"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";
import FilterPills from "@/components/FilterPills";
import TimeRangeFilter from "@/components/TimeRangeFilter";
import DataTable, { type Col } from "@/components/DataTable";
import ExtLink from "@/components/ExtLink";

type Edit = {
  article_id: number; url: string; title: string;
  source_id: number; outlet: string; country: string;
  change_count: number; edit_count: number; extension_count: number;
  last_change: string; first_seen: string;
};
const fmt = (iso: string) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const shortUrl = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };

export default function EditsDashboard() {
  const f = useFilters();
  const [edits, setEdits] = useState<Edit[]>([]);

  // Master-Filter: Quelle + Zeitraum (auf letzte Änderung)
  useEffect(() => {
    if (!f.activeArr.length) { setEdits([]); return; }
    let q = supabase.from("article_edits_summary").select("*").in("source_id", f.activeArr);
    if (f.rangeFrom) q = q.gte("last_change", f.rangeFrom);
    if (f.rangeTo) q = q.lte("last_change", f.rangeTo);
    q.order("change_count", { ascending: false }).limit(1000).then(({ data }) => setEdits((data as Edit[]) ?? []));
  }, [f.activeArr.join(","), f.rangeFrom, f.rangeTo]);

  const byPublisher = useMemo(() => {
    const m = new Map<number, { id: number; outlet: string; count: number; edits: number; extensions: number }>();
    for (const e of edits) {
      const cur = m.get(e.source_id) || { id: e.source_id, outlet: e.outlet, count: 0, edits: 0, extensions: 0 };
      m.set(e.source_id, { ...cur, count: cur.count + Number(e.change_count), edits: cur.edits + e.edit_count, extensions: cur.extensions + e.extension_count });
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [edits]);

  const stats = useMemo(() => ({
    changes: edits.reduce((s, e) => s + Number(e.change_count), 0),
    edits: edits.reduce((s, e) => s + e.edit_count, 0),
    extensions: edits.reduce((s, e) => s + e.extension_count, 0),
    articles: edits.length,
  }), [edits]);

  const pubCols: Col<typeof byPublisher[0]>[] = useMemo(() => [
    { key: "outlet", label: "Verlag", width: 180, value: (p) => p.outlet, render: (p) => <Link href={`/articles?source_id=${p.id}`} style={{ color: "var(--accent)", fontWeight: 600 }}>{p.outlet}</Link> },
    { key: "count", label: "Änderungen", width: 130, align: "right", value: (p) => p.count, render: (p) => <strong>{p.count.toLocaleString("de-DE")}</strong> },
    { key: "edits", label: "Stille Edits", width: 130, align: "right", value: (p) => p.edits, render: (p) => <span style={{ color: "var(--red)" }}>{p.edits}</span> },
    { key: "extensions", label: "Erweiterungen", width: 140, align: "right", value: (p) => p.extensions, render: (p) => <span style={{ color: "var(--green)" }}>{p.extensions}</span> },
  ], []);

  const artCols: Col<Edit>[] = useMemo(() => [
    { key: "outlet", label: "Quelle", width: 130, value: (e) => e.outlet, render: (e) => <>{e.outlet} <span className="cc">{e.country}</span></> },
    { key: "title", label: "Artikel", width: 420, sortable: false, groupable: false, value: (e) => e.title ?? e.url,
      render: (e) => <div className="art-row"><Link href={`/articles/${e.article_id}`} target="_blank" className="url" title={e.title}>{e.title?.slice(0, 110) || shortUrl(e.url)}</Link><ExtLink href={e.url} className="open-btn" title="Original (Hintergrund-Tab)">↗</ExtLink></div> },
    { key: "edit_count", label: "Stille Edits", width: 110, align: "right", value: (e) => e.edit_count, render: (e) => <span style={{ color: e.edit_count > 0 ? "var(--red)" : "var(--faint)", fontWeight: 600 }}>{e.edit_count}</span> },
    { key: "extension_count", label: "Erweiterungen", width: 120, align: "right", value: (e) => e.extension_count, render: (e) => <span style={{ color: e.extension_count > 0 ? "var(--green)" : "var(--faint)", fontWeight: 600 }}>{e.extension_count}</span> },
    { key: "change_count", label: "Gesamt", width: 90, align: "right", value: (e) => Number(e.change_count), render: (e) => <strong>{e.change_count}</strong> },
    { key: "last_change", label: "Letzte Änderung", width: 150, value: (e) => e.last_change, render: (e) => <span className="mono faint">{fmt(e.last_change)}</span> },
  ], []);

  return (
    <>
      <FilterPills />
      <div className="page wide">
        <div className="kpi-strip">
          <div className="stat-tile"><div className="l">Änderungen erfasst</div><div className="n tnum">{stats.changes.toLocaleString("de-DE")}</div><div className="sub">in {stats.articles} Artikeln</div></div>
          <div className="stat-tile"><div className="l">Stille Edits</div><div className="n tnum" style={{ color: "var(--red)" }}>{stats.edits.toLocaleString("de-DE")}</div><div className="sub">nachträgliche Überarbeitungen</div></div>
          <div className="stat-tile"><div className="l">Erweiterungen</div><div className="n tnum" style={{ color: "var(--green)" }}>{stats.extensions.toLocaleString("de-DE")}</div><div className="sub">neue Passagen ergänzt</div></div>
          <div className="stat-tile accent"><div className="l">Ø Änderungen/Artikel</div><div className="n tnum">{stats.articles ? (stats.changes / stats.articles).toFixed(1) : "—"}</div><div className="sub">Durchschnitt</div></div>
        </div>

        <h2 className="section-h">Änderungen pro Publizist</h2>
        <DataTable columns={pubCols} rows={byPublisher} rowKey={(p) => p.id} minWidth={600} />

        <h2 className="section-h" style={{ marginTop: 28 }}>Artikel mit Änderungen <span className="count">{stats.articles} Artikel</span></h2>
        <DataTable columns={artCols} rows={edits} rowKey={(e) => e.article_id} minWidth={1100} />
      </div>
      <TimeRangeFilter />
    </>
  );
}
