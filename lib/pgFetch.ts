// Supabase/PostgREST kappt jede Antwort bei max-rows (hier: 1000 Zeilen) — auch wenn
// .limit() mehr verlangt. Für clientseitige Aggregationen über größere Mengen müssen
// die Daten daher seitenweise geholt werden.

// Parallel (gebündelt): Count holen, dann in Batches von max. BATCH_SIZE Seiten laden.
// Retry (bis zu 3 Versuche) pro Seite: Bei Supabase-Ratelimiting oder kurzem Netz-Fehler
// würden sonst einzelne Seiten still ausfallen → Corpus unvollständig → Charts falsch.
const BATCH_SIZE = 5; // max. parallele Supabase-Requests gleichzeitig
const RETRY = 3;      // max. Versuche pro Seite

export async function fetchAllRows<T>(
  countQ: () => PromiseLike<{ count: number | null }>,
  pageQ: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxRows = 30000,
): Promise<T[]> {
  const { count } = await countQ();
  const nPages = Math.min(Math.ceil(maxRows / 1000), Math.max(1, Math.ceil((count ?? 0) / 1000)));

  const fetchPage = async (from: number, to: number): Promise<T[]> => {
    for (let attempt = 0; attempt < RETRY; attempt++) {
      const r = await pageQ(from, to);
      if (!r.error && r.data) return r.data as T[];
      if (attempt < RETRY - 1) await new Promise((res) => setTimeout(res, 350 * (attempt + 1)));
    }
    console.error(`fetchAllRows: Seite ${from}–${to} nach ${RETRY} Versuchen fehlgeschlagen`);
    return [];
  };

  const out: T[] = [];
  for (let i = 0; i < nPages; i += BATCH_SIZE) {
    const batch = Array.from(
      { length: Math.min(BATCH_SIZE, nPages - i) },
      (_, j) => fetchPage((i + j) * 1000, (i + j) * 1000 + 999),
    );
    const results = await Promise.all(batch);
    for (const rows of results) out.push(...rows);
  }
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
