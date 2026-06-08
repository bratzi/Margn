"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type Edit = {
  article_id: number;
  url: string;
  title: string;
  source_id: number;
  outlet: string;
  country: string;
  change_count: number;
  edit_count: number;
  extension_count: number;
  last_change: string;
  first_seen: string;
};

const fmt = (iso: string) => new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "Europe/Berlin" });
const shortUrl = (u: string) => { try { const x = new URL(u); return x.host.replace(/^www\./, ""); } catch { return u; } };

export default function EditsDashboard() {
  const [edits, setEdits] = useState<Edit[]>([]);
  const [sortBy, setSortBy] = useState<"changes" | "edits" | "extensions" | "date">("changes");

  useEffect(() => {
    supabase.from("article_edits_summary").select("*").order("change_count", { ascending: false }).limit(500)
      .then(({ data }) => setEdits((data as Edit[]) ?? []));
  }, []);

  const sorted = useMemo(() => {
    const arr = [...edits];
    if (sortBy === "changes") arr.sort((a, b) => b.change_count - a.change_count);
    else if (sortBy === "edits") arr.sort((a, b) => b.edit_count - a.edit_count);
    else if (sortBy === "extensions") arr.sort((a, b) => b.extension_count - a.extension_count);
    else arr.sort((a, b) => new Date(b.last_change).getTime() - new Date(a.last_change).getTime());
    return arr;
  }, [edits, sortBy]);

  const byPublisher = useMemo(() => {
    const m = new Map<number, { count: number; edits: number; extensions: number }>();
    for (const e of edits) {
      const cur = m.get(e.source_id) || { count: 0, edits: 0, extensions: 0 };
      m.set(e.source_id, {
        count: cur.count + e.change_count,
        edits: cur.edits + e.edit_count,
        extensions: cur.extensions + e.extension_count,
      });
    }
    return [...m.entries()].map(([id, stats]) => {
      const outlet = edits.find((e) => e.source_id === id)?.outlet || "?";
      return { id, outlet, ...stats };
    }).sort((a, b) => b.count - a.count);
  }, [edits]);

  const stats = useMemo(() => {
    const totalChanges = edits.reduce((s, e) => s + e.change_count, 0);
    const totalEdits = edits.reduce((s, e) => s + e.edit_count, 0);
    const totalExts = edits.reduce((s, e) => s + e.extension_count, 0);
    return { totalChanges, totalEdits, totalExts, articles: edits.length };
  }, [edits]);

  return (
    <div className="with-rail">
      <div className="page">
        <div className="kpi-strip">
          <div className="stat-tile"><div className="l">📝 Änderungen gesamt</div><div className="n tnum">{stats.totalChanges.toLocaleString("de-DE")}</div><div className="sub">in {stats.articles} Artikeln</div></div>
          <div className="stat-tile"><div className="l">✏️ Stille Edits</div><div className="n tnum">{stats.totalEdits.toLocaleString("de-DE")}</div><div className="sub">nachträgliche Überarbeitungen</div></div>
          <div className="stat-tile"><div className="l">➕ Erweiterungen</div><div className="n tnum">{stats.totalExts.toLocaleString("de-DE")}</div><div className="sub">neue Inhalte hinzugefügt</div></div>
          <div className="stat-tile accent"><div className="l">Ø Änderungen/Artikel</div><div className="n tnum">{stats.articles ? (stats.totalChanges / stats.articles).toFixed(1) : "—"}</div><div className="sub">durchschnitt</div></div>
        </div>

        <h2 className="section-h">Änderungen pro Publizist</h2>
        <div className="panel" style={{ overflowX: "auto" }}>
          <table className="matrix">
            <thead><tr><th>Verlag</th><th>Änderungen</th><th>Edits</th><th>Erweiterungen</th><th>Ø/Artikel</th></tr></thead>
            <tbody>
              {byPublisher.map((p) => (
                <tr key={p.id}>
                  <td className="pub">{p.outlet}</td>
                  <td className="tnum">{p.count.toLocaleString("de-DE")}</td>
                  <td className="tnum"><span style={{ color: "var(--red)" }}>{p.edits}</span></td>
                  <td className="tnum"><span style={{ color: "var(--green)" }}>{p.extensions}</span></td>
                  <td className="tnum faint">{(p.count / (p.edits + p.extensions + 1)).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="section-h">Artikel mit meisten Änderungen
          <span className="count" style={{ marginLeft: "auto" }}>
            <button onClick={() => setSortBy("changes")} className={sortBy === "changes" ? "active" : ""} style={{ marginRight: 8 }}>nach Ges.</button>
            <button onClick={() => setSortBy("edits")} className={sortBy === "edits" ? "active" : ""} style={{ marginRight: 8 }}>nach Edits</button>
            <button onClick={() => setSortBy("extensions")} className={sortBy === "extensions" ? "active" : ""} style={{ marginRight: 8 }}>nach Erw.</button>
            <button onClick={() => setSortBy("date")} className={sortBy === "date" ? "active" : ""}>nach Datum</button>
          </span>
        </h2>
        <div className="panel" style={{ overflowX: "auto" }}>
          <table className="matrix">
            <thead><tr><th>Artikel</th><th>Verlag</th><th>Änderungen</th><th>Edit</th><th>Erweit.</th><th>Letzter</th></tr></thead>
            <tbody>
              {sorted.map((e) => (
                <tr key={e.article_id}>
                  <td>
                    <Link href={`/articles/${e.article_id}`} target="_blank" className="url mono" title={e.title} style={{ maxWidth: "40vw" }}>
                      <span style={{ color: "var(--faint)" }}>{shortUrl(e.url)}</span> · {e.title.slice(0, 60)}
                    </Link>
                  </td>
                  <td className="cell-nowrap">{e.outlet}</td>
                  <td className="tnum"><strong>{e.change_count}</strong></td>
                  <td className="tnum"><span style={{ color: e.edit_count > 0 ? "var(--red)" : "var(--faint)" }}>{e.edit_count}</span></td>
                  <td className="tnum"><span style={{ color: e.extension_count > 0 ? "var(--green)" : "var(--faint)" }}>{e.extension_count}</span></td>
                  <td className="tnum faint">{fmt(e.last_change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
