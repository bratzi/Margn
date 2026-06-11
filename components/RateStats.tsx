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
  // Hover auf einen EINZELNEN Datenpunkt (nicht den ganzen Bucket)
  const [hoverDot, setHoverDot] = useState<{ sid: number; idx: number; x: number; y: number } | null>(null);
  const [containerW, setContainerW] = useState(0);
  // dens = Pixel pro Bucket (Stauchen ↔ Strecken). null = automatisch an Containerbreite anpassen.
  const [dens, setDens] = useState<number | null>(null);
  // Im Dynamisch-Modus überschreibt das Mausrad die Einheit (springt Woche↔Tag↔Stunde)
  const [autoUnitOverride, setAutoUnitOverride] = useState<Unit | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  // Pan-Zustand (Click-and-Drag verschiebt die X-Achse)
  const panRef = useRef<{ startX: number; startScroll: number } | null>(null);
  const [panning, setPanning] = useState(false);

  // Container-Breite via Callback-Ref messen (Container existiert erst nach Daten-Load).
  const measure = (el: HTMLDivElement | null) => {
    scrollRef.current = el;
    roRef.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver(() => { const w = el.clientWidth; if (w > 0) setContainerW(w); });
    ro.observe(el);
    roRef.current = ro;
    setContainerW(el.clientWidth);
  };
  useEffect(() => () => roRef.current?.disconnect(), []);

  const fromIso = f.days[f.rangeIdx.from] + "T00:00:00Z";
  const toIso = f.days[f.rangeIdx.to] + "T23:59:59Z";
  const spanDays = f.rangeIdx.to - f.rangeIdx.from + 1;
  const baseAutoUnit: Unit = spanDays <= 3 ? "hour" : spanDays <= 45 ? "day" : "week";
  // Im Dynamisch-Modus darf das Mausrad die Einheit verschieben (override), sonst zählt manual.
  const unit: Unit = manual === "auto" ? (autoUnitOverride ?? baseAutoUnit) : manual;
  const UNIT_ORDER: Unit[] = ["week", "day", "hour"]; // grob → fein

  // Dichte/Override zurücksetzen, wenn Modus oder Zeitraum wechselt
  useEffect(() => { setDens(null); setAutoUnitOverride(null); setHoverDot(null); }, [manual, fromIso, toIso]);

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
    const mx = Math.max(1, ...ser.flatMap((s) => s.vals));
    return { series: ser, maxVal: mx };
  }, [rows, sources, act, buckets, unit]);

  const NB = buckets.length;
  const availW = (containerW > 0 ? containerW : VW) - PAD_L - PAD_R;
  // „Fit"-Dichte: so dicht, dass alle Buckets genau die Containerbreite füllen.
  const fitDens = availW / Math.max(1, NB - 1);
  // Erlaubter Dichtebereich: stauchen bis fitDens (nie schmaler als Container),
  // strecken bis großzügig (Stunden brauchen weniger px als Wochen).
  const maxDens = unit === "hour" ? 70 : unit === "day" ? 90 : 160;
  const effDens = dens === null ? fitDens : Math.max(fitDens, Math.min(maxDens, dens));
  // naturalWidth: Datendichte × Bucketzahl, aber nie schmaler als der Container.
  const naturalWidth = Math.max(availW, effDens * Math.max(1, NB - 1));
  const totalSvgW = naturalWidth + PAD_L + PAD_R;
  const stretched = naturalWidth > availW + 1; // breiter als Container → scrollbar

  const X = (i: number) => PAD_L + (i / Math.max(1, NB - 1)) * naturalWidth;
  const Y = (v: number) => PAD_T + CH - (v / maxVal) * CH;

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
  // Volles Datum+Zeit für den Dot-Tooltip
  const fmtFull = (iso: string) => {
    const d = new Date(iso);
    if (unit === "hour") return d.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " Uhr";
    if (unit === "week") return "KW " + isoWeek(d) + " · " + d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" });
    return d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "UTC" });
  };

  const unitLabel = unit === "hour" ? "Stunden" : unit === "day" ? "Tage" : "Kalenderwochen";
  const total = series.reduce((s, x) => s + x.vals.reduce((a, b) => a + b, 0), 0);
  const fromD = new Date(fromIso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const toD = new Date(toIso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const axisStep = Math.max(1, Math.ceil(NB / (stretched ? 18 : 10)));

  const yTicks = useMemo(() => {
    const nTicks = 4;
    const step = Math.ceil(maxVal / nTicks) || 1;
    const ticks: number[] = [];
    for (let v = 0; v <= maxVal; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < maxVal) ticks.push(maxVal);
    return ticks;
  }, [maxVal]);

  const hoverInfo = useMemo(() => {
    if (!hoverDot) return null;
    const s = series.find((x) => x.id === hoverDot.sid);
    if (!s) return null;
    return { name: nameById.get(s.id)!, color: s.color, val: s.vals[hoverDot.idx], when: fmtFull(buckets[hoverDot.idx]) };
  }, [hoverDot, series, buckets]);

  // Mausrad: kontrolliert in beide Richtungen stauchen/strecken.
  // Dynamisch-Modus: an den Dichte-Enden springt die EINHEIT (grob ↔ fein).
  // pointerRatio = relative Position im Content [0..1]; pointerPx = Pixel im sichtbaren Container.
  function applyZoom(dir: 1 | -1, pointerRatio: number, pointerPx: number) {
    const cur = effDens;
    const STEP = 1.22; // sanfte, gerasterte Schritte (kontrolliert)
    let next = dir > 0 ? cur * STEP : cur / STEP;

    if (manual === "auto") {
      const order = UNIT_ORDER; // week → day → hour
      const ui = order.indexOf(unit);
      // Weiter reinzoomen am oberen Dichte-Ende → feinere Einheit
      if (dir > 0 && next >= maxDens - 0.5 && ui < order.length - 1) {
        setAutoUnitOverride(order[ui + 1]); setDens(null);
        return;
      }
      // Weiter rauszoomen am Fit-Ende → gröbere Einheit
      if (dir < 0 && next <= fitDens + 0.5 && ui > 0) {
        setAutoUnitOverride(order[ui - 1]); setDens(null);
        return;
      }
    }
    next = Math.max(fitDens, Math.min(maxDens, next));
    if (Math.abs(next - cur) < 0.01) return;
    setDens(next);
    // Punkt unter dem Cursor halten: Content-Punkt (ratio·nextTotal) soll an Pixel pointerPx liegen.
    const nextTotal = Math.max(availW, next * Math.max(1, NB - 1)) + PAD_L + PAD_R;
    requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      el.scrollLeft = Math.max(0, pointerRatio * nextTotal - pointerPx);
      if (axisRef.current) axisRef.current.scrollLeft = el.scrollLeft;
    });
  }

  function handleWheel(e: React.WheelEvent<SVGSVGElement>) {
    if (!scrollRef.current) return;
    e.preventDefault();
    const el = scrollRef.current;
    const rect = el.getBoundingClientRect();
    const pointerInContainer = e.clientX - rect.left;
    const ratio = (el.scrollLeft + pointerInContainer) / totalSvgW;
    applyZoom(e.deltaY < 0 ? 1 : -1, ratio, pointerInContainer);
    setHoverDot(null);
  }

  // Click-and-Drag verschiebt die X-Achse (Pan). Nur sinnvoll wenn gescrollt werden kann.
  function handleDown(e: React.MouseEvent<SVGSVGElement>) {
    if (e.button !== 0 || !scrollRef.current || !stretched) return;
    panRef.current = { startX: e.clientX, startScroll: scrollRef.current.scrollLeft };
    setPanning(true);
    setHoverDot(null);
  }
  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const p = panRef.current;
    if (!p || !scrollRef.current) return;
    const sl = p.startScroll - (e.clientX - p.startX);
    scrollRef.current.scrollLeft = sl;
    if (axisRef.current) axisRef.current.scrollLeft = scrollRef.current.scrollLeft;
  }
  function handleUp() { panRef.current = null; setPanning(false); }

  const resetZoom = () => {
    setDens(null); setAutoUnitOverride(null);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    if (axisRef.current) axisRef.current.scrollLeft = 0;
  };
  const zoomMod = dens !== null || autoUnitOverride !== null;

  // Dots zeigen, solange sie nicht zu dicht stehen (px-Abstand der Buckets)
  const showDots = effDens >= 7;

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
              <span className="rate-hint">Mausrad: stauchen / strecken{stretched ? " · ziehen verschiebt" : ""}</span>
              {zoomMod && <button className="rate-zoomreset" onClick={resetZoom} title="Ansicht zurücksetzen">⤢ zurücksetzen</button>}
              <span style={{ marginLeft: zoomMod ? 0 : "auto", color: "var(--faint)" }}>
                Einheit: <b style={{ color: "var(--accent)" }}>{unitLabel}</b>{manual === "auto" ? " (dynamisch)" : ""}
              </span>
            </div>

            <div
              ref={measure}
              className={`rate-scroll ${stretched ? "can-pan" : ""} ${panning ? "is-panning" : ""}`}
              onScroll={(e) => {
                const sl = (e.target as HTMLDivElement).scrollLeft;
                if (axisRef.current) axisRef.current.scrollLeft = sl;
              }}
            >
              <svg
                key={`${unit}-${NB}`}
                viewBox={`0 0 ${totalSvgW} ${VH}`}
                width={totalSvgW}
                height={VH}
                className="rate-svg-inner data-fade-in"
                style={{ display: "block", touchAction: "pan-x" }}
                onWheel={handleWheel}
                onMouseDown={handleDown}
                onMouseMove={handleMove}
                onMouseUp={handleUp}
                onMouseLeave={() => { handleUp(); setHoverDot(null); }}
              >
                {yTicks.map((v) => (
                  <g key={v}>
                    <line x1={PAD_L} y1={Y(v)} x2={totalSvgW - PAD_R} y2={Y(v)}
                      stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                    <text x={PAD_L - 6} y={Y(v)} textAnchor="end" dominantBaseline="middle"
                      fontSize="9" fill="var(--faint)">{v}</text>
                  </g>
                ))}

                {dayDividers.map(({ idx, label }) => (
                  <g key={idx}>
                    <line x1={X(idx)} y1={PAD_T} x2={X(idx)} y2={PAD_T + CH}
                      stroke="var(--line-2)" strokeWidth="1" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                    <text x={X(idx) + 4} y={PAD_T + 11} fontSize="9" fill="var(--faint)">{label}</text>
                  </g>
                ))}

                <line x1={PAD_L} y1={PAD_T + CH} x2={totalSvgW - PAD_R} y2={PAD_T + CH}
                  stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />

                {series.map((s) => (
                  <path key={`a${s.id}`} d={areaPath(s.vals)} fill={s.color} opacity={0.12} />
                ))}
                {series.map((s) => (
                  <path key={`l${s.id}`} d={smoothPath(s.vals)} fill="none"
                    stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke" />
                ))}

                {/* Datenpunkte — Tooltip NUR beim Hover auf den einzelnen Dot */}
                {showDots && series.map((s) => s.vals.map((v, i) => {
                  if (v <= 0) return null;
                  const isHover = hoverDot?.sid === s.id && hoverDot?.idx === i;
                  return (
                    <g key={`${s.id}-${i}`}>
                      {/* dezenter Pulsier-Ring (stärker als zuvor, mit Stil) */}
                      <circle cx={X(i)} cy={Y(v)} r="4" fill={s.color} className="rate-pulse" style={{ ["--c" as any]: s.color }} />
                      {/* Kern-Dot */}
                      <circle cx={X(i)} cy={Y(v)} r={isHover ? 5.5 : 3.4} fill={s.color}
                        stroke="var(--surface)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
                        className="rate-dot" />
                      {/* unsichtbare große Hitbox für leichtes Treffen (nicht während Pan) */}
                      <circle cx={X(i)} cy={Y(v)} r="11" fill="transparent" style={{ cursor: stretched ? "grab" : "pointer" }}
                        onMouseEnter={() => !panRef.current && setHoverDot({ sid: s.id, idx: i, x: X(i), y: Y(v) })}
                        onMouseLeave={() => setHoverDot((h) => (h?.sid === s.id && h?.idx === i ? null : h))} />
                    </g>
                  );
                }))}
              </svg>

              {/* Per-Dot-Tooltip */}
              {hoverInfo && hoverDot && (
                <div className="rate-cursor-tip rate-dot-tip" style={{ left: hoverDot.x, top: hoverDot.y }}>
                  <div className="rct-label">{hoverInfo.when}</div>
                  <div className="rct-row">
                    <i style={{ background: hoverInfo.color }} />
                    <span>{hoverInfo.name}</span>
                    <b>{hoverInfo.val}</b>
                  </div>
                </div>
              )}
            </div>

            <div className="rate-axis-wrap" ref={axisRef}>
              <div className="rate-axis" style={{ width: totalSvgW, position: "relative" }}>
                {buckets.map((b, i) => {
                  if (i % axisStep !== 0) return null;
                  return (
                    <span key={b} style={{
                      position: "absolute",
                      left: X(i),
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
