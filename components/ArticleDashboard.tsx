"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { FileText, Folder, Clock } from "@/components/icons";
import PublisherCompare from "@/components/PublisherCompare";
import TopicChart from "@/components/TopicChart";
import FilterPanel, { type Src } from "@/components/FilterPanel";
import { topicLabel } from "@/lib/topics";

type Summary = { source_id: number; outlet: string; country: string; discovered: number; analyzed: number; backlog: number };
type Row = { id: number; article_id: number | null; url: string; outlet: string; country: string | null; discovered_at: string; analyzed: boolean; paywalled: boolean | null };

const PAGE = 30;
function shortUrl(u: string) {
  try { const x = new URL(u); return { host: x.host.replace(/^www\./, ""), path: x.pathname }; } catch { return { host: "", path: u }; }
}
const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const cutoff = (p: string) => {
  const d = new Date();
  if (p === "24h") d.setHours(d.getHours() - 24);
  else if (p === "7d") d.setDate(d.getDate() - 7);
  else if (p === "30d") d.setDate(d.getDate() - 30);
  else return null;
  return d.toISOString();
};

export default function ArticleDashboard() {
  const [summary, setSummary] = useState<Summary[]>([]);
  const [sources, setSources] = useState<Src[]>([]);
  const [active, setActive] = useState<Set<number>>(new Set());
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  // Filter
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState("all");
  const [paywall, setPaywall] = useState("all");
  const [atype, setAtype] = useState("all");
  const [author, setAuthor] = useState("all");
  const [topic, setTopic] = useState("all");
  const [lang, setLang] = useState("all");
  const [period, setPeriod] = useState("all");
  const [topicStats, setTopicStats] = useState<{ topic: string; source_id: number; n: number }[]>([]);

  // Quellen + Summary laden
  useEffect(() => {
    (async () => {
      const [{ data: srcs }, { data: sum }, { data: ts }] = await Promise.all([
        supabase.from("sources").select("id,name,base_url,country").eq("active", true),
        supabase.from("article_status_summary").select("*"),
        supabase.from("topic_stats").select("*"),
      ]);
      const s = (srcs as Src[]) ?? [];
      setSources(s);
      setActive(new Set(s.map((x) => x.id)));
      setSummary((sum as Summary[]) ?? []);
      setTopicStats((ts as any[]) ?? []);
      setUpdatedAt(new Date());
    })();
  }, []);

  const loadRows = useCallback(async () => {
    if (!active.size) { setRows([]); setTotal(0); return; }
    let q = supabase.from("article_status").select("id,article_id,url,outlet,country,discovered_at,analyzed,paywalled", { count: "exact" })
      .in("source_id", [...active]);
    if (status === "analyzed") q = q.eq("analyzed", true);
    else if (status === "backlog") q = q.eq("analyzed", false);
    if (paywall === "yes") q = q.eq("paywalled", true);
    else if (paywall === "no") q = q.eq("paywalled", false);
    if (atype !== "all") q = q.eq("article_type", atype);
    if (author !== "all") q = q.eq("author_status", author);
    if (topic !== "all") q = q.eq("topic", topic);
    if (lang !== "all") q = q.eq("language", lang);
    const c = cutoff(period);
    if (c) q = q.gte("published_at", c);
    const { data, count } = await q.order("discovered_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as Row[]) ?? []);
    setTotal(count ?? 0);
  }, [active, status, paywall, atype, author, topic, lang, period, page]);

  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { setPage(0); }, [active, status, paywall, atype, author, topic, lang, period]);

  const toggle = (id: number) => setActive((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setAll = (on: boolean) => setActive(on ? new Set(sources.map((s) => s.id)) : new Set());

  const topicOpts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of topicStats) if (active.has(r.source_id)) m.set(r.topic, (m.get(r.topic) ?? 0) + r.n);
    return [...m.entries()].filter(([t]) => t !== "sonstiges").sort((a, b) => b[1] - a[1])
      .map(([key, n]) => ({ key, label: topicLabel(key), n }));
  }, [topicStats, active]);

  const visSummary = useMemo(() => summary.filter((s) => active.has(s.source_id)), [summary, active]);
  const totals = useMemo(() => visSummary.reduce((a, s) => ({ d: a.d + s.discovered, an: a.an + s.analyzed, b: a.b + s.backlog }), { d: 0, an: 0, b: 0 }), [visSummary]);
  const pct = totals.d ? Math.round((totals.an / totals.d) * 100) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <div className="topbar">
        <h1>Übersicht</h1>
        <span className="live"><span className="live-dot" /> Live · {updatedAt ? updatedAt.toLocaleTimeString("de-DE") : "…"}</span>
      </div>

      <div className="with-rail">
        <div className="page">
          <div className="kpi-strip">
            <div className="stat-tile"><div className="l"><Folder /> Quellen</div><div className="n tnum">{active.size}<span style={{ fontSize: 14, color: "var(--faint)" }}> / {sources.length}</span></div><div className="sub">ausgewählt</div></div>
            <div className="stat-tile"><div className="l"><FileText /> Entdeckt</div><div className="n tnum">{totals.d.toLocaleString("de-DE")}</div><div className="sub">Artikel gefunden</div></div>
            <div className="stat-tile"><div className="l"><Clock /> Analysiert</div><div className="n tnum">{totals.an.toLocaleString("de-DE")}</div><div className="sub">{totals.b.toLocaleString("de-DE")} im Backlog</div></div>
            <div className="stat-tile accent"><div className="l">Fortschritt</div><div className="n tnum">{pct}%</div><div className="bar"><i style={{ width: `${pct}%` }} /></div></div>
          </div>

          <PublisherCompare activeSources={[...active]} />

          <TopicChart activeSources={[...active]} current={topic} onPick={setTopic} />

          <h2 className="section-h">Artikel <span className="count">{total.toLocaleString("de-DE")} Treffer{topic !== "all" ? ` · ${topicLabel(topic)}` : ""}</span></h2>
          <div className="panel">
            <table>
              <thead><tr><th>Quelle</th><th>Artikel</th><th>Entdeckt</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const { host, path } = shortUrl(r.url);
                  return (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{r.outlet} <span className="cc">{r.country}</span></td>
                      <td>
                        {r.article_id
                          ? <Link href={`/articles/${r.article_id}`} className="url" title={r.url}><span className="mono"><span className="path">{host}</span>{path}</span></Link>
                          : <a href={r.url} target="_blank" rel="noreferrer" className="url" title={r.url}><span className="mono"><span className="path">{host}</span>{path}</span></a>}
                      </td>
                      <td className="mono faint" style={{ whiteSpace: "nowrap" }}>{fmt(r.discovered_at)}</td>
                      <td>
                        {r.paywalled ? <span className="badge lock">Paywall</span> : null}
                        {r.analyzed ? <span className="badge ok">analysiert</span> : <span className="badge wait">Backlog</span>}
                      </td>
                    </tr>
                  );
                })}
                {!rows.length && <tr><td colSpan={4} className="faint" style={{ padding: 28, textAlign: "center" }}>Keine Artikel für diese Filter.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Zurück</button>
            <span>Seite {page + 1} / {pages}</span>
            <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Weiter →</button>
          </div>
        </div>

        <FilterPanel
          open={open} setOpen={setOpen} sources={sources}
          active={active} toggle={toggle} setAll={setAll}
          status={status} setStatus={setStatus} paywall={paywall} setPaywall={setPaywall}
          atype={atype} setAtype={setAtype} author={author} setAuthor={setAuthor}
          topic={topic} setTopic={setTopic} topics={topicOpts}
          lang={lang} setLang={setLang} period={period} setPeriod={setPeriod}
        />
      </div>
    </>
  );
}
