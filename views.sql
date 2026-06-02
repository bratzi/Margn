-- Zusätzliche Views & Policies für die Frontend-Komponenten.
-- Nach schema.sql ausführen.

-- 1) Geänderte Überschriften: je Artikel die aktuelle (geänderte) Version + die direkt davorliegende.
--    Liefert vorher/nachher-Paare für den Diff-Viewer.
create or replace view headline_edits as
with ranked as (
  select
    av.id,
    av.article_id,
    av.title,
    av.teaser,
    av.scanned_at,
    av.changed,
    a.url,
    a.first_seen,
    s.name     as outlet,
    s.country,
    s.language,
    lag(av.title)  over (partition by av.article_id order by av.scanned_at) as prev_title,
    lag(av.teaser) over (partition by av.article_id order by av.scanned_at) as prev_teaser
  from article_versions av
  join articles a on a.id = av.article_id
  join sources  s on s.id = a.source_id
)
select
  id, article_id, url, outlet, country, language,
  prev_title as before_title,
  title      as after_title,
  prev_teaser as before_teaser,
  teaser      as after_teaser,
  first_seen,
  scanned_at,
  -- Minuten zwischen Erstsichtung und dieser Änderung
  round(extract(epoch from (scanned_at - first_seen)) / 60.0)::int as delay_minutes
from ranked
where changed = true and prev_title is not null;

-- 2) Echo-Zeitleiste: alle Artikel eines Clusters mit Erstsichtung, Ähnlichkeit und
--    Minuten-Versatz zum frühesten Artikel des Clusters.
create or replace view cluster_echoes as
with members as (
  select
    ac.cluster_id,
    ac.article_id,
    ac.similarity,
    a.first_seen,
    coalesce(a.published_at, a.first_seen) as ts,   -- published_at bevorzugen, sonst first_seen
    s.name as outlet,
    s.country,
    s.language
  from article_clusters ac
  join articles a on a.id = ac.article_id
  join sources  s on s.id = a.source_id
),
origins as (
  select cluster_id, min(ts) as origin_ts from members group by cluster_id
)
select
  m.cluster_id,
  m.article_id,
  m.outlet,
  m.country,
  m.language,
  round(m.similarity * 100)::int as similarity_pct,
  m.ts,
  (o.origin_ts = m.ts) as is_origin,
  round(extract(epoch from (m.ts - o.origin_ts)) / 60.0)::int as offset_minutes
from members m
join origins o on o.cluster_id = m.cluster_id
order by m.cluster_id, m.ts;

-- 3) Nur-Lese-Zugriff fürs Frontend (anon-Key). body_text bleibt außen vor,
--    weil die Views ihn nicht selektieren.
alter table sources           enable row level security;
alter table articles          enable row level security;
alter table article_versions  enable row level security;
alter table story_clusters    enable row level security;
alter table article_clusters  enable row level security;

create policy "read sources"   on sources          for select using (true);
create policy "read articles"  on articles         for select using (true);
create policy "read versions"  on article_versions for select using (true);
create policy "read clusters"  on story_clusters   for select using (true);
create policy "read aclusters" on article_clusters for select using (true);
