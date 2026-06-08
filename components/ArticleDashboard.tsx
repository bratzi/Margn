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
import { topicLabel } from "@/lib/topics";

type Row = {
  id: number; article_id: number | null; url: string; outlet: string; country: string | null;
  analyzed: boolean; paywalled: boolean | null; ptype: string; topic: string | null; author_status: string | null;
  discovered_at: string | null; last_seen: string | null; published_at: string | null;
  word_count: number | null; reading_min: number | null; revision_count: number | null;
  edit_count: number | null; extension_count: number | null; lang_detected: string | null;
};

const PTYPE: Record<string, { l: string; c: string }> = {
  artikel: { l: "Artikel", c: "neutral" }, paywall: { l: "Paywall", c: "lock" },
  video: { l: "Video", c: "media" }, werbung: { l: "Werbung", c: "wait" },
  hub: { l: "Hub", c: "neutral" }, blog: { l: "Timeline", c: "info" }, timeline: { l: "Timeline", c: "info" },
};
const AUTHOR: Record<string, { l: string; c: string }> = {
  named: { l: "Autor", c: "ok" }, anonymous: { l: "Redaktion", c: "wait" },
};
const PAGE = 30;
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
  const [sortCol, setSortCol] = useState<"recent" | "src" | "type" | "topic" | "author">("recent");
  const [agg, setAgg] = useState({ articles: 0, paywalled: 0, named: 0, au: 0, video: 0, werbung: 0, new7d: 0 });
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  useEffect(() => { setUpdatedAt(new Date()); }, [f.ready]);

  const fpct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

  // Aggregat-Facts
  useEffect(() => {
    if (!f.active.size) return;
    supabase.rpc("publisher_stats_f", { p_sources: f.activeArr, p_topic: f.topic === "all" ? null : f.topic, p_from: f.rangeFrom, p_to: f.rangeTo })
      .then(({ data }) => {
        const a = { articles: 0, paywalled: 0, named: 0, au: 0, video: 0, werbung: 0, new7d: 0 };
        for (const r of (data ?? []) as any[]) { a.articles += r.articles; a.paywalled += r.paywalled; a.named += r.au_named; a.au += r.au_named + r.au_anon + r.au_none; a.video += r.video; a.werbung += r.werbung; a.new7d += r.new_7d; }
        setAgg(a);
      });
  }, [f.activeArr.join(","), f.topic, f.rangeFrom, f.rangeTo]);

  // Keyword → Artikel-IDs
  useEffect(() => {
    if (f.keyword === "all") { setKwIds(null); return; }
    supabase.from("article_keywords").select("article_id, keywords!inner(term)").eq("keywords.term", f.keyword)
      .then(({ data }) => setKwIds((data ?? []).map((r: any) => r.article_id)));
  }, [f.keyword]);

  const loadRows = useCallback(async () => {
    if (!f.active.size) { setRows([]); setTotal(0); return; }
    if (f.keyword !== "all" && kwIds === null) return;
    let q = supabase.from("page_overview").select("id,article_id,url,outlet,country,analyzed,paywalled,ptype,topic,author_status,discovered_at,last_seen,published_at,word_count,reading_min,revision_count,edit_count,extension_count,lang_detected", { count: "exact" }).in("source_id", f.activeArr);
    if (f.status === "analyzed") q = q.eq("analyzed", true); else if (f.status === "backlog") q = q.eq("analyzed", false);
    if (f.paywall === "yes") q = q.eq("paywalled", true); else if (f.paywall === "no") q = q.eq("paywalled", false);
    if (f.atype !== "all") q = q.eq("ptype", f.atype);
    if (f.author !== "all") q = q.eq("author_status", f.author);
    if (f.topic !== "all") q = q.eq("topic", f.topic);
    if (f.lang !== "all") q = q.eq("language", f.lang);
    if (f.rangeFrom) q = q.gte("published_at", f.rangeFrom);
    if (f.rangeTo) q = q.lte("published_at", f.rangeTo);
    if (kwIds) q = q.in("article_id", kwIds.length ? kwIds : [-1]);
    const col = sortCol === "src" ? "outlet" : sortCol === "type" ? "ptype" : sortCol === "topic" ? "topic" : sortCol === "author" ? "author_status" : "discovered_at";
    const { data, count } = await q.order(col, { ascending: sortCol !== "recent" }).range(page * PAGE, page * PAGE + PAGE - 1);
    setRows((data as Row[]) ?? []); setTotal(count ?? 0);
  }, [f.activeArr.join(","), f.status, f.paywall, f.atype, f.author, f.topic, f.lang, f.rangeFrom, f.rangeTo, kwIds, f.keyword, page, sortCol]);

  useEffect(() => { loadRows(); }, [loadRows]);
  useEffect(() => { setPage(0); }, [f.activeArr.join(","), f.status, f.paywall, f.atype, f.author, f.topic, f.keyword, f.lang, f.rangeFrom, f.rangeTo]);

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
  const ctxLabel = `${total.toLocaleString("de-DE")} Treffer${f.topic !== "all" ? ` · ${topicLabel(f.topic)}` : ""}${f.keyword !== "all" ? ` · #${f.keyword}` : ""}`;

  return (
    <>
      <div className="topbar">
        <h1>Übersicht</h1>
        <span className="live"><span className="live-dot" /> Live · {updatedAt ? updatedAt.toLocaleTimeString("de-DE") : "…"}</span>
      </div>

      <FilterPills />

      <div className="page wide">
        <div className="kpi-strip">
          <div className="stat-tile"><div className="l"><FileText /> Artikel</div><div className="n tnum">{agg.articles.toLocaleString("de-DE")}</div><div className="sub">{agg.new7d.toLocaleString("de-DE")} neu (7 Tage)</div></div>
          <div className="stat-tile"><div className="l">🔒 Paywall-Anteil</div><div className="n tnum" style={{ color: fpct(agg.paywalled, agg.articles) > 40 ? "var(--red)" : "inherit" }}>{fpct(agg.paywalled, agg.articles)}%</div><div className="sub">{agg.paywalled.toLocaleString("de-DE")} hinter Schranke</div></div>
          <div className="stat-tile"><div className="l">✍️ Namentliche Autoren</div><div className="n tnum" style={{ color: "var(--green)" }}>{fpct(agg.named, agg.au)}%</div><div className="sub">statt Redaktion/Agentur</div></div>
          <div className="stat-tile accent"><div className="l">🎬 Video & Werbung</div><div className="n tnum">{(agg.video + agg.werbung).toLocaleString("de-DE")}</div><div className="bar"><i style={{ width: `${fpct(agg.video + agg.werbung, agg.articles + agg.video + agg.werbung)}%` }} /></div></div>
        </div>

        <h2 className="section-h">Auf einen Blick <span className="count">{f.topic !== "all" ? topicLabel(f.topic) : "Gesamtverteilung"}</span></h2>
        <div className="donut-grid">
          <Donut title="Themen-Mix" centerLabel={f.topicOpts.reduce((s, t) => s + t.n, 0).toLocaleString("de-DE")} centerSub="Artikel"
            segments={f.topicOpts.slice(0, 6).map((t, i) => ({ label: t.label, value: t.n, color: PUB_COLORS[i % PUB_COLORS.length] }))} />
          <Donut title="Bezahlschranke" centerLabel={`${fpct(agg.paywalled, agg.articles)}%`} centerSub="Paywall"
            segments={[{ label: "Frei zugänglich", value: agg.articles - agg.paywalled, color: "var(--green)" }, { label: "Hinter Paywall", value: agg.paywalled, color: "var(--red)" }]} />
          <Donut title="Autoren-Transparenz" centerLabel={`${fpct(agg.named, agg.au)}%`} centerSub="namentlich"
            segments={[{ label: "Namentlich", value: agg.named, color: "var(--green)" }, { label: "Redaktion/Agentur · ohne", value: agg.au - agg.named, color: "var(--line-2)" }]} />
        </div>

        <RateStats />
        <PublisherCompare sources={f.sources} activeSources={f.activeArr} topic={f.topic} from={f.rangeFrom} to={f.rangeTo} />
        <TopicChart activeSources={f.activeArr} current={f.topic} onPick={f.setTopic} />

        {f.keywordOpts.length > 0 && (
          <>
            <h2 className="section-h">Schlagwörter im Filter <span className="count">{f.topic !== "all" ? topicLabel(f.topic) : "alle Themen"} · klick zum Filtern</span></h2>
            <div className="kw-cloud">
              {f.keywordOpts.slice(0, 60).map((k) => (
                <button key={k.key} className={`kw-pill ${f.keyword === k.key ? "on" : ""}`} onClick={() => f.setKeyword(f.keyword === k.key ? "all" : k.key)}>{k.label} <span className="kw-n">{k.n}</span></button>
              ))}
            </div>
          </>
        )}

        <h2 className="section-h">Artikel <span className="count">{ctxLabel} · ↔ scrollbar</span></h2>
        <div className="panel table-scroll">
          <table className="arttable wide-table">
            <thead><tr>
              <th className="c-art">Seite</th>
              <th style={{ cursor: "pointer" }} onClick={() => setSortCol("src")}>Quelle {sortCol === "src" && "↓"}</th>
              <th style={{ cursor: "pointer" }} onClick={() => setSortCol("type")}>Typ {sortCol === "type" && "↓"}</th>
              <th style={{ cursor: "pointer" }} onClick={() => setSortCol("topic")}>Thema {sortCol === "topic" && "↓"}</th>
              <th style={{ cursor: "pointer" }} onClick={() => setSortCol("author")}>Autor {sortCol === "author" && "↓"}</th>
              <th>Veröffentlicht</th><th>Erster Scan</th><th>Letzter Scan</th>
              <th className="num">Wörter</th><th className="num">Lesezeit</th><th>Änderungen</th><th>Sprache</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const { host, path } = shortUrl(r.url);
                const kws = r.article_id ? rowKw[r.article_id] : undefined;
                const rev = r.revision_count ?? 0;
                return (
                  <tr key={r.id}>
                    <td className="c-art">
                      <div className="art-row">
                        {r.article_id
                          ? <Link href={`/articles/${r.article_id}`} target="_blank" className="url mono" title={`Details: ${r.url}`}><span className="path">{host}</span>{path}</Link>
                          : <span className="url mono" title={r.url}><span className="path">{host}</span>{path}</span>}
                        <a href={r.url} target="_blank" rel="noreferrer" className="open-btn" title="Original öffnen" aria-label="Original öffnen"><External size={14} /></a>
                      </div>
                      {kws && kws.length > 0 && <div className="kw-row">{kws.slice(0, 5).map((k) => <span key={k} className="kw-chip">{k}</span>)}</div>}
                    </td>
                    <td className="cell-nowrap">{r.outlet} <span className="cc">{r.country}</span></td>
                    <td className="cell-nowrap"><span className={`badge ${PTYPE[r.ptype]?.c ?? "neutral"}`}>{PTYPE[r.ptype]?.l ?? r.ptype}</span></td>
                    <td className="cell-nowrap faint">{r.topic ? topicLabel(r.topic) : "—"}</td>
                    <td className="cell-nowrap">{r.author_status && AUTHOR[r.author_status] ? <span className={`badge ${AUTHOR[r.author_status].c}`}>{AUTHOR[r.author_status].l}</span> : <span className="faint">—</span>}</td>
                    <td className="cell-nowrap mono faint">{fmtD(r.published_at)}</td>
                    <td className="cell-nowrap mono faint">{fmtDT(r.discovered_at)}</td>
                    <td className="cell-nowrap mono faint">{fmtDT(r.last_seen)}</td>
                    <td className="num tnum faint">{r.word_count ? r.word_count.toLocaleString("de-DE") : "—"}</td>
                    <td className="num tnum faint">{r.reading_min ? `${r.reading_min} min` : "—"}</td>
                    <td className="cell-nowrap">
                      {rev > 0
                        ? <span className="rev-badge" title={`${r.edit_count ?? 0} Edits · ${r.extension_count ?? 0} Erweiterungen`}>{rev}× {(r.edit_count ?? 0) > 0 && <i className="rev-e">{r.edit_count}E</i>}{(r.extension_count ?? 0) > 0 && <i className="rev-x">{r.extension_count}+</i>}</span>
                        : <span className="faint">—</span>}
                    </td>
                    <td className="cell-nowrap faint" style={{ textTransform: "uppercase", fontSize: 11 }}>{r.lang_detected || r.country?.toLowerCase() || "—"}</td>
                  </tr>
                );
              })}
              {!rows.length && <tr><td colSpan={12} className="faint" style={{ padding: 28, textAlign: "center" }}>Keine Seiten für diese Filter.</td></tr>}
            </tbody>
          </table>
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
