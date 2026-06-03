-- NewsScraper / EU-Medienobservatorium – Datenbankschema
-- Im Supabase-SQL-Editor einmal komplett ausführen.

create extension if not exists vector;

-- Quellen inkl. Land + Sprache
create table sources (
  id        bigint generated always as identity primary key,
  name      text not null,
  base_url  text not null,
  feed_url  text,
  country   text,
  language  text,
  active    boolean default true,
  created_at timestamptz default now()
);

-- Ein Artikel = eine eindeutige URL
create table articles (
  id           bigint generated always as identity primary key,
  source_id    bigint references sources(id),
  url          text not null unique,
  first_seen   timestamptz default now(),
  last_seen    timestamptz default now(),
  published_at timestamptz,
  is_article   boolean default true
  -- last_seen wird bei jedem Crawl aktualisiert, sobald der Artikel wieder verlinkt/erreicht wird.
  -- Artikel mit altem last_seen sind aus der Seite "abgefallen" (nicht mehr verlinkt).
);

-- Versionshistorie + Embedding + erweiterbarer Signal-Beutel
create table article_versions (
  id         bigint generated always as identity primary key,
  article_id bigint references articles(id) on delete cascade,
  scanned_at timestamptz default now(),
  title      text,
  teaser     text,
  body_hash  text,
  body_text  text,                  -- intern; öffentlich NICHT anzeigen
  changed    boolean default false,
  embedding  vector(1024),          -- Dimension an Embedding-Modell anpassen!
  signals    jsonb                  -- erweiterbar: paywalled, has_comments, is_liveblog, ad_signal, body_chars, ...
);

-- Dimensionen
create table keywords   (id bigint generated always as identity primary key, term text unique);
create table authors    (id bigint generated always as identity primary key, name text unique);
create table categories (id bigint generated always as identity primary key, name text unique);

create table article_keywords   (article_id bigint references articles(id) on delete cascade,
                                  keyword_id bigint references keywords(id),  primary key(article_id, keyword_id));
create table article_authors    (article_id bigint references articles(id) on delete cascade,
                                  author_id  bigint references authors(id),   primary key(article_id, author_id));
create table article_categories (article_id bigint references articles(id) on delete cascade,
                                  category_id bigint references categories(id), primary key(article_id, category_id));

-- Sprachübergreifende Story-Cluster
create table story_clusters (
  id         bigint generated always as identity primary key,
  created_at timestamptz default now(),
  label      text
);
create table article_clusters (
  cluster_id bigint references story_clusters(id) on delete cascade,
  article_id bigint references articles(id) on delete cascade,
  similarity real,
  primary key (cluster_id, article_id)
);

-- Indizes
create index on article_versions (article_id, scanned_at desc);
create index on article_versions using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index on article_versions using gin (signals);
create index on articles (source_id, last_seen desc);

-- RPC: sprachübergreifende Ähnlichkeitssuche
-- DISTINCT ON article_id: pro Artikel nur die nächstgelegene Version, sonst verdrängen
-- mit der Zeit die vielen Eigen-Versionen eines Artikels echte Nachbarn.
create or replace function similar_articles(query_embedding vector(1024), match_count int)
returns table (article_id bigint, similarity real)
language sql stable as $$
  select t.article_id, t.similarity
  from (
    select distinct on (av.article_id)
      av.article_id,
      1 - (av.embedding <=> query_embedding) as similarity
    from article_versions av
    where av.embedding is not null
    order by av.article_id, av.embedding <=> query_embedding
  ) t
  order by t.similarity desc
  limit match_count;
$$;

-- RPC: Artikel, die noch keinem Cluster zugeordnet sind (aber ein Embedding haben)
create or replace function unclustered_articles(lim int)
returns table (article_id bigint)
language sql stable as $$
  select a.id
  from articles a
  where not exists (select 1 from article_clusters ac where ac.article_id = a.id)
    and exists (select 1 from article_versions av where av.article_id = a.id and av.embedding is not null)
  order by a.last_seen desc
  limit lim;
$$;

-- Beispielquellen (mehrsprachig!)
insert into sources (name, base_url, feed_url, country, language) values
  ('Tagesschau', 'https://www.tagesschau.de', 'https://www.tagesschau.de/index~rss2.xml', 'DE', 'de'),
  ('Le Monde',   'https://www.lemonde.fr',    'https://www.lemonde.fr/rss/une.xml',       'FR', 'fr');
