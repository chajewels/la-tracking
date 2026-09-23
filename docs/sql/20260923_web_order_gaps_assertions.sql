-- ============================================================================
-- Web order gaps — SQL assertions for migration 20260923120000_web_order_gaps
-- 2026-09-23. Run in the Supabase SQL Editor AFTER the migration is applied.
-- Claude Code has NOT run this (no database access from this machine).
--
-- WRITES NOTHING THAT SURVIVES. Everything happens inside one transaction that
-- ends in ROLLBACK: a throwaway is_test customer, one throwaway product with
-- two variants, two web cash orders, two layaways. Staff-bell and audit rows
-- the triggers write are rolled back with them.
--
-- Reading the result: the script ends with NOTICE 'ALL WEB ORDER GAP
-- ASSERTIONS PASSED'. Any failure RAISEs 'ASSERTION FAILED — …' naming the
-- check, and the ROLLBACK still runs.
--
-- REVISION 2 (2026-09-23). The first run failed on its first insert:
--   23514 website_products violates "website_products_metals_nonempty"
-- (metals defaults to '{}' and the CHECK needs at least one). Every fixture
-- has now been checked against every constraint and trigger in the migrations
-- on the tables it writes:
--   website_products        metals nonempty + allowed list (K18), condition
--                           and origin CHECKs (defaults 'New' / 'UNKNOWN'),
--                           sku / slug UNIQUE, forbidden-gold-terms trigger,
--                           metals->karat sync trigger (K18 is a karat value)
--   website_product_variants price_jpy / price_php / stock_qty >= 0
--   cash_orders             total_amount > 0, source_channel / order_type /
--                           payment_method / payment_status / customer_lang /
--                           refund_status value lists, tracking pair,
--                           invoice UNIQUE + invoice registry, test prefix
--   cash_order_items        written with website_product_id, NEVER product_id
--                           (product_id is the Shopify FK — Bug #266); the
--                           column list is exactly create_web_order_atomic's
--   payment_submissions     required columns only (no CHECKs)
--   layaway_accounts        3-month plan (no minimum), source_channel,
--                           customer_lang, total_amount > 0, tracking pair
--   layaway_account_items   quantity > 0; column list is exactly
--                           create_web_layaway_atomic's
--   layaway_schedule        amounts >= 0, installment_number > 0,
--                           (account_id, installment_number) UNIQUE, chronology
-- The revalidation trigger on the two website tables calls net.http_post;
-- pg_net only queues the request in-transaction, so ROLLBACK sends nothing.
--
-- PREFLIGHT. Before any insert, the script compares LIVE against that list:
-- any CHECK constraint on these tables it does not know, and any NOT NULL
-- column without a default that a fixture does not set, are ALL named in one
-- 'PREFLIGHT —' error and nothing is inserted. That turns "fails on the first
-- unknown constraint" into "names every unknown constraint at once".
-- ============================================================================

BEGIN;

DO $t$
DECLARE
  c    uuid;   -- throwaway test customer
  p    uuid;   -- throwaway product
  v1   uuid;   -- variant held by the cash orders
  v2   uuid;   -- variant held by the web layaway
  o1   uuid;   -- web cash order: freeze, expire, revive
  o2   uuid;   -- web cash order: staff cancel over a pending submission
  sub1 uuid;
  la1  uuid;   -- web layaway: forfeit + rehold
  la2  uuid;   -- hub layaway: forfeit touches no stock
  staff uuid;
  r    jsonb;
  n    integer;
  st   text;
  ps   text;
  due  timestamptz;
  exp  timestamptz;
  rel  timestamptz;
  raised boolean;
  unknown text;
  missing text;
BEGIN
  -- ------------------------------------------------------------- preflight
  -- Read-only. Names every live CHECK constraint these fixtures were not
  -- written against, and every required column they do not set, then stops.
  SELECT string_agg(format('%s.%s: %s', rel::regclass, conname, pg_get_constraintdef(oid)), E'\n  ')
    INTO unknown
    FROM (SELECT oid, conrelid AS rel, conname FROM pg_constraint
           WHERE contype = 'c'
             AND conrelid IN ('public.customers'::regclass, 'public.website_products'::regclass,
                              'public.website_product_variants'::regclass, 'public.cash_orders'::regclass,
                              'public.cash_order_items'::regclass, 'public.payment_submissions'::regclass,
                              'public.layaway_accounts'::regclass, 'public.layaway_account_items'::regclass,
                              'public.layaway_schedule'::regclass)
             AND conname <> ALL (ARRAY[
               'website_products_condition_check', 'website_products_origin_check',
               'website_products_metals_nonempty', 'website_products_metals_values',
               'website_product_variants_price_jpy_check', 'website_product_variants_price_php_check',
               'website_product_variants_stock_qty_check',
               'cash_orders_total_amount_check', 'cash_orders_total_paid_check',
               'cash_orders_tracking_pair_check', 'cash_orders_source_channel_check',
               'cash_orders_order_type_check', 'cash_orders_payment_method_check',
               'cash_orders_payment_status_check', 'cash_orders_customer_lang_check',
               'cash_orders_refund_status_check',
               'layaway_accounts_payment_plan_months_check', 'layaway_accounts_total_amount_check',
               'layaway_accounts_total_paid_check', 'layaway_accounts_tracking_pair_check',
               'layaway_accounts_source_channel_check', 'layaway_accounts_customer_lang_check',
               'layaway_account_items_quantity_check',
               'base_amount_positive', 'carried_amount_non_negative',
               'layaway_schedule_base_installment_amount_check', 'layaway_schedule_installment_number_check',
               'layaway_schedule_paid_amount_check', 'layaway_schedule_penalty_amount_check',
               'layaway_schedule_total_due_amount_check', 'penalty_non_negative'])) k;

  SELECT string_agg(format('%s.%s', c.table_name, c.column_name), ', ')
    INTO missing
    FROM information_schema.columns c
    JOIN (VALUES
      ('customers',                ARRAY['full_name','is_test']),
      ('website_products',         ARRAY['sku','slug','name','status','metals']),
      ('website_product_variants', ARRAY['product_id','price_jpy','stock_qty','sort']),
      ('cash_orders',              ARRAY['invoice_number','customer_id','currency','total_amount','remaining_balance',
                                         'status','source_channel','payment_status','payment_method','order_type',
                                         'web_reference','transfer_due_at','expires_at']),
      ('cash_order_items',         ARRAY['cash_order_id','website_product_id','variant_id','title','sku','quantity',
                                         'unit_price_jpy','line_total_jpy']),
      ('payment_submissions',      ARRAY['customer_id','cash_order_id','submitted_amount','payment_date',
                                         'payment_method','status']),
      ('layaway_accounts',         ARRAY['customer_id','invoice_number','currency','total_amount','remaining_balance',
                                         'payment_plan_months','order_date','status','source_channel']),
      ('layaway_account_items',    ARRAY['account_id','website_product_id','variant_id','title','sku','quantity',
                                         'unit_price_jpy','line_total_jpy']),
      ('layaway_schedule',         ARRAY['account_id','installment_number','due_date','base_installment_amount',
                                         'total_due_amount','currency','status'])
    ) AS s(t, cols) ON s.t = c.table_name
   WHERE c.table_schema = 'public'
     AND c.is_nullable = 'NO'
     AND c.column_default IS NULL
     AND c.is_generated = 'NEVER'
     AND c.is_identity = 'NO'
     AND NOT (c.column_name = ANY (s.cols));

  IF unknown IS NOT NULL OR missing IS NOT NULL THEN
    RAISE EXCEPTION E'PREFLIGHT — the fixtures were not written against these live objects. Nothing was inserted. Send this whole message to Claude Code.\n CHECK constraints not accounted for:\n  %\n Required columns the fixtures do not set: %',
      coalesce(unknown, '(none)'), coalesce(missing, '(none)');
  END IF;

  SELECT user_id INTO staff FROM public.user_roles WHERE role = 'admin' LIMIT 1;
  IF staff IS NULL THEN RAISE EXCEPTION 'setup: no admin user to act as staff'; END IF;

  INSERT INTO public.customers (full_name, is_test)
  VALUES ('ZZ web-order-gaps assertion', true) RETURNING id INTO c;

  -- metals: at least one, from the allowed list (website_products_metals_*);
  -- condition / origin take their CHECK-valid defaults ('New' / 'UNKNOWN').
  INSERT INTO public.website_products (sku, slug, name, status, metals)
  VALUES ('ZZ-GAPS-0923', 'zz-gaps-0923', 'ZZ gaps assertion', 'active', ARRAY['K18']::text[])
  RETURNING id INTO p;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
  VALUES (p, 1000, 0, 0) RETURNING id INTO v1;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
  VALUES (p, 1000, 0, 1) RETURNING id INTO v2;

  -- ------------------------------------------------------------ fixtures
  -- Two pending web cash orders past their deadline, each holding one of v1
  -- (stock already taken: v1 sits at 0).
  INSERT INTO public.cash_orders (invoice_number, customer_id, currency, total_amount, remaining_balance,
                                  status, source_channel, payment_status, payment_method, order_type,
                                  web_reference, transfer_due_at, expires_at)
  VALUES ('ZZGAPS0923A', c, 'JPY', 1000, 1000, 'pending', 'web', 'pending_transfer', 'transfer', 'SELF',
          'CJ-W-ZZ0923A', now() - interval '1 hour', now() - interval '1 hour')
  RETURNING id INTO o1;
  -- website_product_id, never product_id: product_id is the Shopify FK (Bug #266).
  INSERT INTO public.cash_order_items (cash_order_id, website_product_id, variant_id, title, sku, quantity,
                                       unit_price_jpy, line_total_jpy)
  VALUES (o1, p, v1, 'ZZ gaps assertion', 'ZZ-GAPS-0923', 1, 1000, 1000);

  INSERT INTO public.cash_orders (invoice_number, customer_id, currency, total_amount, remaining_balance,
                                  status, source_channel, payment_status, payment_method, order_type,
                                  web_reference, transfer_due_at, expires_at)
  VALUES ('ZZGAPS0923B', c, 'JPY', 1000, 1000, 'pending', 'web', 'pending_transfer', 'transfer', 'SELF',
          'CJ-W-ZZ0923B', now() - interval '1 hour', now() - interval '1 hour')
  RETURNING id INTO o2;

  INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date,
                                          payment_method, status)
  VALUES (c, o1, 1000, current_date, 'bank_transfer', 'submitted') RETURNING id INTO sub1;
  INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date,
                                          payment_method, status)
  VALUES (c, o2, 1000, current_date, 'bank_transfer', 'under_review');

  -- ================================================= GAP 1 — INVARIANT 12
  -- 1a. Expiry (the cron's path) stands down while a submission is pending.
  r := public.expire_web_order_atomic(o1);
  IF (r->>'ok')::boolean OR r->>'reason' <> 'submission_pending' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1a expiry over a pending submission returned %', r;
  END IF;
  SELECT status::text INTO st FROM public.cash_orders WHERE id = o1;
  SELECT stock_qty INTO n FROM public.website_product_variants WHERE id = v1;
  IF st <> 'pending' OR n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1a order moved (status %, stock %)', st, n;
  END IF;
  IF (SELECT status::text FROM public.payment_submissions WHERE id = sub1) <> 'submitted' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1a the pending submission was touched';
  END IF;

  -- 1b. A system-sourced cancel is automation too: frozen.
  r := public.terminate_web_order_atomic(o1, 'cancelled', 'system test', NULL, NULL, NULL, NULL, 'system', false);
  IF (r->>'ok')::boolean OR r->>'reason' <> 'submission_pending' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1b system cancel over a pending submission returned %', r;
  END IF;

  -- 1c. A STAFF cancel is a person acting deliberately: never blocked.
  r := public.terminate_web_order_atomic(o2, 'cancelled', 'assertion: staff cancel', staff, 'assert@test', NULL, NULL, 'staff', false);
  IF NOT coalesce((r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1c staff cancel was blocked: %', r;
  END IF;

  -- 1d. Once the reviewer resolves the submission, expiry proceeds and the
  --     stock goes back on sale.
  UPDATE public.payment_submissions SET status = 'rejected' WHERE id = sub1;
  r := public.expire_web_order_atomic(o1);
  IF NOT coalesce((r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1d expiry after the submission was resolved returned %', r;
  END IF;
  SELECT status::text, payment_status INTO st, ps FROM public.cash_orders WHERE id = o1;
  SELECT stock_qty INTO n FROM public.website_product_variants WHERE id = v1;
  IF st <> 'expired' OR ps <> 'cancelled' OR n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1d after expiry: status %, payment_status %, stock %', st, ps, n;
  END IF;

  -- ============================================== GAP 2 — revive a web order
  r := public.revive_web_cash_order_atomic(o1, '   ', staff, 'assert@test', 'staff');
  IF r->>'error' IS DISTINCT FROM 'reason_required' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2a blank reason returned %', r;
  END IF;

  r := public.revive_web_cash_order_atomic(o1, 'assertion: customer transfer delayed', staff, 'assert@test', 'staff');
  IF NOT coalesce((r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b revive returned %', r;
  END IF;
  SELECT status::text, payment_status, transfer_due_at, expires_at INTO st, ps, due, exp
    FROM public.cash_orders WHERE id = o1;
  SELECT stock_qty INTO n FROM public.website_product_variants WHERE id = v1;
  IF st <> 'pending' OR ps <> 'pending_transfer' OR n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b after revive: status %, payment_status %, stock %', st, ps, n;
  END IF;
  IF due IS DISTINCT FROM exp THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b transfer_due_at % and expires_at % differ', due, exp;
  END IF;
  -- This customer has no live order besides the one being revived (o2 is
  -- cancelled, o1 was expired when measured), so the rule gives 24 hours.
  IF (r->>'deadline_hours')::int <> 24 OR due < now() + interval '23 hours 59 minutes' OR due > now() + interval '24 hours 1 minute' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b deadline % (% h) is not the 24h first-order rule', due, r->>'deadline_hours';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_id = o1 AND action = 'web_order_revived') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b no web_order_revived audit row';
  END IF;

  r := public.revive_web_cash_order_atomic(o1, 'again', staff, 'assert@test', 'staff');
  IF r->>'error' IS DISTINCT FROM 'not_expired' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2c reviving a live order returned %', r;
  END IF;

  -- 2d. The piece sold while the order was expired: refused, nothing written.
  r := public.expire_web_order_atomic(o1);
  IF NOT coalesce((r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2d re-expiry returned %', r;
  END IF;
  UPDATE public.website_product_variants SET stock_qty = 0 WHERE id = v1;   -- someone bought it
  r := public.revive_web_cash_order_atomic(o1, 'assertion: too late', staff, 'assert@test', 'staff');
  IF r->>'error' IS DISTINCT FROM 'out_of_stock' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2d revive of a sold piece returned %', r;
  END IF;
  SELECT status::text INTO st FROM public.cash_orders WHERE id = o1;
  SELECT stock_qty INTO n FROM public.website_product_variants WHERE id = v1;
  IF st <> 'expired' OR n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2d refused revive still wrote (status %, stock %)', st, n;
  END IF;

  -- ======================================= GAP 3 — forfeit returns web stock
  INSERT INTO public.layaway_accounts (customer_id, invoice_number, currency, total_amount, remaining_balance,
                                       payment_plan_months, order_date, status, source_channel, web_reference,
                                       downpayment_amount, customer_lang)
  VALUES (c, 'ZZGAPS0923L', 'JPY', 30000, 30000, 3, current_date, 'active', 'web', 'CJ-W-ZZ0923L', 9000, 'en')
  RETURNING id INTO la1;
  INSERT INTO public.layaway_account_items (account_id, website_product_id, variant_id, title, sku, quantity,
                                            unit_price_jpy, line_total_jpy)
  VALUES (la1, p, v2, 'ZZ gaps assertion', 'ZZ-GAPS-0923', 1, 30000, 30000);
  INSERT INTO public.layaway_schedule (account_id, installment_number, due_date, base_installment_amount,
                                       total_due_amount, currency, status)
  VALUES (la1, 1, current_date + 30, 7000, 7000, 'JPY', 'pending');

  INSERT INTO public.layaway_accounts (customer_id, invoice_number, currency, total_amount, remaining_balance,
                                       payment_plan_months, order_date, status, source_channel)
  VALUES (c, 'ZZGAPS0923H', 'JPY', 30000, 30000, 3, current_date, 'active', 'hub_manual')
  RETURNING id INTO la2;

  -- 3a. Web plan: forfeited, schedule cancelled, piece back on sale, marker set.
  r := public.manual_forfeit_layaway_atomic(la1, staff, 'staff');
  IF NOT coalesce((r->>'ok')::boolean, false) OR NOT (r->>'is_web')::boolean
     OR (r->>'stock_lines_restored')::int <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3a web forfeit returned %', r;
  END IF;
  SELECT status::text, stock_released_at INTO st, rel FROM public.layaway_accounts WHERE id = la1;
  SELECT stock_qty INTO n FROM public.website_product_variants WHERE id = v2;
  IF st <> 'forfeited' OR rel IS NULL OR n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3a after forfeit: status %, stock_released_at %, stock %', st, rel, n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.layaway_schedule WHERE account_id = la1 AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3a schedule rows were not cancelled';
  END IF;

  -- 3b. Forfeiting twice is refused and returns nothing twice.
  r := public.manual_forfeit_layaway_atomic(la1, staff, 'staff');
  SELECT stock_qty INTO n FROM public.website_product_variants WHERE id = v2;
  IF r->>'error' IS DISTINCT FROM 'not_forfeitable' OR n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3b second forfeit returned % (stock %)', r, n;
  END IF;

  -- 3c. Reactivation (what reactivate-account writes) takes the piece back.
  UPDATE public.layaway_accounts SET status = 'extension_active' WHERE id = la1;
  SELECT stock_released_at INTO rel FROM public.layaway_accounts WHERE id = la1;
  SELECT stock_qty INTO n FROM public.website_product_variants WHERE id = v2;
  IF rel IS NOT NULL OR n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3c reactivation did not re-hold (stock_released_at %, stock %)', rel, n;
  END IF;

  -- 3d. Forfeit again, the piece sells, reactivation is refused and the plan
  --     stays forfeited.
  r := public.manual_forfeit_layaway_atomic(la1, staff, 'staff');
  UPDATE public.website_product_variants SET stock_qty = 0 WHERE id = v2;   -- someone bought it
  raised := false;
  BEGIN
    UPDATE public.layaway_accounts SET status = 'extension_active' WHERE id = la1;
  EXCEPTION WHEN OTHERS THEN
    raised := (SQLERRM LIKE 'web_layaway_stock_unavailable%');
  END;
  SELECT status::text INTO st FROM public.layaway_accounts WHERE id = la1;
  IF NOT raised OR st <> 'forfeited' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3d reactivation of a sold piece (raised %, status %)', raised, st;
  END IF;

  -- 3e. A Hub plan's forfeit touches no website stock and sets no marker.
  UPDATE public.website_product_variants SET stock_qty = 5 WHERE id = v2;
  r := public.manual_forfeit_layaway_atomic(la2, staff, 'staff');
  SELECT stock_released_at INTO rel FROM public.layaway_accounts WHERE id = la2;
  SELECT stock_qty INTO n FROM public.website_product_variants WHERE id = v2;
  IF NOT coalesce((r->>'ok')::boolean, false) OR (r->>'is_web')::boolean OR rel IS NOT NULL OR n <> 5 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3e hub forfeit: % (marker %, stock %)', r, rel, n;
  END IF;

  RAISE NOTICE 'ALL WEB ORDER GAP ASSERTIONS PASSED';
END
$t$;

ROLLBACK;
