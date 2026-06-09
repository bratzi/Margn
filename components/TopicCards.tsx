"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";
import { topicLabel } from "@/lib/topics";

type K = { topic: string; articles: number; paywalled: number; au_named: number; au_total: number; new_7d: number; outlets: number };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export default function TopicCards() {
  const f = useFilters();
  const [rows, setRows] = useState<K[]>([]);

  useEffect(() => {
    if (!f.activeArr.length) { setRows([]); return; }
    const nn = (v: string) => (v === "all" ? null : v);
    supabase.rpc("topic_kpis_f", { p_sources: f.activeArr, p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang), p_from: f.rangeFrom, p_to: f.rangeTo })
      .then(({ data }) => setRows(((data as K[]) ?? []).filter((r) => r.topic !== "sonstiges")));
  }, [f.activeArr.join(","), f.paywall, f.author, f.lang, f.rangeFrom, f.rangeTo]);

  if (!rows.length) return null;

  return (
    <>
      <h2 className="section-h">Themen-Kennzahlen <span className="count">↔ scrollen · klick zum Filtern</span></h2>
      <div className="topic-cards">
        {rows.map((r) => {
          const pw = pct(r.paywalled, r.articles), nm = pct(r.au_named, r.au_total);
          const on = f.topic === r.topic;
          return (
            <button key={r.topic} className={`tcard ${on ? "on" : ""}`} onClick={() => f.setTopic(on ? "all" : r.topic)}>
              <div className="tc-head"><span className="tc-name">{topicLabel(r.topic)}</span><span className="tc-art tnum">{r.articles.toLocaleString("de-DE")}</span></div>
              <div className="tc-sub">{r.new_7d} neu (7T) · {r.outlets} Quellen</div>
              <div className="tc-metrics">
                <div className="tc-m"><span className="tc-ml">Paywall</span><span className="tc-mv" style={{ color: pw > 40 ? "var(--red)" : "var(--ink)" }}>{pw}%</span><span className="tc-bar"><i style={{ width: `${pw}%`, background: "var(--red)" }} /></span></div>
                <div className="tc-m"><span className="tc-ml">Namentl.</span><span className="tc-mv" style={{ color: "var(--green)" }}>{nm}%</span><span className="tc-bar"><i style={{ width: `${nm}%`, background: "var(--green)" }} /></span></div>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}
