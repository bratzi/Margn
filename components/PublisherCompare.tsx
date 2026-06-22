"use client";

import { useMemo, useState } from "react";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";
import { axisTime, berlinDayBoundsUTC, makeMatcher, snapshotOf } from "@/lib/filterCorpus";

type Stat = {
  source_id: number; articles: number; paywalled: number;
  au_named: number; au_anon: number; au_none: number;
};

type Period = "7d" | "30d" | "90d" | "dyn";
const PERIOD_DAYS: Record<Exclude<Period, "dyn">, number> = { "7d": 7, "30d": 30, "90d": 90 };

const short = (n: string) => n.replace(" Online", "");
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const fmtD = (d: Date) => d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

function periodLabel(p: Period) {
  if (p === "7d") return "7 Tage";
  if (p === "30d") return "30 Tage";
  if (p === "90d") return "90 Tage";
  return "Dynamisch";
}

function fixedPeriodBounds(p: Exclude<Period, "dyn">) {
  const days = PERIOD_DAYS[p];
  const now = new Date();
  const curFrom = new Date(now); curFrom.setDate(now.getDate() - days);
  const prevFrom = new Date(now); prevFrom.setDate(now.getDate() - 2 * days);
  return { days, now, curFrom, prevFrom };
}

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

function DeltaPP({ cur, prev, baseOk }: { cur: number; prev: number; baseOk: boolean }) {
  if (!baseOk) return <span className="pc-delta neutral" title="Vorperiode: zu wenig Artikel">·</span>;
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
  const { sources, activeArr: activeSources, topics, days, rangeIdx } = f;
  const [period, setPeriod] = useState<Period>("7d");
  const nameById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  // Berechne curFrom/curTo/prevFrom/prevTo je nach Modus
  const { curFrom, curTo, prevFrom, periodDays } = useMemo(() => {
    if (period === "dyn") {
      // Dynamisch: nutzt aktuellen TimeRangeFilter-Bereich
      const cf = new Date(berlinDayBoundsUTC(days[rangeIdx.from]).from);
      const ct = new Date(berlinDayBoundsUTC(days[rangeIdx.to]).to);
      const spanMs = ct.getTime() - cf.getTime();
      const pf = new Date(cf.getTime() - spanMs);
      const pdDays = Math.max(1, Math.round(spanMs / 86400000));
      return { curFrom: cf, curTo: ct, prevFrom: pf, periodDays: pdDays };
    }
    const { days: d, now, curFrom: cf, prevFrom: pf } = fixedPeriodBounds(period as Exclude<Period, "dyn">);
    return { curFrom: cf, curTo: now, prevFrom: pf, periodDays: d };
  }, [period, days, rangeIdx]);

  // Beide Perioden aus dem gemeinsamen Corpus — gleiches Prädikat wie die Tabelle
  // (alle Filter außer Zeit; die Perioden bringt der Vergleich selbst mit).
  // Videos/Werbung/Hubs sind damit automatisch raus — vorher zählte die RPC sie mit.
  const { stats, prevMap } = useMemo(() => {
    const snap = snapshotOf(f as any);
    const match = makeMatcher(snap, f.subPats, f.kwIdSet, { time: true });
    const act = new Set(activeSources);
    const curFromMs = curFrom.getTime(), curToMs = curTo.getTime(), prevFromMs = prevFrom.getTime();
    const mk = (): Stat => ({ source_id: 0, articles: 0, paywalled: 0, au_named: 0, au_anon: 0, au_none: 0 });
    const cur = new Map<number, Stat>(), prev = new Map<number, Stat>();
    for (const r of f.corpus) {
      if (!act.has(r.source_id)) continue;
      if (!match(r)) continue;
      const t = axisTime(r, f.timeAxis);
      if (!t) continue;
      const ms = Date.parse(t);
      const target = ms >= curFromMs && ms <= curToMs ? cur : ms >= prevFromMs && ms < curFromMs ? prev : null;
      if (!target) continue;
      let s = target.get(r.source_id);
      if (!s) { s = mk(); s.source_id = r.source_id; target.set(r.source_id, s); }
      s.articles++;
      if (r.paywalled === true) s.paywalled++;
      if (r.author_status === "named") s.au_named++;
      else if (r.author_status === "anonymous") s.au_anon++;
      else if (r.author_status === "none") s.au_none++;
    }
    return { stats: [...cur.values()], prevMap: prev };
  }, [f.corpus, f.corpusReady, activeSources.join(","), topics.join(","), f.status, f.paywall,
      f.atype, f.author, f.lang, f.changed, f.depth, f.timeAxis, f.subPats.join("|"), f.kwIdSet,
      curFrom.getTime(), curTo.getTime(), prevFrom.getTime()]);

  if (!stats.length) return null;
  const nm = (id: number) => short(nameById.get(id)?.name ?? "?");
  const ctx = topics.length === 1 ? ` · Thema: ${topicLabel(topics[0])}` : topics.length > 1 ? ` · ${topics.length} Themen` : "";

  const derived = stats.map((s) => {
    const prev = prevMap.get(s.source_id);
    const au = s.au_named + s.au_anon + s.au_none;
    const auPrev = prev ? prev.au_named + prev.au_anon + prev.au_none : 0;
    return {
      sid: s.source_id, name: nm(s.source_id), country: nameById.get(s.source_id)?.country ?? "",
      articles: s.articles, prevArticles: prev?.articles ?? 0,
      perDay: s.articles / periodDays, prevPerDay: (prev?.articles ?? 0) / periodDays,
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
      title: "Artikel", desc: `${f.timeAxis === "seen" ? "Heute/Zeitraum gesehene" : "Veröffentlichte"} Artikel${ctx}`, color: "var(--accent)",
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
        raw: `${d.articles.toLocaleString("de-DE")} Artikel in ${periodDays} Tagen`,
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
          {(["7d", "30d", "90d", "dyn"] as Period[]).map((p) => (
            <button key={p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}
              title={p === "dyn" ? "Nutzt den aktuell gewählten Zeitstrahl-Bereich" : undefined}>
              {periodLabel(p)}
            </button>
          ))}
        </div>
      </h2>

      <div className="pc-basis">
        <span className="pc-basis-cur">Zeitraum: <b>{fmtD(curFrom)} – {fmtD(curTo)}</b></span>
        <span className="pc-basis-sep">·</span>
        <span>Δ vergleicht mit der Vorperiode <b>{fmtD(prevFrom)} – {fmtD(curFrom)}</b> (gleiche Länge)</span>
      </div>

      <div className="charts data-fade-in" key={`${period}-${curFrom.toISOString()}-${stats.length}`}>
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

      <h2 className="section-h">Steckbrief <span className="count">{fmtD(curFrom)} – {fmtD(curTo)}{ctx}</span></h2>
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
