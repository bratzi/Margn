"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Lock, LockOpen, Video, FileText, Clock, ArrowLeft, External, Plus, Pencil, Folder } from "@/components/icons";
import { topicLabel } from "@/lib/topics";
import ScanTimeline from "@/components/ScanTimeline";

type Detail = {
  id: number; url: string; title: string | null; description: string | null; og_image: string | null;
  published_at: string | null; modified_at: string | null; paywalled: boolean | null;
  word_count: number | null; reading_min: number | null; article_type: string | null;
  lang_detected: string | null; first_seen: string | null; last_seen: string | null; author_status: string | null; topic: string | null;
  outlet: string; country: string; base_url: string; depth: number | null;
  revision_count: number | null; extension_count: number | null; edit_count: number | null;
  scan_count: number | null; scan_times: string[] | null;
};
type Change = { old?: string; new?: string };
type Snapshot = { id: number; captured_at: string; change_kind: string; title_old: string | null; title_new: string | null; added: string | null; added_count: number; removed_count: number; word_delta: number; changes: Change[] | null };

const LANG: Record<string, string> = { de: "Deutsch", fr: "Français", en: "English" };
const TYPE_LABEL: Record<string, string> = {
  news: "Nachricht", opinion: "Meinung", analysis: "Analyse", liveblog: "Liveblog", timeline: "Timeline-Artikel",
  review: "Rezension", reportage: "Reportage", interactive: "Interaktiv", interview: "Interview",
};

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtShort(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", year: "numeric" });
}

export default function ArticleDetail({ id }: { id: number }) {
  const [a, setA] = useState<Detail | null>(null);
  const [authors, setAuthors] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("article_detail").select("*").eq("id", id).single();
      if (!data) { setLoading(false); return; }
      setA(data as Detail);
      const [au, kw, cat, sn] = await Promise.all([
        supabase.from("article_authors").select("authors(name)").eq("article_id", id),
        supabase.from("article_keywords").select("keywords(term)").eq("article_id", id),
        supabase.from("article_categories").select("categories(name)").eq("article_id", id),
        supabase.from("article_snapshots").select("*").eq("article_id", id).order("captured_at", { ascending: false }),
      ]);
      setAuthors(((au.data ?? []) as any[]).map((r) => r.authors?.name).filter(Boolean));
      setKeywords(((kw.data ?? []) as any[]).map((r) => r.keywords?.term).filter(Boolean));
      setCategories(((cat.data ?? []) as any[]).map((r) => r.categories?.name).filter(Boolean));
      setSnaps((sn.data ?? []) as Snapshot[]);
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <div className="page"><p className="faint">Lade…</p></div>;
  if (!a) return <div className="page"><p className="faint">Artikel nicht gefunden.</p></div>;

  const segs = (() => { try { return new URL(a.url).pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean); } catch { return []; } })();
  const type = a.article_type ?? "news";

  return (
    <div className="page detail">
      <Link href="/articles" className="back"><ArrowLeft size={15} /> Alle Artikel</Link>

      {/* Kicker */}
      <div className="d-kicker">
        <a href={a.base_url} target="_blank" rel="noreferrer" className="d-outlet">{a.outlet}</a>
        <span className="cc">{a.country}</span>
        {a.topic && <span className="badge topicbadge"><Folder /> {topicLabel(a.topic)}</span>}
        <TypeBadge type={type} />
        {a.paywalled === true && <span className="badge lock"><Lock /> Paywall</span>}
        {a.paywalled === false && <span className="badge free"><LockOpen /> Frei zugänglich</span>}
      </div>

      <h1 className="d-title">{a.title ?? a.url.replace(/^https?:\/\/(www\.)?/, "")}</h1>
      {a.description && <p className="d-dek">{a.description}</p>}

      {/* Kategorien prominent */}
      {categories.length > 0 && (
        <div className="cat-banner">
          <span className="cat-label">Ressort</span>
          <div className="cat-chips">{categories.map((x) => <span key={x} className="cat-chip">{x}</span>)}</div>
        </div>
      )}

      {a.og_image && <div className="d-hero"><img src={a.og_image} alt="" /></div>}

      {/* Stats */}
      <div className="panel statbar">
        <Stat k="Veröffentlicht" v={fmtDate(a.published_at)} />
        {a.modified_at && a.modified_at !== a.published_at && <Stat k="Aktualisiert" v={fmtDate(a.modified_at)} />}
        {a.word_count ? <Stat k="Umfang" v={`${a.word_count.toLocaleString("de-DE")} Wörter`} /> : null}
        {a.reading_min ? <Stat k="Lesezeit" v={`${a.reading_min} Min`} /> : null}
        <Stat k="Sprache" v={LANG[a.lang_detected ?? ""] ?? a.lang_detected ?? "—"} />
      </div>

      {/* Scan-Timeline */}
      <DL h="Scan-Verlauf">
        <ScanTimeline firstSeen={a.first_seen} lastSeen={a.last_seen} scanTimes={a.scan_times} scanCount={a.scan_count}
          changeTimes={snaps.map((s) => s.captured_at)} />
      </DL>

      <DL h="Autoren">
        {a.author_status === "named" && authors.length > 0
          ? <div className="row">{authors.map((x) => <span key={x} className="tag a">{x}</span>)}</div>
          : a.author_status === "anonymous"
          ? <span className="badge wait">Redaktion / Agentur{authors.length ? ` · ${authors.join(", ")}` : ""}</span>
          : <span className="badge neutral">Kein Autor genannt</span>}
      </DL>
      <DL h={`Schlagwörter${keywords.length ? ` · ${keywords.length}` : ""}`}>
        {keywords.length > 0
          ? <div className="row">{keywords.map((x) => <span key={x} className="tag">{x}</span>)}</div>
          : <span className="faint" style={{ fontSize: 13 }}>Keine Schlagwörter im Quelltext gefunden (oder noch nicht erfasst).</span>}
      </DL>

      {/* Seitenbaum */}
      {segs.length > 0 && (
        <DL h="Position im Seitenbaum">
          <div className="crumb">
            <span className="seg">{a.base_url.replace(/^https?:\/\/(www\.)?/, "")}</span>
            {segs.map((s, i) => (
              <span key={i} style={{ display: "inline-flex", alignItems: "center" }}>
                <span className="sep">/</span><span className={`seg ${i === segs.length - 1 ? "last" : ""}`}>{s}</span>
              </span>
            ))}
          </div>
          {a.depth != null && <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>Tiefe: {a.depth} {a.depth === 1 ? "Ebene" : "Ebenen"} von der Startseite</p>}
        </DL>
      )}

      {/* Änderungsverlauf / Timeline */}
      <DL h="Änderungsverlauf">
        {snaps.length === 0 ? (
          <div className="empty">
            Noch keine Änderungen erfasst. Sobald margn den Artikel erneut besucht und sich Text oder
            Überschrift ändern, erscheint hier eine Zeitleiste — mit Unterscheidung zwischen
            <strong> Erweiterungen</strong> (neu hinzugefügte Passagen) und <strong> stillen Änderungen</strong> (nachträglich überarbeitete Stellen).
          </div>
        ) : (
          <>
            <div className="diff-legend">
              <span><mark className="hl-add">grün</mark> = neu hinzugekommen</span>
              <span><mark className="hl">gelb</mark> = ersetzt</span>
              <span><del className="hl-rm">rot</del> = entfernt</span>
            </div>
            <div className="tl">
              {snaps.map((s) => <TimelineItem key={s.id} s={s} />)}
            </div>
          </>
        )}
      </DL>

      <div style={{ marginTop: 28 }}>
        <a href={a.url} target="_blank" rel="noreferrer" className="cta">Originalartikel öffnen <External size={15} /></a>
      </div>
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  const label = TYPE_LABEL[type] ?? type;
  if (type === "liveblog" || type === "timeline") return <span className="badge info"><Clock /> {label}</span>;
  if (type === "interactive") return <span className="badge media"><Video /> {label}</span>;
  return <span className="badge neutral"><FileText /> {label}</span>;
}

// Inline-Wort-Diff (LCS): EIN durchgehender Text, in dem nur die geänderten Wörter
// markiert sind — entfernt = rot durchgestrichen, neu = grün, ersetzt = gelb.
type Op = { t: string; op: "eq" | "del" | "ins" | "repl" };
function inlineOps(oldS: string, newS: string): Op[] {
  const o = oldS.split(/(\s+)/).filter((x) => x !== ""), n = newS.split(/(\s+)/).filter((x) => x !== "");
  const m = o.length, k = n.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--)
    dp[i][j] = o[i] === n[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw: Op[] = []; let i = 0, j = 0;
  while (i < m || j < k) {
    if (i < m && j < k && o[i] === n[j]) { raw.push({ t: o[i], op: "eq" }); i++; j++; }
    else if (j < k && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) { raw.push({ t: n[j], op: "ins" }); j++; }
    else { raw.push({ t: o[i], op: "del" }); i++; }
  }
  // Whitespace zwischen gleichartigen Änderungen mitfärben (durchgehender Marker)
  for (let x = 1; x < raw.length - 1; x++) if (/^\s+$/.test(raw[x].t) && raw[x].op === "eq" && raw[x - 1].op === raw[x + 1].op && raw[x - 1].op !== "eq") raw[x].op = raw[x - 1].op;
  // Segmente bilden; del unmittelbar gefolgt von ins = Ersetzung → ins als "repl" (gelb).
  const segs: Op[] = [];
  for (const r of raw) { const l = segs[segs.length - 1]; if (l && l.op === r.op) l.t += r.t; else segs.push({ ...r }); }
  for (let x = 1; x < segs.length; x++) if (segs[x].op === "ins" && segs[x - 1].op === "del") segs[x].op = "repl";
  return segs;
}
function InlineDiff({ oldS, newS }: { oldS: string; newS: string }) {
  return <>{inlineOps(oldS, newS).map((s, x) =>
    s.op === "del" ? <del key={x} className="hl-rm">{s.t}</del>
    : s.op === "ins" ? <mark key={x} className="hl-add">{s.t}</mark>
    : s.op === "repl" ? <mark key={x} className="hl">{s.t}</mark>
    : <span key={x}>{s.t}</span>)}</>;
}
// Eine geänderte/neue/entfernte Passage rendern.
function ChangePassage({ c }: { c: Change }) {
  if (c.old && c.new) return <div className="tl-passage edit"><span className="pk">✎ Geändert</span><span className="diff-body"><InlineDiff oldS={c.old} newS={c.new} /></span></div>;
  if (c.new) return <div className="tl-passage add"><span className="pk">+ Neu hinzugekommen</span><span className="diff-body"><mark className="hl-add">{c.new}</mark></span></div>;
  return <div className="tl-passage del"><span className="pk">− Entfernt</span><span className="diff-body"><del className="hl-rm">{c.old}</del></span></div>;
}

function TimelineItem({ s }: { s: Snapshot }) {
  const kindLabel = s.change_kind === "extension" ? "Erweiterung" : s.change_kind === "edit" ? "Stille Änderung" : "Geändert & erweitert";
  const Icon = s.change_kind === "edit" ? Pencil : Plus;
  const cls = s.change_kind === "extension" ? "ok" : s.change_kind === "edit" ? "lock" : "wait";
  const changes = (s.changes ?? []).filter((c) => c.old || c.new);
  return (
    <div className="tl-item">
      <span className={`tl-dot ${s.change_kind}`} />
      <div className="tl-head">
        <span className={`badge ${cls}`}><Icon /> {kindLabel}</span>
        <span className="tl-when">{fmtDate(s.captured_at)}</span>
        {s.word_delta ? <span className="faint" style={{ fontSize: 12.5 }}>{s.word_delta > 0 ? "+" : ""}{s.word_delta} Wörter</span> : null}
      </div>
      {s.title_old && s.title_new && (
        <div className="tl-title-change"><span className="diff-lbl">Überschrift</span><span className="new"><InlineDiff oldS={s.title_old} newS={s.title_new} /></span></div>
      )}
      {changes.length > 0
        ? changes.map((c, x) => <ChangePassage key={x} c={c} />)
        : s.added ? (
          // Fallback für Altdaten ohne strukturierten Diff: ganze Passage (ohne Vollmarkierung)
          <div className={`tl-passage ${s.change_kind === "edit" ? "edit" : "add"}`}>
            <span className="pk">{s.change_kind === "edit" ? "✎ Geänderte Passage" : "+ Neu hinzugekommen"}</span>
            <span className="diff-body">{s.added.length > 700 ? s.added.slice(0, 700) + "…" : s.added}</span>
          </div>
        ) : s.removed_count > 0 ? <p className="rm-note">− {s.removed_count} Passage(n) entfernt</p> : null}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return <div className="stat"><div className="k">{k}</div><div className="v">{v}</div></div>;
}
function DL({ h, children }: { h: string; children: React.ReactNode }) {
  return <div className="panel pad dl-section" style={{ marginTop: 14 }}><div className="h">{h}</div>{children}</div>;
}
