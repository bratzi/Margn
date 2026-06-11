import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chromium, type BrowserContext } from "playwright";
import { createHash } from "node:crypto";
import { sb } from "./lib";
import { topicOf } from "./topics";

// --- Crawl-Grenzen (per Env übersteuerbar; CI knapp, lokaler Tief-Crawl höher) ---
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES ?? 80);    // gerenderte Seiten pro Quelle
const MAX_DEPTH = Number(process.env.CRAWL_MAX_DEPTH ?? 2);     // Linktiefe ab Startseite
const DELAY_MS = Number(process.env.CRAWL_DELAY_MS ?? 100);     // Höflichkeitspause (kein Embed mehr → kürzer)
const CONCURRENCY = Number(process.env.CRAWL_CONCURRENCY ?? 4); // parallele Browser-Tabs
const MIN_BODY = 1200;                                       // viel Fließtext = echter Artikel (Hubs haben wenig)
const DRY_RUN = process.env.CRAWL_DRY_RUN === "1";           // nur zählen, kein DB-Write
// "articles":   crawlen + Artikel speichern (Metadaten).
// "structure":  Rubriken crawlen, Links klassifizieren.
// "analyze":    batch-upsert pages.kind='article' → articles (kein Chromium).
// "enrich":     articles ohne Titel rendern + Metadaten nachtragen.
// "reclassify": pages.kind='article' rendern, Videos → kind='media' + aus articles entfernen.
const MODE = (process.env.CRAWL_MODE ?? "articles") as "articles" | "structure" | "analyze" | "enrich" | "reclassify";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stripHash = (u: string) => u.split("#")[0];

// Stumme Konsole: schluckt jsdom-CSS-Parsefehler (z.B. FAZ-Tailwind), die sonst crashen.
const silentVC = new VirtualConsole();
const makeDom = (html: string, url: string) => new JSDOM(html, { url, virtualConsole: silentVC });

type Source = { id: number; base_url: string; language: string | null };
type Seed = { url: string; depth: number };

// embed() DEAKTIVIERT – reaktivieren wenn Cluster-Feature wieder aufgenommen wird.

async function upsertArticle(sourceId: number, url: string, meta?: ReturnType<typeof extractMeta>, extra?: Record<string, unknown>): Promise<number> {
  const row: Record<string, unknown> = { source_id: sourceId, url, last_seen: new Date().toISOString() };
  if (meta) {
    const { authors, keywords, categories, ...rest } = meta;
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

// EINDEUTIGE Liveblog-Erkennung aus URL/Titel (präzise, wenig Falschtreffer).
// Bewusst NICHT erkannt: Rubriken/Tagesformate (n-tv "der_tag", "Transfer-Ticker" = Einzelmeldungen,
// Spiegel "News des Tages"). Echte, über Zeit wachsende Artikel werden empirisch über
// extension_count>=2 → 'timeline' erkannt (siehe trackChanges), unabhängig vom URL-Muster.
function isLiveContent(url: string, title: string | null): boolean {
  const hay = (url + " " + (title ?? "")).toLowerCase();
  if (/news?ticker\/.*alle-[a-z-]+-news/.test(hay)) return false; // Bild News-Hubs
  return /liveblog|live-blog|live-ticker|liveticker|newsblog|en-direct|im[- ]minutentakt/.test(hay)
    || /\/live\//.test(hay); // Le Monde: /…/live/…
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

  const published_at =
    metaContent(html, "article:published_time") ??
    article.datePublished ?? null;

  const modified_at =
    metaContent(html, "article:modified_time") ??
    article.dateModified ?? null;

  // Paywall: JSON-LD isAccessibleForFree ist maßgeblich (verlässlich pro Artikel).
  // CSS-Pattern NUR als Fallback, wenn KEIN JSON-LD-Signal existiert – sonst markiert
  // das seitenweit geladene Paywall-Framework (z.B. "paywall"/"piano-") jeden freien Artikel.
  const iaff = ld.map((d) => d.isAccessibleForFree).filter((v) => v !== undefined && v !== null);
  const isFree = (v: any) => v === true || v === "True" || v === "true";
  const notFree = (v: any) => v === false || v === "False" || v === "false";
  const paywalled = iaff.length > 0
    ? iaff.some(notFree) && !iaff.some(isFree)
    : PAYWALL_CSS.test(html);

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

  // Keywords (JSON-LD keywords + meta news_keywords/keywords/article:tag)
  const kwRaw = article.keywords ?? metaContent(html, "news_keywords", "keywords", "article:tag") ?? "";
  const kwArr = Array.isArray(kwRaw) ? kwRaw : String(kwRaw).split(/[,;|]/);
  const keywords: string[] = kwArr
    .map((k: string) => String(k).trim().toLowerCase())
    .filter((k: string) => k.length > 1 && k.length < 60);

  // Kategorien
  const catRaw = article.articleSection ?? metaContent(html, "article:section") ?? "";
  const categories: string[] = (typeof catRaw === "string" ? catRaw.split(/[,;|]/) : catRaw)
    .map((c: string) => c.trim()).filter((c: string) => c.length > 1 && c.length < 80);

  const author_status = classifyAuthorStatus(authorList);
  const topic = topicOf(categories, url);

  return { title, description, og_image, published_at, modified_at, paywalled, article_type, word_count, reading_min, lang_detected, author_status, topic, authors: authorList, keywords, categories };
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

type PrevState = { title: string | null; content_hash: string | null; para_fps: string | null; body_words: number | null; extension_count: number | null; edit_count: number | null; revision_count: number | null; article_type: string | null } | null;

// Vergleicht neuen Inhalt mit dem letzten Stand und schreibt bei echter Änderung einen Snapshot.
// Unterscheidet "extension" (nur hinzugefügt = valide Erweiterung, z.B. Timeline-Artikel) von
// "edit" (entfernt/ersetzt = stille Änderung) und "mixed".
async function trackChanges(articleId: number, prev: PrevState, newTitle: string | null, body: string, isLiveblog: boolean) {
  const paras = normalizeParas(body);
  if (!paras.length) return;
  const fps = paras.map(fp);
  const contentHash = fp(fps.join("|"));
  const bodyWords = body.trim().split(/\s+/).length;

  // Erstkontakt: nur Baseline-Fingerprint + Absätze speichern, kein Snapshot.
  if (!prev || !prev.content_hash) {
    await sb.from("articles").update({
      content_hash: contentHash, para_fps: fps.join(","), body_words: bodyWords,
      ...(isLiveblog ? { article_type: "liveblog" } : {}),
    }).eq("id", articleId);
    await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
    return;
  }
  const titleChanged = !!prev.title && !!newTitle && decodeEntities(prev.title) !== decodeEntities(newTitle);
  if (prev.content_hash === contentHash && !titleChanged) return; // nichts geändert

  // Absatz-Diff
  const oldSet = new Set((prev.para_fps ?? "").split(",").filter(Boolean));
  const newSet = new Set(fps);
  const fpToText = new Map(paras.map((p, i) => [fps[i], p]));
  const addedFps = fps.filter((f) => !oldSet.has(f));
  const addedTexts = [...new Set(addedFps)].map((f) => fpToText.get(f)!).filter(Boolean);
  const removedCount = [...oldSet].filter((f) => !newSet.has(f)).length;

  // Nur reine Umsortierung (gleiche Absätze, andere Reihenfolge) → kein Snapshot.
  // Absätze sind durch normalizeParas bereits ≥60 Zeichen, daher zählt jeder echte Zugang.
  if (!titleChanged && addedFps.length === 0 && removedCount === 0) {
    await sb.from("articles").update({ content_hash: contentHash, para_fps: fps.join(","), body_words: bodyWords }).eq("id", articleId);
    await sb.from("article_paras").upsert({ article_id: articleId, paras: capParas(paras) }, { onConflict: "article_id" });
    return;
  }

  // Strukturierter Wort-Diff: geänderte Absätze (entfernt↔hinzugefügt) per Ähnlichkeit paaren.
  const { data: paraRow } = await sb.from("article_paras").select("paras").eq("article_id", articleId).maybeSingle();
  const oldParas: string[] = Array.isArray(paraRow?.paras) ? (paraRow!.paras as string[]) : [];
  const removedTexts = oldParas.filter((p) => !newSet.has(fp(p)));
  const changes = buildChanges(removedTexts, addedTexts);

  // Eindeutige Klassifikation (sich gegenseitig ausschließend):
  //  - Liveblog/Timeline: laufendes Wachstum → IMMER Erweiterung (kein "stiller Edit").
  //  - Sonst stille Titeländerung → Edit (das journalistisch interessante Signal).
  //  - Sonst Netto-Zuwachs (mehr hinzu als entfernt) → Erweiterung.
  //  - Sonst (Umschreiben/Kürzen) → Edit.
  const isTimeline = isLiveblog || prev.article_type === "timeline" || (prev.extension_count ?? 0) >= 2;
  let kind: "extension" | "edit";
  if (isTimeline) kind = "extension";
  else if (titleChanged) kind = "edit";
  else if (addedFps.length > removedCount) kind = "extension";
  else kind = "edit";

  await sb.from("article_snapshots").insert({
    article_id: articleId, change_kind: kind,
    title_old: titleChanged ? decodeEntities(prev.title!) : null,
    title_new: titleChanged ? decodeEntities(newTitle!) : null,
    added: addedTexts.join("\n\n").slice(0, 8000),
    added_count: addedFps.length, removed_count: removedCount,
    word_delta: bodyWords - (prev.body_words ?? bodyWords),
    changes,
  });

  const extCount = (prev.extension_count ?? 0) + (kind === "extension" ? 1 : 0);
  const editCount = (prev.edit_count ?? 0) + (kind === "edit" ? 1 : 0);
  // Kategorie "timeline": mehrfach erweitert (echter, über Tage wachsender Artikel)
  const newType = isLiveblog ? "liveblog" : (extCount >= 2 ? "timeline" : undefined);
  await sb.from("articles").update({
    content_hash: contentHash, para_fps: fps.join(","), title: newTitle, body_words: bodyWords,
    revision_count: (prev.revision_count ?? 0) + 1, extension_count: extCount, edit_count: editCount,
    ...(newType ? { article_type: newType } : {}),
  }).eq("id", articleId);
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
function buildChanges(removed: string[], added: string[]): Change[] {
  const rem = [...removed], usedR = new Set<number>();
  const out: Change[] = [];
  for (const a of added) {
    let best = -1, bestSim = 0;
    rem.forEach((r, i) => { if (usedR.has(i)) return; const s = similarity(a, r); if (s > bestSim) { bestSim = s; best = i; } });
    if (best >= 0 && bestSim >= 0.35) { usedR.add(best); out.push({ old: rem[best].slice(0, 1500), new: a.slice(0, 1500) }); }
    else out.push({ new: a.slice(0, 1500) });
  }
  rem.forEach((r, i) => { if (!usedR.has(i)) out.push({ old: r.slice(0, 1500) }); });
  return out.slice(0, 30);
}

// Artikel vollständig speichern: Metadaten + Dimensionen + Änderungs-Tracking.
async function saveArticleFull(sourceId: number, url: string, html: string) {
  const meta = extractMeta(html, url);
  const art = asArticle(html, url);
  // Vorzustand VOR dem Upsert lesen (sonst überschreibt upsertArticle den alten Titel).
  const { data: prev } = await sb.from("articles")
    .select("title,content_hash,para_fps,body_words,extension_count,edit_count,revision_count,article_type,scan_count,scan_times")
    .eq("url", url).maybeSingle();
  const id = await upsertArticle(sourceId, url, meta, { scan_count: ((prev as any)?.scan_count ?? 0) + 1, scan_times: appendScan((prev as any)?.scan_times) });
  await upsertDimensions(id, meta.authors, meta.keywords, meta.categories);
  if (art) await trackChanges(id, (prev as PrevState) ?? null, meta.title ?? art.title, art.body, meta.article_type === "liveblog");
  return id;
}

// "Mehr laden"-Buttons auf Timeline-/Liveblog-Seiten ausklicken, damit ÄLTERE Meldungen
// im DOM landen. Ohne das vergleicht das Änderungs-Tracking nur das sichtbare Fenster und
// meldet falsche "Entfernungen", wenn Meldungen aus dem Erstausschnitt rutschen.
// Verlagsübergreifende Textmuster (DE+FR); klickt bis nichts mehr wächst (max 12 Runden).
const LOAD_MORE_RX = /^(mehr laden|mehr anzeigen|weitere (beiträge|meldungen|artikel|einträge)( laden| anzeigen)?|(ältere|frühere) (beiträge|meldungen|einträge)( laden| anzeigen)?|alle (beiträge|meldungen) anzeigen|nachladen|mehr beiträge|weiterlesen|load more|show more|charger plus|voir plus|plus de messages|afficher plus|lire la suite du live)$/i;
async function expandTimeline(page: import("playwright").Page): Promise<void> {
  for (let round = 0; round < 12; round++) {
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

// Eine Seite im echten Browser rendern. Liefert HTTP-Status + gerendertes HTML.
// expand=true: Timeline-/Liveblog-Seite vorher vollständig ausklappen (ältere Meldungen nachladen).
async function renderPage(ctx: BrowserContext, url: string, expand = false): Promise<{ status: number; html: string | null }> {
  const page = await ctx.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const status = resp?.status() ?? 0;
    if (expand) await expandTimeline(page);
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

// === Klassifikation der Seiten (Knoten im Baum) ===
type Kind = "article" | "section" | "media" | "interactive" | "sponsored" | "service" | "unknown";

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

    const { html } = await renderPage(ctx, s.url, isLiveContent(s.url, null));
    if (!html) return;

    const links = s.depth < MAX_DEPTH ? sameDomainLinks(html, src.base_url, s.url) : [];
    const { kind, article } = classifyRendered(s.url, html);
    counts[kind] = (counts[kind] ?? 0) + 1;

    if (!DRY_RUN) {
      try {
        const fromId = await upsertRenderedNode(src.id, s.url, kind, s.depth);
        if (links.length) { await ensureNodes(src.id, links, s.depth + 1); await addEdges(fromId, links); }
        if (kind === "article" && article && MODE !== "structure") {
          await saveArticleFull(src.id, s.url, html);
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

// enrich-Modus: Alle articles ohne Titel mit Chromium rendern und Metadaten nachtragen.
// Läuft parallel (CONCURRENCY Tabs). Ideal nach dem ersten analyze-Batch.
async function enrichArticles(sources: Source[]) {
  const srcById = new Map(sources.map((s) => [s.id, s]));

  // Artikel ohne Titel ODER ohne Veröffentlichungsdatum ODER ohne Wortanzahl laden (balanciert).
  const perSource = Math.ceil(MAX_PAGES / sources.length);
  const toEnrich: { id: number; url: string; source_id: number }[] = [];
  for (const src of sources) {
    // Prio 1: kein Titel (komplette Lücke)
    const { data: noTitle } = await sb.from("articles").select("id,url,source_id")
      .eq("source_id", src.id).is("title", null).limit(Math.ceil(perSource * 0.6));
    toEnrich.push(...((noTitle ?? []) as any[]));
    // Prio 2: Titel vorhanden, aber Veröffentlichungsdatum fehlt
    const missing = perSource - (noTitle?.length ?? 0);
    if (missing > 0) {
      const { data: noDate } = await sb.from("articles").select("id,url,source_id")
        .eq("source_id", src.id).not("title", "is", null).is("published_at", null).limit(missing);
      const seen = new Set(toEnrich.map((r) => r.id));
      for (const r of (noDate ?? []) as any[]) { if (!seen.has(r.id)) toEnrich.push(r); }
    }
  }
  console.log(`Zu bereichern: ${toEnrich.length} Artikel (max ${perSource}/Quelle)`);
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
            .select("title,content_hash,para_fps,body_words,extension_count,edit_count,revision_count,article_type,scan_count,scan_times")
            .eq("id", item.id).maybeSingle();
          const { authors, keywords, categories, ...fields } = meta;
          await sb.from("articles").update({ ...fields, last_seen: new Date().toISOString(), scan_count: ((prev as any)?.scan_count ?? 0) + 1, scan_times: appendScan((prev as any)?.scan_times) }).eq("id", item.id);
          await upsertDimensions(item.id, authors, keywords, categories);
          if (art) await trackChanges(item.id, (prev as PrevState) ?? null, meta.title ?? art.title, art.body, meta.article_type === "liveblog");
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

async function run() {
  const { data, error } = await sb.from("sources").select("id,base_url,language").eq("active", true);
  if (error) throw new Error(`Quellen-Abfrage fehlgeschlagen: ${error.message}`);
  console.log(`${data?.length ?? 0} aktive Quellen geladen.`);
  if (!data?.length) throw new Error("Keine aktiven Quellen gefunden – Abbruch.");

  if (MODE === "analyze") { await analyzeBacklog(); return; }
  if (MODE === "enrich")     { await enrichArticles(data as Source[]); return; }
  if (MODE === "reclassify") { await reclassifyPages(data as Source[]); return; }

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
