"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/articles", label: "Fortschritt" },
  { href: "/edits", label: "Stille Edits" },
  { href: "/echoes", label: "Echo-Cluster" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav className="nav">
      <div className="nav-inner">
        <Link href="/articles" className="brand">News<span>Scraper</span></Link>
        <div className="tabs">
          {TABS.map((t) => (
            <Link key={t.href} href={t.href} className={`tab ${path === t.href ? "on" : ""}`}>{t.label}</Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
