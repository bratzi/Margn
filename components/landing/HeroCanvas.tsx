"use client";

import { useEffect, useRef } from "react";

// Hero-Hintergrund: ein abstraktes Strömungsfeld (curl-artiges Flow-Field).
// Hunderte haarfeine Partikel folgen einem unsichtbaren, langsam
// verformenden Vektorfeld und hinterlassen kurze, weiche Spuren. Der Cursor
// ist eine Kraft: er erzeugt einen Wirbel/Sog, um den sich die Strömung
// biegt. Bewusst monochrom, niedrige Deckkraft, KEIN additives Ausbrennen
// (jeder Frame wird sauber gelöscht — Spuren entstehen nur aus dem
// Bewegungssegment), zur Mitte hin ausgedünnt für lesbare Typo.
// DPR-gedeckelt, pausiert außerhalb des Viewports, reduced-motion-bewusst.

type P = { x: number; y: number; px: number; py: number; spd: number; life: number; max: number; tone: number; a: number };

const A1 = [110, 138, 255]; // #6e8aff
const A2 = [159, 178, 255]; // #9fb2ff

export default function HeroCanvas() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    host.appendChild(canvas);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = window.matchMedia("(max-width: 768px)").matches;

    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

    let W = 0, H = 0;
    const COUNT = small ? 230 : 600;
    let ps: P[] = [];
    let t = Math.random() * 1000;

    const spawn = (p: P, fresh = false) => {
      p.x = Math.random() * W;
      p.y = Math.random() * H;
      p.px = p.x; p.py = p.y;
      p.spd = rnd(0.5, 1.5);
      p.max = rnd(60, 230);
      p.life = fresh ? Math.random() * p.max : 0;
      p.tone = Math.random();
      p.a = rnd(0.06, 0.2);
    };

    const build = () => {
      ps = Array.from({ length: COUNT }, () => {
        const p = {} as P; spawn(p, true); return p;
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
      if (!ps.length) build();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    build();

    // Strömungsrichtung an (x,y,t) — billiges, organisches Pseudo-Feld aus
    // überlagerten Sinuswellen (Domain-Warping). Gibt einen Winkel zurück.
    const flow = (x: number, y: number) => {
      const s = 0.0016;
      let a = Math.sin(x * s + t * 0.20) + Math.sin(y * s * 1.2 - t * 0.16) + Math.sin((x + y) * s * 0.7 + t * 0.22);
      a += 0.5 * Math.sin(x * s * 2.4 - y * s * 1.7 + t * 0.12);
      return a * 1.4;
    };

    // Maus als Kraft (Wirbel + leichter Sog)
    const mouse = { x: -9999, y: -9999, active: false };
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.active = true;
    };
    const onLeave = () => { mouse.active = false; mouse.x = -9999; mouse.y = -9999; };
    if (!small && !reduced) {
      window.addEventListener("pointermove", onMove, { passive: true });
      host.addEventListener("pointerleave", onLeave);
    }

    // Elliptische Mitten-Maske → Typo bleibt lesbar (0 Mitte … 1 Rand)
    const centerFade = (x: number, y: number) => {
      const nx = (x / W - 0.5) * 2;
      const ny = (y / H - 0.46) * 2.05;
      const d = Math.sqrt(nx * nx * 0.82 + ny * ny);
      return clamp01((d - 0.26) / 0.5);
    };

    let raf = 0, visible = true, last = performance.now();
    const MR = small ? 150 : 230, MR2 = MR * MR;

    const drawParticle = (p: P, dt: number) => {
      p.px = p.x; p.py = p.y;
      const ang = flow(p.x, p.y);
      let vx = Math.cos(ang) * p.spd, vy = Math.sin(ang) * p.spd;

      let near = 0;
      if (mouse.active) {
        const dx = p.x - mouse.x, dy = p.y - mouse.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < MR2) {
          const d = Math.sqrt(d2) + 0.001;
          const f = 1 - d / MR;
          near = f;
          // Wirbel (tangential) + leichter Sog nach außen
          vx += (-dy / d) * f * 3.0 + (dx / d) * f * 0.7;
          vy += (dx / d) * f * 3.0 + (dy / d) * f * 0.7;
        }
      }

      p.x += vx * dt; p.y += vy * dt;
      p.life += dt;

      // Respawn bei Lebensende oder außerhalb (mit Rand)
      if (p.life > p.max || p.x < -30 || p.x > W + 30 || p.y < -30 || p.y > H + 30) {
        spawn(p);
        return;
      }

      const fade = centerFade(p.x, p.y);
      if (fade <= 0.002) return;
      // weiches Ein-/Ausblenden über die Lebensdauer
      const lifeFade = Math.sin(clamp01(p.life / p.max) * Math.PI);
      const c = p.tone < 0.5 ? A1 : A2;
      const alpha = (p.a + near * 0.4) * fade * lifeFade;
      if (alpha < 0.004) return;

      ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
      ctx.lineWidth = near > 0.4 ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(p.px, p.py);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    };

    const step = (now: number) => {
      const dt = Math.min(2.4, (now - last) / 16.67);
      last = now;
      if (!reduced) t += dt * 0.016;

      ctx.clearRect(0, 0, W, H);
      ctx.lineCap = "round";
      for (const p of ps) drawParticle(p, dt);
    };

    const loop = (now: number) => { step(now); raf = requestAnimationFrame(loop); };

    if (reduced) {
      // statisches Feld: einen kurzen Schritt zeichnen
      last = performance.now();
      for (const p of ps) { p.life = p.max * 0.5; }
      step(last + 16);
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
