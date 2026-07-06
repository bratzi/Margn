-- Re-Scan-Stufe „noch verlinkt" (Art. 207366: 12 Tage ungescannt trotz Startseiten-Platzierung).
--
-- Semantik: pages.last_seen = zuletzt VERLINKT GESEHEN (die Discovery bumpt es bei jeder
-- Sichtung eines Artikel-Links in Sitemap/Startseite/Ressorts — scraper/main.ts),
-- articles.last_seen = zuletzt GESCANNT. Die altersgestaffelten Re-Scan-Stufen enden am
-- RESCAN_DAYS-Horizont; was der Verlag darüber hinaus noch verlinkt, holte niemand zurück —
-- und die 30-Tage-Retention (maintenance.sql, articles.last_seen) hätte solche lebendigen
-- Artikel am Ende sogar gelöscht. Diese Funktion liefert: kürzlich noch verlinkt gesehen,
-- aber Scan überfällig — Überfälligstes zuerst.
--
-- Deploy: über die Management-API ausführen, danach: notify pgrst, 'reload schema';
create or replace function public.linked_stale_articles(
  src_ids bigint[], seen_since timestamptz, due_before timestamptz, lim int
) returns table (url text, source_id bigint)
language sql stable
set search_path to 'public'
as $$
  select a.url, a.source_id
  from articles a
  join pages p on p.url = a.url
  where a.source_id = any(src_ids)
    and a.title is not null
    and p.kind = 'article'
    and p.last_seen >= seen_since
    and a.last_seen <= due_before
  order by a.last_seen asc
  limit lim;
$$;

-- Nur der Scraper (service_role) braucht sie.
revoke execute on function public.linked_stale_articles(bigint[], timestamptz, timestamptz, int) from anon, authenticated;
