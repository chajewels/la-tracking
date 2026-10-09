-- Square L2–L8 (2026-10-09, eighth release). NOT a migration — never applied to live.
-- Runs on a local copy carrying the live bodies AND
-- supabase/migrations/20261201120000_square_l2_l8.sql. One transaction, rolled back.
-- Every check states the CORRECT behaviour; after the fix this file must report 0 failed.
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '{}'::jsonb); EXCEPTION WHEN others THEN RETURN jsonb_build_object('raised', SQLERRM); END $$;
CREATE FUNCTION pg_temp.run(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN others THEN RETURN SQLERRM; END $$;

INSERT INTO auth.users (id, email) VALUES ('84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'admin-test@example.com') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'admin') ON CONFLICT DO NOTHING;
INSERT INTO public.customers (id, full_name, email, mobile_number, customer_code, is_test) VALUES
  ('00000000-0000-0000-0000-0000000000c8', 'L2L8 Customer', 'c8@example.com', '09011118888', 'CJ-2026-90008', false)
ON CONFLICT (id) DO NOTHING;
CREATE FUNCTION pg_temp.o(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000f0' || lpad(i::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.sp(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000f1' || lpad(i::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.cp(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000f2' || lpad(i::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.att(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000f3' || lpad(i::text, 2, '0'))::uuid $$;
\set admin '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457'

-- Orders 1-9: yen web orders of ¥15,000 (pending unless a test changes them).
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency,
                                order_date, total_amount, total_paid, remaining_balance)
SELECT pg_temp.o(i), 'L28' || i, '00000000-0000-0000-0000-0000000000c8', 'pending', 'CJ-W-L28' || i, 'web', 'JPY',
       (now() AT TIME ZONE 'Asia/Manila')::date - 3, 15000, 0, 15000
FROM generate_series(1, 9) i;

-- ===== L3: refund_jpy never goes down =====================================================
INSERT INTO public.square_payments (id, cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy,
                                    authorized_at, captured_at, environment, currency, refund_jpy)
VALUES (pg_temp.sp(1), pg_temp.o(1), '00000000-0000-0000-0000-0000000000c8', 'sq_l28_1', 'captured', true, 15000, 15000,
        now() - interval '2 days', now() - interval '1 day', 'sandbox', 'JPY', 5000);
SELECT pg_temp.try($q$SELECT public.apply_square_payment_state('sq_l28_1', 'COMPLETED', 15000, 0, 'JPY', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, 'webhook', NULL)$q$);
SELECT pg_temp.ok((SELECT refund_jpy FROM public.square_payments WHERE id = pg_temp.sp(1)) = 5000,
  'L3 a later payment.updated without refunded_money keeps refund_jpy',
  (SELECT 'refund_jpy=' || refund_jpy FROM public.square_payments WHERE id = pg_temp.sp(1)));
SELECT pg_temp.try($q$SELECT public.apply_square_payment_state('sq_l28_1', 'COMPLETED', 15000, 7000, 'JPY', NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, 'webhook', NULL)$q$);
SELECT pg_temp.ok((SELECT refund_jpy FROM public.square_payments WHERE id = pg_temp.sp(1)) = 7000,
  'CONTROL L3 a larger refunded total still raises refund_jpy');

-- ===== L4: one lock order (attempt first) =================================================
SELECT pg_temp.ok(
  position('square_card_attempts WHERE id = p_attempt_id FOR UPDATE' IN d) > 0
  AND position('square_card_attempts WHERE id = p_attempt_id FOR UPDATE' IN d) < position('cash_orders WHERE id = v_att.cash_order_id FOR UPDATE' IN d)
  AND position('square_card_attempts WHERE id = p_attempt_id;' IN d) = 0,
  'L4 close_square_attempt_atomic locks the attempt before the order (as file_square_authorization_atomic)')
  FROM (SELECT pg_get_functiondef('public.close_square_attempt_atomic(uuid,text)'::regprocedure) d) x;
SELECT pg_temp.ok(
  position('FROM public.square_card_attempts a' IN d) > 0
  AND position('FROM public.square_card_attempts a' IN d) < position('FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE' IN d),
  'L4 apply_square_payment_state locks the attempt before the payment row')
  FROM (SELECT pg_get_functiondef('public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,jsonb,jsonb,text,uuid)'::regprocedure) d) x;
-- close still works for an admin on an old open attempt.
INSERT INTO public.square_card_attempts (id, cash_order_id, customer_id, reference, idempotency_key, amount_jpy, currency, environment, location_id, status, created_at)
VALUES (pg_temp.att(4), pg_temp.o(4), '00000000-0000-0000-0000-0000000000c8', 'cja_l28_4xx', 'idem_l28_4xxxx', 15000, 'JPY', 'sandbox', 'LOC1', 'unknown', now() - interval '2 hours');
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
SELECT pg_temp.ok(r ->> 'ok' = 'true', 'CONTROL L4 an admin still closes a stuck attempt', r::text)
  FROM (SELECT pg_temp.try(format('SELECT public.close_square_attempt_atomic(%L, %L)', pg_temp.att(4), 'checked the Square Dashboard, nothing there')) r) x;
SELECT set_config('request.jwt.claims', '', true);

-- ===== L2: a dispute the Hub cannot read is refused, one bell =============================
INSERT INTO public.square_payments (id, cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy,
                                    authorized_at, captured_at, environment, currency)
VALUES (pg_temp.sp(2), pg_temp.o(2), '00000000-0000-0000-0000-0000000000c8', 'sq_l28_2', 'captured', true, 15000, 15000,
        now() - interval '2 days', now() - interval '1 day', 'sandbox', 'JPY');
SELECT pg_temp.ok(r ->> 'error' = 'bad_amount', 'L2 a dispute with no amount is refused (bad_amount)', r::text)
  FROM (SELECT pg_temp.try($q$SELECT public.record_square_dispute('dp_l28_a', 'sq_l28_2', 'EVIDENCE_REQUIRED', 'FRAUD', NULL, NULL, NULL, NULL,
        '{"id":"dp_l28_a","state":"EVIDENCE_REQUIRED"}'::jsonb)$q$) r) x;
SELECT pg_temp.try($q$SELECT public.record_square_dispute('dp_l28_a', 'sq_l28_2', 'EVIDENCE_REQUIRED', 'FRAUD', NULL, NULL, NULL, NULL,
        '{"id":"dp_l28_a","state":"EVIDENCE_REQUIRED"}'::jsonb)$q$);
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.square_disputes WHERE square_dispute_id = 'dp_l28_a'),
  'L2 nothing stored for the unreadable dispute');
SELECT pg_temp.ok((SELECT count(*) FROM public.staff_notifications WHERE type = 'card_dispute_unrecorded' AND metadata ->> 'dispute_id' = 'dp_l28_a') = 1,
  'L2 exactly one card_dispute_unrecorded bell across two deliveries',
  (SELECT count(*)::text FROM public.staff_notifications WHERE type = 'card_dispute_unrecorded' AND metadata ->> 'dispute_id' = 'dp_l28_a'));
SELECT pg_temp.ok(r ->> 'error' = 'bad_currency', 'L2 a non-yen dispute is refused (bad_currency)', r::text)
  FROM (SELECT pg_temp.try($q$SELECT public.record_square_dispute('dp_l28_b', 'sq_l28_2', 'EVIDENCE_REQUIRED', 'FRAUD', 100, NULL, NULL, NULL,
        '{"id":"dp_l28_b","amount_money":{"amount":100,"currency":"USD"}}'::jsonb)$q$) r) x;
SELECT pg_temp.ok(r ->> 'error' = 'bad_amount', 'L2 a payload amount that differs from the recorded figure is refused', r::text)
  FROM (SELECT pg_temp.try($q$SELECT public.record_square_dispute('dp_l28_c', 'sq_l28_2', 'EVIDENCE_REQUIRED', 'FRAUD', 15000, NULL, NULL, NULL,
        '{"id":"dp_l28_c","amount_money":{"amount":1500,"currency":"JPY"}}'::jsonb)$q$) r) x;
SELECT pg_temp.ok(r ->> 'ok' = 'true' AND (r -> 'dispute' ->> 'amount_jpy')::bigint = 15000,
  'CONTROL L2 a readable yen dispute is recorded', r::text)
  FROM (SELECT pg_temp.try($q$SELECT public.record_square_dispute('dp_l28_d', 'sq_l28_2', 'EVIDENCE_REQUIRED', 'FRAUD', 15000, NULL, NULL, NULL,
        '{"id":"dp_l28_d","amount_money":{"amount":15000,"currency":"JPY"}}'::jsonb)$q$) r) x;

-- ===== L5: the browser cannot move the balance while a card payment holds the order =======
INSERT INTO public.square_payments (id, cash_order_id, customer_id, square_payment_id, status, test, amount_jpy,
                                    authorized_at, environment, currency)
VALUES (pg_temp.sp(3), pg_temp.o(3), '00000000-0000-0000-0000-0000000000c8', 'sq_l28_3', 'authorized', true, 15000,
        now() - interval '1 hour', 'sandbox', 'JPY');
SELECT pg_temp.ok(public.cash_order_payment_lock(pg_temp.o(3)) = 'card_payment_unresolved', 'SANITY order 3 is card-locked');
SELECT set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
SELECT pg_temp.ok(r LIKE 'card_payment_unresolved%', 'L5 a signed-in edit of remaining_balance is refused while the card lock is set', r)
  FROM (SELECT pg_temp.run(format('UPDATE public.cash_orders SET remaining_balance = 1 WHERE id = %L', pg_temp.o(3))) r) x;
SELECT pg_temp.ok(r LIKE 'card_payment_unresolved%', 'L5 the Manage Invoice payload (same total, recomputed balance) is refused too', r)
  FROM (SELECT pg_temp.run(format('UPDATE public.cash_orders SET total_amount = 15000, remaining_balance = 14000, order_date = order_date WHERE id = %L', pg_temp.o(3))) r) x;
SELECT pg_temp.ok(r = 'ok', 'CONTROL L5 a signed-in edit of another field still works', r)
  FROM (SELECT pg_temp.run(format('UPDATE public.cash_orders SET order_date = order_date - 1 WHERE id = %L', pg_temp.o(3))) r) x;
SELECT pg_temp.ok(r = 'ok', 'CONTROL L5 the balance of an order with no lock can still be edited', r)
  FROM (SELECT pg_temp.run(format('UPDATE public.cash_orders SET remaining_balance = 14999 WHERE id = %L', pg_temp.o(9))) r) x;
SELECT set_config('request.jwt.claims', '', true);
SELECT pg_temp.ok(r = 'ok', 'CONTROL L5 a service-role recording (total_paid and balance together) is not blocked', r)
  FROM (SELECT pg_temp.run(format('UPDATE public.cash_orders SET remaining_balance = 0, total_paid = 15000 WHERE id = %L', pg_temp.o(3))) r) x;

-- ===== L6: mark refund issued — capped by the recorded card money, a second part allowed ==
-- Order 5: mixed — card ¥10,000 recorded + bank transfer ¥5,000; Square refunded the card in full.
-- Order 6: mixed — card captured ¥10,000, ¥3,000 refunded BEFORE recording (net ¥7,000 recorded),
--          later ¥7,000 refunded; plus bank transfer ¥5,000.
-- Order 7: card only ¥10,000 — refunded in two steps (¥4,000, then ¥6,000).
UPDATE public.cash_orders SET status = 'cancelled', refund_status = 'refund_pending' WHERE id IN (pg_temp.o(5), pg_temp.o(6), pg_temp.o(7));
INSERT INTO public.square_payments (id, cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy,
                                    authorized_at, captured_at, environment, currency)
VALUES (pg_temp.sp(5), pg_temp.o(5), '00000000-0000-0000-0000-0000000000c8', 'sq_l28_5', 'captured', true, 10000, 10000, now() - interval '3 days', now() - interval '2 days', 'sandbox', 'JPY'),
       (pg_temp.sp(6), pg_temp.o(6), '00000000-0000-0000-0000-0000000000c8', 'sq_l28_6', 'captured', true, 10000, 10000, now() - interval '3 days', now() - interval '2 days', 'sandbox', 'JPY'),
       (pg_temp.sp(7), pg_temp.o(7), '00000000-0000-0000-0000-0000000000c8', 'sq_l28_7', 'captured', true, 10000, 10000, now() - interval '3 days', now() - interval '2 days', 'sandbox', 'JPY');
-- Fixture rows only: the ledger guards are bypassed for the inserts (replica mode), then restored.
SET LOCAL session_replication_role = replica;
INSERT INTO public.cash_payments (id, cash_order_id, amount_paid, currency, date_paid, payment_method, reference_number, provider_capture_id)
VALUES (pg_temp.cp(5), pg_temp.o(5), 10000, 'JPY', current_date - 2, 'square', 'sq_l28_5', 'sq_l28_5'),
       (pg_temp.cp(6), pg_temp.o(6), 7000, 'JPY', current_date - 2, 'square', 'sq_l28_6', 'sq_l28_6'),
       (pg_temp.cp(7), pg_temp.o(7), 10000, 'JPY', current_date - 2, 'square', 'sq_l28_7', 'sq_l28_7');
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method, reference_number)
VALUES (pg_temp.o(5), 5000, 'JPY', current_date - 2, 'bank_transfer', 'BT-L28-5'),
       (pg_temp.o(6), 5000, 'JPY', current_date - 2, 'bank_transfer', 'BT-L28-6');
UPDATE public.square_payments SET cash_payment_id = pg_temp.cp(i) FROM generate_series(5, 7) i WHERE id = pg_temp.sp(i);
SET LOCAL session_replication_role = origin;
INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
VALUES ('rf_l28_5', pg_temp.sp(5), 'sq_l28_5', pg_temp.o(5), 10000, 'COMPLETED'),
       ('rf_l28_6a', pg_temp.sp(6), 'sq_l28_6', pg_temp.o(6), 3000, 'COMPLETED'),
       ('rf_l28_6b', pg_temp.sp(6), 'sq_l28_6', pg_temp.o(6), 7000, 'COMPLETED'),
       ('rf_l28_7a', pg_temp.sp(7), 'sq_l28_7', pg_temp.o(7), 4000, 'COMPLETED');

CREATE FUNCTION pg_temp.mark(p_order uuid, p_method text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.mark_web_order_refund_issued_atomic(%L, %L, %L, %L, NULL, NULL)',
                            p_order, '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', p_method, (now() AT TIME ZONE 'Asia/Manila')::date))
$$;
-- Order 5
SELECT pg_temp.ok(r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 10000, 'L6 order 5: card marked for the card money (¥10,000)', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(5), 'card') r) x;
SELECT pg_temp.ok(r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 5000 AND coalesce(r ->> 'already_recorded', 'false') = 'false',
  'L6 order 5: the bank-transfer part can be marked after the card part (¥5,000)', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(5), 'bank_transfer') r) x;
SELECT pg_temp.ok(r ->> 'already_recorded' = 'true' AND (r ->> 'amount')::numeric = 5000, 'L6 order 5: the same bank-transfer mark again writes nothing', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(5), 'bank_transfer') r) x;
SELECT pg_temp.ok(r ->> 'error' = 'not_refund_pending', 'L6 order 5: a third, different non-card mark is refused', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(5), 'cash') r) x;
SELECT pg_temp.ok(r ->> 'already_recorded' = 'true', 'L6 order 5: the card mark again writes nothing', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(5), 'card') r) x;
SELECT pg_temp.ok((SELECT count(*) FROM public.audit_logs WHERE entity_id = pg_temp.o(5) AND action = 'refund_marked_issued') = 2,
  'L6 order 5: exactly two marks on the books');
-- Order 6
SELECT pg_temp.ok(r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 7000,
  'L6 order 6: the card figure is the RECORDED card money returned (¥7,000), not the ¥10,000 Square refunded', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(6), 'card') r) x;
-- Order 7
SELECT pg_temp.ok(r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 4000, 'L6 order 7: first card refund marked (¥4,000)', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(7), 'card') r) x;
INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
VALUES ('rf_l28_7b', pg_temp.sp(7), 'sq_l28_7', pg_temp.o(7), 6000, 'COMPLETED');
SELECT pg_temp.ok(r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 6000 AND coalesce(r ->> 'already_recorded', 'false') = 'false',
  'L6 order 7: a later completed Square refund is marked for the remainder (¥6,000)', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(7), 'card') r) x;
SELECT pg_temp.ok(r ->> 'already_recorded' = 'true', 'L6 order 7: nothing more to mark — same answer, nothing written', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(7), 'card') r) x;
SELECT pg_temp.ok(r ->> 'error' = 'not_refund_pending', 'CONTROL L6 order 7 (card only): a non-card mark is still refused', r::text)
  FROM (SELECT pg_temp.mark(pg_temp.o(7), 'bank_transfer') r) x;
SELECT pg_temp.ok(NOT has_function_privilege('authenticated', 'public.square_order_card_refund_recordable_jpy(uuid)', 'EXECUTE')
                  AND NOT has_function_privilege('anon', 'public.square_order_card_refund_recordable_jpy(uuid)', 'EXECUTE'),
  'L6 the recordable-figure helper is not callable by signed-in users or anon');

-- ===== L7: a hold on a closed attempt says it is voided automatically =====================
INSERT INTO public.square_card_attempts (id, cash_order_id, customer_id, reference, idempotency_key, amount_jpy, currency, environment, location_id, status, created_at)
VALUES (pg_temp.att(8), pg_temp.o(8), '00000000-0000-0000-0000-0000000000c8', 'cja_l28_8xx', 'idem_l28_8xxxx', 15000, 'JPY', 'sandbox', 'LOC1', 'cancelled', now() - interval '2 hours');
SELECT pg_temp.ok(r ->> 'exception' = 'unfiled_hold' AND r ->> 'reason' = 'attempt_cancelled', 'SANITY L7 a late hold on a cancelled attempt is an unfiled hold', r::text)
  FROM (SELECT pg_temp.try(format($q$SELECT public.file_square_authorization_atomic(%L, 'sq_l28_8', 15000, 'JPY', 'LOC1', 'VISA', '1111', NULL,
          now(), now() + interval '7 days', 'NORMAL', NULL, NULL, NULL, NULL, current_date, 'L2L8 Customer', 'test', 'CJ-W-L288', 'test')$q$, pg_temp.att(8))) r) x;
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.staff_notifications WHERE type = 'card_hold_unfiled' AND metadata ->> 'square_payment_id' = 'sq_l28_8'
                            AND body LIKE '%voids this hold automatically%' AND body NOT LIKE '%record it or void it%'),
  'L7 the bell says the Hub voids it (never "record it")',
  (SELECT body FROM public.staff_notifications WHERE type = 'card_hold_unfiled' AND metadata ->> 'square_payment_id' = 'sq_l28_8' LIMIT 1));
SELECT pg_temp.ok((SELECT exception_note FROM public.square_payments WHERE square_payment_id = 'sq_l28_8') = 'attempt_cancelled',
  'L7 the hold row carries the reason the reconcile retry keys on (attempt_*)');

SELECT name, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, left(coalesce(detail, ''), 160) AS detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) || ' passed, ' || count(*) FILTER (WHERE NOT pass) || ' failed' AS summary FROM t_results;
ROLLBACK;
