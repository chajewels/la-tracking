-- ============================================================================
-- Hero cut-outs — LOCAL tests for 20261009100000_hero_cutouts.sql.
-- NEVER ON LIVE. Runs on the media-cutouts local stub (it drops schema public):
--
--   initdb -D /tmp/herocut --locale=C -E UTF8 -U postgres
--   pg_ctl -D /tmp/herocut -o "-p 55472 -k /tmp" start
--   export PGOPTIONS='-c cutout.local_stub=yes'
--   P="psql -h /tmp -p 55472 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20261005_media_cutouts_local_stub.sql
--   $P supabase/migrations/20261006100000_media_cutouts.sql        # Photoroom, to prove it is untouched
--   $P supabase/migrations/20261007100000_media_cutout_photoroom.sql
--   $P supabase/migrations/20261009100000_hero_cutouts.sql
--   $P supabase/migrations/20261009100000_hero_cutouts.sql         # re-run is safe
--   $P docs/sql/20261009_hero_cutouts_local_tests.sql
--
-- Every block raises on failure; the last line prints ALL PASSED.
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
-- b: staff WITH manage_website_catalog (may look, may not decide); c: staff without it.
INSERT INTO public.perm VALUES ('00000000-0000-0000-0000-00000000000b', 'manage_website_catalog');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-00000000000a', 'Owner Admin');
INSERT INTO public.website_products (id, sku, slug, name, status) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'C0853', 'c0853', 'Bvlgari watch', 'active'),
  ('b0000000-0000-0000-0000-000000000002', 'N3940', 'n3940', 'LV necklace', 'active');
INSERT INTO public.website_product_variants (id, product_id) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002');
CREATE FUNCTION pg_temp.u(p text) RETURNS text LANGUAGE sql AS
  $$ SELECT 'https://pfoicalpzdcmyxzvwyhz.supabase.co/storage/v1/object/public/promotions/website/' || p $$;
CREATE FUNCTION pg_temp.as_user(p text) RETURNS void LANGUAGE sql AS $$ SELECT set_config('test.uid', p, false) $$;
CREATE FUNCTION pg_temp.sha(c text) RETURNS text LANGUAGE sql AS $$ SELECT repeat(c, 64) $$;
CREATE FUNCTION pg_temp.rec(url text, sha text, st text, path text DEFAULT 'website/derived/hero/0123456789abcdef0123456789abcdef/89abcdef/cutout.webp')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.hero_cutout_record(jsonb_build_object('source_url', url, 'source_sha256', sha, 'status', st,
    'flags', CASE WHEN st = 'needs_review' THEN '["low_res:463x495"]'::jsonb ELSE '[]'::jsonb END, 'coverage', 0.31,
    'cutout_path', CASE WHEN st = 'failed' THEN NULL ELSE path END,
    'width', CASE WHEN st = 'failed' THEN NULL ELSE 700 END, 'height', CASE WHEN st = 'failed' THEN NULL ELSE 900 END,
    'source_width', 1440, 'source_height', 1440, 'model', 'birefnet-general@epoch_244',
    'toolchain', '{"rembg":"2.0.85"}'::jsonb)) $$;
-- The Photoroom record before anything below runs (block 12 compares).
CREATE TEMP TABLE photoroom_before AS SELECT count(*) AS n FROM public.website_media_cutouts;
INSERT INTO public.website_product_media (variant_id, url, sort) VALUES
  ('d0000000-0000-0000-0000-000000000001', pg_temp.u('page365/1/c0853-1.jpeg'), 0),
  ('d0000000-0000-0000-0000-000000000001', pg_temp.u('page365/1/c0853-2.jpeg'), 1),
  ('d0000000-0000-0000-0000-000000000002', pg_temp.u('page365/2/n3940-1.jpeg'), 0);
-- The Photoroom enqueue trigger queued these three itself (its own table).
CREATE TEMP TABLE photoroom_after_media AS SELECT count(*) AS n FROM public.website_media_cutouts;

-- ------------------------------------------------ 1. the switch: approval-first, guarded, admin-only
DO $t$ DECLARE r jsonb; BEGIN
  IF public.hero_cutout_mode() <> 'approve' THEN RAISE EXCEPTION '1: mode is %', public.hero_cutout_mode(); END IF;
  BEGIN
    UPDATE public.system_settings SET value = '"auto"' WHERE key = 'hero_cutout_mode';
    RAISE EXCEPTION '1: direct write was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Hero cut-out go-live is switched only%' THEN RAISE; END IF;
  END;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  r := public.set_hero_cutout_mode('auto', 'approve');
  IF r ->> 'error' <> 'admin_only' THEN RAISE EXCEPTION '1: staff changed the switch: %', r; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  r := public.set_hero_cutout_mode('on', 'approve');
  IF r ->> 'error' <> 'invalid_mode' THEN RAISE EXCEPTION '1: bad mode accepted: %', r; END IF;
  r := public.set_hero_cutout_mode('auto', 'auto');
  IF r ->> 'error' <> 'stale' THEN RAISE EXCEPTION '1: stale screen accepted: %', r; END IF;
  IF public.hero_cutout_mode() <> 'approve' THEN RAISE EXCEPTION '1: mode moved'; END IF;
  -- An unreadable value reads "approve" (fail-safe).
  PERFORM set_config('app.allow_hero_cutout_mode_change', 'on', true);
  UPDATE public.system_settings SET value = '"banana"' WHERE key = 'hero_cutout_mode';
  IF public.hero_cutout_mode() <> 'approve' THEN RAISE EXCEPTION '1: garbage did not read approve'; END IF;
  UPDATE public.system_settings SET value = '"approve"' WHERE key = 'hero_cutout_mode';
  PERFORM set_config('app.allow_hero_cutout_mode_change', '', true);
  RAISE NOTICE '1 ok: approval-first, guarded, admin-only, fail-safe';
END $t$;

-- ------------------------------------------------ 2. browser roles cannot reach the record
SET ROLE authenticated;
DO $t$ BEGIN
  BEGIN PERFORM 1 FROM public.website_hero_cutouts; RAISE EXCEPTION '2: authenticated read the table';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.hero_cutout_record('{}'::jsonb); RAISE EXCEPTION '2: authenticated called the writer';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM * FROM public.hero_cutouts_for_site(ARRAY['x']); RAISE EXCEPTION '2: authenticated called the site read';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $t$;
RESET ROLE;
SET ROLE anon;
DO $t$ BEGIN
  BEGIN PERFORM 1 FROM public.website_hero_cutouts; RAISE EXCEPTION '2: anon read the table';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM public.review_hero_cutout('x', 'approve', 'ok'); RAISE EXCEPTION '2: anon reviewed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE '2 ok: anon / authenticated cannot read or write the record';
END $t$;
RESET ROLE;

-- ------------------------------------------------ 3. even the service role writes only through the functions
SET ROLE service_role;
DO $t$ BEGIN
  BEGIN
    INSERT INTO public.website_hero_cutouts (source_url, source_sha256, status, qa_status, cutout_path, width, height, model)
    VALUES (pg_temp.u('page365/1/c0853-1.jpeg'), pg_temp.sha('a'), 'approved', 'ok',
            'website/derived/hero/0123456789abcdef0123456789abcdef/89abcdef/cutout.webp', 1, 1, 'x');
    RAISE EXCEPTION '3: a direct insert was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'website_hero_cutouts is written only by%' THEN RAISE; END IF;
  END;
  RAISE NOTICE '3 ok: direct writes refused, even for the service role';
END $t$;

-- ------------------------------------------------ 4. the workflow records a verdict; it waits (approval-first)
DO $t$ DECLARE r jsonb; n int; BEGIN
  r := pg_temp.rec(pg_temp.u('page365/1/c0853-1.jpeg'), pg_temp.sha('a'), 'auto_fixed');
  IF r ->> 'result' <> 'inserted' OR r ->> 'status' <> 'auto_fixed' THEN RAISE EXCEPTION '4: %', r; END IF;
  SELECT count(*) INTO n FROM public.hero_cutouts_for_site(ARRAY[pg_temp.u('page365/1/c0853-1.jpeg')]);
  IF n <> 0 THEN RAISE EXCEPTION '4: a waiting cut-out reached the site'; END IF;
  SELECT count(*) INTO n FROM public.hero_cutouts_known();
  IF n <> 1 THEN RAISE EXCEPTION '4: known list has %', n; END IF;
  RAISE NOTICE '4 ok: passed cut-out waits for the owner; the site sees nothing';
END $t$;

-- ------------------------------------------------ 5. never twice for an unchanged source; a replaced source is re-recorded
DO $t$ DECLARE r jsonb; BEGIN
  r := pg_temp.rec(pg_temp.u('page365/1/c0853-1.jpeg'), pg_temp.sha('a'), 'ok');
  IF r ->> 'result' <> 'unchanged' OR r ->> 'status' <> 'auto_fixed' THEN RAISE EXCEPTION '5: %', r; END IF;
  r := pg_temp.rec(pg_temp.u('page365/2/n3940-1.jpeg'), pg_temp.sha('c'), 'needs_review');
  IF r ->> 'status' <> 'needs_review' THEN RAISE EXCEPTION '5: %', r; END IF;
  -- held for size: the next run (same bytes) changes nothing
  r := pg_temp.rec(pg_temp.u('page365/2/n3940-1.jpeg'), pg_temp.sha('c'), 'needs_review');
  IF r ->> 'result' <> 'unchanged' THEN RAISE EXCEPTION '5: held photo re-recorded: %', r; END IF;
  r := pg_temp.rec(pg_temp.u('page365/1/c0853-1.jpeg'), pg_temp.sha('b'), 'ok');
  IF r ->> 'result' <> 'replaced' THEN RAISE EXCEPTION '5: new bytes not replaced: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'hero_cutout_record:replaced') THEN RAISE EXCEPTION '5: no audit row'; END IF;
  RAISE NOTICE '5 ok: once per unchanged source (held included); new bytes re-recorded and audited';
END $t$;

-- ------------------------------------------------ 6. the workflow cannot decide, and records only real photos
DO $t$ DECLARE r jsonb; BEGIN
  BEGIN PERFORM pg_temp.rec(pg_temp.u('page365/1/c0853-2.jpeg'), pg_temp.sha('d'), 'approved'); RAISE EXCEPTION '6: approved accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'hero_cutout_record: status must be%' THEN RAISE; END IF; END;
  BEGIN PERFORM pg_temp.rec(pg_temp.u('page365/1/c0853-2.jpeg'), pg_temp.sha('d'), 'rejected'); RAISE EXCEPTION '6: rejected accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'hero_cutout_record: status must be%' THEN RAISE; END IF; END;
  r := pg_temp.rec(pg_temp.u('page365/9/not-a-product.jpeg'), pg_temp.sha('d'), 'ok');
  IF r ->> 'error' <> 'unknown_photo' THEN RAISE EXCEPTION '6: unknown photo recorded: %', r; END IF;
  BEGIN PERFORM public.hero_cutout_record(jsonb_build_object('source_url', pg_temp.u('derived/x.jpeg'), 'source_sha256', pg_temp.sha('d'), 'status', 'ok'));
    RAISE EXCEPTION '6: derived URL accepted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'hero_cutout_record: bad source_url%' THEN RAISE; END IF; END;
  RAISE NOTICE '6 ok: workflow cannot approve/reject; only real product photos';
END $t$;

-- ------------------------------------------------ 7. held and failed reach the site as "held", never with a file
DO $t$ DECLARE r jsonb; j jsonb; BEGIN
  r := pg_temp.rec(pg_temp.u('page365/1/c0853-2.jpeg'), pg_temp.sha('e'), 'failed');
  IF r ->> 'status' <> 'failed' THEN RAISE EXCEPTION '7: %', r; END IF;
  SELECT hero_cutout INTO j FROM public.hero_cutouts_for_site(ARRAY[pg_temp.u('page365/1/c0853-2.jpeg')]);
  IF j <> '{"status":"held"}'::jsonb THEN RAISE EXCEPTION '7: failed → %', j; END IF;
  SELECT hero_cutout INTO j FROM public.hero_cutouts_for_site(ARRAY[pg_temp.u('page365/2/n3940-1.jpeg')]);
  IF j <> '{"status":"held"}'::jsonb THEN RAISE EXCEPTION '7: needs_review → %', j; END IF;
  RAISE NOTICE '7 ok: held → {status: held}, no file';
END $t$;
RESET ROLE;

-- ------------------------------------------------ 8. the owner approves (admin only, stale-checked, audited) → live
DO $t$ DECLARE r jsonb; j jsonb; c int; BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  r := public.review_hero_cutout(pg_temp.u('page365/1/c0853-1.jpeg'), 'approve', 'ok');
  IF r ->> 'error' <> 'admin_only' THEN RAISE EXCEPTION '8: staff approved: %', r; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  r := public.review_hero_cutout(pg_temp.u('page365/1/c0853-1.jpeg'), 'approve', 'needs_review');
  IF r ->> 'error' <> 'stale' THEN RAISE EXCEPTION '8: stale accepted: %', r; END IF;
  SELECT count(*) INTO c FROM net.calls;
  r := public.review_hero_cutout(pg_temp.u('page365/1/c0853-1.jpeg'), 'approve', 'ok', 'dial intact');
  IF r ->> 'status' <> 'approved' THEN RAISE EXCEPTION '8: %', r; END IF;
  SELECT hero_cutout INTO j FROM public.hero_cutouts_for_site(ARRAY[pg_temp.u('page365/1/c0853-1.jpeg')]);
  IF j ->> 'status' <> 'approved' OR j ->> 'path' IS NULL OR (j ->> 'width')::int <> 700 THEN RAISE EXCEPTION '8: site sees %', j; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'review_hero_cutout:approve'
                  AND performed_by_user_id = '00000000-0000-0000-0000-00000000000a'
                  AND old_value_json ->> 'status' = 'ok' AND new_value_json ->> 'status' = 'approved') THEN
    RAISE EXCEPTION '8: no audit row'; END IF;
  IF (SELECT count(*) FROM net.calls) <> c + 1
     OR (SELECT body ->> 'productSlug' FROM net.calls ORDER BY id DESC LIMIT 1) <> 'c0853' THEN
    RAISE EXCEPTION '8: storefront not revalidated'; END IF;
  r := public.review_hero_cutout(pg_temp.u('page365/1/c0853-2.jpeg'), 'approve', 'failed');
  IF r ->> 'error' <> 'nothing_to_approve' THEN RAISE EXCEPTION '8: failed run approved: %', r; END IF;
  RAISE NOTICE '8 ok: admin approves (stale-checked, audited, revalidated); a failed run cannot be approved';
END $t$;

-- ------------------------------------------------ 9. the owner rejects — also a live one — audited, and the site stops showing it
DO $t$ DECLARE r jsonb; j jsonb; BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  r := public.review_hero_cutout(pg_temp.u('page365/1/c0853-1.jpeg'), 'reject', 'approved', 'on second look');
  IF r ->> 'status' <> 'rejected' THEN RAISE EXCEPTION '9: %', r; END IF;
  SELECT hero_cutout INTO j FROM public.hero_cutouts_for_site(ARRAY[pg_temp.u('page365/1/c0853-1.jpeg')]);
  IF j <> '{"status":"rejected"}'::jsonb THEN RAISE EXCEPTION '9: site sees %', j; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'review_hero_cutout:reject'
                  AND old_value_json ->> 'status' = 'approved') THEN RAISE EXCEPTION '9: no audit row'; END IF;
  -- the next workflow run (same bytes) does not undo the decision
  r := pg_temp.rec(pg_temp.u('page365/1/c0853-1.jpeg'), pg_temp.sha('b'), 'ok');
  IF r ->> 'result' <> 'unchanged' OR r ->> 'status' <> 'rejected' THEN RAISE EXCEPTION '9: decision undone: %', r; END IF;
  RAISE NOTICE '9 ok: reject any time (also live), audited; the workflow never overturns it';
END $t$;

-- ------------------------------------------------ 10. automatic go-live exists: when ON, a passed cut-out lands approved
DO $t$ DECLARE r jsonb; BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  r := public.set_hero_cutout_mode('auto', 'approve');
  IF NOT (r ->> 'changed')::boolean THEN RAISE EXCEPTION '10: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'set_hero_cutout_mode' AND new_value_json ->> 'mode' = 'auto') THEN
    RAISE EXCEPTION '10: switch not audited'; END IF;
  INSERT INTO public.website_product_media (variant_id, url, sort) VALUES
    ('d0000000-0000-0000-0000-000000000002', pg_temp.u('page365/2/n3940-2.jpeg'), 1),
    ('d0000000-0000-0000-0000-000000000002', pg_temp.u('page365/2/n3940-3.jpeg'), 2);
  r := pg_temp.rec(pg_temp.u('page365/2/n3940-2.jpeg'), pg_temp.sha('f'), 'ok');
  IF r ->> 'status' <> 'approved' THEN RAISE EXCEPTION '10: auto did not approve: %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.website_hero_cutouts WHERE source_url = pg_temp.u('page365/2/n3940-2.jpeg') AND auto_approved)
     OR NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'hero_cutout_record:auto_approved') THEN
    RAISE EXCEPTION '10: automatic approval not marked / audited'; END IF;
  r := pg_temp.rec(pg_temp.u('page365/2/n3940-3.jpeg'), pg_temp.sha('0'), 'needs_review');
  IF r ->> 'status' <> 'needs_review' THEN RAISE EXCEPTION '10: a held cut-out went live: %', r; END IF;
  -- the owner can still reject an automatic one
  r := public.review_hero_cutout(pg_temp.u('page365/2/n3940-2.jpeg'), 'reject', 'approved');
  IF r ->> 'status' <> 'rejected' THEN RAISE EXCEPTION '10: %', r; END IF;
  r := public.set_hero_cutout_mode('approve', 'auto');
  IF public.hero_cutout_mode() <> 'approve' THEN RAISE EXCEPTION '10: not back to approve'; END IF;
  RAISE NOTICE '10 ok: auto go-live works when switched on; held never goes live; back to approve';
END $t$;

-- ------------------------------------------------ 11. the Hub list: staff with the catalogue permission may look; others not
DO $t$ DECLARE r jsonb; o jsonb; BEGIN
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000c');
  r := public.list_hero_cutouts('all');
  IF r ->> 'error' <> 'permission_denied' THEN RAISE EXCEPTION '11: %', r; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000b');
  r := public.list_hero_cutouts('held');
  IF (r ->> 'total')::int <> 3 THEN RAISE EXCEPTION '11: held total %', r ->> 'total'; END IF;
  IF r -> 'rows' -> 0 -> 'product' ->> 'sku' <> 'C0853' THEN RAISE EXCEPTION '11: product not joined: %', r -> 'rows' -> 0; END IF;
  r := public.list_hero_cutouts('rejected', 'n3940');
  IF (r ->> 'total')::int <> 1 THEN RAISE EXCEPTION '11: search %', r; END IF;
  o := public.get_hero_cutout_overview();
  IF (o ->> 'can_review')::boolean OR o ->> 'mode' <> 'approve' THEN RAISE EXCEPTION '11: staff overview %', o; END IF;
  PERFORM pg_temp.as_user('00000000-0000-0000-0000-00000000000a');
  o := public.get_hero_cutout_overview();
  IF NOT (o ->> 'can_review')::boolean OR (o -> 'status_counts' ->> 'rejected')::int <> 2 THEN RAISE EXCEPTION '11: admin overview %', o; END IF;
  RAISE NOTICE '11 ok: list / overview for the catalogue permission; decisions for admin only';
END $t$;

-- ------------------------------------------------ 12. Photoroom untouched
DO $t$ BEGIN
  IF (SELECT count(*) FROM public.website_media_cutouts) <> (SELECT n FROM photoroom_after_media) + 2 THEN
    RAISE EXCEPTION '12: website_media_cutouts changed other than by its own enqueue trigger';
  END IF;
  IF EXISTS (SELECT 1 FROM public.website_media_cutouts WHERE status <> 'pending' OR job_state <> 'queued') THEN
    RAISE EXCEPTION '12: a Photoroom row moved';
  END IF;
  RAISE NOTICE '12 ok: Photoroom rows only queued by their own trigger, none processed';
END $t$;

SELECT 'ALL PASSED' AS result;
