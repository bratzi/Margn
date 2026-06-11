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
    let q = supabase
      .from("page_overview")
      .select("topic, source_id, outlet")
      .in("source_id", f.activeArr);
    if (f.paywall !== "all") q = q.eq("paywalled", f.paywall === "yes");
    if (f.author !== "all") q = q.eq("author_status", f.author);
    if (f.lang !== "all") q = q.eq("language", f.lang);
    if (f.rangeFrom) q = q.gte("published_at", f.rangeFrom);
    if (f.rangeTo) q = q.lte("published_at", f.rangeTo);

    q.limit(50000).then(({ data }) => {
      if (!data) return setRows([]);
      // Aggregiere clientseitig
      const map = new Map<string, number>();
      for (const r of data as any[]) {
        const key = `${r.topic ?? "sonstiges"}|||${r.source_id}|||${r.outlet}`;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      const agg: Row[] = [];
      for (const [key, n] of map) {
        const [topic, sid, outlet] = key.split("|||");
        agg.push({ topic: topic || "sonstiges", source_id: Number(sid), outlet, n });
      }
      setRows(agg);
    });
  }, [f.activeArr.join(","), f.paywall, f.author, f.lang, f.rangeFrom, f.rangeTo]);

  const colorById = useMemo(
    () => new Map(f.sources.map((s, i) => [s.id, PUB_COLORS[i % PUB_COLORS.length]])),
    [f.sources],
  );

  const { topics, totals, outlets } = useMemo(() => {
    // Alle Topics, sortiert nach Gesamtzahl
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
      <div className="panel pad">
        <div className="topic-vchart">
          {topics.map((topic) => {
            const total = totals.get(topic) ?? 0;
            const barH = Math.max(4, Math.round((total / maxTotal) * 220));
            const on = f.topics.includes(topic);
            const outletMap = outlets.get(topic) ?? new Map();
            // Sortierte Outlet-Segmente (größte zuerst)
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
                {/* Gestapelte Säule */}
                <div className="topic-vcol-bar-wrap" style={{ height: 228 }}>
                  <div className="topic-vcol-bar" style={{ height: barH }}>
                    {segments.map((seg) => (
                      <div
                        key={seg.sid}
                        className="topic-vcol-seg"
                        style={{
                          height: `${(seg.n / total) * 100}%`,
                          background: seg.color,
                          opacity: on ? 1 : 0.75,
                        }}
                        title={`${short(seg.outlet)}: ${seg.n.toLocaleString("de-DE")}`}
                      />
                    ))}
                  </div>
                </div>
                {/* Label + Wert */}
                <div className="topic-vcol-total">{total.toLocaleString("de-DE")}</div>
                <div className="topic-vcol-label">{topicLabel(topic)}</div>
              </button>
            );
          })}
        </div>

        {/* Legende (Publisher-Farben) */}
        <div className="topic-vchart-legend">
          {f.sources.filter((s) => f.active.has(s.id)).map((s, i) => (
            <span key={s.id}>
              <i style={{ background: PUB_COLORS[i % PUB_COLORS.length] }} />
              {short(s.name)}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
