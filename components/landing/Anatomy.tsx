"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

// „Anatomie einer stillen Änderung" — gepinnte Scroll-Strecke (Desktop):
// eine nachgestellte Meldung durchläuft vier Versionen, Wort-Diffs werden
// sichtbar, die Zeitleiste links läuft mit. Auf Mobile entfällt das Pinning,
// die Versionen stehen als Feed untereinander (gleiches DOM, nur CSS/GSAP).

type Version = {
  v: string;
  t: string;
  chips: Array<{ cls: string; label: string }>;
  head: React.ReactNode;
  teaser: React.ReactNode;
  anno: React.ReactNode;
};

const VERSIONS: Version[] = [
  {
    v: "v1",
    t: "07:14",
    chips: [{ cls: "", label: "frei zugänglich" }],
    head: <>Konzern streicht 4.000 Stellen in Europa</>,
    teaser: (
      <>
        Der Vorstand bestätigte die Pläne am Morgen. Betriebsratschefin Weber:
        „Das ist ein schwarzer Tag für die Beschäftigten.“
      </>
    ),
    anno: (
      <span>
        <b>Erstmeldung, 07:14 Uhr.</b> Klares Verb, konkrete Zahl, ein
        kritisches Zitat.
      </span>
    ),
  },
  {
    v: "v2",
    t: "09:32",
    chips: [
      { cls: "diff-add", label: "+2" },
      { cls: "diff-del", label: "−1" },
    ],
    head: (
      <>
        Konzern <del>streicht</del> <ins>baut</ins> 4.000 Stellen in Europa{" "}
        <ins>ab</ins>
      </>
    ),
    teaser: (
      <>
        Der Vorstand bestätigte die Pläne am Morgen. Betriebsratschefin Weber:
        „Das ist ein schwarzer Tag für die Beschäftigten.“
      </>
    ),
    anno: (
      <span>
        Zwei Stunden später: aus <b>„streicht“</b> wird <b>„baut ab“</b>.
        Gleiche Nachricht, weicheres Verb. Die URL bleibt dieselbe.
      </span>
    ),
  },
  {
    v: "v3",
    t: "11:05",
    chips: [
      { cls: "diff-add", label: "+1" },
      { cls: "diff-del", label: "−1" },
    ],
    head: (
      <>
        Konzern baut <del>4.000</del> <ins>3.200</ins> Stellen in Europa ab
      </>
    ),
    teaser: (
      <>
        Der Vorstand bestätigte die Pläne am Morgen. Betriebsratschefin Weber:
        „Das ist ein schwarzer Tag für die Beschäftigten.“
      </>
    ),
    anno: (
      <span>
        Die Zahl schrumpft still um 800. <b>Kein Korrekturhinweis, keine
        Fußnote.</b>
      </span>
    ),
  },
  {
    v: "v4",
    t: "14:48",
    chips: [
      { cls: "pay", label: "paywall" },
      { cls: "diff-del", label: "−14" },
    ],
    head: <>Konzern baut 3.200 Stellen in Europa ab</>,
    teaser: (
      <>
        Der Vorstand bestätigte die Pläne am Morgen.{" "}
        <del>
          Betriebsratschefin Weber: „Das ist ein schwarzer Tag für die
          Beschäftigten.“
        </del>
      </>
    ),
    anno: (
      <span>
        Am Nachmittag ist das Zitat verschwunden — und der Artikel steht{" "}
        <b>hinter der Paywall</b>.
      </span>
    ),
  },
];

export default function Anatomy() {
  const rootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const mm = gsap.matchMedia();

    mm.add("(min-width: 861px)", () => {
      const cards = gsap.utils.toArray<HTMLElement>(".mg-vcard", root);
      const railSteps = gsap.utils.toArray<HTMLElement>(".mg-rail-step", root);
      const prog = root.querySelector<HTMLElement>(".mg-rail .prog");
      const end = root.querySelector<HTMLElement>(".mg-anatomy-end");
      const pinEl = root.querySelector<HTMLElement>(".mg-anatomy-pin");
      if (!pinEl || cards.length < 4) return;

      gsap.set(cards.slice(1), { autoAlpha: 0, y: 70, rotate: 1.4, scale: 0.975 });
      if (end) gsap.set(end, { autoAlpha: 0, y: 16 });
      railSteps[0]?.classList.add("on");

      if (reduced) {
        // Ohne Motion: letzte Version + Schlusszeile zeigen, kein Pin
        gsap.set(cards[0], { autoAlpha: 0 });
        gsap.set(cards[3], { autoAlpha: 1, y: 0, rotate: 0, scale: 1 });
        if (end) gsap.set(end, { autoAlpha: 1, y: 0 });
        railSteps.forEach((s) => s.classList.add("on"));
        if (prog) gsap.set(prog, { scaleY: 1 });
        return;
      }

      const tl = gsap.timeline({
        defaults: { ease: "power2.inOut" },
        scrollTrigger: {
          trigger: pinEl,
          start: "top top",
          end: "+=320%",
          pin: true,
          scrub: 0.65,
          anticipatePin: 1,
          snap: { snapTo: "labels", duration: { min: 0.15, max: 0.5 }, ease: "power1.inOut" },
          onUpdate(self) {
            const idx = Math.min(3, Math.floor(self.progress * 3.999));
            railSteps.forEach((s, i) => s.classList.toggle("on", i <= idx));
          },
        },
      });

      tl.addLabel("s0", 0).to({}, { duration: 0.5 });
      for (let i = 0; i < 3; i++) {
        tl.to(cards[i], { autoAlpha: 0, y: -60, rotate: -1.4, scale: 0.975, duration: 0.45 })
          .to(prog, { scaleY: (i + 1) / 3, duration: 0.5, ease: "none" }, "<")
          .to(cards[i + 1], { autoAlpha: 1, y: 0, rotate: 0, scale: 1, duration: 0.5 }, "<0.12")
          .addLabel(`s${i + 1}`)
          .to({}, { duration: 0.5 });
      }
      if (end) tl.to(end, { autoAlpha: 1, y: 0, duration: 0.4 }, "-=0.35");

      return () => {
        railSteps.forEach((s) => s.classList.remove("on"));
      };
    });

    mm.add("(max-width: 860px)", () => {
      const cards = gsap.utils.toArray<HTMLElement>(".mg-vcard", root);
      gsap.set(cards, { clearProps: "all" });
      if (reduced) return;
      cards.forEach((card) => {
        gsap.from(card, {
          y: 50,
          autoAlpha: 0,
          duration: 0.8,
          ease: "power3.out",
          scrollTrigger: { trigger: card, start: "top 86%" },
        });
      });
    });

    return () => mm.revert();
  }, []);

  return (
    <section className="mg-anatomy" id="anatomie" ref={rootRef}>
      <div className="mg-anatomy-pin">
        <div className="mg-anatomy-stage">
          <div className="mg-head">
            <p className="mg-overline">Fallbeispiel · nachgestellt</p>
            <h2 className="mg-h2">
              Anatomie einer <em>stillen</em> Änderung
            </h2>
            <p className="mg-lede">
              Eine Meldung, ein Tag, vier Versionen. So sieht es aus, wenn ein
              Artikel sich verändert, ohne dass es jemand erfährt.
            </p>
          </div>

          <div className="mg-rail" aria-hidden>
            <span className="prog" />
            {VERSIONS.map((ver) => (
              <span key={ver.v} className="mg-rail-step">
                <span>
                  {ver.t}
                  <small>{ver.v}</small>
                </span>
              </span>
            ))}
          </div>

          <div className="mg-vstack">
            {VERSIONS.map((ver) => (
              <article key={ver.v} className="mg-vcard">
                <div className="kick">
                  <span>Wirtschaft · Agenturmeldung</span>
                  <span className="chips">
                    <span className="mg-chip v">
                      {ver.v} · {ver.t}
                    </span>
                    {ver.chips.map((c) => (
                      <span key={c.label} className={`mg-chip ${c.cls}`}>
                        {c.label}
                      </span>
                    ))}
                  </span>
                </div>
                <h3>{ver.head}</h3>
                <p className="teaser">{ver.teaser}</p>
                <p className="anno">{ver.anno}</p>
              </article>
            ))}
          </div>

          <p className="mg-anatomy-end">
            Kein Hinweis. Keine Fußnote. —{" "}
            <b>margn hält jede Version fest.</b>
          </p>
        </div>
      </div>
    </section>
  );
}
