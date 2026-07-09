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
  published_at: string | null; discovered_at: string | null; last_seen: string | null;
  word_count: number | null; revision_count: number | null; edit_count: number | null;
  scan_count: number | null; rubric: string | null;
};

export const CORPUS_COLS =
  "id,article_id,source_id,url,ptype,topic,author_status,paywalled,language," +
  "published_at,discovered_at,last_seen,word_count,revision_count,edit_count,scan_count,rubric";

// Zeitachse: nach welchem Zeitstempel gefiltert/gebucketet wird.
//  - "published": wann der Verlag den Artikel veröffentlicht hat (Publikations-Timing).
//  - "seen":      wann margn den Artikel zuletzt gescannt/online gesehen hat (alles, was HEUTE
//                 online ist — auch früher veröffentlichte Artikel). Das ist die Antwort auf
//                 „warum sehe ich für heute nur wenige?": die meisten sind älter veröffentlicht.
export type TimeAxis = "published" | "seen";
export const TIME_AXIS_LABEL: Record<TimeAxis, string> = { published: "Veröffentlicht", seen: "Zuletzt gesehen" };

// Der Teil des Filter-Contexts, den beide Implementierungen brauchen.
export type FilterSnapshot = {
  status: string; paywall: string; atype: string; author: string;
  topics: string[]; lang: string; changed: string; depth: string;
  rangeFrom: string | null; rangeTo: string | null; timeAxis: TimeAxis;
  // „Regional & Lokales" ausblenden (Default AN): ~24 % des Gesamtvolumens sind Regional-
  // Meldungen — sie erschlagen jede Themen-/Quellen-Verteilung. Per Filter zuschaltbar.
  hideRegional: boolean;
  // Online-Bestand: "all" | "online" (noch verlinkt) | "gone" (rausgeflogen).
  // Grenze ist onlineCut = jüngster Scan-Stand des Corpus − 90 min Crawl-Toleranz
  // (FilterProvider berechnet ihn; gleiche Definition wie die Fluktuations-KPIs).
  linkState: string; onlineCut: string | null;
};

type TimedRow = { published_at: string | null; discovered_at: string | null; last_seen?: string | null };
// Effektive Zeit eines Artikels: Verlagsdatum, sonst erster Scan.
// (Sonst fallen Artikel ohne published_at aus jedem Zeitfilter — bei Bild/Spiegel viele.)
export const effTime = (r: TimedRow) => r.published_at ?? r.discovered_at;
// Achsen-abhängige Zeit: "seen" → letzter Scan, sonst Verlagsdatum (jeweils mit Scan-Fallback).
export const axisTime = (r: TimedRow, axis: TimeAxis) =>
  axis === "seen" ? (r.last_seen ?? r.discovered_at) : (r.published_at ?? r.discovered_at);

// ---------- Zeitzone: Tage & Tagesgrenzen in Europe/Berlin statt UTC ----------
// Vorher liefen alle Tagesgrenzen über UTC-Mitternacht → „heute" begann für DE-Nutzer erst um
// 02:00 nachts. Jetzt: Tage und Range-Grenzen in Berlin-Zeit, DST-sicher via Intl.
const BERLIN_TZ = "Europe/Berlin";
// ⚠ PERF: toLocaleDateString(…, { timeZone }) baut bei JEDEM Aufruf ein neues
// Intl.DateTimeFormat (~0,5 ms). berlinDate läuft über jede Korpus-Zeile in mehreren
// Komponenten (41k Zeilen × ~10 Aufrufe) — das fror den Main-Thread ~20 s ein.
// Daher: EIN gecachter Formatter + Memo je Eingabe-String (Zeilen werden von mehreren
// Komponenten mit identischen Timestamps angefragt).
const BERLIN_DAY_FMT = new Intl.DateTimeFormat("en-CA", { timeZone: BERLIN_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const berlinDateMemo = new Map<string, string>();
// "YYYY-MM-DD" des Zeitpunkts in Berlin.
export function berlinDate(d: Date | string): string {
  if (typeof d === "string") {
    let v = berlinDateMemo.get(d);
    if (v === undefined) {
      v = BERLIN_DAY_FMT.format(new Date(d));
      if (berlinDateMemo.size > 300000) berlinDateMemo.clear(); // Wachstum deckeln
      berlinDateMemo.set(d, v);
    }
    return v;
  }
  return BERLIN_DAY_FMT.format(d);
}
// Offset (ms) Berlin gegenüber UTC zum Zeitpunkt `date`. Formatter ebenfalls gecacht.
const BERLIN_PARTS_FMT = new Intl.DateTimeFormat("en-US", { timeZone: BERLIN_TZ, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function berlinOffsetMs(date: Date): number {
  const m: Record<string, string> = {};
  for (const p of BERLIN_PARTS_FMT.formatToParts(date)) m[p.type] = p.value;
  const hour = m.hour === "24" ? 0 : +m.hour;
  return Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second) - date.getTime();
}
// UTC-ISO-Grenzen eines Berlin-Tages "YYYY-MM-DD": from = 00:00 Berlin, to = 23:59:59 Berlin.
export function berlinDayBoundsUTC(dateStr: string): { from: string; to: string } {
  const base = new Date(dateStr + "T00:00:00Z");
  const from = new Date(base.getTime() - berlinOffsetMs(base));
  return { from: from.toISOString(), to: new Date(from.getTime() + 86400000 - 1000).toISOString() };
}
// Die letzten n Berlin-Tage (älteste zuerst). Mittag-Anker → DST-sicher.
export function makeBerlinDays(n: number): string[] {
  const out: string[] = [];
  let cur = new Date(berlinDate(new Date()) + "T12:00:00Z");
  for (let i = 0; i < n; i++) { out.unshift(berlinDate(cur)); cur = new Date(cur.getTime() - 86400000); }
  return out;
}

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
  // NULL-Topics nicht mit ausschließen (topic <> 'regional' wäre für NULL falsy).
  else if (f.hideRegional) q = q.or("topic.neq.regional,topic.is.null");
  if (f.lang !== "all") q = q.eq("language", f.lang);
  if (f.changed === "yes") q = q.gte("revision_count", 1);
  else if (f.changed === "no") q = q.or("revision_count.is.null,revision_count.eq.0");
  if (f.depth === "kurz") q = q.gt("word_count", 0).lt("word_count", 300);
  else if (f.depth === "mittel") q = q.gte("word_count", 300).lte("word_count", 900);
  else if (f.depth === "lang") q = q.gt("word_count", 900);
  // Online-Bestand: „rausgeflogen" = letzte Sichtung vor onlineCut (seither nicht mehr
  // verlinkt angetroffen); „noch verlinkt" = im jüngsten Scan-Stand gesehen.
  if (f.onlineCut) {
    if (f.linkState === "gone") q = q.lt("last_seen", f.onlineCut);
    else if (f.linkState === "online") q = q.gte("last_seen", f.onlineCut);
  }
  if (f.timeAxis === "seen") {
    // Scan-Achse: last_seen ist praktisch immer gesetzt → einfacher Bereichsfilter.
    if (f.rangeFrom) q = q.gte("last_seen", f.rangeFrom);
    if (f.rangeTo) q = q.lte("last_seen", f.rangeTo);
  } else if (f.rangeFrom && f.rangeTo) {
    q = q.or(`and(published_at.gte.${f.rangeFrom},published_at.lte.${f.rangeTo}),and(published_at.is.null,discovered_at.gte.${f.rangeFrom},discovered_at.lte.${f.rangeTo})`);
  } else if (f.rangeFrom) {
    q = q.or(`published_at.gte.${f.rangeFrom},and(published_at.is.null,discovered_at.gte.${f.rangeFrom})`);
  } else if (f.rangeTo) {
    q = q.or(`published_at.lte.${f.rangeTo},and(published_at.is.null,discovered_at.lte.${f.rangeTo})`);
  }
  // Rubrik-Muster gegen URL ODER die sektionierte `rubric`-Spalte (n-tv idN.html trägt kein Ressort).
  if (subPats.length) q = q.or(subPats.flatMap((s) => [`url.ilike.%/${s}/%`, `rubric.ilike.%/${s}/%`]).join(","));
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
  const cutMs = f.onlineCut ? Date.parse(f.onlineCut) : null;
  const topicSet = new Set(f.topics);
  const pats = subPats.map((s) => `/${s.toLowerCase()}/`);
  return (r: CorpusRow) => {
    if (!ALLOWED_SET.has(r.ptype)) return false;
    // Immer angewandt (auch bei skip.topics): ausgeblendetes Regional soll in KEINER
    // Auswertung auftauchen — auch nicht in Themen-Karten/-Optionen.
    if (f.hideRegional && r.topic === "regional") return false;
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
    // Online-Bestand — PostgREST-Semantik gespiegelt: NULL last_seen fällt in beiden Modi raus.
    if (cutMs !== null && f.linkState !== "all" && (f.linkState === "gone" || f.linkState === "online")) {
      if (r.last_seen == null) return false;
      const ls = Date.parse(r.last_seen);
      if (f.linkState === "gone" ? ls >= cutMs : ls < cutMs) return false;
    }
    if (!skip.time && (fromMs !== null || toMs !== null)) {
      const t = axisTime(r, f.timeAxis);
      if (!t) return false;
      const ms = Date.parse(t);
      if (fromMs !== null && ms < fromMs) return false;
      if (toMs !== null && ms > toMs) return false;
    }
    if (!skip.topics && pats.length) {
      // Rubrik steckt bei n-tv in `rubric` (sektionierte URL), sonst in der URL.
      const u = (r.url + " " + (r.rubric ?? "")).toLowerCase();
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
    rangeFrom: f.rangeFrom, rangeTo: f.rangeTo, timeAxis: (f.timeAxis as TimeAxis) ?? "published",
    hideRegional: !!f.hideRegional,
    linkState: (f.linkState as string) ?? "all", onlineCut: (f.onlineCut as string | null) ?? null,
  };
}
