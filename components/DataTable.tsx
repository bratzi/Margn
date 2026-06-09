"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type Col<T> = {
  key: string;
  label: string;
  width?: number;
  align?: "left" | "right";
  value?: (row: T) => string | number | null; // für Sort/Filter/Gruppierung
  render?: (row: T) => React.ReactNode;
  sortable?: boolean;
  filterable?: boolean;
  groupable?: boolean;
};

export default function DataTable<T>({ columns, rows, rowKey, minWidth = 1100 }: {
  columns: Col<T>[]; rows: T[]; rowKey: (r: T) => string | number; minWidth?: number;
}) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);

  const val = (row: T, col: Col<T>): any => (col.value ? col.value(row) : (row as any)[col.key]);
  const colBy = (k: string) => columns.find((c) => c.key === k)!;

  // Resize
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const r = resizing.current; if (!r) return;
      setWidths((w) => ({ ...w, [r.key]: Math.max(60, r.startW + (e.clientX - r.startX)) }));
    };
    const up = () => { resizing.current = null; document.body.style.cursor = ""; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);
  useEffect(() => { const close = () => setMenu(null); window.addEventListener("click", close); return () => window.removeEventListener("click", close); }, []);

  const view = useMemo(() => {
    let v = rows;
    for (const [k, q] of Object.entries(filters)) {
      if (!q) continue; const col = colBy(k);
      v = v.filter((r) => String(val(r, col) ?? "").toLowerCase().includes(q.toLowerCase()));
    }
    if (sort) {
      const col = colBy(sort.key);
      v = [...v].sort((a, b) => {
        const av = val(a, col), bv = val(b, col);
        const cmp = (typeof av === "number" && typeof bv === "number") ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""), "de", { numeric: true });
        return sort.dir === "asc" ? cmp : -cmp;
      });
    }
    return v;
  }, [rows, filters, sort, columns]);

  const toggleSort = (k: string) => setSort((s) => s?.key === k ? (s.dir === "asc" ? { key: k, dir: "desc" } : null) : { key: k, dir: "asc" });
  const onHeaderCtx = (e: React.MouseEvent, k: string) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, key: k }); };
  const startResize = (e: React.PointerEvent, k: string) => { e.stopPropagation(); resizing.current = { key: k, startX: e.clientX, startW: widths[k] ?? colBy(k).width ?? 130 }; document.body.style.cursor = "col-resize"; };

  // Gruppierung
  const groups = useMemo(() => {
    if (!groupBy) return null;
    const col = colBy(groupBy);
    const m = new Map<string, T[]>();
    for (const r of view) { const g = String(val(r, col) ?? "—"); (m.get(g) ?? m.set(g, []).get(g)!).push(r); }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [view, groupBy]);

  const colW = (c: Col<T>) => widths[c.key] ?? c.width ?? 130;
  let rowNum = 0;

  const Cells = ({ r }: { r: T }) => { rowNum++; const n = rowNum; return (
    <>
      <td className="dt-num">{n}</td>
      {columns.map((c) => <td key={c.key} className={c.align === "right" ? "num" : ""} style={{ maxWidth: colW(c) }}>{c.render ? c.render(r) : String(val(r, c) ?? "—")}</td>)}
    </>
  ); };

  return (
    <div className="dt-wrap">
      <div className="dt-toolbar">
        <button className={`dt-tbtn ${showFilters ? "on" : ""}`} onClick={() => setShowFilters((s) => !s)}>⌕ Spalten-Filter</button>
        {groupBy && <button className="dt-tbtn on" onClick={() => setGroupBy(null)}>Gruppierung: {colBy(groupBy).label} ✕</button>}
        <span className="dt-count">{view.length} Zeilen{groups ? ` · ${groups.length} Gruppen` : ""}</span>
      </div>
      <div className="dt-scroll">
        <table className="dt" style={{ minWidth }}>
          <thead>
            <tr>
              <th className="dt-num">#</th>
              {columns.map((c) => (
                <th key={c.key} style={{ width: colW(c), cursor: c.sortable !== false ? "pointer" : "default" }}
                  onClick={() => c.sortable !== false && toggleSort(c.key)} onContextMenu={(e) => onHeaderCtx(e, c.key)}>
                  <span className="dt-h">{c.label}{sort?.key === c.key && <i>{sort.dir === "asc" ? " ▲" : " ▼"}</i>}</span>
                  <span className="dt-resize" onPointerDown={(e) => startResize(e, c.key)} onClick={(e) => e.stopPropagation()} />
                </th>
              ))}
            </tr>
            {showFilters && (
              <tr className="dt-filterrow">
                <th className="dt-num"></th>
                {columns.map((c) => (
                  <th key={c.key}>{c.filterable !== false && <input value={filters[c.key] ?? ""} placeholder="filtern…" onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))} />}</th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {!groups && view.map((r) => <tr key={rowKey(r)}><Cells r={r} /></tr>)}
            {groups && groups.map(([g, rs]) => (
              <GroupBlock key={g} g={g} count={rs.length} colSpan={columns.length + 1}
                collapsed={collapsed.has(g)} onToggle={() => setCollapsed((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; })}>
                {!collapsed.has(g) && rs.map((r) => <tr key={rowKey(r)}><Cells r={r} /></tr>)}
              </GroupBlock>
            ))}
            {!view.length && <tr><td colSpan={columns.length + 1} className="faint" style={{ padding: 28, textAlign: "center" }}>Keine Zeilen.</td></tr>}
          </tbody>
        </table>
      </div>
      {menu && (
        <div className="dt-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {colBy(menu.key).groupable !== false && <button onClick={() => { setGroupBy(menu.key); setMenu(null); }}>Gruppieren nach „{colBy(menu.key).label}"</button>}
          {groupBy && <button onClick={() => { setGroupBy(null); setMenu(null); }}>Gruppierung aufheben</button>}
          <button onClick={() => { toggleSort(menu.key); setMenu(null); }}>Sortieren</button>
          <button onClick={() => { setShowFilters(true); setMenu(null); }}>Spalten-Filter zeigen</button>
        </div>
      )}
    </div>
  );
}

function GroupBlock({ g, count, colSpan, collapsed, onToggle, children }: { g: string; count: number; colSpan: number; collapsed: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <>
      <tr className="dt-group" onClick={onToggle}>
        <td colSpan={colSpan}><span className="dt-grp-tog">{collapsed ? "▶" : "▼"}</span> {g} <span className="dt-grp-n">{count}</span></td>
      </tr>
      {children}
    </>
  );
}
