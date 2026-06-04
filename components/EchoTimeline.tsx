"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type ClusterOv = { cluster_id: number; size: number; outlets: number; outlet_names: string[] };
type EchoRow = { cluster_id: number; outlet: string; country: string | null; similarity_pct: number; is_origin: boolean; offset_minutes: number };

const FLAG: Record<string, string> = { DE: "🇩🇪", FR: "🇫🇷" };

function simColor(sim: number, origin: boolean) {
  if (origin) return "#3ecf8e";
  if (sim >= 90) return "#f4607a";
  if (sim >= 80) return "#f0b429";
  return "#9aa4b2";
}

export default function EchoTimeline() {
  const [clusters, setClusters] = useState<ClusterOv[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [rows, setRows] = useState<EchoRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from("cluster_overview").select("cluster_id,size,outlets,outlet_names")
      .order("outlets", { ascending: false }).order("size", { ascending: false }).limit(200)
      .then(({ data }) => {
        const cs = ((data as ClusterOv[]) ?? []).filter((c) => c.size > 1);
        setClusters(cs);
        if (cs.length) setSelected(cs[0].cluster_id);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (selected == null) return;
    supabase.from("cluster_echoes").select("cluster_id,outlet,country,similarity_pct,is_origin,offset_minutes")
      .eq("cluster_id", selected).order("offset_minutes", { ascending: true })
      .then(({ data }) => setRows((data as EchoRow[]) ?? []));
  }, [selected]);

  const maxOffset = useMemo(() => Math.max(60, ...rows.map((r) => r.offset_minutes)), [rows]);
  const origin = rows.find((r) => r.is_origin);
  const echoes = rows.filter((r) => !r.is_origin);
  const last = rows[rows.length - 1];

  if (loading) return <p className="muted">Lade Story-Cluster…</p>;
  if (!clusters.length) return (
    <div className="panel pad muted">
      Noch keine blattübergreifenden Cluster. Sie entstehen, sobald mehrere analysierte Artikel
      dieselbe Story behandeln (Cosine-Ähnlichkeit ≥ 0,86).
    </div>
  );

  return (
    <div>
      <div className="controls" style={{ marginTop: 0 }}>
        <select value={selected ?? undefined} onChange={(e) => setSelected(Number(e.target.value))} style={{ minWidth: 340 }}>
          {clusters.map((c) => (
            <option key={c.cluster_id} value={c.cluster_id}>
              #{c.cluster_id} · {c.size} Artikel · {c.outlets} Blätter ({c.outlet_names.join(", ")})
            </option>
          ))}
        </select>
      </div>

      {origin && (
        <div className="muted" style={{ margin: "8px 0 18px", fontSize: 13 }}>
          Ursprung: <b style={{ color: "var(--text)" }}>{origin.outlet}</b> · {echoes.length} weitere Blätter zogen nach
          {last && <> · letzter nach <b style={{ color: "var(--text)" }}>{last.offset_minutes} Min</b></>}
        </div>
      )}

      <div className="panel pad">
        {rows.map((it, i) => {
          const c = simColor(it.similarity_pct, it.is_origin);
          const left = Math.round((it.offset_minutes / maxOffset) * 100);
          return (
            <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12, alignItems: "center", marginBottom: 12 }}>
              <div style={{ textAlign: "right", fontSize: 13 }}>
                <b>{FLAG[it.country ?? ""] ?? ""} {it.outlet}</b>
              </div>
              <div style={{ position: "relative", height: 26 }}>
                <div style={{ position: "absolute", left: 0, top: "50%", height: 1, width: "100%", background: "var(--border)" }} />
                <div style={{ position: "absolute", left: `${left}%`, top: "50%", transform: "translate(-50%,-50%)", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                  <div style={{ width: 12, height: 12, borderRadius: "50%", background: c, boxShadow: `0 0 0 3px ${c}22` }} />
                  <span style={{ fontSize: 12, background: `${c}1f`, color: c, padding: "2px 9px", borderRadius: 99 }}>
                    {it.is_origin ? "zuerst" : `+${it.offset_minutes} Min · ${it.similarity_pct}% ähnlich`}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
        <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12, marginTop: 4 }}>
          <div />
          <div className="muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span>0</span><span>{Math.round(maxOffset / 2)} Min</span><span>{maxOffset} Min</span>
          </div>
        </div>
      </div>
    </div>
  );
}
