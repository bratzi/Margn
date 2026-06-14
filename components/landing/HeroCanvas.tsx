"use client";

import { useEffect, useRef } from "react";

// Hero-Hintergrund: abstrakte Zeitungsspalten, die langsam nach oben
// strömen — ein Feld aus „Textzeilen" (Wort-Balken). Gelegentlich wird ein
// Wort STILL EDITIERT: kurz rot durchgestrichen, dann in veränderter Breite
// grün neu geschrieben, bevor es sich beruhigt. Das ist exakt das Kernmotiv
// des Observatoriums (Silent Edits) — eigenständig statt generischem
// Partikel-/Netz-Effekt. Normales Alpha-Blending (kein Ausbrennen), zur
// Mitte hin ausgedünnt für lesbare Typo. DPR-gedeckelt, pausiert außerhalb
// des Viewports, reduced-motion-bewusst, Maus enthüllt nahe Zeilen.

type Word = { x: number; w: number; baseW: number; edit: { t0: number; newW: number } | null };
type Line = { y: number; words: Word[]; bold: boolean };
type Col = { x: number; w: number; lines: Line[]; stackH: number; speed: number; scroll: number };

const INK = [150, 160, 185];
const RED = [255, 111, 97];
const GREEN = [67, 217, 163];
const ACC2 = [159, 178, 255];
const EDIT_DUR = 1700;

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
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const rgba = (c: number[], a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

    let W = 0, H = 0;
    const COLN = small ? 2 : 3;
    const ROWH = small ? 24 : 30;
    const PAD = small ? 14 : 40;
    const GUT = small ? 22 : 64;
    const MINW = small ? 12 : 16;
    const MAXW = small ? 46 : 70;

    let cols: Col[] = [];

    const genWords = (colW: number): Word[] => {
      const words: Word[] = [];
      let x = 0;
      const stop = colW * rnd(0.62, 1); // mal volle, mal ragged-rechts Zeile
      while (x < stop) {
        const w = rnd(MINW, MAXW);
        if (x + w > colW) break;
        words.push({ x, w, baseW: w, edit: null });
        x += w + rnd(7, 13);
      }
      return words;
    };

    const build = () => {
      cols = [];
      const colW = (W - 2 * PAD - GUT * (COLN - 1)) / COLN;
      const n = Math.ceil((H + 2 * ROWH) / ROWH) + 1;
      for (let c = 0; c < COLN; c++) {
        const lines: Line[] = [];
        for (let i = 0; i < n; i++) {
          lines.push({ y: i * ROWH, words: genWords(colW), bold: i % 6 === 2 });
        }
        cols.push({
          x: PAD + c * (colW + GUT), w: colW, lines,
          stackH: n * ROWH, speed: rnd(8, 13) * (small ? 0.8 : 1), scroll: 0,
        });
      }
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
      build();
    };

    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // Maus (Desktop): Enthüllung naher Zeilen + leichte Parallaxe
    const mouse = { x: -9999, y: -9999, active: false, px: 0, tx: 0 };
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
      mouse.active = true;
      mouse.tx = (mouse.x / W - 0.5) * 16;
    };
    const onLeave = () => { mouse.active = false; mouse.x = -9999; mouse.y = -9999; mouse.tx = 0; };
    if (!small && !reduced) {
      window.addEventListener("pointermove", onMove, { passive: true });
      host.addEventListener("pointerleave", onLeave);
    }

    // Elliptische Mitten-Maske → Typo bleibt lesbar (0 Mitte … 1 Rand)
    const centerFade = (x: number, y: number) => {
      const nx = (x / W - 0.5) * 2;
      const ny = (y / H - 0.46) * 2.05;
      const d = Math.sqrt(nx * nx * 0.82 + ny * ny);
      return clamp01((d - 0.3) / 0.52);
    };

    // Silent-Edit-Planer: startet gelegentlich eine Wort-Änderung auf einer
    // sichtbaren Zeile (max. wenige gleichzeitig).
    let nextEdit = 0;
    const activeEdits = () => cols.reduce((s, c) => s + c.lines.reduce((a, l) => a + l.words.filter((w) => w.edit).length, 0), 0);
    const scheduleEdit = (now: number) => {
      if (now < nextEdit) return;
      nextEdit = now + rnd(500, 1100);
      if (activeEdits() >= (small ? 2 : 4)) return;
      const col = cols[(Math.random() * cols.length) | 0];
      const onScreen = col.lines.filter((l) => {
        const sy = ((l.y - col.scroll) % col.stackH + col.stackH) % col.stackH;
        return sy > ROWH && sy < H - ROWH;
      });
      if (!onScreen.length) return;
      const line = onScreen[(Math.random() * onScreen.length) | 0];
      const cand = line.words.filter((w) => !w.edit);
      if (!cand.length) return;
      const word = cand[(Math.random() * cand.length) | 0];
      word.edit = { t0: now, newW: rnd(MINW, MAXW) };
    };

    let raf = 0, visible = true, last = performance.now();

    const step = (now: number) => {
      const ds = Math.min(0.05, (now - last) / 1000);
      last = now;
      mouse.px += (mouse.tx - mouse.px) * 0.05;

      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(mouse.px, 0);

      if (!reduced) scheduleEdit(now);

      const mx = mouse.x - mouse.px, my = mouse.y;
      const REV = small ? 120 : 170, REV2 = REV * REV;

      for (const col of cols) {
        if (!reduced) col.scroll += col.speed * ds;
        for (const line of col.lines) {
          let sy = ((line.y - col.scroll) % col.stackH + col.stackH) % col.stackH - ROWH;
          if (sy < -ROWH || sy > H + ROWH) continue;
          const h = line.bold ? 3.6 : 2.6;
          const yMid = sy + ROWH / 2;

          for (const word of line.words) {
            let w = word.w, col3 = INK, boost = 0, strikeX = 0, strikeA = 0;

            if (word.edit) {
              const p = (now - word.edit.t0) / EDIT_DUR;
              if (p >= 1) {
                word.w = word.baseW = word.edit.newW;
                word.edit = null;
                w = word.w;
              } else {
                // Breite morpht in der mittleren Phase
                w = p < 0.3 ? word.baseW : p < 0.62 ? lerp(word.baseW, word.edit.newW, (p - 0.3) / 0.32) : word.edit.newW;
                // Farbe: ink → grün → ink
                col3 = p < 0.3 ? INK : p < 0.62 ? GREEN.map((g, i) => lerp(INK[i], g, (p - 0.3) / 0.32)) : GREEN.map((g, i) => lerp(g, INK[i], (p - 0.62) / 0.38));
                boost = Math.sin(clamp01(p) * Math.PI) * 0.42;
                // Durchstreichung wächst zuerst, blendet dann aus
                strikeX = word.baseW * clamp01(p / 0.26);
                strikeA = (1 - clamp01((p - 0.28) / 0.22)) * 0.85;
              }
            }

            const cx = col.x + word.x;
            const fade = centerFade(cx + w / 2, yMid);
            if (fade <= 0.002) continue;
            let a = (line.bold ? 0.26 : 0.2) * fade + boost * fade;

            // Maus-Enthüllung
            if (mouse.active) {
              const dx = cx + w / 2 - mx, dy = yMid - my;
              const d2 = dx * dx + dy * dy;
              if (d2 < REV2) {
                const close = 1 - Math.sqrt(d2) / REV;
                a += close * close * 0.5 * fade;
                col3 = col3.map((v, i) => lerp(v, ACC2[i], close * 0.55));
              }
            }

            ctx.fillStyle = rgba(col3, a);
            ctx.fillRect(cx, yMid - h / 2, w, h);

            if (strikeA > 0.01) {
              ctx.fillStyle = rgba(RED, strikeA * fade);
              ctx.fillRect(cx, yMid - 0.9, strikeX, 1.8);
            }
          }
        }
      }

      ctx.restore();
    };

    const loop = (now: number) => { step(now); raf = requestAnimationFrame(loop); };

    if (reduced) {
      last = performance.now();
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
