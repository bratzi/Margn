"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

// „Anatomie einer stillen Änderung" — gepinnte Scroll-Strecke (Desktop):
// EIN Artikel, eine riesige Schlagzeile. Beim Scrollen passiert der Edit live —
// „streicht" wird durchgestrichen und „baut … ab" schiebt sich rein, „4.000" kippt
// auf „3.200", das kritische Zitat wird zugeschwärzt, am Ende sinkt die Paywall herab.
// Keine Hintergrund-Deko: die Verwandlung des Inhalts IST die Sektion. Auf Mobile
// kein Pin — der End-Diff steht fest, der Verlauf als Liste darunter (gleiches DOM).

type Step = {
  v: string;
  t: string;
  status: { cls: string; label: string };
  anno: React.ReactNode;
};

const STEPS: Step[] = [
  {
    v: "v1",
    t: "07:14",
    status: { cls: "ok", label: "frei lesbar" },
    anno: (
      <>
        <b>Erstmeldung, 07:14 Uhr.</b> Klares Verb, konkrete Zahl, ein kritisches
        Zitat. So ging die Geschichte online.
      </>
    ),
  },
  {
    v: "v2",
    t: "09:32",
    status: { cls: "edit", label: "Titel editiert" },
    anno: (
      <>
        Zwei Stunden später: aus <b>„streicht“</b> wird <b>„baut ab“</b>. Gleiche
        Nachricht, weicheres Verb — die URL bleibt dieselbe.
      </>
    ),
  },
  {
    v: "v3",
    t: "11:05",
    status: { cls: "edit", label: "Zahl editiert" },
    anno: (
      <>
        Die Zahl schrumpft still um <b>800 Stellen</b>. Kein Korrekturhinweis,
        keine Fußnote.
      </>
    ),
  },
  {
    v: "v4",
    t: "14:48",
    status: { cls: "pay", label: "Paywall" },
    anno: (
      <>
        Am Nachmittag ist das kritische Zitat <b>geschwärzt</b> — und der Artikel
        verschwindet <b>hinter der Paywall</b>.
      </>
    ),
  },
];

export default function Anatomy() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const doc = root.querySelector<HTMLElement>(".mg-doc");
    const verEl = root.querySelector<HTMLElement>(".mg-doc-ver");
    const timeEl = root.querySelector<HTMLElement>(".mg-doc-time");
    const chipEl = root.querySelector<HTMLElement>(".mg-doc-status");
    const annos = gsap.utils.toArray<HTMLElement>(".mg-doc-anno", root);
    const railSteps = gsap.utils.toArray<HTMLElement>(".mg-rail-step", root);
    const prog = root.querySelector<HTMLElement>(".mg-rail .prog");
    if (!doc) return;

    // EIN scroll-gescrubbtes Hintergrund-Video (Scrollytelling-Look): die Footage wird
    // NICHT abgespielt, sondern ihre currentTime hängt direkt am Scroll-Fortschritt — beim
    // Scrollen morpht die dunkelblaue Tinte mit. Quelle erst hier setzen → kein Mobile-DL.
    // Voraussetzung für flüssiges Seeken: all-intra-Encode (jedes Frame ein Keyframe).
    const scrub = root.querySelector<HTMLVideoElement>(".mg-ana-scrub");
    const SCRUB_SRC = "/landing/ana/scrub.mp4";
    let vidDur = 0;
    let lastSeek = -1;
    const primeVideo = () => {
      if (!scrub) return;
      if (!scrub.getAttribute("src")) scrub.setAttribute("src", SCRUB_SRC);
      scrub.muted = true;
      scrub.addEventListener("loadedmetadata", () => { vidDur = scrub.duration || 0; });
      // Decoder einmal anwerfen, dann sofort pausieren → currentTime-Seeks werden flüssig.
      scrub.play?.().then(() => scrub.pause?.()).catch(() => {});
    };
    const seekTo = (p: number) => {
      if (!scrub || !vidDur) return;
      const t = Math.max(0, Math.min(vidDur - 0.05, p * (vidDur - 0.05)));
      if (Math.abs(t - lastSeek) < 0.02) return; // redundante Seeks vermeiden
      lastSeek = t;
      try { scrub.currentTime = t; } catch {}
    };
    const stopVideo = () => scrub?.pause?.();

    let lastIdx = -1;

    // teure DOM-Arbeit (Klassen/Text) NUR bei Schrittwechsel; pro Frame nur die billigen
    // CSS-Variablen (opacity/transform = Compositor) + Video play/pause.
    const applyStep = (idx: number, p: number) => {
      if (idx !== lastIdx) {
        doc.classList.toggle("ed-verb", idx >= 1);
        doc.classList.toggle("ed-num", idx >= 2);
        doc.classList.toggle("ed-quote", idx >= 3);
        const s = STEPS[idx];
        if (verEl) verEl.textContent = s.v;
        if (timeEl) timeEl.textContent = s.t;
        if (chipEl) {
          chipEl.textContent = s.status.label;
          chipEl.className = `mg-doc-status ${s.status.cls}`;
        }
        annos.forEach((a, i) => a.classList.toggle("on", i === idx));
        railSteps.forEach((r, i) => r.classList.toggle("on", i <= idx));
        lastIdx = idx;
      }
      // Nur die billige Fortschritts-Variable (Compositor): treibt die kühl→rot-Tönung
      // (Warm-Layer-Opacity) + die dezente Parallaxe/Zoom des Scrub-Videos.
      root.style.setProperty("--ana-p", p.toFixed(3));
    };

    const mm = gsap.matchMedia();

    mm.add("(min-width: 861px)", () => {
      const pinEl = root.querySelector<HTMLElement>(".mg-anatomy-pin");
      if (!pinEl) return;
      doc.classList.remove("is-static");

      primeVideo();

      if (reduced) {
        // Kein Scrubbing: ein repräsentatives Standbild zeigen, Endzustand des Edits.
        scrub?.addEventListener("loadedmetadata", () => { vidDur = scrub?.duration || 0; seekTo(0.6); }, { once: true });
        applyStep(3, 1);
        if (prog) gsap.set(prog, { scaleY: 1 });
        return;
      }

      applyStep(0, 0);
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: pinEl,
          start: "top top",
          end: "+=340%",
          pin: true,
          scrub: 0.6,
          anticipatePin: 1,
          snap: { snapTo: "labels", duration: { min: 0.2, max: 0.6 }, ease: "power1.inOut" },
          onUpdate(self) {
            // Video-Scrub direkt am Scroll-Fortschritt (das IST der Scrollytelling-Effekt).
            seekTo(self.progress);
            const idx = Math.max(0, Math.min(3, Math.round(self.progress * 3)));
            applyStep(idx, self.progress);
          },
        },
      });
      // vier gleich lange Halte-Phasen → vier Snap-Labels
      tl.addLabel("s0", 0).to({}, { duration: 1 })
        .addLabel("s1").to({}, { duration: 1 })
        .addLabel("s2").to({}, { duration: 1 })
        .addLabel("s3").to({}, { duration: 1 })
        .addLabel("end");
      if (prog) tl.fromTo(prog, { scaleY: 0 }, { scaleY: 1, ease: "none", duration: 3 }, 0);

      return () => {
        stopVideo();
        doc.classList.remove("ed-verb", "ed-num", "ed-quote");
        railSteps.forEach((r) => r.classList.remove("on"));
      };
    });

    mm.add("(max-width: 860px)", () => {
      // kein Pin: End-Diff fest zeigen, Verlauf als Liste; reveal beim Reinscrollen
      doc.classList.add("is-static", "ed-verb", "ed-num", "ed-quote");
      annos.forEach((a) => a.classList.add("on"));
      railSteps.forEach((r) => r.classList.add("on"));
      if (prog) gsap.set(prog, { scaleY: 1 });
      root.style.setProperty("--ana-p", "1");
      if (reduced) return;
      gsap.from(doc, {
        y: 48, autoAlpha: 0, duration: 0.85, ease: "power3.out",
        scrollTrigger: { trigger: doc, start: "top 86%" },
      });
      return () => doc.classList.remove("is-static", "ed-verb", "ed-num", "ed-quote");
    });

    return () => mm.revert();
  }, []);

  return (
    <section className="mg-anatomy" id="anatomie" ref={rootRef}>
      <div className="mg-anatomy-pin">
        <div className="mg-ana-bg" aria-hidden>
          {/* EIN scroll-gescrubbtes Video (dunkelblaue, langsam morphende Tinte): seine
              currentTime hängt am Scroll-Fortschritt — die Footage „läuft" nicht, sie wird
              gescrubbt. Quelle wird erst auf dem Desktop per JS gesetzt → kein Mobile-DL.
              Über dem Video nur statische Tönung/Vignette (Compositor), nie pro Frame
              gerastert. */}
          <video className="mg-ana-scrub" muted playsInline preload="auto" />
          <span className="mg-ana-tint" />
          <span className="mg-ana-warm" />
          <span className="mg-ana-vignette" />
        </div>

        <div className="mg-anatomy-stage">
          <div className="mg-head">
            <p className="mg-overline">Fallbeispiel · nachgestellt</p>
            <h2 className="mg-h2">
              Anatomie einer <em>stillen</em> Änderung
            </h2>
            <p className="mg-lede">
              Eine Meldung, ein Tag, vier stille Eingriffe. Scrolle — und sieh zu,
              wie sich der Artikel verändert, ohne dass es jemand erfährt.
            </p>
          </div>

          <div className="mg-rail" aria-hidden>
            <span className="prog" />
            {STEPS.map((s) => (
              <span key={s.v} className="mg-rail-step">
                <span>
                  {s.t}
                  <small>{s.v}</small>
                </span>
              </span>
            ))}
          </div>

          {/* DAS Dokument — verwandelt sich live beim Scrollen */}
          <article className="mg-doc">
            <div className="mg-doc-kick">
              <span className="mg-doc-cat">Wirtschaft · Agenturmeldung</span>
              <span className="mg-doc-meta">
                <span className="mg-doc-ver">v1</span>
                <span className="mg-doc-time">07:14</span>
                <span className="mg-doc-status ok">frei lesbar</span>
              </span>
            </div>

            <h3 className="mg-doc-head">
              Konzern{" "}
              <span className="ana-w verb">
                <span className="old">streicht</span>
                <span className="new">baut</span>
              </span>{" "}
              <span className="ana-w num">
                <span className="old">4.000</span>
                <span className="new">3.200</span>
              </span>{" "}
              Stellen in Europa{" "}
              <span className="ana-add">ab</span>
            </h3>

            <p className="mg-doc-teaser">
              Der Vorstand bestätigte die Pläne am Morgen.
            </p>
            <p className="mg-doc-quote">
              <span className="ana-redact">
                Betriebsratschefin Weber: „Das ist ein schwarzer Tag für die
                Beschäftigten.“
              </span>
            </p>

            {/* Paywall-Schleier senkt sich am Ende herab */}
            <div className="ana-paywall" aria-hidden>
              <span className="lock" aria-hidden>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none">
                  <rect x="4.5" y="10.5" width="15" height="10" rx="2" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              Weiterlesen nur mit Abo
            </div>

            <div className="mg-doc-annos">
              {STEPS.map((s, i) => (
                <p className={`mg-doc-anno${i === 0 ? " on" : ""}`} key={s.v}>
                  <span className="mg-doc-anno-tag">{s.v}</span>
                  <span>{s.anno}</span>
                </p>
              ))}
            </div>
          </article>

          <p className="mg-anatomy-end">
            Kein Hinweis. Keine Fußnote. —{" "}
            <b>margn hält jede Version fest.</b>
          </p>
        </div>
      </div>
    </section>
  );
}
