-- ============================================================================
-- Website orders PR 3 (20261018100000_web_order_drafts.sql) — live checks.
-- (P) and (A) are SELECTs. (T) is the rollback-only preview: it runs the whole
-- migration and a scenario inside ONE transaction that ALWAYS ends in
-- RAISE EXCEPTION 'RESULT …' — the result is in the error text and NOTHING is
-- kept. Build (T) by pasting the migration WITHOUT its BEGIN; / COMMIT; lines
-- between the $MIGRATION$ markers.
-- ============================================================================

-- (P.1) The three bodies this file replaces are the live ones.
-- Want 6417708e3c92f960abb519fca2daea5b | c5e8e93e89c8edc2cdcfc9383880360a | 0909b5efefdac33ea37d9d0078e7850c
SELECT 'P.1' AS chk,
       md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.page365_web_holds(uuid)'))),
       md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.email_delivery_report(integer)'))),
       md5((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.web_reservation_expiring_bells()')));

-- (P.2) Nothing of this PR exists yet. Want f | f | 0 | f.
SELECT 'P.2' AS chk, to_regclass('public.web_order_drafts') IS NOT NULL,
       to_regprocedure('public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)') IS NOT NULL,
       (SELECT count(*) FROM public.system_settings WHERE key = 'web_checkout_mode'),
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'cash_orders' AND column_name = 'web_released_at');

-- (P.3) The web orders the backfill will stamp (first real payment). Want 4 rows on 2026-09-29.
SELECT 'P.3' AS chk, 'cash' AS t, o.invoice_number, o.status::text, min(p.created_at) AS first_paid
  FROM public.cash_orders o JOIN public.cash_payments p ON p.cash_order_id = o.id
 WHERE o.source_channel = 'web' AND p.voided_at IS NULL AND p.amount_paid > 0
   AND p.payment_method IS DISTINCT FROM 'loyalty_redemption' AND coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%'
 GROUP BY 1, 2, 3, 4
UNION ALL
SELECT 'P.3', 'layaway', a.invoice_number, a.status::text, min(p.created_at)
  FROM public.layaway_accounts a JOIN public.payments p ON p.account_id = a.id
 WHERE a.source_channel = 'web' AND p.voided_at IS NULL AND p.amount_paid > 0
   AND p.payment_method IS DISTINCT FROM 'loyalty_redemption' AND coalesce(p.reference_number, '') NOT LIKE 'LOYALTY-%'
 GROUP BY 1, 2, 3, 4;

-- (P.4) service_requests still has its original target CHECK. Want 1 row, service_requests_check.
SELECT 'P.4' AS chk, conname, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'public.service_requests'::regclass AND contype = 'c' AND conname LIKE 'service_requests%check';

-- (T) Rollback-only preview. Nothing is kept.
DO $preview$
DECLARE
  v_holds_before bigint;
  v_holds_after  bigint;
  v_out   jsonb := '{}'::jsonb;
  v_r     jsonb;
  v_cust  uuid;
  v_var   uuid;
  v_stock integer;
  v_q     uuid;
  v_d     uuid;
  v_user  uuid;
BEGIN
  SELECT coalesce(sum(public.page365_web_holds(v.id)), 0) INTO v_holds_before FROM public.website_product_variants v;

  EXECUTE $MIGRATION$
  -- paste supabase/migrations/20261018100000_web_order_drafts.sql here, WITHOUT "BEGIN;" and "COMMIT;"
  $MIGRATION$;

  SELECT coalesce(sum(public.page365_web_holds(v.id)), 0) INTO v_holds_after FROM public.website_product_variants v;
  v_out := v_out || jsonb_build_object(
    'holds_unchanged', v_holds_before = v_holds_after,
    'mode', public.web_checkout_mode(),
    'released_cash', (SELECT count(*) FROM public.cash_orders WHERE web_released_at IS NOT NULL),
    'released_layaway', (SELECT count(*) FROM public.layaway_accounts WHERE web_released_at IS NOT NULL),
    'released_non_web', (SELECT count(*) FROM public.cash_orders WHERE web_released_at IS NOT NULL AND source_channel <> 'web')
                      + (SELECT count(*) FROM public.layaway_accounts WHERE web_released_at IS NOT NULL AND source_channel <> 'web'),
    'report_status', public.email_delivery_report(24) ->> 'status',
    'report_has_drafts', (public.email_delivery_report(24) -> 'expected') ? 'web_drafts_placed',
    'dormant', public.create_web_draft_atomic(gen_random_uuid(), gen_random_uuid()) ->> 'error');

  -- Scenario on the Test Customer and an in-stock piece of an UNPUBLISHED product.
  SELECT c.id INTO v_cust FROM public.customers c WHERE c.customer_code = 'CJ-2026-05088' AND c.is_test;
  SELECT v.id, v.stock_qty INTO v_var, v_stock FROM public.website_product_variants v
    JOIN public.website_products p ON p.id = v.product_id
   WHERE p.status <> 'active' AND v.stock_qty > 0 ORDER BY v.created_at LIMIT 1;
  SELECT ur.user_id INTO v_user FROM public.user_roles ur WHERE ur.role = 'admin' ORDER BY ur.user_id LIMIT 1;

  IF v_cust IS NOT NULL AND v_var IS NOT NULL AND v_user IS NOT NULL THEN
    PERFORM set_config('app.allow_web_checkout_mode_change', 'on', true);
    UPDATE public.system_settings SET value = '"draft"' WHERE key = 'web_checkout_mode';
    PERFORM set_config('app.allow_web_checkout_mode_change', '', true);

    INSERT INTO public.checkout_quotes (customer_id, items, mode, subtotal_jpy, shipping_jpy, total_jpy)
    VALUES (v_cust, jsonb_build_array(jsonb_build_object('variant_id', v_var, 'qty', 1)), 'full', 10000, 800, 10800)
    RETURNING id INTO v_q;
    v_r := public.create_web_draft_atomic(v_cust, v_q, 'en');
    v_d := (v_r ->> 'draft_id')::uuid;
    v_out := v_out || jsonb_build_object(
      'draft', v_r ->> 'ok', 'draft_ref', v_r ->> 'web_reference',
      'held', (SELECT stock_qty FROM public.website_product_variants WHERE id = v_var) = v_stock - 1,
      'bell', (SELECT count(*) FROM public.staff_notifications WHERE metadata ->> 'web_draft_id' = v_d::text));

    v_r := public.materialize_web_draft_atomic(v_d, v_user,
             jsonb_build_object('total_amount', 10800, 'shipping_fee', 800, 'transfer_due_at', now() + interval '24 hours'),
             NULL, '[{"title":"Resize","quantity":1,"unit_price_jpy":0,"line_total_jpy":0}]');
    v_out := v_out || jsonb_build_object(
      'confirm', v_r ->> 'ok', 'confirm_error', v_r ->> 'error',
      'order_invoice', (SELECT invoice_number FROM public.cash_orders WHERE id = (v_r ->> 'order_id')::uuid),
      'order_lines', (SELECT count(*) FROM public.cash_order_items WHERE cash_order_id = (v_r ->> 'order_id')::uuid),
      'stock_after_confirm_unchanged', (SELECT stock_qty FROM public.website_product_variants WHERE id = v_var) = v_stock - 1,
      'hold_counted_once', public.page365_web_holds(v_var));
  ELSE
    v_out := v_out || jsonb_build_object('scenario', 'skipped', 'cust', v_cust, 'variant', v_var, 'admin', v_user);
  END IF;

  RAISE EXCEPTION 'RESULT %', v_out;
END
$preview$;

-- (A) AFTER the migration is applied.
-- (A.1) Bodies. Want 45bb5a67f283468824870545ca41c204 | 640083183d6b994101543ebbea7810eb | a90b52945e1acde7c279d3190a99ee8e
SELECT 'A.1' AS chk,
       md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.page365_web_holds(uuid)'::regprocedure)),
       md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.email_delivery_report(integer)'::regprocedure)),
       md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.web_reservation_expiring_bells()'::regprocedure));
-- (A.2) Dormant. Want order | 0 drafts.
SELECT 'A.2' AS chk, public.web_checkout_mode(), (SELECT count(*) FROM public.web_order_drafts);
-- (A.3) Backfill = P.3's rows, web only. Want the P.3 count | 0.
SELECT 'A.3' AS chk,
       (SELECT count(*) FROM public.cash_orders WHERE web_released_at IS NOT NULL)
     + (SELECT count(*) FROM public.layaway_accounts WHERE web_released_at IS NOT NULL),
       (SELECT count(*) FROM public.cash_orders WHERE web_released_at IS NOT NULL AND source_channel <> 'web')
     + (SELECT count(*) FROM public.layaway_accounts WHERE web_released_at IS NOT NULL AND source_channel <> 'web');
-- (A.4) Grants. Want f | f | t (four rows).
SELECT 'A.4' AS chk, s,
       has_function_privilege('anon', s, 'EXECUTE'), has_function_privilege('authenticated', s, 'EXECUTE'),
       has_function_privilege('service_role', s, 'EXECUTE')
  FROM unnest(ARRAY['public.create_web_draft_atomic(uuid,uuid,text,text,timestamptz)',
                    'public.decline_web_draft_atomic(uuid,text,uuid,text)',
                    'public.expire_web_drafts_atomic(integer,integer)',
                    'public.materialize_web_draft_atomic(uuid,uuid,jsonb,jsonb,jsonb)']) s;
