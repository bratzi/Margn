"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { FileText, External } from "@/components/icons";
import { useFilters } from "@/components/FilterProvider";
import FilterPills from "@/components/FilterPills";
import PublisherCompare from "@/components/PublisherCompare";
import TopicProfile from "@/components/TopicProfile";
import RateStats from "@/components/RateStats";
import TimeRangeFilter from "@/components/TimeRangeFilter";
import PulseBar from "@/components/PulseBar";
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
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => { setUpdatedAt(new Date()); }, [f.ready]);

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
    { key: "outlet", label: "Quelle", width: 130, value: (r) => r.outlet, render: (r) => <>{r.outlet} <span className="cc">{r.country}</span></>,
      agg: (rs) => { const u = new Set(rs.map((r) => r.outlet)).size; return <span title="verschiedene Quellen auf dieser Seite">{u} Quellen</span>; } },
    { key: "ptype", label: "Typ", width: 100, value: (r) => PTYPE[r.ptype]?.l ?? r.ptype, render: (r) => <span className={`badge ${PTYPE[r.ptype]?.c ?? "neutral"}`}>{PTYPE[r.ptype]?.l ?? r.ptype}</span>,
      agg: (rs) => { const a = rs.filter((r) => r.ptype === "artikel").length; return <span title="Anteil echter Artikel">{Math.round((a / rs.length) * 100)}% Artikel</span>; } },
    { key: "topic", label: "Thema", width: 130, value: (r) => (r.topic ? topicLabel(r.topic) : "—"), render: (r) => <span className="faint">{r.topic ? topicLabel(r.topic) : "—"}</span>,
      agg: (rs) => <span title="verschiedene Themen auf dieser Seite">{new Set(rs.map((r) => r.topic ?? "sonstiges")).size} Themen</span> },
    { key: "author_status", label: "Autor", width: 110, value: (r) => r.author_status ?? "—", render: (r) => r.author_status && AUTHOR[r.author_status] ? <span className={`badge ${AUTHOR[r.author_status].c}`}>{AUTHOR[r.author_status].l}</span> : <span className="faint">—</span>,
      agg: (rs) => { const n = rs.filter((r) => r.author_status === "named").length; const base = rs.filter((r) => r.author_status).length; return <span title="namentlich gekennzeichnet">{base ? Math.round((n / base) * 100) : 0}% nam.</span>; } },
    { key: "keywords", label: "Schlagwörter", width: 220, sortable: false, groupable: false, value: (r) => (r.article_id ? rowKw[r.article_id]?.join(" ") : "") ?? "",
      render: (r) => { const kws = r.article_id ? rowKw[r.article_id] : undefined; return kws && kws.length ? <div className="kw-row">{kws.slice(0, 6).map((k) => <span key={k} className="kw-chip">{k}</span>)}</div> : <span className="faint">—</span>; } },
    { key: "scan", label: "Erfassung", width: 120, value: (r) => ((r.scan_count ?? 1) <= 1 ? "Neu" : "Wiederholt"), render: (r) => (r.scan_count ?? 1) <= 1
      ? <span className="new-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></svg>Neu</span>
      : <span className="badge neutral">{r.scan_count}× gescannt</span>,
      agg: (rs) => { const n = rs.filter((r) => (r.scan_count ?? 1) <= 1).length; return <span title="Anteil neu erfasster Artikel">{Math.round((n / rs.length) * 100)}% neu</span>; } },
    { key: "published_at", label: "Veröffentlicht", width: 110, value: (r) => r.published_at ?? "", render: (r) => <span className="mono faint">{fmtD(r.published_at)}</span> },
    { key: "discovered_at", label: "Erster Scan", width: 125, value: (r) => r.discovered_at ?? "", render: (r) => <span className="mono faint">{fmtDT(r.discovered_at)}</span> },
    { key: "last_seen", label: "Letzter Scan", width: 125, value: (r) => r.last_seen ?? "", render: (r) => <span className="mono faint">{fmtDT(r.last_seen)}</span> },
    { key: "word_count", label: "Wörter", width: 90, align: "right", value: (r) => r.word_count ?? 0, render: (r) => <span className="faint">{r.word_count ? r.word_count.toLocaleString("de-DE") : "—"}</span>,
      agg: "avg", aggFormat: (n) => <span title="Ø Wörter">ø {n.toLocaleString("de-DE")}</span> },
    { key: "reading_min", label: "Lesezeit", width: 90, align: "right", value: (r) => r.reading_min ?? 0, render: (r) => <span className="faint">{r.reading_min ? `${r.reading_min} min` : "—"}</span>,
      agg: "avg", aggFormat: (n) => <span title="Ø Lesezeit">ø {n} min</span> },
    { key: "revision_count", label: "Änderungen", width: 120, align: "right", value: (r) => r.revision_count ?? 0,
      render: (r) => { const rev = r.revision_count ?? 0; return rev > 0 ? <span className="rev-badge">{rev}× {(r.edit_count ?? 0) > 0 && <i className="rev-e">{r.edit_count}E</i>}{(r.extension_count ?? 0) > 0 && <i className="rev-x">{r.extension_count}+</i>}</span> : <span className="faint">—</span>; },
      agg: (rs) => { const tot = rs.reduce((s, r) => s + (r.revision_count ?? 0), 0); const ch = rs.filter((r) => (r.revision_count ?? 0) > 0).length; return <span title={`${ch} Artikel geändert`}>{tot}× ({Math.round((ch / rs.length) * 100)}%)</span>; } },
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

        <PulseBar />

        <RateStats />
        <PublisherCompare />
        <TopicProfile />

        {f.keywordOpts.length > 0 && (() => {
          // Echte Tag-Cloud: Schriftgröße proportional zur Häufigkeit (Wurzel-Skala dämpft
          // Ausreißer), Gewicht/Deckkraft nach Rang. Relevanteste Begriffe stechen sofort heraus.
          const kwMax = Math.max(...f.keywordOpts.map((k) => k.n));
          const kwMin = Math.min(...f.keywordOpts.map((k) => k.n));
          const sized = [...f.keywordOpts].sort((a, b) => b.n - a.n);
          const scale = (n: number) => {
            const t = kwMax === kwMin ? 1 : (Math.sqrt(n) - Math.sqrt(kwMin)) / (Math.sqrt(kwMax) - Math.sqrt(kwMin));
            return { fs: 12 + t * 12, w: t > 0.55 ? 700 : t > 0.25 ? 600 : 500, op: 0.62 + t * 0.38 };
          };
          return (
            <>
              <h2 className="section-h">Keywords im Filter <span className="count">{topicLbl || "alle Themen"} · Größe = Häufigkeit · klick zum Filtern</span></h2>
              <div className="kw-cloud kw-cloud-scaled">
                {sized.map((k) => {
                  const s = scale(k.n);
                  const on = f.keyword === k.key;
                  return (
                    <button key={k.key} className={`kw-pill ${on ? "on" : ""}`}
                      style={{ fontSize: on ? undefined : s.fs, fontWeight: s.w, opacity: on ? 1 : s.op }}
                      onClick={() => f.setKeyword(on ? "all" : k.key)}>
                      {k.label} <span className="kw-n">{k.n}</span>
                    </button>
                  );
                })}
              </div>
            </>
          );
        })()}

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
