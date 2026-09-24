-- ============================================================================
-- Reserve first, pay after staff confirm (A2) — SQL assertions for migration
-- 20260924100000_reserve_first_a2. 2026-09-24. Run in the Supabase SQL Editor
-- AFTER the migration is applied (A1 must already be live).
--
-- Run end-to-end by Claude Code before hand-over in the same scratch Postgres 16
-- the A1 script ran in (baseline + every later migration + A1, Supabase-only
-- pieces stubbed), with 20260924100000 applied on top. Result: ALL PASSED, and
-- the A1 script still passes after it. The scratch copy is not live; the
-- preflight below — the A1 script's own, unchanged — is what makes a live run
-- safe.
--
-- WHAT IT PROVES.
--   A  switch off: the staff bell on a web order and a web plan reads exactly
--      as it did before A2 ('Website order placed' / 'Website layaway placed',
--      with the deposit deadline).
--   B  reserve mode: the bell reads 'New reservation — confirm the piece',
--      names no deadline, and carries metadata.reservation = true.
--   C  email_delivery_report carries the three new keys, and they count what
--      they should: a reserved plan placed, two staff confirmations, one
--      declined plan. The two A1 creation-time stamps (switch off) do NOT count
--      as confirmations.
--   D  reservation_reminded_at exists on both tables, NULL on new orders.
--   E  the cron job exists at 23 * * * * and calls web-reservation-sweep.
--
-- WRITES NOTHING THAT SURVIVES. One transaction, ending in ROLLBACK: four
-- throwaway customers, one throwaway product with eight variants, the quotes,
-- and the orders, plans, notifications and audit rows the RPCs write. Section C
-- needs customers the report does not exclude, so TWO OF THE FOUR ARE
-- is_test = false — they exist only inside this transaction and are gone at the
-- ROLLBACK, exactly like everything else here. The web_order_number_seq values
-- the quotes draw are not rolled back (sequences never are): expect a gap of up
-- to eight invoice numbers, the same gap an abandoned checkout leaves.
--
-- Reading the result: the script ends with NOTICE 'ALL RESERVE-FIRST A2
-- ASSERTIONS PASSED'. Any failure RAISEs 'ASSERTION FAILED — …' naming the
-- check, and the ROLLBACK still runs.
-- ============================================================================

BEGIN;

DO $t$
DECLARE
  v_c1     uuid;   -- is_test: switch-off and reserve bell checks
  v_c2     uuid;   -- is_test: reserve bell checks
  v_c3     uuid;   -- NOT test: report deltas (reserve + confirm)
  v_c4     uuid;   -- NOT test: report deltas (switch off, decline)
  v_p      uuid;
  v_v      uuid[] := '{}';
  v_q      uuid;
  v_admin  uuid;
  v_r      jsonb;
  v_o      uuid;
  v_inv    text;
  v_title  text;
  v_body   text;
  v_meta   jsonb;
  v_before jsonb;
  v_after  jsonb;
  v_unknown text;
  v_missing text;
  i        integer;
BEGIN
  -- ------------------------------------------------------------- preflight
  SELECT string_agg(format('%s.%s: %s', k.con_rel::regclass, k.con_name, pg_get_constraintdef(k.con_oid)), E'\n  ')
    INTO v_unknown
    FROM (SELECT pc.oid AS con_oid, pc.conrelid AS con_rel, pc.conname AS con_name FROM pg_constraint pc
           WHERE pc.contype = 'c'
             AND pc.conrelid IN ('public.customers'::regclass, 'public.website_products'::regclass,
                              'public.website_product_variants'::regclass, 'public.checkout_quotes'::regclass,
                              'public.cash_orders'::regclass, 'public.cash_order_items'::regclass,
                              'public.payment_submissions'::regclass, 'public.layaway_accounts'::regclass,
                              'public.layaway_account_items'::regclass, 'public.layaway_schedule'::regclass,
                              'public.schedule_audit_log'::regclass)
             AND pc.conname <> ALL (ARRAY[
               -- website_products
               'website_products_condition_check', 'website_products_metals_nonempty',
               'website_products_metals_values', 'website_products_origin_check',
               -- website_product_variants
               'website_product_variants_price_jpy_check', 'website_product_variants_stock_qty_check',
               -- checkout_quotes (from the migrations; not yet confirmed against live)
               'checkout_quotes_mode_check', 'checkout_quotes_order_type_check',
               'checkout_quotes_subtotal_jpy_check', 'checkout_quotes_total_jpy_check',
               'checkout_quotes_settlement_currency_check',
               -- cash_orders (payment_status_check now admits awaiting_confirmation)
               'cash_orders_customer_lang_check', 'cash_orders_discount_type_check',
               'cash_orders_order_type_check', 'cash_orders_payment_method_check',
               'cash_orders_payment_status_check', 'cash_orders_refund_status_check',
               'cash_orders_source_channel_check', 'cash_orders_total_amount_check',
               'cash_orders_total_paid_check', 'cash_orders_tracking_pair_check',
               -- layaway_accounts
               'layaway_accounts_customer_lang_check', 'layaway_accounts_discount_type_check',
               'layaway_accounts_payment_plan_months_check', 'layaway_accounts_source_channel_check',
               'layaway_accounts_total_amount_check', 'layaway_accounts_total_paid_check',
               'layaway_accounts_tracking_pair_check',
               -- layaway_schedule
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
      ('checkout_quotes',          ARRAY['customer_id','items','mode','term_months','order_type','subtotal_jpy',
                                         'shipping_jpy','total_jpy','expires_at','settlement_currency']),
      ('payment_submissions',      ARRAY['customer_id','cash_order_id','submitted_amount','payment_date',
                                         'payment_method','status'])
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

  SELECT user_id INTO v_admin FROM public.user_roles WHERE role = 'admin' LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'setup: no admin user to act as staff'; END IF;

  -- ------------------------------------------------------------- fixtures
  INSERT INTO public.customers (full_name, is_test) VALUES ('ZZ reserve-first A2 one', true)    RETURNING id INTO v_c1;
  INSERT INTO public.customers (full_name, is_test) VALUES ('ZZ reserve-first A2 two', true)    RETURNING id INTO v_c2;
  INSERT INTO public.customers (full_name, is_test) VALUES ('ZZ reserve-first A2 three', false) RETURNING id INTO v_c3;
  INSERT INTO public.customers (full_name, is_test) VALUES ('ZZ reserve-first A2 four', false)  RETURNING id INTO v_c4;

  INSERT INTO public.website_products (sku, slug, name, status, metals)
  VALUES ('ZZ-RSV-0924', 'zz-rsv-0924', 'ZZ reserve-first A2 assertion', 'active', ARRAY['K18']::text[])
  RETURNING id INTO v_p;
  FOR i IN 1 .. 8 LOOP
    INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
    VALUES (v_p, 1000, 1, i) RETURNING id INTO v_q;
    v_v := v_v || v_q;
  END LOOP;

  -- ============================================ A — switch off: bell unchanged
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c1, jsonb_build_array(jsonb_build_object('variant_id', v_v[1], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_order_atomic(v_c1, v_q, 'transfer', 'en');
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'setup: A1 cash create returned %', v_r; END IF;
  SELECT title, body, metadata INTO v_title, v_body, v_meta FROM public.staff_notifications
   WHERE metadata->>'cash_order_id' = v_r->>'order_id' ORDER BY created_at DESC LIMIT 1;
  IF v_title IS DISTINCT FROM 'Website order placed' OR v_body NOT LIKE '%paid in full · deposit by %'
     OR v_meta ? 'reservation' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A1 switch-off cash bell: %, %, %', v_title, v_body, v_meta;
  END IF;

  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c1, jsonb_build_array(jsonb_build_object('variant_id', v_v[2], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_layaway_atomic(v_c1, v_q, 'en');
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'setup: A2 layaway create returned %', v_r; END IF;
  SELECT title, body, metadata INTO v_title, v_body, v_meta FROM public.staff_notifications
   WHERE account_id = (v_r->>'account_id')::uuid ORDER BY created_at DESC LIMIT 1;
  IF v_title IS DISTINCT FROM 'Website layaway placed' OR v_body NOT LIKE '% months · deposit by %'
     OR v_meta ? 'reservation' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A2 switch-off layaway bell: %, %, %', v_title, v_body, v_meta;
  END IF;
  IF (SELECT reservation_reminded_at FROM public.layaway_accounts WHERE id = (v_r->>'account_id')::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D1 a new plan carries reservation_reminded_at';
  END IF;

  -- ============================================== B — reserve mode: new title
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c2, jsonb_build_array(jsonb_build_object('variant_id', v_v[3], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_order_atomic(v_c2, v_q, 'transfer', 'en', true);
  IF NOT coalesce((v_r->>'reserved')::boolean, false) THEN RAISE EXCEPTION 'setup: B1 reserved cash create returned %', v_r; END IF;
  SELECT title, body, metadata INTO v_title, v_body, v_meta FROM public.staff_notifications
   WHERE metadata->>'cash_order_id' = v_r->>'order_id' ORDER BY created_at DESC LIMIT 1;
  IF v_title IS DISTINCT FROM 'New reservation — confirm the piece'
     OR v_body NOT LIKE '%no payment deadline until confirmed%' OR v_body LIKE '%deposit by%'
     OR NOT coalesce((v_meta->>'reservation')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B1 reserve cash bell: %, %, %', v_title, v_body, v_meta;
  END IF;
  IF (SELECT reservation_reminded_at FROM public.cash_orders WHERE id = (v_r->>'order_id')::uuid) IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D2 a new reservation carries reservation_reminded_at';
  END IF;

  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c2, jsonb_build_array(jsonb_build_object('variant_id', v_v[4], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_layaway_atomic(v_c2, v_q, 'en', p_reserve => true);
  IF NOT coalesce((v_r->>'reserved')::boolean, false) THEN RAISE EXCEPTION 'setup: B2 reserved layaway create returned %', v_r; END IF;
  SELECT title, body, metadata INTO v_title, v_body, v_meta FROM public.staff_notifications
   WHERE account_id = (v_r->>'account_id')::uuid ORDER BY created_at DESC LIMIT 1;
  IF v_title IS DISTINCT FROM 'New reservation — confirm the piece'
     OR v_body NOT LIKE '%layaway ¥1,000 over 3 months · no payment deadline until confirmed%'
     OR NOT coalesce((v_meta->>'reservation')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B2 reserve layaway bell: %, %, %', v_title, v_body, v_meta;
  END IF;

  -- ========================================== C — email_delivery_report keys
  v_before := public.email_delivery_report(1)->'expected';
  IF NOT (v_before ? 'web_layaways_placed' AND v_before ? 'web_reservations_confirmed' AND v_before ? 'web_layaways_closed') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C0 report is missing a new key: %', v_before;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(v_before)) <> 15 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C0 report has % keys, expected 15', (SELECT count(*) FROM jsonb_object_keys(v_before));
  END IF;

  -- c4, switch off: one cash order + one plan. Placed counts move; confirmed
  -- does NOT (A1's creation stamp leaves ready_confirmed_by NULL).
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c4, jsonb_build_array(jsonb_build_object('variant_id', v_v[5], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  PERFORM public.create_web_order_atomic(v_c4, v_q, 'transfer', 'en');
  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c4, jsonb_build_array(jsonb_build_object('variant_id', v_v[6], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  PERFORM public.create_web_layaway_atomic(v_c4, v_q, 'en');

  -- c3, reserve mode: a cash reservation and a plan reservation, both
  -- confirmed by staff; then a second plan reservation, declined.
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[7], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_order_atomic(v_c3, v_q, 'transfer', 'en', true);
  v_r := public.confirm_web_order_ready_atomic('cash_order', (v_r->>'order_id')::uuid, v_admin, 'assertion');
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'setup: C cash confirm returned %', v_r; END IF;

  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[8], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_layaway_atomic(v_c3, v_q, 'en', p_reserve => true);
  v_r := public.confirm_web_order_ready_atomic('layaway', (v_r->>'account_id')::uuid, v_admin, 'assertion');
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'setup: C layaway confirm returned %', v_r; END IF;

  -- The declined plan reuses variant 4's stock, freed by declining c2's plan
  -- first (c2 is a test customer, so that decline must NOT count).
  SELECT id INTO v_o FROM public.layaway_accounts WHERE customer_id = v_c2 AND status = 'active';
  v_r := public.decline_web_layaway_reservation_atomic(v_o, 'assertion — test customer', v_admin);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'setup: C test decline returned %', v_r; END IF;
  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[4], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_layaway_atomic(v_c3, v_q, 'en', p_reserve => true);
  v_r := public.decline_web_layaway_reservation_atomic((v_r->>'account_id')::uuid, 'assertion — cannot supply', v_admin);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN RAISE EXCEPTION 'setup: C decline returned %', v_r; END IF;

  v_after := public.email_delivery_report(1)->'expected';
  -- Placed: c4's plan (switch off) + c3's two plans (reserve) = 3.
  IF (v_after->>'web_layaways_placed')::int - (v_before->>'web_layaways_placed')::int <> 3 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C1 web_layaways_placed moved by %, expected 3',
      (v_after->>'web_layaways_placed')::int - (v_before->>'web_layaways_placed')::int;
  END IF;
  -- Confirmed: c3's cash + c3's first plan = 2. c4's switch-off stamps do not count.
  IF (v_after->>'web_reservations_confirmed')::int - (v_before->>'web_reservations_confirmed')::int <> 2 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C2 web_reservations_confirmed moved by %, expected 2',
      (v_after->>'web_reservations_confirmed')::int - (v_before->>'web_reservations_confirmed')::int;
  END IF;
  -- Closed: c3's declined plan = 1. c2's decline is a test customer.
  IF (v_after->>'web_layaways_closed')::int - (v_before->>'web_layaways_closed')::int <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C3 web_layaways_closed moved by %, expected 1',
      (v_after->>'web_layaways_closed')::int - (v_before->>'web_layaways_closed')::int;
  END IF;
  -- Cash placed: c4 + c3 = 2 (existing key, unchanged rule).
  IF (v_after->>'web_orders_placed')::int - (v_before->>'web_orders_placed')::int <> 2 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C4 web_orders_placed moved by %, expected 2',
      (v_after->>'web_orders_placed')::int - (v_before->>'web_orders_placed')::int;
  END IF;

  -- ========================================================== D, E — schema
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'reservation_reminded_at'
         AND table_name IN ('cash_orders', 'layaway_accounts') AND is_nullable = 'YES') <> 2 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D3 reservation_reminded_at is not a nullable column on both tables';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'web-reservation-sweep' AND schedule = '23 * * * *'
                    AND command LIKE '%/functions/v1/web-reservation-sweep%'
                    AND command LIKE '%email_queue_service_role_key%') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E1 cron web-reservation-sweep missing, mis-scheduled or not Vault-backed';
  END IF;

  RAISE NOTICE 'ALL RESERVE-FIRST A2 ASSERTIONS PASSED';
END
$t$;

ROLLBACK;
