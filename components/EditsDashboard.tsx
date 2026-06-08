"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Plus, Pencil } from "@/components/icons";

type Edit = {
  article_id: number; url: string; title: string;
  source_id: number; outlet: string; country: string;
  change_count: number; edit_count: number; extension_count: number; mixed_count: number;
  last_change: string; first_seen: string;
};
type Change = {
  id: number; article_id: number; captured_at: string; change_kind: string;
  title_old: string | null; title_new: string | null; added: string | null;
  added_count: number; removed_count: number; word_delta: number;
  title: string; url: string; source_id: number; outlet: string; country: string;
};

const fmt = (iso: string) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
const shortUrl = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return u; } };

export default function EditsDashboard() {
  const [edits, setEdits] = useState<Edit[]>([]);
  const [changes, setChanges] = useState<Change[]>([]);
  const [sortBy, setSortBy] = useState<"changes" | "edits" | "extensions" | "date">("changes");
  const [kind, setKind] = useState<"all" | "title" | "extension">("all");

  useEffect(() => {
    supabase.from("article_edits_summary").select("*").order("change_count", { ascending: false }).limit(500)
      .then(({ data }) => setEdits((data as Edit[]) ?? []));
    supabase.from("recent_changes").select("*").order("captured_at", { ascending: false }).limit(120)
      .then(({ data }) => setChanges((data as Change[]) ?? []));
  }, []);

  const sorted = useMemo(() => {
    const arr = [...edits];
    if (sortBy === "changes") arr.sort((a, b) => b.change_count - a.change_count);
    else if (sortBy === "edits") arr.sort((a, b) => b.edit_count - a.edit_count);
    else if (sortBy === "extensions") arr.sort((a, b) => b.extension_count - a.extension_count);
    else arr.sort((a, b) => new Date(b.last_change).getTime() - new Date(a.last_change).getTime());
    return arr;
  }, [edits, sortBy]);

  const visChanges = useMemo(() => changes.filter((c) => {
    if (kind === "title") return c.title_old && c.title_new && c.title_old !== c.title_new;
    if (kind === "extension") return c.word_delta > 50;
    return true;
  }), [changes, kind]);

  const byPublisher = useMemo(() => {
    const m = new Map<number, { count: number; edits: number; extensions: number; outlet: string }>();
    for (const e of edits) {
      const cur = m.get(e.source_id) || { count: 0, edits: 0, extensions: 0, outlet: e.outlet };
      m.set(e.source_id, { count: cur.count + e.change_count, edits: cur.edits + e.edit_count, extensions: cur.extensions + e.extension_count, outlet: e.outlet });
    }
    return [...m.entries()].map(([id, s]) => ({ id, ...s })).sort((a, b) => b.count - a.count);
  }, [edits]);

  const stats = useMemo(() => ({
    changes: edits.reduce((s, e) => s + Number(e.change_count), 0),
    titleEdits: changes.filter((c) => c.title_old && c.title_new && c.title_old !== c.title_new).length,
    extensions: changes.filter((c) => c.word_delta > 50).length,
    articles: edits.length,
  }), [edits, changes]);

  return (
    <div className="with-rail">
      <div className="page">
        <div className="kpi-strip">
          <div className="stat-tile"><div className="l">Änderungen erfasst</div><div className="n tnum">{stats.changes.toLocaleString("de-DE")}</div><div className="sub">in {stats.articles} Artikeln</div></div>
          <div className="stat-tile"><div className="l">Stille Titeländerungen</div><div className="n tnum" style={{ color: "var(--red)" }}>{stats.titleEdits}</div><div className="sub">Überschrift nachträglich geändert</div></div>
          <div className="stat-tile"><div className="l">Texterweiterungen</div><div className="n tnum" style={{ color: "var(--green)" }}>{stats.extensions}</div><div className="sub">neue Passagen ergänzt</div></div>
          <div className="stat-tile accent"><div className="l">Ø Änderungen/Artikel</div><div className="n tnum">{stats.articles ? (stats.changes / stats.articles).toFixed(1) : "—"}</div><div className="sub">Durchschnitt</div></div>
        </div>

        {/* Echter Änderungsverlauf */}
        <h2 className="section-h" style={{ alignItems: "center" }}>Änderungsverlauf <span className="count">{visChanges.length} Änderungen</span>
          <span className="count" style={{ marginLeft: "auto" }}>
            <button onClick={() => setKind("all")} className={kind === "all" ? "active" : ""}>Alle</button>
            <button onClick={() => setKind("title")} className={kind === "title" ? "active" : ""}>Titeländerung</button>
            <button onClick={() => setKind("extension")} className={kind === "extension" ? "active" : ""}>Erweiterung</button>
          </span>
        </h2>
        <div className="panel pad">
          {visChanges.length === 0 ? <p className="faint">Keine Änderungen in dieser Kategorie.</p> : (
            <div className="tl">
              {visChanges.map((c) => <ChangeItem key={c.id} c={c} />)}
            </div>
          )}
        </div>

        {/* Pro Publizist */}
        <h2 className="section-h">Änderungen pro Publizist</h2>
        <div className="panel" style={{ overflowX: "auto" }}>
          <table className="matrix">
            <thead><tr><th>Verlag</th><th>Änderungen</th><th>Stille Edits</th><th>Erweiterungen</th></tr></thead>
            <tbody>
              {byPublisher.map((p) => (
                <tr key={p.id}>
                  <td className="pub"><Link href={`/articles?source_id=${p.id}`} style={{ color: "var(--accent)" }}>{p.outlet}</Link></td>
                  <td className="tnum"><strong>{p.count.toLocaleString("de-DE")}</strong></td>
                  <td className="tnum"><span style={{ color: "var(--red)" }}>{p.edits}</span></td>
                  <td className="tnum"><span style={{ color: "var(--green)" }}>{p.extensions}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pro Artikel */}
        <h2 className="section-h" style={{ alignItems: "center" }}>Artikel mit meisten Änderungen
          <span className="count" style={{ marginLeft: "auto" }}>
            <button onClick={() => setSortBy("changes")} className={sortBy === "changes" ? "active" : ""}>Gesamt</button>
            <button onClick={() => setSortBy("edits")} className={sortBy === "edits" ? "active" : ""}>Edits</button>
            <button onClick={() => setSortBy("extensions")} className={sortBy === "extensions" ? "active" : ""}>Erweit.</button>
            <button onClick={() => setSortBy("date")} className={sortBy === "date" ? "active" : ""}>Datum</button>
          </span>
        </h2>
        <div className="panel" style={{ overflowX: "auto" }}>
          <table className="matrix">
            <thead><tr><th>Artikel</th><th>Verlag</th><th>Ges.</th><th>Edit</th><th>Erweit.</th><th>Letzte</th></tr></thead>
            <tbody>
              {sorted.slice(0, 80).map((e) => (
                <tr key={e.article_id}>
                  <td><Link href={`/articles/${e.article_id}`} target="_blank" className="url mono" title={e.title} style={{ maxWidth: "38vw", display: "inline-block" }}>{e.title?.slice(0, 70) || shortUrl(e.url)}</Link></td>
                  <td className="cell-nowrap">{e.outlet}</td>
                  <td className="tnum"><strong>{e.change_count}</strong></td>
                  <td className="tnum"><span style={{ color: e.edit_count > 0 ? "var(--red)" : "var(--faint)" }}>{e.edit_count}</span></td>
                  <td className="tnum"><span style={{ color: e.extension_count > 0 ? "var(--green)" : "var(--faint)" }}>{e.extension_count}</span></td>
                  <td className="tnum faint cell-nowrap">{fmt(e.last_change)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ChangeItem({ c }: { c: Change }) {
  const titleChanged = c.title_old && c.title_new && c.title_old !== c.title_new;
  const kindLabel = titleChanged ? "Titeländerung" : c.change_kind === "extension" ? "Erweiterung" : c.change_kind === "edit" ? "Stille Änderung" : "Geändert & erweitert";
  const Icon = titleChanged || c.change_kind === "edit" ? Pencil : Plus;
  const cls = titleChanged ? "lock" : c.change_kind === "extension" ? "ok" : "wait";
  return (
    <div className="tl-item">
      <span className={`tl-dot ${c.change_kind}`} />
      <div className="tl-head">
        <Link href={`/articles/${c.article_id}`} target="_blank" style={{ fontWeight: 600, color: "var(--ink)" }}>{c.outlet}</Link>
        <span className={`badge ${cls}`}><Icon /> {kindLabel}</span>
        <span className="tl-when">{fmt(c.captured_at)}</span>
        {c.word_delta ? <span className="faint" style={{ fontSize: 12 }}>{c.word_delta > 0 ? "+" : ""}{c.word_delta} Wörter</span> : null}
      </div>
      {titleChanged ? (
        <div className="tl-title-change"><span className="old">{c.title_old}</span><br /><span className="new">{c.title_new}</span></div>
      ) : (
        <Link href={`/articles/${c.article_id}`} target="_blank" style={{ fontSize: 13.5, color: "var(--ink)", display: "block", marginTop: 2 }}>{c.title?.slice(0, 110)}</Link>
      )}
      {c.added && c.word_delta > 50 && <div className="tl-passage add">{c.added.length > 400 ? c.added.slice(0, 400) + "…" : c.added}</div>}
    </div>
  );
}
