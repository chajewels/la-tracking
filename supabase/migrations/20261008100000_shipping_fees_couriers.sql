-- ===========================================================================
-- shipping_fees_couriers — website-orders PR 2
-- (~/Code/reference/website-orders/INVESTIGATION-v2.md §7 row 2, §2.7, §3;
--  owner decisions W2-1..W2-12 approved 2026-09-27, W2-10 amended: only PH
--  has a default courier, and that default is applied by the PR 4
--  confirmation screen, never by the database).
--
-- OWNER RUNS THIS in the Supabase SQL Editor, as-is, AFTER the release PR is on
-- main. NOT through Lovable. No edge function changes, nothing to deploy.
-- One transaction; safe to re-run (every step is idempotent and the self-check
-- at the end aborts the whole file if the result is not as written).
--
-- What it does:
--
--   A. THE RATE CARD MOVES ONLY THROUGH TWO ADMIN RPCs.
--      set_shipping_rate(country, min_subtotal_jpy, fee_jpy)
--        add a rate, change a fee, or reactivate a deactivated threshold
--      deactivate_shipping_rate(id)
--        switch a rate off (a rate is NEVER deleted)
--      Both: ADMIN ROLE only (re-checked here, not trusted from the browser),
--      one audit_logs row per change (entity_type 'shipping_rate').
--      get_shipping_rates() reads the card for the Hub.
--      trg_guard_shipping_rates refuses every other INSERT/UPDATE, and refuses
--      DELETE and TRUNCATE always — including from the SQL Editor.
--
--   B. RECORD-ONLY CONVERGENCE (§3). Live already reads JP 0 → 800 and
--      JP 8000 → 0 (the owner's 2026-09 SQL Editor UPDATE of the JP 50000
--      seed row). A rebuild from supabase/migrations/ must end in the same
--      state. On live this step changes nothing.
--
--   C. COURIERS. shipping_methods gains "Pabitbit Service (Japan → Philippines,
--      LBC local delivery)", tracked with the LBC number on the LBC template
--      (W2-11). Inserted only if missing.
--
--   D. planned_shipping_method_id (nullable, FK shipping_methods) on
--      cash_orders and layaway_accounts — the two tables the web checkout
--      writes (create_web_order_atomic → cash_orders,
--      create_web_layaway_atomic → layaway_accounts; v2 §1.1). NO database
--      default. Nothing writes it yet: PR 4's confirmation screen does, and
--      that screen (not this file) preselects Pabitbit for PH. JP and every
--      other country have no default — staff choose (JP: Yamato or Japan Post
--      Yu-Pack; elsewhere: DHL Express or Japan Post EMS).
--
-- Read-only verification queries, with the exact expected result of each,
-- are at the end of the file.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Preflight: every object this file relies on exists.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.shipping_rates')   IS NULL THEN v_missing := v_missing || 'shipping_rates'::text; END IF;
  IF to_regclass('public.shipping_methods') IS NULL THEN v_missing := v_missing || 'shipping_methods'::text; END IF;
  IF to_regclass('public.cash_orders')      IS NULL THEN v_missing := v_missing || 'cash_orders'::text; END IF;
  IF to_regclass('public.layaway_accounts') IS NULL THEN v_missing := v_missing || 'layaway_accounts'::text; END IF;
  IF to_regclass('public.audit_logs')       IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regprocedure('public.has_role(uuid, public.app_role)') IS NULL THEN
    v_missing := v_missing || 'has_role(uuid, app_role)'::text;
  END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'shipping_fees_couriers: missing: %', array_to_string(v_missing, ', ');
  END IF;
  -- Every function below is NEW. If live already holds one of these names
  -- with another signature, someone built it in the SQL Editor: stop, so it
  -- is read from live first (CLAUDE.md "FUNCTION CHANGES START FROM LIVE").
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND (
          (p.proname = 'get_shipping_rates'       AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'set_shipping_rate'        AND pg_get_function_identity_arguments(p.oid) <> 'p_country text, p_min_subtotal_jpy integer, p_fee_jpy integer')
       OR (p.proname = 'deactivate_shipping_rate' AND pg_get_function_identity_arguments(p.oid) <> 'p_id uuid')
       OR (p.proname = 'guard_shipping_rates'     AND pg_get_function_identity_arguments(p.oid) <> ''))) THEN
    RAISE EXCEPTION 'shipping_fees_couriers: a shipping-rate function already exists on live with another signature. Read it with pg_get_functiondef before applying this file.';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Guard: shipping_rates changes only through the RPCs below.
--    DELETE and TRUNCATE are refused ALWAYS, with or without the flag: a
--    deleted row would come back ACTIVE on the next rebuild from migrations
--    (the seeds use ON CONFLICT DO NOTHING), while a deactivated row survives
--    it (v2 §3). Deactivate instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_shipping_rates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Shipping rates are never deleted. Deactivate the rate in the Hub: Website → Settings → Shipping fees.'
      USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(current_setting('app.allow_shipping_rates_change', true), '') <> 'on' THEN
    RAISE EXCEPTION 'Shipping rates are changed only from the Hub: Website → Settings → Shipping fees (set_shipping_rate / deactivate_shipping_rate).'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_shipping_rates() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Record-only convergence (v2 §3). Runs BEFORE the guard trigger exists on
--    a first run; on a re-run the trigger exists, so the flag is set locally.
--
--    WHY THE OLD "JP 50000 → 0" SEED CANNOT COME BACK:
--    The only two statements that ever insert shipping_rates are the identical
--    seeds in 20260911024728_…sql:163-165 and 20260911120000_…sql:163-165
--    (INSERT … ('JP',50000,0) … ON CONFLICT (country, min_subtotal_jpy) DO
--    NOTHING).
--      * On LIVE both versions are recorded in
--        supabase_migrations.schema_migrations, and an applied migration never
--        runs again. Live reads JP 8000 → 0 and has no 50000 row, so the
--        UPDATE below matches nothing: a no-op.
--      * On a REBUILD (local reset, preview branch, disaster rebuild) the
--        migrations replay in version order: the seeds (2026-09-11) insert
--        JP 50000 → 0 first, and this file (2026-10-08) runs after them and
--        moves that row to 8000. No later migration inserts a rate, and from
--        here on the guard trigger refuses any insert that does not come
--        through set_shipping_rate — so the rebuild ends at JP 0 → 800,
--        JP 8000 → 0, the same card as live.
--      * If a rebuild somehow holds BOTH free rows, the 50000 one is switched
--        off (never deleted), so the card states one threshold.
-- ---------------------------------------------------------------------------
SELECT set_config('app.allow_shipping_rates_change', 'on', true);

UPDATE public.shipping_rates
   SET min_subtotal_jpy = 8000
 WHERE country = 'JP' AND min_subtotal_jpy = 50000 AND fee_jpy = 0
   AND NOT EXISTS (SELECT 1 FROM public.shipping_rates WHERE country = 'JP' AND min_subtotal_jpy = 8000);

UPDATE public.shipping_rates
   SET is_active = false
 WHERE country = 'JP' AND min_subtotal_jpy = 50000 AND fee_jpy = 0 AND is_active
   AND EXISTS (SELECT 1 FROM public.shipping_rates WHERE country = 'JP' AND min_subtotal_jpy = 8000 AND fee_jpy = 0);

SELECT set_config('app.allow_shipping_rates_change', '', true);

DROP TRIGGER IF EXISTS trg_guard_shipping_rates ON public.shipping_rates;
CREATE TRIGGER trg_guard_shipping_rates
BEFORE INSERT OR UPDATE OR DELETE ON public.shipping_rates
FOR EACH ROW EXECUTE FUNCTION public.guard_shipping_rates();

DROP TRIGGER IF EXISTS trg_guard_shipping_rates_truncate ON public.shipping_rates;
CREATE TRIGGER trg_guard_shipping_rates_truncate
BEFORE TRUNCATE ON public.shipping_rates
FOR EACH STATEMENT EXECUTE FUNCTION public.guard_shipping_rates();

COMMENT ON TABLE public.shipping_rates IS
  'Storefront shipping rate card, read by the website function''s /checkout/quote (shippingFor). Shipping is charged on the pieces subtotal; the active row with the HIGHEST min_subtotal_jpy the subtotal clears applies. A country with no active row returns shipping: null + requires_manual_quote: true. Changed ONLY through set_shipping_rate / deactivate_shipping_rate (admin, audited; Hub → Website → Settings → Shipping fees). trg_guard_shipping_rates refuses every other write and refuses DELETE/TRUNCATE always — deactivate, never delete.';

-- ---------------------------------------------------------------------------
-- 3. Read for the Hub card.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_shipping_rates()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  RETURN jsonb_build_object(
    'can_change', public.has_role(v_uid, 'admin'::public.app_role),
    'rates', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'country', r.country, 'min_subtotal_jpy', r.min_subtotal_jpy,
               'fee_jpy', r.fee_jpy, 'is_active', r.is_active, 'updated_at', r.updated_at)
             ORDER BY r.country, r.min_subtotal_jpy)
        FROM public.shipping_rates r), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_shipping_rates() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_shipping_rates() TO authenticated;
COMMENT ON FUNCTION public.get_shipping_rates() IS
  'The shipping rate card for Hub → Website → Settings → Shipping fees: every row (active and inactive), by country then threshold, plus can_change (admin role).';

-- ---------------------------------------------------------------------------
-- 4. set_shipping_rate — add a threshold, change its fee, or reactivate it.
--    Keyed on (country, min_subtotal_jpy), the table's unique key.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_shipping_rate(
  p_country text, p_min_subtotal_jpy integer, p_fee_jpy integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_country text := upper(btrim(coalesce(p_country, '')));
  v_old     public.shipping_rates%ROWTYPE;
  v_new     public.shipping_rates%ROWTYPE;
  v_action  text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  -- ADMIN ONLY — by role, not by permission key, so no override can grant it.
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  -- shippingFor upper-cases the address country and matches it exactly.
  IF v_country !~ '^[A-Z]{2}$' THEN RETURN jsonb_build_object('error', 'invalid_country'); END IF;
  IF p_min_subtotal_jpy IS NULL OR p_min_subtotal_jpy < 0 OR p_min_subtotal_jpy > 100000000 THEN
    RETURN jsonb_build_object('error', 'invalid_threshold');
  END IF;
  IF p_fee_jpy IS NULL OR p_fee_jpy < 0 OR p_fee_jpy > 1000000 THEN
    RETURN jsonb_build_object('error', 'invalid_fee');
  END IF;

  SELECT * INTO v_old FROM public.shipping_rates
   WHERE country = v_country AND min_subtotal_jpy = p_min_subtotal_jpy
   FOR UPDATE;

  IF v_old.id IS NOT NULL AND v_old.fee_jpy = p_fee_jpy AND v_old.is_active THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'action', 'unchanged', 'rate', to_jsonb(v_old));
  END IF;

  PERFORM set_config('app.allow_shipping_rates_change', 'on', true);
  IF v_old.id IS NULL THEN
    INSERT INTO public.shipping_rates (country, min_subtotal_jpy, fee_jpy, is_active)
    VALUES (v_country, p_min_subtotal_jpy, p_fee_jpy, true)
    RETURNING * INTO v_new;
    v_action := 'created';
  ELSE
    UPDATE public.shipping_rates SET fee_jpy = p_fee_jpy, is_active = true
     WHERE id = v_old.id
    RETURNING * INTO v_new;
    v_action := CASE WHEN NOT v_old.is_active THEN 'reactivated' ELSE 'fee_changed' END;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('shipping_rate', v_new.id, 'set_shipping_rate',
          CASE WHEN v_old.id IS NULL THEN NULL ELSE to_jsonb(v_old) END,
          to_jsonb(v_new) || jsonb_build_object('change', v_action),
          v_uid, now());
  PERFORM set_config('app.allow_shipping_rates_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'action', v_action, 'rate', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_shipping_rate(text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_shipping_rate(text, integer, integer) TO authenticated;
COMMENT ON FUNCTION public.set_shipping_rate(text, integer, integer) IS
  'Adds a shipping threshold, changes its fee, or reactivates it (keyed on country + min_subtotal_jpy). Admin role only; one audit_logs row (shipping_rate / set_shipping_rate, old -> new). With deactivate_shipping_rate, the ONLY writer of shipping_rates (trg_guard_shipping_rates).';

-- ---------------------------------------------------------------------------
-- 5. deactivate_shipping_rate — switch a rate off. Never deletes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deactivate_shipping_rate(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.shipping_rates%ROWTYPE;
  v_new public.shipping_rates%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_old FROM public.shipping_rates WHERE id = p_id FOR UPDATE;
  IF v_old.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF NOT v_old.is_active THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'action', 'unchanged', 'rate', to_jsonb(v_old));
  END IF;

  PERFORM set_config('app.allow_shipping_rates_change', 'on', true);
  UPDATE public.shipping_rates SET is_active = false WHERE id = v_old.id RETURNING * INTO v_new;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('shipping_rate', v_new.id, 'deactivate_shipping_rate', to_jsonb(v_old),
          to_jsonb(v_new) || jsonb_build_object('change', 'deactivated'), v_uid, now());
  PERFORM set_config('app.allow_shipping_rates_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'action', 'deactivated', 'rate', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.deactivate_shipping_rate(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.deactivate_shipping_rate(uuid) TO authenticated;
COMMENT ON FUNCTION public.deactivate_shipping_rate(uuid) IS
  'Switches a shipping rate off (is_active = false). Never deletes. Admin role only; one audit_logs row (shipping_rate / deactivate_shipping_rate). Reactivate with set_shipping_rate on the same country + threshold.';

-- ---------------------------------------------------------------------------
-- 6. Courier: Pabitbit (W2-11). Tracked with the LBC number, so the row takes
--    the LBC row's tracking template, read from the LBC row itself (not
--    retyped here). Last in the list. Inserted only if missing.
-- ---------------------------------------------------------------------------
DO $courier$
DECLARE
  v_lbc_template text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.shipping_methods WHERE provider_name = 'Pabitbit') THEN
    RETURN;
  END IF;
  SELECT tracking_url_template INTO v_lbc_template
    FROM public.shipping_methods
   WHERE provider_name = 'LBC' AND title = 'LBC Express (PH Domestic)';
  IF v_lbc_template IS NULL THEN
    RAISE EXCEPTION 'shipping_fees_couriers: the LBC row "LBC Express (PH Domestic)" is missing, so Pabitbit has no tracking template to copy. Nothing was changed.';
  END IF;
  INSERT INTO public.shipping_methods (provider_name, title, tracking_url_template, is_active, sort_order, notes)
  VALUES ('Pabitbit', 'Pabitbit Service (Japan → Philippines, LBC local delivery)', v_lbc_template, true,
          (SELECT coalesce(max(sort_order), 0) + 1 FROM public.shipping_methods),
          'Japan → Philippines forwarder; LBC delivers locally. Staff record the LBC tracking number, so the template is the LBC one (website-orders W2-11). Default courier for PH web orders, preselected by the confirmation screen (not by the database).')
  ON CONFLICT (provider_name, title) DO NOTHING;
END
$courier$;

-- ---------------------------------------------------------------------------
-- 7. planned_shipping_method_id on both web order tables. No default.
-- ---------------------------------------------------------------------------
ALTER TABLE public.cash_orders      ADD COLUMN IF NOT EXISTS planned_shipping_method_id uuid;
ALTER TABLE public.layaway_accounts ADD COLUMN IF NOT EXISTS planned_shipping_method_id uuid;

ALTER TABLE public.cash_orders      DROP CONSTRAINT IF EXISTS cash_orders_planned_shipping_method_id_fkey;
ALTER TABLE public.cash_orders
  ADD CONSTRAINT cash_orders_planned_shipping_method_id_fkey
  FOREIGN KEY (planned_shipping_method_id) REFERENCES public.shipping_methods(id) ON DELETE RESTRICT;
ALTER TABLE public.layaway_accounts DROP CONSTRAINT IF EXISTS layaway_accounts_planned_shipping_method_id_fkey;
ALTER TABLE public.layaway_accounts
  ADD CONSTRAINT layaway_accounts_planned_shipping_method_id_fkey
  FOREIGN KEY (planned_shipping_method_id) REFERENCES public.shipping_methods(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_cash_orders_planned_shipping_method
  ON public.cash_orders (planned_shipping_method_id) WHERE planned_shipping_method_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_layaway_accounts_planned_shipping_method
  ON public.layaway_accounts (planned_shipping_method_id) WHERE planned_shipping_method_id IS NOT NULL;

COMMENT ON COLUMN public.cash_orders.planned_shipping_method_id IS
  'The courier staff plan to ship with, chosen when a website order is confirmed (website-orders PR 4). NOT the courier that shipped it (shipping_method_id + tracking_number record that). No database default: PH is preselected to Pabitbit by the confirmation screen; JP and other countries have no default and staff choose.';
COMMENT ON COLUMN public.layaway_accounts.planned_shipping_method_id IS
  'The courier staff plan to ship with, chosen when a website layaway is confirmed (website-orders PR 4). NOT the courier that shipped it (shipping_method_id + tracking_number record that). No database default: PH is preselected to Pabitbit by the confirmation screen; JP and other countries have no default and staff choose.';

-- ---------------------------------------------------------------------------
-- 8. Self-check. Aborts the whole file if anything is not as written.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_shipping_rates'
                    AND tgrelid = 'public.shipping_rates'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_guard_shipping_rates_truncate'
                    AND tgrelid = 'public.shipping_rates'::regclass) THEN
    RAISE EXCEPTION 'shipping_fees_couriers self-check: guard trigger missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shipping_rates WHERE country = 'JP' AND min_subtotal_jpy = 50000 AND is_active) THEN
    RAISE EXCEPTION 'shipping_fees_couriers self-check: an active JP 50000 row remains';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.shipping_rates WHERE country = 'JP' AND min_subtotal_jpy = 8000 AND fee_jpy = 0) THEN
    RAISE EXCEPTION 'shipping_fees_couriers self-check: JP 8000 -> 0 is missing';
  END IF;
  IF (SELECT count(*) FROM public.shipping_methods WHERE provider_name = 'Pabitbit') <> 1
     OR (SELECT p.tracking_url_template FROM public.shipping_methods p WHERE p.provider_name = 'Pabitbit')
        IS DISTINCT FROM (SELECT l.tracking_url_template FROM public.shipping_methods l
                           WHERE l.provider_name = 'LBC' AND l.title = 'LBC Express (PH Domestic)') THEN
    RAISE EXCEPTION 'shipping_fees_couriers self-check: Pabitbit row missing, duplicated, or not on the LBC template';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'planned_shipping_method_id'
         AND table_name IN ('cash_orders','layaway_accounts') AND column_default IS NULL AND is_nullable = 'YES') <> 2 THEN
    RAISE EXCEPTION 'shipping_fees_couriers self-check: planned_shipping_method_id is not nullable/default-free on both tables';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY['public.get_shipping_rates()', 'public.set_shipping_rate(text,integer,integer)',
                              'public.deactivate_shipping_rate(uuid)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'shipping_fees_couriers self-check: grants on % are wrong', v_fn;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.guard_shipping_rates()', 'EXECUTE') THEN
    RAISE EXCEPTION 'shipping_fees_couriers self-check: guard_shipping_rates() is callable by a browser role';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT. Each block states the EXACT
-- expected result on live (live as confirmed by the owner on 2026-09-27).
--
-- (1) The rate card is unchanged by this file. Expect exactly 4 rows:
--       JP |      0 |  800 | t
--       JP |   8000 |    0 | t
--       PH |      0 | 3500 | t
--       PH | 100000 |    0 | t
-- SELECT country, min_subtotal_jpy, fee_jpy, is_active
--   FROM public.shipping_rates ORDER BY country, min_subtotal_jpy;
--
-- (2) No JP 50000 row, active or not. Expect: 0
-- SELECT count(*) FROM public.shipping_rates WHERE country = 'JP' AND min_subtotal_jpy = 50000;
--
-- (3) The rate card is guarded. Expect 2 rows:
--       trg_guard_shipping_rates
--       trg_guard_shipping_rates_truncate
-- SELECT tgname FROM pg_trigger
--  WHERE tgrelid = 'public.shipping_rates'::regclass AND tgname LIKE 'trg_guard_shipping_rates%'
--  ORDER BY tgname;
--
-- (4) Couriers. Expect exactly 6 rows, all is_active = t; Pabitbit is LAST
--     (highest sort_order) and its template is the LBC one. Expect exactly
--     one row from the second query: 6 | 1 | t | t | t
-- SELECT provider_name, title, tracking_url_template, is_active, sort_order
--   FROM public.shipping_methods ORDER BY sort_order, provider_name;
-- SELECT (SELECT count(*) FROM public.shipping_methods)                                  AS couriers,
--        (SELECT count(*) FROM public.shipping_methods WHERE provider_name = 'Pabitbit') AS pabitbit_rows,
--        p.tracking_url_template = l.tracking_url_template                                 AS same_template_as_lbc,
--        p.sort_order > ALL (SELECT sort_order FROM public.shipping_methods WHERE id <> p.id) AS pabitbit_last,
--        p.is_active                                                                       AS pabitbit_active
--   FROM public.shipping_methods p, public.shipping_methods l
--  WHERE p.provider_name = 'Pabitbit' AND l.provider_name = 'LBC' AND l.title = 'LBC Express (PH Domestic)';
--
-- (5) The new column on both web order tables, nullable, no default, empty.
--     Expect exactly 2 rows:
--       cash_orders      | uuid | YES | (null) | 0
--       layaway_accounts | uuid | YES | (null) | 0
-- SELECT c.table_name, c.data_type, c.is_nullable, c.column_default,
--        CASE c.table_name
--          WHEN 'cash_orders' THEN (SELECT count(*) FROM public.cash_orders WHERE planned_shipping_method_id IS NOT NULL)
--          ELSE (SELECT count(*) FROM public.layaway_accounts WHERE planned_shipping_method_id IS NOT NULL) END AS rows_set
--   FROM information_schema.columns c
--  WHERE c.table_schema = 'public' AND c.column_name = 'planned_shipping_method_id'
--  ORDER BY c.table_name;
--
-- (6) Browser grants. Expect one row: f | t | f | t | f | t | f
-- SELECT has_function_privilege('anon',          'public.get_shipping_rates()',                    'EXECUTE') AS anon_get,
--        has_function_privilege('authenticated', 'public.get_shipping_rates()',                    'EXECUTE') AS auth_get,
--        has_function_privilege('anon',          'public.set_shipping_rate(text,integer,integer)', 'EXECUTE') AS anon_set,
--        has_function_privilege('authenticated', 'public.set_shipping_rate(text,integer,integer)', 'EXECUTE') AS auth_set,
--        has_function_privilege('anon',          'public.deactivate_shipping_rate(uuid)',          'EXECUTE') AS anon_off,
--        has_function_privilege('authenticated', 'public.deactivate_shipping_rate(uuid)',          'EXECUTE') AS auth_off,
--        has_function_privilege('authenticated', 'public.guard_shipping_rates()',                  'EXECUTE') AS auth_guard;
--
-- (7) Nothing audited yet (the file writes no audit row; only the Hub card
--     does). Expect: 0
-- SELECT count(*) FROM public.audit_logs WHERE entity_type = 'shipping_rate';
-- ===========================================================================
