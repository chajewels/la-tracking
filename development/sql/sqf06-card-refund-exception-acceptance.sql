-- SQF06 acceptance (migration 20261129110000 + the §7 bell in 20261129100000). NOT a migration —
-- never applied to live. Runs on the local Postgres copy of live (mark_web_order_refund_issued_atomic
-- byte-identical to live before the migration), one transaction, rolled back.
-- Expected after the migrations: 18 passed, 0 failed. Before: every exception call answers bad_method.
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN EXECUTE p_sql INTO r; RETURN r; EXCEPTION WHEN others THEN RETURN jsonb_build_object('raised', SQLERRM); END $$;
CREATE FUNCTION pg_temp.mark(p_order text, p_user text, p_method text, p_exc jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.mark_web_order_refund_issued_atomic(%L, %L, %L, %L::date, NULL, %L::jsonb)',
                            p_order, p_user, p_method, (now() AT TIME ZONE 'Asia/Manila')::date, p_exc::text)) $$;

SELECT set_config('test.uid', '00000000-0000-0000-0000-00000000aaaa', false);
INSERT INTO public.customers (id, full_name, email, mobile_number) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Test Customer', 'a@example.com', '09011112222'),
  ('00000000-0000-0000-0000-0000000000c2', 'Other Customer', 'b@example.com', '09033334444');
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-00000000aaaa', 'admin'), ('00000000-0000-0000-0000-00000000bbbb', 'staff');

-- three cancelled card-paid web orders awaiting a refund decision, ¥10,000 captured each
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, refund_status, web_reference, source_channel, currency, order_date, total_amount, total_paid)
SELECT ('00000000-0000-0000-0000-0000000006a' || i)::uuid, 'T6A' || i, '00000000-0000-0000-0000-0000000000c1', 'cancelled', 'refund_pending', 'CJ-W-T6A' || i, 'web', 'JPY',
       (now() AT TIME ZONE 'Asia/Manila')::date - 10, 10000, 10000
FROM generate_series(1, 3) i;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
SELECT ('00000000-0000-0000-0000-0000000006a' || i)::uuid, 10000, 'JPY', 'square', 'sq_cap_6a' || i FROM generate_series(1, 3) i;
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, captured_at, environment) VALUES
  ('00000000-0000-0000-0000-0000000006a1', 'sq_cap_6a1', 'captured', true, 10000, now() - interval '9 days', 'sandbox'),
  ('00000000-0000-0000-0000-0000000006a2', 'sq_cap_6a2', 'captured', true, 10000, now() - interval '400 days', 'sandbox'),
  ('00000000-0000-0000-0000-0000000006a3', 'sq_cap_6a3', 'captured', true, 10000, now() - interval '9 days', 'sandbox');
-- order 1: a Square refund FAILED (¥10,000); order 2: capture 400 days old, no refund attempt; order 3: a refund PENDING only
INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status) VALUES
  ('rf_6a1_failed', (SELECT id FROM public.square_payments WHERE square_payment_id = 'sq_cap_6a1'), 'sq_cap_6a1', '00000000-0000-0000-0000-0000000006a1', 10000, 'FAILED'),
  ('rf_6a3_pending', (SELECT id FROM public.square_payments WHERE square_payment_id = 'sq_cap_6a3'), 'sq_cap_6a3', '00000000-0000-0000-0000-0000000006a3', 10000, 'PENDING');

-- 1. the old refusals still stand
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer', NULL) ->> 'detail' = 'paid_by_card',
                  'SQF06 regression: plain bank_transfer on a card-paid order is still method_mismatch (paid_by_card)');
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-00000000aaaa', 'card', NULL) ->> 'error' = 'no_completed_card_refund',
                  'SQF06 regression: method card still needs a COMPLETED Square refund');
-- 2. admin only
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-00000000bbbb', 'bank_transfer_exception',
                               '{"square_refund_id":"rf_6a1_failed","square_support_ticket":"SQ-123","amount_jpy":"10000","transfer_date":"2026-10-08","transfer_reference":"MUFG 0001"}') ->> 'error' = 'admin_only',
                  'SQF06 #2: staff (non-admin) is refused admin_only');
-- 3. evidence
SELECT pg_temp.ok((SELECT r ->> 'error' = 'exception_evidence_required' AND r ->> 'missing' = 'square_support_ticket'
                   FROM pg_temp.mark('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                                     '{"square_refund_id":"rf_6a1_failed","amount_jpy":"10000","transfer_date":"2026-10-08","transfer_reference":"MUFG 0001"}') r),
                  'SQF06 #3: no Square Support ticket → exception_evidence_required (square_support_ticket)');
SELECT pg_temp.ok((SELECT r ->> 'error' = 'exception_evidence_required' AND r ->> 'missing' = 'transfer_reference'
                   FROM pg_temp.mark('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                                     '{"square_refund_id":"rf_6a1_failed","square_support_ticket":"SQ-123","amount_jpy":"10000","transfer_date":"2026-10-08"}') r),
                  'SQF06 #4: a bank transfer needs its reference');
-- 1. trigger
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000006a3', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                               '{"square_refund_id":"rf_6a3_pending","square_support_ticket":"SQ-124","amount_jpy":"10000","transfer_date":"2026-10-08","transfer_reference":"MUFG 0002"}') ->> 'error' = 'exception_not_triggered',
                  'SQF06 #1: a PENDING refund does not open the exception (only FAILED / REJECTED)');
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000006a3', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                               '{"square_support_ticket":"SQ-124","amount_jpy":"10000","transfer_date":"2026-10-08","transfer_reference":"MUFG 0002"}') ->> 'detail' = 'no_failed_refund_and_capture_within_365_days',
                  'SQF06 #1: no refund id and a 9-day-old capture → not triggered');
-- 5. cap
SELECT pg_temp.ok((SELECT r ->> 'error' = 'exception_over_cap' AND (r ->> 'cap_jpy')::numeric = 10000
                   FROM pg_temp.mark('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                                     '{"square_refund_id":"rf_6a1_failed","square_support_ticket":"SQ-123","amount_jpy":"10001","transfer_date":"2026-10-08","transfer_reference":"MUFG 0001"}') r),
                  'SQF06 #5: ¥10,001 > cap ¥10,000 → exception_over_cap (cap computed, never typed)');
-- 6. the record (FAILED-refund trigger, bank transfer)
CREATE TEMP TABLE t_ok1 AS SELECT pg_temp.mark('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                                               '{"square_refund_id":"rf_6a1_failed","square_support_ticket":"SQ-123","amount_jpy":"10000","transfer_date":"2026-10-08","transfer_reference":"MUFG 0001"}') AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 10000 AND r ->> 'method' = 'bank_transfer_exception'
                          AND r -> 'exception' ->> 'trigger' = 'refund_failed' AND r -> 'exception' ->> 'square_support_ticket' = 'SQ-123' FROM t_ok1)
                  AND (SELECT refund_status = 'refund_issued' FROM public.cash_orders WHERE invoice_number = 'T6A1')
                  AND EXISTS (SELECT 1 FROM public.audit_logs a WHERE a.entity_id = '00000000-0000-0000-0000-0000000006a1' AND a.action = 'refund_marked_issued'
                                AND a.new_value_json ->> 'method' = 'bank_transfer_exception' AND a.new_value_json -> 'exception' ->> 'transfer_reference' = 'MUFG 0001'
                                AND (a.new_value_json -> 'exception' ->> 'cap_jpy')::numeric = 10000),
                  'SQF06 #6: FAILED refund + ticket + transfer → recorded, refund_issued, audit carries the evidence and the cap', (SELECT left(r::text, 400) FROM t_ok1));
SELECT pg_temp.ok((SELECT r ->> 'already_recorded' = 'true' FROM pg_temp.mark('00000000-0000-0000-0000-0000000006a1', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                                               '{"square_refund_id":"rf_6a1_failed","square_support_ticket":"SQ-123","amount_jpy":"10000","transfer_date":"2026-10-08","transfer_reference":"MUFG 0001"}') r),
                  'SQF06 B01 retry: the same request again answers already_recorded');
-- 1. over-age trigger, partial cap (a ¥2,000 Square refund completed years ago + ¥3,000 credit already issued)
INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status) VALUES
  ('rf_6a2_old', (SELECT id FROM public.square_payments WHERE square_payment_id = 'sq_cap_6a2'), 'sq_cap_6a2', '00000000-0000-0000-0000-0000000006a2', 2000, 'COMPLETED');
INSERT INTO public.store_credit_lots (customer_id, currency, original_amount, remaining_amount, status, source_type, source_cash_order_id, expires_at)
VALUES ('00000000-0000-0000-0000-0000000000c1', 'JPY', 3000, 3000, 'active', 'manual', '00000000-0000-0000-0000-0000000006a2', now() + interval '1 year');
CREATE TEMP TABLE t_cap AS SELECT pg_temp.mark('00000000-0000-0000-0000-0000000006a2', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                                               '{"square_support_ticket":"SQ-200","amount_jpy":"5001","transfer_date":"2026-10-08","transfer_reference":"MUFG 0003"}') AS r;
SELECT pg_temp.ok((SELECT r ->> 'error' = 'exception_over_cap' AND (r ->> 'cap_jpy')::numeric = 5000 AND (r ->> 'card_refunded_jpy')::numeric = 2000 AND (r ->> 'credit_issued_jpy')::numeric = 3000 FROM t_cap),
                  'SQF06 #5: cap = ¥10,000 captured − ¥2,000 completed refund − ¥3,000 credit = ¥5,000; ¥5,001 refused', (SELECT r::text FROM t_cap));
CREATE TEMP TABLE t_ok2 AS SELECT pg_temp.mark('00000000-0000-0000-0000-0000000006a2', '00000000-0000-0000-0000-00000000aaaa', 'bank_transfer_exception',
                                               '{"square_support_ticket":"SQ-200","amount_jpy":"5000","transfer_date":"2026-10-08","transfer_reference":"MUFG 0003"}') AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 5000 AND r -> 'exception' ->> 'trigger' = 'capture_over_365_days' FROM t_ok2),
                  'SQF06 #1/#5: a 400-day-old capture opens the path without a refund id; exactly the cap records', (SELECT left(r::text, 300) FROM t_ok2));
-- 4. store credit on written request: the lot must be the customer's, JPY, exactly the amount, not tied to an order
UPDATE public.cash_orders SET refund_status = 'refund_pending' WHERE invoice_number = 'T6A3';
INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status) VALUES
  ('rf_6a3_rejected', (SELECT id FROM public.square_payments WHERE square_payment_id = 'sq_cap_6a3'), 'sq_cap_6a3', '00000000-0000-0000-0000-0000000006a3', 10000, 'REJECTED');
INSERT INTO public.store_credit_lots (id, customer_id, currency, original_amount, remaining_amount, status, source_type, expires_at) VALUES
  ('00000000-0000-0000-0000-0000000010a1', '00000000-0000-0000-0000-0000000000c1', 'JPY', 10000, 10000, 'active', 'manual', now() + interval '1 year'),
  ('00000000-0000-0000-0000-0000000010a2', '00000000-0000-0000-0000-0000000000c2', 'JPY', 10000, 10000, 'active', 'manual', now() + interval '1 year'),
  ('00000000-0000-0000-0000-0000000010a3', '00000000-0000-0000-0000-0000000000c1', 'JPY',  9000,  9000, 'active', 'manual', now() + interval '1 year');
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000006a3', '00000000-0000-0000-0000-00000000aaaa', 'store_credit_exception',
                               '{"square_refund_id":"rf_6a3_rejected","square_support_ticket":"SQ-300","amount_jpy":"10000","store_credit_lot_id":"00000000-0000-0000-0000-0000000010a1"}') ->> 'missing' = 'customer_request',
                  'SQF06 #4: store credit needs the customer''s written request');
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000006a3', '00000000-0000-0000-0000-00000000aaaa', 'store_credit_exception',
                               '{"square_refund_id":"rf_6a3_rejected","square_support_ticket":"SQ-300","amount_jpy":"10000","customer_request":"email 2026-10-07","store_credit_lot_id":"00000000-0000-0000-0000-0000000010a2"}') ->> 'detail' = 'lot_not_this_customer',
                  'SQF06 #4: another customer''s lot is refused');
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000006a3', '00000000-0000-0000-0000-00000000aaaa', 'store_credit_exception',
                               '{"square_refund_id":"rf_6a3_rejected","square_support_ticket":"SQ-300","amount_jpy":"10000","customer_request":"email 2026-10-07","store_credit_lot_id":"00000000-0000-0000-0000-0000000010a3"}') ->> 'detail' = 'lot_amount_differs',
                  'SQF06 #4: a lot of a different amount is refused');
CREATE TEMP TABLE t_ok3 AS SELECT pg_temp.mark('00000000-0000-0000-0000-0000000006a3', '00000000-0000-0000-0000-00000000aaaa', 'store_credit_exception',
                                               '{"square_refund_id":"rf_6a3_rejected","square_support_ticket":"SQ-300","amount_jpy":"10000","customer_request":"email 2026-10-07","store_credit_lot_id":"00000000-0000-0000-0000-0000000010a1"}') AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND r -> 'exception' ->> 'payout' = 'store_credit' AND r -> 'exception' ->> 'trigger' = 'refund_rejected' FROM t_ok3),
                  'SQF06 #4: REJECTED refund + ticket + written request + the customer''s own ¥10,000 lot → recorded as store_credit_exception', (SELECT left(r::text, 300) FROM t_ok3));
-- 7. a Square refund that completes AFTER the exception rings the bell once
SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_6a1_late', 'sq_cap_6a1', 'COMPLETED', 10000, NULL, now(), now(), '{"amount_money":{"amount":10000,"currency":"JPY"}}'::jsonb)$q$);
SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_6a1_late', 'sq_cap_6a1', 'COMPLETED', 10000, NULL, now(), now() + interval '1 minute', '{"amount_money":{"amount":10000,"currency":"JPY"}}'::jsonb)$q$);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_refund_after_exception' AND metadata ->> 'refund_id' = 'rf_6a1_late'),
                  'SQF06 #7: a Square refund completing after the bank-transfer exception rings card_refund_after_exception once');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.staff_notifications WHERE type = 'card_refund_after_exception' AND metadata ->> 'refund_id' = 'rf_6a2_old'),
                  'SQF06 #7: a refund recorded BEFORE the exception (the ¥2,000 in the cap) rings nothing');

SELECT format('%s passed, %s failed', count(*) FILTER (WHERE pass), count(*) FILTER (WHERE NOT pass)) AS result FROM t_results;
SELECT n, name, detail FROM t_results WHERE NOT pass ORDER BY n;
ROLLBACK;
