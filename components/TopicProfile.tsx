"use client";

import { useMemo } from "react";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";
import { PUB_COLORS } from "@/components/TimeRangeFilter";
import { makeMatcher, snapshotOf } from "@/lib/filterCorpus";

// Themen-DNA: Agenda-Analyse nach dem Vorbild der Agenda-Setting-Forschung.
//  - Heatmap Publizist × Thema, zeilennormiert ("Anteil am eigenen Output") → Agenda-Profil
//  - Spezialisierungs-Index = eigener Themenanteil ÷ Marktdurchschnitt (Affinity-Index)
//  - Share of Voice = Anteil eines Publizisten an allen Artikeln eines Themas
//  - Themen-Vielfalt = normierte Shannon-Entropie des Themen-Mix
//  - Monetarisierung (Paywall-Quote) & Autoren-Transparenz je Thema
//  - Unterthemen-Radar aus verlagseigenen Rubriken

type Row = { topic: string | null; source_id: number; paywalled: boolean | null; author_status: string | null; word_count: number | null };
type Cell = { n: number; pw: number; named: number; au: number; words: number; wordsN: number };

const short = (n: string) => n.replace(" Online", "");
const pct = (x: number) => `${Math.round(x * 100)}%`;

export default function TopicProfile() {
  const f = useFilters();
  const loading = !f.corpusReady;

  // Heatmap-Datenbasis aus dem gemeinsamen Corpus — gleiches Prädikat wie die Tabelle,
  // nur ohne Themen-Filter (die Themen-Dimension zeigt die Heatmap selbst). Vorher
  // ignorierte diese Komponente fast ALLE Filter und schloss undatierte Artikel aus.
  const rows = useMemo<Row[]>(() => {
    const snap = snapshotOf(f as any);
    const match = makeMatcher(snap, [], f.kwIdSet, { topics: true });
    const out: Row[] = [];
    for (const r of f.corpus) {
      if (!f.active.has(r.source_id)) continue;
      if (!match(r)) continue;
      out.push(r);
    }
    return out;
  }, [f.corpus, f.corpusReady, f.active, f.status, f.paywall, f.atype, f.author,
      f.lang, f.changed, f.depth, f.hideRegional, f.linkState, f.onlineCut, f.rangeFrom, f.rangeTo, f.timeAxis, f.kwIdSet]);

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
      const c = p.cells.get(t) ?? { n: 0, pw: 0, named: 0, au: 0, words: 0, wordsN: 0 };
      const g = byTopic.get(t) ?? { n: 0, pw: 0, named: 0, au: 0, words: 0, wordsN: 0 };
      c.n++; g.n++;
      if (r.paywalled === true) { c.pw++; g.pw++; totalPw++; }
      if (r.author_status) { c.au++; g.au++; if (r.author_status === "named") { c.named++; g.named++; } }
      if (r.word_count && r.word_count > 0) { c.words += r.word_count; c.wordsN++; g.words += r.word_count; g.wordsN++; }
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

  // Auto-Insights: viele Fakten, die man der Rohtabelle nicht ansieht — in ZUFÄLLIGER Reihenfolge.
  const insights = useMemo(() => {
    const { total, totalPw, topicsSorted, pubs, byTopic } = model;
    const out: { icon: string; value: string; label: string; caption: string }[] = [];
    if (!total || !pubs.length) return out;

    // Publisher-Rollups (Paywall/Autoren/Tiefe je Quelle)
    const pubRoll = pubs.map((p) => {
      let pw = 0, named = 0, au = 0, words = 0, wordsN = 0;
      for (const [, c] of p.cells) { pw += c.pw; named += c.named; au += c.au; words += c.words; wordsN += c.wordsN; }
      return { name: p.name, total: p.total, diversity: p.diversity, pwSh: p.total ? pw / p.total : 0,
        namedSh: au ? named / au : 0, anonSh: au ? (au - named) / au : 0, avgWords: wordsN ? Math.round(words / wordsN) : 0 };
    });
    const big = pubRoll.filter((p) => p.total >= 50);
    const topicBig = topicsSorted.filter((t) => byTopic.get(t)!.n >= 30);

    // 1) Stärkste Spezialisierung (Affinity-Index)
    let spec: { pub: string; topic: string; idx: number; share: number } | null = null;
    for (const p of pubs) {
      if (p.total < 60) continue;
      for (const t of topicsSorted) {
        const c = p.cells.get(t);
        if (!c || c.n < 15) continue;
        const idx = (c.n / p.total) / (byTopic.get(t)!.n / total);
        if (idx >= 1.4 && (!spec || idx > spec.idx)) spec = { pub: p.name, topic: t, idx, share: c.n / p.total };
      }
    }
    if (spec) out.push({ icon: "🎯", value: `${spec.idx.toFixed(1).replace(".", ",")}×`, label: `${spec.pub} → ${topicLabel(spec.topic)}`,
      caption: `${pct(spec.share)} des eigenen Outputs — ${spec.idx.toFixed(1).replace(".", ",")}-fach über dem Marktschnitt` });

    // 2) Share of Voice (Themen-Dominanz)
    let dom: { pub: string; topic: string; sov: number } | null = null;
    for (const t of topicBig) { const g = byTopic.get(t)!;
      for (const p of pubs) { const c = p.cells.get(t); if (!c) continue; const sov = c.n / g.n;
        if (sov >= 0.35 && (!dom || sov > dom.sov)) dom = { pub: p.name, topic: t, sov }; } }
    if (dom) out.push({ icon: "📣", value: pct(dom.sov), label: `Share of Voice: ${topicLabel(dom.topic)}`,
      caption: `${dom.pub} liefert ${pct(dom.sov)} aller ${topicLabel(dom.topic)}-Artikel im Feld` });

    // 3) Meistmonetarisiertes Thema
    const monT = [...topicBig].map((t) => ({ t, sh: byTopic.get(t)!.pw / byTopic.get(t)!.n })).sort((a, b) => b.sh - a.sh)[0];
    if (monT && monT.sh > 0.02) out.push({ icon: "💰", value: pct(monT.sh), label: `Paywall-Spitzenreiter: ${topicLabel(monT.t)}`,
      caption: `Feld-Schnitt ${pct(totalPw / total)} — dieses Thema gilt als besonders zahlungswürdig` });

    // 4) Am freiesten zugängliches Thema
    const freeT = [...topicBig].map((t) => ({ t, sh: byTopic.get(t)!.pw / byTopic.get(t)!.n })).sort((a, b) => a.sh - b.sh)[0];
    if (freeT) out.push({ icon: "🔓", value: pct(1 - freeT.sh), label: `Am offensten: ${topicLabel(freeT.t)}`,
      caption: `${pct(1 - freeT.sh)} frei lesbar — die niedrigste Paywall-Quote im Feld` });

    // 5) Transparentestes Thema (namentliche Autoren)
    const traT = [...topicBig].filter((t) => byTopic.get(t)!.au >= 20).map((t) => ({ t, sh: byTopic.get(t)!.named / byTopic.get(t)!.au })).sort((a, b) => b.sh - a.sh)[0];
    if (traT) out.push({ icon: "✍️", value: pct(traT.sh), label: `Autoren-Klarheit: ${topicLabel(traT.t)}`,
      caption: "Höchster Anteil namentlich gekennzeichneter Artikel" });

    // 6) Tiefstes Thema (Ø Wörter)
    const deepT = [...topicBig].map((t) => ({ t, w: byTopic.get(t)!.wordsN >= 5 ? byTopic.get(t)!.words / byTopic.get(t)!.wordsN : 0 })).sort((a, b) => b.w - a.w)[0];
    if (deepT && deepT.w > 0) out.push({ icon: "📖", value: `${Math.round(deepT.w).toLocaleString("de-DE")}`, label: `Längste Artikel: ${topicLabel(deepT.t)}`,
      caption: `Ø ${Math.round(deepT.w).toLocaleString("de-DE")} Wörter — ≈ ${Math.round(deepT.w / 200)} min Lesezeit` });

    // 7) Breiteste vs. fokussierteste Agenda (Entropie)
    if (big.length >= 2) { const s = [...big].sort((a, b) => b.diversity - a.diversity); const broad = s[0], narrow = s[s.length - 1];
      out.push({ icon: "🧭", value: pct(broad.diversity), label: `Breiteste Agenda: ${broad.name}`,
        caption: `Vielfältigste Themenmischung — ${narrow.name} ist am fokussiertesten (${pct(narrow.diversity)})` }); }

    // 8) Paywall-König (Publisher)
    const pwKing = [...big].sort((a, b) => b.pwSh - a.pwSh)[0];
    if (pwKing && pwKing.pwSh > 0.05) out.push({ icon: "🔒", value: pct(pwKing.pwSh), label: `Paywall-König: ${pwKing.name}`,
      caption: `Höchster Anteil kostenpflichtiger Artikel im Vergleich` });

    // 9) Transparenteste Quelle
    const traP = [...big].sort((a, b) => b.namedSh - a.namedSh)[0];
    if (traP && traP.namedSh > 0) out.push({ icon: "🪪", value: pct(traP.namedSh), label: `Transparenteste Quelle: ${traP.name}`,
      caption: `Nennt am häufigsten echte Autorennamen` });

    // 10) Anonymste Quelle
    const anonP = [...big].sort((a, b) => b.anonSh - a.anonSh)[0];
    if (anonP && anonP.anonSh > 0.3) out.push({ icon: "🕵️", value: pct(anonP.anonSh), label: `Am anonymsten: ${anonP.name}`,
      caption: `Höchster Anteil Redaktion/Agentur statt Autorennamen` });

    // 11) Produktivste Quelle
    const prolific = [...pubRoll].sort((a, b) => b.total - a.total)[0];
    if (prolific) out.push({ icon: "⚡", value: prolific.total.toLocaleString("de-DE"), label: `Produktivste Quelle: ${prolific.name}`,
      caption: `Meiste Artikel im aktuellen Filter` });

    // 12) Ausführlichste Quelle (Ø Wörter)
    const wordy = [...big].filter((p) => p.avgWords > 0).sort((a, b) => b.avgWords - a.avgWords)[0];
    if (wordy) out.push({ icon: "📝", value: wordy.avgWords.toLocaleString("de-DE"), label: `Ausführlichste Quelle: ${wordy.name}`,
      caption: `Ø ${wordy.avgWords.toLocaleString("de-DE")} Wörter pro Artikel` });

    // 13) Größtes Themenfeld
    const topT = topicsSorted.map((t) => ({ t, n: byTopic.get(t)!.n })).sort((a, b) => b.n - a.n)[0];
    if (topT) out.push({ icon: "🗂️", value: pct(topT.n / total), label: `Größtes Themenfeld: ${topicLabel(topT.t)}`,
      caption: `${topT.n.toLocaleString("de-DE")} Artikel — ${pct(topT.n / total)} des gesamten Outputs` });

    // 14) Kürzeste Artikel (Thema)
    const shortT = [...topicBig].map((t) => ({ t, w: byTopic.get(t)!.wordsN >= 5 ? byTopic.get(t)!.words / byTopic.get(t)!.wordsN : 1e9 })).filter((x) => x.w < 1e9).sort((a, b) => a.w - b.w)[0];
    if (shortT) out.push({ icon: "⏱️", value: `${Math.round(shortT.w).toLocaleString("de-DE")}`, label: `Kürzeste Artikel: ${topicLabel(shortT.t)}`,
      caption: `Ø ${Math.round(shortT.w).toLocaleString("de-DE")} Wörter — schnelle Meldungen` });

    // Zufällige Reihenfolge (Fisher-Yates), neu gemischt bei jedem Daten-/Filter-Wechsel.
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }, [model]);

  // Monetarisierung, Transparenz & Tiefe je Thema (für die Mini-Charts)
  const topicStats = useMemo(() => {
    return model.topicsSorted
      .map((t) => {
        const g = model.byTopic.get(t)!;
        return {
          topic: t, n: g.n,
          pwSh: g.n ? g.pw / g.n : 0,
          namedSh: g.au >= 10 ? g.named / g.au : null,
          avgWords: g.wordsN >= 5 ? Math.round(g.words / g.wordsN) : null,
        };
      })
      .filter((x) => x.n >= 10);
  }, [model]);
  const maxWords = useMemo(() => Math.max(1, ...topicStats.map((x) => x.avgWords ?? 0)), [topicStats]);

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

      {/* Auto-Insights: horizontal scrollbares Fakten-Karussell (zufällige Reihenfolge) */}
      {insights.length > 0 && (
        <div className="tp-insights-scroll data-fade-in">
          <div className="tp-insights-track">
            {insights.map((i, idx) => (
              <div key={`${i.label}-${idx}`} className="tp-insight panel">
                <span className="tp-insight-icon">{i.icon}</span>
                <span className="tp-insight-value">{i.value}</span>
                <span className="tp-insight-label">{i.label}</span>
                <span className="tp-insight-caption">{i.caption}</span>
              </div>
            ))}
          </div>
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
        <div className="chart-card panel">
          <h3>Artikel-Tiefe je Thema</h3>
          <div className="desc">Ø Wortzahl — wo wird ausführlich, wo knapp berichtet?</div>
          <div className="bars">
            {[...topicStats].filter((x) => x.avgWords !== null).sort((a, b) => (b.avgWords! - a.avgWords!)).map((x) => (
              <div className="barrow" key={x.topic}>
                <span className="lbl">{topicLabel(x.topic)}</span>
                <span className="track"><i style={{ width: `${Math.round((x.avgWords! / maxWords) * 100)}%`, background: "var(--teal)" }} /></span>
                <span className="val tnum" title={`${x.n.toLocaleString("de-DE")} Artikel · ≈ ${Math.round(x.avgWords! / 200)} min`}>{x.avgWords!.toLocaleString("de-DE")}</span>
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
                    title={`${s.label} · ${s.n} Artikel · ${s.sources} ${s.sources === 1 ? "Quelle" : "Quellen"}`}
                  >
                    {s.label}<span className="subtopic-n">{s.n}</span>
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
