"use client";

import { useEffect, useRef } from "react";

// Hero-Hintergrund: „Reveal". Unter einem fast schwarzen Schleier liegt ein
// verborgenes Feld aus Schlagzeilen-Zeilen, in denen Wörter STILL editiert
// werden (rot gestrichen → grün ersetzt). Eine Linse — am Cursor und eine
// zweite, die automatisch über die Fläche wandert — löscht den Schleier
// lokal weg und enthüllt, was darunter „heimlich geändert" wurde. Genau das
// Versprechen des Observatoriums, als dramatische, interaktive Geste.
// Compositing via destination-out auf einem separaten Schleier-Layer; das
// Hero-Feld bleibt darunter intakt. DPR-gedeckelt, pausiert außer Sicht,
// reduced-motion-bewusst.

type Word = { x: number; w: number; baseW: number; edit: { t0: number; newW: number } | null };
type Row = { y: number; words: Word[]; bold: boolean };

const INK = [150, 160, 185];
const RED = [255, 111, 97];
const GREEN = [67, 217, 163];
const A2 = [159, 178, 255];
const EDIT_DUR = 1700;

export default function HeroCanvas() {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const veil = document.createElement("canvas");
    const vctx = veil.getContext("2d");
    if (!ctx || !vctx) return;
    host.appendChild(canvas);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = window.matchMedia("(max-width: 768px)").matches;

    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const rgba = (c: number[], a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

    let W = 0, H = 0, dpr = 1;
    const ROWH = small ? 26 : 30;
    const MINW = small ? 18 : 26;
    const MAXW = small ? 60 : 92;
    const LENS = small ? 132 : 208;

    let rows: Row[] = [];

    const genWords = (): Word[] => {
      const words: Word[] = [];
      let x = rnd(-20, 10);
      const stop = W * rnd(0.7, 1.0);
      while (x < stop) {
        const w = rnd(MINW, MAXW);
        words.push({ x, w, baseW: w, edit: null });
        x += w + rnd(10, 20);
      }
      return words;
    };

    const build = () => {
      rows = [];
      const n = Math.ceil(H / ROWH) + 1;
      for (let i = 0; i < n; i++) rows.push({ y: i * ROWH + ROWH * 0.5, words: genWords(), bold: i % 5 === 2 });
    };

    const resize = () => {
      W = host.clientWidth || 1;
      H = host.clientHeight || 1;
      dpr = Math.min(small ? 1.3 : 1.5, window.devicePixelRatio || 1);
      for (const cv of [canvas, veil]) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      build();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    const mouse = { x: -9999, y: -9999, active: false };
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.active = true;
    };
    const onLeave = () => { mouse.active = false; };
    if (!small && !reduced) {
      window.addEventListener("pointermove", onMove, { passive: true });
      host.addEventListener("pointerleave", onLeave);
    }

    // hinter der Headline (Mitte) etwas abdunkeln, damit Typo lesbar bleibt
    const centerFade = (x: number, y: number) => {
      const nx = (x / W - 0.5) * 2;
      const ny = (y / H - 0.46) * 2.05;
      const d = Math.sqrt(nx * nx * 0.82 + ny * ny);
      return clamp01((d - 0.18) / 0.5);
    };

    // Silent-Edit-Planer
    let nextEdit = 0;
    const scheduleEdit = (now: number) => {
      if (now < nextEdit) return;
      nextEdit = now + rnd(280, 620);
      const active = rows.reduce((s, r) => s + r.words.filter((w) => w.edit).length, 0);
      if (active >= (small ? 5 : 10)) return;
      const row = rows[(Math.random() * rows.length) | 0];
      const cand = row.words.filter((w) => !w.edit);
      if (!cand.length) return;
      const word = cand[(Math.random() * cand.length) | 0];
      word.edit = { t0: now, newW: rnd(MINW, MAXW) };
    };

    let raf = 0, visible = true, last = performance.now(), tt = 0;

    const drawField = (now: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      for (const row of rows) {
        const h = row.bold ? 3.4 : 2.4;
        const yMid = row.y;
        if (yMid < -ROWH || yMid > H + ROWH) continue;
        for (const word of row.words) {
          let w = word.w, col = INK, boost = 0, strikeX = 0, strikeA = 0;
          if (word.edit) {
            const p = (now - word.edit.t0) / EDIT_DUR;
            if (p >= 1) { word.w = word.baseW = word.edit.newW; word.edit = null; w = word.w; }
            else {
              w = p < 0.3 ? word.baseW : p < 0.62 ? lerp(word.baseW, word.edit.newW, (p - 0.3) / 0.32) : word.edit.newW;
              col = p < 0.3 ? INK : p < 0.62 ? GREEN.map((g, i) => lerp(INK[i], g, (p - 0.3) / 0.32)) : GREEN.map((g, i) => lerp(g, INK[i], (p - 0.62) / 0.38));
              boost = Math.sin(clamp01(p) * Math.PI) * 0.5;
              strikeX = word.baseW * clamp01(p / 0.26);
              strikeA = (1 - clamp01((p - 0.28) / 0.22)) * 0.9;
            }
          }
          const fade = centerFade(word.x + w / 2, yMid);
          if (fade <= 0.002) continue;
          const a = ((row.bold ? 0.7 : 0.52) + boost) * fade;
          ctx.fillStyle = rgba(col, a);
          ctx.fillRect(word.x, yMid - h / 2, w, h);
          if (strikeA > 0.01) {
            ctx.fillStyle = rgba(RED, strikeA * fade);
            ctx.fillRect(word.x, yMid - 1, strikeX, 2);
          }
        }
      }
    };

    const punch = (x: number, y: number, r: number, strength: number) => {
      const g = vctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(0.62, `rgba(0,0,0,${strength * 0.5})`);
      g.addColorStop(1, "rgba(0,0,0,0)");
      vctx.fillStyle = g;
      vctx.beginPath();
      vctx.arc(x, y, r, 0, Math.PI * 2);
      vctx.fill();
    };

    const ring = (x: number, y: number, r: number, a: number) => {
      ctx.strokeStyle = rgba(A2, a);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = rgba(A2, a * 0.4);
      ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, Math.PI * 2); ctx.stroke();
    };

    const frame = (now: number) => {
      const dt = Math.min(2.4, (now - last) / 16.67);
      last = now;
      if (!reduced) { tt += dt * 0.016; scheduleEdit(now); }

      // 1) verborgenes Feld
      drawField(now);

      // 2) Schleier mit „Löchern" (Linsen) aufbauen
      vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      vctx.globalCompositeOperation = "source-over";
      vctx.clearRect(0, 0, W, H);
      vctx.fillStyle = "rgba(10,11,15,0.93)";
      vctx.fillRect(0, 0, W, H);
      vctx.globalCompositeOperation = "destination-out";

      // automatisch wandernde Linse (Lissajous) — Drama auch ohne Maus
      const ax = W * (0.5 + 0.34 * Math.sin(tt * 0.13));
      const ay = H * (0.5 + 0.28 * Math.sin(tt * 0.19 + 1.3));
      punch(ax, ay, LENS * (mouse.active ? 0.78 : 1), 1);

      // Cursor-Linse
      if (mouse.active) punch(mouse.x, mouse.y, LENS, 1);
      vctx.globalCompositeOperation = "source-over";

      // 3) Schleier über das Feld legen (1:1 in Geräte-Pixeln)
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(veil, 0, 0);

      // 4) Akzent-Ringe um die Linsen
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ring(ax, ay, LENS * (mouse.active ? 0.78 : 1), mouse.active ? 0.1 : 0.16);
      if (mouse.active) ring(mouse.x, mouse.y, LENS, 0.2);
    };

    // Auf ~30 fps drosseln — der Reveal braucht keine 60 fps, halbiert die
    // teuren Veil-Blits und das drawImage pro Frame.
    const FRAME_MS = 33;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      frame(now);
    };

    if (reduced) {
      last = performance.now();
      frame(last + 16);
    } else {
      const io = new IntersectionObserver(([e]) => {
        const was = visible; visible = e.isIntersecting;
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
