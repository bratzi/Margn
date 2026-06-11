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

type Period = "7d" | "30d" | "90d";

const short = (n: string) => n.replace(" Online", "");
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

function periodLabel(p: Period) {
  return p === "7d" ? "7 Tage" : p === "30d" ? "30 Tage" : "90 Tage";
}

function periodFrom(p: Period): string {
  const d = new Date();
  if (p === "7d") d.setDate(d.getDate() - 7);
  else if (p === "30d") d.setDate(d.getDate() - 30);
  else d.setDate(d.getDate() - 90);
  return d.toISOString();
}

function prevPeriodFrom(p: Period): string {
  const d = new Date();
  const n = p === "7d" ? 14 : p === "30d" ? 60 : 180;
  d.setDate(d.getDate() - n);
  return d.toISOString();
}
function prevPeriodTo(p: Period): string {
  const d = new Date();
  const n = p === "7d" ? 7 : p === "30d" ? 30 : 90;
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (prev === 0 && cur === 0) return null;
  const diff = cur - prev;
  if (diff === 0) return <span className="pc-delta neutral">±0</span>;
  const pctDiff = prev > 0 ? Math.round((diff / prev) * 100) : null;
  const positive = diff > 0;
  return (
    <span className={`pc-delta ${positive ? "up" : "down"}`}>
      {positive ? "+" : ""}{diff.toLocaleString("de-DE")}
      {pctDiff !== null && <span className="pc-delta-pct"> ({positive ? "+" : ""}{pctDiff}%)</span>}
    </span>
  );
}

export default function PublisherCompare() {
  const f = useFilters();
  const { sources, activeArr: activeSources, topics } = f;
  const [stats, setStats] = useState<Stat[]>([]);
  const [prevStats, setPrevStats] = useState<Stat[]>([]);
  const [period, setPeriod] = useState<Period>("7d");
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  const nn = (v: string) => (v === "all" ? null : v);
  const base = { p_sources: activeSources, p_topics: topics.length ? topics : null, p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang) };

  useEffect(() => {
    const from = periodFrom(period);
    const to = new Date().toISOString();
    const prevFrom = prevPeriodFrom(period);
    const prevTo = prevPeriodTo(period);

    Promise.all([
      supabase.rpc("publisher_stats_f", { ...base, p_from: from, p_to: to }),
      supabase.rpc("publisher_stats_f", { ...base, p_from: prevFrom, p_to: prevTo }),
    ]).then(([cur, prev]) => {
      setStats((cur.data as Stat[]) ?? []);
      setPrevStats((prev.data as Stat[]) ?? []);
    });
  }, [activeSources.join(","), topics.join(","), f.paywall, f.author, f.lang, period]);

  // WICHTIG: alle Hooks VOR jedem early return — sonst "Rendered more hooks than
  // during the previous render" (Crash sobald stats von leer auf befüllt wechselt).
  const prevMap = useMemo(() => new Map(prevStats.map((s) => [s.source_id, s])), [prevStats]);

  if (!stats.length) return null;
  const nm = (id: number) => short(nameById.get(id)?.name ?? "?");
  const ctx = topics.length === 1 ? ` · Thema: ${topicLabel(topics[0])}` : topics.length > 1 ? ` · ${topics.length} Themen` : "";

  const charts: {
    title: string; desc: string; color: string; fmt?: (n: number) => string;
    data: { label: string; value: number; prev: number; raw?: string }[];
  }[] = [
    { title: "Artikel", desc: `Artikel · ${periodLabel(period)}${ctx}`, color: "var(--accent)",
      data: stats.map((s) => ({ label: nm(s.source_id), value: s.articles, prev: prevMap.get(s.source_id)?.articles ?? 0 })) },
    { title: "Paywall-Anteil", desc: `Anteil hinter Bezahlschranke${ctx}`, color: "var(--red)", fmt: (n) => `${n}%`,
      data: stats.map((s) => ({ label: nm(s.source_id), value: pct(s.paywalled, s.articles), prev: pct(prevMap.get(s.source_id)?.paywalled ?? 0, prevMap.get(s.source_id)?.articles ?? 1), raw: `${s.paywalled}/${s.articles}` })) },
    { title: "Namentliche Autoren", desc: `Anteil mit echtem Autorennamen${ctx}`, color: "var(--green)", fmt: (n) => `${n}%`,
      data: stats.map((s) => {
        const prev = prevMap.get(s.source_id);
        return { label: nm(s.source_id), value: pct(s.au_named, s.au_named + s.au_anon + s.au_none), prev: pct(prev?.au_named ?? 0, (prev?.au_named ?? 0) + (prev?.au_anon ?? 0) + (prev?.au_none ?? 0)), raw: `${s.au_named}` };
      }) },
    { title: "Neu veröffentlicht", desc: `Publishing-Frequenz · ${periodLabel(period)}${ctx}`, color: "var(--teal)",
      data: stats.map((s) => ({ label: nm(s.source_id), value: s.new_7d, prev: prevMap.get(s.source_id)?.new_7d ?? 0 })) },
  ];

  return (
    <>
      <h2 className="section-h">
        Publizisten im Vergleich
        <span className="count">{stats.length} Portale{ctx}</span>
        <div className="seg" style={{ marginLeft: "auto" }}>
          {(["7d", "30d", "90d"] as Period[]).map((p) => (
            <button key={p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>{periodLabel(p)}</button>
          ))}
        </div>
      </h2>
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
                    <span className="pc-val-wrap">
                      <span className="val tnum" title={d.raw}>{c.fmt ? c.fmt(d.value) : d.value.toLocaleString("de-DE")}</span>
                      <Delta cur={d.value} prev={d.prev} />
                    </span>
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
            <th>Portal</th><th>Artikel</th><th>Δ</th><th>Paywall</th><th>Namentlich</th><th>Anonym</th><th>Neu</th>
          </tr></thead>
          <tbody>
            {stats.map((s) => {
              const au = s.au_named + s.au_anon + s.au_none;
              const prev = prevMap.get(s.source_id);
              return (
                <tr key={s.source_id}>
                  <td className="pub">{nm(s.source_id)} <span className="cc">{nameById.get(s.source_id)?.country}</span></td>
                  <td className="tnum">{s.articles.toLocaleString("de-DE")}</td>
                  <td className="tnum"><Delta cur={s.articles} prev={prev?.articles ?? 0} /></td>
                  <td className="tnum"><span style={{ color: pct(s.paywalled, s.articles) > 40 ? "var(--red)" : "inherit" }}>{pct(s.paywalled, s.articles)}%</span></td>
                  <td className="tnum"><span style={{ color: "var(--green)" }}>{pct(s.au_named, au)}%</span></td>
                  <td className="tnum">{pct(s.au_anon, au)}%</td>
                  <td className="tnum">{s.new_7d.toLocaleString("de-DE")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
