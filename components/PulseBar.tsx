"use client";

import { useMemo } from "react";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";
import { axisTime, berlinDate, makeMatcher, snapshotOf } from "@/lib/filterCorpus";
import { useTweenedNumber } from "@/lib/chartTween";

// „Auf einen Blick" — verdichtete Headline-Metriken mit Kontext.
// Zählt über den gemeinsamen Corpus mit dem GLEICHEN Prädikat wie die Artikel-Tabelle
// (inkl. Zeit-Fallback published_at → discovered_at und ALLER Filter). Vorher hatte diese
// Komponente eine eigene, abweichende Query — die Zahlen passten nie zur Tabelle.

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const short = (n: string) => n.replace(" Online", "");

function Spark({ vals, color }: { vals: number[]; color: string }) {
  if (vals.length < 2) return null;
  const W = 96, H = 26, max = Math.max(1, ...vals);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * W},${H - (v / max) * (H - 3) - 1.5}`);
  const area = `0,${H} ${pts.join(" ")} ${W},${H}`;
  return (
    <svg className="pulse-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon points={area} fill={color} opacity="0.12" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

export default function PulseBar() {
  const f = useFilters();
  const nameById = useMemo(() => new Map(f.sources.map((s) => [s.id, short(s.name)])), [f.sources]);

  const m = useMemo(() => {
    const snap = snapshotOf(f as any);
    const match = makeMatcher(snap, f.subPats, f.kwIdSet);
    const act = f.active;
    let n = 0, pw = 0, named = 0, au = 0, revAny = 0, edits = 0, words = 0, wordsN = 0;
    const bySource = new Map<number, number>();
    const byTopic = new Map<string, number>();
    const dayBuckets = new Map<string, number>();
    for (const r of f.corpus) {
      if (!act.has(r.source_id)) continue;
      if (!match(r)) continue;
      n++;
      if (r.paywalled === true) pw++;
      if (r.author_status) { au++; if (r.author_status === "named") named++; }
      if ((r.revision_count ?? 0) > 0) revAny++;
      edits += r.edit_count ?? 0;
      if (r.word_count && r.word_count > 0) { words += r.word_count; wordsN++; }
      bySource.set(r.source_id, (bySource.get(r.source_id) ?? 0) + 1);
      const t = r.topic ?? "sonstiges";
      byTopic.set(t, (byTopic.get(t) ?? 0) + 1);
      const et = axisTime(r, f.timeAxis);
      if (et) { const d = berlinDate(et); dayBuckets.set(d, (dayBuckets.get(d) ?? 0) + 1); }
    }
    const daysSorted = [...dayBuckets.keys()].sort();
    const last14 = daysSorted.slice(-14);
    const spark = last14.map((d) => dayBuckets.get(d) ?? 0);
    const recent = spark.slice(-7).reduce((a, b) => a + b, 0);
    const prior = spark.slice(-14, -7).reduce((a, b) => a + b, 0);
    const paceDelta = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : null;
    const topSource = [...bySource.entries()].sort((a, b) => b[1] - a[1])[0];
    const topTopic = [...byTopic.entries()].sort((a, b) => b[1] - a[1])[0];
    const perDay = daysSorted.length ? n / daysSorted.length : 0;

    // Zu-/Abgänge im gewählten Zeitraum: Zugang = erste Sichtung (discovered_at) im
    // Fenster; Abgang = letzte Sichtung im Fenster UND seit dem jüngsten Scan-Stand
    // (± 90 min) nicht mehr gesehen — noch verlinkte Seiten sind KEINE Abgänge.
    // Zeit-agnostischer Matcher: die beiden Ereignisse haben ihre eigene Zeitachse.
    const matchNT = makeMatcher(snap, f.subPats, f.kwIdSet, { time: true });
    const fromMs = f.rangeFrom ? Date.parse(f.rangeFrom) : -Infinity;
    const toMs = f.rangeTo ? Date.parse(f.rangeTo) : Infinity;
    let newestSeen = 0;
    for (const r of f.corpus) { if (r.last_seen) { const t = Date.parse(r.last_seen); if (t > newestSeen) newestSeen = t; } }
    const onlineCut = newestSeen - 90 * 60000;
    let gainsN = 0, lossesN = 0;
    const gainsByDay = new Map<string, number>(), lossesByDay = new Map<string, number>();
    for (const r of f.corpus) {
      if (!act.has(r.source_id)) continue;
      if (!matchNT(r)) continue;
      if (r.discovered_at) {
        const t = Date.parse(r.discovered_at);
        if (t >= fromMs && t <= toMs) { gainsN++; const d = berlinDate(r.discovered_at); gainsByDay.set(d, (gainsByDay.get(d) ?? 0) + 1); }
      }
      if (r.last_seen) {
        const t = Date.parse(r.last_seen);
        if (t < onlineCut && t >= fromMs && t <= toMs) { lossesN++; const d = berlinDate(r.last_seen); lossesByDay.set(d, (lossesByDay.get(d) ?? 0) + 1); }
      }
    }
    // Kontinuierliche Tagesliste (Lücken = 0), damit die Sparklines zeitlich stimmen.
    const fluxDays = [...new Set([...gainsByDay.keys(), ...lossesByDay.keys()])].sort();
    let gainSpark: number[] = [], lossSpark: number[] = [];
    if (fluxDays.length) {
      const list: string[] = [];
      const cur = new Date(fluxDays[0] + "T12:00:00Z");
      const end = fluxDays[fluxDays.length - 1];
      while (list.length < 400) { const d = berlinDate(cur); list.push(d); if (d >= end) break; cur.setUTCDate(cur.getUTCDate() + 1); }
      gainSpark = list.map((d) => gainsByDay.get(d) ?? 0);
      lossSpark = list.map((d) => lossesByDay.get(d) ?? 0);
    }

    return {
      n, pwPct: pct(pw, n), namedPct: pct(named, au),
      revPct: pct(revAny, n), edits,
      avgWords: wordsN ? Math.round(words / wordsN) : 0,
      avgRead: wordsN ? Math.round(words / wordsN / 200) : 0, // ~200 WPM
      spark, paceDelta, perDay,
      gains: { n: gainsN, spark: gainSpark },
      losses: { n: lossesN, spark: lossSpark },
      topOutlet: topSource ? { name: nameById.get(topSource[0]) ?? "?", n: topSource[1], sh: pct(topSource[1], n) } : null,
      topTopic: topTopic ? { key: topTopic[0], n: topTopic[1], sh: pct(topTopic[1], n) } : null,
    };
  }, [f.corpus, f.corpusReady, f.active, f.status, f.paywall, f.atype, f.author,
      f.topics.join(","), f.lang, f.changed, f.depth, f.hideRegional, f.rangeFrom, f.rangeTo, f.timeAxis,
      f.subPats.join("|"), f.kwIdSet, nameById]);

  // Count-up: Kennzahlen zählen weich zum neuen Wert statt hart umzuspringen.
  // (Hooks VOR den early returns — React-Regel.)
  const animN = useTweenedNumber(m.n);
  const animPw = useTweenedNumber(m.pwPct);
  const animNamed = useTweenedNumber(m.namedPct);
  const animRev = useTweenedNumber(m.revPct);
  const animWords = useTweenedNumber(m.avgWords);
  const animGains = useTweenedNumber(m.gains.n);
  const animLosses = useTweenedNumber(m.losses.n);

  if (!f.corpusReady) {
    return (
      <>
        <h2 className="section-h">Auf einen Blick <span className="count">wird berechnet…</span></h2>
        <div className="skeleton skeleton-chart" style={{ height: 120 }} />
      </>
    );
  }
  if (!m.n) return null;

  const topicLbl = f.topics.length === 1 ? topicLabel(f.topics[0]) : f.topics.length > 1 ? `${f.topics.length} Themen` : "Gesamtverteilung";

  return (
    <>
      <h2 className="section-h">Auf einen Blick <span className="count">{topicLbl}</span></h2>
      <div className="pulse-grid data-fade-in">
        {/* Volumen + Tempo mit Sparkline */}
        <div className="pulse-card panel pulse-wide">
          <div className="pulse-k">Artikel im Filter</div>
          <div className="pulse-v">{Math.round(animN).toLocaleString("de-DE")}</div>
          <div className="pulse-sub">
            ø {m.perDay.toLocaleString("de-DE", { maximumFractionDigits: 1 })}/Tag
            {m.paceDelta !== null && (
              <span className={`pulse-trend ${m.paceDelta > 0 ? "up" : m.paceDelta < 0 ? "down" : ""}`}>
                {m.paceDelta > 0 ? "▲" : m.paceDelta < 0 ? "▼" : "•"} {Math.abs(m.paceDelta)}% vs. Vorwoche
              </span>
            )}
          </div>
          <Spark vals={m.spark} color="var(--accent)" />
        </div>

        {/* Paywall */}
        <div className="pulse-card panel">
          <div className="pulse-k">Hinter Paywall</div>
          <div className="pulse-v" style={{ color: m.pwPct > 40 ? "var(--red)" : undefined }}>{Math.round(animPw)}%</div>
          <div className="pulse-meter"><i style={{ width: `${m.pwPct}%`, background: "var(--red)" }} /></div>
          <div className="pulse-sub">{m.pwPct === 0 ? "frei zugänglich" : `${(100 - m.pwPct)}% frei lesbar`}</div>
        </div>

        {/* Autoren-Transparenz */}
        <div className="pulse-card panel">
          <div className="pulse-k">Namentliche Autoren</div>
          <div className="pulse-v" style={{ color: "var(--green)" }}>{Math.round(animNamed)}%</div>
          <div className="pulse-meter"><i style={{ width: `${m.namedPct}%`, background: "var(--green)" }} /></div>
          <div className="pulse-sub">Rest: Redaktion / Agentur</div>
        </div>

        {/* Stille Änderungen — das Alleinstellungsmerkmal */}
        <div className="pulse-card panel">
          <div className="pulse-k">Nachträglich geändert</div>
          <div className="pulse-v" style={{ color: m.revPct > 0 ? "var(--amber)" : undefined }}>{Math.round(animRev)}%</div>
          <div className="pulse-meter"><i style={{ width: `${Math.min(100, m.revPct)}%`, background: "var(--amber)" }} /></div>
          <div className="pulse-sub">{m.edits.toLocaleString("de-DE")} Überschriften-Edits erfasst</div>
        </div>

        {/* Artikel-Tiefe */}
        <div className="pulse-card panel">
          <div className="pulse-k">Ø Artikel-Tiefe</div>
          <div className="pulse-v">{Math.round(animWords).toLocaleString("de-DE")}<span className="pulse-unit"> Wörter</span></div>
          <div className="pulse-sub">≈ {m.avgRead} min Lesezeit</div>
        </div>

        {/* Fluktuation: neu reingekommen vs. offline gegangen (Sparkline = wann) */}
        <div className="pulse-card panel pulse-wide" title="Erste Sichtung liegt im gewählten Zeitraum">
          <div className="pulse-k">Neu reingekommen</div>
          <div className="pulse-v" style={{ color: "var(--green)" }}>{Math.round(animGains).toLocaleString("de-DE")}</div>
          <div className="pulse-sub">erste Sichtung im Zeitraum</div>
          <Spark vals={m.gains.spark} color="var(--green)" />
        </div>
        <div className="pulse-card panel pulse-wide" title="Letzte Sichtung liegt im Zeitraum — seither nicht mehr verlinkt angetroffen">
          <div className="pulse-k">Rausgeflogen</div>
          <div className="pulse-v" style={{ color: "var(--red)" }}>{Math.round(animLosses).toLocaleString("de-DE")}</div>
          <div className="pulse-sub">seither nicht mehr gesehen</div>
          <Spark vals={m.losses.spark} color="var(--red)" />
        </div>

        {/* Aktivster Publizist */}
        {m.topOutlet && (
          <div className="pulse-card panel">
            <div className="pulse-k">Aktivste Quelle</div>
            <div className="pulse-v pulse-v-sm">{m.topOutlet.name}</div>
            <div className="pulse-sub">{m.topOutlet.n.toLocaleString("de-DE")} Artikel · {m.topOutlet.sh}% des Volumens</div>
          </div>
        )}

        {/* Dominantes Thema */}
        {m.topTopic && (
          <button className="pulse-card panel pulse-click" onClick={() => f.toggleTopic(m.topTopic!.key)} title="Klick filtert dieses Thema">
            <div className="pulse-k">Dominantes Thema</div>
            <div className="pulse-v pulse-v-sm">{topicLabel(m.topTopic.key)}</div>
            <div className="pulse-sub">{m.topTopic.sh}% der Artikel im Filter</div>
          </button>
        )}
      </div>
    </>
  );
}
