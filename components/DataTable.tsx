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
  // Aggregat für die Footer-Zeile: numerisch (Summe/Schnitt/Median/Quote) oder eigene Funktion.
  agg?: "sum" | "avg" | "median" | "min" | "max" | ((rows: T[]) => React.ReactNode);
  aggFormat?: (n: number) => React.ReactNode;
};

export default function DataTable<T>({ columns, rows, rowKey, minWidth = 1100, rowClass }: {
  columns: Col<T>[]; rows: T[]; rowKey: (r: T) => string | number; minWidth?: number; rowClass?: (r: T) => string;
}) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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
  // Menü relativ zum Wrapper positionieren — robust gegen transform-Vorfahren
  // (z.B. .data-fade-in mit translateY), die sonst ein position:fixed-Kind verschieben.
  const onHeaderCtx = (e: React.MouseEvent, k: string) => {
    e.preventDefault();
    const wrap = wrapRef.current?.getBoundingClientRect();
    setMenu({ x: e.clientX - (wrap?.left ?? 0), y: e.clientY - (wrap?.top ?? 0), key: k });
  };
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

  // Spalten-Aggregat für die Footer-Zeile (über die aktuell gefilterte Sicht).
  const aggCell = (c: Col<T>, rs: T[]): React.ReactNode => {
    if (!c.agg) return null;
    if (typeof c.agg === "function") return c.agg(rs);
    const nums = rs.map((r) => Number(val(r, c))).filter((x) => Number.isFinite(x));
    if (!nums.length) return null;
    let out: number;
    if (c.agg === "sum") out = nums.reduce((a, b) => a + b, 0);
    else if (c.agg === "avg") out = nums.reduce((a, b) => a + b, 0) / nums.length;
    else if (c.agg === "min") out = Math.min(...nums);
    else if (c.agg === "max") out = Math.max(...nums);
    else { const s = [...nums].sort((a, b) => a - b); out = s[Math.floor(s.length / 2)]; }
    const rounded = c.agg === "avg" ? Math.round(out * 10) / 10 : Math.round(out);
    return c.aggFormat ? c.aggFormat(rounded) : rounded.toLocaleString("de-DE");
  };
  const hasFooter = columns.some((c) => c.agg);

  let rowNum = 0;

  const Cells = ({ r }: { r: T }) => { rowNum++; const n = rowNum; return (
    <>
      <td className="dt-num">{n}</td>
      {columns.map((c) => <td key={c.key} className={c.align === "right" ? "num" : ""} style={{ maxWidth: colW(c) }}>{c.render ? c.render(r) : String(val(r, c) ?? "—")}</td>)}
    </>
  ); };

  return (
    <div className="dt-wrap" ref={wrapRef}>
      <div className="dt-toolbar">
        <button className={`dt-tbtn ${showFilters ? "on" : ""}`} onClick={() => setShowFilters((s) => !s)}>⌕ Spalten-Filter</button>
        {groupBy && <button className="dt-tbtn on" onClick={() => setGroupBy(null)}>Gruppierung: {colBy(groupBy).label} ✕</button>}
        <span className="dt-count">{view.length} Zeilen{groups ? ` · ${groups.length} Gruppen` : ""}{hasFooter ? " · Σ-Zeile aggregiert diese Seite" : ""}</span>
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
            {!groups && view.map((r) => <tr key={rowKey(r)} className={rowClass?.(r)}><Cells r={r} /></tr>)}
            {groups && groups.map(([g, rs]) => (
              <GroupBlock key={g} g={g} count={rs.length} colSpan={columns.length + 1}
                collapsed={collapsed.has(g)} onToggle={() => setCollapsed((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; })}>
                {!collapsed.has(g) && rs.map((r) => <tr key={rowKey(r)} className={rowClass?.(r)}><Cells r={r} /></tr>)}
              </GroupBlock>
            ))}
            {!view.length && <tr><td colSpan={columns.length + 1} className="faint" style={{ padding: 28, textAlign: "center" }}>Keine Zeilen.</td></tr>}
          </tbody>
          {hasFooter && view.length > 0 && (
            <tfoot>
              <tr className="dt-foot">
                <td className="dt-num">Σ</td>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === "right" ? "num" : ""}>
                    {c.agg ? <span className="dt-agg">{aggCell(c, view)}</span> : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
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
