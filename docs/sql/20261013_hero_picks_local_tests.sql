-- ============================================================================
-- Hero picks — LOCAL tests for 20261013100000_hero_picks.sql. NEVER ON LIVE.
--
-- In an EMPTY throwaway Postgres (stub + 20261006 + 20261007 + 20261009 +
-- 20261010 + 20261011 + 20261012 + a stock_qty column the stub lacks, then the
-- migration, then this file). ~/Code/reference/hero-picks/run-sql-tests.sh
-- does it all. Every block raises on failure; the last line prints ALL PASSED.
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;

-- ---------------------------------------------------------------- fixtures
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000a', 'admin'),
                                     ('00000000-0000-0000-0000-00000000000b', 'staff');
INSERT INTO public.perm VALUES ('00000000-0000-0000-0000-00000000000b', 'manage_website_catalog');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-00000000000a', 'Owner Admin');
INSERT INTO public.website_products (id, sku, slug, name, status) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'PUB',   'pub',   'Published ring',        'active'),
  ('b0000000-0000-0000-0000-000000000002', 'DRAFT', 'draft', 'Draft ring',            'draft'),
  ('b0000000-0000-0000-0000-000000000003', 'PUB2',  'pub2',  'Published, no tick',    'active'),
  ('b0000000-0000-0000-0000-000000000004', 'OUT',   'out',   'Published, sold out',   'active');
INSERT INTO public.website_product_variants (id, product_id, stock_qty) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 1),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 1),
  ('d0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000003', 2),
  ('d0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000004', 0);

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.uid', p, false) $$;
CREATE FUNCTION pg_temp.admin() RETURNS void LANGUAGE sql AS $$ SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a') $$;
CREATE FUNCTION pg_temp.staff() RETURNS void LANGUAGE sql AS $$ SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000b') $$;
CREATE FUNCTION pg_temp.photo(variant text, p text) RETURNS void LANGUAGE sql AS
  $$ INSERT INTO public.website_product_media (variant_id, url, sort) VALUES (variant::uuid, pg_temp.u(p), 0) $$;
-- Put a cut-out row in a given state (fixture only: the worker's guards are off meanwhile).
CREATE FUNCTION pg_temp.cutout(p text, st text, with_file boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  ALTER TABLE public.website_media_cutouts DISABLE TRIGGER USER;
  INSERT INTO public.website_media_cutouts (source_url) VALUES (pg_temp.u(p)) ON CONFLICT (source_url) DO NOTHING;
  UPDATE public.website_media_cutouts
     SET status = st, job_state = 'done',
         cutout_path = CASE WHEN with_file THEN 'website/derived/' || md5(p) || '/r1-' || left(md5(p || 'k'), 8) || '/cutout.webp' END,
         cutout_w = CASE WHEN with_file THEN 1200 END, cutout_h = CASE WHEN with_file THEN 900 END
   WHERE source_url = pg_temp.u(p);
  ALTER TABLE public.website_media_cutouts ENABLE TRIGGER USER;
END $$;
-- A hero record (the storefront workflow's), fixture only.
CREATE FUNCTION pg_temp.hero(p text, st text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app.hero_cutout_writer', 'record', false);
  INSERT INTO public.website_hero_cutouts (source_url, source_sha256, status, qa_status, cutout_path, width, height, model)
  VALUES (pg_temp.u(p), md5(p) || md5(p), st, 'ok',
          'website/derived/hero/' || md5(p) || '/' || left(md5(p), 8) || '/cutout.webp', 800, 600, 'birefnet-general');
  PERFORM set_config('app.hero_cutout_writer', '', false);
END $$;
CREATE FUNCTION pg_temp.refused(sql text, frag text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN OTHERS THEN
    IF position(frag IN SQLERRM) = 0 THEN RAISE EXCEPTION 'refused for the wrong reason: % (wanted %)', SQLERRM, frag; END IF;
    RETURN;
  END;
  RAISE EXCEPTION 'not refused: %', sql;
END $$;
CREATE FUNCTION pg_temp.eq(got anyelement, want anyelement, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION '%: got %, want %', what, got, want; END IF;
END $$;
CREATE FUNCTION pg_temp.site(VARIADIC ps text[]) RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_object_agg(replace(s.source_url, pg_temp.u(''), ''), s.hero_cutout), '{}'::jsonb)
    FROM public.hero_cutouts_for_site(ARRAY(SELECT pg_temp.u(x) FROM unnest(ps) x)) s $$;

-- PUB: a ok, b approved, k kept original, r rejected, n needs review, f ok but no file, h hero-only
-- DRAFT: d ok (product not published)    PUB2: c ok (no hero record)    OUT: o ok (sold out)
SELECT pg_temp.photo('d0000000-0000-0000-0000-000000000001', x) FROM unnest(ARRAY['a.jpg','b.jpg','k.jpg','r.jpg','n.jpg','f.jpg','h.jpg']) x;
SELECT pg_temp.photo('d0000000-0000-0000-0000-000000000002', 'd.jpg');
SELECT pg_temp.photo('d0000000-0000-0000-0000-000000000003', 'c.jpg');
SELECT pg_temp.photo('d0000000-0000-0000-0000-000000000004', 'o.jpg');
SELECT pg_temp.cutout('a.jpg', 'ok', true), pg_temp.cutout('b.jpg', 'approved', true), pg_temp.cutout('k.jpg', 'kept_original', false),
       pg_temp.cutout('r.jpg', 'rejected', true), pg_temp.cutout('n.jpg', 'needs_review', true), pg_temp.cutout('f.jpg', 'ok', false),
       pg_temp.cutout('d.jpg', 'ok', true), pg_temp.cutout('c.jpg', 'ok', true), pg_temp.cutout('o.jpg', 'auto_fixed', true);
SELECT pg_temp.hero('a.jpg', 'approved'), pg_temp.hero('b.jpg', 'approved'), pg_temp.hero('k.jpg', 'approved'),
       pg_temp.hero('d.jpg', 'approved'), pg_temp.hero('n.jpg', 'approved'), pg_temp.hero('r.jpg', 'needs_review'),
       pg_temp.hero('h.jpg', 'rejected'), pg_temp.hero('f.jpg', 'ok');

-- ------------------------------------------------ T1. nothing changed on the website
DO $t$
DECLARE s jsonb;
BEGIN
  PERFORM pg_temp.eq(public.hero_photo_source(), 'hero_record', 'T1 switch seeded');
  s := pg_temp.site('a.jpg', 'b.jpg', 'c.jpg', 'r.jpg', 'h.jpg', 'f.jpg');
  -- today's answer: the hero record's own files and states, nothing for c (no record) or f (waiting)
  PERFORM pg_temp.eq(s -> 'a.jpg' ->> 'path', 'website/derived/hero/' || md5('a.jpg') || '/' || left(md5('a.jpg'), 8) || '/cutout.webp', 'T1 a from the hero record');
  PERFORM pg_temp.eq(s -> 'r.jpg' ->> 'status', 'held', 'T1 r held');
  PERFORM pg_temp.eq(s -> 'h.jpg' ->> 'status', 'rejected', 'T1 h rejected');
  PERFORM pg_temp.eq(s ? 'c.jpg' OR s ? 'f.jpg', false, 'T1 no record → no row');
  RAISE NOTICE 'T1 ok: seeded hero_record; the site function answers as before';
END $t$;

-- ------------------------------------------------ T2. who may tick
DO $t$
BEGIN
  PERFORM pg_temp.as_user('');
  PERFORM pg_temp.eq(public.set_hero_pick(pg_temp.u('a.jpg'), true) ->> 'error', 'user_identity_required', 'T2 anonymous');
  PERFORM pg_temp.staff();
  PERFORM pg_temp.eq(public.set_hero_pick(pg_temp.u('a.jpg'), true) ->> 'error', 'admin_only', 'T2 staff tick');
  PERFORM pg_temp.eq(public.hero_picks_carry_over(false) ->> 'error', 'admin_only', 'T2 staff carry-over');
  PERFORM pg_temp.eq(public.set_hero_photo_source('product_ticks', NULL) ->> 'error', 'admin_only', 'T2 staff switch');
  -- staff with manage_website_catalog still READS the lists
  PERFORM pg_temp.eq(public.list_media_cutouts('hero') ? 'error', false, 'T2 staff reads the hero list');
  PERFORM pg_temp.eq((public.get_media_cutout_tab_totals() ->> 'hero_photo_source'), 'hero_record', 'T2 staff reads the switch');
  RAISE NOTICE 'T2 ok: admin only for ticks, carry-over and the switch; staff can read';
END $t$;

-- ------------------------------------------------ T3. the tick and its reasons
DO $t$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.admin();
  PERFORM pg_temp.eq(public.set_hero_pick(pg_temp.u('k.jpg'), true) ->> 'error', 'kept_original',  'T3 kept original');
  PERFORM pg_temp.eq(public.set_hero_pick(pg_temp.u('r.jpg'), true) ->> 'error', 'rejected',       'T3 rejected');
  PERFORM pg_temp.eq(public.set_hero_pick(pg_temp.u('n.jpg'), true) ->> 'error', 'not_completed',  'T3 needs review');
  PERFORM pg_temp.eq(public.set_hero_pick(pg_temp.u('f.jpg'), true) ->> 'error', 'no_cutout_file', 'T3 no file');
  PERFORM pg_temp.eq(public.set_hero_pick(pg_temp.u('d.jpg'), true) ->> 'error', 'not_published',  'T3 unpublished');
  PERFORM pg_temp.eq(public.set_hero_pick(pg_temp.u('zz.jpg'), true) ->> 'error', 'not_found',     'T3 unknown photo');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.website_hero_picks), 0::bigint, 'T3 refusals write nothing');
  r := public.set_hero_pick(pg_temp.u('a.jpg'), true);
  PERFORM pg_temp.eq((r ->> 'changed')::boolean, true, 'T3 tick a');
  r := public.set_hero_pick(pg_temp.u('a.jpg'), true);
  PERFORM pg_temp.eq((r ->> 'changed')::boolean, false, 'T3 tick a again: no change');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.audit_logs WHERE action = 'set_hero_pick:tick'), 1::bigint, 'T3 one audit row');
  PERFORM pg_temp.eq((SELECT performed_by_user_id::text FROM public.audit_logs WHERE action = 'set_hero_pick:tick'),
                     '00000000-0000-0000-0000-00000000000a', 'T3 audited under the admin');
  PERFORM pg_temp.eq((SELECT picked_via || '/' || picked_by FROM public.website_hero_picks),
                     'tick/00000000-0000-0000-0000-00000000000a', 'T3 the row');
  r := public.set_hero_pick(pg_temp.u('a.jpg'), false);
  PERFORM pg_temp.eq((r ->> 'changed')::boolean, true, 'T3 untick');
  r := public.set_hero_pick(pg_temp.u('a.jpg'), false);
  PERFORM pg_temp.eq((r ->> 'changed')::boolean, false, 'T3 untick again: no change');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.audit_logs WHERE action LIKE 'set_hero_pick:%'), 2::bigint, 'T3 two audit rows');
  RAISE NOTICE 'T3 ok: unusable photos refused with the reason; tick / untick once each, audited';
END $t$;

-- ------------------------------------------------ T4. no other writer
DO $t$
BEGIN
  PERFORM pg_temp.refused(format($$INSERT INTO public.website_hero_picks (source_url, picked_via) VALUES (%L, 'tick')$$, pg_temp.u('a.jpg')),
                          'written only from the Hub');
  PERFORM pg_temp.refused($$UPDATE public.system_settings SET value = '"product_ticks"' WHERE key = 'hero_photo_source'$$,
                          'switched only from the Hub');
  PERFORM pg_temp.refused($$DELETE FROM public.system_settings WHERE key = 'hero_photo_source'$$, 'switched only from the Hub');
  RAISE NOTICE 'T4 ok: direct writes to the ticks and the switch are refused';
END $t$;

-- ------------------------------------------------ T5. carry-over: preview, apply, apply again
DO $t$
DECLARE p jsonb; a jsonb; calls bigint := (SELECT count(*) FROM net.calls);
BEGIN
  PERFORM pg_temp.admin();
  p := public.hero_picks_carry_over(false);
  PERFORM pg_temp.eq((p ->> 'approved_hero')::int, 5, 'T5 approved hero records (a b k d n)');
  PERFORM pg_temp.eq((p ->> 'to_tick')::int, 2, 'T5 a and b carry over');
  PERFORM pg_temp.eq(p -> 'left_out', '{"kept_original": 1, "not_completed": 1, "not_published": 1}'::jsonb, 'T5 left out, why');
  PERFORM pg_temp.eq(p -> 'products_now', '{"products_on_hero": 0, "published_left_out": 2, "published_in_stock": 2}'::jsonb, 'T5 now');
  PERFORM pg_temp.eq(p -> 'products_after', '{"products_on_hero": 1, "published_left_out": 1, "published_in_stock": 2}'::jsonb, 'T5 after');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.website_hero_picks), 0::bigint, 'T5 the preview writes nothing');
  a := public.hero_picks_carry_over(true);
  PERFORM pg_temp.eq((a ->> 'ticked')::int, 2, 'T5 applied');
  PERFORM pg_temp.eq((SELECT string_agg(replace(source_url, pg_temp.u(''), '') || ':' || picked_via, ',' ORDER BY source_url)
                        FROM public.website_hero_picks), 'a.jpg:carry_over,b.jpg:carry_over', 'T5 the ticks');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.audit_logs WHERE action = 'hero_picks_carry_over'), 1::bigint, 'T5 one audit row');
  a := public.hero_picks_carry_over(true);
  PERFORM pg_temp.eq((a ->> 'ticked')::int, 0, 'T5 second press ticks nothing');
  PERFORM pg_temp.eq((a ->> 'already_ticked')::int, 2, 'T5 second press sees them');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.website_hero_picks), 2::bigint, 'T5 no duplicates');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.audit_logs WHERE action = 'hero_picks_carry_over'), 1::bigint, 'T5 no second audit row');
  PERFORM pg_temp.eq((SELECT count(*) FROM net.calls), calls, 'T5 on hero_record nothing is revalidated');
  PERFORM pg_temp.eq(pg_temp.site('a.jpg') -> 'a.jpg' ->> 'path',
                     'website/derived/hero/' || md5('a.jpg') || '/' || left(md5('a.jpg'), 8) || '/cutout.webp',
                     'T5 the website still shows the hero record');
  RAISE NOTICE 'T5 ok: preview = apply; apply twice ticks once; audited once; the website unchanged';
END $t$;

-- ------------------------------------------------ T6. the switch
DO $t$
DECLARE r jsonb; calls bigint := (SELECT count(*) FROM net.calls);
BEGIN
  PERFORM pg_temp.admin();
  PERFORM pg_temp.eq(public.set_hero_photo_source('nonsense', NULL) ->> 'error', 'invalid_source', 'T6 invalid');
  PERFORM pg_temp.eq(public.set_hero_photo_source('product_ticks', 'product_ticks') ->> 'error', 'stale', 'T6 stale screen');
  r := public.set_hero_photo_source('product_ticks', 'hero_record');
  PERFORM pg_temp.eq((r ->> 'changed')::boolean, true, 'T6 flipped');
  PERFORM pg_temp.eq(public.hero_photo_source(), 'product_ticks', 'T6 reads product_ticks');
  PERFORM pg_temp.eq((SELECT count(*) FROM net.calls), calls + 1, 'T6 the flip revalidates once');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.audit_logs WHERE action = 'set_hero_photo_source'
                         AND performed_by_user_id = '00000000-0000-0000-0000-00000000000a'), 1::bigint, 'T6 audited');
  r := public.set_hero_photo_source('product_ticks', 'product_ticks');
  PERFORM pg_temp.eq((r ->> 'changed')::boolean, false, 'T6 same value: no change');
  RAISE NOTICE 'T6 ok: admin, stale-safe, audited, revalidates';
END $t$;

-- ------------------------------------------------ T7. product_ticks on the website
DO $t$
DECLARE s jsonb; calls bigint;
BEGIN
  PERFORM pg_temp.admin();
  s := pg_temp.site('a.jpg', 'b.jpg', 'c.jpg', 'k.jpg', 'r.jpg', 'h.jpg', 'n.jpg');
  PERFORM pg_temp.eq(s, jsonb_build_object(
      'a.jpg', jsonb_build_object('status','approved','path','website/derived/' || md5('a.jpg') || '/r1-' || left(md5('a.jpgk'), 8) || '/cutout.webp','width',1200,'height',900),
      'b.jpg', jsonb_build_object('status','approved','path','website/derived/' || md5('b.jpg') || '/r1-' || left(md5('b.jpgk'), 8) || '/cutout.webp','width',1200,'height',900)),
    'T7 only the ticked product cut-outs; no hero-record rows, no held/rejected');
  calls := (SELECT count(*) FROM net.calls);
  PERFORM public.set_hero_pick(pg_temp.u('c.jpg'), true);
  PERFORM pg_temp.eq((SELECT count(*) FROM net.calls), calls + 1, 'T7 a tick revalidates once');
  PERFORM pg_temp.eq(pg_temp.site('c.jpg') ? 'c.jpg', true, 'T7 c on the site');
  -- unpublish PUB: its ticks stay but leave the website; publish again: back
  UPDATE public.website_products SET status = 'draft' WHERE sku = 'PUB';
  PERFORM pg_temp.eq(pg_temp.site('a.jpg', 'b.jpg'), '{}'::jsonb, 'T7 unpublished → off the hero');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.website_hero_picks), 3::bigint, 'T7 the ticks are kept');
  UPDATE public.website_products SET status = 'active' WHERE sku = 'PUB';
  PERFORM pg_temp.eq(pg_temp.site('a.jpg', 'b.jpg') ?& ARRAY['a.jpg','b.jpg'], true, 'T7 published again → back');
  -- a ticked cut-out that is rejected later leaves the hero, the tick stays (to be unticked)
  ALTER TABLE public.website_media_cutouts DISABLE TRIGGER USER;
  UPDATE public.website_media_cutouts SET status = 'rejected' WHERE source_url = pg_temp.u('b.jpg');
  ALTER TABLE public.website_media_cutouts ENABLE TRIGGER USER;
  PERFORM pg_temp.eq(pg_temp.site('b.jpg'), '{}'::jsonb, 'T7 rejected later → off the hero');
  RAISE NOTICE 'T7 ok: ticked + usable only; publish / reject follow';
END $t$;

-- ------------------------------------------------ T8. lists and totals
DO $t$
DECLARE l jsonb; t jsonb; row_b jsonb;
BEGIN
  PERFORM pg_temp.staff();
  l := public.list_media_cutouts('hero');
  PERFORM pg_temp.eq((l ->> 'total')::int, 3, 'T8 hero filter lists every tick (a b c)');
  SELECT x INTO row_b FROM jsonb_array_elements(l -> 'rows') x WHERE x ->> 'source_url' = pg_temp.u('b.jpg');
  PERFORM pg_temp.eq(row_b ->> 'hero_pick_blocker', 'rejected', 'T8 b says why it is off the hero');
  PERFORM pg_temp.eq((row_b ->> 'hero_pick')::boolean, true, 'T8 b is still ticked');
  l := public.list_media_cutouts('all');
  PERFORM pg_temp.eq((SELECT count(*) FROM jsonb_array_elements(l -> 'rows') x WHERE (x ->> 'hero_pick')::boolean), 3::bigint, 'T8 flags on all');
  PERFORM pg_temp.eq((SELECT x ->> 'hero_pick_blocker' FROM jsonb_array_elements(l -> 'rows') x WHERE x ->> 'source_url' = pg_temp.u('k.jpg')),
                     'kept_original', 'T8 k blocker');
  PERFORM pg_temp.eq(EXISTS (SELECT 1 FROM jsonb_array_elements(l -> 'rows') x WHERE x ->> 'source_url' = pg_temp.u('d.jpg')), false,
                     'T8 all still lists published products only');
  PERFORM pg_temp.eq((public.list_media_cutouts('bogus') ->> 'error'), 'invalid_filter', 'T8 unknown filter');
  t := public.get_media_cutout_tab_totals();
  PERFORM pg_temp.eq(t -> 'tabs' -> 'hero', '{"count": 3, "usable": 2, "paid_calls": 0, "products_on_hero": 2, "published_left_out": 0, "published_in_stock": 2}'::jsonb,
                     'T8 hero tab totals');
  PERFORM pg_temp.eq(t ->> 'hero_photo_source', 'product_ticks', 'T8 switch value');
  PERFORM pg_temp.eq((t -> 'tabs' -> 'all' ->> 'count')::int, 9, 'T8 other tabs unchanged (9 published photos)');
  RAISE NOTICE 'T8 ok: hero filter, flags, blockers, Hero tab totals';
END $t$;

-- ------------------------------------------------ T9. a cut-out row that goes takes its tick with it
DO $t$
BEGIN
  ALTER TABLE public.website_media_cutouts DISABLE TRIGGER USER;
  DELETE FROM public.website_media_cutouts WHERE source_url = pg_temp.u('c.jpg');
  ALTER TABLE public.website_media_cutouts ENABLE TRIGGER USER;
  PERFORM pg_temp.eq((SELECT count(*) FROM public.website_hero_picks WHERE source_url = pg_temp.u('c.jpg')), 0::bigint, 'T9 cascade');
  PERFORM pg_temp.refused(format($$DELETE FROM public.website_hero_picks WHERE source_url = %L$$, pg_temp.u('a.jpg')),
                          'written only from the Hub');
  RAISE NOTICE 'T9 ok: the cascade works; a direct delete does not';
END $t$;

-- ------------------------------------------------ T10. back to hero_record = today again
DO $t$
DECLARE s jsonb;
BEGIN
  PERFORM pg_temp.admin();
  PERFORM public.set_hero_photo_source('hero_record', 'product_ticks');
  s := pg_temp.site('a.jpg', 'r.jpg', 'h.jpg', 'c.jpg');
  PERFORM pg_temp.eq(s -> 'a.jpg' ->> 'path', 'website/derived/hero/' || md5('a.jpg') || '/' || left(md5('a.jpg'), 8) || '/cutout.webp', 'T10 a from the record');
  PERFORM pg_temp.eq(s -> 'r.jpg' ->> 'status', 'held', 'T10 r held');
  PERFORM pg_temp.eq(s ? 'c.jpg', false, 'T10 c nothing');
  RAISE NOTICE 'T10 ok: switching back restores today''s answer';
END $t$;

DO $d$ BEGIN RAISE NOTICE 'hero_picks local tests: ALL PASSED'; END $d$;
