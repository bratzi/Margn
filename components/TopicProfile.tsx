"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/pgFetch";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";
import { PUB_COLORS } from "@/components/TimeRangeFilter";

// Themen-DNA: Agenda-Analyse nach dem Vorbild der Agenda-Setting-Forschung.
//  - Heatmap Publizist × Thema, zeilennormiert ("Anteil am eigenen Output") → Agenda-Profil
//  - Spezialisierungs-Index = eigener Themenanteil ÷ Marktdurchschnitt (Affinity-Index)
//  - Share of Voice = Anteil eines Publizisten an allen Artikeln eines Themas
//  - Themen-Vielfalt = normierte Shannon-Entropie des Themen-Mix
//  - Monetarisierung (Paywall-Quote) & Autoren-Transparenz je Thema
//  - Unterthemen-Radar aus verlagseigenen Rubriken

type Row = { topic: string | null; source_id: number; paywalled: boolean | null; author_status: string | null };
type Cell = { n: number; pw: number; named: number; au: number };

const short = (n: string) => n.replace(" Online", "");
const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function TopicProfile() {
  const f = useFilters();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!f.activeArr.length) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    const withFilters = (q: any) => {
      if (f.rangeFrom) q = q.gte("published_at", f.rangeFrom);
      if (f.rangeTo) q = q.lte("published_at", f.rangeTo);
      return q;
    };
    fetchAllRows<Row>(
      () => withFilters(supabase.from("page_overview").select("id", { count: "exact", head: true }).in("source_id", f.activeArr)),
      (a, b) => withFilters(supabase.from("page_overview").select("topic, source_id, paywalled, author_status").in("source_id", f.activeArr)).range(a, b),
    ).then((data) => {
      if (cancelled) return;
      setRows(data);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [f.activeArr.join(","), f.rangeFrom, f.rangeTo]);

  const activeSources = useMemo(() => f.sources.filter((s) => f.active.has(s.id)), [f.sources, f.active]);
  const colorById = useMemo(
    () => new Map(activeSources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])),
    [activeSources],
  );

  const model = useMemo(() => {
    const byPub = new Map<number, { total: number; cells: Map<string, Cell> }>();
    const byTopic = new Map<string, Cell>();
    let total = 0, totalPw = 0;
    for (const r of rows) {
      const t = r.topic ?? "sonstiges";
      total++;
      if (!byPub.has(r.source_id)) byPub.set(r.source_id, { total: 0, cells: new Map() });
      const p = byPub.get(r.source_id)!;
      p.total++;
      const c = p.cells.get(t) ?? { n: 0, pw: 0, named: 0, au: 0 };
      const g = byTopic.get(t) ?? { n: 0, pw: 0, named: 0, au: 0 };
      c.n++; g.n++;
      if (r.paywalled === true) { c.pw++; g.pw++; totalPw++; }
      if (r.author_status) { c.au++; g.au++; if (r.author_status === "named") { c.named++; g.named++; } }
      p.cells.set(t, c); byTopic.set(t, g);
    }
    // Themen-Spalten: relevanteste zuerst, Mini-Themen (<0,5 % oder <5 Artikel) raus
    const topicsSorted = [...byTopic.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .filter(([, v]) => v.n >= Math.max(5, total * 0.005))
      .slice(0, 10)
      .map(([t]) => t);
    const pubs = activeSources
      .filter((s) => byPub.has(s.id))
      .map((s) => {
        const p = byPub.get(s.id)!;
        // Normierte Shannon-Entropie über den Themen-Mix → "Wie breit ist die Agenda?"
        let H = 0;
        for (const [, c] of p.cells) { const sh = c.n / p.total; if (sh > 0) H -= sh * Math.log(sh); }
        const diversity = byTopic.size > 1 ? H / Math.log(byTopic.size) : 0;
        return { id: s.id, name: short(s.name), total: p.total, cells: p.cells, diversity };
      })
      .sort((a, b) => b.total - a.total);
    return { total, totalPw, topicsSorted, pubs, byTopic };
  }, [rows, activeSources]);

  // Auto-Insights: Fakten, die man der Rohtabelle nicht ansieht
  const insights = useMemo(() => {
    const { total, totalPw, topicsSorted, pubs, byTopic } = model;
    const out: { icon: string; value: string; label: string; caption: string }[] = [];
    if (!total || !pubs.length) return out;

    // 1) Stärkste Spezialisierung (Affinity-Index)
    let spec: { pub: string; topic: string; idx: number; share: number } | null = null;
    for (const p of pubs) {
      if (p.total < 80) continue;
      for (const t of topicsSorted) {
        const c = p.cells.get(t);
        if (!c || c.n < 20) continue;
        const idx = (c.n / p.total) / (byTopic.get(t)!.n / total);
        if (idx >= 1.4 && (!spec || idx > spec.idx)) spec = { pub: p.name, topic: t, idx, share: c.n / p.total };
      }
    }
    if (spec) out.push({
      icon: "🎯", value: `${spec.idx.toFixed(1).replace(".", ",")}×`,
      label: `${spec.pub} → ${topicLabel(spec.topic)}`,
      caption: `${pct(spec.share)} des eigenen Outputs — ${spec.idx.toFixed(1).replace(".", ",")}-fach über dem Marktschnitt`,
    });

    // 2) Themen-Dominanz (Share of Voice)
    let dom: { pub: string; topic: string; sov: number } | null = null;
    for (const t of topicsSorted) {
      const g = byTopic.get(t)!;
      if (g.n < 40) continue;
      for (const p of pubs) {
        const c = p.cells.get(t);
        if (!c) continue;
        const sov = c.n / g.n;
        if (sov >= 0.4 && (!dom || sov > dom.sov)) dom = { pub: p.name, topic: t, sov };
      }
    }
    if (dom) out.push({
      icon: "📣", value: pct(dom.sov),
      label: `Share of Voice: ${topicLabel(dom.topic)}`,
      caption: `${dom.pub} liefert ${pct(dom.sov)} aller ${topicLabel(dom.topic)}-Artikel im Feld`,
    });

    // 3) Meistmonetarisiertes Thema (Paywall-Quote vs. Schnitt)
    let mon: { topic: string; sh: number } | null = null;
    for (const t of topicsSorted) {
      const g = byTopic.get(t)!;
      if (g.n < 40) continue;
      const sh = g.pw / g.n;
      if (!mon || sh > mon.sh) mon = { topic: t, sh };
    }
    if (mon && mon.sh > 0.02) out.push({
      icon: "💰", value: pct(mon.sh),
      label: `Paywall-Spitzenreiter: ${topicLabel(mon.topic)}`,
      caption: `Gesamtschnitt ${pct(totalPw / total)} — dieses Thema gilt als besonders zahlungswürdig`,
    });

    // 4) Transparenteste Berichterstattung (namentliche Autoren)
    let tra: { topic: string; sh: number } | null = null;
    for (const t of topicsSorted) {
      const g = byTopic.get(t)!;
      if (g.au < 40) continue;
      const sh = g.named / g.au;
      if (!tra || sh > tra.sh) tra = { topic: t, sh };
    }
    if (tra) out.push({
      icon: "✍️", value: pct(tra.sh),
      label: `Autoren-Klarheit: ${topicLabel(tra.topic)}`,
      caption: "Höchster Anteil namentlich gekennzeichneter Artikel",
    });

    // 5) Breiteste vs. fokussierteste Agenda (Entropie)
    const withDiv = pubs.filter((p) => p.total >= 60);
    if (withDiv.length >= 2) {
      const sorted = [...withDiv].sort((a, b) => b.diversity - a.diversity);
      const broad = sorted[0], narrow = sorted[sorted.length - 1];
      out.push({
        icon: "🧭", value: pct(broad.diversity),
        label: `Themen-Vielfalt: ${broad.name}`,
        caption: `Breiteste Agenda im Feld — ${narrow.name} ist am stärksten fokussiert (${pct(narrow.diversity)})`,
      });
    }
    return out.slice(0, 5);
  }, [model]);

  // Monetarisierung & Transparenz je Thema (für die Mini-Charts)
  const topicStats = useMemo(() => {
    return model.topicsSorted
      .map((t) => {
        const g = model.byTopic.get(t)!;
        return { topic: t, n: g.n, pwSh: g.n ? g.pw / g.n : 0, namedSh: g.au >= 10 ? g.named / g.au : null };
      })
      .filter((x) => x.n >= 10);
  }, [model]);

  // Unterthemen-Radar: Top-Themen mit ihren verlagseigenen Rubriken
  const spotlight = useMemo(
    () => model.topicsSorted.slice(0, 4)
      .map((t) => ({ topic: t, subs: (f.catTree.get(t) ?? []).slice(0, 5) }))
      .filter((x) => x.subs.length > 0),
    [model.topicsSorted, f.catTree],
  );

  if (loading && !rows.length) {
    return (
      <>
        <h2 className="section-h">Themen-DNA <span className="count">wird berechnet…</span></h2>
        <div className="skeleton skeleton-chart" />
      </>
    );
  }
  if (!model.total || !model.pubs.length) return null;
  const { total, topicsSorted, pubs, byTopic } = model;

  return (
    <>
      <h2 className="section-h">
        Themen-DNA
        <span className="count">Agenda-Profil · Spezialisierung · Monetarisierung — {total.toLocaleString("de-DE")} Artikel</span>
      </h2>

      {/* Auto-Insights: was man der Tabelle nicht ansieht */}
      {insights.length > 0 && (
        <div className="tp-insights data-fade-in">
          {insights.map((i) => (
            <div key={i.label} className="tp-insight panel">
              <span className="tp-insight-icon">{i.icon}</span>
              <span className="tp-insight-value">{i.value}</span>
              <span className="tp-insight-label">{i.label}</span>
              <span className="tp-insight-caption">{i.caption}</span>
            </div>
          ))}
        </div>
      )}

      {/* Agenda-Heatmap: Publizist × Thema, zeilennormiert */}
      <div className="panel tp-heat-wrap data-fade-in">
        <table className="tp-heat">
          <thead>
            <tr>
              <th className="tp-pubcol">Agenda-Profil</th>
              {topicsSorted.map((t) => (
                <th key={t}>
                  <button className={f.topics.includes(t) ? "on" : ""} onClick={() => f.toggleTopic(t)} title="Klick filtert dieses Thema">
                    {topicLabel(t)}
                  </button>
                </th>
              ))}
              <th className="tp-tot">Σ</th>
            </tr>
          </thead>
          <tbody>
            {pubs.map((p) => {
              const rowMax = Math.max(0.0001, ...topicsSorted.map((t) => (p.cells.get(t)?.n ?? 0) / p.total));
              return (
                <tr key={p.id}>
                  <td className="tp-pubcol"><i style={{ background: colorById.get(p.id) }} />{p.name}</td>
                  {topicsSorted.map((t) => {
                    const c = p.cells.get(t);
                    const share = (c?.n ?? 0) / p.total;
                    const idx = c ? share / (byTopic.get(t)!.n / total) : 0;
                    const alpha = share / rowMax;
                    return (
                      <td
                        key={t}
                        style={{
                          background: `color-mix(in srgb, var(--accent) ${Math.round(alpha * 78)}%, transparent)`,
                          color: alpha > 0.55 ? "#fff" : "var(--ink)",
                        }}
                        title={`${p.name} · ${topicLabel(t)}: ${(c?.n ?? 0).toLocaleString("de-DE")} Artikel = ${pct(share)} des Outputs · ${idx.toFixed(1).replace(".", ",")}× Marktschnitt`}
                      >
                        {share >= 0.005 ? pct(share) : "·"}
                        {c && c.n >= 15 && idx >= 1.5 && <em className="tp-mark up">▲</em>}
                        {c && c.n >= 15 && idx <= 0.5 && <em className="tp-mark down">▽</em>}
                      </td>
                    );
                  })}
                  <td className="tp-tot tnum">{p.total.toLocaleString("de-DE")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="tp-heat-legend">
          Zellen = Anteil am Output des Publizisten (je Zeile eingefärbt). ▲ ≥ 1,5× über Marktschnitt · ▽ ≤ 0,5×. Themen-Spalte anklicken filtert das Dashboard.
        </div>
      </div>

      {/* Monetarisierung & Transparenz je Thema */}
      <div className="charts tp-minis data-fade-in">
        <div className="chart-card panel">
          <h3>Monetarisierung je Thema</h3>
          <div className="desc">Paywall-Quote — welche Inhalte gelten als zahlungswürdig?</div>
          <div className="bars">
            {[...topicStats].sort((a, b) => b.pwSh - a.pwSh).map((x) => (
              <div className="barrow" key={x.topic}>
                <span className="lbl">{topicLabel(x.topic)}</span>
                <span className="track"><i style={{ width: `${Math.round(x.pwSh * 100)}%`, background: "var(--red)" }} /></span>
                <span className="val tnum" title={`${x.n.toLocaleString("de-DE")} Artikel`}>{pct(x.pwSh)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="chart-card panel">
          <h3>Autoren-Transparenz je Thema</h3>
          <div className="desc">Anteil namentlich gekennzeichneter Artikel</div>
          <div className="bars">
            {[...topicStats].filter((x) => x.namedSh !== null).sort((a, b) => (b.namedSh! - a.namedSh!)).map((x) => (
              <div className="barrow" key={x.topic}>
                <span className="lbl">{topicLabel(x.topic)}</span>
                <span className="track"><i style={{ width: `${Math.round(x.namedSh! * 100)}%`, background: "var(--green)" }} /></span>
                <span className="val tnum" title={`${x.n.toLocaleString("de-DE")} Artikel`}>{pct(x.namedSh!)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Unterthemen-Radar */}
      {spotlight.length > 0 && (
        <div className="panel pad tp-subspot data-fade-in">
          <div className="tp-subspot-h">
            Unterthemen-Radar
            <span>verlagseigene Rubriken in den Top-Themen · klick filtert die Artikelliste</span>
          </div>
          <div className="tp-subspot-grid">
            {spotlight.map(({ topic, subs }) => (
              <div key={topic} className="tp-subspot-col">
                <div className="tp-subspot-t">{topicLabel(topic)}</div>
                {subs.map((s) => (
                  <button
                    key={s.key}
                    className={`subtopic-chip ${f.subcats.includes(s.key) ? "on" : ""}`}
                    onClick={() => f.toggleSubcat(s.key)}
                    title={`${s.key} · ${s.n} Artikel · ${s.sources} ${s.sources === 1 ? "Quelle" : "Quellen"}`}
                  >
                    {s.key}<span className="subtopic-n">{s.n}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
