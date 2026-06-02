import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { createHash } from "node:crypto";
import { sb, toPgVector } from "./lib";

const rss = new Parser();

type Source = { id: number; feed_url: string | null };

// Mehrsprachiges Embedding (Cohere Embed v3). Antwort-Shape defensiv lesen.
async function embed(text: string): Promise<number[]> {
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

async function processSource(src: Source) {
  if (!src.feed_url) return;
  const feed = await rss.parseURL(src.feed_url);
  for (const entry of feed.items) {
    const url = entry.link;
    if (!url) continue;
    // Titel + Teaser kommen direkt aus dem RSS-Feed – kein Bot-Block möglich
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
