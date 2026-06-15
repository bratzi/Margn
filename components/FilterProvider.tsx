"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { topicLabel } from "@/lib/topics";
import { fetchAllRows } from "@/lib/pgFetch";
import { ALLOWED_PTYPES, CORPUS_COLS, makeMatcher, snapshotOf, type CorpusRow } from "@/lib/filterCorpus";

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

function stripAccents(s: string) { return s.normalize("NFD").replace(/[̀-ͯ]/g, ""); }
function toCanonKey(rawLabel: string): string | null {
  const norm = stripAccents(rawLabel.toLowerCase()).replace(/[^a-z ]/g, " ");
  const words = norm.split(/\s+/).filter(Boolean);
  for (const cat of CANON_CATS) {
    if (cat.words.some((w) => words.includes(w) || norm.includes(w))) return cat.key;
  }
  const first = words.find((w) => w.length >= 3);
  return first ?? null;
}
function canonLabel(key: string, fallback: string): string {
  return CANON_CATS.find((c) => c.key === key)?.label ?? fallback;
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

function makeDays(): string[] {
  const out: string[] = []; const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  for (let i = 59; i >= 0; i--) { const x = new Date(d); x.setUTCDate(x.getUTCDate() - i); out.push(x.toISOString().slice(0, 10)); }
  return out;
}

type Ctx = {
  sources: Src[]; active: Set<number>; activeArr: number[];
  toggle: (id: number) => void; setAll: (on: boolean) => void;
  status: string; setStatus: (v: string) => void;
  paywall: string; setPaywall: (v: string) => void;
  atype: string; setAtype: (v: string) => void;
  author: string; setAuthor: (v: string) => void;
  topics: string[]; toggleTopic: (t: string) => void; setTopics: (a: string[]) => void;
  subcats: string[]; toggleSubcat: (c: string) => void;
  keyword: string; setKeyword: (v: string) => void;
  lang: string; setLang: (v: string) => void;
  // Stille Änderungen (revision_count) — Kernfeature des Observatoriums
  changed: string; setChanged: (v: string) => void;
  // Artikel-Tiefe nach Wortzahl (kurz < 300, mittel 300–900, lang > 900)
  depth: string; setDepth: (v: string) => void;
  // Alle Filter auf Ausgangszustand
  resetAll: () => void;
  topicOpts: Opt[]; keywordOpts: Opt[]; subOpts: SubOpt[];
  catTree: Map<string, SubOpt[]>;
  // Gemeinsamer Datenbestand für ALLE Analytics-Komponenten (eine Wahrheit, ein Prädikat).
  corpus: CorpusRow[]; corpusReady: boolean;
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

export type Pin = { from: string; to: string; sourceId?: number; label: string; limit?: number };

const FilterContext = createContext<Ctx | null>(null);
export const useFilters = () => useContext(FilterContext)!;

export default function FilterProvider({ children }: { children: React.ReactNode }) {
  const params = useSearchParams();
  const [sources, setSources] = useState<Src[]>([]);
  const [active, setActive] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState("all");
  const [paywall, setPaywall] = useState("all");
  const [atype, setAtype] = useState("all");
  const [author, setAuthor] = useState("all");
  const [topics, setTopics] = useState<string[]>([]);
  const [subcats, setSubcats] = useState<string[]>([]);
  const [subOpts, setSubOpts] = useState<SubOpt[]>([]);
  const [keyword, setKeyword] = useState("all");
  // Unterthemen bleiben beim Topic-Wechsel erhalten — sie sind über die Filter-Pills
  // jederzeit sichtbar und einzeln entfernbar.
  const toggleTopic = (t: string) => setTopics((p) => p.includes(t) ? p.filter((x) => x !== t) : [...p, t]);
  const toggleSubcat = (c: string) => setSubcats((p) => p.includes(c) ? p.filter((x) => x !== c) : [...p, c]);
  const [lang, setLang] = useState("all");
  const [changed, setChanged] = useState("all");
  const [depth, setDepth] = useState("all");
  const [topicOpts, setTopicOpts] = useState<Opt[]>([]);
  const [keywordOpts, setKeywordOpts] = useState<Opt[]>([]);
  const [ready, setReady] = useState(false);

  const days = useMemo(makeDays, []);
  const [trfOpen, setTrfOpen] = useState(true);
  const [rangeIdx, setRangeIdx] = useState<{ from: number; to: number }>({ from: 0, to: 59 });
  const [pinpoint, setPinpoint] = useState<Pin | null>(null);
  const full = rangeIdx.from === 0 && rangeIdx.to === days.length - 1;
  // Pinpoint (Chart-Klick) hat Vorrang über den Tages-Range für die Tabellen-Abfrage.
  const rangeFrom = pinpoint ? pinpoint.from : (full ? null : days[rangeIdx.from] + "T00:00:00Z");
  const rangeTo = pinpoint ? pinpoint.to : (full ? null : days[rangeIdx.to] + "T23:59:59Z");

  const savedActiveRef = useRef<number[] | null>(null);

  // URL-Params
  useEffect(() => {
    const sid = params.get("source_id"); const kw = params.get("keyword"); const tp = params.get("topic");
    if (sid) { const id = parseInt(sid, 10); if (!isNaN(id)) setActive((p) => new Set([...p, id])); }
    if (kw) setKeyword(kw);
    if (tp) setTopics([tp]);
  }, [params]);

  // gespeicherte Filter laden
  useEffect(() => {
    try {
      const f = JSON.parse(localStorage.getItem("margn-filters") || "{}");
      if (f.status) setStatus(f.status);
      if (f.paywall) setPaywall(f.paywall);
      if (f.atype) setAtype(f.atype);
      if (f.author) setAuthor(f.author);
      if (Array.isArray(f.topics)) setTopics(f.topics); else if (f.topic && f.topic !== "all") setTopics([f.topic]);
      if (f.keyword) setKeyword(f.keyword);
      if (f.lang) setLang(f.lang);
      if (f.changed) setChanged(f.changed);
      if (f.depth) setDepth(f.depth);
      if (typeof f.trfOpen === "boolean") setTrfOpen(f.trfOpen);
      if (f.rangeIdx && typeof f.rangeIdx.from === "number") setRangeIdx(f.rangeIdx);
      if (Array.isArray(f.activeIds)) savedActiveRef.current = f.activeIds;
    } catch {}
  }, []);

  // Quellen laden
  useEffect(() => {
    supabase.from("sources").select("id,name,base_url,country").eq("active", true).then(({ data }) => {
      const s = (data as Src[]) ?? []; const ids = s.map((x) => x.id);
      const saved = savedActiveRef.current;
      setSources(s);
      setActive(new Set(saved && saved.length ? saved.filter((id) => ids.includes(id)) : ids));
      setReady(true);
    });
  }, []);

  // persistieren
  useEffect(() => {
    if (!sources.length) return;
    try {
      localStorage.setItem("margn-filters", JSON.stringify({
        activeIds: [...active], status, paywall, atype, author, topics, keyword, lang, changed, depth, trfOpen, rangeIdx,
      }));
    } catch {}
  }, [active, status, paywall, atype, author, topics, keyword, lang, changed, depth, trfOpen, rangeIdx, sources.length]);

  const nn = (v: string) => (v === "all" ? null : v);

  // ---------- Gemeinsamer Corpus: EINMAL laden, alle Komponenten zählen darüber ----------
  // page_overview (nur erlaubte Seitentypen), neueste zuerst — wächst der Bestand über das
  // Limit, fallen die ältesten raus. Langfristig gehört das in Server-Aggregation (RPCs),
  // für den aktuellen Datenumfang ist der Client-Corpus die konsistenteste Lösung.
  const [corpus, setCorpus] = useState<CorpusRow[]>([]);
  const [corpusReady, setCorpusReady] = useState(false);
  const [corpusGen, setCorpusGen] = useState(0); // erhöht = Neuladen
  useEffect(() => {
    if (!sources.length) return;
    let cancelled = false;
    fetchAllRows<CorpusRow>(
      () => supabase.from("page_overview").select("id", { count: "exact", head: true }).in("ptype", ALLOWED_PTYPES),
      (a, b) => supabase.from("page_overview").select(CORPUS_COLS).in("ptype", ALLOWED_PTYPES)
        .order("discovered_at", { ascending: false }).range(a, b) as any,
      // Cap der clientseitigen Analytics-Menge (neueste zuerst). Angehoben, damit
      // Charts/Optionen auch bei größerem/älterem Bestand vollständig sind.
      // Langfristig gehört diese Aggregation server-seitig (RPC), dann cap-frei.
      100000,
    ).then((rows) => { if (!cancelled) { setCorpus(rows); setCorpusReady(true); } });
    return () => { cancelled = true; };
  }, [sources.length, corpusGen]);
  // Der Scraper schreibt alle 2 h; ein 10-Minuten-Refresh hält die Zählungen aktuell,
  // ohne bei jeder Filteränderung neu zu laden (Filtern bleibt rein clientseitig).
  useEffect(() => {
    const t = setInterval(() => setCorpusGen((g) => g + 1), 10 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Keyword → Artikel-IDs (zentral, damit Tabelle UND Analytics dieselbe Menge nutzen)
  const [kwIds, setKwIds] = useState<number[] | null>(null);
  useEffect(() => {
    if (keyword === "all") { setKwIds(null); return; }
    let cancelled = false;
    supabase.from("article_keywords").select("article_id, keywords!inner(term)").eq("keywords.term", keyword)
      .then(({ data }) => { if (!cancelled) setKwIds((data ?? []).map((r: any) => r.article_id)); });
    return () => { cancelled = true; };
  }, [keyword]);
  const kwIdSet = useMemo(() => (kwIds ? new Set(kwIds) : null), [kwIds]);

  // dynamische Topic-Optionen — aus dem Corpus, mit dem GLEICHEN Prädikat wie die Tabelle
  // (alle Filter außer Themen/Rubriken selbst). Zählt damit exakt das, was die Tabelle zeigt.
  useEffect(() => {
    if (!active.size || !corpusReady) { if (!active.size) setTopicOpts([]); return; }
    const snap = snapshotOf({ status, paywall, atype, author, topics, lang, changed, depth, rangeFrom, rangeTo } as any);
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
  }, [corpus, corpusReady, active, status, paywall, atype, author, lang, changed, depth, rangeFrom, rangeTo, kwIdSet]);

  // Unterthemen-Baum: verlagseigene Rubriken je kanonischem Topic — abgeleitet aus dem
  // URL-PFAD (nicht aus article_categories, das bei Bild/FAZ/n-tv/Tagesschau leer ist).
  // Zählt über den Corpus mit dem Tabellen-Prädikat (ohne Themen-Dimension).
  const [catTree, setCatTree] = useState<Map<string, SubOpt[]>>(new Map());
  useEffect(() => {
    if (!active.size || !corpusReady) { if (!active.size) setCatTree(new Map()); return; }
    const snap = snapshotOf({ status, paywall, atype, author, topics, lang, changed, depth, rangeFrom, rangeTo } as any);
    const match = makeMatcher(snap, [], kwIdSet, { topics: true });
    // raw-Rubriken je Topic sammeln (alle aktiven Quellen)
    const agg = new Map<string, Map<string, { label: string; n: number; src: Set<number> }>>();
    for (const r of corpus) {
      if (!active.has(r.source_id)) continue;
      if (!match(r)) continue;
      const rubric = urlRubric(r.url);
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
  }, [corpus, corpusReady, active, status, paywall, atype, author, lang, changed, depth, rangeFrom, rangeTo, kwIdSet]);

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
    supabase.rpc("keyword_opts_f", { p_sources: [...active], p_topics: topics.length ? topics : null, p_paywall: nn(paywall), p_author: nn(author), p_lang: nn(lang), p_from: rangeFrom, p_to: rangeTo })
      .then(({ data }) => setKeywordOpts((data ?? []).map((r: any) => ({ key: r.term, label: r.term, n: r.n }))));
  }, [active, topics.join(","), paywall, author, lang, rangeFrom, rangeTo]);

  const toggle = (id: number) => setActive((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setAll = (on: boolean) => setActive(on ? new Set(sources.map((s) => s.id)) : new Set());
  const activeArr = useMemo(() => [...active], [active]);
  // Manuelle Range-Änderung hebt einen aktiven Pinpoint auf (keine zwei Zeitfilter gleichzeitig).
  const setRangeIdxClearPin = (r: { from: number; to: number }) => { setPinpoint(null); setRangeIdx(r); };

  // Alle Filter auf Ausgangszustand (Quellen wieder alle aktiv).
  const resetAll = () => {
    setStatus("all"); setPaywall("all"); setAtype("all"); setAuthor("all");
    setTopics([]); setSubcats([]); setKeyword("all"); setLang("all");
    setChanged("all"); setDepth("all"); setPinpoint(null);
    setRangeIdx({ from: 0, to: days.length - 1 });
    setActive(new Set(sources.map((s) => s.id)));
  };

  const value: Ctx = {
    sources, active, activeArr, toggle, setAll,
    status, setStatus, paywall, setPaywall, atype, setAtype, author, setAuthor,
    topics, toggleTopic, setTopics, subcats, toggleSubcat, keyword, setKeyword, lang, setLang,
    changed, setChanged, depth, setDepth, resetAll,
    topicOpts, keywordOpts, subOpts, catTree,
    corpus, corpusReady, kwIds, kwIdSet, subPats,
    days, rangeIdx, setRangeIdx: setRangeIdxClearPin, rangeFrom, rangeTo, pinpoint, setPinpoint, trfOpen, setTrfOpen, ready,
  };
  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
