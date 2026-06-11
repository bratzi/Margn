"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchAllRows } from "@/lib/pgFetch";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";

// „Auf einen Blick" — verdichtete Headline-Metriken mit Kontext statt drei isolierter
// Tortendiagramme. Jede Kachel beantwortet eine Frage, die man der Rohtabelle nicht ansieht:
// Wie viel? Wie schnell? Wie viel hinter Paywall? Wie transparent? Wie oft still geändert?
// Wie tief? Was dominiert gerade? — inkl. Mini-Sparkline für den Volumen-Trend.

type Row = {
  source_id: number; outlet: string; topic: string | null; paywalled: boolean | null;
  author_status: string | null; word_count: number | null; revision_count: number | null;
  edit_count: number | null; published_at: string | null; discovered_at: string | null;
};

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
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!f.activeArr.length) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    const nn = (v: string) => (v === "all" ? null : v);
    const withF = (q: any) => {
      if (f.topics.length) q = q.in("topic", f.topics);
      if (f.paywall === "yes") q = q.eq("paywalled", true); else if (f.paywall === "no") q = q.eq("paywalled", false);
      if (f.author !== "all") q = q.eq("author_status", f.author);
      if (f.lang !== "all") q = q.eq("language", f.lang);
      if (f.rangeFrom) q = q.gte("published_at", f.rangeFrom);
      if (f.rangeTo) q = q.lte("published_at", f.rangeTo);
      return q;
    };
    fetchAllRows<Row>(
      () => withF(supabase.from("page_overview").select("id", { count: "exact", head: true }).in("source_id", f.activeArr)),
      (a, b) => withF(supabase.from("page_overview")
        .select("source_id, outlet, topic, paywalled, author_status, word_count, revision_count, edit_count, published_at, discovered_at")
        .in("source_id", f.activeArr)).range(a, b),
    ).then((data) => { if (!cancelled) { setRows(data); setLoading(false); } });
    return () => { cancelled = true; };
  }, [f.activeArr.join(","), f.topics.join(","), f.paywall, f.author, f.lang, f.rangeFrom, f.rangeTo]);

  const m = useMemo(() => {
    const n = rows.length;
    let pw = 0, named = 0, au = 0, revAny = 0, edits = 0, words = 0, wordsN = 0;
    const byOutlet = new Map<string, number>();
    const byTopic = new Map<string, number>();
    // Volumen-Sparkline über die letzten 14 Tage (nach published_at)
    const dayBuckets = new Map<string, number>();
    for (const r of rows) {
      if (r.paywalled === true) pw++;
      if (r.author_status) { au++; if (r.author_status === "named") named++; }
      if ((r.revision_count ?? 0) > 0) revAny++;
      edits += r.edit_count ?? 0;
      if (r.word_count && r.word_count > 0) { words += r.word_count; wordsN++; }
      byOutlet.set(r.outlet, (byOutlet.get(r.outlet) ?? 0) + 1);
      const t = r.topic ?? "sonstiges";
      byTopic.set(t, (byTopic.get(t) ?? 0) + 1);
      if (r.published_at) { const d = r.published_at.slice(0, 10); dayBuckets.set(d, (dayBuckets.get(d) ?? 0) + 1); }
    }
    const days = [...dayBuckets.keys()].sort();
    const last14 = days.slice(-14);
    const spark = last14.map((d) => dayBuckets.get(d) ?? 0);
    // Tempo: Schnitt der letzten 7 vs. vorherige 7 Tage
    const recent = spark.slice(-7).reduce((a, b) => a + b, 0);
    const prior = spark.slice(-14, -7).reduce((a, b) => a + b, 0);
    const paceDelta = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : null;
    const topOutlet = [...byOutlet.entries()].sort((a, b) => b[1] - a[1])[0];
    const topTopic = [...byTopic.entries()].sort((a, b) => b[1] - a[1])[0];
    const perDay = days.length ? n / days.length : 0;
    return {
      n, pwPct: pct(pw, n), namedPct: pct(named, au),
      revPct: pct(revAny, n), edits,
      avgWords: wordsN ? Math.round(words / wordsN) : 0,
      avgRead: wordsN ? Math.round(words / wordsN / 200) : 0, // ~200 WPM
      spark, paceDelta, perDay,
      topOutlet: topOutlet ? { name: short(topOutlet[0]), n: topOutlet[1], sh: pct(topOutlet[1], n) } : null,
      topTopic: topTopic ? { key: topTopic[0], n: topTopic[1], sh: pct(topTopic[1], n) } : null,
    };
  }, [rows]);

  if (loading && !rows.length) {
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
          <div className="pulse-v">{m.n.toLocaleString("de-DE")}</div>
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
          <div className="pulse-v" style={{ color: m.pwPct > 40 ? "var(--red)" : undefined }}>{m.pwPct}%</div>
          <div className="pulse-meter"><i style={{ width: `${m.pwPct}%`, background: "var(--red)" }} /></div>
          <div className="pulse-sub">{m.pwPct === 0 ? "frei zugänglich" : `${(100 - m.pwPct)}% frei lesbar`}</div>
        </div>

        {/* Autoren-Transparenz */}
        <div className="pulse-card panel">
          <div className="pulse-k">Namentliche Autoren</div>
          <div className="pulse-v" style={{ color: "var(--green)" }}>{m.namedPct}%</div>
          <div className="pulse-meter"><i style={{ width: `${m.namedPct}%`, background: "var(--green)" }} /></div>
          <div className="pulse-sub">Rest: Redaktion / Agentur</div>
        </div>

        {/* Stille Änderungen — das Alleinstellungsmerkmal */}
        <div className="pulse-card panel">
          <div className="pulse-k">Nachträglich geändert</div>
          <div className="pulse-v" style={{ color: m.revPct > 0 ? "var(--amber)" : undefined }}>{m.revPct}%</div>
          <div className="pulse-meter"><i style={{ width: `${Math.min(100, m.revPct)}%`, background: "var(--amber)" }} /></div>
          <div className="pulse-sub">{m.edits.toLocaleString("de-DE")} Überschriften-Edits erfasst</div>
        </div>

        {/* Artikel-Tiefe */}
        <div className="pulse-card panel">
          <div className="pulse-k">Ø Artikel-Tiefe</div>
          <div className="pulse-v">{m.avgWords.toLocaleString("de-DE")}<span className="pulse-unit"> Wörter</span></div>
          <div className="pulse-sub">≈ {m.avgRead} min Lesezeit</div>
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
