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

// RETIRED (gleiche Behandlung aller Verlage): die früher kuratierten FAZ/n-tv-Ressort-Feeds
// werden jetzt GENERISCH von discoverFeeds() entdeckt (deklarierte Feeds + probierte Sektions-
// Feed-Konventionen wie `/rss/<ressort>/`, `<ressort>/rss`). Leer = keine Verlags-Sonderbehandlung.
const KNOWN_FEEDS: Record<string, string[]> = {};
const MIN_BODY = 1200;                                       // viel Fließtext = echter Artikel (Hubs haben wenig)
// RECENCY-FENSTER (VEREINHEITLICHT die Quellen): Verlage exponieren wild unterschiedlich viele
// URLs (n-tv: Archiv über dichte Quervernetzung bis 2009; Tagesschau/FAZ: keine Sitemap → wenig).
// Das Projekt verfolgt STILLE EDITS über Zeit — Wochen/Jahre alte Archiv-Artikel werden nicht mehr
// editiert und verbrennen nur Render-Budget. Darum NEUE Artikel nur führen, wenn ihr
// Veröffentlichungsdatum jünger als ARTICLE_MAX_AGE_DAYS ist; ältere → pages.kind='archive'
// (nicht erneut rendern). So konvergiert jede Quelle aufs gleiche jüngste Fenster.
// 30 Tage = deckungsgleich mit der 30-Tage-Retention (maintenance.sql, last_seen) und dem
// Edit-Fenster (stille Edits passieren Stunden–Tage nach Veröffentlichung, nicht Monate). Bei 90
// rutschten massenhaft 1–3 Monate alte Evergreens/Backlog-Funde frisch in den Bestand und wirkten
// „heute erfasst, aber ewig alt" (FAZ Art. 1618981, 88 T; ganze Spike-Tage mit >1500 Alt-Artikeln).
const ARTICLE_MAX_AGE_DAYS = Number(process.env.ARTICLE_MAX_AGE_DAYS ?? 30);
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
      // JEDE n-tv-Artikel-URL endet auf „-id<N>.html"; der Slug davor variiert (mehrere Slug-
      // Varianten → sonst Mehrfach-Erfassung, z.B. id30797293 unter 2 Slugs). Auf die kanonische
      // Kurzform id<N>.html umschlüsseln (resolved per 308-Redirect; folgt der Scraper).
      const m = u.pathname.match(/-id(\d+)\.html$/i);
      if (m) return `https://www.n-tv.de/id${m[1]}.html`;
    }
    // Artikel tragen ihre Identität IMMER im PFAD (Slug + ID). Query/Hash sind bei allen Quellen
    // reine UI-/Tracking-Zustände (?tab=tools, ?tab=aiAssistant, ?isPreviewManager=true, utm_*,
    // #ref=rss). Ungestrippt entstand je Variante eine EIGENE pages-Zeile, die nie eine
    // articles-Zeile bekam (die entsteht unter der kanonischen URL) → im Dashboard ewig
    // „wird erfasst…", dazu jeden Lauf ein verschwendeter Render.
    // Sektions-/Suchseiten BRAUCHEN ihre Query (Tagesschau ?datum=…) → nur Artikel-Formen anfassen.
    if ((u.search || u.hash) && looksLikeArticle(u.origin + u.pathname)) {
      u.search = ""; u.hash = "";
      return u.href;
    }
  } catch { /* ungültige URL → unverändert */ }
  return raw;
}

// Bilds Artikel-Hex-ID (24 Hex am Ende des Slugs, opt. .html). Identisch über alle Slug-Varianten.
function bildId(u: string): string | null {
  const m = /(?:^|[-/])([0-9a-f]{24})(?:\.html?)?(?:[?#]|$)/i.exec(u);
  return m ? m[1].toLowerCase() : null;
}
// Kanonische Artikel-URL aus dem HTML (<link rel="canonical">, sonst og:url). Bild liefert
// DENSELBEN Artikel unter mehreren Slug-Varianten (gleiche Hex-ID), aber EINER kanonischen URL
// → Mehrfach-Erfassung (s. Screenshot „Dahoam is Dahoam"). Auf die kanonische umschlüsseln,
// damit alle Varianten zu EINER articles-Zeile zusammenfallen. Konservativ: nur bild.de und nur
// wenn die kanonische DIESELBE Hex-ID trägt (kein Verschlucken in eine fremde URL). Die kurze
// Form bild.de/<id> resolved NICHT, daher braucht es die seiten-eigene kanonische URL.
function canonicalArticleUrl(url: string, html: string): string {
  let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch { return url; }
  if (!/(^|\.)bild\.de$/.test(host)) return url;
  const id = bildId(url); if (!id) return url;
  const m = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)
    ?? /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(html)
    ?? /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (m?.[1] && bildId(m[1]) === id) {
    try {
      const cand = new URL(m[1], url);
      // ENTARTETER canonical: Bild liefert (auf Consent-/Fehler-Renders) `/article/<hexid>` OHNE
      // Slug. Übernahm man ihn, entstand ein Artikel namens „Bild" unter einer URL, zu der es gar
      // keine pages-Zeile gibt (unsichtbar, aber dauerhaft re-gescannt), während die echte
      // Slug-Seite ewig auf „wird erfasst…" stand. Solche Kanoniken verwerfen.
      if (!/^\/article\/[0-9a-f]{24}\/?$/i.test(cand.pathname)) return cand.href;
    } catch {}
  }
  return url;
}

// Verlagsstabile Artikel-ID aus der URL — der Teil, der einen RE-SLUG überlebt. Verlage benennen
// Artikel um (neue Überschrift → neuer Slug, oft mit neu gesetztem Datum), die CMS-ID bleibt:
//   Bild:       24-Hex-ID am Slug-Ende          (…-6a4bf145b2ab39bc4a32345b)
//   Spiegel:    UUID nach „-a-"                 (…-a-350acd2a-26ff-4761-…)
//   FAZ:        numerische Dokument-ID vor .html (…-faz-200749933.html; Liveblogs re-sluggen
//               bei JEDER Ticker-Meldung — WM-Blog lag unter 40+ Slugs)
//   Tagesschau: Sophora-Kurz-ID nach dem KOMMA  (…-fluch,wm-liveblog-100.html — der Vor-Komma-
//               Teil ist die re-sluggbare Überschrift; wm-liveblog-100 lag unter 72 Slugs)
//   n-tv:       braucht keinen Key — canonUrl reduziert jede Form auf id<N>.html.
function articleKey(url: string): string | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase(), path = u.pathname;
  if (/(^|\.)bild\.de$/.test(host)) return bildId(url);
  if (/(^|\.)spiegel\.de$/.test(host)) return path.match(/-a-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]?.toLowerCase() ?? null;
  if (/(^|\.)faz\.net$/.test(host)) return path.match(/-(\d{8,})\.html$/)?.[1] ?? null;
  if (/(^|\.)tagesschau\.de$/.test(host)) return path.match(/,([a-z0-9-]+-\d+)\.html$/i)?.[1]?.toLowerCase() ?? null;
  return null;
}

// RE-SLUG-ABGLEICH (alle Verlage mit stabiler CMS-ID): Ohne ihn entstünde je Slug eine EIGENE
// articles-Zeile → dieselbe Story zählt an mehreren Tagen (Bild WM-Trump/Fifa: 05.+06.07. unter
// 3 Überschriften; bestandsweit Bild 251, FAZ 1.166, Spiegel 551, Tagesschau 266 Extra-Zeilen).
// Fix: existiert unter der neuen (kanonischen) URL noch kein Artikel, aber einer mit GLEICHER
// CMS-ID unter anderer URL, dann die BESTEHENDE Zeile auf die neue URL umziehen (id/Historie/
// eingefrorenes published_at bleiben) und die Alt-Seite als alias parken. So bleibt es EIN
// Artikel; der Re-Slug erscheint als stille Titel-/Datums-Änderung — genau das Kernsignal.
async function reconcileReslug(sourceId: number, canonUrl2: string): Promise<void> {
  if (DRY_RUN) return;
  const key = articleKey(canonUrl2); if (!key) return;
  // Schon ein Artikel unter der neuen URL? Dann normaler Upsert-Pfad, nichts zu tun.
  const { data: exists } = await sb.from("articles").select("id").eq("url", canonUrl2).maybeSingle();
  if (exists) return;
  // Bestehende Zeile(n) mit gleicher CMS-ID unter anderer URL — reichste zuerst (meiste Revisionen).
  // Der articleKey-Gegencheck schließt LIKE-Streutreffer aus (z.B. …-100 in …-1000).
  const { data: olds } = await sb.from("articles")
    .select("id,url,revision_count").eq("source_id", sourceId)
    .like("url", `%${key}%`).order("revision_count", { ascending: false });
  const old = (olds ?? []).find((o: any) => o.url !== canonUrl2 && articleKey(o.url) === key);
  if (!old) return;
  await sb.from("articles").update({ url: canonUrl2 }).eq("id", (old as any).id);
  await sb.from("pages").update({ kind: "alias" }).eq("url", (old as any).url);
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

// GRATIS-SENDER: gebühren-/werbefinanzierte Angebote OHNE jede Bezahlschranke. Ihr HTML trägt
// KEIN JSON-LD-Frei-Signal (isAccessibleForFree fehlt), enthält aber seitenweit das Analytics-
// Framework „Piano" (…piano-…) → PAYWALL_CSS schlug fälschlich an und die sticky-Logik fror den
// Fehlbefund dauerhaft ein (Art. 1521125, tagesschau). Diese Hosts sind IMMER frei → paywalled=false
// als verlässliches Frei-Signal, das einen bestehenden Fehl-true über stickyPaywall wieder löst.
const FREE_OUTLETS = /(^|\.)tagesschau\.de$|(^|\.)n-tv\.de$/i;
function isFreeOutlet(url: string): boolean {
  try { return FREE_OUTLETS.test(new URL(url).hostname); } catch { return false; }
}

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

// Ressort-Baum aus der BreadcrumbList (JSON-LD, Schema.org) — der verlässlichste verlagsübergreifende
// Ressort-Träger, AUCH wenn er nicht in der URL steht (n-tv idN.html, Bild/FAZ-Kurz-URLs, dpa-Importe).
// Jeder Verlag liefert die Brotkrume: [Verlagsname, Ressort, (Unterressort…), Artikeltitel].
// Wir schneiden das ERSTE (Verlags-/Startseiten-Label) und das LETZTE (= Artikelüberschrift) ab →
// übrig bleibt der reine Ressort-Pfad ("Feuilleton", "Sport", "Politik"), der in topicOf einfließt.
function breadcrumbSections(html: string, ld: any[]): string[] {
  const bc = ld.find((d) => d && typeIncludes(d["@type"], "BreadcrumbList"));
  const items = Array.isArray(bc?.itemListElement) ? bc.itemListElement : [];
  const names = items
    .slice()
    .sort((a: any, b: any) => (Number(a?.position ?? 0) - Number(b?.position ?? 0)))
    .map((e: any) => (typeof e?.name === "string" ? e.name : e?.item?.name))
    .filter((s: any): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s: string) => s.trim());
  // Erstes = Verlags-/Startseiten-Label, Letztes = Artikeltitel → beide raus.
  const mid: string[] = names.slice(1, -1);
  // Reine Navigations-/Verlagslabels ohne Ressort-Bedeutung verwerfen (sind kein Thema).
  const NOISE = /^(startseite|home|accueil|übersicht|uebersicht|aktuell|news|newsticker|importe?|incoming|dpa|afp|reuters|sid|kna|epd|agenturmeldungen|mehr|alle|artikel|article|faz\.net|bild|der spiegel|spiegel|tagesschau|n-tv|ntv|le monde)$/i;
  return mid.filter((s: string) => !NOISE.test(s));
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
  // Verlags-/Vendor-Varianten: JEDES <meta name="…keywords">. Tagesschau spielt SWR-syndizierte
  // Regionalstücke mit Schlagwörtern NUR in `swr_keywords` aus (kein news_keywords, kein article:tag,
  // Art. 1521125) → sonst 0 Keywords. Der Suffix-Match deckt swr_/sr_/wdr_… generisch ab.
  for (const m of html.matchAll(/<meta[^>]+name=["']([a-z0-9_]*keywords)["'][^>]+content=["']([^"']*)["']/gi)) push(m[2]);
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
    isFreeOutlet(url) ? false                       // Gratis-Sender: immer frei (überstimmt Piano-Fehlalarm)
    : iaff.length > 0 ? (iaff.some(notFree) && !iaff.some(isFree))
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

  // Kategorien = articleSection/article:section PLUS Ressort-Baum aus der BreadcrumbList.
  // Der Breadcrumb-Pfad ist das verlagsübergreifende Ressort-Signal, das die (bei n-tv/Bild/FAZ
  // oft ressortlose) URL nicht trägt → topicOf klassifiziert damit deutlich mehr Artikel korrekt.
  const catRaw = article.articleSection ?? metaContent(html, "article:section") ?? "";
  const secCats: string[] = (typeof catRaw === "string" ? catRaw.split(/[,;|]/) : catRaw)
    .map((c: string) => c.trim()).filter((c: string) => c.length > 1 && c.length < 80);
  const categories: string[] = [...new Set([...secCats, ...breadcrumbSections(html, ld)])]
    .filter((c) => c.length > 1 && c.length < 80);

  const author_status = classifyAuthorStatus(authorList);
  // Themen-Klassifizierung aus dem Ressort-Pfad — MEHRERE URL-Kandidaten in Prioritätsreihenfolge:
  //   1) die gespeicherte/gecrawlte `url` (trägt bei den meisten Verlagen die Rubrik; bei
  //      Tagesschau-Regional /inland/regional/… zeigt og:url auf die MDR/NDR-Quelle mit REGION-
  //      statt Ressort-Pfad → gespeicherte URL zuerst),
  //   2) og:url und 3) <link rel=canonical> (retten n-tv, dessen gespeicherte URL von canonUrl auf
  //      die ressortlose Kurzform idN.html verkürzt ist — die volle Sektion steckt in og:url).
  // topicOf nimmt die erste URL, die eine Rubrik trägt; erst danach die Kategorien/Breadcrumb-Ressorts.
  const canonHref = (/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)
    ?? /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(html))?.[1] ?? "";
  const ogUrl = metaContent(html, "og:url") ?? "";
  const topic = topicOf(categories, [url, ogUrl, canonHref].filter((u) => /^https?:\/\//i.test(u)));

  // rubric = ressorttragende URL für die Unterkategorien-Hierarchie im Frontend. NUR nötig, wenn die
  // gespeicherte URL selbst kein Ressort trägt (n-tv `idN.html`) → dann die sektionierte og:url/
  // canonical, damit der Verlags-Ressort-Baum (z.B. Regional → Baden-Württemberg) auch für n-tv
  // erscheint. Trägt die gespeicherte URL schon ein Ressort (Bild/FAZ/Spiegel/Tagesschau) → null,
  // das Frontend leitet die Rubrik dann direkt aus der URL ab.
  const secCount = (u: string) => { try { const s = new URL(u).pathname.toLowerCase().replace(/\/+$/, "").split("/").filter(Boolean); return s.slice(0, Math.max(0, s.length - 1)).filter((x) => !/^\d+$/.test(x) && !/-\d{4,}/.test(x)).length; } catch { return 0; } };
  // NUR wenn die gespeicherte URL GAR KEIN Ressort trägt (n-tv `idN.html`, secCount 0). Sonst null →
  // Frontend leitet aus der URL ab. WICHTIG: bei Syndication (Tagesschau→sr.de/mdr.de) hat die
  // QUELL-og:url zwar mehr Segmente, ist aber die falsche (fremde) Rubrik → die eigene /inland/
  // regional/<Land>/-URL bleibt maßgeblich, darum kein „mehr Segmente"-Vergleich.
  const rubric = secCount(url) === 0 ? ([ogUrl, canonHref].find((u) => /^https?:\/\//i.test(u) && secCount(u) > 0) ?? null) : null;

  return { title, description, og_image, published_at, published_precise, modified_at, paywalled, article_type, word_count, reading_min, lang_detected, author_status, topic, rubric, authors: authorList, keywords, categories };
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
function cleanBody(body: string, url: string, title: string | null, dek: string | null = null): string {
  let b = body;
  let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch {}

  // JSON-LD-Blobs, die als ROHTEXT in den extrahierten Body lecken ({"@context":"…schema.org"…},
  // z.B. BreadcrumbList/VideoObject auf n-tv-Videoseiten, Art. 897305). Nie Fließtext → per
  // Klammer-Zählung exakt entfernen (Regex kann geschachtelte Objekte nicht sauber bounden).
  for (let i = b.indexOf('{"@context"'); i >= 0; i = b.indexOf('{"@context"', i)) {
    let depth = 0, j = i;
    for (; j < b.length; j++) { if (b[j] === "{") depth++; else if (b[j] === "}" && --depth === 0) { j++; break; } }
    if (depth !== 0) break; // abgeschnittener Blob → nicht raten
    b = b.slice(0, i) + " " + b.slice(j);
  }

  if (/(^|\.)bild\.de$/.test(host)) {
    // Kopf-Chrome: Bild klebt je Render mal <Überschrift><Bild-Caption>Foto: <Credit><DD.MM.YYYY
    // - HH:MM Uhr> VOR den Lauftext → reine Phantom-Edits, deren Diff komplett versiegelt und dann
    // „Unterschied außerhalb des erfassten Ausschnitts" zeigt (Art. 660677). Den GANZEN Vorspann
    // bis einschließlich des führenden „Foto: … Uhr" am Kopf kappen (nur am Anfang, signaturgebunden).
    b = b.replace(/^[\s\S]{0,500}?Foto:\s*[^]{0,90}?\d{1,2}\.\d{2}\.\d{4}\s*[-–—]\s*\d{1,2}:\d{2}\s*Uhr\s*/, "");
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
    // Credits OHNE Slash-vor-Agentur-Muster, die beim Foto-Tausch mit-rotieren (Art. 1084636):
    // "Foto: Getty Images via AFP" und "Foto: <Name>/ZUMA/SplashNews.com". KEIN \b vor "Foto" —
    // Bild klebt die Caption an den Satz davor („BesucherFoto:"), da gibt es keine Wortgrenze.
    b = b.replace(/Foto:\s*Getty Images(?:\s+via\s+AFP)?/g, " ")
         .replace(/Foto:\s*[^/]{1,60}\/ZUMA\/[\w.]{1,40}?\.com/g, " ");
    // Social-Embed-Consent-Platzhalter (X/Twitter/Instagram …): erscheint/verschwindet je Render
    // → Phantom-Edits (Art. 1084636). Fester Start- + Endmarker, Länge gedeckelt.
    b = b.replace(/An dieser Stelle findest du Inhalte aus [\s\S]{0,700}?Weitere Infos finden Sie hier\.?/g, " ");
    // Rotierendes Kaufberater-/Deals-Widget hinter "+++" (Prime-Day-/Commerce-Seiten, Art.
    // 265266: die Produktliste "<Produkt>10,29 EUR<Produkt>249,95 EUR…" wird je Scan ein-/
    // ausgeblendet → ±45-W-Pendel). Den Preis-Lauf entfernen, das "+++" selbst bleibt (= die
    // stabile Ohne-Widget-Variante). Liveblog-"+++"-Zeilen tragen keine EUR-Preise → unberührt.
    b = b.replace(/(\+\+\+)((?:(?!\+\+\+)[\s\S]){0,400}?\d+,\d{2}\s*EUR)+/g, "$1");
  }

  if (/(^|\.)n-tv\.de$/.test(host)) {
    if (title) {
      const head = title.split(/\s+[-|–]\s+/)[0].trim();
      if (head.length > 12) {
        const esc = head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        b = b.replace(new RegExp("^[\\s\\S]{0,280}?" + esc), "");
      }
    }
    // Regional-Teaser-Block: an Regional-Artikeln hängt n-tv eine Liste ANDERER Regional-
    // Schlagzeilen (je <Bundesland-Sektion><Schlagzeile>, ohne Trennzeichen), die per JS
    // intermittierend in den Body geladen wird UND je Render rotiert → sonst Phantom-Edits
    // (~−12 W, Art. 350418 u.v.). Erkennen am dichten, wiederholten Sektions-Label DIREKT vor
    // einem Großbuchstaben (≥2 Treffer nah beieinander = echter Block, kein Zufall) und ab dem
    // ERSTEN solchen Teaser bis zum Ende kappen. Labels = n-tvs Regional-Sektionen (Verbund-
    // regionen zuerst, „Sachsen-Anhalt" vor „Sachsen").
    const REGION = /(?:Baden-Württemberg|Berlin & Brandenburg|Hamburg & Schleswig-Holstein|Mecklenburg-Vorpommern|Niedersachsen & Bremen|Nordrhein-Westfalen|Rheinland-Pfalz & Saarland|Sachsen-Anhalt|Sachsen|Thüringen|Bayern|Hessen)[A-ZÄÖÜ]/g;
    const hits: number[] = []; let mm: RegExpExecArray | null;
    while ((mm = REGION.exec(b)) !== null) { hits.push(mm.index); if (hits.length > 40) break; }
    // Ab dem ERSTEN DICHTEN PAAR kappen — nicht stur hits[0]/hits[1] prüfen: bei Regional-
    // Artikeln ist der EIGENE Sektions-Präfix („SachsenZugausfälle …") Treffer Nr. 1 und liegt
    // weit vor dem rotierenden Block am Ende → die alte Prüfung feuerte nie, der Artikel
    // sammelte 24 Phantom-Edits durch rotierende Regional-Schlagzeilen (Art. 867391).
    for (let i = 0; i + 1 < hits.length; i++) {
      if (hits[i + 1] - hits[i] < 400) { b = b.slice(0, hits[i]); break; }
    }
    // Video-„Empfehlungen"-Karussell am Ende (rotiert je Scan → Dauer-Phantom-Edits, Art.
    // 897305): „Empfehlungen<M:SS><Schlagzeile>…Mehr Inhalte anzeigen" bis zum Ende kappen.
    const emp = b.search(/Empfehlungen\d{1,2}:\d{2}/);
    if (emp > 0 && /Mehr Inhalte anzeigen\s*$/.test(b)) b = b.slice(0, emp);
    b = b.replace(/Mehr Inhalte anzeigen\s*$/, " ");
  }

  if (/(^|\.)faz\.net$/.test(host)) {
    // FAZ klebt VOR den Lauftext einen Kopf-Block, der je nach Render-Zeitpunkt ganz/teilweise/
    // gar nicht im extrahierten Body landet — daraus entstehen sonst reine Phantom-Edits:
    //   "[Ressort]FAZ+<Kicker> : <Überschrift>[18.06.2026, 12:58][Lesezeit: 6 Min.]<Lauftext…>"
    // 1) "Lesezeit: N Min." (Web-Komponente) inkl. evtl. direkt davorstehendem Datum/Uhrzeit als
    //    EINHEIT entfernen — durch Space ersetzen, damit Überschrift und Lede nicht verkleben.
    b = b.replace(/(?:\d{1,2}\.\d{2}\.\d{4},\s*\d{1,2}:\d{2}\s*(?:Uhr)?\s*)?Lesezeit:\s*\d+\s*Min\.?/g, " ");
    // 1a) Ressort-Breadcrumb am Kopf: FAZ klebt je Render mal die Pfad-Ressorts VOR die Überschrift
    //     (z.B. "/aktuell/feuilleton/debatten/…" → "FeuilletonDebatten<Überschrift>…") → sonst reine
    //     Phantom-Edits (Art. 638248). Den Breadcrumb aus den URL-Segmenten bauen und am Start kappen.
    try {
      const segs = new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
      const rub = segs.filter((s, i) => i < segs.length - 1 && s !== "aktuell" && /^[a-zäöüß]{3,}$/.test(s));
      if (rub.length) {
        const crumb = rub.map((s) => s[0].toUpperCase() + s.slice(1)).join("").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        b = b.replace(new RegExp("^\\s*" + crumb, "i"), "");
      }
    } catch {}
    // 1b) Content-Type-Label ("Gastbeitrag" etc.) + "Von <Autor>"-Byline, die FAZ zwischen Überschrift
    //     und Lede klebt (je Render mal da, mal nicht) → Phantom-Edit. EXAKT am Lede-Anfang (description)
    //     kappen, damit die Byline nicht in den echten Text hineingestrippt wird. Ohne dek: kein Eingriff.
    if (dek) {
      const anchor = decodeEntities(dek).replace(/\s+/g, " ").trim().slice(0, 40);
      if (anchor.length >= 12) {
        const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        b = b.replace(new RegExp("(?:Gastbeitrag|Gastkommentar|Kommentar|Glosse|Reportage|Analyse|Interview|Leitartikel|Kolumne|Essay|Nachruf)?\\s*Von\\s+[\\s\\S]{0,80}?(?=" + esc + ")", ""), " ");
      }
    }
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
// Rohen Artikeltext aus EINER HTML-Quelle ziehen (Readability, sonst DOM-Container-Fallback).
function extractArticleText(html: string, url: string): string {
  return asArticle(html, url)?.body ?? extractBodyFallback(html, url)?.body ?? "";
}
// Substanz-Maß eines Bodys: Gesamtlänge der ECHTEN Absätze (normalizeParas: ≥60 Zeichen, keine
// Boilerplate). Junk-RESISTENT: kurze Widget-Labels (<60 Z.) und Boilerplate fließen NICHT ein,
// also misst `chars` echten Artikeltext. Grundlage für die Roh-vs-gerendert-Abwägung; wird VOR
// cleanBody gemessen, solange die Readability-Absatzumbrüche (so vorhanden) noch da sind.
function bodyMeasure(text: string): { paras: number; chars: number } {
  const ps = normalizeParas(text);
  return { paras: ps.length, chars: ps.reduce((s, p) => s + p.length, 0) };
}
// SELBST-ENTSCHEIDUNG: der sauberste UND zugleich vollständigste Body gewinnt.
//  - ROH-HTML (vor JS) ist sauber (kein JS-injizierter Werbe-/Streaming-/Empfehlungs-Müll), kann
//    aber UNVOLLSTÄNDIG sein: reine Client-Render-Verlage (Spiegel-Newsblogs) ODER per JS nach-
//    geladene Ticker/Timelines/Folgeseiten stehen nur im gerenderten DOM.
//  - GERENDERT ist vollständig (JS-Inhalte da), aber oft mit Müll verschmutzt.
// Maß ist die bereinigte ECHT-Text-Länge (kurze Junk-Schnipsel sind durch normalizeParas schon
// rausgefiltert). Der gerenderte Body gewinnt nur, wenn er SPÜRBAR mehr echten Text trägt
// (> 20 %, d.h. JS-nachgeladener Inhalt: Ticker/Folgeseiten) ODER es ein erkannter Live-/Timeline-
// Inhalt ist (den wir bewusst aufgeklappt haben). Bei ähnlicher Vollständigkeit (±20 %) gewinnt das
// saubere Roh-HTML — dessen fehlendes „Mehr" wäre ohnehin nur das injizierte Widget (Art. 269704:
// gerendert nur +3,7 % → Roh gewinnt). So entscheidet das System fallweise selbst.
function chooseBody(rawText: string, renText: string, isLive: boolean): { text: string; fromRendered: boolean } {
  const r = bodyMeasure(rawText), d = bodyMeasure(renText);
  const rawOk = r.chars >= MIN_BODY, renOk = d.chars >= MIN_BODY;
  if (!rawOk && !renOk) return d.chars >= r.chars ? { text: renText, fromRendered: true } : { text: rawText, fromRendered: false };
  if (!rawOk) return { text: renText, fromRendered: true };
  if (!renOk) return { text: rawText, fromRendered: false };
  const renMoreComplete = d.chars > r.chars * 1.2;
  return (isLive || renMoreComplete) ? { text: renText, fromRendered: true } : { text: rawText, fromRendered: false };
}

function trackBody(html: string, url: string, rawHtml: string | null, art: { body: string } | null, metaIsLive: boolean, title: string | null = null, dek: string | null = null): { body: string; isLive: boolean } | null {
  const live = extractLiveBlog(rawHtml ?? html);
  if (live) return { body: live.body, isLive: true }; // JSON-LD-Ticker ist sauber & vollständig → direkt nehmen
  // Zwei Kandidaten gewinnen lassen: Artikeltext aus ROH-HTML (vor JS) vs. aus gerendertem DOM.
  // WICHTIG: BEIDE erst per cleanBody bereinigen, DANN vergleichen. Sonst bläht ein JS-injiziertes
  // Junk-Widget (z.B. n-tvs Regional-Teaser-Liste) den gerenderten Body künstlich auf, sodass er
  // „> 20 % mehr Text" hat und chooseBody ihn fälschlich als „vollständiger" wählt — obwohl das
  // „Mehr" nur Müll ist. Nach cleanBody schrumpft der gerenderte auf den echten Artikeltext, und
  // bei Gleichstand gewinnt das saubere Roh-HTML.
  const rawText = rawHtml ? cleanBody(extractArticleText(rawHtml, url), url, title, dek) : "";
  const renText = cleanBody(art?.body ?? extractArticleText(html, url), url, title, dek);
  if (!rawText && !renText) return null;
  const pick = chooseBody(rawText, renText, metaIsLive);
  return { body: pick.text, isLive: metaIsLive };
}

type PrevState = { title: string | null; content_hash: string | null; para_fps: string | null; body_words: number | null; extension_count: number | null; edit_count: number | null; revision_count: number | null; article_type: string | null; description: string | null; og_image: string | null; paywalled: boolean | null; author_status: string | null; topic: string | null } | null;

// Spalten der `articles`-Basistabelle, die wir je Scan vergleichen, um UNSICHTBARE Edits zu
// finden. Müssen in BEIDEN prev-Selects (saveArticleFull + analyzeBacklog) mitgelesen werden.
const PREV_COLS = "title,content_hash,para_fps,body_words,extension_count,edit_count,revision_count,article_type,scan_count,scan_times,paywalled,published_at,modified_at,first_seen,description,og_image,author_status,topic";

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
// RICHTUNGSUNABHÄNGIGE „Flip-Signatur" eines Edits: der Hash der symmetrischen Fingerprint-
// Differenz zwischen altem und neuem Absatz-Set. Schlüssel-Eigenschaft: ein A→B-Edit und das
// spätere B→A-Zurück-Flip liefern DIESELBE Signatur (die Menge der wechselnden Absätze ist
// identisch, nur die Richtung dreht). Damit lässt sich „die Stelle pendelt schon wieder" auch
// dann erkennen, wenn der GANZE-Body-Hash nie exakt wiederkehrt — z.B. wenn ein client-
// gerendertes Widget (Streaming-Angebote, Empfehlungen, „Folgen"-Button) je Render mal im
// Readability-Body landet, mal nicht. Robuster als der reine content_hash-Vergleich, weil er
// nur die WECHSELNDE Stelle betrachtet statt den oft mit-jitternden Gesamttext.
function flipSig(aFps: string[], bFps: string[]): string {
  const A = new Set(aFps), B = new Set(bFps);
  const sym = [...new Set([...aFps.filter((f) => !B.has(f)), ...bFps.filter((f) => !A.has(f))])].sort();
  return sym.length ? fp(sym.join("|")) : "";
}
// articles-Update, das die optionalen Spalten `recent_hashes`/`recent_flips` GRACEFUL behandelt:
// existiert eine (noch) nicht (kein ALTER gelaufen), wird das Feld weggelassen und erneut
// versucht → der Scraper läuft weiter, der Oszillations-Schutz ist dann nur inaktiv.
async function updateArticle(articleId: number, fields: Record<string, unknown>) {
  let { error } = await sb.from("articles").update(fields).eq("id", articleId);
  if (error && /recent_hashes|recent_flips/i.test(error.message)) {
    const rest = { ...fields }; delete (rest as any).recent_hashes; delete (rest as any).recent_flips;
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
  // Rollende Hash- + Flip-Historie laden (separat + graceful: fehlt eine Spalte, bleibt der
  // jeweilige Schutz inaktiv). recent_flips trägt die richtungsunabhängigen Flip-Signaturen.
  let recentHashes: string[] = [];
  let recentFlips: string[] = [];
  {
    const { data: rh, error: rhErr } = await sb.from("articles").select("recent_hashes,recent_flips").eq("id", articleId).maybeSingle();
    if (!rhErr && (rh as any)?.recent_hashes) recentHashes = String((rh as any).recent_hashes).split(",").filter(Boolean);
    if (!rhErr && (rh as any)?.recent_flips) recentFlips = String((rh as any).recent_flips).split(",").filter(Boolean);
  }
  // Original-Fingerprints des letzten Stands (unbeschnitten, VOR dem Re-Baseline-Schutz unten) —
  // Basis der Flip-Signatur. Gegen die nächste Runde wird wieder hiergegen verglichen, daher
  // konsistent mit dem, was gleich als para_fps gespeichert wird.
  const origPrevFps = (prev.para_fps ?? "").split(",").filter(Boolean);
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
      oldParasClean = normalizeParas(cleanBody(raw.join("\n\n"), url, newTitle, metaNow?.description ?? null));
      prevFps = oldParasClean.map(fp);
      prevHash = fp(prevFps.join("|"));
    }
  }

  const titleChanged = !!prev.title && !!newTitle && decodeEntities(prev.title) !== decodeEntities(newTitle);
  // Verlage ändern beim Bearbeiten oft (nicht immer) STILL das Veröffentlichungsdatum mit.
  // Als unsichtbare Änderung mit-tracken. ≥60 s Differenz, damit Format-/Sekundenjitter nicht zählt.
  // WICHTIG (alle Verlage): gegen den ZULETZT von der SEITE gemeldeten Wert prüfen (letztes
  // Snapshot-`pubdate_new`), NICHT gegen die kanonische `published_at`. Sonst feuert eine STABILE
  // Quellen-Uneinigkeit (Sitemap-Zeit ≠ Seiten-Zeit) bei JEDEM Scan erneut → identisch
  // aussehende Pseudo-„Datums-Edits". newPub ist bei Verlags-Bumps der ROHE Seitenwert
  // (s. freezePubDate) — so bleibt das Re-Dating im Verlauf sichtbar, obwohl published_at
  // eingefroren ist.
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
  // Werbe-/Empfehlungs-Slots, ein client-gerendertes Streaming-Widget wie Art. 269704) und ist
  // sonst NICHTS Echtes geändert (kein Titel/Datum/Meta), dann KEINEN Snapshot schreiben — nur
  // Baseline + Historie still nachziehen. So hört die endlose Wiederholung im Änderungsverlauf auf.
  // Liveblogs/Ticker ausgenommen (echtes Wachstum).
  //
  // Zwei Erkennungen, ODER-verknüpft:
  //  1) content_hash schon kürzlich dagewesen (exakter Ganz-Body-Rücksprung) — billig, aber spröde:
  //     greift nur, wenn der GESAMTE Body byte-genau wiederkehrt.
  //  2) FLIP-SIGNATUR schon kürzlich dagewesen (richtungsunabhängig) — der eigentliche Hebel:
  //     erkennt das Pendeln EINER Stelle auch dann, wenn der restliche Body mit-jittert und der
  //     Ganz-Body-Hash daher nie exakt wiederkehrt. flipSig(A→B) == flipSig(B→A).
  const sig = flipSig(origPrevFps, fps);
  const oscillates = recentHashes.includes(contentHash) || (sig !== "" && recentFlips.includes(sig));
  if (contentChanged && !isTimeline && !titleChanged && !pubChanged && !metaChanged && oscillates) {
    await updateArticle(articleId, {
      content_hash: contentHash, para_fps: fps.join(","), body_words: bodyWords,
      recent_hashes: pushHash(recentHashes, contentHash),
      recent_flips: sig ? pushHash(recentFlips, sig) : recentFlips.join(","),
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
    // Flip-Signatur dieses Edits merken (nur bei reinem Body-Edit sinnvoll) → der nächste
    // Rücksprung auf diese Stelle wird oben als Oszillation erkannt und nicht erneut geschrieben.
    ...(sig && !titleChanged && !pubChanged && !metaChanged ? { recent_flips: pushHash(recentFlips, sig) } : {}),
    ...(newType ? { article_type: newType } : {}),
  });
  await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
}

// Absatzliste speicherschonend kappen (große Liveblogs): max 400 Absätze, je 8000 Zeichen.
// Der Per-Absatz-Cap ist die DIFF-BASELINE: liegt eine spätere Änderung JENSEITS des Caps,
// ist die alte Fassung dort abgeschnitten → der Frontend-Diff kann sie nicht zeigen und meldet
// „Unterschied außerhalb des erfassten Ausschnitts". 62 % der Artikel sind Einzel-Mega-Absätze
// (Bild/n-tv rendern den ganzen Text als EIN <p>) und liefen am alten 2000er-Cap an. 8000
// deckt ~p99 der echten Bodylängen ab (Wachstum der Tabelle ~+11 MB, DB bleibt < 500 MB) und
// schützt zugleich vor Ausreißern (Riesen-Liveblogs). Greift für FUTURE-Edits: die Baseline
// wird beim nächsten Re-Scan je Artikel mit dem größeren Cap neu abgelegt.
function capParas(paras: string[]): string[] {
  return paras.slice(-400).map((p) => p.slice(0, 8000));
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
// Der Cap begrenzt das GESPEICHERTE Diff-Fenster; er sitzt um die Änderung herum (start=p−ctx),
// nicht ab Textanfang → auch eine Änderung tief im Body wird erfasst, solange die Baseline sie
// enthält (siehe capParas). 4000 (vorher 1500) gibt großen Änderungspassagen Platz, ohne dass
// gemeinsamer Prä-/Suffix mitgespeichert wird (der wird abgeschnitten).
function diffRegion(o: string, n: string, ctx = 140, cap = 4000): [string, string] {
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
  if (next === false) return false;   // VERLÄSSLICHES Frei-Signal (JSON-LD isAccessibleForFree=true ODER Gratis-Sender) löst einen Fehl-true
  if (prev === true) return true;      // sonst: einmal Paywall → bleibt Paywall (Stub-Renders liefern null, nicht false → unschädlich)
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

// Ein Artikel „lebt" (echt verfolgt), sobald wir je eine ECHTE Änderung sahen (Revision/Erweiterung/
// Edit). Bis dahin ist er ein statischer Fund → das Recency-Gate greift bei JEDEM Scan, nicht nur beim
// ersten. Schließt die Lücke: ein Erst-Render (z.B. Paywall-Stub) liefert kein Datum (Gate passt),
// spätere Renders tragen aber das echte, ALTE Datum nach — der Artikel trägt dann content_hash und
// würde nie erneut geprüft. So werden auch solche nachträglich als Archiv erkannt und entfernt.
function neverObservedChange(prev: any): boolean {
  return !((prev?.revision_count ?? 0) || (prev?.extension_count ?? 0) || (prev?.edit_count ?? 0));
}

// Artikel vollständig speichern: Metadaten + Dimensionen + Änderungs-Tracking.
// Soll ein NEUER (noch nicht verfolgter) Artikel als Archiv geparkt werden? Nur wenn das
// FRISCHESTE verlässliche Datum (präzises Seiten-Datum ODER vorbefülltes Sitemap-Datum) älter als
// das Fenster ist UND es kein Liveblog/Ticker ist. Verhindert Fehl-Archivierung von Mehrfach-
// Datum-Seiten (Liveticker, Evergreen). Genutzt in saveArticleFull + enrich.
function isStaleForArchive(meta: { published_at: string | null; published_precise: boolean; title: string | null }, prevPublishedAt: string | null | undefined, url: string): boolean {
  if (isLiveContent(url, meta.title)) return false;
  const pageDate = meta.published_precise && meta.published_at ? Date.parse(meta.published_at) : NaN;
  const prevDate = prevPublishedAt ? Date.parse(prevPublishedAt) : NaN;
  const freshest = Math.max(Number.isNaN(pageDate) ? -Infinity : pageDate, Number.isNaN(prevDate) ? -Infinity : prevDate);
  return Number.isFinite(freshest) && (Date.now() - freshest) / 864e5 > ARTICLE_MAX_AGE_DAYS;
}

// published_at ist nach der Erstbefüllung EINGEFROREN. Verlage re-datieren Timelines, Podcast-
// Folgen, Deals und Evergreens laufend („Datums-Bump") — ohne Freeze erschienen sie im Dashboard
// immer wieder als neu veröffentlicht und das Original ginge verloren (FAZ-Reisewarnungen:
// +8 Monate verschluckt). Vorwärts gemeldete Seiten-Daten wandern nach modified_at („Aktualisiert"
// auf der Detailseite); rückwärts gemeldete sind meist Misextraktion (Mehrfach-Datums-Signale,
// v.a. n-tv) und werden verworfen. Nur die autoritative News-Sitemap darf nach FRÜHER verfeinern
// (RPC apply_sitemap_dates, LEAST). Rückgabe = Datum fürs Snapshot-Tracking: beim Vorwärts-Bump
// der ROHE Seitenwert, damit trackChanges das Re-Dating als „Datum still geändert" protokolliert,
// sonst der kanonische. Genutzt in saveArticleFull + enrich.
function freezePubDate(meta: ReturnType<typeof extractMeta>, prev: any): string | null {
  const pageRaw = meta.published_precise ? meta.published_at : null;
  let track = meta.published_at ?? null;
  if (prev?.published_at) {
    if (pageRaw && Date.parse(pageRaw) > Date.parse(prev.published_at) + 60000) {
      if (!meta.modified_at || Date.parse(pageRaw) > Date.parse(meta.modified_at)) meta.modified_at = pageRaw;
      track = pageRaw;
    } else {
      track = prev.published_at;
    }
    meta.published_at = prev.published_at;
  } else if (meta.published_at) {
    // Erstbefüllung: nie NACH der Ersterfassung (der Artikel existierte ja schon; sonst erschiene
    // im Verlauf ein Edit VOR der „Veröffentlichung") — obere Schranke first_seen bzw. jetzt.
    const seenCap = prev?.first_seen ?? new Date().toISOString();
    if (Date.parse(meta.published_at) > Date.parse(seenCap)) meta.published_at = seenCap;
    track = meta.published_at;
  }
  // modified_at nie durch NULL/Älteres ersetzen — Seiten melden dateModified nicht bei jedem
  // Scan, und ein einmal erfasster Bump soll nicht wieder verschwinden.
  if (prev?.modified_at && (!meta.modified_at || Date.parse(meta.modified_at) < Date.parse(prev.modified_at)))
    meta.modified_at = prev.modified_at;
  return track;
}

async function saveArticleFull(sourceId: number, url: string, html: string, rawHtml: string | null = null) {
  const discoveredUrl = url;
  url = canonUrl(url); // n-tv-Ticker-Varianten → Kanonik, damit prev/upsert/Tracking konsistent EINE Zeile treffen
  url = canonicalArticleUrl(url, html); // Bild-Slug-Varianten → kanonische URL (Mehrfach-Erfassung verhindern)
  const meta = extractMeta(html, url);
  const art = asArticle(html, url);
  // Werbe-/Commerce-Inhalte NICHT analysieren (User-Entscheid 07.07.). Prüft neben der
  // gespeicherten URL auch meta.rubric (= sektionierte og:url/canonical), weil n-tv-URLs
  // (idN.html) die Sektion verlieren — nur so ist shopping-und-service dort erkennbar.
  // Seite als 'sponsored' parken (fällt aus dem Render-Pool), evtl. schon angelegte
  // articles-Zeile mitsamt Anhang löschen (FK-CASCADE).
  if ([url, meta.rubric].some((c) => c && classifyUrl(c) === "sponsored")) {
    if (!DRY_RUN) {
      await sb.from("pages").update({ kind: "sponsored" }).in("url", [...new Set([discoveredUrl, url])]);
      await sb.from("articles").delete().eq("url", url);
    }
    return null;
  }
  // Re-Slug auf die bestehende Zeile umziehen, BEVOR prev gelesen wird → prev findet den
  // migrierten Artikel, Tracking läuft als stille Änderung weiter (keine Datums-/Zähl-Dopplung).
  await reconcileReslug(sourceId, url);
  // Vorzustand VOR dem Upsert lesen (sonst überschreibt upsertArticle den alten Titel).
  const { data: prev } = await sb.from("articles")
    .select(PREV_COLS)
    .eq("url", url).maybeSingle();
  // RECENCY-FILTER (Quellen-Vereinheitlichung): NEUE Artikel (noch nicht verfolgt), deren BESTES
  // verlässliches Datum älter als das Fenster ist, NICHT als Artikel führen — Archiv-Seite parken.
  // FRISCHESTES Datum aus (präzisem Seiten-Datum ODER vorbefülltem News-Sitemap-Datum) nehmen —
  // sonst werden Mehrfach-Datum-Seiten fälschlich archiviert (Liveticker: erste Meldung Monate alt;
  // Evergreen mit altem Originaldatum, aber aktueller Sitemap-Zeit). Liveblogs/Ticker NIE archivieren
  // (immer aktuell + editierfreudig). Bereits verfolgte (prev.content_hash) bleiben unangetastet.
  if (neverObservedChange(prev) && isStaleForArchive(meta, (prev as any)?.published_at, url)) {
    if (!DRY_RUN) {
      await sb.from("pages").update({ kind: "archive" }).in("url", [...new Set([discoveredUrl, url])]);
      if (prev) await sb.from("articles").delete().eq("url", url); // schon angelegte, aber noch änderungslose Alt-Zeile mit-entfernen
    }
    return null;
  }
  meta.paywalled = stickyPaywall((prev as any)?.paywalled, meta.paywalled); // Paywall nie fälschlich aufheben
  const pubTrack = freezePubDate(meta, prev as any); // published_at einfrieren, Bump → modified_at + Verlauf
  const id = await upsertArticle(sourceId, url, meta, { scan_count: ((prev as any)?.scan_count ?? 0) + 1, scan_times: appendScan((prev as any)?.scan_times) });
  // ALIAS-AUFRÄUMEN: Die entdeckte URL war eine andere Schreibweise desselben Artikels (Bild
  // re-slugt Überschriften, Query-Varianten, n-tv-Ticker-Formen). Die articles-Zeile entsteht
  // unter der KANONISCHEN URL — die entdeckte pages-Zeile bekäme nie einen Titel, stünde im
  // Dashboard ewig auf „wird erfasst…" und bliebe im Render-Pool (jeder Lauf ein Render umsonst).
  // page_overview ist pages-getrieben (pages LEFT JOIN articles ON url) → die kanonische Seite
  // MUSS es geben, sonst verschwindet der Artikel aus der Übersicht.
  if (!DRY_RUN && discoveredUrl !== url) {
    await sb.from("pages").upsert(
      { source_id: sourceId, url, kind: "article", depth: 1, last_seen: new Date().toISOString() },
      { onConflict: "url", ignoreDuplicates: true });
    await sb.from("pages").update({ kind: "alias" }).eq("url", discoveredUrl);
  }
  await upsertDimensions(id, meta.authors, meta.keywords, meta.categories);
  const tb = trackBody(html, url, rawHtml, art, meta.article_type === "liveblog", meta.title ?? art?.title ?? null, meta.description ?? null);
  if (tb) await trackChanges(id, (prev as PrevState) ?? null, meta.title ?? art?.title ?? null, tb.body, url, tb.isLive, (prev as any)?.published_at ?? null, pubTrack, { description: meta.description, og_image: meta.og_image, paywalled: meta.paywalled, author_status: meta.author_status, topic: meta.topic });
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
async function renderPage(ctx: BrowserContext, url: string, expand = false): Promise<{ status: number; html: string | null; rawHtml: string | null }> {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const status = resp?.status() ?? 0;
    // ROH-HTML (vor JavaScript) aus der Navigations-Response greifen — KEIN zusätzlicher Request.
    // Das ist der server-gelieferte Artikeltext: deterministisch über Renders UND frei von den
    // JS-injizierten Werbe-/Streaming-/Empfehlungs-Widgets, die Readability sonst aus dem
    // gerenderten DOM zieht (Hauptquelle der Oszillations-Phantome). Body-Tracking bevorzugt das.
    let rawHtml: string | null = null;
    try { rawHtml = resp ? await resp.text() : null; } catch { rawHtml = null; }
    // Nur erkannte Liveblogs/Timelines vollständig nachladen (autoScroll + Button-Expansion).
    // Normale Artikel haben den Volltext schon im Erst-Render → kein Scroll nötig; und der
    // Liveblog-Ticker kommt ohnehin aus JSON-LD (serverseitig, scroll-unabhängig). autoScroll
    // auf JEDEM Render war der Haupt-Laufzeit-Regress (10 → 25 min) → hier gezielt gegated.
    if (expand) {
      await autoScroll(page, 4500);
      await expandTimeline(page, 6);
    }
    const html = await page.content();
    return { status, html, rawHtml };
  } catch {
    return { status: 0, html: null, rawHtml: null };
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
  // NEUESTE Sitemaps zuerst — echte Recency-Sortierung statt nur „matcht ein Muster ja/nein".
  // Die alte Binär-Variante ließ z.B. Spiegels Index (alle Kinder matchen `\d{4}`) in Index-
  // reihenfolge = ÄLTESTE zuerst (sitemap-1957…) → Budget verbrannte sich an Uralt-Archiven.
  // Jetzt: News-Sitemaps ganz nach vorn, sonst nach Jahr(-Monat) aus dem Dateinamen absteigend.
  const recencyScore = (u: string) => {
    if (/(news|aktuell|recent)/i.test(u)) return Number.MAX_SAFE_INTEGER;
    const m = u.match(/(\d{4})[-_/]?(\d{2})?/);
    return m ? Number(m[1]) * 100 + Number(m[2] ?? 0) : 0;
  };
  const recentFirst = (urls: string[]) => [...urls].sort((a, b) => recencyScore(b) - recencyScore(a));

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
      // classifyUrl statt nur looksLikeArticle: News-Sitemaps führen auch Advertorials/
      // Shopping-Deals — die dürfen keine Stubs/Datumszeilen mehr erzeugen (kind-Gates).
      if (u.startsWith(origin) && classifyUrl(u) === "article") arts.add(u);
    }
    // Pro <url>-Block die Veröffentlichungszeit ziehen (publication_date > lastmod).
    for (const block of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
      const inner = block[1];
      const loc = /<loc>\s*([^<]+?)\s*<\/loc>/i.exec(inner)?.[1];
      if (!loc) continue;
      const u = stripHash(loc.trim());
      if (!(u.startsWith(origin) && classifyUrl(u) === "article")) continue; // Werbe-URLs: keine Datums-Stubs
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
        const batch = list.slice(i, i + 200).map((url) => canonUrl(url));
        await sb.from("pages").upsert(
          batch.map((url) => ({ source_id: src.id, url, kind: "article", depth: 1 })),
          { onConflict: "url", ignoreDuplicates: true },
        );
        // Link-Sichtung protokollieren: pages.last_seen = „zuletzt verlinkt/gelistet gesehen".
        // ignoreDuplicates überspringt Bekanntes komplett — ohne diesen Bump wüsste niemand,
        // dass ein alter Artikel noch geführt wird (Basis der Re-Scan-Stufe „noch verlinkt").
        await sb.from("pages").update({ last_seen: new Date().toISOString() }).in("url", batch);
        recordSightings(src.id, batch);
      }
    } catch (e) { console.error("SITEMAP-FEHLER:", src.base_url, (e as Error).message); }
  }
  // Präzise Veröffentlichungszeiten aus der Sitemap vorab in `articles` einpflegen
  // ({source_id,url,published_at} — Rest nullable). So hat z.B. Le Monde (Render → 402)
  // die EXAKTE Zeit statt nur den URL-Mittags-Notnagel. publication_date ist autoritativ,
  // darf ein VORHANDENES Datum aber nur nach FRÜHER verfeinern (Freeze — Verlage bumpen
  // Timelines/Podcasts/Deals täglich auf „heute"); lastmod (= Änderungszeit) nur füllen,
  // nie überschreiben. freezePubDate in saveArticleFull/enrich schützt den Wert beim Render.
  const dated = list.filter((u) => pubDates.has(u));
  if (dated.length && !DRY_RUN) {
    // (1) NEUE Stubs anlegen — MIT provisorischem Ressort aus der URL. Sonst hätten
    //     noch-nicht-gerenderte Artikel topic=NULL und verfälschen die Themen-/Agenda-Verteilung
    //     (leere Kategorie). `ignoreDuplicates` = DO NOTHING → bestehende (gerenderte) Zeilen und
    //     ihr Topic bleiben unangetastet. Der Render verfeinert das Topic später (og:url/Breadcrumb).
    const insertStubs = async (urls: string[]) => {
      for (let i = 0; i < urls.length; i += 200) {
        await sb.from("articles").upsert(
          urls.slice(i, i + 200).map((url) => ({ source_id: src.id, url: canonUrl(url), published_at: pubDates.get(url)!.at, topic: topicOf([], url) })),
          { onConflict: "url", ignoreDuplicates: true },
        );
      }
    };
    // (2) Präzises Datum auf bestehende Zeilen ANWENDEN — published_at ist eingefroren: die RPC
    //     verfeinert nur nach FRÜHER (LEAST; präzisiert z.B. den Mittags-Notnagel). Ein NEUERES
    //     Sitemap-Datum ist ein Verlags-Bump und landet in modified_at — vorher überschrieb dieser
    //     Pfad das Original bei JEDEM Lauf (Haupt-Bumper: Artikel erschienen täglich als „neu").
    const refineDates = async (urls: string[]) => {
      for (let i = 0; i < urls.length; i += 200) {
        const { error } = await sb.rpc("apply_sitemap_dates", {
          p: urls.slice(i, i + 200).map((url) => ({ url: canonUrl(url), at: pubDates.get(url)!.at })),
        });
        if (error) console.error("SITEMAP-DATUM-RPC-FEHLER:", src.base_url, error.message);
      }
    };
    try {
      await insertStubs(dated);                                          // neue Stubs: URL-Topic + Datum
      await refineDates(dated.filter((u) => pubDates.get(u)!.precise));  // publication_date → LEAST bzw. modified_at
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
  // Artikel-Signal: lange Zahl-ID, Datumspfad /YYYY/MM/DD/ oder Slug-NNN.html …
  // … ODER eine HEX-Artikel-ID. WICHTIG (sonst „gleiche Exposition" verletzt): Spiegel
  // (`slug-a-<UUID>`) und Bild (`slug-<24-Hex>`) tragen KEINE Zahl-ID — sie wurden bisher nur
  // dann als Artikel erkannt, wenn die Hex-ID ZUFÄLLIG 5+ aufeinanderfolgende Ziffern enthielt;
  // sonst fielen sie als „unknown" aus dem Render-Pool (≈3.200 Spiegel- + ≈4.000 Bild-Artikel).
  return /\d{5,}/.test(u) || /\/\d{4}\/\d{2}\/\d{2}\//.test(u) || /-\d+\.html?$/.test(u)
    || /-a-[0-9a-f]{8}-[0-9a-f]{4}-/i.test(u)              // Spiegel: …-a-<UUID>
    || /-[0-9a-f]{24}(?:\.html?)?(?:$|[?#])/i.test(u);     // Bild: …-<24-Hex-ID>
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
  // Werbung/Commerce: nur als eigenes Rubrik-Segment oder Query-Param (nicht "bewerbung"/
  // "umwerbung", und NIE der Slug — "anzeige-gegen-politiker" ist echte News). User-Entscheid
  // 07.07.: Werbe-/Deals-/Gewinnspiel-Inhalte gar nicht erst erfassen. Verlags-Vertikale:
  // n-tv shopping-und-service, FAZ kaufkompass, Bild brandstory/productstory/kaufberater,
  // Gewinnspiel-Aktionen (Segment-Substring fängt "bildplus-gewinnspiele-aktionen").
  if (SEC(sections, /^(anzeige[n]?|sponsored|advertorials?|werbe[a-z-]*|promotion|adv|partner-?content|brandstory|productstory|shopping-und-service|kaufkompass|kaufberater[a-z-]*|[a-z-]*gewinnspiel[a-z-]*)$/) ||
      /[?&](sponsored|advertorial|anzeige)=/.test(u)) return "sponsored";
  // Host-spezifisch: Bilds /service/ + /sonstiges/ sind durchgehend Affiliate/Eigenwerbung
  // (Kaufberater-Deals, Brandstorys, Abo-/Gewinnspiel-Aktionen, Corporate); Spiegels /tests/
  // ist das Affiliate-Produkttest-Vertical. NICHT global sperren: Bild /auto/tests/ und
  // n-tv /ratgeber/tests/ sind redaktionelle Tests bzw. Hubs.
  if (/bild\.de\/(service|sonstiges)\//.test(u) || /spiegel\.de\/tests\//.test(u)) return "sponsored";
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
// Index-/Übersichts-Form: Pfad endet auf „/" (Startseite, Rubrik-Wurzel, Kategorieseite).
// Solche Seiten tragen oft das JSON-LD/og:type ihres TOP-ARTIKELS — das Signal allein darf
// sie deshalb NIE zum Artikel machen: faz.net selbst + ~100 FAZ-Sektionsseiten liefen so als
// „Artikel" mit der rotierenden Schlagzeilenliste als Body (319 Phantom-Edits; 06.07.
// bereinigt, 109 Zeilen). looksLikeArticle lehnt diese Form längst ab — der signal-Zweig
// unten umging das.
function isIndexUrl(url: string): boolean {
  try { return /\/$/.test(new URL(url).pathname); } catch { return true; }
}
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
  // Paywall-Teaser/Block: trotzdem Artikel, wenn JSON-LD oder Datums-URL es ausweist (Metadaten
  // via extractMeta) — außer die URL hat Index-Form (s. isIndexUrl: Signal stammt vom Top-Artikel).
  if (!isIndexUrl(url) && (signal || strongUrl)) return { kind: "article", article: null };
  return { kind: "section", article: null };
}

// === Knoten/Kanten-Persistenz (der Baum) ===
const pageId = new Map<string, number>(); // url -> pages.id (laufzeitweiter Cache)

// Entdeckte Links als Knoten anlegen (nur neu; bestehende Klassifikation NICHT überschreiben).
// ZUSÄTZLICH jede Artikel-Link-SICHTUNG protokollieren: pages.last_seen = „zuletzt verlinkt
// gesehen". Vorher wurden bekannte URLs komplett übersprungen — niemand wusste, dass ein
// alter Artikel noch auf Startseite/Ressorts steht, und hinter dem RESCAN_DAYS-Horizont
// fiel er FÜR IMMER aus der Beobachtung (Art. 207366: 12 Tage ungescannt trotz
// Startseiten-Platzierung). Der Bump ist die Basis der Re-Scan-Stufe „noch verlinkt".
const bumpedThisRun = new Set<string>();

// === Sichtungs-Protokoll (Minuten-Aggregat) ===
// Jede Artikel-Link-/Listungs-Sichtung zählt EINMAL pro Lauf, minutengenau — Grundlage
// der „Zuletzt gesehen"-Achse im Dashboard: echte Crawl-Ereignisse (Rampe während des
// Laufs, Plateau dazwischen). pages.last_seen allein reicht nicht — jeder neue Lauf
// überschreibt es und frühere Sichtungen des Tages gehen verloren.
const sightingSeen = new Set<string>();
const sightingAgg = new Map<number, Map<string, number>>();
function recordSightings(sourceId: number, urls: string[]) {
  const minute = new Date(); minute.setSeconds(0, 0);
  const k = minute.toISOString();
  let m = sightingAgg.get(sourceId);
  if (!m) { m = new Map(); sightingAgg.set(sourceId, m); }
  let n = 0;
  for (const u of urls) { if (!sightingSeen.has(u)) { sightingSeen.add(u); n++; } }
  if (n) m.set(k, (m.get(k) ?? 0) + n);
}
async function flushSightings() {
  const rows: { source_id: number; minute: string; n: number }[] = [];
  for (const [sid, m] of sightingAgg) for (const [minute, n] of m) rows.push({ source_id: sid, minute, n });
  sightingAgg.clear();
  if (!rows.length || DRY_RUN) return;
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await sb.from("sightings").insert(rows.slice(i, i + 200));
    if (error) { console.error("SIGHTINGS-FEHLER:", error.message); return; }
  }
  // Retention im selben Zug: älter als 35 Tage raus (Korpus-Horizont).
  await sb.from("sightings").delete().lt("minute", new Date(Date.now() - 35 * 864e5).toISOString());
  console.log(`Sichtungen protokolliert: ${rows.length} Minuten-Zeilen.`);
}

async function ensureNodes(sourceId: number, urls: string[], depth: number) {
  const all = [...new Set(urls.map(canonUrl))];
  const fresh = all.filter((u) => !pageId.has(u));
  if (fresh.length) {
    const rows = fresh.map((url) => ({ source_id: sourceId, url, kind: classifyUrl(url), depth }));
    await sb.from("pages").upsert(rows, { onConflict: "url", ignoreDuplicates: true });
    for (let i = 0; i < fresh.length; i += 200) {
      const { data } = await sb.from("pages").select("id,url").in("url", fresh.slice(i, i + 200));
      for (const p of data ?? []) pageId.set(p.url, p.id);
    }
  }
  // Nur Artikel-Links, je Lauf einmal (Navigation/Hubs stehen auf jeder Seite → sparen).
  const artLinks = all.filter((u) => classifyUrl(u) === "article");
  recordSightings(sourceId, artLinks);
  const toBump = artLinks.filter((u) => !bumpedThisRun.has(u));
  for (const u of toBump) bumpedThisRun.add(u);
  for (let i = 0; i < toBump.length; i += 200) {
    await sb.from("pages").update({ last_seen: new Date().toISOString() }).in("url", toBump.slice(i, i + 200));
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

// Begrenzte Parallelität + kleine Pause je Task — WAF-freundlich (kein Request-Burst).
async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i]); await sleep(120); }
  }));
  return out;
}

// UNIFORME, kuratierungsfreie Feed-Entdeckung für JEDEN Verlag: Startseite + Hauptsektionen
// anfahren und ALLE deklarierten <link rel="alternate"> RSS/Atom-Feeds ernten. Hintergrund: die
// Verlage exponieren Artikel sehr unterschiedlich (Sitemap/Feed/Crawl). Tagesschau & Spiegel
// deklarieren JE SEKTION einen eigenen Feed (`/inland/…rss2.xml`, `/sport/index.rss`) → so bekommt
// jeder Verlag dieselbe breite Sektions-Abdeckung, die bisher nur FAZ/n-tv kuratiert (KNOWN_FEEDS)
// hatten — ohne Kuratierung, ohne Qualitätsverlust. KNOWN_FEEDS bleibt als Sicherungs-Supplement.
//
// ⚠️ WAF-LEHRE (02.–04.07.26): das Proben von ~140 Kandidaten als PARALLEL-BURST in JEDEM
// stündlichen Lauf hat die Bot-Erkennung von FAZ (Block ab 02.07. 10:11) und Bild (ab 04.07.
// 15:12) getriggert → ALLE Plain-HTTP-Fetches (Feeds, Sitemaps, Sektionsseiten) liefen ins
// Leere, Discovery = 0 neue Artikel. Darum jetzt: (1) Ergebnis-CACHE in sources.feeds
// (jsonb) + feeds_checked_at — Feed-Layouts ändern sich selten, Neu-Proben nur alle 7 Tage;
// (2) Probes GEDROSSELT (conc 4 + Pause) statt 140 parallel; (3) bei Fetch-Blockade den
// alten Cache NIE mit leerem Ergebnis überschreiben (sonst 7 Tage Discovery-Loch nach Unblock).
const FEEDS_TTL_MS = 7 * 864e5;
async function discoverFeeds(src: Source): Promise<string[]> {
  let origin = ""; try { origin = new URL(src.base_url).origin; } catch { return []; }
  const { data: srow } = await sb.from("sources").select("feeds,feeds_checked_at").eq("id", src.id).maybeSingle();
  const cached: string[] = Array.isArray((srow as any)?.feeds) ? ((srow as any).feeds as string[]) : [];
  const checkedAt = (srow as any)?.feeds_checked_at ? Date.parse((srow as any).feeds_checked_at) : 0;
  if (cached.length && Date.now() - checkedAt < FEEDS_TTL_MS) return cached;

  const feeds = new Set<string>();
  const home = await fetchHtml(src.base_url);
  if (!home) return cached; // Startseite nicht lesbar (Block/Ausfall) → alten Stand nutzen, Cache unangetastet
  for (const f of extractFeedLinks(home, src.base_url)) feeds.add(f);
  // Top-Sektionen aus der Startseite (gleiche Domain, kurzer Pfad, kein Artikel). Nach GANZER
  // Rubrik (1–2 Segmente) keyen, nicht nur nach dem 1. Segment — sonst fiele bei Verlagen mit
  // /<basis>/<ressort>/-Struktur (FAZ: /aktuell/politik/) alles bis auf EINE Rubrik weg.
  const secs = new Map<string, string>();
  for (const link of sameDomainLinks(home, src.base_url, src.base_url)) {
    try {
      const segs = new URL(link).pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      if (segs.length < 1 || segs.length > 2 || classifyUrl(link) === "article") continue;
      const key = segs.join("/");
      if (!secs.has(key)) secs.set(key, `${origin}/${key}/`);
    } catch {}
  }
  const secList = [...secs].slice(0, 30);
  // a) Deklarierte <link rel=alternate>-Feeds der Sektionsseiten ernten (gedrosselt, kein Burst).
  const found = await mapLimited(secList, 4, async ([, u]) => {
    const html = await fetchHtml(u);
    return html ? extractFeedLinks(html, u) : [];
  });
  for (const fs of found) for (const f of fs) feeds.add(f);
  // b) GENERISCH gängige Sektions-Feed-Konventionen probieren (kuratierungsfrei, ersetzt die
  //    verlagsspezifischen KNOWN_FEEDS → gleiche Behandlung aller Verlage): n-tv `<ressort>/rss`,
  //    Spiegel `<ressort>/index.rss`, Tagesschau `<ressort>/index~rss2.xml`, FAZ `/rss/<ressort>/`.
  //    Nur Kandidaten übernehmen, die wirklich ein RSS/Atom-Feed zurückgeben.
  //    WICHTIG: NEBEN den Homepage-Sektionen auch eine feste Ressort-Liste probieren — manche
  //    Ressorts sind NICHT von der Startseite verlinkt (Tagesschau verlinkt „Sport" auf sportschau.de
  //    → /sport/ wurde nie als Sektion erkannt → /sport/index~rss2.xml nie geprobt → Sport-Lücke).
  //    Existiert der Feed nicht, kostet der Probe-404 nur einen billigen Fetch.
  const STANDARD_SECTIONS = ["sport", "politik", "wirtschaft", "wissen", "wissenschaft", "kultur", "panorama", "gesellschaft", "inland", "ausland", "digital", "netzwelt", "technik", "gesundheit", "reise", "auto", "meinung", "finanzen", "feuilleton"];
  // Standard-Ressorts ZUERST (damit sie sicher im Probe-Budget landen), dann die Homepage-Sektionen.
  const secForFeeds = new Map<string, string>();
  for (const key of STANDARD_SECTIONS) secForFeeds.set(key, `${origin}/${key}/`);
  for (const [k, v] of secs) if (!secForFeeds.has(k)) secForFeeds.set(k, v);
  const cand = new Set<string>();
  for (const [key, u] of secForFeeds) { cand.add(`${u}rss`); cand.add(`${u}index.rss`); cand.add(`${u}index~rss2.xml`); cand.add(`${origin}/rss/${key}/`); }
  for (const f of feeds) cand.delete(f); // schon bekannt → nicht erneut anfassen
  const probed = await mapLimited([...cand].slice(0, 140), 4, async (u) => {
    const xml = await fetchXml(u);
    return xml && /<(rss|feed)\b/i.test(xml) ? u : null;
  });
  for (const u of probed) if (u) feeds.add(u);

  const result = [...feeds];
  // Cache pflegen: nur mit substanziellem Ergebnis überschreiben; lieferte der (teil-blockierte)
  // Lauf nichts, alten Stand behalten und nur den Zeitstempel setzen (kein stündliches Re-Proben).
  if (!DRY_RUN) {
    if (result.length) await sb.from("sources").update({ feeds: result, feeds_checked_at: new Date().toISOString() }).eq("id", src.id);
    else await sb.from("sources").update({ feeds_checked_at: new Date().toISOString() }).eq("id", src.id);
  }
  return result.length ? result : cached;
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
  // UNIFORM für ALLE Verlage: Feeds generisch aus Startseite + Hauptsektionen ernten
  // (kuratierungsfrei, deckt Sektions-Feeds ab). Ersetzt die Abhängigkeit vom Einzel-Mechanismus.
  for (const f of await discoverFeeds(src)) enqueue({ url: f, depth: 0, feed: true }, false);
  // Kuratierte Zusatz-Feeds (FAZ/n-tv-Ressorts) bleiben als SICHERUNG, wo Sektionsseiten keinen
  // eigenen Feed deklarieren (z.B. FAZ-Ressort-Feeds) — kein Qualitätsverlust, nur redundant.
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
            const batch = arts.slice(i, i + 200).map((url) => canonUrl(url));
            await sb.from("pages").upsert(
              batch.map((url) => ({ source_id: src.id, url, kind: "article", depth })),
              { onConflict: "url", ignoreDuplicates: true },
            );
            // Link-Sichtung protokollieren (s. ensureNodes): Feed führt den Artikel noch.
            await sb.from("pages").update({ last_seen: new Date().toISOString() }).in("url", batch);
            recordSightings(src.id, batch);
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
    let rawHtml: string | null = null; // Server-HTML vor JS (fürs deterministische Body-Tracking)
    let didRender = false;
    let renderStatus = 0; // HTTP-Status des Renders (0 = nicht gerendert/HTTP-Fetch) → Fehlerseiten-Filter
    if (predicted === "article" || live) {
      // Discovery-Modus (kein Browser) ODER Render-Budget weg → Artikel bleibt
      // als Knoten (existiert bereits via ensureNodes/Sitemap/Feed); analyze rendert.
      if (!RENDER || !ctx || renders >= MAX_PAGES) return;
      const rr = await renderPage(ctx, s.url, live);
      html = rr.html; rawHtml = rr.rawHtml; renderStatus = rr.status;
      if (html) { renders++; didRender = true; }
    } else {
      html = await fetchHtml(s.url);
      if (html) fetches++;
      // Notnagel: link-arme JS-Seite → einmal rendern (nur wenn Browser + Budget da).
      if (RENDER && ctx && (!html || (s.depth < MAX_DEPTH && sameDomainLinks(html, src.base_url, s.url).length < 5)) && renders < MAX_PAGES) {
        const rr = await renderPage(ctx, s.url);
        if (rr.html) { html = rr.html; rawHtml = rr.rawHtml; renderStatus = rr.status; renders++; didRender = true; }
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
        await upsertRenderedNode(src.id, s.url, kind, s.depth);
        // NUR die Knoten (pages) anlegen — die Kanten-Tabelle page_links wird NICHT mehr befüllt:
        // sie war write-only Ballast (nirgends gelesen) und der mit Abstand schnellste DB-Größen-
        // Treiber (≈872k Zeilen / ~100 MB bei stündlichem Lauf) → frisst das 500-MB-Free-Limit.
        if (links.length) await ensureNodes(src.id, links, s.depth + 1);
        // Artikel nur speichern, wenn WIRKLICH gerendert (sonst rendert analyze
        // ihn sauber nach — kein Speichern aus link-armem Roh-HTML).
        if (kind === "article" && article && didRender && MODE !== "structure") {
          await saveArticleFull(src.id, s.url, html, rawHtml);
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

  // 1) OFFENE Artikel-Knoten laden = entdeckte pages.kind='article', die noch NICHT
  // gerendert sind (kein articles-Eintrag mit gesetztem title). Reine Sitemap-Vorab-
  // Zeilen (title=null, nur published_at aus harvestSitemaps) gelten als offen → werden
  // weiterhin gerendert.
  // Früher zog dieser Schritt die KOMPLETTE pages- UND articles-Liste (~je 30k Zeilen,
  // ~5 MB) und verglich clientseitig — der mit Abstand größte Supabase-Egress-Posten
  // (stündlich). Jetzt erledigt ein Server-seitiger Anti-Join (RPC open_article_pages)
  // den Abgleich; übertragen wird nur der tatsächlich offene Rest (typ. wenige hundert).
  // WICHTIG: Re-Scans (stille Edits) hängen NICHT hier dran — sie laufen über den eigenen
  // altersgestaffelten Block weiter unten direkt gegen `articles` und sind unberührt.
  // NEUESTE zuerst (id desc): die jüngsten Funde werden priorisiert gerendert.
  const open = await fetchAll<{ id: number; url: string; source_id: number }>((from) =>
    sb.rpc("open_article_pages", { src_ids: activeIds }).order("id", { ascending: false })
  );

  // Budget GEWICHTET nach offenem Rückstand verteilen (gleiche AUSBEUTE statt nur gleiches
  // Budget): jede Quelle bekommt einen Sockel (FLOOR, deckt die laufende Aufnahme), der Rest
  // proportional zum Rückstand → unter-exponierte Quellen mit großem unknown→article-Rückstand
  // (Spiegel/Bild) holen auf, ohne die frischen Artikel der anderen zu verhungern. Das NEU-Budget
  // wird auf (MAX_PAGES − Re-Scan-Anteil) gedeckelt, damit die Re-Scan-Reserve (stille Edits)
  // garantiert bleibt — auch bei riesigem Rückstand.
  const rescanShare0 = Number(process.env.CRAWL_RESCAN_SHARE ?? 0.2);
  const newBudget = Math.max(activeIds.length, MAX_PAGES - Math.ceil(MAX_PAGES * rescanShare0));
  const openCount = new Map<number, number>();
  for (const p of open) openCount.set(p.source_id, (openCount.get(p.source_id) ?? 0) + 1);
  const floorPer = Math.max(20, Math.floor(newBudget / (activeIds.length * 3)));
  const cap = new Map<number, number>();
  let assigned = 0;
  for (const sid of activeIds) { const f = Math.min(openCount.get(sid) ?? 0, floorPer); cap.set(sid, f); assigned += f; }
  const moreOf = (sid: number) => Math.max(0, (openCount.get(sid) ?? 0) - (cap.get(sid) ?? 0));
  const totalMore = activeIds.reduce((s, sid) => s + moreOf(sid), 0) || 1;
  const rest = Math.max(0, newBudget - assigned);
  for (const sid of activeIds) cap.set(sid, (cap.get(sid) ?? 0) + Math.min(moreOf(sid), Math.floor(rest * moreOf(sid) / totalMore)));
  const bySrc = new Map<number, string[]>();
  for (const p of open) {
    const arr = bySrc.get(p.source_id) ?? bySrc.set(p.source_id, []).get(p.source_id)!;
    if (arr.length < (cap.get(p.source_id) ?? 0)) arr.push(p.url);
  }
  const batch = [...bySrc.values()].reduce((s, a) => s + a.length, 0);
  console.log(`Offen (nicht gerendert): ${open.length} | dieser Lauf: ${batch} (gewichtet, Sockel ${floorPer}/Quelle, NEU-Budget ${newBudget})`);

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
      // STUFE „NOCH VERLINKT" (altersUNabhängig): Artikel, die die Discovery kürzlich noch
      // verlinkt sah (pages.last_seen — Startseite/Ressorts/Feeds/Sitemap, s. ensureNodes),
      // deren letzter SCAN aber ≥24 h zurückliegt. Ohne diese Stufe fiel alles hinter dem
      // RESCAN_DAYS-Horizont FÜR IMMER aus der Beobachtung — auch was der Verlag weiter
      // prominent führt (Art. 207366: 12 Tage ungescannt trotz Startseiten-Platzierung;
      // Messung 06.07.: ~75 solcher Artikel allein auf den 5 Startseiten). Nebeneffekt:
      // schützt lebendige Artikel vor der 30-Tage-Retention (löscht nach articles.last_seen).
      // Kadenz 1×/Tag genügt — das heiße Edit-Fenster decken die Alters-Stufen ab.
      if (remaining > 0) {
        const { data, error } = await sb.rpc("linked_stale_articles", {
          src_ids: activeIds,
          seen_since: new Date(now - 26 * H).toISOString(),
          due_before: new Date(now - 24 * H).toISOString(),
          lim: remaining + 100,
        });
        if (error) console.error("RE-SCAN-VERLINKT-FEHLER:", error.message);
        for (const r of (data ?? []) as any[]) {
          if (remaining <= 0) break;
          if (!inQueue.has(r.url)) { queue.push({ url: r.url, sid: r.source_id }); inQueue.add(r.url); remaining--; }
        }
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
    for (const p of open) { // bereits id-desc (neueste zuerst), enthält nur offene Knoten
      if (queue.length >= MAX_PAGES) break;
      if (inQ.has(p.url)) continue;
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
          const { status, html, rawHtml } = await renderPage(ctx, item.url, isLiveContent(item.url, null));
          if (html) {
            // Selbst-Korrektur: stellt sich eine entdeckte „Artikel"-URL als Fehlerseite/Hub/Video
            // heraus, nicht als Artikel führen. Fehlerseiten (404/410/5xx, Soft-404) zuerst prüfen:
            // sie sehen wie Artikel aus (Titel/Body da), liefern aber HTTP-Fehler → kein Speichern,
            // Knoten als 'error' markieren → fällt aus dem Render-Pool (kein erneutes Re-Scannen).
            if (isErrorPage(status, html)) { await sb.from("pages").update({ kind: "error" }).eq("url", item.url); }
            else {
              const cls = classifyRendered(item.url, html);
              if (cls.kind === "article") { await saveArticleFull(item.sid, item.url, html, rawHtml); ok++; }
              else {
                await sb.from("pages").update({ kind: cls.kind }).eq("url", item.url);
                // Ent-Artikelisierung: eine evtl. schon angelegte articles-Zeile mit-löschen
                // (sonst bleibt ein Phantom-Edit-Sammler stehen — die FAZ-Hubs überlebten so
                // ihre Demotion; enrich löscht längst). FK-CASCADE räumt den Anhang ab.
                await sb.from("articles").delete().eq("url", item.url);
              }
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
        const { html, rawHtml } = await renderPage(ctx, item.url, isLiveContent(item.url, null));
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
        // Werbe-/Commerce-Guard (wie saveArticleFull): auch og:url/canonical-Rubrik prüfen
        // (n-tv idN.html trägt die Sektion nicht in der gespeicherten URL).
        if ([item.url, meta.rubric].some((c) => c && classifyUrl(c) === "sponsored")) {
          await sb.from("pages").update({ kind: "sponsored" }).eq("url", item.url);
          await sb.from("articles").delete().eq("id", item.id);
          continue;
        }
        try {
          // Vorzustand für Tracking lesen, dann Metadaten aktualisieren.
          const { data: prev } = await sb.from("articles")
            .select(PREV_COLS)
            .eq("id", item.id).maybeSingle();
          meta.paywalled = stickyPaywall((prev as any)?.paywalled, meta.paywalled); // Paywall nie fälschlich aufheben
          // Recency-Filter (wie saveArticleFull, frischestes Datum + kein Liveblog): noch nicht
          // verfolgte Alt-Artikel raus → Archiv parken.
          if (neverObservedChange(prev) && isStaleForArchive(meta, (prev as any)?.published_at, item.url)) {
            await sb.from("pages").update({ kind: "archive" }).eq("url", item.url);
            await sb.from("articles").delete().eq("id", item.id);
            continue;
          }
          const pubTrack = freezePubDate(meta, prev as any); // published_at einfrieren (wie saveArticleFull)
          const { authors, keywords, categories, published_precise, ...fields } = meta;
          void published_precise;
          await sb.from("articles").update({ ...fields, last_seen: new Date().toISOString(), scan_count: ((prev as any)?.scan_count ?? 0) + 1, scan_times: appendScan((prev as any)?.scan_times) }).eq("id", item.id);
          await upsertDimensions(item.id, authors, keywords, categories);
          const tb = trackBody(html, item.url, rawHtml, art, meta.article_type === "liveblog", meta.title ?? art?.title ?? null, meta.description ?? null);
          if (tb) await trackChanges(item.id, (prev as PrevState) ?? null, meta.title ?? art?.title ?? null, tb.body, item.url, tb.isLive, (prev as any)?.published_at ?? null, pubTrack, { description: meta.description, og_image: meta.og_image, paywalled: meta.paywalled, author_status: meta.author_status, topic: meta.topic });
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
    // Sichtungs-Aggregate IMMER schreiben — auch bei Teilabbruch (Zeitbudget) sind die
    // bereits gezählten Minuten korrekt.
    await flushSightings();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
