import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chromium, type BrowserContext } from "playwright";
import { sb } from "./lib";

// --- Crawl-Grenzen (per Env übersteuerbar; CI knapp, lokaler Tief-Crawl höher) ---
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 80); // gerenderte Seiten pro Quelle
const MAX_DEPTH = Number(process.env.CRAWL_MAX_DEPTH ?? 2);  // Linktiefe ab Startseite
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS ?? 300);  // Höflichkeitspause
const MIN_BODY = 1200;                                       // viel Fließtext = echter Artikel (Hubs haben wenig)
const DRY_RUN = process.env.CRAWL_DRY_RUN === "1";           // nur zählen, kein DB-Write
// "articles": crawlen + Artikel in articles-Tabelle speichern (Metadaten, kein Volltext/Embedding).
// "structure": Rubriken crawlen, ALLE Links klassifiziert in pages/page_links.
// "analyze": KEIN Crawl – nimmt entdeckte pages.kind='article', rendert+speichert Metadaten.
const MODE = (process.env.CRAWL_MODE ?? "articles") as "articles" | "structure" | "analyze";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripHash = (u: string) => u.split("#")[0];

// Stumme Konsole: schluckt jsdom-CSS-Parsefehler (z.B. FAZ-Tailwind), die sonst crashen.
const silentVC = new VirtualConsole();
const makeDom = (html: string, url: string) => new JSDOM(html, { url, virtualConsole: silentVC });

type Source = { id: number; base_url: string; language: string | null };
type Seed = { url: string; depth: number };

// embed() DEAKTIVIERT – reaktivieren wenn Cluster-Feature wieder aufgenommen wird.

async function upsertArticle(sourceId: number, url: string): Promise<number> {
  const { data, error } = await sb
    .from("articles")
    .upsert({ source_id: sourceId, url, last_seen: new Date().toISOString() }, { onConflict: "url" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// embed() + saveVersion() DEAKTIVIERT: article_versions auf Eis (Speicherplatz).
// Wieder aktivieren: embed, toPgVector, createHash importieren + saveVersion reaktivieren.

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

// === Klassifikation der Seiten (Knoten im Baum) ===
type Kind = "article" | "section" | "media" | "interactive" | "sponsored" | "service" | "unknown";

// Schätzung allein aus der URL (für entdeckte, noch nicht gerenderte Links).
function classifyUrl(url: string): Kind {
  const u = url.toLowerCase();
  if (/(anzeige|sponsored|advertorial|promotion|werbung|\/adv\/)/.test(u)) return "sponsored";
  if (/\/(impressum|kontakt|datenschutz|newsletter|abo|login|konto|hilfe|agb|nutzungsbedingungen|privacy|mentions-legales|cgu)\b/.test(u)) return "service";
  if (/\/(podcast|video|audio|mediathek|livestream|bilder|fotostrecke|galerie|multimedia|tv)\b/.test(u)) return "media";
  if (/(boersenkurse|kurse|wetter|horoskop|lotto|gewinnspiel|rechner|tabelle|ergebnisse|spielplan)/.test(u)) return "interactive";
  if (looksLikeArticle(u)) return "article";
  return "unknown";
}

// Sichere Klassifikation nach dem Rendern (zieht den Inhalt hinzu).
function classifyRendered(url: string, html: string): { kind: Kind; article: { title: string; teaser: string; body: string } | null } {
  const byUrl = classifyUrl(url);
  if (byUrl !== "article" && byUrl !== "unknown") return { kind: byUrl, article: null };
  const art = looksLikeArticle(url) ? asArticle(html, url) : null;
  if (art) return { kind: "article", article: art };
  return { kind: "section", article: null }; // gerenderte, navigationale Nicht-Artikel-Seite
}

// === Knoten/Kanten-Persistenz (der Baum) ===
const pageId = new Map<string, number>(); // url -> pages.id (laufzeitweiter Cache)

// Entdeckte Links als Knoten anlegen (nur neu; bestehende Klassifikation NICHT überschreiben).
async function ensureNodes(sourceId: number, urls: string[], depth: number) {
  const fresh = urls.filter((u) => !pageId.has(u));
  if (!fresh.length) return;
  const rows = fresh.map((url) => ({ source_id: sourceId, url, kind: classifyUrl(url), depth }));
  await sb.from("pages").upsert(rows, { onConflict: "url", ignoreDuplicates: true });
  for (let i = 0; i < fresh.length; i += 200) {
    const { data } = await sb.from("pages").select("id,url").in("url", fresh.slice(i, i + 200));
    for (const p of data ?? []) pageId.set(p.url, p.id);
  }
}

// Gerenderten Knoten mit sicherer Klassifikation schreiben (überschreibt kind).
async function upsertRenderedNode(sourceId: number, url: string, kind: Kind, depth: number): Promise<number> {
  const { data, error } = await sb.from("pages")
    .upsert({ source_id: sourceId, url, kind, depth, last_seen: new Date().toISOString() }, { onConflict: "url" })
    .select("id").single();
  if (error) throw error;
  pageId.set(url, data.id);
  return data.id;
}

// Kanten "von dieser Seite -> Links" speichern.
async function addEdges(fromId: number, toUrls: string[]) {
  const rows = toUrls.map((u) => pageId.get(u))
    .filter((id): id is number => !!id && id !== fromId) // keine Self-Loops
    .map((to) => ({ from_page_id: fromId, to_page_id: to }));
  for (let i = 0; i < rows.length; i += 500) {
    await sb.from("page_links").upsert(rows.slice(i, i + 500), { onConflict: "from_page_id,to_page_id", ignoreDuplicates: true });
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

  let pages = 0;
  const counts: Record<string, number> = {};
  while ((articleQ.length || sectionQ.length) && pages < MAX_PAGES) {
    // structure: Rubriken zuerst (Baum kartieren); articles: Artikel zuerst (Analyse füllen)
    const s = (MODE === "structure"
      ? (sectionQ.shift() ?? articleQ.shift())
      : (articleQ.shift() ?? sectionQ.shift()))!;
    if (visited.has(s.url)) continue;
    visited.add(s.url);
    pages++;

    const { html } = await renderPage(ctx, s.url);
    if (!html) continue;

    // Links der Seite (für Kanten + Rekursion)
    const links = s.depth < MAX_DEPTH ? sameDomainLinks(html, src.base_url, s.url) : [];

    // Seite klassifizieren (Knoten im Baum)
    const { kind, article } = classifyRendered(s.url, html);
    counts[kind] = (counts[kind] ?? 0) + 1;

    if (!DRY_RUN) {
      try {
        // 1) diese Seite als klassifizierten Knoten speichern
        const fromId = await upsertRenderedNode(src.id, s.url, kind, s.depth);
        // 2) Links als Knoten + Kanten (von wo wird wohin verlinkt)
        if (links.length) { await ensureNodes(src.id, links, s.depth + 1); await addEdges(fromId, links); }
        // 3) Artikel in articles-Tabelle (nur Metadaten, kein Volltext/Embedding).
        if (kind === "article" && article && MODE !== "structure") {
          await upsertArticle(src.id, s.url);
        }
      } catch (e) {
        console.error("FEHLER:", s.url, (e as Error).message);
      }
    }

    // Rekursion: Links verfolgen (Artikel-Links bevorzugt), auch von Rubrik-/Übersichtsseiten.
    for (const link of links) enqueue({ url: link, depth: s.depth + 1 }, classifyUrl(link) === "article");
    await sleep(DELAY_MS);
  }
  const summary = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(", ");
  console.log(`Quelle ${src.base_url}: ${pages} Seiten gerendert [${summary}]`);
}

// Alle Zeilen einer Abfrage holen (PostgREST limitiert auf 1000/Request → paginieren).
async function fetchAll<T>(build: (from: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// analyze-Modus: bereits entdeckte Artikel-URLs (pages.kind='article') rendern + embedden.
// Kein Rubriken-Crawl. Arbeitet bis zu MAX_PAGES noch nicht analysierte Artikel ab.
async function analyzeBacklog() {
  const { data: srcs } = await sb.from("sources").select("id,base_url,language").eq("active", true);
  const srcById = new Map((srcs ?? []).map((s: any) => [s.id, s]));
  const activeIds = [...srcById.keys()];

  // 1) entdeckte Artikel-Knoten + bereits analysierte URLs laden
  const discovered = await fetchAll<{ url: string; source_id: number }>((from) =>
    sb.from("pages").select("url,source_id").eq("kind", "article").in("source_id", activeIds).order("id", { ascending: true })
  );
  const doneRows = await fetchAll<{ url: string }>((from) => sb.from("articles").select("url"));
  const done = new Set(doneRows.map((r) => r.url));

  // Budget gleichmäßig über die Quellen verteilen (sonst frisst die größte Quelle alles).
  const perSource = Math.ceil(MAX_PAGES / activeIds.length);
  const bySrc = new Map<number, string[]>();
  let openTotal = 0;
  for (const p of discovered) {
    if (done.has(p.url)) continue;
    openTotal++;
    const arr = bySrc.get(p.source_id) ?? bySrc.set(p.source_id, []).get(p.source_id)!;
    if (arr.length < perSource) arr.push(p.url);
  }
  const batch = [...bySrc.values()].reduce((s, a) => s + a.length, 0);
  console.log(`Entdeckt: ${discovered.length} | analysiert: ${done.size} | offen: ${openTotal} | dieser Lauf: ${batch} (max ${perSource}/Quelle)`);

  const browser = await chromium.launch();
  try {
    for (const [sid, urls] of bySrc) {
      const src = srcById.get(sid);
      const ctx = await browser.newContext({ userAgent: UA, locale: src.language === "fr" ? "fr-FR" : "de-DE" });
      let ok = 0;
      try {
        for (const url of urls) {
          const { html } = await renderPage(ctx, url);
          if (!html) continue;
          const art = asArticle(html, url);
          if (!art) continue;
          try {
            await upsertArticle(sid, url);
            ok++;
            if (ok % 25 === 0) console.log(`  ${src.base_url}: ${ok}/${urls.length}…`);
          } catch (e) { console.error("FEHLER:", url, (e as Error).message); }
          await sleep(DELAY_MS);
        }
      } finally { await ctx.close(); }
      console.log(`Quelle ${src.base_url}: ${ok}/${urls.length} analysiert.`);
    }
  } finally { await browser.close(); }
}

async function run() {
  const { data, error } = await sb.from("sources").select("id,base_url,language").eq("active", true);
  if (error) throw new Error(`Quellen-Abfrage fehlgeschlagen: ${error.message}`);
  console.log(`${data?.length ?? 0} aktive Quellen geladen.`);
  if (!data?.length) throw new Error("Keine aktiven Quellen gefunden – Abbruch.");

  // analyze-Modus: kein Crawl, nur entdeckte Artikel abarbeiten.
  if (MODE === "analyze") { await analyzeBacklog(); return; }

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
