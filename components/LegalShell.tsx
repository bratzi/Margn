import Link from "next/link";

// Eigenständiges Gerüst für Rechtsseiten (kein Dashboard-Chrome): Mini-Nav + Inhalt + Fuß.
export default function LegalShell({ active, children }: { active: "impressum" | "datenschutz"; children: React.ReactNode }) {
  return (
    <div className="legal">
      <nav className="legal-nav">
        <Link href="/" className="legal-brand" aria-label="margn — Startseite">
          <span className="m">m</span>
          <b>margn</b>
        </Link>
        <Link href="/impressum" className={`legal-link ${active === "impressum" ? "on" : ""}`}>Impressum</Link>
        <Link href="/datenschutz" className={`legal-link ${active === "datenschutz" ? "on" : ""}`}>Datenschutz</Link>
      </nav>
      <main className="legal-main">
        {children}
        <div className="legal-foot">
          <Link href="/">← Zur Startseite</Link>
          <Link href="/impressum">Impressum</Link>
          <Link href="/datenschutz">Datenschutz</Link>
        </div>
      </main>
    </div>
  );
}
