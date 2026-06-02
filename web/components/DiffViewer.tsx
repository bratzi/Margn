"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { wordDiff, classifyEdit, KIND_META, type EditKind } from "@/lib/diff";

type EditRow = {
  id: number;
  url: string;
  outlet: string;
  country: string | null;
  before_title: string;
  after_title: string;
  delay_minutes: number | null;
};

const FILTERS: { key: EditKind | "all"; label: string }[] = [
  { key: "all", label: "alle" },
  { key: "toned_down", label: "entschärft" },
  { key: "sharpened", label: "zugespitzt" },
  { key: "factual", label: "faktenkorrektur" },
];

function delayLabel(min: number | null): string {
  if (min == null) return "";
  if (min < 60) return `${min} Min nach Veröffentlichung`;
  return `${Math.round(min / 60)} Std nach Veröffentlichung`;
}

export default function DiffViewer() {
  const [rows, setRows] = useState<EditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<EditKind | "all">("all");

  useEffect(() => {
    supabase
      .from("headline_edits")
      .select("id,url,outlet,country,before_title,after_title,delay_minutes")
      .order("scanned_at", { ascending: false })
      .limit(50)
      .then(({ data, error }) => {
        if (error) console.error(error);
        setRows((data as EditRow[]) ?? []);
        setLoading(false);
      });
  }, []);

  const enriched = useMemo(
    () =>
      rows.map((r) => ({
        ...r,
        kind: classifyEdit(r.before_title, r.after_title),
        diff: wordDiff(r.before_title, r.after_title),
      })),
    [rows]
  );

  const shown = enriched.filter((e) => active === "all" || e.kind === active);

  if (loading) return <p style={{ color: "var(--color-text-secondary)" }}>Lade geänderte Überschriften…</p>;
  if (!rows.length) return <p style={{ color: "var(--color-text-secondary)" }}>Noch keine geänderten Überschriften erfasst.</p>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "1.25rem" }}>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setActive(f.key)}
            style={{
              fontSize: 13,
              padding: "6px 14px",
              borderRadius: "var(--border-radius-md)",
              border: "0.5px solid var(--color-border-secondary)",
              background: "transparent",
              cursor: "pointer",
              fontWeight: active === f.key ? 500 : 400,
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.map((e) => {
        const k = KIND_META[e.kind];
        return (
          <div
            key={e.id}
            style={{
              background: "var(--color-background-primary)",
              border: "0.5px solid var(--color-border-tertiary)",
              borderRadius: "var(--border-radius-lg)",
              padding: "1rem 1.25rem",
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <a href={e.url} style={{ fontWeight: 500, fontSize: 15, textDecoration: "none", color: "var(--color-text-primary)" }}>
                {e.outlet}
              </a>
              {e.country && <span style={{ fontSize: 12, color: "var(--color-text-tertiary)" }}>{e.country}</span>}
              <span style={{ fontSize: 12, background: k.bg, color: k.fg, padding: "3px 10px", borderRadius: "var(--border-radius-md)" }}>
                {k.label}
              </span>
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--color-text-tertiary)" }}>
                {delayLabel(e.delay_minutes)}
              </span>
            </div>

            <DiffLine label="VORHER" tokens={e.diff.before} accent="var(--color-border-tertiary)" />
            <DiffLine label="NACHHER" tokens={e.diff.after} accent={k.accent} />
          </div>
        );
      })}
    </div>
  );
}

function DiffLine({ label, tokens, accent }: { label: string; tokens: { text: string; changed: boolean }[]; accent: string }) {
  return (
    <div
      style={{
        fontSize: 14,
        lineHeight: 1.6,
        padding: "10px 12px",
        borderLeft: `3px solid ${accent}`,
        background: "var(--color-background-secondary)",
        marginBottom: 8,
      }}
    >
      <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", display: "block", marginBottom: 4 }}>{label}</span>
      {tokens.map((t, i) => (
        <span
          key={i}
          style={
            t.changed
              ? { background: "rgba(216,90,48,0.18)", borderRadius: 3, padding: "0 2px", fontWeight: 500 }
              : undefined
          }
        >
          {t.text}{" "}
        </span>
      ))}
    </div>
  );
}
