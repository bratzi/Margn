"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { FileText, External } from "@/components/icons";
import { useFilters } from "@/components/FilterProvider";
import FilterPills from "@/components/FilterPills";
import PublisherCompare from "@/components/PublisherCompare";
import TopicChart from "@/components/TopicChart";
import RateStats from "@/components/RateStats";
import TimeRangeFilter, { PUB_COLORS } from "@/components/TimeRangeFilter";
import Donut from "@/components/Donut";
import TopicCards from "@/components/TopicCards";
import SubTopicBar from "@/components/SubTopicBar";
import ExtLink from "@/components/ExtLink";
import DataTable, { type Col } from "@/components/DataTable";
import { topicLabel } from "@/lib/topics";

type Row = {
  id: number; article_id: number | null; url: string; outlet: string; country: string | null;
  analyzed: boolean; paywalled: boolean | null; ptype: string; topic: string | null; author_status: string | null;
  discovered_at: string | null; last_seen: string | null; published_at: string | null;
  word_count: number | null; reading_min: number | null; revision_count: number | null;
  edit_count: number | null; extension_count: number | null; lang_detected: string | null; scan_count: number | null;
};

const PTYPE: Record<string, { l: string; c: string }> = {
  artikel: { l: "Artikel", c: "neutral" }, paywall: { l: "Paywall", c: "lock" },
  video: { l: "Video", c: "media" }, werbung: { l: "Werbung", c: "wait" },
  hub: { l: "Hub", c: "neutral" }, blog: { l: "Timeline", c: "info" }, timeline: { l: "Timeline", c: "info" },
};
const AUTHOR: Record<string, { l: string; c: string }> = {
  named: { l: "Autor", c: "ok" }, anonymous: { l: "Redaktion", c: "wait" },
};
const PAGE = 100;
const shortUrl = (u: string) => { try { const x = new URL(u); return { host: x.host.replace(/^www\./, ""), path: x.pathname }; } catch { return { host: "", path: u }; } };
const fmtDT = (iso: string | null) => iso ? new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtD = (iso: string | null) => iso ? new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "2-digit" }) : "—";

export default function ArticleDashboard() {
  const f = useFilters();
  const [rows, setRows] = useState<Row[]>([]);
  const [rowKw, setRowKw] = useState<Record<number, string[]>>({});
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [kwIds, setKwIds] = useState<number[] | null>(null);
  const [agg, setAgg] = useState({ articles: 0, paywalled: 0, named: 0, au: 0, video: 0, werbung: 0, new7d: 0 });
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => { setUpdatedAt(new Date()); }, [f.ready]);

  const fpct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

  // Aggregat-Facts. WICHTIG: Autoren-Verteilung wird OHNE den Autor-Filter berechnet —
  // sonst kollabiert die Transparenz-Anzeige bei gesetztem Filter zirkulär auf 100 %/0 %.
  useEffect(() => {
    if (!f.active.size) return;
    const nn = (v: string) => (v === "all" ? null : v);
    const base = { p_sources: f.activeArr, p_topics: f.topics.length ? f.topics : null, p_paywall: nn(f.paywall), p_lang: nn(f.lang), p_from: f.rangeFrom, p_to: f.rangeTo };
    Promise.all([
      supabase.rpc("publisher_stats_f", { ...base, p_author: nn(f.author) }),
      f.author === "all" ? null : supabase.rpc("publisher_stats_f", base), // ungefiltert für au-Anteile
    ]).then(([main, auFree]) => {
      const a = { articles: 0, paywalled: 0, named: 0, au: 0, video: 0, werbung: 0, new7d: 0 };
      for (const r of (main.data ?? []) as any[]) { a.articles += r.articles; a.paywalled += r.paywalled; a.video += r.video; a.werbung += r.werbung; a.new7d += r.new_7d; }
      const auSrc = (auFree?.data ?? main.data ?? []) as any[];
      for (const r of auSrc) { a.named += r.au_named; a.au += r.au_named + r.au_anon + r.au_none; }
      setAgg(a);
    });
  }, [f.activeArr.join(","), f.topics.join(","), f.paywall, f.author, f.lang, f.rangeFrom, f.rangeTo]);

  // Keyword → Artikel-IDs
  useEffect(() => {
    if (f.keyword === "all") { setKwIds(null); return; }
    supabase.from("article_keywords").select("article_id, keywords!inner(term)").eq("keywords.term", f.keyword)
      .then(({ data }) => setKwIds((data ?? []).map((r: any) => r.article_id)));
  }, [f.keyword]);

  // Sub-Rubriken → Artikel-IDs (Artikel mit mind. einer der gewählten Kategorien)
  const [subIds, setSubIds] = useState<number[] | null>(null);
  useEffect(() => {
    if (!f.subcats.length) { setSubIds(null); return; }
    supabase.from("article_categories").select("article_id, categories!inner(name)").in("categories.name", f.subcats)
      .then(({ data }) => setSubIds([...new Set((data ?? []).map((r: any) => r.article_id))]));
  }, [f.subcats.join("|||")]);

  const loadRows = useCallback(async () => {
    if (!f.active.size) { setRows([]); setTotal(0); return; }
    if (f.keyword !== "all" && kwIds === null) return;
    if (f.subcats.length && subIds === null) return;
    // Keyword- und Sub-Rubrik-Artikel-IDs schneiden (beide müssen gelten, wenn gesetzt)
    let idFilter: number[] | null = kwIds;
    if (subIds) idFilter = idFilter ? idFilter.filter((x) => subIds.includes(x)) : subIds;
    let q = supabase.from("page_overview").select("id,article_id,url,outlet,country,analyzed,paywalled,ptype,topic,author_status,discovered_at,last_seen,published_at,word_count,reading_min,revision_count,edit_count,extension_count,lang_detected,scan_count", { count: "exact" }).in("source_id", f.activeArr);
    if (f.status === "analyzed") q = q.eq("analyzed", true); else if (f.status === "backlog") q = q.eq("analyzed", false);
    if (f.status === "new") q = q.lte("scan_count", 1); else if (f.status === "rescanned") q = q.gte("scan_count", 2);
    if (f.paywall === "yes") q = q.eq("paywalled", true); else if (f.paywall === "no") q = q.eq("paywalled", false);
    if (f.atype !== "all") q = q.eq("ptype", f.atype);
    if (f.author !== "all") q = q.eq("author_status", f.author);
    if (f.topics.length) q = q.in("topic", f.topics);
    if (f.lang !== "all") q = q.eq("language", f.lang);
    if (f.rangeFrom) q = q.gte("published_at", f.rangeFrom);
    if (f.rangeTo) q = q.lte("published_at", f.rangeTo);
    if (idFilter) q = q.in("article_id", idFilter.length ? idFilter : [-1]);
    const { data, count } = await q.order("discovered_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as Row[]) ?? []); setTotal(count ?? 0);
  }, [f.activeArr.join(","), f.status, f.paywall, f.atype, f.author, f.topics.join(","), f.lang, f.rangeFrom, f.rangeTo, kwIds, subIds, f.keyword, f.subcats.join("|||"), page]);

  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { setPage(0); }, [f.activeArr.join(","), f.status, f.paywall, f.atype, f.author, f.topics.join(","), f.subcats.join("|||"), f.keyword, f.lang, f.rangeFrom, f.rangeTo]);

  useEffect(() => {
    const ids = rows.map((r) => r.article_id).filter(Boolean) as number[];
    if (!ids.length) { setRowKw({}); return; }
    supabase.from("article_keywords").select("article_id, keywords(term)").in("article_id", ids).then(({ data }) => {
      const m: Record<number, string[]> = {};
      for (const r of (data ?? []) as any[]) { (m[r.article_id] ??= []).push(r.keywords?.term); }
      setRowKw(m);
    });
  }, [rows]);

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const topicLbl = f.topics.length === 0 ? "" : f.topics.length === 1 ? topicLabel(f.topics[0]) : `${f.topics.length} Themen`;
  const ctxLabel = `${total.toLocaleString("de-DE")} Treffer${topicLbl ? ` · ${topicLbl}` : ""}${f.keyword !== "all" ? ` · #${f.keyword}` : ""}`;

  const cols: Col<Row>[] = useMemo(() => [
    { key: "seite", label: "Seite", width: 300, sortable: false, groupable: false, value: (r) => r.url,
      render: (r) => { const { host, path } = shortUrl(r.url); return (
        <div className="art-row">
          {r.article_id
            ? <Link href={`/articles/${r.article_id}`} target="_blank" className="url mono" title={r.url}><span className="path">{host}</span>{path}</Link>
            : <span className="url mono" title={r.url}><span className="path">{host}</span>{path}</span>}
          <ExtLink href={r.url} className="open-btn" title="Original öffnen (Hintergrund-Tab)"><External size={14} /></ExtLink>
        </div>); } },
    { key: "outlet", label: "Quelle", width: 130, value: (r) => r.outlet, render: (r) => <>{r.outlet} <span className="cc">{r.country}</span></> },
    { key: "ptype", label: "Typ", width: 100, value: (r) => PTYPE[r.ptype]?.l ?? r.ptype, render: (r) => <span className={`badge ${PTYPE[r.ptype]?.c ?? "neutral"}`}>{PTYPE[r.ptype]?.l ?? r.ptype}</span> },
    { key: "topic", label: "Thema", width: 130, value: (r) => (r.topic ? topicLabel(r.topic) : "—"), render: (r) => <span className="faint">{r.topic ? topicLabel(r.topic) : "—"}</span> },
    { key: "author_status", label: "Autor", width: 110, value: (r) => r.author_status ?? "—", render: (r) => r.author_status && AUTHOR[r.author_status] ? <span className={`badge ${AUTHOR[r.author_status].c}`}>{AUTHOR[r.author_status].l}</span> : <span className="faint">—</span> },
    { key: "keywords", label: "Schlagwörter", width: 220, sortable: false, groupable: false, value: (r) => (r.article_id ? rowKw[r.article_id]?.join(" ") : "") ?? "",
      render: (r) => { const kws = r.article_id ? rowKw[r.article_id] : undefined; return kws && kws.length ? <div className="kw-row">{kws.slice(0, 6).map((k) => <span key={k} className="kw-chip">{k}</span>)}</div> : <span className="faint">—</span>; } },
    { key: "scan", label: "Erfassung", width: 120, value: (r) => ((r.scan_count ?? 1) <= 1 ? "Neu" : "Wiederholt"), render: (r) => (r.scan_count ?? 1) <= 1
      ? <span className="new-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>Neu</span>
      : <span className="badge neutral">{r.scan_count}× gescannt</span> },
    { key: "published_at", label: "Veröffentlicht", width: 110, value: (r) => r.published_at ?? "", render: (r) => <span className="mono faint">{fmtD(r.published_at)}</span> },
    { key: "discovered_at", label: "Erster Scan", width: 125, value: (r) => r.discovered_at ?? "", render: (r) => <span className="mono faint">{fmtDT(r.discovered_at)}</span> },
    { key: "last_seen", label: "Letzter Scan", width: 125, value: (r) => r.last_seen ?? "", render: (r) => <span className="mono faint">{fmtDT(r.last_seen)}</span> },
    { key: "word_count", label: "Wörter", width: 90, align: "right", value: (r) => r.word_count ?? 0, render: (r) => <span className="faint">{r.word_count ? r.word_count.toLocaleString("de-DE") : "—"}</span> },
    { key: "reading_min", label: "Lesezeit", width: 90, align: "right", value: (r) => r.reading_min ?? 0, render: (r) => <span className="faint">{r.reading_min ? `${r.reading_min} min` : "—"}</span> },
    { key: "revision_count", label: "Änderungen", width: 120, align: "right", value: (r) => r.revision_count ?? 0,
      render: (r) => { const rev = r.revision_count ?? 0; return rev > 0 ? <span className="rev-badge">{rev}× {(r.edit_count ?? 0) > 0 && <i className="rev-e">{r.edit_count}E</i>}{(r.extension_count ?? 0) > 0 && <i className="rev-x">{r.extension_count}+</i>}</span> : <span className="faint">—</span>; } },
    { key: "lang", label: "Sprache", width: 80, value: (r) => r.lang_detected || r.country?.toLowerCase() || "—", render: (r) => <span className="faint" style={{ textTransform: "uppercase", fontSize: 11 }}>{r.lang_detected || r.country?.toLowerCase() || "—"}</span> },
  ], [rowKw]);

  return (
    <>
      <div className="topbar">
        <h1>Übersicht</h1>
        <span className="live"><span className="live-dot" /> Live · {updatedAt ? updatedAt.toLocaleTimeString("de-DE") : "…"}</span>
      </div>

      <FilterPills />

      <div className="page wide">
        <TopicCards />
        <SubTopicBar />

        <h2 className="section-h">Auf einen Blick <span className="count">{topicLbl || "Gesamtverteilung"}</span></h2>
        <div className="donut-grid">
          <Donut title="Themen-Mix" centerLabel={f.topicOpts.reduce((s, t) => s + t.n, 0).toLocaleString("de-DE")} centerSub="Artikel"
            segments={f.topicOpts.slice(0, 8).map((t, i) => ({ label: t.label, value: t.n, color: PUB_COLORS[i % PUB_COLORS.length] }))} />
          <Donut title="Bezahlschranke" centerLabel={`${fpct(agg.paywalled, agg.articles)}%`} centerSub="Paywall"
            segments={[{ label: "Frei zugänglich", value: agg.articles - agg.paywalled, color: "var(--green)" }, { label: "Hinter Paywall", value: agg.paywalled, color: "var(--red)" }]} />
          <Donut title="Autoren-Transparenz" centerLabel={`${fpct(agg.named, agg.au)}%`} centerSub="namentlich"
            segments={[{ label: "Namentlich", value: agg.named, color: "var(--green)" }, { label: "Redaktion/Agentur · ohne", value: agg.au - agg.named, color: "var(--line-2)" }]} />
        </div>

        <RateStats />
        <PublisherCompare />
        <TopicChart />

        {f.keywordOpts.length > 0 && (
          <>
            <h2 className="section-h">Keywords im Filter <span className="count">{topicLbl || "alle Themen"} · klick zum Filtern</span></h2>
            <div className="kw-cloud">
              {f.keywordOpts.map((k) => (
                <button key={k.key} className={`kw-pill ${f.keyword === k.key ? "on" : ""}`} onClick={() => f.setKeyword(f.keyword === k.key ? "all" : k.key)}>{k.label} <span className="kw-n">{k.n}</span></button>
              ))}
            </div>
          </>
        )}

        <h2 className="section-h">Artikel <span className="count">{ctxLabel}</span></h2>
        <div className="data-fade-in" key={`${page}-${rows.length}-${f.topics.join(",")}-${f.subcats.join(",")}`}>
          <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} minWidth={1700} rowClass={(r) => (r.scan_count ?? 1) <= 1 ? "row-new" : ""} />
        </div>

        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Zurück</button>
          <span>Seite {page + 1} / {pages}</span>
          <button disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Weiter →</button>
        </div>
      </div>

      <TimeRangeFilter />
    </>
  );
}
