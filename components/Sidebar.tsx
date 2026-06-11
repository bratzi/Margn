"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import NextRun from "@/components/NextRun";
import FilterControls from "@/components/FilterControls";
import { useFilters } from "@/components/FilterProvider";
import { FileText, Clock } from "@/components/icons";

const NAV = [
  { href: "/articles", label: "Übersicht", icon: FileText },
  { href: "/articles/edits", label: "Silent Edits", icon: Clock },
];

export default function Sidebar() {
  const path = usePathname();
  const f = useFilters();
  const showFilters = path === "/articles" || path === "/articles/edits";
  const [drawer, setDrawer] = useState(false);
  // Desktop-Collapse: schmale Icon-Leiste. Persistiert.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem("margn-sidebar-collapsed") === "1"); } catch {}
  }, []);
  const toggleCollapsed = () => setCollapsed((c) => {
    const n = !c; try { localStorage.setItem("margn-sidebar-collapsed", n ? "1" : "0"); } catch {}
    document.documentElement.classList.toggle("sb-collapsed", n);
    return n;
  });
  useEffect(() => { document.documentElement.classList.toggle("sb-collapsed", collapsed); }, [collapsed]);

  // Route-Wechsel schließt den mobilen Filter-Drawer
  useEffect(() => { setDrawer(false); }, [path]);
  useEffect(() => {
    document.body.classList.toggle("drawer-locked", drawer);
    return () => document.body.classList.remove("drawer-locked");
  }, [drawer]);

  // Filter-Indikatoren: was ist gerade selektiert? (für kollabierte Ansicht + Badge)
  const ind = {
    pub: f.activeArr.length !== f.sources.length ? f.activeArr.length : 0,
    topics: f.topics.length,
    subcats: f.subcats.length,
    paywall: f.paywall !== "all",
    author: f.author !== "all",
    atype: f.atype !== "all",
    lang: f.lang !== "all",
    status: f.status !== "all",
    keyword: f.keyword !== "all",
    range: !(f.rangeIdx.from === 0 && f.rangeIdx.to === f.days.length - 1) || !!f.pinpoint,
  };
  const activeCount =
    (ind.pub ? 1 : 0) + (ind.status ? 1 : 0) + (ind.paywall ? 1 : 0) +
    (ind.author ? 1 : 0) + (ind.atype ? 1 : 0) + (ind.topics ? 1 : 0) +
    (ind.subcats ? 1 : 0) + (ind.lang ? 1 : 0) + (ind.keyword ? 1 : 0) + (ind.range ? 1 : 0);

  return (
    <aside className={`sidebar ${drawer ? "drawer-open" : ""} ${collapsed ? "is-collapsed" : ""}`}>
      <div className="brand-row">
        <Link href="/articles" className="brand" aria-label="margn — Medienobservatorium" title="margn — Medienobservatorium">
          <span className="brand-mark">m</span>
          <span className="brand-text">
            <span className="brand-name">margn</span>
            <span className="brand-tag">Medienobservatorium</span>
          </span>
        </Link>
        {/* Desktop-Collapse-Toggle (nur Desktop sichtbar) */}
        <button className="sb-collapse-btn" onClick={toggleCollapsed} aria-label={collapsed ? "Ausklappen" : "Einklappen"} title={collapsed ? "Ausklappen" : "Einklappen"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={collapsed ? "m9 18 6-6-6-6" : "m15 18-6-6 6-6"} />
          </svg>
        </button>
      </div>

      {/* Mobiler Filter-Umschalter — nur per CSS in der Topbar sichtbar */}
      {showFilters && (
        <button className="filter-toggle" onClick={() => setDrawer((v) => !v)} aria-expanded={drawer} aria-label="Filter">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
          Filter
          {activeCount > 0 && <span className="filter-toggle-badge">{activeCount}</span>}
        </button>
      )}

      <div className="nav-label nav-label-obs">Observatorium</div>
      {NAV.map((n) => {
        const on = n.href === "/articles" ? path === "/articles" : path.startsWith(n.href);
        const Icon = n.icon;
        return <Link key={n.href} href={n.href} className={`nav-item ${on ? "on" : ""}`}><Icon /> {n.label}</Link>;
      })}

      {/* Kollabiert: kompakte Filter-Übersicht (zeigt, was selektiert ist) */}
      {showFilters && collapsed && (
        <button className="sb-mini-filters" onClick={toggleCollapsed} title="Filter ausklappen">
          <span className="sb-mini-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
            {activeCount > 0 && <i className="sb-mini-badge">{activeCount}</i>}
          </span>
          <span className="sb-mini-chips">
            {ind.pub ? <i className="sb-chip" title="Publizisten gewählt">{ind.pub}×Q</i> : null}
            {ind.topics ? <i className="sb-chip" title="Themen">{ind.topics}×T</i> : null}
            {ind.subcats ? <i className="sb-chip" title="Rubriken">{ind.subcats}×R</i> : null}
            {ind.paywall ? <i className="sb-chip" title="Paywall">🔒</i> : null}
            {ind.author ? <i className="sb-chip" title="Autor">✍</i> : null}
            {ind.keyword ? <i className="sb-chip" title="Keyword">#</i> : null}
            {ind.range ? <i className="sb-chip" title="Zeitraum">📅</i> : null}
            {activeCount === 0 ? <i className="sb-chip muted" title="keine Filter">∅</i> : null}
          </span>
        </button>
      )}

      {showFilters && !collapsed && (
        <>
          <div className="nav-label nav-label-filter" style={{ marginTop: 18 }}>
            Filter{activeCount > 0 && <span className="nav-filter-count">{activeCount} aktiv</span>}
            <button className="drawer-close" onClick={() => setDrawer(false)} aria-label="Schließen">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <FilterControls />
        </>
      )}

      <div className="spacer" />
      <NextRun />
      <div className="side-foot">
        <span className="obs">Erscheinungsbild</span>
        <ThemeToggle />
      </div>

      {/* Backdrop hinter dem Drawer (nur mobil sichtbar) */}
      {drawer && <button className="drawer-backdrop" onClick={() => setDrawer(false)} aria-label="Filter schließen" />}
    </aside>
  );
}
