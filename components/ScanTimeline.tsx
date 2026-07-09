"use client";

import { useMemo, useRef, useState } from "react";

type DotInfo = {
  x: number;       // 0–100 %
  t: number;       // ms timestamp
  change: boolean;
};

export default function ScanTimeline({ firstSeen, lastSeen, scanTimes, changeTimes, scanCount, goneAt }: {
  firstSeen: string | null;
  lastSeen: string | null;
  scanTimes: string[] | null;
  changeTimes: string[];
  scanCount: number | null;
  // Zeitpunkt der LETZTEN Link-Sichtung, wenn der Artikel rausgeflogen ist (sonst null):
  // ab hier fand der Crawl den Link auf keiner Übersichtsseite/Feed/Sitemap mehr.
  goneAt?: string | null;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ dot: DotInfo; clientX: number; clientY: number } | null>(null);

  const { dots, t0, t1, goneX, goneT } = useMemo(() => {
    const all = (scanTimes && scanTimes.length ? scanTimes : [firstSeen, lastSeen]).filter(Boolean) as string[];
    const ms = all.map((d) => new Date(d).getTime()).sort((a, b) => a - b);
    const first = firstSeen ? new Date(firstSeen).getTime() : ms[0];
    const last  = lastSeen  ? new Date(lastSeen).getTime()  : ms[ms.length - 1];
    const gone = goneAt ? new Date(goneAt).getTime() : null;
    const t0 = Math.min(first, ms[0] ?? first);
    // Rausflug-Zeitpunkt kann NACH dem letzten Scan liegen → Achse bis dorthin dehnen.
    const t1 = Math.max(last, ms[ms.length - 1] ?? last, gone ?? -Infinity);
    const span = Math.max(1, t1 - t0);
    const changeSet = new Set(changeTimes.map((c) => Math.round(new Date(c).getTime() / 60000)));
    const dotArr: DotInfo[] = ms.map((m) => ({
      x: ((m - t0) / span) * 100,
      t: m,
      change: changeSet.has(Math.round(m / 60000)),
    }));
    const goneX = gone != null ? ((gone - t0) / span) * 100 : null;
    return { dots: dotArr, t0, t1, goneX, goneT: gone };
  }, [firstSeen, lastSeen, scanTimes, changeTimes, goneAt]);

  const fmtFull = (ms: number) =>
    new Date(ms).toLocaleString("de-DE", {
      weekday: "short", day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin",
    });
  const fmtDate = (ms: number) =>
    new Date(ms).toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric", timeZone: "Europe/Berlin" });

  const days = Math.round((t1 - t0) / 86400000);
  const durLabel = days >= 1 ? `${days} Tag${days === 1 ? "" : "e"}` : `${Math.max(1, Math.round((t1 - t0) / 3600000))} h`;
  const baseline = !scanTimes || scanTimes.length === 0;
  const totalScans = scanCount ?? dots.length;
  const changeCount = changeTimes.length;

  // Monatliche Marker auf der Zeitlinie
  const monthMarkers = useMemo(() => {
    if (days < 14) return [];
    const span = Math.max(1, t1 - t0);
    const out: { x: number; label: string }[] = [];
    const d = new Date(t0);
    d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
    d.setUTCMonth(d.getUTCMonth() + 1);
    while (d.getTime() < t1) {
      out.push({
        x: ((d.getTime() - t0) / span) * 100,
        label: d.toLocaleDateString("de-DE", { month: "short", timeZone: "UTC" }),
      });
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
    return out;
  }, [t0, t1, days]);

  return (
    <div className="scant">
      {/* Kopfzeile mit Metriken */}
      <div className="scant-head">
        <div className="scant-endpoint">
          <span className="scant-k">Erstmals erfasst</span>
          <span className="scant-v">{fmtDate(t0)}</span>
        </div>
        <div className="scant-mid">
          <span className="scant-dur">{durLabel} beobachtet</span>
          <div className="scant-badges">
            <span className="scant-badge scant-badge-scan">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
              </svg>
              {totalScans.toLocaleString("de-DE")} Scans
            </span>
            {changeCount > 0 && (
              <span className="scant-badge scant-badge-change">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                {changeCount} Änderung{changeCount !== 1 ? "en" : ""}
              </span>
            )}
          </div>
        </div>
        <div className="scant-endpoint" style={{ textAlign: "right" }}>
          <span className="scant-k">Zuletzt gesehen</span>
          <span className="scant-v">{fmtDate(t1)}</span>
        </div>
      </div>

      {/* Track */}
      <div
        className="scant-track"
        ref={trackRef}
        onMouseLeave={() => setHover(null)}
      >
        {/* Fortschrittsbalken (Gradient) */}
        <div className="scant-line" />

        {/* Start/End-Caps */}
        <div className="scant-cap start" title={fmtFull(t0)} />
        <div className="scant-cap end" title={fmtFull(t1)} />

        {/* Monats-Marker */}
        {monthMarkers.map((m, i) => (
          <div key={i} className="scant-month-tick" style={{ left: `${m.x}%` }}>
            <span>{m.label}</span>
          </div>
        ))}

        {/* Rausgeflogen-Marker: letzter Ort, an dem der Crawl den Link noch verlinkt fand.
            Danach tauchte er auf keiner Startseite, keinem Ressort, Feed oder Sitemap mehr auf. */}
        {goneX != null && goneT != null && (
          <div className="scant-gone" style={{ left: `${goneX}%` }}
            title={`Link nicht mehr gefunden — zuletzt verlinkt gesehen ${fmtFull(goneT)}`}>
            <span className="scant-gone-dot" />
          </div>
        )}

        {/* Scan-Punkte */}
        {dots.map((d, i) => (
          <button
            key={i}
            className={`scant-dot ${d.change ? "change" : ""}`}
            style={{ left: `${d.x}%` }}
            onMouseEnter={(e) => setHover({ dot: d, clientX: e.clientX, clientY: e.clientY })}
            onMouseMove={(e) => setHover({ dot: d, clientX: e.clientX, clientY: e.clientY })}
            aria-label={fmtFull(d.t)}
          />
        ))}

        {/* Tooltip */}
        {hover && (
          <div
            className={`scant-tip ${hover.dot.change ? "change" : ""}`}
            style={{ left: `${hover.dot.x}%` }}
          >
            <span className="scant-tip-type">
              {hover.dot.change ? "✎ Scan mit Änderung" : "Scan"}
            </span>
            <span className="scant-tip-time">{fmtFull(hover.dot.t)}</span>
          </div>
        )}
      </div>

      {/* Legende */}
      <div className="scant-legend">
        <span><i className="scant-dot-leg" /> Scan</span>
        <span><i className="scant-dot-leg change" /> Scan mit Änderung</span>
        {goneX != null && <span><i className="scant-dot-leg gone" /> Link nicht mehr gefunden</span>}
        {baseline && <span className="faint">· Einzel-Scans werden ab jetzt erfasst</span>}
      </div>
    </div>
  );
}
