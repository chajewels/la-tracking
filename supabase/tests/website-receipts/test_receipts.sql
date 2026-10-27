-- Website receipts — scenario suite (run by run.sh on a scratch database).
-- Each block either passes silently or RAISEs; the last line prints PASSED.
\set ON_ERROR_STOP 1

CREATE OR REPLACE FUNCTION pg_temp.ok(cond boolean, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.issued(p_order uuid) RETURNS public.website_receipts LANGUAGE sql AS $$
  SELECT * FROM public.website_receipts
   WHERE status = 'issued' AND (cash_order_id = p_order OR layaway_account_id = p_order)
$$;

INSERT INTO public.customers (id, full_name, email) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Real One', 'one@example.com'),
  ('00000000-0000-0000-0000-0000000000c2', 'Real Two', 'two@example.com');
INSERT INTO public.customers (id, full_name, email, is_test) VALUES
  ('00000000-0000-0000-0000-0000000000c9', 'Test Customer', 'test@chajewelsjp.com', true);
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000a0a0', 'admin');

-- ---------------------------------------------------------------- the switch
DO $t$ BEGIN
  PERFORM pg_temp.ok(public.web_receipts_mode() = 'off', 'seeded off');
  PERFORM pg_temp.ok(public.web_receipts_live_at() IS NULL, 'live_at seeded null');
END $t$;

-- A direct write to the switch is refused.
DO $t$ BEGIN
  BEGIN
    UPDATE public.system_settings SET value = '"on"' WHERE key = 'web_receipts_mode';
    RAISE EXCEPTION 'FAIL: direct switch write allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF;
  END;
END $t$;

-- A non-admin user is refused; an invalid mode is refused.
DO $t$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000b0b0', false);
  r := public.set_web_receipts_mode('on');
  PERFORM pg_temp.ok(r ->> 'error' = 'permission_denied', 'non-admin refused: ' || r::text);
  PERFORM set_config('request.jwt.claim.sub', '', false);
  r := public.set_web_receipts_mode('maybe');
  PERFORM pg_temp.ok(r ->> 'error' = 'invalid_mode', 'invalid mode refused');
END $t$;

-- Completed while OFF: never gets a receipt.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel, web_reference)
VALUES ('00000000-0000-0000-0000-000000000101', '900101', '00000000-0000-0000-0000-0000000000c1', 'JPY', 50000, 50000, 'web', 'CJ-W-900101');
BEGIN;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-000000000101', 50000, 'JPY', 'transfer');
UPDATE public.cash_orders SET total_paid = 50000, remaining_balance = 0, status = 'completed', completed_at = now()
 WHERE id = '00000000-0000-0000-0000-000000000101';
COMMIT;
DO $t$ BEGIN
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.website_receipts), 'no receipt while off');
END $t$;

-- Turn it ON (SQL Editor path: no user, session_user postgres). Audited.
DO $t$ DECLARE r jsonb; BEGIN
  r := public.set_web_receipts_mode('on');
  PERFORM pg_temp.ok(r ->> 'mode' = 'on' AND (r ->> 'changed')::boolean, 'switched on: ' || r::text);
  PERFORM pg_temp.ok(public.web_receipts_live_at() IS NOT NULL, 'live_at stamped');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'set_web_receipts_mode'), 'audited');
END $t$;
SELECT pg_sleep(0.01);

-- The order completed while off still gets nothing when it changes later.
UPDATE public.cash_orders SET shipping_fee = 0, total_amount = 50000 WHERE id = '00000000-0000-0000-0000-000000000101';
UPDATE public.cash_orders SET payment_method = 'transfer' WHERE id = '00000000-0000-0000-0000-000000000101';
DO $t$ BEGIN
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.website_receipts), 'completed-before-live never issued');
END $t$;

-- ---------------------------------------------- 1. a plain yen order, ¥100,000
-- The status is written BEFORE the payment in the same transaction: the
-- deferred trigger must still see the payment.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel, web_reference)
VALUES ('00000000-0000-0000-0000-000000000201', '900201', '00000000-0000-0000-0000-0000000000c1', 'JPY', 100000, 100000, 'web', 'CJ-W-900201');
INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy)
VALUES ('00000000-0000-0000-0000-000000000201', 'K18 ring', 1, 100000, 100000);
BEGIN;
UPDATE public.cash_orders SET total_paid = 100000, remaining_balance = 0, status = 'completed', completed_at = now()
 WHERE id = '00000000-0000-0000-0000-000000000201';
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-000000000201', 100000, 'JPY', 'transfer');
COMMIT;
DO $t$ DECLARE r public.website_receipts; BEGIN
  r := pg_temp.issued('00000000-0000-0000-0000-000000000201');
  PERFORM pg_temp.ok(r.id IS NOT NULL, 'issued for the yen order');
  PERFORM pg_temp.ok(r.receipt_number ~ ('^CJR-' || to_char(now() AT TIME ZONE 'Asia/Tokyo', 'YYYY') || '-[0-9]{6}$'), 'number format ' || r.receipt_number);
  PERFORM pg_temp.ok(r.verify_code ~ '^[0-9a-f]{40}$', 'verify code 40 hex');
  PERFORM pg_temp.ok(r.total_paid = 100000 AND r.taxable_total = 100000, 'total 100000');
  PERFORM pg_temp.ok(r.tax_amount = 9091 AND r.subtotal = 90909, 'subtotal 90909 + tax 9091, got ' || r.subtotal || ' + ' || r.tax_amount);
  PERFORM pg_temp.ok(r.order_number = 'CJ-W-900201', 'order number is the web reference');
  PERFORM pg_temp.ok(r.purpose = 'お品代として' AND r.addressee IS NULL, 'defaults');
  PERFORM pg_temp.ok(jsonb_array_length(r.lines -> 'items') = 1, 'one item line');
END $t$;

-- A no-op update keeps the same receipt.
UPDATE public.cash_orders SET payment_method = 'square' WHERE id = '00000000-0000-0000-0000-000000000201';
UPDATE public.cash_orders SET refund_status = 'no_refund' WHERE id = '00000000-0000-0000-0000-000000000201';
UPDATE public.cash_orders SET refund_status = NULL WHERE id = '00000000-0000-0000-0000-000000000201';
DO $t$ BEGIN
  PERFORM pg_temp.ok(public.web_receipt_sync('cash', '00000000-0000-0000-0000-000000000201') ->> 'action' = 'kept', 'sync is idempotent');
END $t$;
DO $t$ BEGIN
  PERFORM pg_temp.ok((SELECT count(*) FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000201') = 1,
                     'no new receipt when nothing on the receipt changed');
END $t$;

-- A Hub order never gets one.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel)
VALUES ('00000000-0000-0000-0000-000000000301', '19500', '00000000-0000-0000-0000-0000000000c1', 'JPY', 20000, 20000, 'hub_manual');
BEGIN;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-000000000301', 20000, 'JPY', 'cash');
UPDATE public.cash_orders SET total_paid = 20000, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000301';
COMMIT;
DO $t$ BEGIN
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000301'), 'hub order: none');
END $t$;

-- A TEST- order gets none while mode = on.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel, web_reference, is_test)
VALUES ('00000000-0000-0000-0000-000000000401', 'TEST-900401', '00000000-0000-0000-0000-0000000000c9', 'JPY', 11000, 11000, 'web', 'CJ-W-900401', true);
BEGIN;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-000000000401', 11000, 'JPY', 'transfer');
UPDATE public.cash_orders SET total_paid = 11000, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000401';
COMMIT;
DO $t$ BEGIN
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000401'), 'TEST order: none while on');
END $t$;

-- ------------------- 2. coupon, points, shipping, COD fee (owner example set)
-- pieces 98,000 − discount 5,000 + shipping 800 + COD fee 1,150 = 94,950
-- points 3,000 (LOYALTY-), courier 91,950 → received 91,950
-- block: subtotal 89,091 + tax 8,909 − discount 8,000 + shipping 800 + COD 1,150 = 91,950
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel, web_reference,
                                shipping_fee, discount_amount, cod_fee, coupon_code, payment_method)
VALUES ('00000000-0000-0000-0000-000000000501', '900501', '00000000-0000-0000-0000-0000000000c1', 'JPY', 94950, 94950, 'web', 'CJ-W-900501',
        800, 5000, 1150, 'WELCOME', 'cod');
INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy) VALUES
  ('00000000-0000-0000-0000-000000000501', 'Necklace', 1, 60000, 60000),
  ('00000000-0000-0000-0000-000000000501', 'Earrings', 2, 19000, 38000);
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, reference_number)
VALUES ('00000000-0000-0000-0000-000000000501', 3000, 'JPY', 'loyalty_redemption', 'LOYALTY-abc');
UPDATE public.cash_orders SET total_paid = 3000, remaining_balance = 91950 WHERE id = '00000000-0000-0000-0000-000000000501';
BEGIN;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-000000000501', 91950, 'JPY', 'cod');
UPDATE public.cash_orders SET total_paid = 94950, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000501';
COMMIT;
DO $t$ DECLARE r public.website_receipts; BEGIN
  r := pg_temp.issued('00000000-0000-0000-0000-000000000501');
  PERFORM pg_temp.ok(r.id IS NOT NULL, 'issued for the COD order');
  PERFORM pg_temp.ok((r.lines ->> 'goods_total')::numeric = 98000, 'goods 98000');
  PERFORM pg_temp.ok((r.lines ->> 'discount')::numeric = 5000 AND r.lines ->> 'coupon_code' = 'WELCOME', 'discount + coupon label');
  PERFORM pg_temp.ok((r.lines ->> 'points')::numeric = 3000, 'points 3000');
  PERFORM pg_temp.ok((r.lines ->> 'shipping')::numeric = 800 AND (r.lines ->> 'cod_fee')::numeric = 1150, 'shipping + cod');
  PERFORM pg_temp.ok(r.total_paid = 91950 AND r.taxable_total = 98000 AND r.tax_amount = 8909 AND r.subtotal = 89091, 'block ' || r.total_paid || '/' || r.tax_amount || '/' || r.subtotal);
  PERFORM pg_temp.ok((r.lines ->> 'discount_total')::numeric = 8000 AND (r.lines ->> 'adds_up')::boolean, 'discount = coupon + points; adds up');
  PERFORM pg_temp.ok(jsonb_array_length(r.lines -> 'payments') = 1 AND r.lines -> 'payments' -> 0 ->> 'method' = 'cod', 'points are not a payment line');
END $t$;

-- ------------------------------ 3. store credit is a payment line, not a discount
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel, web_reference)
VALUES ('00000000-0000-0000-0000-000000000601', '900601', '00000000-0000-0000-0000-0000000000c2', 'JPY', 30000, 30000, 'web', 'CJ-W-900601');
INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy)
VALUES ('00000000-0000-0000-0000-000000000601', 'Ring', 1, 30000, 30000);
BEGIN;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, reference_number) VALUES
  ('00000000-0000-0000-0000-000000000601', 10000, 'JPY', 'store_credit', 'SC-1'),
  ('00000000-0000-0000-0000-000000000601', 20000, 'JPY', 'transfer', NULL);
UPDATE public.cash_orders SET total_paid = 30000, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000601';
COMMIT;
DO $t$ DECLARE r public.website_receipts; BEGIN
  r := pg_temp.issued('00000000-0000-0000-0000-000000000601');
  PERFORM pg_temp.ok(r.total_paid = 30000 AND (r.lines ->> 'store_credit')::numeric = 10000, 'store credit counted as money');
  PERFORM pg_temp.ok(r.tax_amount = 2727 AND r.subtotal = 27273, 'tax on 30000 = 2727');
END $t$;

-- ------------------------------ 4. leaves completed → cancelled; back → NEW number
DO $t$ DECLARE v_first text; BEGIN
  SELECT receipt_number INTO v_first FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000601';
  PERFORM set_config('t.first', v_first, false);
END $t$;
BEGIN;
UPDATE public.cash_payments SET voided_at = now() WHERE cash_order_id = '00000000-0000-0000-0000-000000000601' AND payment_method = 'transfer';
UPDATE public.cash_orders SET total_paid = 10000, remaining_balance = 20000, status = 'pending', completed_at = NULL WHERE id = '00000000-0000-0000-0000-000000000601';
COMMIT;
DO $t$ BEGIN
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000601')).id IS NULL, 'no issued after void');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.website_receipts WHERE receipt_number = current_setting('t.first')
                              AND status = 'cancelled' AND cancel_reason = 'not_completed' AND cancelled_at IS NOT NULL), 'cancelled not_completed');
END $t$;
BEGIN;
UPDATE public.cash_payments SET voided_at = NULL WHERE cash_order_id = '00000000-0000-0000-0000-000000000601';
UPDATE public.cash_orders SET total_paid = 30000, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000601';
COMMIT;
DO $t$ DECLARE r public.website_receipts; BEGIN
  r := pg_temp.issued('00000000-0000-0000-0000-000000000601');
  PERFORM pg_temp.ok(r.id IS NOT NULL AND r.receipt_number <> current_setting('t.first'), 'restored → NEW number');
END $t$;

-- ------------------------------ 5. figures change while completed → cancel + new
DO $t$ BEGIN
  PERFORM set_config('t.first', (pg_temp.issued('00000000-0000-0000-0000-000000000501')).receipt_number, false);
END $t$;
BEGIN;
UPDATE public.cash_orders SET shipping_fee = 700, total_amount = 94850, total_paid = 94850 WHERE id = '00000000-0000-0000-0000-000000000501';
UPDATE public.cash_payments SET amount_paid = 91850 WHERE cash_order_id = '00000000-0000-0000-0000-000000000501' AND payment_method = 'cod';
COMMIT;
DO $t$ DECLARE r public.website_receipts; BEGIN
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.website_receipts WHERE receipt_number = current_setting('t.first')
                              AND status = 'cancelled' AND cancel_reason IN ('figures_changed', 'not_fully_paid')), 'old one cancelled with a reason');
  r := pg_temp.issued('00000000-0000-0000-0000-000000000501');
  PERFORM pg_temp.ok(r.id IS NOT NULL AND (r.lines ->> 'shipping')::numeric = 700 AND r.total_paid = 91850, 'new receipt with new figures');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000501' AND status = 'issued') = 1,
                     'at most one issued');
END $t$;

-- ------------------------------ 6. owner changed → cancelled + new for the new owner
DO $t$ BEGIN
  PERFORM set_config('t.first', (pg_temp.issued('00000000-0000-0000-0000-000000000201')).receipt_number, false);
END $t$;
UPDATE public.cash_orders SET customer_id = '00000000-0000-0000-0000-0000000000c2' WHERE id = '00000000-0000-0000-0000-000000000201';
DO $t$ DECLARE r public.website_receipts; BEGIN
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.website_receipts WHERE receipt_number = current_setting('t.first')
                              AND status = 'cancelled' AND cancel_reason = 'owner_changed'), 'owner_changed');
  r := pg_temp.issued('00000000-0000-0000-0000-000000000201');
  PERFORM pg_temp.ok(r.customer_id = '00000000-0000-0000-0000-0000000000c2', 'new receipt for the new owner');
END $t$;

-- ------------------------------ 7. Square refund → cancelled, no new one
INSERT INTO public.square_refunds (cash_order_id, amount_jpy, status) VALUES ('00000000-0000-0000-0000-000000000201', 100000, 'PENDING');
DO $t$ BEGIN
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000201')).id IS NOT NULL, 'a PENDING refund changes nothing');
END $t$;
UPDATE public.square_refunds SET status = 'COMPLETED' WHERE cash_order_id = '00000000-0000-0000-0000-000000000201';
DO $t$ BEGIN
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000201')).id IS NULL, 'refunded: no issued receipt');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000201'
                              AND status = 'cancelled' AND cancel_reason = 'refunded'), 'cancelled refunded');
END $t$;

-- ------------------------------ 8. Paidy refund and an open dispute
INSERT INTO public.paidy_refunds (cash_order_id, refund_id, amount_jpy) VALUES ('00000000-0000-0000-0000-000000000601', 'ref_1', 1000);
INSERT INTO public.square_disputes (cash_order_id, amount_jpy, state) VALUES ('00000000-0000-0000-0000-000000000501', 5000, 'EVIDENCE_REQUIRED');
DO $t$ BEGIN
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000601'
                              AND status = 'cancelled' AND cancel_reason = 'refunded'), 'paidy refund cancels');
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000501')).id IS NULL
                     AND EXISTS (SELECT 1 FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000501'
                                  AND cancel_reason = 'disputed'), 'open dispute cancels');
END $t$;
UPDATE public.square_disputes SET state = 'WON' WHERE cash_order_id = '00000000-0000-0000-0000-000000000501';
DO $t$ BEGIN
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000501')).id IS NOT NULL, 'dispute WON: fully paid again, new number');
END $t$;

-- ------------------------------ 9. yen web layaway with a late fee
-- item ¥100,000 → unit excl. tax round(100000/1.1) = 90,909; tax 9,091;
-- late fee ¥1,000 (paid, not waived); payments ¥101,000 → total ¥101,000
INSERT INTO public.layaway_accounts (id, customer_id, invoice_number, currency, total_amount, remaining_balance, source_channel, web_reference)
VALUES ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-0000000000c1', '900701', 'JPY', 100000, 100000, 'web', 'CJ-W-900701');
INSERT INTO public.layaway_account_items (account_id, title, quantity, unit_price_jpy, line_total_jpy)
VALUES ('00000000-0000-0000-0000-000000000701', 'Bracelet', 1, 100000, 100000);
INSERT INTO public.penalty_fees (account_id, currency, penalty_amount, status) VALUES ('00000000-0000-0000-0000-000000000701', 'JPY', 1000, 'paid');
BEGIN;
INSERT INTO public.payments (account_id, amount_paid, currency, payment_method, reference_number) VALUES
  ('00000000-0000-0000-0000-000000000701', 30000, 'JPY', 'transfer', 'DP-1'),
  ('00000000-0000-0000-0000-000000000701', 71000, 'JPY', 'transfer', NULL);
UPDATE public.layaway_accounts SET total_paid = 101000, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000701';
COMMIT;
DO $t$ DECLARE r public.website_receipts; BEGIN
  r := pg_temp.issued('00000000-0000-0000-0000-000000000701');
  PERFORM pg_temp.ok(r.id IS NOT NULL AND r.currency = 'JPY', 'layaway issued');
  PERFORM pg_temp.ok(r.total_paid = 101000 AND r.penalty_total = 1000 AND r.taxable_total = 100000, 'layaway totals');
  PERFORM pg_temp.ok(r.subtotal = 90909 AND r.tax_amount = 9091, 'late fee outside the 10%: ' || r.subtotal || ' + ' || r.tax_amount);
  PERFORM pg_temp.ok((r.lines -> 'items' -> 0 ->> 'unit_price_ex')::numeric = 90909, 'item shown excl. tax');
END $t$;

-- ------------------------------ 9a. peso orders (owner option a)
-- Item lines are yen only; each line is converted once at fx_rate_used and the
-- rounding remainder goes on the largest quantity-1 line.
INSERT INTO public.layaway_accounts (id, customer_id, invoice_number, currency, total_amount, remaining_balance, source_channel, web_reference, fx_rate_used)
VALUES ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-0000000000c2', '900702', 'PHP', 42000, 42000, 'web', 'CJ-W-900702', 0.42);
INSERT INTO public.layaway_account_items (account_id, title, quantity, unit_price_jpy, line_total_jpy) VALUES
  ('00000000-0000-0000-0000-000000000702', 'Bracelet', 1, 60000, 60000), ('00000000-0000-0000-0000-000000000702', 'Ring', 1, 40000, 40000);
BEGIN;
INSERT INTO public.payments (account_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-000000000702', 42000, 'PHP', 'bdo');
UPDATE public.layaway_accounts SET total_paid = 42000, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000702';
COMMIT;
DO $t$ DECLARE r public.website_receipts; BEGIN
  r := pg_temp.issued('00000000-0000-0000-0000-000000000702');
  PERFORM pg_temp.ok(r.id IS NOT NULL AND r.currency = 'PHP', 'peso: issued');
  PERFORM pg_temp.ok((SELECT (e ->> 'line_total')::numeric FROM jsonb_array_elements(r.lines -> 'items') e WHERE e ->> 'title' = 'Bracelet') = 25200 AND (SELECT (e ->> 'line_total')::numeric FROM jsonb_array_elements(r.lines -> 'items') e WHERE e ->> 'title' = 'Ring') = 16800, 'peso lines 25,200 + 16,800');
  PERFORM pg_temp.ok((SELECT (e ->> 'unit_price_ex')::numeric FROM jsonb_array_elements(r.lines -> 'items') e WHERE e ->> 'title' = 'Bracelet') = 22909 AND (SELECT (e ->> 'unit_price_ex')::numeric FROM jsonb_array_elements(r.lines -> 'items') e WHERE e ->> 'title' = 'Ring') = 15273, 'peso lines excl. tax');
  PERFORM pg_temp.ok(r.subtotal = 38182 AND r.tax_amount = 3818 AND r.total_paid = 42000, 'peso block: ' || r.subtotal || ' + ' || r.tax_amount);
END $t$;

-- peso remainder: ¥19,000 × 2 + ¥30,000 at 0.308345; checkout total ₱20,967
-- (Σ unit-converted lines would be 20,968 → −1 on the ¥30,000 line).
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel, web_reference, fx_rate_used)
VALUES ('00000000-0000-0000-0000-000000000703', '900703', '00000000-0000-0000-0000-0000000000c2', 'PHP', 20967, 20967, 'web', 'CJ-W-900703', 0.308345);
INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy) VALUES
  ('00000000-0000-0000-0000-000000000703', 'Earrings', 2, 19000, 38000), ('00000000-0000-0000-0000-000000000703', 'Pendant', 1, 30000, 30000);
BEGIN;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-000000000703', 20967, 'PHP', 'gcash');
UPDATE public.cash_orders SET total_paid = 20967, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000703';
COMMIT;
DO $t$ DECLARE r public.website_receipts; BEGIN
  r := pg_temp.issued('00000000-0000-0000-0000-000000000703');
  PERFORM pg_temp.ok(r.id IS NOT NULL, 'peso remainder: issued');
  PERFORM pg_temp.ok((SELECT (e ->> 'unit_price')::numeric FROM jsonb_array_elements(r.lines -> 'items') e WHERE e ->> 'title' = 'Earrings') = 5859 AND (SELECT (e ->> 'line_total')::numeric FROM jsonb_array_elements(r.lines -> 'items') e WHERE e ->> 'title' = 'Earrings') = 11718, 'qty-2 line untouched');
  PERFORM pg_temp.ok((SELECT (e ->> 'unit_price')::numeric FROM jsonb_array_elements(r.lines -> 'items') e WHERE e ->> 'title' = 'Pendant') = 9249, 'remainder on the qty-1 line');
  PERFORM pg_temp.ok(r.subtotal + r.tax_amount = 20967 AND r.total_paid = 20967, 'peso remainder adds up');
END $t$;

-- ------------------------------ 9b. item lines that do not add up: never issued
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel, web_reference)
VALUES ('00000000-0000-0000-0000-000000000751', '900751', '00000000-0000-0000-0000-0000000000c2', 'JPY', 50000, 50000, 'web', 'CJ-W-900751');
INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy)
VALUES ('00000000-0000-0000-0000-000000000751', 'Edited at Confirm', 1, 45000, 45000);
BEGIN;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES ('00000000-0000-0000-0000-000000000751', 50000, 'JPY', 'transfer');
UPDATE public.cash_orders SET total_paid = 50000, remaining_balance = 0, status = 'completed', completed_at = now() WHERE id = '00000000-0000-0000-0000-000000000751';
COMMIT;
DO $t$ BEGIN
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.website_receipts WHERE cash_order_id = '00000000-0000-0000-0000-000000000751'), 'lines ≠ total: not issued');
  PERFORM pg_temp.ok(public.web_receipt_sync('cash', '00000000-0000-0000-0000-000000000751') ->> 'not_issued' = 'does_not_add_up', 'reason reported');
  PERFORM public.web_receipt_sync('cash', '00000000-0000-0000-0000-000000000751');
  PERFORM pg_temp.ok((SELECT count(*) FROM public.staff_notifications
                       WHERE type = 'website_receipt_not_issued'
                         AND metadata ->> 'order_id' = '00000000-0000-0000-0000-000000000751'
                         AND metadata ->> 'reason' = 'block_mismatch'
                         AND metadata ->> 'cash_order_id' = '00000000-0000-0000-0000-000000000751') = 1,
                     'staff told once, not on every sync');
END $t$;

-- ------------------------------ 10. mode = test: TEST orders only
DO $t$ DECLARE r jsonb; BEGIN
  r := public.set_web_receipts_mode('test');
  PERFORM pg_temp.ok(r ->> 'mode' = 'test', 'switched to test');
END $t$;
SELECT pg_sleep(0.01);
INSERT INTO public.cash_orders (id, invoice_number, customer_id, currency, total_amount, remaining_balance, source_channel, web_reference, is_test)
VALUES ('00000000-0000-0000-0000-000000000801', 'TEST-900801', '00000000-0000-0000-0000-0000000000c9', 'JPY', 1100, 1100, 'web', 'CJ-W-900801', true),
       ('00000000-0000-0000-0000-000000000802', '900802', '00000000-0000-0000-0000-0000000000c1', 'JPY', 2200, 2200, 'web', 'CJ-W-900802', false);
INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy) VALUES
  ('00000000-0000-0000-0000-000000000801', 'Test piece', 1, 1100, 1100), ('00000000-0000-0000-0000-000000000802', 'Piece', 1, 2200, 2200);
BEGIN;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES
  ('00000000-0000-0000-0000-000000000801', 1100, 'JPY', 'transfer'), ('00000000-0000-0000-0000-000000000802', 2200, 'JPY', 'transfer');
UPDATE public.cash_orders SET total_paid = total_amount, remaining_balance = 0, status = 'completed', completed_at = now()
 WHERE id IN ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802');
COMMIT;
DO $t$ BEGIN
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000801')).tax_amount = 100, 'TEST order issued in test mode, tax 100');
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000802')).id IS NULL, 'real order not issued in test mode');
END $t$;

-- ------------------------------ 11. downloads, reissue flag, details, verify
DO $t$ DECLARE r jsonb; v_id uuid; v_code text; BEGIN
  SELECT id, verify_code INTO v_id, v_code FROM public.website_receipts WHERE layaway_account_id = '00000000-0000-0000-0000-000000000701' AND status = 'issued';
  r := public.record_website_receipt_issue(v_id, '00000000-0000-0000-0000-0000000000c2', 'ja');
  PERFORM pg_temp.ok(r ->> 'error' = 'not_found', 'another customer cannot download');
  r := public.record_website_receipt_issue(v_id, '00000000-0000-0000-0000-0000000000c1', 'ja');
  PERFORM pg_temp.ok((r ->> 'issue_no')::int = 1 AND NOT (r ->> 'is_reissue')::boolean, 'first download is the original');
  r := public.record_website_receipt_issue(v_id, '00000000-0000-0000-0000-0000000000c1', 'en');
  PERFORM pg_temp.ok((r ->> 'issue_no')::int = 2 AND (r ->> 'is_reissue')::boolean AND r ->> 'language' = 'en', 'second is a reissue');

  r := public.update_website_receipt_details(v_id, '00000000-0000-0000-0000-0000000000c1', '  株式会社テスト  ', '');
  PERFORM pg_temp.ok(r ->> 'addressee' = '株式会社テスト' AND r ->> 'purpose' = 'お品代として', 'trimmed; empty purpose = default');
  r := public.update_website_receipt_details(v_id, '00000000-0000-0000-0000-0000000000c1', repeat('あ', 61), 'x');
  PERFORM pg_temp.ok(r ->> 'error' = 'addressee_too_long', 'addressee limit');
  r := public.update_website_receipt_details(v_id, '00000000-0000-0000-0000-0000000000c1', 'A', repeat('x', 41));
  PERFORM pg_temp.ok(r ->> 'error' = 'purpose_too_long', 'purpose limit');
  r := public.update_website_receipt_details(v_id, '00000000-0000-0000-0000-0000000000c1', E'A\nB', 'x');
  PERFORM pg_temp.ok(r ->> 'error' = 'invalid_characters', 'control characters refused');
  r := public.record_website_receipt_issue(v_id, '00000000-0000-0000-0000-0000000000c1', 'ja');
  PERFORM pg_temp.ok(r -> 'receipt' ->> 'addressee' = '株式会社テスト', 'the PDF prints the new addressee');
  PERFORM pg_temp.ok((SELECT addressee FROM public.website_receipt_issues WHERE receipt_id = v_id AND issue_no = 3) = '株式会社テスト', 'history keeps it');

  r := public.verify_website_receipt(upper(v_code));
  PERFORM pg_temp.ok(r ->> 'status' = 'valid' AND r ->> 'currency' = 'JPY' AND (r ->> 'total')::numeric = 101000, 'verify valid');
  PERFORM pg_temp.ok((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) = ARRAY['currency', 'issued_at', 'receipt_number', 'status', 'total'], 'verify is minimal');
  PERFORM pg_temp.ok(public.verify_website_receipt('deadbeef') IS NULL, 'unknown code');
  SELECT verify_code INTO v_code FROM public.website_receipts WHERE status = 'cancelled' LIMIT 1;
  PERFORM pg_temp.ok(public.verify_website_receipt(v_code) ->> 'status' = 'cancelled', 'verify cancelled');
  SELECT id INTO v_id FROM public.website_receipts WHERE status = 'cancelled' LIMIT 1;
  PERFORM pg_temp.ok(public.record_website_receipt_issue(v_id, (SELECT customer_id FROM public.website_receipts WHERE id = v_id), 'ja') ->> 'error' = 'receipt_cancelled', 'cancelled: no download');
  PERFORM pg_temp.ok(public.update_website_receipt_details(v_id, (SELECT customer_id FROM public.website_receipts WHERE id = v_id), 'A', 'B') ->> 'error' = 'receipt_cancelled', 'cancelled: no edit');
END $t$;

-- A paid penalty waived while completed: the payments now exceed the order total
-- (an overpayment), the block no longer adds up → cancelled, and NO new receipt
-- (the owner's rule: never force a balancing line).
DO $t$ BEGIN
  PERFORM set_config('t.first', (pg_temp.issued('00000000-0000-0000-0000-000000000701')).receipt_number, false);
END $t$;
UPDATE public.penalty_fees SET status = 'waived', waived_at = now() WHERE account_id = '00000000-0000-0000-0000-000000000701';
DO $t$ BEGIN
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM public.website_receipts WHERE receipt_number = current_setting('t.first')
                              AND status = 'cancelled' AND cancel_reason = 'does_not_add_up'), 'waiver → does_not_add_up');
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000701')).id IS NULL, 'no receipt when it does not add up');
  PERFORM pg_temp.ok((public.web_receipt_snapshot('layaway', '00000000-0000-0000-0000-000000000701') ->> 'adds_up')::boolean = false, 'snapshot says so');
END $t$;

-- ------------------------------ 12. figures frozen, never deleted, history append-only
DO $t$ BEGIN
  BEGIN
    UPDATE public.website_receipts SET total_paid = 1 WHERE status = 'issued';
    RAISE EXCEPTION 'FAIL: figures edited';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF; END;
  BEGIN
    DELETE FROM public.website_receipts;
    RAISE EXCEPTION 'FAIL: deleted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF; END;
  BEGIN
    UPDATE public.website_receipts SET status = 'issued', cancelled_at = NULL, cancel_reason = NULL WHERE status = 'cancelled';
    RAISE EXCEPTION 'FAIL: un-cancelled';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF; END;
  BEGIN
    DELETE FROM public.website_receipt_issues;
    RAISE EXCEPTION 'FAIL: history deleted';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'FAIL:%' THEN RAISE; END IF; END;
END $t$;

-- ------------------------------ 13. email queue
DO $t$ DECLARE n int; v_id uuid; BEGIN
  SELECT count(*) INTO n FROM public.website_receipt_email_candidates(50);
  PERFORM pg_temp.ok(n = (SELECT count(*) FROM public.website_receipts WHERE status = 'issued'), 'every issued receipt queued');
  SELECT id INTO v_id FROM public.website_receipt_email_candidates(1);
  PERFORM public.finish_website_receipt_email(v_id, false, 'boom');
  PERFORM pg_temp.ok((SELECT email_attempts = 1 AND email_sent_at IS NULL AND email_last_error = 'boom' FROM public.website_receipts WHERE id = v_id), 'failure counted');
  PERFORM public.finish_website_receipt_email(v_id, true, NULL);
  PERFORM pg_temp.ok((SELECT email_sent_at IS NOT NULL AND email_last_error IS NULL FROM public.website_receipts WHERE id = v_id), 'sent recorded');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.website_receipt_email_candidates(50) c WHERE c.id = v_id), 'sent leaves the queue');
  PERFORM pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.website_receipt_email_candidates(50) c
                                   JOIN public.website_receipts r ON r.id = c.id WHERE r.status <> 'issued'), 'cancelled never queued');
END $t$;

-- ------------------------------ 14. off again: nothing new, existing receipts still cancel on change
DO $t$ BEGIN PERFORM public.set_web_receipts_mode('off'); END $t$;
UPDATE public.cash_orders SET status = 'cancelled' WHERE id = '00000000-0000-0000-0000-000000000801';
DO $t$ BEGIN
  PERFORM pg_temp.ok((pg_temp.issued('00000000-0000-0000-0000-000000000801')).id IS NULL, 'cancel still applies while off');
END $t$;

-- ------------------------------ 15. privileges
DO $t$ BEGIN
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.web_receipt_sync(text, uuid)', 'EXECUTE'), 'sync not callable by users');
  PERFORM pg_temp.ok(NOT has_function_privilege('authenticated', 'public.verify_website_receipt(text)', 'EXECUTE'), 'verify service only');
  PERFORM pg_temp.ok(NOT has_table_privilege('authenticated', 'public.website_receipts', 'UPDATE'), 'no user writes');
  PERFORM pg_temp.ok(EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'receipt-assets' AND NOT public), 'private bucket');
END $t$;

SELECT 'website receipts: PASSED' AS result;
