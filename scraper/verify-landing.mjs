// Einmaliges Prüf-Skript für die neue Landingpage (läuft aus scraper/, weil
// Playwright hier installiert ist). Macht Screenshots (Desktop + Mobile),
// sammelt Konsolen-/Seitenfehler und prüft auf horizontalen Overflow.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:3000";
const OUT = new URL("./shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function run(name, viewport, opts = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  page.on("requestfailed", (r) => errors.push(`[requestfailed] ${r.url()} — ${r.failure()?.errorText}`));

  await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000); // Intro + Canvas
  await page.screenshot({ path: `${OUT}${name}-1-hero.png` });

  // Overflow-Check
  const overflow = await page.evaluate(() => {
    const d = document.scrollingElement;
    return { scrollW: d.scrollWidth, innerW: window.innerWidth, scrollH: d.scrollHeight };
  });

  // Durch die Seite scrollen — Stationen relativ zur Gesamthöhe
  const h = viewport.height;
  const stops = [
    ["2-marquee", 1.0],
    ["3-anatomy-a", 1.9],
    ["4-anatomy-b", 3.0],
    ["5-anatomy-c", 4.2],
    ["6-stats-features", 5.6],
    ["7-method", 6.8],
    ["8-coverage", 7.8],
    ["9-final", 99],
  ];
  for (const [label, mult] of stops) {
    await page.evaluate(
      ([y]) => window.scrollTo({ top: y, behavior: "instant" }),
      [mult === 99 ? overflow.scrollH : Math.round(h * mult)]
    );
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${OUT}${name}-${label}.png` });
  }

  console.log(`\n=== ${name} (${viewport.width}x${viewport.height}) ===`);
  console.log(`scrollWidth=${overflow.scrollW} innerWidth=${overflow.innerW} ${overflow.scrollW > overflow.innerW ? "!!! H-OVERFLOW" : "ok"}`);
  console.log(`pageHeight=${overflow.scrollH}`);
  if (errors.length) console.log("FEHLER:\n" + errors.join("\n"));
  else console.log("Keine Konsolen-/Seitenfehler.");
  await ctx.close();
}

await run("desktop", { width: 1440, height: 900 });
await run("mobile", { width: 390, height: 844 }, {
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});

await browser.close();
console.log(`\nScreenshots: ${OUT}`);
