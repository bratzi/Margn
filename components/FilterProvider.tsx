"use client";

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { topicLabel, TOPICS_SANS_REGIONAL } from "@/lib/topics";
import { fetchAllRows, timeoutSignal } from "@/lib/pgFetch";
import { ALLOWED_PTYPES, CORPUS_COLS, makeMatcher, snapshotOf, makeBerlinDays, berlinDayBoundsUTC, onlineCutsFrom, type CorpusRow, type TimeAxis } from "@/lib/filterCorpus";

export type Src = { id: number; name: string; country: string; base_url: string };
type Opt = { key: string; label: string; n: number };
// key = Roh-Pfadmuster (z.B. "politik/ausland") zum URL-Filtern; label = lesbar.
export type SubOpt = { key: string; label: string; n: number; sources: number; rawKeys: string[] };

// Kanonische Ober-Kategorien mit mehrsprachigen Synonymen (DE/FR/EN).
// Erlaubt das Bündeln sprachlich unterschiedlicher Verlagsrubriken unter einem Dach.
const CANON_CATS: { key: string; label: string; words: string[] }[] = [
  { key: "politik",       label: "Politik",              words: ["politik", "politique", "political", "politisch"] },
  { key: "international", label: "International",         words: ["ausland", "international", "étranger", "monde", "europa", "europe", "foreign", "world", "außenpolitik"] },
  { key: "national",      label: "National / Inland",    words: ["inland", "national", "france", "deutschland", "germany", "allemagne", "innenpolitik"] },
  { key: "wirtschaft",    label: "Wirtschaft",           words: ["wirtschaft", "économie", "economy", "business", "finanzen", "finances", "geld", "markt"] },
  { key: "sport",         label: "Sport",                words: ["sport", "sports", "fussball", "football", "soccer", "bundesliga", "ligue"] },
  { key: "kultur",        label: "Kultur",               words: ["kultur", "culture", "kulturell", "art", "arts", "kino", "film", "musik", "musique", "litterature"] },
  { key: "gesellschaft",  label: "Gesellschaft",         words: ["gesellschaft", "société", "social", "soziales", "leben", "vie", "famille"] },
  { key: "wissenschaft",  label: "Wissenschaft & Tech",  words: ["wissenschaft", "sciences", "technologie", "technology", "tech", "forschung", "innovation", "numerique", "digital"] },
  { key: "gesundheit",    label: "Gesundheit",           words: ["gesundheit", "santé", "health", "medizin", "médecine", "medical"] },
  { key: "umwelt",        label: "Umwelt & Klima",       words: ["umwelt", "klima", "environnement", "environment", "climate", "natur", "nature", "ecologie", "energie"] },
  { key: "meinung",       label: "Meinung",              words: ["meinung", "opinion", "kommentar", "commentary", "analyse", "analysis", "debat", "debatte"] },
  { key: "regional",      label: "Regional",             words: ["regional", "local", "lokal", "region", "bundesland", "departement"] },
  { key: "reise",         label: "Reise",                words: ["reise", "voyage", "tourisme", "tourism", "travel", "urlaub", "ferien"] },
  { key: "medien",        label: "Medien",               words: ["medien", "médias", "media", "presse", "press", "fernsehen", "television"] },
];

// Deutsche Bundesländer als eigene Rubrik-Ebene: damit „Regional" NICHT alle Länder in einen Topf
// wirft, sondern je Bundesland eine Unterkategorie zeigt — verlagsübergreifend gebündelt (Bild
// /regional/niedersachsen/, n-tv /regionales/niedersachsen/, Tagesschau /inland/regional/…).
// Reihenfolge: zusammengesetzte VOR einfachen Namen (Sachsen-Anhalt vor Sachsen etc.).
const BUNDESLAENDER: { key: string; label: string; m: string[] }[] = [
  { key: "baden-wuerttemberg", label: "Baden-Württemberg", m: ["baden wuerttemberg", "baden wurttemberg"] },
  { key: "bayern", label: "Bayern", m: ["bayern"] },
  { key: "berlin-brandenburg", label: "Berlin & Brandenburg", m: ["berlin und brandenburg"] },
  { key: "mecklenburg-vorpommern", label: "Mecklenburg-Vorpommern", m: ["mecklenburg vorpommern", "mecklenburgvorpommern"] },
  { key: "nordrhein-westfalen", label: "Nordrhein-Westfalen", m: ["nordrhein westfalen", "nordrheinwestfalen"] },
  { key: "rheinland-pfalz", label: "Rheinland-Pfalz", m: ["rheinland pfalz", "rheinlandpfalz"] },
  { key: "sachsen-anhalt", label: "Sachsen-Anhalt", m: ["sachsen anhalt", "sachsenanhalt"] },
  { key: "schleswig-holstein", label: "Schleswig-Holstein", m: ["schleswig holstein", "schleswigholstein"] },
  { key: "brandenburg", label: "Brandenburg", m: ["brandenburg"] },
  { key: "niedersachsen", label: "Niedersachsen", m: ["niedersachsen"] },
  { key: "thueringen", label: "Thüringen", m: ["thueringen", "thuringen"] },
  { key: "bremen", label: "Bremen", m: ["bremen"] },
  { key: "hamburg", label: "Hamburg", m: ["hamburg"] },
  { key: "hessen", label: "Hessen", m: ["hessen"] },
  { key: "saarland", label: "Saarland", m: ["saarland"] },
  { key: "sachsen", label: "Sachsen", m: ["sachsen"] },
  { key: "berlin", label: "Berlin", m: ["berlin"] },
];
function stripAccents(s: string) { return s.normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function toCanonKey(rawLabel: string): string | null {
  const norm = stripAccents(rawLabel.toLowerCase()).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  // Bundesland zuerst → „Regional · Sachsen" gruppiert unter „Sachsen", nicht unter „Regional".
  for (const bl of BUNDESLAENDER) if (bl.m.some((x) => norm.includes(x))) return bl.key;
  const words = norm.split(/\s+/).filter(Boolean);
  for (const cat of CANON_CATS) {
    if (cat.words.some((w) => words.includes(w) || norm.includes(w))) return cat.key;
  }
  const first = words.find((w) => w.length >= 3);
  return first ?? null;
}
function canonLabel(key: string, fallback: string): string {
  return BUNDESLAENDER.find((b) => b.key === key)?.label ?? CANON_CATS.find((c) => c.key === key)?.label ?? fallback;
}

// Generische Pfad-Wrapper, die KEINE inhaltliche Rubrik sind.
const RUBRIC_SKIP = new Set([
  "aktuell", "article", "articles", "news", "nachrichten", "story", "html", "amp",
  "de", "en", "fr", "thema", "themen", "a", "id",
]);
// Rubrik aus dem URL-Pfad: aussagekräftigste Rubriken-Segmente (vor dem Headline-Slug).
// Gibt { raw, label } zurück — raw zum URL-Filtern, label für die Anzeige.
// z.B. faz.net/aktuell/politik/ausland/slug-123.html → { raw:"politik/ausland", label:"Politik · Ausland" }
function urlRubric(url: string): { raw: string; label: string } | null {
  let segs: string[] = [];
  try { segs = new URL(url).pathname.toLowerCase().replace(/\/+$/, "").split("/").filter(Boolean); }
  catch { return null; }
  if (segs.length < 2) return null;
  const rubricSegs = segs.slice(0, -1).filter(
    (s) => !/^\d+$/.test(s) && !/-\d{4,}/.test(s) && !/^\d{4}$/.test(s) && !RUBRIC_SKIP.has(s) && s.length >= 2,
  );
  if (!rubricSegs.length) return null;
  const last2 = rubricSegs.slice(-2);
  const pretty = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { raw: last2.join("/"), label: last2.map(pretty).join(" · ") };
}

// Max. 30 Tage: die DB-Retention löscht Artikel 30 Tage nach dem letzten Scan
// (maintenance.sql) — 60/90-Tage-Fenster zeigten dahinter nur Leere.
const WINDOW_OPTS = [7, 14, 30] as const;
export { WINDOW_OPTS };

type Ctx = {
  sources: Src[]; active: Set<number>; activeArr: number[];
  toggle: (id: number) => void; setAll: (on: boolean) => void;
  status: string; setStatus: (v: string) => void;
  paywall: string; setPaywall: (v: string) => void;
  atype: string; setAtype: (v: string) => void;
  author: string; setAuthor: (v: string) => void;
  topics: string[]; toggleTopic: (t: string) => void; setTopics: (a: string[]) => void;
  subcats: string[]; toggleSubcat: (c: string) => void;
  // „Regional & Lokales" ausblenden (Default AN): ~24 % des Volumens sind Regional-Meldungen
  // und erschlagen jede Verteilung. Zuschaltbar über den Filter.
  hideRegional: boolean; setHideRegional: (b: boolean) => void;
  // Online-Bestand: "all" | "online" (noch verlinkt) | "gone" (rausgeflogen — letzte
  // Sichtung vor dem Quellen-Cut). onlineCut = Cuts je Quelle (source_id → ISO).
  linkState: string; setLinkState: (v: string) => void; onlineCut: Record<string, string> | null;
  keyword: string; setKeyword: (v: string) => void;
  // Volltextsuche über alle Eigenschaften (Titel/URL/Teaser/Thema/Schlagwörter/Rubriken/Inhalt).
  search: string; setSearch: (v: string) => void; searchPending: boolean; searchCount: number | null;
  // MEHRFACH-SUCHE: per Enter übernommene Begriffe. Jeder Begriff wird eigenständig gesucht,
  // die Treffermengen sind ODER-verknüpft (Vereinigung) — mehrere Suchen zugleich anwenden.
  searchTerms: string[]; addSearchTerm: (t: string) => void; removeSearchTerm: (t: string) => void;
  termCounts: Map<string, number | null>;
  lang: string; setLang: (v: string) => void;
  // Stille Änderungen (revision_count) — Kernfeature des Observatoriums
  changed: string; setChanged: (v: string) => void;
  // Artikel-Tiefe nach Wortzahl (kurz < 300, mittel 300–900, lang > 900)
  depth: string; setDepth: (v: string) => void;
  // Zeitfenster-Breite (Tage) — per Preset wählbar (7/14/30/60/90)
  windowDays: number; setWindowDays: (n: number) => void;
  // Zeitachse: nach Veröffentlichung ODER nach letztem Scan ("zuletzt gesehen") filtern/bucketen
  timeAxis: TimeAxis; setTimeAxis: (a: TimeAxis) => void;
  // Alle Filter auf Ausgangszustand
  resetAll: () => void;
  topicOpts: Opt[]; keywordOpts: Opt[]; subOpts: SubOpt[];
  catTree: Map<string, SubOpt[]>;
  // Gemeinsamer Datenbestand für ALLE Analytics-Komponenten (eine Wahrheit, ein Prädikat).
  corpus: CorpusRow[]; corpusReady: boolean;
  // Manuelles Nachladen der Daten (Refresh-Button) — ohne Seiten-Reload. refreshing = Ladevorgang
  // läuft; corpusLoadedAt = Zeitstempel des letzten erfolgreichen Ladens; corpusError = letzter
  // Ladeversuch (inkl. Auto-Wiederholung) ist gescheitert, alter Bestand wird weiter angezeigt.
  reloadCorpus: () => void; refreshing: boolean; corpusLoadedAt: number | null; corpusError: boolean;
  // Keyword-Filter: Artikel-IDs des gewählten Keywords (null = kein Keyword-Filter aktiv)
  kwIds: number[] | null; kwIdSet: Set<number> | null;
  // Aufgelöste URL-Muster der gewählten Sub-Rubriken (kanonisch → roh, mehrsprachig)
  subPats: string[];
  days: string[]; rangeIdx: { from: number; to: number }; setRangeIdx: (r: { from: number; to: number }) => void;
  rangeFrom: string | null; rangeTo: string | null;
  // Pinpoint: exaktes Zeitfenster (+ optional Quelle) aus einem Chart-Klick — überschreibt
  // rangeFrom/rangeTo für die Tabelle und kann eine einzelne Quelle isolieren.
  pinpoint: Pin | null; setPinpoint: (p: Pin | null) => void;
  trfOpen: boolean; setTrfOpen: (b: boolean) => void;
  ready: boolean;
};

export type Pin = { from: string; to: string; sourceId?: number; topic?: string; label: string; limit?: number };

const FilterContext = createContext<Ctx | null>(null);
export const useFilters = () => useContext(FilterContext)!;

export default function FilterProvider({ children }: { children: React.ReactNode }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const [sources, setSources] = useState<Src[]>([]);
  const [active, setActive] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState("all");
  const [paywall, setPaywall] = useState("all");
  const [atype, setAtype] = useState("all");
  const [author, setAuthor] = useState("all");
  const [topics, setTopics] = useState<string[]>([]);
  const [subcats, setSubcats] = useState<string[]>([]);
  const [hideRegional, _setHideRegional] = useState(true);
  // Beim Ausblenden auch eine evtl. aktive Regional-Themenwahl (+ Bundesland-Rubriken)
  // abräumen — sonst filtert man auf eine ausgeblendete Menge (0 Treffer, verwirrend).
  const setHideRegional = (b: boolean) => {
    _setHideRegional(b);
    if (b) {
      setTopics((p) => p.filter((t) => t !== "regional"));
      setSubcats((p) => p.filter((c) => !BUNDESLAENDER.some((bl) => bl.key === c)));
    }
  };
  const [subOpts, setSubOpts] = useState<SubOpt[]>([]);
  const [keyword, setKeyword] = useState("all");
  const [search, setSearch] = useState("");
  const [searchTerms, setSearchTerms] = useState<string[]>([]);
  const addSearchTerm = useCallback((t: string) => {
    const v = t.trim();
    if (v.length < 2) return;
    setSearchTerms((p) => (p.some((x) => x.toLowerCase() === v.toLowerCase()) ? p : [...p, v]));
  }, []);
  const removeSearchTerm = useCallback((t: string) => setSearchTerms((p) => p.filter((x) => x !== t)), []);
  // Unterthemen bleiben beim Topic-Wechsel erhalten — sie sind über die Filter-Pills
  // jederzeit sichtbar und einzeln entfernbar.
  const toggleTopic = (t: string) => setTopics((p) => p.includes(t) ? p.filter((x) => x !== t) : [...p, t]);
  const toggleSubcat = (c: string) => setSubcats((p) => p.includes(c) ? p.filter((x) => x !== c) : [...p, c]);
  const [lang, setLang] = useState("all");
  const [changed, setChanged] = useState("all");
  const [depth, setDepth] = useState("all");
  const [linkState, setLinkState] = useState("all");
  const [windowDays, _setWindowDays] = useState(30);
  // setWindowDays: Fensterbreite wechseln und Slider + Pinpoint sofort zurücksetzen.
  const setWindowDays = (n: number) => { _setWindowDays(n); setRangeIdx({ from: 0, to: n - 1 }); setPinpoint(null); };
  // Zeitachse (Veröffentlicht ↔ Zuletzt gesehen). Achsenwechsel hebt einen Pinpoint auf,
  // damit kein Chart-Klick mit der falschen Zeitsemantik hängen bleibt.
  const [timeAxis, _setTimeAxis] = useState<TimeAxis>("published");
  const setTimeAxis = (a: TimeAxis) => { _setTimeAxis(a); setPinpoint(null); };
  const [topicOpts, setTopicOpts] = useState<Opt[]>([]);
  const [keywordOpts, setKeywordOpts] = useState<Opt[]>([]);
  const [ready, setReady] = useState(false);

  const days = useMemo(() => makeBerlinDays(windowDays), [windowDays]);
  const [trfOpen, setTrfOpen] = useState(true);
  const [rangeIdx, setRangeIdx] = useState<{ from: number; to: number }>({ from: 0, to: 29 });
  const [pinpoint, setPinpoint] = useState<Pin | null>(null);
  // Slider-Indizes an die tatsächliche days-Länge klemmen (Sicherheitsnetz bei
  // localStorage-Mismatch zwischen verschiedenen Fensterbreiten).
  const safeFrom = Math.min(rangeIdx.from, days.length - 1);
  const safeTo = Math.min(rangeIdx.to, days.length - 1);
  // Pinpoint (Chart-Klick) hat Vorrang über den Tages-Range für die Tabellen-Abfrage.
  // Rechtes Ende am Fensterrand → kein rangeTo (keine künstliche Zukunfts-Abschneidung).
  const rangeFrom = pinpoint ? pinpoint.from : berlinDayBoundsUTC(days[safeFrom]).from;
  const rangeTo = pinpoint ? pinpoint.to : (safeTo === days.length - 1 ? null : berlinDayBoundsUTC(days[safeTo]).to);

  const savedActiveRef = useRef<number[] | null>(null);

  // URL-Params
  useEffect(() => {
    const sid = params.get("source_id"); const kw = params.get("keyword"); const tp = params.get("topic");
    if (sid) { const id = parseInt(sid, 10); if (!isNaN(id)) setActive((p) => new Set([...p, id])); }
    if (kw) setKeyword(kw);
    if (tp) { setTopics([tp]); if (tp === "regional") _setHideRegional(false); } // Deep-Link auf Regional schaltet es sichtbar
  }, [params]);

  // gespeicherte Filter laden
  useEffect(() => {
    try {
      const f = JSON.parse(localStorage.getItem("margn-filters") || "{}");
      if (f.status) setStatus(f.status);
      if (Array.isArray(f.searchTerms)) setSearchTerms(f.searchTerms.filter((x: unknown) => typeof x === "string" && (x as string).length >= 2));
      if (f.paywall) setPaywall(f.paywall);
      if (f.atype) setAtype(f.atype);
      if (f.author) setAuthor(f.author);
      const savedHideRegional = typeof f.hideRegional === "boolean" ? f.hideRegional : true;
      _setHideRegional(savedHideRegional);
      // Gespeicherte Regional-Themenwahl mit dem (Default-)Ausblenden versöhnen.
      const loadTopics = (arr: string[]) => setTopics(savedHideRegional ? arr.filter((t) => t !== "regional") : arr);
      if (Array.isArray(f.topics)) loadTopics(f.topics); else if (f.topic && f.topic !== "all") loadTopics([f.topic]);
      if (f.keyword) setKeyword(f.keyword);
      if (f.lang) setLang(f.lang);
      if (f.changed) setChanged(f.changed);
      if (f.depth) setDepth(f.depth);
      if (f.linkState === "online" || f.linkState === "gone") setLinkState(f.linkState);
      if (f.timeAxis === "published" || f.timeAxis === "seen") _setTimeAxis(f.timeAxis);
      if (typeof f.trfOpen === "boolean") setTrfOpen(f.trfOpen);
      // Ohne gespeicherte Wahl: auf Mobilgeräten eingeklappt starten — der offene
      // Zeitstrahl belegt sonst dauerhaft ~40 % des kleinen Screens.
      else if (typeof window !== "undefined" && window.innerWidth <= 860) setTrfOpen(false);
      // windowDays zuerst setzen (nicht setWindowDays, um rangeIdx nicht automatisch zu resetten),
      // dann rangeIdx manuell klemmen — so bleibt ein gespeicherter Teilbereich erhalten.
      const savedW = (WINDOW_OPTS as readonly number[]).includes(f.windowDays) ? f.windowDays as number : 30;
      _setWindowDays(savedW);
      if (f.rangeIdx && typeof f.rangeIdx.from === "number") {
        const maxIdx = savedW - 1;
        setRangeIdx({ from: Math.min(f.rangeIdx.from, maxIdx), to: Math.min(f.rangeIdx.to ?? maxIdx, maxIdx) });
      }
      if (Array.isArray(f.activeIds)) savedActiveRef.current = f.activeIds;
    } catch {}
  }, []);

  // Quellen laden — MIT Timeout + Retry: das ist der Torwächter der ganzen Seite (ohne
  // sources lädt weder Corpus noch Tabelle). Ein einzelner hängender Request ließ das
  // Dashboard sonst dauerhaft leer stehen.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const ts = timeoutSignal();
        const { data, error } = await supabase.from("sources").select("id,name,base_url,country")
          .eq("active", true).abortSignal(ts.signal);
        ts.done();
        if (cancelled) return;
        if (!error && data) {
          const s = (data as Src[]) ?? []; const ids = s.map((x) => x.id);
          const saved = savedActiveRef.current;
          setSources(s);
          setActive(new Set(saved && saved.length ? saved.filter((id) => ids.includes(id)) : ids));
          setReady(true);
          return;
        }
        if (attempt < 2) await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // persistieren
  useEffect(() => {
    if (!sources.length) return;
    try {
      localStorage.setItem("margn-filters", JSON.stringify({
        activeIds: [...active], status, paywall, atype, author, topics, keyword, lang, changed, depth, trfOpen, rangeIdx, windowDays, timeAxis, searchTerms, hideRegional, linkState,
      }));
    } catch {}
  }, [active, status, paywall, atype, author, topics, keyword, lang, changed, depth, trfOpen, rangeIdx, windowDays, timeAxis, searchTerms, hideRegional, linkState, sources.length]);

  const nn = (v: string) => (v === "all" ? null : v);

  // ---------- Gemeinsamer Corpus: EINMAL laden, alle Komponenten zählen darüber ----------
  // page_overview (nur erlaubte Seitentypen), neueste zuerst — wächst der Bestand über das
  // Limit, fallen die ältesten raus. Langfristig gehört das in Server-Aggregation (RPCs),
  // für den aktuellen Datenumfang ist der Client-Corpus die konsistenteste Lösung.
  const [corpus, setCorpus] = useState<CorpusRow[]>([]);
  const [corpusReady, setCorpusReady] = useState(false);
  const [corpusGen, setCorpusGen] = useState(0); // erhöht = Neuladen
  const [refreshing, setRefreshing] = useState(false);
  const [corpusError, setCorpusError] = useState(false);
  const [corpusLoadedAt, setCorpusLoadedAt] = useState<number | null>(null);
  // EGRESS-Sparen: Den schweren Corpus (page_overview, ~10 MB) NUR auf den Seiten laden, die ihn
  // auch auswerten (Dashboard + Edits). Landing/Detailseite brauchen ihn nicht — bisher zog ihn aber
  // JEDER Seitenaufruf mit (FilterProvider liegt im Root-Layout).
  const needsCorpus = pathname === "/articles" || pathname === "/articles/edits" || pathname === "/articles/keywords";
  const corpusLoadedAtRef = useRef<number | null>(null); // Frische-Quelle (sofort aktuell, kein State-Lag)
  const fetchedGenRef = useRef(-1);                       // für welche corpusGen zuletzt geladen wurde
  const FRESH_MS = 10 * 60 * 1000;                        // jünger = kein erneuter Pull bei Navigation/Rückkehr
  // Refresh-Button: Daten neu ziehen, ohne die Seite zu laden (alter Bestand bleibt sichtbar,
  // bis der neue da ist → kein Flackern). reloadCorpus erhöht nur corpusGen → der Lade-Effekt feuert.
  const reloadCorpus = useCallback(() => { setRefreshing(true); setCorpusGen((g) => g + 1); }, []);
  useEffect(() => {
    if (!sources.length || !needsCorpus) return;
    // Bei Navigation zurück ins Dashboard NICHT erneut ziehen, solange der Bestand frisch ist; ein
    // erzwungenes Neuladen (Refresh-Button/Sichtbarkeit) bumpt corpusGen und lädt trotzdem.
    const age = corpusLoadedAtRef.current ? Date.now() - corpusLoadedAtRef.current : Infinity;
    if (corpusGen === fetchedGenRef.current && age < FRESH_MS) return;
    fetchedGenRef.current = corpusGen;
    let cancelled = false;
    // Corpus auf max. 35 Tage (= größtes Preset 30 + 5 Puffer) begrenzen.
    // Ohne Filter würden Archiv-Artikel (z.B. Le Monde bis 1945) die Zeilen­zahl
    // massiv aufblähen → zu viele parallele Supabase-Requests → Rate-Limit-Fehler
    // → Corpus unvollständig → Charts zählen weniger als die Tabelle.
    const floor = new Date(); floor.setUTCDate(floor.getUTCDate() - 35);
    const cf = floor.toISOString();
    // Deckt BEIDE Zeitachsen ab: kürzlich veröffentlicht ODER kürzlich gescannt ("zuletzt gesehen").
    // Sonst fehlten auf der Scan-Achse ältere, aber heute noch online/gescannte Artikel.
    const corpusFilter = `published_at.gte.${cf},and(published_at.is.null,discovered_at.gte.${cf}),last_seen.gte.${cf}`;
    const load = () => fetchAllRows<CorpusRow>(
      (signal) => supabase.from("page_overview").select("id", { count: "exact", head: true })
        .in("ptype", ALLOWED_PTYPES).or(corpusFilter).abortSignal(signal),
      // WICHTIG: nach dem EINDEUTIGEN PK `id` paginieren, nicht nach
      // discovered_at. Bei gleichen discovered_at-Werten (Batch-Inserts) ist die
      // Sortierung über parallele Range-Requests sonst nicht stabil → Zeilen
      // fallen zwischen Seiten raus → Corpus unvollständig → Charts zählen
      // weniger als die Tabelle. id desc ≈ neueste zuerst und ist eindeutig.
      (a, b, signal) => supabase.from("page_overview").select(CORPUS_COLS).in("ptype", ALLOWED_PTYPES)
        .or(corpusFilter).order("id", { ascending: false }).range(a, b).abortSignal(signal) as any,
      // Cap der clientseitigen Analytics-Menge. Langfristig gehört diese
      // Aggregation server-seitig (RPC), dann cap-frei.
      100000,
    );
    // Ein Klick = bis zu zwei komplette Versuche: fetchAllRows wirft jetzt bei jedem Loch
    // (statt still unvollständig zu liefern), ein transienter Aussetzer wird also hier
    // abgefangen statt vom Nutzer per Mehrfach-Klick. Scheitern beide: alter Bestand bleibt
    // sichtbar, corpusError signalisiert es dem Button.
    (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const rows = await load();
          if (cancelled) return;
          // Dedupe nach id: Offset-Pagination auf id desc verschiebt bei gleichzeitigen
          // Inserts (stündlicher Scrape) die Seitengrenzen → einzelne Zeilen kämen doppelt.
          const seen = new Set<number>();
          const uniq = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
          setCorpus(uniq); setCorpusReady(true); setCorpusError(false);
          corpusLoadedAtRef.current = Date.now(); setCorpusLoadedAt(Date.now()); setRefreshing(false);
          return;
        } catch {
          if (cancelled) return;
          if (attempt === 0) await new Promise((res) => setTimeout(res, 1200));
        }
      }
      if (!cancelled) { setCorpusError(true); setRefreshing(false); }
    })();
    return () => { cancelled = true; };
  }, [sources.length, corpusGen, needsCorpus]);
  // KEIN blindes Intervall-Polling mehr: ein vergessener Tab zog sonst ~10 MB ALLE 10 min
  // (≈1,4 GB/Tag) — der mit Abstand größte Egress-Posten. Stattdessen nur nachladen, wenn der
  // Nutzer zu einem SICHTBAREN Dashboard-Tab zurückkehrt UND der Bestand älter als FRESH_MS ist.
  // Hintergrund-/vergessene Tabs kosten so gar nichts; der Refresh-Button bleibt für „sofort frisch".
  useEffect(() => {
    if (!needsCorpus) return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const age = corpusLoadedAtRef.current ? Date.now() - corpusLoadedAtRef.current : Infinity;
      if (age > FRESH_MS) setCorpusGen((g) => g + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [needsCorpus]);

  // Grenze „noch verlinkt" ↔ „rausgeflogen": JE QUELLE die jüngste LINK-SICHTUNG minus die
  // quellenspezifische Toleranz (Discovery-Abdeckung ist strukturell verschieden — n-tv wird
  // stündlich komplett gesehen, Tagesschau/FAZ ohne Sitemap nur gesampelt; s. ONLINE_TOLERANCE_H).
  // Vorher: jüngster SCAN-Stand − 90 min (falsche Größe, 41 % Scheinabgänge), dann globale 6 h
  // (für Tagesschau 78 % Fehlalarm). EINE Wahrheit für Bestand-Filter + Fluktuations-KPIs.
  const onlineCut = useMemo(() => onlineCutsFrom(corpus), [corpus]);

  // Keyword → Artikel-IDs (zentral, damit Tabelle UND Analytics dieselbe Menge nutzen)
  const [kwIds, setKwIds] = useState<number[] | null>(null);
  useEffect(() => {
    if (keyword === "all") { setKwIds(null); return; }
    let cancelled = false;
    supabase.from("article_keywords").select("article_id, keywords!inner(term)").eq("keywords.term", keyword)
      .then(({ data }) => { if (!cancelled) setKwIds((data ?? []).map((r: any) => r.article_id)); });
    return () => { cancelled = true; };
  }, [keyword]);

  // VOLLTEXTSUCHE → Artikel-IDs: durchsucht serverseitig Titel/URL/Teaser/Thema/Schlagwörter/
  // Rubriken (RPC search_articles; Artikelinhalt-Suche 2026-07-05 entfernt, DB-Limit). Entprellt; ein
  // Kaltstart-500 wird einmal wiederholt. Die Treffer schränken — wie der Keyword-Filter —
  // Tabelle UND Analytik ein (mit dem Keyword-Filter UND-verknüpft).
  const [searchIds, setSearchIds] = useState<number[] | null>(null);
  const [searchPending, setSearchPending] = useState(false);
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setSearchIds(null); setSearchPending(false); return; }
    let cancelled = false;
    setSearchPending(true);
    const run = (attempt: number) => {
      const ts = timeoutSignal();
      supabase.rpc("search_articles", { p_q: q, p_sources: active.size ? [...active] : null, p_limit: 1200 })
        .abortSignal(ts.signal)
        .then(({ data, error }) => {
          ts.done();
          if (cancelled) return;
          if (error) { if (attempt < 1) { setTimeout(() => run(attempt + 1), 500); return; } setSearchIds([]); setSearchPending(false); return; }
          setSearchIds((data ?? []).map((r: any) => r.article_id)); setSearchPending(false);
        });
    };
    const t = setTimeout(() => run(0), 280);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, active]);

  // MEHRFACH-SUCHE: jeder Chip-Begriff wird eigenständig per RPC gesucht (parallel, mit einem
  // Kaltstart-Retry wie die Live-Suche). Ergebnis je Begriff gecacht in termIds.
  const [termIds, setTermIds] = useState<Map<string, number[]>>(new Map());
  useEffect(() => {
    if (!searchTerms.length) { setTermIds(new Map()); return; }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(searchTerms.map(async (t): Promise<[string, number[]]> => {
        for (let attempt = 0; ; attempt++) {
          const ts = timeoutSignal();
          const { data, error } = await supabase.rpc("search_articles", { p_q: t, p_sources: active.size ? [...active] : null, p_limit: 1200 }).abortSignal(ts.signal);
          ts.done();
          if (!error) return [t, (data ?? []).map((r: any) => r.article_id)];
          if (attempt >= 1) return [t, []];
          await new Promise((res) => setTimeout(res, 500));
        }
      }));
      if (!cancelled) setTermIds(new Map(entries));
    })();
    return () => { cancelled = true; };
  }, [searchTerms.join("|"), active]);
  // Trefferzahl je Chip (null = lädt noch) — fürs Chip-Label im Filterpanel.
  const termCounts = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const t of searchTerms) m.set(t, termIds.has(t) ? termIds.get(t)!.length : null);
    return m;
  }, [searchTerms.join("|"), termIds]);
  // Chips + Live-Eingabe wirken zusammen als EIN Such-Filter: ODER-verknüpft (Vereinigung).
  const combinedSearchIds = useMemo(() => {
    if (!searchTerms.length) return searchIds;
    const u = new Set<number>();
    for (const t of searchTerms) for (const id of termIds.get(t) ?? []) u.add(id);
    if (searchIds) for (const id of searchIds) u.add(id);
    return [...u];
  }, [searchIds, termIds, searchTerms.join("|")]);

  // Keyword- UND Such-IDs zu EINER ID-Restriktion verschmelzen (Schnittmenge; null = keine).
  const effKwIds = useMemo(() => {
    if (kwIds == null) return combinedSearchIds;
    if (combinedSearchIds == null) return kwIds;
    const ss = new Set(combinedSearchIds); return kwIds.filter((x) => ss.has(x));
  }, [kwIds, combinedSearchIds]);
  const kwIdSet = useMemo(() => (effKwIds ? new Set(effKwIds) : null), [effKwIds]);
  const searchCount = useMemo(() => (search.trim().length < 2 ? null : (searchIds?.length ?? null)), [search, searchIds]);

  // dynamische Topic-Optionen — aus dem Corpus, mit dem GLEICHEN Prädikat wie die Tabelle
  // (alle Filter außer Themen/Rubriken selbst). Zählt damit exakt das, was die Tabelle zeigt.
  useEffect(() => {
    if (!active.size || !corpusReady) { if (!active.size) setTopicOpts([]); return; }
    const snap = snapshotOf({ status, paywall, atype, author, topics, lang, changed, depth, rangeFrom, rangeTo, timeAxis, hideRegional, linkState, onlineCut } as any);
    const match = makeMatcher(snap, [], kwIdSet, { topics: true });
    const counts = new Map<string, number>();
    for (const r of corpus) {
      if (!active.has(r.source_id)) continue;
      if (!match(r)) continue;
      const t = r.topic ?? "sonstiges";
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    setTopicOpts([...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([key, n]) => ({ key, label: topicLabel(key), n })));
  }, [corpus, corpusReady, active, status, paywall, atype, author, lang, changed, depth, hideRegional, linkState, onlineCut, rangeFrom, rangeTo, timeAxis, kwIdSet]);

  // Unterthemen-Baum: verlagseigene Rubriken je kanonischem Topic — abgeleitet aus dem
  // URL-PFAD (nicht aus article_categories, das bei Bild/FAZ/n-tv/Tagesschau leer ist).
  // Zählt über den Corpus mit dem Tabellen-Prädikat (ohne Themen-Dimension).
  const [catTree, setCatTree] = useState<Map<string, SubOpt[]>>(new Map());
  useEffect(() => {
    if (!active.size || !corpusReady) { if (!active.size) setCatTree(new Map()); return; }
    const snap = snapshotOf({ status, paywall, atype, author, topics, lang, changed, depth, rangeFrom, rangeTo, timeAxis, hideRegional, linkState, onlineCut } as any);
    const match = makeMatcher(snap, [], kwIdSet, { topics: true });
    // raw-Rubriken je Topic sammeln (alle aktiven Quellen)
    const agg = new Map<string, Map<string, { label: string; n: number; src: Set<number> }>>();
    for (const r of corpus) {
      if (!active.has(r.source_id)) continue;
      if (!match(r)) continue;
      // Ressort-Baum: bei n-tv trägt die gespeicherte URL (idN.html) kein Ressort → dann die
      // sektionierte `rubric`-URL (og:url/canonical, vom Scraper gespeichert) nutzen.
      const rubric = urlRubric(r.rubric || r.url);
      if (!rubric) continue;
      const topic = r.topic ?? "sonstiges";
      if (!agg.has(topic)) agg.set(topic, new Map());
      const m = agg.get(topic)!;
      const e = m.get(rubric.raw) ?? { label: rubric.label, n: 0, src: new Set<number>() };
      e.n++; e.src.add(r.source_id);
      m.set(rubric.raw, e);
    }
    // Mehrsprachige Rubriken zu kanonischen Kategorien bündeln:
    // "politik/ausland" + "politique/international" → beide unter "international"
    const tree = new Map<string, SubOpt[]>();
    for (const [topic, m] of agg) {
      const groups = new Map<string, { label: string; n: number; src: Set<number>; rawKeys: string[]; topN: number }>();
      for (const [raw, entry] of m) {
        if (entry.n < 3) continue;
        const cKey = toCanonKey(entry.label) ?? raw.replace(/\//g, "_");
        const g = groups.get(cKey);
        if (g) {
          g.n += entry.n;
          entry.src.forEach((id) => g.src.add(id));
          g.rawKeys.push(raw);
          if (entry.n > g.topN) { g.topN = entry.n; g.label = canonLabel(cKey, entry.label); }
        } else {
          groups.set(cKey, { label: canonLabel(cKey, entry.label), n: entry.n, src: new Set(entry.src), rawKeys: [raw], topN: entry.n });
        }
      }
      const list = [...groups.entries()]
        .map(([key, g]) => ({ key, label: g.label, n: g.n, sources: g.src.size, rawKeys: g.rawKeys }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 24);
      if (list.length) tree.set(topic, list);
    }
    setCatTree(tree);
  }, [corpus, corpusReady, active, status, paywall, atype, author, lang, changed, depth, hideRegional, linkState, onlineCut, rangeFrom, rangeTo, timeAxis, kwIdSet]);

  // Gewählte Sub-Rubriken → rohe URL-Muster (mehrsprachig, quellenübergreifend)
  const subPats = useMemo(() => {
    if (!subcats.length) return [];
    return subcats.flatMap((key) => {
      for (const opts of catTree.values()) {
        const opt = opts.find((o) => o.key === key);
        if (opt) return opt.rawKeys;
      }
      return [key];
    });
  }, [subcats.join("|||"), catTree]);

  // SubTopicBar-Optionen: abgeleitet aus dem Baum (bei genau einem gewählten Topic)
  useEffect(() => {
    setSubOpts(topics.length === 1 ? (catTree.get(topics[0]) ?? []) : []);
  }, [topics.join(","), catTree]);

  // dynamische Keyword-Optionen (voller Filtersatz)
  useEffect(() => {
    if (!active.size) { setKeywordOpts([]); return; }
    // Bei ausgeblendetem Regional die positive Themen-Liste „alle außer regional" durchreichen
    // (die RPC kennt nur p_topics; verifiziert: DB-Topics = exakt die kanonischen Schlüssel).
    supabase.rpc("keyword_opts_f", { p_sources: [...active], p_topics: topics.length ? topics : (hideRegional ? TOPICS_SANS_REGIONAL : null), p_paywall: nn(paywall), p_author: nn(author), p_lang: nn(lang), p_from: rangeFrom, p_to: rangeTo })
      .then(({ data }) => setKeywordOpts((data ?? []).map((r: any) => ({ key: r.term, label: r.term, n: r.n }))));
  }, [active, topics.join(","), hideRegional, paywall, author, lang, rangeFrom, rangeTo]);

  const toggle = (id: number) => setActive((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setAll = (on: boolean) => setActive(on ? new Set(sources.map((s) => s.id)) : new Set());
  const activeArr = useMemo(() => [...active], [active]);
  // Manuelle Range-Änderung hebt einen aktiven Pinpoint auf (keine zwei Zeitfilter gleichzeitig).
  const setRangeIdxClearPin = (r: { from: number; to: number }) => { setPinpoint(null); setRangeIdx(r); };

  // Alle Filter auf Ausgangszustand (Quellen wieder alle aktiv).
  const resetAll = () => {
    setStatus("all"); setPaywall("all"); setAtype("all"); setAuthor("all");
    setTopics([]); setSubcats([]); setKeyword("all"); setSearch(""); setSearchTerms([]); setLang("all");
    _setHideRegional(true); setLinkState("all");
    setChanged("all"); setDepth("all"); setPinpoint(null);
    _setWindowDays(30); setRangeIdx({ from: 0, to: 29 }); _setTimeAxis("published");
    setActive(new Set(sources.map((s) => s.id)));
  };

  const value: Ctx = {
    sources, active, activeArr, toggle, setAll,
    status, setStatus, paywall, setPaywall, atype, setAtype, author, setAuthor,
    topics, toggleTopic, setTopics, subcats, toggleSubcat, hideRegional, setHideRegional,
    linkState, setLinkState, onlineCut, keyword, setKeyword,
    search, setSearch, searchPending, searchCount,
    searchTerms, addSearchTerm, removeSearchTerm, termCounts, lang, setLang,
    changed, setChanged, depth, setDepth, resetAll,
    topicOpts, keywordOpts, subOpts, catTree,
    corpus, corpusReady, reloadCorpus, refreshing, corpusLoadedAt, corpusError, kwIds: effKwIds, kwIdSet, subPats,
    days, rangeIdx, setRangeIdx: setRangeIdxClearPin, rangeFrom, rangeTo, pinpoint, setPinpoint, trfOpen, setTrfOpen,
    windowDays, setWindowDays, timeAxis, setTimeAxis, ready,
  };
  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
