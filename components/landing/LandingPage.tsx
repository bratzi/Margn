"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { SplitText } from "gsap/SplitText";
import Lenis from "lenis";
import HeroCanvas from "@/components/landing/HeroCanvas";
import DiffCycler from "@/components/landing/DiffCycler";
import Anatomy from "@/components/landing/Anatomy";
import FeatureReveal from "@/components/landing/FeatureReveal";
import ScrollSpine from "@/components/landing/ScrollSpine";

gsap.registerPlugin(ScrollTrigger, SplitText);

/* Wort-Maske für den Hero-Einstieg */
function W({ children }: { children: React.ReactNode }) {
  return (
    <span className="w">
      <span className="wi">{children}</span>
    </span>
  );
}

const STEPS = [
  {
    n: "01",
    title: "Erfassen",
    text: "Leitmedien aus mehreren Ländern werden stündlich erfasst — vollautomatisch und zurückhaltend. Weitere Märkte kommen laufend hinzu.",
  },
  {
    n: "02",
    title: "Versionieren",
    text: "Jeder Artikel wird bei jedem Scan verglichen. Änderungen an Titel und Text werden als Revision festgehalten — mit Zeitstempel.",
  },
  {
    n: "03",
    title: "Auswerten",
    text: "Themen, Paywall, Autoren, Tiefe: alle Dimensionen werden publizistenübergreifend normalisiert und vergleichbar gemacht.",
  },
];

const TRUST = [
  {
    n: "§ 01",
    title: "Schonende Erfassung",
    text: "Die Quellen werden vollautomatisch und zurückhaltend im Hintergrund erfasst — ohne sie zu belasten.",
  },
  {
    n: "§ 02",
    title: "Offen einsehbar",
    text: "Das Dashboard ist ohne Anmeldung zugänglich. Jede Kennzahl lässt sich bis zum einzelnen Artikel und Scan zurückverfolgen.",
  },
  {
    n: "§ 03",
    title: "Nachvollziehbare Methodik",
    text: "Spezialisierungs-Indizes, Share of Voice und Themen-Vielfalt folgen etablierten Maßen der Agenda-Setting-Forschung.",
  },
];

export default function LandingPage() {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const cursorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finePointer = window.matchMedia("(pointer: fine)").matches;

    /* ---------- Smooth Scroll (Lenis) ---------- */
    let lenis: Lenis | null = null;
    let rafCb: ((t: number) => void) | null = null;
    if (!reduced) {
      lenis = new Lenis({ duration: 1.15 });
      lenis.on("scroll", ScrollTrigger.update);
      rafCb = (t: number) => lenis!.raf(t * 1000);
      gsap.ticker.add(rafCb);
      gsap.ticker.lagSmoothing(0);
    }

    /* ---------- Anker sanft anfahren ---------- */
    const onAnchorClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#"]');
      if (!a) return;
      const target = document.querySelector(a.getAttribute("href")!);
      if (!target) return;
      e.preventDefault();
      if (lenis) lenis.scrollTo(target as HTMLElement, { offset: -64, duration: 1.4 });
      else target.scrollIntoView();
    };
    root.addEventListener("click", onAnchorClick);

    /* ---------- Nav-Blur + Scroll-Fortschritt ---------- */
    const prog = root.querySelector<HTMLElement>(".mg-progress > i");
    // scrollHeight ist ein Layout-Read → NICHT pro Scroll-Event lesen, sondern cachen
    // (nur bei Resize/Font-Load neu berechnen). Scroll-Arbeit zusätzlich rAF-gedrosselt.
    const docEl = document.documentElement;
    let scrollMax = docEl.scrollHeight - docEl.clientHeight;
    const recalcMax = () => { scrollMax = docEl.scrollHeight - docEl.clientHeight; };
    let scrollRaf = 0;
    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        const nav = navRef.current;
        if (nav) nav.classList.toggle("is-scrolled", window.scrollY > 24);
        if (prog) prog.style.transform = `scaleX(${scrollMax > 0 ? Math.min(1, window.scrollY / scrollMax) : 0})`;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", recalcMax, { passive: true });
    document.fonts?.ready?.then(recalcMax).catch(() => {});
    onScroll();

    /* ---------- Raster-Glow unter dem Cursor ---------- */
    const glowEls = finePointer
      ? Array.from(root.querySelectorAll<HTMLElement>(".mg-section, .mg-stats, .mg-foot"))
      : [];
    let glowRaf = 0;
    // Rects cachen statt pro pointermove zu messen (getBoundingClientRect = Layout-Read).
    // Nur bei Scroll/Resize als „dirty" markieren und beim nächsten Move einmal neu lesen.
    let glowRects: DOMRect[] = [];
    let glowDirty = true;
    const markGlowDirty = () => { glowDirty = true; };
    const onGlow = (e: PointerEvent) => {
      if (glowRaf) return;
      glowRaf = requestAnimationFrame(() => {
        glowRaf = 0;
        if (glowDirty) { glowRects = glowEls.map((el) => el.getBoundingClientRect()); glowDirty = false; }
        for (let i = 0; i < glowEls.length; i++) {
          const el = glowEls[i], r = glowRects[i];
          const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (inside) {
            el.style.setProperty("--mx", `${e.clientX}px`);
            el.style.setProperty("--my", `${e.clientY - r.top}px`);
            el.style.setProperty("--spot", "1");
          } else if (el.style.getPropertyValue("--spot") === "1") {
            el.style.setProperty("--spot", "0");
          }
        }
      });
    };
    if (glowEls.length) {
      window.addEventListener("pointermove", onGlow, { passive: true });
      window.addEventListener("scroll", markGlowDirty, { passive: true });
      window.addEventListener("resize", markGlowDirty, { passive: true });
    }

    const ctx = gsap.context(() => {
      if (reduced) return;

      /* ---------- Hero-Intro ---------- */
      const intro = gsap.timeline({ defaults: { ease: "power4.out" } });
      intro
        .from(".mg-hero .mg-overline", { autoAlpha: 0, y: 18, duration: 0.9, delay: 0.15 })
        .from(".mg-h1 .wi", { yPercent: 115, duration: 1.15, stagger: 0.07 }, "-=0.55")
        .from(".mg-hero-sub", { autoAlpha: 0, y: 24, duration: 0.9 }, "-=0.6")
        .from(".mg-hero-cta > *", { autoAlpha: 0, y: 18, duration: 0.7, stagger: 0.09 }, "-=0.6")
        .from(".mg-hero-foot", { autoAlpha: 0, duration: 1 }, "-=0.4")
        .from(".mg-hero-canvas", { autoAlpha: 0, duration: 1.6, ease: "none" }, 0.1);

      /* ---------- Überschriften: Zeilen-Maskenreveal ---------- */
      const splitHeadings = () => {
        gsap.utils.toArray<HTMLElement>("[data-split]").forEach((el) => {
          try {
            const split = new SplitText(el, { type: "lines", mask: "lines", linesClass: "sl" });
            gsap.from(split.lines, {
              yPercent: 112,
              duration: 1.05,
              ease: "power4.out",
              stagger: 0.09,
              scrollTrigger: { trigger: el, start: "top 84%" },
            });
          } catch {
            gsap.from(el, {
              autoAlpha: 0,
              y: 28,
              duration: 0.9,
              scrollTrigger: { trigger: el, start: "top 84%" },
            });
          }
        });
        ScrollTrigger.refresh();
      };
      if (document.fonts?.ready) document.fonts.ready.then(() => ctx.add(splitHeadings));
      else splitHeadings();

      /* ---------- Generische Reveals ---------- */
      gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
        gsap.from(el, {
          autoAlpha: 0,
          y: 36,
          duration: 0.95,
          ease: "power3.out",
          delay: parseFloat(el.dataset.reveal || "0"),
          scrollTrigger: { trigger: el, start: "top 87%" },
        });
      });

      /* ---------- Methodik: Linie zeichnen ---------- */
      gsap.utils.toArray<HTMLElement>(".mg-steps .wire").forEach((wire) => {
        gsap.to(wire, {
          scaleX: 1,
          scaleY: 1,
          duration: 1.6,
          ease: "power2.inOut",
          scrollTrigger: { trigger: ".mg-steps", start: "top 70%" },
        });
      });

      /* ---------- Zähler ---------- */
      gsap.utils.toArray<HTMLElement>("[data-count]").forEach((el) => {
        const target = parseFloat(el.dataset.count || "0");
        const obj = { v: 0 };
        gsap.to(obj, {
          v: target,
          duration: 1.6,
          ease: "power3.out",
          scrollTrigger: { trigger: el, start: "top 88%" },
          onUpdate() {
            el.textContent = Math.round(obj.v).toLocaleString("de-DE");
          },
        });
      });

      /* ---------- Magnetische Buttons ---------- */
      if (finePointer) {
        gsap.utils.toArray<HTMLElement>(".mg-btn").forEach((btn) => {
          const xTo = gsap.quickTo(btn, "x", { duration: 0.4, ease: "power3" });
          const yTo = gsap.quickTo(btn, "y", { duration: 0.4, ease: "power3" });
          const move = (e: MouseEvent) => {
            const r = btn.getBoundingClientRect();
            xTo((e.clientX - (r.left + r.width / 2)) * 0.28);
            yTo((e.clientY - (r.top + r.height / 2)) * 0.34);
          };
          const leave = () => {
            xTo(0);
            yTo(0);
          };
          btn.addEventListener("mousemove", move);
          btn.addEventListener("mouseleave", leave);
        });
      }
    }, root);

    /* ---------- Eigener Cursor (nur feine Zeiger) ---------- */
    let removeCursor: (() => void) | null = null;
    const cursor = cursorRef.current;
    if (!reduced && finePointer && cursor) {
      gsap.set(cursor, { x: -100, y: -100, scale: 0.28, opacity: 0 });
      // Knapperes Folgen: 0.35s power3 wirkte träge/laggy. 0.12s = flüssig, aber noch
      // sanft. quickTo recycelt EINEN Tween (kein Tween-Neubau pro Event).
      const xTo = gsap.quickTo(cursor, "x", { duration: 0.12, ease: "power3" });
      const yTo = gsap.quickTo(cursor, "y", { duration: 0.12, ease: "power3" });
      let shown = false;
      const onMove = (e: PointerEvent) => {
        // Einblenden nur EINMAL — vorher lief pro pointermove ein neuer gsap.to-Tween
        // (Dutzende/s → GC-Druck → Ruckeln).
        if (!shown) { shown = true; gsap.to(cursor, { opacity: 1, duration: 0.3 }); }
        xTo(e.clientX);
        yTo(e.clientY);
      };
      let hot = false;
      const onOver = (e: PointerEvent) => {
        // pointerover feuert bei jedem Elementwechsel — nur tweenen, wenn sich der
        // Hot-Zustand WIRKLICH ändert, statt jedes Mal einen Tween zu erzeugen.
        const next = !!(e.target as HTMLElement).closest("a, button, .mg-btn");
        if (next === hot) return;
        hot = next;
        gsap.to(cursor, { scale: hot ? 1 : 0.28, duration: 0.3, ease: "power3.out" });
      };
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerover", onOver, { passive: true });
      removeCursor = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerover", onOver);
      };
    }

    return () => {
      ctx.revert();
      removeCursor?.();
      root.removeEventListener("click", onAnchorClick);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", recalcMax);
      window.removeEventListener("pointermove", onGlow);
      window.removeEventListener("scroll", markGlowDirty);
      window.removeEventListener("resize", markGlowDirty);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (glowRaf) cancelAnimationFrame(glowRaf);
      if (rafCb) gsap.ticker.remove(rafCb);
      lenis?.destroy();
    };
  }, []);

  return (
    <div className="mg" ref={rootRef}>
      <div className="mg-grain" aria-hidden />
      <div className="mg-progress" aria-hidden><i /></div>
      <div className="mg-cursor" ref={cursorRef} aria-hidden />
      <ScrollSpine />

      {/* ---------------- Nav ---------------- */}
      <header className="mg-nav" ref={navRef}>
        <div className="mg-nav-in">
          <Link href="/" className="mg-logo" aria-label="margn — Startseite">
            <b>margn</b>
            <i>Medienobservatorium</i>
          </Link>
          <nav className="mg-nav-links" aria-label="Sektionen">
            <a href="#anatomie">Anatomie</a>
            <a href="#funktionen">Funktionen</a>
            <a href="#methodik">Methodik</a>
            <a href="#abdeckung">Abdeckung</a>
            <a href="#transparenz">Transparenz</a>
          </nav>
          <Link href="/articles" className="mg-btn sm">
            <span>Dashboard</span>
            <span className="arr">→</span>
          </Link>
        </div>
      </header>

      {/* ---------------- Hero ---------------- */}
      <section className="mg-hero">
        <HeroCanvas />
        <p className="mg-overline">Offenes Medienobservatorium · mehrsprachig</p>
        <h1 className="mg-h1">
          <W>Was</W> <W>Nachrichtenseiten</W>{" "}
          <W>
            <DiffCycler words={["verändern", "entschärfen", "umschreiben", "streichen"]} />,
          </W>
          <br />
          <W>
            <em>nachdem</em>
          </W>{" "}
          <W>sie</W> <W>publiziert</W> <W>haben.</W>
        </h1>
        <p className="mg-hero-sub">
          margn beobachtet Leitmedien über Länder- und Sprachgrenzen hinweg,
          versioniert jeden Artikel stündlich und macht sichtbar, was zwischen
          den Zeilen passiert: <strong>stille Edits</strong>, Agenda-Profile,
          Paywall-Strategien.
        </p>
        <div className="mg-hero-cta">
          <Link href="/articles" className="mg-btn">
            <span>Dashboard öffnen</span>
            <span className="arr">→</span>
          </Link>
          <a href="#anatomie" className="mg-btn ghost">
            <span>Die Anatomie eines Edits</span>
            <span className="arr">↓</span>
          </a>
        </div>
        <div className="mg-hero-foot">
          <span className="mg-scrollhint">
            Scrollen <i />
          </span>
          <span className="mg-rev">rev 2026.06 · stündlich aktualisiert</span>
        </div>
      </section>

      {/* ---------------- Funktionen (interaktiv) ---------------- */}
      <FeatureReveal />

      {/* ---------------- Anatomie (Pin) ---------------- */}
      <Anatomy />

      {/* ---------------- Kennzahlen ---------------- */}
      <section className="mg-stats">
        <div className="mg-stats-in">
          <div className="mg-stat" data-reveal="0">
            <span className="v">
              <span data-count="60">0</span>
              <small>min</small>
            </span>
            <span className="l">Scan-Takt</span>
            <span className="s">jede Quelle, rund um die Uhr</span>
          </div>
          <div className="mg-stat" data-reveal="0.08">
            <span className="v">
              <span data-count="2">0</span>
            </span>
            <span className="l">Medienmärkte</span>
            <span className="s">Deutschland &amp; Frankreich</span>
          </div>
          <div className="mg-stat" data-reveal="0.16">
            <span className="v">
              <span data-count="1024">0</span>
            </span>
            <span className="l">Dimensionen je Embedding</span>
            <span className="s">sprachübergreifend vergleichbar</span>
          </div>
          <div className="mg-stat" data-reveal="0.24">
            <span className="v">24/7</span>
            <span className="l">Beobachtung</span>
            <span className="s">serverlos &amp; automatisiert</span>
          </div>
        </div>
      </section>

      {/* ---------------- Methodik ---------------- */}
      <section className="mg-method" id="methodik">
        <div className="mg-section">
          <div className="mg-head">
            <p className="mg-overline">Methodik</p>
            <h2 className="mg-h2" data-split>
              Drei Schritte, <em>stündlich</em> wiederholt
            </h2>
          </div>
          <div className="mg-steps">
            <span className="wire" aria-hidden />
            {STEPS.map((s) => (
              <div className="mg-step" key={s.n} data-reveal="0">
                <div className="dot">{s.n}</div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
          <p className="mg-method-note" data-reveal="0">
            <span className="pulse" />
            läuft automatisch · GitHub Actions · seit 2026
          </p>
        </div>
      </section>

      {/* ---------------- Abdeckung ---------------- */}
      <section className="mg-section" id="abdeckung">
        <div className="mg-head">
          <p className="mg-overline">Abdeckung</p>
          <h2 className="mg-h2" data-split>
            Viele Sprachen, <em>eine</em> Geschichte
          </h2>
          <p className="mg-lede" data-reveal="0">
            Mehrsprachige Embeddings legen dieselbe Story über Sprachgrenzen
            zusammen: Berichterstattung aus verschiedenen Ländern landet im
            selben Cluster — mit derselben Methodik vermessen. Weitere Märkte
            kommen laufend hinzu.
          </p>
        </div>
        <div className="mg-pair">
          <div className="mg-pair-card" data-reveal="0">
            <span className="lang">
              <b>DE</b>
              <span>06:12</span>
            </span>
            <h3>EU einigt sich auf strengere Regeln für Lieferketten</h3>
            <span className="src">deutsche Tageszeitung · Wirtschaft</span>
          </div>
          <div className="mg-pair-link" data-reveal="0.15" aria-hidden>
            <span className="line" />
            <span className="sim">Ähnlichkeit 0,91</span>
            <span className="cl">ein Story-Cluster</span>
            <span className="line" />
          </div>
          <div className="mg-pair-card" data-reveal="0.1">
            <span className="lang">
              <b>FR</b>
              <span>08:47</span>
            </span>
            <h3>
              L’UE s’accorde sur des règles plus strictes pour les chaînes
              d’approvisionnement
            </h3>
            <span className="src">quotidien français · Économie</span>
          </div>
        </div>
      </section>

      {/* ---------------- Transparenz ---------------- */}
      <section className="mg-section" id="transparenz">
        <div className="mg-head">
          <p className="mg-overline">Transparenz</p>
          <h2 className="mg-h2" data-split>
            Nichts versteckt — alles <em>nachvollziehbar.</em>
          </h2>
        </div>
        <div className="mg-trust" data-reveal="0">
          {TRUST.map((t) => (
            <div className="mg-trust-item" key={t.n}>
              <span className="t-n">{t.n}</span>
              <h3>{t.title}</h3>
              <p>{t.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------------- Finale ---------------- */}
      <section className="mg-final">
        <h2 className="mg-h2" data-split>
          Sehen, was <del>geschrieben</del> <ins>umgeschrieben</ins> wurde.
        </h2>
        <p className="mg-lede" data-reveal="0">
          Das Dashboard ist offen — keine Anmeldung, nachvollziehbare
          Auswertungen bis zum einzelnen Artikel.
        </p>
        <div className="mg-hero-cta" data-reveal="0.1">
          <Link href="/articles" className="mg-btn xl">
            <span>Dashboard öffnen</span>
            <span className="arr">→</span>
          </Link>
        </div>
        <p className="mg-final-rev" data-reveal="0.15">
          margn · offenes Medienobservatorium · rev 2026.06
        </p>
      </section>

      {/* ---------------- Footer ---------------- */}
      <footer className="mg-foot">
        <div className="mg-foot-in">
          <div>
            <span className="mg-logo">
              <b>margn</b>
              <i>Medienobservatorium</i>
            </span>
            <p className="mg-foot-claim">
              Liest, was zwischen den Zeilen steht: stille Änderungen,
              Agenda-Profile und Paywall-Strategien von Leitmedien über
              Länder- und Sprachgrenzen hinweg.
            </p>
          </div>
          <div>
            <h4>Erkunden</h4>
            <ul>
              <li>
                <Link href="/articles">Übersicht</Link>
              </li>
              <li>
                <Link href="/articles/edits">Silent Edits</Link>
              </li>
            </ul>
          </div>
          <div>
            <h4>Prinzipien</h4>
            <ul>
              <li>
                <a href="#methodik">Methodik</a>
              </li>
              <li>
                <a href="#transparenz">Transparenz</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="mg-foot-mark" aria-hidden>margn</div>
        <div className="mg-foot-base">
          <div>
            <span>© 2026 margn — offenes Medienobservatorium</span>
            <span>Offenes Dashboard · nachvollziehbare Methodik</span>
          </div>
          <div className="mg-foot-legal">
            <Link href="/impressum">Impressum</Link>
            <Link href="/datenschutz">Datenschutz</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
