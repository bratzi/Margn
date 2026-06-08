"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";
import { PUB_COLORS } from "@/components/TimeRangeFilter";

type TL = { source_id: number; day: string; n: number };
const short = (n: string) => n.replace(" Online", "");
const VW = 1000, VH = 200;

export default function RateStats() {
  const f = useFilters();
  const { sources, activeArr } = f;
  const [rows, setRows] = useState<TL[]>([]);
  const [gran, setGran] = useState<"day" | "week">("day");

  useEffect(() => {
    if (!activeArr.length) { setRows([]); return; }
    supabase.rpc("publish_timeline_f", {
      p_sources: activeArr, p_topic: f.topic === "all" ? null : f.topic,
      p_paywall: f.paywall === "all" ? null : f.paywall, p_author: f.author === "all" ? null : f.author,
      p_lang: f.lang === "all" ? null : f.lang,
    }).then(({ data }) => setRows((data as TL[]) ?? []));
  }, [activeArr.join(","), f.topic, f.paywall, f.author, f.lang]);

  const colorById = useMemo(() => new Map(sources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])), [sources]);
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, short(s.name)])), [sources]);
  const act = useMemo(() => new Set(activeArr), [activeArr]);

  // Tage-Achse (letzte 60), optional zu Wochen aggregiert
  const buckets = useMemo(() => {
    const days: string[] = []; const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    for (let i = 59; i >= 0; i--) { const x = new Date(d); x.setUTCDate(x.getUTCDate() - i); days.push(x.toISOString().slice(0, 10)); }
    if (gran === "day") return days.map((day) => ({ label: day, days: [day] }));
    const weeks: { label: string; days: string[] }[] = [];
    for (let i = 0; i < days.length; i += 7) weeks.push({ label: days[i], days: days.slice(i, i + 7) });
    return weeks;
  }, [gran]);

  const { series, maxTotal } = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const r of rows) { if (!map.has(r.source_id)) map.set(r.source_id, new Map()); map.get(r.source_id)!.set(r.day, r.n); }
    const ser = sources.filter((s) => act.has(s.id)).map((s) => ({
      id: s.id, color: colorById.get(s.id)!,
      vals: buckets.map((b) => b.days.reduce((sum, d) => sum + (map.get(s.id)?.get(d) ?? 0), 0)),
    }));
    const tot = buckets.map((_, i) => ser.reduce((sum, s) => sum + s.vals[i], 0));
    return { series: ser, maxTotal: Math.max(1, ...tot) };
  }, [rows, sources, act, buckets, colorById]);

  if (!rows.length) return null;
  const NB = buckets.length;
  const X = (i: number) => (i / Math.max(1, NB - 1)) * VW;
  const colW = (VW / NB) * (gran === "day" ? 0.7 : 0.78);
  const fmt = (ds: string) => new Date(ds + "T00:00:00Z").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const total = series.reduce((s, x) => s + x.vals.reduce((a, b) => a + b, 0), 0);

  return (
    <>
      <h2 className="section-h" style={{ alignItems: "center" }}>Publikationen über Zeit <span className="count">{total.toLocaleString("de-DE")} Artikel (60 Tage)</span>
        <div className="seg" style={{ marginLeft: "auto" }}>
          <button className={gran === "day" ? "on" : ""} onClick={() => setGran("day")}>Pro Tag</button>
          <button className={gran === "week" ? "on" : ""} onClick={() => setGran("week")}>Pro Woche</button>
        </div>
      </h2>
      <div className="panel pad">
        <div className="rate-legend">{series.map((s) => <span key={s.id}><i style={{ background: s.color }} />{nameById.get(s.id)}</span>)}</div>
        <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" className="rate-svg">
          <line x1={0} y1={VH} x2={VW} y2={VH} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {buckets.map((_, i) => {
            let yb = VH;
            return <g key={i}>{series.map((s) => { const h = (s.vals[i] / maxTotal) * (VH - 6); if (h <= 0) return null; const y = yb - h; yb = y; return <rect key={s.id} x={X(i) - colW / 2} y={y} width={colW} height={h} fill={s.color} rx={gran === "week" ? 2 : 0}><title>{`${nameById.get(s.id)}: ${s.vals[i]}`}</title></rect>; })}</g>;
          })}
        </svg>
        <div className="rate-axis">{buckets.filter((_, i) => i % Math.ceil(NB / 8) === 0).map((b, k, arr) => <span key={b.label} style={{ left: `${(buckets.indexOf(b) / Math.max(1, NB - 1)) * 100}%`, transform: k === 0 ? "none" : k === arr.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>{fmt(b.label)}</span>)}</div>
      </div>
    </>
  );
}
