"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";

// Publizisten-Benchmark mit sauberer Vergleichsbasis:
//  - Balken = aktueller Zeitraum, Δ = Veränderung zur DIREKT VORANGEHENDEN Periode
//    gleicher Länge (beide Zeiträume werden explizit mit Datum angezeigt).
//  - Zähl-KPIs: Δ absolut + Prozent. Quoten-KPIs: Δ in PROZENTPUNKTEN (pp) —
//    "%-Veränderung einer Prozentzahl" erzeugt die absurden Werte, die vorher zu sehen waren.
//  - Guard: Hat die Vorperiode zu wenig Datenbasis (< 10 Artikel), wird kein Δ behauptet.

type Stat = {
  source_id: number; articles: number; paywalled: number;
  au_named: number; au_anon: number; au_none: number;
  video: number; werbung: number; hub: number; new_7d: number;
};

type Period = "7d" | "30d" | "90d";
const PERIOD_DAYS: Record<Period, number> = { "7d": 7, "30d": 30, "90d": 90 };

const short = (n: string) => n.replace(" Online", "");
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const fmtD = (d: Date) => d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

function periodLabel(p: Period) { return p === "7d" ? "7 Tage" : p === "30d" ? "30 Tage" : "90 Tage"; }

function periodBounds(p: Period) {
  const days = PERIOD_DAYS[p];
  const now = new Date();
  const curFrom = new Date(now); curFrom.setDate(now.getDate() - days);
  const prevFrom = new Date(now); prevFrom.setDate(now.getDate() - 2 * days);
  return { days, now, curFrom, prevFrom };
}

// Δ für Zähl-KPIs: absolut + % zur Vorperiode. prev=0 → "neu" statt +∞%.
function DeltaCount({ cur, prev }: { cur: number; prev: number }) {
  if (prev === 0 && cur === 0) return <span className="pc-delta neutral">—</span>;
  if (prev === 0) return <span className="pc-delta up" title="Vorperiode: 0">neu</span>;
  const diff = cur - prev;
  if (diff === 0) return <span className="pc-delta neutral">±0</span>;
  const p = Math.round((diff / prev) * 100);
  return (
    <span className={`pc-delta ${diff > 0 ? "up" : "down"}`} title={`Vorperiode: ${prev.toLocaleString("de-DE")}`}>
      {diff > 0 ? "+" : ""}{diff.toLocaleString("de-DE")}
      <span className="pc-delta-pct"> ({p > 0 ? "+" : ""}{p}%)</span>
    </span>
  );
}

// Δ für Quoten-KPIs: Prozentpunkte. baseOk=false → keine Aussage (zu wenig Daten).
function DeltaPP({ cur, prev, baseOk }: { cur: number; prev: number; baseOk: boolean }) {
  if (!baseOk) return <span className="pc-delta neutral" title="Vorperiode: zu wenig Artikel für einen belastbaren Vergleich">·</span>;
  const diff = Math.round(cur - prev);
  if (diff === 0) return <span className="pc-delta neutral" title={`Vorperiode: ${Math.round(prev)}%`}>±0 pp</span>;
  return (
    <span className={`pc-delta ${diff > 0 ? "up" : "down"}`} title={`Vorperiode: ${Math.round(prev)}%`}>
      {diff > 0 ? "+" : ""}{diff} pp
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
  const prevMap = useMemo(() => new Map(prevStats.map((s) => [s.source_id, s])), [prevStats]);

  useEffect(() => {
    if (!activeSources.length) { setStats([]); setPrevStats([]); return; }
    const nn = (v: string) => (v === "all" ? null : v);
    const base = { p_sources: activeSources, p_topics: topics.length ? topics : null, p_paywall: nn(f.paywall), p_author: nn(f.author), p_lang: nn(f.lang) };
    const { now, curFrom, prevFrom } = periodBounds(period);
    Promise.all([
      supabase.rpc("publisher_stats_f", { ...base, p_from: curFrom.toISOString(), p_to: now.toISOString() }),
      supabase.rpc("publisher_stats_f", { ...base, p_from: prevFrom.toISOString(), p_to: curFrom.toISOString() }),
    ]).then(([cur, prev]) => {
      setStats((cur.data as Stat[]) ?? []);
      setPrevStats((prev.data as Stat[]) ?? []);
    });
  }, [activeSources.join(","), topics.join(","), f.paywall, f.author, f.lang, period]);

  const { days, now, curFrom, prevFrom } = periodBounds(period);

  if (!stats.length) return null;
  const nm = (id: number) => short(nameById.get(id)?.name ?? "?");
  const ctx = topics.length === 1 ? ` · Thema: ${topicLabel(topics[0])}` : topics.length > 1 ? ` · ${topics.length} Themen` : "";

  // Abgeleitete Kennzahlen je Publizist (aktuell + Vorperiode)
  const derived = stats.map((s) => {
    const prev = prevMap.get(s.source_id);
    const au = s.au_named + s.au_anon + s.au_none;
    const auPrev = prev ? prev.au_named + prev.au_anon + prev.au_none : 0;
    return {
      sid: s.source_id, name: nm(s.source_id), country: nameById.get(s.source_id)?.country ?? "",
      articles: s.articles, prevArticles: prev?.articles ?? 0,
      perDay: s.articles / days, prevPerDay: (prev?.articles ?? 0) / days,
      pwPct: pct(s.paywalled, s.articles), prevPwPct: pct(prev?.paywalled ?? 0, prev?.articles ?? 0),
      pwBaseOk: (prev?.articles ?? 0) >= 10,
      namedPct: pct(s.au_named, au), prevNamedPct: pct(prev?.au_named ?? 0, auPrev),
      anonPct: pct(s.au_anon, au), nonePct: pct(s.au_none, au),
      auBaseOk: auPrev >= 10,
      pwRaw: `${s.paywalled.toLocaleString("de-DE")}/${s.articles.toLocaleString("de-DE")}`,
      namedRaw: `${s.au_named.toLocaleString("de-DE")}/${au.toLocaleString("de-DE")}`,
    };
  });

  const charts: {
    title: string; desc: string; color: string;
    data: { sid: number; label: string; value: number; display: string; raw?: string; delta: React.ReactNode }[];
  }[] = [
    {
      title: "Artikel", desc: `Veröffentlichte Artikel${ctx}`, color: "var(--accent)",
      data: derived.map((d) => ({
        sid: d.sid, label: d.name, value: d.articles, display: d.articles.toLocaleString("de-DE"),
        delta: <DeltaCount cur={d.articles} prev={d.prevArticles} />,
      })),
    },
    {
      title: "Publikations-Tempo", desc: `Ø Artikel pro Tag${ctx}`, color: "var(--teal)",
      data: derived.map((d) => ({
        sid: d.sid, label: d.name, value: d.perDay,
        display: d.perDay.toLocaleString("de-DE", { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
        raw: `${d.articles.toLocaleString("de-DE")} Artikel in ${days} Tagen`,
        delta: <DeltaCount cur={Math.round(d.perDay * 10)} prev={Math.round(d.prevPerDay * 10)} />,
      })),
    },
    {
      title: "Paywall-Quote", desc: `Anteil hinter Bezahlschranke${ctx} · Δ in Prozentpunkten`, color: "var(--red)",
      data: derived.map((d) => ({
        sid: d.sid, label: d.name, value: d.pwPct, display: `${d.pwPct}%`, raw: d.pwRaw,
        delta: <DeltaPP cur={d.pwPct} prev={d.prevPwPct} baseOk={d.pwBaseOk} />,
      })),
    },
    {
      title: "Namentliche Autoren", desc: `Anteil mit echtem Autorennamen${ctx} · Δ in Prozentpunkten`, color: "var(--green)",
      data: derived.map((d) => ({
        sid: d.sid, label: d.name, value: d.namedPct, display: `${d.namedPct}%`, raw: d.namedRaw,
        delta: <DeltaPP cur={d.namedPct} prev={d.prevNamedPct} baseOk={d.auBaseOk} />,
      })),
    },
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

      {/* Explizite Vergleichsbasis — was wird womit verglichen? */}
      <div className="pc-basis">
        <span className="pc-basis-cur">Zeitraum: <b>{fmtD(curFrom)} – {fmtD(now)}</b></span>
        <span className="pc-basis-sep">·</span>
        <span>Δ vergleicht mit der Vorperiode <b>{fmtD(prevFrom)} – {fmtD(curFrom)}</b> (gleiche Länge)</span>
      </div>

      <div className="charts data-fade-in" key={`${period}-${stats.length}`}>
        {charts.map((c) => {
          const max = Math.max(0.0001, ...c.data.map((d) => d.value));
          const sorted = [...c.data].sort((a, b) => b.value - a.value);
          return (
            <div className="chart-card panel" key={c.title}>
              <h3>{c.title}</h3>
              <div className="desc">{c.desc}</div>
              <div className="bars">
                {sorted.map((d) => (
                  <div className="barrow" key={d.sid}>
                    <span className="lbl">{d.label}</span>
                    <span className="track"><i style={{ width: `${(d.value / max) * 100}%`, background: c.color }} /></span>
                    <span className="pc-val-wrap">
                      <span className="val tnum" title={d.raw}>{d.display}</span>
                      {d.delta}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <h2 className="section-h">Steckbrief <span className="count">{fmtD(curFrom)} – {fmtD(now)}{ctx}</span></h2>
      <div className="panel" style={{ overflowX: "auto" }}>
        <table className="matrix">
          <thead>
            <tr>
              <th>Portal</th>
              <th title="Veröffentlichte Artikel im Zeitraum">Artikel</th>
              <th title={`Veränderung zur Vorperiode ${fmtD(prevFrom)}–${fmtD(curFrom)}`}>Δ Vorperiode</th>
              <th title="Durchschnittliche Artikel pro Tag">Ø/Tag</th>
              <th title="Anteil Artikel hinter Bezahlschranke">Paywall</th>
              <th title="Veränderung der Paywall-Quote in Prozentpunkten">Δ pp</th>
              <th title="Anteil namentlich gekennzeichneter Artikel">Namentlich</th>
              <th title="Redaktion/Agentur ohne Personennamen">Anonym</th>
              <th title="Ganz ohne Autorenangabe">Ohne</th>
            </tr>
          </thead>
          <tbody>
            {derived.map((d) => (
              <tr key={d.sid}>
                <td className="pub">{d.name} <span className="cc">{d.country}</span></td>
                <td className="tnum">{d.articles.toLocaleString("de-DE")}</td>
                <td className="tnum"><DeltaCount cur={d.articles} prev={d.prevArticles} /></td>
                <td className="tnum">{d.perDay.toLocaleString("de-DE", { maximumFractionDigits: 1, minimumFractionDigits: 1 })}</td>
                <td className="tnum"><span style={{ color: d.pwPct > 40 ? "var(--red)" : "inherit" }} title={d.pwRaw}>{d.pwPct}%</span></td>
                <td className="tnum"><DeltaPP cur={d.pwPct} prev={d.prevPwPct} baseOk={d.pwBaseOk} /></td>
                <td className="tnum"><span style={{ color: "var(--green)" }} title={d.namedRaw}>{d.namedPct}%</span></td>
                <td className="tnum">{d.anonPct}%</td>
                <td className="tnum faint">{d.nonePct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pc-footnote">
          Δ = Veränderung gegenüber der direkt vorangehenden Periode gleicher Länge ({fmtD(prevFrom)} – {fmtD(curFrom)}).
          Quoten-Veränderungen in Prozentpunkten (pp). „·" = Vorperiode hat zu wenig Artikel für einen belastbaren Vergleich.
        </div>
      </div>
    </>
  );
}
