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
-- LIVE vs REPO — CHECK constraints (revision 4, 2026-09-23). The accepted
-- list in the preflight is now EXACTLY the live pg_constraint list for these
-- tables, supplied by the owner after the preflight fired twice on live.
--
--   Live-only (in no migration) — drift, filed in docs/OPEN-BUGS.md:
--     cash_orders_discount_type_check
--     layaway_accounts_discount_type_check
--       both: CHECK (discount_type IS NULL OR discount_type IN ('amount','percent'))
--     and the columns behind them — discount_amount, discount_type,
--     discount_value on cash_orders AND layaway_accounts (written by
--     EditAccountDialog and _shared/order-extras.ts; in types.ts; in no
--     migration). Revision 3 of this header said cash_orders had no such
--     CHECK; that was an inference from one preflight output and was wrong.
--   Repo-only, NOT drift: website_product_variants_price_php_check was
--     created inline in 20260908030829 and went away with the column
--     (20260908121000 drops price_php). Removed from the accepted list.
--   Every other live CHECK matches a migration.
--
-- Fixtures vs every live CHECK: every cash_orders and layaway_accounts row
-- sets discount_type = NULL explicitly; customer_lang NULL / 'en';
-- order_type 'SELF'; payment_method 'transfer'; payment_status
-- 'pending_transfer' (then 'cancelled' / back via the functions);
-- refund_status stays NULL (the staff cancel has no money received);
-- source_channel 'web' / 'hub_manual'; totals > 0; total_paid 0; tracking
-- and shipping method both NULL; plan 3 months; schedule amounts >= 0 and
-- installment 1; metals {K18}; condition / origin at their defaults
-- ('New' / 'UNKNOWN'); price_jpy 1000; stock_qty never below 0.
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
  v_c    uuid;   -- throwaway test customer
  v_p    uuid;   -- throwaway product
  v_v1   uuid;   -- variant held by the cash orders
  v_v2   uuid;   -- variant held by the web layaway
  v_o1   uuid;   -- web cash order: freeze, expire, revive
  v_o2   uuid;   -- web cash order: staff cancel over a pending submission
  v_sub1 uuid;
  v_la1  uuid;   -- web layaway: forfeit + rehold
  v_la2  uuid;   -- hub layaway: forfeit touches no stock
  v_staff uuid;
  v_r    jsonb;
  v_n    integer;
  v_st   text;
  v_ps   text;
  v_due  timestamptz;
  v_exp  timestamptz;
  v_rel  timestamptz;
  v_raised boolean;
  v_unknown text;
  v_missing text;
BEGIN
  -- ------------------------------------------------------------- preflight
  -- Read-only. Names every live CHECK constraint these fixtures were not
  -- written against, and every required column they do not set, then stops.
  SELECT string_agg(format('%s.%s: %s', k.con_rel::regclass, k.con_name, pg_get_constraintdef(k.con_oid)), E'\n  ')
    INTO v_unknown
    FROM (SELECT pc.oid AS con_oid, pc.conrelid AS con_rel, pc.conname AS con_name FROM pg_constraint pc
           WHERE pc.contype = 'c'
             AND pc.conrelid IN ('public.customers'::regclass, 'public.website_products'::regclass,
                              'public.website_product_variants'::regclass, 'public.cash_orders'::regclass,
                              'public.cash_order_items'::regclass, 'public.payment_submissions'::regclass,
                              'public.layaway_accounts'::regclass, 'public.layaway_account_items'::regclass,
                              'public.layaway_schedule'::regclass)
             -- EXACTLY the live CHECK list on these tables, from pg_constraint
             -- (owner, 2026-09-23). customers, cash_order_items,
             -- payment_submissions and layaway_account_items have none live.
             AND pc.conname <> ALL (ARRAY[
               -- website_products
               'website_products_condition_check', 'website_products_metals_nonempty',
               'website_products_metals_values', 'website_products_origin_check',
               -- website_product_variants
               'website_product_variants_price_jpy_check', 'website_product_variants_stock_qty_check',
               -- cash_orders
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

  SELECT user_id INTO v_staff FROM public.user_roles WHERE role = 'admin' LIMIT 1;
  IF v_staff IS NULL THEN RAISE EXCEPTION 'setup: no admin user to act as staff'; END IF;

  INSERT INTO public.customers (full_name, is_test)
  VALUES ('ZZ web-order-gaps assertion', true) RETURNING id INTO v_c;

  -- metals: at least one, from the allowed list (website_products_metals_*);
  -- condition / origin take their CHECK-valid defaults ('New' / 'UNKNOWN').
  INSERT INTO public.website_products (sku, slug, name, status, metals)
  VALUES ('ZZ-GAPS-0923', 'zz-gaps-0923', 'ZZ gaps assertion', 'active', ARRAY['K18']::text[])
  RETURNING id INTO v_p;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
  VALUES (v_p, 1000, 0, 0) RETURNING id INTO v_v1;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
  VALUES (v_p, 1000, 0, 1) RETURNING id INTO v_v2;

  -- ------------------------------------------------------------ fixtures
  -- Two pending web cash orders past their deadline, each holding one of v1
  -- (stock already taken: v1 sits at 0).
  INSERT INTO public.cash_orders (invoice_number, customer_id, currency, total_amount, remaining_balance,
                                  status, source_channel, payment_status, payment_method, order_type,
                                  web_reference, transfer_due_at, expires_at, discount_type)
  VALUES ('ZZGAPS0923A', v_c, 'JPY', 1000, 1000, 'pending', 'web', 'pending_transfer', 'transfer', 'SELF',
          'CJ-W-ZZ0923A', now() - interval '1 hour', now() - interval '1 hour',
          NULL)   -- explicit: cash_orders_discount_type_check allows NULL
  RETURNING id INTO v_o1;
  -- website_product_id, never product_id: product_id is the Shopify FK (Bug #266).
  INSERT INTO public.cash_order_items (cash_order_id, website_product_id, variant_id, title, sku, quantity,
                                       unit_price_jpy, line_total_jpy)
  VALUES (v_o1, v_p, v_v1, 'ZZ gaps assertion', 'ZZ-GAPS-0923', 1, 1000, 1000);

  INSERT INTO public.cash_orders (invoice_number, customer_id, currency, total_amount, remaining_balance,
                                  status, source_channel, payment_status, payment_method, order_type,
                                  web_reference, transfer_due_at, expires_at, discount_type)
  VALUES ('ZZGAPS0923B', v_c, 'JPY', 1000, 1000, 'pending', 'web', 'pending_transfer', 'transfer', 'SELF',
          'CJ-W-ZZ0923B', now() - interval '1 hour', now() - interval '1 hour',
          NULL)   -- explicit: cash_orders_discount_type_check allows NULL
  RETURNING id INTO v_o2;

  INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date,
                                          payment_method, status)
  VALUES (v_c, v_o1, 1000, current_date, 'bank_transfer', 'submitted') RETURNING id INTO v_sub1;
  INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date,
                                          payment_method, status)
  VALUES (v_c, v_o2, 1000, current_date, 'bank_transfer', 'under_review');

  -- ================================================= GAP 1 — INVARIANT 12
  -- 1a. Expiry (the cron's path) stands down while a submission is pending.
  v_r := public.expire_web_order_atomic(v_o1);
  IF (v_r->>'ok')::boolean OR v_r->>'reason' <> 'submission_pending' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1a expiry over a pending submission returned %', v_r;
  END IF;
  SELECT status::text INTO v_st FROM public.cash_orders WHERE id = v_o1;
  SELECT stock_qty INTO v_n FROM public.website_product_variants WHERE id = v_v1;
  IF v_st <> 'pending' OR v_n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1a order moved (status %, stock %)', v_st, v_n;
  END IF;
  IF (SELECT status::text FROM public.payment_submissions WHERE id = v_sub1) <> 'submitted' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1a the pending submission was touched';
  END IF;

  -- 1b. A system-sourced cancel is automation too: frozen.
  v_r := public.terminate_web_order_atomic(v_o1, 'cancelled', 'system test', NULL, NULL, NULL, NULL, 'system', false);
  IF (v_r->>'ok')::boolean OR v_r->>'reason' <> 'submission_pending' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1b system cancel over a pending submission returned %', v_r;
  END IF;

  -- 1c. A STAFF cancel is a person acting deliberately: never blocked.
  v_r := public.terminate_web_order_atomic(v_o2, 'cancelled', 'assertion: staff cancel', v_staff, 'assert@test', NULL, NULL, 'staff', false);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1c staff cancel was blocked: %', v_r;
  END IF;

  -- 1d. Once the reviewer resolves the submission, expiry proceeds and the
  --     stock goes back on sale.
  UPDATE public.payment_submissions SET status = 'rejected' WHERE id = v_sub1;
  v_r := public.expire_web_order_atomic(v_o1);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1d expiry after the submission was resolved returned %', v_r;
  END IF;
  SELECT status::text, payment_status INTO v_st, v_ps FROM public.cash_orders WHERE id = v_o1;
  SELECT stock_qty INTO v_n FROM public.website_product_variants WHERE id = v_v1;
  IF v_st <> 'expired' OR v_ps <> 'cancelled' OR v_n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 1d after expiry: status %, payment_status %, stock %', v_st, v_ps, v_n;
  END IF;

  -- ============================================== GAP 2 — revive a web order
  v_r := public.revive_web_cash_order_atomic(v_o1, '   ', v_staff, 'assert@test', 'staff');
  IF v_r->>'error' IS DISTINCT FROM 'reason_required' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2a blank reason returned %', v_r;
  END IF;

  v_r := public.revive_web_cash_order_atomic(v_o1, 'assertion: customer transfer delayed', v_staff, 'assert@test', 'staff');
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b revive returned %', v_r;
  END IF;
  SELECT status::text, payment_status, transfer_due_at, expires_at INTO v_st, v_ps, v_due, v_exp
    FROM public.cash_orders WHERE id = v_o1;
  SELECT stock_qty INTO v_n FROM public.website_product_variants WHERE id = v_v1;
  IF v_st <> 'pending' OR v_ps <> 'pending_transfer' OR v_n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b after revive: status %, payment_status %, stock %', v_st, v_ps, v_n;
  END IF;
  IF v_due IS DISTINCT FROM v_exp THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b transfer_due_at % and expires_at % differ', v_due, v_exp;
  END IF;
  -- This customer has no live order besides the one being revived (o2 is
  -- cancelled, o1 was expired when measured), so the rule gives 24 hours.
  IF (v_r->>'deadline_hours')::int <> 24 OR v_due < now() + interval '23 hours 59 minutes' OR v_due > now() + interval '24 hours 1 minute' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b deadline % (% h) is not the 24h first-order rule', v_due, v_r->>'deadline_hours';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs WHERE entity_id = v_o1 AND action = 'web_order_revived') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2b no web_order_revived audit row';
  END IF;

  v_r := public.revive_web_cash_order_atomic(v_o1, 'again', v_staff, 'assert@test', 'staff');
  IF v_r->>'error' IS DISTINCT FROM 'not_expired' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2c reviving a live order returned %', v_r;
  END IF;

  -- 2d. The piece sold while the order was expired: refused, nothing written.
  v_r := public.expire_web_order_atomic(v_o1);
  IF NOT coalesce((v_r->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2d re-expiry returned %', v_r;
  END IF;
  UPDATE public.website_product_variants SET stock_qty = 0 WHERE id = v_v1;   -- someone bought it
  v_r := public.revive_web_cash_order_atomic(v_o1, 'assertion: too late', v_staff, 'assert@test', 'staff');
  IF v_r->>'error' IS DISTINCT FROM 'out_of_stock' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2d revive of a sold piece returned %', v_r;
  END IF;
  SELECT status::text INTO v_st FROM public.cash_orders WHERE id = v_o1;
  SELECT stock_qty INTO v_n FROM public.website_product_variants WHERE id = v_v1;
  IF v_st <> 'expired' OR v_n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 2d refused revive still wrote (status %, stock %)', v_st, v_n;
  END IF;

  -- ======================================= GAP 3 — forfeit returns web stock
  INSERT INTO public.layaway_accounts (customer_id, invoice_number, currency, total_amount, remaining_balance,
                                       payment_plan_months, order_date, status, source_channel, web_reference,
                                       downpayment_amount, customer_lang, discount_type)
  VALUES (v_c, 'ZZGAPS0923L', 'JPY', 30000, 30000, 3, current_date, 'active', 'web', 'CJ-W-ZZ0923L', 9000, 'en',
          NULL)   -- explicit: layaway_accounts_discount_type_check allows NULL
  RETURNING id INTO v_la1;
  INSERT INTO public.layaway_account_items (account_id, website_product_id, variant_id, title, sku, quantity,
                                            unit_price_jpy, line_total_jpy)
  VALUES (v_la1, v_p, v_v2, 'ZZ gaps assertion', 'ZZ-GAPS-0923', 1, 30000, 30000);
  INSERT INTO public.layaway_schedule (account_id, installment_number, due_date, base_installment_amount,
                                       total_due_amount, currency, status)
  VALUES (v_la1, 1, current_date + 30, 7000, 7000, 'JPY', 'pending');

  INSERT INTO public.layaway_accounts (customer_id, invoice_number, currency, total_amount, remaining_balance,
                                       payment_plan_months, order_date, status, source_channel, discount_type)
  VALUES (v_c, 'ZZGAPS0923H', 'JPY', 30000, 30000, 3, current_date, 'active', 'hub_manual',
          NULL)   -- explicit: layaway_accounts_discount_type_check allows NULL
  RETURNING id INTO v_la2;

  -- 3a. Web plan: forfeited, schedule cancelled, piece back on sale, marker set.
  v_r := public.manual_forfeit_layaway_atomic(v_la1, v_staff, 'staff');
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR NOT (v_r->>'is_web')::boolean
     OR (v_r->>'stock_lines_restored')::int <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3a web forfeit returned %', v_r;
  END IF;
  SELECT status::text, stock_released_at INTO v_st, v_rel FROM public.layaway_accounts WHERE id = v_la1;
  SELECT stock_qty INTO v_n FROM public.website_product_variants WHERE id = v_v2;
  IF v_st <> 'forfeited' OR v_rel IS NULL OR v_n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3a after forfeit: status %, stock_released_at %, stock %', v_st, v_rel, v_n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.layaway_schedule WHERE account_id = v_la1 AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3a schedule rows were not cancelled';
  END IF;

  -- 3b. Forfeiting twice is refused and returns nothing twice.
  v_r := public.manual_forfeit_layaway_atomic(v_la1, v_staff, 'staff');
  SELECT stock_qty INTO v_n FROM public.website_product_variants WHERE id = v_v2;
  IF v_r->>'error' IS DISTINCT FROM 'not_forfeitable' OR v_n <> 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3b second forfeit returned % (stock %)', v_r, v_n;
  END IF;

  -- 3c. Reactivation (what reactivate-account writes) takes the piece back.
  UPDATE public.layaway_accounts SET status = 'extension_active' WHERE id = v_la1;
  SELECT stock_released_at INTO v_rel FROM public.layaway_accounts WHERE id = v_la1;
  SELECT stock_qty INTO v_n FROM public.website_product_variants WHERE id = v_v2;
  IF v_rel IS NOT NULL OR v_n <> 0 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3c reactivation did not re-hold (stock_released_at %, stock %)', v_rel, v_n;
  END IF;

  -- 3d. Forfeit again, the piece sells, reactivation is refused and the plan
  --     stays forfeited.
  v_r := public.manual_forfeit_layaway_atomic(v_la1, v_staff, 'staff');
  UPDATE public.website_product_variants SET stock_qty = 0 WHERE id = v_v2;   -- someone bought it
  v_raised := false;
  BEGIN
    UPDATE public.layaway_accounts SET status = 'extension_active' WHERE id = v_la1;
  EXCEPTION WHEN OTHERS THEN
    v_raised := (SQLERRM LIKE 'web_layaway_stock_unavailable%');
  END;
  SELECT status::text INTO v_st FROM public.layaway_accounts WHERE id = v_la1;
  IF NOT v_raised OR v_st <> 'forfeited' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3d reactivation of a sold piece (raised %, status %)', v_raised, v_st;
  END IF;

  -- 3e. A Hub plan's forfeit touches no website stock and sets no marker.
  UPDATE public.website_product_variants SET stock_qty = 5 WHERE id = v_v2;
  v_r := public.manual_forfeit_layaway_atomic(v_la2, v_staff, 'staff');
  SELECT stock_released_at INTO v_rel FROM public.layaway_accounts WHERE id = v_la2;
  SELECT stock_qty INTO v_n FROM public.website_product_variants WHERE id = v_v2;
  IF NOT coalesce((v_r->>'ok')::boolean, false) OR (v_r->>'is_web')::boolean OR v_rel IS NOT NULL OR v_n <> 5 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — 3e hub forfeit: % (marker %, stock %)', v_r, v_rel, v_n;
  END IF;

  RAISE NOTICE 'ALL WEB ORDER GAP ASSERTIONS PASSED';
END
$t$;

ROLLBACK;
