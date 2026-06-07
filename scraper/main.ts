import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chromium, type BrowserContext } from "playwright";
import { sb } from "./lib";

// --- Crawl-Grenzen (per Env übersteuerbar; CI knapp, lokaler Tief-Crawl höher) ---
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 80);    // gerenderte Seiten pro Quelle
const MAX_DEPTH = Number(process.env.CRAWL_MAX_DEPTH ?? 2);     // Linktiefe ab Startseite
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS ?? 100);     // Höflichkeitspause (kein Embed mehr → kürzer)
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 4); // parallele Browser-Tabs
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

async function upsertArticle(sourceId: number, url: string, meta?: ReturnType<typeof extractMeta>): Promise<number> {
  const row: Record<string, unknown> = { source_id: sourceId, url, last_seen: new Date().toISOString() };
  if (meta) {
    const { authors, keywords, categories, ...rest } = meta;
    Object.assign(row, rest);
    void authors; void keywords; void categories; // handled separately
  }
  const { data, error } = await sb.from("articles").upsert(row, { onConflict: "url" }).select("id").single();
  if (error) throw error;
  return data.id;
}

// --- Metadaten-Extraktion aus gerendertem HTML ---

const PAYWALL_CSS = /paywall|premium-overlay|piano-|plus-artikel|abo-schranke|metered-wall|subscriber-only|locked-content/i;
const TYPE_MAP: Record<string, string> = {
  LiveBlogPosting: "liveblog", OpinionNewsArticle: "opinion", AnalysisNewsArticle: "analysis",
  ReviewNewsArticle: "review", ReportageNewsArticle: "reportage", InteractiveNewsArticle: "interactive",
};

function parseJsonLd(html: string): any[] {
  const out: any[] = [];
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    try { const j = JSON.parse(m[1]); out.push(...(Array.isArray(j) ? j : [j])); } catch {}
  }
  return out;
}

function metaContent(html: string, ...selectors: string[]): string | null {
  for (const sel of selectors) {
    const rx = new RegExp(`<meta[^>]+(?:name|property)=["']${sel}["'][^>]+content=["']([^"']+)["']`, "i");
    const m = rx.exec(html) ?? new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${sel}["']`, "i").exec(html);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function extractMeta(html: string, url: string) {
  const ld = parseJsonLd(html);
  const article = ld.find((d) => typeof d["@type"] === "string" && d["@type"].includes("Article")) ?? {};

  const title =
    metaContent(html, "og:title", "twitter:title") ??
    article.headline ??
    html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ?? null;

  const description =
    metaContent(html, "og:description", "description", "twitter:description") ??
    article.description ?? null;

  const og_image =
    metaContent(html, "og:image", "twitter:image") ??
    article.image?.url ?? article.image ?? null;

  const published_at =
    metaContent(html, "article:published_time") ??
    article.datePublished ?? null;

  const modified_at =
    metaContent(html, "article:modified_time") ??
    article.dateModified ?? null;

  // Paywall: JSON-LD isAccessibleForFree oder CSS-Pattern
  const paywalled =
    ld.some((d) => d.isAccessibleForFree === false || d.isAccessibleForFree === "False") ||
    PAYWALL_CSS.test(html);

  // Artikeltyp aus @type
  const rawType = typeof article["@type"] === "string" ? article["@type"] : "NewsArticle";
  const article_type = TYPE_MAP[rawType] ?? "news";

  // Wörter + Lesezeit (sichtbarer Text)
  const visibleText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const word_count = visibleText.trim().split(/\s+/).length;
  const reading_min = Math.max(1, Math.round(word_count / 200));

  // Sprache
  const lang_detected = html.match(/<html[^>]+lang=["']([a-z]{2})/i)?.[1] ?? null;

  // Autoren (JSON-LD author + meta)
  const authorRaw = article.author ?? [];
  const authorList: string[] = (Array.isArray(authorRaw) ? authorRaw : [authorRaw])
    .map((a: any) => (typeof a === "string" ? a : a?.name ?? "").trim())
    .filter(Boolean);
  const metaAuthor = metaContent(html, "author", "article:author");
  if (metaAuthor && !authorList.includes(metaAuthor)) authorList.push(metaAuthor);

  // Keywords
  const kwRaw = article.keywords ?? metaContent(html, "keywords", "article:tag") ?? "";
  const keywords: string[] = (typeof kwRaw === "string" ? kwRaw.split(/[,;|]/) : kwRaw)
    .map((k: string) => k.trim().toLowerCase()).filter((k: string) => k.length > 1 && k.length < 60);

  // Kategorien
  const catRaw = article.articleSection ?? metaContent(html, "article:section") ?? "";
  const categories: string[] = (typeof catRaw === "string" ? catRaw.split(/[,;|]/) : catRaw)
    .map((c: string) => c.trim()).filter((c: string) => c.length > 1 && c.length < 80);

  return { title, description, og_image, published_at, modified_at, paywalled, article_type, word_count, reading_min, lang_detected, authors: authorList, keywords, categories };
}

// Junction-Tabellen (authors/keywords/categories) befüllen.
async function upsertDimensions(articleId: number, authors: string[], keywords: string[], categories: string[]) {
  const save = async (table: string, junctionTable: string, articleCol: string, dimCol: string, values: string[]) => {
    if (!values.length) return;
    // Dimensionen upserten
    await sb.from(table).upsert(values.map((v) => ({ name: v })), { onConflict: "name", ignoreDuplicates: true });
    const { data } = await sb.from(table).select("id,name").in("name", values);
    if (!data?.length) return;
    const rows = data.map((d: any) => ({ [articleCol]: articleId, [dimCol]: d.id }));
    await sb.from(junctionTable).upsert(rows, { onConflict: `${articleCol},${dimCol}`, ignoreDuplicates: true });
  };
  await Promise.all([
    save("authors", "article_authors", "article_id", "author_id", authors),
    save("keywords", "article_keywords", "article_id", "keyword_id", keywords),
    save("categories", "article_categories", "article_id", "category_id", categories),
  ]);
}

// Eine Seite im echten Browser rendern. Liefert HTTP-Status + gerendertes HTML.
async function renderPage(ctx: BrowserContext, url: string): Promise<{ status: number; html: string | null }> {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const status = resp?.status() ?? 0;
    const html = await page.content(); // kein waitForTimeout – brauchen nur Links, keinen vollständigen Text
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

  // Einen einzelnen Seed verarbeiten (renderPage + classify + DB-Write + neue Links einreihen).
  async function processOne(s: Seed) {
    if (visited.has(s.url)) return;
    visited.add(s.url);
    pages++;

    const { html } = await renderPage(ctx, s.url);
    if (!html) return;

    const links = s.depth < MAX_DEPTH ? sameDomainLinks(html, src.base_url, s.url) : [];
    const { kind, article } = classifyRendered(s.url, html);
    counts[kind] = (counts[kind] ?? 0) + 1;

    if (!DRY_RUN) {
      try {
        const fromId = await upsertRenderedNode(src.id, s.url, kind, s.depth);
        if (links.length) { await ensureNodes(src.id, links, s.depth + 1); await addEdges(fromId, links); }
        if (kind === "article" && article && MODE !== "structure") {
          const meta = extractMeta(html, s.url);
          const artId = await upsertArticle(src.id, s.url, meta);
          await upsertDimensions(artId, meta.authors, meta.keywords, meta.categories);
        }
      } catch (e) { console.error("FEHLER:", s.url, (e as Error).message); }
    }
    for (const link of links) enqueue({ url: link, depth: s.depth + 1 }, classifyUrl(link) === "article");
  }

  // Parallele Worker: CONCURRENCY Tabs laufen gleichzeitig.
  const next = (): Seed | undefined => MODE === "structure"
    ? (sectionQ.shift() ?? articleQ.shift())
    : (articleQ.shift() ?? sectionQ.shift());

  async function worker() {
    while (pages < MAX_PAGES) {
      const s = next();
      if (!s) break;
      await processOne(s);
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

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

  // Kein Chromium mehr nötig: wir speichern nur URL + Metadaten (no content/embed).
  // Direkt batch-upsertn aus pages → articles.
  for (const [sid, urls] of bySrc) {
    const src = srcById.get(sid);
    const CHUNK = 200;
    let ok = 0;
    for (let i = 0; i < urls.length; i += CHUNK) {
      const chunk = urls.slice(i, i + CHUNK);
      const rows = chunk.map((url) => ({ source_id: sid, url, last_seen: new Date().toISOString() }));
      const { error } = await sb.from("articles").upsert(rows, { onConflict: "url", ignoreDuplicates: false });
      if (error) console.error("FEHLER batch:", error.message);
      else ok += chunk.length;
    }
    console.log(`Quelle ${src.base_url}: ${ok}/${urls.length} analysiert.`);
  }
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
