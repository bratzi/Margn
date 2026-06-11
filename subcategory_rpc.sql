-- Sub-Kategorie-Optionen: gibt alle Kategorien-Strings zurück,
-- die bei Artikeln eines bestimmten Topics vorkommen, inkl. Artikel-Anzahl.
-- In Supabase SQL-Editor ausführen (einmalig).
create or replace function subcategory_opts_f(
  p_sources  int[]         default null,
  p_topic    text          default null,
  p_paywall  text          default null,
  p_author   text          default null,
  p_lang     text          default null,
  p_from     timestamptz   default null,
  p_to       timestamptz   default null
)
returns table(subcategory text, n bigint)
language sql stable
as $$
  select
    c.name         as subcategory,
    count(distinct a.id) as n
  from articles a
  join categories c         on c.id in (
      select ac2.category_id from article_categories ac2 where ac2.article_id = a.id
  )
  where
    (p_sources is null or a.source_id = any(p_sources))
    and (p_topic  is null or a.topic   = p_topic)
    and (p_paywall is null or (p_paywall = 'yes' and a.paywalled = true) or (p_paywall = 'no' and a.paywalled = false))
    and (p_author  is null or a.author_status = p_author)
    and (p_lang    is null or a.lang_detected = p_lang)
    and (p_from    is null or a.published_at >= p_from)
    and (p_to      is null or a.published_at <= p_to)
  group by c.name
  order by n desc
  limit 100;
$$;

grant execute on function subcategory_opts_f to anon;
