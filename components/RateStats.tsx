"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";
import { PUB_COLORS, TOPIC_COLORS } from "@/components/TimeRangeFilter";
import { axisTime, berlinDayBoundsUTC, makeMatcher, snapshotOf } from "@/lib/filterCorpus";
import { topicLabel } from "@/lib/topics";
import { useTweenedSeries } from "@/lib/chartTween";
import ChartStyleToggle, { type ChartStyle } from "@/components/ChartStyleToggle";

type Unit = "minute" | "hour" | "day" | "week";
type ChartMode = "publishers" | "topics";
// Eine Reihe = ein Verleger ODER ein Thema. sid/topic sagt, worauf ein Dot-Klick pinnt.
type Series = { key: string; color: string; label: string; vals: number[]; sid?: number; topic?: string };
const short = (n: string) => n.replace(" Online", "");
const VW = 1000;
const PAD_L = 44, PAD_B = 24, PAD_T = 18, PAD_R = 12;

// ISO-Kalenderwoche aus LOKALEN Datumskomponenten (konsistent mit der lokalen Bucketing-Zeit).
function isoWeek(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; t.setDate(t.getDate() - day + 3);
  const first = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t.getTime() - first.getTime()) / 86400000 - 3 + ((first.getDay() + 6) % 7)) / 7);
}

export default function RateStats() {
  const f = useFilters();
  const { sources, activeArr } = f;
  const [manual, setManual] = useState<"auto" | Unit>("auto");
  const [chartMode, setChartMode] = useState<ChartMode>("publishers");
  const [timeFormat, setTimeFormat] = useState<"abs" | "rel">("rel");
  const [chartH, setChartH] = useState(220);
  const [resizing, setResizing] = useState(false);
  const VH = chartH;
  const CH = VH - PAD_T - PAD_B;
  // Hover auf einen EINZELNEN Datenpunkt (nicht den ganzen Bucket)
  const [hoverDot, setHoverDot] = useState<{ key: string; idx: number; x: number; y: number } | null>(null);
  // Fadenkreuz-Cursor (vertikale + horizontale Linie + x/y-Wert), SVG-Koordinaten. rAF-gedrosselt.
  const [cross, setCross] = useState<{ x: number; y: number } | null>(null);
  const crossRaf = useRef<number | null>(null);
  // „Jetzt"-Marker: aktuelle Uhrzeit, aktualisiert sich ~alle 30 s → die Linie läuft mit.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    const id = setInterval(tick, 30000);
    const onVis = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, []);
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
  const didPanRef = useRef(false); // unterscheidet echten Klick von Pan-Geste
  const [panning, setPanning] = useState(false);
  // Aktuelle Wheel-Logik (wird jeden Render aktualisiert); der NATIVE Listener ruft sie auf.
  const wheelFnRef = useRef<(e: WheelEvent) => void>(() => {});

  // Stabiler nativer wheel-Handler (delegiert an die aktuelle Logik im Ref).
  const nativeWheelRef = useRef((e: WheelEvent) => wheelFnRef.current(e));
  // Container-Breite via Callback-Ref messen (Container existiert erst nach Daten-Load).
  // Zusätzlich: NATIVER wheel-Listener mit { passive: false }, damit preventDefault greift und
  // das Mausrad-Zoom NICHT die Seite mitscrollt (React onWheel ist passiv → preventDefault wirkungslos).
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (scrollRef.current) scrollRef.current.removeEventListener("wheel", nativeWheelRef.current);
    scrollRef.current = el;
    roRef.current?.disconnect();
    if (!el) return;
    el.addEventListener("wheel", nativeWheelRef.current, { passive: false });
    const ro = new ResizeObserver(() => { const w = el.clientWidth; if (w > 0) setContainerW(w); });
    ro.observe(el);
    roRef.current = ro;
    setContainerW(el.clientWidth);
  }, []);
  useEffect(() => () => {
    roRef.current?.disconnect();
    scrollRef.current?.removeEventListener("wheel", nativeWheelRef.current);
  }, []);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = chartH;
    setResizing(true);
    const onMove = (ev: PointerEvent) => setChartH(Math.max(100, Math.min(600, startH + ev.clientY - startY)));
    const onUp = () => { setResizing(false); window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const fromIso = berlinDayBoundsUTC(f.days[f.rangeIdx.from]).from;
  const toIso = berlinDayBoundsUTC(f.days[f.rangeIdx.to]).to;
  const spanDays = f.rangeIdx.to - f.rangeIdx.from + 1;
  const baseAutoUnit: Unit = spanDays <= 3 ? "hour" : spanDays <= 45 ? "day" : "week";
  // Im Dynamisch-Modus darf das Mausrad die Einheit verschieben (override), sonst zählt manual.
  const unit: Unit = manual === "auto" ? (autoUnitOverride ?? baseAutoUnit) : manual;
  const UNIT_ORDER: Unit[] = ["week", "day", "hour", "minute"]; // grob → fein

  // Dichte/Override zurücksetzen, wenn Modus oder Zeitraum wechselt
  useEffect(() => { setDens(null); setAutoUnitOverride(null); setHoverDot(null); }, [manual, fromIso, toIso]);

  const colorById = useMemo(() => new Map(sources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])), [sources]);
  const act = useMemo(() => new Set(activeArr), [activeArr]);

  // Bucketing in LOKALER Zeit des Endnutzers (nicht UTC) — sonst erscheint ein um 06:00
  // (Berlin) publizierter Artikel fälschlich im 04:00-Bucket (UTC-Versatz).
  const truncTo = (iso: string, u: Unit) => {
    const d = new Date(iso);
    if (u === "minute") d.setSeconds(0, 0);
    else if (u === "hour") d.setMinutes(0, 0, 0);
    else if (u === "day") d.setHours(0, 0, 0, 0);
    else { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); }
    return d;
  };

  const buckets = useMemo(() => {
    const out: string[] = [];
    const cur = truncTo(fromIso, unit);
    const end = new Date(toIso);
    // Minuten erzeugen extrem viele Buckets → hartes Limit, sonst hängt das Rendering.
    const cap = unit === "minute" ? 4000 : 3000;
    let g = 0;
    while (cur <= end && g++ < cap) {
      out.push(cur.toISOString());
      // Schrittweite in lokaler Zeit (DST-sicher: ein „Tag" kann 23/25 h haben)
      if (unit === "minute") cur.setMinutes(cur.getMinutes() + 1);
      else if (unit === "hour") cur.setHours(cur.getHours() + 1);
      else if (unit === "day") cur.setDate(cur.getDate() + 1);
      else cur.setDate(cur.getDate() + 7);
    }
    return out;
  }, [fromIso, toIso, unit]);

  // Zählung direkt aus dem gemeinsamen Corpus — gleiches Prädikat wie die Tabelle,
  // Zeitfenster ist der gewählte Zeitstrahl-Bereich, Bucketing über die EFFEKTIVE Zeit
  // (published_at, sonst discovered_at — vorher fielen undatierte Artikel ganz raus).
  // „Zuletzt gesehen"-Achse = SICHTUNGEN: der Scraper protokolliert minutengenau, wie
  // viele Artikel-Links jeder Lauf sieht (Rel. = pro Zeiteinheit; Abs. = Tageszähler,
  // Reset um 00:00). Die „Veröffentlicht"-Achse bleibt unverändert (1 Artikel = 1 Bucket).
  const presence = f.timeAxis === "seen";
  // Bestand „Rausgeflogen": Sichtungen wären hier irreführend (sie zählen ALLE Link-
  // Sichtungen) — die last_seen-Verteilung der gefilterten Abgänge ist die richtige Kurve.
  const useSight = presence && f.linkState !== "gone";

  // Sichtungs-Events laden (RPC aggregiert serverseitig auf Minuten- bzw. Stunden-Körnung,
  // hält den Egress klein). null = noch nicht geladen, [] = keine Events im Fenster.
  const [sightRows, setSightRows] = useState<{ source_id: number; bucket: string; n: number }[] | null>(null);
  const sightGran = unit === "minute" ? "minute" : "hour";
  useEffect(() => {
    if (!useSight) { setSightRows(null); return; }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("sighting_buckets", { p_from: fromIso, p_to: toIso, p_gran: sightGran });
      if (!cancelled) setSightRows(error ? [] : ((data ?? []) as { source_id: number; bucket: string; n: number }[]));
    })();
    return () => { cancelled = true; };
  }, [useSight, fromIso, toIso, sightGran, f.corpusLoadedAt]);

  const { series, total, isSightings } = useMemo(() => {
    // „Zuletzt gesehen" + Verleger: ECHTE Crawl-Sichtungen aus der sightings-Tabelle —
    // der Scraper protokolliert minutengenau, wie viele Artikel-Links er sieht. Ergebnis:
    // Rampe während des ~30-min-Laufs, Plateau bis zum nächsten Lauf. Fällt auf die
    // last_seen-Verteilung zurück, solange noch keine Events gesammelt sind (Tabelle neu)
    // oder im Themen-Modus (Sichtungen sind nur je Quelle erfasst, nicht je Thema).
    if (useSight && chartMode === "publishers" && sightRows && sightRows.length) {
      const starts = buckets.map((b) => Date.parse(b));
      const stepMs = unit === "minute" ? 60000 : unit === "hour" ? 3600000 : unit === "day" ? 86400000 : 604800000;
      const windowTo = (starts[starts.length - 1] ?? 0) + stepMs;
      // letzter Bucket-Index mit start <= ms (binäre Suche)
      const idxOf = (ms: number) => {
        let lo = 0, hi = starts.length - 1, res = 0;
        while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= ms) { res = mid; lo = mid + 1; } else hi = mid - 1; }
        return res;
      };
      const bySid = new Map<number, number[]>();
      let tot = 0;
      for (const r of sightRows) {
        if (!act.has(r.source_id)) continue;
        const ms = Date.parse(r.bucket);
        if (ms < (starts[0] ?? 0) || ms >= windowTo) continue;
        let vals = bySid.get(r.source_id);
        if (!vals) { vals = new Array(buckets.length).fill(0); bySid.set(r.source_id, vals); }
        vals[idxOf(ms)] += r.n;
        tot += r.n;
      }
      const ser: Series[] = sources.filter((s) => act.has(s.id)).map((s) => ({
        key: String(s.id), sid: s.id, color: colorById.get(s.id)!, label: short(s.name),
        vals: bySid.get(s.id) ?? buckets.map(() => 0),
      }));
      return { series: ser, total: tot, isSightings: true };
    }

    const snap = { ...snapshotOf(f as any), rangeFrom: fromIso, rangeTo: toIso };
    const match = makeMatcher(snap, f.subPats, f.kwIdSet);
    let tot = 0;

    if (chartMode === "topics") {
      // Nach Thema gruppieren statt nach Quelle; Top-10-Themen farbkodiert.
      const map = new Map<string, Map<string, number>>();
      for (const r of f.corpus) {
        if (!act.has(r.source_id)) continue;
        if (!match(r)) continue;
        const t = axisTime(r, f.timeAxis);
        if (!t) continue;
        const k = truncTo(t, unit).toISOString();
        const topic = r.topic ?? "sonstiges";
        if (!map.has(topic)) map.set(topic, new Map());
        const m = map.get(topic)!;
        m.set(k, (m.get(k) ?? 0) + 1);
        tot++;
      }
      const ser: Series[] = [...map.entries()]
        .map(([topic, m]) => ({
          key: topic, topic, color: TOPIC_COLORS[topic] ?? "var(--faint)", label: topicLabel(topic),
          vals: buckets.map((b) => m.get(b) ?? 0),
        }))
        .sort((a, b) => b.vals.reduce((s, v) => s + v, 0) - a.vals.reduce((s, v) => s + v, 0))
        .slice(0, 10);
      return { series: ser, total: tot, isSightings: false };
    }

    const map = new Map<number, Map<string, number>>();
    for (const r of f.corpus) {
      if (!act.has(r.source_id)) continue;
      if (!match(r)) continue;
      const t = axisTime(r, f.timeAxis);
      if (!t) continue;
      const k = truncTo(t, unit).toISOString();
      if (!map.has(r.source_id)) map.set(r.source_id, new Map());
      const m = map.get(r.source_id)!;
      m.set(k, (m.get(k) ?? 0) + 1);
      tot++;
    }
    const ser: Series[] = sources.filter((s) => act.has(s.id)).map((s) => ({
      key: String(s.id), sid: s.id, color: colorById.get(s.id)!, label: short(s.name),
      vals: buckets.map((b) => map.get(s.id)?.get(b) ?? 0),
    }));
    return { series: ser, total: tot, isSightings: false };
  }, [chartMode, useSight, sightRows, f.corpus, f.corpusReady, sources, act, buckets, unit, fromIso, toIso, f.timeAxis,
      f.status, f.paywall, f.atype, f.author, f.topics.join(","), f.lang, f.changed, f.depth,
      f.hideRegional, f.linkState, f.onlineCut, f.subPats.join("|"), f.kwIdSet]);

  const NB = buckets.length;
  const availW = (containerW > 0 ? containerW : VW) - PAD_L - PAD_R;
  // „Fit"-Dichte: so dicht, dass alle Buckets genau die Containerbreite füllen.
  const fitDens = availW / Math.max(1, NB - 1);
  // Erlaubter Dichtebereich PRO EINHEIT — bewusst weit gespannt, damit man lange innerhalb
  // einer Einheit strecken UND stauchen kann, bevor (im Dynamik-Modus) die Einheit springt.
  // maxDens (strecken): großzügig, feinere Einheiten brauchen weniger px je Bucket.
  const maxDens = unit === "minute" ? 120 : unit === "hour" ? 400 : unit === "day" ? 600 : 900;
  // minDens (stauchen): unter fitDens erlaubt → Achse wird gestaucht (Buckets rücken zusammen),
  // aber nie unter ~1,5 px/Bucket (sonst unlesbar). Erst dann springt die Einheit gröber.
  const minDensFloor = unit === "minute" ? 0.4 : unit === "hour" ? 1.2 : unit === "day" ? 3 : 6;
  const minDens = Math.min(fitDens, minDensFloor);
  const effDens = dens === null ? fitDens : Math.max(minDens, Math.min(maxDens, dens));
  // naturalWidth: Datendichte × Bucketzahl; darf jetzt auch SCHMALER als der Container sein
  // (Stauchen), füllt dann zentriert nur einen Teil — sonst nie unter Containerbreite.
  const naturalWidth = effDens * Math.max(1, NB - 1);
  const totalSvgW = Math.max(availW, naturalWidth) + PAD_L + PAD_R;
  const stretched = naturalWidth > availW + 1; // breiter als Container → scrollbar

  const X = (i: number) => PAD_L + (i / Math.max(1, NB - 1)) * naturalWidth;
  const Y = (v: number) => PAD_T + CH - (v / displayMaxVal) * CH;

  // Darstellung Säulen ↔ Kurve: FREI wählbar (Badge im Chart), unabhängig vom Modus.
  // DEFAULT folgt weiterhin dem Modus: „Je Einheit" = Säulen (der Crawl arbeitet schubweise,
  // die meisten Minuten-Buckets sind 0 — eine Kurve über die Nullen wirkt wie Dauer-Aktivität),
  // „Kumuliert" = Kurve (stetiger, monotoner Verlauf). Eine explizite Wahl überstimmt den
  // Default und gilt in beiden Modi weiter.
  const [styleChoice, setStyleChoice] = useState<ChartStyle | null>(null);
  const chartStyle: ChartStyle = styleChoice ?? (timeFormat === "rel" ? "bars" : "curve");
  const barMode = chartStyle === "bars";
  function linePoints(vals: number[]): [number, number][] {
    return vals.map((v, i) => [X(i), Y(v)] as [number, number]);
  }
  function pathThrough(pts: [number, number][]): string {
    if (pts.length < 2) return "";
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      const cp = (x1 - x0) * 0.45;
      d += ` C${(x0 + cp).toFixed(1)},${y0.toFixed(1)} ${(x1 - cp).toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return d;
  }
  function smoothPath(vals: number[]): string {
    return pathThrough(linePoints(vals));
  }
  function areaPath(vals: number[]): string {
    const pts = linePoints(vals);
    if (pts.length < 2) return "";
    const line = pathThrough(pts);
    const base = PAD_T + CH;
    return `${line} L${pts[pts.length - 1][0].toFixed(1)},${base.toFixed(1)} L${pts[0][0].toFixed(1)},${base.toFixed(1)} Z`;
  }

  // Tagestrennlinien im Stunden- UND Minuten-Modus (Mitternacht LOKAL markiert den Tageswechsel).
  const dayDividers = useMemo(() => {
    if (unit !== "hour" && unit !== "minute") return [];
    const out: { idx: number; label: string }[] = [];
    for (let i = 1; i < buckets.length; i++) {
      const d = new Date(buckets[i]);
      if (d.getHours() === 0 && d.getMinutes() === 0) {
        out.push({ idx: i, label: d.toLocaleDateString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }) });
      }
    }
    return out;
  }, [buckets, unit]);

  // Position der „Jetzt"-Linie: aktuelle Zeit auf die Bucket-Achse projiziert (fraktionaler
  // Bucket-Index → X). null, wenn „jetzt" außerhalb des sichtbaren Zeitraums liegt.
  const nowX = useMemo(() => {
    if (buckets.length === 0) return null;
    const first = Date.parse(buckets[0]);
    const stepMs = unit === "minute" ? 60000 : unit === "hour" ? 3600000 : unit === "day" ? 86400000 : 604800000;
    const lastStart = Date.parse(buckets[buckets.length - 1]);
    if (nowMs < first || nowMs > lastStart + stepMs) return null;
    // Bucket finden, in den „jetzt" fällt, dann innerhalb interpolieren (DST-sicher via Nachbar-Delta).
    let i = 0;
    while (i < buckets.length - 1 && Date.parse(buckets[i + 1]) <= nowMs) i++;
    const bi = Date.parse(buckets[i]);
    const biNext = i < buckets.length - 1 ? Date.parse(buckets[i + 1]) : bi + stepMs;
    const frac = i + Math.min(1, Math.max(0, (nowMs - bi) / Math.max(1, biNext - bi)));
    // „jetzt" liegt im laufenden (letzten, Teil-)Bucket → frac kann NB-1 übersteigen und würde
    // rechts aus dem Plot laufen (weggeclippt). Auf die rechte Plotkante klemmen (= Vorderkante).
    return X(Math.min(frac, NB - 1));
  }, [buckets, nowMs, unit, naturalWidth, NB]);

  // Alle Labels in LOKALER Zeit des Endnutzers.
  const fmtAxis = (iso: string) => {
    const d = new Date(iso);
    if (unit === "minute") return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (unit === "hour") return String(d.getHours()).padStart(2, "0") + ":00";
    if (unit === "week") return "KW " + isoWeek(d);
    return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
  };
  // Volles Datum+Zeit für den Dot-Tooltip
  const fmtFull = (iso: string) => {
    const d = new Date(iso);
    if (unit === "minute") return d.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " Uhr";
    if (unit === "hour") return d.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " Uhr";
    if (unit === "week") return "KW " + isoWeek(d) + " · " + d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
    return d.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "2-digit" });
  };

  const unitLabel = unit === "minute" ? "Minuten" : unit === "hour" ? "Stunden" : unit === "day" ? "Tage" : "Kalenderwochen";

  // Klick auf einen Dot → Tabelle exakt auf dieses Bucket-Zeitfenster + diese Reihe
  // (Verleger ODER Thema, je nach Chart-Modus) filtern.
  const pinDot = (s: Series, idx: number) => {
    const start = new Date(buckets[idx]);
    const end = new Date(start);
    if (unit === "minute") end.setUTCMinutes(end.getUTCMinutes() + 1);
    else if (unit === "hour") end.setUTCHours(end.getUTCHours() + 1);
    else if (unit === "day") end.setUTCDate(end.getUTCDate() + 1);
    else end.setUTCDate(end.getUTCDate() + 7);
    end.setUTCSeconds(end.getUTCSeconds() - 1); // inklusives Ende
    // Relativ vs. Absolut filtern UNTERSCHIEDLICH:
    //  • Rel.: der Dot = Artikel PRO Zeiteinheit → Fenster = genau dieses eine Bucket.
    //  • Abs.: der Dot = KUMULIERTER Stand (displaySeries resettet je Lokaltag) → Fenster =
    //    ab Tagesbeginn bis zu diesem Bucket, damit die Tabelle ALLE bis hier gezählten
    //    Artikel zeigt (nicht nur das eine Bucket).
    const from = timeFormat === "abs"
      ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0)
      : start;
    f.setPinpoint({
      from: from.toISOString(), to: end.toISOString(),
      ...(s.sid != null ? { sourceId: s.sid } : {}),
      ...(s.topic != null ? { topic: s.topic } : {}),
      label: timeFormat === "abs"
        ? `${s.label} · kumuliert bis ${fmtFull(buckets[idx])}`
        : `${s.label} · ${fmtFull(buckets[idx])}`,
    });
    // sanft zur Tabelle scrollen, damit die Wirkung sichtbar ist
    requestAnimationFrame(() => document.querySelector(".dt-wrap")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  const fromD = new Date(fromIso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const toD = new Date(toIso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  // X-Achsen-Beschriftung auf RUNDEN Zeitpunkten: Der frühere Index-Schritt (jedes k-te
  // Bucket) erzeugte bei krummem k „zufällige" Label wie 04:46, 05:23 … Jetzt wird der
  // kleinste „schöne" Schritt (5/10/15/30 min, 1/2/3/6/12 h, 1/2/7 Tage) gewählt, der den
  // Mindestabstand (~64 px) einhält — und beschriftet wird nur ein Bucket, dessen LOKALE
  // Zeit ein Vielfaches des Schritts ist. Die Ticks liegen damit gleichbleibend auf
  // 04:00 / 04:15 / 04:30 … und bleiben beim Zoomen/Scrollen stabil verankert.
  const LABEL_MIN_PX = 64;
  const axisTicks = useMemo(() => {
    const set = new Set<number>();
    const bucketPx = Math.max(0.0001, effDens); // px je Bucket
    let stepMin = 0; // gewählter Schritt in Minuten (nur minute/hour) — steuert das Tick-Format
    if (unit === "minute" || unit === "hour") {
      const bucketMin = unit === "minute" ? 1 : 60;
      // Schritt-Leiter in Minuten; ab 2880 = Mehr-Tages-Schritte (nur Mitternachten).
      const LADDER = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080];
      const needMin = (LABEL_MIN_PX / bucketPx) * bucketMin;
      const step = LADDER.find((s) => s >= bucketMin && s >= needMin) ?? LADDER[LADDER.length - 1];
      stepMin = step;
      for (let i = 0; i < buckets.length; i++) {
        const d = new Date(buckets[i]);
        const minOfDay = d.getHours() * 60 + d.getMinutes();
        if (step <= 1440) { if (minOfDay % step === 0) set.add(i); }
        else if (minOfDay === 0) {
          // Mehr-Tages-Schritt: Mitternacht jedes n-ten Tages, verankert am Epochentag
          // (stabil — unabhängig vom Fensterstart).
          const dayNum = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
          if (dayNum % (step / 1440) === 0) set.add(i);
        }
      }
    } else if (unit === "day") {
      const needDays = LABEL_MIN_PX / bucketPx;
      const step = [1, 2, 7, 14].find((s) => s >= needDays) ?? 14;
      for (let i = 0; i < buckets.length; i++) {
        const d = new Date(buckets[i]);
        const dayNum = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
        // Ab Wochen-Schritt auf Montage legen (14 Tage = Montage gerader ISO-Wochen).
        if (step < 7 ? dayNum % step === 0 : d.getDay() === 1 && (step === 7 || isoWeek(d) % 2 === 0)) set.add(i);
      }
    } else {
      // Wochen beginnen ohnehin einheitlich montags → gleichmäßiger Index-Schritt reicht.
      const step = Math.max(1, Math.ceil(LABEL_MIN_PX / bucketPx));
      for (let i = 0; i < buckets.length; i += step) set.add(i);
    }
    return { set, stepMin };
  }, [unit, buckets, effDens]);
  // Ab Tages-Schritt zeigen die Ticks das DATUM: „00:00 | 00:00 | 00:00 …" (jede Mitternacht)
  // wäre korrekt gerundet, aber nichtssagend.
  const fmtTick = (iso: string) =>
    axisTicks.stepMin >= 1440
      ? new Date(iso).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })
      : fmtAxis(iso);

  // Im "abs"-Modus: Tageskumulierung — Reset auf 0 bei Tageswechsel (Lokalzeit).
  // Auf der Sichtungs-Achse ergibt das den erwarteten Tageszähler: jeder Crawl addiert
  // seine Sichtungen obendrauf, um 00:00 beginnt der Zähler bei null.
  const displayTarget = useMemo(() => {
    if (timeFormat !== "abs") return series;
    const dayKey = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
    return series.map((s) => {
      let running = 0, curDay = "";
      return {
        ...s,
        vals: s.vals.map((v, i) => {
          const day = dayKey(buckets[i]);
          if (day !== curDay) { running = 0; curDay = day; }
          running += v;
          return running;
        }),
      };
    });
  }, [series, timeFormat, presence, buckets]);
  // Wertwechsel (Rel↔Abs, Filter, Corpus-Reload) morphen weich zur neuen Sicht;
  // Y-Skala/Ticks hängen an den getweenten Werten und gleiten mit.
  const displaySeries = useTweenedSeries(displayTarget);

  // Säulen stehen NEBENEINANDER (gruppiert), nicht gestapelt: gestapelt startet jede Quelle auf
  // einem anderen Sockel und ist deshalb nicht vergleichbar. Gruppiert misst jede Säule ab der
  // Nulllinie → die Y-Skala fasst den größten EINZELWERT (wie im Linienmodus).
  const displayMaxVal = useMemo(
    () => Math.max(1, ...displaySeries.flatMap((s) => s.vals)),
    [displaySeries],
  );

  // Gruppierte Säulen-Geometrie: je Bucket ein Slot, darin S Säulen nebeneinander.
  // Bei feinen Einheiten (viele Buckets) wird die Einzelsäule sub-pixelig — ein Mindestmaß hält
  // sie sichtbar; der Chart ist ohnehin horizontal zoom-/scrollbar (Mausrad).
  const barGeom = useMemo(() => {
    if (!barMode) return null;
    const S = Math.max(1, displaySeries.length);
    const slot = naturalWidth / Math.max(1, NB);
    const groupW = Math.min(slot * 0.82, 26 * S);
    const bw = Math.max(0.6, groupW / S);
    // linker Rand der Gruppe, relativ zur Bucket-Mitte X(i)
    const x0 = -(bw * S) / 2;
    return { bw, x0 };
  }, [barMode, displaySeries.length, naturalWidth, NB]);

  const yTicks = useMemo(() => {
    const nTicks = 4;
    const step = Math.ceil(displayMaxVal / nTicks) || 1;
    const ticks: number[] = [];
    for (let v = 0; v <= displayMaxVal; v += step) ticks.push(v);
    if (ticks[ticks.length - 1] < displayMaxVal) ticks.push(displayMaxVal);
    return ticks;
  }, [displayMaxVal]);

  // Originale (nicht-kumulative) Werte pro Reihe — für Dot-Sichtbarkeit im abs-Modus.
  const origById = useMemo(() => new Map(series.map((s) => [s.key, s.vals])), [series]);

  const hoverInfo = useMemo(() => {
    if (!hoverDot) return null;
    // Ziel-Werte (nicht die getweenten) — im Tooltip sollen ganze Zahlen stehen.
    const s = displayTarget.find((x) => x.key === hoverDot.key);
    if (!s) return null;
    return { name: s.label, color: s.color, val: s.vals[hoverDot.idx], when: fmtFull(buckets[hoverDot.idx]) };
  }, [hoverDot, displayTarget, buckets, timeFormat]);

  // Mausrad: kontrolliert in beide Richtungen stauchen/strecken.
  // Dynamisch-Modus: an den Dichte-Enden springt die EINHEIT (grob ↔ fein).
  // pointerRatio = relative Position im Content [0..1]; pointerPx = Pixel im sichtbaren Container.
  function applyZoom(dir: 1 | -1, pointerRatio: number, pointerPx: number) {
    const cur = effDens;
    const STEP = 1.07; // langsame Schritte → man bleibt länger innerhalb einer Einheit
    let next = dir > 0 ? cur * STEP : cur / STEP;

    if (manual === "auto") {
      const order = UNIT_ORDER; // week → day → hour → minute
      const ui = order.indexOf(unit);
      // Einheit springt erst, wenn man am ECHTEN Dichte-Ende (max bzw. min) weiterdreht —
      // nicht schon an fitDens. So bleibt man lange in Stunden/Tagen/Wochen/Minuten.
      // Sprung zu „minute" nur bei kurzem Zeitraum (sonst zu viele Buckets).
      const nextUnit = order[ui + 1];
      const canGoFiner = nextUnit !== "minute" || spanDays <= 3;
      if (dir > 0 && cur >= maxDens - 0.5 && ui < order.length - 1 && canGoFiner) {
        setAutoUnitOverride(nextUnit); setDens(null);
        return;
      }
      if (dir < 0 && cur <= minDens + 0.05 && ui > 0) {
        setAutoUnitOverride(order[ui - 1]); setDens(null);
        return;
      }
    }
    next = Math.max(minDens, Math.min(maxDens, next));
    if (Math.abs(next - cur) < 0.001) return;
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

  // Wheel-Logik jeden Render in den Ref schreiben (frischer Closure-State).
  // Der native Listener (passive:false, in measure attached) ruft diese Funktion auf.
  wheelFnRef.current = (e: WheelEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    e.preventDefault();   // verhindert das Mitscrollen der Seite
    e.stopPropagation();
    const rect = el.getBoundingClientRect();
    const pointerInContainer = e.clientX - rect.left;
    const ratio = (el.scrollLeft + pointerInContainer) / totalSvgW;
    applyZoom(e.deltaY < 0 ? 1 : -1, ratio, pointerInContainer);
    setHoverDot(null);
    clearCross();
  };

  // Click-and-Drag verschiebt die X-Achse (Pan). Nur sinnvoll wenn gescrollt werden kann.
  function handleDown(e: React.MouseEvent<SVGSVGElement>) {
    if (e.button !== 0 || !scrollRef.current || !stretched) return;
    panRef.current = { startX: e.clientX, startScroll: scrollRef.current.scrollLeft };
    didPanRef.current = false;
    setPanning(true);
    setHoverDot(null);
    clearCross();
  }
  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const p = panRef.current;
    if (p && scrollRef.current) { // Pan-Geste → kein Fadenkreuz
      if (Math.abs(e.clientX - p.startX) > 3) didPanRef.current = true;
      scrollRef.current.scrollLeft = p.startScroll - (e.clientX - p.startX);
      if (axisRef.current) axisRef.current.scrollLeft = scrollRef.current.scrollLeft;
      return;
    }
    // Fadenkreuz: Mauskoordinaten → SVG-Koordinaten (skaliert, falls die SVG anders gerendert wird).
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) * (totalSvgW / r.width);
    const y = (e.clientY - r.top) * (VH / r.height);
    if (crossRaf.current != null) return; // max. ein Update pro Frame
    crossRaf.current = requestAnimationFrame(() => {
      crossRaf.current = null;
      const inPlot = x >= PAD_L && x <= totalSvgW - PAD_R && y >= PAD_T && y <= PAD_T + CH;
      setCross(inPlot ? { x, y } : null);
    });
  }
  function clearCross() { if (crossRaf.current != null) { cancelAnimationFrame(crossRaf.current); crossRaf.current = null; } setCross(null); }
  function handleUp() { panRef.current = null; setPanning(false); }

  const resetZoom = () => {
    setDens(null); setAutoUnitOverride(null);
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    if (axisRef.current) axisRef.current.scrollLeft = 0;
  };
  const zoomMod = dens !== null || autoUnitOverride !== null;

  // Datenpunkte zeigen, wenn sie nicht zu dicht stehen — ODER wenn die Daten dünn sind
  // (z.B. Minuten-Modus: viele leere Buckets, aber nur wenige echte Punkte → diese exakt
  // minutengenau als Dots zeigen, statt sie wegen niedriger Dichte auszublenden).
  // Auf den ZIEL-Werten rechnen — die getweenten Zwischenwerte würden die
  // Dot-Sichtbarkeit während der Animation hin- und herkippen.
  const nonZeroPts = useMemo(
    () => displayTarget.reduce((s, ser) => s + ser.vals.reduce((a, v) => a + (v > 0 ? 1 : 0), 0), 0),
    [displayTarget],
  );
  const showDots = effDens >= 7 || nonZeroPts <= 280;

  return (
    <>
      <h2 className="section-h" style={{ alignItems: "center", flexWrap: "wrap" }}>
        {f.timeAxis === "seen" ? "Gesehen über Zeit" : "Publikationen über Zeit"}
        <span className="count"><span className="fx-text" key={`${total}-${fromD}-${toD}-${isSightings}`}>{total.toLocaleString("de-DE")} {isSightings ? "Sichtungen" : "Artikel"} · {fromD}–{toD}</span></span>
        <div className="seg seg-xs" style={{ marginLeft: "auto" }}>
          <button className={chartMode === "publishers" ? "on" : ""} onClick={() => setChartMode("publishers")} title="Linien je Verleger">Verleger</button>
          <button className={chartMode === "topics" ? "on" : ""} onClick={() => setChartMode("topics")} title="Linien je Thema (Top 10)">Themen</button>
        </div>
        <div className="seg" style={{ marginLeft: 6 }}>
          {/* „Rel./Abs." las sich wie Prozent vs. Anzahl — gemeint ist Rate vs. Kumulation. */}
          <button className={timeFormat === "rel" ? "on" : ""} onClick={() => setTimeFormat("rel")}
            title={presence ? "Sichtungen je Zeiteinheit — wie viele Seiten der Crawl in diesem Fenster verlinkt gesehen hat" : "Artikel je Zeiteinheit"}>Je Einheit</button>
          <button className={timeFormat === "abs" ? "on" : ""} onClick={() => setTimeFormat("abs")}
            title={presence ? "Tageszähler — jeder Crawl addiert seine Sichtungen, Reset um 00:00" : "Kumuliert je Tag (Reset um 00:00)"}>Kumuliert</button>
          <div style={{ width: 1, background: "var(--line)", margin: "0 4px" }} />
          <button className={manual === "auto" ? "on" : ""} onClick={() => setManual("auto")} title="Dynamisch">⟳ Dynamisch</button>
          {/* Minuten nur bei kurzem Zeitraum (sonst zu viele Buckets für die RPC) */}
          {spanDays <= 3 && <button className={manual === "minute" ? "on" : ""} onClick={() => setManual("minute")} title="Minutengenau">Minute</button>}
          <button className={manual === "hour" ? "on" : ""} onClick={() => setManual("hour")}>Stunde</button>
          <button className={manual === "day" ? "on" : ""} onClick={() => setManual("day")}>Tag</button>
          <button className={manual === "week" ? "on" : ""} onClick={() => setManual("week")}>Woche</button>
        </div>
      </h2>
      <div className="panel pad" style={{ position: "relative" }}>
        <div className="trf-resize" onPointerDown={startResize} title="Höhe ziehen" style={{ cursor: resizing ? "row-resize" : undefined }}><span /></div>
        {!total ? (
          <p className="faint" style={{ fontSize: 13 }}>Keine Artikel im gewählten Zeitraum.</p>
        ) : (
          <>
            <div className="rate-legend">
              {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
              <span className="rate-hint">Mausrad: stauchen / strecken{stretched ? " · ziehen verschiebt" : ""}</span>
              {zoomMod && <button className="rate-zoomreset" onClick={resetZoom} title="Ansicht zurücksetzen">⤢ zurücksetzen</button>}
              <span style={{ marginLeft: zoomMod ? 0 : "auto", color: "var(--faint)" }}>
                Einheit: <b className="fx-text" key={unitLabel} style={{ color: "var(--accent)" }}>{unitLabel}</b>{manual === "auto" ? " (dynamisch)" : ""}
              </span>
            </div>

            <div style={{ position: "relative" }}>
              {/* Sticky Y-Achse — scrollt nicht mit dem Chart */}
              <svg
                style={{ position: "absolute", left: 0, top: 0, zIndex: 2, pointerEvents: "none", background: "var(--surface)" }}
                width={PAD_L}
                height={VH}
              >
                {yTicks.map((v) => (
                  <text key={v} x={PAD_L - 6} y={Y(v)} textAnchor="end" dominantBaseline="middle"
                    fontSize="9" fill="var(--faint)">{v}</text>
                ))}
                <line x1={PAD_L - 1} y1={PAD_T} x2={PAD_L - 1} y2={PAD_T + CH}
                  stroke="var(--line)" strokeWidth="1" />
                {/* y-Wert des Fadenkreuz-Cursors — fest auf der Y-Achse, immer sichtbar */}
                {cross && (
                  <g>
                    <rect className="rate-cross-chip" x={1} y={cross.y - 7} width={PAD_L - 3} height={14} rx={3} />
                    <text className="rate-cross-txt" x={(PAD_L - 2) / 2} y={cross.y + 3.4} textAnchor="middle">
                      {Math.max(0, Math.round(((PAD_T + CH - cross.y) / CH) * displayMaxVal))}
                    </text>
                  </g>
                )}
              </svg>

              <div
                ref={measure}
                className={`rate-scroll ${stretched ? "can-pan" : ""} ${panning ? "is-panning" : ""}`}
                onScroll={(e) => {
                  const sl = (e.target as HTMLDivElement).scrollLeft;
                  if (axisRef.current) axisRef.current.scrollLeft = sl;
                }}
              >
              <svg
                key={`${unit}-${NB}-${chartStyle}-${displayTarget.map((s) => s.key).join(",")}`}
                viewBox={`0 0 ${totalSvgW} ${VH}`}
                width={totalSvgW}
                height={VH}
                className="rate-svg-inner chart-swap"
                style={{ display: "block", touchAction: "pan-x" }}
                onMouseDown={handleDown}
                onMouseMove={handleMove}
                onMouseUp={handleUp}
                onMouseLeave={() => { handleUp(); setHoverDot(null); clearCross(); }}
              >
                {yTicks.map((v) => (
                  <g key={v}>
                    <line x1={PAD_L} y1={Y(v)} x2={totalSvgW - PAD_R} y2={Y(v)}
                      stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
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

                {/* Vertikal auslaufende Gradient-Flächen unter den Kurven (statt flacher
                    Deckkraft) — stopColor nimmt die var(--cN)-Serienfarben direkt an. */}
                <defs>
                  {displaySeries.map((s) => {
                    const gid = `rs-grad-${String(s.key).replace(/[^a-zA-Z0-9_-]/g, "")}`;
                    return (
                      <linearGradient key={gid} id={gid} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={s.color} stopOpacity="0.32" />
                        <stop offset="100%" stopColor={s.color} stopOpacity="0" />
                      </linearGradient>
                    );
                  })}
                </defs>
                {/* Pro Einheit → GRUPPIERTE Säulen: je Bucket stehen die Verleger nebeneinander,
                    jede misst ab der Nulllinie und ist damit direkt vergleichbar.
                    Kumuliert → Fläche + Linie (stetiger, monotoner Verlauf). */}
                {barMode && barGeom ? (
                  displaySeries.map((s, si) => (
                    <g key={`b${s.key}`}>
                      {s.vals.map((v, i) => {
                        if (v <= 0) return null;
                        const yTop = Y(v), yBot = Y(0);
                        const bx = X(i) + barGeom.x0 + si * barGeom.bw;
                        return (
                          <rect key={i} x={bx} y={yTop}
                            width={barGeom.bw} height={Math.max(0.75, yBot - yTop)}
                            fill={s.color} opacity={0.92} shapeRendering="crispEdges"
                            style={{ cursor: presence ? "default" : "pointer" }}
                            onMouseEnter={() => !panRef.current && setHoverDot({ key: s.key, idx: i, x: bx + barGeom.bw / 2, y: yTop })}
                            onMouseLeave={() => setHoverDot((h) => (h?.key === s.key && h?.idx === i ? null : h))}
                            onClick={() => { if (!didPanRef.current && !presence) pinDot(s, i); }} />
                        );
                      })}
                    </g>
                  ))
                ) : (
                  <>
                    {displaySeries.map((s) => (
                      <path key={`a${s.key}`} d={areaPath(s.vals)}
                        fill={`url(#rs-grad-${String(s.key).replace(/[^a-zA-Z0-9_-]/g, "")})`} />
                    ))}
                    {displaySeries.map((s) => (
                      <path key={`l${s.key}`} d={smoothPath(s.vals)} fill="none"
                        stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        vectorEffect="non-scaling-stroke" />
                    ))}
                  </>
                )}

                {/* „Jetzt"-Marker: dezente vertikale Linie an der aktuellen Uhrzeit, läuft mit. */}
                {nowX != null && (
                  <g className="rate-now" pointerEvents="none">
                    <line className="rate-now-line" x1={nowX} y1={PAD_T} x2={nowX} y2={PAD_T + CH} vectorEffect="non-scaling-stroke" />
                    <g transform={`translate(${nowX - 3}, ${PAD_T + 1})`}>
                      <rect className="rate-now-chip" x={-30} y={0} width={30} height={12} rx={3} vectorEffect="non-scaling-stroke" />
                      <text className="rate-now-txt" x={-15} y={9} textAnchor="middle">jetzt</text>
                    </g>
                  </g>
                )}

                {/* Datenpunkte — Tooltip NUR beim Hover auf den einzelnen Dot.
                    Im Säulenmodus überflüssig: dort trägt die Säule selbst den Tooltip. */}
                {!barMode && showDots && displaySeries.map((s) => s.vals.map((v, i) => {
                  if ((origById.get(s.key)?.[i] ?? 0) <= 0) return null;
                  const isHover = hoverDot?.key === s.key && hoverDot?.idx === i;
                  return (
                    <g key={`${s.key}-${i}`}>
                      <circle cx={X(i)} cy={Y(v)} r="4" fill={s.color} className="rate-pulse" style={{ ["--c" as any]: s.color }} />
                      <circle cx={X(i)} cy={Y(v)} r={isHover ? 5.5 : 3.4} fill={s.color}
                        stroke="var(--surface)" strokeWidth="1.5" vectorEffect="non-scaling-stroke"
                        className="rate-dot" />
                      <circle cx={X(i)} cy={Y(v)} r="11" fill="transparent" style={{ cursor: presence ? "default" : "pointer" }}
                        onMouseEnter={() => !panRef.current && setHoverDot({ key: s.key, idx: i, x: X(i), y: Y(v) })}
                        onMouseLeave={() => setHoverDot((h) => (h?.key === s.key && h?.idx === i ? null : h))}
                        onClick={() => { if (!didPanRef.current && !presence) pinDot(s, i); }} />
                    </g>
                  );
                }))}

                {/* Fadenkreuz-Cursor: vertikale + horizontale Linie + x-Wert (Zeit) am unteren Rand.
                    Dezent (dünn, gestrichelt). pointerEvents:none → Dot-Hover bleibt funktionsfähig. */}
                {cross && (() => {
                  const bi = Math.min(NB - 1, Math.max(0, Math.round(((cross.x - PAD_L) / Math.max(1, naturalWidth)) * (NB - 1))));
                  return (
                    <g className="rate-cross" pointerEvents="none">
                      <line className="rate-cross-line" x1={cross.x} y1={PAD_T} x2={cross.x} y2={PAD_T + CH} vectorEffect="non-scaling-stroke" />
                      <line className="rate-cross-line" x1={PAD_L} y1={cross.y} x2={totalSvgW - PAD_R} y2={cross.y} vectorEffect="non-scaling-stroke" />
                      <g transform={`translate(${cross.x}, ${PAD_T + CH + 2})`}>
                        <rect className="rate-cross-chip" x={-26} y={0} width={52} height={14} rx={3} vectorEffect="non-scaling-stroke" />
                        <text className="rate-cross-txt" x={0} y={10.3} textAnchor="middle">{fmtAxis(buckets[bi])}</text>
                      </g>
                    </g>
                  );
                })()}
              </svg>

              {/* Per-Dot-Tooltip — flippt nach UNTEN, wenn der Punkt zu weit oben liegt
                  (sonst wäre der Tooltip über dem Punkt abgeschnitten/unsichtbar). */}
              {hoverInfo && hoverDot && (
                <div className={`rate-cursor-tip rate-dot-tip ${hoverDot.y < 62 ? "below" : ""}`} style={{ left: hoverDot.x, top: hoverDot.y }}>
                  <div className="rct-label">{hoverInfo.when}</div>
                  <div className="rct-row">
                    <i style={{ background: hoverInfo.color }} />
                    <span>{hoverInfo.name}</span>
                    <b>{hoverInfo.val}</b>
                  </div>
                </div>
              )}
            </div>

            {/* Darstellung Säulen ↔ Kurve — dezentes Badge, oben rechts im Chart.
                Bewusst AUSSERHALB des Scroll-Containers (scrollt sonst beim Pannen mit raus). */}
            <ChartStyleToggle className="cst-abs" value={chartStyle} onChange={setStyleChoice} />
            </div>

            <div className="rate-axis-wrap" ref={axisRef}>
              <div className="rate-axis" style={{ width: totalSvgW, position: "relative" }}>
                {buckets.map((b, i) => {
                  if (!axisTicks.set.has(i)) return null;
                  return (
                    <span key={b} style={{
                      position: "absolute",
                      left: X(i),
                      transform: i === 0 ? "none" : i >= NB - 2 ? "translateX(-100%)" : "translateX(-50%)",
                    }}>{fmtTick(b)}</span>
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
