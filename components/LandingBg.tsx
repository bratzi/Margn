"use client";

import { useEffect, useRef } from "react";

// Dezenter animierter Hintergrund für die Landing-Sektionen. Thematisch: ein driftendes
// „Signal-/Datennetz" (Punkte + Verbindungslinien) bzw. ruhig fließende Farbnebel.
// Performant (requestAnimationFrame, DPR-bewusst, pausiert wenn unsichtbar), respektiert
// prefers-reduced-motion. Liegt absolut hinter dem Sektions-Inhalt, sehr niedrige Deckkraft.
type Variant = "network" | "flow";

export default function LandingBg({ variant = "network" }: { variant?: Variant }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3D63DD";
    const rgb = hexToRgb(accent);
    let raf = 0, w = 0, h = 0, dpr = Math.min(2, window.devicePixelRatio || 1);
    let visible = true;

    const parent = canvas.parentElement!;
    const resize = () => {
      w = parent.clientWidth; h = parent.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    type P = { x: number; y: number; vx: number; vy: number; r: number };
    let pts: P[] = [];
    const seed = () => {
      const n = variant === "network" ? Math.min(64, Math.round((w * h) / 16000)) : Math.min(7, Math.round(w / 220));
      pts = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * (variant === "network" ? 0.22 : 0.12),
        vy: (Math.random() - 0.5) * (variant === "network" ? 0.22 : 0.12),
        r: variant === "network" ? 1.4 + Math.random() * 1.6 : 120 + Math.random() * 160,
      }));
    };

    const drawNetwork = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
      }
      // Verbindungslinien (nur nahe Punkte)
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i], b = pts[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 140 * 140) {
            const o = (1 - Math.sqrt(d2) / 140) * 0.16;
            ctx.strokeStyle = `rgba(${rgb},${o.toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      // Knoten
      for (const p of pts) {
        ctx.fillStyle = `rgba(${rgb},0.32)`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
    };

    const drawFlow = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of pts) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -p.r) p.x = w + p.r; if (p.x > w + p.r) p.x = -p.r;
        if (p.y < -p.r) p.y = h + p.r; if (p.y > h + p.r) p.y = -p.r;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
        g.addColorStop(0, `rgba(${rgb},0.10)`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      }
    };

    const tick = () => {
      if (visible) (variant === "network" ? drawNetwork : drawFlow)();
      raf = requestAnimationFrame(tick);
    };

    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: 0 });
    io.observe(parent);
    const ro = new ResizeObserver(resize);
    ro.observe(parent);
    resize();
    raf = requestAnimationFrame(tick);

    return () => { cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); };
  }, [variant]);

  return <canvas ref={ref} className="ld-bg" aria-hidden />;
}

function hexToRgb(hex: string): string {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
