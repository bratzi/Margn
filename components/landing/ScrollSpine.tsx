"use client";

import { useEffect, useRef } from "react";

/* ----------------------------------------------------------------------------
   ScrollSpine — eine mitlaufende Linie, die quer über die Seite WANDERT (links ↔
   Mitte ↔ rechts), pro Sektion ihren Charakter wechselt (gerade, wellig, zackig,
   Treppe, Feder …) und sich entlang des Scrolls zeichnet. Bewusst nicht zu brav:
   driftende Mittellinie + Charakter-Textur mit Hüllkurve und etwas Jitter, weich
   geglättet. Misst echte Sektionspositionen, reagiert auf Layout-Änderungen,
   respektiert prefers-reduced-motion.
---------------------------------------------------------------------------- */

type Mood = "straight" | "wave" | "zig" | "step" | "spring" | "ease";

// Reihenfolge = DOM-Reihenfolge. lane = horizontale Spur (0 = links … 1 = rechts) im
// Content-Band; amp = Stärke der Charakter-Textur; color = Stimmung der Sektion.
const SECTIONS: { sel: string; mood: Mood; color: string; lane: number; amp: number }[] = [
  { sel: ".mg-hero",     mood: "ease",   color: "#9fb2ff", lane: 0.16, amp: 0.55 }, // ruhiger Einstieg, links
  { sel: "#funktionen",  mood: "wave",   color: "#6e8aff", lane: 0.52, amp: 1.0 },  // fließend, mittig
  { sel: "#anatomie",    mood: "zig",    color: "#ff6f61", lane: 0.78, amp: 1.15 }, // Diff/Herzschlag, rechts, rot
  { sel: ".mg-stats",    mood: "step",   color: "#9fb2ff", lane: 0.40, amp: 0.9 },  // Kennzahlen — Stufen
  { sel: "#methodik",    mood: "spring", color: "#43d9a3", lane: 0.22, amp: 0.85 }, // Prozess — Feder, links, grün
  { sel: "#abdeckung",   mood: "wave",   color: "#6e8aff", lane: 0.66, amp: 1.0 },  // sprachübergreifend, rechts der Mitte
  { sel: "#transparenz", mood: "straight", color: "#9fb2ff", lane: 0.48, amp: 0.25 }, // nichts versteckt — fast gerade
  { sel: ".mg-final",    mood: "ease",   color: "#43d9a3", lane: 0.5,  amp: 0.55 }, // Auflösung, mittig
];

type Pt = { x: number; y: number };

// Dreieck (scharf) und weiches Rechteck — für Zickzack bzw. Treppe.
const tri = (t: number) => (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * t));
function shape(mood: Mood, t: number): number {
  switch (mood) {
    case "wave": return Math.sin(2 * Math.PI * 1.5 * t);
    case "spring": return Math.sin(2 * Math.PI * 3.5 * t);
    case "zig": return tri(2 * t);
    case "step": return Math.tanh(3.2 * Math.sin(2 * Math.PI * 2.5 * t)); // gerundete Stufen
    case "ease": return Math.sin(Math.PI * t);
    default: return 0; // straight
  }
}

// Catmull-Rom → kubische Bézier: macht den ganzen Linienzug fließend (auch die
// Zacken werden minimal gerundet → der gewünschte „nicht 100 %"-Touch).
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

  useEffect(() => {
    const svg = svgRef.current, ghost = ghostRef.current, draw = drawRef.current, head = headRef.current, grad = gradRef.current;
    if (!svg || !ghost || !draw || !head || !grad) return;
    const root = svg.parentElement;
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let len = 0, raf = 0, polyLen = 1;
    let polyPts: Pt[] = [];
    let cum = new Float64Array(0);

    const build = () => {
      const W = root.clientWidth, H = root.scrollHeight;
      if (!W || !H) return;
      const narrow = W < 720;

      // Content-Band (max 1280, zentriert) → die Linie webt sich durch den Inhalt,
      // darf aber leicht in die Ränder ausschwingen.
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

      // Mittellinie: weich interpolierte Spur (lane) über die Sektions-Mitten.
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

      // Jede Sektion „besitzt" ein vertikales Band (bis zur Mitte zur Nachbarsektion).
      const bands = found.map((f, i) => ({
        start: i === 0 ? 0 : (found[i - 1].mid + f.mid) / 2,
        end: i === found.length - 1 ? H : (f.mid + found[i + 1].mid) / 2,
        mood: f.mood, amp: f.amp, seed: i * 1.73,
      }));
      const bandAt = (y: number) => {
        for (const b of bands) if (y <= b.end) return b;
        return bands[bands.length - 1];
      };

      // Punkte abtasten: Mittellinie + globaler Drift + Charakter-Textur mit Hüllkurve.
      const S = narrow ? 15 : 11;
      const pts: Pt[] = [];
      for (let y = 0; y <= H; y += S) {
        let cx = laneToX(laneAt(y)) + driftPx * Math.sin(y * 0.0016 + 0.7);
        const b = bandAt(y);
        const lp = Math.min(1, Math.max(0, (y - b.start) / Math.max(1, b.end - b.start)));
        const env = Math.sin(Math.PI * lp);                  // 0 an den Bandgrenzen → nahtlos
        const jit = 0.82 + 0.32 * Math.sin(lp * 6.3 + b.seed); // leichte Unregelmäßigkeit
        const off = ampPx * b.amp * env * jit * shape(b.mood, lp);
        const x = Math.min(W - 6, Math.max(6, cx + off));
        pts.push({ x, y });
      }
      if (pts.length && pts[pts.length - 1].y < H) pts.push({ x: pts[pts.length - 1].x, y: H });

      const d = smooth(pts);

      // Farbverlauf entlang Y, Stops an den Sektions-Mitten.
      grad.setAttribute("gradientUnits", "userSpaceOnUse");
      grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
      grad.setAttribute("x2", "0"); grad.setAttribute("y2", String(H));
      grad.replaceChildren();
      found.forEach((f) => {
        const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
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
      // Polylinien-Längentabelle EINMAL pro build vorberechnen → Kopfposition per
      // Interpolation statt getPointAtLength PRO Scroll-Frame (das lief auf dem
      // seitenlangen Pfad und war der Haupt-Scroll-Ruckler).
      polyPts = pts;
      cum = new Float64Array(pts.length);
      let acc = 0;
      for (let i = 1; i < pts.length; i++) { acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); cum[i] = acc; }
      polyLen = acc || 1;
      if (reduced) { draw.style.strokeDashoffset = "0"; head.style.display = "none"; }
      else apply();
    };

    const apply = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      const progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      draw.style.strokeDashoffset = String(len * (1 - progress));
      // Kopf entlang der vorberechneten Polylinie interpolieren (binäre Suche im
      // cum-Array) — billig, statt getPointAtLength auf dem ganzen Pfad pro Frame.
      if (polyPts.length > 1) {
        const target = polyLen * progress;
        let lo = 1, hi = polyPts.length - 1;
        while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < target) lo = m + 1; else hi = m; }
        const seg = cum[lo] - cum[lo - 1] || 1;
        const t = (target - cum[lo - 1]) / seg;
        const x = polyPts[lo - 1].x + (polyPts[lo].x - polyPts[lo - 1].x) * t;
        const y = polyPts[lo - 1].y + (polyPts[lo].y - polyPts[lo - 1].y) * t;
        head.setAttribute("cx", x.toFixed(1));
        head.setAttribute("cy", y.toFixed(1));
        head.style.opacity = progress > 0.002 && progress < 0.999 ? "1" : "0";
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

  return (
    <svg className="mg-spine" ref={svgRef} aria-hidden preserveAspectRatio="none">
      <defs>
        <linearGradient id="mgSpineGrad" ref={gradRef} />
      </defs>
      <path className="mg-spine-ghost" ref={ghostRef} fill="none" />
      <path className="mg-spine-draw" ref={drawRef} fill="none" stroke="url(#mgSpineGrad)" />
      <circle className="mg-spine-head" ref={headRef} r="4.5" />
    </svg>
  );
}
