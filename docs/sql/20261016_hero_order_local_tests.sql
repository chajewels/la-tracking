-- ============================================================================
-- Hero order — LOCAL tests for 20261016100000_hero_order.sql. NEVER ON LIVE.
--
-- In an EMPTY throwaway Postgres (stub + 20261006 … 20261012 + stock_qty +
-- 20261013100000 + the website_categories columns the stub lacks, then the
-- migration, then this file). ~/Code/reference/hero-order/run-sql-tests.sh
-- does it all. Every block raises on failure; the last line prints ALL PASSED.
--
-- Owner requirement + decisions, 2026-09-29 (docs/HERO-PICKS.md "Running order").
-- ============================================================================
DO $g$ BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: local throwaway Postgres only (PGOPTIONS=-c cutout.local_stub=yes)';
  END IF;
END $g$;

-- ---------------------------------------------------------------- fixtures
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000a', 'admin'),
                                     ('00000000-0000-0000-0000-00000000000b', 'staff'),
                                     ('00000000-0000-0000-0000-00000000000c', 'staff');
INSERT INTO public.perm VALUES ('00000000-0000-0000-0000-00000000000b', 'manage_website_catalog');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-00000000000a', 'Owner Admin');
INSERT INTO public.website_categories (slug, name, published, sort_order) VALUES
  ('rings', 'Rings', true, 1), ('watches', 'Watches', true, 2), ('hidden', 'Hidden', false, 3), ('empty', 'Empty', true, 4);

CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.uid', p, false) $$;
CREATE FUNCTION pg_temp.admin() RETURNS void LANGUAGE sql AS $$ SELECT pg_temp.as_user('00000000-0000-0000-0000-00000000000a') $$;
CREATE FUNCTION pg_temp.eq(got anyelement, want anyelement, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION '%: got %, want %', what, got, want; END IF;
END $$;
-- Put a cut-out row in a given state (fixture only: the worker's guards are off meanwhile).
CREATE FUNCTION pg_temp.cutout(p text, st text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  ALTER TABLE public.website_media_cutouts DISABLE TRIGGER USER;
  INSERT INTO public.website_media_cutouts (source_url) VALUES (pg_temp.u(p)) ON CONFLICT (source_url) DO NOTHING;
  UPDATE public.website_media_cutouts
     SET status = st, job_state = 'done', cutout_path = 'website/derived/' || md5(p) || '/cutout.webp',
         catalog_small_path = 'website/derived/' || md5(p) || '/catalog-small.webp', cutout_w = 1200, cutout_h = 900
   WHERE source_url = pg_temp.u(p);
  ALTER TABLE public.website_media_cutouts ENABLE TRIGGER USER;
END $$;
-- One product: one variant with stock, photos <sku-lower>.jpg (+ extra), each with an ok cut-out,
-- in the given categories at the given Hub sort_order.
CREATE FUNCTION pg_temp.prod(sku text, st text, stock int, cats text[], sort int, extra text[] DEFAULT '{}') RETURNS void
LANGUAGE plpgsql AS $$
DECLARE v_p uuid; v_v uuid; x text;
BEGIN
  INSERT INTO public.website_products (sku, slug, name, status) VALUES (sku, lower(sku), 'Piece ' || sku, st::public.website_product_status)
  RETURNING id INTO v_p;
  INSERT INTO public.website_product_variants (product_id, stock_qty) VALUES (v_p, stock) RETURNING id INTO v_v;
  FOREACH x IN ARRAY array_prepend(lower(sku) || '.jpg', extra) LOOP
    INSERT INTO public.website_product_media (variant_id, url, sort) VALUES (v_v, pg_temp.u(x), 0);
    PERFORM pg_temp.cutout(x, 'ok');
  END LOOP;
  INSERT INTO public.website_category_products (category_id, product_id, sort_order)
  SELECT c.id, v_p, sort FROM public.website_categories c WHERE c.slug = ANY (cats);
END $$;
-- Tick through set_hero_pick (the real writer), then pin the tick time so the tests control the order.
CREATE FUNCTION pg_temp.tick(p text, mins int) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.admin();
  r := public.set_hero_pick(pg_temp.u(p), true);
  IF r ? 'error' THEN RAISE EXCEPTION 'tick % refused: %', p, r ->> 'error'; END IF;
  PERFORM set_config('app.hero_pick_writer', 'pick', true);
  UPDATE public.website_hero_picks SET picked_at = timestamptz '2026-01-01 00:00+00' + make_interval(mins => mins)
   WHERE source_url = pg_temp.u(p);
  PERFORM set_config('app.hero_pick_writer', '', true);
END $$;
CREATE FUNCTION pg_temp.untick(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT pg_temp.admin(); SELECT public.set_hero_pick(pg_temp.u(p), false); SELECT NULL::void $$;
CREATE FUNCTION pg_temp.stock(sku text, n int) RETURNS void LANGUAGE sql AS
  $$ UPDATE public.website_product_variants SET stock_qty = n
      WHERE product_id = (SELECT id FROM public.website_products WHERE website_products.sku = stock.sku) $$;
-- A slide as the website would show it: the on-hero SKUs in place order, e.g. 'R3,R1,R5'.
CREATE FUNCTION pg_temp.slide(cat text, st text DEFAULT 'on_hero') RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(p.sku, ',' ORDER BY l.place, p.sku), '')
    FROM public.hero_lineup_rows(NULL) l
    JOIN public.website_products p ON p.id = l.product_id
    JOIN public.website_categories c ON c.id = l.category_id
   WHERE c.slug = cat AND l.state = st $$;
CREATE FUNCTION pg_temp.why(sku text) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(DISTINCT l.reason, ',') FROM public.hero_lineup_rows(NULL) l
    JOIN public.website_products p ON p.id = l.product_id WHERE p.sku = why.sku AND l.state = 'not_showing' $$;

-- Rings, Hub order R5, R4, R3, R2, R1 (sort 1..5): the Hub's order is NOT the tick order.
SELECT pg_temp.prod('R1', 'active', 1, ARRAY['rings'], 5), pg_temp.prod('R2', 'active', 1, ARRAY['rings'], 4),
       pg_temp.prod('R3', 'active', 1, ARRAY['rings'], 3), pg_temp.prod('R4', 'active', 1, ARRAY['rings'], 2),
       pg_temp.prod('R5', 'active', 1, ARRAY['rings'], 1);
-- M1: two photos (m1.jpg + m1b.jpg). W1: a watch also listed under rings. X1: only in the hidden category.
SELECT pg_temp.prod('M1', 'active', 1, ARRAY['rings'], 9, ARRAY['m1b.jpg']),
       pg_temp.prod('W1', 'active', 1, ARRAY['watches','rings'], 9),
       pg_temp.prod('X1', 'active', 1, ARRAY['hidden'], 0);

-- ------------------------------------------------ T1. the switch and the site answer on hero_record
DO $t$
BEGIN
  PERFORM pg_temp.eq(public.hero_photo_source(), 'hero_record', 'T1 switch untouched');
  PERFORM pg_temp.tick('r1.jpg', 10);
  PERFORM pg_temp.eq((SELECT count(*) FROM public.hero_cutouts_for_site(ARRAY[pg_temp.u('r1.jpg')])), 0::bigint,
                     'T1 hero_record: a tick is not on the website');
  RAISE NOTICE 'T1 ok: on hero_record the website still sees no tick';
END $t$;

-- ------------------------------------------------ T2. tick order, not Hub order; max 3; extras wait
DO $t$
BEGIN
  -- Ticked R3, R1(already, t10), R5, R2, R4 — R3 ticked first.
  PERFORM pg_temp.tick('r3.jpg', 5), pg_temp.tick('r5.jpg', 20), pg_temp.tick('r2.jpg', 30), pg_temp.tick('r4.jpg', 40);
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R3,R1,R5', 'T2 on the hero: the three oldest ticks');
  PERFORM pg_temp.eq(pg_temp.slide('rings', 'waiting'), 'R2,R4', 'T2 waiting, in tick order');
  PERFORM pg_temp.eq((SELECT string_agg(l.place::text, ',' ORDER BY l.place) FROM public.hero_lineup_rows(NULL) l),
                     '1,2,3,4,5', 'T2 places 1..5');
  PERFORM pg_temp.eq(pg_temp.slide('watches'), '', 'T2 a category with no tick shows none');
  RAISE NOTICE 'T2 ok: oldest tick first, three on the slide, extras wait';
END $t$;

-- ------------------------------------------------ T3. publishing a product never changes the hero
DO $t$
DECLARE c jsonb;
BEGIN
  -- N1: newest, first in the Hub's order (sort 0), usable cut-out, in stock — but not ticked.
  PERFORM pg_temp.prod('N1', 'active', 1, ARRAY['rings','watches'], 0);
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R3,R1,R5', 'T3 rings unchanged');
  PERFORM pg_temp.eq(pg_temp.slide('watches'), '', 'T3 watches: never falls back to an untagged piece');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.hero_lineup_rows(NULL) l JOIN public.website_products p ON p.id = l.product_id
                       WHERE p.sku = 'N1'), 0::bigint, 'T3 N1 is not in the lineup at all');
  c := public.hero_product_counts(NULL);
  PERFORM pg_temp.eq((c ->> 'products_on_hero')::int, 3, 'T3 counts: on the hero = 3 (not 5)');
  PERFORM pg_temp.eq((c ->> 'hero_waiting')::int, 2, 'T3 counts: 2 waiting');
  PERFORM pg_temp.eq((c ->> 'published_in_stock')::int, 9, 'T3 counts: published in stock');
  PERFORM pg_temp.eq((c ->> 'published_left_out')::int, 6, 'T3 counts: left out = in stock minus on the hero');
  RAISE NOTICE 'T3 ok: a new product does not move the hero; counts are the slide, not every tick';
END $t$;

-- ------------------------------------------------ T4. sold drops out, the next tick takes the place; back in stock keeps its place
DO $t$
BEGIN
  PERFORM pg_temp.stock('R1', 0);
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R3,R5,R2', 'T4 R1 sold: R2 (next tick) moves up');
  PERFORM pg_temp.eq(pg_temp.slide('rings', 'waiting'), 'R4', 'T4 R4 still waiting');
  PERFORM pg_temp.eq(pg_temp.why('R1'), 'sold', 'T4 R1 not showing: sold');
  PERFORM pg_temp.stock('R1', 1);
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R3,R1,R5', 'T4 back in stock: R1 keeps its original place (decision d)');
  PERFORM pg_temp.eq(pg_temp.slide('rings', 'waiting'), 'R2,R4', 'T4 R2 back to waiting');
  RAISE NOTICE 'T4 ok: sold drops out, the next tick moves up; back in stock keeps its place';
END $t$;

-- ------------------------------------------------ T5. unpublished drops out; no fallback when the ticks run out
DO $t$
BEGIN
  UPDATE public.website_products SET status = 'draft' WHERE sku = 'R3';
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R1,R5,R2', 'T5 R3 unpublished: R2 moves up');
  PERFORM pg_temp.eq(pg_temp.why('R3'), 'not_published', 'T5 R3 not showing: not published');
  PERFORM pg_temp.stock('R1', 0); PERFORM pg_temp.stock('R5', 0); PERFORM pg_temp.stock('R2', 0); PERFORM pg_temp.stock('R4', 0);
  PERFORM pg_temp.eq(pg_temp.slide('rings'), '', 'T5 every tick gone: the slide is empty, N1 never fills it');
  PERFORM pg_temp.eq((public.hero_product_counts(NULL) ->> 'products_on_hero')::int, 0, 'T5 counts: none on the hero');
  UPDATE public.website_products SET status = 'active' WHERE sku = 'R3';
  PERFORM pg_temp.stock('R1', 1); PERFORM pg_temp.stock('R5', 1); PERFORM pg_temp.stock('R2', 1); PERFORM pg_temp.stock('R4', 1);
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R3,R1,R5', 'T5 restored');
  RAISE NOTICE 'T5 ok: unpublished drops out; no untagged fallback';
END $t$;

-- ------------------------------------------------ T6. untick then tick again = back of the queue
DO $t$
BEGIN
  PERFORM pg_temp.untick('r3.jpg');
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R1,R5,R2', 'T6 unticked R3 leaves');
  PERFORM pg_temp.eq(pg_temp.why('R3'), NULL::text, 'T6 unticked R3 is not in the lineup');
  PERFORM pg_temp.admin();
  PERFORM public.set_hero_pick(pg_temp.u('r3.jpg'), true);   -- a real tick: picked_at = now()
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R1,R5,R2', 'T6 re-ticked R3 does not push anyone off');
  PERFORM pg_temp.eq(pg_temp.slide('rings', 'waiting'), 'R4,R3', 'T6 R3 is at the back of the queue (decision b)');
  RAISE NOTICE 'T6 ok: untick + tick = back of the queue';
END $t$;

-- ------------------------------------------------ T7. several ticked photos: the earliest still-usable one decides
DO $t$
BEGIN
  PERFORM pg_temp.tick('m1.jpg', 1), pg_temp.tick('m1b.jpg', 90);
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'M1,R1,R5', 'T7 M1 takes its place from its earliest tick (t1)');
  -- Its earliest photo's cut-out is rejected: the place now comes from m1b (t90) — the back.
  PERFORM pg_temp.cutout('m1.jpg', 'rejected');
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R1,R5,R2', 'T7 m1 not usable: M1 moves to m1b''s time');
  PERFORM pg_temp.eq(pg_temp.slide('rings', 'waiting'), 'R4,M1,R3', 'T7 M1 now at t90 (R3 was re-ticked later, in T6)');
  PERFORM pg_temp.cutout('m1b.jpg', 'kept_original');
  PERFORM pg_temp.eq(pg_temp.why('M1'), 'cutout_not_usable', 'T7 no usable ticked photo: not showing, with the reason');
  PERFORM pg_temp.cutout('m1.jpg', 'ok'); PERFORM pg_temp.cutout('m1b.jpg', 'ok');
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'M1,R1,R5', 'T7 restored');
  RAISE NOTICE 'T7 ok: earliest usable ticked photo decides (decision a)';
END $t$;

-- ------------------------------------------------ T8. ties (carry-over: one timestamp) in the Hub's category order
DO $t$
BEGIN
  PERFORM pg_temp.untick('m1.jpg'), pg_temp.untick('m1b.jpg'), pg_temp.untick('r3.jpg');
  -- R1..R5 all ticked at the same instant: Hub order is R5 (sort 1), R4, R3, R2, R1.
  PERFORM pg_temp.tick('r3.jpg', 0);
  PERFORM set_config('app.hero_pick_writer', 'pick', false);
  UPDATE public.website_hero_picks SET picked_at = timestamptz '2026-01-01 00:00+00'
   WHERE source_url IN (SELECT pg_temp.u(x) FROM unnest(ARRAY['r1.jpg','r2.jpg','r3.jpg','r4.jpg','r5.jpg']) x);
  PERFORM set_config('app.hero_pick_writer', '', false);
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R5,R4,R3', 'T8 ties follow the Hub order (decision c)');
  -- Same sort_order: then the product name.
  UPDATE public.website_category_products SET sort_order = 7
   WHERE product_id IN (SELECT id FROM public.website_products WHERE sku IN ('R1','R2','R3','R4','R5'));
  PERFORM pg_temp.eq(pg_temp.slide('rings'), 'R1,R2,R3', 'T8 same sort_order: by name');
  RAISE NOTICE 'T8 ok: equal tick times follow the Hub''s category order';
END $t$;

-- ------------------------------------------------ T9. several categories; no published category
DO $t$
BEGIN
  PERFORM pg_temp.tick('w1.jpg', 100), pg_temp.tick('x1.jpg', 101);
  PERFORM pg_temp.eq(pg_temp.slide('watches'), 'W1', 'T9 W1 on the watches slide');
  PERFORM pg_temp.eq(pg_temp.slide('rings', 'waiting'), 'R4,R5,W1', 'T9 W1 waits its turn on the rings slide');
  PERFORM pg_temp.eq((SELECT reason FROM public.hero_lineup_rows(NULL) l JOIN public.website_products p ON p.id = l.product_id
                       WHERE p.sku = 'X1'), 'no_category', 'T9 X1 (hidden category only): no_category');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.hero_lineup_rows(NULL) l
                       JOIN public.website_categories c ON c.id = l.category_id WHERE c.slug = 'hidden'), 0::bigint,
                     'T9 an unpublished category has no slide');
  PERFORM pg_temp.eq((public.hero_product_counts(NULL) ->> 'products_on_hero')::int, 4, 'T9 counts: R1,R2,R3 + W1');
  PERFORM pg_temp.eq((public.hero_product_counts(NULL) ->> 'hero_waiting')::int, 2, 'T9 counts: R4,R5 waiting (W1 is on a slide)');
  RAISE NOTICE 'T9 ok: a piece in two categories is placed per slide; no published category is reported';
END $t$;

-- ------------------------------------------------ T10. the website sees picked_at on product_ticks
DO $t$
DECLARE s jsonb;
BEGIN
  PERFORM pg_temp.admin();
  PERFORM pg_temp.eq(public.set_hero_photo_source('product_ticks', 'hero_record') ->> 'ok', 'true', 'T10 switch');
  SELECT jsonb_object_agg(replace(x.source_url, pg_temp.u(''), ''), x.hero_cutout) INTO s
    FROM public.hero_cutouts_for_site(ARRAY[pg_temp.u('w1.jpg'), pg_temp.u('n1.jpg')]) x;
  PERFORM pg_temp.eq((s -> 'w1.jpg' ->> 'picked_at')::timestamptz, timestamptz '2026-01-01 00:00+00' + interval '100 minutes',
                     'T10 picked_at on a ticked photo');
  PERFORM pg_temp.eq(s ? 'n1.jpg', false, 'T10 an untagged photo: no row');
  PERFORM pg_temp.eq(s -> 'w1.jpg' ->> 'status', 'approved', 'T10 still approved');
  PERFORM pg_temp.eq(public.set_hero_photo_source('hero_record', 'product_ticks') ->> 'ok', 'true', 'T10 switch back');
  RAISE NOTICE 'T10 ok: product_ticks carries picked_at; untagged photos get nothing';
END $t$;

-- ------------------------------------------------ T11. the Hub view: who may read it and what it says
DO $t$
DECLARE v jsonb; r jsonb;
BEGIN
  PERFORM pg_temp.as_user('');
  PERFORM pg_temp.eq(public.get_hero_lineup() ->> 'error', 'user_identity_required', 'T11 anonymous');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  PERFORM pg_temp.eq(public.get_hero_lineup() ->> 'error', 'permission_denied', 'T11 staff without the permission');
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  v := public.get_hero_lineup();
  PERFORM pg_temp.eq(v ? 'error', false, 'T11 staff with manage_website_catalog reads it');
  PERFORM pg_temp.eq((SELECT string_agg(c ->> 'slug', ',' ORDER BY o) FROM jsonb_array_elements(v -> 'categories') WITH ORDINALITY AS a(c, o)),
                     'rings,watches,empty', 'T11 published categories, Hub order, empty ones too');
  r := v -> 'categories' -> 0;
  PERFORM pg_temp.eq((SELECT string_agg(x ->> 'sku', ',' ORDER BY o) FROM jsonb_array_elements(r -> 'on_hero') WITH ORDINALITY AS a(x, o)),
                     'R1,R2,R3', 'T11 rings on the hero');
  PERFORM pg_temp.eq((SELECT string_agg(x ->> 'sku', ',' ORDER BY o) FROM jsonb_array_elements(r -> 'waiting') WITH ORDINALITY AS a(x, o)),
                     'R4,R5,W1', 'T11 rings waiting');
  PERFORM pg_temp.eq(r -> 'on_hero' -> 0 -> 'photo' ->> 'thumb_path', 'website/derived/' || md5('r1.jpg') || '/catalog-small.webp',
                     'T11 the thumbnail is the photo the place comes from');
  PERFORM pg_temp.eq(v -> 'no_category' -> 0 ->> 'sku', 'X1', 'T11 no_category lists X1');
  PERFORM pg_temp.eq((v ->> 'slide_limit')::int, 3, 'T11 slide limit');
  PERFORM pg_temp.stock('R2', 0);
  v := public.get_hero_lineup();
  PERFORM pg_temp.eq(v -> 'categories' -> 0 -> 'not_showing' -> 0 ->> 'reason', 'sold', 'T11 sold is listed with its reason');
  PERFORM pg_temp.stock('R2', 1);
  RAISE NOTICE 'T11 ok: the Hub view — per category on the hero / waiting / not showing';
END $t$;

-- ------------------------------------------------ T12. the carry-over preview counts extra photos as ticked now (after every tick)
DO $t$
DECLARE c jsonb;
BEGIN
  PERFORM pg_temp.untick('r1.jpg'), pg_temp.untick('r2.jpg');
  c := public.hero_product_counts(ARRAY[pg_temp.u('n1.jpg'), pg_temp.u('r1.jpg')]);
  -- rings: R3,R4,R5 (t0) stay on; N1 / R1 would be ticked now → wait. watches: W1 then N1 → both on.
  PERFORM pg_temp.eq((c ->> 'products_on_hero')::int, 5, 'T12 preview on the hero: R3,R4,R5,W1,N1');
  PERFORM pg_temp.eq((c ->> 'hero_waiting')::int, 1, 'T12 preview waiting: R1');
  PERFORM pg_temp.eq((SELECT count(*) FROM public.website_hero_picks WHERE source_url = pg_temp.u('n1.jpg')), 0::bigint,
                     'T12 the preview writes nothing');
  RAISE NOTICE 'T12 ok: the carry-over preview places new ticks after the existing ones';
END $t$;

-- ------------------------------------------------ T13. grants
DO $t$
BEGIN
  PERFORM pg_temp.eq(has_function_privilege('authenticated', 'public.hero_lineup_rows(text[])', 'EXECUTE'), false, 'T13 lineup rows: not the browser');
  PERFORM pg_temp.eq(has_function_privilege('service_role', 'public.hero_lineup_rows(text[])', 'EXECUTE'), true, 'T13 lineup rows: service role');
  PERFORM pg_temp.eq(has_function_privilege('anon', 'public.get_hero_lineup()', 'EXECUTE'), false, 'T13 Hub view: not anon');
  PERFORM pg_temp.eq(has_function_privilege('authenticated', 'public.hero_cutouts_for_site(text[])', 'EXECUTE'), false, 'T13 site fn: not the browser');
  RAISE NOTICE 'T13 ok: grants';
END $t$;

DO $done$ BEGIN RAISE NOTICE 'hero_order local tests: ALL PASSED'; END $done$;
