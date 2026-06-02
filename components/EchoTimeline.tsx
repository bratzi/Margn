"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";

type EchoRow = {
  cluster_id: number;
  outlet: string;
  country: string | null;
  similarity_pct: number;
  is_origin: boolean;
  offset_minutes: number;
};

type ClusterRow = { id: number; label: string | null };

function simColor(sim: number, isOrigin: boolean) {
  if (isOrigin) return { bg: "#E1F5EE", fg: "#0F6E56", accent: "#1D9E75" };
  if (sim >= 90) return { bg: "#FAECE7", fg: "#712B13", accent: "#D85A30" };
  if (sim >= 80) return { bg: "#FAEEDA", fg: "#633806", accent: "#BA7517" };
  return { bg: "#F1EFE8", fg: "#444441", accent: "#888780" };
}

export default function EchoTimeline() {
  const [clusters, setClusters] = useState<ClusterRow[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [rows, setRows] = useState<EchoRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Cluster mit mehr als einem Mitglied laden (nur die sind als "Echo" interessant)
  useEffect(() => {
    supabase
      .from("story_clusters")
      .select("id,label")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (error) console.error(error);
        const cs = (data as ClusterRow[]) ?? [];
        setClusters(cs);
        if (cs.length) setSelected(cs[0].id);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (selected == null) return;
    supabase
      .from("cluster_echoes")
      .select("cluster_id,outlet,country,similarity_pct,is_origin,offset_minutes")
      .eq("cluster_id", selected)
      .order("offset_minutes", { ascending: true })
      .then(({ data, error }) => {
        if (error) console.error(error);
        setRows((data as EchoRow[]) ?? []);
      });
  }, [selected]);

  const maxOffset = useMemo(() => Math.max(60, ...rows.map((r) => r.offset_minutes)), [rows]);
  const origin = rows.find((r) => r.is_origin);
  const echoes = rows.filter((r) => !r.is_origin);
  const last = rows[rows.length - 1];

  if (loading) return <p style={{ color: "var(--color-text-secondary)" }}>Lade Story-Cluster…</p>;
  if (!clusters.length) return <p style={{ color: "var(--color-text-secondary)" }}>Noch keine Cluster gebildet.</p>;

  return (
    <div>
      <div style={{ marginBottom: "1rem" }}>
        <label style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>Story</label>
        <select
          value={selected ?? undefined}
          onChange={(e) => setSelected(Number(e.target.value))}
          style={{ marginLeft: 8, minWidth: 280 }}
        >
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label ?? `Cluster #${c.id}`}
            </option>
          ))}
        </select>
      </div>

      {origin && (
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: "1.25rem" }}>
          Ursprung: <strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{origin.outlet}</strong> ·{" "}
          {echoes.length} weitere Blätter zogen nach
          {last && (
            <>
              {" "}· letzter Nachzügler nach{" "}
              <strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{last.offset_minutes} Min</strong>
            </>
          )}
        </div>
      )}

      {rows.map((it, i) => {
        const c = simColor(it.similarity_pct, it.is_origin);
        const pct = Math.round((it.offset_minutes / maxOffset) * 100);
        return (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12, alignItems: "center", marginBottom: 10 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{it.outlet}</div>
              {it.country && <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{it.country}</div>}
            </div>
            <div style={{ position: "relative", height: 32 }}>
              <div style={{ position: "absolute", left: 0, top: "50%", height: "0.5px", width: "100%", background: "var(--color-border-tertiary)" }} />
              <div
                style={{
                  position: "absolute",
                  left: `${pct}%`,
                  top: "50%",
                  transform: "translate(-50%,-50%)",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  whiteSpace: "nowrap",
                }}
              >
                <div style={{ width: 14, height: 14, borderRadius: "50%", background: c.bg, border: `2px solid ${c.accent}` }} />
                <span style={{ fontSize: 12, background: c.bg, color: c.fg, padding: "2px 9px", borderRadius: "var(--border-radius-md)" }}>
                  {it.is_origin ? "zuerst" : `+${it.offset_minutes} Min · ${it.similarity_pct}% ähnlich`}
                </span>
              </div>
            </div>
          </div>
        );
      })}

      <div style={{ display: "grid", gridTemplateColumns: "150px 1fr", gap: 12, marginTop: 6 }}>
        <div />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-tertiary)" }}>
          <span>0</span>
          <span>{Math.round(maxOffset / 2)} Min</span>
          <span>{maxOffset} Min nach Erstmeldung</span>
        </div>
      </div>
    </div>
  );
}
