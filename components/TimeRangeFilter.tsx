"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFilters, WINDOW_OPTS } from "@/components/FilterProvider";
import { axisTime, berlinDate, berlinDayBoundsUTC, makeMatcher, snapshotOf, TIME_AXIS_LABEL } from "@/lib/filterCorpus";
import { topicLabel } from "@/lib/topics";
import { useTweenedNumber, useTweenedSeries } from "@/lib/chartTween";
import ChartStyleToggle, { type ChartStyle } from "@/components/ChartStyleToggle";

// Serien-Slots aus globals.css (--c1..--c8): je Theme eigene, validierte Stufen.
// Feste Slot-Reihenfolge = CVD-Sicherheit — nicht umsortieren, nur dort ändern.
export const PUB_COLORS = ["var(--c1)", "var(--c2)", "var(--c3)", "var(--c4)", "var(--c5)", "var(--c6)", "var(--c7)", "var(--c8)"];
export const TOPIC_COLORS: Record<string, string> = {
  politik: "var(--c4)", wirtschaft: "var(--c7)", sport: "var(--c1)",
  kultur: "var(--c6)", wissen: "var(--c3)", digital: "var(--petrol)",
  panorama: "var(--c5)", regional: "var(--olive)", gesundheit: "var(--c8)", reise: "var(--c2)",
  auto: "var(--muted)", meinung: "var(--faint)", sonstiges: "var(--line-2)",
};
type ChartMode = "publishers" | "topics";
const short = (n: string) => n.replace(" Online", "");
const VW = 1000, VH = 100;

type HoverDay = { idx: number; clientX: number; clientY: number };

export default function TimeRangeFilter() {
  const f = useFilters();
  const { sources, activeArr, days, rangeIdx, setRangeIdx, trfOpen, setTrfOpen, windowDays, setWindowDays } = f;
  const N = days.length;
  const [h, setH] = useState(168);
  const [chartMode, setChartMode] = useState<ChartMode>("publishers");
  // Darstellung Säulen ↔ Kurve — frei wählbar über das Badge im Chart (wie RateStats).
  const [chartStyle, setChartStyle] = useState<ChartStyle>("bars");
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
  const act = useMemo(() => new Set(activeArr), [activeArr]);

  // „Zuletzt gesehen"-Achse: Balken = echte Crawl-Sichtungen je Berlin-Tag (RPC-Tages-
  // Körnung, ~300 Zeilen je 30 T). Die frühere last_seen-Verteilung zeigte vor heute nur
  // die ABGÄNGE (noch Verlinktes wird bei jedem Lauf auf „heute" gebumpt) — dieser Blick
  // ist jetzt bewusst der Bestand-Filter „Rausgeflogen": dann sind die last_seen-Balken
  // genau richtig (wann flog was raus?) und Sichtungen bleiben aus. Fallback auf die
  // Verteilung auch, solange noch keine Events im Fenster liegen (Tabelle neu, wie RateStats).
  const wantSight = f.timeAxis === "seen" && f.linkState !== "gone";
  const [sightRows, setSightRows] = useState<{ source_id: number; bucket: string; n: number }[] | null>(null);
  useEffect(() => {
    if (!wantSight) { setSightRows(null); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("sighting_buckets", {
        p_from: berlinDayBoundsUTC(days[0]).from,
        p_to: berlinDayBoundsUTC(days[days.length - 1]).to,
        p_gran: "day",
      });
      if (!cancelled) setSightRows(error ? [] : ((data ?? []) as { source_id: number; bucket: string; n: number }[]));
    })();
    return () => { cancelled = true; };
  }, [wantSight, days, f.corpusLoadedAt]);

  const sightSeries = useMemo(() => {
    if (!wantSight || !sightRows?.length) return null;
    const dayIdx = new Map(days.map((d, i) => [d, i]));
    const map = new Map<number, number[]>();
    for (const r of sightRows) {
      if (!act.has(r.source_id)) continue;
      const i = dayIdx.get(berlinDate(r.bucket));
      if (i === undefined) continue;
      let vals = map.get(r.source_id);
      if (!vals) { vals = new Array(days.length).fill(0); map.set(r.source_id, vals); }
      vals[i] += r.n;
    }
    return sources.filter((s) => act.has(s.id)).map((s) => ({
      id: String(s.id), color: colorById.get(s.id)!, label: short(s.name),
      vals: map.get(s.id) ?? new Array(days.length).fill(0),
    }));
  }, [wantSight, sightRows, act, sources, colorById, days]);

  // Säulen direkt aus dem gemeinsamen Corpus — GLEICHES Prädikat wie die Tabelle,
  // nur ohne Zeitfilter (die Zeitachse ist ja der Chart selbst). Damit stimmen die
  // Balken exakt mit den Tabellen-Treffern des jeweiligen Tages überein.
  const corpusDeps = [f.corpus, f.corpusReady, days, f.timeAxis,
    f.status, f.paywall, f.atype, f.author, f.topics.join(","), f.lang, f.changed, f.depth,
    f.hideRegional, f.linkState, f.onlineCut, f.subPats.join("|"), f.kwIdSet] as const;

  const series = useMemo(() => {
    const snap = snapshotOf(f as any);
    const match = makeMatcher(snap, f.subPats, f.kwIdSet, { time: true });
    const dayIdx = new Map(days.map((d, i) => [d, i]));
    const map = new Map<number, number[]>();
    for (const r of f.corpus) {
      if (!act.has(r.source_id)) continue;
      if (!match(r)) continue;
      const t = axisTime(r, f.timeAxis);
      if (!t) continue;
      const i = dayIdx.get(berlinDate(t));
      if (i === undefined) continue;
      let vals = map.get(r.source_id);
      if (!vals) { vals = new Array(days.length).fill(0); map.set(r.source_id, vals); }
      vals[i]++;
    }
    return sources.filter((s) => act.has(s.id)).map((s) => ({
      id: String(s.id), color: colorById.get(s.id)!, label: short(s.name),
      vals: map.get(s.id) ?? new Array(days.length).fill(0),
    }));
  }, [sources, act, colorById, ...corpusDeps]);

  const topicSeries = useMemo(() => {
    const snap = snapshotOf(f as any);
    const match = makeMatcher(snap, f.subPats, f.kwIdSet, { time: true });
    const dayIdx = new Map(days.map((d, i) => [d, i]));
    const map = new Map<string, number[]>();
    for (const r of f.corpus) {
      if (!act.has(r.source_id)) continue;
      if (!match(r)) continue;
      const t = axisTime(r, f.timeAxis);
      if (!t) continue;
      const i = dayIdx.get(berlinDate(t));
      if (i === undefined) continue;
      const topic = r.topic ?? "sonstiges";
      let vals = map.get(topic);
      if (!vals) { vals = new Array(days.length).fill(0); map.set(topic, vals); }
      vals[i]++;
    }
    return [...map.entries()]
      .sort((a, b) => b[1].reduce((s, v) => s + v, 0) - a[1].reduce((s, v) => s + v, 0))
      .slice(0, 10)
      .map(([topic, vals]) => ({
        id: topic, color: TOPIC_COLORS[topic] ?? "var(--faint)", label: topicLabel(topic), vals,
      }));
  }, [act, ...corpusDeps]);

  // Verleger-Modus zeigt Sichtungen, sobald Events da sind; Themen-Modus bleibt beim
  // Corpus (Sichtungen sind nur je Quelle erfasst, nicht je Thema).
  const isSightings = chartMode === "publishers" && sightSeries != null;
  const activeSeries = chartMode === "topics" ? topicSeries : (sightSeries ?? series);
  // Getweente Kopie NUR für die Balken-Geometrie (weiches Morphen bei Filter-/Achsen-
  // Wechseln); Tooltip + Legende lesen weiter die ganzzahligen Ziel-Werte.
  const animSeries = useTweenedSeries(activeSeries);

  const maxTotal = useMemo(() => {
    const base = isSightings ? sightSeries! : series;
    const tot = days.map((_, i) => base.reduce((sum, s) => sum + s.vals[i], 0));
    return Math.max(1, ...tot);
  }, [isSightings, sightSeries, series, days]);
  const animMaxTotal = Math.max(1, useTweenedNumber(maxTotal));

  const X = (i: number) => (i / (N - 1)) * VW;
  const colW = (VW / N) * 0.72;

  // Kurven-Modus: dieselben gestapelten Tageswerte als geglättete Flächenbänder.
  // Band s reicht von der Stapel-Oberkante der Serien darunter bis zur eigenen —
  // Lesart und Skala (animMaxTotal) sind mit den gestapelten Säulen identisch.
  const Yv = (v: number) => VH - (v / animMaxTotal) * VH;
  const curveThrough = (pts: [number, number][]) => {
    if (pts.length < 2) return "";
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const cp = (x1 - x0) * 0.45;
      d += ` C${(x0 + cp).toFixed(1)},${y0.toFixed(1)} ${(x1 - cp).toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return d;
  };
  const stackBands = useMemo(() => {
    if (chartStyle !== "curve") return null;
    const base: number[] = new Array(N).fill(0);
    return animSeries.map((s) => {
      const lower = base.slice();
      for (let i = 0; i < N; i++) base[i] += s.vals[i] ?? 0;
      const upper = base.slice();
      if (!upper.some((v, i) => v - lower[i] > 0)) return null;
      const top = upper.map((v, i): [number, number] => [X(i), Yv(v)]);
      const bot = lower.map((v, i): [number, number] => [X(i), Yv(v)]).reverse();
      // Oberkante hin, Unterkante (rückwärts) zurück — geschlossenes Band.
      const back = curveThrough(bot).replace(/^M[^C]+/, "");
      return { id: s.id, color: s.color, d: `${curveThrough(top)} L${bot[0][0].toFixed(1)},${bot[0][1].toFixed(1)} ${back} Z` };
    }).filter(Boolean) as { id: string; color: string; d: string }[];
  }, [chartStyle, animSeries, N, animMaxTotal]);
  const pctOf = (i: number) => (i / (N - 1)) * 100;
  const halfColPct = (colW / 2 / VW) * 100;
  const edgeLeft = (i: number) => Math.max(0, pctOf(i) - halfColPct);
  const edgeRight = (i: number) => Math.min(100, pctOf(i) + halfColPct);
  const chartH = Math.max(60, h - 60);

  const idxFromClient = useCallback((clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(N - 1, Math.round(((clientX - rect.left) / rect.width) * (N - 1))));
  }, [N]);

  // Echte Bewegung seit Pointer-Down? Unterscheidet Drag von Klick — ein Tages-Klick
  // (Pinpoint) darf nach einem Griff-/Band-Drag nicht zusätzlich feuern.
  const movedRef = useRef(false);
  const downXRef = useRef(0);

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      if (Math.abs(e.clientX - downXRef.current) > 4) movedRef.current = true;
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
    window.addEventListener("pointercancel", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); };
  }, [drag, idxFromClient, setRangeIdx, N]);

  const start = (k: typeof drag, e: React.PointerEvent) => {
    document.body.style.userSelect = "none";
    movedRef.current = false;
    downXRef.current = e.clientX;
    if (k === "band") dragRef.current = { start: idxFromClient(e.clientX), f: liveRef.current.from, t: liveRef.current.to };
    setDrag(k);
  };

  // Pointer-DELEGATION für Griffe + Band: Die Tages-Hover-Flächen (.trf-col-hit, z4) liegen
  // ÜBER Griffen (z3) und Band — deren eigene onPointerDown feuern also fast nie
  // (elementFromPoint am Knauf trifft trf-col-hit; auf Touch war der Range so gar nicht
  // verstellbar). z-Anheben wäre die falsche Kur: bei Voll-Auswahl (Default) deckte das Band
  // dann ALLE Tage ab → keine Tooltips/Tages-Klicks mehr. Stattdessen entscheidet der
  // Chart-Container per Nähe-Test, ob ein Pointer-Down einen Griff (Toleranz fein 12 px,
  // Touch 26 px) oder das Band (nur bei echter Teil-Auswahl) meint.
  const chartPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if ((e.target as HTMLElement).closest(".trf-h, .trf-bandsel, .trf-resize")) return; // Direkt-Treffer laufen wie gehabt
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const xFrom = (edgeLeft(liveRef.current.from) / 100) * rect.width;
    const xTo = (edgeRight(liveRef.current.to) / 100) * rect.width;
    const NEAR = e.pointerType === "touch" ? 26 : 12;
    // Näherer Griff gewinnt (bei Einzeltag liegen beide fast aufeinander).
    const dFrom = Math.abs(x - xFrom), dTo = Math.abs(x - xTo);
    if (dFrom <= NEAR || dTo <= NEAR) { start(dFrom <= dTo ? "from" : "to", e); return; }
    if (x > xFrom && x < xTo && (liveRef.current.from > 0 || liveRef.current.to < N - 1)) start("band", e);
  };
  const fmtDay = (ds: string) => new Date(ds + "T00:00:00Z").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });

  // Klick auf einen Tag: Pinpoint OHNE sourceId → alle Publizisten dieses Tages sichtbar
  const handleDayClick = (dayIdx: number) => {
    const total = series.reduce((sum, s) => sum + s.vals[dayIdx], 0);
    if (total === 0) return;
    const day = days[dayIdx];
    const b = berlinDayBoundsUTC(day);
    f.setPinpoint({ from: b.from, to: b.to, label: fmtDay(day) });
  };

  if (!trfOpen) {
    return (
      <div className="trf trf-mini">
        <button className="rail-toggle" onClick={() => setTrfOpen(true)} title="Zeitstrahl aufklappen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 18V9M9 18V5M14 18v-7M19 18v-4" /></svg></button>
        <span className="filter-tag">Filter</span>
        <span className="trf-mini-label">{TIME_AXIS_LABEL[f.timeAxis]}: <b>{rangeIdx.from === rangeIdx.to ? fmtDay(days[rangeIdx.from]) : `${fmtDay(days[rangeIdx.from])} – ${fmtDay(days[rangeIdx.to])}`}</b></span>
      </div>
    );
  }

  return (
    <div className="trf trf-open" style={{ height: h }}>
      <div className="trf-resize" onPointerDown={(e) => start("resize", e)} title="Höhe ziehen"><span /></div>
      <div className="trf-head">
        <span className="filter-tag">Filter</span>
        <div className="trf-title">{f.timeAxis === "seen" ? "Zeitraum · Zuletzt gesehen" : "Veröffentlichungs-Zeitraum"} <span className="trf-range">{live.from === live.to ? fmtDay(days[live.from]) : `${fmtDay(days[live.from])} – ${fmtDay(days[live.to])}`}</span></div>
        <div className="seg seg-xs trf-axissel">
          <button className={f.timeAxis === "published" ? "on" : ""} onClick={() => f.setTimeAxis("published")} title="Nach Veröffentlichungsdatum des Verlags">Veröffentlicht</button>
          <button className={f.timeAxis === "seen" ? "on" : ""} onClick={() => f.setTimeAxis("seen")} title="Nach letztem Scan — zeigt alles, was im Zeitraum online/gescannt war (auch früher veröffentlicht)">Zuletzt gesehen</button>
        </div>
        <div className="seg seg-xs trf-presets">
          {WINDOW_OPTS.map((n) => (
            <button key={n} className={windowDays === n ? "on" : ""} onClick={() => setWindowDays(n)} title={`Letzte ${n} Tage`}>{n}T</button>
          ))}
        </div>
        <div className="seg seg-xs trf-mode">
          <button className={chartMode === "publishers" ? "on" : ""} onClick={() => setChartMode("publishers")}>Verleger</button>
          <button className={chartMode === "topics" ? "on" : ""} onClick={() => setChartMode("topics")}>Themen</button>
        </div>
        <div className="trf-legend">{activeSeries.map((s) => <span key={s.id}><i style={{ background: s.color }} />{s.label}</span>)}</div>
        {(live.from > 0 || live.to < N - 1) && <button className="trf-reset" onClick={() => { setLive({ from: 0, to: N - 1 }); setRangeIdx({ from: 0, to: N - 1 }); }}>Zurücksetzen</button>}
        <button className="rail-toggle" onClick={() => setTrfOpen(false)} title="Einklappen"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg></button>
      </div>

      <div
        className="trf-chart" ref={trackRef} style={{ height: chartH }}
        onPointerDown={chartPointerDown}
        onDoubleClick={(e) => { const i = idxFromClient(e.clientX); setLive({ from: i, to: i }); setRangeIdx({ from: i, to: i }); }}
        onMouseLeave={() => setHoverDay(null)}
        title="Doppelklick: nur diesen Tag · Klick: alle Artikel dieses Tages"
      >
        <svg key={`${chartMode}-${N}-${chartStyle}`} className="trf-svg chart-swap" viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none">
          {stackBands ? (
            stackBands.map((b) => <path key={b.id} d={b.d} fill={b.color} opacity={0.92} />)
          ) : (
            days.map((_, i) => {
              let yb = VH;
              return <g key={i}>{animSeries.map((s) => { const ht = (s.vals[i] / animMaxTotal) * VH; if (ht <= 0) return null; const y = yb - ht; yb = y; return <rect key={s.id} x={X(i) - colW / 2} y={y} width={colW} height={ht} fill={s.color} opacity={0.92} />; })}</g>;
            })
          )}
        </svg>

        {/* Darstellung Säulen ↔ Kurve — dezentes Badge, oben rechts im Chart */}
        <ChartStyleToggle className="cst-abs" value={chartStyle} onChange={setChartStyle} />

        {/* Transparente Hover-Overlays je Tag – fangen Hover + Klick ab */}
        {days.map((_, i) => (
          <div
            key={i}
            className="trf-col-hit"
            style={{ left: `${edgeLeft(i)}%`, width: `${Math.max(edgeRight(i) - edgeLeft(i), 1)}%` }}
            onMouseEnter={(e) => setHoverDay({ idx: i, clientX: e.clientX, clientY: e.clientY })}
            onMouseMove={(e) => setHoverDay((h) => h ? { ...h, clientX: e.clientX, clientY: e.clientY } : h)}
            onClick={() => { if (!movedRef.current) handleDayClick(i); }}
          />
        ))}

        {/* Tooltip */}
        {hoverDay && (() => {
          const dayData = activeSeries.filter((s) => s.vals[hoverDay.idx] > 0);
          if (!dayData.length) return null;
          const total = dayData.reduce((sum, s) => sum + s.vals[hoverDay.idx], 0);
          const rect = trackRef.current?.getBoundingClientRect();
          const relX = rect ? hoverDay.clientX - rect.left : 0;
          const fromRight = rect ? rect.width - relX < 160 : false;
          return (
            <div className="trf-tt" style={{ left: fromRight ? undefined : `${(relX / (rect?.width ?? 1)) * 100}%`, right: fromRight ? `${100 - (relX / (rect?.width ?? 1)) * 100}%` : undefined }}>
              <div className="trf-tt-day">{fmtDay(days[hoverDay.idx])}{isSightings ? " · Sichtungen" : f.timeAxis === "seen" && f.linkState === "gone" ? " · rausgeflogen" : ""}</div>
              {dayData.map((s) => (
                <div key={s.id} className="trf-tt-row">
                  <i style={{ background: s.color }} />
                  <span>{s.label}</span>
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
