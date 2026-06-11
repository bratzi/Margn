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
const ZOOM_MIN = 1, ZOOM_MAX = 14;

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
  // Zoom-Faktor (Mausrad) + Drag-to-Zoom-Auswahl in Pixeln
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const axisRef = useRef<HTMLDivElement>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const dragStartRef = useRef<number | null>(null);

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
  const autoUnit: Unit = spanDays <= 3 ? "hour" : spanDays <= 45 ? "day" : "week";
  const unit: Unit = manual === "auto" ? autoUnit : manual;

  // Zoom zurücksetzen, wenn sich Einheit oder Zeitraum ändert
  useEffect(() => { setZoom(1); setDrag(null); setHoverDot(null); }, [unit, fromIso, toIso]);

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
  const minPxPerBucket = unit === "hour" ? 28 : unit === "day" ? 18 : 40;
  const availW = (containerW > 0 ? containerW : VW) - PAD_L - PAD_R;
  // Zoom multipliziert die Datendichte → X-Achse wird breiter (scrollbar)
  const dataWidth = NB * minPxPerBucket * zoom;
  const naturalWidth = Math.max(availW, dataWidth);
  const totalSvgW = naturalWidth + PAD_L + PAD_R;
  const zoomed = zoom > 1.001;

  const X = (i: number) => PAD_L + (i / Math.max(1, NB - 1)) * naturalWidth;
  const Y = (v: number) => PAD_T + CH - (v / maxVal) * CH;
  // Pixel→Bucket-Index (SVG-Koordinaten)
  const idxAtX = (svgX: number) => {
    const cx = svgX - PAD_L;
    return Math.max(0, Math.min(NB - 1, Math.round((cx / naturalWidth) * (NB - 1))));
  };

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
  const axisStep = Math.max(1, Math.ceil(NB / (zoomed ? 18 : 10)));

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

  // SVG-X aus einem Maus-Event (für Drag-to-Zoom)
  const svgXFromEvent = (e: React.MouseEvent<SVGSVGElement> | React.WheelEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * totalSvgW;
  };

  // Mausrad → Zoom (Position unter dem Cursor bleibt fixiert)
  function handleWheel(e: React.WheelEvent<SVGSVGElement>) {
    if (!scrollRef.current) return;
    e.preventDefault();
    const el = scrollRef.current;
    const rect = el.getBoundingClientRect();
    const pointerInContainer = e.clientX - rect.left;     // px im sichtbaren Container
    const contentX = el.scrollLeft + pointerInContainer;  // px im (skalierten) Inhalt
    const ratio = contentX / totalSvgW;                   // relative Position [0..1]
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    const nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
    if (nextZoom === zoom) return;
    setZoom(nextZoom);
    // Nach Re-Render Scrollposition so setzen, dass der Punkt unter dem Cursor bleibt
    const nextTotal = Math.max(availW, NB * minPxPerBucket * nextZoom) + PAD_L + PAD_R;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        const sl = ratio * nextTotal - pointerInContainer;
        scrollRef.current.scrollLeft = sl;
        if (axisRef.current) axisRef.current.scrollLeft = sl;
      }
    });
  }

  // Drag-to-Zoom: gedrückt ziehen markiert Bereich, Loslassen zoomt rein
  function handleDown(e: React.MouseEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    const x = svgXFromEvent(e);
    if (x < PAD_L || x > totalSvgW - PAD_R) return;
    dragStartRef.current = x;
    setHoverDot(null);
  }
  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    if (dragStartRef.current === null) return;
    const x = svgXFromEvent(e);
    setDrag({ x0: dragStartRef.current, x1: Math.max(PAD_L, Math.min(totalSvgW - PAD_R, x)) });
  }
  function handleUp() {
    const sel = drag;
    dragStartRef.current = null;
    setDrag(null);
    if (!sel) return;
    const lo = Math.min(sel.x0, sel.x1), hi = Math.max(sel.x0, sel.x1);
    if (hi - lo < 12) return; // zu kleine Auswahl = Klick, ignorieren
    const iLo = idxAtX(lo), iHi = idxAtX(hi);
    const span = Math.max(1, iHi - iLo);
    // Ziel: der gewählte Bereich soll die volle Breite füllen → Zoom = NB/span
    const targetZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (NB - 1) / span));
    setZoom(targetZoom);
    const nextTotal = Math.max(availW, NB * minPxPerBucket * targetZoom) + PAD_L + PAD_R;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        const sl = PAD_L + (iLo / Math.max(1, NB - 1)) * (nextTotal - PAD_L - PAD_R) - PAD_L;
        scrollRef.current.scrollLeft = Math.max(0, sl);
        if (axisRef.current) axisRef.current.scrollLeft = Math.max(0, sl);
      }
    });
  }

  const resetZoom = () => {
    setZoom(1); setDrag(null);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    if (axisRef.current) axisRef.current.scrollLeft = 0;
  };

  // Dots nur zeigen, wenn nicht zu dicht (sonst Linie pur)
  const showDots = NB / Math.max(1, zoom) <= 120 || zoomed;

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
              <span className="rate-hint">Mausrad zoomt · Bereich ziehen zoomt rein</span>
              {zoomed && <button className="rate-zoomreset" onClick={resetZoom} title="Zoom zurücksetzen">⤢ {zoom.toFixed(1)}× · zurücksetzen</button>}
              <span style={{ marginLeft: zoomed ? 0 : "auto", color: "var(--faint)" }}>
                Einheit: <b style={{ color: "var(--accent)" }}>{unitLabel}</b>{manual === "auto" ? " (dynamisch)" : ""}
              </span>
            </div>

            <div
              ref={measure}
              className={`rate-scroll ${dragStartRef.current !== null ? "is-selecting" : ""}`}
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
                      {/* unsichtbare große Hitbox für leichtes Treffen */}
                      <circle cx={X(i)} cy={Y(v)} r="11" fill="transparent" style={{ cursor: "pointer" }}
                        onMouseEnter={() => dragStartRef.current === null && setHoverDot({ sid: s.id, idx: i, x: X(i), y: Y(v) })}
                        onMouseLeave={() => setHoverDot((h) => (h?.sid === s.id && h?.idx === i ? null : h))} />
                    </g>
                  );
                }))}

                {/* Drag-to-Zoom-Auswahl */}
                {drag && (
                  <rect
                    x={Math.min(drag.x0, drag.x1)} y={PAD_T}
                    width={Math.abs(drag.x1 - drag.x0)} height={CH}
                    fill="var(--accent)" opacity="0.12" stroke="var(--accent)" strokeWidth="1"
                    strokeDasharray="3 2" vectorEffect="non-scaling-stroke" pointerEvents="none"
                  />
                )}
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
