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

  // Route-Wechsel schließt den mobilen Filter-Drawer
  useEffect(() => { setDrawer(false); }, [path]);
  // Body-Scroll sperren solange der Drawer offen ist
  useEffect(() => {
    document.body.classList.toggle("drawer-locked", drawer);
    return () => document.body.classList.remove("drawer-locked");
  }, [drawer]);

  // Anzahl gesetzter Filter (für Badge am mobilen Button)
  const activeCount =
    (f.activeArr.length !== f.sources.length ? 1 : 0) +
    (f.status !== "all" ? 1 : 0) + (f.paywall !== "all" ? 1 : 0) +
    (f.author !== "all" ? 1 : 0) + (f.atype !== "all" ? 1 : 0) +
    (f.topics.length ? 1 : 0) + (f.lang !== "all" ? 1 : 0);

  return (
    <aside className={`sidebar ${drawer ? "drawer-open" : ""}`}>
      <Link href="/articles" className="brand" aria-label="margn — Medienobservatorium">
        <span className="brand-mark">m</span>
        <span className="brand-text">
          <span className="brand-name">margn</span>
          <span className="brand-tag">Medienobservatorium</span>
        </span>
      </Link>

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

      {showFilters && (
        <>
          <div className="nav-label nav-label-filter" style={{ marginTop: 18 }}>
            Filter
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
