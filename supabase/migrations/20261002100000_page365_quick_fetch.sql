-- ===========================================================================
-- page365_quick_fetch — QUICK reads every 30 minutes, a FULL read nightly, and
-- automatic INCREASES (PR 3c). Owner decisions, final, 2026-09-26.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main
-- and BEFORE page365-inventory-fetch is redeployed. One transaction. When it
-- runs it changes NO website stock, publishes/unpublishes nothing, and leaves
-- the automatic switch (system_settings.page365_inventory_auto_apply) exactly
-- as it is — the self-check at the end proves all three.
--
-- 1. AUTOMATIC INCREASES. Staff enter every confirmed website sale in Page365,
--    so Page365 is the full truth. With the switch ON, a scheduled read now
--    applies increases as well as decreases and hides. Unchanged: target =
--    Page365 available − unconfirmed website holds (− unpaid invoice holds while
--    page365_hold_unpaid_invoices); compare-and-set; never below 0; never a
--    "Don't sync with Page365" product (read live); nothing from a partial or
--    failed read; only inside the run's 30-minute window; not if superseded.
--    Still manual: Create drafts, photo copies, prices, re-publishing.
-- 2. QUICK READS. A quick read reads the catalogue LIST (two requests: it is
--    cumulative), then opens a product page ONLY for listings that can hold a
--    Hub product: the list name's code is a Hub code (status not archived, not
--    switched off), or the listing held a Hub code in an earlier read (multi-
--    variant listings put codes on the variants), or a Hub product was drafted
--    from it. Every other listing is kept as status 'listed' (seen on the list,
--    page not opened). The list count still drives the shrink guard; "missing"
--    for hide-follow still needs a clean read (list complete AND every opened
--    page read).
-- 3. FULL READS. Nightly — the first scheduled read after 02:00 PHT
--    (= 03:00 JST; system_settings.page365_inventory_full_hour_pht) — and on a
--    staff "Full fetch". "New in Page365" comes from the latest full read.
-- 4. CREATE DRAFTS reads each ticked listing FRESH (edge function, through
--    page365_inventory_refresh_product) and refuses one not read in the last
--    15 minutes ('not_fresh') or gone from Page365 ('gone_from_page365').
-- 5. ONE READER. A draft refresh takes page365_inventory_reader (a one-row
--    lease); the chunk reader backs off while it is held, the refresh refuses
--    while a run's lease is held. <= 4 requests/s, one reader, as before.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). md5(pg_proc.prosrc):
--   replaced   page365_inventory_finish          9d0be9494288800686e2d6a90edb3304 -> 6bf16430aedfd4068b45024b8d860e95   (PR 2 body; (e) + return)
--              page365_inventory_auto_apply_run  21eb560506fc8727076d715dd9e1bc97 -> d9d251fb68aac0acf9a5360b22fddc07   (PR 3b body; increases)
--              page365_inventory_create_drafts   8e30c58f54f53cbab62ec7ab9149b4d3 -> 9ae1eb47496736b925db9625b1e2d373   (PR 4 body; full run, fresh read)
--   relied on, proved unchanged after:
--              page365_inventory_claim           fa8a56b999761aa0fab8172ac78f2ed0
--              page365_inventory_store_product   6ae646ee897b92ca7aa5002f8c416743
--              page365_inventory_apply           e65757c2f32b597b2a55047d77783df3
--              page365_inventory_lease           81e98272a20bfb457f8d1bbc09cf594c
--              page365_inventory_follow          9c99a035f3812fb39522d087618e461d
--              page365_inventory_hide_item       3a0a932b88cdd1534a9c0285f8ea392b
--              page365_inventory_retention       9dc2d413a9b146ebc09778c854dad187
--   Each replaced body below is the repo text of its latest migration with the
--   PR 3c edits applied; its "before" md5 is the live body the owner confirmed
--   after PR 3b (verification (2) of 20261001100000).
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if live is not what this was written against. Re-running
-- the file is a no-op (each replaced body is recognised as already new).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_cols    text[];
  v_bad     text := '';
  v_got     text;
  v_def     text;
  r         record;
BEGIN
  IF to_regclass('public.page365_inventory_runs')     IS NULL THEN v_missing := v_missing || 'page365_inventory_runs (PR 1)'::text; END IF;
  IF to_regclass('public.page365_inventory_products') IS NULL THEN v_missing := v_missing || 'page365_inventory_products (PR 1)'::text; END IF;
  IF to_regclass('public.page365_inventory_items')    IS NULL THEN v_missing := v_missing || 'page365_inventory_items (PR 1)'::text; END IF;
  IF to_regclass('public.page365_product_presence')   IS NULL THEN v_missing := v_missing || 'page365_product_presence (PR 3b)'::text; END IF;
  IF to_regclass('public.website_products')           IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants')   IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.system_settings')            IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF to_regclass('public.audit_logs')                 IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.staff_notifications')        IS NULL THEN v_missing := v_missing || 'staff_notifications'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_quick_fetch: missing: %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('page365_inventory_runs','id'), ('page365_inventory_runs','source'), ('page365_inventory_runs','status'),
      ('page365_inventory_runs','created_at'), ('page365_inventory_runs','finished_at'), ('page365_inventory_runs','products_total'),
      ('page365_inventory_runs','page365_count'), ('page365_inventory_runs','lease_holder'), ('page365_inventory_runs','lease_until'),
      ('page365_inventory_runs','auto_applied'), ('page365_inventory_runs','auto_apply_state'), ('page365_inventory_runs','hidden_count'),
      ('page365_inventory_products','id'), ('page365_inventory_products','run_id'), ('page365_inventory_products','status'),
      ('page365_inventory_products','page365_product_id'), ('page365_inventory_products','list_name'),
      ('page365_inventory_products','fetched_at'), ('page365_inventory_products','photos'), ('page365_inventory_products','name'),
      ('page365_inventory_products','price_jpy'), ('page365_inventory_products','full_price_jpy'),
      ('page365_inventory_items','inventory_product_id'), ('page365_inventory_items','page365_variant_id'),
      ('page365_inventory_items','page365_product_id'), ('page365_inventory_items','code'), ('page365_inventory_items','kind'),
      ('page365_inventory_items','category'), ('page365_inventory_items','status'), ('page365_inventory_items','result_note'),
      ('page365_inventory_items','page365_available'), ('page365_inventory_items','page365_name'), ('page365_inventory_items','variant_name'),
      ('page365_inventory_items','page365_price_jpy'), ('page365_inventory_items','page365_full_price_jpy'),
      ('website_products','sku'), ('website_products','status'), ('website_products','page365_sync_disabled'),
      ('website_products','page365_product_id')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'page365_quick_fetch: missing column(s): %', array_to_string(v_cols, ', ');
  END IF;
  IF to_regprocedure('public.page365_first_word(text)') IS NULL THEN
    RAISE EXCEPTION 'page365_quick_fetch: public.page365_first_word(text) missing (#195)';
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'page365_quick_fetch: public.has_permission(uuid,text) missing';
  END IF;

  -- The live bodies. The three replaced ones may already be new (a re-run).
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_finish(uuid)',                 '9d0be9494288800686e2d6a90edb3304', '6bf16430aedfd4068b45024b8d860e95'),
      ('page365_inventory_auto_apply_run(uuid)',         '21eb560506fc8727076d715dd9e1bc97', 'd9d251fb68aac0acf9a5360b22fddc07'),
      ('page365_inventory_create_drafts(uuid,uuid[])',   '8e30c58f54f53cbab62ec7ab9149b4d3', '9ae1eb47496736b925db9625b1e2d373'),
      ('page365_inventory_claim(uuid,integer)',          'fa8a56b999761aa0fab8172ac78f2ed0', NULL),
      ('page365_inventory_store_product(uuid,jsonb,text)', '6ae646ee897b92ca7aa5002f8c416743', NULL),
      ('page365_inventory_apply(uuid,uuid[],uuid[])',    'e65757c2f32b597b2a55047d77783df3', NULL),
      ('page365_inventory_lease(uuid,text,integer)',     '81e98272a20bfb457f8d1bbc09cf594c', NULL),
      ('page365_inventory_follow(uuid)',                 '9c99a035f3812fb39522d087618e461d', NULL),
      ('page365_inventory_hide_item(uuid,uuid,uuid,text)', '3a0a932b88cdd1534a9c0285f8ea392b', NULL),
      ('page365_inventory_retention(integer)',           '9dc2d413a9b146ebc09778c854dad187', NULL)
    ) AS t(fn, want, or_new)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want AND v_got IS DISTINCT FROM r.or_new THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'STOP — page365_quick_fetch: live is not what this file was written against. Nothing was modified.%', v_bad;
  END IF;

  -- The product status CHECK must be PR 1's list (re-run: already with 'listed').
  SELECT pg_get_constraintdef(k.oid) INTO v_def FROM pg_constraint k
   WHERE k.conrelid = 'public.page365_inventory_products'::regclass AND k.conname = 'page365_inventory_products_status_check';
  IF v_def IS NULL
     OR NOT (v_def LIKE '%''pending''%' AND v_def LIKE '%''claimed''%' AND v_def LIKE '%''fetched''%' AND v_def LIKE '%''error''%') THEN
    RAISE EXCEPTION 'page365_quick_fetch: page365_inventory_products_status_check is not PR 1''s list: %', coalesce(v_def, 'missing');
  END IF;

  -- Name collisions: new objects must not exist in another shape.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'page365_inventory_plan_quick'       AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid')
       OR (p.proname = 'page365_inventory_next_kind'        AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'page365_inventory_refresh_product'  AND pg_get_function_identity_arguments(p.oid) <> 'p_product_row_id uuid, p_detail jsonb, p_error text')
       OR (p.proname = 'page365_inventory_reader_lease'     AND pg_get_function_identity_arguments(p.oid) <> 'p_holder text, p_seconds integer')
       OR (p.proname = 'page365_inventory_reader_release'   AND pg_get_function_identity_arguments(p.oid) <> 'p_holder text'));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'page365_quick_fetch: function(s) already exist with another signature: %', v_got;
  END IF;
  IF to_regclass('public.page365_inventory_reader') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'page365_inventory_reader' AND column_name = 'lease_until') THEN
    RAISE EXCEPTION 'page365_quick_fetch: a different public.page365_inventory_reader already exists';
  END IF;

  -- Remember what must not move: the switch, and every product's status/stock.
  PERFORM set_config('page365.quick_switch_before',
                     coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'absent'), true);
  PERFORM set_config('page365.quick_catalog_before',
                     (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), ''))
                        FROM public.website_products wp)
                     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), ''))
                           FROM public.website_product_variants v), true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Run kind, the list-only product status, the increase count.
--    Existing runs read every product page: they are 'full' (the default).
-- ---------------------------------------------------------------------------
ALTER TABLE public.page365_inventory_runs
  ADD COLUMN IF NOT EXISTS kind           text NOT NULL DEFAULT 'full',
  ADD COLUMN IF NOT EXISTS listed_total   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_increased integer NOT NULL DEFAULT 0;
ALTER TABLE public.page365_inventory_runs DROP CONSTRAINT IF EXISTS page365_inventory_runs_kind_check;
ALTER TABLE public.page365_inventory_runs ADD CONSTRAINT page365_inventory_runs_kind_check CHECK (kind IN ('quick','full'));
COMMENT ON COLUMN public.page365_inventory_runs.kind IS
  'PR 3c. full = every product page opened (nightly schedule, staff "Full fetch"; all runs before PR 3c). quick = the catalogue list plus the pages of listings that can hold a Hub product (page365_inventory_plan_quick); every other listing is status listed. The page365-inventory-fetch edge function always sets it.';
COMMENT ON COLUMN public.page365_inventory_runs.listed_total IS
  'PR 3c, quick runs: listings seen on the catalogue list whose page was not opened (status listed). products_total counts the pages to open.';
COMMENT ON COLUMN public.page365_inventory_runs.auto_increased IS
  'PR 3c: of auto_applied, how many were increases (the rest were decreases).';
CREATE INDEX IF NOT EXISTS idx_page365_inventory_runs_kind_created
  ON public.page365_inventory_runs (kind, created_at DESC);

ALTER TABLE public.page365_inventory_products DROP CONSTRAINT page365_inventory_products_status_check;
ALTER TABLE public.page365_inventory_products ADD CONSTRAINT page365_inventory_products_status_check
  CHECK (status IN ('pending','claimed','fetched','error','listed'));
COMMENT ON COLUMN public.page365_inventory_products.status IS
  'pending -> claimed -> fetched | error (retried once). listed (PR 3c, quick runs only): on the catalogue list, page not opened — never claimed, never counted as open or as an error.';

-- The nightly full read's hour, in PHT (the canonical timezone). 2 = 02:00 PHT
-- = 03:00 JST, a quiet hour in Japan. Inserted only if absent.
INSERT INTO public.system_settings (key, value, description)
VALUES ('page365_inventory_full_hour_pht', '2'::jsonb,
        'Page365 inventory (PR 3c): the first scheduled read at or after this hour (PHT, 0-23) each day is a FULL read (every product page); every other scheduled read is QUICK (the list plus Hub products'' pages). 2 = 02:00 PHT = 03:00 JST.')
ON CONFLICT (key) DO NOTHING;

-- The switch's description only (its VALUE is never written here; the guard
-- trigger would refuse it anyway).
UPDATE public.system_settings
   SET description = 'Page365 inventory: when true, the 30-minute scheduled fetch applies DECREASES and INCREASES to website stock and hides products Page365 stopped listing (PR 3c). New products, prices, photos and re-publishing always wait for staff. Changed only from Hub -> Website -> Page365 stock (set_page365_inventory_auto_apply; manage_website_catalog; audited).'
 WHERE key = 'page365_inventory_auto_apply';

-- ---------------------------------------------------------------------------
-- 2. One reader: the draft refresh's lease (one row). Written only by the two
--    functions below; nobody else reads it but the service role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page365_inventory_reader (
  id           boolean PRIMARY KEY DEFAULT true CHECK (id),
  lease_holder text,
  lease_until  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.page365_inventory_reader IS
  'PR 3c. The Create-drafts refresh''s lease on reading Page365 (one row). page365_inventory_reader_lease takes it only while no run lease is held; the chunk reader (page365-inventory-fetch) backs off while it is held. One reader at a time, <= 4 requests/s.';
INSERT INTO public.page365_inventory_reader (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.page365_inventory_reader ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.page365_inventory_reader FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.page365_inventory_reader TO service_role;

CREATE OR REPLACE FUNCTION public.page365_inventory_reader_lease(p_holder text, p_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_row public.page365_inventory_reader%ROWTYPE;
BEGIN
  IF p_holder IS NULL OR p_holder = '' THEN RETURN false; END IF;
  SELECT * INTO v_row FROM public.page365_inventory_reader WHERE id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_row.lease_until > now() AND v_row.lease_holder IS DISTINCT FROM p_holder THEN RETURN false; END IF;
  -- A run is being read right now: that reader goes first.
  IF EXISTS (SELECT 1 FROM public.page365_inventory_runs r
              WHERE r.status = 'fetching' AND r.lease_until > now()) THEN
    RETURN false;
  END IF;
  UPDATE public.page365_inventory_reader
     SET lease_holder = p_holder,
         lease_until  = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 60), 10), 300)),
         updated_at   = now()
   WHERE id;
  RETURN true;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_reader_lease(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_reader_lease(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.page365_inventory_reader_release(p_holder text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  UPDATE public.page365_inventory_reader SET lease_holder = NULL, lease_until = NULL, updated_at = now()
   WHERE id AND lease_holder = p_holder;
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_reader_release(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_reader_release(text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Which pages a QUICK run opens. Service role only, called by the edge
--    function right after the list is queued. Every other listing -> 'listed'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_plan_quick(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run    public.page365_inventory_runs%ROWTYPE;
  v_listed integer;
  v_read   integer;
  v_codes  integer;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.status <> 'fetching' OR v_run.kind <> 'quick' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_quick_fetching_run');
  END IF;

  -- Hub codes: the same set finish's Hub-only list uses (not archived, a
  -- code), less products switched to "Don't sync with Page365".
  SELECT count(DISTINCT public.page365_first_word(wp.sku)) INTO v_codes FROM public.website_products wp
   WHERE wp.status <> 'archived' AND NOT coalesce(wp.page365_sync_disabled, false)
     AND public.page365_first_word(wp.sku) IS NOT NULL;

  WITH hub AS (
    SELECT DISTINCT public.page365_first_word(wp.sku) AS code FROM public.website_products wp
     WHERE wp.status <> 'archived' AND NOT coalesce(wp.page365_sync_disabled, false)
       AND public.page365_first_word(wp.sku) IS NOT NULL)
  UPDATE public.page365_inventory_products p
     SET status = 'listed'
   WHERE p.run_id = p_run_id AND p.status = 'pending'
     -- (a) the list name's code is a Hub code;
     AND NOT EXISTS (SELECT 1 FROM hub WHERE hub.code = public.page365_first_word(p.list_name))
     -- (b) the listing held a Hub code in an earlier read (variant codes);
     AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                       JOIN hub ON hub.code = i.code
                      WHERE i.kind = 'page365' AND i.page365_product_id = p.page365_product_id AND i.run_id <> p_run_id)
     -- (c) a Hub product was drafted from it.
     AND NOT EXISTS (SELECT 1 FROM public.website_products wp
                      WHERE wp.page365_product_id = p.page365_product_id
                        AND wp.status <> 'archived' AND NOT coalesce(wp.page365_sync_disabled, false));
  GET DIAGNOSTICS v_listed = ROW_COUNT;

  SELECT count(*) INTO v_read FROM public.page365_inventory_products
   WHERE run_id = p_run_id AND status <> 'listed';
  UPDATE public.page365_inventory_runs
     SET products_total = v_read, listed_total = v_listed, updated_at = now()
   WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'to_read', v_read, 'listed', v_listed, 'hub_codes', v_codes);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_plan_quick(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_plan_quick(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_plan_quick(uuid) IS
  'PR 3c. For a QUICK run that is still fetching: keep for reading only the listings that can hold a Hub product (list-name code is a Hub code; or the listing held a Hub code in an earlier read; or a Hub product was drafted from it). Hub code = page365_first_word(sku), status not archived, not switched off. Every other listing -> status listed. Service role.';

-- ---------------------------------------------------------------------------
-- 4. The nightly full read. The first SCHEDULED read that starts at or after
--    page365_inventory_full_hour_pht (default 02:00 PHT = 03:00 JST) each day is
--    'full'; so is the next one if that read failed outright. Otherwise 'quick'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_next_kind()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_raw      text := (SELECT s.value #>> '{}' FROM public.system_settings s WHERE s.key = 'page365_inventory_full_hour_pht');
  v_hour     integer := CASE WHEN v_raw ~ '^\s*\d{1,2}\s*$' AND btrim(v_raw)::integer BETWEEN 0 AND 23
                             THEN btrim(v_raw)::integer ELSE 2 END;
  v_now_pht  timestamp := now() AT TIME ZONE 'Asia/Manila';
  v_boundary timestamp := date_trunc('day', now() AT TIME ZONE 'Asia/Manila') + make_interval(hours => v_hour);
BEGIN
  IF v_boundary > v_now_pht THEN v_boundary := v_boundary - interval '1 day'; END IF;
  IF EXISTS (SELECT 1 FROM public.page365_inventory_runs r
              WHERE r.source = 'schedule' AND r.kind = 'full' AND r.status <> 'failed'
                AND r.created_at >= (v_boundary AT TIME ZONE 'Asia/Manila')) THEN
    RETURN 'quick';
  END IF;
  RETURN 'full';
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_next_kind() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_next_kind() TO service_role;
COMMENT ON FUNCTION public.page365_inventory_next_kind() IS
  'PR 3c. quick | full for the NEXT scheduled Page365 read: full when no scheduled full read (not failed) has started since the latest page365_inventory_full_hour_pht boundary (default 02:00 PHT = 03:00 JST). Service role.';

-- ---------------------------------------------------------------------------
-- 5. Create drafts reads each listing FRESH. Service role only (the edge
--    function, action "refresh"). Only a FULL, ready run's rows; only the
--    'new' rows under review are updated (a stock row's proposal is never
--    silently rewritten). Whitelisted keys only, as store_product.
--    p_error 'gone' = the listing answered 404: its new rows are marked
--    gone_from_page365 and are never drafted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_refresh_product(p_product_row_id uuid, p_detail jsonb, p_error text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_p       public.page365_inventory_products%ROWTYPE;
  v_run     public.page365_inventory_runs%ROWTYPE;
  v_photos  jsonb;
  v_v       jsonb;
  v_n       integer;
  v_updated integer := 0;
  v_added   integer := 0;
  v_gone    integer := 0;
BEGIN
  SELECT * INTO v_p FROM public.page365_inventory_products WHERE id = p_product_row_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = v_p.run_id;
  IF v_run.status IS DISTINCT FROM 'ready' OR v_run.kind IS DISTINCT FROM 'full' THEN
    RETURN jsonb_build_object('result', 'not_a_full_run');
  END IF;

  IF p_error = 'gone' THEN
    UPDATE public.page365_inventory_items
       SET result_note = 'gone_from_page365'
     WHERE inventory_product_id = v_p.id AND kind = 'page365' AND category = 'new' AND status = 'review';
    GET DIAGNOSTICS v_gone = ROW_COUNT;
    RETURN jsonb_build_object('result', 'gone', 'gone', v_gone);
  END IF;

  -- Same backstop as store_product: never a guessed quantity.
  IF p_error IS NULL AND p_detail IS NOT NULL AND (
       jsonb_typeof(p_detail->'variants') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_detail->'variants') = 0
    OR jsonb_typeof(coalesce(p_detail->'photos', '[]'::jsonb)) <> 'array'
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_detail->'variants') v
                WHERE jsonb_typeof(v->'id') IS DISTINCT FROM 'number'
                   OR jsonb_typeof(v->'available') IS DISTINCT FROM 'number'
                   OR (v->>'available') !~ '^[0-9]+$')) THEN
    p_error := 'detail failed the variant check';
  END IF;
  IF p_error IS NOT NULL OR p_detail IS NULL THEN
    RETURN jsonb_build_object('result', 'error', 'error', left(coalesce(p_error, 'no detail'), 300));
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', (ph->>'id')::bigint, 'version', ph->>'version', 'url', ph->>'url',
           'position', (ph->>'position')::integer) ORDER BY ord), '[]'::jsonb)
    INTO v_photos
    FROM jsonb_array_elements(coalesce(p_detail->'photos', '[]'::jsonb)) WITH ORDINALITY AS t(ph, ord);

  UPDATE public.page365_inventory_products
     SET fetched_at = now(), name = p_detail->>'name',
         price_jpy = (p_detail->>'price_jpy')::integer, full_price_jpy = (p_detail->>'full_price_jpy')::integer,
         photos = v_photos
   WHERE id = v_p.id;

  FOR v_v IN SELECT * FROM jsonb_array_elements(p_detail->'variants') LOOP
    UPDATE public.page365_inventory_items i
       SET page365_name = p_detail->>'name', variant_name = v_v->>'name',
           code = nullif(upper(btrim(v_v->>'code')), ''),
           page365_price_jpy = (v_v->>'price_jpy')::integer, page365_full_price_jpy = (v_v->>'full_price_jpy')::integer,
           page365_available = (v_v->>'available')::integer,
           result_note = CASE WHEN i.result_note = 'gone_from_page365' THEN NULL ELSE i.result_note END
     WHERE i.inventory_product_id = v_p.id AND i.page365_variant_id = (v_v->>'id')::bigint
       AND i.kind = 'page365' AND i.category = 'new' AND i.status = 'review';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_updated := v_updated + v_n;
    IF NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                    WHERE i.inventory_product_id = v_p.id AND i.page365_variant_id = (v_v->>'id')::bigint) THEN
      -- A variant Page365 added since the full read: the next full read lists it.
      v_added := v_added + 1;
    END IF;
  END LOOP;

  UPDATE public.page365_inventory_items i
     SET result_note = 'gone_from_page365'
   WHERE i.inventory_product_id = v_p.id AND i.kind = 'page365' AND i.category = 'new' AND i.status = 'review'
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_detail->'variants') v
                      WHERE (v->>'id')::bigint = i.page365_variant_id);
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  RETURN jsonb_build_object('result', 'refreshed', 'updated', v_updated, 'new_variants_not_listed', v_added, 'gone', v_gone);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_refresh_product(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_refresh_product(uuid, jsonb, text) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_refresh_product(uuid, jsonb, text) IS
  'PR 3c. Create drafts'' fresh read of one listing of a FULL ready run: updates the listing (name, prices, photos, fetched_at) and its NEW rows under review (quantity, price, names, code) in place; marks new rows whose variant (or the whole listing, p_error gone) left Page365 gone_from_page365. Never touches a stock row. Service role.';

-- ---------------------------------------------------------------------------
-- 6. page365_inventory_finish — PR 2 body; PR 3c edits: a QUICK read leaves
--    switched-off products out of the Hub-only list (it never opened them);
--    the result names the run kind.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_finish(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_prev     public.page365_inventory_runs%ROWTYPE;
  v_prev_count integer;
  v_open     integer;
  v_errors   integer;
  v_it       record;
  v_m        record;
  v_status   text;
  v_reason   text;
  -- PR 2
  v_mode     text := CASE WHEN (SELECT s.value #>> '{}' FROM public.system_settings s
                                 WHERE s.key = 'page365_stock_mode') = 'invoice'
                          THEN 'invoice' ELSE 'inventory_sync' END;
  v_hold_unpaid boolean := coalesce((SELECT s.value #>> '{}' FROM public.system_settings s
                                      WHERE s.key = 'page365_hold_unpaid_invoices'), 'true') <> 'false';
  v_off      boolean;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.status <> 'fetching' THEN
    RETURN jsonb_build_object('ok', true, 'status', v_run.status, 'already', true);
  END IF;

  SELECT count(*) FILTER (WHERE status IN ('pending','claimed') OR (status = 'error' AND attempts < 2)),
         count(*) FILTER (WHERE status = 'error')
    INTO v_open, v_errors
    FROM public.page365_inventory_products WHERE run_id = p_run_id;
  IF v_open > 0 THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_done', 'open', v_open); END IF;

  -- (a) No code / a code seen twice in this read: flagged, never matched.
  UPDATE public.page365_inventory_items SET match_result = 'no_code', category = 'flagged'
   WHERE run_id = p_run_id AND kind = 'page365' AND code IS NULL;
  UPDATE public.page365_inventory_items i SET match_result = 'duplicate_in_page365', category = 'flagged'
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.code IS NOT NULL
     AND (SELECT count(*) FROM public.page365_inventory_items j
           WHERE j.run_id = p_run_id AND j.kind = 'page365' AND j.code = i.code) > 1;

  -- (b) Match the rest on the code, exactly (#195's matcher, unchanged). A
  --     product switched to "Don't sync with Page365" is not_synced (PR 2).
  FOR v_it IN
    SELECT i.id, i.code, i.page365_available, i.page365_price_jpy, i.inventory_product_id
      FROM public.page365_inventory_items i
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'pending'
     ORDER BY i.id
  LOOP
    SELECT * INTO v_m FROM public.page365_match_line(v_it.code);
    v_off := coalesce((SELECT wp.page365_sync_disabled FROM public.website_products wp
                        WHERE wp.id = v_m.o_product_id), false);
    IF v_m.o_match_result = 'matched' THEN
      UPDATE public.page365_inventory_items i
         SET match_result = 'matched', website_product_id = v_m.o_product_id, variant_id = v_m.o_variant_id,
             hub_sku = (SELECT sku FROM public.website_products WHERE id = v_m.o_product_id),
             hub_price_jpy = (SELECT price_jpy FROM public.website_product_variants WHERE id = v_m.o_variant_id),
             seen_stock = v_m.o_stock_qty,
             web_holds = public.page365_web_holds(v_m.o_variant_id),
             invoice_holds = CASE WHEN v_mode = 'invoice'
                                  THEN (SELECT count(*) FROM public.page365_stock_lines l
                                         WHERE l.variant_id = v_m.o_variant_id AND l.stock_state = 'held')
                                  ELSE public.page365_invoice_holds(v_m.o_variant_id) END,
             category = CASE WHEN v_off THEN 'not_synced' ELSE i.category END
       WHERE i.id = v_it.id;
    ELSE
      UPDATE public.page365_inventory_items i
         SET match_result = v_m.o_match_result, website_product_id = v_m.o_product_id,
             category = CASE WHEN v_off THEN 'not_synced'
                             WHEN v_m.o_match_result = 'unmatched' THEN 'new' ELSE 'flagged' END
       WHERE i.id = v_it.id;
    END IF;
  END LOOP;

  -- (c) The proposal: max(0, Page365 available - website holds [- unpaid
  --     invoice holds, PR 2]), and its direction. not_synced is never proposed.
  UPDATE public.page365_inventory_items i
     SET proposed_stock = greatest(0, i.page365_available - coalesce(i.web_holds, 0)
                                      - CASE WHEN v_mode = 'inventory_sync' AND v_hold_unpaid
                                             THEN coalesce(i.invoice_holds, 0) ELSE 0 END),
         price_differs = i.page365_price_jpy IS DISTINCT FROM i.hub_price_jpy
   WHERE i.run_id = p_run_id AND i.match_result = 'matched' AND i.category <> 'not_synced';
  UPDATE public.page365_inventory_items i
     SET category = CASE
           WHEN v_mode = 'invoice' AND i.invoice_holds > 0 THEN 'excluded'
           WHEN i.proposed_stock < i.seen_stock    THEN 'decrease'
           WHEN i.proposed_stock > i.seen_stock    THEN 'increase'
           ELSE 'no_change' END
   WHERE i.run_id = p_run_id AND i.match_result = 'matched' AND i.category <> 'not_synced';

  -- (d) Photos per matched variant: Page365 total, not yet copied (by id AND
  --     version), and copies whose Page365 photo is gone (flagged, not deleted).
  --     not_synced: never copied, so nothing to count.
  UPDATE public.page365_inventory_items i
     SET photos_total = jsonb_array_length(p.photos),
         photos_to_copy = (SELECT count(*) FROM jsonb_array_elements(p.photos) ph
                            WHERE NOT EXISTS (SELECT 1 FROM public.website_product_media m
                                               WHERE m.variant_id = i.variant_id
                                                 AND m.page365_photo_id = (ph->>'id')::bigint
                                                 AND m.page365_photo_version IS NOT DISTINCT FROM ph->>'version')),
         photos_removed = (SELECT count(*) FROM public.website_product_media m
                            WHERE m.variant_id = i.variant_id AND m.page365_photo_id IS NOT NULL
                              AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.photos) ph
                                               WHERE (ph->>'id')::bigint = m.page365_photo_id))
    FROM public.page365_inventory_products p
   WHERE p.id = i.inventory_product_id AND i.run_id = p_run_id AND i.match_result = 'matched'
     AND i.category <> 'not_synced';

  -- (e) Hub-only: only a COMPLETE read can say a code is absent. Archived
  --     products are out of scope; a code with an inner space never matched.
  --     A switched-off product is listed as not_synced, never as missing.
  --     PR 3c: a QUICK read never opens a switched-off product's page, so it
  --     cannot say that product is missing — it is left out altogether.
  IF v_errors = 0 THEN
    SELECT * INTO v_prev FROM public.page365_inventory_runs r
     WHERE r.id <> p_run_id AND r.status = 'ready' AND r.created_at < v_run.created_at
     ORDER BY r.created_at DESC LIMIT 1;
    INSERT INTO public.page365_inventory_items (run_id, kind, website_product_id, hub_sku, match_result, category, missing_runs)
    SELECT p_run_id, 'hub_only', wp.id, wp.sku, 'hub_only',
           CASE WHEN wp.page365_sync_disabled THEN 'not_synced' ELSE 'hub_only' END,
           1 + coalesce((SELECT pi.missing_runs FROM public.page365_inventory_items pi
                          WHERE pi.run_id = v_prev.id AND pi.kind = 'hub_only' AND pi.website_product_id = wp.id), 0)
      FROM public.website_products wp
     WHERE wp.status <> 'archived'
       AND NOT (v_run.kind = 'quick' AND coalesce(wp.page365_sync_disabled, false))
       AND public.page365_first_word(wp.sku) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                        WHERE i.run_id = p_run_id AND i.kind = 'page365'
                          AND i.code = public.page365_first_word(wp.sku))
    ON CONFLICT DO NOTHING;
  END IF;

  -- (f) Ready only if the read was clean and the catalogue did not shrink by > 20 %.
  SELECT r.page365_count INTO v_prev_count FROM public.page365_inventory_runs r
   WHERE r.id <> p_run_id AND r.status = 'ready' AND r.created_at < v_run.created_at
   ORDER BY r.created_at DESC LIMIT 1;
  IF v_errors > 0 THEN
    v_status := 'partial'; v_reason := v_errors || ' product(s) could not be read';
  ELSIF v_prev_count IS NOT NULL AND v_run.page365_count < v_prev_count * 0.8 THEN
    v_status := 'partial';
    v_reason := 'catalogue count fell from ' || v_prev_count || ' to ' || v_run.page365_count;
  ELSE
    v_status := 'ready';
  END IF;

  UPDATE public.page365_inventory_runs
     SET status = v_status, error = v_reason, previous_count = v_prev_count,
         finished_at = now(), updated_at = now()
   WHERE id = p_run_id;
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'reason', v_reason, 'mode', v_mode, 'kind', v_run.kind);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_finish(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_finish(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. page365_inventory_auto_apply_run — PR 3b body; PR 3c edits: INCREASES
--    too (same gate, compare-and-set, direction checked), counted apart
--    (auto_increased), named in the audit and in the one bell per run.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_auto_apply_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run     public.page365_inventory_runs%ROWTYPE;
  -- Fail-closed: only JSON true / "true" is on.
  v_on      boolean := coalesce((SELECT s.value #>> '{}' FROM public.system_settings s
                                  WHERE s.key = 'page365_inventory_auto_apply'), 'false') = 'true';
  v_mode    text := CASE WHEN (SELECT s.value #>> '{}' FROM public.system_settings s
                                WHERE s.key = 'page365_stock_mode') = 'invoice'
                         THEN 'invoice' ELSE 'inventory_sync' END;
  v_state   text;
  v_it      public.page365_inventory_items%ROWTYPE;
  v_note    text;
  v_applied integer := 0;
  v_changed integer := 0;
  v_skipped integer := 0;
  v_failed  integer := 0;
  v_codes   text[] := ARRAY[]::text[];
  v_type    text;
  -- PR 3b
  v_hid_id       uuid;
  v_res          jsonb;
  v_hidden       integer := 0;
  v_hide_changed integer := 0;
  v_hide_skipped integer := 0;
  v_hide_failed  integer := 0;
  v_hide_codes   text[] := ARRAY[]::text[];
  -- PR 3c
  v_increased    integer := 0;
  v_inc_codes    text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.source <> 'schedule' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_scheduled'); END IF;
  IF v_run.status = 'fetching' THEN RETURN jsonb_build_object('ok', false, 'reason', 'still_fetching'); END IF;
  IF v_run.auto_apply_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'state', v_run.auto_apply_state, 'applied', v_run.auto_applied,
                              'hidden', v_run.hidden_count);
  END IF;

  v_state := CASE
    WHEN v_run.status <> 'ready'                                THEN 'not_ready'
    WHEN NOT v_on                                               THEN 'off'
    WHEN now() > v_run.created_at + interval '30 minutes'       THEN 'window_passed'
    WHEN EXISTS (SELECT 1 FROM public.page365_inventory_runs r
                  WHERE r.id <> v_run.id AND r.status = 'ready' AND r.created_at > v_run.created_at) THEN 'superseded'
    ELSE 'applied' END;

  IF v_state = 'applied' THEN
    FOR v_it IN
      SELECT i.* FROM public.page365_inventory_items i
       WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
         AND i.category IN ('decrease', 'increase') AND i.status = 'review'
       ORDER BY i.id
       FOR UPDATE
    LOOP
      v_note := CASE
        WHEN v_it.variant_id IS NULL OR v_it.seen_stock IS NULL OR v_it.proposed_stock IS NULL THEN 'not_a_stock_change'
        WHEN EXISTS (SELECT 1 FROM public.website_product_variants wv
                       JOIN public.website_products wp ON wp.id = wv.product_id
                      WHERE wv.id = v_it.variant_id AND wp.page365_sync_disabled)             THEN 'sync_disabled'
        WHEN v_it.proposed_stock < 0 OR v_it.proposed_stock = v_it.seen_stock
          OR (v_it.category = 'increase') <> (v_it.proposed_stock > v_it.seen_stock)            THEN 'not_a_stock_change'
        WHEN v_mode = 'invoice' AND EXISTS (SELECT 1 FROM public.page365_stock_lines l
                                             WHERE l.variant_id = v_it.variant_id AND l.stock_state = 'held') THEN 'invoice_hold'
        ELSE NULL END;
      IF v_note IS NOT NULL THEN
        -- The row stays under review for staff; only the note says why.
        UPDATE public.page365_inventory_items SET result_note = v_note WHERE id = v_it.id;
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      BEGIN
        -- Compare-and-set (PR 3c: decreases AND increases): a website sale
        -- since the fetch (stock moved) is skipped, never overwritten.
        UPDATE public.website_product_variants
           SET stock_qty = v_it.proposed_stock, updated_at = now()
         WHERE id = v_it.variant_id AND stock_qty = v_it.seen_stock AND stock_qty <> v_it.proposed_stock;
        IF FOUND THEN
          UPDATE public.page365_inventory_items
             SET status = 'applied', applied_at = now(), applied_by = NULL, result_note = 'auto_applied'
           WHERE id = v_it.id;
          INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
          VALUES ('website_product_variant', v_it.variant_id, 'page365_inventory_auto_applied',
                  jsonb_build_object('stock_qty', v_it.seen_stock),
                  jsonb_build_object('stock_qty', v_it.proposed_stock, 'run_id', p_run_id, 'item_id', v_it.id,
                                     'code', v_it.code, 'direction', v_it.category, 'source', 'schedule',
                                     'page365_available', v_it.page365_available, 'web_holds', v_it.web_holds,
                                     'invoice_holds', v_it.invoice_holds, 'mode', v_mode),
                  NULL);
          v_applied := v_applied + 1;
          IF v_it.category = 'increase' THEN
            v_increased := v_increased + 1;
            v_inc_codes := v_inc_codes || coalesce(v_it.code, '?');
          ELSE
            v_codes := v_codes || coalesce(v_it.code, '?');
          END IF;
        ELSE
          UPDATE public.page365_inventory_items
             SET status = 'changed_since_fetch', result_note = 'stock changed after the fetch; the next fetch re-checks it'
           WHERE id = v_it.id;
          v_changed := v_changed + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.page365_inventory_items SET status = 'failed', result_note = left(SQLERRM, 300) WHERE id = v_it.id;
        v_failed := v_failed + 1;
      END;
    END LOOP;

    -- PR 3b: products gone from 2 complete reads in a row — stock 0 and
    -- unpublished, each through the one hide writer (compare-and-set).
    FOR v_hid_id IN
      SELECT i.id FROM public.page365_inventory_items i
       WHERE i.run_id = p_run_id AND i.kind = 'hub_only' AND i.category = 'hide' AND i.status = 'review'
       ORDER BY i.id
    LOOP
      BEGIN
        v_res := public.page365_inventory_hide_item(v_hid_id, p_run_id, NULL, 'schedule');
        IF v_res->>'result' = 'hidden' THEN
          v_hidden := v_hidden + 1;
          v_hide_codes := v_hide_codes || coalesce(v_res->>'code', '?');
        ELSIF v_res->>'result' = 'changed_since_fetch' THEN
          v_hide_changed := v_hide_changed + 1;
        ELSE
          v_hide_skipped := v_hide_skipped + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.page365_inventory_items SET status = 'failed', result_note = left(SQLERRM, 300) WHERE id = v_hid_id;
        v_hide_failed := v_hide_failed + 1;
      END;
    END LOOP;
  END IF;

  -- One audit row per run whenever the switch was on (what was attempted and
  -- why not, if nothing was).
  IF v_on THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('page365_inventory_run', p_run_id, 'page365_inventory_auto_apply',
            jsonb_build_object('state', v_state, 'run_status', v_run.status, 'applied', v_applied,
                               'decreased', v_applied - v_increased, 'increased', v_increased,
                               'increased_codes', to_jsonb(v_inc_codes[1:50]),
                               'changed_since_fetch', v_changed, 'skipped', v_skipped, 'failed', v_failed,
                               'hidden', v_hidden, 'hide_changed_since_fetch', v_hide_changed,
                               'hide_skipped', v_hide_skipped, 'hide_failed', v_hide_failed,
                               'hidden_codes', to_jsonb(v_hide_codes[1:50]),
                               'mode', v_mode, 'source', 'schedule'),
            NULL);
  END IF;

  v_type := CASE WHEN v_run.status IN ('partial', 'failed') THEN 'page365_inventory_run_failed'
                 WHEN v_hidden > 0                          THEN 'page365_inventory_hidden'
                 WHEN v_applied > 0                         THEN 'page365_inventory_auto_applied' END;

  UPDATE public.page365_inventory_runs
     SET auto_apply_state = v_state, auto_applied = v_applied, auto_increased = v_increased,
         auto_apply_changed = v_changed,
         auto_apply_skipped = v_skipped + v_failed, auto_apply_at = now(),
         hidden_count = hidden_count + v_hidden,
         hide_notified_at = CASE WHEN v_hidden > 0 THEN now() ELSE hide_notified_at END,
         notified_at = CASE WHEN v_type IS NOT NULL THEN now() ELSE notified_at END
   WHERE id = p_run_id;

  -- At most one bell per run (auto_apply_at makes this block run once).
  IF v_type = 'page365_inventory_run_failed' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES (v_type, 'Scheduled Page365 fetch did not complete',
            'The ' || to_char(v_run.created_at AT TIME ZONE 'Asia/Manila', 'HH24:MI') || ' PHT scheduled read was '
              || v_run.status || coalesce(' (' || v_run.error || ')', '') || '. Nothing was applied; the next scheduled fetch tries again.',
            jsonb_build_object('run_id', p_run_id, 'status', v_run.status, 'error', v_run.error));
  ELSIF v_type = 'page365_inventory_hidden' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES (v_type, 'Page365: products hidden on the website',
            v_hidden || ' product(s) no longer on Page365 were hidden on the website automatically (stock 0, unpublished) by the '
              || to_char(v_run.created_at AT TIME ZONE 'Asia/Manila', 'HH24:MI') || ' PHT scheduled fetch: '
              || array_to_string(v_hide_codes[1:10], ', ') || CASE WHEN cardinality(v_hide_codes) > 10 THEN ' …' ELSE '' END || '.'
              || CASE WHEN v_applied > 0 THEN ' ' || (v_applied - v_increased) || ' stock decrease(s) and '
                        || v_increased || ' increase(s) were also applied.' ELSE '' END,
            jsonb_build_object('run_id', p_run_id, 'hidden', v_hidden, 'codes', to_jsonb(v_hide_codes[1:50]),
                               'applied', v_applied, 'applied_codes', to_jsonb(v_codes[1:50]),
                               'increased', v_increased, 'increased_codes', to_jsonb(v_inc_codes[1:50]), 'source', 'schedule'));
  ELSIF v_type = 'page365_inventory_auto_applied' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES (v_type, 'Page365 stock updated automatically',
            (v_applied - v_increased) || ' decrease(s) and ' || v_increased || ' increase(s) applied to website stock from the '
              || to_char(v_run.created_at AT TIME ZONE 'Asia/Manila', 'HH24:MI') || ' PHT scheduled Page365 fetch'
              || CASE WHEN cardinality(v_codes) > 0
                      THEN '. Down: ' || array_to_string(v_codes[1:10], ', ') || CASE WHEN cardinality(v_codes) > 10 THEN ' …' ELSE '' END
                      ELSE '' END
              || CASE WHEN cardinality(v_inc_codes) > 0
                      THEN '. Up: ' || array_to_string(v_inc_codes[1:10], ', ') || CASE WHEN cardinality(v_inc_codes) > 10 THEN ' …' ELSE '' END
                      ELSE '' END || '.',
            jsonb_build_object('run_id', p_run_id, 'applied', v_applied, 'codes', to_jsonb(v_codes[1:50]),
                               'decreased', v_applied - v_increased, 'increased', v_increased,
                               'increased_codes', to_jsonb(v_inc_codes[1:50])));
  END IF;

  RETURN jsonb_build_object('ok', true, 'state', v_state, 'applied', v_applied, 'increased', v_increased,
                            'changed_since_fetch', v_changed,
                            'skipped', v_skipped, 'failed', v_failed, 'hidden', v_hidden,
                            'hide_changed_since_fetch', v_hide_changed, 'hide_skipped', v_hide_skipped,
                            'hide_failed', v_hide_failed, 'notified', v_type);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_auto_apply_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_auto_apply_run(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_auto_apply_run(uuid) IS
  'The ONLY automatic Page365 stock writer (PR 3; hides PR 3b; increases PR 3c). Service role. Closes a SCHEDULED run once: applies its decrease AND increase rows (compare-and-set, never a switched-off product, never an invoice hold in invoice mode) and its hide rows (page365_inventory_hide_item: stock 0 + unpublish, compare-and-set) only when system_settings.page365_inventory_auto_apply is true, the read was ready, the run is inside its 30-minute window and not superseded. Never re-publishes, never drafts, never touches prices or photos. Audits per row and per run; at most one staff bell per run.';
COMMENT ON COLUMN public.page365_inventory_runs.auto_apply_state IS
  'Scheduled runs only (NULL on manual runs and before the run ends). applied = the switch was on and every eligible decrease, increase (PR 3c) AND hide was attempted (see auto_applied, auto_increased, hidden_count); off = the switch was off, nothing applied; not_ready = the read was partial or failed, nothing applied; window_passed = the run ended more than 30 minutes after it began, nothing applied; superseded = a newer ready run existed, nothing applied. Written once, by page365_inventory_auto_apply_run.';

-- ---------------------------------------------------------------------------
-- 8. page365_inventory_create_drafts — PR 4 body; PR 3c edits: only a FULL
--    run (superseded only by a newer full run, 48 h), and only rows read
--    fresh in the last 15 minutes and still on Page365.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_create_drafts(p_run_id uuid, p_item_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_id       uuid;
  v_it       public.page365_inventory_items%ROWTYPE;
  v_prod     public.page365_inventory_products%ROWTYPE;
  v_found    boolean;
  v_multi    boolean;
  v_name     text;
  v_price    integer;
  v_stock    integer;
  v_metals   text[];
  v_desc     text;
  v_cond     text;
  v_cat      uuid;
  v_slug     text;
  v_n        integer;
  v_pid      uuid;
  v_vid      uuid;
  v_existing uuid;
  v_needs    text[];
  v_kind     text;
  v_created  jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_failed   jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'forbidden');
  END IF;
  IF cardinality(coalesce(p_item_ids, '{}')) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'nothing_selected');
  END IF;
  IF cardinality(p_item_ids) > 700 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_many');
  END IF;

  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.status <> 'ready' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_not_ready', 'status', v_run.status);
  END IF;
  -- PR 3c: "New in Page365" comes from the latest FULL read (quick reads open
  -- only Hub products' pages). Quick reads every 30 minutes do not supersede
  -- it; the next full read does. 48 h: one nightly full read may fail.
  IF v_run.kind IS DISTINCT FROM 'full' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_full_fetch');
  END IF;
  IF v_run.finished_at < now() - interval '48 hours' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'run_stale');
  END IF;
  IF EXISTS (SELECT 1 FROM public.page365_inventory_runs r
              WHERE r.status = 'ready' AND r.kind = 'full' AND r.created_at > v_run.created_at) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'superseded');
  END IF;

  FOR v_id IN SELECT DISTINCT x FROM unnest(p_item_ids) x ORDER BY 1 LOOP
    SELECT * INTO v_it FROM public.page365_inventory_items WHERE id = v_id AND run_id = p_run_id FOR UPDATE;
    v_found := FOUND;
    IF NOT v_found THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'reason', 'not_in_run');
      CONTINUE;
    END IF;
    IF v_it.result_note = 'draft_created' THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'already_created',
                                                   'product_id', v_it.website_product_id);
      CONTINUE;
    END IF;
    -- "Don't sync with Page365" (PR 2): a code whose Hub product is switched
    -- off is never drafted — whether the fetch already saw the switch
    -- (category not_synced) or it was switched on since.
    SELECT wp.id INTO v_existing FROM public.website_products wp
     WHERE wp.page365_sync_disabled
       AND (public.page365_first_word(wp.sku) = v_it.code
         OR (wp.page365_product_id = v_it.page365_product_id AND wp.page365_variant_id = v_it.page365_variant_id))
     ORDER BY wp.created_at LIMIT 1;
    IF v_it.category = 'not_synced' OR v_existing IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'sync_disabled',
                                                   'product_id', coalesce(v_existing, v_it.website_product_id));
      IF v_it.status = 'review' THEN
        UPDATE public.page365_inventory_items SET result_note = 'sync_disabled' WHERE id = v_id;
      END IF;
      CONTINUE;
    END IF;
    IF v_it.kind <> 'page365' OR v_it.category <> 'new' OR v_it.match_result <> 'unmatched' OR v_it.status <> 'review'
       OR v_it.code IS NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'not_new');
      CONTINUE;
    END IF;
    -- PR 3c: a draft is made from a FRESH read of the listing — the edge
    -- function re-reads it just before this call (page365_inventory_refresh_product)
    -- — never from the nightly copy. Gone from Page365 since: never drafted.
    IF v_it.result_note = 'gone_from_page365' THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'gone_from_page365');
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.page365_inventory_products p
                    WHERE p.id = v_it.inventory_product_id AND p.fetched_at >= now() - interval '15 minutes') THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'not_fresh');
      CONTINUE;
    END IF;

    -- The code is in the Hub now (made by hand since the fetch, or a sku with
    -- the code as its first word): never a second product.
    SELECT wp.id INTO v_existing FROM public.website_products wp
     WHERE public.page365_first_word(wp.sku) = v_it.code ORDER BY wp.created_at LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'code_exists',
                                                   'product_id', v_existing);
      UPDATE public.page365_inventory_items SET result_note = 'code_exists' WHERE id = v_id;
      CONTINUE;
    END IF;
    SELECT wp.id INTO v_existing FROM public.website_products wp
     WHERE wp.page365_product_id = v_it.page365_product_id AND wp.page365_variant_id = v_it.page365_variant_id;
    IF v_existing IS NOT NULL THEN
      v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'already_created',
                                                   'product_id', v_existing);
      CONTINUE;
    END IF;

    SELECT * INTO v_prod FROM public.page365_inventory_products WHERE id = v_it.inventory_product_id;
    SELECT count(*) INTO v_n FROM public.page365_inventory_items j WHERE j.inventory_product_id = v_it.inventory_product_id;
    v_multi := v_n > 1;
    -- A listing carrying several codes: each product is named by its variant.
    v_name  := btrim(CASE WHEN v_multi AND btrim(coalesce(v_it.variant_name, '')) ~ '\S\s+\S' THEN v_it.variant_name
                          ELSE coalesce(v_it.page365_name, v_prod.name, v_prod.list_name) END);
    v_price := coalesce(v_it.page365_price_jpy, v_prod.price_jpy);
    v_stock := greatest(0, coalesce(v_it.page365_available, 0));
    v_metals := public.page365_metals_from_text(v_name || ' ' || coalesce(v_it.page365_name, '') || ' '
                                                || coalesce(v_prod.list_description, ''));
    v_desc  := public.page365_clean_description(v_prod.list_description);
    v_cond  := CASE WHEN v_name ~* '\[\s*pre-?loved\s*\]' OR coalesce(v_prod.list_category, '') ~* 'pre-?loved'
                    THEN 'Preloved' ELSE 'New' END;
    v_cat   := public.page365_category_for(v_prod.list_category);
    -- Only what Page365 printed: the whole word "watch"/"watches" in the name
    -- or the Page365 category makes a watch (no stamp required). Anything
    -- else is jewelry. Staff can change it in the product dialog.
    v_kind  := CASE WHEN (v_name || ' ' || coalesce(v_it.page365_name, '') || ' ' || coalesce(v_prod.list_category, ''))
                         ~* '\mwatch(es)?\M' THEN 'watch' ELSE 'jewelry' END;

    -- A listing whose name starts with a word, not a code ("Necklace K18 …"):
    -- the first-word rule would make "NECKLACE" the sku. Never.
    IF regexp_replace(regexp_replace(lower(v_it.code), 'es$', ''), 's$', '')
         IN ('ring','necklace','pendant','bracelet','earring','bangle','anklet',
             'brooch','charm','chain','pearl','set','new','preloved','watch')
       OR upper(v_it.code) = ANY (ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900','SILVER925']) THEN
      v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'code_is_a_word');
      CONTINUE;
    END IF;
    IF v_price IS NULL OR v_price <= 0 THEN
      v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'no_price');
      CONTINUE;
    END IF;
    IF cardinality(v_metals) = 0 AND v_kind = 'jewelry' THEN
      v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'no_metal');
      CONTINUE;
    END IF;

    v_slug := left(btrim(regexp_replace(lower(v_it.code || '-' || regexp_replace(v_name, '^\S+\s*', '')),
                                        '[^a-z0-9]+', '-', 'g'), '-'), 90);
    IF v_slug = '' THEN v_slug := lower(v_it.code); END IF;
    IF EXISTS (SELECT 1 FROM public.website_products WHERE slug = v_slug) THEN
      v_slug := v_slug || '-' || v_it.page365_variant_id;
    END IF;

    BEGIN
      INSERT INTO public.website_products (sku, slug, name, status, origin, condition, metals, item_kind, description_en,
                                           page365_product_id, page365_variant_id, page365_category)
      VALUES (v_it.code, v_slug, v_name, 'draft', 'UNKNOWN', v_cond, v_metals, v_kind, v_desc,
              v_it.page365_product_id, v_it.page365_variant_id, v_prod.list_category)
      RETURNING id INTO v_pid;

      INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
      VALUES (v_pid, v_price, v_stock, 0)
      RETURNING id INTO v_vid;

      IF v_cat IS NOT NULL THEN
        INSERT INTO public.website_category_products (category_id, product_id, sort_order) VALUES (v_cat, v_pid, 0);
      END IF;

      -- The item is now matched to the new variant: the PR 1 copier copies its
      -- photos, and the next fetch sees it as an ordinary matched piece.
      UPDATE public.page365_inventory_items
         SET match_result = 'matched', website_product_id = v_pid, variant_id = v_vid, hub_sku = v_it.code,
             hub_price_jpy = v_price, seen_stock = v_stock, web_holds = 0, invoice_holds = 0, proposed_stock = v_stock,
             photos_total = jsonb_array_length(v_prod.photos), photos_to_copy = jsonb_array_length(v_prod.photos),
             photos_removed = 0, price_differs = false,
             status = 'applied', applied_at = now(), applied_by = v_uid, result_note = 'draft_created'
       WHERE id = v_id;

      v_needs := ARRAY['origin']
              || CASE WHEN v_cat IS NULL THEN ARRAY['category'] ELSE ARRAY[]::text[] END;
      INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
      VALUES ('website_product', v_pid, 'page365_draft_created',
              jsonb_build_object('run_id', p_run_id, 'item_id', v_id, 'sku', v_it.code, 'name', v_name,
                                 'price_jpy', v_price, 'stock_qty', v_stock, 'metals', to_jsonb(v_metals), 'item_kind', v_kind,
                                 'condition', v_cond, 'category_id', v_cat, 'page365_category', v_prod.list_category,
                                 'description_copied', v_desc IS NOT NULL, 'photos', jsonb_array_length(v_prod.photos),
                                 'page365_product_id', v_it.page365_product_id, 'page365_variant_id', v_it.page365_variant_id,
                                 'needs', to_jsonb(v_needs)),
              v_uid);
      v_created := v_created || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'product_id', v_pid,
                                                   'variant_id', v_vid, 'name', v_name, 'needs', to_jsonb(v_needs),
                                                   'photos', jsonb_array_length(v_prod.photos));
    EXCEPTION
      WHEN unique_violation THEN
        -- A concurrent press made the same sku between the check and the insert.
        v_skipped := v_skipped || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', 'code_exists');
      WHEN OTHERS THEN
        v_failed := v_failed || jsonb_build_object('item_id', v_id, 'code', v_it.code, 'reason', left(SQLERRM, 300));
    END;
  END LOOP;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('page365_inventory_run', p_run_id, 'page365_inventory_create_drafts',
          jsonb_build_object('created', jsonb_array_length(v_created), 'skipped', jsonb_array_length(v_skipped),
                             'failed', jsonb_array_length(v_failed), 'sent', cardinality(p_item_ids)),
          v_uid);

  RETURN jsonb_build_object('ok', true,
    'created', jsonb_array_length(v_created), 'skipped', jsonb_array_length(v_skipped),
    'failed', jsonb_array_length(v_failed),
    'created_items', v_created, 'skipped_items', v_skipped, 'failed_items', v_failed);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_create_drafts(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.page365_inventory_create_drafts(uuid, uuid[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. Self-check, still inside the transaction. Pure reads; any failure aborts
--    the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn  text;
  v_got text;
  r     record;
BEGIN
  -- Nothing on the website moved, and the switch did not move.
  IF (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
     IS DISTINCT FROM current_setting('page365.quick_catalog_before', true) THEN
    RAISE EXCEPTION 'page365_quick_fetch self-check: a product status or stock changed during this file';
  END IF;
  IF coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'absent')
     IS DISTINCT FROM current_setting('page365.quick_switch_before', true) THEN
    RAISE EXCEPTION 'page365_quick_fetch self-check: the auto-apply switch changed during this file';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_finish(uuid)',                 '6bf16430aedfd4068b45024b8d860e95'),
      ('page365_inventory_auto_apply_run(uuid)',         'd9d251fb68aac0acf9a5360b22fddc07'),
      ('page365_inventory_create_drafts(uuid,uuid[])',   '9ae1eb47496736b925db9625b1e2d373'),
      ('page365_inventory_claim(uuid,integer)',          'fa8a56b999761aa0fab8172ac78f2ed0'),
      ('page365_inventory_store_product(uuid,jsonb,text)', '6ae646ee897b92ca7aa5002f8c416743'),
      ('page365_inventory_apply(uuid,uuid[],uuid[])',    'e65757c2f32b597b2a55047d77783df3'),
      ('page365_inventory_lease(uuid,text,integer)',     '81e98272a20bfb457f8d1bbc09cf594c'),
      ('page365_inventory_follow(uuid)',                 '9c99a035f3812fb39522d087618e461d'),
      ('page365_inventory_hide_item(uuid,uuid,uuid,text)', '3a0a932b88cdd1534a9c0285f8ea392b'),
      ('page365_inventory_retention(integer)',           '9dc2d413a9b146ebc09778c854dad187')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'page365_quick_fetch self-check: % body md5 %, expected %', r.fn, v_got, r.want;
    END IF;
  END LOOP;

  -- Browser roles reach none of the new functions; create_drafts stays theirs.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.page365_inventory_plan_quick(uuid)', 'public.page365_inventory_next_kind()',
    'public.page365_inventory_refresh_product(uuid,jsonb,text)', 'public.page365_inventory_reader_lease(text,integer)',
    'public.page365_inventory_reader_release(text)', 'public.page365_inventory_finish(uuid)',
    'public.page365_inventory_auto_apply_run(uuid)'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_quick_fetch self-check: % is callable by a browser role', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_quick_fetch self-check: service_role cannot run %', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.page365_inventory_create_drafts(uuid,uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.page365_inventory_create_drafts(uuid,uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_quick_fetch self-check: page365_inventory_create_drafts grants are wrong';
  END IF;
  IF has_table_privilege('authenticated', 'public.page365_inventory_reader', 'SELECT')
     OR has_table_privilege('anon', 'public.page365_inventory_reader', 'SELECT') THEN
    RAISE EXCEPTION 'page365_quick_fetch self-check: a browser role can read page365_inventory_reader';
  END IF;

  -- Runs written without a kind (an edge function not yet redeployed) read
  -- every page: they must default to full.
  IF (SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'page365_inventory_runs' AND column_name = 'kind') IS DISTINCT FROM '''full''::text' THEN
    RAISE EXCEPTION 'page365_quick_fetch self-check: page365_inventory_runs.kind must default to full';
  END IF;
  IF (SELECT count(*) FROM public.page365_inventory_reader) <> 1 THEN
    RAISE EXCEPTION 'page365_quick_fetch self-check: page365_inventory_reader must hold exactly one row';
  END IF;
  IF public.page365_inventory_next_kind() NOT IN ('quick', 'full') THEN
    RAISE EXCEPTION 'page365_quick_fetch self-check: page365_inventory_next_kind() is broken';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) Objects, and the switch exactly as before (the owner turned it ON: expect true);
--     expect: true | t | t | t | t | 2
-- SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply') AS auto_apply,
--        to_regprocedure('public.page365_inventory_plan_quick(uuid)') IS NOT NULL                    AS plan_quick,
--        to_regprocedure('public.page365_inventory_next_kind()') IS NOT NULL                         AS next_kind,
--        to_regprocedure('public.page365_inventory_refresh_product(uuid,jsonb,text)') IS NOT NULL    AS refresh,
--        (SELECT pg_get_constraintdef(oid) LIKE '%''listed''%' FROM pg_constraint
--          WHERE conname = 'page365_inventory_products_status_check')                                AS listed_status,
--        (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_full_hour_pht') AS full_hour_pht;
--
-- (2) Bodies; expect exactly:
--     page365_inventory_apply e65757c2f32b597b2a55047d77783df3 ·
--     page365_inventory_auto_apply_run d9d251fb68aac0acf9a5360b22fddc07 ·
--     page365_inventory_create_drafts 9ae1eb47496736b925db9625b1e2d373 ·
--     page365_inventory_finish 6bf16430aedfd4068b45024b8d860e95 ·
--     page365_inventory_follow 9c99a035f3812fb39522d087618e461d ·
--     page365_inventory_hide_item 3a0a932b88cdd1534a9c0285f8ea392b
-- SELECT proname, md5(prosrc) FROM pg_proc
--  WHERE proname IN ('page365_inventory_apply','page365_inventory_auto_apply_run','page365_inventory_create_drafts',
--                    'page365_inventory_finish','page365_inventory_follow','page365_inventory_hide_item')
--  ORDER BY 1;
--
-- (3) Browser roles; expect: f | f | f | t
-- SELECT has_function_privilege('authenticated','public.page365_inventory_plan_quick(uuid)','EXECUTE')                 AS auth_plan,
--        has_function_privilege('authenticated','public.page365_inventory_refresh_product(uuid,jsonb,text)','EXECUTE') AS auth_refresh,
--        has_table_privilege('authenticated','public.page365_inventory_reader','SELECT')                               AS auth_reader,
--        has_function_privilege('authenticated','public.page365_inventory_create_drafts(uuid,uuid[])','EXECUTE')       AS auth_drafts;
--
-- (4) Every run so far is full; expect one row: full | <number of runs kept>
-- SELECT kind, count(*) FROM public.page365_inventory_runs GROUP BY kind;
--
-- (5) What the next scheduled read will be; expect 'quick' if a scheduled read has already started since
--     today's 02:00 PHT, else 'full'.
-- SELECT public.page365_inventory_next_kind();
--
-- (6) How many product pages a quick read will open (the Hub side of the rule; the edge adds the list);
--     expect a number close to your non-archived, synced Hub products.
-- SELECT count(DISTINCT public.page365_first_word(sku)) AS hub_codes
--   FROM public.website_products
--  WHERE status <> 'archived' AND NOT coalesce(page365_sync_disabled, false) AND public.page365_first_word(sku) IS NOT NULL;
--
-- (7) After the edge redeploy, within ~35 minutes: a quick scheduled run; expect kind quick, status ready,
--     products_total ≈ (6), listed_total ≈ page365_count − products_total, seconds well under 60.
-- SELECT created_at, source, kind, status, page365_count, products_total, listed_total,
--        round(extract(epoch FROM finished_at - created_at)) AS seconds, auto_apply_state, auto_applied, auto_increased
--   FROM public.page365_inventory_runs ORDER BY created_at DESC LIMIT 5;
--
-- (8) The next morning (after 02:00 PHT = 03:00 JST): one scheduled FULL run; expect one row, status ready.
-- SELECT created_at, kind, status, products_total FROM public.page365_inventory_runs
--  WHERE source = 'schedule' AND kind = 'full' ORDER BY created_at DESC LIMIT 1;
-- ===========================================================================
