"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type TL = { source_id: number; day: string; n: number };
type Src = { id: number; name: string };

export const PUB_COLORS = ["#3D63DD", "#1A7F55", "#CF4035", "#B0790C", "#0C8F86", "#8B5CF6", "#D6457A", "#0E7490"];
const short = (n: string) => n.replace(" Online", "");
const VW = 1000, VH = 100, PADT = 6, PADB = 6, PH = VH - PADT - PADB;

export default function TimeRangeFilter({
  sources, activeSources, fromIdx, toIdx, onChange, open, setOpen,
}: {
  sources: Src[]; activeSources: number[];
  fromIdx: number; toIdx: number; onChange: (fromIdx: number, toIdx: number, days: string[]) => void;
  open: boolean; setOpen: (b: boolean) => void;
}) {
  const [rows, setRows] = useState<TL[]>([]);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<null | "from" | "to" | "band">(null);
  const dragRef = useRef<{ start: number; f: number; t: number } | null>(null);

  useEffect(() => { supabase.from("publish_timeline").select("*").then(({ data }) => setRows((data as TL[]) ?? [])); }, []);

  const days = useMemo(() => {
    const out: string[] = [];
    const d = new Date(); d.setUTCHours(0, 0, 0, 0);
    for (let i = 59; i >= 0; i--) { const x = new Date(d); x.setUTCDate(x.getUTCDate() - i); out.push(x.toISOString().slice(0, 10)); }
    return out;
  }, []);
  const N = days.length;

  const colorById = useMemo(() => new Map(sources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])), [sources]);
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, short(s.name)])), [sources]);
  const act = useMemo(() => new Set(activeSources), [activeSources]);

  const { series, maxV } = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const r of rows) { if (!map.has(r.source_id)) map.set(r.source_id, new Map()); map.get(r.source_id)!.set(r.day, r.n); }
    let mx = 1;
    const ser = sources.filter((s) => act.has(s.id)).map((s) => {
      const m = map.get(s.id); const vals = days.map((d) => m?.get(d) ?? 0);
      mx = Math.max(mx, ...vals);
      return { id: s.id, color: colorById.get(s.id)!, vals };
    });
    return { series: ser, maxV: mx };
  }, [rows, sources, act, days, colorById]);

  const X = (i: number) => (i / (N - 1)) * VW;
  const Y = (v: number) => PADT + (1 - v / maxV) * PH;
  const pctOf = (i: number) => (i / (N - 1)) * 100;

  const idxFromClient = useCallback((clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    const r = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(N - 1, Math.round(r * (N - 1))));
  }, [N]);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const i = idxFromClient(e.clientX);
      if (drag === "from") onChange(Math.min(i, toIdx - 1), toIdx, days);
      else if (drag === "to") onChange(fromIdx, Math.max(i, fromIdx + 1), days);
      else if (dragRef.current) {
        const d0 = dragRef.current, delta = i - d0.start, w = d0.t - d0.f;
        let nf = d0.f + delta, nt = d0.t + delta;
        if (nf < 0) { nf = 0; nt = w; } if (nt > N - 1) { nt = N - 1; nf = nt - w; }
        onChange(nf, nt, days);
      }
    };
    const up = () => { setDrag(null); dragRef.current = null; document.body.style.userSelect = ""; };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [drag, fromIdx, toIdx, days, idxFromClient, onChange, N]);

  const startDrag = (k: "from" | "to" | "band", e: React.PointerEvent) => {
    document.body.style.userSelect = "none";
    if (k === "band") dragRef.current = { start: idxFromClient(e.clientX), f: fromIdx, t: toIdx };
    setDrag(k);
  };

  const fmtDay = (ds: string) => new Date(ds + "T00:00:00Z").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });

  if (!open) {
    return (
      <div className="trf trf-mini">
        <button className="rail-toggle" onClick={() => setOpen(true)} title="Zeitraum-Filter aufklappen" aria-label="Zeitraum aufklappen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>
        </button>
        <span className="trf-mini-label">Veröffentlicht: <b>{fmtDay(days[fromIdx])} – {fmtDay(days[toIdx])}</b></span>
      </div>
    );
  }

  return (
    <div className="trf trf-open">
      <div className="trf-head">
        <div className="trf-title">Veröffentlichungs-Zeitraum <span className="trf-range">{fmtDay(days[fromIdx])} – {fmtDay(days[toIdx])}</span></div>
        <div className="trf-legend">{series.map((s) => <span key={s.id}><i style={{ background: s.color }} />{nameById.get(s.id)}</span>)}</div>
        {(fromIdx > 0 || toIdx < N - 1) && <button className="trf-reset" onClick={() => onChange(0, N - 1, days)}>Zurücksetzen</button>}
        <button className="rail-toggle" onClick={() => setOpen(false)} title="Einklappen" aria-label="Zeitraum einklappen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
      </div>

      <div className="trf-chart" ref={trackRef}>
        <svg className="trf-svg" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none">
          <line x1={0} y1={PADT + PH} x2={VW} y2={PADT + PH} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {series.map((s) => (
            <polyline key={s.id} fill="none" stroke={s.color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
              points={s.vals.map((v, i) => `${X(i)},${Y(v)}`).join(" ")} />
          ))}
        </svg>
        {/* Overlays */}
        <div className="trf-dim" style={{ left: 0, width: `${pctOf(fromIdx)}%` }} />
        <div className="trf-dim" style={{ right: 0, width: `${100 - pctOf(toIdx)}%` }} />
        <div className="trf-bandsel" style={{ left: `${pctOf(fromIdx)}%`, width: `${pctOf(toIdx) - pctOf(fromIdx)}%` }}
          onPointerDown={(e) => startDrag("band", e)} />
        <div className="trf-h" style={{ left: `${pctOf(fromIdx)}%` }} onPointerDown={(e) => startDrag("from", e)}><span /></div>
        <div className="trf-h" style={{ left: `${pctOf(toIdx)}%` }} onPointerDown={(e) => startDrag("to", e)}><span /></div>
      </div>
      <div className="trf-axis">
        {[0, 15, 30, 45, 59].map((i) => <span key={i} style={{ left: `${pctOf(i)}%`, transform: i === 0 ? "none" : i === 59 ? "translateX(-100%)" : "translateX(-50%)" }}>{fmtDay(days[i])}</span>)}
      </div>
    </div>
  );
}
