"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Dezenter Cookie-Hinweis. margn setzt NUR technisch notwendige Cookies (Login-Sitzung) und
// lokale Einstellungen (Theme, Layout) — keine Tracking-/Marketing-Cookies. Nach TTDSG/DSGVO ist
// dafür keine Einwilligung nötig, nur Transparenz → ein informierender Hinweis (kein Consent-Wall),
// einmalig, per localStorage gemerkt.
export default function CookieNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem("mg-cookie-ack")) setShow(true);
    } catch {
      /* localStorage gesperrt → Hinweis einfach nicht zeigen */
    }
  }, []);

  if (!show) return null;

  const ack = () => {
    try { localStorage.setItem("mg-cookie-ack", "1"); } catch {}
    setShow(false);
  };

  return (
    <div className="cookie-note" role="region" aria-label="Cookie-Hinweis">
      <p className="cookie-note-txt">
        <strong>Nur das Nötigste.</strong> margn verwendet ausschließlich technisch notwendige
        Cookies (Login-Sitzung) und lokale Einstellungen wie das Theme. Kein Tracking, keine Werbung.
        Details in der <Link href="/datenschutz">Datenschutzerklärung</Link>.
      </p>
      <button type="button" className="cookie-note-ok" onClick={ack}>Verstanden</button>
    </div>
  );
}
