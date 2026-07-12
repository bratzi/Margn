// Persistenter Korpus-Cache (IndexedDB) für das Dashboard.
//
// Zweck: Der ~3,6-MB-Korpus (page_overview, ~35 Tage) wurde bei JEDEM Kaltstart neu
// gezogen (Charts erst nach ~21 s da). Mit diesem Cache malt das Dashboard SOFORT aus
// dem letzten Bestand und holt danach nur noch die DELTA-Zeilen (seit dem letzten Sync
// re-gescannt/neu) — Egress und Ladezeit sinken beim Wiederbesuch drastisch.
//
// Korrektheit hat Vorrang (Charts müssen zur Tabelle passen): Der Aufrufer gleicht nach
// dem Delta den SERVER-Count gegen den zusammengeführten Bestand ab und lädt bei Drift
// komplett neu. Alle IDB-Fehler sind weich (private Modus, Kontingent) → Fallback = der
// bisherige Voll-Load, nichts bricht.

import type { CorpusRow } from "@/lib/filterCorpus";

const DB_NAME = "margn";
const STORE = "corpus";
const KEY = "page_overview";
// Bei jeder Änderung an CORPUS_COLS / an der Korpus-Filterform HOCHZÄHLEN → alter Cache
// wird verworfen statt inkompatibel weiterverwendet.
export const CACHE_SCHEMA_VERSION = 1;

export type CorpusCacheEntry = {
  v: number;
  sig: string;           // Filter-Signatur (Floor-Tag + Seitentypen + Schema-Version)
  rows: CorpusRow[];
  syncedAt: number;      // Date.now() des letzten erfolgreichen Syncs
  maxLastSeen: string;   // größtes last_seen im Bestand = Delta-Wasserstand (ISO, lexikografisch vergleichbar)
};

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
      rq.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function maxLastSeenOf(rows: CorpusRow[]): string {
  let m = "";
  for (const r of rows) { const ls = r.last_seen; if (ls && ls > m) m = ls; }
  return m;
}

export async function readCorpusCache(sig: string): Promise<CorpusCacheEntry | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const rq = tx.objectStore(STORE).get(KEY);
      rq.onsuccess = () => {
        const e = rq.result as CorpusCacheEntry | undefined;
        const ok = !!e && e.v === CACHE_SCHEMA_VERSION && e.sig === sig
          && Array.isArray(e.rows) && e.rows.length > 0;
        resolve(ok ? e! : null);
      };
      rq.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function writeCorpusCache(sig: string, rows: CorpusRow[]): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const entry: CorpusCacheEntry = {
    v: CACHE_SCHEMA_VERSION, sig, rows, syncedAt: Date.now(), maxLastSeen: maxLastSeenOf(rows),
  };
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* Kontingent/privat → still verwerfen */
  } finally {
    db.close();
  }
}
