"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Lock, LockOpen, Video, FileText, Clock, ArrowLeft, External, Plus, Pencil, Folder } from "@/components/icons";
import { topicLabel } from "@/lib/topics";
import { ALLOWED_PTYPES } from "@/lib/filterCorpus";
import ScanTimeline from "@/components/ScanTimeline";
import ExtLink from "@/components/ExtLink";

type Detail = {
  id: number; source_id: number; url: string; title: string | null; description: string | null; og_image: string | null;
  published_at: string | null; modified_at: string | null; paywalled: boolean | null;
  word_count: number | null; reading_min: number | null; article_type: string | null;
  lang_detected: string | null; first_seen: string | null; last_seen: string | null; author_status: string | null; topic: string | null;
  outlet: string; country: string; base_url: string; depth: number | null;
  revision_count: number | null; extension_count: number | null; edit_count: number | null;
  scan_count: number | null; scan_times: string[] | null;
};
type Change = { old?: string; new?: string };
type Pctl = { label: string; verb: string; pct: number; n: number };
type Neighbor = { articleId: number; title: string | null; outlet: string; country: string | null; shared: string[]; cross: boolean };
type MetaEdit = { field: string; old: string | null; new: string | null };
type Snapshot = { id: number; captured_at: string; change_kind: string; title_old: string | null; title_new: string | null; added: string | null; added_count: number; removed_count: number; word_delta: number; pubdate_old: string | null; pubdate_new: string | null; changes: Change[] | null; meta_edits: MetaEdit[] | null };

const LANG: Record<string, string> = { de: "Deutsch", fr: "Français", en: "English" };
const TYPE_LABEL: Record<string, string> = {
  news: "Nachricht", opinion: "Meinung", analysis: "Analyse", liveblog: "Liveblog", timeline: "Timeline-Artikel",
  review: "Rezension", reportage: "Reportage", interactive: "Interaktiv", interview: "Interview",
};
// Unsichtbare Metadaten-Edits: Feld-Schlüssel → kurzes Chip-Label.
const META_LABEL: Record<string, string> = { description: "Teaser", og_image: "Bild", topic: "Ressort", paywalled: "Paywall", author_status: "Autor" };
const AUTHOR_STATUS_LABEL: Record<string, string> = { named: "namentlich", anonymous: "Redaktion/Agentur", none: "kein Autor" };

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtShort(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", year: "numeric" });
}
// Eine Zeitspanne (ms) menschenlesbar: Min → h → d. Quelle der Wahrheit für alle
// abgeleiteten Dauer-Angaben auf der Detailseite.
function durStr(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "unter 1 Min";
  if (mins < 60) return `${mins} Min`;
  const hours = Math.floor(mins / 60), remMins = mins % 60;
  if (hours < 48) return remMins > 0 ? `${hours}h ${remMins}min` : `${hours}h`;
  const days = Math.floor(hours / 24), remH = hours % 24;
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}
function timeDelta(isoA: string, isoB: string): string {
  return durStr(Math.abs(new Date(isoB).getTime() - new Date(isoA).getTime()));
}

export default function ArticleDetail({ id }: { id: number }) {
  const [a, setA] = useState<Detail | null>(null);
  const [authors, setAuthors] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [pctls, setPctls] = useState<Pctl[] | null>(null);
  const [neighbors, setNeighbors] = useState<Neighbor[] | null>(null);
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

  // Einordnung: wie dieser Artikel im Vergleich zu seinen Peers liegt (gleiche Quelle,
  // gleiches Thema). Reine COUNT-Queries (head:true) gegen page_overview — günstig, kein
  // Datentransfer. Perzentil = Anteil der Peers, die unter dem eigenen Wert liegen.
  useEffect(() => {
    if (!a) return;
    let cancelled = false;
    (async () => {
      const wc = a.word_count, rc = a.revision_count ?? 0, sid = a.source_id, topic = a.topic;
      // Vergleichsbasis: nur echte journalistische Seiten, die schon analysiert sind (word_count gesetzt).
      const base = (q: any) => q.in("ptype", ALLOWED_PTYPES).not("word_count", "is", null);
      const cnt = async (mut: (q: any) => any) => {
        const { count } = await mut(supabase.from("page_overview").select("id", { count: "exact", head: true }));
        return count ?? 0;
      };
      const jobs: Promise<Pctl | null>[] = [];
      const mk = async (label: string, verb: string, minN: number, total: () => Promise<number>, below: () => Promise<number>): Promise<Pctl | null> => {
        const [tot, blw] = await Promise.all([total(), below()]);
        return tot >= minN ? { label, verb, pct: Math.round((blw / tot) * 100), n: tot } : null;
      };
      if (wc != null) {
        jobs.push(mk(`Länge · ${a.outlet}`, "länger als", 5,
          () => cnt((q) => base(q).eq("source_id", sid)),
          () => cnt((q) => base(q).eq("source_id", sid).lt("word_count", wc))));
        if (topic) jobs.push(mk(`Länge · Thema ${topicLabel(topic)}`, "länger als", 8,
          () => cnt((q) => base(q).eq("topic", topic)),
          () => cnt((q) => base(q).eq("topic", topic).lt("word_count", wc))));
      }
      if (rc > 0) {
        // revision_count ist bei unveränderten Artikeln NULL → als 0 (= unter rc) werten.
        jobs.push(mk(`Bearbeitung · ${a.outlet}`, "öfter geändert als", 5,
          () => cnt((q) => base(q).eq("source_id", sid)),
          () => cnt((q) => base(q).eq("source_id", sid).or(`revision_count.lt.${rc},revision_count.is.null`))));
      }
      const res = (await Promise.all(jobs)).filter(Boolean) as Pctl[];
      if (!cancelled) setPctls(res);
    })();
    return () => { cancelled = true; };
  }, [a?.id]);

  // Thematische Nachbarn: andere Artikel, die viele Schlagwörter teilen → Hinweis auf
  // dieselbe Story / gemeinsames Framing (Kernkonzept). Geteilte Keywords werden per
  // inverser Dokumentfrequenz gewichtet (IDF, 1/√df) — seltene, spezifische Begriffe
  // (z.B. „eu-haushalt") wiegen schwer, allgegenwärtige („ukraine") kaum; ultragenerische
  // (df > 1200) fallen ganz raus. So dominieren echte Story-Nachbarn statt Themen-Rauschen.
  useEffect(() => {
    if (!a) return;
    let cancelled = false;
    (async () => {
      const self = a.id;
      const { data: kwRows } = await supabase.from("article_keywords").select("keyword_id, keywords(term)").eq("article_id", self);
      const myKw = ((kwRows ?? []) as any[]).map((r) => ({ id: r.keyword_id as number, term: r.keywords?.term as string })).filter((r) => r.id && r.term);
      if (myKw.length < 2) { if (!cancelled) setNeighbors([]); return; }
      // Dokumentfrequenz je Keyword (parallele COUNT-HEADs) → IDF-Gewicht.
      const withDf = await Promise.all(myKw.slice(0, 24).map(async (kw) => {
        const { count } = await supabase.from("article_keywords").select("article_id", { count: "exact", head: true }).eq("keyword_id", kw.id);
        return { ...kw, df: count ?? 0 };
      }));
      const useful = withDf.filter((k) => k.df >= 1 && k.df <= 1200);
      if (useful.length < 2) { if (!cancelled) setNeighbors([]); return; }
      const wById = new Map(useful.map((k) => [k.id, 1 / Math.sqrt(k.df)]));
      const termById = new Map(useful.map((k) => [k.id, k.term]));
      const { data: coRows } = await supabase.from("article_keywords").select("article_id, keyword_id").in("keyword_id", useful.map((k) => k.id)).neq("article_id", self).limit(4000);
      const agg = new Map<number, { score: number; terms: Set<string> }>();
      for (const r of (coRows ?? []) as any[]) {
        const w = wById.get(r.keyword_id); if (w == null) continue;
        const e = agg.get(r.article_id) ?? { score: 0, terms: new Set<string>() };
        e.score += w; e.terms.add(termById.get(r.keyword_id)!);
        agg.set(r.article_id, e);
      }
      const ranked = [...agg.entries()].filter(([, e]) => e.terms.size >= 2).sort((x, y) => y[1].score - x[1].score).slice(0, 8);
      if (!ranked.length) { if (!cancelled) setNeighbors([]); return; }
      const { data: meta } = await supabase.from("page_overview").select("article_id,title,outlet,country").in("article_id", ranked.map(([id]) => id)).in("ptype", ALLOWED_PTYPES);
      const metaById = new Map(((meta ?? []) as any[]).map((m) => [m.article_id, m]));
      const out: Neighbor[] = [];
      for (const [id, e] of ranked) {
        const m = metaById.get(id); if (!m) continue;
        out.push({ articleId: id, title: m.title, outlet: m.outlet, country: m.country, shared: [...e.terms].slice(0, 5), cross: m.outlet !== a.outlet });
      }
      if (!cancelled) setNeighbors(out);
    })();
    return () => { cancelled = true; };
  }, [a?.id]);

  // Verhaltensprofil: aus bereits geladenen Daten abgeleitete, „auf den ersten Blick
  // unsichtbare" Kennzahlen (Latenz, stilles Bearbeitungsfenster, Wort-Bilanz, Scan-Takt).
  const profile = useMemo(() => {
    if (!a) return null;
    const pub = a.published_at ? Date.parse(a.published_at) : NaN;
    const fs = a.first_seen ? Date.parse(a.first_seen) : NaN;
    const sc = a.scan_count ?? 0;
    const st = (a.scan_times ?? []).map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n)).sort((x, y) => x - y);
    const sn = snaps.map((s) => Date.parse(s.captured_at)).filter((n) => !Number.isNaN(n)).sort((x, y) => x - y);
    const tiles: { k: string; v: string; s?: string }[] = [];
    if (pub && fs && fs - pub > 60000) tiles.push({ k: "Erfasst nach Erscheinen", v: durStr(fs - pub), s: "Verzug, bis margn den Artikel sah" });
    if (sn.length && pub && sn[0] - pub > 0) tiles.push({ k: "Erste Änderung", v: durStr(sn[0] - pub), s: "nach Veröffentlichung" });
    if (sn.length && pub && sn[sn.length - 1] - pub > 0) tiles.push({ k: "Zuletzt verändert", v: durStr(sn[sn.length - 1] - pub), s: "nach Veröffentlichung" });
    if (sc > 1) { const rc = a.revision_count ?? 0; tiles.push({ k: "Änderungsquote", v: `${Math.round((rc / sc) * 100)}%`, s: `${rc} Änderung${rc !== 1 ? "en" : ""} in ${sc} Scans` }); }
    const net = snaps.reduce((s, x) => s + (x.word_delta || 0), 0);
    if (net !== 0) tiles.push({ k: "Wort-Bilanz", v: `${net > 0 ? "+" : ""}${net.toLocaleString("de-DE")}`, s: "Wörter seit Erstfassung" });
    if (st.length >= 3) {
      const gaps: number[] = []; for (let i = 1; i < st.length; i++) gaps.push(st[i] - st[i - 1]);
      gaps.sort((x, y) => x - y);
      tiles.push({ k: "Scan-Takt", v: `alle ${durStr(gaps[Math.floor(gaps.length / 2)])}`, s: "Median zwischen Besuchen" });
    }
    const edit = a.edit_count ?? 0, ext = a.extension_count ?? 0, rev = a.revision_count ?? 0;
    let insight: string | null = null;
    if (snaps.some((s) => s.pubdate_old && s.pubdate_new)) insight = "Das Veröffentlichungsdatum wurde nachträglich verschoben — eine Änderung, die Leser nie zu sehen bekommen.";
    else if (edit > 0 && ext === 0) insight = "Alle erfassten Änderungen waren stille Korrekturen am bestehenden Text — ergänzt wurde nichts.";
    else if (ext >= 2) insight = "Der Beitrag wuchs über mehrere Besuche hinweg — fortlaufende, mitlaufende Berichterstattung.";
    else if (rev > 0 && sn.length && pub && sn[sn.length - 1] - pub > 86400000) insight = `Noch ${durStr(sn[sn.length - 1] - pub)} nach Veröffentlichung redaktionell angefasst.`;
    else if (rev === 0 && sc >= 4) insight = `Über ${sc} Besuche unverändert — ein stabiler, abgeschlossener Text.`;
    return { tiles, edit, ext, rev, insight };
  }, [a, snaps]);

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

      {/* Einordnung: Perzentil-Vergleich gegen Peers (gleiche Quelle / gleiches Thema) */}
      {pctls && pctls.length > 0 && (
        <DL h="Einordnung">
          <div className="pctls">
            {pctls.map((p) => (
              <div className="pctl" key={p.label}>
                <div className="pctl-top">
                  <span className="pctl-lbl">{p.label}</span>
                  <span className="pctl-val">{p.verb} <b>{p.pct}%</b></span>
                </div>
                <div className="pctl-bar"><i style={{ width: `${p.pct}%` }} /></div>
                <div className="pctl-sub">verglichen mit {p.n.toLocaleString("de-DE")} Artikeln</div>
              </div>
            ))}
          </div>
        </DL>
      )}

      {/* Scan-Timeline */}
      <DL h="Scan-Verlauf">
        <ScanTimeline firstSeen={a.first_seen} lastSeen={a.last_seen} scanTimes={a.scan_times} scanCount={a.scan_count}
          changeTimes={snaps.map((s) => s.captured_at)} />
      </DL>

      {/* Verhaltensprofil: abgeleitete, „auf den ersten Blick unsichtbare" Kennzahlen */}
      {profile && (profile.tiles.length > 0 || profile.rev > 0 || profile.insight) && (
        <DL h="Was die Daten verraten">
          {profile.tiles.length > 0 && (
            <div className="dprofile">
              {profile.tiles.map((t) => (
                <div className="dmetric" key={t.k}>
                  <div className="k">{t.k}</div>
                  <div className="v">{t.v}</div>
                  {t.s && <div className="s">{t.s}</div>}
                </div>
              ))}
            </div>
          )}
          {profile.rev > 0 && profile.edit + profile.ext > 0 && (
            <div className="dsplit">
              <div className="dsplit-bar">
                {profile.edit > 0 && <span className="seg-edit" style={{ flex: profile.edit }} />}
                {profile.ext > 0 && <span className="seg-ext" style={{ flex: profile.ext }} />}
              </div>
              <div className="dsplit-legend">
                <span className="le edit">{profile.edit} stille Änderung{profile.edit !== 1 ? "en" : ""}</span>
                <span className="le ext">{profile.ext} Erweiterung{profile.ext !== 1 ? "en" : ""}</span>
              </div>
            </div>
          )}
          {profile.insight && <p className="dinsight">{profile.insight}</p>}
        </DL>
      )}

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

      {/* Thematische Nachbarn: blattübergreifendes Echo über geteilte Schlagwörter */}
      {neighbors && neighbors.length > 0 && (
        <DL h="Thematische Nachbarn">
          <p className="neigh-intro">
            Andere Artikel, die auffällig viele — und besonders seltene — Schlagwörter mit diesem teilen.
            Ein Hinweis auf dieselbe Story oder ein gemeinsames Framing.
            {neighbors.some((n) => n.cross) && <> <b>{neighbors.filter((n) => n.cross).length}</b> davon aus anderen Blättern.</>}
          </p>
          <div className="neigh">
            {neighbors.map((n) => (
              <Link key={n.articleId} href={`/articles/${n.articleId}`} className="neigh-card">
                <div className="neigh-main">
                  <div className="neigh-title">{n.title ?? "(ohne Titel)"}</div>
                  <div className="neigh-kws">{n.shared.map((t) => <span key={t} className="neigh-chip">{t}</span>)}</div>
                </div>
                <div className="neigh-meta">
                  <span className="neigh-outlet">{n.outlet} <span className="cc">{n.country}</span></span>
                  {n.cross && <span className="neigh-echo">↔ blattübergreifend</span>}
                </div>
              </Link>
            ))}
          </div>
        </DL>
      )}

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

      {/* Änderungsverlauf als Zeitstrahl: oben die Veröffentlichung (Erstfassung) mit Uhrzeit,
          darunter jede erfasste Version chronologisch, unten die aktuelle Fassung — Vorher/Jetzt. */}
      <DL h="Änderungsverlauf">
        <div className="chist">
          <ChistAnchor kind="pub"
            label={a.published_at ? "Veröffentlicht" : "Erstmals erfasst"}
            time={a.published_at ?? a.first_seen}
            sub={a.published_at ? "Erstfassung des Verlags" : "Kein Verlagsdatum — erster Scan"} />
          {snaps.length === 0 ? (
            <div className="chist-none">
              Seither <strong>keine Änderung erfasst</strong> — Überschrift, Text, Datum, Teaser,
              Ressort, Paywall-Status und Autor sind unverändert. Sobald margn etwas Stilles entdeckt,
              erscheint hier jede Version mit Vorher/Jetzt-Vergleich.
            </div>
          ) : (
            snaps.map((s, i) => <ChangeCard key={s.id} s={s} v={i + 1} />)
          )}
          <ChistAnchor kind="now" label="Aktuelle Fassung" time={a.last_seen}
            sub={snaps.length > 0 ? `${snaps.length} Änderung${snaps.length !== 1 ? "en" : ""} erfasst · zuletzt geprüft` : "zuletzt geprüft, unverändert"} />
        </div>
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

// Eine kompakte „so wurde es still geändert"-Zeile (Ressort/Paywall/Autor).
function MetaLine({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="chist-meta">{icon}<span>{children}</span></div>;
}
// Rendert EINEN unsichtbaren Metadaten-Edit passend zum Feldtyp.
function MetaEditView({ m }: { m: MetaEdit }) {
  if (m.field === "description" && m.old && m.new) return <Juxta oldS={m.old} newS={m.new} label="Teaser geändert" />;
  if (m.field === "og_image") return (
    <div className="chist-block">
      <div className="lbl">Vorschaubild getauscht</div>
      <div className="chist-imgs">
        <figure className="old"><figcaption>Vorher</figcaption>{m.old ? <img src={m.old} alt="" /> : <span className="faint">—</span>}</figure>
        <figure className="new"><figcaption>Jetzt</figcaption>{m.new ? <img src={m.new} alt="" /> : <span className="faint">—</span>}</figure>
      </div>
    </div>
  );
  if (m.field === "topic") return <MetaLine icon={<Folder />}>Ressort verschoben — <b>{topicLabel(m.old ?? "")}</b> → <b>{topicLabel(m.new ?? "")}</b></MetaLine>;
  if (m.field === "paywalled") {
    const activated = m.new === "true";
    return <MetaLine icon={activated ? <Lock size={14} /> : <LockOpen size={14} />}>{activated
      ? <>Paywall <b>aktiviert</b> — der Artikel ist jetzt kostenpflichtig.</>
      : <>Paywall <b>entfernt</b> — der Artikel ist jetzt frei zugänglich.</>}</MetaLine>;
  }
  if (m.field === "author_status") return <MetaLine icon={<Pencil />}>Autoren-Angabe geändert — <b>{AUTHOR_STATUS_LABEL[m.old ?? ""] ?? m.old}</b> → <b>{AUTHOR_STATUS_LABEL[m.new ?? ""] ?? m.new}</b></MetaLine>;
  return null;
}

// Anker-Punkt auf dem Verlaufs-Zeitstrahl: oben = Veröffentlichung (Erstfassung), unten = aktuelle Fassung.
function ChistAnchor({ kind, label, time, sub }: { kind: "pub" | "now"; label: string; time: string | null; sub?: string }) {
  return (
    <div className={`chist-anchor ${kind}`}>
      <div className="chist-anchor-head">
        <span className="chist-anchor-label">{label}</span>
        <span className="chist-anchor-time">{fmtDate(time)}</span>
      </div>
      {sub && <span className="chist-anchor-sub">{sub}</span>}
    </div>
  );
}

// Eine Version im Verlauf = eine Karte (chronologisch). Badges markieren auch unsichtbare
// Änderungen (Überschrift, Datum, Teaser, Ressort, Paywall, Autor), die auf den ersten Blick verborgen sind.
function ChangeCard({ s, v }: { s: Snapshot; v: number }) {
  const isEdit = s.change_kind === "edit";
  const kindLabel = s.change_kind === "extension" ? "Erweiterung" : isEdit ? "Stille Änderung" : "Geändert & erweitert";
  const Icon = isEdit ? Pencil : Plus;
  const cls = s.change_kind === "extension" ? "ok" : isEdit ? "lock" : "wait";
  const changes = (s.changes ?? []).filter((c) => c.old || c.new);
  const titleChanged = !!(s.title_old && s.title_new);
  const dateChanged = !!(s.pubdate_old && s.pubdate_new);
  const metaEdits = (s.meta_edits ?? []).filter((m) => m && m.field);
  const rewritten = changes.filter((c) => c.old && c.new).length;
  const bodyTouched = changes.length > 0 || !!s.added || s.added_count > 0 || s.removed_count > 0;
  return (
    <div className={`chist-card ${s.change_kind}`}>
      <div className="chist-head">
        <span className="chist-v">V{v}</span>
        <span className={`badge ${cls}`}><Icon /> {kindLabel}</span>
        <span className="chist-when">{fmtDate(s.captured_at)}</span>
        <span className="chist-chips">
          {titleChanged && <span className="chist-chip">Überschrift</span>}
          {dateChanged && <span className="chist-chip date">Datum</span>}
          {metaEdits.map((m) => <span key={m.field} className="chist-chip meta">{META_LABEL[m.field] ?? m.field}</span>)}
          {s.added_count > 0 && <span className="chist-chip add">+{s.added_count}&nbsp;Absatz{s.added_count > 1 ? "e" : ""}</span>}
          {s.removed_count > 0 && <span className="chist-chip del">−{s.removed_count}&nbsp;Absatz{s.removed_count > 1 ? "e" : ""}</span>}
          {s.word_delta ? <span className="chist-chip">{s.word_delta > 0 ? "+" : ""}{s.word_delta}&nbsp;W</span> : null}
        </span>
      </div>
      {dateChanged && (
        <div className="chist-date"><Clock size={14} /><span>Veröffentlichungsdatum still geändert — <b>vorher</b> {fmtDate(s.pubdate_old)} · <b>jetzt</b> {fmtDate(s.pubdate_new)}</span></div>
      )}
      {metaEdits.map((m, i) => <MetaEditView key={`${m.field}-${i}`} m={m} />)}
      {titleChanged && <Juxta oldS={s.title_old!} newS={s.title_new!} label="Überschrift" />}
      {bodyTouched && (
        <p className="chist-bodynote">
          Fließtext still bearbeitet{rewritten > 0 ? ` · ${rewritten} Passage${rewritten > 1 ? "n" : ""} umgeschrieben` : ""}
          {" — "}<span className="faint">Volltext nicht gespiegelt, im Original bei der Quelle lesen.</span>
        </p>
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
