"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "@/components/icons";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const t = (document.documentElement.dataset.theme as "light" | "dark") || "light";
    setTheme(t);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("margn-theme", next); } catch {}
    setTheme(next);
  }

  return (
    <button onClick={toggle} className="theme-toggle" aria-label={theme === "dark" ? "Helles Design" : "Dunkles Design"} title={theme === "dark" ? "Hell" : "Dunkel"}>
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
