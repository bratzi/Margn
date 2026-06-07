"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Stat = {
  source_id: number; outlet: string; country: string;
  articles: number; sections: number; media: number; interactive: number; sponsored: number;
  analyzed: number; paywalled: number; with_image: number; liveblogs: number;
  au_named: number; au_anon: number; au_none: number;
  new_24h: number; new_7d: number; median_words: number | null; avg_reading: number | null;
};

const short = (n: string) => n.replace(" Online", "");
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export default function PublisherCompare({ activeSources }: { activeSources?: number[] }) {
  const [all, setAll] = useState<Stat[]>([]);
  useEffect(() => { supabase.from("publisher_stats").select("*").then(({ data }) => setAll((data as Stat[]) ?? [])); }, []);
  const act = activeSources ? new Set(activeSources) : null;
  const stats = act ? all.filter((s) => act.has(s.source_id)) : all;
  if (!stats.length) return null;

  const charts: { title: string; desc: string; color: string; fmt?: (n: number) => string; data: { label: string; value: number; raw?: string }[] }[] = [
    { title: "Artikel gesamt", desc: "Entdeckte Artikelseiten je Portal", color: "var(--accent)",
      data: stats.map((s) => ({ label: short(s.outlet), value: s.articles })) },
    { title: "Paywall-Anteil", desc: "Anteil analysierter Artikel hinter Bezahlschranke", color: "var(--red)", fmt: (n) => `${n}%`,
      data: stats.map((s) => ({ label: short(s.outlet), value: pct(s.paywalled, s.analyzed), raw: `${s.paywalled}/${s.analyzed}` })) },
    { title: "Namentliche Autoren", desc: "Artikel mit echtem Autorennamen (statt Redaktion/Agentur)", color: "var(--green)", fmt: (n) => `${n}%`,
      data: stats.map((s) => ({ label: short(s.outlet), value: pct(s.au_named, s.analyzed), raw: `${s.au_named}/${s.analyzed}` })) },
    { title: "Video-Beiträge", desc: "Als reine Video-Seiten erkannt", color: "#8B5CF6",
      data: stats.map((s) => ({ label: short(s.outlet), value: s.media })) },
    { title: "Werbe-/Sponsored-Seiten", desc: "Als Anzeige/Advertorial erkannte Seiten", color: "var(--amber)",
      data: stats.map((s) => ({ label: short(s.outlet), value: s.sponsored })) },
    { title: "Neu veröffentlicht (7 Tage)", desc: "Publishing-Frequenz der letzten Woche", color: "var(--teal)",
      data: stats.map((s) => ({ label: short(s.outlet), value: s.new_7d })) },
  ];

  return (
    <>
      <h2 className="section-h">Publizisten im Vergleich <span className="count">{stats.length} Portale</span></h2>
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

      {/* Autoren-Transparenz: gestapelt named/anon/none */}
      <h2 className="section-h">Autoren-Transparenz <span className="count">namentlich · Redaktion/Agentur · ohne Angabe</span></h2>
      <div className="panel pad">
        <div className="legend">
          <span><i style={{ background: "var(--green)" }} /> Namentlich</span>
          <span><i style={{ background: "var(--amber)" }} /> Redaktion / Agentur</span>
          <span><i style={{ background: "var(--line-2)" }} /> Ohne Angabe</span>
        </div>
        <div className="stacks">
          {[...stats].sort((a, b) => pct(b.au_named, b.analyzed) - pct(a.au_named, a.analyzed)).map((s) => {
            const tot = Math.max(1, s.au_named + s.au_anon + s.au_none);
            return (
              <div className="stackrow" key={s.source_id}>
                <span className="lbl">{short(s.outlet)}</span>
                <span className="stack">
                  <i style={{ width: `${(s.au_named / tot) * 100}%`, background: "var(--green)" }} title={`Namentlich: ${s.au_named}`} />
                  <i style={{ width: `${(s.au_anon / tot) * 100}%`, background: "var(--amber)" }} title={`Redaktion/Agentur: ${s.au_anon}`} />
                  <i style={{ width: `${(s.au_none / tot) * 100}%`, background: "var(--line-2)" }} title={`Ohne: ${s.au_none}`} />
                </span>
                <span className="val tnum">{pct(s.au_named, tot)}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Steckbrief */}
      <h2 className="section-h">Steckbrief <span className="count">alle Kennzahlen</span></h2>
      <div className="panel" style={{ overflowX: "auto" }}>
        <table className="matrix">
          <thead>
            <tr>
              <th>Portal</th><th>Artikel</th><th>Rubriken</th><th>Video</th><th>Werbung</th>
              <th>Paywall</th><th>Namentlich</th><th>Anonym</th><th>Ohne</th><th>Ø Lesezeit</th><th>Neu 7T</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => (
              <tr key={s.source_id}>
                <td className="pub">{short(s.outlet)} <span className="cc">{s.country}</span></td>
                <td className="tnum">{s.articles.toLocaleString("de-DE")}</td>
                <td className="tnum">{s.sections}</td>
                <td className="tnum">{s.media.toLocaleString("de-DE")}</td>
                <td className="tnum">{s.sponsored}</td>
                <td className="tnum"><span style={{ color: pct(s.paywalled, s.analyzed) > 40 ? "var(--red)" : "inherit" }}>{pct(s.paywalled, s.analyzed)}%</span></td>
                <td className="tnum"><span style={{ color: "var(--green)" }}>{pct(s.au_named, s.analyzed)}%</span></td>
                <td className="tnum">{pct(s.au_anon, s.analyzed)}%</td>
                <td className="tnum faint">{pct(s.au_none, s.analyzed)}%</td>
                <td className="tnum">{s.avg_reading ?? "—"} Min</td>
                <td className="tnum">{s.new_7d}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
