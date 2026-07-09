-- Sichtungs-Protokoll: minutengenaue Aggregate je Quelle — „wie viele Artikel-Links hat
-- der Crawl in dieser Minute verlinkt/gelistet gesehen?" (je Lauf zählt jede URL 1×).
-- Grundlage der „Zuletzt gesehen"-Achse im Dashboard: echte Crawl-Ereignisse mit
-- Rampen/Plateaus statt last_seen-Überschreibung (die frühere Sichtungen verliert).
-- ~150 Zeilen je Lauf; der Scraper räumt >35 Tage selbst ab. Einmal in Supabase ausführen.

create table if not exists sightings (
  id        bigint generated always as identity primary key,
  source_id int not null references sources(id) on delete cascade,
  minute    timestamptz not null,
  n         int not null
);

create index if not exists sightings_src_minute_idx on sightings (source_id, minute desc);
create index if not exists sightings_minute_idx on sightings (minute);

alter table sightings enable row level security;

-- Frontend (anon) liest; schreiben darf nur der Service-Key (RLS gilt für ihn nicht).
drop policy if exists "sightings read" on sightings;
create policy "sightings read" on sightings for select using (true);

-- Gebündelter Abruf fürs Dashboard: Minuten-, Stunden- oder Tages-Körnung, Summe je Quelle.
-- Stunden-Körnung hält den Egress klein (30 Tage ≈ 3,6k Zeilen statt 108k).
-- 'day' bucketet nach BERLIN-Tagen (der Zeitstrahl rechnet in Europe/Berlin) und
-- liefert die Berlin-Mitternacht als timestamptz zurück (~300 Zeilen je 30 Tage).
create or replace function sighting_buckets(p_from timestamptz, p_to timestamptz, p_gran text default 'hour')
returns table (source_id int, bucket timestamptz, n bigint)
language sql stable as $$
  select s.source_id,
         case when p_gran = 'minute' then date_trunc('minute', s.minute)
              when p_gran = 'day' then date_trunc('day', s.minute at time zone 'Europe/Berlin') at time zone 'Europe/Berlin'
              else date_trunc('hour', s.minute) end as bucket,
         sum(s.n)::bigint as n
  from sightings s
  where s.minute >= p_from and s.minute <= p_to
  group by 1, 2
  order by 2;
$$;

grant execute on function sighting_buckets(timestamptz, timestamptz, text) to anon;
