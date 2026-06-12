"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Live-Kennzahlen für die Landingpage — echte Daten als Vertrauenssignal.
type Stats = { articles: number; sources: number; edits: number; topics: number };

function useCountUp(target: number, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!target) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      setV(Math.round(target * (1 - Math.pow(1 - p, 3)))); // ease-out cubic
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function Num({ value, label, sub }: { value: number; label: string; sub?: string }) {
  const v = useCountUp(value);
  return (
    <div className="ld-stat">
      <span className="ld-stat-v">{v.toLocaleString("de-DE")}</span>
      <span className="ld-stat-l">{label}</span>
      {sub && <span className="ld-stat-s">{sub}</span>}
    </div>
  );
}

export default function LandingStats() {
  const [s, setS] = useState<Stats | null>(null);

  useEffect(() => {
    Promise.all([
      supabase.from("articles").select("id", { count: "exact", head: true }),
      supabase.from("sources").select("id", { count: "exact", head: true }).eq("active", true),
      supabase.from("articles").select("id", { count: "exact", head: true }).gte("revision_count", 1),
    ]).then(([a, src, ed]) => {
      setS({ articles: a.count ?? 0, sources: src.count ?? 0, edits: ed.count ?? 0, topics: 12 });
    });
  }, []);

  if (!s) return <div className="ld-stats ld-stats-skeleton" aria-hidden />;
  return (
    <div className="ld-stats">
      <Num value={s.articles} label="Artikel beobachtet" sub="versioniert & ausgewertet" />
      <Num value={s.sources} label="Nachrichtenquellen" sub="DE & FR, stündlich" />
      <Num value={s.edits} label="stille Änderungen" sub="nachträglich erfasst" />
      <Num value={s.topics} label="Themenfelder" sub="publizistenübergreifend" />
    </div>
  );
}
