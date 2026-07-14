-- keyword_trends -- Themen-Brisanz im Zeitverlauf (Server-Aggregation).
--
-- Liefert pro Schlagwort EINE Zeile: Gesamtzahl + Tages-Zeitreihe (Berlin-Tagesgrenzen)
-- als kompaktes jsonb-Array [{d:'YYYY-MM-DD', n:int}, ...], gebuendelt auf die Top-N
-- haeufigsten Begriffe im Zeitraum. Die Auswertung (Anstieg/Abfall, Momentum, Steigung,
-- Spike/z-Score, Sparkline) passiert clientseitig auf dieser kompakten Reihe.
--
-- Warum pro-Term-Aggregation statt (term, tag)-Zeilen: PostgREST kappt jede Antwort bei
-- 1000 Zeilen. 400 Begriffe x bis 90 Tage sprengen das -> Daten gingen verloren. Pro Term
-- eine Zeile (<= p_limit) bleibt unter dem Limit und spart Egress.
--
-- Performance: NICHT ueber die View page_overview gehen (LEFT JOIN articles<->pages ueber
-- die TEXT-Spalte url -> statement_timeout 57014 bei 96k article_keywords). Stattdessen
-- erst die Basistabelle articles filtern (indiziert), dann auf article_keywords joinen.
-- 'set plan_cache_mode = force_custom_plan' erzwingt pro Aufruf einen Custom-Plan -- sonst
-- waehlt der generische Plan einen Seq-Scan und laeuft in den anon-Timeout (3s).
--
-- Alle Artikel mit Keywords sind is_article=true (news/liveblog) -> der ptype-Filter des
-- Corpus (kein Video/Werbung/Hub) ist hier ohne pages-Join erfuellt. Sprache haengt an der
-- Quelle (sources.language).
--
-- Zeit = axisTime (deckt sich mit lib/filterCorpus.ts + TimeRangeFilter-Histogramm):
--   'seen' -> coalesce(last_seen, first_seen), sonst published_at mit first_seen-Fallback.

-- Fix 2026-07-15: p_status/p_changed/p_depth ergaenzt (scan_count/revision_count/word_count --
-- Spalten von articles, die die arts-CTE ohnehin schon scannt, kein neuer Join/Index noetig).
-- Vorher wich die "Erwaehnungen"-Zahl je Begriff von der tatsaechlichen Artikelzahl nach Klick
-- auf /articles?keyword=X ab, sobald "Erfassung"/"Nachtraeglich geaendert"/"Artikel-Tiefe" aktiv
-- war -- gleiches Muster wie keyword_opts_f (Keyword-Wolke in der Uebersicht). linkState/subcats/
-- Volltextsuche bleiben aus Performance-Gruenden aussen vor (pages-Join bzw. Textsuche, siehe oben).
drop function if exists public.keyword_trends(bigint[], timestamptz, timestamptz, text, text[], text, text, text, int);

create function public.keyword_trends(
  p_sources bigint[]    default null,
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_axis    text        default 'published',
  p_topics  text[]      default null,
  p_paywall text        default null,
  p_author  text        default null,
  p_lang    text        default null,
  p_limit   int         default 300,
  p_status  text        default null,
  p_changed text        default null,
  p_depth   text        default null
) returns table(term text, total int, series jsonb)
language sql stable
set search_path to 'public', 'pg_temp'
set plan_cache_mode to 'force_custom_plan'
as $func$
  with arts as (
    select a.id,
           (case when p_axis = 'seen'
                 then coalesce(a.last_seen, a.first_seen)
                 else coalesce(a.published_at, a.first_seen) end) as t
    from articles a
    join sources s on s.id = a.source_id
    where a.is_article is true
      and (p_sources is null or cardinality(p_sources)=0 or a.source_id = any(p_sources))
      and (p_topics  is null or cardinality(p_topics)=0 or a.topic = any(p_topics))
      and (p_paywall is null or (p_paywall='yes' and a.paywalled) or (p_paywall='no' and not a.paywalled))
      and (p_author  is null or a.author_status = p_author)
      and (p_lang    is null or s.language = p_lang)
      and (p_status  is null or (p_status='new' and coalesce(a.scan_count,1) <= 1) or (p_status='rescanned' and coalesce(a.scan_count,1) >= 2))
      and (p_changed is null or (p_changed='yes' and coalesce(a.revision_count,0) >= 1) or (p_changed='no' and coalesce(a.revision_count,0) = 0))
      and (p_depth   is null or (p_depth='kurz' and a.word_count > 0 and a.word_count < 300)
                             or (p_depth='mittel' and a.word_count >= 300 and a.word_count <= 900)
                             or (p_depth='lang' and a.word_count > 900))
  ),
  arts_f as (
    select id, t from arts
    where t is not null
      and (p_from is null or t >= p_from)
      and (p_to   is null or t <= p_to)
  ),
  rows as (
    select k.term as term, (af.t at time zone 'Europe/Berlin')::date as bucket
    from arts_f af
    join article_keywords ak on ak.article_id = af.id
    join keywords k          on k.id = ak.keyword_id
  ),
  bucketed as (
    select term, bucket, count(*)::int as n
    from rows
    group by term, bucket
  ),
  totals as (
    select term, sum(n)::int as total
    from bucketed
    group by term
    order by sum(n) desc, term
    limit p_limit
  )
  -- jsonb_agg NUR fuer die Top-N Begriffe (ein GROUP BY, kein korrelierter Subquery -> schnell).
  select tt.term,
         tt.total,
         jsonb_agg(jsonb_build_object('d', b.bucket, 'n', b.n) order by b.bucket) as series
  from totals tt
  join bucketed b on b.term = tt.term
  group by tt.term, tt.total
  order by tt.total desc, tt.term;
$func$;

grant execute on function public.keyword_trends(bigint[], timestamptz, timestamptz, text, text[], text, text, text, int, text, text, text)
  to anon, authenticated;
