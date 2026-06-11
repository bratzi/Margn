"use client";

import { topicLabel } from "@/lib/topics";
import { useFilters } from "@/components/FilterProvider";

// Sub-Rubriken (verlagseigene Ressorts) des aktuell gewählten Topics.
// Visuell abgesetzt von den Haupt-Themen: eingerückt, kleiner, mit „↳"-Anker.
// Erscheint nur bei genau einem gewählten Topic und vorhandenen Optionen.
export default function SubTopicBar() {
  const f = useFilters();
  if (f.topics.length !== 1 || !f.subOpts.length) return null;
  const topic = f.topics[0];

  return (
    <div className="subtopic-bar">
      <span className="subtopic-anchor">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 5v8a4 4 0 0 0 4 4h7" /><path d="m16 13 4 4-4 4" />
        </svg>
        Rubriken in <b>{topicLabel(topic)}</b>
      </span>
      <div className="subtopic-chips">
        {f.subOpts.map((s) => {
          const on = f.subcats.includes(s.key);
          return (
            <button
              key={s.key}
              className={`subtopic-chip ${on ? "on" : ""}`}
              onClick={() => f.toggleSubcat(s.key)}
              title={`${s.key} · ${s.n} Artikel · ${s.sources} ${s.sources === 1 ? "Quelle" : "Quellen"}`}
            >
              {s.key}
              <span className="subtopic-n">{s.n}</span>
              {s.sources > 1 && <i className="subtopic-multi" title="quellenübergreifend">⇄</i>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
