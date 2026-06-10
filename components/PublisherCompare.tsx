"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";

type Stat = {
  source_id: number; articles: number; paywalled: number;
  au_named: number; au_anon: number; au_none: number;
  video: number; werbung: number; hub: number; new_7d: number;
};

const short = (n: string) => n.replace(" Online", "");
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export default function PublisherCompare() {
  const f = useFilters();
  const { sources, activeArr: activeSources, topics } = f;
  const [stats, setStats] = useState<Stat[]>([]);
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  useEffect(() => {
    const nn = (v: string) => (v === "all" ? null : v);
    supabase.rpc("publisher_stats_f", {
      p_sources: activeSources, p_topics: topics.length ? topics : null, p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang), p_from: f.rangeFrom, p_to: f.rangeTo,
    }).then(({ data }) => setStats((data as Stat[]) ?? []));
  }, [activeSources.join(","), topics.join(","), f.paywall, f.author, f.lang, f.rangeFrom, f.rangeTo]);

  if (!stats.length) return null;
  const nm = (id: number) => short(nameById.get(id)?.name ?? "?");
  const ctx = topics.length === 1 ? ` · Thema: ${topicLabel(topics[0])}` : topics.length > 1 ? ` · ${topics.length} Themen` : "";

  const charts: { title: string; desc: string; color: string; fmt?: (n: number) => string; data: { label: string; value: number; raw?: string }[] }[] = [
    { title: "Artikel", desc: `Artikel im Filter${ctx}`, color: "var(--accent)",
      data: stats.map((s) => ({ label: nm(s.source_id), value: s.articles })) },
    { title: "Paywall-Anteil", desc: `Anteil hinter Bezahlschranke${ctx}`, color: "var(--red)", fmt: (n) => `${n}%`,
      data: stats.map((s) => ({ label: nm(s.source_id), value: pct(s.paywalled, s.articles), raw: `${s.paywalled}/${s.articles}` })) },
    { title: "Namentliche Autoren", desc: `Anteil mit echtem Autorennamen${ctx}`, color: "var(--green)", fmt: (n) => `${n}%`,
      data: stats.map((s) => ({ label: nm(s.source_id), value: pct(s.au_named, s.au_named + s.au_anon + s.au_none), raw: `${s.au_named}` })) },
    { title: "Video-Beiträge", desc: "Reine Video-Seiten (gesamt)", color: "#8B5CF6",
      data: stats.map((s) => ({ label: nm(s.source_id), value: s.video })) },
    { title: "Werbe-/Sponsored-Seiten", desc: "Als Anzeige erkannt (gesamt)", color: "var(--amber)",
      data: stats.map((s) => ({ label: nm(s.source_id), value: s.werbung })) },
    { title: "Neu veröffentlicht (7 Tage)", desc: `Publishing-Frequenz${ctx}`, color: "var(--teal)",
      data: stats.map((s) => ({ label: nm(s.source_id), value: s.new_7d })) },
  ];

  return (
    <>
      <h2 className="section-h">Publizisten im Vergleich <span className="count">{stats.length} Portale{ctx}</span></h2>
      <div className="charts">
        {charts.map((c) => {
          const max = Math.max(1, ...c.data.map((d) => d.value));
          const sorted = [...c.data].sort((a, b) => b.value - a.value);
          return (
            <div className="chart-card panel" key={c.title}>
              <h3>{c.title}</h3>
              <div className="desc">{c.desc}</div>
              <div className="bars">
                {sorted.map((d) => (
                  <div className="barrow" key={d.label}>
                    <span className="lbl">{d.label}</span>
                    <span className="track"><i style={{ width: `${(d.value / max) * 100}%`, background: c.color }} /></span>
                    <span className="val tnum" title={d.raw}>{c.fmt ? c.fmt(d.value) : d.value.toLocaleString("de-DE")}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <h2 className="section-h">Steckbrief <span className="count">aktueller Filter{ctx}</span></h2>
      <div className="panel" style={{ overflowX: "auto" }}>
        <table className="matrix">
          <thead><tr>
            <th>Portal</th><th>Artikel</th><th>Paywall</th><th>Namentlich</th><th>Anonym</th><th>Video</th><th>Werbung</th><th>Hub</th><th>Neu 7T</th>
          </tr></thead>
          <tbody>
            {stats.map((s) => {
              const au = s.au_named + s.au_anon + s.au_none;
              return (
                <tr key={s.source_id}>
                  <td className="pub">{nm(s.source_id)} <span className="cc">{nameById.get(s.source_id)?.country}</span></td>
                  <td className="tnum">{s.articles.toLocaleString("de-DE")}</td>
                  <td className="tnum"><span style={{ color: pct(s.paywalled, s.articles) > 40 ? "var(--red)" : "inherit" }}>{pct(s.paywalled, s.articles)}%</span></td>
                  <td className="tnum"><span style={{ color: "var(--green)" }}>{pct(s.au_named, au)}%</span></td>
                  <td className="tnum">{pct(s.au_anon, au)}%</td>
                  <td className="tnum">{s.video.toLocaleString("de-DE")}</td>
                  <td className="tnum">{s.werbung}</td>
                  <td className="tnum">{s.hub}</td>
                  <td className="tnum">{s.new_7d}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
