import "../legal.css";
import LegalShell from "@/components/LegalShell";

export const metadata = {
  title: "Datenschutzerklärung — margn",
  robots: { index: true, follow: true },
};

// Datenschutzerklärung nach DSGVO/BDSG, zugeschnitten auf den realen Stack:
// Hosting Vercel (USA), Backend/DB Supabase, technisch notwendige Login-Sitzung, localStorage,
// kein Tracking/Analytics. ⚠️ [Verantwortlicher] mit echten Daten füllen (siehe Hinweis).
export default function Datenschutz() {
  return (
    <LegalShell active="datenschutz">
      <h1>Datenschutzerklärung</h1>
      <p className="legal-updated">Stand: Juni 2026</p>

      <div className="legal-note">
        <b>Vor Veröffentlichung ausfüllen:</b> Es fehlt noch die <b>Anschrift</b> des Verantwortlichen
        (identisch zum Impressum). Name und E-Mail sind eingetragen.
      </div>

      <h2>1. Verantwortlicher</h2>
      <p>Verantwortlicher im Sinne der Datenschutz-Grundverordnung (DSGVO) ist:</p>
      <address className="legal-addr">
        Waldemar Helwich<br />
        [Straße und Hausnummer]<br />
        [PLZ und Ort]<br />
        E-Mail: <a href="mailto:w.helwich@googlemail.com">w.helwich@googlemail.com</a>
      </address>

      <h2>2. Überblick &amp; Grundsätze</h2>
      <p>
        margn ist ein nichtkommerzielles Medienobservatorium. Wir erheben so wenig personenbezogene
        Daten wie möglich. Es findet <strong>kein Tracking, keine Werbung und keine Weitergabe von
        Daten zu Marketingzwecken</strong> statt. Es werden keine Analyse-Dienste (z. B. Google
        Analytics), keine Social-Media-Plugins und keine Werbenetzwerke eingebunden.
      </p>

      <h2>3. Hosting (Vercel)</h2>
      <p>
        Diese Website wird bei der <strong>Vercel Inc.</strong>, 340 S Lemon Ave #4133, Walnut, CA
        91789, USA, gehostet. Beim Aufruf der Seiten verarbeitet Vercel als Auftragsverarbeiter
        technisch notwendige Verbindungsdaten (insbesondere IP-Adresse, Datum und Uhrzeit des Zugriffs,
        angeforderte URL, Referrer, Browser-/Geräteinformationen) in Server-Logfiles, um die Auslieferung
        und Sicherheit der Website zu gewährleisten.
      </p>
      <p>
        Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse am sicheren und stabilen
        Betrieb der Website). Da Vercel ein US-Anbieter ist, kann es zu einer Übermittlung von Daten in
        die USA kommen. Diese erfolgt auf Grundlage der EU-Standardvertragsklauseln (Art. 46 DSGVO) bzw.
        — soweit zertifiziert — des EU-US Data Privacy Framework. Details:{" "}
        <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">
          vercel.com/legal/privacy-policy
        </a>
        .
      </p>

      <h2>4. Datenbank &amp; Backend (Supabase)</h2>
      <p>
        Für Datenhaltung und Authentifizierung nutzen wir <strong>Supabase</strong> (Supabase, Inc.).
        In der Datenbank werden die vom System erfassten Artikel-Metadaten und Auswertungen gespeichert;
        diese enthalten regelmäßig keine personenbezogenen Daten der Websitebesucher. Lesende Zugriffe
        des Frontends erfolgen über einen öffentlichen, durch Zugriffsregeln (Row Level Security)
        beschränkten Schlüssel. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Mit dem Anbieter besteht
        bzw. wird ein Auftragsverarbeitungsvertrag (Art. 28 DSGVO) geschlossen.
      </p>

      <h2>5. Server-Logfiles</h2>
      <p>
        Bei jedem Zugriff werden automatisch Informationen erhoben, die Ihr Browser übermittelt
        (siehe Abschnitt 3). Diese Daten sind technisch erforderlich, werden nicht mit anderen
        Datenquellen zusammengeführt und dienen ausschließlich dem Betrieb, der Stabilität und der
        Sicherheit. Sie werden nach kurzer Zeit gelöscht bzw. anonymisiert, soweit sie nicht zur
        Aufklärung von Missbrauch oder Störungen benötigt werden.
      </p>

      <h2>6. Cookies &amp; lokale Speicherung</h2>
      <p>margn verwendet ausschließlich technisch notwendige Mittel:</p>
      <ul>
        <li>
          <strong>Login-Sitzung (Cookie <code>mg_session</code>):</strong> Nur für angemeldete Nutzer
          des geschützten Dashboards. Es handelt sich um ein signiertes, HttpOnly-Sitzungscookie, das
          allein die Anmeldung absichert. Rechtsgrundlage: § 25 Abs. 2 Nr. 2 TTDSG (unbedingt
          erforderlich) i. V. m. Art. 6 Abs. 1 lit. f DSGVO. Es enthält keine personenbezogenen Profile.
        </li>
        <li>
          <strong>Lokale Einstellungen (localStorage):</strong> Im Browser werden Komfort-Einstellungen
          gespeichert, etwa das Farbschema (hell/dunkel), Layout-/Spalteneinstellungen und die
          Bestätigung dieses Cookie-Hinweises. Diese Daten verbleiben auf Ihrem Gerät und werden nicht an
          uns übertragen.
        </li>
      </ul>
      <p>
        Da keine Cookies oder Techniken zu Analyse-, Tracking- oder Marketingzwecken eingesetzt werden,
        ist hierfür keine Einwilligung erforderlich. Sie können Cookies in Ihren Browsereinstellungen
        jederzeit löschen oder blockieren.
      </p>

      <h2>7. Kontaktaufnahme</h2>
      <p>
        Wenn Sie uns per E-Mail kontaktieren, verarbeiten wir Ihre Angaben (E-Mail-Adresse, Inhalt) zur
        Bearbeitung Ihrer Anfrage. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO bzw. lit. b DSGVO,
        sofern es um vorvertragliche Maßnahmen geht. Die Daten werden gelöscht, sobald sie für den Zweck
        nicht mehr erforderlich sind und keine gesetzlichen Aufbewahrungspflichten entgegenstehen.
      </p>

      <h2>8. Ihre Rechte</h2>
      <p>Sie haben nach der DSGVO insbesondere folgende Rechte:</p>
      <ul>
        <li>Auskunft über die zu Ihrer Person verarbeiteten Daten (Art. 15 DSGVO),</li>
        <li>Berichtigung unrichtiger Daten (Art. 16 DSGVO),</li>
        <li>Löschung (Art. 17 DSGVO) und Einschränkung der Verarbeitung (Art. 18 DSGVO),</li>
        <li>Datenübertragbarkeit (Art. 20 DSGVO),</li>
        <li>
          Widerspruch gegen Verarbeitungen, die auf Art. 6 Abs. 1 lit. f DSGVO beruhen (Art. 21 DSGVO),
        </li>
        <li>Widerruf erteilter Einwilligungen mit Wirkung für die Zukunft (Art. 7 Abs. 3 DSGVO).</li>
      </ul>
      <p>
        Zudem haben Sie das Recht, sich bei einer Datenschutz-Aufsichtsbehörde zu beschweren (Art. 77
        DSGVO). Zuständig ist die Aufsichtsbehörde Ihres üblichen Aufenthaltsorts bzw. die des
        Verantwortlichen.
      </p>

      <h2>9. Datensicherheit</h2>
      <p>
        Die Website wird ausschließlich verschlüsselt über HTTPS (TLS) ausgeliefert. Der Zugang zum
        Dashboard ist durch ein Zugangswort geschützt; das Sitzungscookie wird signiert und
        HttpOnly/Secure gesetzt.
      </p>

      <h2>10. Änderungen</h2>
      <p>
        Wir passen diese Datenschutzerklärung an, sobald sich die Rechtslage oder die technische
        Verarbeitung ändert. Es gilt die jeweils auf dieser Seite veröffentlichte Fassung.
      </p>
    </LegalShell>
  );
}
