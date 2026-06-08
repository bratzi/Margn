"use client";

import { useEffect, useState } from "react";

// Nächster scrape-Lauf: alle 3 Stunden zur vollen Stunde (UTC, cron "0 */3 * * *").
function nextRun(): Date {
  const now = new Date();
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  const h = now.getUTCHours();
  const nextH = (Math.floor(h / 3) + 1) * 3;
  d.setUTCHours(nextH);
  return d;
}

export default function NextRun() {
  const [left, setLeft] = useState("");

  useEffect(() => {
    const tick = () => {
      const ms = nextRun().getTime() - Date.now();
      const s = Math.max(0, Math.floor(ms / 1000));
      const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      setLeft(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="nextrun" title="Nächster Crawl + Analyse (alle 3 Stunden)">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
      <span className="nr-label">Nächster Crawl</span>
      <span className="nr-time mono tnum">{left}</span>
    </div>
  );
}
