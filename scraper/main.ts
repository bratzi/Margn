import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { createHash } from "node:crypto";
import { chromium, type BrowserContext } from "playwright";
import { sb, toPgVector } from "./lib";

// --- Crawl-Grenzen (per Env übersteuerbar; CI knapp, lokaler Tief-Crawl höher) ---
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 80); // gerenderte Seiten pro Quelle
const MAX_DEPTH = Number(process.env.CRAWL_MAX_DEPTH ?? 2);  // Linktiefe ab Startseite
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS ?? 300);  // Höflichkeitspause
const MIN_BODY = 1200;                                       // viel Fließtext = echter Artikel (Hubs haben wenig)
const DRY_RUN = process.env.CRAWL_DRY_RUN === "1";           // nur zählen: kein Embed, kein DB-Write
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripHash = (u: string) => u.split("#")[0];

// Stumme Konsole: schluckt jsdom-CSS-Parsefehler (z.B. FAZ-Tailwind), die sonst crashen.
const silentVC = new VirtualConsole();
const makeDom = (html: string, url: string) => new JSDOM(html, { url, virtualConsole: silentVC });

type Source = { id: number; base_url: string; language: string | null };
type Seed = { url: string; depth: number };

// HuggingFace Router: intfloat/multilingual-e5-large (1024d, mehrsprachig)
async function embed(text: string): Promise<number[]> {
  const r = await fetch(
    "https://router.huggingface.co/hf-inference/models/intfloat/multilingual-e5-large/pipeline/feature-extraction",
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.HF_TOKEN}` },
      body: JSON.stringify({ inputs: `passage: ${text.slice(0, 2000)}` }),
    }
  );
  if (!r.ok) throw new Error(`Embed failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return Array.isArray(j[0]) ? j[0] : j;
}

async function upsertArticle(sourceId: number, url: string): Promise<number> {
  const { data, error } = await sb
    .from("articles")
    .upsert({ source_id: sourceId, url, last_seen: new Date().toISOString() }, { onConflict: "url" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function latestVersion(articleId: number) {
  const { data } = await sb
    .from("article_versions").select("title,teaser")
    .eq("article_id", articleId).order("scanned_at", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

async function saveVersion(articleId: number, title: string, teaser: string, body: string) {
  const hash = createHash("sha256").update(body ?? "").digest("hex");
  const prev = await latestVersion(articleId);
  const changed = !!prev && (prev.title !== title || prev.teaser !== teaser);
  const vector = await embed(`${title}\n\n${teaser}`);
  await sb.from("article_versions").insert({
    article_id: articleId, title, teaser, body_hash: hash, body_text: body, changed, embedding: toPgVector(vector),
  });
}

// Eine Seite im echten Browser rendern. Liefert HTTP-Status + gerendertes HTML.
async function renderPage(ctx: BrowserContext, url: string): Promise<{ status: number; html: string | null }> {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const status = resp?.status() ?? 0;
    // kurz warten, damit nachladender Inhalt (JS) noch reinkommt
    await page.waitForTimeout(500);
    const html = await page.content();
    return { status, html };
  } catch {
    return { status: 0, html: null };
  } finally {
    await page.close();
  }
}

// Interne Links derselben Domain aus dem gerenderten DOM (für die Rekursion).
function sameDomainLinks(html: string, baseUrl: string, pageUrl: string): string[] {
  try {
    const dom = makeDom(html, pageUrl);
    const origin = new URL(baseUrl).origin;
    const out = new Set<string>();
    for (const a of dom.window.document.querySelectorAll("a[href]")) {
      const href = (a as HTMLAnchorElement).href;
      if (!href) continue;
      const clean = stripHash(href);
      if (clean.startsWith(origin) && clean.length > origin.length + 1) out.add(clean);
    }
    return [...out];
  } catch {
    return [];
  }
}

// URL-Muster: ist das überhaupt eine Artikel-URL (und keine Rubrik-/Übersichts-/Footer-Seite)?
// Echte Artikel tragen eine lange ID oder ein Datum im Pfad; Rubriken nicht.
function looksLikeArticle(url: string): boolean {
  const u = url.toLowerCase();
  // Footer/Service-Seiten
  if (/\/(impressum|kontakt|datenschutz|newsletter|mediathek|archiv|suche|recherche|abo|hilfe|agb|rss|index)\b/.test(u)) return false;
  // Audio/Video/Bild-Strecken + Evergreen-Service (kein Fließtext)
  if (/\/(podcast|video|livestream|audio|multimedia|bilder|fotostrecke|guides?-d-achat|qui-sommes-nous|about-us|le-monde-(services|et-vous))\b/.test(u)) return false;
  // Widget-/Hub-Seiten mit ID, aber ohne Artikeltext (Börsenkurse, Wetter, Horoskop, Themen-Hubs …)
  if (/(boersenkurse|kurse|horoskop|wetter|lotto|gewinnspiel|comics|spiele|aboseite|abonnement|bildplus|ateaserseite|teaserseite|alle-infos|thema-|bestseller|verbraucherdialog|chaleur-humaine|se-former)/.test(u)) return false;
  if (/[-/](home|startseite|teaserseite)[-/]/.test(u)) return false; // .../startseite-..., erotik-home-..., /home-...
  if (/\/tv\/|[-/]a-z[-/.]/.test(u)) return false;                   // TV-Hubs, A-Z-Glossare
  let path: string;
  try { path = new URL(url).pathname; } catch { return false; }
  const segs = path.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segs.length < 2) return false;                                // Rubrik-Wurzel: /inland, /sport
  if (/\/$/.test(path)) return false;                               // Rubrik-Index: /politique/
  // Artikel-Signal: lange Zahl-ID, Datumspfad /YYYY/MM/DD/ oder Slug-NNN.html
  return /\d{5,}/.test(u) || /\/\d{4}\/\d{2}\/\d{2}\//.test(u) || /-\d+\.html?$/.test(u);
}

// Gerenderte Seite als Artikel lesen (sichtbarer Text). null = eher Übersichtsseite.
function asArticle(html: string, url: string): { title: string; teaser: string; body: string } | null {
  try {
    const dom = makeDom(html, url);
    const a = new Readability(dom.window.document).parse();
    if (!a || !a.title?.trim() || (a.textContent?.length ?? 0) < MIN_BODY) return null;
    return { title: a.title.trim(), teaser: (a.excerpt ?? "").trim(), body: a.textContent ?? "" };
  } catch {
    return null;
  }
}

// Rekursiver, begrenzter Chromium-Crawl einer Quelle.
async function crawlSource(ctx: BrowserContext, src: Source) {
  const visited = new Set<string>();
  const queued = new Set<string>();
  // Zwei FIFO-Queues: Artikel-Links werden zuerst abgearbeitet (Budget füllt sich mit echten
  // Artikeln), Rubriken/Übersichten danach – aber jeweils in Breiten-/Seitenreihenfolge,
  // also kein Abtauchen in einen einzelnen Strang (z.B. eine Podcast-Liste).
  const articleQ: Seed[] = [];
  const sectionQ: Seed[] = [];
  const enqueue = (s: Seed, isArticle: boolean) => {
    if (queued.has(s.url)) return;
    queued.add(s.url);
    (isArticle ? articleQ : sectionQ).push(s);
  };

  enqueue({ url: src.base_url, depth: 0 }, false); // Startseite = Übersicht

  let pages = 0, found = 0;
  while ((articleQ.length || sectionQ.length) && pages < MAX_PAGES) {
    const s = (articleQ.shift() ?? sectionQ.shift())!; // Artikel zuerst, sonst Rubrik
    if (visited.has(s.url)) continue;
    visited.add(s.url);
    pages++;

    const { html } = await renderPage(ctx, s.url);
    if (!html) continue;

    // Artikel? Erst URL-Muster (keine Rubrik/Übersicht), dann Inhalt prüfen.
    // upsertArticle setzt last_seen = "zuletzt verlinkt/erreicht"; altes last_seen = abgefallen.
    const art = looksLikeArticle(s.url) ? asArticle(html, s.url) : null;
    if (art) {
      found++;
      if (!DRY_RUN) {
        try {
          const id = await upsertArticle(src.id, s.url);
          await saveVersion(id, art.title, art.teaser, art.body);
        } catch (e) {
          console.error("FEHLER speichern:", s.url, (e as Error).message);
        }
      }
      if (found % 10 === 0) console.log(`  ${src.base_url}: ${found} Artikel / ${pages} Seiten…`);
    }

    // Links IMMER verfolgen – auch von Rubrik-/Übersichtsseiten, denn dort hängen die Artikel.
    // Nur das SPEICHERN (oben) ist auf echte Artikel beschränkt.
    if (s.depth < MAX_DEPTH) {
      for (const link of sameDomainLinks(html, src.base_url, s.url)) {
        enqueue({ url: link, depth: s.depth + 1 }, looksLikeArticle(link)); // Artikel- vs. Rubrik-Queue
      }
    }
    await sleep(DELAY_MS);
  }
  console.log(`Quelle ${src.base_url}: ${pages} Seiten gerendert, ${found} Artikel erreicht.`);
}

async function run() {
  const { data, error } = await sb.from("sources").select("id,base_url,language").eq("active", true);
  if (error) throw new Error(`Quellen-Abfrage fehlgeschlagen: ${error.message}`);
  console.log(`${data?.length ?? 0} aktive Quellen geladen.`);
  if (!data?.length) throw new Error("Keine aktiven Quellen gefunden – Abbruch.");
  const browser = await chromium.launch();
  try {
    for (const src of (data ?? []) as Source[]) {
      console.log(`\n=== ${src.base_url} ===`);
      const ctx = await browser.newContext({ userAgent: UA, locale: src.language === "fr" ? "fr-FR" : "de-DE" });
      try {
        await crawlSource(ctx, src);
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
