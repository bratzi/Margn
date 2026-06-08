"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { topicLabel } from "@/lib/topics";

export type Src = { id: number; name: string; country: string; base_url: string };
type Opt = { key: string; label: string; n: number };

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
  topic: string; setTopic: (v: string) => void;
  keyword: string; setKeyword: (v: string) => void;
  lang: string; setLang: (v: string) => void;
  topicOpts: Opt[]; keywordOpts: Opt[];
  days: string[]; rangeIdx: { from: number; to: number }; setRangeIdx: (r: { from: number; to: number }) => void;
  rangeFrom: string | null; rangeTo: string | null;
  trfOpen: boolean; setTrfOpen: (b: boolean) => void;
  ready: boolean;
};

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
  const [topic, setTopic] = useState("all");
  const [keyword, setKeyword] = useState("all");
  const [lang, setLang] = useState("all");
  const [topicOpts, setTopicOpts] = useState<Opt[]>([]);
  const [keywordOpts, setKeywordOpts] = useState<Opt[]>([]);
  const [ready, setReady] = useState(false);

  const days = useMemo(makeDays, []);
  const [trfOpen, setTrfOpen] = useState(true);
  const [rangeIdx, setRangeIdx] = useState<{ from: number; to: number }>({ from: 0, to: 59 });
  const full = rangeIdx.from === 0 && rangeIdx.to === days.length - 1;
  const rangeFrom = full ? null : days[rangeIdx.from] + "T00:00:00Z";
  const rangeTo = full ? null : days[rangeIdx.to] + "T23:59:59Z";

  const savedActiveRef = useRef<number[] | null>(null);

  // URL-Params
  useEffect(() => {
    const sid = params.get("source_id"); const kw = params.get("keyword"); const tp = params.get("topic");
    if (sid) { const id = parseInt(sid, 10); if (!isNaN(id)) setActive((p) => new Set([...p, id])); }
    if (kw) setKeyword(kw);
    if (tp) setTopic(tp);
  }, [params]);

  // gespeicherte Filter laden
  useEffect(() => {
    try {
      const f = JSON.parse(localStorage.getItem("margn-filters") || "{}");
      if (f.status) setStatus(f.status);
      if (f.paywall) setPaywall(f.paywall);
      if (f.atype) setAtype(f.atype);
      if (f.author) setAuthor(f.author);
      if (f.topic) setTopic(f.topic);
      if (f.keyword) setKeyword(f.keyword);
      if (f.lang) setLang(f.lang);
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
        activeIds: [...active], status, paywall, atype, author, topic, keyword, lang, trfOpen, rangeIdx,
      }));
    } catch {}
  }, [active, status, paywall, atype, author, topic, keyword, lang, trfOpen, rangeIdx, sources.length]);

  const nn = (v: string) => (v === "all" ? null : v);

  // dynamische Topic-Optionen (voller Filtersatz)
  useEffect(() => {
    if (!active.size) { setTopicOpts([]); return; }
    supabase.rpc("topic_opts_f", { p_sources: [...active], p_paywall: nn(paywall), p_author: nn(author), p_lang: nn(lang), p_from: rangeFrom, p_to: rangeTo })
      .then(({ data }) => setTopicOpts((data ?? []).filter((r: any) => r.topic !== "sonstiges").map((r: any) => ({ key: r.topic, label: topicLabel(r.topic), n: r.n }))));
  }, [active, paywall, author, lang, rangeFrom, rangeTo]);

  // dynamische Keyword-Optionen (voller Filtersatz)
  useEffect(() => {
    if (!active.size) { setKeywordOpts([]); return; }
    supabase.rpc("keyword_opts_f", { p_sources: [...active], p_topic: nn(topic), p_paywall: nn(paywall), p_author: nn(author), p_lang: nn(lang), p_from: rangeFrom, p_to: rangeTo })
      .then(({ data }) => setKeywordOpts((data ?? []).map((r: any) => ({ key: r.term, label: r.term, n: r.n }))));
  }, [active, topic, paywall, author, lang, rangeFrom, rangeTo]);

  const toggle = (id: number) => setActive((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setAll = (on: boolean) => setActive(on ? new Set(sources.map((s) => s.id)) : new Set());
  const activeArr = useMemo(() => [...active], [active]);

  const value: Ctx = {
    sources, active, activeArr, toggle, setAll,
    status, setStatus, paywall, setPaywall, atype, setAtype, author, setAuthor,
    topic, setTopic, keyword, setKeyword, lang, setLang, topicOpts, keywordOpts,
    days, rangeIdx, setRangeIdx, rangeFrom, rangeTo, trfOpen, setTrfOpen, ready,
  };
  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}
