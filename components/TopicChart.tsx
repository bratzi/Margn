"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";

export default function TopicChart() {
  const f = useFilters();
  const [rows, setRows] = useState<{ topic: string; n: number }[]>([]);

  // Gefilterte Themen-Verteilung (Quellen + Paywall + Autor + Sprache + Zeitraum)
  useEffect(() => {
    if (!f.activeArr.length) { setRows([]); return; }
    const nn = (v: string) => (v === "all" ? null : v);
    supabase.rpc("topic_opts_f", { p_sources: f.activeArr, p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang), p_from: f.rangeFrom, p_to: f.rangeTo })
      .then(({ data }) => setRows((data ?? []).filter((r: any) => r.topic !== "sonstiges")));
  }, [f.activeArr.join(","), f.paywall, f.author, f.lang, f.rangeFrom, f.rangeTo]);

  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...sorted.map((r) => r.n));

  return (
    <>
      <h2 className="section-h">Themen <span className="count">publizistenübergreifend · klick zum Filtern</span></h2>
      <div className="panel pad">
        <div className="bars">
          {sorted.map((r) => (
            <button key={r.topic} className={`barrow barrow-btn ${f.topic === r.topic ? "sel" : ""}`} onClick={() => f.setTopic(f.topic === r.topic ? "all" : r.topic)} title="Nach Thema filtern">
              <span className="lbl">{topicLabel(r.topic)}</span>
              <span className="track"><i style={{ width: `${(r.n / max) * 100}%`, background: f.topic === r.topic ? "var(--accent)" : "var(--teal)" }} /></span>
              <span className="val tnum">{r.n.toLocaleString("de-DE")}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
