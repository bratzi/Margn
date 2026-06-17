"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFilters, WINDOW_OPTS } from "@/components/FilterProvider";
import { effTime, makeMatcher, snapshotOf } from "@/lib/filterCorpus";

export const PUB_COLORS = ["#3D63DD", "#1A7F55", "#CF4035", "#B0790C", "#0C8F86", "#8B5CF6", "#D6457A", "#0E7490"];
const short = (n: string) => n.replace(" Online", "");
const VW = 1000, VH = 100;

type HoverDay = { idx: number; clientX: number; clientY: number };

export default function TimeRangeFilter() {
  const f = useFilters();
  const { sources, activeArr, days, rangeIdx, setRangeIdx, trfOpen, setTrfOpen, windowDays, setWindowDays } = f;
  const N = days.length;
  const [h, setH] = useState(168);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<null | "from" | "to" | "band" | "resize">(null);
  const dragRef = useRef<{ start: number; f: number; t: number } | null>(null);
  const [live, setLive] = useState(rangeIdx);
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => { if (!drag) setLive(rangeIdx); }, [rangeIdx, drag]);

  // Hover-Tooltip
  const [hoverDay, setHoverDay] = useState<HoverDay | null>(null);

  const colorById = useMemo(() => new Map(sources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])), [sources]);
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, short(s.name)])), [sources]);
  const act = useMemo(() => new Set(activeArr), [activeArr]);

  // Säulen direkt aus dem gemeinsamen Corpus — GLEICHES Prädikat wie die Tabelle,
  // nur ohne Zeitfilter (die Zeitachse ist ja der Chart selbst). Damit stimmen die
  // Balken exakt mit den Tabellen-Treffern des jeweiligen Tages überein.
  const { series } = useMemo(() => {
    const snap = snapshotOf(f as any);
    const match = makeMatcher(snap, f.subPats, f.kwIdSet, { time: true });
    const dayIdx = new Map(days.map((d, i) => [d, i]));
    const map = new Map<number, number[]>();
    for (const r of f.corpus) {
      if (!act.has(r.source_id)) continue;
      if (!match(r)) continue;
      const t = effTime(r);
      if (!t) continue;
      const i = dayIdx.get(t.slice(0, 10));
      if (i === undefined) continue;
      let vals = map.get(r.source_id);
      if (!vals) { vals = new Array(days.length).fill(0); map.set(r.source_id, vals); }
      vals[i]++;
    }
    const ser = sources.filter((s) => act.has(s.id)).map((s) => ({
      id: s.id, color: colorById.get(s.id)!, vals: map.get(s.id) ?? new Array(days.length).fill(0),
    }));
    return { series: ser };
  }, [f.corpus, f.corpusReady, sources, act, days, colorById,
      f.status, f.paywall, f.atype, f.author, f.topics.join(","), f.lang, f.changed, f.depth,
      f.subPats.join("|"), f.kwIdSet]);

  const maxTotal = useMemo(() => {
    const tot = days.map((_, i) => series.reduce((sum, s) => sum + s.vals[i], 0));
    return Math.max(1, ...tot);
  }, [series, days]);

  const X = (i: number) => (i / (N - 1)) * VW;
  const colW = (VW / N) * 0.72;
  const pctOf = (i: number) => (i / (N - 1)) * 100;
  const halfColPct = (colW / 2 / VW) * 100;
  const edgeLeft = (i: number) => Math.max(0, pctOf(i) - halfColPct);
  const edgeRight = (i: number) => Math.min(100, pctOf(i) + halfColPct);
  const chartH = Math.max(60, h - 60);

  const idxFromClient = useCallback((clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(N - 1, Math.round(((clientX - rect.left) / rect.width) * (N - 1))));
  }, [N]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (drag === "resize") { setH(Math.max(96, Math.min(440, window.innerHeight - e.clientY))); return; }
      const i = idxFromClient(e.clientX);
      const cur = liveRef.current;
      if (drag === "from") setLive({ from: Math.min(i, cur.to), to: cur.to });
      else if (drag === "to") setLive({ from: cur.from, to: Math.max(i, cur.from) });
      else if (dragRef.current) {
        const d0 = dragRef.current, delta = i - d0.start, w = d0.t - d0.f;
        let nf = d0.f + delta, nt = d0.t + delta;
        if (nf < 0) { nf = 0; nt = w; } if (nt > N - 1) { nt = N - 1; nf = nt - w; }
        setLive({ from: nf, to: nt });
      }
    };
    const up = () => {
      setDrag(null); dragRef.current = null; document.body.style.userSelect = "";
      if (drag !== "resize") setRangeIdx(liveRef.current);
    };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag, idxFromClient, setRangeIdx, N]);

  const start = (k: typeof drag, e: React.PointerEvent) => {
    document.body.style.userSelect = "none";
    if (k === "band") dragRef.current = { start: idxFromClient(e.clientX), f: liveRef.current.from, t: liveRef.current.to };
    setDrag(k);
  };
  const fmtDay = (ds: string) => new Date(ds + "T00:00:00Z").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });

  // Klick auf einen Tag: Pinpoint OHNE sourceId → alle Publizisten dieses Tages sichtbar
  const handleDayClick = (dayIdx: number) => {
    const total = series.reduce((sum, s) => sum + s.vals[dayIdx], 0);
    if (total === 0) return;
    const day = days[dayIdx];
    f.setPinpoint({ from: day + "T00:00:00Z", to: day + "T23:59:59Z", label: fmtDay(day) });
  };

  if (!trfOpen) {
    return (
      <div className="trf trf-mini">
        <button className="rail-toggle" onClick={() => setTrfOpen(true)} title="Zeitstrahl aufklappen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 18V9M9 18V5M14 18v-7M19 18v-4" /></svg></button>
        <span className="trf-mini-label">Veröffentlicht: <b>{rangeIdx.from === rangeIdx.to ? fmtDay(days[rangeIdx.from]) : `${fmtDay(days[rangeIdx.from])} – ${fmtDay(days[rangeIdx.to])}`}</b></span>
      </div>
    );
  }

  return (
    <div className="trf trf-open" style={{ height: h }}>
      <div className="trf-resize" onPointerDown={(e) => start("resize", e)} title="Höhe ziehen"><span /></div>
      <div className="trf-head">
        <div className="trf-title">Veröffentlichungs-Zeitraum <span className="trf-range">{live.from === live.to ? fmtDay(days[live.from]) : `${fmtDay(days[live.from])} – ${fmtDay(days[live.to])}`}</span></div>
        <div className="seg seg-xs trf-presets">
          {WINDOW_OPTS.map((n) => (
            <button key={n} className={windowDays === n ? "on" : ""} onClick={() => setWindowDays(n)} title={`Letzte ${n} Tage`}>{n}T</button>
          ))}
        </div>
        <div className="trf-legend">{series.map((s) => <span key={s.id}><i style={{ background: s.color }} />{nameById.get(s.id)}</span>)}</div>
        {(live.from > 0 || live.to < N - 1) && <button className="trf-reset" onClick={() => { setLive({ from: 0, to: N - 1 }); setRangeIdx({ from: 0, to: N - 1 }); }}>Zurücksetzen</button>}
        <button className="rail-toggle" onClick={() => setTrfOpen(false)} title="Einklappen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg></button>
      </div>

      <div
        className="trf-chart" ref={trackRef} style={{ height: chartH }}
        onDoubleClick={(e) => { const i = idxFromClient(e.clientX); setLive({ from: i, to: i }); setRangeIdx({ from: i, to: i }); }}
        onMouseLeave={() => setHoverDay(null)}
        title="Doppelklick: nur diesen Tag · Klick auf Balken: alle Artikel dieses Tages"
      >
        <svg className="trf-svg" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none">
          {days.map((_, i) => {
            let yb = VH;
            return <g key={i}>{series.map((s) => { const ht = (s.vals[i] / maxTotal) * VH; if (ht <= 0) return null; const y = yb - ht; yb = y; return <rect key={s.id} x={X(i) - colW / 2} y={y} width={colW} height={ht} fill={s.color} opacity={0.92} />; })}</g>;
          })}
        </svg>

        {/* Transparente Hover-Overlays je Tag – fangen Hover + Klick ab */}
        {days.map((_, i) => (
          <div
            key={i}
            className="trf-col-hit"
            style={{ left: `${edgeLeft(i)}%`, width: `${Math.max(edgeRight(i) - edgeLeft(i), 1)}%` }}
            onMouseEnter={(e) => setHoverDay({ idx: i, clientX: e.clientX, clientY: e.clientY })}
            onMouseMove={(e) => setHoverDay((h) => h ? { ...h, clientX: e.clientX, clientY: e.clientY } : h)}
            onClick={() => handleDayClick(i)}
          />
        ))}

        {/* Tooltip */}
        {hoverDay && (() => {
          // Tooltip zeigt immer Per-Tag-Werte (series), unabhängig vom abs/rel-Modus
          const dayData = series.filter((s) => s.vals[hoverDay.idx] > 0);
          if (!dayData.length) return null;
          const total = dayData.reduce((sum, s) => sum + s.vals[hoverDay.idx], 0);
          const rect = trackRef.current?.getBoundingClientRect();
          const relX = rect ? hoverDay.clientX - rect.left : 0;
          const fromRight = rect ? rect.width - relX < 160 : false;
          return (
            <div className="trf-tt" style={{ left: fromRight ? undefined : `${(relX / (rect?.width ?? 1)) * 100}%`, right: fromRight ? `${100 - (relX / (rect?.width ?? 1)) * 100}%` : undefined }}>
              <div className="trf-tt-day">{fmtDay(days[hoverDay.idx])}</div>
              {dayData.map((s) => (
                <div key={s.id} className="trf-tt-row">
                  <i style={{ background: s.color }} />
                  <span>{nameById.get(s.id)}</span>
                  <b>{s.vals[hoverDay.idx]}</b>
                </div>
              ))}
              {dayData.length > 1 && <div className="trf-tt-total">Gesamt: <b>{total}</b></div>}
            </div>
          );
        })()}

        <div className="trf-dim" style={{ left: 0, width: `${edgeLeft(live.from)}%` }} />
        <div className="trf-dim" style={{ right: 0, width: `${100 - edgeRight(live.to)}%` }} />
        <div className={`trf-bandsel ${live.from === live.to ? "single" : ""}`}
          style={{ left: `${edgeLeft(live.from)}%`, width: `${edgeRight(live.to) - edgeLeft(live.from)}%` }}
          onPointerDown={(e) => start("band", e)} />
        <div className="trf-h" style={{ left: `${edgeLeft(live.from)}%` }} onPointerDown={(e) => start("from", e)}><span /></div>
        <div className="trf-h" style={{ left: `${edgeRight(live.to)}%` }} onPointerDown={(e) => start("to", e)}><span /></div>
      </div>
      <div className="trf-axis">{[0, Math.round(N / 4), Math.round(N / 2), Math.round(3 * N / 4), N - 1].map((i, pos) => <span key={i} style={{ left: `${pctOf(i)}%`, transform: pos === 0 ? "none" : pos === 4 ? "translateX(-100%)" : "translateX(-50%)" }}>{fmtDay(days[i])}</span>)}</div>
    </div>
  );
}
