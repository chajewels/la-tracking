-- SQV01–SQV04 + D-G04 acceptance (migration 20261130110000). NOT a migration — never applied to
-- live. Runs on the local Postgres copy of live (every patched function byte-identical to live
-- before the migration: md5s in the migration's guards), one transaction, rolled back.
-- The concurrent cases (two orders racing for one lot, two approvers, void racing allocation)
-- are development/sql/sqv-concurrency.sh — two real sessions.
-- Expected after the migration: 54 passed, 0 failed.
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
GRANT ALL ON t_results TO PUBLIC;
GRANT USAGE ON SEQUENCE t_results_n_seq TO PUBLIC;
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN EXECUTE p_sql INTO r; RETURN r; EXCEPTION WHEN others THEN RETURN jsonb_build_object('raised', SQLERRM); END $$;

-- people: admin (= the local auth.uid()), staff
INSERT INTO public.user_roles (user_id, role) VALUES
  ('84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'admin'), ('00000000-0000-0000-0000-00000000bbbb', 'staff');
CREATE FUNCTION pg_temp.admin() RETURNS uuid LANGUAGE sql AS $$ SELECT '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457'::uuid $$;
INSERT INTO public.customers (id, full_name, email, mobile_number, customer_code, is_test) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Card Customer', 'c1@example.com', '09011112222', 'CJ-2026-90001', false),
  ('00000000-0000-0000-0000-0000000000c2', 'Other Customer', 'c2@example.com', '09033334444', 'CJ-2026-90002', false),
  ('00000000-0000-0000-0000-0000000000c3', 'Test Customer', 'c3@example.com', '09055556666', 'CJ-2026-90003', true);

-- ten cancelled, card-paid web orders awaiting a refund decision, ¥10,000 captured each
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, refund_status, web_reference, source_channel, currency,
                                order_date, total_amount, total_paid, cancelled_at)
SELECT ('00000000-0000-0000-0000-00000000e0' || lpad(i::text, 2, '0'))::uuid, 'TE' || i, '00000000-0000-0000-0000-0000000000c1',
       'cancelled', 'refund_pending', 'CJ-W-TE' || i, 'web', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 10, 10000, 10000,
       now() - interval '2 days'
FROM generate_series(1, 10) i;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
SELECT ('00000000-0000-0000-0000-00000000e0' || lpad(i::text, 2, '0'))::uuid, 10000, 'JPY', 'square', 'sq_e' || i FROM generate_series(1, 10) i;
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, authorized_at, captured_at, environment)
SELECT ('00000000-0000-0000-0000-00000000e0' || lpad(i::text, 2, '0'))::uuid, 'sq_e' || i, 'captured', true, 10000,
       now() - interval '9 days', now() - interval '8 days', 'sandbox'
FROM generate_series(1, 10) i;
CREATE FUNCTION pg_temp.o(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000e0' || lpad(i::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.refund(i int, rid text, st text, amt bigint DEFAULT 10000) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  SELECT rid, sp.id, sp.square_payment_id, sp.cash_order_id, amt, st FROM public.square_payments sp WHERE sp.square_payment_id = 'sq_e' || i $$;
CREATE FUNCTION pg_temp.approve(i int, payout text, rid text, ticket text, amt bigint, who uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.approve_card_refund_exception_atomic(%L, %L, %L, %L, %L, %s, NULL)',
                            pg_temp.o(i), coalesce(who, pg_temp.admin()), payout, rid, ticket, amt)) $$;
CREATE FUNCTION pg_temp.record(i int, method text, exc jsonb, who uuid DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.mark_web_order_refund_issued_atomic(%L, %L, %L, %L::date, NULL, %L::jsonb)',
                            pg_temp.o(i), coalesce(who, pg_temp.admin()), method, (now() AT TIME ZONE 'Asia/Manila')::date, exc::text)) $$;
CREATE FUNCTION pg_temp.today() RETURNS text LANGUAGE sql AS $$ SELECT ((now() AT TIME ZONE 'Asia/Manila')::date)::text $$;

-- =========================================================== SQV01
SELECT pg_temp.ok(NOT has_function_privilege('authenticated', 'public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', 'EXECUTE')
              AND has_function_privilege('service_role', 'public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', 'EXECUTE'),
                  'SQV01 the refund writer is service_role only (authenticated has no EXECUTE)');
SELECT pg_temp.refund(1, 'rf_e1_failed', 'FAILED');
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-00000000bbbb', 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE t_sqv01 AS SELECT pg_temp.try(format('SELECT public.mark_web_order_refund_issued_atomic(%L, %L, %L, %L::date, NULL, %L::jsonb)',
       '00000000-0000-0000-0000-00000000e001', '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'bank_transfer_exception', pg_temp.today(),
       '{"transfer_date":"2026-10-08","transfer_reference":"X"}')) AS r;
CREATE TEMP TABLE t_sqv01b AS SELECT pg_temp.try(format('SELECT public.approve_card_refund_exception_atomic(%L, %L, %L, %L, %L, 10000, NULL)',
       '00000000-0000-0000-0000-00000000e001', '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'bank_transfer', 'rf_e1_failed', 'T')) AS r;
RESET ROLE;
SELECT pg_temp.ok((SELECT r ->> 'raised' ILIKE '%permission denied%' FROM t_sqv01),
                  'SQV01 a signed-in staff caller passing an ADMIN uuid to the refund writer directly is refused (permission denied)', (SELECT r::text FROM t_sqv01));
SELECT pg_temp.ok((SELECT r ->> 'raised' ILIKE '%permission denied%' FROM t_sqv01b),
                  'SQV01 … and to the approve function too', (SELECT r::text FROM t_sqv01b));
SELECT pg_temp.ok((SELECT refund_status = 'refund_pending' FROM public.cash_orders WHERE id = pg_temp.o(1)),
                  'SQV01 nothing changed on the order');

-- =========================================================== approve (step 1)
SELECT pg_temp.ok(pg_temp.approve(1, 'bank_transfer', 'rf_e1_failed', 'SQ-1', 10000, '00000000-0000-0000-0000-00000000bbbb') ->> 'error' = 'admin_only',
                  'approve: staff (not admin) refused');
SELECT pg_temp.ok(pg_temp.approve(1, 'bank_transfer', 'rf_e1_failed', '  ', 10000) ->> 'missing' = 'square_support_ticket',
                  'approve: no Square Support ticket refused');
SELECT pg_temp.ok(pg_temp.approve(1, 'cash', 'rf_e1_failed', 'SQ-1', 10000) ->> 'error' = 'bad_payout',
                  'approve: payout other than bank transfer / store credit refused (never cash, never another card)');
SELECT pg_temp.ok((SELECT r ->> 'error' = 'exception_over_cap' AND (r ->> 'cap_jpy')::bigint = 10000 FROM (SELECT pg_temp.approve(1, 'bank_transfer', 'rf_e1_failed', 'SQ-1', 10001) AS r) x),
                  'approve: ¥10,001 > cap ¥10,000 refused');
SELECT pg_temp.ok(pg_temp.record(1, 'bank_transfer_exception', '{"transfer_date":"2026-10-08","transfer_reference":"X"}') ->> 'error' = 'exception_not_approved',
                  'record without an approval refused (pay only after approval)');
CREATE TEMP TABLE t_ap1 AS SELECT pg_temp.approve(1, 'bank_transfer', 'rf_e1_failed', 'SQ-1', 10000) AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND r -> 'exception' ->> 'status' = 'approved' AND r -> 'exception' ->> 'trigger_kind' = 'refund_failed' FROM t_ap1)
              AND EXISTS (SELECT 1 FROM public.staff_notifications WHERE type = 'card_refund_exception_approved' AND metadata ->> 'cash_order_id' = pg_temp.o(1)::text),
                  'approve: FAILED refund + ticket → approved, amount reserved, bell to pay it', (SELECT left(r::text, 300) FROM t_ap1));
SELECT pg_temp.ok(pg_temp.approve(1, 'bank_transfer', 'rf_e1_failed', 'SQ-1', 10000) ->> 'error' = 'exception_exists',
                  'approve: a second approval on the same order refused');
SELECT pg_temp.ok(pg_temp.record(1, 'store_credit_exception', '{}') ->> 'error' = 'exception_payout_mismatch',
                  'record: payout must match the approval');
SELECT pg_temp.ok(pg_temp.record(1, 'bank_transfer_exception', jsonb_build_object('transfer_date', pg_temp.today())) ->> 'missing' = 'transfer_reference',
                  'record: bank transfer needs its reference');
SELECT pg_temp.ok(pg_temp.record(1, 'bank_transfer_exception', jsonb_build_object('transfer_date', ((now() AT TIME ZONE 'Asia/Manila')::date - 5)::text, 'transfer_reference', 'X')) ->> 'detail' = 'transfer_date',
                  'record: a transfer dated before the approval is refused');
CREATE TEMP TABLE t_rec1 AS SELECT pg_temp.record(1, 'bank_transfer_exception', jsonb_build_object('transfer_date', pg_temp.today(), 'transfer_reference', 'MUFG 1')) AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 10000 AND r -> 'exception' ->> 'payout' = 'bank_transfer' FROM t_rec1)
              AND (SELECT status = 'recorded' AND transfer_reference = 'MUFG 1' FROM public.card_refund_exceptions WHERE cash_order_id = pg_temp.o(1))
              AND (SELECT refund_status = 'refund_issued' FROM public.cash_orders WHERE id = pg_temp.o(1)),
                  'record: bank transfer recorded against the approval; order refund_issued', (SELECT left(r::text, 300) FROM t_rec1));

-- =========================================================== SQV03 pending refunds
SELECT pg_temp.refund(2, 'rf_e2_failed', 'FAILED'); SELECT pg_temp.refund(2, 'rf_e2_pending', 'PENDING');
SELECT pg_temp.ok((SELECT r ->> 'error' = 'exception_refund_in_progress' AND r -> 'refunds' -> 0 ->> 'refund_id' = 'rf_e2_pending' FROM (SELECT pg_temp.approve(2, 'bank_transfer', 'rf_e2_failed', 'SQ-2', 10000) AS r) x),
                  'SQV03 failed + replacement PENDING ¥10,000 → approval refused (the exact double-pay case)');
SELECT pg_temp.refund(3, 'rf_e3_rejected', 'REJECTED'); SELECT pg_temp.refund(3, 'rf_e3_partial', 'PENDING', 4000);
SELECT pg_temp.ok(pg_temp.approve(3, 'bank_transfer', 'rf_e3_rejected', 'SQ-3', 6000) ->> 'error' = 'exception_refund_in_progress',
                  'SQV03 rejected + ¥4,000 partial PENDING → refused (no coexistence with an open refund)');
SELECT pg_temp.refund(4, 'rf_e4_failed', 'FAILED'); SELECT pg_temp.refund(4, 'rf_e4_odd', 'SOMETHING_NEW');
SELECT pg_temp.ok(pg_temp.approve(4, 'bank_transfer', 'rf_e4_failed', 'SQ-4', 10000) ->> 'error' = 'exception_refund_in_progress',
                  'SQV03 a refund in an unknown status counts as open → refused');
-- approved, then a refund starts in Square before the transfer
SELECT pg_temp.refund(5, 'rf_e5_failed', 'FAILED');
SELECT pg_temp.approve(5, 'bank_transfer', 'rf_e5_failed', 'SQ-5', 10000);
SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_e5_late', 'sq_e5', 'PENDING', 10000, NULL, now(), now(), '{"amount_money":{"amount":10000,"currency":"JPY"}}'::jsonb)$q$);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_refund_after_exception' AND metadata ->> 'refund_id' = 'rf_e5_late'),
                  'SQV03 a Square refund that STARTS after approval (pending) rings card_refund_after_exception — before anyone pays');
SELECT pg_temp.ok(pg_temp.record(5, 'bank_transfer_exception', jsonb_build_object('transfer_date', pg_temp.today(), 'transfer_reference', 'X')) ->> 'error' = 'exception_refund_in_progress',
                  'SQV03 recording against that approval is refused while the refund is pending');
SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_e5_late', 'sq_e5', 'COMPLETED', 10000, NULL, now(), now() + interval '1 minute', '{"amount_money":{"amount":10000,"currency":"JPY"}}'::jsonb)$q$);
SELECT pg_temp.ok(pg_temp.record(5, 'bank_transfer_exception', jsonb_build_object('transfer_date', pg_temp.today(), 'transfer_reference', 'X')) ->> 'error' = 'exception_superseded',
                  'SQV03 once Square completes the refund, the approval is superseded (cap 0): never both');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_refund_after_exception' AND metadata ->> 'refund_id' = 'rf_e5_late'),
                  'SQV03 the later bell rings once per refund (pending → completed does not ring twice)');
SELECT pg_temp.ok(pg_temp.try(format('SELECT public.cancel_card_refund_exception_atomic(%L, %L, %L)', pg_temp.o(5), pg_temp.admin(), '')) ->> 'error' = 'reason_required',
                  'cancel approval: a reason is required');
SELECT pg_temp.ok(pg_temp.try(format('SELECT public.cancel_card_refund_exception_atomic(%L, %L, %L)', pg_temp.o(5), '00000000-0000-0000-0000-00000000bbbb', 'x')) ->> 'error' = 'admin_only',
                  'cancel approval: admin only');
CREATE TEMP TABLE t_can5 AS SELECT pg_temp.try(format('SELECT public.cancel_card_refund_exception_atomic(%L, %L, %L)', pg_temp.o(5), pg_temp.admin(), 'Square refunded it')) AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' FROM t_can5)
              AND (SELECT status = 'cancelled' FROM public.card_refund_exceptions WHERE cash_order_id = pg_temp.o(5)),
                  'cancel approval: the superseded approval is withdrawn', (SELECT left(r::text, 300) FROM t_can5));
SELECT pg_temp.ok(pg_temp.try(format('SELECT public.cancel_card_refund_exception_atomic(%L, %L, %L)', pg_temp.o(1), pg_temp.admin(), 'x')) ->> 'error' IN ('already_recorded', 'no_approval'),
                  'cancel approval: a recorded (paid) exception cannot be cancelled');

-- =========================================================== SQV02 store-credit lot allocation
SELECT pg_temp.refund(6, 'rf_e6_failed', 'FAILED'); SELECT pg_temp.refund(7, 'rf_e7_failed', 'FAILED');
INSERT INTO public.store_credit_lots (id, customer_id, currency, original_amount, remaining_amount, status, source_type, issued_at, expires_at)
VALUES ('00000000-0000-0000-0000-0000000010b0', '00000000-0000-0000-0000-0000000000c1', 'JPY', 10000, 10000, 'active', 'manual_admin', now() - interval '1 hour', now() + interval '1 year');
SELECT pg_temp.approve(6, 'store_credit', 'rf_e6_failed', 'SQ-6', 10000);
SELECT pg_temp.approve(7, 'store_credit', 'rf_e7_failed', 'SQ-7', 10000);
SELECT pg_temp.ok(pg_temp.record(6, 'store_credit_exception', '{"customer_request":"email 9 Oct","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b0"}') ->> 'detail' = 'lot_issued_before_approval',
                  'SQV02 an older lot (issued before the approval) cannot become refund proof');
INSERT INTO public.store_credit_lots (id, customer_id, currency, original_amount, remaining_amount, status, source_type, issued_at, expires_at) VALUES
  ('00000000-0000-0000-0000-0000000010b1', '00000000-0000-0000-0000-0000000000c1', 'JPY', 10000, 10000, 'active', 'manual_admin', now() + interval '1 second', now() + interval '1 year'),
  ('00000000-0000-0000-0000-0000000010b2', '00000000-0000-0000-0000-0000000000c2', 'JPY', 10000, 10000, 'active', 'manual_admin', now() + interval '1 second', now() + interval '1 year'),
  ('00000000-0000-0000-0000-0000000010b3', '00000000-0000-0000-0000-0000000000c1', 'JPY',  9000,  9000, 'active', 'manual_admin', now() + interval '1 second', now() + interval '1 year'),
  ('00000000-0000-0000-0000-0000000010b4', '00000000-0000-0000-0000-0000000000c1', 'JPY', 10000,  6000, 'active', 'manual_admin', now() + interval '1 second', now() + interval '1 year'),
  ('00000000-0000-0000-0000-0000000010b5', '00000000-0000-0000-0000-0000000000c1', 'JPY', 10000, 10000, 'expired', 'manual_admin', now() + interval '1 second', now() + interval '1 second'),
  ('00000000-0000-0000-0000-0000000010b6', '00000000-0000-0000-0000-0000000000c1', 'PHP', 10000, 10000, 'active', 'manual_admin', now() + interval '1 second', now() + interval '1 year');
INSERT INTO public.store_credit_lots (id, customer_id, currency, original_amount, remaining_amount, status, source_type, source_cash_order_id, issued_at, expires_at) VALUES
  ('00000000-0000-0000-0000-0000000010b7', '00000000-0000-0000-0000-0000000000c1', 'JPY', 10000, 10000, 'active', 'cancelled_cash', pg_temp.o(10), now() + interval '1 second', now() + interval '1 year');
SELECT pg_temp.ok(pg_temp.record(6, 'store_credit_exception', '{"store_credit_lot_id":"00000000-0000-0000-0000-0000000010b1"}') ->> 'missing' = 'customer_request',
                  'SQV02 store credit needs her written request');
SELECT pg_temp.ok(pg_temp.record(6, 'store_credit_exception', '{"customer_request":"e","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b2"}') ->> 'detail' = 'lot_not_this_customer', 'SQV02 another customer''s lot refused');
SELECT pg_temp.ok(pg_temp.record(6, 'store_credit_exception', '{"customer_request":"e","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b3"}') ->> 'detail' = 'lot_amount_differs', 'SQV02 a lot of another amount refused');
SELECT pg_temp.ok(pg_temp.record(6, 'store_credit_exception', '{"customer_request":"e","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b4"}') ->> 'detail' = 'lot_already_spent', 'SQV02 a partly spent lot refused');
SELECT pg_temp.ok(pg_temp.record(6, 'store_credit_exception', '{"customer_request":"e","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b5"}') ->> 'detail' = 'lot_not_active', 'SQV02 an expired lot refused');
SELECT pg_temp.ok(pg_temp.record(6, 'store_credit_exception', '{"customer_request":"e","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b6"}') ->> 'detail' = 'lot_not_jpy', 'SQV02 a peso lot refused');
SELECT pg_temp.ok(pg_temp.record(6, 'store_credit_exception', '{"customer_request":"e","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b7"}') ->> 'detail' = 'lot_tied_to_an_order', 'SQV02 a cancellation lot of another order refused');
CREATE TEMP TABLE t_rec6 AS SELECT pg_temp.record(6, 'store_credit_exception', '{"customer_request":"email 9 Oct","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b1"}') AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' FROM t_rec6)
              AND (SELECT store_credit_lot_id = '00000000-0000-0000-0000-0000000010b1' AND status = 'recorded' FROM public.card_refund_exceptions WHERE cash_order_id = pg_temp.o(6)),
                  'SQV02 the right lot is recorded and ALLOCATED to this refund', (SELECT left(r::text, 300) FROM t_rec6));
SELECT pg_temp.ok(pg_temp.record(7, 'store_credit_exception', '{"customer_request":"e","store_credit_lot_id":"00000000-0000-0000-0000-0000000010b1"}') ->> 'detail' = 'lot_already_allocated',
                  'SQV02 the same lot can NOT settle a second order (sequential reuse)');
SELECT pg_temp.ok(pg_temp.try($q$INSERT INTO public.card_refund_exceptions (cash_order_id, status, payout, trigger_kind, square_support_ticket, amount_jpy, cap_jpy, card_captured_jpy, card_refunded_jpy, credit_issued_jpy, approved_by, recorded_by, recorded_at, store_credit_lot_id)
                                    VALUES ('00000000-0000-0000-0000-00000000e008', 'recorded', 'store_credit', 'refund_failed', 'x', 10000, 10000, 10000, 0, 0, '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', now(), '00000000-0000-0000-0000-0000000010b1') RETURNING '{}'::jsonb$q$) ->> 'raised' ILIKE '%uq_card_refund_exceptions_lot%',
                  'SQV02 the database itself refuses a second allocation of one lot (unique index — holds under concurrency)');
SELECT pg_temp.ok((SELECT remaining_amount = 10000 AND status::text = 'active' FROM public.store_credit_lots WHERE id = '00000000-0000-0000-0000-0000000010b1'),
                  'SQV02 the allocated lot stays spendable by her (later spending is legitimate)');

-- =========================================================== SQV04 age from the original payment
UPDATE public.square_payments SET authorized_at = now() - interval '13 months', captured_at = now() - interval '11 months' WHERE square_payment_id = 'sq_e8';
SELECT pg_temp.ok(pg_temp.approve(8, 'bank_transfer', NULL, 'SQ-8', 10000) -> 'exception' ->> 'trigger_kind' = 'payment_over_1_year',
                  'SQV04 authorised 13 months ago, captured 11 months ago → over 1 year from the ORIGINAL payment (the old capture rule said no)');
UPDATE public.square_payments SET authorized_at = now() - interval '11 months', captured_at = now() - interval '11 months' WHERE square_payment_id = 'sq_e9';
SELECT pg_temp.ok(pg_temp.approve(9, 'bank_transfer', NULL, 'SQ-9', 10000) ->> 'detail' = 'no_failed_refund_and_payment_within_1_year',
                  'SQV04 a payment 11 months old with no failed refund → not triggered (Square facts only, D-SQV04)');
SELECT pg_temp.ok(NOT (TIMESTAMPTZ '2024-02-29 11:00:00+09' < TIMESTAMPTZ '2025-02-28 12:00:00+09' - interval '1 year')
              AND (TIMESTAMPTZ '2024-02-29 12:00:00+09' < TIMESTAMPTZ '2025-03-01 12:00:00+09' - interval '1 year'),
                  'SQV04 calendar year, leap day: a 29 Feb 2024 payment is not yet "over 1 year" on 28 Feb 2025 but is on 1 Mar 2025');
SELECT pg_temp.ok(pg_temp.record(10, 'card', '{}') ->> 'error' = 'no_completed_card_refund',
                  'regression: method card still needs a COMPLETED Square refund');

-- =========================================================== D-G04 allow-list
SELECT pg_temp.ok(public.square_mode() = 'test' AND public.square_card_allowed('00000000-0000-0000-0000-0000000000c3')
              AND NOT public.square_card_allowed('00000000-0000-0000-0000-0000000000c1'),
                  'D-G04 mode test: only test customers (as the storefront already did)');
SELECT pg_temp.ok(public.square_audience() = 'listed' AND public.square_card_customer_ids_json() = '[]'::jsonb,
                  'D-G04 seeded fail-closed: audience listed, empty list');
SELECT pg_temp.ok(pg_temp.try($q$SELECT public.set_square_settings('on', 'sq0idp-ABCDEF123', 'LOCPROD1', 0, 'test', 'listed', ARRAY['CJ-2026-99999'])$q$) ->> 'error' = 'unknown_customer_code',
                  'D-G04 an unknown customer code is refused (nothing saved)');
SELECT pg_temp.ok(pg_temp.try($q$SELECT public.set_square_settings('on', 'sq0idp-ABCDEF123', 'LOCPROD1', 0, 'test', 'some', NULL)$q$) ->> 'error' = 'invalid_audience',
                  'D-G04 an invalid audience is refused');
CREATE TEMP TABLE t_set AS SELECT pg_temp.try($q$SELECT public.set_square_settings('on', 'sq0idp-ABCDEF123', 'LOCPROD1', 0, 'test', 'listed', ARRAY[' cj-2026-90001 '])$q$) AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND r ->> 'audience' = 'listed' FROM t_set)
              AND public.square_card_allowed('00000000-0000-0000-0000-0000000000c1')
              AND NOT public.square_card_allowed('00000000-0000-0000-0000-0000000000c2')
              AND NOT public.square_card_allowed('00000000-0000-0000-0000-0000000000c3')
              AND NOT public.square_card_allowed(NULL),
                  'D-G04 mode on + listed: ONLY the listed customer may pay by card (code matched case/space-insensitively)', (SELECT r::text FROM t_set));
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.audit_logs WHERE action = 'set_square_settings' AND new_value_json ->> 'audience' = 'listed'
                           AND new_value_json -> 'card_customer_ids' ? '00000000-0000-0000-0000-0000000000c1'),
                  'D-G04 the change is audited with the list');
SELECT pg_temp.ok((SELECT r -> 'card_customers' -> 0 ->> 'code' = 'CJ-2026-90001' AND r ->> 'audience' = 'listed' FROM (SELECT public.get_square_settings() AS r) x),
                  'D-G04 get_square_settings shows the audience and the listed customer by code');
SELECT pg_temp.ok(pg_temp.try($q$UPDATE public.system_settings SET value = to_jsonb('everyone'::text) WHERE key = 'square_audience' RETURNING '{}'::jsonb$q$) ->> 'raised' ILIKE '%only from the Hub%',
                  'D-G04 the audience cannot be changed by a direct write (guard trigger)');
SELECT pg_temp.ok((SELECT public.reserve_square_attempt('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000000c2', 10000, 'production', 'LOCPROD1', 'sq0idp-ABCDEF123', false, 'key_00000001', 'cja_ref_00000001', NULL, '{}') ->> 'error') IN ('wrong_customer', 'card_not_offered'),
                  'D-G04 reserve: a customer not on the list never reaches Square (refused before the attempt row)');
UPDATE public.cash_orders SET customer_id = '00000000-0000-0000-0000-0000000000c2' WHERE id = pg_temp.o(2);
SELECT pg_temp.ok(public.reserve_square_attempt(pg_temp.o(2), '00000000-0000-0000-0000-0000000000c2', 10000, 'production', 'LOCPROD1', 'sq0idp-ABCDEF123', false, 'key_00000002', 'cja_ref_00000002', NULL, '{}') ->> 'error' = 'card_not_offered'
              AND NOT EXISTS (SELECT 1 FROM public.square_card_attempts WHERE idempotency_key = 'key_00000002'),
                  'D-G04 reserve: card_not_offered for her own order when she is not listed; no attempt written');
SELECT pg_temp.try($q$SELECT public.set_square_settings('on', NULL, NULL, NULL, 'on', 'everyone', NULL)$q$);
SELECT pg_temp.ok(public.square_card_allowed('00000000-0000-0000-0000-0000000000c2') AND public.square_audience() = 'everyone',
                  'D-G04 audience everyone: every customer may pay by card');
SET LOCAL app.allow_square_settings_change = 'on';
UPDATE public.system_settings SET value = to_jsonb('garbage'::text) WHERE key = 'square_audience';
SELECT pg_temp.ok(public.square_audience() = 'listed' AND NOT public.square_card_allowed('00000000-0000-0000-0000-0000000000c2'),
                  'D-G04 an unreadable audience fails closed to listed');

SELECT format('%s passed, %s failed', count(*) FILTER (WHERE pass), count(*) FILTER (WHERE NOT pass)) AS result FROM t_results;
SELECT n, name, detail FROM t_results WHERE NOT pass ORDER BY n;
ROLLBACK;
