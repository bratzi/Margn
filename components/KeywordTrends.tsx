"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";
import { berlinDate } from "@/lib/filterCorpus";
import { TOPICS_SANS_REGIONAL } from "@/lib/topics";
import { PUB_COLORS } from "@/components/TimeRangeFilter";
import { useTweenedSeries } from "@/lib/chartTween";
import FilterPills from "@/components/FilterPills";
import TimeRangeFilter from "@/components/TimeRangeFilter";
import DataTable, { type Col } from "@/components/DataTable";

// ---- Daten der RPC keyword_trends: pro Begriff EINE Zeile mit kompakter Tagesreihe ----
type Raw = { term: string; total: number; series: { d: string; n: number }[] };

// ---- Aus der Tagesreihe abgeleitete Kennzahlen (Brisanz/Bewegung im Zeitfenster) ----
type Metric = {
  term: string;
  total: number;          // Erwähnungen im Fenster
  vals: number[];         // Tageswerte, ausgerichtet an analysisDays (0 = kein Treffer)
  first: number;          // Summe erste Fensterhälfte
  second: number;         // Summe zweite Fensterhälfte
  delta: number;          // second − first  (Kern: Anstieg/Abfall in absoluter Häufigkeit)
  pct: number | null;     // relative Veränderung (null = Vorhälfte 0 → "neu")
  slope: number;          // OLS-Steigung über die Tage (Trendstärke, Treffer/Tag)
  mean: number;
  peakVal: number; peakDay: string;
  spike: number;          // z-Score des Spitzentags ggü. Fenster-Mittel (Burst-Signal)
  activeDays: number;
  share: number;          // Anteil an allen Erwähnungen im Fenster
  // Anteils-Bewegung: Share des Begriffs an ALLEN Erwähnungen je Fensterhälfte. Neutralisiert
  // das wachsende Gesamtvolumen → ein Begriff kann absolut wachsen und trotzdem an Anteil
  // verlieren (echter "Absteiger"). shareDelta in Bruchteilen (×100 = Prozentpunkte).
  shareFirst: number; shareSecond: number; shareDelta: number;
};

const fmtDay = (ds: string) => new Date(ds + "T00:00:00Z").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
const nf = (n: number) => n.toLocaleString("de-DE");

// Kontinuierliche Berlin-Tage zwischen zwei Tages-Strings (inkl.), älteste zuerst.
function daysBetween(fromDay: string, toDay: string): string[] {
  const out: string[] = [];
  let cur = new Date(fromDay + "T12:00:00Z");
  const end = toDay;
  let guard = 0;
  while (berlinDate(cur) <= end && guard++ < 400) { out.push(berlinDate(cur)); cur = new Date(cur.getTime() + 86400000); }
  return out;
}

// Mini-Sparkline (Fläche + Linie) — gemeinsam für Mover-Karten und Tabelle.
function Sparkline({ vals, color, w = 132, h = 30 }: { vals: number[]; color: string; w?: number; h?: number }) {
  if (!vals.length) return null;
  const max = Math.max(1, ...vals);
  const n = vals.length;
  const X = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const Y = (v: number) => h - 2 - (v / max) * (h - 4);
  const line = vals.map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${X(n - 1).toFixed(1)} ${h} L${X(0).toFixed(1)} ${h} Z`;
  const lastIdx = vals.length - 1;
  return (
    <svg className="kt-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={X(lastIdx)} cy={Y(vals[lastIdx])} r={1.8} fill={color} />
    </svg>
  );
}

// Bewegungs-Badge (absolut + relativ) — gleiche Sprache wie der Publizisten-Vergleich.
function Delta({ delta, pct }: { delta: number; pct: number | null }) {
  if (delta === 0) return <span className="pc-delta neutral">±0</span>;
  const up = delta > 0;
  return (
    <span className={`pc-delta ${up ? "up" : "down"}`} title={pct === null ? "Vorhälfte: 0" : `relativ ${pct > 0 ? "+" : ""}${Math.round(pct)} %`}>
      {up ? "+" : ""}{nf(delta)}
      {pct === null ? <span className="pc-delta-pct"> (neu)</span> : <span className="pc-delta-pct"> ({pct > 0 ? "+" : ""}{Math.round(pct)} %)</span>}
    </span>
  );
}

// Bewegungs-Badge je Modus: absolut (+N (+%)) oder Anteils-Verschiebung (+X,XX pp).
function MoveBadge({ m, mode }: { m: Metric; mode: "abs" | "share" }) {
  if (mode === "share") {
    const pp = m.shareDelta * 100;
    if (Math.abs(pp) < 0.005) return <span className="pc-delta neutral">±0 pp</span>;
    const up = pp > 0;
    return (
      <span className={`pc-delta ${up ? "up" : "down"}`} title={`Anteil ${(m.shareFirst * 100).toFixed(2)} % → ${(m.shareSecond * 100).toFixed(2)} %`}>
        {up ? "+" : ""}{pp.toFixed(2)} pp
      </span>
    );
  }
  return <Delta delta={m.delta} pct={m.pct} />;
}

type ChartMode = "movers" | "volume";

export default function KeywordTrends() {
  const f = useFilters();
  const [raw, setRaw] = useState<Raw[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [chartMode, setChartMode] = useState<ChartMode>("movers");
  // Bewegung messen als absolute Häufigkeit ("abs") oder als Anteil am Gesamtvolumen ("share").
  // "share" deckt Absteiger auf, die bei wachsendem Korpus absolut trotzdem zulegen.
  const [moveMode, setMoveMode] = useState<"abs" | "share">("abs");

  // Analyse-Fenster als kontinuierliche Berlin-Tage. Normalfall: gewählter Slider-Bereich;
  // Pinpoint (Chart-Klick): aus dessen Grenzen. So sind alle Begriffs-Reihen gleich getaktet.
  const analysisDays = useMemo(() => {
    if (f.pinpoint) return daysBetween(berlinDate(f.pinpoint.from), berlinDate(f.pinpoint.to));
    const from = Math.min(f.rangeIdx.from, f.days.length - 1);
    const to = Math.min(f.rangeIdx.to, f.days.length - 1);
    return f.days.slice(from, to + 1);
  }, [f.pinpoint, f.days, f.rangeIdx.from, f.rangeIdx.to]);

  // RPC-Aufruf: gleiche Filter wie Übersicht/Edits (Quelle, Thema, Paywall, Autor, Sprache,
  // Zeitachse, Zeitraum). Keyword-Filter selbst greift hier NICHT — diese Seite vergleicht
  // ja alle Schlagwörter. Ein Kalt-Cache-Timeout wird einmal wiederholt.
  const nn = (v: string) => (v === "all" ? null : v);
  const fetchKey = [f.activeArr.join(","), f.rangeFrom, f.rangeTo, f.timeAxis, f.topics.join(","), f.hideRegional, f.paywall, f.author, f.lang, f.status, f.changed, f.depth].join("|");
  useEffect(() => {
    if (!f.activeArr.length) { setRaw([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setErr(false);
    const params = {
      p_sources: f.activeArr, p_from: f.rangeFrom, p_to: f.rangeTo, p_axis: f.timeAxis,
      // Ausgeblendetes Regional: positive Liste „alle außer regional" (die RPC kennt nur p_topics).
      p_topics: f.topics.length ? f.topics : (f.hideRegional ? TOPICS_SANS_REGIONAL : null),
      p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang), p_limit: 300,
      p_status: nn(f.status), p_changed: nn(f.changed), p_depth: nn(f.depth),
    };
    const run = (attempt: number) => {
      supabase.rpc("keyword_trends", params).then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          if (attempt < 1) { setTimeout(() => run(attempt + 1), 500); return; }
          setErr(true); setRaw([]); setLoading(false); return;
        }
        setRaw((data as Raw[]) ?? []); setLoading(false);
      });
    };
    run(0);
    return () => { cancelled = true; };
  }, [fetchKey]);

  // Tagesreihen ausrichten + Kennzahlen berechnen.
  const metrics = useMemo<Metric[]>(() => {
    if (!raw) return [];
    const N = analysisDays.length;
    const idx = new Map(analysisDays.map((d, i) => [d, i]));
    const grand = raw.reduce((s, r) => s + r.total, 0) || 1;
    const half = Math.floor(N / 2);
    const arr = raw.map((r) => {
      const vals = new Array(N).fill(0);
      for (const p of r.series ?? []) { const i = idx.get(p.d); if (i !== undefined) vals[i] = p.n; }
      const total = vals.reduce((a, b) => a + b, 0);
      let first = 0, second = 0;
      for (let i = 0; i < half; i++) first += vals[i];
      for (let i = N - half; i < N; i++) second += vals[i];
      const delta = second - first;
      const pct = first > 0 ? (delta / first) * 100 : null;
      const mean = N ? total / N : 0;
      const xm = (N - 1) / 2;
      let sxy = 0, sxx = 0;
      for (let i = 0; i < N; i++) { sxy += (i - xm) * (vals[i] - mean); sxx += (i - xm) * (i - xm); }
      const slope = sxx > 0 ? sxy / sxx : 0;
      let peakVal = 0, peakIdx = 0;
      for (let i = 0; i < N; i++) if (vals[i] > peakVal) { peakVal = vals[i]; peakIdx = i; }
      const variance = N ? vals.reduce((a, v) => a + (v - mean) * (v - mean), 0) / N : 0;
      const std = Math.sqrt(variance);
      const spike = std > 0 ? (peakVal - mean) / std : 0;
      return {
        term: r.term, total, vals, first, second, delta, pct, slope, mean,
        peakVal, peakDay: analysisDays[peakIdx] ?? "", spike,
        activeDays: vals.filter((v) => v > 0).length, share: total / grand,
        shareFirst: 0, shareSecond: 0, shareDelta: 0,
      };
    }).filter((m) => m.total > 0);
    // Zweiter Durchgang: Anteils-Bewegung relativ zum Gesamtvolumen je Hälfte.
    const gFirst = arr.reduce((s, m) => s + m.first, 0) || 1;
    const gSecond = arr.reduce((s, m) => s + m.second, 0) || 1;
    for (const m of arr) {
      m.shareFirst = m.first / gFirst;
      m.shareSecond = m.second / gSecond;
      m.shareDelta = m.shareSecond - m.shareFirst;
    }
    return arr;
  }, [raw, analysisDays]);

  const grandTotal = useMemo(() => metrics.reduce((s, m) => s + m.total, 0), [metrics]);

  // Bewegungswert je Modus: absolute Häufigkeit oder Anteils-Verschiebung.
  const moveVal = (m: Metric) => (moveMode === "share" ? m.shareDelta : m.delta);
  // Mover-Listen: nach Bewegung sortiert, Rauschen unter total<3 raus.
  const risers = useMemo(() => metrics.filter((m) => moveVal(m) > 0 && m.total >= 3)
    .sort((a, b) => moveVal(b) - moveVal(a)).slice(0, 10), [metrics, moveMode]);
  const fallers = useMemo(() => metrics.filter((m) => moveVal(m) < 0 && m.total >= 3)
    .sort((a, b) => moveVal(a) - moveVal(b)).slice(0, 10), [metrics, moveMode]);

  // Begriffe für den Verlaufs-Chart: größte Bewegung (im aktiven Modus) ODER größtes Volumen.
  const chartTerms = useMemo(() => {
    const base = metrics.filter((m) => m.total >= 3);
    const sel = chartMode === "movers"
      ? [...base].sort((a, b) => Math.abs(moveVal(b)) - Math.abs(moveVal(a)))
      : [...base].sort((a, b) => b.total - a.total);
    return sel.slice(0, 6);
  }, [metrics, chartMode, moveMode]);

  const single = analysisDays.length < 2;

  return (
    <>
      <FilterPills />
      <div className="page wide">
        {/* KPI-Leiste */}
        <div className="kpi-strip">
          <div className="stat-tile">
            <div className="l">Schlagwörter</div>
            <div className="n tnum">{loading ? "…" : nf(metrics.length)}</div>
            <div className="sub">im Zeitraum aktiv</div>
          </div>
          <div className="stat-tile">
            <div className="l">Erwähnungen</div>
            <div className="n tnum">{loading ? "…" : nf(grandTotal)}</div>
            <div className="sub">{analysisDays.length} Tage · {fmtDay(analysisDays[0] ?? "")}–{fmtDay(analysisDays[analysisDays.length - 1] ?? "")}</div>
          </div>
          <div className="stat-tile">
            <div className="l">Stärkster Aufsteiger</div>
            <div className="n" style={{ color: "var(--green)", fontSize: 19 }}>{risers[0] ? `#${risers[0].term}` : "—"}</div>
            <div className="sub">{risers[0] ? <MoveBadge m={risers[0]} mode={moveMode} /> : "keine Bewegung"}</div>
          </div>
          <div className="stat-tile">
            <div className="l">Stärkster Absteiger</div>
            <div className="n" style={{ color: "var(--red)", fontSize: 19 }}>{fallers[0] ? `#${fallers[0].term}` : "—"}</div>
            <div className="sub">{fallers[0] ? <MoveBadge m={fallers[0]} mode={moveMode} /> : "keine Bewegung"}</div>
          </div>
        </div>

        {single && !loading && (
          <div className="kt-hint">Für eine Trend-Analyse einen Zeitraum von mindestens zwei Tagen wählen — aktuell ist nur ein einzelner Tag aktiv.</div>
        )}
        {err && <div className="kt-hint kt-err">Konnte die Keyword-Trends nicht laden. Bitte den Zeitraum verkleinern oder neu laden.</div>}

        {/* Verlaufs-Chart */}
        <h2 className="section-h">
          Brisanz im Zeitverlauf
          <span className="count">Top {chartTerms.length} {chartMode === "movers" ? "Bewegungen" : "nach Volumen"}</span>
          <div className="seg seg-xs" style={{ marginLeft: "auto" }}>
            <button className={chartMode === "movers" ? "on" : ""} onClick={() => setChartMode("movers")} title="Begriffe mit der größten Veränderung">Größte Bewegung</button>
            <button className={chartMode === "volume" ? "on" : ""} onClick={() => setChartMode("volume")} title="Häufigste Begriffe">Volumen</button>
          </div>
        </h2>
        <TrendChart terms={chartTerms} days={analysisDays} />

        {/* Mover-Boards */}
        <h2 className="section-h" style={{ marginTop: 24 }}>
          Auf- und Absteiger
          <span className="count">2. vs. 1. Fensterhälfte</span>
          <div className="seg seg-xs" style={{ marginLeft: "auto" }}>
            <button className={moveMode === "abs" ? "on" : ""} onClick={() => setMoveMode("abs")} title="Absolute Häufigkeitsänderung">Absolut</button>
            <button className={moveMode === "share" ? "on" : ""} onClick={() => setMoveMode("share")} title="Veränderung des Anteils an allen Erwähnungen — neutralisiert das wachsende Gesamtvolumen und deckt Absteiger auf">Anteil</button>
          </div>
        </h2>
        <div className="kt-movers">
          <MoverBoard title="Aufsteiger" subtitle={moveMode === "share" ? "wachsender Anteil am Gesamtvolumen" : "steigende Häufigkeit"} items={risers} kind="up" mode={moveMode} />
          <MoverBoard title="Absteiger" subtitle={moveMode === "share" ? "schrumpfender Anteil am Gesamtvolumen" : "fallende Häufigkeit"} items={fallers} kind="down" mode={moveMode} />
        </div>

        {/* Vollständige Tabelle */}
        <h2 className="section-h" style={{ marginTop: 28 }}>
          Alle Schlagwörter <span className="count">{metrics.length} Begriffe · sortier- und filterbar</span>
        </h2>
        <KeywordTable metrics={metrics} />
      </div>
      <TimeRangeFilter />
    </>
  );
}

// ---------------- Mover-Board (Aufsteiger / Absteiger) ----------------
function MoverBoard({ title, subtitle, items, kind, mode }: { title: string; subtitle: string; items: Metric[]; kind: "up" | "down"; mode: "abs" | "share" }) {
  const color = kind === "up" ? "var(--green)" : "var(--red)";
  return (
    <div className="kt-board panel">
      <div className="kt-board-head">
        <span className="kt-board-title" style={{ color }}>{kind === "up" ? "▲" : "▼"} {title}</span>
        <span className="kt-board-sub">{subtitle}</span>
      </div>
      {items.length === 0 ? <div className="kt-board-empty">keine ausreichende Bewegung im Zeitraum</div> : (
        <ol className="kt-board-list">
          {items.map((m, i) => (
            <li key={m.term} className="kt-mover">
              <span className="kt-mover-rank">{i + 1}</span>
              <Link href={`/articles?keyword=${encodeURIComponent(m.term)}`} className="kt-mover-term" title={`Artikel zu „${m.term}" anzeigen`}>{m.term}</Link>
              <span className="kt-mover-spark"><Sparkline vals={m.vals} color={color} w={110} h={26} /></span>
              <span className="kt-mover-now tnum" title="Erwähnungen im Zeitraum">{nf(m.total)}</span>
              <span className="kt-mover-delta"><MoveBadge m={m} mode={mode} /></span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ---------------- Verlaufs-Chart (Multi-Linie, Hover-Tooltip) ----------------
function TrendChart({ terms, days }: { terms: Metric[]; days: string[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const VW = 1000, VH = 240, PAD_L = 0, PAD_B = 0;
  const N = days.length;
  // Linien-Geometrie weich morphen (Tooltip/Legende lesen weiter die Roh-Werte).
  const animTerms = useTweenedSeries(useMemo(() => terms.map((t) => ({ ...t, key: t.term })), [terms]));
  const max = useMemo(() => Math.max(1, ...animTerms.flatMap((t) => t.vals)), [animTerms]);
  const X = (i: number) => (N <= 1 ? VW / 2 : (i / (N - 1)) * VW);
  const Y = (v: number) => VH - (v / max) * (VH - 8) - 4;
  const colorOf = (i: number) => PUB_COLORS[i % PUB_COLORS.length];

  if (!terms.length) return <div className="kt-chart-empty panel">Noch keine Daten für diesen Zeitraum.</div>;

  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect(); if (!rect) return;
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(N - 1, Math.round(rel * (N - 1)))));
  };

  return (
    <div className="kt-chart panel">
      <div className="kt-chart-legend">
        {terms.map((t, i) => (
          <Link key={t.term} href={`/articles?keyword=${encodeURIComponent(t.term)}`} className="kt-leg" title={`Artikel zu „${t.term}"`}>
            <i style={{ background: colorOf(i) }} />{t.term}
          </Link>
        ))}
      </div>
      <div className="kt-chart-plot" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <svg key={terms.map((t) => t.term).join(",")} viewBox={`0 0 ${VW} ${VH}`} preserveAspectRatio="none" className="kt-chart-svg chart-swap">
          {/* Horizontale Hilfslinien */}
          {[0.25, 0.5, 0.75].map((p) => <line key={p} x1={0} x2={VW} y1={VH - p * (VH - 8) - 4} y2={VH - p * (VH - 8) - 4} className="kt-grid" />)}
          {animTerms.map((t, i) => {
            const d = t.vals.map((v, j) => `${j === 0 ? "M" : "L"}${X(j).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
            return <path key={t.term} d={d} fill="none" stroke={colorOf(i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity={0.92} />;
          })}
          {hover !== null && <line x1={X(hover)} x2={X(hover)} y1={0} y2={VH} className="kt-cursor" />}
          {hover !== null && animTerms.map((t, i) => <circle key={t.term} cx={X(hover)} cy={Y(t.vals[hover])} r={2.6} fill={colorOf(i)} />)}
        </svg>
        {hover !== null && (() => {
          const rows = terms.map((t, i) => ({ term: t.term, v: t.vals[hover], c: colorOf(i) })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
          const leftPct = (X(hover) / VW) * 100;
          const fromRight = leftPct > 62;
          return (
            <div className="kt-tt" style={fromRight ? { right: `${100 - leftPct}%` } : { left: `${leftPct}%` }}>
              <div className="kt-tt-day">{fmtDay(days[hover])}</div>
              {rows.length ? rows.map((r) => (
                <div key={r.term} className="kt-tt-row"><i style={{ background: r.c }} /><span>{r.term}</span><b>{r.v}</b></div>
              )) : <div className="kt-tt-row kt-tt-empty">keine Treffer</div>}
            </div>
          );
        })()}
      </div>
      <div className="kt-chart-axis">
        {[0, Math.round((N - 1) / 4), Math.round((N - 1) / 2), Math.round(3 * (N - 1) / 4), N - 1]
          .filter((v, idx, a) => a.indexOf(v) === idx)
          .map((i, pos, arr) => <span key={i} style={{ left: `${(i / Math.max(1, N - 1)) * 100}%`, transform: pos === 0 ? "none" : pos === arr.length - 1 ? "translateX(-100%)" : "translateX(-50%)" }}>{fmtDay(days[i])}</span>)}
      </div>
    </div>
  );
}

// ---------------- Vollständige Tabelle ----------------
function KeywordTable({ metrics }: { metrics: Metric[] }) {
  const cols: Col<Metric>[] = useMemo(() => [
    { key: "term", label: "Schlagwort", width: 200, value: (m) => m.term,
      render: (m) => <Link href={`/articles?keyword=${encodeURIComponent(m.term)}`} className="kt-term-link" title={`Artikel zu „${m.term}" anzeigen`}>{m.term}</Link> },
    { key: "total", label: "Erwähnungen", width: 120, align: "right", agg: "sum", value: (m) => m.total, render: (m) => <strong>{nf(m.total)}</strong> },
    { key: "spark", label: "Verlauf", width: 150, sortable: false, groupable: false, filterable: false, value: () => "",
      render: (m) => <Sparkline vals={m.vals} color={m.delta >= 0 ? "var(--green)" : "var(--red)"} w={132} h={26} /> },
    { key: "delta", label: "Bewegung", width: 130, align: "right", agg: "sum", value: (m) => m.delta,
      render: (m) => <Delta delta={m.delta} pct={m.pct} /> },
    { key: "sharedelta", label: "Δ Anteil", width: 100, align: "right", value: (m) => Math.round(m.shareDelta * 10000) / 100,
      render: (m) => { const pp = m.shareDelta * 100; return <span style={{ color: pp > 0.005 ? "var(--green)" : pp < -0.005 ? "var(--red)" : "var(--faint)" }} title={`${(m.shareFirst * 100).toFixed(2)} % → ${(m.shareSecond * 100).toFixed(2)} %`}>{pp > 0 ? "+" : ""}{pp.toFixed(2)} pp</span>; } },
    { key: "slope", label: "Trend/Tag", width: 110, align: "right", value: (m) => Math.round(m.slope * 100) / 100,
      render: (m) => <span style={{ color: m.slope > 0.02 ? "var(--green)" : m.slope < -0.02 ? "var(--red)" : "var(--faint)" }}>{m.slope > 0 ? "↗" : m.slope < 0 ? "↘" : "→"} {m.slope.toFixed(2)}</span> },
    { key: "spike", label: "Spitze (z)", width: 110, align: "right", value: (m) => Math.round(m.spike * 100) / 100,
      render: (m) => <span title={`Spitzentag: ${fmtDay(m.peakDay)} (${m.peakVal})`} style={{ fontWeight: m.spike >= 2 ? 700 : 400, color: m.spike >= 2 ? "var(--accent)" : "inherit" }}>{m.spike.toFixed(1)}σ</span> },
    { key: "activeDays", label: "Aktive Tage", width: 110, align: "right", value: (m) => m.activeDays, render: (m) => <span className="faint">{m.activeDays}</span> },
    { key: "share", label: "Anteil", width: 90, align: "right", value: (m) => Math.round(m.share * 1000) / 10,
      render: (m) => <span className="faint">{(m.share * 100).toFixed(1)} %</span> },
    { key: "peak", label: "Spitzentag", width: 120, value: (m) => m.peakDay, render: (m) => <span className="mono faint">{fmtDay(m.peakDay)} · {m.peakVal}</span> },
  ], []);
  return <DataTable columns={cols} rows={metrics} rowKey={(m) => m.term} tableId="keyword-trends" minWidth={1120} />;
}
