import { chromium } from "playwright";
import { sb } from "./lib";

const AD_HOSTS = /doubleclick|googlesyndication|adservice|adnxs|criteo|taboola|outbrain/i;
const COMMENT_MARKERS = ["disqus", "coral", "fb-comments", "commento", "kommentar", "comment-section"];

type Ctx = { url: string; html: string; jsonLd: any[]; adRequests: number };

// === Jedes Feature = ein Eintrag. Neues Signal hinzufügen = eine Zeile ergänzen. ===
const collectors: Record<string, (c: Ctx) => unknown> = {
  has_comments: (c) => COMMENT_MARKERS.some((m) => c.html.includes(m)),
  ad_signal: (c) => c.adRequests,
  paywalled: (c) =>
    c.jsonLd.some((d) => d.isAccessibleForFree === false || d.isAccessibleForFree === "False") ||
    /paywall|premium-overlay|piano-|plus-artikel|abo-schranke/.test(c.html),
  is_liveblog: (c) =>
    c.jsonLd.some((d) => d["@type"] === "LiveBlogPosting") ||
    /liveblog|live-blog|live-?ticker/.test(c.html),
  body_chars: (c) => c.html.replace(/<[^>]+>/g, "").length, // Basis für Liveblog-Wachstum
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
