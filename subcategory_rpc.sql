-- Sub-Rubriken (verlagseigene Ressorts) innerhalb eines kanonischen Topics.
-- Liefert die häufigsten Kategorie-Strings der Artikel, die zum gewählten Topic gehören,
-- inkl. Artikel-Anzahl und Anzahl beteiligter Quellen (für "quellenübergreifend"-Hinweis).
--
-- Datenlage: nur ~26% der Artikel tragen überhaupt eine Kategorie und es gibt ~540
-- verschiedene (viele Einzel-Dossiers). Darum: NUR mit gesetztem p_topic abfragen,
-- Mindesthäufigkeit p_min filtern Rauschen weg, Ausgabe auf Top-N begrenzt.
--
-- In Supabase SQL-Editor ausführen (einmalig).
create or replace function subcategory_opts_f(
  p_sources  int[]         default null,
  p_topic    text          default null,
  p_paywall  text          default null,
  p_author   text          default null,
  p_lang     text          default null,
  p_from     timestamptz   default null,
  p_to       timestamptz   default null,
  p_min      int           default 3
)
returns table(subcategory text, n bigint, sources bigint)
language sql stable
as $$
  select
    c.name                       as subcategory,
    count(distinct a.id)         as n,
    count(distinct a.source_id)  as sources
  from articles a
  join article_categories ac on ac.article_id = a.id
  join categories c          on c.id = ac.category_id
  where
    p_topic is not null
    and a.topic = p_topic
    and (p_sources is null or a.source_id = any(p_sources))
    and (p_paywall is null or (p_paywall = 'yes' and a.paywalled = true) or (p_paywall = 'no' and a.paywalled = false))
    and (p_author  is null or a.author_status = p_author)
    and (p_lang    is null or a.lang_detected = p_lang)
    and (p_from    is null or a.published_at >= p_from)
    and (p_to      is null or a.published_at <= p_to)
  group by c.name
  having count(distinct a.id) >= p_min
  order by n desc
  limit 24;
$$;

grant execute on function subcategory_opts_f to anon;
