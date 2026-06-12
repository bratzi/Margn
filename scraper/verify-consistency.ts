// Einmaliges Prüfskript: Stimmen Client-Prädikat (Charts) und Server-Query (Tabelle)
// für diverse Filterkombinationen überein? Nutzt das ECHTE Modul lib/filterCorpus.ts.
// Aufruf: npx tsx verify-consistency.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import {
  ALLOWED_PTYPES, CORPUS_COLS, applyServerFilters, makeMatcher,
  type CorpusRow, type FilterSnapshot,
} from "../lib/filterCorpus";

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

const BASE: FilterSnapshot = {
  status: "all", paywall: "all", atype: "all", author: "all",
  topics: [], lang: "all", changed: "all", depth: "all",
  rangeFrom: null, rangeTo: null,
};

const day = (offset: number) => {
  const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const CASES: { name: string; f: Partial<FilterSnapshot> }[] = [
  { name: "kein Filter", f: {} },
  { name: "Paywall=ja", f: { paywall: "yes" } },
  { name: "Autor=named", f: { author: "named" } },
  { name: "geändert=ja", f: { changed: "yes" } },
  { name: "Tiefe=lang", f: { depth: "lang" } },
  { name: "Sprache=fr", f: { lang: "fr" } },
  { name: "Typ=timeline", f: { atype: "timeline" } },
  { name: "Status=neu", f: { status: "new" } },
  { name: "letzte 7 Tage", f: { rangeFrom: day(-7) + "T00:00:00Z", rangeTo: day(0) + "T23:59:59Z" } },
  { name: "Kombi: 7T+Paywall+geändert", f: { rangeFrom: day(-7) + "T00:00:00Z", rangeTo: day(0) + "T23:59:59Z", paywall: "yes", changed: "yes" } },
];

(async () => {
  // Corpus laden wie der FilterProvider
  const { count } = await sb.from("page_overview").select("id", { count: "exact", head: true }).in("ptype", ALLOWED_PTYPES);
  const pages = Math.ceil((count ?? 0) / 1000);
  const results = await Promise.all(Array.from({ length: pages }, (_, i) =>
    sb.from("page_overview").select(CORPUS_COLS).in("ptype", ALLOWED_PTYPES)
      .order("discovered_at", { ascending: false }).range(i * 1000, i * 1000 + 999)));
  const corpus: CorpusRow[] = [];
  for (const r of results) if (r.data) corpus.push(...(r.data as unknown as CorpusRow[]));
  console.log(`Corpus: ${corpus.length} Zeilen (Server-Count: ${count})\n`);

  // Topics dynamisch dazunehmen
  const topics = [...new Set(corpus.map((r) => r.topic).filter(Boolean))].slice(0, 2) as string[];
  for (const t of topics) CASES.push({ name: `Thema=${t}`, f: { topics: [t] } });

  let fails = 0;
  for (const c of CASES) {
    const f: FilterSnapshot = { ...BASE, ...c.f };
    // Server-Zählung (wie die Tabelle)
    let q = sb.from("page_overview").select("id", { count: "exact", head: true });
    q = applyServerFilters(q, f, [], null);
    const { count: serverN } = await q;
    // Client-Zählung (wie die Charts)
    const match = makeMatcher(f, [], null);
    const clientN = corpus.reduce((s, r) => s + (match(r) ? 1 : 0), 0);
    const ok = serverN === clientN;
    if (!ok) fails++;
    console.log(`${ok ? "✓" : "✗ MISMATCH"}  ${c.name.padEnd(28)} Server=${serverN}  Client=${clientN}`);
  }
  console.log(fails === 0 ? "\nAlle Fälle konsistent." : `\n${fails} Abweichung(en)!`);
  process.exit(fails === 0 ? 0 : 1);
})();
