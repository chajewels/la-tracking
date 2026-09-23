-- ============================================================================
-- Reserve first, pay after staff confirm (A1) — SQL assertions for migration
-- 20260923140000_reserve_first_a1. 2026-09-23. Run in the Supabase SQL Editor
-- AFTER the migration is applied.
--
-- Run end-to-end by Claude Code before hand-over in a scratch Postgres 16:
-- the 20260705230000 baseline plus every later migration, with Supabase-only
-- pieces stubbed (auth, cron, net, vault) and the live-only objects the repo
-- does not record (cash_orders.source_channel, cash_order_items,
-- store_credit_lots) added by hand. The four functions this migration changes
-- md5-matched the repo there before the migration ran. Result: ALL PASSED, and
-- the two earlier 20260923 assertion scripts still pass after the migration.
-- The scratch copy is not live. The preflight below is what makes a live run
-- safe.
--
-- WRITES NOTHING THAT SURVIVES. Everything happens inside one transaction that
-- ends in ROLLBACK: two throwaway is_test customers, one throwaway product with
-- eight variants, checkout quotes, the orders and plans the RPCs create from
-- them, and the audit / notification rows their triggers write. The website
-- revalidation trigger calls net.http_post, which only queues in-transaction,
-- so ROLLBACK sends nothing. The web_order_number_seq values the quotes draw are
-- NOT rolled back (sequences never are): expect a gap of up to eight invoice
-- numbers, the same gap an abandoned checkout leaves.
--
-- Reading the result: the script ends with NOTICE 'ALL RESERVE-FIRST A1
-- ASSERTIONS PASSED'. Any failure RAISEs 'ASSERTION FAILED — …' naming the
-- check, and the ROLLBACK still runs.
--
-- WHO ACTS. The confirming staff member is any admin (has_permission
-- short-circuits admin). The REFUSED user is a real finance user with no
-- per-user override on confirm_web_order_ready. If live has none, the script
-- uses a random uuid with no role at all, which has_permission also refuses,
-- and says so in a NOTICE; the finance role row is asserted false either way.
--
-- PREFLIGHT. Before any insert, the script compares LIVE against the CHECK list
-- the fixtures were written against: every CHECK constraint on the tables it
-- writes that it does not know, and every NOT NULL column without a default
-- that a fixture does not set, are ALL named in one 'PREFLIGHT —' error and
-- nothing is inserted. The list for the tables 20260923_web_order_gaps_assertions
-- also writes is that script's list, which is EXACTLY live pg_constraint
-- (owner, 2026-09-23). checkout_quotes is new here; its five CHECKs are the
-- ones the migrations define (mode, order_type, subtotal/total >= 0,
-- settlement_currency). If live has others, the preflight names them.
--
-- Fixtures vs every CHECK: customers is_test true; product metals {K18},
-- condition / origin at their defaults; variants price_jpy 1000, stock 1;
-- quotes mode full/layaway, order_type SELF, settlement JPY, subtotal 1000,
-- shipping 0, total 1000, term 3 (no plan minimum); the orders and plans are
-- written by the RPCs under test, never by hand.
-- ============================================================================

BEGIN;

DO $t$
DECLARE
  v_c1     uuid;   -- customer for the switch-off (today's flow) checks
  v_c2     uuid;   -- customer for reserve -> confirm; has no other orders
  v_c3     uuid;   -- customer for decline + expiry
  v_p      uuid;
  v_v      uuid[] := '{}';   -- eight variants, stock 1 each
  v_q      uuid;
  v_admin  uuid;
  v_fin    uuid;
  v_r      jsonb;
  v_o      uuid;   -- scratch order / plan ids
  v_o_cash uuid;   -- B: reserved cash order, confirmed
  v_o_lay  uuid;   -- C: reserved layaway, confirmed
  v_o_x1   uuid;   -- E: reserved cash, 73 h old -> swept
  v_o_x2   uuid;   -- E: reserved layaway, 73 h old -> swept
  v_o_x3   uuid;   -- E: reserved cash, 1 h old -> survives
  v_o_x4   uuid;   -- E: reserved cash, 73 h old, submission pending -> frozen
  v_n      integer;
  v_st     text;
  v_ps     text;
  v_due    timestamptz;
  v_exp    timestamptz;
  v_ready  timestamptz;
  v_by     uuid;
  v_od     date;
  v_end    date;
  v_today  date := (now() AT TIME ZONE 'Asia/Manila')::date;
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

  -- ------------------------------------------------------------ who acts
  SELECT user_id INTO v_admin FROM public.user_roles WHERE role = 'admin' LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'setup: no admin user to act as staff'; END IF;

  SELECT ur.user_id INTO v_fin
    FROM public.user_roles ur
   WHERE ur.role = 'finance'
     AND NOT EXISTS (SELECT 1 FROM public.user_roles x WHERE x.user_id = ur.user_id AND x.role <> 'finance')
     AND NOT EXISTS (SELECT 1 FROM public.user_permission_overrides o
                      WHERE o.user_id = ur.user_id AND o.permission_key = 'confirm_web_order_ready')
   LIMIT 1;
  IF v_fin IS NULL THEN
    v_fin := gen_random_uuid();
    RAISE NOTICE 'no finance-only user without an override on live; the refusal checks use a user with no role at all';
  END IF;

  -- ---------------------------------------------- the seed rows (section 10)
  IF (SELECT value FROM public.system_settings WHERE key = 'web_reservation_mode') IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 0a web_reservation_mode is not false';
  END IF;
  SELECT string_agg(role::text || '=' || is_allowed::text, ',' ORDER BY role::text) INTO v_st
    FROM public.role_permissions WHERE permission_key = 'confirm_web_order_ready';
  IF v_st IS DISTINCT FROM 'admin=true,csr=true,finance=false,live_agent=false,staff=true' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 0b confirm_web_order_ready seed is %', v_st;
  END IF;
  IF public.has_permission(v_fin, 'confirm_web_order_ready') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 0c the refused user holds confirm_web_order_ready';
  END IF;

  -- ------------------------------------------------------------- fixtures
  INSERT INTO public.customers (full_name, is_test) VALUES ('ZZ reserve-first A1 one', true)   RETURNING id INTO v_c1;
  INSERT INTO public.customers (full_name, is_test) VALUES ('ZZ reserve-first A1 two', true)   RETURNING id INTO v_c2;
  INSERT INTO public.customers (full_name, is_test) VALUES ('ZZ reserve-first A1 three', true) RETURNING id INTO v_c3;

  INSERT INTO public.website_products (sku, slug, name, status, metals)
  VALUES ('ZZ-RSV-0923', 'zz-rsv-0923', 'ZZ reserve-first assertion', 'active', ARRAY['K18']::text[])
  RETURNING id INTO v_p;
  FOR i IN 1 .. 8 LOOP
    INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
    VALUES (v_p, 1000, 1, i) RETURNING id INTO v_q;
    v_v := v_v || v_q;
  END LOOP;

  -- ========================================== A — switch off: today's flow
  -- A1. Cash, p_reserve omitted.
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c1, jsonb_build_array(jsonb_build_object('variant_id', v_v[1], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_order_atomic(v_c1, v_q, 'transfer', 'en');
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR v_r ? 'reserved' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A1 create_web_order_atomic without p_reserve returned %', v_r;
  END IF;
  v_o := (v_r->>'order_id')::uuid;
  SELECT payment_status, transfer_due_at, expires_at, ready_confirmed_at, ready_confirmed_by
    INTO v_ps, v_due, v_exp, v_ready, v_by FROM public.cash_orders WHERE id = v_o;
  IF v_ps <> 'pending_transfer' OR v_due IS NULL OR v_due IS DISTINCT FROM v_exp
     OR v_due < now() + interval '23 hours 59 minutes' OR v_due > now() + interval '24 hours 1 minute'
     OR v_ready IS NULL OR v_by IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A1 wrote payment_status %, due %, expires %, ready %, by %', v_ps, v_due, v_exp, v_ready, v_by;
  END IF;
  IF (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[1]) <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A1 stock was not taken';
  END IF;
  -- A2. set_account_deadlines still moves a non-reserved order.
  v_r := public.set_account_deadlines('cash_order', v_o, now() + interval '5 days', 'assertion', v_admin);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A2 set_account_deadlines on a ready order returned %', v_r;
  END IF;

  -- A3. Layaway, p_reserve omitted: deadline set (72 h — A1 makes c1 returning),
  --     ready stamped, schedule from the checkout date.
  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c1, jsonb_build_array(jsonb_build_object('variant_id', v_v[2], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_layaway_atomic(v_c1, v_q, 'en');
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR v_r ? 'reserved' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A3 create_web_layaway_atomic without p_reserve returned %', v_r;
  END IF;
  v_o := (v_r->>'account_id')::uuid;
  SELECT transfer_due_at, ready_confirmed_at, order_date INTO v_due, v_ready, v_od
    FROM public.layaway_accounts WHERE id = v_o;
  IF v_due IS NULL OR v_ready IS NULL
     OR v_due < now() + interval '71 hours 59 minutes' OR v_due > now() + interval '72 hours 1 minute' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A3 due %, ready %', v_due, v_ready;
  END IF;
  IF (SELECT due_date FROM public.layaway_schedule WHERE account_id = v_o AND installment_number = 1)
     IS DISTINCT FROM (v_od + make_interval(months => 1))::date THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A3 installment 1 is not order_date + 1 month';
  END IF;

  -- =============================================== B — reserve, confirm: cash
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c2, jsonb_build_array(jsonb_build_object('variant_id', v_v[3], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_order_atomic(v_c2, v_q, 'transfer', 'en', true);
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR NOT coalesce((v_r->>'reserved')::boolean, false)
     OR v_r->'transfer_due_at' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B1 reserved create returned %', v_r;
  END IF;
  v_o_cash := (v_r->>'order_id')::uuid;
  SELECT status::text, payment_status, transfer_due_at, expires_at, ready_confirmed_at
    INTO v_st, v_ps, v_due, v_exp, v_ready FROM public.cash_orders WHERE id = v_o_cash;
  IF v_st <> 'pending' OR v_ps <> 'awaiting_confirmation' OR v_due IS NOT NULL OR v_exp IS NOT NULL OR v_ready IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B1 reservation: status %, payment_status %, due %, expires %, ready %', v_st, v_ps, v_due, v_exp, v_ready;
  END IF;
  IF (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[3]) <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B1 a reservation must hold the stock';
  END IF;

  v_r := public.set_account_deadlines('cash_order', v_o_cash, now() + interval '5 days', 'assertion', v_admin);
  IF v_r->>'error' IS DISTINCT FROM 'not_ready' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B2 set_account_deadlines on a reservation returned %', v_r;
  END IF;

  v_r := public.confirm_web_order_ready_atomic('cash_order', v_o_cash, v_fin, NULL);
  IF v_r->>'error' IS DISTINCT FROM 'permission_denied' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B3 confirm by a finance user returned %', v_r;
  END IF;
  v_r := public.confirm_web_order_ready_atomic('cash_order', v_o_cash, NULL, NULL);
  IF v_r->>'error' IS DISTINCT FROM 'user_identity_required' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B4 confirm with no user returned %', v_r;
  END IF;
  SELECT payment_status, ready_confirmed_at INTO v_ps, v_ready FROM public.cash_orders WHERE id = v_o_cash;
  IF v_ps <> 'awaiting_confirmation' OR v_ready IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B3/B4 a refused confirm still wrote (%, %)', v_ps, v_ready;
  END IF;

  -- B5. Confirmed: this is c2's FIRST order, and the order itself must not
  --     count towards "returning" — 24 hours, not 72.
  v_r := public.confirm_web_order_ready_atomic('cash_order', v_o_cash, v_admin, 'assertion: ready');
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR (v_r->>'deadline_hours')::int <> 24 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B5 confirm returned %', v_r;
  END IF;
  SELECT payment_status, transfer_due_at, expires_at, ready_confirmed_at, ready_confirmed_by
    INTO v_ps, v_due, v_exp, v_ready, v_by FROM public.cash_orders WHERE id = v_o_cash;
  IF v_ps <> 'pending_transfer' OR v_due IS DISTINCT FROM v_exp OR v_ready IS NULL OR v_by IS DISTINCT FROM v_admin
     OR v_due < now() + interval '23 hours 59 minutes' OR v_due > now() + interval '24 hours 1 minute' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B5 after confirm: %, due %, expires %, ready %, by %', v_ps, v_due, v_exp, v_ready, v_by;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_id = v_o_cash AND action = 'web_order_ready_confirmed') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B5 no web_order_ready_confirmed audit row';
  END IF;
  v_r := public.confirm_web_order_ready_atomic('cash_order', v_o_cash, v_admin, NULL);
  IF v_r->>'error' IS DISTINCT FROM 'already_confirmed' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B6 second confirm returned %', v_r;
  END IF;
  v_r := public.set_account_deadlines('cash_order', v_o_cash, now() + interval '5 days', 'assertion', v_admin);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B7 set_account_deadlines after confirm returned %', v_r;
  END IF;

  -- ============================================ C — reserve, confirm: layaway
  -- Checkout dated 10 days ago so the re-anchoring is visible.
  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c2, jsonb_build_array(jsonb_build_object('variant_id', v_v[4], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_r := public.create_web_layaway_atomic(v_c2, v_q, 'en', NULL, current_date - 10, NULL, NULL, true);
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR NOT coalesce((v_r->>'reserved')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C1 reserved layaway returned %', v_r;
  END IF;
  v_o_lay := (v_r->>'account_id')::uuid;
  SELECT status::text, transfer_due_at, ready_confirmed_at INTO v_st, v_due, v_ready
    FROM public.layaway_accounts WHERE id = v_o_lay;
  IF v_st <> 'active' OR v_due IS NOT NULL OR v_ready IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C1 reservation: status %, due %, ready %', v_st, v_due, v_ready;
  END IF;
  v_r := public.set_account_deadlines('layaway', v_o_lay, now() + interval '5 days', 'assertion', v_admin);
  IF v_r->>'error' IS DISTINCT FROM 'not_ready' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C2 set_account_deadlines on a reserved plan returned %', v_r;
  END IF;
  v_r := public.confirm_web_order_ready_atomic('layaway', v_o_lay, v_fin, NULL);
  IF v_r->>'error' IS DISTINCT FROM 'permission_denied' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C3 layaway confirm by a finance user returned %', v_r;
  END IF;

  -- C4. Confirmed: 72 h (c2 now has a live order besides this plan), order
  --     date = today PHT, every installment = today + n months.
  v_r := public.confirm_web_order_ready_atomic('layaway', v_o_lay, v_admin, NULL);
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR (v_r->>'deadline_hours')::int <> 72
     OR (v_r->>'schedule_rows_reanchored')::int <> 3 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C4 layaway confirm returned %', v_r;
  END IF;
  SELECT transfer_due_at, ready_confirmed_at, ready_confirmed_by, order_date, end_date
    INTO v_due, v_ready, v_by, v_od, v_end FROM public.layaway_accounts WHERE id = v_o_lay;
  IF v_od <> v_today OR v_ready IS NULL OR v_by IS DISTINCT FROM v_admin
     OR v_due < now() + interval '71 hours 59 minutes' OR v_due > now() + interval '72 hours 1 minute' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C4 after confirm: order_date % (today %), due %, ready %, by %', v_od, v_today, v_due, v_ready, v_by;
  END IF;
  IF EXISTS (SELECT 1 FROM public.layaway_schedule
              WHERE account_id = v_o_lay
                AND due_date <> (v_today + make_interval(months => installment_number))::date) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C4 a schedule row is not order_date + n months';
  END IF;
  IF v_end IS DISTINCT FROM (SELECT max(due_date) FROM public.layaway_schedule WHERE account_id = v_o_lay) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C4 end_date % is not the last due date', v_end;
  END IF;
  SELECT count(*) INTO v_n FROM public.schedule_audit_log
   WHERE account_id = v_o_lay AND action = 'web_ready_reanchor';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C4 expected 3 schedule_audit_log rows, found %', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_id = v_o_lay AND action = 'web_layaway_ready_confirmed'
                    AND (old_value_json->>'order_date')::date = current_date - 10) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C4 the audit row does not keep the checkout order_date';
  END IF;
  v_r := public.set_account_deadlines('layaway', v_o_lay, now() + interval '5 days', 'assertion', v_admin);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C5 set_account_deadlines after confirm returned %', v_r;
  END IF;

  -- ======================================================== D — decline
  -- D1. Cash: "can't supply" is terminate_web_order_atomic, stock returned.
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[5], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_o := (public.create_web_order_atomic(v_c3, v_q, 'transfer', 'en', true)->>'order_id')::uuid;
  v_r := public.terminate_web_order_atomic(v_o, 'cancelled', 'assertion: cannot supply', v_admin, 'assert@test',
                                           NULL, NULL, 'staff', false);
  SELECT status::text INTO v_st FROM public.cash_orders WHERE id = v_o;
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR v_st <> 'cancelled'
     OR (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[5]) <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D1 cash decline: % (status %)', v_r, v_st;
  END IF;

  -- D2. Layaway: reason required, finance refused, then declined.
  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[6], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_o := (public.create_web_layaway_atomic(v_c3, v_q, 'en', NULL, NULL, NULL, NULL, true)->>'account_id')::uuid;
  IF (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[6]) <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D2 a reserved plan must hold the stock';
  END IF;
  v_r := public.decline_web_layaway_reservation_atomic(v_o, '   ', v_admin);
  IF v_r->>'error' IS DISTINCT FROM 'reason_required' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D2a blank reason returned %', v_r;
  END IF;
  v_r := public.decline_web_layaway_reservation_atomic(v_o, 'assertion: cannot supply', v_fin);
  IF v_r->>'error' IS DISTINCT FROM 'permission_denied' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D2b decline by a finance user returned %', v_r;
  END IF;
  v_r := public.decline_web_layaway_reservation_atomic(v_o, 'assertion: cannot supply', v_admin);
  SELECT status::text, expired_at INTO v_st, v_exp FROM public.layaway_accounts WHERE id = v_o;
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR (v_r->>'stock_lines_restored')::int <> 1
     OR v_st <> 'cancelled' OR v_exp IS NOT NULL
     OR (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[6]) <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D2c decline: % (status %, expired_at %)', v_r, v_st, v_exp;
  END IF;
  IF EXISTS (SELECT 1 FROM public.layaway_schedule WHERE account_id = v_o AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D2c schedule rows were not cancelled';
  END IF;
  v_r := public.decline_web_layaway_reservation_atomic(v_o, 'again', v_admin);
  IF v_r->>'error' IS DISTINCT FROM 'not_live' OR (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[6]) <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D2d second decline returned % (stock returned twice?)', v_r;
  END IF;
  -- D3. A confirmed plan is not a reservation and cannot be declined.
  v_r := public.decline_web_layaway_reservation_atomic(v_o_lay, 'assertion', v_admin);
  IF v_r->>'error' IS DISTINCT FROM 'already_confirmed' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D3 declining a confirmed plan returned %', v_r;
  END IF;

  -- ================================================== E — 72-hour expiry
  -- x1 cash and x2 layaway: reserved 73 h ago -> cancelled, stock back.
  -- x3 cash: reserved 1 h ago -> untouched.
  -- x4 cash: reserved 73 h ago with a submission awaiting review -> frozen.
  -- B's confirmed order is aged too and must not be touched.
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[5], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_o_x1 := (public.create_web_order_atomic(v_c3, v_q, 'transfer', 'en', true)->>'order_id')::uuid;
  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, order_type, subtotal_jpy,
                                      shipping_jpy, total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[6], 'qty', 1)), 'layaway', 3, 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_o_x2 := (public.create_web_layaway_atomic(v_c3, v_q, 'en', NULL, NULL, NULL, NULL, true)->>'account_id')::uuid;
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[7], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_o_x3 := (public.create_web_order_atomic(v_c3, v_q, 'transfer', 'en', true)->>'order_id')::uuid;
  INSERT INTO public.checkout_quotes (customer_id, items, mode, order_type, subtotal_jpy, shipping_jpy,
                                      total_jpy, expires_at, settlement_currency)
  VALUES (v_c3, jsonb_build_array(jsonb_build_object('variant_id', v_v[8], 'qty', 1)), 'full', 'SELF',
          1000, 0, 1000, now() + interval '1 hour', 'JPY') RETURNING id INTO v_q;
  v_o_x4 := (public.create_web_order_atomic(v_c3, v_q, 'transfer', 'en', true)->>'order_id')::uuid;
  IF v_o_x1 IS NULL OR v_o_x2 IS NULL OR v_o_x3 IS NULL OR v_o_x4 IS NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E setup: a reservation was not created (% % % %)', v_o_x1, v_o_x2, v_o_x3, v_o_x4;
  END IF;
  INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date,
                                          payment_method, status)
  VALUES (v_c3, v_o_x4, 1000, current_date, 'bank_transfer', 'submitted');

  UPDATE public.cash_orders SET created_at = now() - interval '73 hours' WHERE id IN (v_o_x1, v_o_x4, v_o_cash);
  UPDATE public.cash_orders SET created_at = now() - interval '1 hour'   WHERE id = v_o_x3;
  UPDATE public.layaway_accounts SET created_at = now() - interval '73 hours' WHERE id IN (v_o_x2, v_o_lay);

  v_r := public.expire_unconfirmed_web_reservations_atomic();
  IF NOT coalesce((v_r->>'ok')::boolean, false)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'cancelled_cash_orders') e WHERE (e->>'id')::uuid = v_o_x1)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'cancelled_layaways') e WHERE (e->>'id')::uuid = v_o_x2)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'cancelled_cash_orders') e
                 WHERE (e->>'id')::uuid IN (v_o_x3, v_o_x4, v_o_cash))
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'cancelled_layaways') e WHERE (e->>'id')::uuid = v_o_lay)
     OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_r->'skipped') e
                     WHERE (e->>'id')::uuid = v_o_x4 AND e->>'reason' = 'submission_pending') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E1 sweep returned %', v_r;
  END IF;
  IF (SELECT status::text FROM public.cash_orders WHERE id = v_o_x1) <> 'cancelled'
     OR (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[5]) <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E2 swept cash order not cancelled or stock not returned';
  END IF;
  IF (SELECT status::text FROM public.layaway_accounts WHERE id = v_o_x2) <> 'cancelled'
     OR (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[6]) <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E3 swept plan not cancelled or stock not returned';
  END IF;
  IF (SELECT status::text FROM public.cash_orders WHERE id = v_o_x3) <> 'pending'
     OR (SELECT status::text FROM public.cash_orders WHERE id = v_o_x4) <> 'pending'
     OR (SELECT status::text FROM public.cash_orders WHERE id = v_o_cash) <> 'pending'
     OR (SELECT status::text FROM public.layaway_accounts WHERE id = v_o_lay) <> 'active'
     OR (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[7]) <> 0
     OR (SELECT stock_qty FROM public.website_product_variants WHERE id = v_v[8]) <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E4 the sweep touched an order it must leave alone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_id = v_o_x2 AND action = 'web_layaway_reservation_expired') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E3 no web_layaway_reservation_expired audit row';
  END IF;
  -- E5. Idempotent: a second sweep finds nothing new to cancel.
  v_r := public.expire_unconfirmed_web_reservations_atomic();
  IF jsonb_array_length(v_r->'cancelled_cash_orders') <> 0 OR jsonb_array_length(v_r->'cancelled_layaways') <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — E5 second sweep cancelled again: %', v_r;
  END IF;

  RAISE NOTICE 'ALL RESERVE-FIRST A1 ASSERTIONS PASSED';
END
$t$;

ROLLBACK;
