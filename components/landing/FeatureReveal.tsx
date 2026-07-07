"use client";

import { useState } from "react";

// Interaktive Funktions-Sektion: links eine große Liste der Funktionen,
// rechts eine Bühne, die beim Hover/Fokus die passende animierte
// Daten-Vorschau + Erläuterung einblendet. Ersetzt das frühere Lauf-Band.

function DiffPreview() {
  return (
    <div className="pv pv-diff" aria-hidden>
      <span className="pv-diff-meta">06:12 → 09:48 · stille Revision</span>
      <p className="pv-diff-line">
        EU einigt sich auf <del>strenge</del>{" "}
        <ins>deutlich strengere</ins> Regeln für Lieferketten
      </p>
      <span className="pv-diff-tag"><i /> 1 Edit nach Veröffentlichung</span>
    </div>
  );
}

function BarsPreview() {
  const rows: [string, number][] = [
    ["Politik", 86], ["Wirtschaft", 64], ["International", 57], ["Kultur", 31], ["Sport", 19],
  ];
  return (
    <div className="pv pv-bars" aria-hidden>
      {rows.map(([l, v], i) => (
        <span className="pv-bar" key={l} style={{ ["--v" as any]: `${v}%`, ["--d" as any]: `${i * 70}ms` }}>
          <b>{l}</b>
          <i><u /></i>
          <em>{v > 60 ? "2×∅" : ""}</em>
        </span>
      ))}
    </div>
  );
}

function PaywallPreview() {
  return (
    <div className="pv pv-paywall" aria-hidden>
      <div className="pv-ring" style={{ ["--p" as any]: "58%" }}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        <span className="pv-ring-v">58<small>%</small></span>
      </div>
      <div className="pv-paywall-meta">
        <span>Paywall-Quote · Wirtschaft</span>
        <b className="pv-up">+6 pp ggü. Vorperiode</b>
      </div>
    </div>
  );
}

function BenchPreview() {
  const rows: [string, number, string][] = [
    ["Quelle A", 92, "+18%"], ["Quelle B", 61, "−4%"], ["Quelle C", 44, "+2%"],
  ];
  return (
    <div className="pv pv-bench" aria-hidden>
      {rows.map(([l, v, d], i) => (
        <span className="pv-bench-row" key={l} style={{ ["--v" as any]: `${v}%`, ["--d" as any]: `${i * 90}ms` }}>
          <b>{l}</b>
          <i><u /></i>
          <em className={d.startsWith("−") ? "dn" : "up"}>{d}</em>
        </span>
      ))}
    </div>
  );
}

function RadarPreview() {
  const chips = ["Politik · Ausland", "Wirtschaft · Finanzen", "Sport · Fußball", "Kultur · Film", "Regional · Hessen"];
  return (
    <div className="pv pv-radar" aria-hidden>
      {chips.map((c, i) => (
        <span className="pv-chip" key={c} style={{ ["--d" as any]: `${i * 80}ms` }}>{c}</span>
      ))}
    </div>
  );
}

function TrendPreview() {
  const rows: [string, number, string][] = [
    ["Hitzewelle", 88, "+142%"], ["WM-Finale", 64, "+38%"], ["Koalition", 37, "−21%"],
  ];
  return (
    <div className="pv pv-bench" aria-hidden>
      {rows.map(([l, v, d], i) => (
        <span className="pv-bench-row" key={l} style={{ ["--v" as any]: `${v}%`, ["--d" as any]: `${i * 90}ms` }}>
          <b>{l}</b>
          <i><u /></i>
          <em className={d.startsWith("−") ? "dn" : "up"}>{d}</em>
        </span>
      ))}
    </div>
  );
}

function RedatePreview() {
  return (
    <div className="pv pv-diff" aria-hidden>
      <span className="pv-diff-meta">Verlag datiert um · Artikel wirkt „neu“</span>
      <p className="pv-diff-line">
        Veröffentlicht: <ins>31.10.2025</ins>, nicht <del>06.07.2026</del>
      </p>
      <span className="pv-diff-tag"><i /> Umdatierung als „Aktualisiert“ ausgewiesen</span>
    </div>
  );
}

function PulsePreview() {
  return (
    <div className="pv pv-pulse" aria-hidden>
      <svg viewBox="0 0 240 90" preserveAspectRatio="none">
        <path className="pv-pulse-area" d="M0,72 C30,60 44,30 70,38 C96,46 104,18 130,22 C156,26 168,58 196,52 C220,47 230,64 240,60 L240,90 L0,90 Z" />
        <path className="pv-pulse-line" d="M0,72 C30,60 44,30 70,38 C96,46 104,18 130,22 C156,26 168,58 196,52 C220,47 230,64 240,60" />
        <circle className="pv-pulse-dot" cx="130" cy="22" r="3.4" />
      </svg>
      <span className="pv-pulse-meta">Publikations-Peak · 08:00–09:00 · klickbar bis zur Minute</span>
    </div>
  );
}

const FEATURES = [
  { n: "01", key: "edits", title: "Silent Edits", tag: "Versionierung", preview: <DiffPreview />,
    text: "Jeder Scan wird versioniert. Wort für Wort sichtbar, was sich nach der Veröffentlichung geändert hat — rot entfernt, grün ergänzt." },
  { n: "02", key: "dna", title: "Themen-DNA", tag: "Agenda-Setting", preview: <BarsPreview />,
    text: "Agenda-Profile nach dem Vorbild der Agenda-Setting-Forschung: Wer setzt wie stark auf welches Thema — und wer liegt doppelt über dem Marktschnitt?" },
  { n: "03", key: "paywall", title: "Paywall-Monitoring", tag: "Zugang", preview: <PaywallPreview />,
    text: "Welche Inhalte gelten als zahlungswürdig? Paywall-Quoten je Thema und Publizist, im Zeitvergleich mit der Vorperiode — ehrlich gerechnet." },
  { n: "04", key: "bench", title: "Publizisten-Benchmark", tag: "Vergleich", preview: <BenchPreview />,
    text: "Volumen, Publikations-Tempo, Autoren-Transparenz: jede Quelle im direkten Vergleich — mit expliziter Vergleichsbasis statt schöner, leerer Zahlen." },
  { n: "05", key: "radar", title: "Unterthemen-Radar", tag: "Rubriken", preview: <RadarPreview />,
    text: "Verlagseigene Rubriken wie Politik · Ausland oder Sport · Fußball, quellenübergreifend aus URL- und Seitenstruktur abgeleitet — bis hinunter auf Bundesland-Ebene." },
  { n: "06", key: "pulse", title: "Publikationsrhythmen", tag: "Zeitverlauf", preview: <PulsePreview />,
    text: "Publikationsrhythmen von Kalenderwochen bis auf Minuten zoombar. Ein Klick auf einen Datenpunkt filtert die Artikelliste exakt auf dieses Zeitfenster." },
  { n: "07", key: "trends", title: "Keyword-Trends", tag: "Begriffskonjunktur", preview: <TrendPreview />,
    text: "Welche Begriffe steigen im Nachrichtenstrom auf, welche verschwinden? Mehrere Suchbegriffe im Zeitverlauf — absolut oder als Anteil, Absteiger inklusive." },
  { n: "08", key: "redate", title: "Datums-Forensik", tag: "Re-Dating", preview: <RedatePreview />,
    text: "Verlage datieren Timelines, Podcast-Folgen und Ratgeber gern auf „heute“ um, damit sie neu wirken. margn bewahrt das originale Veröffentlichungsdatum und weist jede Verschiebung als Aktualisierung aus." },
];

export default function FeatureReveal() {
  const [active, setActive] = useState(0);

  return (
    <section className="mg-section mg-reveal" id="funktionen">
      <div className="mg-head">
        <p className="mg-overline">Funktionen</p>
        <h2 className="mg-h2" data-split>
          Acht Blicke <em>hinter</em> die Schlagzeile
        </h2>
        <p className="mg-lede" data-reveal="0">
          Fahre über eine Funktion — rechts erscheint, was sie sichtbar macht.
        </p>
      </div>

      <div className="mg-reveal-grid" data-reveal="0.05">
        <ul className="mg-reveal-list">
          {FEATURES.map((f, i) => (
            <li key={f.key}>
              <button
                type="button"
                className={`mg-reveal-item${i === active ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                aria-pressed={i === active}
              >
                <span className="ri-n">/{f.n}</span>
                <span className="ri-t">{f.title}</span>
                <span className="ri-arr" aria-hidden>→</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="mg-reveal-stage">
          {FEATURES.map((f, i) => (
            <article
              key={f.key}
              className={`mg-reveal-card${i === active ? " is-active" : ""}`}
              aria-hidden={i !== active}
            >
              <div className="rc-preview">{f.preview}</div>
              <div className="rc-body">
                <span className="rc-tag">{f.tag}</span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
