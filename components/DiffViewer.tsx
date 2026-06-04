"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { wordDiff, classifyEdit, type EditKind } from "@/lib/diff";

type EditRow = {
  id: number; url: string; outlet: string; country: string | null;
  before_title: string; after_title: string; delay_minutes: number | null; scanned_at: string;
};

const FILTERS: { key: EditKind | "all"; label: string }[] = [
  { key: "all", label: "Alle" },
  { key: "toned_down", label: "Entschärft" },
  { key: "sharpened", label: "Zugespitzt" },
  { key: "factual", label: "Faktenkorrektur" },
];
const KIND: Record<EditKind, { label: string; color: string }> = {
  toned_down: { label: "entschärft", color: "#5b8cff" },
  sharpened: { label: "zugespitzt", color: "#f4607a" },
  factual: { label: "faktenkorrektur", color: "#f0b429" },
  other: { label: "geändert", color: "#9aa4b2" },
};
const FLAG: Record<string, string> = { DE: "🇩🇪", FR: "🇫🇷" };

function delayLabel(min: number | null) {
  if (min == null) return "";
  return min < 60 ? `${min} Min nach Erstmeldung` : `${Math.round(min / 60)} Std nach Erstmeldung`;
}

export default function DiffViewer() {
  const [rows, setRows] = useState<EditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<EditKind | "all">("all");

  useEffect(() => {
    supabase.from("headline_edits")
      .select("id,url,outlet,country,before_title,after_title,delay_minutes,scanned_at")
      .order("scanned_at", { ascending: false }).limit(80)
      .then(({ data }) => { setRows((data as EditRow[]) ?? []); setLoading(false); });
  }, []);

  const enriched = useMemo(() => rows.map((r) => ({
    ...r, kind: classifyEdit(r.before_title, r.after_title), diff: wordDiff(r.before_title, r.after_title),
  })), [rows]);
  const shown = enriched.filter((e) => active === "all" || e.kind === active);

  if (loading) return <p className="muted">Lade geänderte Überschriften…</p>;
  if (!rows.length) return (
    <div className="panel pad muted">
      Noch keine stillen Edits erfasst. Diese entstehen über die Zeit: sobald ein Artikel mehrfach
      gescannt wurde und sich die Überschrift zwischen zwei Scans ändert, erscheint er hier.
    </div>
  );

  return (
    <div>
      <div className="seg" style={{ marginBottom: 16 }}>
        {FILTERS.map((f) => (
          <button key={f.key} className={active === f.key ? "on" : ""} onClick={() => setActive(f.key)}>{f.label}</button>
        ))}
      </div>

      {shown.map((e) => {
        const k = KIND[e.kind];
        return (
          <div className="panel pad" key={e.id} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <a href={e.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600, color: "var(--text)" }}>
                {FLAG[e.country ?? ""] ?? ""} {e.outlet}
              </a>
              <span className="badge" style={{ background: `${k.color}22`, color: k.color }}>{k.label}</span>
              <span className="muted" style={{ marginLeft: "auto", fontSize: 12.5 }}>{delayLabel(e.delay_minutes)}</span>
            </div>
            <DiffLine label="VORHER" tokens={e.diff.before} accent="var(--text-faint)" />
            <DiffLine label="NACHHER" tokens={e.diff.after} accent={k.color} />
          </div>
        );
      })}
    </div>
  );
}

function DiffLine({ label, tokens, accent }: { label: string; tokens: { text: string; changed: boolean }[]; accent: string }) {
  return (
    <div style={{ fontSize: 14, lineHeight: 1.6, padding: "9px 12px", borderLeft: `3px solid ${accent}`, background: "var(--panel-2)", borderRadius: 6, marginBottom: 8 }}>
      <span className="muted" style={{ fontSize: 10.5, letterSpacing: ".05em", display: "block", marginBottom: 4 }}>{label}</span>
      {tokens.map((t, i) => (
        <span key={i} style={t.changed ? { background: "rgba(244,96,122,.22)", borderRadius: 3, padding: "0 3px", fontWeight: 600 } : undefined}>
          {t.text}{" "}
        </span>
      ))}
    </div>
  );
}
