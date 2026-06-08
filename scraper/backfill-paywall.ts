import "dotenv/config";
import { sb } from "./lib";

// Alle aktuell als Paywall markierten Artikel laden
async function fetchAll<T>(build: (from: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from).range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const rows = await fetchAll<{ id: number; url: string }>((f) =>
  sb.from("articles").select("id,url").eq("paywalled", true).order("id", { ascending: true })
);
console.log(`Paywall-markierte Artikel: ${rows.length}`);

const isFree = (v: any) => v === true || v === "True" || v === "true";
const notFree = (v: any) => v === false || v === "False" || v === "false";

// Plain-Fetch + JSON-LD isAccessibleForFree
async function checkFree(url: string): Promise<"free" | "paywall" | "unknown"> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const html = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: ctrl.signal })).text();
    clearTimeout(t);
    const iaff: any[] = [];
    for (const m of html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) ?? []) {
      const body = m.replace(/<script[^>]*>/i, "").replace(/<\/script>/i, "");
      try {
        const parsed = JSON.parse(body);
        for (const d of (Array.isArray(parsed) ? parsed : [parsed])) {
          if (d && d.isAccessibleForFree !== undefined) iaff.push(d.isAccessibleForFree);
          for (const g of d?.["@graph"] ?? []) if (g?.isAccessibleForFree !== undefined) iaff.push(g.isAccessibleForFree);
        }
      } catch {}
    }
    if (!iaff.length) return "unknown";
    if (iaff.some(isFree) && !iaff.some(notFree)) return "free";
    if (iaff.some(notFree)) return "paywall";
    return "unknown";
  } catch { return "unknown"; }
}

const toFree: number[] = [];
let done = 0, free = 0, keep = 0, unk = 0;
const POOL = 12;
for (let i = 0; i < rows.length; i += POOL) {
  const batch = rows.slice(i, i + POOL);
  const results = await Promise.all(batch.map((r) => checkFree(r.url)));
  results.forEach((res, j) => {
    done++;
    if (res === "free") { toFree.push(batch[j].id); free++; }
    else if (res === "paywall") keep++;
    else unk++;
  });
  if (done % 240 === 0) console.log(`  ${done}/${rows.length} → frei:${free} paywall:${keep} unbekannt:${unk}`);
}
console.log(`\nKorrigiere ${toFree.length} fälschlich als Paywall markierte Artikel → frei`);

for (let i = 0; i < toFree.length; i += 500) {
  await sb.from("articles").update({ paywalled: false }).in("id", toFree.slice(i, i + 500));
}
console.log("Fertig.");
