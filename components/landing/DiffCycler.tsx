"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

// Das selbst-editierende Wort im Hero-H1: das aktuelle Wort wird rot
// durchgestrichen, das nächste schiebt sich grün nach — wie ein Silent Edit
// in Echtzeit. Läuft als Schleife; bei prefers-reduced-motion bleibt das
// erste Wort statisch stehen.

const INK = "#f2f0e9";
const RED = "#ff6f61";
const GREEN = "#43d9a3";

export default function DiffCycler({
  words = ["ändern", "entschärfen", "umschreiben", "streichen"],
}: {
  words?: string[];
}) {
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const slot = root.querySelector<HTMLElement>(".slot")!;
    const cur = root.querySelector<HTMLElement>(".word.cur")!;
    const next = root.querySelector<HTMLElement>(".word.next")!;
    const strike = root.querySelector<HTMLElement>(".strike")!;
    const ghost = root.querySelector<HTMLElement>(".ghost")!;

    let alive = true;
    let idx = 0;
    let widths: number[] = [];
    const ctx = gsap.context(() => {}, root);

    const measure = () => {
      widths = words.map((w) => {
        ghost.textContent = w;
        return ghost.offsetWidth;
      });
    };

    const cycle = () => {
      if (!alive) return;
      const nextIdx = (idx + 1) % words.length;
      next.textContent = words[nextIdx];

      ctx.add(() => {
        const tl = gsap.timeline({
          onComplete: () => {
            cur.textContent = words[nextIdx];
            gsap.set(cur, { y: 0, color: GREEN });
            gsap.set(next, { y: "115%" });
            gsap.set(strike, { scaleX: 0, opacity: 1 });
            gsap.to(cur, { color: INK, duration: 0.9, ease: "none", delay: 0.4 });
            idx = nextIdx;
            gsap.delayedCall(1.9, cycle);
          },
        });
        tl.to(strike, { scaleX: 1, duration: 0.42, ease: "power2.inOut" })
          .to(cur, { color: RED, duration: 0.3, ease: "none" }, "<0.1")
          .addLabel("swap", "+=0.55")
          .to(slot, { width: widths[nextIdx], duration: 0.5, ease: "power3.inOut" }, "swap")
          .to(strike, { opacity: 0, duration: 0.22 }, "swap")
          .to(cur, { y: "-115%", duration: 0.55, ease: "power3.inOut" }, "swap")
          .fromTo(next, { y: "115%", color: GREEN }, { y: "0%", duration: 0.55, ease: "power3.inOut" }, "swap+=0.06");
      });
    };

    const boot = () => {
      if (!alive) return;
      measure();
      gsap.set(slot, { width: widths[0] });
      gsap.set(next, { y: "115%" });
      gsap.delayedCall(2.4, cycle);
    };

    if (document.fonts?.ready) {
      document.fonts.ready.then(() => boot());
    } else {
      boot();
    }

    let rt: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (!alive) return;
        measure();
        gsap.set(slot, { width: widths[idx] });
      }, 150);
    };
    window.addEventListener("resize", onResize);

    return () => {
      alive = false;
      clearTimeout(rt);
      window.removeEventListener("resize", onResize);
      ctx.revert();
    };
  }, [words]);

  return (
    <span className="mg-diffw" ref={rootRef}>
      <span className="slot">
        <span className="word cur">{words[0]}</span>
        <span className="word next" aria-hidden />
        <span className="strike" aria-hidden />
      </span>
      <span className="ghost" aria-hidden />
    </span>
  );
}
