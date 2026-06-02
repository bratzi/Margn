# NewsScraper → EU-Medienobservatorium (Starter-Repo)

Sprachübergreifender Medien-Vergleich: Artikel scrapen, versionieren, mehrsprachig einbetten,
über Sprachgrenzen hinweg zu „dieselbe-Geschichte“-Clustern gruppieren und je Seite Signale
(Kommentar an/aus, Werbung, Paywall, Liveblog) erfassen. Durchgehend TypeScript, serverlos.

## Bausteine

| Datei | Zweck |
|---|---|
| `schema.sql` | Komplettes DB-Schema + pgvector + RPCs (einmal in Supabase ausführen) |
| `scraper/main.ts` | Feed lesen, Artikel extrahieren, Version + Embedding speichern (stündlich) |
| `scraper/signals.ts` | Headless-Browser: erweiterbarer Signal-Beutel (täglich) |
| `scraper/cluster.ts` | Sprachübergreifende Story-Cluster bilden (alle 6 h) |
| `.github/workflows/*` | Geplante Läufe (kostenlos) |

## Einrichtung (in dieser Reihenfolge!)

1. **Supabase-Projekt** anlegen (Region z. B. Frankfurt). `Project URL`, `service_role`-Key und
   `anon`-Key notieren.
2. **Schema** ausführen: Inhalt von `schema.sql` in den Supabase-SQL-Editor kopieren und starten.
   > Wichtig: `vector(1024)` passt zu Cohere Embed v3. Anderes Modell → Dimension in `schema.sql`
   > **und** im Embedding-Aufruf angleichen.
3. **Cohere-Key** holen (oder anderes mehrsprachiges Embedding-Modell; dann `embed()` in
   `scraper/main.ts` anpassen).
4. **Lokal testen:**
   ```bash
   cd scraper
   npm install
   cp ../.env.example ../.env   # Werte eintragen
   set -a && source ../.env && set +a
   npm run scrape
   ```
5. **Cross-Lingual-Test** (der entscheidende Moment): Sobald Artikel aus 2 Sprachen drin sind,
   im Supabase-SQL-Editor prüfen, ob `similar_articles(...)` die deutsche und französische Version
   derselben Story als nahe Treffer findet. Erst wenn das überzeugt, weitermachen.
6. **Cluster + Signale** lokal ausprobieren: `npm run cluster`, dann `npx playwright install chromium`
   und `npm run signals`.
7. **In CI bringen:** Repo zu GitHub pushen, unter *Settings → Secrets and variables → Actions*
   die drei Secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `COHERE_API_KEY`) hinterlegen.
   Die Workflows laufen dann automatisch.

## Neues Signal hinzufügen

In `scraper/signals.ts` eine Zeile in `collectors` ergänzen – z. B.:
```ts
reading_time: (c) => Math.round(c.html.replace(/<[^>]+>/g, "").split(/\s+/).length / 200),
```
Kein Schema-Änderung nötig: alles landet im JSONB-Feld `signals`.

## Reihenfolge der Stufen

1. Scrape + Embedding + `similar_articles` überzeugt → Fundament steht.
2. Cluster + Signale (Paywall/Liveblog/Kommentar/Werbung).
3. Framing/Buzzword-Analyse je Cluster (LLM) + Frontend-Visualisierung.

## Sicherheit & Recht

- `service_role`-Key nur im Scraper, nie im Frontend (dort `anon`-Key + RLS).
- `body_text` nur intern; öffentlich Titel/Teaser kurz + Quelle verlinken.
- `robots.txt`/ToS respektieren, RSS bevorzugen, freundliche Crawl-Rate.
- Kommentar-Signal ist nur an/aus – keine Inhalte, keine Personen.
