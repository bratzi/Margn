import "dotenv/config";
import { sb } from "./lib";

// Aufruf: npx tsx tree.ts [quelle] [maxKinderProKnoten]
// Zeigt die Rubriken-Hierarchie einer Quelle aus den URL-Pfaden: Startseite → Zwischenseiten → Artikel.
// Nur Äste, die (irgendwo darunter) zu Artikeln führen, werden gezeigt.
const arg = (process.argv[2] ?? "tagesschau").toLowerCase();
const MAX_CHILDREN = Number(process.argv[3] ?? 6);

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
if (!src) { console.log("Quelle nicht gefunden:", srcs?.map((s) => s.name).join(", ")); process.exit(1); }

type Node = { url: string; kind: string };
const pages = await fetchAll<Node>("pages", "url,kind", (q) => q.eq("source_id", src.id));

// --- Baum aus URL-Pfadsegmenten aufbauen ---
type T = { seg: string; kind: string; children: Map<string, T>; articleCount: number };
const root: T = { seg: src.base_url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""), kind: "section", children: new Map(), articleCount: 0 };

// Struktur-/Datums-Segmente, die keine echten Rubriken sind (Le Monde: /article/2026/05/26/…)
const SKIP_SEG = /^(\d{4}|\d{1,2}|article|aktuell)$/;

for (const p of pages) {
  let path: string;
  try { path = new URL(p.url).pathname; } catch { continue; }
  const segs = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).filter((s) => !SKIP_SEG.test(s));
  if (!segs.length) continue; // Startseite selbst
  let cur = root;
  segs.forEach((seg, i) => {
    const isLeaf = i === segs.length - 1;
    let child = cur.children.get(seg);
    if (!child) { child = { seg, kind: "section", children: new Map(), articleCount: 0 }; cur.children.set(seg, child); }
    if (isLeaf) child.kind = p.kind; // Blatt trägt den echten Typ (article/media/…)
    cur = child;
  });
}

// --- Artikel-Zähler hochpropagieren + Pruning (nur Äste mit Artikeln) ---
function count(n: T): number {
  let c = n.kind === "article" ? 1 : 0;
  for (const ch of n.children.values()) c += count(ch);
  n.articleCount = c;
  return c;
}
count(root);

// --- Einzel-Ketten zusammenfassen (z.B. /article/2026/06/03 → eine Zeile) ---
function compress(n: T) {
  for (const ch of [...n.children.values()]) compress(ch);
  if (n.children.size === 1) {
    const [only] = [...n.children.values()];
    if (n.kind === "section" && only.kind === "section" && only.children.size) {
      n.seg = `${n.seg}/${only.seg}`;
      n.children = only.children;
      n.kind = only.kind;
    }
  }
}
for (const ch of root.children.values()) compress(ch);

const ICON: Record<string, string> = { article: "📄", section: "📂", media: "🎬", interactive: "🎛️", sponsored: "💰", service: "⚙️", unknown: "·" };
// Verzweigungsknoten (haben Artikel darunter) sind de-facto Rubriken → 📂, auch wenn URL-Typ "unknown".
const iconOf = (k: T) => k.kind === "article" ? "📄" : (k.kind === "unknown" || !ICON[k.kind] ? "📂" : ICON[k.kind]);

function render(n: T, prefix: string) {
  const kids = [...n.children.values()]
    .filter((c) => c.articleCount > 0 || c.kind === "article")
    .sort((a, b) => (a.kind === "article" ? 1 : 0) - (b.kind === "article" ? 1 : 0) || b.articleCount - a.articleCount);
  const shown = kids.slice(0, MAX_CHILDREN);
  shown.forEach((k, i) => {
    const last = i === shown.length - 1 && kids.length <= MAX_CHILDREN;
    const tag = k.kind === "article" ? "" : `  (${k.articleCount} Artikel)`;
    console.log(`${prefix}${last ? "└─ " : "├─ "}${iconOf(k)} ${k.seg}${tag}`);
    if (k.kind !== "article") render(k, prefix + (last ? "   " : "│  "));
  });
  if (kids.length > MAX_CHILDREN) {
    const rest = kids.slice(MAX_CHILDREN);
    console.log(`${prefix}└─ … +${rest.length} weitere Rubriken (${rest.reduce((s, k) => s + k.articleCount, 0)} Artikel)`);
  }
}

console.log(`\nBAUM: ${src.name} — Rubriken-Hierarchie, nur Äste mit Artikeln\n`);
console.log(`📂 ${root.seg}  (Startseite, ${root.articleCount} Artikel gesamt)`);
render(root, "");
