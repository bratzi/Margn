-- search_articles -- Volltextsuche fuers Filter-Panel (Metadaten).
--
-- Durchsucht Titel, URL (Rueckwaerts-/Link-Suche), Teaser (description), Thema, Schlagwoerter
-- und Rubriken (categories). Gibt die Treffer-Artikel-IDs zurueck; das Frontend (FilterProvider)
-- verschneidet sie mit dem Keyword-Filter und schraenkt damit Tabelle UND Analytik ein.
--
-- 2026-07-05: Die Suche im Artikelinhalt (article_paras) wurde ENTFERNT -- der dafuer noetige
-- pg_trgm-GIN-Index war 52 MB (DB-Limit 500 MB, s. maintenance.sql) und die RPC lag mit
-- paras-Branch bei ~5 s (> 3-s-anon-Timeout). Ohne paras-Branch reicht der Seq Scan ueber
-- articles (description/topic sind nicht indiziert -- bewusst, kein weiterer Index).

create extension if not exists pg_trgm;
-- url_trgm bleibt: wird vom Sub-Rubriken-Filter genutzt (filterCorpus url.ilike).
create index if not exists ix_articles_url_trgm on public.articles using gin (url gin_trgm_ops);

create or replace function public.search_articles(p_q text, p_sources bigint[] default null, p_limit int default 1200)
returns table(article_id bigint)
language sql stable
set search_path to 'public', 'pg_temp'
set plan_cache_mode to 'force_custom_plan'
as $func$
  select a.id
  from articles a, (select '%' || p_q || '%' as p) pat
  where a.is_article
    and length(p_q) >= 2
    and (p_sources is null or cardinality(p_sources) = 0 or a.source_id = any(p_sources))
    and (
         a.title ilike pat.p
      or a.url ilike pat.p
      or a.description ilike pat.p
      or coalesce(a.topic, '') ilike pat.p
      or exists(select 1 from article_keywords ak join keywords k on k.id = ak.keyword_id where ak.article_id = a.id and k.term ilike pat.p)
      or exists(select 1 from article_categories ac join categories c on c.id = ac.category_id where ac.article_id = a.id and c.name ilike pat.p)
    )
  limit p_limit;
$func$;

grant execute on function public.search_articles(text, bigint[], int) to anon, authenticated;
-- Nach DDL noetig, damit PostgREST die Funktion sieht: notify pgrst, 'reload schema';
