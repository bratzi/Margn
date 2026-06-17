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

// Typ-bewusster Vergleich (aufsteigend): Zahl → numerisch, numerischer String →
// numerisch, ISO-Datum → chronologisch, sonst natürliche de-Sortierung. Leerwerte
// werden separat (immer ans Ende) behandelt.
const isEmptyVal = (v: unknown) => v === null || v === undefined || v === "";
const NUM_RE = /^-?\d+(?:[.,]\d+)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}/;
function cmpTyped(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a), bs = String(b);
  if (NUM_RE.test(as.trim()) && NUM_RE.test(bs.trim())) return parseFloat(as.replace(",", ".")) - parseFloat(bs.replace(",", "."));
  if (ISO_RE.test(as) && ISO_RE.test(bs)) { const d = Date.parse(as) - Date.parse(bs); if (!Number.isNaN(d)) return d; }
  return as.localeCompare(bs, "de", { numeric: true, sensitivity: "base" });
}

export default function DataTable<T>({ columns, rows, rowKey, minWidth = 1100, rowClass, tableId, onSortChange }: {
  columns: Col<T>[]; rows: T[]; rowKey: (r: T) => string | number; minWidth?: number; rowClass?: (r: T) => string; tableId?: string;
  // Wenn gesetzt: Sort-State wird nach oben delegiert (Server-Sort) — kein client-seitiges Umsortieren.
  onSortChange?: (s: { key: string; dir: "asc" | "desc" } | null) => void;
}) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [groupBy, setGroupBy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  // Spalten-Reihenfolge, ausgeblendete & gepinnte Spalten (persistiert je tableId)
  const [order, setOrder] = useState<string[]>(columns.map((c) => c.key));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);
  const dragCol = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Layout (Reihenfolge/versteckt/gepinnt/Breiten) aus localStorage laden + speichern.
  const lsKey = tableId ? `dt-layout-${tableId}` : null;
  useEffect(() => {
    if (!lsKey) return;
    try {
      const s = JSON.parse(localStorage.getItem(lsKey) || "{}");
      if (Array.isArray(s.order)) setOrder(s.order);
      if (Array.isArray(s.hidden)) setHidden(new Set(s.hidden));
      if (Array.isArray(s.pinned)) setPinned(new Set(s.pinned));
      if (s.widths) setWidths(s.widths);
    } catch {}
  }, [lsKey]);
  useEffect(() => {
    if (!lsKey) return;
    try { localStorage.setItem(lsKey, JSON.stringify({ order, hidden: [...hidden], pinned: [...pinned], widths })); } catch {}
  }, [lsKey, order, hidden, pinned, widths]);

  // Sichtbare Spalten in aktueller Reihenfolge, gepinnte zuerst.
  const orderedCols = useMemo(() => {
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const ord = order.filter((k) => byKey.has(k));
    for (const c of columns) if (!ord.includes(c.key)) ord.push(c.key); // neue Spalten anhängen
    const vis = ord.map((k) => byKey.get(k)!).filter((c) => !hidden.has(c.key));
    return [...vis.filter((c) => pinned.has(c.key)), ...vis.filter((c) => !pinned.has(c.key))];
  }, [columns, order, hidden, pinned]);

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
    // Nur client-seitig sortieren, wenn kein externer Sort-Handler (sonst kommt die
    // Sortierung bereits vom Server — doppeltes Sortieren würde die Reihenfolge brechen).
    if (sort && !onSortChange) {
      const col = colBy(sort.key);
      v = [...v].sort((a, b) => {
        const av = val(a, col), bv = val(b, col);
        const aE = isEmptyVal(av), bE = isEmptyVal(bv);
        if (aE || bE) return aE && bE ? 0 : aE ? 1 : -1; // Leerwerte immer ans Ende (beide Richtungen)
        const c = cmpTyped(av, bv);
        return sort.dir === "asc" ? c : -c;
      });
    }
    return v;
  }, [rows, filters, sort, columns, !!onSortChange]);

  const toggleSort = (k: string) => {
    const next = sort?.key === k ? (sort.dir === "asc" ? { key: k, dir: "desc" as const } : null) : { key: k, dir: "asc" as const };
    setSort(next);
    onSortChange?.(next);
  };
  // Menü relativ zum Wrapper positionieren — robust gegen transform-Vorfahren
  // (z.B. .data-fade-in mit translateY), die sonst ein position:fixed-Kind verschieben.
  const onHeaderCtx = (e: React.MouseEvent, k: string) => {
    e.preventDefault();
    const wrap = wrapRef.current?.getBoundingClientRect();
    setMenu({ x: e.clientX - (wrap?.left ?? 0), y: e.clientY - (wrap?.top ?? 0), key: k });
  };
  const startResize = (e: React.PointerEvent, k: string) => { e.stopPropagation(); resizing.current = { key: k, startX: e.clientX, startW: widths[k] ?? colBy(k).width ?? 130 }; document.body.style.cursor = "col-resize"; };

  // Spalten per Drag umsortieren
  const onColDrop = (target: string) => {
    const src = dragCol.current;
    dragCol.current = null; setDragOver(null);
    if (!src || src === target) return;
    setOrder((prev) => {
      const base = prev.filter((k) => columns.some((c) => c.key === k));
      for (const c of columns) if (!base.includes(c.key)) base.push(c.key);
      const from = base.indexOf(src), to = base.indexOf(target);
      if (from < 0 || to < 0) return prev;
      const next = [...base]; next.splice(from, 1); next.splice(to, 0, src);
      return next;
    });
  };
  const togglePin = (k: string) => setPinned((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const hideCol = (k: string) => setHidden((s) => new Set(s).add(k));
  const resetLayout = () => { setOrder(columns.map((c) => c.key)); setHidden(new Set()); setPinned(new Set()); setWidths({}); };

  // CSV-Export der aktuell sichtbaren Sicht (gefiltert+sortiert), nur sichtbare Spalten.
  const exportCsv = () => {
    const cols = orderedCols;
    const esc = (s: any) => { const t = String(s ?? "").replace(/"/g, '""'); return /[",;\n]/.test(t) ? `"${t}"` : t; };
    const head = ["#", ...cols.map((c) => c.label)].join(";");
    const lines = view.map((r, i) => [i + 1, ...cols.map((c) => esc(val(r, c)))].join(";"));
    const blob = new Blob(["﻿" + [head, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${tableId ?? "tabelle"}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

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
  const hasFooter = orderedCols.some((c) => c.agg);
  const nCols = orderedCols.length + 1;

  let rowNum = 0;

  const Cells = ({ r }: { r: T }) => { rowNum++; const n = rowNum; return (
    <>
      <td className="dt-num">{n}</td>
      {orderedCols.map((c) => <td key={c.key} className={`${c.align === "right" ? "num" : ""} ${pinned.has(c.key) ? "dt-pinned" : ""}`} style={{ maxWidth: colW(c) }}>{c.render ? c.render(r) : String(val(r, c) ?? "—")}</td>)}
    </>
  ); };

  return (
    <div className="dt-wrap" ref={wrapRef}>
      <div className="dt-toolbar">
        <button className={`dt-tbtn ${showFilters ? "on" : ""}`} onClick={() => setShowFilters((s) => !s)}>⌕ Spalten-Filter</button>
        {groupBy && <button className="dt-tbtn on" onClick={() => setGroupBy(null)}>Gruppierung: {colBy(groupBy).label} ✕</button>}
        {hidden.size > 0 && <button className="dt-tbtn" onClick={() => setHidden(new Set())}>{hidden.size} ausgeblendet einblenden</button>}
        {(order.join() !== columns.map((c) => c.key).join() || hidden.size || pinned.size) ? <button className="dt-tbtn" onClick={resetLayout}>↺ Layout zurücksetzen</button> : null}
        <button className="dt-tbtn" onClick={exportCsv} title="Sichtbare Sicht als CSV">⭳ CSV</button>
        <span className="dt-count">{view.length} Zeilen{groups ? ` · ${groups.length} Gruppen` : ""}{hasFooter ? " · Σ aggregiert diese Seite" : ""}</span>
      </div>
      <div className="dt-scroll">
        <table className="dt" style={{ minWidth }}>
          <thead>
            <tr>
              <th className="dt-num">#</th>
              {orderedCols.map((c) => (
                <th key={c.key} style={{ width: colW(c), cursor: c.sortable !== false ? "pointer" : "default" }}
                  className={`${pinned.has(c.key) ? "dt-pinned" : ""} ${dragOver === c.key ? "dt-dragover" : ""}`}
                  draggable
                  onDragStart={(e) => { if (resizing.current) { e.preventDefault(); return; } dragCol.current = c.key; }}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(c.key); }}
                  onDragLeave={() => setDragOver((d) => (d === c.key ? null : d))}
                  onDrop={() => onColDrop(c.key)}
                  onClick={() => c.sortable !== false && toggleSort(c.key)} onContextMenu={(e) => onHeaderCtx(e, c.key)}>
                  <span className="dt-h">{pinned.has(c.key) && <i className="dt-pin-mark">📌</i>}{c.label}{sort?.key === c.key && <i>{sort.dir === "asc" ? " ▲" : " ▼"}</i>}</span>
                  <span className="dt-resize" onPointerDown={(e) => startResize(e, c.key)} onClick={(e) => e.stopPropagation()} />
                </th>
              ))}
            </tr>
            {showFilters && (
              <tr className="dt-filterrow">
                <th className="dt-num"></th>
                {orderedCols.map((c) => (
                  <th key={c.key}>{c.filterable !== false && <input value={filters[c.key] ?? ""} placeholder="filtern…" onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))} />}</th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {!groups && view.map((r) => <tr key={rowKey(r)} className={rowClass?.(r)}><Cells r={r} /></tr>)}
            {groups && groups.map(([g, rs]) => (
              <GroupBlock key={g} g={g} count={rs.length} colSpan={nCols}
                collapsed={collapsed.has(g)} onToggle={() => setCollapsed((s) => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; })}>
                {!collapsed.has(g) && rs.map((r) => <tr key={rowKey(r)} className={rowClass?.(r)}><Cells r={r} /></tr>)}
              </GroupBlock>
            ))}
            {!view.length && <tr><td colSpan={nCols} className="faint" style={{ padding: 28, textAlign: "center" }}>Keine Zeilen.</td></tr>}
          </tbody>
          {hasFooter && view.length > 0 && (
            <tfoot>
              <tr className="dt-foot">
                <td className="dt-num">Σ</td>
                {orderedCols.map((c) => (
                  <td key={c.key} className={c.align === "right" ? "num" : ""}>
                    {c.agg ? <span className="dt-agg">{aggCell(c, view)}</span> : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {menu && (() => {
        const mc = colBy(menu.key);
        return (
          <div className="dt-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
            <div className="dt-menu-head">{mc.label}</div>
            {mc.sortable !== false && <>
              <button onClick={() => { setSort({ key: menu.key, dir: "asc" }); setMenu(null); }}>↑ Aufsteigend sortieren</button>
              <button onClick={() => { setSort({ key: menu.key, dir: "desc" }); setMenu(null); }}>↓ Absteigend sortieren</button>
            </>}
            {sort?.key === menu.key && <button onClick={() => { setSort(null); setMenu(null); }}>Sortierung aufheben</button>}
            <div className="dt-menu-sep" />
            <button onClick={() => { togglePin(menu.key); setMenu(null); }}>{pinned.has(menu.key) ? "📌 Anheftung lösen" : "📌 Spalte anheften"}</button>
            <button onClick={() => { hideCol(menu.key); setMenu(null); }}>⊘ Spalte ausblenden</button>
            {mc.groupable !== false && <button onClick={() => { setGroupBy(menu.key); setMenu(null); }}>⊞ Gruppieren nach „{mc.label}"</button>}
            {groupBy && <button onClick={() => { setGroupBy(null); setMenu(null); }}>Gruppierung aufheben</button>}
            <button onClick={() => { setShowFilters(true); setMenu(null); }}>⌕ Spalten-Filter zeigen</button>
            <div className="dt-menu-sep" />
            <button onClick={() => { exportCsv(); setMenu(null); }}>⭳ Als CSV exportieren</button>
            <button onClick={() => { resetLayout(); setMenu(null); }}>↺ Layout zurücksetzen</button>
          </div>
        );
      })()}
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
