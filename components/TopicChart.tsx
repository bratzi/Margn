"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";
import { PUB_COLORS } from "@/components/TimeRangeFilter";

type Row = { topic: string; source_id: number; outlet: string; n: number };

const short = (n: string) => n.replace(" Online", "");

export default function TopicChart() {
  const f = useFilters();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!f.activeArr.length) { setRows([]); return; }
    const nn = (v: string) => (v === "all" ? null : v);
    // Nutze page_overview direkt: topic + source gruppiert
    supabase
      .from("page_overview")
      .select("topic, source_id, outlet")
      .in("source_id", f.activeArr)
      .limit(20000)
      .then(({ data, error }) => {
        if (error || !data) { setRows([]); return; }
        // Aggregiere clientseitig nach topic × source
        const map = new Map<string, number>();
        for (const r of data as any[]) {
          const key = `${r.topic ?? "sonstiges"}|||${r.source_id}|||${r.outlet ?? ""}`;
          map.set(key, (map.get(key) ?? 0) + 1);
        }
        const agg: Row[] = [];
        for (const [key, n] of map) {
          const parts = key.split("|||");
          agg.push({ topic: parts[0] || "sonstiges", source_id: Number(parts[1]), outlet: parts[2] ?? "", n });
        }
        setRows(agg);
      });
  }, [f.activeArr.join(","), f.paywall, f.author, f.lang, f.rangeFrom, f.rangeTo]);

  // Farb- und Reihenfolge-Zuordnung — IDENTISCH für Balken-Segmente UND Legende.
  // (Vorher liefen Balken über f.sources-Index, Legende über aktive-gefilterten Index →
  //  Farben stimmten nicht überein und dominante Quelle ließ alles einfarbig wirken.)
  const activeSources = useMemo(
    () => f.sources.filter((s) => f.active.has(s.id)),
    [f.sources, f.active],
  );
  const colorById = useMemo(
    () => new Map(activeSources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])),
    [activeSources],
  );

  const { topics, totals, outlets } = useMemo(() => {
    const topicTotals = new Map<string, number>();
    const topicOutlets = new Map<string, Map<number, { outlet: string; n: number }>>();
    for (const r of rows) {
      topicTotals.set(r.topic, (topicTotals.get(r.topic) ?? 0) + r.n);
      if (!topicOutlets.has(r.topic)) topicOutlets.set(r.topic, new Map());
      const om = topicOutlets.get(r.topic)!;
      const existing = om.get(r.source_id);
      om.set(r.source_id, { outlet: r.outlet, n: (existing?.n ?? 0) + r.n });
    }
    const sorted = [...topicTotals.entries()].sort((a, b) => b[1] - a[1]);
    return { topics: sorted.map(([t]) => t), totals: topicTotals, outlets: topicOutlets };
  }, [rows]);

  if (!topics.length) return null;

  const maxTotal = Math.max(1, ...topics.map((t) => totals.get(t) ?? 0));

  return (
    <>
      <h2 className="section-h">
        Themen <span className="count">publizistenübergreifend · klick zum Filtern</span>
      </h2>
      <div className="panel pad data-fade-in" key={topics.length}>
        <div className="topic-vchart">
          {topics.map((topic) => {
            const total = totals.get(topic) ?? 0;
            const barH = Math.max(4, Math.round((total / maxTotal) * 220));
            const on = f.topics.includes(topic);
            const outletMap = outlets.get(topic) ?? new Map();
            const segments = [...outletMap.entries()]
              .sort((a, b) => b[1].n - a[1].n)
              .map(([sid, { outlet, n }]) => ({ sid, outlet, n, color: colorById.get(sid) ?? "var(--muted)" }));

            return (
              <button
                key={topic}
                className={`topic-vcol ${on ? "sel" : ""}`}
                onClick={() => f.toggleTopic(topic)}
                title={`${topicLabel(topic)}: ${total.toLocaleString("de-DE")} Artikel`}
              >
                <div className="topic-vcol-bar-wrap" style={{ height: 228 }}>
                  <div className="topic-vcol-bar" style={{ height: barH }}>
                    {segments.map((seg) => (
                      <div
                        key={seg.sid}
                        className="topic-vcol-seg"
                        style={{ height: `${(seg.n / total) * 100}%`, background: seg.color, opacity: on ? 1 : 0.75 }}
                        title={`${short(seg.outlet)}: ${seg.n.toLocaleString("de-DE")}`}
                      />
                    ))}
                  </div>
                </div>
                <div className="topic-vcol-total">{total.toLocaleString("de-DE")}</div>
                <div className="topic-vcol-label">{topicLabel(topic)}</div>
              </button>
            );
          })}
        </div>
        <div className="topic-vchart-legend">
          {activeSources.map((s) => (
            <span key={s.id}>
              <i style={{ background: colorById.get(s.id) }} />
              {short(s.name)}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
