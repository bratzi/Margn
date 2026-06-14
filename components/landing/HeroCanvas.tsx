"use client";

import { useEffect, useRef } from "react";

// Hero-Hintergrund: ein ruhiges „Story-Constellation"-Netz — driftende
// Datenknoten, die sich zu Clustern verbinden, wenn sie nah beieinander
// liegen. Metapher: das sprachübergreifende Zusammenführen derselben
// Geschichte. Bewusst zurückhaltend — NORMALES Alpha-Blending (kein
// additives „Ausbrennen"), niedrige Deckkraft, zur Mitte hin ausgedünnt,
// damit die Typografie lesbar bleibt. DPR-gedeckelt, pausiert außerhalb des
// Viewports, reduced-motion-bewusst. Maus erzeugt einen sanften Fokus
// (nahe Knoten leuchten auf + verbinden sich zum Cursor) und eine leichte
// Parallaxe der gesamten Ebene.

type Node = {
  x: number; y: number; vx: number; vy: number;
  r: number; a: number; hub: boolean; phase: number;
};

export default function HeroCanvas() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // kein 2D-Context — CSS-Hintergrund übernimmt
    host.appendChild(canvas);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = window.matchMedia("(max-width: 768px)").matches;

    // Palette, abgestimmt auf die Landing-Variablen (#6e8aff / #9fb2ff).
    const ACCENT = [110, 138, 255];
    const ACCENT2 = [159, 178, 255];
    const rgba = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

    let W = 0, H = 0; // CSS-Pixel
    const LINK = small ? 104 : 134; // Verbindungsdistanz
    const LINK2 = LINK * LINK;
    const COUNT = small ? 66 : 150;

    let nodes: Node[] = [];
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);

    const build = () => {
      nodes = Array.from({ length: COUNT }, () => {
        const hub = Math.random() < 0.09;
        return {
          x: Math.random() * W,
          y: Math.random() * H,
          vx: rnd(-1, 1) * 0.15,
          vy: rnd(-1, 1) * 0.15,
          r: hub ? rnd(2.2, 3.2) : rnd(0.8, 1.9),
          a: hub ? rnd(0.8, 1) : rnd(0.32, 0.7),
          hub,
          phase: Math.random() * Math.PI * 2,
        };
      });
    };

    const resize = () => {
      W = host.clientWidth || 1;
      H = host.clientHeight || 1;
      const dpr = Math.min(small ? 1.5 : 2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!nodes.length) build();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    build();

    // Maus (nur Desktop): sanfter Fokus + Parallaxe.
    const mouse = { x: -9999, y: -9999, active: false, px: 0, py: 0, tx: 0, ty: 0 };
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
      mouse.active = true;
      mouse.tx = (mouse.x / W - 0.5) * 18;
      mouse.ty = (mouse.y / H - 0.5) * 14;
    };
    const onLeave = () => { mouse.active = false; mouse.x = -9999; mouse.y = -9999; mouse.tx = 0; mouse.ty = 0; };
    if (!small && !reduced) {
      window.addEventListener("pointermove", onMove, { passive: true });
      host.addEventListener("pointerleave", onLeave);
    }

    // Zentrums-Maske: elliptisch zur Mitte (Typo) hin ausdünnen → Text lesbar.
    // 0 in der Mitte, 1 am Rand.
    const centerFade = (x: number, y: number) => {
      const nx = (x / W - 0.5) * 2;
      const ny = (y / H - 0.46) * 2.05;
      const d = Math.sqrt(nx * nx * 0.82 + ny * ny);
      return Math.min(1, Math.max(0, (d - 0.3) / 0.52));
    };

    let raf = 0;
    let visible = true;
    let last = performance.now();

    const step = (now: number) => {
      const dt = Math.min(2.4, (now - last) / 16.67);
      last = now;

      // Parallaxe sanft nachführen
      mouse.px += (mouse.tx - mouse.px) * 0.045;
      mouse.py += (mouse.ty - mouse.py) * 0.045;

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(mouse.px, mouse.py);

      // Bewegung + sanftes Wrappen
      for (const n of nodes) {
        n.x += n.vx * dt;
        n.y += n.vy * dt;
        if (n.x < -24) n.x = W + 24; else if (n.x > W + 24) n.x = -24;
        if (n.y < -24) n.y = H + 24; else if (n.y > H + 24) n.y = -24;
      }

      // Verbindungen (O(n²), bei ~150 Knoten unkritisch)
      ctx.lineWidth = 1;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const fa = centerFade(a.x, a.y);
        if (fa <= 0.001) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK2) continue;
          const fb = centerFade(b.x, b.y);
          const close = 1 - Math.sqrt(d2) / LINK;
          const alpha = close * close * 0.15 * Math.min(fa, fb);
          if (alpha < 0.004) continue;
          ctx.strokeStyle = rgba(ACCENT, alpha);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      // Maus-Fokus: Linien Cursor → nahe Knoten + leichte Anziehung
      if (mouse.active) {
        const mx = mouse.x - mouse.px, my = mouse.y - mouse.py;
        const MR = small ? 150 : 205, MR2 = MR * MR;
        for (const n of nodes) {
          const dx = n.x - mx, dy = n.y - my;
          const d2 = dx * dx + dy * dy;
          if (d2 > MR2) continue;
          const dist = Math.sqrt(d2) + 0.0001;
          const close = 1 - dist / MR;
          const alpha = close * close * 0.38 * centerFade(n.x, n.y);
          if (alpha >= 0.004) {
            ctx.strokeStyle = rgba(ACCENT2, alpha);
            ctx.beginPath();
            ctx.moveTo(mx, my);
            ctx.lineTo(n.x, n.y);
            ctx.stroke();
          }
          n.vx += (-dx / dist) * 0.0022 * close * dt;
          n.vy += (-dy / dist) * 0.0022 * close * dt;
        }
      }

      // Geschwindigkeit dämpfen + Mindest-Drift erhalten
      for (const n of nodes) {
        n.vx *= 0.99; n.vy *= 0.99;
        if (Math.hypot(n.vx, n.vy) < 0.05) {
          n.vx += rnd(-1, 1) * 0.012;
          n.vy += rnd(-1, 1) * 0.012;
        }
      }

      // Knoten zeichnen (Hubs pulsieren dezent)
      const t = now * 0.001;
      for (const n of nodes) {
        const f = centerFade(n.x, n.y);
        if (f <= 0.001) continue;
        const pulse = n.hub ? 0.78 + 0.22 * Math.sin(t + n.phase) : 1;
        ctx.fillStyle = rgba(n.hub ? ACCENT2 : ACCENT, n.a * 0.52 * f * pulse);
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
        if (n.hub) {
          ctx.fillStyle = rgba(ACCENT2, n.a * 0.12 * f * pulse);
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r * 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.restore();
    };

    const loop = (now: number) => {
      step(now);
      raf = requestAnimationFrame(loop);
    };

    if (reduced) {
      last = performance.now();
      step(last + 16); // ein statisches Bild genügt
    } else {
      const io = new IntersectionObserver(([e]) => {
        const was = visible;
        visible = e.isIntersecting;
        if (visible && !was) { last = performance.now(); raf = requestAnimationFrame(loop); }
        if (!visible) cancelAnimationFrame(raf);
      });
      io.observe(host);
      last = performance.now();
      raf = requestAnimationFrame(loop);
      const onVis = () => {
        cancelAnimationFrame(raf);
        if (!document.hidden && visible) { last = performance.now(); raf = requestAnimationFrame(loop); }
      };
      document.addEventListener("visibilitychange", onVis);

      return () => {
        cancelAnimationFrame(raf);
        io.disconnect();
        document.removeEventListener("visibilitychange", onVis);
        window.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerleave", onLeave);
        ro.disconnect();
        if (canvas.parentNode) host.removeChild(canvas);
      };
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      ro.disconnect();
      if (canvas.parentNode) host.removeChild(canvas);
    };
  }, []);

  return <div ref={ref} className="mg-hero-canvas" aria-hidden />;
}
