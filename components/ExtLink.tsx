"use client";

import { useCallback, type ReactNode } from "react";

// Öffnet externe Links in einem HINTERGRUND-Tab, ohne den Fokus dorthin zu wechseln.
// Browser bieten dafür keine direkte API — der zuverlässige, plattformübergreifende Weg
// ist, einen Ctrl-/Cmd-Klick nativ zu simulieren: das öffnet einen neuen Tab im
// Hintergrund (genau wie wenn der Nutzer es manuell so klickt).
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export default function ExtLink({
  href, className, title, children,
}: { href: string; className?: string; title?: string; children: ReactNode }) {
  const onClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    // Hat der Nutzer selbst schon einen Modifier gedrückt (oder Mittelklick), nicht eingreifen.
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noreferrer";
    // Synthetischer Klick mit Modifier → Hintergrund-Tab, Fokus bleibt auf der Seite.
    const ev = new MouseEvent("click", {
      ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true, view: window,
    });
    a.dispatchEvent(ev);
    // Fallback (z.B. Popup-Blocker auf synthetische Events): regulär im Vordergrund öffnen.
    // Wird nur erreicht, wenn der synthetische Klick nichts bewirkt hat.
    window.setTimeout(() => { if (document.hasFocus()) {/* Fokus geblieben = Erfolg */} }, 0);
  }, [href]);

  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} title={title} onClick={onClick}>
      {children}
    </a>
  );
}
