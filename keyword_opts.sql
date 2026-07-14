-- keyword_opts_f — Schlagwort-Optionen fürs Filter-Dropdown (Top 80 im Filtersatz).
--
-- Fix 2026-07-09: Die Ur-Fassung joinete die View page_overview (LEFT JOIN articles<->pages
-- über die TEXT-Spalte url). Mit übergebener Themenliste (Standard seit dem Regional-Toggle:
-- TOPICS_SANS_REGIONAL) kippte der Plan in einen Seq-Scan -> statement_timeout 57014 (3 s,
-- anon) bei JEDEM Dashboard-Load -> Dropdown leer. Gleiches Muster wie keyword_trends.sql:
-- erst die Basistabelle articles filtern (indiziert, is_article=true deckt den ptype-Filter
-- des Corpus ab), dann auf article_keywords joinen; force_custom_plan erzwingt pro Aufruf
-- einen passenden Plan. Einmal in Supabase ausführen.
--
-- Fix 2026-07-09 (Forts.): trotzdem weiter 57014-Timeouts, sobald die Pipeline lief. Gemessen
-- (explain analyze, buffers) waren es drei Posten:
--   1. Bitmap Heap Scan auf articles: 4.077 Heap-Blöcke NUR um `id` zu holen und `is_article`
--      zu prüfen — articles ist mit ~1,3 KB/Zeile sehr breit. `articles_pub_isart_idx` trägt
--      source_id nicht, deshalb wählte der Planer articles_source_pub_idx und musste in den Heap.
--   2. Seq-Scan über alle 19.376 keywords + Hash-Join über 50.242 Zeilen — nur um am Ende
--      80 Terme auszugeben.
--   3. Der Join auf sources war ausschließlich für den (meist leeren) p_lang-Filter da.
-- Warm 100 ms, unter Pipeline-Last 3,1–3,6 s (alles „shared hit" → reine CPU-Contention, kein I/O).
--
-- Kur: (a) Deckungs-Index (source_id, published_at, id) WHERE is_article -> Index Only Scan,
-- articles-Buffer 4.179 -> 2.493, Kosten 5.149 -> 1.584. (b) NACH keyword_id gruppieren (int)
-- statt nach term (text) und keywords erst für die 80 Sieger per PK nachschlagen. (c) sources
-- nur noch per EXISTS, wenn p_lang gesetzt ist. Ergebnis identisch (verifiziert per EXCEPT über
-- zwei Parameterkombis), warm 100 -> 60 ms, End-to-End über anon 200–625 ms statt Timeout.
--
-- Fix 2026-07-15: p_status/p_changed/p_depth ergänzt (scan_count/revision_count/word_count —
-- alles Spalten von articles, die die arts-CTE ohnehin schon scannt, also OHNE neuen Join/Index).
-- Vorher zeigte die Zahl neben jedem Keyword-Pill (f.keywordOpts) einen anderen Filtersatz als
-- die Tabelle: die RPC kannte nur sources/topics/paywall/author/lang/Zeitraum, NICHT „Erfassung"/
-- „Nachträglich geändert"/„Artikel-Tiefe" — sobald einer dieser drei aktiv war, wich die Pill-Zahl
-- von der tatsächlichen Trefferzahl nach Klick ab. linkState/subcats/Volltextsuche bleiben
-- bewusst außen vor (brauchen pages-Join bzw. Textsuche → teurer, gleiches Timeout-Risiko wie
-- oben dokumentiert) — bei aktivem Online-Bestand- oder Rubrik-Filter kann die Pill-Zahl also
-- weiterhin abweichen.

create or replace function public.keyword_opts_f(
  p_sources integer[]   default null,
  p_topics  text[]      default null,
  p_paywall text        default null,
  p_author  text        default null,
  p_lang    text        default null,
  p_from    timestamptz default null,
  p_to      timestamptz default null,
  p_status  text        default null,
  p_changed text        default null,
  p_depth   text        default null
) returns table(term text, n int)
language sql stable
set search_path to 'public', 'pg_temp'
set plan_cache_mode to 'force_custom_plan'
as $func$
  with arts as (
    select a.id
    from articles a
    where a.is_article is true
      and (p_sources is null or cardinality(p_sources)=0 or a.source_id = any(p_sources))
      and (p_topics  is null or cardinality(p_topics)=0 or a.topic = any(p_topics))
      and (p_paywall is null or (p_paywall='yes' and a.paywalled) or (p_paywall='no' and not a.paywalled))
      and (p_author  is null or a.author_status = p_author)
      -- kein JOIN: ohne p_lang fällt der sources-Zugriff komplett weg
      and (p_lang    is null or exists (select 1 from sources s where s.id = a.source_id and s.language = p_lang))
      and (p_from    is null or a.published_at >= p_from)
      and (p_to      is null or a.published_at <= p_to)
      and (p_status  is null or (p_status='new' and coalesce(a.scan_count,1) <= 1) or (p_status='rescanned' and coalesce(a.scan_count,1) >= 2))
      and (p_changed is null or (p_changed='yes' and coalesce(a.revision_count,0) >= 1) or (p_changed='no' and coalesce(a.revision_count,0) = 0))
      and (p_depth   is null or (p_depth='kurz' and a.word_count > 0 and a.word_count < 300)
                             or (p_depth='mittel' and a.word_count >= 300 and a.word_count <= 900)
                             or (p_depth='lang' and a.word_count > 900))
  ),
  -- Erst nach keyword_id (int) gruppieren und auf 80 kappen; keywords.term wird NUR für die
  -- Sieger nachgeschlagen. keywords.term ist UNIQUE -> Gruppierung nach id == nach term.
  agg as (
    select ak.keyword_id, count(*)::int as n
    from article_keywords ak
    join arts af on af.id = ak.article_id
    group by ak.keyword_id
    order by n desc
    limit 80
  )
  select k.term, agg.n
  from agg join keywords k on k.id = agg.keyword_id
  order by agg.n desc, k.term;
$func$;

grant execute on function public.keyword_opts_f(integer[], text[], text, text, text, timestamptz, timestamptz, text, text, text)
  to anon, authenticated;

-- Deckungs-Indizes für den arts-CTE: liefern (source_id, published_at, id) direkt aus dem Index,
-- partiell auf is_article -> kein Heap-Zugriff auf die breiten articles-Zeilen nötig.
-- Rest-„Heap Fetches" entstehen nur, weil der Scraper articles laufend updatet (last_seen) und
-- die Visibility Map daher selten all-visible ist; Autovacuum drückt sie.
create index if not exists articles_kwopt_idx
  on articles (source_id, published_at, id) where is_article is true;
-- Gegenstück ohne Quellenfilter (p_sources is null): published_at führt.
create index if not exists articles_kwopt_nosrc_idx
  on articles (published_at, id) where is_article is true;

-- Vorgänger, vom Deckungs-Index abgelöst (published_at ohne id -> immer Heap-Zugriff):
--   articles_pub_isart_idx on articles (published_at) where is_article is true;
