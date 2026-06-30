-- search_articles -- Vollumfassende Volltextsuche fuers Filter-Panel.
--
-- Durchsucht JEDE Eigenschaft eines Artikels: Titel, URL (Rueckwaerts-/Link-Suche), Teaser
-- (description), Thema, Schlagwoerter, Rubriken (categories) UND den Artikelinhalt selbst
-- (article_paras.paras -- die gespeicherten Absaetze; article_versions.body_text ist quasi leer).
-- Gibt die Treffer-Artikel-IDs zurueck; das Frontend (FilterProvider) verschneidet sie mit dem
-- Keyword-Filter und schraenkt damit Tabelle UND Analytik ein (wie der Keyword-Filter).
--
-- Performance: ILIKE '%q%' ueber alle Absaetze ist ohne Index ~7,5 s (anon-Timeout 3 s). Daher
-- pg_trgm-GIN-Indizes (s.u.) -> ~1 s. 'force_custom_plan' erzwingt pro Aufruf den Trgm-Plan.

create extension if not exists pg_trgm;
create index if not exists ix_article_paras_trgm on public.article_paras using gin ((paras::text) gin_trgm_ops);
create index if not exists ix_articles_title_trgm  on public.articles using gin (title gin_trgm_ops);
create index if not exists ix_articles_url_trgm    on public.articles using gin (url   gin_trgm_ops);

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
      or exists(select 1 from article_paras p where p.article_id = a.id and p.paras::text ilike pat.p)
    )
  limit p_limit;
$func$;

grant execute on function public.search_articles(text, bigint[], int) to anon, authenticated;
-- Nach DDL noetig, damit PostgREST die Funktion sieht: notify pgrst, 'reload schema';
