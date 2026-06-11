"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";
import { PUB_COLORS } from "@/components/TimeRangeFilter";

type B = { source_id: number; bucket: string; n: number };
type Unit = "hour" | "day" | "week";
const short = (n: string) => n.replace(" Online", "");
const VW = 1000, VH = 220;
const PAD_L = 44, PAD_B = 24, PAD_T = 18, PAD_R = 12;
const CW = VW - PAD_L - PAD_R;
const CH = VH - PAD_T - PAD_B;

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
  const [cursor, setCursor] = useState<{ x: number; bucketIdx: number } | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);

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

  const truncTo = (iso: string, u: Unit) => {
    const d = new Date(iso);
    if (u === "hour") d.setUTCMinutes(0, 0, 0);
    else if (u === "day") d.setUTCHours(0, 0, 0, 0);
    else { d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); }
    return d;
  };

  const buckets = useMemo(() => {
    const out: string[] = [];
    const cur = truncTo(fromIso, unit);
    const end = new Date(toIso);
    let g = 0;
    while (cur <= end && g++ < 3000) {
      out.push(cur.toISOString());
      if (unit === "hour") cur.setUTCHours(cur.getUTCHours() + 1);
      else if (unit === "day") cur.setUTCDate(cur.getUTCDate() + 1);
      else cur.setUTCDate(cur.getUTCDate() + 7);
    }
    return out;
  }, [fromIso, toIso, unit]);

  const { series, maxVal } = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const r of rows) {
      if (!map.has(r.source_id)) map.set(r.source_id, new Map());
      const m = map.get(r.source_id)!;
      const k = truncTo(r.bucket, unit).toISOString();
      m.set(k, (m.get(k) ?? 0) + r.n);
    }
    const ser = sources.filter((s) => act.has(s.id)).map((s) => ({
      id: s.id, color: colorById.get(s.id)!,
      vals: buckets.map((b) => map.get(s.id)?.get(b) ?? 0),
    }));
    // max ist das Maximum einer einzelnen Serie (nicht gestapelt)
    const mx = Math.max(1, ...ser.flatMap((s) => s.vals));
    return { series: ser, maxVal: mx };
  }, [rows, sources, act, buckets, unit]);

  const NB = buckets.length;
  // Mindest-Pixel pro Bucket für horizontales Scrollen
  const minPxPerBucket = unit === "hour" ? 28 : unit === "day" ? 18 : 40;
  // naturalWidth: Mindestbreite des Zeichenbereichs (ohne Padding).
  // Wenn NB Buckets × minPx < CW → Chart nutzt immer die volle Containerbreite.
  const naturalWidth = Math.max(CW, NB * minPxPerBucket);
  const totalSvgW = naturalWidth + PAD_L + PAD_R;
  // Muss gescrollt werden?
  const needsScroll = naturalWidth > CW;

  const X = (i: number) => PAD_L + (i / Math.max(1, NB - 1)) * naturalWidth;
  const Y = (v: number) => PAD_T + CH - (v / maxVal) * CH;

  // Nicht-gestapelte Serien: Smooth Monotone Cubic (cardinal spline)
  function smoothPath(vals: number[]): string {
    if (vals.length < 2) return "";
    const pts = vals.map((v, i) => [X(i), Y(v)] as [number, number]);
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const cp = (x1 - x0) * 0.45;
      d += ` C${(x0 + cp).toFixed(1)},${y0.toFixed(1)} ${(x1 - cp).toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return d;
  }
  function areaPath(vals: number[]): string {
    if (vals.length < 2) return "";
    const line = smoothPath(vals);
    const last = X(vals.length - 1);
    const base = PAD_T + CH;
    return `${line} L${last.toFixed(1)},${base.toFixed(1)} L${PAD_L.toFixed(1)},${base.toFixed(1)} Z`;
  }

  // Tagestrennlinien (Stunden-Modus)
  const dayDividers = useMemo(() => {
    if (unit !== "hour") return [];
    const out: { idx: number; label: string }[] = [];
    for (let i = 1; i < buckets.length; i++) {
      const d = new Date(buckets[i]);
      if (d.getUTCHours() === 0) {
        out.push({ idx: i, label: d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: "UTC" }) });
      }
    }
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

  // Y-Achsen-Ticks
  const yTicks = useMemo(() => {
    const nTicks = 4;
    const step = Math.ceil(maxVal / nTicks) || 1;
    const ticks: number[] = [];
    for (let v = 0; v <= maxVal; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < maxVal) ticks.push(maxVal);
    return ticks;
  }, [maxVal]);

  // Cursor-Bucket-Info
  const cursorInfo = useMemo(() => {
    if (cursor === null || cursor.bucketIdx < 0 || cursor.bucketIdx >= NB) return null;
    const idx = cursor.bucketIdx;
    return {
      label: fmtAxis(buckets[idx]),
      entries: series.map((s) => ({ name: nameById.get(s.id)!, color: s.color, val: s.vals[idx] })).filter((e) => e.val > 0),
      total: series.reduce((sum, s) => sum + s.vals[idx], 0),
    };
  }, [cursor, series, buckets, NB]);

  function handleMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    // Maus-X auf SVG-viewBox skalieren (korrekt für beide Modi: feste Breite + stretched)
    const svgX = ((e.clientX - rect.left) / rect.width) * totalSvgW;
    const chartX = svgX - PAD_L;
    if (chartX < 0 || chartX > naturalWidth) { setCursor(null); return; }
    const idx = Math.round((chartX / naturalWidth) * (NB - 1));
    setCursor({ x: X(idx), bucketIdx: idx });
  }

  return (
    <>
      <h2 className="section-h" style={{ alignItems: "center", flexWrap: "wrap" }}>
        Publikationen über Zeit
        <span className="count">{total.toLocaleString("de-DE")} Artikel · {fromD}–{toD}</span>
        <div className="seg" style={{ marginLeft: "auto" }}>
          <button className={manual === "auto" ? "on" : ""} onClick={() => setManual("auto")} title="Dynamisch">⟳ Dynamisch</button>
          <button className={manual === "hour" ? "on" : ""} onClick={() => setManual("hour")}>Stunde</button>
          <button className={manual === "day" ? "on" : ""} onClick={() => setManual("day")}>Tag</button>
          <button className={manual === "week" ? "on" : ""} onClick={() => setManual("week")}>Woche</button>
        </div>
      </h2>
      <div className="panel pad">
        {!rows.length ? (
          <p className="faint" style={{ fontSize: 13 }}>Keine veröffentlichten Artikel im gewählten Zeitraum.</p>
        ) : (
          <>
            <div className="rate-legend">
              {series.map((s) => <span key={s.id}><i style={{ background: s.color }} />{nameById.get(s.id)}</span>)}
              <span style={{ marginLeft: "auto", color: "var(--faint)" }}>
                Einheit: <b style={{ color: "var(--accent)" }}>{unitLabel}</b>{manual === "auto" ? " (dynamisch)" : ""}
              </span>
            </div>

            {/* Scrollbarer Chart-Container */}
            <div
              ref={scrollRef}
              className="rate-scroll"
              onScroll={(e) => {
                const sl = (e.target as HTMLDivElement).scrollLeft;
                setScrollLeft(sl);
                if (axisRef.current) axisRef.current.scrollLeft = sl;
              }}
            >
              <svg
                viewBox={`0 0 ${totalSvgW} ${VH}`}
                width={needsScroll ? totalSvgW : "100%"}
                height={VH}
                className="rate-svg-inner"
                style={{ display: "block", minWidth: needsScroll ? totalSvgW : "100%" }}
                preserveAspectRatio={needsScroll ? undefined : "none"}
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setCursor(null)}
              >
                {/* Y-Achsen-Linien + Labels */}
                {yTicks.map((v) => (
                  <g key={v}>
                    <line x1={PAD_L} y1={Y(v)} x2={totalSvgW - PAD_R} y2={Y(v)}
                      stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    <text x={PAD_L - 6} y={Y(v)} textAnchor="end" dominantBaseline="middle"
                      fontSize="9" fill="var(--faint)">{v}</text>
                  </g>
                ))}

                {/* Tagestrennlinien mit Datum-Label */}
                {dayDividers.map(({ idx, label }) => (
                  <g key={idx}>
                    <line x1={X(idx)} y1={PAD_T} x2={X(idx)} y2={PAD_T + CH}
                      stroke="var(--line-2)" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    <text x={X(idx) + 4} y={PAD_T + 11} fontSize="9" fill="var(--faint)">{label}</text>
                  </g>
                ))}

                {/* Baseline */}
                <line x1={PAD_L} y1={PAD_T + CH} x2={totalSvgW - PAD_R} y2={PAD_T + CH}
                  stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />

                {/* Flächen (transparent, einzeln — nicht gestapelt) */}
                {series.map((s) => (
                  <path key={`a${s.id}`} d={areaPath(s.vals)} fill={s.color} opacity={0.12} />
                ))}

                {/* Linien (abgerundet smooth) */}
                {series.map((s) => (
                  <path key={`l${s.id}`} d={smoothPath(s.vals)} fill="none"
                    stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />
                ))}

                {/* Pulsierende Datenpunkte — Wert nur bei Hover sichtbar */}
                {NB <= 120 && series.map((s) => s.vals.map((v, i) => v > 0 ? (
                  <g key={`${s.id}-${i}`}>
                    {/* Pulsier-Ring */}
                    <circle cx={X(i)} cy={Y(v)} r="6" fill={s.color} opacity="0.18" className="rate-pulse" />
                    {/* Kern-Dot */}
                    <circle cx={X(i)} cy={Y(v)} r="3.5" fill={s.color}
                      stroke="var(--surface)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
                      className="rate-dot" />
                  </g>
                ) : null))}

                {/* Interaktiver Cursor */}
                {cursor !== null && (
                  <line x1={cursor.x} y1={PAD_T} x2={cursor.x} y2={PAD_T + CH}
                    stroke="var(--accent)" strokeWidth="1" opacity="0.5"
                    strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
                )}
              </svg>

              {/* Hover-Tooltip (außerhalb SVG für einfacheres Styling) */}
              {cursor !== null && cursorInfo && (
                <div className="rate-cursor-tip" style={{
                  left: needsScroll ? cursor.x : `${(cursor.x / totalSvgW) * 100}%`,
                }}>
                  <div className="rct-label">{cursorInfo.label}</div>
                  {cursorInfo.entries.map((e) => (
                    <div key={e.name} className="rct-row">
                      <i style={{ background: e.color }} />
                      <span>{e.name}</span>
                      <b>{e.val}</b>
                    </div>
                  ))}
                  {cursorInfo.entries.length > 1 && (
                    <div className="rct-total">Gesamt: <b>{cursorInfo.total}</b></div>
                  )}
                </div>
              )}
            </div>

            {/* X-Achse (scrollt mit wenn nötig, sonst 100%-Breite) */}
            <div className="rate-axis-wrap" ref={axisRef}>
              <div className="rate-axis" style={{ width: needsScroll ? totalSvgW : "100%", position: "relative" }}>
                {buckets.map((b, i) => {
                  if (i % axisStep !== 0) return null;
                  // Prozentuale Position innerhalb des Zeichenbereichs [PAD_L/totalSvgW … (totalSvgW-PAD_R)/totalSvgW]
                  const pct = needsScroll
                    ? undefined
                    : `${((PAD_L + (i / Math.max(1, NB - 1)) * naturalWidth) / totalSvgW) * 100}%`;
                  const abs = needsScroll
                    ? PAD_L + (i / Math.max(1, NB - 1)) * naturalWidth
                    : undefined;
                  return (
                    <span key={b} style={{
                      position: "absolute",
                      left: pct ?? abs,
                      transform: i === 0 ? "none" : i >= NB - 2 ? "translateX(-100%)" : "translateX(-50%)",
                    }}>{fmtAxis(b)}</span>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
