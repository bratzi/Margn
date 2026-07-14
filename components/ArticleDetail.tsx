"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { Lock, LockOpen, Video, FileText, Clock, ArrowLeft, External, Plus, Pencil, Folder, Link2, Link2Off } from "@/components/icons";
import { topicLabel } from "@/lib/topics";
import { ALLOWED_PTYPES, onlineToleranceMs } from "@/lib/filterCorpus";
import ScanTimeline from "@/components/ScanTimeline";
import ExtLink from "@/components/ExtLink";

type Detail = {
  id: number; source_id: number; url: string; title: string | null; description: string | null; og_image: string | null;
  published_at: string | null; modified_at: string | null; paywalled: boolean | null;
  word_count: number | null; reading_min: number | null; article_type: string | null;
  lang_detected: string | null; first_seen: string | null; last_seen: string | null; author_status: string | null; topic: string | null;
  // link_seen = pages.last_seen = zuletzt VERLINKT gesehen (nicht: zuletzt gescannt).
  // link_resighted = nach der Entdeckung erneut gesichtet → Stille ist ein Abgangs-Beleg.
  link_seen: string | null; link_resighted: boolean | null;
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
const META_LABEL: Record<string, string> = { description: "Teaser", topic: "Ressort", paywalled: "Paywall", author_status: "Autor" };
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
// Echte stille Re-Datierung? Eine Veröffentlichungszeit, die RÜCKWÄRTS springt oder um Monate
// abweicht, ist fast immer eine Fehl-Extraktion (Seiten tragen mehrere Datums-Signale: Original,
// „aktualisiert", verwandte Artikel) — KEIN echtes „still geändert". Sonst falsche Datums-Meldungen
// verlagsübergreifend (z.B. Art. 34243: 2026-06-18 → 2025-11-14, 7 Monate rückwärts). Plausibel =
// vorwärts und höchstens ~30 Tage (so wie Verlage Artikel „auffrischen").
function realDateShift(oldIso: string | null, newIso: string | null): boolean {
  if (!oldIso || !newIso) return false;
  const a = new Date(oldIso).getTime(), b = new Date(newIso).getTime();
  if (!a || !b || a === b) return false;
  const days = (b - a) / 864e5;
  return days > 0 && days <= 30;
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
  const [onlineCut, setOnlineCut] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("article_detail").select("*").eq("id", id).single();
      if (!data) { setLoading(false); return; }
      setA(data as Detail);
      const [au, kw, cat, sn, cut] = await Promise.all([
        supabase.from("article_authors").select("authors(name)").eq("article_id", id),
        supabase.from("article_keywords").select("keywords(term)").eq("article_id", id),
        supabase.from("article_categories").select("categories(name)").eq("article_id", id),
        supabase.from("article_snapshots").select("*").eq("article_id", id).order("captured_at", { ascending: true }),
        // Jüngste Link-Sichtung DERSELBEN QUELLE = Bezugspunkt für „noch verlinkt" — deren
        // Crawl-Rhythmus zählt, nicht der einer anderen. Gegen „jetzt" zu messen wäre falsch,
        // sobald der Crawler pausiert (dann wäre alles „raus"). Toleranz quellenspezifisch
        // (Discovery-Abdeckung: n-tv stündlich komplett, Tagesschau/FAZ nur gesampelt).
        // GLEICHE Seitentyp-Einschränkung wie der Dashboard-Corpus (FilterProvider/onlineCutsFrom) —
        // sonst driftet dieser Cut von dem im Rest der App auseinander, weil Hub-/Video-/Werbe-
        // Seiten hier mitzählen würden, dort aber nicht (ALLOWED_PTYPES). Eine Wahrheit.
        supabase.from("page_overview").select("link_seen").eq("source_id", (data as Detail).source_id)
          .in("ptype", ALLOWED_PTYPES)
          .order("link_seen", { ascending: false, nullsFirst: false }).limit(1),
      ]);
      const newestLink = ((cut.data ?? []) as any[])[0]?.link_seen as string | undefined;
      setOnlineCut(newestLink
        ? new Date(Date.parse(newestLink) - onlineToleranceMs((data as Detail).source_id)).toISOString()
        : null);
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
      // Anteil der Peers strikt unter v. Deckel bei 99 %: der Artikel selbst steckt in arr, kann also
      // nie „länger als 100 %" sein (das las sich absurd) — und die abgeleiteten Radar-Achsen maxen
      // damit nicht mehr exakt auf den Außenring aus.
      const pctBelow = (arr: number[], v: number) => arr.length ? Math.min(99, Math.round((arr.filter((x) => x < v).length / arr.length) * 100)) : 0;

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
    const pubEff = effPublished(a.published_at, a.first_seen);
    const pub = pubEff ? Date.parse(pubEff) : NaN;
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
    if (snaps.some((s) => realDateShift(s.pubdate_old, s.pubdate_new))) insight = "Das Veröffentlichungsdatum wurde nachträglich verschoben — eine Änderung, die Leser nie zu sehen bekommen.";
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

  // Cross-Version-Dedup für Liveblogs: je Snapshot die Absatz-Keys, die in FRÜHEREN Versionen
  // schon gezeigt wurden → ChangeCard blendet die dort aus (kein doppeltes Anzeigen desselben
  // Ticker-Eintrags über viele Versionen, Art. 5830).
  const dupKeysPerSnap = useMemo(() => {
    const seen = new Set<string>();
    return snaps.map((s) => {
      const before = new Set(seen);
      const paras = (s.changes ?? []).filter((c) => c.new && !c.old).map((c) => decodeEntities(c.new ?? "").trim()).filter(Boolean);
      const own = paras.length ? paras : (s.added ? [decodeEntities(s.added).trim()] : []);
      for (const p of own) seen.add(paraKey(p));
      return before;
    });
  }, [snaps]);

  if (loading) return <div className="page detail"><p className="faint">Lade…</p></div>;
  if (!a) return <div className="page detail"><p className="faint">Artikel nicht gefunden.</p></div>;

  const segs = (() => { try { return new URL(a.url).pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean); } catch { return []; } })();
  const type = a.article_type ?? "news";
  // Online-Bestand, DREI Zustände: „noch verlinkt" = letzte LINK-Sichtung innerhalb der Toleranz.
  // „rausgeflogen" = Sichtung älter als Toleranz UND der Link wurde nach der Entdeckung je
  // WIEDER-gesichtet (link_resighted) — nur dann ist Stille ein Beleg. Einmal-Sichtungen
  // (Nischen-Ressorts außerhalb der Sampling-Umlaufbahn, Art. 1640704) = „unbekannt": kein
  // Badge, kein roter Punkt. Bezugsgröße ist NIE der letzte Scan (budgetiert, sagt nichts).
  const link: { state: "online" | "gone" | "unknown"; since: string } | null =
    a.link_seen && onlineCut
      ? Date.parse(a.link_seen) >= Date.parse(onlineCut)
        ? { state: "online", since: a.link_seen }
        : a.link_resighted === true
          ? { state: "gone", since: a.link_seen }
          : { state: "unknown", since: a.link_seen }
      : null;

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
        {link?.state === "gone" && <span className="badge gone"><Link2Off /> Rausgeflogen</span>}
        {link?.state === "online" && <span className="badge online"><Link2 /> Noch verlinkt</span>}
      </div>
      <h1 className="d-title">{a.title ?? a.url.replace(/^https?:\/\/(www\.)?/, "")}</h1>
      {a.description && <p className="d-dek">{a.description}</p>}
      {categories.length > 0 && (
        <div className="cat-banner">
          <span className="cat-label">Ressort</span>
          <div className="cat-chips">{categories.map((x) => <span key={x} className="cat-chip">{x}</span>)}</div>
        </div>
      )}
      {/* 2-spaltig: LINKS (2/3) der Artikel selbst — erst Identität (Eckdaten, Status,
          Schlagwörter, Autoren, Seitenbaum), dann der zeitliche Block (Scan-Verlauf, Profil,
          GANZ UNTEN Änderungsverlauf). RECHTS (1/3) margns Analyse — Link, Radar, Einordnung,
          Nachbarn. Verlagsbilder (og_image) werden aus Urheberrechtsgründen NIRGENDS eingebunden. */}
      <div className="d-grid">
        {/* Linke Spalte (breit): das Stück + seine Fakten */}
        <aside className="d-aside">
          {/* Eckdaten (Zeit/Umfang/Sprache) */}
          <DL h="Eckdaten">
            <div className="statrow">
              {a.published_at ? (
                <Stat k="Veröffentlicht" v={fmtDate(effPublished(a.published_at, a.first_seen))}
                  sub={a.first_seen
                    ? (Date.parse(a.published_at) > Date.parse(a.first_seen)
                      ? "auf Erstsichtung datiert (Verlagsdatum lag danach)"
                      : `Erfasst ${timeDelta(a.published_at, a.first_seen)} später`)
                    : undefined} />
              ) : (
                <Stat k="Veröffentlicht" v="Kein Datum vom Verlag" sub={a.first_seen ? `Erster Scan: ${fmtDate(a.first_seen)}` : undefined} />
              )}
              {a.modified_at && a.modified_at !== a.published_at && <Stat k="Aktualisiert" v={fmtDate(a.modified_at)} />}
              {a.word_count ? <Stat k="Umfang" v={`${a.word_count.toLocaleString("de-DE")} Wörter`} /> : null}
              {a.reading_min ? <Stat k="Lesezeit" v={`${a.reading_min} Min`} /> : null}
              <Stat k="Sprache" v={LANG[a.lang_detected ?? ""] ?? a.lang_detected ?? "—"} />
            </div>
          </DL>

          <DL h="Online-Bestand">
            {!link ? (
              <span className="faint" style={{ fontSize: 13 }}>Verlinkung unbekannt — für diese Seite liegt keine Link-Sichtung vor.</span>
            ) : link.state === "gone" ? (
              <>
                <span className="badge gone"><Link2Off /> Rausgeflogen</span>
                <p className="faint" style={{ fontSize: 13, marginTop: 10 }}>
                  Zuletzt verlinkt gesehen am <b>{fmtDate(link.since)}</b> — seither taucht der Artikel
                  auf keiner Startseite, keinem Ressort, in keinem Feed und keiner Sitemap mehr auf
                  (seit {timeDelta(link.since, new Date().toISOString())}).
                </p>
              </>
            ) : link.state === "online" ? (
              <>
                <span className="badge online"><Link2 /> Noch verlinkt</span>
                <p className="faint" style={{ fontSize: 13, marginTop: 10 }}>
                  Zuletzt verlinkt gesehen am <b>{fmtDate(link.since)}</b> — der Verlag führt den Artikel
                  weiterhin auf mindestens einer Übersichtsseite, im Feed oder in der Sitemap.
                </p>
              </>
            ) : (
              <p className="faint" style={{ fontSize: 13, margin: 0 }}>
                Verlinkung unbekannt — der Link wurde nur bei der Entdeckung gesehen
                ({fmtDate(link.since)}). Sein Ressort liegt außerhalb der regelmäßigen
                Beobachtung, daher ist das Ausbleiben weiterer Sichtungen kein Beleg für
                einen Abgang.
              </p>
            )}
          </DL>

          <DL h={`Schlagwörter${keywords.length ? ` · ${keywords.length}` : ""}`}>
            {keywords.length > 0
              ? <div className="row">{keywords.map((x) => <span key={x} className="tag">{x}</span>)}</div>
              : <span className="faint" style={{ fontSize: 13 }}>Keine Schlagwörter im Quelltext gefunden (oder noch nicht erfasst).</span>}
          </DL>

          <DL h="Autoren">
            {a.author_status === "named" && authors.length > 0
              ? <div className="row">{authors.map((x) => <span key={x} className="tag a">{x}</span>)}</div>
              : a.author_status === "anonymous"
              ? <span className="badge wait">Redaktion / Agentur{authors.length ? ` · ${authors.join(", ")}` : ""}</span>
              : <span className="badge neutral">Kein Autor genannt</span>}
          </DL>

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

          {/* Ab hier der zeitliche/beobachtende Block (vorher zwischen den Identitäts-Metadaten
              zerrissen): Rohdaten-Chart -> verdichtete Synthese -> volles Log, dieselbe
              Übersicht-vor-Detail-Kaskade wie rechts (Radar -> Einordnung -> Nachbarn). */}
          <DL h="Scan-Verlauf">
            <ScanTimeline firstSeen={a.first_seen} lastSeen={a.last_seen} scanTimes={a.scan_times} scanCount={a.scan_count}
              changeTimes={snaps.map((s) => s.captured_at)}
              goneAt={link?.state === "gone" ? link.since : null} />
          </DL>

          {/* Verhaltensprofil — direkt über dem Änderungsverlauf */}
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

          {/* Änderungsverlauf — ganz unten links */}
          <DL h="Änderungsverlauf">
            <div className="chist">
              <ChistAnchor kind="pub"
                label={a.published_at ? "Veröffentlicht" : "Erstmals erfasst"}
                time={effPublished(a.published_at, a.first_seen) ?? a.first_seen}
                sub={a.published_at ? "Erstfassung des Verlags" : "Kein Verlagsdatum — erster Scan"} />
              {snaps.length === 0 ? (
                <div className="chist-none">
                  Seither <strong>keine Änderung erfasst</strong> — Überschrift, Text, Datum, Teaser,
                  Ressort, Paywall-Status und Autor sind unverändert. Sobald margn etwas Stilles entdeckt,
                  erscheint hier jede Version mit Vorher/Jetzt-Vergleich.
                </div>
              ) : (
                snaps.map((s, i) => <ChangeCard key={s.id} s={s} v={i + 1} dupKeys={dupKeysPerSnap[i]} />)
              )}
              <ChistAnchor kind="now" label="Aktuelle Fassung" time={a.last_seen}
                sub={snaps.length > 0 ? `${snaps.length} Änderung${snaps.length !== 1 ? "en" : ""} erfasst · zuletzt geprüft` : "zuletzt geprüft, unverändert"} />
            </div>
          </DL>
        </aside>

        {/* Rechte Spalte (schmal): Link + margns Analyse */}
        <div className="d-main">
          <div className="d-cta-bar">
            <ExtLink href={a.url} className="cta d-cta">Originalartikel öffnen <External size={15} /></ExtLink>
          </div>
          <div className="d-info">
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
          </div>
        </div>
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
type Op = { t: string; op: "eq" | "del" | "ins" | "repl" | "skip" | "trunc" };
function inlineOps(oldS: string, newS: string): Op[] {
  // Token = Wort INKL. nachfolgendem Whitespace. Wichtig: KEINE eigenständigen Whitespace-Tokens,
  // sonst matchen die Leerzeichen im LCS und verankern völlig verschiedene Texte Wort für Wort
  // (→ „Konfetti" mit Schraffur zwischen jedem Wort, v.a. bei Überschriften). So zerfällt ein
  // komplett anderer Tail sauber in EINEN del- + EINEN ins-Block.
  const o = oldS.match(/\S+\s*/gu) ?? [], n = newS.match(/\S+\s*/gu) ?? [];
  const m = o.length, k = n.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--)
    dp[i][j] = o[i] === n[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw: Op[] = []; let i = 0, j = 0;
  while (i < m || j < k) {
    if (i < m && j < k && o[i] === n[j]) { raw.push({ t: o[i], op: "eq" }); i++; j++; }
    else if (i < m && (j >= k || dp[i + 1][j] >= dp[i][j + 1])) { raw.push({ t: o[i], op: "del" }); i++; }
    else { raw.push({ t: n[j], op: "ins" }); j++; }
  }
  for (let x = 1; x < raw.length - 1; x++) if (/^\s+$/.test(raw[x].t) && raw[x].op === "eq" && raw[x - 1].op === raw[x + 1].op && raw[x - 1].op !== "eq") raw[x].op = raw[x - 1].op;
  const segs: Op[] = [];
  for (const r of raw) { const l = segs[segs.length - 1]; if (l && l.op === r.op) l.t += r.t; else segs.push({ ...r }); }
  // Unterscheidet sich ein del/ins-Paar NUR in Satzzeichen/Whitespace/Groß-Klein (typisch: ein
  // nachträglich gesetztes Komma, „plant" → „plant,", Art. 1531034), dann NICHT das ganze Wort
  // durchstreichen + neu einfügen, sondern ZEICHENGENAU diffen — sichtbar bleibt nur das Komma.
  // Der Buchstaben/Ziffern-Vergleich garantiert, dass hier kein echter Wortwechsel char-weise
  // zerhackt wird (das bliebe ein sauberer del/ins-Block).
  const refined: Op[] = [];
  for (let x = 0; x < segs.length; x++) {
    const a = segs[x], b = segs[x + 1];
    if (a.op === "del" && b && b.op === "ins" && a.t.length <= 400 && b.t.length <= 400 &&
        alnumOnly(a.t) !== "" && alnumOnly(a.t) === alnumOnly(b.t)) {
      refined.push(...charOps(a.t, b.t)); x++; continue;
    }
    refined.push(a);
  }
  const segs2 = mergeOps(refined);
  for (let x = 1; x < segs2.length; x++) if (segs2[x].op === "ins" && segs2[x - 1].op === "del") segs2[x].op = "repl";
  return segs2;
}
// Buchstaben+Ziffern eines Segments (klein, ohne Satzzeichen/Whitespace) — Gleichheit heißt:
// es änderte sich NUR Interpunktion/Schreibweise.
function alnumOnly(s: string): string { return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); }
// Zeichen-genauer LCS-Diff. Nur für kurze, nachweislich fast identische Segmente (s. inlineOps),
// sonst entstünde unlesbares Zeichen-Konfetti.
function charOps(a: string, b: string): Op[] {
  const m = a.length, k = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Op[] = []; let i = 0, j = 0;
  while (i < m || j < k) {
    if (i < m && j < k && a[i] === b[j]) { out.push({ t: a[i], op: "eq" }); i++; j++; }
    else if (i < m && (j >= k || dp[i + 1][j] >= dp[i][j + 1])) { out.push({ t: a[i], op: "del" }); i++; }
    else { out.push({ t: b[j], op: "ins" }); j++; }
  }
  return out;
}
// Lange Body-Diffs (Ticker/Liveblog/Riesenabsatz wie n-tv) auf ZEILEN-Ebene diffen statt
// Wort-Ebene: ein Wort-LCS über zwei verschobene 1500-Zeichen-Fenster matcht zufällig
// wiederkehrende Tokens („Uhr:", „Gruppe", Städtenamen) und produziert Wort-Konfetti.
// Stattdessen in sinnvolle „Zeilen" segmentieren (Ticker-Zeit-/Datums-Marker + Satzgrenzen),
// dann LCS über ganze Zeilen → entfernte/ergänzte Einträge erscheinen als saubere Blöcke.
function splitLines(s: string): string[] {
  const parts = s.split(
    /(?=\d{1,2}[.:]\d{2}\s*Uhr)|(?=(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),\s*\d)|(?<=[.!?»“"])(?=[A-ZÄÖÜ])/u
  );
  return parts.filter((p) => p.length > 0);
}
function lineOps(oldS: string, newS: string): Op[] {
  const o = splitLines(oldS), n = splitLines(newS);
  const m = o.length, k = n.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(k + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--)
    dp[i][j] = o[i] === n[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: Op[] = []; let i = 0, j = 0;
  while (i < m || j < k) {
    if (i < m && j < k && o[i] === n[j]) { ops.push({ t: o[i], op: "eq" }); i++; j++; }
    // del-ZUERST bei Gleichstand (wie inlineOps) — sonst kommt eine geänderte Zeile als
    // ins→del heraus, und refineLineOps (das NUR del→ins zu Wort-Diff verfeinert) greift nie
    // → man sieht den ganzen Absatz rot UND grün statt nur der geänderten Wörter (Art. 393012).
    else if (i < m && (j >= k || dp[i + 1][j] >= dp[i][j + 1])) { ops.push({ t: o[i], op: "del" }); i++; }
    else { ops.push({ t: n[j], op: "ins" }); j++; }
  }
  return ops;
}
// GEÄNDERTE Passagen zwischen zwei unveränderten Zeilen als Wort-Diff verfeinern. WICHTIG:
// über den ganzen LAUF (alle del- + alle ins-Zeilen der Region gebündelt), nicht Zeile-für-Zeile —
// der Zeilen-LCS findet bei leicht redigierten Absätzen oft KEINE exakt gleiche Zeile, und eine
// 1:1-Paarung einzelner Zeilen greift dann nie. Ergebnis war ein ~2000-Zeichen-Block, der komplett
// durchgestrichen und fast identisch wieder eingefügt wurde (Art. 1084636 V1/V3). Erst wenn die
// gebündelten Alt-/Neu-Texte wirklich UNÄHNLICH sind, bleiben es zwei saubere Blöcke.
function refineLineOps(ops: Op[]): Op[] {
  const out: Op[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op === "eq") { out.push(ops[i]); i++; continue; }
    let j = i; const dels: string[] = [], inss: string[] = [];
    while (j < ops.length && ops[j].op !== "eq") {
      if (ops[j].op === "del") dels.push(ops[j].t); else inss.push(ops[j].t);
      j++;
    }
    const oldT = dels.join(""), newT = inss.join("");
    if (oldT && newT && jaccard(normTxt(oldT), normTxt(newT)) >= 0.4) out.push(...inlineOps(oldT, newT));
    else {
      if (oldT) out.push({ t: oldT, op: "del" });
      if (newT) out.push({ t: newT, op: "ins" });
    }
    i = j;
  }
  return out;
}
// Abgeschnittenen Schluss als neutrales „…" versiegeln (VERSATZ, kein echter Zugewinn):
// Der Scraper kappt gespeicherte Absätze bei 2000 Zeichen — oft MITTEN IM WORT. Die alte
// Fassung endet dann früher als die neue (z.B. „…der F"), und der Diff zeigt das angeschnittene
// Wort rot + den ganzen Rest grün, obwohl dort gar nichts „hinzugefügt" wurde, sondern nur
// außerhalb des erfassten Ausschnitts lag. Erkennen: die LETZTE Abweichung ist ein einzelnes,
// am Wortende angeschnittenes del-Token (kein folgender Whitespace), gefolgt NUR von ins/repl,
// deren erstes genau dieses Wort fortsetzt. Dann del + ins-Schwanz durch ein „…" ersetzen.
function sealTruncatedTail(ops: Op[], netWd = 0): Op[] {
  let di = -1;
  for (let i = ops.length - 1; i >= 0; i--) {
    if (ops[i].op === "del") { di = i; break; }
    if (ops[i].op !== "ins" && ops[i].op !== "repl") return ops; // hinter dem Schwanz steht echter Text → kein Trunkierungsfall
  }
  if (di < 0 || di === ops.length - 1) return ops;
  const d = ops[di].t;
  if (/\s/.test(d.trim()) || /\s$/.test(d)) return ops;            // EIN Token, am Ende angeschnitten (kein Trenner danach)
  if (!ops[di + 1].t.trimStart().startsWith(d.trim())) return ops; // die Ergänzung setzt genau dieses Wort fort
  // NUR als echter Zugewinn ZEIGEN, wenn der Body überhaupt GEWACHSEN ist (netWd>0) UND der
  // angeschnittene Schwanz ungefähr diesem Wachstum entspricht (echte Ergänzung, z.B. Art. 19682
  // +305). Sonst — Body schrumpfte/stagnierte ODER der Schwanz ist viel länger als der Netto-
  // Zuwachs — ist der Schwanz ein reines CAP-ARTEFAKT (alte Fassung mitten im Wort gekürzt) →
  // versiegeln. (Fix: vorher `Math.abs(netWd)`; bei einem Edit MIT Wortverlust an anderer Stelle
  // wurde der abgeschnittene Wortrest fälschlich stehengelassen → „EinsatzkrEinsatzkräfte…",
  // Art. 343940 V12, word_delta=−6.)
  const tailWords = ops.slice(di + 1).reduce((s, o) => s + ((o.t.match(/\S+/g) ?? []).length), 0);
  // Echter Zugewinn: zeigen — aber OHNE das angeschnittene Alt-Fragment. Die Ergänzung beginnt
  // mit genau diesem Wort, ein durchgestrichenes „e" vor grünem „einigen…" ist reiner Cap-Müll.
  if (netWd > 0 && tailWords <= netWd + 6) return [...ops.slice(0, di), ...ops.slice(di + 1)];
  return [...ops.slice(0, di), GAP];
}
// Auslassungs-Marker. Trägt bewusst KEINEN Text — gerendert wird eine visuelle Trennung.
const GAP: Op = { t: "", op: "trunc" };
// Benachbarte gleichartige Segmente wieder verschmelzen (nach Umklassifizierungen).
function mergeOps(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const r of ops) { const l = out[out.length - 1]; if (l && l.op === r.op) l.t += r.t; else out.push({ ...r }); }
  return out;
}
// (1) Ein del + direkt folgendes ins/repl, die sich NUR im Whitespace unterscheiden, ist KEINE
// sichtbare Änderung — typisch der Absatz-Join im Scraper, der ein Leerzeichen verschluckt
// („…bänder. Sheriff" → „…bänder.Sheriff"). Als unverändert (eq) zeigen statt durchstreichen +
// fast identisch wieder einfügen (genau das vom User verlangte „kein 90 %-Block-Pendeln").
function mergeWhitespaceEdits(ops: Op[]): Op[] {
  const strip = (s: string) => s.replace(/\s+/g, "");
  const out: Op[] = [];
  for (let i = 0; i < ops.length; i++) {
    const cur = ops[i], nxt = ops[i + 1];
    if (cur.op === "del" && nxt && (nxt.op === "ins" || nxt.op === "repl") && strip(cur.t) === strip(nxt.t)) {
      out.push({ t: nxt.t, op: "eq" }); i++;
    } else out.push(cur);
  }
  return mergeOps(out);
}
// (2) „Wort-Konfetti" einsammeln: Zwei WIRKLICH verschiedene, lange Passagen, die das Wort-LCS nur
// an zufällig gleichen Mini-Wörtern („von", „ein", „der") verzahnt, als EINEN sauberen
// durchgestrichenen Block + EINEN grünen Block zeigen — nicht Wort für Wort verschränkt. Greift NUR
// bei langen, UNÄHNLICHEN Regionen zwischen echten Ankern; kleine/ähnliche Edits bleiben Wort-Diff.
function collapseConfetti(ops: Op[]): Op[] {
  const isAnchor = (o: Op) => o.op === "eq" && normTxt(o.t).length > 16;
  const out: Op[] = []; let region: Op[] = [];
  const flush = () => {
    const changes = region.filter((o) => o.op !== "eq").length;
    const tinyEqs = region.filter((o) => o.op === "eq").length;
    const oldT = region.filter((o) => o.op === "eq" || o.op === "del").map((o) => o.t).join("");
    const newT = region.filter((o) => o.op === "eq" || o.op === "ins" || o.op === "repl").map((o) => o.t).join("");
    const big = oldT.length >= 120 || newT.length >= 120;
    if (changes >= 2 && tinyEqs >= 1 && big && jaccard(normTxt(oldT), normTxt(newT)) < 0.6) {
      if (oldT.trim()) out.push({ t: oldT, op: "del" });
      if (newT.trim()) out.push({ t: newT, op: "ins" });
    } else out.push(...region);
    region = [];
  };
  for (const o of ops) {
    if (isAnchor(o)) { if (region.length) flush(); out.push(o); }
    else region.push(o);
  }
  if (region.length) flush();
  return mergeOps(out);
}
// (3) Versatz am ANFANG versiegeln: Beginnt der Diff mit einem großen, REINEN del-Block VOR dem
// ersten gemeinsamen Anker (das neue Snippet fängt schlicht später im selben Text an, weil die
// erfassten Alt-/Neu-Fenster nicht bündig sind), ist dieser Text NICHT entfernt — er lag außerhalb
// des erfassten Ausschnitts und steht im echten Artikel weiter oben. Darum „…" statt Durchstreichen
// (User: „DARF UNTER KEINEN UMSTÄNDEN" als gelöscht erscheinen, was real noch da ist, Art. 567492).
function sealMisalignedHead(ops: Op[]): Op[] {
  const e = ops.findIndex((o) => o.op === "eq");
  if (e <= 0) return ops;                                  // kein führender Block oder gar kein Anker
  const head = ops.slice(0, e);
  if (!head.every((o) => o.op === "del")) return ops;      // reiner Alt-Vorspann (kein neuer Text davor)
  const headLen = head.reduce((s, o) => s + o.t.length, 0);
  if (headLen < 100) return ops;                           // kleiner Vorspann = echte Änderung → zeigen
  if (normTxt(ops[e].t).length < 24) return ops;           // der folgende Anker muss echt sein
  return [GAP, ...ops.slice(e)];
}
// (4) Versatz am ENDE versiegeln — das Gegenstück zu sealMisalignedHead und die Ursache der vom
// User gemeldeten „mehrfach gelöschten" Passagen (Art. 453089): Bei rollenden Artikeln (oben kommt
// täglich ein Eintrag dazu) rutscht hinten Text aus dem 1500/2000-Zeichen-Erfassungsfenster.
// Der Diff endet dann nach dem letzten Anker mit einem GROSSEN del-Block plus höchstens einem
// Mini-ins (dem am Cap angeschnittenen Anfang desselben Textes, z.B. „Achte…"). Dieser Text ist
// NICHT gelöscht — er steht im Artikel weiter unten. Erkennen: das Mini-ins ist ein PRÄFIX des
// del-Blocks (die Fenster überlappen exakt dort), UND die Wort-Bilanz des Scans widerspricht
// einem Verlust dieser Größe. Ein ECHTER Schluss-Wegfall (netWd entsprechend negativ) bleibt rot.
function sealMisalignedTail(ops: Op[], netWd = 0): Op[] {
  let e = -1;
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i].op === "eq" && normTxt(ops[i].t).length >= 24) { e = i; break; }
  if (e < 0 || e === ops.length - 1) return ops;
  const tail = ops.slice(e + 1);
  if (tail.some((o) => o.op === "trunc")) return ops;      // bereits versiegelt
  const oldT = tail.filter((o) => o.op === "eq" || o.op === "del").map((o) => o.t).join("");
  const newT = tail.filter((o) => o.op === "eq" || o.op === "ins" || o.op === "repl").map((o) => o.t).join("");
  if (oldT.length < 120 || normTxt(newT).length > 40) return ops;
  const a = normTxt(oldT).toLowerCase(), b = normTxt(newT).toLowerCase();
  if (b && !a.startsWith(b)) return ops;                   // Neu-Rest muss den Alt-Block fortsetzen (Fenster-Überlapp)
  const lostWords = (oldT.match(/\S+/g) ?? []).length;
  if (netWd < 0 && -netWd >= lostWords / 2) return ops;    // Verlust in dieser Größenordnung real → zeigen
  return [...ops.slice(0, e + 1), GAP];
}
// Alle Aufräum-Schritte in fester Reihenfolge: erst Whitespace-Joins tilgen (vergrößert die echten
// Anker), dann Konfetti zu Blöcken bündeln, dann Anfangs-/Schluss-Versatz versiegeln.
function finalizeOps(ops: Op[], netWd = 0): Op[] {
  const cleaned = collapseConfetti(mergeWhitespaceEdits(ops));
  const sealed = mergeOps(sealTruncatedTail(sealMisalignedTail(sealMisalignedHead(cleaned), netWd), netWd));
  // Das Versiegeln (Anfangs-/Schluss-Versatz → „…") darf die EINZIGE sichtbare Änderung nicht
  // wegputzen. Sonst erscheint „Unterschied außerhalb des erfassten Ausschnitts", obwohl real etwas
  // editiert wurde — typisch eine am Absatzanfang/-ende entfernte Foto-Caption/Zeitmarke oder ein
  // eingeschobenes Zitat (Art. 1569057, 1504824). Rollende Ticker liefern KEINE old/new-Paare mehr
  // (isTimeline = nur Zugänge) → ein Rand-del in einem Paar ist stets ein echter Edit, kein Fenster-
  // Versatz. Bleibt nach dem Versiegeln nichts Sichtbares, aber vorher schon → ungesiegelt zeigen.
  const visible = (o: Op[]) => o.some((x) => x.op === "del" || x.op === "ins" || x.op === "repl");
  if (!visible(sealed) && visible(cleaned)) return mergeOps(cleaned);
  return sealed;
}
// Am Zeichen-Cap abgeschnittener Alt-Text: `oldS` endet mit einem Wortfragment (≥4 Buchstaben),
// dessen vollständige Form (ein längeres Wort mit gleichem Präfix) in `newS` vorkommt → der
// gespeicherte Alt-Body war gekappt (2000/8000-Cap), das Fragment ist ein Kappungs-Artefakt, KEIN
// echter Textverlust. Verlagsübergreifend (Bild/n-tv/… Einzel-Mega-Absätze, s. capParas). Gibt das
// abzuschneidende Fragment zurück; das Präfix-in-`newS`-Kriterium schließt vollständige Endwörter aus.
function truncatedFrag(oldS: string, newS: string): string | null {
  if (oldS.length < 200 || /[…\s]$/u.test(oldS)) return null;
  const m = oldS.match(/\p{L}{4,}$/u);
  if (!m) return null;
  const frag = m[0].toLowerCase();
  const words = newS.toLowerCase().match(/\p{L}+/gu) ?? [];
  return words.some((w) => w.length > frag.length && w.startsWith(frag)) ? m[0] : null;
}
// „Veröffentlicht" kann NIE nach dem ersten Scan liegen — wir sahen den Artikel ja bereits. Ein
// späteres Verlagsdatum ist eine Vorwärts-Fehldatierung (die Backward-Klemme im Scraper ließ pubdate
// über first_seen hinauswandern). Fürs Display auf first_seen klemmen, damit die Zeitachse stimmt
// (sonst erscheint eine „stille Änderung" VOR der Veröffentlichung). Verlagsübergreifend.
function effPublished(pub: string | null, firstSeen: string | null): string | null {
  if (pub && firstSeen && Date.parse(pub) > Date.parse(firstSeen)) return firstSeen;
  return pub;
}
// Zeilen-Diff in „Hunks" zerlegen: zusammenhängende Änderungen + etwas Kontext = EIN Hunk.
// Sind mehrere Änderungsstellen weit auseinander, entstehen mehrere Hunks → mehrere kleine
// Boxen statt einer riesigen (User-Wunsch: „mehrere Boxen statt 1 großen, logisch gesplittet").
function toHunks(ops: Op[], ctx = 2): Op[][] {
  // Nur ECHTE Änderungen eröffnen einen Hunk — eine Auslassungs-Lücke ist keine Änderung
  // (sonst entstünde eine eigene „Stelle" die nur aus einem Trenner besteht).
  const ch = ops.map((o, i) => (o.op === "del" || o.op === "ins" || o.op === "repl" ? i : -1)).filter((i) => i >= 0);
  if (!ch.length) return [];
  const groups: [number, number][] = [];
  let start = ch[0], prev = ch[0];
  for (let x = 1; x < ch.length; x++) {
    if (ch[x] - prev - 1 > ctx * 2) { groups.push([start, prev]); start = ch[x]; }
    prev = ch[x];
  }
  groups.push([start, prev]);
  return groups.map(([a, b]) => ops.slice(Math.max(0, a - ctx), Math.min(ops.length, b + ctx + 1)));
}
// Lange Kontext-Zeilen an den Hunk-Rändern kürzen (zur Änderung hin), damit ein Hunk kompakt bleibt.
// Kontext an WORTGRENZEN kappen — ein mitten im Wort beginnender Block („ters. Während…") liest
// sich wie ein Textfehler. head = Ende behalten (vorne sauber anschneiden), tail = Anfang behalten.
function cutHead(s: string, n: number): string { return s.slice(-n).replace(/^\S*\s+/u, ""); }
function cutTail(s: string, n: number): string { return s.slice(0, n).replace(/\s+\S*$/u, ""); }
function trimHunk(h: Op[]): Op[] {
  // Gekürzter Kontext wird als visuelle Lücke markiert, NICHT als „…" im Textfluss.
  return h.flatMap((o, i) => {
    if (o.op !== "eq" || o.t.length <= 160) return [o];
    if (i === 0) return [GAP, { ...o, t: cutHead(o.t, 120) }];
    if (i === h.length - 1) return [{ ...o, t: cutTail(o.t, 120) }, GAP];
    return [{ ...o, t: cutTail(o.t, 80) }, GAP, { ...o, t: cutHead(o.t, 80) }];
  });
}
// Eine einzelne Diff-Box — UNIFIED inline (wie Section 3 der Landingpage): EIN Textfluss,
// Entferntes rot durchgestrichen + ausgegraut, Hinzugefügtes grün. KEINE Vorher/Jetzt-Spalten,
// KEINE Schraffur auf dem Text — so wie echte Diff-Tools (und vom User explizit gewünscht).
function DiffBox({ ops, label, kind }: { ops: Op[]; label: string; kind: string }) {
  // ops sind bereits durch finalizeOps aufgeräumt/versiegelt (siehe DiffBlock) — hier nur rendern.
  const changed = ops.some((o) => o.op === "del" || o.op === "ins" || o.op === "repl");
  return (
    <div className={`dq ${kind}`}>
      <div className="dq-lbl"><span className="dq-pm">±</span>{label}</div>
      {!changed ? (
        <div className="dq-body"><span className="faint" style={{ fontSize: 12.5 }}>Unterschied außerhalb des erfassten Ausschnitts</span></div>
      ) : (
        <div className="dq-uni">
          {ops.map((o, i) =>
            // Auslassung = echte visuelle Trennung, KEIN „…" im Textfluss (sonst liest sich ein
            // Sprung wie fortlaufender Text, obwohl dahinter ein ganz anderer Absatz stehen kann).
            o.op === "skip" || o.op === "trunc"
              ? <span key={i} className="dq-gap" role="separator" title="Sprung: Hier fehlt Text — die Blöcke hängen nicht zusammen" />
            : o.op === "del" ? <del key={i} className="dq-uni-del">{o.t}</del>
            : o.op === "ins" || o.op === "repl" ? <ins key={i} className="dq-uni-ins">{o.t}</ins>
            : <span key={i}>{o.t}</span>
          )}
        </div>
      )}
    </div>
  );
}
// Side-by-Side: Vorher links, Jetzt rechts. Kurze Diffs (Titel/Teaser) = EINE Box mit Wort-Diff.
// Lange Body-Texte (Ticker/Liveblog/Riesenabsatz) = Zeilen-Diff, in MEHRERE Boxen je Änderungsstelle
// gesplittet statt einer riesigen Box.
function DiffBlock({ oldS, newS, label, kind = "edit", netWd = 0 }: { oldS: string; newS: string; label: string; kind?: "edit" | "title" | "meta"; netWd?: number }) {
  oldS = decodeEntities(oldS); newS = decodeEntities(newS);
  // Kappungs-Schwanz abfangen: angeschnittenes Endwort aus oldS strippen + neutrale Lücke anhängen,
  // statt ein halbes Wort („beko", „Arbe") als „gelöscht" zu zeigen. Greift für ALLE Verlage.
  // WICHTIG: auf den ORIGINAL-Strings prüfen — truncatedFrag verlässt sich auf einen evtl.
  // vorhandenen „…"-Endmarker, der gleich darunter entfernt wird.
  const frag = truncatedFrag(oldS, newS);
  let oldE = frag ? oldS.slice(0, oldS.length - frag.length).replace(/\s+$/u, "") : oldS;
  let newE = newS;
  // Der Scraper (diffRegion) klebt „…" an Anfang/Ende des gespeicherten Fensters. Als TEXT gerendert
  // suggeriert das einen zusammenhängenden Absatz. Marker entfernen → als visuelle Lücke zeigen.
  const HEAD_ELL = /^\s*…\s*/u, TAIL_ELL = /\s*…\s*$/u;
  const headGap = HEAD_ELL.test(oldE) && HEAD_ELL.test(newE);
  if (headGap) {
    oldE = oldE.replace(HEAD_ELL, ""); newE = newE.replace(HEAD_ELL, "");
    // Hinter dem Marker steht ein angeschnittenes Wort („…ten: Gmail-Nutzer"). Beide Seiten teilen
    // denselben Vorspann (diffRegion schneidet sie am selben Offset) → identisch kappen, sonst
    // entstünde ein Schein-Unterschied. Nur wenn das erste Token wirklich gleich ist.
    const t1 = oldE.match(/^\S*\s+/u)?.[0], t2 = newE.match(/^\S*\s+/u)?.[0];
    if (t1 && t2 && t1 === t2) { oldE = oldE.slice(t1.length); newE = newE.slice(t2.length); }
  }
  const tailGap = TAIL_ELL.test(oldE) || TAIL_ELL.test(newE) || !!frag;
  oldE = oldE.replace(TAIL_ELL, ""); newE = newE.replace(TAIL_ELL, "");
  const seal = (ops: Op[]): Op[] =>
    mergeOps([...(headGap ? [GAP] : []), ...ops, ...(tailGap ? [GAP] : [])]);
  const big = oldE.length + newE.length > 600;
  if (!big) return <DiffBox ops={seal(finalizeOps(inlineOps(oldE, newE), netWd))} label={label} kind={kind} />;
  // METHODENWAHL: WORT-Diff bevorzugen (sauber, markiert nur die geänderten Wörter — auch bei
  // langen Bodys mit verstreuten kleinen Änderungen, Art. 443924). NUR bei KONFETTI (sehr viele
  // verstreute Blöcke, typisch für rollende Ticker mit wiederkehrenden Tokens) auf den ZEILEN-Diff
  // zurückfallen. Anschließend räumt finalizeOps das Ergebnis auf: Whitespace-Joins tilgen,
  // restliches Konfetti zu sauberen Blöcken bündeln, Anfangs-/Schluss-Versatz als „…" versiegeln —
  // damit NIE ein Block durchgestrichen erscheint, der real noch im Artikel steht (Art. 567492).
  const wordOps = inlineOps(oldE, newE);
  const changeBlocks = wordOps.reduce((s, o) => s + (o.op !== "eq" ? 1 : 0), 0);
  const ops = seal(finalizeOps(changeBlocks <= 40 ? wordOps : refineLineOps(lineOps(oldE, newE)), netWd));
  const hunks = toHunks(ops).map(trimHunk);
  if (hunks.length <= 1) {
    return <DiffBox ops={hunks[0] ?? ops} label={label} kind={kind} />;
  }
  return (
    <>
      {hunks.map((h, i) => <DiffBox key={i} ops={h} kind={kind} label={`${label} · Stelle ${i + 1}/${hunks.length}`} />)}
    </>
  );
}

// Roh-Changes „aussöhnen": Manche Snapshots liefern eine geänderte Passage als getrenntes {new}
// + {old} mit (im erfassten Fenster) identischem Text → roh gerendert ZWEI gleiche Textwände
// („neu" + „entfernt"), was keinen Sinn ergibt. Hier: ungepaarte Zu-/Abgänge nach Wort-
// Ähnlichkeit paaren, echte Paare als Wort-Diff führen, sichtbar identische no-op-Paare verwerfen.
function normTxt(s: string): string { return s.replace(/\s+/g, " ").trim(); }
// Roh mitgescrapte HTML-Entities (&nbsp; &amp; …) VOR dem Diffen auflösen — sonst stehen sie als
// sichtbarer Text im Diff („D.&nbsp;C.") und erzeugen falsche Wort-Unterschiede, wenn eine
// Fassung die Entity trägt und die andere das echte Zeichen.
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/&(?:amp|#38);/g, "&");
}
// Normierter Schlüssel eines (Liveblog-)Absatzes für Cross-Version-Dedup.
function paraKey(t: string): string { return t.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120); }
function jaccard(a: string, b: string): number {
  const A = new Set(a.toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? []);
  const B = new Set(b.toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? []);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
function reconcileChanges(raw: Change[]): { items: Change[]; noopDropped: boolean } {
  const paired: Change[] = [], adds: string[] = [], rems: string[] = [];
  for (const c of raw) {
    if (c.old && c.new) paired.push(c);
    else if (c.new) adds.push(c.new);
    else if (c.old) rems.push(c.old);
  }
  const items: Change[] = [];
  let noopDropped = false;
  for (const p of paired) { if (normTxt(p.old!) === normTxt(p.new!)) noopDropped = true; else items.push(p); }
  const usedR = new Set<number>();
  // Verschobene Erfassungsfenster paaren: Bei rollenden Artikeln (täglich neuer Eintrag oben,
  // hinten rutscht Text aus dem Fenster) sind Zu- und Abgang DERSELBE Text, nur versetzt — mit
  // langem gemeinsamem Anfang, aber wegen des ausgetauschten Rests einer Jaccard-Ähnlichkeit
  // unter 0.4. Ungepaart ergäbe das zwei fast identische Textwände „neu" + „entfernt"
  // (Art. 453089 V3) — darum zählt ein Präfix-Überlapp ab 80 Zeichen ebenfalls als Paar.
  const prefixLen = (x: string, y: string) => {
    const a = normTxt(x).toLowerCase(), b = normTxt(y).toLowerCase();
    const n = Math.min(a.length, b.length); let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  };
  for (const a of adds) {
    let best = -1, bestSim = 0;
    rems.forEach((r, i) => { if (usedR.has(i)) return; const s = jaccard(a, r); if (s > bestSim) { bestSim = s; best = i; } });
    if (best < 0 || bestSim < 0.4) {
      let bestP = -1, bestPL = 0;
      rems.forEach((r, i) => { if (usedR.has(i)) return; const l = prefixLen(a, r); if (l > bestPL) { bestPL = l; bestP = i; } });
      if (bestPL >= 80) { best = bestP; bestSim = 1; }
    }
    if (best >= 0 && bestSim >= 0.4) {
      usedR.add(best);
      if (normTxt(rems[best]) === normTxt(a)) noopDropped = true;   // sichtbar identisch → kein Sinn, weg
      else items.push({ old: rems[best], new: a });                 // echte Änderung → Wort-Diff
    } else items.push({ new: a });
  }
  rems.forEach((r, i) => { if (!usedR.has(i)) items.push({ old: r }); });
  return { items, noopDropped };
}

function MetaLine({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <div className="chist-meta">{icon}<span>{children}</span></div>;
}
function MetaEditView({ m }: { m: MetaEdit }) {
  if (m.field === "description" && m.old && m.new) return <DiffBlock oldS={m.old} newS={m.new} label="Teaser geändert" kind="meta" />;
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

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + " …" : s);

function ChangeCard({ s, v, dupKeys }: { s: Snapshot; v: number; dupKeys?: Set<string> }) {
  const isEdit = s.change_kind === "edit";
  const isExt = s.change_kind === "extension";
  const kindLabel = s.change_kind === "extension" ? "Erweiterung" : isEdit ? "Stille Änderung" : "Geändert & erweitert";
  const Icon = isEdit ? Pencil : Plus;
  const cls = s.change_kind === "extension" ? "ok" : isEdit ? "lock" : "wait";
  const { items: allChanges, noopDropped } = reconcileChanges(
    (s.changes ?? []).filter((c) => c.old || c.new)
      .map((c) => ({ old: c.old ? decodeEntities(c.old) : undefined, new: c.new ? decodeEntities(c.new) : undefined }))
  );
  // Nur die größten Passagen zeigen (Länge der Änderung), der Rest als Hinweis — nicht jeder Absatz.
  const changes = [...allChanges].sort((a, b) => ((b.old?.length ?? 0) + (b.new?.length ?? 0)) - ((a.old?.length ?? 0) + (a.new?.length ?? 0))).slice(0, 3);
  const moreChanges = allChanges.length - changes.length;
  // Absatz-Chips aus den ABGEGLICHENEN Changes ableiten, nicht aus den rohen Scraper-Zählern:
  // bei Bild/n-tv ist der Body EIN Absatz, dessen Fingerprint bei jeder Änderung komplett kippt
  // → added_count=1/removed_count=1, obwohl es nur EINE modifizierte Passage ist (z.B. nur Chrome
  // entfernt). reconcileChanges paart das als {old,new} → zählt weder als Zu- noch als Abgang.
  // So kein falsches „+1 Absatz" mehr ohne sichtbares Grün (Art. 388298).
  const addedParas = allChanges.filter((c) => c.new && !c.old).length;
  const removedParas = allChanges.filter((c) => c.old && !c.new).length;
  const titleChanged = !!(s.title_old && s.title_new);
  const dateChanged = realDateShift(s.pubdate_old, s.pubdate_new);
  // Bild-Wechsel (og_image) NICHT anzeigen — Verlagsbilder einzubinden ist urheberrechtlich
  // heikel. Nur wenn die Karte sonst KOMPLETT leer wäre, ein bildloser Hinweis.
  const metaEdits = (s.meta_edits ?? []).filter((m) => m && m.field && m.field !== "og_image");
  const imageSwapped = (s.meta_edits ?? []).some((m) => m && m.field === "og_image");
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
          {addedParas > 0 && <span className="chist-chip add">+{addedParas}&nbsp;Absatz{addedParas > 1 ? "e" : ""}</span>}
          {!isExt && removedParas > 0 && <span className="chist-chip del">−{removedParas}&nbsp;Absatz{removedParas > 1 ? "e" : ""}</span>}
          {s.word_delta ? <span className="chist-chip">{s.word_delta > 0 ? "+" : ""}{s.word_delta}&nbsp;W</span> : null}
        </span>
      </div>
      {dateChanged && (
        <div className="chist-date"><Clock size={14} /><span>Veröffentlichungsdatum still geändert — <b>vorher</b> {fmtDate(s.pubdate_old)} · <b>jetzt</b> {fmtDate(s.pubdate_new)}</span></div>
      )}
      {metaEdits.map((m, i) => <MetaEditView key={`${m.field}-${i}`} m={m} />)}
      {titleChanged && <DiffBlock oldS={s.title_old!} newS={s.title_new!} label="Überschrift geändert" kind="title" />}
      {isExt ? (() => {
        // Neu hinzugekommenes NICHT als ein Riesenblock — jeder hinzugefügte Absatz = eigene Box
        // (in Dokument-Reihenfolge). So ist es logisch gesplittet statt eine große Textwand.
        let paras = (s.changes ?? []).filter((c) => c.new && !c.old).map((c) => decodeEntities(c.new ?? "").trim()).filter(Boolean);
        if (!paras.length && s.added) paras = [decodeEntities(s.added).trim()];
        // CROSS-VERSION-DEDUP: Liveblog-/Ticker-Einträge, die in einer FRÜHEREN Version schon
        // gezeigt wurden (Re-Segmentierung lässt denselben Eintrag wiederkehren), hier raus —
        // sonst sieht man dieselbe Meldung über viele Versionen doppelt (Art. 5830).
        const total = paras.length;
        if (dupKeys) paras = paras.filter((p) => !dupKeys.has(paraKey(p)));
        const dropped = total - paras.length;
        const shown = paras.slice(0, 5);
        const more = paras.length - shown.length;
        if (!shown.length) {
          return total > 0
            ? <p className="faint" style={{ fontSize: 12.5 }}>Keine neuen Einträge — die {total} erfassten waren bereits in früheren Versionen.</p>
            : null;
        }
        return (
          <>
            {shown.map((p, i) => (
              <div className="dq ext" key={i}>
                <div className="dq-lbl"><span className="dq-pm add">+</span>Neu hinzugekommen{shown.length > 1 ? ` · Abschnitt ${i + 1}` : ""}</div>
                <div className="dq-body dq-add-body">{clip(p, 560)}</div>
              </div>
            ))}
            {more > 0 && <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>+ {more} weiterer Abschnitt{more > 1 ? "e" : ""}</p>}
            {dropped > 0 && <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>({dropped} bereits in früheren Versionen gezeigt)</p>}
          </>
        );
      })() : (
        <>
          {changes.map((c, i) =>
            c.old && c.new ? <DiffBlock key={i} oldS={c.old} newS={c.new} label="Geänderte Passage" netWd={s.word_delta} />
            : c.new ? (
              <div className="dq ext" key={i}>
                <div className="dq-lbl"><span className="dq-pm add">+</span>Neu hinzugekommen</div>
                <div className="dq-body dq-add-body">{clip(c.new!, 420)}</div>
              </div>
            ) : (
              <div className="dq del-only" key={i}>
                <div className="dq-lbl"><span className="dq-pm del">−</span>Entfernt</div>
                <div className="dq-body dq-del-body">{clip(c.old!, 420)}</div>
              </div>
            )
          )}
          {moreChanges > 0 && (
            <p className="faint" style={{ fontSize: 12.5, marginTop: 10 }}>+ {moreChanges} weitere, kleinere Passage{moreChanges > 1 ? "n" : ""} geändert</p>
          )}
          {changes.length === 0 && !titleChanged && s.added && !noopDropped && (
            <div className={`dq ${isEdit ? "del-only" : "ext"}`}>
              <div className="dq-lbl"><span className={`dq-pm ${isEdit ? "del" : "add"}`}>{isEdit ? "±" : "+"}</span>{isEdit ? "Geänderte Passage" : "Neu hinzugekommen"}</div>
              <div className={`dq-body ${isEdit ? "dq-del-body" : "dq-add-body"}`}>{clip(decodeEntities(s.added), 420)}</div>
            </div>
          )}
          {/* no-op-Paar verworfen (Differenz lag außerhalb des erfassten Ausschnitts) → ehrlicher Hinweis statt zwei gleicher Textwände */}
          {changes.length === 0 && noopDropped && !titleChanged && (
            <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>Text minimal überarbeitet — der Unterschied liegt außerhalb des erfassten Ausschnitts.</p>
          )}
          {changes.length === 0 && !titleChanged && !s.added && !dateChanged && !noopDropped && s.removed_count > 0 && (
            <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>− {s.removed_count} Passage(n) entfernt</p>
          )}
          {changes.length === 0 && !titleChanged && !s.added && !dateChanged && !noopDropped && s.removed_count === 0 && metaEdits.length === 0 && imageSwapped && (
            <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>Nur das Vorschaubild wurde getauscht (Verlagsbilder werden aus Urheberrechtsgründen nicht angezeigt).</p>
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
