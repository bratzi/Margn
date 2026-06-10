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
      p_sources: activeArr, p_topics: f.topics.length ? f.topics : null, p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang),
      p_from: fromIso, p_to: toIso, p_bucket: unit,
    }).limit(6000).then(({ data }) => setRows((data as B[]) ?? []));
  }, [activeArr.join(","), f.topics.join(","), f.paywall, f.author, f.lang, fromIso, toIso, unit]);

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

  const { series, maxTotal, totals } = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const r of rows) { if (!map.has(r.source_id)) map.set(r.source_id, new Map()); const m = map.get(r.source_id)!; const k = truncTo(r.bucket, unit).toISOString(); m.set(k, (m.get(k) ?? 0) + r.n); }
    const ser = sources.filter((s) => act.has(s.id)).map((s) => ({ id: s.id, color: colorById.get(s.id)!, vals: buckets.map((b) => map.get(s.id)?.get(b) ?? 0) }));
    const tot = buckets.map((_, i) => ser.reduce((sum, s) => sum + s.vals[i], 0));
    return { series: ser, maxTotal: Math.max(1, ...tot), totals: tot };
  }, [rows, sources, act, buckets, unit]);

  const NB = buckets.length;
  const X = (i: number) => (i / Math.max(1, NB - 1)) * VW;
  const Y = (v: number) => VH - (v / maxTotal) * (VH - 18);

  // Gestapelte Flächen: je Serie kumulierte Ober-/Unterkante, als geschlossener Pfad.
  const stacked = useMemo(() => {
    const base = new Array(NB).fill(0);
    return series.map((s) => {
      const lower = [...base];
      for (let i = 0; i < NB; i++) base[i] += s.vals[i];
      const upper = [...base];
      const fwd = upper.map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
      const back = [...lower].reverse().map((v, j) => `L${X(NB - 1 - j).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
      const line = upper.map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
      return { ...s, area: `${fwd} ${back} Z`, line, upper };
    });
  }, [series, NB, maxTotal]);

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
              {dayDividers.map((i) => <line key={i} x1={X(i)} y1={0} x2={X(i)} y2={VH} stroke="var(--line-2)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />)}
              <line x1={0} y1={VH} x2={VW} y2={VH} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {/* Gefüllte Kurven (gestapelt, leicht transparent) + Konturlinie */}
              {stacked.map((s) => <path key={`a${s.id}`} d={s.area} fill={s.color} opacity={0.28} />)}
              {stacked.map((s) => <path key={`l${s.id}`} d={s.line} fill="none" stroke={s.color} strokeWidth="1.8" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
              {/* Dots auf den Wertepunkten (bei lesbarer Dichte) */}
              {NB <= 70 && stacked.map((s) => s.upper.map((v, i) => s.vals[i] > 0 ? (
                <circle key={`${s.id}-${i}`} cx={X(i)} cy={Y(v)} r={NB <= 24 ? 3 : 2} fill={s.color} stroke="var(--surface)" strokeWidth="1">
                  <title>{`${nameById.get(s.id)}: ${s.vals[i]} (${fmtAxis(buckets[i])})`}</title>
                </circle>
              ) : null))}
              {/* Dezente Gesamt-Beschriftung über den Spitzen */}
              {NB <= 24 && totals.map((t, i) => t > 0 ? <text key={i} x={X(i)} y={Y(t) - 7} textAnchor="middle" fontSize="9.5" fill="var(--faint)">{t}</text> : null)}
            </svg>
            <div className="rate-axis">{buckets.map((b, i) => i % axisStep === 0 ? <span key={b} style={{ left: `${(i / Math.max(1, NB - 1)) * 100}%`, transform: i === 0 ? "none" : i >= NB - 2 ? "translateX(-100%)" : "translateX(-50%)" }}>{fmtAxis(b)}</span> : null)}</div>
          </>
        )}
      </div>
    </>
  );
}
