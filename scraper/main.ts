import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chromium, type BrowserContext } from "playwright";
import { createHash } from "node:crypto";
import { sb } from "./lib";
import { topicOf } from "./topics";

// --- Crawl-Grenzen (per Env übersteuerbar; CI knapp, lokaler Tief-Crawl höher) ---
// WICHTIG: Kostentreiber ist das BROWSER-Rendering (Playwright), nicht das
// Entdecken von Links. Darum zwei getrennte Budgets je Quelle:
//   MAX_PAGES   = teure Browser-Renders (Artikel; bestimmt CI-Minuten).
//   MAX_FETCHES = billige HTTP-Entdeckung (Rubriken/Hubs; macht den Crawl tief
//                 & ganzheitlich, ohne die Minuten zu sprengen).
// So liest jeder Lauf den GANZEN Strukturbaum eines Publizisten aus; die dabei
// entdeckten Artikel-URLs rendert der analyze-Job nach (Budget 2000/Lauf).
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 80);    // Browser-Renders pro Quelle (teuer)
const MAX_FETCHES = Number(process.env.CRAWL_MAX_FETCHES ?? MAX_PAGES * 10); // HTTP-Discovery pro Quelle (billig)
const MAX_DEPTH = Number(process.env.CRAWL_MAX_DEPTH ?? 2);     // Linktiefe ab Startseite
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS ?? 100);     // Höflichkeitspause (kein Embed mehr → kürzer)
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 4); // parallele Browser-Tabs
// Hartes Gesamt-Zeitbudget für den articles-Crawl (Schutz vor CI-Job-Timeout).
// Wird gleichmäßig auf die Quellen verteilt; jede Quelle stoppt an ihrer Frist.
const TIME_BUDGET_MS = Number(process.env.CRAWL_TIME_BUDGET_MS ?? 16 * 60 * 1000);
// CRAWL_RENDER=0 → reiner Discovery-Modus OHNE Browser (Sitemaps/Feeds/HTML-Links
// per HTTP, Artikel werden nur als Knoten markiert). Spart die teuren Render- und
// Playwright-Minuten — das Rendern übernimmt der analyze-Job.
const RENDER = process.env.CRAWL_RENDER !== "0";

// Kuratierte Feeds für Quellen, deren Auto-Erkennung (robots.txt/Sitemap/<link>)
// zu wenig hergibt. FAZ z.B. nennt keine Sitemap in robots.txt, hat aber ergiebige
// RSS-Ressort-Feeds. Schlüssel = Host. Wird beim Crawl der Quelle mit eingereiht.
const KNOWN_FEEDS: Record<string, string[]> = {
  "www.faz.net": [
    "https://www.faz.net/rss/aktuell/",
    "https://www.faz.net/rss/aktuell/politik/",
    "https://www.faz.net/rss/aktuell/wirtschaft/",
    "https://www.faz.net/rss/aktuell/finanzen/",
    "https://www.faz.net/rss/aktuell/feuilleton/",
    "https://www.faz.net/rss/aktuell/gesellschaft/",
    "https://www.faz.net/rss/aktuell/sport/",
    "https://www.faz.net/rss/aktuell/wissen/",
    "https://www.faz.net/rss/aktuell/technik-motor/",
    "https://www.faz.net/rss/aktuell/karriere-hochschule/",
    "https://www.faz.net/rss/aktuell/reise/",
    "https://www.faz.net/rss/aktuell/rhein-main/",
  ],
  "www.n-tv.de": [
    "https://www.n-tv.de/rss",
    "https://www.n-tv.de/politik/rss",
    "https://www.n-tv.de/wirtschaft/rss",
    "https://www.n-tv.de/sport/rss",
    "https://www.n-tv.de/panorama/rss",
    "https://www.n-tv.de/technik/rss",
    "https://www.n-tv.de/wissen/rss",
    "https://www.n-tv.de/auto/rss",
    "https://www.n-tv.de/reise/rss",
    "https://www.n-tv.de/unterhaltung/rss",
    "https://www.n-tv.de/ratgeber/rss",
    "https://www.n-tv.de/der_tag/rss",
  ],
};
const MIN_BODY = 1200;                                       // viel Fließtext = echter Artikel (Hubs haben wenig)
const DRY_RUN = process.env.CRAWL_DRY_RUN === "1";           // nur zählen, kein DB-Write
// "articles":   crawlen + Artikel speichern (Metadaten).
// "structure":  Rubriken crawlen, Links klassifizieren.
// "analyze":    batch-upsert pages.kind='article' → articles (kein Chromium).
// "enrich":     articles ohne Titel rendern + Metadaten nachtragen.
// "reclassify": pages.kind='article' rendern, Videos → kind='media' + aus articles entfernen.
const MODE = (process.env.CRAWL_MODE ?? "articles") as "articles" | "structure" | "analyze" | "enrich" | "reclassify" | "retopic" | "rekeyword" | "retype";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripHash = (u: string) => u.split("#")[0];

// Stumme Konsole: schluckt jsdom-CSS-Parsefehler (z.B. FAZ-Tailwind), die sonst crashen.
const silentVC = new VirtualConsole();
const makeDom = (html: string, url: string) => new JSDOM(html, { url, virtualConsole: silentVC });

type Source = { id: number; base_url: string; language: string | null; feed_url?: string | null };
type Seed = { url: string; depth: number; feed?: boolean };

// embed() DEAKTIVIERT – reaktivieren wenn Cluster-Feature wieder aufgenommen wird.

function canonUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (/(^|\.)n-tv\.de$/i.test(u.hostname)) {
      const m = u.pathname.match(/\/\d{2}-\d{2}-.*-id(\d+)\.html$/i);
      if (m) return `https://www.n-tv.de/id${m[1]}.html`;
    }
  } catch { /* ungültige URL → unverändert */ }
  return raw;
}

async function upsertArticle(sourceId: number, url: string, meta?: ReturnType<typeof extractMeta>, extra?: Record<string, unknown>): Promise<number> {
  url = canonUrl(url);
  const row: Record<string, unknown> = { source_id: sourceId, url, last_seen: new Date().toISOString() };
  if (meta) {
    const { authors, keywords, categories, published_precise, ...rest } = meta;
    void published_precise; // nur Steuerflag, keine DB-Spalte
    Object.assign(row, rest);
    void authors; void keywords; void categories; // handled separately
  }
  if (extra) Object.assign(row, extra);
  const { data, error } = await sb.from("articles").upsert(row, { onConflict: "url" }).select("id").single();
  if (error) throw error;
  return data.id;
}

// --- Metadaten-Extraktion aus gerendertem HTML ---

const PAYWALL_CSS = /paywall|premium-overlay|piano-|plus-artikel|abo-schranke|metered-wall|subscriber-only|locked-content/i;

function isLiveContent(url: string, title: string | null): boolean {
  const hay = (url + " " + (title ?? "")).toLowerCase();
  if (/news?ticker\/.*alle-[a-z-]+-news/.test(hay)) return false; // Bild News-Hubs
  return /liveblog|live-blog|live-ticker|liveticker|newsblog|en-direct|im[- ]minutentakt/.test(hay)
    || /\/live\//.test(hay) // Le Monde: /…/live/…
    || /\+\+.+\+\+/.test(title ?? ""); // Tagesschau-Konvention: "Liveblog: ++ Meldung ++"
}
const TYPE_MAP: Record<string, string> = {
  LiveBlogPosting: "liveblog", OpinionNewsArticle: "opinion", AnalysisNewsArticle: "analysis",
  ReviewNewsArticle: "review", ReportageNewsArticle: "reportage", InteractiveNewsArticle: "interactive",
};

function parseJsonLd(html: string): any[] {
  const out: any[] = [];
  const rx = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    try {
      const j = JSON.parse(m[1]);
      const items = Array.isArray(j) ? j : [j];
      for (const it of items) {
        out.push(it);
        // @graph-Wrapper entpacken (Le Monde, FAZ u.a. verschachteln Article darin)
        if (it && Array.isArray(it["@graph"])) out.push(...it["@graph"]);
      }
    } catch {}
  }
  return out;
}

// @type kann String ODER Array sein ("NewsArticle" vs. ["NewsArticle","Report"]).
function typeIncludes(t: any, needle: string): boolean {
  if (typeof t === "string") return t.includes(needle);
  if (Array.isArray(t)) return t.some((x) => typeof x === "string" && x.includes(needle));
  return false;
}

// Schlagwörter aus <a rel="tag">-Links (HTML-Standard, von FAZ u.a. genutzt).
function relTagKeywords(html: string): string[] {
  const out: string[] = [];
  const rx = /<a[^>]+rel=["']tag["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const txt = m[1].replace(/<[^>]+>/g, "").trim();
    if (txt) out.push(txt);
  }
  return out;
}

// Keywords aus allen bekannten Quellen sammeln, normalisieren, deduplizieren.
//  1) JSON-LD keywords (String/Array)  2) meta news_keywords/keywords
//  3) ALLE <meta property="article:tag"> (mehrfach)  4) <a rel="tag"> (FAZ u.a.)
function extractKeywords(html: string, article: any): string[] {
  const parts: string[] = [];
  const push = (raw: any) => {
    if (!raw) return;
    const arr = Array.isArray(raw) ? raw : String(raw).split(/[,;|]/);
    for (const k of arr) parts.push(String(k));
  };
  push(article?.keywords);
  push(metaContent(html, "news_keywords", "keywords"));
  for (const m of html.matchAll(/<meta[^>]+property=["']article:tag["'][^>]+content=["']([^"']+)["']/gi)) parts.push(m[1]);
  for (const t of relTagKeywords(html)) parts.push(t);
  return [...new Set(
    parts.map((k) => k.trim().toLowerCase().replace(/_/g, " ")).filter((k) => k.length > 1 && k.length < 60),
  )];
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
  const article = ld.find((d) => d && typeIncludes(d["@type"], "Article")) ?? {};

  const titleRaw =
    metaContent(html, "og:title", "twitter:title") ??
    article.headline ??
    html.match(/<title[^>]*>([^<]+)/i)?.[1]?.trim() ?? null;
  const title = titleRaw ? decodeEntities(titleRaw) : null;

  const description =
    metaContent(html, "og:description", "description", "twitter:description") ??
    article.description ?? null;

  const og_image =
    metaContent(html, "og:image", "twitter:image") ??
    article.image?.url ?? article.image ?? null;

  // Datum ROBUST über mehrere Quellen ziehen — Publizisten legen datePublished
  // mal aufs NewsArticle, mal auf WebPage/BlogPosting/@graph, mal nur als Meta
  // oder <time>. Frühere Logik („nur das eine Article-Objekt") verfehlte n-tv
  // (kein Article-@type) und FAZ (mehrere Blöcke) → fälschlich „kein Datum".
  const validDate = (s: unknown): string | null => {
    if (typeof s !== "string" || !s.trim()) return null;
    return Number.isNaN(Date.parse(s)) ? null : s.trim();
  };
  const anyLdField = (field: string): string | null => {
    for (const d of ld) { const v = validDate(d?.[field]); if (v) return v; }
    return null;
  };
  const rawJsonDate = (field: string): string | null => {
    const m = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, "i").exec(html);
    return validDate(m?.[1]);
  };
  const timeTagDate = (): string | null => {
    const m = /<time\b[^>]*\b(?:itemprop=["']datePublished["']|pubdate)[^>]*\bdatetime=["']([^"']+)["']/i.exec(html)
      ?? /<time\b[^>]*\bdatetime=["']([^"']+)["'][^>]*\b(?:itemprop=["']datePublished["']|pubdate)/i.exec(html);
    return validDate(m?.[1]);
  };
  // Letzter Notnagel: Datum aus dem URL-Pfad /YYYY/MM/DD/ (z.B. Le Monde —
  // liefert dem Crawler 402/Paywall, das Datum steht aber zuverlässig im Pfad).
  // Mittag UTC, damit die lokale Anzeige nicht auf den Vortag rutscht.
  const urlPathDate = (): string | null => {
    const m = /\/(\d{4})\/(\d{2})\/(\d{2})(?:\/|_|-)/.exec(url);
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return validDate(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
  };

  // Präzise Quellen (mit Uhrzeit) zuerst; der URL-Pfad ist nur ein DATUM ohne
  // echte Uhrzeit (Mittag UTC) → als „unpräzise" markiert, damit er einen
  // bereits vorhandenen präzisen Wert (z.B. aus der News-Sitemap) NICHT überschreibt.
  const precisePub =
    validDate(metaContent(html, "article:published_time", "og:article:published_time")) ??
    validDate(article.datePublished) ??
    anyLdField("datePublished") ??
    rawJsonDate("datePublished") ??
    timeTagDate();
  const published_at = precisePub ?? urlPathDate() ?? null;
  const published_precise = precisePub != null;

  const modified_at =
    validDate(metaContent(html, "article:modified_time", "og:updated_time")) ??
    validDate(article.dateModified) ??
    anyLdField("dateModified") ??
    rawJsonDate("dateModified") ?? null;

  // Paywall: JSON-LD isAccessibleForFree ist maßgeblich (verlässlich pro Artikel).
  // CSS-Pattern NUR als Fallback, wenn KEIN JSON-LD-Signal existiert – sonst markiert
  // das seitenweit geladene Paywall-Framework (z.B. "paywall"/"piano-") jeden freien Artikel.
  const iaff = ld.map((d) => d.isAccessibleForFree).filter((v) => v !== undefined && v !== null);
  const isFree = (v: any) => v === true || v === "True" || v === "true";
  const notFree = (v: any) => v === false || v === "False" || v === "false";
  // true/false NUR bei verlässlichem Signal; sonst null = „unbekannt" (NICHT frei!).
  // Wichtig für Paywall-Seiten, die dem Crawler einen Stub/Teaser ohne Signal
  // liefern (Le Monde 402) — die dürfen ein bestehendes paywalled=true NICHT
  // überschreiben. Die Übernahme regelt die sticky-Logik in upsert/enrich.
  const paywalled: boolean | null =
    iaff.length > 0 ? (iaff.some(notFree) && !iaff.some(isFree))
    : PAYWALL_CSS.test(html) ? true
    : null;

  // Artikeltyp aus @type … ergänzt um URL/Titel-Erkennung für Liveblogs
  // (FAZ/Spiegel u.a. liefern KEIN LiveBlogPosting-@type, tragen es aber im Pfad/Titel).
  const rawType = typeof article["@type"] === "string" ? article["@type"] : "NewsArticle";
  const article_type = isLiveContent(url, title) ? "liveblog" : (TYPE_MAP[rawType] ?? "news");

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

  const keywords = extractKeywords(html, article);

  // Kategorien
  const catRaw = article.articleSection ?? metaContent(html, "article:section") ?? "";
  const categories: string[] = (typeof catRaw === "string" ? catRaw.split(/[,;|]/) : catRaw)
    .map((c: string) => c.trim()).filter((c: string) => c.length > 1 && c.length < 80);

  const author_status = classifyAuthorStatus(authorList);
  const topic = topicOf(categories, url);

  return { title, description, og_image, published_at, published_precise, modified_at, paywalled, article_type, word_count, reading_min, lang_detected, author_status, topic, authors: authorList, keywords, categories };
}

// Autoren-Status: 'named' (echte Person), 'anonymous' (Redaktion/Agentur/Eigenname), 'none' (keiner).
const GENERIC_AUTHOR = /^(redaktion|red\.?|dpa(-afx)?|afp|reuters|sid|kna|epd|ap|afx|ag|agenturen|online|newsroom|web|t-online|n-?tv|bild(\.de)?|spiegel( online)?|der spiegel|faz|f\.a\.z\.|faz\.net|tagesschau(\.de)?|sportschau|ard|zdf|rnd|le ?monde(\.fr)?)$/i;
function isPersonName(s: string): boolean {
  return /\p{Lu}[\p{Ll}.'-]+\s+\p{Lu}[\p{Ll}.'-]+/u.test(s);
}
function classifyAuthorStatus(authors: string[]): "named" | "anonymous" | "none" {
  const cleaned = authors.map((a) => a.trim()).filter(Boolean);
  if (!cleaned.length) return "none";
  const named = cleaned.some((a) => {
    if (GENERIC_AUTHOR.test(a)) return false;
    if (/\.(de|fr|com|net)$/i.test(a)) return false;     // Domains
    if (!a.includes(" ")) return false;                   // Einzelwort (meist Agentur/Kürzel)
    return isPersonName(a.replace(/^(von|par|by)\s+/i, ""));
  });
  return named ? "named" : "anonymous";
}

// Junction-Tabellen (authors/keywords/categories) befüllen.
// Achtung: keywords nutzt Spalte 'term', authors/categories nutzen 'name'.
async function upsertDimensions(articleId: number, authors: string[], keywords: string[], categories: string[]) {
  const save = async (table: string, nameCol: string, junctionTable: string, articleCol: string, dimCol: string, values: string[]) => {
    if (!values.length) return;
    const uniq = [...new Set(values.map((v) => v.trim()).filter(Boolean))].slice(0, 25);
    await sb.from(table).upsert(uniq.map((v) => ({ [nameCol]: v })), { onConflict: nameCol, ignoreDuplicates: true });
    const { data } = await sb.from(table).select(`id,${nameCol}`).in(nameCol, uniq);
    if (!data?.length) return;
    const rows = data.map((d: any) => ({ [articleCol]: articleId, [dimCol]: d.id }));
    await sb.from(junctionTable).upsert(rows, { onConflict: `${articleCol},${dimCol}`, ignoreDuplicates: true });
  };
  await Promise.all([
    save("authors", "name", "article_authors", "article_id", "author_id", authors),
    save("keywords", "term", "article_keywords", "article_id", "keyword_id", keywords),
    save("categories", "name", "article_categories", "article_id", "category_id", categories),
  ]);
}

// --- Änderungs-Tracking (speicherschonend über Absatz-Fingerprints) ---

// Paywall-/Login-/Cookie-/Navigations-Boilerplate, das je nach Render auf-/abtaucht und
// sonst als falsche "Änderung" gezählt würde (v.a. Le-Monde-Overlay, Newsletter-CTAs).
const BOILERPLATE = /cet article vous est offert|réservé aux abonnés|article réservé|pour lire (gratuitement|cet)|connectez-vous|inscrivez-vous|vous n.?êtes pas inscrit|déjà abonné|s.?abonner|abonnez-vous|se connecter|newsletter|cookies? (akzeptieren|zustimmen|verwalten)|alle akzeptieren|datenschutz|jetzt anmelden|mit bild plus|spiegel\+ lesen/i;

// HTML-Entities (v.a. &nbsp;) dekodieren + Whitespace normalisieren – sonst zählt
// "&nbsp;" vs. Leerzeichen als Titeländerung.
function decodeEntities(s: string): string {
  return s.replace(/&nbsp;|&#160;|&#xa0;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
}

// Body in normalisierte Absätze (≥60 Zeichen, gegen UI-Rauschen) zerlegen.
function normalizeParas(body: string): string[] {
  return body.split(/\n+/).map((p) => decodeEntities(p))
    .filter((p) => p.length >= 60 && !BOILERPLATE.test(p));
}
const fp = (s: string) => createHash("sha1").update(s.toLowerCase()).digest("hex").slice(0, 12);

// Scan-Zeitstempel anhängen, auf die letzten 150 gekappt (Detail-Timeline).
function appendScan(prev: unknown): string[] {
  const arr = Array.isArray(prev) ? (prev as string[]) : [];
  return [...arr, new Date().toISOString()].slice(-150);
}

// Liveblog-Ticker aus JSON-LD (LiveBlogPosting.liveBlogUpdate[]).
function extractLiveBlog(html: string): { body: string; count: number } | null {
  const updates: any[] = [];
  for (const node of parseJsonLd(html)) {
    if (!node || typeof node !== "object" || !typeIncludes(node["@type"], "LiveBlogPosting")) continue;
    const u = (node as any).liveBlogUpdate;
    if (Array.isArray(u)) updates.push(...u);
    else if (u && typeof u === "object") updates.push(u);
  }
  if (!updates.length) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const e of updates
    .map((x) => ({
      t: Date.parse(x?.datePublished ?? "") || 0,
      head: typeof x?.headline === "string" ? x.headline.trim() : "",
      text: typeof x?.articleBody === "string" ? x.articleBody.trim() : "",
    }))
    .filter((e) => e.head || e.text)
    .sort((a, b) => a.t - b.t)) {
    const para = [e.head, e.text].filter(Boolean).join(". ");
    const key = fp(para);
    if (seen.has(key)) continue; // doppelte Updates (gleicher Text) zusammenfassen
    seen.add(key);
    parts.push(para);
  }
  return parts.length ? { body: parts.join("\n\n"), count: parts.length } : null;
}

// Normalisiert den extrahierten Body je Quelle (entfernt Nicht-Fließtext am Anfang).
function cleanBody(body: string, url: string, title: string | null): string {
  let b = body;
  let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch {}

  if (/(^|\.)bild\.de$/.test(host)) {
    const i = b.indexOf("Artikel weiterlesen");
    if (i >= 0 && i < 700) b = b.slice(i + "Artikel weiterlesen".length);
    b = b.replace(/\bFoto:[^]{0,90}?\d{1,2}\.\d{2}\.\d{4}\s*[-–—]\s*\d{1,2}:\d{2}\s*Uhr/g, " ")
         .replace(/TTS-Player überspringen/g, " ")
         .replace(/Text to Speech:[^]{0,140}?(?=Artikel weiterlesen|[A-ZÄÖÜ])/g, " ")
         .replace(/Artikel weiterlesen/g, " ");
    // Bild-Bildunterschriften: ganzer Block "BILD<Caption>Foto: <Fotograf>/<Agentur>" ist kein
    // Artikeltext und wechselt, sobald Fotos getauscht/nachgetragen werden → sonst Phantom-Edits.
    b = b.replace(/BILD[\s\S]{0,400}?Foto:\s*[^/]{1,90}\/\s*BILD/g, " ");
    // Übrige Bild-Credits anderer Agenturen (ohne /BILD-Endung).
    b = b.replace(/\bFoto:\s*[^/]{1,90}\/\s*(dpa[a-z-]*|AFP|Getty[^,. ]*|Reuters|AP|action ?press|imago|picture alliance|ddp|epd|Bildagentur[^,. ]*)\b\.?/gi, " ");
  }

  if (/(^|\.)n-tv\.de$/.test(host) && title) {
    const head = title.split(/\s+[-|–]\s+/)[0].trim();
    if (head.length > 12) {
      const esc = head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      b = b.replace(new RegExp("^[\\s\\S]{0,280}?" + esc), "");
    }
  }

  if (/(^|\.)faz\.net$/.test(host)) {
    // FAZ klebt VOR den Lauftext einen Kopf-Block, der je nach Render-Zeitpunkt ganz/teilweise/
    // gar nicht im extrahierten Body landet — daraus entstehen sonst reine Phantom-Edits:
    //   "[Ressort]FAZ+<Kicker> : <Überschrift>[18.06.2026, 12:58][Lesezeit: 6 Min.]<Lauftext…>"
    // 1) "Lesezeit: N Min." (Web-Komponente) inkl. evtl. direkt davorstehendem Datum/Uhrzeit als
    //    EINHEIT entfernen — durch Space ersetzen, damit Überschrift und Lede nicht verkleben.
    b = b.replace(/(?:\d{1,2}\.\d{2}\.\d{4},\s*\d{1,2}:\d{2}\s*(?:Uhr)?\s*)?Lesezeit:\s*\d+\s*Min\.?/g, " ");
    // 2) Führender "[Ressort]FAZ+<Kicker> :"-Kopf (Ressort = ein großgeschriebenes Wort direkt davor).
    b = b.replace(/^\s*(?:[A-ZÄÖÜ][A-Za-zäöüß-]{2,20})?FAZ\+[^:]{0,80}:\s*/, "");
    // 3) Abschluss-Chrome am Ende abschneiden (wächst/wechselt je Scan → Phantom-Edits):
    //    Paywall-CTA, "Das Beste von FAZ+"-Empfehlungen, Verlags-Footer, sowie der
    //    Leserkommentar-Block ("Lesermeinungen<Nutzer><Datum>…") und Recirculation-Teaser.
    //    WICHTIG (Art. 171547): genau dieser Kommentar-/Empfehlungs-Slot ROTIERT je Scan
    //    (mal Kommentare, mal Teaser) → Readability greift ihn mal so, mal so → oszillierende
    //    Phantom-Edits (add+remove, die sich Version für Version gegenseitig aufheben).
    //    Marker VOR der FAZ+-Neutralisierung suchen (sonst sind die "FAZ+"-Anker schon weg).
    const tail = b.search(/jetzt nur \d+,\d{2}\s*€|Zugang zu allen FAZ\+|Mit einem Klick online kündbar|Das Beste von FAZ\+|Stellenmarkt\s+Verlagsangebot|FAZ\+ kostenlos testen|Lesermeinungen(?=[A-ZÄÖÜ0-9])|Quelle:\s*F\.A\.Z\./);
    if (tail > 120) b = b.slice(0, tail);
    // 4) Verbliebene "FAZ+"-Badges (FAZ-Plus-Empfehlungen/Recirculation-Teaser im Text) neutralisieren.
    b = b.replace(/\bFAZ\+/g, " ");
    // 5) Autoren-Box-Chrome: der „Folgen"-Button (Follow) in der Autorenzeile erscheint/verschwindet
    //    je Render → reine Oszillation (Art. 235745: „…Wirtschaft. Folgen Redakteurin…" ↔ „…Wirtschaft.
    //    Redakteurin…"). „Folgen" vor der (oft wiederholten) Rollen-Angabe entfernen → Body stabil.
    b = b.replace(/\.\s*Folgen\s+(?=(?:Redakteur|Redaktor|Autor|Korrespondent|Reporter|Volont[aä]r|Redaktionsleiter|Ressortleiter|Herausgeber|Kolumnist|Wirtschafts|Politik|Sport|Feuilleton)[a-zäöüß]*\b)/g, ". ");
  }

  return b.replace(/\s+/g, " ").trim();
}

// Body + Liveblog-Flag fürs Change-Tracking bestimmen (verlagsübergreifend). Für echte
// Liveblogs den vollständigen JSON-LD-Ticker bevorzugen; sonst den (bereinigten) Readability-Body.
function trackBody(html: string, url: string, art: { body: string } | null, metaIsLive: boolean, title: string | null = null): { body: string; isLive: boolean } | null {
  const live = extractLiveBlog(html);
  if (live) return { body: live.body, isLive: true }; // JSON-LD-Ticker ist sauber → nicht bereinigen
  if (art) return { body: cleanBody(art.body, url, title), isLive: metaIsLive };
  const fb = extractBodyFallback(html, url); // z.B. Spiegel: Readability scheiterte
  return fb ? { body: cleanBody(fb.body, url, title), isLive: metaIsLive } : null;
}

type PrevState = { title: string | null; content_hash: string | null; para_fps: string | null; body_words: number | null; extension_count: number | null; edit_count: number | null; revision_count: number | null; article_type: string | null; description: string | null; og_image: string | null; paywalled: boolean | null; author_status: string | null; topic: string | null } | null;

// Spalten der `articles`-Basistabelle, die wir je Scan vergleichen, um UNSICHTBARE Edits zu
// finden. Müssen in BEIDEN prev-Selects (saveArticleFull + analyzeBacklog) mitgelesen werden.
const PREV_COLS = "title,content_hash,para_fps,body_words,extension_count,edit_count,revision_count,article_type,scan_count,scan_times,paywalled,published_at,description,og_image,author_status,topic";

type MetaNow = { description: string | null; og_image: string | null; paywalled: boolean | null; author_status: string | null; topic: string | null };
type MetaEdit = { field: string; old: string | null; new: string | null };

// Unsichtbare Metadaten-Edits zwischen zwei Scans erkennen: Teaser/Description, Vorschaubild,
// Ressort, Paywall-Status, Autoren-Status — still geändert, ohne den Fließtext anzufassen.
// Bewusst KONSERVATIV: nur echte Wechsel zwischen zwei belastbaren Werten, damit
// Extraktions-Rauschen (mal kein Bild geliefert, Byline kurz nicht erkannt) nicht als Edit zählt.
function buildMetaEdits(prev: NonNullable<PrevState>, m: MetaNow | null): MetaEdit[] {
  if (!m) return [];
  const out: MetaEdit[] = [];
  const norm = (s: string | null | undefined) => (s ? decodeEntities(s) : "");
  if (norm(prev.description) && norm(m.description) && norm(prev.description) !== norm(m.description))
    out.push({ field: "description", old: prev.description!, new: m.description! });          // Teaser umformuliert
  if (prev.og_image && m.og_image && prev.og_image !== m.og_image)
    out.push({ field: "og_image", old: prev.og_image, new: m.og_image });                     // Vorschaubild getauscht
  if (prev.topic && m.topic && prev.topic !== m.topic)
    out.push({ field: "topic", old: prev.topic, new: m.topic });                              // Ressort umsortiert
  if (typeof prev.paywalled === "boolean" && typeof m.paywalled === "boolean" && prev.paywalled !== m.paywalled)
    out.push({ field: "paywalled", old: String(prev.paywalled), new: String(m.paywalled) });  // Paywall an/aus (kein null)
  if (prev.author_status && m.author_status && prev.author_status !== m.author_status
      && prev.author_status !== "none" && m.author_status !== "none")
    out.push({ field: "author_status", old: prev.author_status, new: m.author_status });      // named<->anonymous (none zu flaky)
  return out;
}

// Rollende Historie der letzten Inhalts-Hashes (für die verlagsübergreifende Oszillations-
// Erkennung). Gleichen Hash ans Ende ziehen (dedup), max. `keep` behalten.
function pushHash(recent: string[], h: string, keep = 8): string {
  return [...recent.filter((x) => x !== h), h].slice(-keep).join(",");
}
// articles-Update, das die optionale Spalte `recent_hashes` GRACEFUL behandelt: existiert sie
// (noch) nicht (kein ALTER gelaufen), wird das Feld weggelassen und erneut versucht → der
// Scraper läuft weiter, der Oszillations-Schutz ist dann nur inaktiv.
async function updateArticle(articleId: number, fields: Record<string, unknown>) {
  let { error } = await sb.from("articles").update(fields).eq("id", articleId);
  if (error && /recent_hashes/i.test(error.message)) {
    const rest = { ...fields }; delete (rest as any).recent_hashes;
    ({ error } = await sb.from("articles").update(rest).eq("id", articleId));
  }
  if (error) console.error("ARTICLE-UPDATE-FEHLER:", error.message);
}

// Vergleicht neuen Inhalt mit dem letzten Stand und schreibt bei echter Änderung einen Snapshot.
// Unterscheidet "extension" (nur hinzugefügt = valide Erweiterung, z.B. Timeline-Artikel) von
// "edit" (entfernt/ersetzt = stille Änderung) und "mixed".
async function trackChanges(articleId: number, prev: PrevState, newTitle: string | null, body: string, url: string, isLiveblog: boolean, prevPub: string | null = null, newPub: string | null = null, metaNow: MetaNow | null = null) {
  const paras = normalizeParas(body);
  if (!paras.length) return;
  const fps = paras.map(fp);
  const contentHash = fp(fps.join("|"));
  const bodyWords = body.trim().split(/\s+/).length;

  // Erstkontakt: nur Baseline-Fingerprint + Absätze speichern, kein Snapshot.
  if (!prev || !prev.content_hash) {
    await updateArticle(articleId, {
      content_hash: contentHash, para_fps: fps.join(","), body_words: bodyWords,
      recent_hashes: pushHash([], contentHash),
      ...(isLiveblog ? { article_type: "liveblog" } : {}),
    });
    await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
    return;
  }
  // Rollende Hash-Historie laden (separat + graceful: fehlt die Spalte, bleibt der Schutz inaktiv).
  let recentHashes: string[] = [];
  {
    const { data: rh, error: rhErr } = await sb.from("articles").select("recent_hashes").eq("id", articleId).maybeSingle();
    if (!rhErr && (rh as any)?.recent_hashes) recentHashes = String((rh as any).recent_hashes).split(",").filter(Boolean);
  }
  // Re-Baseline-Schutz: Eine ALTE Baseline (Bild/n-tv) kann noch Verlags-Kopf-Chrome enthalten,
  // das cleanBody inzwischen entfernt. Ein reiner Extraktions-Unterschied darf KEINEN Edit erzeugen
  // und keinen Chrome-Text in den Diff schreiben → alte Absätze identisch normalisieren und damit
  // vergleichen. Nur für betroffene Hosts und nur wenn sich der Inhalt überhaupt geändert hat.
  let prevFps = (prev.para_fps ?? "").split(",").filter(Boolean);
  let prevHash = prev.content_hash;
  let oldParasClean: string[] | null = null;
  let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (prevHash !== contentHash && (/(^|\.)bild\.de$/.test(host) || /(^|\.)n-tv\.de$/.test(host) || /(^|\.)faz\.net$/.test(host))) {
    const { data: pr } = await sb.from("article_paras").select("paras").eq("article_id", articleId).maybeSingle();
    const raw: string[] = Array.isArray(pr?.paras) ? (pr!.paras as string[]) : [];
    if (raw.length) {
      oldParasClean = normalizeParas(cleanBody(raw.join("\n\n"), url, newTitle));
      prevFps = oldParasClean.map(fp);
      prevHash = fp(prevFps.join("|"));
    }
  }

  const titleChanged = !!prev.title && !!newTitle && decodeEntities(prev.title) !== decodeEntities(newTitle);
  // Verlage ändern beim Bearbeiten oft (nicht immer) STILL das Veröffentlichungsdatum mit.
  // Als unsichtbare Änderung mit-tracken. ≥60 s Differenz, damit Format-/Sekundenjitter nicht zählt.
  // WICHTIG (alle Verlage): gegen den ZULETZT von der SEITE gemeldeten Wert prüfen (letztes
  // Snapshot-`pubdate_new`), NICHT gegen die kanonische `published_at`. Sonst feuert eine STABILE
  // Quellen-Uneinigkeit (Sitemap-Zeit ≠ Seiten-Zeit; Discovery setzt published_at je Lauf zurück)
  // bei JEDEM Scan erneut → identisch aussehende Pseudo-„Datums-Edits".
  let pubBaseline = prevPub;
  if (!!prevPub && !!newPub && Math.abs(Date.parse(newPub) - Date.parse(prevPub)) >= 60000) {
    const { data: lastPd } = await sb.from("article_snapshots")
      .select("pubdate_new").eq("article_id", articleId).not("pubdate_new", "is", null)
      .order("captured_at", { ascending: false }).limit(1).maybeSingle();
    if ((lastPd as any)?.pubdate_new) pubBaseline = (lastPd as any).pubdate_new as string;
  }
  const pubChanged = !!pubBaseline && !!newPub && Math.abs(Date.parse(newPub) - Date.parse(pubBaseline)) >= 60000;
  // Unsichtbare Metadaten-Edits (Teaser/Bild/Ressort/Paywall/Autor) — das „zwischen den Zeilen".
  const metaEdits = buildMetaEdits(prev, metaNow);
  const metaChanged = metaEdits.length > 0;
  if (prevHash === contentHash && !titleChanged && !pubChanged && !metaChanged) {
    // Kein echter Unterschied (oder nur weggefallenes Chrome) → Baseline still auf die saubere
    // Fassung nachziehen, KEINEN Snapshot schreiben.
    if (prevHash !== prev.content_hash) {
      await sb.from("articles").update({ content_hash: contentHash, para_fps: fps.join(","), body_words: bodyWords }).eq("id", articleId);
      await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
    }
    return;
  }

  // Absatz-Diff
  const oldSet = new Set(prevFps);
  const newSet = new Set(fps);
  const fpToText = new Map(paras.map((p, i) => [fps[i], p]));
  const addedFps = fps.filter((f) => !oldSet.has(f));
  const addedTexts = [...new Set(addedFps)].map((f) => fpToText.get(f)!).filter(Boolean);
  const removedCount = [...oldSet].filter((f) => !newSet.has(f)).length;
  const contentChanged = addedFps.length > 0 || removedCount > 0;

  // Nur reine Umsortierung (gleiche Absätze, andere Reihenfolge) → kein Snapshot.
  // Absätze sind durch normalizeParas bereits ≥60 Zeichen, daher zählt jeder echte Zugang.
  if (!titleChanged && !pubChanged && !metaChanged && addedFps.length === 0 && removedCount === 0) {
    await sb.from("articles").update({ content_hash: contentHash, para_fps: fps.join(","), body_words: bodyWords }).eq("id", articleId);
    await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
    return;
  }

  // Strukturierter Wort-Diff NUR bei echter Inhaltsänderung. Reine Datums-/Meta-Edits
  // (contentChanged=false) bekommen KEINEN Body-Diff — sonst erzeugt eine para_fps↔article_paras-
  // Diskrepanz einen Geister-„entfernten" Absatz (zweite Ursache der V3/V4-Pseudo-Edits).
  // Falls der Re-Baseline-Schutz die alte Baseline schon bereinigt geladen hat, die nutzen.
  let oldParas: string[] = [];
  if (contentChanged) {
    if (oldParasClean) oldParas = oldParasClean;
    else {
      const { data: paraRow } = await sb.from("article_paras").select("paras").eq("article_id", articleId).maybeSingle();
      oldParas = Array.isArray(paraRow?.paras) ? (paraRow!.paras as string[]) : [];
    }
  }
  // Liveblog/Ticker/Timeline gelten als WACHSEND (auch wenn die Live-Erkennung bei EINEM Scan
  // mal scheitert) — ein einmal erkannter Liveblog bleibt einer. Für ALLE Verlage.
  const isTimeline = isLiveblog || prev.article_type === "liveblog" || prev.article_type === "timeline" || (prev.extension_count ?? 0) >= 2;

  // Diff aufbauen. Bei Liveblogs/Timelines NUR Neuzugänge führen: „entfernt" ist dort fast immer
  // Re-Segmentierung durch lazyload/Re-Render (kein echtes Verschwinden) — sonst erschiene es als
  // „geänderte Passage" und sähe aus wie viele stille Edits. removed=0 für den Snapshot.
  let removedForSnap = removedCount;
  let changes: Change[];
  if (!contentChanged) {
    changes = [];
  } else if (isTimeline) {
    changes = addedTexts.map((t) => ({ new: t.slice(0, 1500) }));
    removedForSnap = 0;
  } else {
    changes = buildChanges(oldParas.filter((p) => !newSet.has(fp(p))), addedTexts);
  }

  // Verlagsübergreifender Phantom-Schutz: Fingerprints unterschieden sich (addedFps/removed > 0),
  // aber es bleibt KEIN sichtbarer Unterschied übrig (nur getauschte Bild-Credits jenseits des
  // Fensters, Re-Segmentierung o.Ä.) → KEIN Snapshot, Baseline still nachziehen.
  if (!isTimeline && contentChanged && changes.length === 0 && !titleChanged && !pubChanged && !metaChanged) {
    await sb.from("articles").update({ content_hash: contentHash, para_fps: fps.join(","), body_words: bodyWords }).eq("id", articleId);
    await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
    return;
  }

  // Eindeutige Klassifikation (sich gegenseitig ausschließend):
  //  - Liveblog/Timeline: laufendes Wachstum → IMMER Erweiterung (kein "stiller Edit").
  //  - Sonst stille Titeländerung → Edit (das journalistisch interessante Signal).
  //  - Sonst Netto-Zuwachs (mehr hinzu als entfernt) → Erweiterung.
  //  - Sonst (Umschreiben/Kürzen) → Edit.
  let kind: "extension" | "edit";
  if (!contentChanged && !titleChanged && (pubChanged || metaChanged)) kind = "edit"; // reines Um-Datieren / Metadaten-Edit = stille Änderung
  else if (isTimeline) kind = "extension";
  else if (titleChanged) kind = "edit";
  else if (addedFps.length > removedCount) kind = "extension";
  else kind = "edit";

  // OSZILLATIONS-SCHUTZ (verlagsübergreifend): Springt der Inhalt auf einen KÜRZLICH dagewesenen
  // Stand zurück (A→B→A…, typisch für rotierendes Chrome wie den FAZ-„Folgen"-Button, wechselnde
  // Werbe-/Empfehlungs-Slots) und ist sonst NICHTS Echtes geändert (kein Titel/Datum/Meta), dann
  // KEINEN Snapshot schreiben — nur Baseline + Historie still nachziehen. So hört die endlose
  // Wiederholung im Änderungsverlauf auf (Art. 235745). Liveblogs/Ticker ausgenommen (echtes Wachstum).
  if (contentChanged && !isTimeline && !titleChanged && !pubChanged && !metaChanged && recentHashes.includes(contentHash)) {
    await updateArticle(articleId, {
      content_hash: contentHash, para_fps: fps.join(","), body_words: bodyWords,
      recent_hashes: pushHash(recentHashes, contentHash),
    });
    await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
    return;
  }

  const snapRow: Record<string, unknown> = {
    article_id: articleId, change_kind: kind,
    title_old: titleChanged ? decodeEntities(prev.title!) : null,
    title_new: titleChanged ? decodeEntities(newTitle!) : null,
    added: contentChanged ? addedTexts.join("\n\n").slice(0, 8000) : "",
    added_count: addedFps.length, removed_count: removedForSnap,
    word_delta: bodyWords - (prev.body_words ?? bodyWords),
    changes,
  };
  if (pubChanged) { snapRow.pubdate_old = pubBaseline; snapRow.pubdate_new = newPub; }
  if (metaChanged) snapRow.meta_edits = metaEdits;
  let { error: snapErr } = await sb.from("article_snapshots").insert(snapRow);
  // Optionale Spalten (pubdate_old/new, meta_edits) evtl. noch nicht via ALTER angelegt →
  // Snapshot ohne diese Felder retten, statt ihn ganz zu verlieren.
  if (snapErr && /pubdate|meta_edits/i.test(snapErr.message)) {
    delete snapRow.pubdate_old; delete snapRow.pubdate_new; delete snapRow.meta_edits;
    ({ error: snapErr } = await sb.from("article_snapshots").insert(snapRow));
  }
  if (snapErr) console.error("SNAPSHOT-FEHLER:", snapErr.message);

  const extCount = (prev.extension_count ?? 0) + (kind === "extension" ? 1 : 0);
  const editCount = (prev.edit_count ?? 0) + (kind === "edit" ? 1 : 0);
  // Kategorie "timeline": mehrfach erweitert (echter, über Tage wachsender Artikel)
  const newType = isLiveblog ? "liveblog" : (extCount >= 2 ? "timeline" : undefined);
  await updateArticle(articleId, {
    content_hash: contentHash, para_fps: fps.join(","), title: newTitle, body_words: bodyWords,
    revision_count: (prev.revision_count ?? 0) + 1, extension_count: extCount, edit_count: editCount,
    recent_hashes: pushHash(recentHashes, contentHash),
    ...(newType ? { article_type: newType } : {}),
  });
  await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
}

// Absatzliste speicherschonend kappen (große Liveblogs): max 400 Absätze, je 2000 Zeichen.
function capParas(paras: string[]): string[] {
  return paras.slice(-400).map((p) => p.slice(0, 2000));
}

// Token-Ähnlichkeit (Jaccard) zum Paaren geänderter Absätze.
function tokens(s: string): Set<string> { return new Set(s.toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? []); }
function similarity(a: string, b: string): number {
  const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Entfernte ↔ hinzugefügte Absätze paaren → strukturierter Diff:
//  {old,new} = geänderter Absatz (Wort-Diff im Frontend), {new} = neu, {old} = entfernt.
type Change = { old?: string; new?: string };
// Bei einem GEÄNDERTEN Absatz nur die tatsächlich abweichende Stelle (mit Kontext) speichern.
// Sonst zeigt ein Riesen-Absatz, dessen Änderung jenseits von 1500 Zeichen liegt, identischen
// Anfangstext → scheinbar „leerer" stiller Edit. Gemeinsamen Prä-/Suffix abschneiden.
function diffRegion(o: string, n: string, ctx = 140, cap = 1500): [string, string] {
  const minL = Math.min(o.length, n.length);
  let p = 0; while (p < minL && o[p] === n[p]) p++;
  let so = o.length - 1, sn = n.length - 1;
  while (so >= p && sn >= p && o[so] === n[sn]) { so--; sn--; }
  const start = Math.max(0, p - ctx);
  const oEnd = Math.min(o.length, so + 1 + ctx);
  const nEnd = Math.min(n.length, sn + 1 + ctx);
  const lead = start > 0 ? "…" : "";
  const oOut = (lead + o.slice(start, oEnd) + (oEnd < o.length ? "…" : "")).slice(0, cap);
  const nOut = (lead + n.slice(start, nEnd) + (nEnd < n.length ? "…" : "")).slice(0, cap);
  return [oOut, nOut];
}
function buildChanges(removed: string[], added: string[]): Change[] {
  const rem = [...removed], usedR = new Set<number>();
  const out: Change[] = [];
  for (const a of added) {
    let best = -1, bestSim = 0;
    rem.forEach((r, i) => { if (usedR.has(i)) return; const s = similarity(a, r); if (s > bestSim) { bestSim = s; best = i; } });
    if (best >= 0 && bestSim >= 0.35) {
      usedR.add(best);
      const [o2, n2] = diffRegion(rem[best], a);
      // Identische Region = kein SICHTBARER Unterschied (Differenz lag außerhalb des Fensters
      // oder nur weggeputztes Chrome) → KEIN „leerer" Edit-Eintrag. Verlagsübergreifend.
      if (o2 !== n2) out.push({ old: o2, new: n2 });
    }
    else out.push({ new: a.slice(0, 1500) });
  }
  rem.forEach((r, i) => { if (!usedR.has(i)) out.push({ old: r.slice(0, 1500) }); });
  return out.slice(0, 30);
}

// Paywall „sticky": einmal als Paywall erkannt → bleibt Paywall. Nur ein
// VERLÄSSLICHES Frei-Signal (next === false aus JSON-LD) oder ein neuer
// Paywall-Befund (true) ändert es. Kein Signal (next === null) → bestehenden
// Wert behalten. Verhindert, dass Stub-/Teaser-Renders (z.B. Le Monde 402) eine
// bestehende Paywall fälschlich auf „frei" setzen. Metadaten werden trotzdem geholt.
function stickyPaywall(prev: boolean | null | undefined, next: boolean | null): boolean | null {
  if (prev === true) return true;
  if (next === null || next === undefined) return prev ?? null;
  return next;
}

// TEMP-Diagnose: echte Paywall-Signale je GERENDERTEM Artikel protokollieren, um verlags-
// übergreifend treffsichere Erkennung abzuleiten (das statische HTML trägt das Signal nicht).
// Gedeckelt je Host, nur Paywall-relevante Verlage → kein Log-Überlauf. Nach Auswertung entfernen.
const PAYDIAG_CAP = 60;
const payDiagSeen: Record<string, number> = {};
function payDiag(html: string, url: string, decided: boolean | null) {
  let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch { return; }
  if (!/(^|\.)(faz\.net|bild\.de|spiegel\.de)$/.test(host)) return;
  if ((payDiagSeen[host] ?? 0) >= PAYDIAG_CAP) return;
  payDiagSeen[host] = (payDiagSeen[host] ?? 0) + 1;
  const probes: [string, RegExp][] = [
    ["iaff-false", /"isAccessibleForFree"\s*:\s*"?false"?/i],
    ["iaff-true", /"isAccessibleForFree"\s*:\s*"?true"?/i],
    ["haspart", /"hasPart"/i],
    ["jetzt-kostenlos", /Jetzt kostenlos/i],
    ["f-plus", /\bF\+\b/],
    ["bildplus", /BILDplus/i],
    ["spiegelplus", /SPIEGEL\s?\+|\bS\+\b/],
    ["weiterlesen-mit", /weiterlesen mit/i],
    ["piano", /tp-modal|tp-container|class="[^"]*piano|id="piano"/i],
    ["abo-schranke", /nur mit Abo|Abonnement erforderlich|Zugang erforderlich|Diese Funktion ist .{0,20}Abonnenten/i],
  ];
  const markers = probes.filter(([, re]) => re.test(html)).map(([n]) => n);
  console.log(`PAYDIAG host=${host} decided=${decided} markers=[${markers.join(",")}]`);
}

// Artikel vollständig speichern: Metadaten + Dimensionen + Änderungs-Tracking.
async function saveArticleFull(sourceId: number, url: string, html: string) {
  url = canonUrl(url); // n-tv-Ticker-Varianten → Kanonik, damit prev/upsert/Tracking konsistent EINE Zeile treffen
  const meta = extractMeta(html, url);
  const art = asArticle(html, url);
  // Vorzustand VOR dem Upsert lesen (sonst überschreibt upsertArticle den alten Titel).
  const { data: prev } = await sb.from("articles")
    .select(PREV_COLS)
    .eq("url", url).maybeSingle();
  meta.paywalled = stickyPaywall((prev as any)?.paywalled, meta.paywalled); // Paywall nie fälschlich aufheben
  // Präzises Datum (z.B. aus News-Sitemap) NICHT durch den URL-Mittags-Notnagel überschreiben.
  if (!meta.published_precise && (prev as any)?.published_at) meta.published_at = (prev as any).published_at;
  const id = await upsertArticle(sourceId, url, meta, { scan_count: ((prev as any)?.scan_count ?? 0) + 1, scan_times: appendScan((prev as any)?.scan_times) });
  await upsertDimensions(id, meta.authors, meta.keywords, meta.categories);
  const tb = trackBody(html, url, art, meta.article_type === "liveblog", meta.title ?? art?.title ?? null);
  if (tb) await trackChanges(id, (prev as PrevState) ?? null, meta.title ?? art?.title ?? null, tb.body, url, tb.isLive, (prev as any)?.published_at ?? null, meta.published_at ?? null, { description: meta.description, og_image: meta.og_image, paywalled: meta.paywalled, author_status: meta.author_status, topic: meta.topic });
  return id;
}

// "Mehr laden"-Buttons auf Timeline-/Liveblog-Seiten ausklicken, damit ÄLTERE Meldungen
// im DOM landen. Ohne das vergleicht das Änderungs-Tracking nur das sichtbare Fenster und
// meldet falsche "Entfernungen", wenn Meldungen aus dem Erstausschnitt rutschen.
// Verlagsübergreifende Textmuster (DE+FR); klickt bis nichts mehr wächst (max 12 Runden).
const LOAD_MORE_RX = /^(mehr laden|mehr anzeigen|weitere (beiträge|meldungen|artikel|einträge)( laden| anzeigen)?|(ältere|frühere) (beiträge|meldungen|einträge)( laden| anzeigen)?|alle (beiträge|meldungen) anzeigen|nachladen|mehr beiträge|load more|show more|charger plus|voir plus|plus de messages|afficher plus|lire la suite du live)$/i;
async function expandTimeline(page: import("playwright").Page, maxRounds = 12): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    const before = await page.evaluate(() => document.body?.innerText.length ?? 0);
    const clicked = await page.evaluate((rxSrc: string) => {
      const rx = new RegExp(rxSrc, "i");
      const els = [...document.querySelectorAll<HTMLElement>("button, a[role=button], a.more, [class*='load-more'], [class*='loadmore'], [class*='show-more']")];
      const btn = els.find((e) => rx.test((e.innerText || "").trim().replace(/\s+/g, " ")) && e.offsetParent !== null);
      if (btn) { btn.scrollIntoView({ block: "center" }); btn.click(); return true; }
      return false;
    }, LOAD_MORE_RX.source).catch(() => false);
    if (!clicked) break;
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => document.body?.innerText.length ?? 0).catch(() => before);
    if (after <= before + 50) break; // nichts Neues mehr gekommen
  }
}

// Lazy-/Infinite-Load anstoßen: in Schritten bis ans Seitenende scrollen, bis die
// Höhe stabil bleibt (alle nachladenden Inhalte im DOM) oder das Zeitbudget aus ist.
// Läuft für ALLE Verleger — billig für statische Seiten (Höhe sofort stabil → früher
// Abbruch), gründlich für dynamische (Ticker/Timeline, JS-gerenderter Inhalt). Ohne
// das erwischt jeder Scan ein anderes Teilfragment → das Change-Tracking meldet
// Pseudo-Änderungen, die nur „noch nicht nachgeladen" waren (z.B. Bild-Live-Ticker:
// Body 180 Wörter, 33× „erweitert", word_delta schwankt ±200). Danach zurück nach
// oben, damit Readability sauber den Hauptinhalt greift.
async function autoScroll(page: import("playwright").Page, maxMs = 6000): Promise<void> {
  await page.evaluate(async (budget) => {
    await new Promise<void>((resolve) => {
      const t0 = Date.now();
      let lastH = -1, stable = 0;
      const tick = () => {
        const h = document.documentElement.scrollHeight;
        window.scrollTo(0, h);
        if (h === lastH) { if (++stable >= 2) return resolve(); }
        else { stable = 0; lastH = h; }
        if (Date.now() - t0 > budget) return resolve();
        setTimeout(tick, 250);
      };
      tick();
    });
  }, maxMs).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

// Eine Seite im echten Browser rendern. Liefert HTTP-Status + gerendertes HTML.
// VOR dem Auslesen wird IMMER vollständig nachgeladen: erst autoScroll (lazy/infinite
// für alle Verleger), dann Button-Expansion (self-gating — ohne passenden Button
// sofort fertig). expand=true (erkannter Live-/Timeline-Inhalt) → gründlicher.
async function renderPage(ctx: BrowserContext, url: string, expand = false): Promise<{ status: number; html: string | null }> {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const status = resp?.status() ?? 0;
    // Nur erkannte Liveblogs/Timelines vollständig nachladen (autoScroll + Button-Expansion).
    // Normale Artikel haben den Volltext schon im Erst-Render → kein Scroll nötig; und der
    // Liveblog-Ticker kommt ohnehin aus JSON-LD (serverseitig, scroll-unabhängig). autoScroll
    // auf JEDEM Render war der Haupt-Laufzeit-Regress (10 → 25 min) → hier gezielt gegated.
    if (expand) {
      await autoScroll(page, 4500);
      await expandTimeline(page, 6);
    }
    const html = await page.content();
    return { status, html };
  } catch {
    return { status: 0, html: null };
  } finally {
    await page.close();
  }
}

// Schnelle Link-Entdeckung OHNE Browser: rohes HTML per HTTP holen. Für
// Rubriken/Hubs/Übersichten reicht das fast immer (Navigation steht
// serverseitig im HTML). Spart das Gros der Browser-Zeit → erlaubt tiefe,
// ganzheitliche Crawls. Artikel werden weiterhin mit Chromium gerendert
// (Body/Paywall/JSON-LD/Liveblog-Expansion).
async function fetchHtml(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const resp = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "de,fr;q=0.8,en;q=0.6" },
      redirect: "follow", signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    if (!/text\/html|xhtml/i.test(resp.headers.get("content-type") ?? "")) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Feed-Auto-Erkennung aus dem HTML-Head: <link rel="alternate" type="…rss/atom…" href>.
function extractFeedLinks(html: string, pageUrl: string): string[] {
  const out = new Set<string>();
  const rx = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null) {
    const tag = m[0];
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try { out.add(new URL(href, pageUrl).href); } catch {}
  }
  return [...out];
}

// XML/Feed holen — eigene Funktion, da fetchHtml nur text/html akzeptiert.
async function fetchXml(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const resp = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Artikel-URLs aus RSS/Atom: <item><link>URL</link>, Atom <link href="URL"/>, <guid>URL</guid>.
function extractFeedItemUrls(xml: string, baseUrl: string): string[] {
  const out = new Set<string>();
  let origin = ""; try { origin = new URL(baseUrl).origin; } catch {}
  const add = (raw?: string) => {
    if (!raw) return;
    try { const abs = new URL(raw.trim(), baseUrl).href; if (!origin || abs.startsWith(origin)) out.add(stripHash(abs)); } catch {}
  };
  for (const m of xml.matchAll(/<link>\s*([^<]+?)\s*<\/link>/gi)) add(m[1]);
  for (const m of xml.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/gi)) add(m[1]);
  for (const m of xml.matchAll(/<guid[^>]*>\s*(https?:\/\/[^<]+?)\s*<\/guid>/gi)) add(m[1]);
  return [...out];
}

// Sitemap-Harvesting: robots.txt → Sitemap-Einträge (+ /sitemap.xml als Fallback),
// Sitemap-Index eine Ebene auflösen (neueste/News-Sitemaps bevorzugt), Artikel-URLs
// extrahieren und als 'article'-Knoten markieren → analyze rendert sie nach.
// Der größte, billigste Hebel: News-Sitemaps listen praktisch alle aktuellen Artikel.
const MAX_SITEMAP_URLS = Number(process.env.CRAWL_MAX_SITEMAP_URLS ?? 3000);

// News-Sitemap-Datum normalisieren: gültiger Zeitstempel → ISO (UTC), sonst null.
function sitemapDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

async function harvestSitemaps(src: Source, deadline: number): Promise<number> {
  let origin = ""; try { origin = new URL(src.base_url).origin; } catch { return 0; }
  const seen = new Set<string>();
  const recentFirst = (urls: string[]) =>
    urls.sort((a, b) => (/(news|aktuell|recent|article|\d{4})/i.test(b) ? 1 : 0) - (/(news|aktuell|recent|article|\d{4})/i.test(a) ? 1 : 0));

  // 1) Sitemap-URLs aus robots.txt (+ Fallback)
  let sitemaps: string[] = [];
  const robots = await fetchXml(`${origin}/robots.txt`);
  if (robots) for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) { try { sitemaps.push(new URL(m[1], origin).href); } catch {} }
  if (!sitemaps.length) sitemaps = [`${origin}/sitemap.xml`, `${origin}/news-sitemap.xml`, `${origin}/sitemap-news.xml`];
  sitemaps = recentFirst([...new Set(sitemaps)]);

  const arts = new Set<string>();
  // Exakte Veröffentlichungszeit je URL aus der News-Sitemap. precise=true nur bei
  // <news:publication_date> (autoritativ) — false beim <lastmod>-Fallback (= Änderungs-,
  // nicht Erscheinungszeit → darf einen vorhandenen Wert nur füllen, nie überschreiben).
  const pubDates = new Map<string, { at: string; precise: boolean }>();
  let files = 0;
  const MAX_FILES = 10;
  const grabLocs = (xml: string) => {
    // URLs einsammeln (tolerant ggü. Sitemap-Struktur, wie bisher).
    for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
      const u = stripHash(m[1].trim());
      if (u.startsWith(origin) && looksLikeArticle(u)) arts.add(u);
    }
    // Pro <url>-Block die Veröffentlichungszeit ziehen (publication_date > lastmod).
    for (const block of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
      const inner = block[1];
      const loc = /<loc>\s*([^<]+?)\s*<\/loc>/i.exec(inner)?.[1];
      if (!loc) continue;
      const u = stripHash(loc.trim());
      if (!(u.startsWith(origin) && looksLikeArticle(u))) continue;
      const pd = sitemapDate(/<(?:\w+:)?publication_date>\s*([^<]+?)\s*<\/(?:\w+:)?publication_date>/i.exec(inner)?.[1]);
      const lm = sitemapDate(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(inner)?.[1]);
      if (pd) pubDates.set(u, { at: pd, precise: true });
      else if (lm && !pubDates.has(u)) pubDates.set(u, { at: lm, precise: false });
    }
  };

  for (const sm of sitemaps) {
    if (files >= MAX_FILES || arts.size >= MAX_SITEMAP_URLS || Date.now() > deadline) break;
    if (seen.has(sm)) continue; seen.add(sm);
    const xml = await fetchXml(sm);
    if (!xml) continue;
    files++;
    if (/<sitemapindex/i.test(xml)) {
      // Index → Kind-Sitemaps (neueste/News zuerst), nur ein paar laden
      const childs = recentFirst([...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim()));
      for (const c of childs.slice(0, 6)) {
        if (files >= MAX_FILES || arts.size >= MAX_SITEMAP_URLS || Date.now() > deadline) break;
        if (seen.has(c)) continue; seen.add(c);
        const cx = await fetchXml(c);
        if (cx) { files++; grabLocs(cx); }
      }
    } else {
      grabLocs(xml);
    }
  }

  const list = [...arts].slice(0, MAX_SITEMAP_URLS);
  if (list.length && !DRY_RUN) {
    try {
      for (let i = 0; i < list.length; i += 200) {
        await sb.from("pages").upsert(
          list.slice(i, i + 200).map((url) => ({ source_id: src.id, url: canonUrl(url), kind: "article", depth: 1 })),
          { onConflict: "url", ignoreDuplicates: true },
        );
      }
    } catch (e) { console.error("SITEMAP-FEHLER:", src.base_url, (e as Error).message); }
  }
  // Präzise Veröffentlichungszeiten aus der Sitemap vorab in `articles` einpflegen
  // ({source_id,url,published_at} — Rest nullable). So hat z.B. Le Monde (Render → 402)
  // die EXAKTE Zeit statt nur den URL-Mittags-Notnagel. publication_date ist autoritativ
  // → überschreibt (auch den Notnagel); lastmod (= Änderungszeit) nur füllen, nie
  // überschreiben. precise-sticky in saveArticleFull/enrich schützt den Wert beim Render.
  const dated = list.filter((u) => pubDates.has(u));
  if (dated.length && !DRY_RUN) {
    const writeDates = async (urls: string[], ignoreDuplicates: boolean) => {
      for (let i = 0; i < urls.length; i += 200) {
        await sb.from("articles").upsert(
          urls.slice(i, i + 200).map((url) => ({ source_id: src.id, url: canonUrl(url), published_at: pubDates.get(url)!.at })),
          { onConflict: "url", ignoreDuplicates },
        );
      }
    };
    try {
      await writeDates(dated.filter((u) => pubDates.get(u)!.precise), false);  // publication_date → überschreibt
      await writeDates(dated.filter((u) => !pubDates.get(u)!.precise), true);  // nur lastmod → nur neue Zeilen
    } catch (e) { console.error("SITEMAP-DATUM-FEHLER:", src.base_url, (e as Error).message); }
  }
  console.log(`Sitemaps ${src.base_url}: ${files} Dateien gelesen, ${list.length} Artikel-URLs markiert (${dated.length} mit Datum)`);
  return list.length;
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
  // Autorenprofile (FAZ /redaktion/, Tagesschau /korrespondenten/, /autor|/auteur) — keine Artikel
  if (/\/(redaktion|autor(en)?|auteurs?|author|journalist|kolumnisten|signataires|korrespondenten|korrespondent)\//.test(u)) return false;
  // Themen-Hubs / Special-Übersichten (Bild /themen/specials/, allgemeine /thema(s)/-Sammlungen)
  if (/\/themen?\/(specials?|organisationen|personen)\//.test(u)) return false;
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

// Positives Artikel-Signal: JSON-LD trägt einen Artikel-Typ ODER og:type=article.
// Hub-/Landingpages tragen WebPage/CollectionPage/NewsMediaOrganization → kein Signal.
function hasArticleSignal(html: string): boolean {
  const types = parseJsonLd(html).flatMap((d) => (Array.isArray(d["@type"]) ? d["@type"] : [d["@type"]])).filter(Boolean) as string[];
  if (types.some((t) => /(News)?Article|LiveBlogPosting|ReportageNewsArticle|OpinionNewsArticle|ReviewNewsArticle|AnalysisNewsArticle|BlogPosting|Report\b/i.test(t))) return true;
  if (/property=["']og:type["'][^>]+content=["']article["']/i.test(html) || /content=["']article["'][^>]+property=["']og:type["']/i.test(html)) return true;
  return false;
}

// Gerenderte Seite als Artikel lesen (sichtbarer Text). null = eher Übersichtsseite/Hub.
function asArticle(html: string, url: string): { title: string; teaser: string; body: string } | null {
  try {
    const dom = makeDom(html, url);
    const a = new Readability(dom.window.document).parse();
    if (!a || !a.title?.trim() || (a.textContent?.length ?? 0) < MIN_BODY) return null;
    // Link-Dichte des EXTRAHIERTEN Inhalts: Hubs liefern Teaser-Linklisten statt Fließtext.
    const linkCount = (a.content?.match(/<a\b/gi) ?? []).length;
    const dens = linkCount / Math.max(1, (a.textContent?.length ?? 1) / 100);
    if (dens > 2.5) return null; // viele Links, wenig Text → Linkliste/Hub, kein Artikel
    return { title: a.title.trim(), teaser: (a.excerpt ?? "").trim(), body: a.textContent ?? "" };
  } catch {
    return null;
  }
}

// Fallback-Body, wenn Readability scheitert (z.B. Spiegel-Newsblogs: reines Client-Render,
// KEIN JSON-LD → asArticle liefert null → body_words blieb leer). Greift den größten
// Artikel-Container im GERENDERTEN DOM und zieht dessen Absätze als Text. Läuft nur als
// letzte Stufe in trackBody (nach JSON-LD & Readability), daher kein Risiko für saubere
// Artikel; die Aufrufer rendern ohnehin nur als „article" klassifizierte Seiten.
function extractBodyFallback(html: string, url: string): { body: string } | null {
  try {
    const doc = makeDom(html, url).window.document;
    let best: any = null, bestLen = 0;
    for (const sel of ['[data-area="body"]', '[itemprop="articleBody"]', "article", "main"]) {
      for (const el of Array.from(doc.querySelectorAll(sel))) {
        const len = ((el as any).textContent ?? "").length;
        if (len > bestLen) { bestLen = len; best = el; }
      }
      if (best && bestLen >= MIN_BODY) break;
    }
    if (!best || bestLen < MIN_BODY) return null;
    const blocks = Array.from(best.querySelectorAll("p, li, h2, h3, h4"))
      .map((e: any) => (e.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t: string) => t.length >= 30);
    const body = (blocks.length ? blocks.join("\n\n") : (best.textContent ?? "")).trim();
    return body.length >= MIN_BODY ? { body } : null;
  } catch {
    return null;
  }
}

// === Klassifikation der Seiten (Knoten im Baum) ===
type Kind = "article" | "section" | "media" | "interactive" | "sponsored" | "service" | "error" | "unknown";

// Pfad in Segmente; das letzte Segment ist der Headline-Slug (enthält beliebige Wörter
// wie "be-werbung", "advertorials", "fame-fighting-international") und darf NICHT die
// Rubrik bestimmen. Klassifikation prüft daher nur die Rubrik-Segmente (alle außer Slug)
// als ganze Tokens, nicht als Substrings irgendwo in der URL.
function urlSegments(url: string): { sections: string[]; slug: string } {
  try {
    const segs = new URL(url).pathname.toLowerCase().replace(/\/+$/, "").split("/").filter(Boolean);
    return { sections: segs.slice(0, Math.max(0, segs.length - 1)), slug: segs[segs.length - 1] ?? "" };
  } catch { return { sections: [], slug: "" }; }
}
const SEC = (segs: string[], rx: RegExp) => segs.some((s) => rx.test(s));

// Schätzung allein aus der URL (für entdeckte, noch nicht gerenderte Links).
function classifyUrl(url: string): Kind {
  const { sections, slug } = urlSegments(url);
  const u = url.toLowerCase();
  // Werbung: nur als eigenes Rubrik-Segment oder Query-Param (nicht "bewerbung"/"umwerbung")
  if (SEC(sections, /^(anzeige[n]?|sponsored|advertorials?|werbe[a-z-]*|promotion|adv|partner-?content)$/) ||
      /[?&](sponsored|advertorial|anzeige)=/.test(u)) return "sponsored";
  if (SEC(sections, /^(impressum|kontakt|datenschutz|newsletter|abo|login|konto|hilfe|agb|nutzungsbedingungen|privacy|mentions-legales|cgu)$/)) return "service";
  // Medien: Rubrik-Segment ODER Slug-Präfix (tagesschau /video-NNN.html, /audio-NNN)
  if (SEC(sections, /^(podcast|videos?|audio|mediathek|livestream|bilder|fotostrecke[n]?|galerie|multimedia|tv)$/) ||
      /^(video|audio|podcast|livestream)-/.test(slug)) return "media";
  if (SEC(sections, /^(boersenkurse|kurse|wetter|horoskop|lotto|gewinnspiel|rechner|tabelle|ergebnisse|spielplan)$/)) return "interactive";
  if (looksLikeArticle(url)) return "article";
  return "unknown";
}

// Inhaltbasierte Video-Erkennung – erkennt reine Video-Seiten.
// WICHTIG: Artikel mit eingebettetem Video (z.B. Tagesschau) bleiben Artikel.
// Schlüsselregel: Hat die Seite AUCH einen Article/NewsArticle-Typ im JSON-LD → kein Video.
function isVideoPage(html: string): boolean {
  const ld = parseJsonLd(html);
  const allTypes = ld.flatMap((d) => Array.isArray(d["@type"]) ? d["@type"] : [d["@type"]]).filter(Boolean) as string[];

  // Seite mit Article/NewsArticle-Typ ist ein Artikel – auch wenn ein VideoObject eingebettet ist.
  if (allTypes.some((t) => /article/i.test(t))) return false;

  // og:type = video.* (ohne gleichzeitigen Article-Typ)
  if (/property=["']og:type["'][^>]+content=["']video\./i.test(html) ||
      /content=["']video\.[^"']+["'][^>]+property=["']og:type["']/i.test(html)) return true;

  // JSON-LD VideoObject als EINZIGER signifikanter Typ (kein Article daneben)
  if (allTypes.some((t) => t === "VideoObject")) return true;

  // twitter:card = player + kaum Fließtext (reine Player-Seite)
  if (/name=["']twitter:card["'][^>]+content=["']player["']/i.test(html) ||
      /content=["']player["'][^>]+name=["']twitter:card["']/i.test(html)) {
    const wordCount = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().split(/\s+/).length;
    if (wordCount < 200) return true;
  }
  return false;
}

// Fehler-/Statusseiten erkennen, die wie Artikel AUSSEHEN (URL passt aufs Artikel-Muster,
// Titel + etwas Body vorhanden), aber keine sind: echte 404/410/5xx-Seiten (z.B. Tagesschau
// „Ein Fehler ist aufgetreten (#404)" unter einer alten, umgezogenen URL) und Soft-404s
// (Server liefert HTTP 200, der Inhalt ist aber eine Fehlerseite). VERLAGSÜBERGREIFEND:
//  - Primär & autoritativ: der echte HTTP-Status (>=400 ⇒ kein Artikel, sprachunabhängig).
//  - Sekundär: ein eng am Titelanfang verankertes Fehler-Muster für Soft-404s. Bewusst
//    auf den <title>-ANFANG verankert, damit echte Schlagzeilen, die ein Fehler-Wort nur
//    enthalten („…wäre ein Fehler", „…verweigert"), NICHT fälschlich rausfliegen.
const ERROR_TITLE_RX = /^\s*(ein fehler ist aufgetreten|entschuldigung,? es ist ein fehler|fehler\s*[:#(]|404\b|410\b|error\s*\d{3}|seite (nicht|leider nicht|wurde nicht|konnte nicht) (gefunden|geladen|aufgerufen)|seite nicht verf[üu]gbar|diese seite (gibt es|existiert) nicht|page (not found|introuvable|non[\s-]?trouv)|not found|page indisponible|cette page n.?existe|zugriff verweigert|access denied|forbidden|just a moment|attention required)/i;
function pageTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()) : null;
}
function isErrorPage(status: number, html: string): boolean {
  if (status >= 400) return true;                  // echter 404/410/5xx → niemals Artikel
  const t = pageTitleTag(html);
  return !!t && ERROR_TITLE_RX.test(t);            // Soft-404 (HTTP 200 + Fehler-Titel)
}

// Sichere Klassifikation nach dem Rendern (zieht den Inhalt hinzu).
// ROBUST gegen Bot-/Consent-Blockseiten (winzig) und Paywall-Teaser (Artikel mit wenig Text):
//  - Hub nur, wenn SUBSTANZIELLE Seite gerendert wurde UND kein Artikel-Signal UND keine Datums-Artikel-URL.
//  - Artikel auch bei Paywall-Teaser, sofern JSON-LD Article-Signal ODER klare Datums-Artikel-URL vorliegt.
const datedArticleUrl = (url: string) => /\/article\/\d{4}\/\d{2}\/\d{2}\//.test(url) || /\/\d{4}\/\d{2}\/\d{2}\//.test(url);
function classifyRendered(url: string, html: string): { kind: Kind; article: { title: string; teaser: string; body: string } | null } {
  const byUrl = classifyUrl(url);
  if (byUrl !== "article" && byUrl !== "unknown") return { kind: byUrl, article: null };
  if (isVideoPage(html)) return { kind: "media", article: null };

  const signal = hasArticleSignal(html);
  const strongUrl = datedArticleUrl(url);
  const substantial = html.length > 25000; // Block-/Consent-Seiten sind winzig → nicht als Hub verurteilen

  // Eindeutiger Hub: voll geladene Seite, aber kein Artikel-Signal und keine Datums-Artikel-URL.
  if (substantial && !signal && !strongUrl) return { kind: "section", article: null };

  const art = looksLikeArticle(url) ? asArticle(html, url) : null;
  if (art) return { kind: "article", article: art };
  // Paywall-Teaser/Block: trotzdem Artikel, wenn JSON-LD oder Datums-URL es ausweist (Metadaten via extractMeta).
  if (signal || strongUrl) return { kind: "article", article: null };
  return { kind: "section", article: null };
}

// === Knoten/Kanten-Persistenz (der Baum) ===
const pageId = new Map<string, number>(); // url -> pages.id (laufzeitweiter Cache)

// Entdeckte Links als Knoten anlegen (nur neu; bestehende Klassifikation NICHT überschreiben).
async function ensureNodes(sourceId: number, urls: string[], depth: number) {
  const fresh = [...new Set(urls.map(canonUrl))].filter((u) => !pageId.has(u));
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
  url = canonUrl(url);
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
async function crawlSource(ctx: BrowserContext | null, src: Source, deadline: number) {
  const visited = new Set<string>();
  const queued = new Set<string>();
  // Zwei FIFO-Queues: Artikel-Links werden zuerst abgearbeitet (Budget füllt sich mit echten
  // Artikeln), Rubriken/Übersichten danach – aber jeweils in Breiten-/Seitenreihenfolge,
  // also kein Abtauchen in einen einzelnen Strang (z.B. eine Podcast-Liste).
  const articleQ: Seed[] = [];
  const sectionQ: Seed[] = [];
  const feedQ: Seed[] = []; // RSS/Atom-Feeds — billige, ergiebige Artikel-Entdeckung
  const enqueue = (s: Seed, isArticle: boolean) => {
    if (queued.has(s.url)) return;
    queued.add(s.url);
    if (s.feed) feedQ.push(s);
    else (isArticle ? articleQ : sectionQ).push(s);
  };

  enqueue({ url: src.base_url, depth: 0 }, false); // Startseite = Übersicht
  // Gespeicherten Feed (sources.feed_url) sofort einreihen — weitere Feeds werden
  // aus der Startseite auto-erkannt (<link rel="alternate">).
  if (src.feed_url) enqueue({ url: src.feed_url, depth: 0, feed: true }, false);
  // Kuratierte Zusatz-Feeds (z.B. FAZ/n-tv-Ressorts), wo Auto-Erkennung wenig findet.
  let srcHost = ""; try { srcHost = new URL(src.base_url).host; } catch {}
  for (const f of (KNOWN_FEEDS[srcHost] ?? [])) enqueue({ url: f, depth: 0, feed: true }, false);

  // Sitemaps zuerst abgrasen (billig, riesige Ausbeute) — markiert Artikel-Knoten
  // für analyze. Nutzt ~1/3 der Quellen-Frist, der Rest bleibt für HTML/Feeds.
  await harvestSitemaps(src, Date.now() + Math.floor((deadline - Date.now()) / 3));

  let pages = 0;            // verarbeitete Seiten gesamt (gegen MAX_FETCHES)
  let renders = 0;          // teure Browser-Renders (gegen MAX_PAGES)
  let fetches = 0, saved = 0;
  const counts: Record<string, number> = {};

  // Einen einzelnen Seed verarbeiten (HTML holen + classify + DB-Write + neue Links einreihen).
  async function processOne(s: Seed) {
    if (visited.has(s.url)) return;
    visited.add(s.url);

    // Feed-Seed: XML holen, Artikel-URLs extrahieren und DIREKT als 'article'-
    // Knoten markieren → analyze rendert sie nach. Ultrabillig (1 Fetch →
    // dutzende/hunderte Artikel), hebt v.a. JS-/Paywall-lastige Quellen.
    if (s.feed) {
      const xml = await fetchXml(s.url);
      if (!xml) return;
      fetches++; pages++;
      counts["feed"] = (counts["feed"] ?? 0) + 1;
      const arts = extractFeedItemUrls(xml, src.base_url).filter(looksLikeArticle);
      if (arts.length && !DRY_RUN) {
        const depth = Math.min(s.depth + 1, MAX_DEPTH);
        try {
          for (let i = 0; i < arts.length; i += 200) {
            await sb.from("pages").upsert(
              arts.slice(i, i + 200).map((url) => ({ source_id: src.id, url: canonUrl(url), kind: "article", depth })),
              { onConflict: "url", ignoreDuplicates: true },
            );
          }
        } catch (e) { console.error("FEED-FEHLER:", s.url, (e as Error).message); }
      }
      return;
    }

    const live = isLiveContent(s.url, null);
    const predicted = classifyUrl(s.url);

    // NUR echte Artikel/Liveblogs rendern (teuer, budgetiert). Alles andere —
    // Rubriken/Hubs/„unknown"/Medien/Service — billig per HTTP entdecken, damit
    // der Crawl auch bei Tiefe 4 schnell bleibt. Entpuppt sich eine billig
    // geholte Seite als Artikel, wird ihr Knoten unten korrekt als 'article'
    // markiert → der analyze-Job rendert sie nach.
    let html: string | null = null;
    let didRender = false;
    let renderStatus = 0; // HTTP-Status des Renders (0 = nicht gerendert/HTTP-Fetch) → Fehlerseiten-Filter
    if (predicted === "article" || live) {
      // Discovery-Modus (kein Browser) ODER Render-Budget weg → Artikel bleibt
      // als Knoten (existiert bereits via ensureNodes/Sitemap/Feed); analyze rendert.
      if (!RENDER || !ctx || renders >= MAX_PAGES) return;
      const rr = await renderPage(ctx, s.url, live);
      html = rr.html; renderStatus = rr.status;
      if (html) { renders++; didRender = true; }
    } else {
      html = await fetchHtml(s.url);
      if (html) fetches++;
      // Notnagel: link-arme JS-Seite → einmal rendern (nur wenn Browser + Budget da).
      if (RENDER && ctx && (!html || (s.depth < MAX_DEPTH && sameDomainLinks(html, src.base_url, s.url).length < 5)) && renders < MAX_PAGES) {
        const rr = await renderPage(ctx, s.url);
        if (rr.html) { html = rr.html; renderStatus = rr.status; renders++; didRender = true; }
      }
    }
    if (!html) return;
    pages++;

    const links = s.depth < MAX_DEPTH ? sameDomainLinks(html, src.base_url, s.url) : [];
    let { kind, article } = classifyRendered(s.url, html);
    // Fehler-/Statusseite (echter 404/410/5xx oder Soft-404 mit Fehler-Titel) NIE als Artikel
    // führen — verlagsübergreifend. Knoten als 'error' markieren, damit analyze ihn nicht
    // erneut als Artikel rendert. Nur wenn wirklich gerendert (HTTP-Status ist sonst aussagelos).
    if (didRender && isErrorPage(renderStatus, html)) { kind = "error"; article = null; }
    counts[kind] = (counts[kind] ?? 0) + 1;

    if (!DRY_RUN) {
      try {
        const fromId = await upsertRenderedNode(src.id, s.url, kind, s.depth);
        if (links.length) { await ensureNodes(src.id, links, s.depth + 1); await addEdges(fromId, links); }
        // Artikel nur speichern, wenn WIRKLICH gerendert (sonst rendert analyze
        // ihn sauber nach — kein Speichern aus link-armem Roh-HTML).
        if (kind === "article" && article && didRender && MODE !== "structure") {
          await saveArticleFull(src.id, s.url, html);
          saved++;
        }
      } catch (e) { console.error("FEHLER:", s.url, (e as Error).message); }
    }
    for (const link of links) enqueue({ url: link, depth: s.depth + 1 }, classifyUrl(link) === "article");
    // Feeds aus dem Seiten-Head auto-erkennen (v.a. Startseite/Rubriken) → einreihen.
    if (s.depth < MAX_DEPTH) for (const f of extractFeedLinks(html, s.url)) enqueue({ url: f, depth: s.depth, feed: true }, false);
  }

  // Parallele Worker: CONCURRENCY Tabs laufen gleichzeitig.
  // Feeds zuerst (billig, hohe Ausbeute), dann Artikel, dann Rubriken.
  const next = (): Seed | undefined => MODE === "structure"
    ? (sectionQ.shift() ?? articleQ.shift() ?? feedQ.shift())
    : (feedQ.shift() ?? articleQ.shift() ?? sectionQ.shift());

  async function worker() {
    // Läuft bis Discovery-Budget erschöpft, Queue leer ODER Zeitfrist erreicht.
    while (pages < MAX_FETCHES && Date.now() < deadline) {
      const s = next();
      if (!s) break;
      await processOne(s);
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const summary = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(", ");
  console.log(`Quelle ${src.base_url}: ${pages} Seiten · ${renders} gerendert · ${fetches} per HTTP · ${saved} Artikel gespeichert [${summary}]`);
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

  // 1) entdeckte Artikel-Knoten + bereits analysierte URLs laden.
  // NEUESTE zuerst (id desc): die jüngsten Funde (Feeds/Sitemaps/Crawl) werden
  // priorisiert gerendert → relevante, aktuelle Artikel zuerst statt altem Backlog.
  const discovered = await fetchAll<{ url: string; source_id: number }>((from) =>
    sb.from("pages").select("url,source_id").eq("kind", "article").in("source_id", activeIds).order("id", { ascending: false })
  );
  // „Erledigt" = bereits GERENDERT (title gesetzt). Reine Sitemap-Vorab-Zeilen
  // (title=null, nur published_at aus harvestSitemaps) zählen NICHT als erledigt →
  // werden weiterhin gerendert, statt vom Renderer übersprungen zu werden.
  const doneRows = await fetchAll<{ url: string }>((from) => sb.from("articles").select("url").not("title", "is", null));
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

  // Neue Artikel werden DIREKT gerendert und voll angereichert (Titel, Wörter, Datum,
  // Autoren, Keywords) — statt nur nackte URLs einzufügen. So kommen neue Artikel OHNE den
  // separaten enrich-Job mit Metadaten in die DB; enrich bleibt nur für den Altbestand.
  const queue: { url: string; sid: number }[] = [];
  for (const [sid, urls] of bySrc) for (const url of urls) queue.push({ url, sid });

  // RE-SCANS ZUERST reservieren (stille Edits — das Kernfeature): bevor der
  // Wasserstand-Topf aufgefüllt wird, bekommt der Re-Scan-Pool garantiert sein
  // Minimum. Sonst würde ein großer Rückstand (z.B. Le Monde-Archiv) den gesamten
  // Topf schlucken und stille Edits wären nie sichtbar.
  // Re-Scan-Anteil am Render-Budget. 10 % (=150) war zu knapp fürs Edit-Fenster, 35 % zu viel
  // (Laufzeit 10 → 25 min). 20 % (=300 bei MAX_PAGES 1500) ist der Kompromiss: deckt mit dem
  // engen heute+gestern-Fenster die frischen Artikel gut ab, ohne den Lauf zu sprengen.
  // Jeder Re-Scan ist ein teurer Browser-Render → direkter Laufzeit-Hebel. Per Env tunbar.
  const RESCAN_SHARE = Number(process.env.CRAWL_RESCAN_SHARE ?? 0.2);
  const RESCAN_CAP = Math.max(50, Math.ceil(MAX_PAGES * RESCAN_SHARE));
  const newCount0 = queue.length;
  {
    const rescanBudget = Math.min(RESCAN_CAP, MAX_PAGES - queue.length);
    if (rescanBudget > 0) {
      const now = Date.now();
      const H = 3_600_000;
      const horizonDays = Number(process.env.RESCAN_DAYS ?? 3); // Re-Scan-Fenster (Tage); stündliche Pipeline → weiter gefasst
      const inQueue = new Set(queue.map((q) => q.url));

      // ALTERSGESTAFFELTE KADENZ statt „ältester last_seen zuerst" über ein flaches Fenster.
      // Stille Überschriften-Edits — das Kernfeature — passieren STUNDEN nach der
      // Veröffentlichung, nicht Tage danach. Die alte Strategie kam dem Fund kaum hinterher
      // und re-scannte jeden Artikel erst ~4 T nach Entdeckung EINMAL (Lag empirisch exakt
      // 3,8 T, knapp vor Ablauf des Fensters) → das Edit-Fenster war längst vorbei und die
      // jüngste Kohorte stand im Frontend dauerhaft auf „Neu". Jetzt: frische Artikel JEDEN
      // Lauf re-scannen, ältere zunehmend seltener.
      //   Alter    = published_at (Fallback first_seen, wenn published_at NULL).
      //   „fällig" = last_seen älter als das Stufen-Intervall (dueH).
      //   Spalte heißt in der Basistabelle `first_seen` (NICHT `discovered_at` — das ist nur
      //   ein View-Alias in page_overview; mit ihm warf die Query 400 → stiller Totalausfall).
      // Auf die STÜNDLICHE Pipeline getunt (war alle 4 h): dueH ≤ 1 ⇒ praktisch jeden Lauf.
      // Gewichte summieren > 1 ⇒ ungenutztes Budget einer Stufe rollt automatisch zur
      // nächsten und zum Sicherheitsnetz. tier3 greift nur, wenn RESCAN_DAYS > 2 (sonst hiH ≤ loH → leer).
      const tiers = [
        { loH: 0,  hiH: 24,               dueH: 1,  weight: 0.55 }, // heute <24 h: ~jede Stunde (kurzlebige Edits!)
        { loH: 24, hiH: 48,               dueH: 6,  weight: 0.30 }, // gestern 24–48 h: ~4×/Tag
        { loH: 48, hiH: horizonDays * 24, dueH: 24, weight: 0.20 }, // älter bis Horizont: ~1×/Tag
      ];

      const reserve = async (loH: number, hiH: number, dueH: number, slice: number) => {
        if (slice <= 0 || hiH <= loH) return 0;
        const lo = new Date(now - hiH * H).toISOString();         // älterer effTime-Rand
        const hi = new Date(now - loH * H).toISOString();         // jüngerer effTime-Rand
        const dueBefore = new Date(now - dueH * H).toISOString();  // nur „überfällige"
        const { data, error } = await sb.from("articles")
          .select("url,source_id")
          .in("source_id", activeIds)
          .not("title", "is", null)
          .lte("last_seen", dueBefore)
          .or(`and(published_at.gte.${lo},published_at.lte.${hi}),and(published_at.is.null,first_seen.gte.${lo},first_seen.lte.${hi})`)
          .order("last_seen", { ascending: true }) // innerhalb der Stufe: Überfälligstes zuerst
          .limit(slice + 100);
        if (error) { console.error("RE-SCAN-STUFE-FEHLER:", error.message); return 0; }
        let pushed = 0;
        for (const r of (data ?? []) as any[]) {
          if (pushed >= slice) break;
          if (!inQueue.has(r.url)) { queue.push({ url: r.url, sid: r.source_id }); inQueue.add(r.url); pushed++; }
        }
        return pushed;
      };

      let remaining = rescanBudget;
      for (const t of tiers) {
        if (remaining <= 0) break;
        remaining -= await reserve(t.loH, t.hiH, t.dueH, Math.min(remaining, Math.ceil(rescanBudget * t.weight)));
      }
      // Sicherheitsnetz: Restbudget mit dem global Überfälligsten im Gesamtfenster füllen
      // (alte Strategie) — verhindert brachliegendes Budget in ruhigen Läufen.
      if (remaining > 0) {
        const since = new Date(now - horizonDays * 86_400_000).toISOString();
        const { data } = await sb.from("articles")
          .select("url,source_id")
          .in("source_id", activeIds)
          .not("title", "is", null)
          .or(`published_at.gte.${since},first_seen.gte.${since}`)
          .order("last_seen", { ascending: true })
          .limit(remaining + 100);
        for (const r of (data ?? []) as any[]) {
          if (remaining <= 0) break;
          if (!inQueue.has(r.url)) { queue.push({ url: r.url, sid: r.source_id }); inQueue.add(r.url); remaining--; }
        }
      }
    }
    console.log(`Re-Scan reserviert: ${queue.length - newCount0} Artikel (altersgestaffelt: frisch≫jung≫alt, cap ${RESCAN_CAP})`);
  }

  // Wasserstand-Auffüllung: nach Re-Scan-Reserve verbleibendes Budget mit NOCH NICHT
  // gerenderten Artikeln füllen — neueste zuerst, quellenübergreifend. So leeren sich
  // große Rückstände (Le Monde/Bild) schneller, statt Budget brachliegen zu lassen.
  // Gleiche Minuten (Cap bleibt MAX_PAGES), nur sinnvoller genutzt.
  const newCount = queue.length;
  if (queue.length < MAX_PAGES) {
    const inQ = new Set(queue.map((q) => q.url));
    for (const p of discovered) { // bereits id-desc (neueste zuerst)
      if (queue.length >= MAX_PAGES) break;
      if (done.has(p.url) || inQ.has(p.url)) continue;
      queue.push({ url: p.url, sid: p.source_id }); inQ.add(p.url);
    }
    console.log(`Wasserstand aufgefüllt: ${queue.length - newCount} weitere neue Artikel`);
  }

  const browser = await chromium.launch();
  let done2 = 0, ok = 0;
  const total = queue.length;
  async function worker() {
    const ctx = await browser.newContext({ userAgent: UA });
    try {
      while (true) {
        const item = queue.shift();
        if (!item) break;
        try {
          const { status, html } = await renderPage(ctx, item.url, isLiveContent(item.url, null));
          if (html) {
            // Selbst-Korrektur: stellt sich eine entdeckte „Artikel"-URL als Fehlerseite/Hub/Video
            // heraus, nicht als Artikel führen. Fehlerseiten (404/410/5xx, Soft-404) zuerst prüfen:
            // sie sehen wie Artikel aus (Titel/Body da), liefern aber HTTP-Fehler → kein Speichern,
            // Knoten als 'error' markieren → fällt aus dem Render-Pool (kein erneutes Re-Scannen).
            if (isErrorPage(status, html)) { await sb.from("pages").update({ kind: "error" }).eq("url", item.url); }
            else {
              const cls = classifyRendered(item.url, html);
              if (cls.kind === "article") { await saveArticleFull(item.sid, item.url, html); ok++; }
              else { await sb.from("pages").update({ kind: cls.kind }).eq("url", item.url); }
            }
          }
        } catch (e) { console.error("FEHLER:", item.url, (e as Error).message); }
        if (++done2 % 50 === 0) console.log(`  ${done2}/${total} gerendert (${ok} Artikel)…`);
        await sleep(DELAY_MS);
      }
    } finally { await ctx.close(); }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();
  console.log(`Fertig: ${done2} gerendert, ${ok} Artikel voll angereichert.`);
}

// enrich-Modus: Alle articles ohne Titel mit Chromium rendern und Metadaten nachtragen.
// Läuft parallel (CONCURRENCY Tabs). Ideal nach dem ersten analyze-Batch.
async function enrichArticles(sources: Source[]) {
  const srcById = new Map(sources.map((s) => [s.id, s]));

  // Budget proportional zum Backlog jeder Quelle verteilen — sonst verschwendet die
  // Gleichverteilung Renderzeit auf fast-vollständige Quellen (z.B. Spiegel),
  // während große Lücken (Le Monde) nur langsam abgebaut werden.
  const backlog = new Map<number, number>();
  let backlogTotal = 0;
  for (const src of sources) {
    const { count } = await sb.from("articles").select("id", { count: "exact", head: true })
      .eq("source_id", src.id).or("title.is.null,published_at.is.null");
    backlog.set(src.id, count ?? 0);
    backlogTotal += count ?? 0;
  }
  const toEnrich: { id: number; url: string; source_id: number }[] = [];
  for (const src of sources) {
    const bl = backlog.get(src.id) ?? 0;
    if (bl === 0) continue;
    // Anteil am Gesamt-Backlog → Budget (min. 10, damit kleine Quellen nicht verhungern)
    const quota = Math.max(10, Math.round((bl / Math.max(1, backlogTotal)) * MAX_PAGES));
    // Prio 1: kein Titel (komplette Lücke). NEUESTE zuerst, damit aktuelle Tage schnell
    // vollständig werden. Darf das VOLLE Quota nehmen — wenn eine Quelle (z.B. Bild) den
    // Backlog dominiert, soll der frühere 60%-Deckel sie nicht künstlich bremsen; das
    // Datums-Backfill (Prio 2) bekommt nur den Rest, ist aber ohnehin nachrangig.
    const { data: noTitle } = await sb.from("articles").select("id,url,source_id")
      .eq("source_id", src.id).is("title", null)
      .order("first_seen", { ascending: false }).limit(quota);
    toEnrich.push(...((noTitle ?? []) as any[]));
    // Prio 2: Titel vorhanden, aber Veröffentlichungsdatum fehlt (nur falls Quota übrig)
    const missing = quota - (noTitle?.length ?? 0);
    if (missing > 0) {
      const { data: noDate } = await sb.from("articles").select("id,url,source_id")
        .eq("source_id", src.id).not("title", "is", null).is("published_at", null)
        .order("first_seen", { ascending: false }).limit(missing);
      const seen = new Set(toEnrich.map((r) => r.id));
      for (const r of (noDate ?? []) as any[]) { if (!seen.has(r.id)) toEnrich.push(r); }
    }
  }
  console.log(`Zu bereichern: ${toEnrich.length} Artikel (Backlog gesamt: ${backlogTotal})`);
  if (!toEnrich.length) { console.log("Alle Artikel haben bereits Metadaten."); return; }

  const browser = await chromium.launch();
  const queue = [...toEnrich];
  let done = 0;

  async function worker(langHint: string) {
    const ctx = await browser.newContext({ userAgent: UA, locale: langHint === "fr" ? "fr-FR" : "de-DE" });
    try {
      while (true) {
        const item = queue.shift();
        if (!item) break;
        const { html } = await renderPage(ctx, item.url, isLiveContent(item.url, null));
        if (!html) continue;
        // Selbst-Korrektur: Hub/Übersicht (robust erkannt) → demoten, nicht als Artikel führen.
        const cls = classifyRendered(item.url, html);
        if (cls.kind !== "article") {
          await sb.from("pages").update({ kind: cls.kind }).eq("url", item.url);
          await sb.from("articles").delete().eq("id", item.id);
          continue;
        }
        const meta = extractMeta(html, item.url);
        const art = asArticle(html, item.url);
        try {
          // Vorzustand für Tracking lesen, dann Metadaten aktualisieren.
          const { data: prev } = await sb.from("articles")
            .select(PREV_COLS)
            .eq("id", item.id).maybeSingle();
          meta.paywalled = stickyPaywall((prev as any)?.paywalled, meta.paywalled); // Paywall nie fälschlich aufheben
          if (!meta.published_precise && (prev as any)?.published_at) meta.published_at = (prev as any).published_at;
          const { authors, keywords, categories, published_precise, ...fields } = meta;
          void published_precise;
          await sb.from("articles").update({ ...fields, last_seen: new Date().toISOString(), scan_count: ((prev as any)?.scan_count ?? 0) + 1, scan_times: appendScan((prev as any)?.scan_times) }).eq("id", item.id);
          await upsertDimensions(item.id, authors, keywords, categories);
          const tb = trackBody(html, item.url, art, meta.article_type === "liveblog", meta.title ?? art?.title ?? null);
          if (tb) await trackChanges(item.id, (prev as PrevState) ?? null, meta.title ?? art?.title ?? null, tb.body, item.url, tb.isLive, (prev as any)?.published_at ?? null, meta.published_at ?? null, { description: meta.description, og_image: meta.og_image, paywalled: meta.paywalled, author_status: meta.author_status, topic: meta.topic });
          done++;
          if (done % 50 === 0) console.log(`  ${done}/${toEnrich.length} angereichert…`);
        } catch (e) { console.error("FEHLER:", item.url, (e as Error).message); }
        await sleep(DELAY_MS);
      }
    } finally { await ctx.close(); }
  }

  // Pro Quelle eigener Worker mit passender Locale
  const workers = sources.map((s) => worker(s.language ?? "de"));
  await Promise.all(workers);
  await browser.close();
  console.log(`Fertig: ${done}/${toEnrich.length} Artikel angereichert.`);
}

// reclassify: Rendert alle pages.kind='article', erkennt Videos nachträglich und korrigiert.
// Videos → pages.kind='media', Eintrag in articles gelöscht (waren falsch klassifiziert).
async function reclassifyPages(sources: Source[]) {
  const srcById = new Map(sources.map((s) => [s.id, s]));
  const perSource = Math.ceil(MAX_PAGES / sources.length);

  // pages.kind='article' laden (die potenziell falsch klassifizierten)
  const toCheck: { id: number; url: string; source_id: number }[] = [];
  for (const src of sources) {
    const { data } = await sb.from("pages").select("id,url,source_id")
      .eq("source_id", src.id).eq("kind", "article").limit(perSource);
    toCheck.push(...((data ?? []) as { id: number; url: string; source_id: number }[]));
  }
  console.log(`Prüfe ${toCheck.length} Seiten auf Video-Inhalt (max ${perSource}/Quelle)…`);

  const browser = await chromium.launch();
  const queue = [...toCheck];
  let corrected = 0, kept = 0;

  async function worker(langHint: string) {
    const ctx = await browser.newContext({ userAgent: UA, locale: langHint === "fr" ? "fr-FR" : "de-DE" });
    try {
      while (true) {
        const item = queue.shift();
        if (!item) break;
        const { html } = await renderPage(ctx, item.url);
        if (!html) continue;
        if (isVideoPage(html)) {
          // pages.kind auf 'media' korrigieren
          await sb.from("pages").update({ kind: "media" }).eq("id", item.id);
          // aus articles entfernen falls fälschlicherweise eingetragen
          await sb.from("articles").delete().eq("url", item.url);
          corrected++;
          console.log(`  VIDEO erkannt: ${item.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 70)}`);
        } else {
          kept++;
        }
        if ((corrected + kept) % 100 === 0) console.log(`  ${corrected + kept}/${toCheck.length} geprüft (${corrected} Videos)…`);
        await sleep(DELAY_MS);
      }
    } finally { await ctx.close(); }
  }

  await Promise.all(sources.map((s) => worker(s.language ?? "de")));
  await browser.close();
  console.log(`\nFertig: ${corrected} als Video reklassifiziert, ${kept} korrekt als Artikel.`);
}

// retopic: Themen NUR aus URL + bereits gespeicherten Kategorien neu berechnen (kein Rendering).
// Korrigiert „sonstiges"-Fehlklassifikationen nach Schema-Erweiterungen und entfernt URLs,
// die nach neuen Regeln gar keine Artikel sind (Autorenseiten, Themen-Hubs).
async function retopicArticles() {
  console.log("retopic: Themen aus URL + Kategorien neu berechnen…");
  const PAGE = 1000;
  let from = 0, scanned = 0, changed = 0, removed = 0;
  const changes: Record<string, number> = {};

  while (true) {
    const { data: arts, error } = await sb.from("articles")
      .select("id,url,topic,article_categories(categories(name))")
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) { console.error(error.message); break; }
    if (!arts?.length) break;

    for (const a of arts as any[]) {
      scanned++;
      // Nicht-Artikel (nach neuen Regeln) komplett entfernen
      if (!looksLikeArticle(a.url)) {
        await sb.from("articles").delete().eq("id", a.id);
        await sb.from("pages").update({ kind: "section" }).eq("url", a.url);
        removed++;
        continue;
      }
      const cats: string[] = (a.article_categories ?? [])
        .map((ac: any) => ac.categories?.name).filter(Boolean);
      const next = topicOf(cats, a.url);
      if (next !== a.topic) {
        await sb.from("articles").update({ topic: next }).eq("id", a.id);
        changed++;
        const k = `${a.topic ?? "∅"}→${next}`;
        changes[k] = (changes[k] ?? 0) + 1;
      }
    }
    console.log(`  ${scanned} geprüft · ${changed} umklassifiziert · ${removed} entfernt`);
    if (arts.length < PAGE) break;
    from += PAGE;
  }

  console.log(`\nFertig: ${scanned} geprüft, ${changed} Themen geändert, ${removed} Nicht-Artikel entfernt.`);
  const top = Object.entries(changes).sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log("Top-Übergänge:"); for (const [k, n] of top) console.log(`  ${k}: ${n}`);
}

// retype: article_type für ALLE Artikel neu bewerten — ohne Rendering, rein aus DB-Daten.
// Nötig, weil die Erstklassifikation oft lief, BEVOR der Titel bekannt war (isLiveContent
// sah nur die URL). Jetzt mit Titel: Tagesschau-"++ Meldung ++"-Liveblogs etc. werden erkannt.
// Zusätzlich die empirische Regel: 2+ Erweiterungen = über Zeit wachsender Timeline-Artikel.
async function retypeArticles() {
  console.log("retype: article_type aus URL + Titel + Wachstums-Historie neu bewerten…");
  const PAGE = 1000;
  let from = 0, scanned = 0, changed = 0;
  const changes: Record<string, number> = {};

  while (true) {
    const { data: arts, error } = await sb.from("articles")
      .select("id,url,title,article_type,extension_count")
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) { console.error(error.message); break; }
    if (!arts?.length) break;

    for (const a of arts as any[]) {
      scanned++;
      const cur = a.article_type ?? "news";
      let next = cur;
      if (isLiveContent(a.url, a.title)) {
        if (cur !== "liveblog" && cur !== "timeline") next = "liveblog";
      } else if ((a.extension_count ?? 0) >= 2 && (cur === "news" || cur === null)) {
        next = "timeline";
      }
      if (next !== cur) {
        await sb.from("articles").update({ article_type: next }).eq("id", a.id);
        changed++;
        const k = `${cur}→${next}`;
        changes[k] = (changes[k] ?? 0) + 1;
      }
    }
    console.log(`  ${scanned} geprüft · ${changed} umklassifiziert`);
    if (arts.length < PAGE) break;
    from += PAGE;
  }

  console.log(`\nFertig: ${scanned} geprüft, ${changed} Typen geändert.`);
  for (const [k, n] of Object.entries(changes).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
}

// rekeyword: Rendert Artikel OHNE Keyword-Verknüpfung neu und trägt Keywords nach
// (für Backlog nach Extractor-Verbesserung; priorisiert Quellen mit den größten Lücken).
async function rekeywordArticles(sources: Source[]) {
  console.log("rekeyword: Artikel ohne Keywords neu rendern und Schlagwörter nachtragen…");
  // Pro Quelle ein faires Budget; Artikel OHNE Keyword-Verknüpfung sammeln.
  const perSource = Math.ceil(MAX_PAGES / sources.length);
  const toFix: { id: number; url: string; lang: string }[] = [];
  for (const src of sources) {
    // Mehr laden als Budget (viele haben evtl. schon Keywords), bis perSource ohne KW erreicht.
    const { data } = await sb.from("articles")
      .select("id,url,article_keywords(article_id)")
      .eq("source_id", src.id).not("title", "is", null).limit(perSource * 4);
    let taken = 0;
    for (const a of (data ?? []) as any[]) {
      if (taken >= perSource) break;
      if (!a.article_keywords?.length) { toFix.push({ id: a.id, url: a.url, lang: src.language ?? "de" }); taken++; }
    }
  }
  const queue = toFix.slice(0, MAX_PAGES);
  console.log(`Zu bearbeiten: ${queue.length} Artikel ohne Keywords.`);
  if (!queue.length) { console.log("Keine Artikel ohne Keywords gefunden."); return; }

  const browser = await chromium.launch();
  let done = 0, withKw = 0;
  const total = queue.length;
  async function worker() {
    const ctx = await browser.newContext({ userAgent: UA, locale: "de-DE" });
    try {
      while (true) {
        const item = queue.shift();
        if (!item) break;
        const { html } = await renderPage(ctx, item.url);
        if (html) {
          const ld = parseJsonLd(html);
          const article = ld.find((d) => d && typeIncludes(d["@type"], "Article")) ?? {};
          const kws = extractKeywords(html, article);
          if (kws.length) { await upsertDimensions(item.id, [], kws, []); withKw++; }
        }
        done++;
        if (done % 50 === 0) console.log(`  ${done}/${total} bearbeitet (${withKw} mit Keywords)…`);
        await sleep(DELAY_MS);
      }
    } finally { await ctx.close(); }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await browser.close();
  console.log(`\nFertig: ${done} bearbeitet, ${withKw} mit Keywords angereichert.`);
}

async function run() {
  const { data, error } = await sb.from("sources").select("id,base_url,language,feed_url").eq("active", true);
  if (error) throw new Error(`Quellen-Abfrage fehlgeschlagen: ${error.message}`);
  console.log(`${data?.length ?? 0} aktive Quellen geladen.`);
  if (!data?.length) throw new Error("Keine aktiven Quellen gefunden – Abbruch.");

  if (MODE === "analyze") { await analyzeBacklog(); return; }
  if (MODE === "enrich")     { await enrichArticles(data as Source[]); return; }
  if (MODE === "reclassify") { await reclassifyPages(data as Source[]); return; }
  if (MODE === "retopic")    { await retopicArticles(); return; }
  if (MODE === "retype")     { await retypeArticles(); return; }
  if (MODE === "rekeyword")  { await rekeywordArticles(data as Source[]); return; }

  // Browser nur im Render-Modus starten; Discovery-Only läuft komplett ohne Chromium.
  const browser = RENDER ? await chromium.launch() : null;
  const sources = (data ?? []) as Source[];
  // Gesamt-Zeitbudget gleichmäßig auf die Quellen verteilen → der Lauf endet
  // garantiert vor dem CI-Job-Timeout, jede Quelle bekommt eine faire Frist.
  const runDeadline = Date.now() + TIME_BUDGET_MS;
  try {
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      if (Date.now() >= runDeadline) { console.log("Zeitbudget erreicht — restliche Quellen übersprungen."); break; }
      // Restzeit auf die noch ausstehenden Quellen aufteilen.
      const remainingSrc = sources.length - i;
      const srcDeadline = Math.min(runDeadline, Date.now() + Math.floor((runDeadline - Date.now()) / remainingSrc));
      console.log(`\n=== ${src.base_url} (Frist: ${Math.round((srcDeadline - Date.now()) / 1000)}s) ===`);
      const ctx = browser ? await browser.newContext({ userAgent: UA, locale: src.language === "fr" ? "fr-FR" : "de-DE" }) : null;
      try {
        await crawlSource(ctx, src, srcDeadline);
      } finally {
        if (ctx) await ctx.close();
      }
    }
  } finally {
    if (browser) await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
