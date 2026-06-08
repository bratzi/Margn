"use client";

type Seg = { label: string; value: number; color: string };

// Ring-/Donut-Diagramm (SVG). Eyecatcher statt Balken.
export default function Donut({ title, segments, centerLabel, centerSub }: {
  title: string; segments: Seg[]; centerLabel?: string; centerSub?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const R = 52, C = 2 * Math.PI * R, sw = 18;
  let offset = 0;
  const arcs = segments.filter((s) => s.value > 0).map((s) => {
    const frac = s.value / total;
    const dash = frac * C;
    const el = { ...s, dash, gap: C - dash, off: offset, frac };
    offset -= dash;
    return el;
  });

  return (
    <div className="donut-card panel">
      <h3>{title}</h3>
      <div className="donut-body">
        <svg viewBox="0 0 140 140" className="donut-svg">
          <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-2)" strokeWidth={sw} />
          {arcs.map((a, i) => (
            <circle key={i} cx="70" cy="70" r={R} fill="none" stroke={a.color} strokeWidth={sw}
              strokeDasharray={`${a.dash} ${a.gap}`} strokeDashoffset={a.off}
              transform="rotate(-90 70 70)" strokeLinecap="butt" style={{ transition: "stroke-dasharray .6s" }} />
          ))}
          <text x="70" y="66" textAnchor="middle" className="donut-center">{centerLabel}</text>
          <text x="70" y="84" textAnchor="middle" className="donut-sub">{centerSub}</text>
        </svg>
        <div className="donut-legend">
          {segments.map((s) => (
            <div key={s.label} className="dl-row">
              <span className="dl-dot" style={{ background: s.color }} />
              <span className="dl-label">{s.label}</span>
              <span className="dl-val tnum">{Math.round((s.value / total) * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
