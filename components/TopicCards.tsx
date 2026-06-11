"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useFilters } from "@/components/FilterProvider";
import { topicLabel } from "@/lib/topics";

type K = { topic: string; articles: number; paywalled: number; au_named: number; au_total: number; new_7d: number; new_24h: number; outlets: number; timelines: number; avg_words: number; edits: number };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function Metric({ l, v, color, bar }: { l: string; v: string; color?: string; bar?: { p: number; c: string } }) {
  return (
    <div className="tc-m">
      <span className="tc-ml">{l}</span>
      <span className="tc-mv" style={color ? { color } : undefined}>{v}</span>
      <span className="tc-bar">{bar && <i style={{ width: `${Math.min(100, bar.p)}%`, background: bar.c }} />}</span>
    </div>
  );
}

export default function TopicCards() {
  const f = useFilters();
  const [rows, setRows] = useState<K[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!f.activeArr.length) { setRows([]); return; }
    const nn = (v: string) => (v === "all" ? null : v);
    supabase.rpc("topic_kpis_f", { p_sources: f.activeArr, p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang), p_from: f.rangeFrom, p_to: f.rangeTo })
      .then(({ data }) => setRows((data as K[]) ?? []));
  }, [f.activeArr.join(","), f.paywall, f.author, f.lang, f.rangeFrom, f.rangeTo]);

  if (!rows.length) return null;
  const toggleOpen = (t: string) => setOpen((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });

  return (
    <>
      <h2 className="section-h">Themen-Kennzahlen <span className="count">↔ scrollen · klick zum Filtern · ⌄ für mehr KPIs</span></h2>
      <div className="topic-cards">
        {rows.map((r) => {
          const pw = pct(r.paywalled, r.articles), nm = pct(r.au_named, r.au_total);
          const on = f.topics.includes(r.topic);
          const exp = open.has(r.topic);
          return (
            <div key={r.topic} className={`tcard ${on ? "on" : ""}`} role="button" tabIndex={0} onClick={() => f.toggleTopic(r.topic)}>
              <div className="tc-head"><span className="tc-name">{topicLabel(r.topic)}</span><span className="tc-art tnum">{r.articles.toLocaleString("de-DE")}</span></div>
              <div className="tc-sub">{r.new_7d} neu (7T) · {r.outlets} Quellen</div>
              <div className="tc-metrics">
                <Metric l="Paywall" v={`${pw}%`} color={pw > 40 ? "var(--red)" : undefined} bar={{ p: pw, c: "var(--red)" }} />
                <Metric l="Namentl." v={`${nm}%`} color="var(--green)" bar={{ p: nm, c: "var(--green)" }} />
                <Metric l="Neu 24h" v={String(r.new_24h)} bar={{ p: pct(r.new_24h, Math.max(1, r.new_7d)), c: "var(--accent)" }} />
                {exp && (
                  <>
                    <Metric l="Timelines" v={String(r.timelines)} bar={{ p: pct(r.timelines, r.articles), c: "#8B5CF6" }} />
                    <Metric l="Edits" v={String(r.edits)} color={r.edits > 0 ? "var(--amber)" : undefined} bar={{ p: Math.min(100, r.edits * 10), c: "var(--amber)" }} />
                    <Metric l="Ø Wörter" v={r.avg_words ? r.avg_words.toLocaleString("de-DE") : "—"} bar={{ p: Math.min(100, r.avg_words / 12), c: "var(--teal)" }} />
                    <Metric l="Anteil" v={`${pct(r.articles, rows.reduce((s, x) => s + x.articles, 0))}%`} bar={{ p: pct(r.articles, rows.reduce((s, x) => s + x.articles, 0)), c: "var(--line-2)" }} />
                  </>
                )}
              </div>
              <button className="tc-more" onClick={(e) => { e.stopPropagation(); toggleOpen(r.topic); }} title={exp ? "Weniger KPIs" : "Mehr KPIs"}>{exp ? "⌃ weniger" : "⌄ mehr KPIs"}</button>
            </div>
          );
        })}
      </div>
    </>
  );
}
