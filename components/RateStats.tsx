"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type R = { source_id: number; last_24h: number; last_7d: number };
type Src = { id: number; name: string };

const short = (n: string) => n.replace(" Online", "");

export default function RateStats({ sources, activeSources }: { sources: Src[]; activeSources: number[] }) {
  const [rows, setRows] = useState<R[]>([]);
  const [mode, setMode] = useState<"hour" | "day">("hour");
  useEffect(() => { supabase.from("rate_stats").select("*").then(({ data }) => setRows((data as R[]) ?? [])); }, []);

  const act = useMemo(() => new Set(activeSources), [activeSources]);
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, short(s.name)])), [sources]);

  const data = useMemo(() => rows.filter((r) => act.has(r.source_id)).map((r) => ({
    label: nameById.get(r.source_id) ?? "?",
    value: mode === "hour" ? r.last_24h / 24 : r.last_7d / 7,
  })).sort((a, b) => b.value - a.value), [rows, act, mode, nameById]);

  const tot = useMemo(() => rows.filter((r) => act.has(r.source_id)).reduce((s, r) => s + (mode === "hour" ? r.last_24h / 24 : r.last_7d / 7), 0), [rows, act, mode]);

  if (!rows.length) return null;
  const max = Math.max(0.1, ...data.map((d) => d.value));
  const unit = mode === "hour" ? "Artikel / Stunde" : "Artikel / Tag";

  return (
    <>
      <h2 className="section-h" style={{ alignItems: "center" }}>
        Publishing-Rate <span className="count">Ø {tot.toFixed(mode === "hour" ? 1 : 0)} {unit} gesamt</span>
        <div className="seg" style={{ marginLeft: "auto" }}>
          <button className={mode === "hour" ? "on" : ""} onClick={() => setMode("hour")}>Pro Stunde</button>
          <button className={mode === "day" ? "on" : ""} onClick={() => setMode("day")}>Pro Tag</button>
        </div>
      </h2>
      <div className="panel pad">
        <div className="bars">
          {data.map((d) => (
            <div className="barrow" key={d.label}>
              <span className="lbl">{d.label}</span>
              <span className="track"><i style={{ width: `${(d.value / max) * 100}%`, background: "var(--accent)" }} /></span>
              <span className="val tnum">{d.value.toFixed(mode === "hour" ? 2 : 1)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
