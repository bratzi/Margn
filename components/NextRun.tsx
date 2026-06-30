"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Zeitplan (UTC, GitHub-Actions in .github/workflows/analyze.yml):
//   Pipeline (Discovery + Render in EINEM Job): self-pacing Loop, scrapt STÜNDLICH um :10.
//     → bewusst NICHT zur vollen Stunde (:00). Seed-Cron :10/:40 startet nur den Loop.
//   (structure läuft separat nur wöchentlich.)
// WICHTIG: GitHub-Cron ist best-effort — der echte Start kann sich um Minuten verzögern
// oder ein Slot ganz ausfallen. Angezeigt wird der GEPLANTE Zeitpunkt, keine Garantie.
function nextPipeline(): Date {
  const now = new Date();
  const c = new Date(now);
  c.setUTCMinutes(10, 0, 0);                      // :10 der aktuellen Stunde
  if (c.getTime() <= now.getTime()) c.setUTCHours(c.getUTCHours() + 1); // schon vorbei → nächste Stunde
  return c;
}
function cd(target: Date): string {
  const s = Math.max(0, Math.floor((target.getTime() - Date.now()) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
const clock = (d: Date) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

export default function NextRun() {
  const [pl, setPl] = useState("");
  const [at, setAt] = useState("");
  const [active, setActive] = useState(false);

  // Countdown-Ticker
  useEffect(() => {
    const tick = () => { const n = nextPipeline(); setPl(cd(n)); setAt(clock(n)); };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  // „läuft gerade": frische Daten in der DB (Pipeline rendert) → letzte Aktivität < 4 min.
  // EGRESS-Sparen: NUR pollen, wenn der Tab sichtbar ist (vergessener Hintergrund-Tab = 0 Requests),
  // und nur alle 60 s — die Pipeline läuft stündlich, häufiger muss der „läuft"-Indikator nicht sein.
  useEffect(() => {
    let cancelled = false;
    let t: ReturnType<typeof setInterval> | null = null;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const { data } = await supabase.from("page_overview").select("last_seen").order("last_seen", { ascending: false }).limit(1);
        const ts = data?.[0]?.last_seen ? Date.parse(data[0].last_seen as string) : 0;
        if (!cancelled) setActive(ts > 0 && Date.now() - ts < 4 * 60 * 1000);
      } catch { /* offline/again later */ }
    };
    const start = () => { if (!t) { check(); t = setInterval(check, 60000); } };
    const stop = () => { if (t) { clearInterval(t); t = null; } };
    const onVis = () => (document.visibilityState === "visible" ? start() : stop());
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; stop(); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  return (
    <div className="nextrun nextrun-multi" title={"Automatik: Pipeline (Discovery + Render) stündlich um :10 (bewusst nicht zur vollen Stunde). GitHub-Cron ist best-effort — der Start kann sich verzögern oder ausfallen, der Wert ist der GEPLANTE Zeitpunkt. Badge „läuft“ = aktuell frische Daten erkannt."}>
      <div className="nr-head">
        <span>Automatik</span>
        {active && <span className="nr-live"><i />läuft</span>}
      </div>
      <div className="nr-row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l3 8 4-16 3 8h4" /></svg>
        <span className="nr-label">Pipeline <i className="nr-ivl">stündlich</i></span>
        <span className={`nr-time mono tnum ${active ? "is-dim" : ""}`}>{pl}</span>
      </div>
      <div className="nr-row">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        <span className="nr-label">geplant <i className="nr-ivl">best-effort</i></span>
        <span className="nr-time mono tnum">≈ {at}</span>
      </div>
    </div>
  );
}
