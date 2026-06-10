"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";

type TL = { source_id: number; day: string; n: number };
export const PUB_COLORS = ["#3D63DD", "#1A7F55", "#CF4035", "#B0790C", "#0C8F86", "#8B5CF6", "#D6457A", "#0E7490"];
const short = (n: string) => n.replace(" Online", "");
const VW = 1000, VH = 100;

export default function TimeRangeFilter() {
  const f = useFilters();
  const { sources, activeArr, days, rangeIdx, setRangeIdx, trfOpen, setTrfOpen } = f;
  const N = days.length;
  const [rows, setRows] = useState<TL[]>([]);
  const [h, setH] = useState(168);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<null | "from" | "to" | "band" | "resize">(null);
  const dragRef = useRef<{ start: number; f: number; t: number } | null>(null);
  // Flüssiges Ziehen: während des Drags nur lokaler State (keine Daten-Reloads);
  // commit in den globalen Filter erst beim Loslassen.
  const [live, setLive] = useState(rangeIdx);
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => { if (!drag) setLive(rangeIdx); }, [rangeIdx, drag]);

  // Gefilterte Säulen (Thema/Paywall/Autor/Sprache wirken; Zeitraum NICHT, der kommt aus dem Chart selbst)
  useEffect(() => {
    if (!activeArr.length) { setRows([]); return; }
    supabase.rpc("publish_timeline_f", {
      p_sources: activeArr, p_topics: f.topics.length ? f.topics : null,
      p_paywall: f.paywall === "all" ? null : f.paywall, p_author: f.author === "all" ? null : f.author,
      p_lang: f.lang === "all" ? null : f.lang,
    }).then(({ data }) => setRows((data as TL[]) ?? []));
  }, [activeArr.join(","), f.topics.join(","), f.paywall, f.author, f.lang]);

  const colorById = useMemo(() => new Map(sources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])), [sources]);
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, short(s.name)])), [sources]);
  const act = useMemo(() => new Set(activeArr), [activeArr]);

  const { series, maxTotal } = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const r of rows) { if (!map.has(r.source_id)) map.set(r.source_id, new Map()); map.get(r.source_id)!.set(r.day, r.n); }
    const ser = sources.filter((s) => act.has(s.id)).map((s) => ({ id: s.id, color: colorById.get(s.id)!, vals: days.map((d) => map.get(s.id)?.get(d) ?? 0) }));
    const tot = days.map((_, i) => ser.reduce((sum, s) => sum + s.vals[i], 0));
    return { series: ser, maxTotal: Math.max(1, ...tot) };
  }, [rows, sources, act, days, colorById]);

  const X = (i: number) => (i / (N - 1)) * VW;
  const colW = (VW / N) * 0.72;
  const pctOf = (i: number) => (i / (N - 1)) * 100;
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
      if (drag === "from") setLive({ from: Math.min(i, cur.to - 1), to: cur.to });
      else if (drag === "to") setLive({ from: cur.from, to: Math.max(i, cur.from + 1) });
      else if (dragRef.current) {
        const d0 = dragRef.current, delta = i - d0.start, w = d0.t - d0.f;
        let nf = d0.f + delta, nt = d0.t + delta;
        if (nf < 0) { nf = 0; nt = w; } if (nt > N - 1) { nt = N - 1; nf = nt - w; }
        setLive({ from: nf, to: nt });
      }
    };
    const up = () => {
      setDrag(null); dragRef.current = null; document.body.style.userSelect = "";
      if (drag !== "resize") setRangeIdx(liveRef.current); // erst JETZT laden alle Komponenten
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

  if (!trfOpen) {
    return (
      <div className="trf trf-mini">
        <button className="rail-toggle" onClick={() => setTrfOpen(true)} title="Zeitstrahl aufklappen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 18V9M9 18V5M14 18v-7M19 18v-4" /></svg></button>
        <span className="trf-mini-label">Veröffentlicht: <b>{fmtDay(days[rangeIdx.from])} – {fmtDay(days[rangeIdx.to])}</b></span>
      </div>
    );
  }

  return (
    <div className="trf trf-open" style={{ height: h }}>
      <div className="trf-resize" onPointerDown={(e) => start("resize", e)} title="Höhe ziehen"><span /></div>
      <div className="trf-head">
        <div className="trf-title">Veröffentlichungs-Zeitraum <span className="trf-range">{fmtDay(days[live.from])} – {fmtDay(days[live.to])}</span></div>
        <div className="trf-legend">{series.map((s) => <span key={s.id}><i style={{ background: s.color }} />{nameById.get(s.id)}</span>)}</div>
        {(live.from > 0 || live.to < N - 1) && <button className="trf-reset" onClick={() => { setLive({ from: 0, to: N - 1 }); setRangeIdx({ from: 0, to: N - 1 }); }}>Zurücksetzen</button>}
        <button className="rail-toggle" onClick={() => setTrfOpen(false)} title="Einklappen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg></button>
      </div>

      <div className="trf-chart" ref={trackRef} style={{ height: chartH }}>
        <svg className="trf-svg" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none">
          {days.map((_, i) => {
            let yb = VH;
            return <g key={i}>{series.map((s) => { const ht = (s.vals[i] / maxTotal) * VH; if (ht <= 0) return null; const y = yb - ht; yb = y; return <rect key={s.id} x={X(i) - colW / 2} y={y} width={colW} height={ht} fill={s.color} opacity={0.92} />; })}</g>;
          })}
        </svg>
        <div className="trf-dim" style={{ left: 0, width: `${pctOf(live.from)}%` }} />
        <div className="trf-dim" style={{ right: 0, width: `${100 - pctOf(live.to)}%` }} />
        <div className="trf-bandsel" style={{ left: `${pctOf(live.from)}%`, width: `${pctOf(live.to) - pctOf(live.from)}%` }} onPointerDown={(e) => start("band", e)} />
        <div className="trf-h" style={{ left: `${pctOf(live.from)}%` }} onPointerDown={(e) => start("from", e)}><span /></div>
        <div className="trf-h" style={{ left: `${pctOf(live.to)}%` }} onPointerDown={(e) => start("to", e)}><span /></div>
      </div>
      <div className="trf-axis">{[0, 15, 30, 45, 59].map((i) => <span key={i} style={{ left: `${pctOf(i)}%`, transform: i === 0 ? "none" : i === 59 ? "translateX(-100%)" : "translateX(-50%)" }}>{fmtDay(days[i])}</span>)}</div>
    </div>
  );
}
