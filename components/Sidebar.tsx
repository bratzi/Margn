"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import NextRun from "@/components/NextRun";
import FilterControls from "@/components/FilterControls";
import { FileText, Clock } from "@/components/icons";

const NAV = [
  { href: "/articles", label: "Übersicht", icon: FileText },
  { href: "/articles/edits", label: "Silent Edits", icon: Clock },
];

export default function Sidebar() {
  const path = usePathname();
  const showFilters = path === "/articles";
  return (
    <aside className="sidebar">
      <Link href="/articles" className="brand" aria-label="margn">
        <span className="word">marg<span className="mark">n</span></span>
      </Link>

      <div className="nav-label">Observatorium</div>
      {NAV.map((n) => {
        const on = n.href === "/articles" ? path === "/articles" : path.startsWith(n.href);
        const Icon = n.icon;
        return <Link key={n.href} href={n.href} className={`nav-item ${on ? "on" : ""}`}><Icon /> {n.label}</Link>;
      })}

      {showFilters && <><div className="nav-label" style={{ marginTop: 18 }}>Filter</div><FilterControls /></>}

      <div className="spacer" />
      <NextRun />
      <div className="side-foot">
        <span className="obs">Medienobservatorium</span>
        <ThemeToggle />
      </div>
    </aside>
  );
}
