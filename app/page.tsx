import Link from "next/link";
import LandingStats from "@/components/LandingStats";
import LandingBg from "@/components/LandingBg";
import LandingSources from "@/components/LandingSources";

export const metadata = {
  title: "margn — Was Nachrichtenseiten ändern, nachdem sie publiziert haben",
  description:
    "Offenes Medienobservatorium: erfasst Artikel aus DE & FR stündlich, versioniert sie und macht stille Änderungen, Agenda-Profile und Paywall-Strategien sichtbar.",
};

// Editoriale Feature-Liste — nummeriert statt Icon-Kacheln (ruhige, typografische Rhythmik).
const FEATURES = [
  {
    n: "01",
    title: "Silent Edits",
    text: "Überschriften und Texte werden nach der Veröffentlichung still geändert. margn versioniert jeden Scan und zeigt Wort für Wort, was sich geändert hat — rot entfernt, grün neu.",
  },
  {
    n: "02",
    title: "Themen-DNA",
    text: "Agenda-Heatmap nach dem Vorbild der Agenda-Setting-Forschung: Welcher Publizist setzt wie stark auf welches Thema — und wer liegt 2× über dem Marktschnitt?",
  },
  {
    n: "03",
    title: "Paywall-Monitoring",
    text: "Welche Inhalte gelten als zahlungswürdig? Paywall-Quoten je Thema und Publizist, im Zeitvergleich mit der Vorperiode — in Prozentpunkten, ehrlich gerechnet.",
  },
  {
    n: "04",
    title: "Publizisten-Benchmark",
    text: "Artikel-Volumen, Publikations-Tempo, Autoren-Transparenz: jede Quelle im direkten Vergleich, mit expliziter Vergleichsbasis statt schöner, aber leerer Zahlen.",
  },
  {
    n: "05",
    title: "Zeitverlauf bis zur Minute",
    text: "Publikationsrhythmen von Kalenderwochen bis auf Minuten zoombar. Ein Klick auf einen Datenpunkt filtert die Artikelliste exakt auf dieses Zeitfenster.",
  },
  {
    n: "06",
    title: "Unterthemen-Radar",
    text: "Verlagseigene Rubriken wie Politik · Ausland oder Sport · Fußball, quellenübergreifend und mehrsprachig aus den URL-Strukturen abgeleitet und als Filter nutzbar.",
  },
];

const STEPS = [
  { n: "01", title: "Erfassen", text: "Quellen aus Deutschland und Frankreich werden stündlich gelesen — schonend, per RSS und freundlicher Crawl-Rate." },
  { n: "02", title: "Versionieren", text: "Jeder Artikel wird bei jedem Scan verglichen. Änderungen an Titel und Text werden als Revision festgehalten — mit Zeitstempel." },
  { n: "03", title: "Auswerten", text: "Themen, Paywall, Autoren, Tiefe: alle Dimensionen werden publizistenübergreifend normalisiert und im Dashboard vergleichbar gemacht." },
];

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
            <a href="#abdeckung">Abdeckung</a>
            <a href="#methodik">Methodik</a>
            <a href="#transparenz">Transparenz</a>
          </nav>
          <Link href="/articles" className="ld-cta-sm">Dashboard öffnen</Link>
        </div>
      </header>

      {/* Hero — dunkles Statement-Panel mit Serif-Display */}
      <section className="ld-hero ld-dark">
        <LandingBg variant="network" />
        <p className="ld-overline">Offenes Medienobservatorium · Deutschland &amp; Frankreich</p>
        <h1 className="ld-h1">
          Was Nachrichtenseiten ändern,<br />
          <em>nachdem</em> sie publiziert haben.
        </h1>
        <p className="ld-sub">
          margn beobachtet große Nachrichtenquellen, versioniert jeden Artikel
          und macht sichtbar, was zwischen den Zeilen passiert: stille Überschriften-Änderungen,
          Agenda-Profile, Paywall-Strategien und Publikationsrhythmen.
        </p>
        <div className="ld-cta-row">
          <Link href="/articles" className="ld-cta">Dashboard öffnen</Link>
          <a href="#funktionen" className="ld-cta-ghost">Funktionen ansehen</a>
        </div>
      </section>

      {/* Kennzahlen-Band — Vertrauen über echte Zahlen */}
      <section className="ld-band">
        <LandingStats />
      </section>

      {/* Funktionen — editoriale, nummerierte Liste */}
      <section className="ld-section" id="funktionen">
        <p className="ld-overline">Funktionen</p>
        <h2 className="ld-h2">Mehrwerte, die man auf den ersten Blick nicht sieht</h2>
        <div className="ld-grid">
          {FEATURES.map((ftr) => (
            <div key={ftr.title} className="ld-card">
              <span className="ld-card-n">{ftr.n}</span>
              <h3>{ftr.title}</h3>
              <p>{ftr.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Abdeckung — Quellen & Länder (analog „Expansion"-Sektion) */}
      <section className="ld-section ld-section-alt" id="abdeckung">
        <p className="ld-overline">Abdeckung</p>
        <h2 className="ld-h2">Zwei Medienmärkte, eine Vergleichsbasis</h2>
        <p className="ld-lede">
          Sprachübergreifende Beobachtung: deutsche und französische Leitmedien werden mit derselben
          Methodik erfasst und normalisiert — Themen, Rubriken und Kennzahlen sind direkt vergleichbar.
        </p>
        <LandingSources />
      </section>

      {/* Methodik */}
      <section className="ld-section" id="methodik">
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
      <section className="ld-section ld-section-alt" id="transparenz">
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

      {/* Abschluss-CTA — dunkles Serif-Statement wie der Hero */}
      <section className="ld-final ld-dark">
        <LandingBg variant="flow" />
        <h2 className="ld-h2 ld-h2-final">Selbst nachsehen,<br /><em>was</em> sich geändert hat.</h2>
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
