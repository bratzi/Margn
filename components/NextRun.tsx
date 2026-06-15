"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Zeitpläne (UTC, GitHub-Actions-Cron):
//   Crawl/Discovery: alle 2 h zur vollen Stunde   (scrape.yml  "0 */2 * * *")
//   Analyse/Render:  alle 6 h um :30 (h ∈ 0,6,12,18)  (analyze.yml "30 */6 * * *")
function nextScrape(): Date {
  const now = new Date();
  const d = new Date(now);
  d.setUTCHours((Math.floor(now.getUTCHours() / 2) + 1) * 2, 0, 0, 0); // 24 rollt auf morgen 00:00
  return d;
}
function nextAnalyze(): Date {
  const now = new Date();
  for (let day = 0; day < 2; day++) {
    for (const h of [0, 6, 12, 18]) {
      const c = new Date(now);
      c.setUTCDate(now.getUTCDate() + day);
      c.setUTCHours(h, 30, 0, 0);
      if (c.getTime() > now.getTime()) return c;
    }
  }
  const f = new Date(now); f.setUTCDate(now.getUTCDate() + 1); f.setUTCHours(0, 30, 0, 0);
  return f;
}
function cd(target: Date): string {
  const s = Math.max(0, Math.floor((target.getTime() - Date.now()) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export default function NextRun() {
  const [scr, setScr] = useState("");
  const [ana, setAna] = useState("");
  const [active, setActive] = useState(false);

  // Countdown-Ticker
  useEffect(() => {
    const tick = () => { setScr(cd(nextScrape())); setAna(cd(nextAnalyze())); };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // „läuft gerade": frische Daten in der DB (Analyse rendert) → letzte Aktivität < 4 min.
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const { data } = await supabase.from("page_overview").select("last_seen").order("last_seen", { ascending: false }).limit(1);
        const ts = data?.[0]?.last_seen ? Date.parse(data[0].last_seen as string) : 0;
        if (!cancelled) setActive(ts > 0 && Date.now() - ts < 4 * 60 * 1000);
      } catch { /* offline/again later */ }
    };
    check();
    const t = setInterval(check, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <div className="nextrun nextrun-multi" title={'Automatik (UTC): Crawl alle 2 h · Analyse alle 6 h. Badge „läuft“ = aktuell frische Daten erkannt.'}>
      <div className="nr-head">
        <span>Automatik</span>
        {active && <span className="nr-live"><i />läuft</span>}
      </div>
      <div className="nr-row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
        <span className="nr-label">Crawl <i className="nr-ivl">2 h</i></span>
        <span className="nr-time mono tnum">{scr}</span>
      </div>
      <div className="nr-row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>
        <span className="nr-label">Analyse <i className="nr-ivl">6 h</i></span>
        <span className={`nr-time mono tnum ${active ? "is-dim" : ""}`}>{ana}</span>
      </div>
    </div>
  );
}
