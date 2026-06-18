"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Lock, LockOpen, Video, FileText, Clock, ArrowLeft, External, Plus, Pencil, Folder } from "@/components/icons";
import { topicLabel } from "@/lib/topics";
import ScanTimeline from "@/components/ScanTimeline";
import ExtLink from "@/components/ExtLink";

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
type Snapshot = { id: number; captured_at: string; change_kind: string; title_old: string | null; title_new: string | null; added: string | null; added_count: number; removed_count: number; word_delta: number; pubdate_old: string | null; pubdate_new: string | null; changes: Change[] | null };

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
function timeDelta(isoA: string, isoB: string): string {
  const diff = Math.abs(new Date(isoB).getTime() - new Date(isoA).getTime());
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "unter 1 Min";
  if (mins < 60) return `${mins} Min`;
  const hours = Math.floor(mins / 60), remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}min` : `${hours}h`;
  const days = Math.floor(hours / 24), remH = hours % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
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
        supabase.from("article_snapshots").select("*").eq("article_id", id).order("captured_at", { ascending: true }),
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
        <ExtLink href={a.base_url} className="d-outlet">{a.outlet}</ExtLink>
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
        {a.published_at ? (
          <Stat k="Veröffentlicht" v={fmtDate(a.published_at)}
            sub={a.first_seen ? `Erfasst ${timeDelta(a.published_at, a.first_seen)} später` : undefined} />
        ) : (
          <Stat k="Veröffentlicht" v="Kein Datum vom Verlag" sub={a.first_seen ? `Erster Scan: ${fmtDate(a.first_seen)}` : undefined} />
        )}
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

      {/* Änderungsverlauf: chronologische Versions-Karten, alt/neu gegenübergestellt, in sich scrollbar */}
      <DL h="Änderungsverlauf">
        {snaps.length === 0 ? (
          <div className="empty">
            Noch keine Änderungen erfasst. Sobald margn den Artikel erneut besucht und sich Text,
            Überschrift oder Veröffentlichungsdatum ändern, erscheint hier der Verlauf — jede Version
            mit <strong>Vorher/Jetzt</strong>-Gegenüberstellung und Badges für
            <strong> unsichtbare Änderungen</strong> (Überschrift, Datum).
          </div>
        ) : (
          <div className="chist">
            {snaps.map((s, i) => <ChangeCard key={s.id} s={s} v={i + 1} />)}
          </div>
        )}
      </DL>

      <div style={{ marginTop: 28 }}>
        <ExtLink href={a.url} className="cta">Originalartikel öffnen <External size={15} /></ExtLink>
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
// Aus der OP-Liste rendern wir ZWEI getrennte Versionen statt eines gemischten
// Durchstreich-Texts: alte Seite zeigt eq + entfernte Wörter (rot), neue Seite zeigt
// eq + ergänzte/ersetzte Wörter (grün). „repl" = ersetztes Wort (gehört zur neuen Seite).
function SideOld({ ops }: { ops: Op[] }) {
  return <>{ops.map((s, x) =>
    s.op === "del" ? <del key={x} className="hl-rm">{s.t}</del>
    : s.op === "ins" || s.op === "repl" ? null
    : <span key={x}>{s.t}</span>)}</>;
}
function SideNew({ ops }: { ops: Op[] }) {
  return <>{ops.map((s, x) =>
    s.op === "ins" || s.op === "repl" ? <mark key={x} className="hl-add">{s.t}</mark>
    : s.op === "del" ? null
    : <span key={x}>{s.t}</span>)}</>;
}
// Zwei Versionen gegenübergestellt (Vorher | Jetzt) — geänderte Wörter je Seite dezent markiert.
function Juxta({ oldS, newS, label }: { oldS: string; newS: string; label: string }) {
  const ops = inlineOps(oldS, newS);
  return (
    <div className="chist-block">
      <div className="lbl">{label}</div>
      <div className="chist-2">
        <div className="chist-ver old"><span className="vlbl">Vorher</span><span><SideOld ops={ops} /></span></div>
        <div className="chist-ver new"><span className="vlbl">Jetzt</span><span><SideNew ops={ops} /></span></div>
      </div>
    </div>
  );
}

// Eine Version im Verlauf = eine Karte (chronologisch). Badges markieren auch unsichtbare
// Änderungen (Überschrift, Veröffentlichungsdatum), die auf den ersten Blick verborgen sind.
function ChangeCard({ s, v }: { s: Snapshot; v: number }) {
  const isEdit = s.change_kind === "edit";
  const kindLabel = s.change_kind === "extension" ? "Erweiterung" : isEdit ? "Stille Änderung" : "Geändert & erweitert";
  const Icon = isEdit ? Pencil : Plus;
  const cls = s.change_kind === "extension" ? "ok" : isEdit ? "lock" : "wait";
  const changes = (s.changes ?? []).filter((c) => c.old || c.new);
  const titleChanged = !!(s.title_old && s.title_new);
  const dateChanged = !!(s.pubdate_old && s.pubdate_new);
  return (
    <div className={`chist-card ${s.change_kind}`}>
      <div className="chist-head">
        <span className="chist-v">V{v}</span>
        <span className={`badge ${cls}`}><Icon /> {kindLabel}</span>
        <span className="chist-when">{fmtDate(s.captured_at)}</span>
        <span className="chist-chips">
          {titleChanged && <span className="chist-chip">Überschrift</span>}
          {dateChanged && <span className="chist-chip date">Datum</span>}
          {s.added_count > 0 && <span className="chist-chip add">+{s.added_count}&nbsp;Absatz{s.added_count > 1 ? "e" : ""}</span>}
          {s.removed_count > 0 && <span className="chist-chip del">−{s.removed_count}&nbsp;Absatz{s.removed_count > 1 ? "e" : ""}</span>}
          {s.word_delta ? <span className="chist-chip">{s.word_delta > 0 ? "+" : ""}{s.word_delta}&nbsp;W</span> : null}
        </span>
      </div>
      {dateChanged && (
        <div className="chist-date"><Clock size={14} /><span>Veröffentlichungsdatum still geändert — <b>vorher</b> {fmtDate(s.pubdate_old)} · <b>jetzt</b> {fmtDate(s.pubdate_new)}</span></div>
      )}
      {titleChanged && <Juxta oldS={s.title_old!} newS={s.title_new!} label="Überschrift" />}
      {changes.map((c, i) =>
        c.old && c.new ? <Juxta key={i} oldS={c.old} newS={c.new} label="Geänderte Passage" />
        : c.new ? (
          <div className="chist-block" key={i}>
            <div className="lbl add-l">Neu hinzugekommen</div>
            <div className="chist-ver new">{c.new}</div>
          </div>
        ) : (
          <div className="chist-block" key={i}>
            <div className="lbl del-l">Entfernt</div>
            <div className="chist-ver old">{c.old}</div>
          </div>
        )
      )}
      {changes.length === 0 && !titleChanged && s.added && (
        <div className="chist-block">
          <div className={`lbl ${isEdit ? "del-l" : "add-l"}`}>{isEdit ? "Geänderte Passage" : "Neu hinzugekommen"}</div>
          <div className={`chist-ver ${isEdit ? "old" : "new"}`}>{s.added.length > 700 ? s.added.slice(0, 700) + "…" : s.added}</div>
        </div>
      )}
      {changes.length === 0 && !titleChanged && !s.added && !dateChanged && s.removed_count > 0 && (
        <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>− {s.removed_count} Passage(n) entfernt</p>
      )}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
function DL({ h, children }: { h: string; children: React.ReactNode }) {
  return <div className="panel pad dl-section" style={{ marginTop: 14 }}><div className="h">{h}</div>{children}</div>;
}
