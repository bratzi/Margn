"use client";

import { useMemo, useState } from "react";
import { useFilters } from "@/components/FilterProvider";
import { topicLabel } from "@/lib/topics";
import { makeMatcher, snapshotOf } from "@/lib/filterCorpus";

type K = { topic: string; articles: number; paywalled: number; au_named: number; au_total: number; new_7d: number; new_24h: number; outlets: number; timelines: number; avg_words: number; edits: number };
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function Metric({ l, v, color, bar, extra }: { l: string; v: string; color?: string; bar?: { p: number; c: string }; extra?: React.ReactNode }) {
  return (
    <div className="tc-m">
      <span className="tc-ml">{l}</span>
      <span className="tc-mv" style={color ? { color } : undefined}>{v}</span>
      {extra && <span className="tc-m-bench">{extra}</span>}
      <span className="tc-bar">{bar && <i style={{ width: `${Math.min(100, bar.p)}%`, background: bar.c }} />}</span>
    </div>
  );
}

export default function TopicCards() {
  const f = useFilters();
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Themen-KPIs aus dem gemeinsamen Corpus — gleiches Prädikat wie die Tabelle,
  // ohne die Themen-Dimension selbst (die zeigen die Karten ja).
  const rows = useMemo<K[]>(() => {
    if (!f.corpusReady || !f.active.size) return [];
    const snap = snapshotOf(f as any);
    const match = makeMatcher(snap, [], f.kwIdSet, { topics: true });
    const now = Date.now();
    const ms7d = now - 7 * 86400000, ms24h = now - 86400000;
    type Agg = { articles: number; paywalled: number; au_named: number; au_total: number; new_7d: number; new_24h: number; sources: Set<number>; timelines: number; words: number; wordsN: number; edits: number };
    const byTopic = new Map<string, Agg>();
    for (const r of f.corpus) {
      if (!f.active.has(r.source_id)) continue;
      if (!match(r)) continue;
      const t = r.topic ?? "sonstiges";
      let a = byTopic.get(t);
      if (!a) { a = { articles: 0, paywalled: 0, au_named: 0, au_total: 0, new_7d: 0, new_24h: 0, sources: new Set(), timelines: 0, words: 0, wordsN: 0, edits: 0 }; byTopic.set(t, a); }
      a.articles++;
      if (r.paywalled === true) a.paywalled++;
      if (r.author_status) { a.au_total++; if (r.author_status === "named") a.au_named++; }
      const disc = r.discovered_at ? Date.parse(r.discovered_at) : null;
      if (disc !== null && disc >= ms7d) a.new_7d++;
      if (disc !== null && disc >= ms24h) a.new_24h++;
      a.sources.add(r.source_id);
      if (r.ptype === "timeline" || r.ptype === "blog") a.timelines++;
      if (r.word_count && r.word_count > 0) { a.words += r.word_count; a.wordsN++; }
      a.edits += r.edit_count ?? 0;
    }
    return [...byTopic.entries()]
      .map(([topic, a]) => ({
        topic, articles: a.articles, paywalled: a.paywalled, au_named: a.au_named, au_total: a.au_total,
        new_7d: a.new_7d, new_24h: a.new_24h, outlets: a.sources.size, timelines: a.timelines,
        avg_words: a.wordsN ? Math.round(a.words / a.wordsN) : 0, edits: a.edits,
      }))
      .sort((a, b) => b.articles - a.articles);
  }, [f.corpus, f.corpusReady, f.active, f.status, f.paywall, f.atype, f.author,
      f.lang, f.changed, f.depth, f.rangeFrom, f.rangeTo, f.kwIdSet]);

  if (!rows.length) return null;
  const toggleOpen = (t: string) => setOpen((s) => { const n = new Set(s); n.has(t) ? n.delete(t) : n.add(t); return n; });

  // Durchschnitte über alle Themen — für „über/unter dem Schnitt"-Benchmark je Karte.
  const totalArt = rows.reduce((s, x) => s + x.articles, 0);
  const totalPwBase = rows.reduce((s, x) => s + x.articles, 0);
  const totalNamedBase = rows.reduce((s, x) => s + x.au_total, 0);
  const avgPw = pct(rows.reduce((s, x) => s + x.paywalled, 0), totalPwBase);
  const avgNm = pct(rows.reduce((s, x) => s + x.au_named, 0), totalNamedBase);
  // Benchmark-Chip: Abweichung in Prozentpunkten vom Themen-Schnitt
  const Bench = ({ v, avg, invert }: { v: number; avg: number; invert?: boolean }) => {
    const d = v - avg;
    if (Math.abs(d) < 3) return <span className="tc-bench flat" title={`Schnitt: ${avg}%`}>≈ Schnitt</span>;
    const good = invert ? d < 0 : d > 0;
    return (
      <span className={`tc-bench ${good ? "good" : "bad"}`} title={`Themen-Schnitt: ${avg}%`}>
        {d > 0 ? "▲" : "▼"} {Math.abs(d)} pp
      </span>
    );
  };

  return (
    <>
      <h2 className="section-h">Themen-Kennzahlen <span className="count">↔ scrollen · klick zum Filtern · Abweichung vom Themen-Schnitt</span></h2>
      <div className="topic-cards">
        {rows.map((r) => {
          const pw = pct(r.paywalled, r.articles), nm = pct(r.au_named, r.au_total);
          const on = f.topics.includes(r.topic);
          const exp = open.has(r.topic);
          const share = pct(r.articles, totalArt);
          return (
            <div key={r.topic} className={`tcard ${on ? "on" : ""}`} role="button" tabIndex={0} onClick={() => f.toggleTopic(r.topic)}>
              <div className="tc-head"><span className="tc-name">{topicLabel(r.topic)}</span><span className="tc-art tnum">{r.articles.toLocaleString("de-DE")}</span></div>
              <div className="tc-sub">{share}% des Volumens · {r.new_7d} neu (7T) · {r.outlets} Quellen</div>
              <div className="tc-metrics">
                <Metric l="Paywall" v={`${pw}%`} color={pw > 40 ? "var(--red)" : undefined} bar={{ p: pw, c: "var(--red)" }} extra={<Bench v={pw} avg={avgPw} invert />} />
                <Metric l="Namentl." v={`${nm}%`} color="var(--green)" bar={{ p: nm, c: "var(--green)" }} extra={<Bench v={nm} avg={avgNm} />} />
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
