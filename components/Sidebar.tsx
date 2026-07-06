"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import NextRun from "@/components/NextRun";
import FilterControls from "@/components/FilterControls";
import { useFilters } from "@/components/FilterProvider";
import { Newspaper, FileDiff, TrendingUp } from "@/components/icons";

const NAV = [
  { href: "/articles", label: "Übersicht", icon: Newspaper },
  { href: "/articles/edits", label: "Silent Edits", icon: FileDiff },
  { href: "/articles/keywords", label: "Keyword-Trends", icon: TrendingUp },
];

export default function Sidebar() {
  const path = usePathname();
  const f = useFilters();
  const showFilters = path === "/articles" || path === "/articles/edits" || path === "/articles/keywords";
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
    changed: f.changed !== "all",
    depth: f.depth !== "all",
    search: f.search.trim().length >= 2 || f.searchTerms.length > 0,
    regional: !f.hideRegional, // Einbeziehen = Abweichung vom Standard (ausgeblendet)
    range: !(f.rangeIdx.from === 0 && f.rangeIdx.to === f.days.length - 1) || !!f.pinpoint,
  };
  const activeCount =
    (ind.pub ? 1 : 0) + (ind.status ? 1 : 0) + (ind.paywall ? 1 : 0) +
    (ind.author ? 1 : 0) + (ind.atype ? 1 : 0) + (ind.topics ? 1 : 0) +
    (ind.subcats ? 1 : 0) + (ind.lang ? 1 : 0) + (ind.keyword ? 1 : 0) +
    (ind.changed ? 1 : 0) + (ind.depth ? 1 : 0) + (ind.search ? 1 : 0) +
    (ind.regional ? 1 : 0) + (ind.range ? 1 : 0);

  // Landingpage + Login sind full-bleed ohne App-Chrome.
  // WICHTIG: erst NACH allen Hooks returnen (Rules of Hooks — Layout persistiert über Routen).
  if (path === "/" || path === "/login" || path === "/impressum" || path === "/datenschutz") return null;

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
        return <Link key={n.href} href={n.href} className={`nav-item ${on ? "on" : ""}`} title={n.label}><Icon /> <span>{n.label}</span></Link>;
      })}

      {/* Kollabiert: vertikale Icon-Leiste der AKTIVEN Filter. Reine Icons, klick öffnet. */}
      {showFilters && collapsed && (() => {
        const items: { id: string; label: string; n?: number; icon: React.ReactNode }[] = [];
        const I = (d: string) => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
        if (ind.pub) items.push({ id: "pub", label: `${ind.pub} Publizist(en)`, n: ind.pub, icon: I("M3 7h18M3 12h18M3 17h18") });
        if (ind.topics) items.push({ id: "tp", label: `${ind.topics} Thema/Themen`, n: ind.topics, icon: I("M3 7l2-3h6l2 3h6v12H3z") });
        if (ind.subcats) items.push({ id: "sc", label: `${ind.subcats} Rubrik(en)`, n: ind.subcats, icon: I("M9 5v8a4 4 0 0 0 4 4h7M16 13l4 4-4 4") });
        if (ind.paywall) items.push({ id: "pw", label: "Paywall-Filter", icon: I("M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z") });
        if (ind.author) items.push({ id: "au", label: "Autor-Filter", icon: I("M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z") });
        if (ind.atype) items.push({ id: "at", label: "Seitentyp-Filter", icon: I("M4 4h16v16H4zM4 9h16") });
        if (ind.status) items.push({ id: "st", label: "Erfassungs-Filter", icon: I("M12 2v4M12 18v4M2 12h4M18 12h4") });
        if (ind.keyword) items.push({ id: "kw", label: "Keyword-Filter", icon: I("M4 9h16M4 15h16M10 3 8 21M16 3l-2 18") });
        if (ind.search) items.push({ id: "se", label: "Such-Filter", n: f.searchTerms.length > 1 ? f.searchTerms.length : undefined, icon: I("m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z") });
        if (ind.regional) items.push({ id: "rg2", label: "inkl. Regional & Lokales", icon: I("M9 20 3 17V4l6 3m0 13 6-3m-6 3V7m6 10 6 3V7l-6-3m0 13V4M9 7l6-3") });
        if (ind.changed) items.push({ id: "ch", label: "Änderungs-Filter", icon: I("M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z") });
        if (ind.depth) items.push({ id: "dp", label: "Tiefe-Filter", icon: I("M4 6h16M4 12h10M4 18h6") });
        if (ind.lang) items.push({ id: "lg", label: "Sprach-Filter", icon: I("M2 12h20M12 2a15 15 0 0 1 0 20A15 15 0 0 1 12 2z") });
        if (ind.range) items.push({ id: "rg", label: "Zeitraum-Filter", icon: I("M3 4h18v18H3zM3 10h18M8 2v4M16 2v4") });
        return (
          <div className="sb-fstack">
            <button className="sb-fstack-toggle" onClick={toggleCollapsed} title={`${activeCount} Filter aktiv — ausklappen`}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5h18M6 12h12M10 19h4" /></svg>
              {activeCount > 0 && <i className="sb-fstack-badge">{activeCount}</i>}
            </button>
            {items.map((it) => (
              <button key={it.id} className="sb-ficon" onClick={toggleCollapsed} title={it.label} aria-label={it.label}>
                {it.icon}
                {it.n && it.n > 1 ? <i className="sb-ficon-n">{it.n}</i> : null}
              </button>
            ))}
            {activeCount === 0 && <span className="sb-fstack-empty" title="keine Filter aktiv">∅</span>}
          </div>
        );
      })()}

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
      <form className="side-logout" method="POST" action="/api/logout">
        <button type="submit" title="Abmelden" aria-label="Abmelden">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
          <span>Abmelden</span>
        </button>
      </form>

      {/* Backdrop hinter dem Drawer (nur mobil sichtbar) */}
      {drawer && <button className="drawer-backdrop" onClick={() => setDrawer(false)} aria-label="Filter schließen" />}
    </aside>
  );
}
