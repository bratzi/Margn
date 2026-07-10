"use client";

// Dezenter Umschalter Säulen ↔ Kurve — kleines Badge, das IM Chart sitzt (oben rechts,
// via .cst-abs). Wiederverwendbar überall, wo dieselben Daten als Säulen ODER Kurve
// gezeigt werden können (RateStats, Zeitstrahl). stopPropagation schirmt die Chart-
// Gesten darunter ab (Pan/Doppelklick/Drag).
export type ChartStyle = "bars" | "curve";

export default function ChartStyleToggle({ value, onChange, className }: {
  value: ChartStyle; onChange: (s: ChartStyle) => void; className?: string;
}) {
  return (
    <div
      className={`cst${className ? ` ${className}` : ""}`}
      role="group" aria-label="Darstellung: Säulen oder Kurve"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button type="button" className={value === "bars" ? "on" : ""} title="Als Säulen zeigen" onClick={() => onChange("bars")}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
          <path d="M5 19V10M10 19V5M15 19v-8M20 19v-5" />
        </svg>
      </button>
      <button type="button" className={value === "curve" ? "on" : ""} title="Als Kurve zeigen" onClick={() => onChange("curve")}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 17c3-1 4-8 7-8s4 6 7 6c2 0 3-2 4-4" />
        </svg>
      </button>
    </div>
  );
}
