// Supabase/PostgREST kappt jede Antwort bei max-rows (hier: 1000 Zeilen) — auch wenn
// .limit() mehr verlangt. Für clientseitige Aggregationen über größere Mengen müssen
// die Daten daher seitenweise geholt werden.

// Parallel (gebündelt): Count holen, dann in Batches von max. BATCH_SIZE Seiten laden.
// Retry (bis zu 3 Versuche) pro Seite: Bei Supabase-Ratelimiting oder kurzem Netz-Fehler
// würden sonst einzelne Seiten still ausfallen → Corpus unvollständig → Charts falsch.
const BATCH_SIZE = 5; // max. parallele Supabase-Requests gleichzeitig
const RETRY = 3;      // max. Versuche pro Seite

// Hartes Abbruch-Timeout je Request: Ein still hängender Fetch (Verbindungs-Stall, Proxy,
// Rechner-Aufwachen) blockierte sonst das await ENDLOS — der Retry griff nie, der ganze
// Ladevorgang „hängt ewig". Der Abbruch macht aus dem Stall einen normalen Fehlversuch,
// den die vorhandene Retry-Logik auffängt. Die Aufrufer MÜSSEN das Signal per
// .abortSignal(signal) an die Supabase-Query hängen.
const REQ_TIMEOUT_MS = 15000;
export function timeoutSignal(ms = REQ_TIMEOUT_MS): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

export async function fetchAllRows<T>(
  countQ: (signal: AbortSignal) => PromiseLike<{ count: number | null }>,
  pageQ: (from: number, to: number, signal: AbortSignal) => PromiseLike<{ data: T[] | null; error: unknown }>,
  maxRows = 30000,
  // Äußeres Abbruch-Signal des Aufrufers: Ohne dieses lief ein vom Effekt-Cleanup „cancelled"
  // Ladevorgang im Netz KOMPLETT weiter (alle Seiten) — beim Dashboard-Kaltstart wurde der
  // Corpus so doppelt gezogen (~3,5 MB Egress verschenkt pro Load). Geprüft wird an den
  // Batch-/Versuchs-Grenzen; maximal ein laufender 5er-Batch läuft noch aus.
  outer?: AbortSignal,
): Promise<T[]> {
  const bail = () => { if (outer?.aborted) throw new Error("fetchAllRows: abgebrochen"); };
  // Count MIT Retry und hartem Fehler: fiele er still auf null zurück, würde nur EINE Seite
  // (1000 Zeilen) geladen und als Erfolg gemeldet — Charts zeigten dann ~2 % der Daten.
  let count: number | null = null;
  for (let attempt = 0; attempt < RETRY; attempt++) {
    bail();
    const ts = timeoutSignal();
    try { count = (await countQ(ts.signal)).count ?? null; } catch { count = null; } finally { ts.done(); }
    if (count !== null) break;
    if (attempt < RETRY - 1) await new Promise((res) => setTimeout(res, 350 * (attempt + 1)));
  }
  if (count === null) throw new Error("fetchAllRows: Count nicht ermittelbar");
  const nPages = Math.min(Math.ceil(maxRows / 1000), Math.max(1, Math.ceil(count / 1000)));

  const fetchPage = async (from: number, to: number): Promise<T[] | null> => {
    for (let attempt = 0; attempt < RETRY; attempt++) {
      bail();
      const ts = timeoutSignal();
      try {
        const r = await pageQ(from, to, ts.signal);
        if (!r.error && r.data) return r.data as T[];
      } catch {} // Netzwerk-Reject zählt wie ein PostgREST-Fehler: erneut versuchen
      finally { ts.done(); }
      if (attempt < RETRY - 1) await new Promise((res) => setTimeout(res, 350 * (attempt + 1)));
    }
    return null;
  };

  const pages: (T[] | null)[] = new Array(nPages).fill(null);
  for (let i = 0; i < nPages; i += BATCH_SIZE) {
    bail();
    await Promise.all(Array.from(
      { length: Math.min(BATCH_SIZE, nPages - i) },
      (_, j) => fetchPage((i + j) * 1000, (i + j) * 1000 + 999).then((rows) => { pages[i + j] = rows; }),
    ));
  }
  // Nachputz-Runde: ausgefallene Seiten einzeln SERIELL nachholen — der parallele Burst ist
  // die häufigste Ausfallursache. Bleibt danach ein Loch, wird geworfen statt ein
  // unvollständiger Bestand als Erfolg gemeldet (der Aufrufer behält dann die alten Daten).
  for (let i = 0; i < nPages; i++) {
    if (pages[i] === null) pages[i] = await fetchPage(i * 1000, i * 1000 + 999);
    if (pages[i] === null) {
      console.error(`fetchAllRows: Seite ${i * 1000}–${i * 1000 + 999} endgültig fehlgeschlagen`);
      throw new Error("fetchAllRows: unvollständig");
    }
  }
  const out: T[] = [];
  for (const rows of pages) out.push(...(rows as T[]));
  return out;
}

// Nur der exakte Count (head:true), mit Retry/Timeout — für den Delta-Abgleich (Cache):
// die Zeilenzahl des SERVERS gegen den zusammengeführten Client-Bestand prüfen.
export async function fetchCount(
  countQ: (signal: AbortSignal) => PromiseLike<{ count: number | null }>,
  outer?: AbortSignal,
): Promise<number> {
  for (let attempt = 0; attempt < RETRY; attempt++) {
    if (outer?.aborted) throw new Error("fetchCount: abgebrochen");
    const ts = timeoutSignal();
    try { const c = (await countQ(ts.signal)).count; if (c != null) return c; } catch {} finally { ts.done(); }
    if (attempt < RETRY - 1) await new Promise((res) => setTimeout(res, 350 * (attempt + 1)));
  }
  throw new Error("fetchCount: nicht ermittelbar");
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
