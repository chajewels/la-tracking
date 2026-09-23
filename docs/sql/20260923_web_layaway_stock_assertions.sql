-- ============================================================================
-- Web layaway stock on forfeit + all-or-nothing reactivation — SQL assertions
-- for migrations 20260923130000_record_live_discount_columns and
-- 20260923130100_web_layaway_forfeit_stock.
-- 2026-09-23. Run in the Supabase SQL Editor AFTER both migrations are applied.
-- Claude Code has NOT run this against live (no database access).
--
-- WRITES NOTHING THAT SURVIVES. One transaction, ending in ROLLBACK: a
-- throwaway is_test customer, one throwaway product with one variant, three
-- layaways. Trigger- and function-written audit rows roll back with them.
--
-- What it proves:
--   A  an AUTOMATIC forfeit (the plain status UPDATE auto-forfeit-settlement
--      makes) of a web plan puts its pieces back on sale in the same statement
--      and stamps stock_released_at
--   B  the staff forfeit and the trigger never return the same piece twice
--   C  reactivating a web plan whose piece has sold changes NOTHING: schedule
--      rows stay cancelled, status stays forfeited, is_reactivated stays false,
--      stock untouched — and the refusal names the piece
--   D  a successful reactivation un-cancels the rows, flips the account, adds
--      the Extension Month row and re-holds the pieces, all at once
--   E  extension_active -> final_forfeited (automatic) releases the pieces again
--   F  a Hub plan's forfeit and reactivation touch no website stock
--   G  a failed Extension Month insert still does not block reactivation (the
--      edge function never blocked on it; that tolerance is kept and reported)
--
-- PREFLIGHT (same pattern as 20260923_web_order_gaps_assertions.sql). Before
-- any insert it compares LIVE against the exact live CHECK list for the tables
-- written here (owner's pg_constraint dump, 2026-09-23) and the required
-- columns the fixtures set, and names every difference in one 'PREFLIGHT —'
-- error. Every PL/pgSQL variable is v_-prefixed and every query column is
-- alias-qualified, so no name can be read as both.
--
-- Fixtures vs every live CHECK on the tables written: layaway_accounts —
-- plan 3 months, source_channel 'web' / 'hub_manual', customer_lang 'en' /
-- NULL, discount_type NULL (explicit), totals > 0, total_paid 0, tracking and
-- shipping method both NULL; layaway_schedule — amounts >= 0, installment
-- numbers 1..4, due dates strictly increasing (chronology trigger);
-- website_products — metals {K18}, condition / origin defaults; variants —
-- price_jpy 1000, stock_qty never below 0.
--
-- Reading the result: ends with NOTICE 'ALL WEB LAYAWAY STOCK ASSERTIONS
-- PASSED'. A failure RAISEs 'ASSERTION FAILED — …' naming the check.
-- ============================================================================

BEGIN;

DO $t$
DECLARE
  v_cust    uuid;
  v_prod    uuid;
  v_var     uuid;
  v_web1    uuid;   -- web plan: auto forfeit, sold-piece refusal, reactivation, final forfeit
  v_web2    uuid;   -- web plan: staff forfeit (no double release); extension-row tolerance
  v_hub     uuid;   -- hub plan: no stock involvement
  v_staff   uuid;
  v_res     jsonb;
  v_qty     integer;
  v_cnt     integer;
  v_status  text;
  v_reac    boolean;
  v_marker  timestamptz;
  v_unknown text;
  v_missing text;
BEGIN
  -- ------------------------------------------------------------- preflight
  SELECT string_agg(format('%s.%s: %s', k.con_rel::regclass, k.con_name, pg_get_constraintdef(k.con_oid)), E'\n  ')
    INTO v_unknown
    FROM (SELECT pc.oid AS con_oid, pc.conrelid AS con_rel, pc.conname AS con_name
            FROM pg_constraint pc
           WHERE pc.contype = 'c'
             AND pc.conrelid IN ('public.customers'::regclass, 'public.website_products'::regclass,
                                 'public.website_product_variants'::regclass, 'public.layaway_accounts'::regclass,
                                 'public.layaway_account_items'::regclass, 'public.layaway_schedule'::regclass)
             -- EXACTLY the live CHECK list on these tables (owner, 2026-09-23).
             AND pc.conname <> ALL (ARRAY[
               'website_products_condition_check', 'website_products_metals_nonempty',
               'website_products_metals_values', 'website_products_origin_check',
               'website_product_variants_price_jpy_check', 'website_product_variants_stock_qty_check',
               'layaway_accounts_customer_lang_check', 'layaway_accounts_discount_type_check',
               'layaway_accounts_payment_plan_months_check', 'layaway_accounts_source_channel_check',
               'layaway_accounts_total_amount_check', 'layaway_accounts_total_paid_check',
               'layaway_accounts_tracking_pair_check',
               'base_amount_positive', 'carried_amount_non_negative',
               'layaway_schedule_base_installment_amount_check', 'layaway_schedule_installment_number_check',
               'layaway_schedule_paid_amount_check', 'layaway_schedule_penalty_amount_check',
               'layaway_schedule_total_due_amount_check', 'penalty_non_negative'])) k;

  SELECT string_agg(format('%s.%s', col.table_name, col.column_name), ', ')
    INTO v_missing
    FROM information_schema.columns col
    JOIN (VALUES
      ('customers',                ARRAY['full_name','is_test']),
      ('website_products',         ARRAY['sku','slug','name','status','metals']),
      ('website_product_variants', ARRAY['product_id','price_jpy','stock_qty','sort']),
      ('layaway_accounts',         ARRAY['customer_id','invoice_number','currency','total_amount','remaining_balance',
                                         'payment_plan_months','order_date','status','source_channel']),
      ('layaway_account_items',    ARRAY['account_id','website_product_id','variant_id','title','sku','quantity',
                                         'unit_price_jpy','line_total_jpy']),
      ('layaway_schedule',         ARRAY['account_id','installment_number','due_date','base_installment_amount',
                                         'total_due_amount','currency','status'])
    ) AS want(t, cols) ON want.t = col.table_name
   WHERE col.table_schema = 'public'
     AND col.is_nullable = 'NO'
     AND col.column_default IS NULL
     AND col.is_generated = 'NEVER'
     AND col.is_identity = 'NO'
     AND NOT (col.column_name = ANY (want.cols));

  IF v_unknown IS NOT NULL OR v_missing IS NOT NULL THEN
    RAISE EXCEPTION E'PREFLIGHT — the fixtures were not written against these live objects. Nothing was inserted. Send this whole message to Claude Code.\n CHECK constraints not accounted for:\n  %\n Required columns the fixtures do not set: %',
      coalesce(v_unknown, '(none)'), coalesce(v_missing, '(none)');
  END IF;

  -- The migrations under test must be present.
  IF to_regprocedure('public.reactivate_layaway_atomic(uuid,uuid,date,integer)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgname = 'trg_release_forfeited_web_layaway_stock')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgname = 'trg_rehold_released_web_layaway_stock') THEN
    RAISE EXCEPTION 'PREFLIGHT — migration 20260923130100_web_layaway_forfeit_stock is not applied. Nothing was inserted.';
  END IF;

  -- -------------------------------------------------------------- fixtures
  SELECT ur.user_id INTO v_staff FROM public.user_roles ur WHERE ur.role = 'admin' LIMIT 1;
  IF v_staff IS NULL THEN RAISE EXCEPTION 'setup: no admin user to act as staff'; END IF;

  INSERT INTO public.customers (full_name, is_test)
  VALUES ('ZZ web-layaway-stock assertion', true) RETURNING id INTO v_cust;

  INSERT INTO public.website_products (sku, slug, name, status, metals)
  VALUES ('ZZ-WLS-0923', 'zz-wls-0923', 'ZZ layaway stock assertion', 'active', ARRAY['K18']::text[])
  RETURNING id INTO v_prod;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
  VALUES (v_prod, 1000, 0, 0) RETURNING id INTO v_var;   -- 0: held by the plans below

  INSERT INTO public.layaway_accounts (customer_id, invoice_number, currency, total_amount, remaining_balance,
                                       payment_plan_months, order_date, status, source_channel, web_reference,
                                       downpayment_amount, customer_lang, discount_type)
  VALUES (v_cust, 'ZZWLS0923A', 'JPY', 30000, 30000, 3, current_date - 150, 'overdue', 'web', 'CJ-W-ZZWLSA',
          9000, 'en', NULL)
  RETURNING id INTO v_web1;
  INSERT INTO public.layaway_account_items (account_id, website_product_id, variant_id, title, sku, quantity,
                                            unit_price_jpy, line_total_jpy)
  VALUES (v_web1, v_prod, v_var, 'ZZ layaway stock assertion', 'ZZ-WLS-0923', 1, 30000, 30000);
  INSERT INTO public.layaway_schedule (account_id, installment_number, due_date, base_installment_amount,
                                       total_due_amount, currency, status)
  VALUES (v_web1, 1, current_date - 120, 7000, 7000, 'JPY', 'overdue'),
         (v_web1, 2, current_date - 90,  7000, 7000, 'JPY', 'overdue'),
         (v_web1, 3, current_date - 60,  7000, 7000, 'JPY', 'overdue');

  INSERT INTO public.layaway_accounts (customer_id, invoice_number, currency, total_amount, remaining_balance,
                                       payment_plan_months, order_date, status, source_channel, web_reference,
                                       downpayment_amount, customer_lang, discount_type)
  VALUES (v_cust, 'ZZWLS0923B', 'JPY', 30000, 30000, 3, current_date - 150, 'overdue', 'web', 'CJ-W-ZZWLSB',
          9000, 'en', NULL)
  RETURNING id INTO v_web2;
  INSERT INTO public.layaway_account_items (account_id, website_product_id, variant_id, title, sku, quantity,
                                            unit_price_jpy, line_total_jpy)
  VALUES (v_web2, v_prod, v_var, 'ZZ layaway stock assertion', 'ZZ-WLS-0923', 1, 30000, 30000);
  -- Installments 1..3 plus an existing row 4, so the Extension Month insert
  -- (installment 4) collides — case G.
  INSERT INTO public.layaway_schedule (account_id, installment_number, due_date, base_installment_amount,
                                       total_due_amount, currency, status)
  VALUES (v_web2, 1, current_date - 120, 7000, 7000, 'JPY', 'overdue'),
         (v_web2, 2, current_date - 90,  7000, 7000, 'JPY', 'overdue'),
         (v_web2, 3, current_date - 60,  7000, 7000, 'JPY', 'overdue'),
         (v_web2, 4, current_date - 30,  0,    0,    'JPY', 'pending');

  INSERT INTO public.layaway_accounts (customer_id, invoice_number, currency, total_amount, remaining_balance,
                                       payment_plan_months, order_date, status, source_channel, discount_type)
  VALUES (v_cust, 'ZZWLS0923H', 'JPY', 30000, 30000, 3, current_date - 150, 'overdue', 'hub_manual', NULL)
  RETURNING id INTO v_hub;
  INSERT INTO public.layaway_schedule (account_id, installment_number, due_date, base_installment_amount,
                                       total_due_amount, currency, status)
  VALUES (v_hub, 1, current_date - 120, 7000, 7000, 'JPY', 'overdue');

  -- ======================== A. automatic forfeit returns the web plan's piece
  -- Exactly the write auto-forfeit-settlement makes (PATH 2), then its
  -- schedule cancel.
  UPDATE public.layaway_accounts SET status = 'forfeited', forfeited_at = now(), updated_at = now()
   WHERE id = v_web1;
  UPDATE public.layaway_schedule SET status = 'cancelled', updated_at = now()
   WHERE account_id = v_web1 AND status <> 'paid';
  SELECT la.stock_released_at INTO v_marker FROM public.layaway_accounts la WHERE la.id = v_web1;
  SELECT pv.stock_qty INTO v_qty FROM public.website_product_variants pv WHERE pv.id = v_var;
  IF v_marker IS NULL OR v_qty <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A automatic forfeit: stock_released_at %, stock %', v_marker, v_qty;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs al
                  WHERE al.entity_id = v_web1 AND al.action = 'web_layaway_stock_released') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A no web_layaway_stock_released audit row';
  END IF;

  -- ============ B. staff forfeit: the RPC releases once; the trigger stands aside
  v_res := public.manual_forfeit_layaway_atomic(v_web2, v_staff, 'staff');
  SELECT pv.stock_qty INTO v_qty FROM public.website_product_variants pv WHERE pv.id = v_var;
  IF NOT coalesce((v_res->>'ok')::boolean, false) OR (v_res->>'stock_lines_restored')::int <> 1 OR v_qty <> 2 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B staff forfeit returned % (stock % — expected exactly 2)', v_res, v_qty;
  END IF;
  SELECT count(*) INTO v_cnt FROM public.audit_logs al
   WHERE al.entity_id = v_web2 AND al.action = 'web_layaway_stock_released';
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B the trigger also released the staff-forfeited plan (% rows)', v_cnt;
  END IF;

  -- ================= C. reactivation of a sold piece changes NOTHING
  UPDATE public.website_product_variants SET stock_qty = 0 WHERE id = v_var;   -- both pieces sold
  v_res := public.reactivate_layaway_atomic(v_web1, v_staff, current_date + 30, 0);
  IF v_res->>'error' IS DISTINCT FROM 'out_of_stock'
     OR jsonb_array_length(coalesce(v_res->'lines', '[]'::jsonb)) <> 1
     OR v_res->'lines'->0->>'sku' IS DISTINCT FROM 'ZZ-WLS-0923' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C refusal did not name the piece: %', v_res;
  END IF;
  SELECT la.status::text, la.is_reactivated, la.stock_released_at INTO v_status, v_reac, v_marker
    FROM public.layaway_accounts la WHERE la.id = v_web1;
  SELECT count(*) INTO v_cnt FROM public.layaway_schedule ls WHERE ls.account_id = v_web1 AND ls.status <> 'cancelled';
  SELECT pv.stock_qty INTO v_qty FROM public.website_product_variants pv WHERE pv.id = v_var;
  IF v_status <> 'forfeited' OR v_reac OR v_marker IS NULL OR v_cnt <> 0 OR v_qty <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C refused reactivation wrote something: status %, is_reactivated %, marker %, live rows %, stock %',
      v_status, v_reac, v_marker, v_cnt, v_qty;
  END IF;

  -- ============================ D. successful reactivation, all at once
  UPDATE public.website_product_variants SET stock_qty = 1 WHERE id = v_var;   -- piece back
  v_res := public.reactivate_layaway_atomic(v_web1, v_staff, current_date + 30, 2);
  IF NOT coalesce((v_res->>'ok')::boolean, false) OR NOT (v_res->>'stock_reheld')::boolean
     OR (v_res->>'schedule_rows_uncancelled')::int <> 3 OR NOT (v_res->>'extension_row_inserted')::boolean THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D reactivation returned %', v_res;
  END IF;
  SELECT la.status::text, la.is_reactivated, la.stock_released_at INTO v_status, v_reac, v_marker
    FROM public.layaway_accounts la WHERE la.id = v_web1;
  SELECT pv.stock_qty INTO v_qty FROM public.website_product_variants pv WHERE pv.id = v_var;
  IF v_status <> 'extension_active' OR NOT v_reac OR v_marker IS NOT NULL OR v_qty <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D after reactivation: status %, is_reactivated %, marker %, stock %',
      v_status, v_reac, v_marker, v_qty;
  END IF;
  IF (SELECT count(*) FROM public.layaway_schedule ls WHERE ls.account_id = v_web1 AND ls.status = 'overdue') <> 3
     OR NOT EXISTS (SELECT 1 FROM public.layaway_schedule ls
                     WHERE ls.account_id = v_web1 AND ls.installment_number = 4
                       AND ls.due_date = current_date + 30 AND ls.status = 'pending'
                       AND ls.base_installment_amount = 0 AND ls.total_due_amount = 0) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D schedule rows not un-cancelled or Extension Month row missing';
  END IF;
  IF (SELECT la.penalty_count_at_reactivation FROM public.layaway_accounts la WHERE la.id = v_web1) <> 2
     OR (SELECT la.extension_end_date FROM public.layaway_accounts la WHERE la.id = v_web1) <> current_date + 30 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D reactivation fields not written';
  END IF;

  -- One-time only, answered under the lock.
  v_res := public.reactivate_layaway_atomic(v_web1, v_staff, current_date + 30, 2);
  IF v_res->>'error' IS DISTINCT FROM 'not_forfeited' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D a second reactivation returned %', v_res;
  END IF;

  -- ================== E. extension over, automatic final forfeit releases again
  UPDATE public.layaway_accounts SET status = 'final_forfeited', updated_at = now() WHERE id = v_web1;
  SELECT la.stock_released_at INTO v_marker FROM public.layaway_accounts la WHERE la.id = v_web1;
  SELECT pv.stock_qty INTO v_qty FROM public.website_product_variants pv WHERE pv.id = v_var;
  IF v_marker IS NULL OR v_qty <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E final forfeit: marker %, stock %', v_marker, v_qty;
  END IF;
  v_res := public.reactivate_layaway_atomic(v_web1, v_staff, current_date + 30, 2);
  IF v_res->>'error' IS DISTINCT FROM 'final_forfeited' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E reactivating a final forfeit returned %', v_res;
  END IF;

  -- ========== G. a failed Extension Month insert does not block reactivation
  -- v_web2 already has installment 4, so the Extension Month insert collides.
  v_res := public.reactivate_layaway_atomic(v_web2, v_staff, current_date + 30, 0);
  IF NOT coalesce((v_res->>'ok')::boolean, false) OR (v_res->>'extension_row_inserted')::boolean
     OR v_res->>'extension_row_error' IS NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — G tolerated insert failure returned %', v_res;
  END IF;
  SELECT la.status::text INTO v_status FROM public.layaway_accounts la WHERE la.id = v_web2;
  IF v_status <> 'extension_active' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — G status %', v_status;
  END IF;

  -- ================================ F. hub plan: no website stock involved
  UPDATE public.website_product_variants SET stock_qty = 7 WHERE id = v_var;
  UPDATE public.layaway_accounts SET status = 'forfeited', forfeited_at = now() WHERE id = v_hub;
  v_res := public.reactivate_layaway_atomic(v_hub, v_staff, current_date + 30, 0);
  SELECT la.stock_released_at INTO v_marker FROM public.layaway_accounts la WHERE la.id = v_hub;
  SELECT pv.stock_qty INTO v_qty FROM public.website_product_variants pv WHERE pv.id = v_var;
  IF NOT coalesce((v_res->>'ok')::boolean, false) OR (v_res->>'stock_reheld')::boolean OR v_marker IS NOT NULL OR v_qty <> 7 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — F hub plan: % (marker %, stock %)', v_res, v_marker, v_qty;
  END IF;

  RAISE NOTICE 'ALL WEB LAYAWAY STOCK ASSERTIONS PASSED';
END
$t$;

ROLLBACK;
