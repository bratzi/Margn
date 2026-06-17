"use client";

import { useEffect, useRef } from "react";

/* ----------------------------------------------------------------------------
   ScrollSpine — eine mitlaufende Linie, die sich von Sektion zu Sektion thematisch
   verändert (gerade, wellig, zackig …), entlang des Scrolls gezeichnet wird und einen
   glühenden Kopf voranschickt. Selbstständig: misst die echten Sektionspositionen,
   reagiert auf Resize/Höhenänderung (z. B. Anatomy-Pin), respektiert reduced-motion.
---------------------------------------------------------------------------- */

type Mood = "straight" | "wave" | "zig" | "step" | "spring" | "ease";

// Reihenfolge = Reihenfolge der Sektionen im DOM. Farbe passend zur Sektions-Stimmung.
const SECTIONS: { sel: string; mood: Mood; color: string; amp: number }[] = [
  { sel: ".mg-hero",   mood: "ease",     color: "#9fb2ff", amp: 0.55 }, // ruhiger Einstieg
  { sel: "#funktionen", mood: "wave",    color: "#6e8aff", amp: 1.0 },  // fließend, erkundend
  { sel: "#anatomie",  mood: "zig",      color: "#ff6f61", amp: 1.05 }, // Edit/Diff — scharf, rot
  { sel: ".mg-stats",  mood: "step",     color: "#9fb2ff", amp: 0.9 },  // Kennzahlen — Stufen
  { sel: "#methodik",  mood: "spring",   color: "#43d9a3", amp: 0.7 },  // Prozess — Feder, grün
  { sel: "#abdeckung", mood: "wave",     color: "#6e8aff", amp: 1.0 },  // sprachübergreifend
  { sel: "#transparenz", mood: "straight", color: "#9fb2ff", amp: 0 }, // nichts versteckt
  { sel: ".mg-final",  mood: "ease",     color: "#43d9a3", amp: 0.5 },  // Auflösung
];

type Pt = { x: number; y: number };

// Wellenform eines Segments von yStart→yEnd. Beginnt und endet IMMER bei x=baseX
// (Offset 0 an den Rändern) → saubere, nahtlose Übergänge zwischen den Sektionen.
function segment(mood: Mood, yStart: number, yEnd: number, baseX: number, amp: number): { pts: Pt[]; sharp: boolean } {
  const h = yEnd - yStart;
  if (h <= 1 || mood === "straight" || amp === 0) return { pts: [{ x: baseX, y: yStart }, { x: baseX, y: yEnd }], sharp: false };

  const pts: Pt[] = [];
  const push = (t: number, off: number) => pts.push({ x: baseX + off, y: yStart + h * t });

  if (mood === "zig") {
    // scharfes Dreieck/Zickzack (Diff-Look): Spitzen abwechselnd, eckig
    const teeth = Math.max(3, Math.round(h / 90));
    push(0, 0);
    for (let i = 1; i <= teeth; i++) {
      const t = i / (teeth + 1);
      push(t, (i % 2 === 0 ? -1 : 1) * amp);
    }
    push(1, 0);
    return { pts, sharp: true };
  }

  if (mood === "step") {
    // Treppe (Balken-Anmutung): horizontale + vertikale Kanten, eckig
    const steps = Math.max(3, Math.round(h / 120));
    push(0, 0);
    for (let i = 0; i < steps; i++) {
      const t0 = i / steps, t1 = (i + 1) / steps;
      const off = (i % 2 === 0 ? 1 : -1) * amp;
      pts.push({ x: baseX + off, y: yStart + h * t0 }); // horizontaler Sprung
      pts.push({ x: baseX + off, y: yStart + h * t1 }); // vertikal mit
    }
    push(1, 0);
    return { pts, sharp: true };
  }

  // glatte Formen: viele Stützpunkte, später als Bézier geglättet
  const n = Math.max(10, Math.round(h / 12));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let off = 0;
    if (mood === "wave") off = amp * Math.sin(t * Math.PI * 2 * 1.5);      // ~1,5 Zyklen
    else if (mood === "spring") off = amp * Math.sin(t * Math.PI * 2 * 4); // enge Feder
    else if (mood === "ease") off = amp * Math.sin(t * Math.PI);           // ein sanfter Bogen
    push(t, off);
  }
  return { pts, sharp: false };
}

// Catmull-Rom → kubische Bézier (für die glatten Segmente)
function smooth(pts: Pt[]): string {
  let d = "";
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += `C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} `;
  }
  return d;
}

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

    let len = 0;
    let progress = 0;
    let raf = 0;

    const build = () => {
      const W = root.clientWidth;
      const H = root.scrollHeight;
      if (!W || !H) return;
      // Linke Bahn; Amplitude/Position skalieren mit der Breite (mobil schmal am Rand).
      const narrow = W < 720;
      const baseX = narrow ? 22 : Math.min(132, Math.max(48, W * 0.07));
      const ampBase = narrow ? 12 : Math.min(46, Math.max(20, W * 0.032));

      // Sektionen vertikal vermessen (Mittelpunkte als Ankerpunkte).
      const found = SECTIONS
        .map((s) => ({ ...s, el: root.querySelector<HTMLElement>(s.sel) }))
        .filter((s): s is typeof s & { el: HTMLElement } => !!s.el)
        .map((s) => {
          const r = s.el.getBoundingClientRect();
          const top = r.top + window.scrollY;
          return { ...s, top, mid: top + r.height / 2 };
        });
      if (found.length < 2) return;

      // Pfad zusammensetzen: von Seitenanfang über alle Sektions-Mitten bis zum Ende.
      const anchors = [0, ...found.map((f) => f.mid), H];
      let d = `M ${baseX.toFixed(1)} 0 `;
      for (let i = 0; i < anchors.length - 1; i++) {
        const mood = found[Math.min(i, found.length - 1)].mood;
        const amp = ampBase * found[Math.min(i, found.length - 1)].amp;
        const seg = segment(mood, anchors[i], anchors[i + 1], baseX, amp);
        d += seg.sharp
          ? seg.pts.slice(1).map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + " "
          : smooth(seg.pts);
      }

      // Farbverlauf entlang Y (userSpaceOnUse), Stops an den Sektions-Mitten.
      grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
      grad.setAttribute("x2", "0"); grad.setAttribute("y2", String(H));
      grad.setAttribute("gradientUnits", "userSpaceOnUse");
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

      if (reduced) {
        draw.style.strokeDashoffset = "0"; // statisch komplett sichtbar
        head.style.display = "none";
      } else {
        apply();
      }
    };

    const apply = () => {
      raf = 0;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
      const drawn = len * progress;
      draw.style.strokeDashoffset = String(len - drawn);
      try {
        const p = draw.getPointAtLength(drawn);
        head.setAttribute("cx", p.x.toFixed(1));
        head.setAttribute("cy", p.y.toFixed(1));
        head.style.opacity = progress > 0.002 && progress < 0.999 ? "1" : "0";
      } catch { /* getPointAtLength vor erstem Layout */ }
    };

    const onScroll = () => { if (!reduced && !raf) raf = requestAnimationFrame(apply); };

    // Höhenänderungen (Pin-Sektion, Reveals, Fonts) → Pfad neu vermessen, debounced.
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
