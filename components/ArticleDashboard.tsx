"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { FileText, Folder, Clock, External } from "@/components/icons";
import PublisherCompare from "@/components/PublisherCompare";
import TopicChart from "@/components/TopicChart";
import RateStats from "@/components/RateStats";
import TimeRangeFilter from "@/components/TimeRangeFilter";
import FilterPanel, { type Src } from "@/components/FilterPanel";
import { topicLabel } from "@/lib/topics";
import FilterPills from "@/components/FilterPills";

type Summary = { source_id: number; outlet: string; country: string; discovered: number; analyzed: number; backlog: number };
type Row = { id: number; article_id: number | null; url: string; outlet: string; country: string | null; analyzed: boolean; paywalled: boolean | null; ptype: string; topic: string | null; author_status: string | null };

const PTYPE: Record<string, { l: string; c: string }> = {
  artikel: { l: "Artikel", c: "neutral" }, paywall: { l: "Paywall", c: "lock" },
  video: { l: "Video", c: "media" }, werbung: { l: "Werbung", c: "wait" },
  hub: { l: "Hub", c: "neutral" }, blog: { l: "Blog", c: "info" }, timeline: { l: "Timeline", c: "info" },
};
const AUTHOR: Record<string, { l: string; c: string }> = {
  named: { l: "Autor", c: "ok" }, anonymous: { l: "Redaktion", c: "wait" },
};

const PAGE = 30;
function shortUrl(u: string) {
  try { const x = new URL(u); return { host: x.host.replace(/^www\./, ""), path: x.pathname }; } catch { return { host: "", path: u }; }
}
function makeDays(): string[] {
  const out: string[] = []; const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  for (let i = 59; i >= 0; i--) { const x = new Date(d); x.setUTCDate(x.getUTCDate() - i); out.push(x.toISOString().slice(0, 10)); }
  return out;
}

export default function ArticleDashboard() {
  const params = useSearchParams();
  const [summary, setSummary] = useState<Summary[]>([]);
  const [sources, setSources] = useState<Src[]>([]);
  const [active, setActive] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<Row[]>([]);
  const [rowKw, setRowKw] = useState<Record<number, string[]>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [sortCol, setSortCol] = useState<"src" | "type" | "topic" | "author" | "status">("status");

  // Filter
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState("all");
  const [paywall, setPaywall] = useState("all");
  const [atype, setAtype] = useState("all");
  const [author, setAuthor] = useState("all");
  const [topic, setTopic] = useState("all");
  const [keyword, setKeyword] = useState("all");
  const [lang, setLang] = useState("all");
  const [topicStats, setTopicStats] = useState<{ topic: string; source_id: number; n: number }[]>([]);
  const [kwStats, setKwStats] = useState<{ term: string; source_id: number; n: number }[]>([]);
  const [kwIds, setKwIds] = useState<number[] | null>(null);

  // Zeit-Range (Brush)
  const days = useMemo(makeDays, []);
  const [trfOpen, setTrfOpen] = useState(true);
  const [rangeIdx, setRangeIdx] = useState<{ from: number; to: number }>({ from: 0, to: 59 });
  const full = rangeIdx.from === 0 && rangeIdx.to === days.length - 1;
  const rangeFrom = full ? null : days[rangeIdx.from] + "T00:00:00Z";
  const rangeTo = full ? null : days[rangeIdx.to] + "T23:59:59Z";

  const savedActiveRef = useRef<number[] | null>(null);
  const savedPageRef = useRef<number>(0);
  const skipReset = useRef(false);

  // URL-Query-Params auslesen (z.B. ?source_id=5 von Silent Edits)
  useEffect(() => {
    const sourceId = params.get("source_id");
    const keyword_ = params.get("keyword");
    const topic_ = params.get("topic");
    if (sourceId) {
      const id = parseInt(sourceId, 10);
      if (!isNaN(id)) setActive((prev) => new Set([...prev, id]));
    }
    if (keyword_) setKeyword(keyword_);
    if (topic_) setTopic(topic_);
  }, [params]);

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
      if (typeof f.open === "boolean") setOpen(f.open);
      if (typeof f.trfOpen === "boolean") setTrfOpen(f.trfOpen);
      if (f.rangeIdx && typeof f.rangeIdx.from === "number") setRangeIdx(f.rangeIdx);
      if (typeof f.page === "number") savedPageRef.current = f.page;
      if (Array.isArray(f.activeIds)) savedActiveRef.current = f.activeIds;
    } catch {}
  }, []);

  useEffect(() => {
    (async () => {
      const [{ data: srcs }, { data: sum }, { data: ts }, { data: ks }] = await Promise.all([
        supabase.from("sources").select("id,name,base_url,country").eq("active", true),
        supabase.from("article_status_summary").select("*"),
        supabase.from("topic_stats").select("*"),
        supabase.from("keyword_stats").select("*"),
      ]);
      const s = (srcs as Src[]) ?? [];
      const ids = s.map((x) => x.id);
      const saved = savedActiveRef.current;
      skipReset.current = true;
      setSources(s);
      setActive(new Set(saved && saved.length ? saved.filter((id) => ids.includes(id)) : ids));
      setPage(savedPageRef.current);
      setSummary((sum as Summary[]) ?? []);
      setTopicStats((ts as any[]) ?? []);
      setKwStats((ks as any[]) ?? []);
      setUpdatedAt(new Date());
      setTimeout(() => { skipReset.current = false; }, 0);
    })();
  }, []);

  useEffect(() => {
    if (!sources.length) return;
    try {
      localStorage.setItem("margn-filters", JSON.stringify({
        activeIds: [...active], status, paywall, atype, author, topic, keyword, lang, open, trfOpen, rangeIdx, page,
      }));
    } catch {}
  }, [active, status, paywall, atype, author, topic, keyword, lang, open, trfOpen, rangeIdx, page, sources.length]);

  // Keyword → Artikel-IDs für Tabellenfilter
  useEffect(() => {
    if (keyword === "all") { setKwIds(null); return; }
    supabase.from("article_keywords").select("article_id, keywords!inner(term)").eq("keywords.term", keyword)
      .then(({ data }) => setKwIds((data ?? []).map((r: any) => r.article_id)));
  }, [keyword]);

  // Dynamische Topic-Optionen (abhängig von Zeitraum + Quellen + Sprache)
  useEffect(() => {
    supabase.rpc("topic_opts_f", {
      p_sources: [...active], p_lang: lang === "all" ? null : lang,
      p_from: rangeFrom, p_to: rangeTo,
    }).then(({ data }) => {
      const opts = data ? data.map((r: any) => ({ key: r.topic, label: topicLabel(r.topic), n: r.n })) : [];
      setTopicStats(data ?? []);
    });
  }, [active, lang, rangeFrom, rangeTo]);

  // Dynamische Keyword-Optionen (abhängig von Zeitraum + Quellen + Thema + Sprache)
  useEffect(() => {
    supabase.rpc("keyword_opts_f", {
      p_sources: [...active], p_topic: topic === "all" ? null : topic,
      p_lang: lang === "all" ? null : lang,
      p_from: rangeFrom, p_to: rangeTo,
    }).then(({ data }) => {
      setKwStats(data ?? []);
    });
  }, [active, topic, lang, rangeFrom, rangeTo]);

  const loadRows = useCallback(async () => {
    if (!active.size) { setRows([]); setTotal(0); return; }
    if (keyword !== "all" && kwIds === null) return; // warte auf IDs
    let q = supabase.from("page_overview").select("id,article_id,url,outlet,country,analyzed,paywalled,ptype,topic,author_status", { count: "exact" })
      .in("source_id", [...active]);
    if (status === "analyzed") q = q.eq("analyzed", true);
    else if (status === "backlog") q = q.eq("analyzed", false);
    if (paywall === "yes") q = q.eq("paywalled", true);
    else if (paywall === "no") q = q.eq("paywalled", false);
    if (atype !== "all") q = q.eq("ptype", atype);
    if (author !== "all") q = q.eq("author_status", author);
    if (topic !== "all") q = q.eq("topic", topic);
    if (lang !== "all") q = q.eq("language", lang);
    if (rangeFrom) q = q.gte("published_at", rangeFrom);
    if (rangeTo) q = q.lte("published_at", rangeTo);
    if (kwIds) q = q.in("article_id", kwIds.length ? kwIds : [-1]);
    const col = sortCol === "src" ? "outlet" : sortCol === "type" ? "ptype" : sortCol === "topic" ? "topic" : sortCol === "author" ? "author_status" : "analyzed";
    const { data, count } = await q.order(col, { ascending: sortCol === "status" }).range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as Row[]) ?? []);
    setTotal(count ?? 0);
  }, [active, status, paywall, atype, author, topic, lang, rangeFrom, rangeTo, kwIds, keyword, page, sortCol]);

  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { if (skipReset.current) return; setPage(0); }, [active, status, paywall, atype, author, topic, keyword, lang, rangeFrom, rangeTo]);

  // Keywords der sichtbaren Zeilen nachladen
  useEffect(() => {
    const ids = rows.map((r) => r.article_id).filter(Boolean) as number[];
    if (!ids.length) { setRowKw({}); return; }
    supabase.from("article_keywords").select("article_id, keywords(term)").in("article_id", ids).then(({ data }) => {
      const m: Record<number, string[]> = {};
      for (const r of (data ?? []) as any[]) { (m[r.article_id] ??= []).push(r.keywords?.term); }
      setRowKw(m);
    });
  }, [rows]);

  const toggle = (id: number) => setActive((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setAll = (on: boolean) => setActive(on ? new Set(sources.map((s) => s.id)) : new Set());

  const topicOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of topicStats) if (active.has(r.source_id)) m.set(r.topic, (m.get(r.topic) ?? 0) + r.n);
    return [...m.entries()].filter(([t]) => t !== "sonstiges").sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, label: topicLabel(key), n }));
  }, [topicStats, active]);

  const keywordOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of kwStats) if (active.has(r.source_id)) m.set(r.term, (m.get(r.term) ?? 0) + r.n);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([key, n]) => ({ key, label: key, n }));
  }, [kwStats, active]);

  const visSummary = useMemo(() => summary.filter((s) => active.has(s.source_id)), [summary, active]);
  const totals = useMemo(() => visSummary.reduce((a, s) => ({ d: a.d + s.discovered, an: a.an + s.analyzed, b: a.b + s.backlog }), { d: 0, an: 0, b: 0 }), [visSummary]);
  const pct = totals.d ? Math.round((totals.an / totals.d) * 100) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const activeArr = useMemo(() => [...active], [active]);
  const ctxLabel = `${total.toLocaleString("de-DE")} Treffer${topic !== "all" ? ` · ${topicLabel(topic)}` : ""}${keyword !== "all" ? ` · #${keyword}` : ""}`;

  return (
    <>
      <div className="topbar">
        <h1>Übersicht
          <Link href="/articles/edits" style={{ marginLeft: 16, fontSize: 13, fontWeight: 500, color: "var(--muted)" }}>→ Silent Edits</Link>
        </h1>
        <span className="live"><span className="live-dot" /> Live · {updatedAt ? updatedAt.toLocaleTimeString("de-DE") : "…"}</span>
      </div>

      <FilterPills sources={sources} activeSources={activeArr}
        status={status} setStatus={setStatus} paywall={paywall} setPaywall={setPaywall}
        atype={atype} setAtype={setAtype} author={author} setAuthor={setAuthor}
        topic={topic} setTopic={setTopic} keyword={keyword} setKeyword={setKeyword}
        lang={lang} setLang={setLang} toggleSource={toggle}
      />

      <div className="with-rail">
        <div className="page">
          <div className="kpi-strip">
            <div className="stat-tile"><div className="l"><Folder /> Quellen</div><div className="n tnum">{active.size}<span style={{ fontSize: 14, color: "var(--faint)" }}> / {sources.length}</span></div><div className="sub">ausgewählt</div></div>
            <div className="stat-tile"><div className="l"><FileText /> Entdeckt</div><div className="n tnum">{totals.d.toLocaleString("de-DE")}</div><div className="sub">Artikel gefunden</div></div>
            <div className="stat-tile"><div className="l"><Clock /> Analysiert</div><div className="n tnum">{totals.an.toLocaleString("de-DE")}</div><div className="sub">{totals.b.toLocaleString("de-DE")} im Backlog</div></div>
            <div className="stat-tile accent"><div className="l">Fortschritt</div><div className="n tnum">{pct}%</div><div className="bar"><i style={{ width: `${pct}%` }} /></div></div>
          </div>

          <RateStats sources={sources} activeSources={activeArr} />
          <PublisherCompare sources={sources} activeSources={activeArr} topic={topic} from={rangeFrom} to={rangeTo} />
          <TopicChart activeSources={activeArr} current={topic} onPick={setTopic} />

          <h2 className="section-h">Artikel <span className="count">{ctxLabel}</span></h2>
          <div className="panel">
            <table className="arttable">
              <thead><tr>
                <th className="c-src" style={{ cursor: "pointer" }} onClick={() => setSortCol("src")}>Quelle {sortCol === "src" && "↓"}</th>
                <th className="c-art">Seite</th>
                <th className="c-typ" style={{ cursor: "pointer" }} onClick={() => setSortCol("type")}>Typ {sortCol === "type" && "↓"}</th>
                <th className="c-topic" style={{ cursor: "pointer" }} onClick={() => setSortCol("topic")}>Thema {sortCol === "topic" && "↓"}</th>
                <th className="c-author" style={{ cursor: "pointer" }} onClick={() => setSortCol("author")}>Autor {sortCol === "author" && "↓"}</th>
                <th className="c-stat" style={{ cursor: "pointer" }} onClick={() => setSortCol("status")}>Status {sortCol === "status" && "↓"}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => {
                  const { host, path } = shortUrl(r.url);
                  const kws = r.article_id ? rowKw[r.article_id] : undefined;
                  return (
                    <tr key={r.id}>
                      <td className="cell-nowrap c-src">{r.outlet} <span className="cc">{r.country}</span></td>
                      <td>
                        <div className="art-row">
                          {r.article_id
                            ? <Link href={`/articles/${r.article_id}`} target="_blank" className="url mono" title={`Details: ${r.url}`}><span className="path">{host}</span>{path}</Link>
                            : <span className="url mono" title={r.url}><span className="path">{host}</span>{path}</span>}
                          <a href={r.url} target="_blank" rel="noreferrer" className="open-btn" title="Original öffnen" aria-label="Original öffnen"><External size={14} /></a>
                        </div>
                        {kws && kws.length > 0 && <div className="kw-row">{kws.slice(0, 5).map((k) => <span key={k} className="kw-chip">{k}</span>)}</div>}
                      </td>
                      <td className="c-typ cell-nowrap"><span className={`badge ${PTYPE[r.ptype]?.c ?? "neutral"}`}>{PTYPE[r.ptype]?.l ?? r.ptype}</span></td>
                      <td className="c-topic cell-nowrap faint">{r.topic ? topicLabel(r.topic) : "—"}</td>
                      <td className="c-author cell-nowrap">{r.author_status && AUTHOR[r.author_status] ? <span className={`badge ${AUTHOR[r.author_status].c}`}>{AUTHOR[r.author_status].l}</span> : <span className="faint">—</span>}</td>
                      <td className="cell-nowrap">{r.analyzed ? <span className="badge ok">analysiert</span> : <span className="badge wait">Backlog</span>}</td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={6} className="faint" style={{ padding: 28, textAlign: "center" }}>Keine Seiten für diese Filter.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Zurück</button>
            <span>Seite {page + 1} / {pages}</span>
            <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Weiter →</button>
          </div>

          <TimeRangeFilter sources={sources} activeSources={activeArr} fromIdx={rangeIdx.from} toIdx={rangeIdx.to}
            onChange={(f, t) => setRangeIdx({ from: f, to: t })} open={trfOpen} setOpen={setTrfOpen} />
        </div>

        <FilterPanel
          open={open} setOpen={setOpen} sources={sources}
          active={active} toggle={toggle} setAll={setAll}
          status={status} setStatus={setStatus} paywall={paywall} setPaywall={setPaywall}
          atype={atype} setAtype={setAtype} author={author} setAuthor={setAuthor}
          topic={topic} setTopic={setTopic} topics={topicOpts}
          keyword={keyword} setKeyword={setKeyword} keywords={keywordOpts}
          lang={lang} setLang={setLang}
        />
      </div>
    </>
  );
}
