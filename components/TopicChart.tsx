"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { topicLabel } from "@/lib/topics";

type TS = { topic: string; source_id: number; n: number };

export default function TopicChart({ activeSources, onPick, current }: { activeSources: number[]; onPick?: (t: string) => void; current?: string }) {
  const [rows, setRows] = useState<TS[]>([]);
  useEffect(() => { supabase.from("topic_stats").select("*").then(({ data }) => setRows((data as TS[]) ?? [])); }, []);

  const act = useMemo(() => new Set(activeSources), [activeSources]);
  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) if (act.has(r.source_id)) m.set(r.topic, (m.get(r.topic) ?? 0) + r.n);
    return [...m.entries()].filter(([t]) => t !== "sonstiges").sort((a, b) => b[1] - a[1]);
  }, [rows, act]);

  if (!totals.length) return null;
  const max = Math.max(1, ...totals.map(([, n]) => n));

  return (
    <>
      <h2 className="section-h">Themen <span className="count">publizistenübergreifend · klick zum Filtern</span></h2>
      <div className="panel pad">
        <div className="bars">
          {totals.map(([t, n]) => (
            <button key={t} className={`barrow barrow-btn ${current === t ? "sel" : ""}`} onClick={() => onPick?.(current === t ? "all" : t)} title="Nach Thema filtern">
              <span className="lbl">{topicLabel(t)}</span>
              <span className="track"><i style={{ width: `${(n / max) * 100}%`, background: current === t ? "var(--accent)" : "var(--teal)" }} /></span>
              <span className="val tnum">{n.toLocaleString("de-DE")}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
