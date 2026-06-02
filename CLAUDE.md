# CLAUDE.md – Projektkontext für Claude Code

Diese Datei gibt Claude Code dauerhaften Kontext über das Projekt. Beim Start in diesem
Verzeichnis liest Claude Code sie automatisch.

## Was das ist

Ein **sprachübergreifendes EU-Medienobservatorium** (Neuauflage eines alten VB.NET-Projekts
namens "NewsScraper"). Es scrapt Nachrichtenartikel aus mehreren Ländern, versioniert sie,
bettet sie mehrsprachig ein und macht Muster sichtbar, die man "zwischen den Zeilen" liest:
stille Überschriften-Änderungen, blattübergreifende Inhalts-Übernahme, gemeinsame Buzzwords/
Framings, Paywall-/Werbung-/Kommentar-Signale.

Es ist ein **Hobbyprojekt**: möglichst günstig (~0 €/Monat zum Start), serverlos, kein on-prem.

## Architektur (durchgehend TypeScript)

```
Quellen (RSS/HTML)
   -> scraper/main.ts       Feed lesen, Artikel extrahieren, Version + Embedding speichern (stündlich, GitHub Actions)
   -> scraper/signals.ts    Headless-Browser (Playwright): erweiterbarer Signal-Beutel (täglich)
   -> scraper/cluster.ts    Sprachübergreifende Story-Cluster bilden (alle 6 h)
   -> Supabase              Postgres + pgvector + Auto-API + Storage + Login
   -> web/                  Next.js-Frontend (Vercel), liest per anon-Key + RLS
```

## Verzeichnisse

- `schema.sql` – DB-Schema, pgvector, RPCs (`similar_articles`, `unclustered_articles`). Einmal in Supabase ausführen.
- `views.sql` – Views `headline_edits` und `cluster_echoes` + lesende RLS-Policies. Nach schema.sql ausführen.
- `scraper/` – Node/TypeScript-Jobs, ausgeführt mit `tsx` (kein Build-Schritt).
  - `lib.ts` – Supabase-Service-Client + pgvector-Helfer (`toPgVector`/`fromPgVector`).
  - `main.ts` / `signals.ts` / `cluster.ts` – die drei Jobs.
- `web/` – Next.js-App.
  - `lib/supabase.ts` – Browser-Client (anon-Key, nur lesend).
  - `lib/diff.ts` – Wort-Diff + Edit-Klassifizierung (Heuristik; später per LLM ersetzt).
  - `components/DiffViewer.tsx` – Viewer für still geänderte Überschriften (liest `headline_edits`).
  - `components/EchoTimeline.tsx` – "wer hatte die Story zuerst" (liest `cluster_echoes`).
  - `app/edits/` und `app/echoes/` – Seiten zu den Komponenten.
- `.github/workflows/` – Cron-Jobs (scrape stündlich, signals täglich, cluster alle 6 h).

## Datenmodell (Kern)

- `sources` – Quellen mit `country`/`language`.
- `articles` – eine eindeutige URL je Artikel.
- `article_versions` – **das Herzstück**: pro Scan eine Version mit `title`, `teaser`,
  `body_text` (intern!), `changed`-Flag, `embedding vector(1024)` und `signals jsonb`.
- `keywords`/`authors`/`categories` + n:m-Tabellen.
- `story_clusters` + `article_clusters` – sprachübergreifende "dieselbe Geschichte"-Gruppen.

## Wichtige Konventionen / Fallstricke

- **Vektor-Dimension muss überall gleich sein.** Schema nutzt `vector(1024)` (Cohere Embed v3).
  Anderes Modell -> Zahl in `schema.sql` UND im `embed()`-Aufruf in `scraper/main.ts` ändern.
- **pgvector über die API** kommt/geht als Text-Literal `[1,2,3]`, nicht als JS-Array.
  Immer `toPgVector`/`fromPgVector` aus `scraper/lib.ts` nutzen.
- **Key-Trennung strikt:** `SUPABASE_SERVICE_KEY` NUR im Scraper. Frontend nutzt
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` + RLS. `body_text` wird in keiner View selektiert.
- **Signale sind erweiterbar:** neues Merkmal = eine Zeile in `collectors` in `signals.ts`,
  keine Schema-Migration (landet in `signals` jsonb).
- **`@/`-Import-Alias** im Frontend ist in `web/tsconfig.json` unter `paths` definiert.
- Edit-Klassifizierung in `lib/diff.ts` ist eine Platzhalter-Heuristik; in Stufe 2 ersetzt ein
  LLM sie und schreibt das Label in die DB.

## Umgebungsvariablen

Scraper (`.env` / GitHub Secrets): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `COHERE_API_KEY`.
Frontend (`.env.local` / Vercel): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
Vorlagen: `.env.example` und `web/.env.local.example`.

## Befehle

```bash
# Scraper
cd scraper && npm install
npm run scrape      # Feed -> Artikel -> Version + Embedding
npm run signals     # Playwright-Signale (vorher: npx playwright install chromium)
npm run cluster     # Story-Cluster bilden

# Frontend
cd web && npm install
npm run dev         # Seiten unter /edits und /echoes
```

## Aktueller Stand

Fundament steht: Schema, Views, drei Scraper-Jobs, zwei Frontend-Komponenten (DiffViewer,
EchoTimeline). Embeddings/Cluster/Signale sind verdrahtet, aber noch nicht mit echten Daten
über längere Zeit getestet.

## Nächste sinnvolle Schritte

1. Supabase-Projekt anlegen, `schema.sql` + `views.sql` ausführen.
2. Scraper lokal gegen 2 Quellen unterschiedlicher Sprache laufen lassen.
3. **Cross-Lingual-Test:** findet `similar_articles(...)` dieselbe Story in DE und FR? (Kernbeweis.)
4. Cron aktivieren, ein paar Tage Daten sammeln.
5. Dann: Cluster-Labels per LLM (`story_clusters.label`), Framing/Buzzword-Analyse, Cluster-Graph.

## Recht / Sorgfalt

- Öffentlich nur Metadaten + eigene Analysen; Volltext zur Quelle verlinken, nicht spiegeln.
- `robots.txt`/ToS respektieren, RSS bevorzugen, freundliche Crawl-Rate.
- Kommentar-Signal ist nur an/aus – keine Inhalte, keine Personen (DSGVO-schonend).
