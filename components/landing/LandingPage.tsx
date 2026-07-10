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

const TRUST = [
  {
    n: "§ 01",
    title: "Schonende Erfassung",
    text: "Die Quellen werden vollautomatisch und zurückhaltend im Hintergrund erfasst — ohne sie zu belasten.",
  },
  {
    n: "§ 02",
    title: "Kontrollierter Zugang",
    text: "Das Dashboard ist während der Aufbauphase nicht öffentlich. Sobald das Observatorium einen reifen Stand erreicht hat, wird es kontrolliert veröffentlicht.",
  },
  {
    n: "§ 03",
    title: "Zurückhaltung bei Daten",
    text: "Öffentlich werden nur Metadaten und eigene Auswertungen. Volltexte werden nicht gespiegelt, sondern zur Quelle verlinkt.",
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
            <a href="#status">Status</a>
            <a href="#abdeckung">Abdeckung</a>
            <a href="#transparenz">Grundsätze</a>
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
        <p className="mg-overline">Medienobservatorium im Aufbau · fünf deutsche Leitmedien</p>
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
          margn beobachtet fünf führende deutsche Leitmedien, versioniert
          jeden Artikel fortlaufend und macht sichtbar, was zwischen den Zeilen
          passiert: <strong>stille Edits</strong>, umdatierte Artikel,
          Agenda-Profile, Paywall-Strategien.
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
          <span className="mg-rev">Private Preview · Zugang beschränkt</span>
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
              <span data-count="5">0</span>
            </span>
            <span className="l">Leitmedien</span>
            <span className="s">Tagesschau · Spiegel · FAZ · Bild · n-tv</span>
          </div>
          <div className="mg-stat" data-reveal="0.08">
            <span className="v">
              <span data-count="8">0</span>
            </span>
            <span className="l">Analyse-Blickwinkel</span>
            <span className="s">von Silent Edits bis Datums-Forensik</span>
          </div>
          <div className="mg-stat" data-reveal="0.16">
            <span className="v">
              <span data-count="16">0</span>
            </span>
            <span className="l">Bundesländer</span>
            <span className="s">Regionalberichterstattung inklusive</span>
          </div>
          <div className="mg-stat" data-reveal="0.24">
            <span className="v">24/7</span>
            <span className="l">Beobachtung</span>
            <span className="s">vollautomatisch im Hintergrund</span>
          </div>
        </div>
      </section>

      {/* ---------------- Status ---------------- */}
      <section className="mg-method" id="status">
        <div className="mg-section">
          <div className="mg-head">
            <p className="mg-overline">Status</p>
            <h2 className="mg-h2" data-split>
              Im Aufbau — Veröffentlichung <em>kontrolliert</em>
            </h2>
            <p className="mg-lede" data-reveal="0">
              margn ist ein laufendes Aufbauprojekt. Das Dashboard ist derzeit
              nicht öffentlich zugänglich; Datenbasis und Auswertungen werden
              fortlaufend erweitert und geprüft. Sobald das Observatorium
              einen reifen Stand erreicht hat, wird es kontrolliert
              veröffentlicht.
            </p>
          </div>
          <p className="mg-method-note" data-reveal="0">
            <span className="pulse" />
            in aktiver Entwicklung · Zugang beschränkt
          </p>
        </div>
      </section>

      {/* ---------------- Abdeckung ---------------- */}
      <section className="mg-section" id="abdeckung">
        <div className="mg-head">
          <p className="mg-overline">Abdeckung</p>
          <h2 className="mg-h2" data-split>
            Fünf Perspektiven, <em>ein</em> Nachrichtenmarkt
          </h2>
          <p className="mg-lede" data-reveal="0">
            Vom öffentlich-rechtlichen Angebot bis zum Boulevard: fünf
            Leitmedien, die den deutschen Nachrichtenmarkt prägen — mit
            derselben Methodik vermessen. Erfasst wird das komplette Spektrum:
            alle Ressorts, Liveticker und Regionalberichterstattung aus allen
            16 Bundesländern.
          </p>
        </div>
        <div className="mg-srcs">
          <div className="mg-pair-card" data-reveal="0">
            <span className="lang">
              <b>ÖRR</b>
            </span>
            <h3>Tagesschau</h3>
            <span className="src">tagesschau.de</span>
          </div>
          <div className="mg-pair-card" data-reveal="0.06">
            <span className="lang">
              <b>Magazin</b>
            </span>
            <h3>Spiegel</h3>
            <span className="src">spiegel.de</span>
          </div>
          <div className="mg-pair-card" data-reveal="0.12">
            <span className="lang">
              <b>Zeitung</b>
            </span>
            <h3>FAZ</h3>
            <span className="src">faz.net</span>
          </div>
          <div className="mg-pair-card" data-reveal="0.18">
            <span className="lang">
              <b>Boulevard</b>
            </span>
            <h3>Bild</h3>
            <span className="src">bild.de</span>
          </div>
          <div className="mg-pair-card" data-reveal="0.24">
            <span className="lang">
              <b>TV-Nachrichten</b>
            </span>
            <h3>n-tv</h3>
            <span className="src">n-tv.de</span>
          </div>
        </div>

        {/* Ausblick: sprachübergreifende Story-Findung — bewusst als KOMMENDES Feature
            ausgewiesen, nicht als bestehendes (aktuell rein deutschsprachiger Korpus). */}
        <div className="mg-next" data-reveal="0">
          <span className="mg-next-badge">In Vorbereitung</span>
          <h3 className="mg-next-h">Viele Sprachen, eine Geschichte</h3>
          <p className="mg-lede">
            Als Nächstes wächst margn über den deutschen Markt hinaus:
            mehrsprachige Embeddings legen dieselbe Story über Sprachgrenzen
            zusammen — Berichterstattung aus verschiedenen Ländern landet
            automatisch im selben Cluster, übersetzt vergleichbar und mit
            derselben Methodik vermessen.
          </p>
          <div className="mg-pair">
            <div className="mg-pair-card">
              <span className="lang">
                <b>DE</b>
                <span>06:12</span>
              </span>
              <h3>EU einigt sich auf strengere Regeln für Lieferketten</h3>
              <span className="src">deutsche Tageszeitung · Wirtschaft</span>
            </div>
            <div className="mg-pair-link" aria-hidden>
              <span className="line" />
              <span className="sim">Ähnlichkeit 0,91</span>
              <span className="cl">ein Story-Cluster</span>
              <span className="line" />
            </div>
            <div className="mg-pair-card">
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
        </div>
      </section>

      {/* ---------------- Transparenz ---------------- */}
      <section className="mg-section" id="transparenz">
        <div className="mg-head">
          <p className="mg-overline">Grundsätze</p>
          <h2 className="mg-h2" data-split>
            Mit Sorgfalt gebaut, mit <em>Zurückhaltung</em> geteilt.
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
          margn ist im Aufbau und derzeit nicht frei zugänglich. Die
          Veröffentlichung folgt kontrolliert, sobald Datenbasis und
          Auswertungen einen reifen Stand erreicht haben.
        </p>
        <div className="mg-hero-cta" data-reveal="0.1">
          <Link href="/articles" className="mg-btn xl">
            <span>Zum Dashboard</span>
            <span className="arr">→</span>
          </Link>
        </div>
        <p className="mg-final-rev" data-reveal="0.15">
          margn · Medienobservatorium · Private Preview
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
              umdatierte Artikel, Agenda-Profile und Paywall-Strategien
              von fünf führenden deutschen Leitmedien — fortlaufend erfasst,
              versioniert, nachvollziehbar.
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
              <li>
                <Link href="/articles/keywords">Keyword-Trends</Link>
              </li>
            </ul>
          </div>
          <div>
            <h4>Prinzipien</h4>
            <ul>
              <li>
                <a href="#status">Status</a>
              </li>
              <li>
                <a href="#transparenz">Grundsätze</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="mg-foot-mark" aria-hidden>margn</div>
        <div className="mg-foot-base">
          <div>
            <span>© 2026 margn — Medienobservatorium</span>
            <span>Im Aufbau · kontrollierte Veröffentlichung geplant</span>
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
