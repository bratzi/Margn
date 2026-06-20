import "../legal.css";
import LegalShell from "@/components/LegalShell";

export const metadata = {
  title: "Impressum — margn",
  robots: { index: true, follow: true },
};

// Impressum nach § 5 TMG / § 18 Abs. 2 MStV.
// ⚠️ Die mit [eckigen Klammern] markierten Felder MÜSSEN mit echten Daten gefüllt werden,
// sonst ist das Impressum nicht rechtswirksam (siehe Hinweis-Box).
export default function Impressum() {
  return (
    <LegalShell active="impressum">
      <h1>Impressum</h1>
      <p className="legal-updated">Angaben gemäß § 5 TMG und § 18 Abs. 2 MStV</p>

      <div className="legal-note">
        <b>Vor Veröffentlichung ausfüllen:</b> Es fehlt noch die <b>ladungsfähige Anschrift</b>
        (Straße/Hausnr., PLZ, Ort) — ohne sie ist das Impressum nicht vollständig. Telefon ist optional,
        aber empfohlen. Name und E-Mail sind eingetragen; bitte prüfen.
      </div>

      <h2>Diensteanbieter</h2>
      <address className="legal-addr">
        Waldemar Helwich<br />
        [Straße und Hausnummer]<br />
        [PLZ und Ort]<br />
        Deutschland
      </address>

      <h2>Kontakt</h2>
      <p>
        E-Mail: <a href="mailto:w.helwich@googlemail.com">w.helwich@googlemail.com</a><br />
        Telefon: [optional — eine schnelle elektronische Kontaktmöglichkeit (E-Mail) ist gegeben]
      </p>

      <h2>Verantwortlich für den Inhalt</h2>
      <p>Verantwortlich im Sinne des § 18 Abs. 2 MStV:</p>
      <address className="legal-addr">
        Waldemar Helwich<br />
        [Anschrift wie oben]
      </address>

      <h2>Haftung für Inhalte</h2>
      <p>
        Die Inhalte dieser Seiten wurden mit größtmöglicher Sorgfalt erstellt. Für die Richtigkeit,
        Vollständigkeit und Aktualität der Inhalte kann jedoch keine Gewähr übernommen werden. Als
        Diensteanbieter sind wir gemäß § 7 Abs. 1 TMG für eigene Inhalte auf diesen Seiten nach den
        allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 TMG sind wir als Diensteanbieter jedoch
        nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen oder nach
        Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.
      </p>
      <p>
        margn erfasst und verarbeitet öffentlich zugängliche Veröffentlichungen Dritter und stellt
        ausschließlich Metadaten sowie eigene Auswertungen dar. Der vollständige Originaltext wird nicht
        gespiegelt, sondern zur jeweiligen Quelle verlinkt. Marken- und Namensrechte der genannten
        Medien liegen bei den jeweiligen Inhabern.
      </p>

      <h2>Haftung für Links</h2>
      <p>
        Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss
        haben. Deshalb können wir für diese fremden Inhalte auch keine Gewähr übernehmen. Für die Inhalte
        der verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber der Seiten verantwortlich.
        Bei Bekanntwerden von Rechtsverletzungen werden wir derartige Links umgehend entfernen.
      </p>

      <h2>Urheberrecht</h2>
      <p>
        Die durch den Betreiber erstellten Inhalte und Werke (Quellcode, Auswertungen, Darstellungen)
        unterliegen dem deutschen Urheberrecht. Beiträge Dritter sind als solche gekennzeichnet bzw.
        verlinken auf die Originalquelle.
      </p>

      <h2>Streitschlichtung</h2>
      <p>
        Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:{" "}
        <a href="https://ec.europa.eu/consumers/odr/" target="_blank" rel="noopener noreferrer">
          https://ec.europa.eu/consumers/odr/
        </a>
        . Wir sind nicht verpflichtet und nicht bereit, an Streitbeilegungsverfahren vor einer
        Verbraucherschlichtungsstelle teilzunehmen.
      </p>
    </LegalShell>
  );
}
