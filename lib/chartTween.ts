"use client";

import { useEffect, useRef, useState } from "react";

// Weiche Chart-Übergänge: Werte werden per rAF von der zuletzt GEZEIGTEN Sicht zur
// neuen Ziel-Sicht interpoliert (Morphing statt hartem Sprung). Struktursprünge
// (andere Reihen-Keys oder Bucket-Anzahl) springen sofort — dort übernimmt der
// CSS-Crossfade (.chart-swap) des Aufrufers. prefers-reduced-motion schaltet alles ab.

const EASE = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic

const reduceMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type WithVals = { key?: string; id?: string; vals: number[] };
const keyOf = (s: WithVals) => s.key ?? s.id ?? "";

export function useTweenedSeries<T extends WithVals>(target: T[], dur = 480): T[] {
  const shown = useRef<Map<string, number[]>>(new Map());
  const raf = useRef(0);
  const [, force] = useState(0);

  // Struktur (Keys + Längen) getrennt von den Werten signieren: Wertänderung → Tween,
  // Strukturänderung → sofortiger Sprung (der Aufrufer remountet mit .chart-swap).
  const structSig = target.map((s) => `${keyOf(s)}:${s.vals.length}`).join("|");
  const valsSig = target.map((s) => s.vals.join(",")).join(";");

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    const structural =
      shown.current.size !== target.length ||
      target.some((s) => shown.current.get(keyOf(s))?.length !== s.vals.length);
    if (structural || reduceMotion()) {
      shown.current = new Map(target.map((s) => [keyOf(s), s.vals]));
      force((x) => x + 1);
      return;
    }
    const from = new Map([...shown.current].map(([k, v]) => [k, [...v]]));
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = EASE(t);
      shown.current = new Map(
        target.map((s) => {
          const f = from.get(keyOf(s))!;
          return [keyOf(s), s.vals.map((v, i) => f[i] + (v - f[i]) * e)];
        }),
      );
      force((x) => x + 1);
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structSig, valsSig, dur]);

  return target.map((s) => ({ ...s, vals: shown.current.get(keyOf(s)) ?? s.vals }));
}

// Einzelwert-Tween (Count-up): zählt weich von der zuletzt gezeigten Zahl zur neuen.
export function useTweenedNumber(target: number, dur = 480): number {
  const shown = useRef(target);
  const raf = useRef(0);
  const [, force] = useState(0);

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (reduceMotion() || !Number.isFinite(shown.current)) {
      shown.current = target;
      force((x) => x + 1);
      return;
    }
    const from = shown.current;
    if (from === target) return;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      shown.current = from + (target - from) * EASE(t);
      force((x) => x + 1);
      if (t < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, dur]);

  return shown.current;
}
