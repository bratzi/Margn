-- article_context.sql — Detailseite: Einordnung, Radar-Schatten und Nachbar-DF server-seitig.
--
-- HINTERGRUND: Die Detailseite zog je Aufruf ~30 KB Peer-Zeilen der Quelle UND ~30 KB des Themas
-- und rechnete Perzentil/Median im Browser. Das war doppelt teuer (Egress) UND falsch: PostgREST
-- deckelt serverseitig bei 1.000 UNGEORDNETEN Zeilen → die Statistik lief auf einer willkürlichen
-- Scheibe. Diese RPC rechnet über ALLE Peers (percentile_cont) und liefert ~300 Byte.
--
-- Peer-Korpus = Artikel-Seiten der Quelle (p.kind='article'); das ist deckungsgleich mit dem
-- ALLOWED_PTYPES-Filter des restlichen Frontends (artikel/paywall/timeline gehen alle aus
-- p.kind='article' hervor, s. page_overview-Definition).
--
-- Einmal in Supabase ausführen (nach linked_from.sql). Idempotent.

-- HINWEIS zur Perf: `src` ist MATERIALIZED — der pages↔articles-Join (über den Index
-- pages(source_id, kind)) läuft dann EINMAL, alle Perzentile lesen das kleine Zwischenergebnis
-- (~750 ms für 6.500 Peers statt ~5 s). Der frühere Themen-Vergleich (Länge quer über ALLE
-- Blätter) ist bewusst RAUS: er scannte ohne topic-Index den Gesamtkorpus (~6 s) und verglich
-- Outlet-übergreifend Äpfel mit Birnen. Ein topic-Index wäre bei 483/500 MB der falsche Preis.
create or replace function public.article_context(p_article_id bigint, p_source_id bigint, p_topic text)
returns table (
  len_src_pct   int, len_src_n   int, len_src_med   int,
  edit_pct      int, edit_n      int, edit_med      int,
  edited_share  numeric,
  -- Median-Rohwerte der Quelle für den Radar-Schatten (gleich normalisiert wie der Artikel im Frontend)
  peer_wc numeric, peer_rev numeric, peer_lag_h numeric, peer_vis_d numeric, peer_ext_share numeric, peer_depth numeric
)
language sql
stable
security definer
set search_path = public
as $fn$
  with self as (
    select a.word_count wc, coalesce(a.revision_count, 0) rev
    from articles a where a.id = p_article_id
  ),
  src as materialized (  -- Korpus der Quelle (pages-getrieben über den (source_id,kind)-Index)
    select a.word_count, coalesce(a.revision_count,0) rev, coalesce(a.extension_count,0) ext,
           coalesce(a.edit_count,0) edit, a.published_at, a.modified_at, a.first_seen,
           p.last_seen link_seen, p.depth
    from pages p
    join articles a on a.url = p.url
    where p.source_id = p_source_id and p.kind = 'article'
  ),
  srcwc as (select word_count wc from src where word_count is not null),
  edited as (select rev from src where rev >= 1)
  select
    -- Umfang vs. Quelle: Anteil Peers strikt kürzer, Deckel 99 (der Artikel steckt selbst mit drin)
    least(99, coalesce((select round(100.0 * count(*) filter (where wc < (select wc from self)) / greatest(count(*),1)) from srcwc), 0))::int,
    (select count(*) from srcwc)::int,
    (select round(percentile_cont(0.5) within group (order by wc)) from srcwc)::int,
    -- Bearbeitung innerhalb der bearbeiteten Artikel
    least(99, coalesce((select round(100.0 * count(*) filter (where rev < (select rev from self)) / greatest(count(*),1)) from edited), 0))::int,
    (select count(*) from edited)::int,
    (select round(percentile_cont(0.5) within group (order by rev)) from edited)::int,
    -- Anteil je bearbeiteter Artikel der Quelle (nur ab 8 Peers aussagekräftig)
    (select case when count(*) >= 8 then round((count(*) filter (where rev >= 1))::numeric / count(*), 4) end from src),
    -- Radar-Mediane
    (select percentile_cont(0.5) within group (order by wc) from srcwc),
    (select percentile_cont(0.5) within group (order by rev) from src),
    (select percentile_cont(0.5) within group (order by extract(epoch from (modified_at - published_at))/3600.0)
       from src where modified_at is not null and published_at is not null and modified_at > published_at),
    (select percentile_cont(0.5) within group (order by extract(epoch from (link_seen - first_seen))/86400.0)
       from src where link_seen is not null and first_seen is not null and link_seen > first_seen),
    (select percentile_cont(0.5) within group (order by ext::numeric / nullif(ext + edit, 0))
       from src where (ext + edit) > 0),
    (select percentile_cont(0.5) within group (order by depth) from src where depth is not null);
$fn$;

grant execute on function public.article_context(bigint, bigint, text) to anon, authenticated;

-- Eigenes Timeout: die anon-Rolle hat statement_timeout=3s. Kalt (Buffer-Cache leer) kann die
-- große Quelle 2–14 s brauchen; warm ~1 s. Ohne diese Anhebung würde der erste Besuch nach
-- Leerlauf abgeschnitten → Einordnung/Radar-Schatten leer. SECURITY-DEFINER-Funktionen dürfen das.
alter function public.article_context(bigint, bigint, text) set statement_timeout = '12s';

-- Dokumentfrequenz je Schlagwort in EINER Abfrage (ersetzt bis zu 24 Einzel-COUNTs der Nachbarn).
create or replace function public.keyword_dfs(ids bigint[])
returns table (keyword_id bigint, df bigint)
language sql
stable
security definer
set search_path = public
as $fn$
  select keyword_id, count(*)::bigint df
  from article_keywords
  where keyword_id = any(ids)
  group by keyword_id;
$fn$;

grant execute on function public.keyword_dfs(bigint[]) to anon, authenticated;
alter function public.keyword_dfs(bigint[]) set statement_timeout = '8s';
