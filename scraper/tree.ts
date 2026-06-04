import "dotenv/config";
import { sb } from "./lib";

// Aufruf: npx tsx tree.ts [quelle] [maxKinderProKnoten]
// Zeigt den Link-Baum einer Quelle ab der Startseite – aber NUR die Äste, die zu Artikeln führen.
const arg = (process.argv[2] ?? "tagesschau").toLowerCase();
const MAX_CHILDREN = Number(process.argv[3] ?? 6);

// Alle Zeilen einer Tabelle holen (PostgREST limitiert auf 1000/Request → paginieren).
async function fetchAll<T>(table: string, cols: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = sb.from(table).select(cols).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const { data: srcs } = await sb.from("sources").select("id,name,base_url");
const src = (srcs ?? []).find((s) => s.name.toLowerCase().includes(arg) || s.base_url.includes(arg));
if (!src) { console.log("Quelle nicht gefunden. Verfügbar:", srcs?.map((s) => s.name).join(", ")); process.exit(1); }

type Node = { id: number; url: string; kind: string; depth: number | null };
const nodes = await fetchAll<Node>("pages", "id,url,kind,depth", (q) => q.eq("source_id", src.id));
const ids = new Set(nodes.map((n) => n.id));
const byId = new Map(nodes.map((n) => [n.id, n]));

type Edge = { from_page_id: number; to_page_id: number };
const edgesAll = await fetchAll<Edge>("page_links", "from_page_id,to_page_id");
const children = new Map<number, number[]>();
const parents = new Map<number, number[]>();
for (const e of edgesAll) {
  if (!ids.has(e.from_page_id) || !ids.has(e.to_page_id)) continue; // nur diese Quelle
  (children.get(e.from_page_id) ?? children.set(e.from_page_id, []).get(e.from_page_id)!).push(e.to_page_id);
  (parents.get(e.to_page_id) ?? parents.set(e.to_page_id, []).get(e.to_page_id)!).push(e.from_page_id);
}

// "Führt zu Artikel?" – Rückwärts-BFS von allen Artikel-Knoten zu ihren Vorfahren.
const leads = new Set<number>();
const stack: number[] = nodes.filter((n) => n.kind === "article").map((n) => n.id);
stack.forEach((id) => leads.add(id));
while (stack.length) {
  const id = stack.pop()!;
  for (const p of parents.get(id) ?? []) if (!leads.has(p)) { leads.add(p); stack.push(p); }
}

// Wurzel = Startseite (depth 0 oder url == base_url).
const norm = (u: string) => u.replace(/\/+$/, "");
const root = nodes.find((n) => n.depth === 0) ?? nodes.find((n) => norm(n.url) === norm(src.base_url));
if (!root) { console.log("Keine Startseite (depth 0) im Baum – erst einen Crawl laufen lassen."); process.exit(0); }

const short = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") || "/";
const ICON: Record<string, string> = { article: "📄", section: "📂", media: "🎬", interactive: "🎛️", sponsored: "💰", service: "⚙️", unknown: "·" };

let articleCount = 0, sectionCount = 0;
const printed = new Set<number>();

function render(id: number, prefix: string, isLast: boolean) {
  const n = byId.get(id)!;
  const branch = prefix === "" ? "" : isLast ? "└─ " : "├─ ";
  console.log(`${prefix}${branch}${ICON[n.kind] ?? "·"} ${short(n.url)}`);
  printed.add(id);
  if (n.kind === "article") { articleCount++; return; }
  sectionCount++;

  // Kinder: nur die, die zu Artikeln führen, noch nicht gedruckt, keine Schleifen.
  const kids = (children.get(id) ?? [])
    .filter((c) => leads.has(c) && !printed.has(c))
    .map((c) => byId.get(c)!)
    // Rubriken zuerst (Struktur), dann Artikel
    .sort((a, b) => (a.kind === "article" ? 1 : 0) - (b.kind === "article" ? 1 : 0));

  const shown = kids.slice(0, MAX_CHILDREN);
  const childPrefix = prefix + (prefix === "" ? "" : isLast ? "   " : "│  ");
  shown.forEach((k, i) => render(k.id, childPrefix, i === shown.length - 1 && kids.length <= MAX_CHILDREN));
  if (kids.length > MAX_CHILDREN) {
    const rest = kids.length - MAX_CHILDREN;
    const restArts = kids.slice(MAX_CHILDREN).filter((k) => k.kind === "article").length;
    console.log(`${childPrefix}└─ … +${rest} weitere (${restArts} Artikel)`);
  }
}

console.log(`\nBAUM: ${src.name} — nur Pfade, die zu Artikeln führen\n`);
render(root.id, "", true);
console.log(`\nKnoten gesamt: ${nodes.length} | zu Artikeln führend: ${leads.size} | im Baum gezeigt: ${printed.size}`);
console.log(`(📂 Zwischenseiten: ${sectionCount}, 📄 Artikel: ${articleCount})`);
