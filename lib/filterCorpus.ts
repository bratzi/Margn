// ZENTRALE Filterlogik des Dashboards — die einzige Quelle der Wahrheit.
//
// Vorher hatte jede Komponente ihre eigene Filter-Implementierung (Tabelle: PostgREST
// mit Zeit-Fallback; PulseBar/TopicProfile: PostgREST ohne Fallback und mit Teilfiltern;
// Charts: DB-RPCs mit wieder anderen Teilfiltern). Ergebnis: Die Zahlen wichen überall
// voneinander ab. Jetzt gilt:
//
//   1. ALLE Analytics-Komponenten zählen über denselben clientseitigen Corpus
//      (page_overview, einmal geladen) mit demselben Prädikat `makeMatcher`.
//   2. Die Artikel-Tabelle fragt weiterhin den Server (Pagination), aber über
//      `applyServerFilters` — das exakte Spiegelbild von `makeMatcher`.
//
// WICHTIG: Wer einen Filter ändert, muss BEIDE Funktionen anpassen (Server + Client).
// Sie stehen deshalb bewusst direkt untereinander in dieser Datei.

// Nur diese Seitentypen zählen als journalistischer Inhalt.
// Videos/Werbung/Hubs verzerren Quoten (Paywall, Autoren, Wortzahlen) und sind raus.
export const ALLOWED_PTYPES = ["artikel", "paywall", "timeline", "blog"];
const ALLOWED_SET = new Set(ALLOWED_PTYPES);
// Der Seitentyp-Filter "timeline" umfasst beide Roh-Werte aus der DB.
const TIMELINE_PTYPES = ["timeline", "blog"];
const TIMELINE_SET = new Set(TIMELINE_PTYPES);

export type CorpusRow = {
  id: number; article_id: number | null; source_id: number; url: string;
  ptype: string; topic: string | null; author_status: string | null;
  paywalled: boolean | null; language: string | null;
  published_at: string | null; discovered_at: string | null;
  word_count: number | null; revision_count: number | null; edit_count: number | null;
  scan_count: number | null;
};

export const CORPUS_COLS =
  "id,article_id,source_id,url,ptype,topic,author_status,paywalled,language," +
  "published_at,discovered_at,word_count,revision_count,edit_count,scan_count";

// Der Teil des Filter-Contexts, den beide Implementierungen brauchen.
export type FilterSnapshot = {
  status: string; paywall: string; atype: string; author: string;
  topics: string[]; lang: string; changed: string; depth: string;
  rangeFrom: string | null; rangeTo: string | null;
};

// Effektive Zeit eines Artikels: Verlagsdatum, sonst erster Scan.
// (Sonst fallen Artikel ohne published_at aus jedem Zeitfilter — bei Bild/Spiegel viele.)
export const effTime = (r: { published_at: string | null; discovered_at: string | null }) =>
  r.published_at ?? r.discovered_at;

// ---------- SERVER-Seite (Artikel-Tabelle) ----------
// Spiegelbild von makeMatcher — Änderungen immer in BEIDEN Funktionen nachziehen!
export function applyServerFilters(q: any, f: FilterSnapshot, subPats: string[], kwIds: number[] | null) {
  q = q.in("ptype", ALLOWED_PTYPES);
  if (f.status === "new") q = q.lte("scan_count", 1);
  else if (f.status === "rescanned") q = q.gte("scan_count", 2);
  if (f.paywall === "yes") q = q.eq("paywalled", true);
  else if (f.paywall === "no") q = q.eq("paywalled", false);
  if (f.atype !== "all") {
    if (f.atype === "timeline") q = q.in("ptype", TIMELINE_PTYPES);
    else q = q.eq("ptype", f.atype);
  }
  if (f.author !== "all") q = q.eq("author_status", f.author);
  if (f.topics.length) q = q.in("topic", f.topics);
  if (f.lang !== "all") q = q.eq("language", f.lang);
  if (f.changed === "yes") q = q.gte("revision_count", 1);
  else if (f.changed === "no") q = q.or("revision_count.is.null,revision_count.eq.0");
  if (f.depth === "kurz") q = q.gt("word_count", 0).lt("word_count", 300);
  else if (f.depth === "mittel") q = q.gte("word_count", 300).lte("word_count", 900);
  else if (f.depth === "lang") q = q.gt("word_count", 900);
  if (f.rangeFrom && f.rangeTo) {
    q = q.or(`and(published_at.gte.${f.rangeFrom},published_at.lte.${f.rangeTo}),and(published_at.is.null,discovered_at.gte.${f.rangeFrom},discovered_at.lte.${f.rangeTo})`);
  } else if (f.rangeFrom) {
    q = q.or(`published_at.gte.${f.rangeFrom},and(published_at.is.null,discovered_at.gte.${f.rangeFrom})`);
  } else if (f.rangeTo) {
    q = q.or(`published_at.lte.${f.rangeTo},and(published_at.is.null,discovered_at.lte.${f.rangeTo})`);
  }
  if (subPats.length) q = q.or(subPats.map((s) => `url.ilike.%/${s}/%`).join(","));
  if (kwIds) q = q.in("article_id", kwIds.length ? kwIds : [-1]);
  return q;
}

// ---------- CLIENT-Seite (alle Analytics-Komponenten) ----------
// skip.time:   Komponente bringt eigene Zeitachse mit (Zeitstrahl, Publizisten-Vergleich)
// skip.topics: Komponente zeigt selbst die Themen-Dimension (Themen-Karten, Heatmap)
export function makeMatcher(
  f: FilterSnapshot, subPats: string[], kwIdSet: Set<number> | null,
  skip: { time?: boolean; topics?: boolean } = {},
): (r: CorpusRow) => boolean {
  const fromMs = f.rangeFrom ? Date.parse(f.rangeFrom) : null;
  const toMs = f.rangeTo ? Date.parse(f.rangeTo) : null;
  const topicSet = new Set(f.topics);
  const pats = subPats.map((s) => `/${s.toLowerCase()}/`);
  return (r: CorpusRow) => {
    if (!ALLOWED_SET.has(r.ptype)) return false;
    // Erfassung — PostgREST-Semantik: NULL <= 1 ist NULL → Zeile fällt raus
    if (f.status === "new") { if (r.scan_count == null || r.scan_count > 1) return false; }
    else if (f.status === "rescanned") { if (r.scan_count == null || r.scan_count < 2) return false; }
    if (f.paywall === "yes" && r.paywalled !== true) return false;
    if (f.paywall === "no" && r.paywalled !== false) return false;
    if (f.atype !== "all") {
      if (f.atype === "timeline") { if (!TIMELINE_SET.has(r.ptype)) return false; }
      else if (r.ptype !== f.atype) return false;
    }
    if (f.author !== "all" && r.author_status !== f.author) return false;
    if (!skip.topics && topicSet.size && !topicSet.has(r.topic ?? "")) return false;
    if (f.lang !== "all" && r.language !== f.lang) return false;
    if (f.changed === "yes" && (r.revision_count ?? 0) < 1) return false;
    if (f.changed === "no" && r.revision_count != null && r.revision_count !== 0) return false;
    if (f.depth === "kurz") { if (r.word_count == null || r.word_count <= 0 || r.word_count >= 300) return false; }
    else if (f.depth === "mittel") { if (r.word_count == null || r.word_count < 300 || r.word_count > 900) return false; }
    else if (f.depth === "lang") { if (r.word_count == null || r.word_count <= 900) return false; }
    if (!skip.time && (fromMs !== null || toMs !== null)) {
      const t = effTime(r);
      if (!t) return false;
      const ms = Date.parse(t);
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms > toMs) return false;
    }
    if (!skip.topics && pats.length) {
      const u = r.url.toLowerCase();
      if (!pats.some((p) => u.includes(p))) return false;
    }
    if (kwIdSet) { if (r.article_id == null || !kwIdSet.has(r.article_id)) return false; }
    return true;
  };
}

// Snapshot aus dem Filter-Context ziehen (nur die relevanten Felder).
export function snapshotOf(f: FilterSnapshot & Record<string, unknown>): FilterSnapshot {
  return {
    status: f.status, paywall: f.paywall, atype: f.atype, author: f.author,
    topics: f.topics, lang: f.lang, changed: f.changed, depth: f.depth,
    rangeFrom: f.rangeFrom, rangeTo: f.rangeTo,
  };
}
