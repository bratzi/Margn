// Supabase/PostgREST kappt jede Antwort bei max-rows (hier: 1000 Zeilen) — auch wenn
// .limit() mehr verlangt. Für clientseitige Aggregationen über größere Mengen müssen
// die Daten daher seitenweise geholt werden.

// Parallel: erst Count holen, dann alle Seiten gleichzeitig laden (für große Tabellen).
export async function fetchAllRows<T>(
  countQ: () => PromiseLike<{ count: number | null }>,
  pageQ: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxRows = 30000,
): Promise<T[]> {
  const { count } = await countQ();
  const pages = Math.min(Math.ceil(maxRows / 1000), Math.max(1, Math.ceil((count ?? 0) / 1000)));
  const results = await Promise.all(Array.from({ length: pages }, (_, i) => pageQ(i * 1000, i * 1000 + 999)));
  const out: T[] = [];
  for (const r of results) if (!r.error && r.data) out.push(...r.data);
  return out;
}

// Sequenziell mit Früh-Abbruch (für mittlere Mengen, wenn kein Count verfügbar/nötig).
export async function fetchPagedSeq<T>(
  pageQ: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxPages = 10,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < maxPages; i++) {
    const { data, error } = await pageQ(i * 1000, i * 1000 + 999);
    if (error || !data?.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}
