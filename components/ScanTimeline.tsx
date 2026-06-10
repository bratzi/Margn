"use client";

import { useMemo, useState } from "react";

// Horizontale Scan-Timeline: jeder Punkt = ein Scan; Änderungs-Scans hervorgehoben.
// Zeigt auf einen Blick: wann erstmals erfasst, wann zuletzt gesehen, wie oft gescannt.
export default function ScanTimeline({ firstSeen, lastSeen, scanTimes, changeTimes, scanCount }: {
  firstSeen: string | null; lastSeen: string | null; scanTimes: string[] | null; changeTimes: string[]; scanCount: number | null;
}) {
  const [hover, setHover] = useState<{ x: number; label: string; change: boolean } | null>(null);

  const { dots, t0, t1, span } = useMemo(() => {
    const all = (scanTimes && scanTimes.length ? scanTimes : [firstSeen, lastSeen]).filter(Boolean) as string[];
    const ms = all.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
    const first = firstSeen ? new Date(firstSeen).getTime() : ms[0];
    const last = lastSeen ? new Date(lastSeen).getTime() : ms[ms.length - 1];
    const t0 = Math.min(first, ms[0] ?? first);
    const t1 = Math.max(last, ms[ms.length - 1] ?? last);
    const span = Math.max(1, t1 - t0);
    const changeSet = new Set(changeTimes.map((c) => Math.round(new Date(c).getTime() / 60000)));
    const dots = ms.map((m) => ({ x: ((m - t0) / span) * 100, t: m, change: changeSet.has(Math.round(m / 60000)) }));
    return { dots, t0, t1, span };
  }, [firstSeen, lastSeen, scanTimes, changeTimes]);

  const fmt = (ms: number) => new Date(ms).toLocaleString("de-DE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
  const fmtD = (ms: number) => new Date(ms).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Berlin" });
  const days = Math.round((t1 - t0) / 86400000);
  const durLabel = days >= 1 ? `${days} Tag${days === 1 ? "" : "e"}` : `${Math.max(1, Math.round((t1 - t0) / 3600000))} h`;
  const baseline = !scanTimes || scanTimes.length === 0;

  return (
    <div className="scant">
      <div className="scant-head">
        <div><span className="scant-k">Erstmals erfasst</span><span className="scant-v">{fmtD(t0)}</span></div>
        <div className="scant-mid"><span className="scant-dur">{durLabel} beobachtet</span><span className="scant-cnt">{(scanCount ?? dots.length).toLocaleString("de-DE")} Scans · {changeTimes.length} Änderungen</span></div>
        <div style={{ textAlign: "right" }}><span className="scant-k">Zuletzt gesehen</span><span className="scant-v">{fmtD(t1)}</span></div>
      </div>
      <div className="scant-track" onMouseLeave={() => setHover(null)}>
        <div className="scant-line" />
        <div className="scant-cap start" />
        <div className="scant-cap end" />
        {dots.map((d, i) => (
          <span key={i} className={`scant-dot ${d.change ? "change" : ""}`} style={{ left: `${d.x}%` }}
            onMouseEnter={() => setHover({ x: d.x, label: fmt(d.t), change: d.change })} />
        ))}
        {hover && (
          <div className="scant-tip" style={{ left: `${hover.x}%` }}>
            {hover.change ? "✎ Geändert · " : "Scan · "}{hover.label}
          </div>
        )}
      </div>
      <div className="scant-legend">
        <span><i className="scant-dot" /> Scan</span>
        <span><i className="scant-dot change" /> Scan mit Änderung</span>
        {baseline && <span className="faint">· Einzel-Scans werden ab jetzt erfasst</span>}
      </div>
    </div>
  );
}
