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
// Eine Einordnungs-Zeile: Perzentil ODER (für die seltene Bearbeitung) Rang innerhalb der
// bearbeiteten Artikel + Median-Kontext, damit die Zahl aussagekräftig ist statt „immer ~100 %".
type Pctl = { key: string; label: string; verb: string; pct: number; n: number; selfVal: number; median: number | null; cohort?: string };
type Neighbor = { articleId: number; title: string | null; outlet: string; country: string | null; shared: string[]; cross: boolean };
type MetaEdit = { field: string; old: string | null; new: string | null };
type Snapshot = { id: number; captured_at: string; change_kind: string; title_old: string | null; title_new: string | null; added: string | null; added_count: number; removed_count: number; word_delta: number; pubdate_old: string | null; pubdate_new: string | null; changes: Change[] | null; meta_edits: MetaEdit[] | null };

const LANG: Record<string, string> = { de: "Deutsch", fr: "Français", en: "English" };
const TYPE_LABEL: Record<string, string> = {
  news: "Nachricht", opinion: "Meinung", analysis: "Analyse", liveblog: "Liveblog", timeline: "Timeline-Artikel",
  review: "Rezension", reportage: "Reportage", interactive: "Interaktiv", interview: "Interview",
};
const META_LABEL: Record<string, string> = { description: "Teaser", og_image: "Bild", topic: "Ressort", paywalled: "Paywall", author_status: "Autor" };
const AUTHOR_STATUS_LABEL: Record<string, string> = { named: "namentlich", anonymous: "Redaktion/Agentur", none: "kein Autor" };

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
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
  const [editedShare, setEditedShare] = useState<number | null>(null); // Anteil bearbeiteter Artikel der Quelle
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

  // Einordnung gegen Peers (gleiche Quelle / gleiches Thema). Statt vieler COUNT-Round-Trips je
  // EINE Abfrage je Vergleichsraum (die Peer-Mengen sind klein) → Perzentil + Median client-seitig.
  // WICHTIG (Fix): Die Bearbeitungs-Häufigkeit wird NICHT gegen ALLE Artikel verglichen — die
  // meisten haben 0 Änderungen, jeder bearbeitete landete so bei ~100 %. Stattdessen Perzentil
  // INNERHALB der bearbeiteten Artikel (revision_count ≥ 1) + Median, plus Seltenheits-Quote.
  useEffect(() => {
    if (!a) return;
    let cancelled = false;
    (async () => {
      const wc = a.word_count, rc = a.revision_count ?? 0, sid = a.source_id, topic = a.topic;
      const median = (arr: number[]): number | null => {
        if (arr.length < 4) return null;
        const s = [...arr].sort((x, y) => x - y); const m = Math.floor(s.length / 2);
        return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
      };
      const pctBelow = (arr: number[], v: number) => arr.length ? Math.round((arr.filter((x) => x < v).length / arr.length) * 100) : 0;

      // Quelle: Wortzahl + Revisionen in EINER Abfrage.
      const { data: srcRows } = await supabase.from("page_overview")
        .select("word_count,revision_count").eq("source_id", sid).in("ptype", ALLOWED_PTYPES).not("word_count", "is", null).limit(3000);
      const src = (srcRows ?? []) as { word_count: number | null; revision_count: number | null }[];
      const srcWc = src.map((r) => r.word_count).filter((n): n is number => n != null);
      const srcEdited = src.map((r) => r.revision_count ?? 0).filter((n) => n >= 1);

      // Thema: nur Wortzahl, nur falls vorhanden.
      let topicWc: number[] = [];
      if (topic) {
        const { data: tRows } = await supabase.from("page_overview")
          .select("word_count").eq("topic", topic).in("ptype", ALLOWED_PTYPES).not("word_count", "is", null).limit(3000);
        topicWc = ((tRows ?? []) as any[]).map((r) => r.word_count).filter((n) => n != null);
      }

      const res: Pctl[] = [];
      if (wc != null && srcWc.length >= 5)
        res.push({ key: "len_src", label: `Umfang · ${a.outlet}`, verb: "länger als", pct: pctBelow(srcWc, wc), n: srcWc.length, selfVal: wc, median: median(srcWc) });
      if (wc != null && topicWc.length >= 8)
        res.push({ key: "len_topic", label: `Umfang · ${topicLabel(topic!)}`, verb: "länger als", pct: pctBelow(topicWc, wc), n: topicWc.length, selfVal: wc, median: median(topicWc) });
      if (rc > 0 && srcEdited.length >= 4)
        res.push({ key: "edit", label: `Bearbeitung · ${a.outlet}`, verb: "öfter geändert als", pct: pctBelow(srcEdited, rc), n: srcEdited.length, selfVal: rc, median: median(srcEdited), cohort: "bearbeiteten Artikeln" });

      const share = srcWc.length >= 8 ? srcEdited.length / srcWc.length : null;
      if (!cancelled) { setPctls(res); setEditedShare(share); }
    })();
    return () => { cancelled = true; };
  }, [a?.id]);

  // Thematische Nachbarn: blattübergreifendes Echo über IDF-gewichtete, geteilte Schlagwörter.
  useEffect(() => {
    if (!a) return;
    let cancelled = false;
    (async () => {
      const self = a.id;
      const { data: kwRows } = await supabase.from("article_keywords").select("keyword_id, keywords(term)").eq("article_id", self);
      const myKw = ((kwRows ?? []) as any[]).map((r) => ({ id: r.keyword_id as number, term: r.keywords?.term as string })).filter((r) => r.id && r.term);
      if (myKw.length < 2) { if (!cancelled) setNeighbors([]); return; }
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

  // Verhaltensprofil: abgeleitete, „auf den ersten Blick unsichtbare" Kennzahlen.
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

  // Radar-„Fingerabdruck": 6 normalisierte Achsen (0..1), die das Verhalten des Artikels auf
  // einen Blick zeigen — das „zwischen den Zeilen". Perzentil-Achsen kommen aus pctls, der Rest
  // aus bereits geladenen Daten (sanfte Obergrenzen). Bewusst robust gegen fehlende Werte.
  const radar = useMemo(() => {
    if (!a) return null;
    const byKey = (k: string) => pctls?.find((p) => p.key === k)?.pct ?? null;
    const lenPct = byKey("len_src");
    const editPct = byKey("edit");
    const rev = a.revision_count ?? 0, sc = a.scan_count ?? 0;
    const axes = [
      { label: "Umfang", v: lenPct != null ? lenPct / 100 : Math.min(1, (a.word_count ?? 0) / 1500), hint: "Länge vs. Quelle" },
      { label: "Bearbeitung", v: rev === 0 ? 0 : editPct != null ? Math.max(0.12, editPct / 100) : Math.min(1, rev / 8), hint: "Änderungs-Intensität" },
      { label: "Volatilität", v: sc > 0 ? Math.min(1, rev / sc / 0.5) : 0, hint: "Änderungen je Scan" },
      { label: "Schlagwörter", v: Math.min(1, keywords.length / 12), hint: "thematische Dichte" },
      { label: "Echo", v: Math.min(1, (neighbors?.length ?? 0) / 8), hint: "blattübergreifende Nähe" },
      { label: "Beobachtung", v: Math.min(1, sc / 24), hint: "wie oft margn nachsah" },
    ];
    const area = axes.reduce((s, x) => s + x.v, 0) / axes.length; // grobes „Aktivitäts"-Maß
    return { axes, area };
  }, [a, pctls, keywords.length, neighbors]);

  // Verlauf aufbereiten: erst konsekutive Duplikate falten, dann Oszillation erkennen (die ganze
  // Historie fällt auf ≤2 wiederkehrende Fassungen zusammen → Quelle pendelt; nur einmal zeigen).
  const history = (() => {
    const groups = groupSnaps(snaps);
    const distinct: SnapGroup[] = [];
    const seen = new Set<string>();
    for (const g of groups) { const sig = snapSig(g.first); if (!seen.has(sig)) { seen.add(sig); distinct.push(g); } }
    const oscillating = groups.length >= 3 && distinct.length <= 2;
    return { groups, distinct, oscillating, switches: groups.length, from: snaps[0]?.captured_at ?? null, to: snaps[snaps.length - 1]?.captured_at ?? null };
  })();

  if (loading) return <div className="page detail"><p className="faint">Lade…</p></div>;
  if (!a) return <div className="page detail"><p className="faint">Artikel nicht gefunden.</p></div>;

  const segs = (() => { try { return new URL(a.url).pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean); } catch { return []; } })();
  const type = a.article_type ?? "news";

  return (
    <div className="page detail">
      <Link href="/articles" className="back"><ArrowLeft size={15} /> Alle Artikel</Link>

      {/* Kopf — volle Breite */}
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
      {categories.length > 0 && (
        <div className="cat-banner">
          <span className="cat-label">Ressort</span>
          <div className="cat-chips">{categories.map((x) => <span key={x} className="cat-chip">{x}</span>)}</div>
        </div>
      )}
      {/* 2-spaltig: links (2/3) Bild + Änderungsverlauf, rechts (1/3) Link (immer sichtbar) + Infos */}
      <div className="d-grid">
        <div className="d-main">
          <div className="d-cta-bar">
            <ExtLink href={a.url} className="cta d-cta">Originalartikel öffnen <External size={15} /></ExtLink>
          </div>
          <div className="d-info">
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

          {/* Fingerabdruck-Radar */}
          {radar && (
            <DL h="Profil auf einen Blick">
              <RadarChart axes={radar.axes} />
            </DL>
          )}

          {/* Einordnung — jetzt mit Median-Kontext + Bearbeitung gegen bearbeitete Peers */}
          {pctls && pctls.length > 0 && (
            <DL h="Einordnung">
              <div className="pctls">
                {pctls.map((p) => (
                  <div className="pctl" key={p.key}>
                    <div className="pctl-top">
                      <span className="pctl-lbl">{p.label}</span>
                      <span className="pctl-val">{p.verb} <b>{p.pct}%</b></span>
                    </div>
                    <div className="pctl-bar"><i style={{ width: `${p.pct}%` }} /></div>
                    <div className="pctl-sub">
                      {p.median != null && <>Median <b>{p.median.toLocaleString("de-DE")}</b>, dieser <b>{p.selfVal.toLocaleString("de-DE")}</b> · </>}
                      {p.n.toLocaleString("de-DE")} {p.cohort ?? "Artikel"}
                    </div>
                  </div>
                ))}
              </div>
              {editedShare != null && (
                <p className="pctl-rarity">
                  Nur <b>{Math.round(editedShare * 100)}%</b> aller {a.outlet}-Artikel wurden nach dem Erscheinen überhaupt noch angefasst —
                  {(a.revision_count ?? 0) > 0 ? " dieser gehört dazu." : " dieser nicht."}
                </p>
              )}
            </DL>
          )}

          {/* Verhaltensprofil */}
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

          {neighbors && neighbors.length > 0 && (
            <DL h="Thematische Nachbarn">
              <p className="neigh-intro">
                Andere Artikel, die auffällig viele — und besonders seltene — Schlagwörter mit diesem teilen.
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
          </div>
        </div>

        {/* Linke Spalte (2/3): Bild + Änderungsverlauf, gleich breit */}
        <aside className="d-aside">
          {a.og_image && <div className="d-hero"><img src={a.og_image} alt="" /></div>}
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
              ) : history.oscillating ? (
                <>
                  <div className="chist-osc">
                    <span className="chist-osc-h">↻ Quelle pendelt</span>
                    <span>Diese Stelle wechselte zwischen {fmtDate(history.from)} und {fmtDate(history.to)} <b>{history.switches}×</b> hin und her. Hier {history.distinct.length === 2 ? "beide Fassungen" : "die betroffene Fassung"} — die Wiederholungen sind zusammengefasst.</span>
                  </div>
                  {history.distinct.map((g, gi, arr) => (
                    <ChangeCard key={g.first.id} s={g.first} v={g.v}
                      prev={gi > 0 ? arr[gi - 1].first : undefined} prevV={gi > 0 ? arr[gi - 1].v : undefined} />
                  ))}
                </>
              ) : (
                history.groups.map((g, gi, arr) => (
                  <ChangeCard key={g.first.id} s={g.first} v={g.v}
                    prev={gi > 0 ? arr[gi - 1].first : undefined} prevV={gi > 0 ? arr[gi - 1].v : undefined}
                    repeat={g.count > 1 ? { count: g.count, from: g.from, to: g.to } : undefined} />
                ))
              )}
              <ChistAnchor kind="now" label="Aktuelle Fassung" time={a.last_seen}
                sub={snaps.length > 0 ? `${snaps.length} Änderung${snaps.length !== 1 ? "en" : ""} erfasst · zuletzt geprüft` : "zuletzt geprüft, unverändert"} />
            </div>
          </DL>
        </aside>
      </div>
    </div>
  );
}

// Radar/Spinnendiagramm (handgemaltes SVG, keine Dependency). Zeigt 6 normalisierte Achsen als
// gefülltes Polygon über zwei Gitterringen — der „Fingerabdruck" des Artikels.
function RadarChart({ axes }: { axes: { label: string; v: number; hint: string }[] }) {
  const N = axes.length;
  const size = 260, cx = size / 2, cy = size / 2 + 6, R = 86;
  const ang = (i: number) => (Math.PI * 2 * i) / N - Math.PI / 2;
  const pt = (i: number, r: number) => [cx + Math.cos(ang(i)) * R * r, cy + Math.sin(ang(i)) * R * r] as const;
  const poly = (r: (i: number) => number) => axes.map((_, i) => pt(i, r(i)).join(",")).join(" ");
  const shape = poly((i) => Math.max(0.02, Math.min(1, axes[i].v)));
  return (
    <div className="radar">
      <svg viewBox={`0 0 ${size} ${size}`} className="radar-svg" role="img" aria-label="Profil-Radar">
        {[1, 0.66, 0.33].map((r) => (
          <polygon key={r} className="radar-grid" points={poly(() => r)} />
        ))}
        {axes.map((_, i) => { const [x, y] = pt(i, 1); return <line key={i} className="radar-spoke" x1={cx} y1={cy} x2={x} y2={y} />; })}
        <polygon className="radar-area" points={shape} />
        {axes.map((ax, i) => { const [x, y] = pt(i, Math.max(0.02, Math.min(1, ax.v))); return <circle key={i} className="radar-dot" cx={x} cy={y} r={3} />; })}
        {axes.map((ax, i) => {
          const [x, y] = pt(i, 1.2);
          const anchor = Math.abs(Math.cos(ang(i))) < 0.3 ? "middle" : Math.cos(ang(i)) > 0 ? "start" : "end";
          return <text key={i} className="radar-lbl" x={x} y={y} textAnchor={anchor} dominantBaseline="middle">{ax.label}</text>;
        })}
      </svg>
      <div className="radar-legend">
        {axes.map((ax) => (
          <div className="radar-leg" key={ax.label}>
            <span className="radar-leg-bar"><i style={{ width: `${Math.round(Math.min(1, ax.v) * 100)}%` }} /></span>
            <span className="radar-leg-lbl">{ax.label}</span>
            <span className="radar-leg-hint">{ax.hint}</span>
          </div>
        ))}
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

// Inline-Wort-Diff (LCS): EIN durchgehender Text, in dem nur die geänderten Wörter markiert sind.
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
  for (let x = 1; x < raw.length - 1; x++) if (/^\s+$/.test(raw[x].t) && raw[x].op === "eq" && raw[x - 1].op === raw[x + 1].op && raw[x - 1].op !== "eq") raw[x].op = raw[x - 1].op;
  const segs: Op[] = [];
  for (const r of raw) { const l = segs[segs.length - 1]; if (l && l.op === r.op) l.t += r.t; else segs.push({ ...r }); }
  for (let x = 1; x < segs.length; x++) if (segs[x].op === "ins" && segs[x - 1].op === "del") segs[x].op = "repl";
  return segs;
}
// Lange unveränderte Passagen zusammenfalten: nur wenige Wörter Kontext um jede Änderung herum,
// der Rest wird zu einem Platzhalter „⋯" (n Wörter unverändert). So bleibt nur das Wesentliche im
// Blick — statt denselben Absatz in jeder Version komplett zu wiederholen.
type Tok = { op: "eq" | "del" | "ins" | "repl" | "gap"; t: string; n?: number };
function headWords(words: string[], n: number) { let c = 0, r = ""; for (const w of words) { r += w; if (w.trim() && ++c >= n) break; } return r; }
function tailWords(words: string[], n: number) { let c = 0, r = ""; for (let i = words.length - 1; i >= 0; i--) { r = words[i] + r; if (words[i].trim() && ++c >= n) break; } return r; }
function compactDiff(oldS: string, newS: string, ctx = 7): Tok[] {
  const ops = inlineOps(oldS, newS);
  const idx = ops.map((o, i) => (o.op !== "eq" ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) return [];
  const out: Tok[] = [];
  ops.forEach((o, i) => {
    if (o.op !== "eq") {
      // auch lange Einfügungen/Löschungen kappen — nur der Anfang + Platzhalter (Boilerplate raus)
      const w = o.t.split(/(\s+)/).filter((x) => x !== "");
      const wl = w.filter((x) => x.trim()).length;
      if (wl > 42) out.push({ op: o.op, t: headWords(w, 34) }, { op: "gap", t: "", n: wl - 34 });
      else out.push({ op: o.op, t: o.t });
      return;
    }
    const before = idx.some((c) => c < i), after = idx.some((c) => c > i);
    const words = o.t.split(/(\s+)/).filter((w) => w !== "");
    const wlen = words.filter((w) => w.trim()).length;
    if (before && after) {
      if (wlen > 2 * ctx) { out.push({ op: "eq", t: headWords(words, ctx) }, { op: "gap", t: "", n: wlen - 2 * ctx }, { op: "eq", t: tailWords(words, ctx) }); }
      else out.push({ op: "eq", t: o.t });
    } else if (after) { // führender Kontext: nur die letzten ctx Wörter vor der ersten Änderung
      if (wlen > ctx) out.push({ op: "gap", t: "", n: wlen - ctx }, { op: "eq", t: tailWords(words, ctx) });
      else out.push({ op: "eq", t: o.t });
    } else { // abschließender Kontext: nur die ersten ctx Wörter nach der letzten Änderung
      if (wlen > ctx) out.push({ op: "eq", t: headWords(words, ctx) }, { op: "gap", t: "", n: wlen - ctx });
      else out.push({ op: "eq", t: o.t });
    }
  });
  return out;
}
// Ein zusammenhängender Inline-Diff: ~~entfernt~~ (rot) + ergänzt (grün), Platzhalter schraffiert.
function DiffText({ oldS, newS }: { oldS: string; newS: string }) {
  const toks = compactDiff(oldS, newS);
  if (!toks.length) return <span className="faint" style={{ fontSize: 12.5 }}>nur Whitespace/Formatierung geändert</span>;
  return (
    <span className="dq-text">
      {toks.map((t, i) =>
        t.op === "gap" ? <span key={i} className="dq-gap" title={`${t.n} Wörter unverändert`} aria-label={`${t.n} Wörter unverändert`}>⋯</span>
        : t.op === "del" ? <del key={i} className="dq-del">{t.t}</del>
        : t.op === "ins" || t.op === "repl" ? <ins key={i} className="dq-ins">{t.t}</ins>
        : <span key={i}>{t.t}</span>
      )}
    </span>
  );
}
function DiffBlock({ oldS, newS, label, kind = "edit" }: { oldS: string; newS: string; label: string; kind?: "edit" | "title" | "meta" }) {
  return (
    <div className={`dq ${kind}`}>
      <div className="dq-lbl"><span className="dq-pm">±</span>{label}</div>
      <div className="dq-body"><DiffText oldS={oldS} newS={newS} /></div>
    </div>
  );
}

function MetaLine({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="chist-meta">{icon}<span>{children}</span></div>;
}
function MetaEditView({ m }: { m: MetaEdit }) {
  if (m.field === "description" && m.old && m.new) return <DiffBlock oldS={m.old} newS={m.new} label="Teaser geändert" kind="meta" />;
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

// Signatur einer Änderung (Inhalt, nicht Zeit) — um aufeinanderfolgende IDENTISCHE Snapshots zu
// erkennen. Manche Quellen lassen dieselbe Stelle stündlich hin- und herspringen; der Scraper
// speichert dann denselben Diff mehrfach. Solche Wiederholungen fassen wir zu EINER Karte zusammen.
function snapSig(s: Snapshot): string {
  const ch = (s.changes ?? []).map((c) => `${c.old ?? ""}»${c.new ?? ""}`).join("¦");
  const me = (s.meta_edits ?? []).map((m) => `${m.field}:${m.old}»${m.new}`).join("¦");
  return [s.change_kind, s.title_old, s.title_new, s.pubdate_old, s.pubdate_new, s.added, ch, me].join("∣");
}
type SnapGroup = { first: Snapshot; v: number; count: number; from: string; to: string };
function groupSnaps(snaps: Snapshot[]): SnapGroup[] {
  const groups: SnapGroup[] = [];
  snaps.forEach((s, i) => {
    const last = groups[groups.length - 1];
    if (last && snapSig(last.first) === snapSig(s)) { last.count++; last.to = s.captured_at; }
    else groups.push({ first: s, v: i + 1, count: 1, from: s.captured_at, to: s.captured_at });
  });
  return groups;
}

function ChangeCard({ s, v, prev, prevV, repeat }: { s: Snapshot; v: number; prev?: Snapshot; prevV?: number; repeat?: { count: number; from: string; to: string } }) {
  const isEdit = s.change_kind === "edit";
  const isExt = s.change_kind === "extension";
  const kindLabel = s.change_kind === "extension" ? "Erweiterung" : isEdit ? "Stille Änderung" : "Geändert & erweitert";
  const Icon = isEdit ? Pencil : Plus;
  const cls = s.change_kind === "extension" ? "ok" : isEdit ? "lock" : "wait";
  const allChanges = (s.changes ?? []).filter((c) => c.old || c.new);
  // Nur die größten Passagen zeigen (Länge der Änderung), der Rest als Hinweis — nicht jeder Absatz.
  const changes = [...allChanges].sort((a, b) => ((b.old?.length ?? 0) + (b.new?.length ?? 0)) - ((a.old?.length ?? 0) + (a.new?.length ?? 0))).slice(0, 3);
  const moreChanges = allChanges.length - changes.length;
  const titleChanged = !!(s.title_old && s.title_new);
  const dateChanged = !!(s.pubdate_old && s.pubdate_new);
  const metaEdits = (s.meta_edits ?? []).filter((m) => m && m.field);
  // Oszillation erkennen: nimmt dieser Snapshot exakt den vorigen zurück? (Quelle springt hin und her.)
  const c0 = allChanges.find((c) => c.old && c.new);
  const p0 = prev?.changes?.find((c) => c.old && c.new);
  const isRevert = !!(
    (c0 && p0 && c0.old === p0.new && c0.new === p0.old) ||
    (s.title_old && s.title_new && prev?.title_old === s.title_new && prev?.title_new === s.title_old)
  );
  return (
    <div className={`chist-card ${s.change_kind}${isRevert ? " revert" : ""}`}>
      <div className="chist-head">
        <span className="chist-v">{repeat ? `V${v}–V${v + repeat.count - 1}` : `V${v}`}</span>
        <span className={`badge ${cls}`}><Icon /> {kindLabel}</span>
        <span className="chist-when">{fmtDate(s.captured_at)}</span>
        <span className="chist-chips">
          {repeat && <span className="chist-chip repeat">↻&nbsp;{repeat.count}×</span>}
          {isRevert && <span className="chist-chip revert">↩ Rücknahme</span>}
          {titleChanged && <span className="chist-chip">Überschrift</span>}
          {dateChanged && <span className="chist-chip date">Datum</span>}
          {metaEdits.map((m) => <span key={m.field} className="chist-chip meta">{META_LABEL[m.field] ?? m.field}</span>)}
          {s.added_count > 0 && <span className="chist-chip add">+{s.added_count}&nbsp;Absatz{s.added_count > 1 ? "e" : ""}</span>}
          {!isExt && s.removed_count > 0 && <span className="chist-chip del">−{s.removed_count}&nbsp;Absatz{s.removed_count > 1 ? "e" : ""}</span>}
          {s.word_delta ? <span className="chist-chip">{s.word_delta > 0 ? "+" : ""}{s.word_delta}&nbsp;W</span> : null}
        </span>
      </div>
      {repeat ? (
        <div className="chist-revert-note"><span>↻</span> Dieselbe Änderung <b>{repeat.count}×</b> erfasst ({fmtDate(repeat.from)} – {fmtDate(repeat.to)}) — die Quelle ließ den Text mehrfach hin- und herspringen.</div>
      ) : isRevert ? (
        <div className="chist-revert-note"><span>↩</span> Setzt <b>V{prevV}</b> wieder zurück — dieselbe Stelle pendelt bei der Quelle hin und her.</div>
      ) : null}
      {dateChanged && (
        <div className="chist-date"><Clock size={14} /><span>Veröffentlichungsdatum still geändert — <b>vorher</b> {fmtDate(s.pubdate_old)} · <b>jetzt</b> {fmtDate(s.pubdate_new)}</span></div>
      )}
      {metaEdits.map((m, i) => <MetaEditView key={`${m.field}-${i}`} m={m} />)}
      {titleChanged && <DiffBlock oldS={s.title_old!} newS={s.title_new!} label="Überschrift geändert" kind="title" />}
      {isExt ? (() => {
        const newText = s.added || changes.filter((c) => c.new).map((c) => c.new).join("\n\n");
        return newText ? (
          <div className="dq ext">
            <div className="dq-lbl"><span className="dq-pm add">+</span>Neu hinzugekommen</div>
            <div className="dq-body dq-add-body">{newText.length > 520 ? newText.slice(0, 520) + " …" : newText}</div>
          </div>
        ) : null;
      })() : (
        <>
          {changes.map((c, i) =>
            c.old && c.new ? <DiffBlock key={i} oldS={c.old} newS={c.new} label="Geänderte Passage" />
            : c.new ? (
              <div className="dq ext" key={i}>
                <div className="dq-lbl"><span className="dq-pm add">+</span>Neu hinzugekommen</div>
                <div className="dq-body dq-add-body">{c.new!.length > 420 ? c.new!.slice(0, 420) + " …" : c.new}</div>
              </div>
            ) : (
              <div className="dq del-only" key={i}>
                <div className="dq-lbl"><span className="dq-pm del">−</span>Entfernt</div>
                <div className="dq-body dq-del-body">{c.old!.length > 420 ? c.old!.slice(0, 420) + " …" : c.old}</div>
              </div>
            )
          )}
          {moreChanges > 0 && (
            <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>+ {moreChanges} weitere, kleinere Passage{moreChanges > 1 ? "n" : ""} geändert</p>
          )}
          {changes.length === 0 && !titleChanged && s.added && (
            <div className={`dq ${isEdit ? "del-only" : "ext"}`}>
              <div className="dq-lbl"><span className={`dq-pm ${isEdit ? "del" : "add"}`}>{isEdit ? "±" : "+"}</span>{isEdit ? "Geänderte Passage" : "Neu hinzugekommen"}</div>
              <div className={`dq-body ${isEdit ? "dq-del-body" : "dq-add-body"}`}>{s.added.length > 420 ? s.added.slice(0, 420) + " …" : s.added}</div>
            </div>
          )}
          {changes.length === 0 && !titleChanged && !s.added && !dateChanged && s.removed_count > 0 && (
            <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>− {s.removed_count} Passage(n) entfernt</p>
          )}
        </>
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
