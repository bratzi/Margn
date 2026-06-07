"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { FileText, Folder, Clock } from "@/components/icons";
import PublisherCompare from "@/components/PublisherCompare";

type Summary = { source_id: number; outlet: string; country: string; discovered: number; analyzed: number; backlog: number };
type Row = { id: number; article_id: number | null; url: string; outlet: string; country: string | null; discovered_at: string; analyzed: boolean };
type Mode = "all" | "analyzed" | "backlog";

const PAGE = 30;
const MODES: { k: Mode; l: string }[] = [{ k: "all", l: "Alle" }, { k: "analyzed", l: "Analysiert" }, { k: "backlog", l: "Backlog" }];

function shortUrl(u: string) {
  try { const x = new URL(u); return { host: x.host.replace(/^www\./, ""), path: x.pathname }; }
  catch { return { host: "", path: u }; }
}
const fmt = (iso: string | null) => iso ? new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export default function ArticleDashboard() {
  const [summary, setSummary] = useState<Summary[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<Mode>("all");
  const [outlet, setOutlet] = useState("all");
  const [page, setPage] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const loadStats = useCallback(async () => {
    const { data } = await supabase.from("article_status_summary").select("*");
    setSummary((data as Summary[]) ?? []);
    setUpdatedAt(new Date());
  }, []);

  const loadRows = useCallback(async () => {
    let q = supabase.from("article_status").select("id,article_id,url,outlet,country,discovered_at,analyzed", { count: "exact" });
    if (mode === "analyzed") q = q.eq("analyzed", true);
    else if (mode === "backlog") q = q.eq("analyzed", false);
    if (outlet !== "all") q = q.eq("outlet", outlet);
    const { data, count } = await q.order("discovered_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as Row[]) ?? []);
    setTotal(count ?? 0);
  }, [mode, outlet, page]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { const t = setInterval(() => { loadStats(); loadRows(); }, 20000); return () => clearInterval(t); }, [loadStats, loadRows]);

  const totals = useMemo(() => summary.reduce((a, s) => ({ d: a.d + s.discovered, an: a.an + s.analyzed, b: a.b + s.backlog }), { d: 0, an: 0, b: 0 }), [summary]);
  const pct = totals.d ? Math.round((totals.an / totals.d) * 100) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <div className="topbar">
        <h1>Übersicht</h1>
        <span className="live"><span className="live-dot" /> Live · {updatedAt ? updatedAt.toLocaleTimeString("de-DE") : "…"}</span>
      </div>

      <div className="page">
        {/* KPI-Strip */}
        <div className="kpi-strip">
          <div className="stat-tile"><div className="l"><Folder /> Quellen</div><div className="n tnum">{summary.length}</div><div className="sub">beobachtete Portale</div></div>
          <div className="stat-tile"><div className="l"><FileText /> Entdeckt</div><div className="n tnum">{totals.d.toLocaleString("de-DE")}</div><div className="sub">Artikel gefunden</div></div>
          <div className="stat-tile"><div className="l"><Clock /> Analysiert</div><div className="n tnum">{totals.an.toLocaleString("de-DE")}</div><div className="sub">{totals.b.toLocaleString("de-DE")} im Backlog</div></div>
          <div className="stat-tile accent"><div className="l">Fortschritt</div><div className="n tnum">{pct}%</div><div className="bar"><i style={{ width: `${pct}%` }} /></div></div>
        </div>

        {/* Publizisten-Vergleich (Kern der Startseite) */}
        <PublisherCompare />

        {/* Artikel */}
        <h2 className="section-h">Artikel <span className="count">{total.toLocaleString("de-DE")} Treffer</span></h2>
        <div className="controls">
          <div className="seg">
            {MODES.map((m) => <button key={m.k} className={mode === m.k ? "on" : ""} onClick={() => { setMode(m.k); setPage(0); }}>{m.l}</button>)}
          </div>
          <select value={outlet} onChange={(e) => { setOutlet(e.target.value); setPage(0); }}>
            <option value="all">Alle Quellen</option>
            {summary.map((s) => <option key={s.source_id} value={s.outlet}>{s.outlet}</option>)}
          </select>
        </div>

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
                    <td>{r.analyzed ? <span className="badge ok">analysiert</span> : <span className="badge wait">Backlog</span>}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={4} className="faint" style={{ padding: 28, textAlign: "center" }}>Keine Artikel.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Zurück</button>
          <span>Seite {page + 1} / {pages}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Weiter →</button>
        </div>
      </div>
    </>
  );
}
