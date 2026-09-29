-- ============================================================================
-- Website orders PR 3 (web order drafts) — LOCAL tests. Run after the stub and
-- the migration (see docs/sql/20261018_web_order_drafts_local_stub.sql).
-- Every check RAISEs on failure; the last line prints ALL PASSED.
-- ============================================================================
\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.ok(p boolean, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', p_what; END IF;
END $$;

-- ---------------------------------------------------------------- fixtures
INSERT INTO public.customers (id, full_name, email) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'Ana Web', 'ana@example.com'),
  ('c0000000-0000-0000-0000-000000000002', 'Hub Customer', 'hub@example.com');
INSERT INTO public.customer_addresses (id, customer_id, recipient_name, line1, city, country) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'Ana', '1-2-3 Tateishi', 'Tokyo', 'JP'),
  ('a0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 'Ana', '5th Ave', 'New York', 'US');
INSERT INTO public.website_products (id, sku, slug, name) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'AL3', 'al3', 'Pendant K18'),
  ('b0000000-0000-0000-0000-000000000002', 'R7828', 'r7828', 'Ring 750');
INSERT INTO public.website_product_variants (id, product_id, price_jpy, stock_qty) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 20000, 1),
  ('d0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 400000, 1);
-- Users: admin, staff (all three keys), csr (no create_account), finance (none).
INSERT INTO public.user_roles (user_id, role) VALUES
  ('e0000000-0000-0000-0000-00000000000a', 'admin'),
  ('e0000000-0000-0000-0000-00000000000b', 'staff'),
  ('e0000000-0000-0000-0000-00000000000c', 'csr'),
  ('e0000000-0000-0000-0000-00000000000d', 'finance');
INSERT INTO public.profiles (user_id, full_name) VALUES ('e0000000-0000-0000-0000-00000000000a', 'Owner');

CREATE OR REPLACE FUNCTION pg_temp.quote(p_mode text, p_variant uuid, p_price int, p_ship int, p_addr uuid,
                                         p_term int DEFAULT NULL, p_cur text DEFAULT 'JPY', p_rate numeric DEFAULT NULL,
                                         p_reserved bigint DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.checkout_quotes (customer_id, items, mode, term_months, ship_to_address_id,
                                      subtotal_jpy, shipping_jpy, total_jpy, settlement_currency, fx_rate, fx_rate_date,
                                      reserved_invoice_seq)
  VALUES ('c0000000-0000-0000-0000-000000000001',
          jsonb_build_array(jsonb_build_object('variant_id', p_variant, 'qty', 1)),
          p_mode, p_term, p_addr, p_price, p_ship, p_price + coalesce(p_ship, 0), p_cur, p_rate,
          CASE WHEN p_rate IS NULL THEN NULL ELSE DATE '2026-09-29' END, p_reserved)
  RETURNING id
$$;

-- ------------------------------------------------------------ 1. the switch
DO $t$
DECLARE r jsonb; q uuid;
BEGIN
  PERFORM pg_temp.ok(public.web_checkout_mode() = 'order', 'switch seeded order');
  q := pg_temp.quote('full', 'd0000000-0000-0000-0000-000000000001', 20000, 0, 'a0000000-0000-0000-0000-000000000001');
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q);
  PERFORM pg_temp.ok(r ->> 'error' = 'checkout_mode_not_draft', 'writer dormant while order: ' || r::text);
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000001') = 1, 'no stock taken while dormant');

  PERFORM set_config('test.uid', 'e0000000-0000-0000-0000-00000000000b', false);
  r := public.set_web_checkout_mode('draft');
  PERFORM pg_temp.ok(r ->> 'error' = 'permission_denied', 'staff cannot flip: ' || r::text);
  PERFORM set_config('test.uid', 'e0000000-0000-0000-0000-00000000000a', false);
  r := public.set_web_checkout_mode('bogus');
  PERFORM pg_temp.ok(r ->> 'error' = 'invalid_mode', 'invalid mode refused');
  r := public.set_web_checkout_mode('draft', 'draft');
  PERFORM pg_temp.ok(r ->> 'error' = 'stale', 'stale expected refused');
  r := public.set_web_checkout_mode('draft', 'order');
  PERFORM pg_temp.ok((r ->> 'changed')::boolean AND public.web_checkout_mode() = 'draft', 'admin flips to draft: ' || r::text);
  PERFORM pg_temp.ok((SELECT count(*) FROM public.audit_logs WHERE action = 'set_web_checkout_mode') = 1, 'flip audited');
  r := public.get_web_checkout_mode();
  PERFORM pg_temp.ok(r ->> 'mode' = 'draft' AND (r ->> 'can_change')::boolean, 'get_web_checkout_mode reads it');
  BEGIN
    UPDATE public.system_settings SET value = '"order"' WHERE key = 'web_checkout_mode';
    RAISE EXCEPTION 'FAIL: direct UPDATE of the switch was allowed';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  END;
  PERFORM set_config('test.uid', '', false);
END $t$;

-- ---------------------------------------------------- 2. a cash draft (JPY)
DO $t$
DECLARE r jsonb; q uuid; q2 uuid; d uuid;
BEGIN
  q := (SELECT id FROM public.checkout_quotes ORDER BY created_at LIMIT 1);
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000002', q);
  PERFORM pg_temp.ok(r ->> 'error' = 'quote_not_found', 'another customer''s quote refused');
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q, 'ja');
  PERFORM pg_temp.ok((r ->> 'ok')::boolean, 'cash draft written: ' || r::text);
  d := (r ->> 'draft_id')::uuid;
  PERFORM pg_temp.ok(r ->> 'web_reference' = 'CJ-W-900051' AND r ->> 'invoice_number' = '900051', 'number drawn for a cash draft');
  PERFORM pg_temp.ok((r ->> 'shipping_pending')::boolean = false, 'JP shipping carried');
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000001') = 0, 'stock held');
  PERFORM pg_temp.ok((SELECT hold_state FROM public.web_order_draft_lines WHERE draft_id = d) = 'held', 'line held');
  PERFORM pg_temp.ok((SELECT consumed_at IS NOT NULL FROM public.checkout_quotes WHERE id = q), 'quote consumed');
  PERFORM pg_temp.ok((SELECT ship_to_snapshot ->> 'city' FROM public.web_order_drafts WHERE id = d) = 'Tokyo', 'address snapshotted');
  PERFORM pg_temp.ok((SELECT customer_lang FROM public.web_order_drafts WHERE id = d) = 'ja', 'language kept');
  PERFORM pg_temp.ok(public.page365_web_holds('d0000000-0000-0000-0000-000000000001') = 1, 'Page365 sync sees the draft hold');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.staff_notifications
                       WHERE title = 'New website order — confirm the piece' AND metadata ->> 'web_draft_id' = d::text) = 1, 'draft bell');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.cash_orders) = 0, 'no order row for a draft');

  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q);
  PERFORM pg_temp.ok(r ->> 'error' = 'quote_already_used', 'a quote makes one draft');

  -- Sold out: the whole draft is rolled back, nothing left behind.
  q2 := pg_temp.quote('full', 'd0000000-0000-0000-0000-000000000001', 20000, 0, 'a0000000-0000-0000-0000-000000000001');
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q2);
  PERFORM pg_temp.ok(r ->> 'error' = 'out_of_stock', 'sold out refused: ' || r::text);
  PERFORM pg_temp.ok((SELECT count(*) FROM public.web_order_drafts) = 1, 'refused draft left no row');
  PERFORM pg_temp.ok((SELECT consumed_at IS NULL FROM public.checkout_quotes WHERE id = q2), 'refused quote not consumed');
END $t$;

-- ---------------------------------------------- 3. shipping at confirmation
DO $t$
DECLARE r jsonb; q uuid;
BEGIN
  UPDATE public.website_product_variants SET stock_qty = 3 WHERE id = 'd0000000-0000-0000-0000-000000000001';
  -- JP has a rate card: the quote must carry the fee.
  q := pg_temp.quote('full', 'd0000000-0000-0000-0000-000000000001', 20000, NULL, 'a0000000-0000-0000-0000-000000000001');
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q);
  PERFORM pg_temp.ok(r ->> 'error' = 'shipping_quote_required', 'JP without fee refused: ' || r::text);
  -- US has none: shipping is added at confirmation.
  q := pg_temp.quote('full', 'd0000000-0000-0000-0000-000000000001', 20000, NULL, 'a0000000-0000-0000-0000-000000000002');
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q);
  PERFORM pg_temp.ok((r ->> 'ok')::boolean AND (r ->> 'shipping_pending')::boolean, 'US draft, shipping pending: ' || r::text);
  PERFORM pg_temp.ok((SELECT shipping IS NULL AND country = 'US' FROM public.web_order_drafts WHERE id = (r ->> 'draft_id')::uuid), 'stored as pending');
  PERFORM pg_temp.ok((SELECT body LIKE '%+ shipping to add%' FROM public.staff_notifications
                       WHERE metadata ->> 'web_draft_id' = r ->> 'draft_id'), 'bell says shipping to add');
END $t$;

-- ---------------------------------------------------- 4. a layaway draft (PHP)
DO $t$
DECLARE r jsonb; q uuid;
BEGIN
  q := pg_temp.quote('layaway', 'd0000000-0000-0000-0000-000000000002', 400000, 0, 'a0000000-0000-0000-0000-000000000001',
                     6, 'PHP', 0.42, 900777);
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q, 'en');
  PERFORM pg_temp.ok(r ->> 'error' = 'agreement_missing', 'unsigned layaway refused: ' || r::text);
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q, 'en', 'v3', now());
  PERFORM pg_temp.ok((r ->> 'ok')::boolean, 'layaway draft: ' || r::text);
  PERFORM pg_temp.ok(r ->> 'invoice_number' = '900777' AND r ->> 'web_reference' = 'CJ-W-900777', 'reserved number used');
  PERFORM pg_temp.ok(r ->> 'currency' = 'PHP' AND (r ->> 'total')::numeric = 168000, 'pesos half-up at the quote rate');
  PERFORM pg_temp.ok((r ->> 'deposit')::numeric > 0 AND jsonb_array_length(r -> 'schedule') = 6, 'provisional deposit + schedule');

  -- Below the 8-month minimum (₱126,000): refused, stock untouched.
  UPDATE public.website_product_variants SET stock_qty = 1 WHERE id = 'd0000000-0000-0000-0000-000000000002';
  q := pg_temp.quote('layaway', 'd0000000-0000-0000-0000-000000000002', 10000, 0, 'a0000000-0000-0000-0000-000000000001',
                     8, 'JPY');
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q, 'en', 'v3', now());
  PERFORM pg_temp.ok(r ->> 'error' = 'below_plan_minimum', 'plan minimum: ' || r::text);
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000002') = 1, 'refusal kept stock');
END $t$;

-- ----------------------------------------------- 5. decline ("Can't supply")
DO $t$
DECLARE r jsonb; d uuid;
BEGIN
  d := (SELECT id FROM public.web_order_drafts WHERE country = 'US');
  r := public.decline_web_draft_atomic(d, '  ', 'e0000000-0000-0000-0000-00000000000b');
  PERFORM pg_temp.ok(r ->> 'error' = 'reason_required', 'reason required');
  r := public.decline_web_draft_atomic(d, 'Sold at the shop', 'e0000000-0000-0000-0000-00000000000d');
  PERFORM pg_temp.ok(r ->> 'error' = 'permission_denied', 'finance may not decline');
  r := public.decline_web_draft_atomic(d, 'Sold at the shop', NULL);
  PERFORM pg_temp.ok(r ->> 'error' = 'user_identity_required', 'staff path needs a user');
  r := public.decline_web_draft_atomic(d, 'Sold at the shop', 'e0000000-0000-0000-0000-00000000000b');
  PERFORM pg_temp.ok((r ->> 'ok')::boolean AND r ->> 'status' = 'declined', 'declined: ' || r::text);
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000001') = 3, 'stock back');
  PERFORM pg_temp.ok((SELECT hold_state FROM public.web_order_draft_lines WHERE draft_id = d) = 'released', 'line released');
  PERFORM pg_temp.ok((SELECT decline_reason = 'Sold at the shop' AND decided_by = 'e0000000-0000-0000-0000-00000000000b'
                        FROM public.web_order_drafts WHERE id = d), 'decision recorded');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.audit_logs WHERE entity_id = d AND action = 'web_draft_declined') = 1, 'decline audited');
  r := public.decline_web_draft_atomic(d, 'again', 'e0000000-0000-0000-0000-00000000000b');
  PERFORM pg_temp.ok(r ->> 'error' = 'not_open', 'a closed draft is never re-released');
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000001') = 3, 'stock returned once');
END $t$;

-- ------------------------------------------------------- 6. the 72h expiry
DO $t$
DECLARE r jsonb; q uuid; d uuid;
BEGIN
  q := pg_temp.quote('full', 'd0000000-0000-0000-0000-000000000001', 20000, 800, 'a0000000-0000-0000-0000-000000000001');
  r := public.create_web_draft_atomic('c0000000-0000-0000-0000-000000000001', q);
  d := (r ->> 'draft_id')::uuid;
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000001') = 2, 'held');
  -- 50h old: the 48h bell, once.
  UPDATE public.web_order_drafts SET created_at = now() - interval '50 hours' WHERE id = d;
  PERFORM public.web_reservation_expiring_bells();
  PERFORM public.web_reservation_expiring_bells();
  PERFORM pg_temp.ok((SELECT count(*) FROM public.staff_notifications
                       WHERE type = 'web_reservation_expiring' AND metadata ->> 'entity_id' = d::text
                         AND metadata ->> 'entity_type' = 'web_draft' AND account_id IS NULL) = 1, '48h bell once for a draft');
  r := public.expire_web_drafts_atomic();
  PERFORM pg_temp.ok(jsonb_array_length(r -> 'expired_drafts') = 0, 'not expired before 72h');
  UPDATE public.web_order_drafts SET created_at = now() - interval '73 hours' WHERE id = d;
  r := public.expire_web_drafts_atomic();
  PERFORM pg_temp.ok(jsonb_array_length(r -> 'expired_drafts') = 1, 'expired: ' || r::text);
  PERFORM pg_temp.ok((SELECT status FROM public.web_order_drafts WHERE id = d) = 'expired', 'status expired');
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000001') = 3, 'stock back on expiry');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.audit_logs WHERE entity_id = d AND action = 'web_draft_expired') = 1, 'expiry audited');
END $t$;

-- ----------------------------------------------------- 7. Confirm, cash order
DO $t$
DECLARE r jsonb; d uuid; o uuid; sr uuid; v_courier uuid := (SELECT id FROM public.shipping_methods LIMIT 1);
BEGIN
  d := (SELECT id FROM public.web_order_drafts WHERE mode = 'full' AND status = 'to_confirm');
  INSERT INTO public.service_requests (customer_id, web_draft_id, kind, details)
  VALUES ('c0000000-0000-0000-0000-000000000001', d, 'resize', 'Size 12 please') RETURNING id INTO sr;
  BEGIN
    INSERT INTO public.service_requests (customer_id, kind, details) VALUES ('c0000000-0000-0000-0000-000000000001', 'resize', 'x');
    RAISE EXCEPTION 'FAIL: a request with no target was allowed';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000d', '{"total_amount":20800}');
  PERFORM pg_temp.ok(r ->> 'error' = 'permission_denied', 'finance may not confirm');
  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000c', '{"total_amount":20800}');
  PERFORM pg_temp.ok(r ->> 'error' = 'deadline_required', 'deadline required: ' || r::text);
  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000c',
         jsonb_build_object('total_amount', 25800, 'transfer_due_at', now() + interval '24 hours'),
         NULL, '[{"title":"Resize","quantity":0,"unit_price_jpy":5000,"line_total_jpy":5000}]');
  PERFORM pg_temp.ok(r ->> 'error' = 'service_lines_invalid', 'bad service line refused');

  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000001') = 3, 'stock before Confirm');
  -- csr holds create_cash_order: a cash draft is theirs to confirm.
  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000c',
         jsonb_build_object('total_amount', 25800, 'shipping_fee', 800, 'transfer_due_at', now() + interval '24 hours',
                            'planned_shipping_method_id', v_courier, 'notes', 'Gift wrap'),
         NULL, '[{"title":"Resize","quantity":1,"unit_price_jpy":5000,"line_total_jpy":5000}]');
  PERFORM pg_temp.ok((r ->> 'ok')::boolean AND r ->> 'entity_type' = 'cash_order', 'confirmed: ' || r::text);
  o := (r ->> 'order_id')::uuid;
  PERFORM pg_temp.ok((SELECT invoice_number = (SELECT invoice_seq::text FROM public.web_order_drafts WHERE id = d)
                             AND source_channel = 'web' AND payment_status = 'pending_transfer' AND status = 'pending'
                             AND ready_confirmed_at IS NOT NULL AND ready_confirmed_by = 'e0000000-0000-0000-0000-00000000000c'
                             AND expires_at = transfer_due_at AND total_amount = 25800 AND remaining_balance = 25800
                             AND shipping_fee = 800 AND planned_shipping_method_id = v_courier AND notes = 'Gift wrap'
                             AND loyalty_jpy_amount = 20000 AND web_released_at IS NULL
                             AND ship_to_snapshot ->> 'city' = 'Tokyo'
                        FROM public.cash_orders WHERE id = o), 'order row written as a confirmed web order');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.cash_order_items WHERE cash_order_id = o AND variant_id IS NOT NULL) = 1
                     AND (SELECT count(*) FROM public.cash_order_items WHERE cash_order_id = o AND variant_id IS NULL AND title = 'Resize') = 1,
                     'product line + service line');
  -- Stock was 3 before Confirm (this draft's hold was taken in section 2,
  -- before section 3 reset the count): Confirm must not move it.
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000001') = 3,
                     'NO second stock movement at Confirm');
  PERFORM pg_temp.ok(public.page365_web_holds('d0000000-0000-0000-0000-000000000001') = 1, 'hold now counted once, on the order');
  PERFORM pg_temp.ok((SELECT status = 'confirmed' AND cash_order_id = o FROM public.web_order_drafts WHERE id = d), 'draft confirmed');
  PERFORM pg_temp.ok((SELECT bool_and(hold_state = 'transferred') FROM public.web_order_draft_lines WHERE draft_id = d), 'lines transferred');
  PERFORM pg_temp.ok((SELECT cash_order_id = o AND web_draft_id = d FROM public.service_requests WHERE id = sr), 'service request moved to the order');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.staff_notifications WHERE title = 'Website order placed'
                        AND metadata ->> 'cash_order_id' = o::text) = 1, 'the confirmed order rings "Website order placed"');
  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000c',
         jsonb_build_object('total_amount', 25800, 'transfer_due_at', now() + interval '24 hours'));
  PERFORM pg_temp.ok(r ->> 'error' = 'not_open', 'confirmed once');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.cash_orders) = 1, 'one order');

  -- Released on the first REAL payment only.
  INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method, reference_number)
  VALUES (o, 1000, 'JPY', CURRENT_DATE, 'loyalty_redemption', 'LOYALTY-1');
  PERFORM pg_temp.ok((SELECT web_released_at IS NULL FROM public.cash_orders WHERE id = o), 'loyalty redemption does not release');
  INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method)
  VALUES (o, 5000, 'JPY', CURRENT_DATE, 'bank_transfer');
  PERFORM pg_temp.ok((SELECT web_released_at IS NOT NULL FROM public.cash_orders WHERE id = o), 'a real payment releases');
  UPDATE public.cash_payments SET voided_at = now() WHERE cash_order_id = o AND payment_method = 'bank_transfer';
  PERFORM pg_temp.ok((SELECT web_released_at IS NOT NULL FROM public.cash_orders WHERE id = o), 'sticky after a void');
END $t$;

-- -------------------------------------------------- 8. Confirm, layaway plan
DO $t$
DECLARE r jsonb; d uuid; a uuid; sched jsonb; dp numeric; tot numeric;
BEGIN
  d := (SELECT id FROM public.web_order_drafts WHERE mode = 'layaway' AND status = 'to_confirm');
  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000c',
         jsonb_build_object('total_amount', 168000, 'transfer_due_at', now() + interval '72 hours'));
  PERFORM pg_temp.ok(r ->> 'error' = 'permission_denied', 'csr without create_account may not confirm a plan');

  -- Final figures: + ₱1,500 shipping, recomputed by the caller (PR 4 uses layaway_quote).
  tot := 169500;
  sched := (SELECT jsonb_agg(jsonb_build_object('installment_number', s ->> 'installment_number', 'due_date', s ->> 'due_date',
                                                'amount', s -> 'amount') ORDER BY (s ->> 'installment_number')::int)
              FROM jsonb_array_elements(public.layaway_quote(168000, 6, 'PHP', (now() AT TIME ZONE 'Asia/Manila')::date, 1500, 0) -> 'schedule') s);
  dp := (public.layaway_quote(168000, 6, 'PHP', (now() AT TIME ZONE 'Asia/Manila')::date, 1500, 0) ->> 'deposit')::numeric;

  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000b',
         jsonb_build_object('total_amount', tot, 'shipping_fee', 1500, 'downpayment_amount', dp,
                            'payment_plan_months', 8, 'transfer_due_at', now() + interval '72 hours'), sched);
  PERFORM pg_temp.ok(r ->> 'error' = 'term_locked', 'term locked (W2-3): ' || r::text);
  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000b',
         jsonb_build_object('total_amount', tot + 1, 'shipping_fee', 1500, 'downpayment_amount', dp,
                            'transfer_due_at', now() + interval '72 hours'), sched);
  PERFORM pg_temp.ok(r ->> 'error' = 'schedule_mismatch', 'schedule must add up: ' || r::text);
  r := public.materialize_web_draft_atomic(d, 'e0000000-0000-0000-0000-00000000000b',
         jsonb_build_object('total_amount', tot, 'shipping_fee', 1500, 'downpayment_amount', dp,
                            'transfer_due_at', now() + interval '72 hours'), sched);
  PERFORM pg_temp.ok((r ->> 'ok')::boolean AND r ->> 'entity_type' = 'layaway_account', 'plan confirmed: ' || r::text);
  a := (r ->> 'account_id')::uuid;
  PERFORM pg_temp.ok((SELECT invoice_number = '900777' AND web_reference = 'CJ-W-900777' AND currency = 'PHP'
                             AND total_amount = tot AND downpayment_amount = dp AND payment_plan_months = 6
                             AND fx_rate_used = 0.42 AND agreement_version = 'v3' AND agreement_acceptance_date IS NOT NULL
                             AND ready_confirmed_by = 'e0000000-0000-0000-0000-00000000000b' AND status = 'active'
                             AND loyalty_jpy_amount = 400000 AND source_channel = 'web'
                        FROM public.layaway_accounts WHERE id = a), 'plan row');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.layaway_schedule WHERE account_id = a) = 6, 'six instalments');
  PERFORM pg_temp.ok((SELECT stock_qty FROM public.website_product_variants WHERE id = 'd0000000-0000-0000-0000-000000000002') = 1,
                     'plan: no second stock movement');

  INSERT INTO public.payments (account_id, amount_paid, currency, reference_number, remarks)
  VALUES (a, dp, 'PHP', 'DP-1', 'downpayment');
  PERFORM pg_temp.ok((SELECT web_released_at IS NOT NULL FROM public.layaway_accounts WHERE id = a), 'plan released on the deposit');
END $t$;

-- --------------------------------------- 9. Hub orders are never stamped
DO $t$
DECLARE a uuid;
BEGIN
  INSERT INTO public.layaway_accounts (customer_id, invoice_number, currency, total_amount, payment_plan_months, order_date,
                                       remaining_balance, downpayment_amount)
  VALUES ('c0000000-0000-0000-0000-000000000002', '19999', 'JPY', 30000, 3, CURRENT_DATE, 30000, 9000) RETURNING id INTO a;
  INSERT INTO public.payments (account_id, amount_paid, currency) VALUES (a, 9000, 'JPY');
  PERFORM pg_temp.ok((SELECT web_released_at IS NULL FROM public.layaway_accounts WHERE id = a), 'Hub plan not stamped');
END $t$;

-- ------------------------------------------------ 10. the email health report
DO $t$
DECLARE r jsonb;
BEGIN
  r := public.email_delivery_report(24);
  -- 4 drafts, but the expired one was back-dated 73h: 3 inside the 24h window.
  PERFORM pg_temp.ok((r -> 'expected' ->> 'web_drafts_placed')::int = 3, 'drafts counted: ' || (r -> 'expected')::text);
  PERFORM pg_temp.ok((r -> 'expected' ->> 'web_drafts_closed')::int = 2, 'declined + expired counted');
  PERFORM pg_temp.ok((r -> 'expected' ->> 'web_orders_placed')::int = 0, 'a confirmed draft is not counted twice');
  PERFORM pg_temp.ok((r -> 'expected' ->> 'web_layaways_placed')::int = 0, 'nor a confirmed plan');
  PERFORM pg_temp.ok((r -> 'expected' ->> 'web_reservations_confirmed')::int = 2, 'the ready emails');
END $t$;

-- ---------------------------------------------------------------- 11. RLS
DO $t$
BEGIN
  PERFORM set_config('test.uid', 'e0000000-0000-0000-0000-00000000000b', false);
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.ok((SELECT count(*) FROM public.web_order_drafts) = 4, 'staff reads drafts');
  PERFORM set_config('test.uid', 'e0000000-0000-0000-0000-00000000000d', false);
  PERFORM pg_temp.ok((SELECT count(*) FROM public.web_order_drafts) = 0, 'finance reads none');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.web_order_draft_lines) = 0, 'finance reads no lines');
  BEGIN
    UPDATE public.web_order_drafts SET status = 'declined';
    RAISE EXCEPTION 'FAIL: authenticated could write a draft';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  PERFORM set_config('test.uid', '', false);
END $t$;

-- ------------------------------------------------------ 12. backfill on re-run
ALTER TABLE public.payments DISABLE TRIGGER trg_web_released_payments;
UPDATE public.layaway_accounts SET web_released_at = NULL WHERE web_reference = 'CJ-W-900777';
ALTER TABLE public.payments ENABLE TRIGGER trg_web_released_payments;
\ir ../../supabase/migrations/20261018100000_web_order_drafts.sql
DO $t$
BEGIN
  PERFORM pg_temp.ok((SELECT web_released_at = (SELECT min(created_at) FROM public.payments p WHERE p.account_id = a.id)
                        FROM public.layaway_accounts a WHERE web_reference = 'CJ-W-900777'), 'backfill stamps the first payment time');
  PERFORM pg_temp.ok(public.web_checkout_mode() = 'draft', 're-run kept the owner''s switch');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.web_order_drafts) = 4, 're-run kept the drafts');
END $t$;

SELECT 'ALL PASSED' AS result;
