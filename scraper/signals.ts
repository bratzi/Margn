import { chromium } from "playwright";
import { sb } from "./lib";

const AD_HOSTS = /doubleclick|googlesyndication|adservice|adnxs|criteo|taboola|outbrain/i;
const COMMENT_MARKERS = ["disqus", "coral", "fb-comments", "commento", "kommentar", "comment-section"];

// Paywall-Erkennung: DOM-Elemente die auf gesperrten Inhalt hinweisen.
// Playwright rendert die Seite vollständig → zuverlässiger als statisches HTML.
const PAYWALL_DOM = [
  // FAZ: Paywall-Wrapper + Piano-Meter
  "faz-paywall", "faz-plus", "js-paywall", "SubscriptionWall",
  // Spiegel: Plus-Artikel
  "spiegel-plus", "paid-content", "sp-subscription",
  // Le Monde: Abonnenten-Schranke
  "article__state--premium", "paywall", "lmd-premium",
  // Allgemein
  "piano-", "tinypass", "piano-id", "piano-offer",
  "metered-wall", "subscriber-only", "locked-content",
  "abo-schranke", "plus-artikel", "premium-overlay",
  "premium-content", "premium-article",
];

type Ctx = { url: string; html: string; jsonLd: any[]; adRequests: number };

// === Jedes Feature = ein Eintrag. Neues Signal hinzufügen = eine Zeile ergänzen. ===
const collectors: Record<string, (c: Ctx) => unknown> = {
  has_comments: (c) => COMMENT_MARKERS.some((m) => c.html.includes(m)),
  ad_signal: (c) => c.adRequests,
  paywalled: (c) => {
    // JSON-LD hat Vorrang wenn vorhanden
    const iaff = c.jsonLd.map((d: any) => d.isAccessibleForFree).filter((v: any) => v !== undefined && v !== null);
    const notFree = (v: any) => v === false || v === "False" || v === "false";
    const isFree = (v: any) => v === true || v === "True" || v === "true";
    if (iaff.length > 0) return iaff.some(notFree) && !iaff.some(isFree);
    // DOM-basiert: präzise Pattern die in gerenderter Seite auf Paywall-Schranken hindeuten
    return PAYWALL_DOM.some((p) => c.html.includes(p.toLowerCase()));
  },
  is_liveblog: (c) =>
    c.jsonLd.some((d: any) => d["@type"] === "LiveBlogPosting") ||
    /liveblog|live-blog|live-?ticker/.test(c.html),
  body_chars: (c) => c.html.replace(/<[^>]+>/g, "").length,
};

async function gather(url: string): Promise<Ctx> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let adRequests = 0;
  page.on("request", (r) => {
    if (AD_HOSTS.test(r.url())) adRequests++;
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});
  const html = (await page.content()).toLowerCase();
  const jsonLd = await page.$$eval('script[type="application/ld+json"]', (els) =>
    els.flatMap((e) => {
      try {
        const j = JSON.parse(e.textContent || "{}");
        return Array.isArray(j) ? j : [j];
      } catch {
        return [];
      }
    })
  );
  await browser.close();
  return { url, html, jsonLd, adRequests };
}

async function run() {
  // Versionen, die noch nicht mit Signalen angereichert sind
  const { data } = await sb
    .from("article_versions")
    .select("id, articles(url)")
    .is("signals", null)
    .limit(50);

  for (const v of data ?? []) {
    const url = (v as any).articles?.url;
    if (!url) continue;
    try {
      const ctx = await gather(url);
      const signals: Record<string, unknown> = {};
      for (const [key, fn] of Object.entries(collectors)) {
        try {
          signals[key] = fn(ctx);
        } catch {
          signals[key] = null;
        }
      }
      await sb.from("article_versions").update({ signals }).eq("id", (v as any).id);
      // Paywall-Signal zurück in articles spiegeln (überschreibt ggf. fehlerhafte statische Erkennung)
      if (typeof signals.paywalled === "boolean") {
        await sb.from("articles").update({ paywalled: signals.paywalled }).eq("url", url);
      }
      console.log("SIGNALS:", url, signals);
    } catch (e) {
      console.error("FEHLER:", url, (e as Error).message);
    }
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
