"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type Summary = { source_id: number; outlet: string; country: string; discovered: number; analyzed: number; backlog: number };
type Row = { id: number; url: string; outlet: string; country: string | null; discovered_at: string; analyzed: boolean; title: string | null };
type Mode = "all" | "analyzed" | "backlog";

const PAGE = 25;
const FLAG: Record<string, string> = { DE: "🇩🇪", FR: "🇫🇷" };
const MODES: { k: Mode; l: string }[] = [
  { k: "all", l: "Alle" }, { k: "analyzed", l: "Analysiert" }, { k: "backlog", l: "Backlog" },
];

function shortUrl(u: string) {
  try { const x = new URL(u); return { host: x.host.replace(/^www\./, ""), path: x.pathname }; }
  catch { return { host: "", path: u }; }
}
function fmt(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function ArticleDashboard() {
  const [summary, setSummary] = useState<Summary[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [mode, setMode] = useState<Mode>("all");
  const [outlet, setOutlet] = useState("all");
  const [page, setPage] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  const loadStats = useCallback(async () => {
    const { data: sum } = await supabase.from("article_status_summary").select("*");
    setSummary((sum as Summary[]) ?? []);
    setUpdatedAt(new Date());
  }, []);

  const loadRows = useCallback(async () => {
    let q = supabase.from("article_status").select("id,url,outlet,country,discovered_at,analyzed,title", { count: "exact" });
    if (mode === "analyzed") q = q.eq("analyzed", true);
    else if (mode === "backlog") q = q.eq("analyzed", false);
    if (outlet !== "all") q = q.eq("outlet", outlet);
    const { data, count } = await q.order("discovered_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as Row[]) ?? []);
    setTotal(count ?? 0);
  }, [mode, outlet, page]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { const t = setInterval(() => { loadStats(); loadRows(); }, 15000); return () => clearInterval(t); }, [loadStats, loadRows]);

  const totals = useMemo(() => summary.reduce((a, s) => ({ d: a.d + s.discovered, an: a.an + s.analyzed, b: a.b + s.backlog }), { d: 0, an: 0, b: 0 }), [summary]);
  const pct = totals.d ? Math.round((totals.an / totals.d) * 100) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="wrap">
      <div className="h-row">
        <div>
          <div className="title">Crawl-Fortschritt & Analyse</div>
          <div className="subtitle">Entdeckte Artikel je Quelle · analysiert vs. Backlog</div>
        </div>
        <div className="live"><span className="dot" /> live · {updatedAt ? updatedAt.toLocaleTimeString("de-DE") : "…"}</div>
      </div>

      {/* Gesamtfortschritt + KPIs */}
      <div className="panel pad overall">
        <div>
          <div className="big">{pct}%<small>analysiert</small></div>
          <div className="kpis">
            <div className="kpi"><b>{totals.an.toLocaleString("de-DE")}</b> <span>analysiert</span></div>
            <div className="kpi"><b>{totals.b.toLocaleString("de-DE")}</b> <span>Backlog</span></div>
            <div className="kpi"><b>{totals.d.toLocaleString("de-DE")}</b> <span>entdeckt</span></div>
          </div>
        </div>
        <div><div className="bar"><i style={{ width: `${pct}%` }} /></div></div>
      </div>

      {/* Karten je Quelle */}
      <div className="grid">
        {summary.map((s) => {
          const p = s.discovered ? Math.round((s.analyzed / s.discovered) * 100) : 0;
          return (
            <div className="card" key={s.source_id}>
              <div className="top">
                <div className="outlet">{s.outlet}<span className="flag">{FLAG[s.country] ?? s.country}</span></div>
                <div className="pct">{p}%</div>
              </div>
              <div className="bar sm"><i style={{ width: `${p}%` }} /></div>
              <div className="nums">
                <span><b>{s.analyzed.toLocaleString("de-DE")}</b> analysiert</span>
                <span><b>{s.backlog.toLocaleString("de-DE")}</b> Backlog</span>
                <span className="muted">{s.discovered.toLocaleString("de-DE")} gesamt</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filter */}
      <div className="controls">
        <div className="seg">
          {MODES.map((m) => (
            <button key={m.k} className={mode === m.k ? "on" : ""} onClick={() => { setMode(m.k); setPage(0); }}>{m.l}</button>
          ))}
        </div>
        <select value={outlet} onChange={(e) => { setOutlet(e.target.value); setPage(0); }}>
          <option value="all">Alle Quellen</option>
          {summary.map((s) => <option key={s.source_id} value={s.outlet}>{s.outlet}</option>)}
        </select>
        <div className="spacer" />
        <span className="muted">{total.toLocaleString("de-DE")} Artikel</span>
      </div>

      {/* Tabelle */}
      <div className="panel">
        <table>
          <thead>
            <tr><th>Quelle</th><th>Artikel</th><th>Entdeckt</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const { host, path } = shortUrl(r.url);
              return (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{FLAG[r.country ?? ""] ?? ""} {r.outlet}</td>
                  <td>
                    <a href={r.url} target="_blank" rel="noreferrer" className="url" title={r.url}>
                      {r.title ? r.title : <span className="mono"><span className="path">{host}</span>{path}</span>}
                    </a>
                  </td>
                  <td className="mono muted" style={{ whiteSpace: "nowrap" }}>{fmt(r.discovered_at)}</td>
                  <td>{r.analyzed ? <span className="badge ok"><i />analysiert</span> : <span className="badge wait"><i />Backlog</span>}</td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={4} className="muted" style={{ padding: 28, textAlign: "center" }}>Keine Artikel.</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Zurück</button>
        <span>Seite {page + 1} / {pages}</span>
        <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Weiter →</button>
      </div>
    </div>
  );
}
