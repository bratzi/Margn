import Link from "next/link";
import LandingStats from "@/components/LandingStats";

export const metadata = {
  title: "margn — Was Nachrichtenseiten ändern, nachdem sie publiziert haben",
  description:
    "Offenes Medienobservatorium: erfasst Artikel aus DE & FR stündlich, versioniert sie und macht stille Änderungen, Agenda-Profile und Paywall-Strategien sichtbar.",
};

const FEATURES = [
  {
    icon: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z",
    title: "Silent Edits",
    text: "Überschriften und Texte werden nach der Veröffentlichung still geändert. margn versioniert jeden Scan und zeigt Wort für Wort, was sich geändert hat — rot entfernt, grün neu.",
  },
  {
    icon: "M3 3v18h18M7 16l4-6 4 3 5-8",
    title: "Themen-DNA",
    text: "Agenda-Heatmap nach dem Vorbild der Agenda-Setting-Forschung: Welcher Publizist setzt wie stark auf welches Thema — und wer liegt 2× über dem Marktschnitt?",
  },
  {
    icon: "M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z",
    title: "Paywall-Monitoring",
    text: "Welche Inhalte gelten als zahlungswürdig? Paywall-Quoten je Thema und Publizist, im Zeitvergleich mit der Vorperiode — in Prozentpunkten, ehrlich gerechnet.",
  },
  {
    icon: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M9 2h6v4H9zM9 12h6M9 16h4",
    title: "Publizisten-Benchmark",
    text: "Artikel-Volumen, Publikations-Tempo, Autoren-Transparenz: jede Quelle im direkten Vergleich, mit expliziter Vergleichsbasis statt schöner, aber leerer Zahlen.",
  },
  {
    icon: "M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
    title: "Zeitverlauf bis zur Minute",
    text: "Publikationsrhythmen von Kalenderwochen bis auf Minuten zoombar. Ein Klick auf einen Datenpunkt filtert die Artikelliste exakt auf dieses Zeitfenster.",
  },
  {
    icon: "M9 5v8a4 4 0 0 0 4 4h7M16 13l4 4-4 4",
    title: "Unterthemen-Radar",
    text: "Verlagseigene Rubriken wie Politik · Ausland oder Sport · Fußball, quellenübergreifend aus den URL-Strukturen abgeleitet und als Filter nutzbar.",
  },
];

const STEPS = [
  { n: "01", title: "Erfassen", text: "Sechs Quellen aus Deutschland und Frankreich werden stündlich gelesen — schonend, per RSS und freundlicher Crawl-Rate." },
  { n: "02", title: "Versionieren", text: "Jeder Artikel wird bei jedem Scan verglichen. Änderungen an Titel und Text werden als Revision festgehalten — mit Zeitstempel." },
  { n: "03", title: "Auswerten", text: "Themen, Paywall, Autoren, Tiefe: alle Dimensionen werden publizistenübergreifend normalisiert und im Dashboard vergleichbar gemacht." },
];

function Icon({ d }: { d: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export default function Landing() {
  return (
    <div className="ld">
      {/* Sticky Top-Nav */}
      <header className="ld-nav">
        <div className="ld-nav-inner">
          <span className="ld-brand">
            <span className="brand-mark">m</span>
            <span className="ld-brand-name">margn</span>
            <span className="ld-brand-tag">Medienobservatorium</span>
          </span>
          <nav className="ld-nav-links">
            <a href="#funktionen">Funktionen</a>
            <a href="#methodik">Methodik</a>
            <a href="#transparenz">Transparenz</a>
          </nav>
          <Link href="/articles" className="ld-cta-sm">Dashboard öffnen</Link>
        </div>
      </header>

      {/* Hero */}
      <section className="ld-hero">
        <p className="ld-overline">Offenes Medienobservatorium · DE &amp; FR</p>
        <h1 className="ld-h1">
          Was Nachrichtenseiten ändern,<br />
          <em>nachdem</em> sie publiziert haben.
        </h1>
        <p className="ld-sub">
          margn beobachtet sechs große Nachrichtenquellen, versioniert jeden Artikel
          und macht sichtbar, was zwischen den Zeilen passiert: stille Überschriften-Änderungen,
          Agenda-Profile, Paywall-Strategien und Publikationsrhythmen.
        </p>
        <div className="ld-cta-row">
          <Link href="/articles" className="ld-cta">Dashboard öffnen</Link>
          <a href="#funktionen" className="ld-cta-ghost">Funktionen ansehen</a>
        </div>
        <LandingStats />
      </section>

      {/* Funktionen */}
      <section className="ld-section" id="funktionen">
        <p className="ld-overline">Funktionen</p>
        <h2 className="ld-h2">Mehrwerte, die man auf den ersten Blick nicht sieht</h2>
        <div className="ld-grid">
          {FEATURES.map((ftr) => (
            <div key={ftr.title} className="ld-card">
              <span className="ld-card-icon"><Icon d={ftr.icon} /></span>
              <h3>{ftr.title}</h3>
              <p>{ftr.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Methodik */}
      <section className="ld-section ld-section-alt" id="methodik">
        <p className="ld-overline">Methodik</p>
        <h2 className="ld-h2">Drei Schritte, stündlich wiederholt</h2>
        <div className="ld-steps">
          {STEPS.map((s) => (
            <div key={s.n} className="ld-step">
              <span className="ld-step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Transparenz */}
      <section className="ld-section" id="transparenz">
        <p className="ld-overline">Transparenz</p>
        <h2 className="ld-h2">Nur Metadaten. Volltexte bleiben bei den Verlagen.</h2>
        <div className="ld-trust">
          <div className="ld-trust-item">
            <h3>Respektvolles Crawling</h3>
            <p>RSS bevorzugt, robots.txt respektiert, freundliche Rate. Kein Spiegeln von Inhalten — jeder Artikel verlinkt auf das Original.</p>
          </div>
          <div className="ld-trust-item">
            <h3>Öffentliche Analysen</h3>
            <p>Veröffentlicht werden ausschließlich Metadaten und eigene Auswertungen: Zeitstempel, Themen, Quoten, Diffs von Überschriften.</p>
          </div>
          <div className="ld-trust-item">
            <h3>Nachvollziehbare Methodik</h3>
            <p>Spezialisierungs-Indizes, Share of Voice und Themen-Vielfalt folgen etablierten Maßen der Agenda-Setting-Forschung.</p>
          </div>
        </div>
      </section>

      {/* Abschluss-CTA */}
      <section className="ld-final">
        <h2 className="ld-h2">Selbst nachsehen, was sich geändert hat.</h2>
        <Link href="/articles" className="ld-cta">Zum Dashboard</Link>
      </section>

      <footer className="ld-foot">
        <span><span className="brand-mark sm">m</span> margn — Medienobservatorium</span>
        <span className="ld-foot-links">
          <Link href="/articles">Übersicht</Link>
          <Link href="/articles/edits">Silent Edits</Link>
        </span>
      </footer>
    </div>
  );
}
