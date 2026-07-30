-- linked_from.sql — Fundstellen je Artikel: WO wird er verlinkt geführt?
--
-- HINTERGRUND: `pages.last_seen` (in den Views als `link_seen`) sagt nur, DASS ein Artikel
-- zuletzt irgendwo verlinkt gesehen wurde — nie wo. Damit blieb der Online-Bestand ein
-- Indizienschluss aus Zeitablauf: „seit X Stunden nicht gesehen" ⇒ vermutlich rausgeflogen.
-- Die Zuordnung Hub → Artikel liegt beim Crawl längst vor und wurde bisher weggeworfen
-- (scraper/main.ts: ensureNodes, Feed-Pfad, harvestSitemaps).
--
-- BEWUSST KEINE Kanten-Tabelle: `page_links` war mit ~915k Zeilen / ~100 MB der schnellste
-- DB-Größen-Treiber und wurde stillgelegt (s. maintenance.sql). Stattdessen je Artikel eine
-- auf 6 Einträge gedeckelte jsonb-Liste, die pro Lauf KOMPLETT ersetzt wird — sie beschreibt
-- immer den aktuellen Stand und wächst daher nicht. Geschätzt 15–25 MB für den Gesamtkorpus.
--
-- Form: [{"u": "/politik/", "k": "section", "t": "2026-07-24T12:00:00.000Z"}, …]
--   u = Pfad der Fundstelle (relativ zur base_url der Quelle — spart Platz)
--   k = home | section | feed | sitemap
--   t = Zeitpunkt der Sichtung in diesem Lauf
--
-- Einmal in Supabase (SQL Editor) ausführen. Idempotent.

-- 1) Spalte -------------------------------------------------------------------------------
alter table articles add column if not exists linked_from jsonb;

comment on column articles.linked_from is
  'Fundstellen: wo dieser Artikel zuletzt verlinkt geführt wurde. Pro Crawl-Lauf ersetzt, max. 6.';

-- 2) Schreib-RPC für den Scraper ----------------------------------------------------------
-- Absichtlich UPDATE statt UPSERT: ein Upsert würde für jeden verlinkten, aber nie gerenderten
-- Pfad eine leere Artikelzeile anlegen und den Korpus aufblähen. Nur bestehende Zeilen werden
-- angefasst; unbekannte URLs fallen still durch.
create or replace function public.apply_link_refs(p jsonb)
returns void
language sql
security definer
set search_path = public
as $fn$
  update articles a
     set linked_from = e.refs
    from (
      select x->>'url' as url, x->'refs' as refs
      from jsonb_array_elements(p) as x
    ) e
   where a.url = e.url;
$fn$;

-- Schreibrechte strikt beim Scraper (Service-Key). Das Frontend liest nur.
revoke all on function public.apply_link_refs(jsonb) from public;
revoke all on function public.apply_link_refs(jsonb) from anon, authenticated;
grant execute on function public.apply_link_refs(jsonb) to service_role;

-- 3) Lese-RPC fürs Frontend ----------------------------------------------------------------
-- Die Detailseite holt die Fundstellen einzeln statt über die View `article_detail` — so muss
-- deren Definition nicht angefasst werden. Liefert ausschließlich linked_from, kein Volltext.
create or replace function public.article_link_refs(p_article_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(a.linked_from, '[]'::jsonb) from articles a where a.id = p_article_id;
$fn$;

grant execute on function public.article_link_refs(bigint) to anon, authenticated;
