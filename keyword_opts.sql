-- keyword_opts_f — Schlagwort-Optionen fürs Filter-Dropdown (Top 80 im Filtersatz).
--
-- Fix 2026-07-09: Die Ur-Fassung joinete die View page_overview (LEFT JOIN articles<->pages
-- über die TEXT-Spalte url). Mit übergebener Themenliste (Standard seit dem Regional-Toggle:
-- TOPICS_SANS_REGIONAL) kippte der Plan in einen Seq-Scan -> statement_timeout 57014 (3 s,
-- anon) bei JEDEM Dashboard-Load -> Dropdown leer. Gleiches Muster wie keyword_trends.sql:
-- erst die Basistabelle articles filtern (indiziert, is_article=true deckt den ptype-Filter
-- des Corpus ab), dann auf article_keywords joinen; force_custom_plan erzwingt pro Aufruf
-- einen passenden Plan. Einmal in Supabase ausführen.

create or replace function public.keyword_opts_f(
  p_sources integer[]   default null,
  p_topics  text[]      default null,
  p_paywall text        default null,
  p_author  text        default null,
  p_lang    text        default null,
  p_from    timestamptz default null,
  p_to      timestamptz default null
) returns table(term text, n int)
language sql stable
set search_path to 'public', 'pg_temp'
set plan_cache_mode to 'force_custom_plan'
as $func$
  with arts as (
    select a.id
    from articles a
    join sources s on s.id = a.source_id
    where a.is_article is true
      and (p_sources is null or cardinality(p_sources)=0 or a.source_id = any(p_sources))
      and (p_topics  is null or cardinality(p_topics)=0 or a.topic = any(p_topics))
      and (p_paywall is null or (p_paywall='yes' and a.paywalled) or (p_paywall='no' and not a.paywalled))
      and (p_author  is null or a.author_status = p_author)
      and (p_lang    is null or s.language = p_lang)
      and (p_from    is null or a.published_at >= p_from)
      and (p_to      is null or a.published_at <= p_to)
  )
  select k.term, count(*)::int as n
  from arts af
  join article_keywords ak on ak.article_id = af.id
  join keywords k          on k.id = ak.keyword_id
  group by k.term
  order by 2 desc
  limit 80;
$func$;

grant execute on function public.keyword_opts_f(integer[], text[], text, text, text, timestamptz, timestamptz)
  to anon, authenticated;

-- Stützt den arts-CTE (Seq-Scan über articles kostete unter Pipeline-Last >3 s):
-- partiell auf den Corpus-relevanten Teil, Zeitfenster ist immer Teil des Aufrufs.
create index if not exists articles_pub_isart_idx on articles (published_at) where is_article is true;
