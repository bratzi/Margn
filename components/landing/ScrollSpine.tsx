"use client";

import { useEffect, useRef, useState } from "react";

/* ----------------------------------------------------------------------------
   ScrollSpine — eine mitlaufende Linie, die quer über die Seite WANDERT und sich
   entlang des Scrolls zeichnet. NEU: pro Sektion ein CHECKPOINT, den der Kopf
   anfährt. Erreicht der Kopf einen Checkpoint, „zündet" er (Impact-Animation +
   Farbe) und erzählt im HUD die nächste Station im Leben EINES Artikels — von der
   Veröffentlichung über stille Edits bis zur aktuellen Fassung. Die Linie wird so
   zum Zeitstrahl einer Artikel-Evolution, abgespult durchs Scrollen.
   Respektiert prefers-reduced-motion, misst echte Layoutpositionen.
---------------------------------------------------------------------------- */

type Mood = "straight" | "wave" | "zig" | "step" | "spring" | "ease";

const SECTIONS: { sel: string; mood: Mood; color: string; lane: number; amp: number }[] = [
  { sel: ".mg-hero",     mood: "ease",   color: "#9fb2ff", lane: 0.16, amp: 0.55 },
  { sel: "#funktionen",  mood: "wave",   color: "#6e8aff", lane: 0.52, amp: 1.0 },
  { sel: "#anatomie",    mood: "zig",    color: "#ff6f61", lane: 0.78, amp: 1.15 },
  { sel: ".mg-stats",    mood: "step",   color: "#9fb2ff", lane: 0.40, amp: 0.9 },
  { sel: "#methodik",    mood: "spring", color: "#43d9a3", lane: 0.22, amp: 0.85 },
  { sel: "#abdeckung",   mood: "wave",   color: "#6e8aff", lane: 0.66, amp: 1.0 },
  { sel: "#transparenz", mood: "straight", color: "#9fb2ff", lane: 0.48, amp: 0.25 },
  { sel: ".mg-final",    mood: "ease",   color: "#43d9a3", lane: 0.5,  amp: 0.55 },
];

// Das Leben EINES Artikels, Station für Station — je Checkpoint eine Änderung.
type Beat = { k: string; t: string; title: string; detail: string };
const STORY: Beat[] = [
  { k: "pub",     t: "08:02", title: "Veröffentlicht",            detail: `«EU einigt sich auf strengere Lieferketten-Regeln»` },
  { k: "edit",    t: "09:14", title: "Überschrift still geändert", detail: `«einigt sich» → «ringt um Kompromiss»` },
  { k: "ext",     t: "10:41", title: "Absatz ergänzt",            detail: "+2 Absätze zur Gegenposition der Industrie" },
  { k: "meta",    t: "12:20", title: "Teaser umformuliert",       detail: "Vorspann sachlicher gefasst — gleicher Link" },
  { k: "date",    t: "14:55", title: "Datum verschoben",          detail: "Erscheinungszeit still um 3 h vordatiert" },
  { k: "paywall", t: "17:30", title: "Paywall aktiviert",         detail: "vorhin frei lesbar — jetzt kostenpflichtig" },
  { k: "echo",    t: "19:08", title: "Blattübergreifendes Echo",  detail: "drei weitere Medien greifen die Story auf" },
  { k: "now",     t: "jetzt", title: "Aktuelle Fassung",          detail: "6 stille Änderungen seit dem Erscheinen" },
];
const KIND_LABEL: Record<string, string> = {
  pub: "Start", edit: "Stille Änderung", ext: "Erweiterung", meta: "Metadaten",
  date: "Datum", paywall: "Paywall", echo: "Echo", now: "Stand",
};

type Pt = { x: number; y: number };

const tri = (t: number) => (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * t));
function shape(mood: Mood, t: number): number {
  switch (mood) {
    case "wave": return Math.sin(2 * Math.PI * 1.5 * t);
    case "spring": return Math.sin(2 * Math.PI * 3.5 * t);
    case "zig": return tri(2 * t);
    case "step": return Math.tanh(3.2 * Math.sin(2 * Math.PI * 2.5 * t));
    case "ease": return Math.sin(Math.PI * t);
    default: return 0;
  }
}
function smooth(pts: Pt[]): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} `;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} `;
  }
  return d;
}
const smoothstep = (t: number) => t * t * (3 - 2 * t);

export default function ScrollSpine() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const ghostRef = useRef<SVGPathElement | null>(null);
  const drawRef = useRef<SVGPathElement | null>(null);
  const headRef = useRef<SVGCircleElement | null>(null);
  const gradRef = useRef<SVGLinearGradientElement | null>(null);
  const cpLayerRef = useRef<SVGGElement | null>(null);
  // aktiver Beat-Index (für HUD). -1 = noch keiner erreicht.
  const [active, setActive] = useState(-1);

  useEffect(() => {
    const svg = svgRef.current, ghost = ghostRef.current, draw = drawRef.current, head = headRef.current, grad = gradRef.current, cpLayer = cpLayerRef.current;
    if (!svg || !ghost || !draw || !head || !grad || !cpLayer) return;
    const root = svg.parentElement;
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const NS = "http://www.w3.org/2000/svg";

    let len = 0, raf = 0, polyLen = 1, scrollMax = 1;
    let polyPts: Pt[] = [];
    let cum = new Float64Array(0);
    // Checkpoints: Position auf der Linie + zugehöriges SVG-<g> + „gezündet"-Status.
    let checkpoints: { y: number; el: SVGGElement; hit: boolean }[] = [];
    let lastActive = -1;
    let finalBtnEl: HTMLElement | null = null; // Endpunkt: der „Dashboard öffnen"-Button
    let arrived = false;

    const build = () => {
      const W = root.clientWidth, H = root.scrollHeight;
      if (!W || !H) return;
      const narrow = W < 720;

      const padX = narrow ? 16 : Math.min(64, Math.max(22, W * 0.045));
      const cx0 = Math.max(padX, (W - 1280) / 2 + padX);
      const cx1 = W - cx0;
      const laneToX = (lane: number) => cx0 + lane * (cx1 - cx0);
      const ampPx = narrow ? 13 : Math.min(58, Math.max(24, W * 0.038));
      const driftPx = narrow ? 7 : Math.min(28, W * 0.016);

      const found = SECTIONS
        .map((s) => ({ ...s, el: root.querySelector<HTMLElement>(s.sel) }))
        .filter((s): s is typeof s & { el: HTMLElement } => !!s.el)
        .map((s) => {
          const r = s.el.getBoundingClientRect();
          const top = r.top + window.scrollY;
          return { ...s, top, h: r.height, mid: top + r.height / 2 };
        });
      if (found.length < 2) return;

      const anchors = [
        { y: 0, lane: found[0].lane },
        ...found.map((f) => ({ y: f.mid, lane: f.lane })),
        { y: H, lane: found[found.length - 1].lane },
      ];
      const laneAt = (y: number) => {
        for (let i = 0; i < anchors.length - 1; i++) {
          if (y <= anchors[i + 1].y) {
            const a = anchors[i], b = anchors[i + 1];
            const t = (y - a.y) / Math.max(1, b.y - a.y);
            return a.lane + (b.lane - a.lane) * smoothstep(Math.min(1, Math.max(0, t)));
          }
        }
        return anchors[anchors.length - 1].lane;
      };

      const bands = found.map((f, i) => ({
        start: i === 0 ? 0 : (found[i - 1].mid + f.mid) / 2,
        end: i === found.length - 1 ? H : (f.mid + found[i + 1].mid) / 2,
        mood: f.mood, amp: f.amp, seed: i * 1.73,
      }));
      const bandAt = (y: number) => {
        for (const b of bands) if (y <= b.end) return b;
        return bands[bands.length - 1];
      };

      // Endpunkt der Linie = Mitte des „Dashboard öffnen"-Buttons (statt unten rauszulaufen).
      finalBtnEl = root.querySelector<HTMLElement>(".mg-final .mg-btn");
      let endY = H, endX: number | null = null;
      if (finalBtnEl) {
        const br = finalBtnEl.getBoundingClientRect();
        endY = br.top + window.scrollY + br.height / 2;
        endX = br.left + br.width / 2;
      }

      const S = narrow ? 20 : 16;
      const pts: Pt[] = [];
      for (let y = 0; y <= endY; y += S) {
        let cx = laneToX(laneAt(y)) + driftPx * Math.sin(y * 0.0016 + 0.7);
        const b = bandAt(y);
        const lp = Math.min(1, Math.max(0, (y - b.start) / Math.max(1, b.end - b.start)));
        const env = Math.sin(Math.PI * lp);
        const jit = 0.82 + 0.32 * Math.sin(lp * 6.3 + b.seed);
        const off = ampPx * b.amp * env * jit * shape(b.mood, lp);
        const x = Math.min(W - 6, Math.max(6, cx + off));
        pts.push({ x, y });
      }
      // exakt auf dem Button landen (sanft einlenken über den letzten Punkt)
      const lastX = endX ?? (pts.length ? pts[pts.length - 1].x : 6);
      if (pts.length && pts[pts.length - 1].y < endY) pts.push({ x: lastX, y: endY });
      else if (pts.length) pts[pts.length - 1] = { x: lastX, y: endY };

      const d = smooth(pts);

      grad.setAttribute("gradientUnits", "userSpaceOnUse");
      grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
      grad.setAttribute("x2", "0"); grad.setAttribute("y2", String(H));
      grad.replaceChildren();
      found.forEach((f) => {
        const stop = document.createElementNS(NS, "stop");
        stop.setAttribute("offset", `${Math.max(0, Math.min(1, f.mid / H)) * 100}%`);
        stop.setAttribute("stop-color", f.color);
        grad.appendChild(stop);
      });

      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", String(W));
      svg.setAttribute("height", String(H));
      ghost.setAttribute("d", d);
      draw.setAttribute("d", d);

      len = draw.getTotalLength();
      draw.style.strokeDasharray = String(len);
      polyPts = pts;
      cum = new Float64Array(pts.length);
      let acc = 0;
      for (let i = 1; i < pts.length; i++) { acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); cum[i] = acc; }
      polyLen = acc || 1;
      // progress=1 erreichen, sobald der Button angenehm im Bild ist (bei ~72 % Viewporthöhe) —
      // so „andockt" der Kopf am Button, statt erst am absoluten Seitenende.
      const lastPt = polyPts[polyPts.length - 1];
      scrollMax = finalBtnEl
        ? Math.max(1, lastPt.y - window.innerHeight * 0.72)
        : document.documentElement.scrollHeight - window.innerHeight;

      // ----- Checkpoints auf der Linie platzieren (an den Sektions-Mitten) -----
      const xAtY = (yy: number) => {
        // Polylinie ist in y monoton steigend → nächsten Punkt suchen und x interpolieren.
        let lo = 1, hi = polyPts.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (polyPts[m].y < yy) lo = m + 1; else hi = m; }
        const a = polyPts[lo - 1], b = polyPts[lo];
        const t = (yy - a.y) / Math.max(1, b.y - a.y);
        return a.x + (b.x - a.x) * t;
      };
      cpLayer.replaceChildren();
      checkpoints = found.slice(0, STORY.length).map((f, i) => {
        const y = Math.min(H - 4, f.mid);
        const x = xAtY(y);
        const g = document.createElementNS(NS, "g") as SVGGElement;
        g.setAttribute("class", "mg-cp");
        g.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
        g.style.setProperty("--cp", f.color);
        const burst = document.createElementNS(NS, "circle");
        burst.setAttribute("class", "mg-cp-burst"); burst.setAttribute("r", "9");
        const ring = document.createElementNS(NS, "circle");
        ring.setAttribute("class", "mg-cp-ring"); ring.setAttribute("r", "9");
        const dot = document.createElementNS(NS, "circle");
        dot.setAttribute("class", "mg-cp-dot"); dot.setAttribute("r", "4");
        const num = document.createElementNS(NS, "text");
        num.setAttribute("class", "mg-cp-num"); num.setAttribute("dy", "0.5"); num.textContent = String(i + 1);
        g.append(burst, ring, dot, num);
        cpLayer.appendChild(g);
        return { y, el: g, hit: false };
      });
      lastActive = -1;

      if (reduced) {
        draw.style.strokeDashoffset = "0"; head.style.display = "none";
        checkpoints.forEach((c) => { c.el.classList.add("is-hit"); c.hit = true; });
        setActive(checkpoints.length - 1);
      } else apply();
    };

    const apply = () => {
      raf = 0;
      const max = scrollMax;
      const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      draw.style.strokeDashoffset = String(len * (1 - progress));
      let hx = 0, hy = 0;
      if (polyPts.length > 1) {
        const target = polyLen * progress;
        let lo = 1, hi = polyPts.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < target) lo = m + 1; else hi = m; }
        const seg = cum[lo] - cum[lo - 1] || 1;
        const t = (target - cum[lo - 1]) / seg;
        hx = polyPts[lo - 1].x + (polyPts[lo].x - polyPts[lo - 1].x) * t;
        hy = polyPts[lo - 1].y + (polyPts[lo].y - polyPts[lo - 1].y) * t;
        head.setAttribute("cx", hx.toFixed(1));
        head.setAttribute("cy", hy.toFixed(1));
        head.style.opacity = progress > 0.002 && progress < 0.999 ? "1" : "0";
      }
      // Checkpoints zünden, sobald der Kopf sie (vertikal) passiert; rückwärts wieder lösen.
      const reach = hy + 26; // etwas Vorlauf, damit es „beim Anfahren" zündet
      let act = -1;
      for (let i = 0; i < checkpoints.length; i++) {
        const c = checkpoints[i];
        const on = reach >= c.y;
        if (on !== c.hit) { c.hit = on; c.el.classList.toggle("is-hit", on); if (on) { c.el.classList.remove("pulse"); void c.el.getBBox(); c.el.classList.add("pulse"); } }
        if (on) act = i;
      }
      if (act !== lastActive) { lastActive = act; setActive(act); }
      // Finale: Kopf dockt am Button an → einmalige Impact-Animation + Dauerpuls.
      if (finalBtnEl) {
        const on = progress > 0.992;
        if (on !== arrived) { arrived = on; finalBtnEl.classList.toggle("is-arrived", on); }
      }
    };

    const onScroll = () => { if (!reduced && !raf) raf = requestAnimationFrame(apply); };

    let rebuildT = 0;
    const scheduleBuild = () => { clearTimeout(rebuildT); rebuildT = window.setTimeout(build, 120); };
    const ro = new ResizeObserver(scheduleBuild);
    ro.observe(root);

    build();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", scheduleBuild);
    document.fonts?.ready?.then(scheduleBuild).catch(() => {});
    const t1 = window.setTimeout(build, 400);
    const t2 = window.setTimeout(build, 1200);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", scheduleBuild);
      ro.disconnect();
      clearTimeout(rebuildT); clearTimeout(t1); clearTimeout(t2);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const cur = active >= 0 ? STORY[Math.min(active, STORY.length - 1)] : null;

  return (
    <>
      <svg className="mg-spine" ref={svgRef} aria-hidden preserveAspectRatio="none">
        <defs>
          <linearGradient id="mgSpineGrad" ref={gradRef} />
        </defs>
        <path className="mg-spine-ghost" ref={ghostRef} fill="none" />
        <path className="mg-spine-draw" ref={drawRef} fill="none" stroke="url(#mgSpineGrad)" />
        <g className="mg-cp-layer" ref={cpLayerRef} />
        <circle className="mg-spine-head" ref={headRef} r="4.5" />
      </svg>

      {/* HUD: erzählt die Artikel-Evolution Station für Station, getrieben vom Scroll. */}
      <div className={`mg-evo ${cur ? "is-on" : ""}`} aria-hidden>
        <div className="mg-evo-rail">
          {STORY.map((b, i) => (
            <span key={i} className={`mg-evo-tick ${i <= active ? "on" : ""} ${i === active ? "now" : ""}`} data-k={b.k} />
          ))}
        </div>
        <div className="mg-evo-body">
          <div className="mg-evo-top">
            <span className="mg-evo-eyebrow">Leben eines Artikels</span>
            <span className="mg-evo-step">{active >= 0 ? `${active + 1} / ${STORY.length}` : ""}</span>
          </div>
          {cur ? (
            <div className="mg-evo-card" key={active} data-k={cur.k}>
              <div className="mg-evo-card-head">
                <span className="mg-evo-kind">{KIND_LABEL[cur.k] ?? cur.k}</span>
                <span className="mg-evo-time">{cur.t}</span>
              </div>
              <div className="mg-evo-title">{cur.title}</div>
              <div className="mg-evo-detail">{cur.detail}</div>
            </div>
          ) : (
            <div className="mg-evo-hint">Scrollen — die Linie spult ein Artikel-Leben ab.</div>
          )}
        </div>
      </div>
    </>
  );
}
