"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";

const TABS = [
  { href: "/articles", label: "Übersicht" },
  // { href: "/edits", label: "Stille Edits" },   // Feature auf Eis
  // { href: "/echoes", label: "Echo-Cluster" },  // Feature auf Eis
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link href="/articles" className="brand" aria-label="margn – Medienobservatorium">
          <span className="word">marg<span className="mark">n</span></span>
          <span className="tag">Medienobservatorium</span>
        </Link>
        <div className="nav-right">
          <div className="tabs">
            {TABS.map((t) => (
              <Link key={t.href} href={t.href} className={`tab ${path === t.href || (t.href === "/articles" && path.startsWith("/articles")) ? "on" : ""}`}>{t.label}</Link>
            ))}
          </div>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
