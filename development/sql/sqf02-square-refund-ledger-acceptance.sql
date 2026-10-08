-- SQF02 acceptance (migration 20261129100000). NOT a migration — never applied to live.
-- Runs on the local Postgres copy of live (record_square_refund byte-identical to live before
-- the migration), one transaction, rolled back.
-- Expected after the migration: 14 passed, 0 failed. Before: the refusal checks fail
-- (the old body records a ¥0 refund, a USD refund, a refund above the capture, and re-binds
-- a refund id to another payment).
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN EXECUTE p_sql INTO r; RETURN r; EXCEPTION WHEN others THEN RETURN jsonb_build_object('raised', SQLERRM); END $$;
CREATE FUNCTION pg_temp.rec(p_refund text, p_payment text, p_status text, p_amount bigint, p_currency text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.record_square_refund(%L, %L, %L, %s, NULL, now() - interval ''1 hour'', now(), %L::jsonb)',
                            p_refund, p_payment, p_status, p_amount,
                            jsonb_build_object('id', p_refund, 'payment_id', p_payment, 'status', p_status,
                                               'amount_money', jsonb_build_object('amount', p_amount, 'currency', p_currency))::text)) $$;
CREATE FUNCTION pg_temp.bells(p_refund text, p_error text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.staff_notifications
   WHERE type = 'card_refund_unrecorded' AND metadata ->> 'refund_id' = p_refund AND metadata ->> 'error' = p_error $$;

SELECT set_config('test.uid', '00000000-0000-0000-0000-00000000aaaa', false);
INSERT INTO public.customers (id, full_name, email, mobile_number) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Test Customer', 'a@example.com', '09011112222');
-- two card-paid web orders, ¥10,000 captured each
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency, order_date, total_amount, total_paid)
VALUES ('00000000-0000-0000-0000-0000000002a1', 'T2A1', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-T2A1', 'web', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 3, 10000, 10000),
       ('00000000-0000-0000-0000-0000000002a2', 'T2A2', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-T2A2', 'web', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 3, 10000, 10000);
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
VALUES ('00000000-0000-0000-0000-0000000002a1', 10000, 'JPY', 'square', 'sq_cap_2a1'),
       ('00000000-0000-0000-0000-0000000002a2', 10000, 'JPY', 'square', 'sq_cap_2a2');
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, captured_at, environment)
VALUES ('00000000-0000-0000-0000-0000000002a1', 'sq_cap_2a1', 'captured', true, 10000, now() - interval '2 days', 'sandbox'),
       ('00000000-0000-0000-0000-0000000002a2', 'sq_cap_2a2', 'captured', true, 10000, now() - interval '2 days', 'sandbox');

-- 1. bad_amount: a ¥0 refund (what the old edge wrote when Square's answer had no amount) is refused and rings a bell
CREATE TEMP TABLE t_ba AS SELECT pg_temp.rec('rf_zero', 'sq_cap_2a1', 'COMPLETED', 0, 'JPY') AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'false' AND r ->> 'error' = 'bad_amount' FROM t_ba)
                  AND NOT EXISTS (SELECT 1 FROM public.square_refunds WHERE square_refund_id = 'rf_zero')
                  AND pg_temp.bells('rf_zero', 'bad_amount') = 1,
                  'SQF02 bad_amount: ¥0 refund refused, nothing recorded, one card_refund_unrecorded bell', (SELECT r::text FROM t_ba));
SELECT pg_temp.rec('rf_zero', 'sq_cap_2a1', 'COMPLETED', 0, 'JPY');
SELECT pg_temp.ok(pg_temp.bells('rf_zero', 'bad_amount') = 1, 'SQF02 the same refusal re-polled rings the bell only once');

-- 2. bad_currency
CREATE TEMP TABLE t_bc AS SELECT pg_temp.rec('rf_usd', 'sq_cap_2a1', 'COMPLETED', 30, 'USD') AS r;
SELECT pg_temp.ok((SELECT r ->> 'error' = 'bad_currency' FROM t_bc)
                  AND NOT EXISTS (SELECT 1 FROM public.square_refunds WHERE square_refund_id = 'rf_usd')
                  AND pg_temp.bells('rf_usd', 'bad_currency') = 1,
                  'SQF02 bad_currency: a USD refund is refused and belled', (SELECT r::text FROM t_bc));
CREATE TEMP TABLE t_nc AS SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_nocur', 'sq_cap_2a1', 'COMPLETED', 3000, NULL, now(), now(), '{}'::jsonb)$q$) AS r;
SELECT pg_temp.ok((SELECT r ->> 'error' = 'bad_currency' FROM t_nc),
                  'SQF02 a payload that names no currency is refused too (fail closed)', (SELECT r::text FROM t_nc));

-- 3. a good refund records
CREATE TEMP TABLE t_g1 AS SELECT pg_temp.rec('rf_ok1', 'sq_cap_2a1', 'COMPLETED', 3000, 'JPY') AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND (r -> 'refund' ->> 'amount_jpy')::bigint = 3000 FROM t_g1),
                  'SQF02 regression: a ¥3,000 JPY refund on a ¥10,000 capture records', (SELECT left(r::text, 300) FROM t_g1));
SELECT pg_temp.ok(pg_temp.rec('rf_ok1b', 'sq_cap_2a1', 'completed', 3000, 'jpy') ->> 'ok' = 'true',
                  'SQF02 currency / status case-insensitive (jpy = JPY)');

-- 4. over_ceiling: 3000 + 3000 recorded; a further 5000 would exceed the ¥10,000 captured
CREATE TEMP TABLE t_oc AS SELECT pg_temp.rec('rf_big', 'sq_cap_2a1', 'COMPLETED', 5000, 'JPY') AS r;
SELECT pg_temp.ok((SELECT r ->> 'error' = 'over_ceiling' AND (r ->> 'other_refunds_jpy')::bigint = 6000 AND (r ->> 'captured_jpy')::numeric = 10000 FROM t_oc)
                  AND NOT EXISTS (SELECT 1 FROM public.square_refunds WHERE square_refund_id = 'rf_big')
                  AND pg_temp.bells('rf_big', 'over_ceiling') = 1,
                  'SQF02 over_ceiling: ¥6,000 already refunded + ¥5,000 > ¥10,000 captured → refused + belled', (SELECT r::text FROM t_oc));
SELECT pg_temp.ok(pg_temp.rec('rf_exact', 'sq_cap_2a1', 'PENDING', 4000, 'JPY') ->> 'ok' = 'true',
                  'SQF02 exactly up to the capture (¥6,000 + ¥4,000 = ¥10,000) records');
SELECT pg_temp.ok(pg_temp.rec('rf_failed_big', 'sq_cap_2a1', 'FAILED', 50000, 'JPY') ->> 'ok' = 'true',
                  'SQF02 a FAILED refund has no ceiling (it moved no money) and is recorded as the fact it is');
SELECT pg_temp.ok(pg_temp.rec('rf_after_failed', 'sq_cap_2a1', 'COMPLETED', 1, 'JPY') ->> 'error' = 'over_ceiling',
                  'SQF02 the FAILED ¥50,000 does not count toward the ceiling, but the capture is already fully refunded (¥10,000) → ¥1 more is refused');

-- 5. parent_mismatch: rf_ok1 (recorded on sq_cap_2a1) arrives claiming payment sq_cap_2a2
CREATE TEMP TABLE t_pm AS SELECT pg_temp.rec('rf_ok1', 'sq_cap_2a2', 'COMPLETED', 3000, 'JPY') AS r;
SELECT pg_temp.ok((SELECT r ->> 'error' = 'parent_mismatch' FROM t_pm)
                  AND (SELECT square_payment_id = 'sq_cap_2a1' AND cash_order_id = '00000000-0000-0000-0000-0000000002a1' FROM public.square_refunds WHERE square_refund_id = 'rf_ok1')
                  AND pg_temp.bells('rf_ok1', 'parent_mismatch') = 1,
                  'SQF02 parent_mismatch: a refund id is never re-bound to another payment; the row keeps its payment and order', (SELECT r::text FROM t_pm));

-- 6. the status update path still works (same parent, newer observation)
CREATE TEMP TABLE t_up AS SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_exact', 'sq_cap_2a1', 'COMPLETED', 4000, NULL, now() - interval '1 hour', now() + interval '1 minute', '{"amount_money":{"amount":4000,"currency":"JPY"}}'::jsonb)$q$) AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND r ->> 'changed' = 'true' FROM t_up)
                  AND (SELECT status = 'COMPLETED' FROM public.square_refunds WHERE square_refund_id = 'rf_exact'),
                  'SQF02 regression: PENDING → COMPLETED on the same payment updates (its own amount is excluded from the ceiling sum)', (SELECT left(r::text, 300) FROM t_up));

-- 7. SQF06 §8 wording
SELECT pg_temp.ok(position('reverse the Square refund' IN pg_get_functiondef('public.record_square_refund'::regproc)) = 0
                  AND position('void the UNSPENT store-credit lot' IN pg_get_functiondef('public.record_square_refund'::regproc)) > 0,
                  'SQF06 §8: the card_refund_after_credit bell no longer says "reverse the Square refund"');
-- the unrelated-payment and stale paths are untouched
SELECT pg_temp.ok(pg_temp.rec('rf_x', 'sq_nope', 'COMPLETED', 100, 'JPY') ->> 'error' = 'unknown_payment',
                  'SQF02 regression: an unknown payment is still unknown_payment (recovery path), no bell',
                  (SELECT pg_temp.bells('rf_x', 'unknown_payment')::text));

SELECT format('%s passed, %s failed', count(*) FILTER (WHERE pass), count(*) FILTER (WHERE NOT pass)) AS result FROM t_results;
SELECT n, name, detail FROM t_results WHERE NOT pass ORDER BY n;
ROLLBACK;
