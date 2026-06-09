"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";
import { PUB_COLORS } from "@/components/TimeRangeFilter";

type B = { source_id: number; bucket: string; n: number };
type Unit = "hour" | "day" | "week";
const short = (n: string) => n.replace(" Online", "");
const VW = 1000, VH = 200;

// ISO-Kalenderwoche
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t.getTime() - first.getTime()) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}

export default function RateStats() {
  const f = useFilters();
  const { sources, activeArr } = f;
  const [rows, setRows] = useState<B[]>([]);
  const [manual, setManual] = useState<"auto" | Unit>("auto");

  const fromIso = f.days[f.rangeIdx.from] + "T00:00:00Z";
  const toIso = f.days[f.rangeIdx.to] + "T23:59:59Z";
  const spanDays = f.rangeIdx.to - f.rangeIdx.from + 1;
  const autoUnit: Unit = spanDays <= 3 ? "hour" : spanDays <= 45 ? "day" : "week";
  const unit: Unit = manual === "auto" ? autoUnit : manual;

  useEffect(() => {
    if (!activeArr.length) { setRows([]); return; }
    const nn = (v: string) => (v === "all" ? null : v);
    supabase.rpc("publish_buckets_f", {
      p_sources: activeArr, p_topic: nn(f.topic), p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang),
      p_from: fromIso, p_to: toIso, p_bucket: unit,
    }).then(({ data }) => setRows((data as B[]) ?? []));
  }, [activeArr.join(","), f.topic, f.paywall, f.author, f.lang, fromIso, toIso, unit]);

  const colorById = useMemo(() => new Map(sources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])), [sources]);
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, short(s.name)])), [sources]);
  const act = useMemo(() => new Set(activeArr), [activeArr]);

  const truncTo = (iso: string, u: Unit) => { const d = new Date(iso); if (u === "hour") d.setUTCMinutes(0, 0, 0); else if (u === "day") d.setUTCHours(0, 0, 0, 0); else { d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); } return d; };

  const buckets = useMemo(() => {
    const out: string[] = []; const cur = truncTo(fromIso, unit); const end = new Date(toIso);
    let g = 0;
    while (cur <= end && g++ < 3000) { out.push(cur.toISOString()); if (unit === "hour") cur.setUTCHours(cur.getUTCHours() + 1); else if (unit === "day") cur.setUTCDate(cur.getUTCDate() + 1); else cur.setUTCDate(cur.getUTCDate() + 7); }
    return out;
  }, [fromIso, toIso, unit]);

  const { series, maxTotal } = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const r of rows) { if (!map.has(r.source_id)) map.set(r.source_id, new Map()); const m = map.get(r.source_id)!; const k = truncTo(r.bucket, unit).toISOString(); m.set(k, (m.get(k) ?? 0) + r.n); }
    const ser = sources.filter((s) => act.has(s.id)).map((s) => ({ id: s.id, color: colorById.get(s.id)!, vals: buckets.map((b) => map.get(s.id)?.get(b) ?? 0) }));
    const tot = buckets.map((_, i) => ser.reduce((sum, s) => sum + s.vals[i], 0));
    return { series: ser, maxTotal: Math.max(1, ...tot) };
  }, [rows, sources, act, buckets, unit]);

  const NB = buckets.length;
  const X = (i: number) => (i / Math.max(1, NB - 1)) * VW;
  const colW = Math.min(38, (VW / Math.max(1, NB)) * 0.72);

  // Tagestrennlinien (im Stunden-Modus an Tageswechseln)
  const dayDividers = useMemo(() => {
    if (unit !== "hour") return [];
    const out: number[] = [];
    for (let i = 1; i < buckets.length; i++) if (new Date(buckets[i]).getUTCDate() !== new Date(buckets[i - 1]).getUTCDate()) out.push(i);
    return out;
  }, [buckets, unit]);

  const fmtAxis = (iso: string) => {
    const d = new Date(iso);
    if (unit === "hour") return String(d.getUTCHours()).padStart(2, "0") + ":00";
    if (unit === "week") return "KW " + isoWeek(d);
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  };
  const unitLabel = unit === "hour" ? "Stunden" : unit === "day" ? "Tage" : "Kalenderwochen";
  const total = series.reduce((s, x) => s + x.vals.reduce((a, b) => a + b, 0), 0);
  const fromD = new Date(fromIso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const toD = new Date(toIso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const axisStep = Math.max(1, Math.ceil(NB / 10));

  return (
    <>
      <h2 className="section-h" style={{ alignItems: "center", flexWrap: "wrap" }}>Publikationen über Zeit
        <span className="count">{total.toLocaleString("de-DE")} Artikel · {fromD}–{toD}</span>
        <div className="seg" style={{ marginLeft: "auto" }}>
          <button className={manual === "auto" ? "on" : ""} onClick={() => setManual("auto")} title="Zeiteinheit passt sich dem Zoom an">⟳ Dynamisch</button>
          <button className={manual === "hour" ? "on" : ""} onClick={() => setManual("hour")}>Stunde</button>
          <button className={manual === "day" ? "on" : ""} onClick={() => setManual("day")}>Tag</button>
          <button className={manual === "week" ? "on" : ""} onClick={() => setManual("week")}>Woche</button>
        </div>
      </h2>
      <div className="panel pad">
        {!rows.length ? <p className="faint" style={{ fontSize: 13 }}>Keine veröffentlichten Artikel im gewählten Zeitraum.</p> : (
          <>
            <div className="rate-legend">
              {series.map((s) => <span key={s.id}><i style={{ background: s.color }} />{nameById.get(s.id)}</span>)}
              <span style={{ marginLeft: "auto", color: "var(--faint)" }}>Einheit: <b style={{ color: "var(--accent)" }}>{unitLabel}</b>{manual === "auto" ? " (dynamisch)" : ""}</span>
            </div>
            <svg viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" className="rate-svg">
              {dayDividers.map((i) => <line key={i} x1={X(i) - (VW / NB) / 2} y1={0} x2={X(i) - (VW / NB) / 2} y2={VH} stroke="var(--line-2)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />)}
              <line x1={0} y1={VH} x2={VW} y2={VH} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {buckets.map((_, i) => { let yb = VH; return <g key={i}>{series.map((s) => { const h = (s.vals[i] / maxTotal) * (VH - 6); if (h <= 0) return null; const y = yb - h; yb = y; return <rect key={s.id} x={X(i) - colW / 2} y={y} width={colW} height={h} fill={s.color} rx={NB < 30 ? 2 : 0}><title>{`${nameById.get(s.id)}: ${s.vals[i]}`}</title></rect>; })}</g>; })}
            </svg>
            <div className="rate-axis">{buckets.map((b, i) => i % axisStep === 0 ? <span key={b} style={{ left: `${(i / Math.max(1, NB - 1)) * 100}%`, transform: i === 0 ? "none" : i >= NB - 2 ? "translateX(-100%)" : "translateX(-50%)" }}>{fmtAxis(b)}</span> : null)}</div>
          </>
        )}
      </div>
    </>
  );
}
