import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { sb, toPgVector } from "./lib";

const rss = new Parser();

type Source = { id: number; feed_url: string | null };

// Mehrsprachiges Embedding (Cohere Embed v3). Antwort-Shape defensiv lesen.
// Trial-Key: 100 calls/min → 650ms Pause zwischen Calls reicht
const embedDelay = () => new Promise(r => setTimeout(r, 650));

async function embed(text: string): Promise<number[]> {
  await embedDelay();
  const r = await fetch("https://api.cohere.com/v2/embed", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.COHERE_API_KEY}`,
    },
    body: JSON.stringify({
      model: "embed-multilingual-v3.0",
      input_type: "clustering",
      embedding_types: ["float"],
      texts: [text.slice(0, 2000)],
    }),
  });
  if (!r.ok) throw new Error(`Embed failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.embeddings?.float?.[0] ?? j.embeddings?.[0];
}

async function upsertArticle(sourceId: number, url: string): Promise<number> {
  const { data, error } = await sb
    .from("articles")
    .upsert(
      { source_id: sourceId, url, last_seen: new Date().toISOString() },
      { onConflict: "url" }
    )
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function latestVersion(articleId: number) {
  const { data } = await sb
    .from("article_versions")
    .select("title,teaser")
    .eq("article_id", articleId)
    .order("scanned_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

async function saveVersion(articleId: number, title: string, teaser: string, body: string) {
  const hash = createHash("sha256").update(body ?? "").digest("hex");
  const prev = await latestVersion(articleId);
  const changed = !!prev && (prev.title !== title || prev.teaser !== teaser);
  const vector = await embed(`${title}\n\n${teaser}`);
  await sb.from("article_versions").insert({
    article_id: articleId,
    title,
    teaser,
    body_hash: hash,
    body_text: body,
    changed,
    embedding: toPgVector(vector),
  });
}

// Versucht den Volltext zu holen; gibt null zurück wenn geblockt/Fehler.
async function fetchBody(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; NewsScraperBot/0.1)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const dom = new JSDOM(await res.text(), { url });
    const a = new Readability(dom.window.document).parse();
    // Blockseiten liefern oft sehr kurzen Text – dann lieber null zurück
    if (!a || a.textContent.length < 200) return null;
    return a.textContent;
  } catch {
    return null;
  }
}

// Playwright-Pfad: Homepage laden, Artikel-Links sammeln, jeden Artikel rendern.
async function processPlaywright(src: Source, homeUrl: string) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "de-DE",
  });
  try {
    const page = await ctx.newPage();
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Alle internen Artikel-Links sammeln (mind. 30 Zeichen Pfad = kein Menü-Link)
    const links: string[] = await page.$$eval("a[href]", (els, base) =>
      [...new Set(
        els
          .map((a) => (a as HTMLAnchorElement).href)
          .filter((h) => h.startsWith(base) && h.length > base.length + 30)
      )].slice(0, 30),
      homeUrl
    );

    for (const url of links) {
      try {
        const ap = await ctx.newPage();
        await ap.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
        const html = await ap.content();
        await ap.close();

        const dom = new JSDOM(html, { url });
        const article = new Readability(dom.window.document).parse();
        if (!article || article.textContent.length < 200) continue;

        const title = article.title?.trim() ?? "";
        const teaser = article.excerpt?.trim() ?? "";
        if (!title) continue;

        const id = await upsertArticle(src.id, url);
        await saveVersion(id, title, teaser, article.textContent);
        console.log("OK (pw):", url);
      } catch (e) {
        console.error("FEHLER (pw):", url, (e as Error).message);
      }
    }
  } finally {
    await browser.close();
  }
}

async function processSource(src: Source) {
  if (!src.feed_url) return;

  // playwright://<url> → headless-Browser-Pfad
  if (src.feed_url.startsWith("playwright://")) {
    await processPlaywright(src, src.feed_url.replace("playwright://", ""));
    return;
  }

  const feed = await rss.parseURL(src.feed_url);
  for (const entry of feed.items) {
    const url = entry.link;
    if (!url) continue;
    const title = entry.title?.trim() ?? "";
    const teaser = (entry.contentSnippet ?? entry.summary ?? "").trim();
    if (!title) continue;
    try {
      const body = await fetchBody(url) ?? teaser;
      const id = await upsertArticle(src.id, url);
      await saveVersion(id, title, teaser, body);
      console.log("OK:", url);
    } catch (e) {
      console.error("FEHLER:", url, (e as Error).message);
    }
  }
}

async function run() {
  const { data } = await sb.from("sources").select("id,feed_url").eq("active", true);
  for (const src of (data ?? []) as Source[]) await processSource(src);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
