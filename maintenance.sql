-- maintenance.sql — Größen-Begrenzung, damit die Supabase-DB im Free-Tier (500 MB) bleibt.
-- Einmal in Supabase ausführen (nach schema.sql/views.sql). Läuft danach täglich per pg_cron.
--
-- HINTERGRUND: Die DB lief Ende Juni 2026 auf 410/500 MB. Hauptursache war die write-only
-- Kanten-Tabelle `page_links` (≈915k Zeilen / ~100 MB, nirgends gelesen) + ein toter 33-MB-
-- ivfflat-Embedding-Index auf `article_versions` (Feature ungenutzt). Beides entfernt → 278 MB.
-- Damit es DAUERHAFT im Free-Tier bleibt (Korpus wächst ~10 MB/Tag, WM-Volumen), diese Retention:
--   (1) Karteileichen wegräumen: nie geänderte Artikel, die seit >30 Tagen nicht mehr gesehen
--       wurden (2026-07-05 von 45 auf 30 verschärft — bei ~2.200 Artikeln/Tag passt 45 T nicht
--       dauerhaft in 500 MB). ON DELETE CASCADE entfernt paras/keywords/authors/categories/
--       snapshots mit. ALLE jemals geänderten Artikel (≥1 Snapshot) bleiben für immer — Kern-Wert.
--   (2) Dauer-Ticker/Liveblogs deckeln: je Artikel nur die 60 jüngsten Extension-Snapshots
--       behalten (ein offener n-tv-Ticker hatte 571 → reine Re-Segmentierungs-Wiederholung).
--   (3) 2026-08-03: Diff-Payload (added/changes) von Snapshots >14 T verwerfen — der größte,
--       unbegrenzt wachsende Treiber (snapshots-TOAST 119 MB). Chronik-Zeile bleibt.
--   (4) 2026-08-03: article_paras dormanter Artikel (>30 T) löschen — nur Diff-Arbeitsstand.

create or replace function public.prune_db() returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- (1) Nie geänderte, alte Artikel löschen (Kinder via CASCADE).
  delete from articles a
  where a.last_seen < now() - interval '30 days'
    and not exists (select 1 from article_snapshots s where s.article_id = a.id);

  -- (2) Extension-Snapshots je Artikel auf die 60 jüngsten kappen.
  delete from article_snapshots s
  using (
    select id, row_number() over (partition by article_id order by captured_at desc) rn
    from article_snapshots where change_kind = 'extension'
  ) r
  where s.id = r.id and r.rn > 60;

  -- (3) NEU 2026-08-03: Diff-Payload (added/changes) alter Snapshots verwerfen. Das war die
  -- größte, UNBEGRENZT wachsende Leak-Quelle: article_snapshots-TOAST lief auf 119 MB (die
  -- Volltext-Deltas jeder je erfassten Änderung). Die Chronik-ZEILE bleibt (Zeitpunkt, Titel-
  -- Änderung, Wortbilanz, Einstufung); nur der Volltext-Diff von Änderungen älter als 14 Tage
  -- entfällt. Das Frontend zeigt dafür einen „archiviert"-Hinweis. Fenster bewusst knapp (14 T),
  -- weil bei ~483/500 MB kein VACUUM-FULL-Headroom für ein größeres Fenster bleibt.
  update article_snapshots
     set added = null, changes = null
   where captured_at < now() - interval '14 days'
     and (added is not null or changes is not null);

  -- (4) NEU 2026-08-03: Diff-Arbeitsstand (article_paras) dormanter Artikel verwerfen — die
  -- gespeicherten Absätze braucht nur der NÄCHSTE Scan zum Diffen. Wird ein Artikel nach >30 T
  -- doch wieder gescannt, re-baselined er sauber (kein Falsch-Diff). Deckelt den paras-TOAST.
  delete from article_paras p
   using articles a
   where a.id = p.article_id and a.last_seen < now() - interval '30 days';
end;
$fn$;

-- WICHTIG: prune_db ist SECURITY DEFINER (löscht an RLS vorbei). EXECUTE für public/anon/
-- authenticated entziehen, sonst könnte jeder per /rest/v1/rpc/prune_db die Löschung auslösen.
-- Nur der Owner (= pg_cron-Job) ruft sie auf.
revoke execute on function public.prune_db() from public, anon, authenticated;

-- Täglich um 03:17 UTC. cron.schedule ist idempotent (upsert nach jobname).
create extension if not exists pg_cron;
select cron.schedule('prune-db-daily', '17 3 * * *', 'select public.prune_db()');

-- Einmal sofort anwenden:
select public.prune_db();
