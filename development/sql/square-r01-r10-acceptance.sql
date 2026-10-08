-- Square QA reassessment R01 / R02 / R05 acceptance (2026-10-08, migration 20261118120000).
-- NOT a migration — never applied to live. Runs on the local Postgres copy of the live schema
-- (live function bodies as of the 2026-10-08 11:45 apply) with auth.uid() = test.uid and
-- is_staff / has_permission answering true. One transaction, rolled back.
-- Expected after the migration: 16 passed, 0 failed. Before: the R05 refusals and the R01/R02
-- column/ordering checks fail (old behaviour mints credit on a Square-refunded order).
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN EXECUTE p_sql INTO r; RETURN r; EXCEPTION WHEN others THEN RETURN jsonb_build_object('raised', SQLERRM); END $$;

SELECT set_config('test.uid', '00000000-0000-0000-0000-00000000aaaa', false);
INSERT INTO public.customers (id, full_name, email, mobile_number) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Test Customer', 'a@example.com', '09011112222');

-- ================================================================ R05 web orders (terminate)
-- four card-paid web orders, ¥10,000 each, placed 3 days ago (after-order-day rule → 70 % credit)
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency, order_date, total_amount, total_paid)
SELECT ('00000000-0000-0000-0000-00000000f0a' || i)::uuid, 'TR5' || i, '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-TR5' || i, 'web', 'JPY',
       (now() AT TIME ZONE 'Asia/Manila')::date - 3, 10000, 10000
FROM generate_series(1, 4) i;
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
SELECT ('00000000-0000-0000-0000-00000000f0a' || i)::uuid, 10000, 'JPY', 'square', 'sq_cap_r5' || i FROM generate_series(1, 4) i;
-- 1: fully refunded in Square; 2: partially (¥4,000) refunded; 3: refund PENDING; 4: refund FAILED
INSERT INTO public.square_refunds (square_refund_id, square_payment_id, cash_order_id, amount_jpy, status) VALUES
  ('rf_r5_1', 'sq_cap_r51', '00000000-0000-0000-0000-00000000f0a1', 10000, 'COMPLETED'),
  ('rf_r5_2', 'sq_cap_r52', '00000000-0000-0000-0000-00000000f0a2',  4000, 'COMPLETED'),
  ('rf_r5_3', 'sq_cap_r53', '00000000-0000-0000-0000-00000000f0a3', 10000, 'PENDING'),
  ('rf_r5_4', 'sq_cap_r54', '00000000-0000-0000-0000-00000000f0a4', 10000, 'FAILED');

CREATE FUNCTION pg_temp.term(p_order text, p_refund text, p_preview boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.terminate_web_order_atomic(%L, %L, %L, %L, %L, %L, NULL, %L, %L)',
                            p_order, 'cancelled', 'test cancel', '00000000-0000-0000-0000-00000000aaaa', 'staff@example.com',
                            p_refund, 'staff', p_preview)) $$;

SELECT pg_temp.ok((pg_temp.term('00000000-0000-0000-0000-00000000f0a1', NULL, true) ->> 'card_refunded')::boolean,
                  'R05 preview flags a Square-refunded order (card_refunded = true)');
SELECT pg_temp.ok(NOT (pg_temp.term('00000000-0000-0000-0000-00000000f0a4', NULL, true) ->> 'card_refunded')::boolean,
                  'R05 preview: a FAILED Square refund does not count');

CREATE TEMP TABLE t_r51 AS SELECT pg_temp.term('00000000-0000-0000-0000-00000000f0a1', 'store_credit_issued', false) AS r;
SELECT pg_temp.ok((SELECT r ->> 'reason' = 'card_already_refunded' FROM t_r51)
                  AND (SELECT status = 'completed' FROM public.cash_orders WHERE invoice_number = 'TR51')
                  AND NOT EXISTS (SELECT 1 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-00000000f0a1'),
                  'R05 fully refunded in Square → store credit REFUSED, order untouched, no lot', (SELECT left(r::text, 300) FROM t_r51));
CREATE TEMP TABLE t_r52 AS SELECT pg_temp.term('00000000-0000-0000-0000-00000000f0a2', 'store_credit_issued', false) AS r;
SELECT pg_temp.ok((SELECT r ->> 'reason' = 'card_already_refunded' FROM t_r52)
                  AND NOT EXISTS (SELECT 1 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-00000000f0a2'),
                  'R05 partially refunded (¥4,000) → store credit REFUSED (no arithmetic, owner A)');
CREATE TEMP TABLE t_r53 AS SELECT pg_temp.term('00000000-0000-0000-0000-00000000f0a3', 'store_credit_issued', false) AS r;
SELECT pg_temp.ok((SELECT r ->> 'reason' = 'card_already_refunded' FROM t_r53),
                  'R05 a PENDING Square refund is committed money → store credit REFUSED');
-- the refund path still works on a refunded order
CREATE TEMP TABLE t_r54 AS SELECT pg_temp.term('00000000-0000-0000-0000-00000000f0a1', 'refund_pending', false) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'ok')::boolean FROM t_r54)
                  AND (SELECT status = 'cancelled' AND refund_status = 'refund_pending' FROM public.cash_orders WHERE invoice_number = 'TR51'),
                  'R05 "refund pending" on a Square-refunded order still cancels', (SELECT left(r::text, 300) FROM t_r54));
-- a FAILED refund means nothing went back: store credit is allowed and the 30/70 rule applies
CREATE TEMP TABLE t_r55 AS SELECT pg_temp.term('00000000-0000-0000-0000-00000000f0a4', 'store_credit_issued', false) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'ok')::boolean FROM t_r55)
                  AND (SELECT original_amount = 7000 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-00000000f0a4'),
                  'R05 FAILED refund only → store credit allowed, ¥7,000 lot (regression: 30/70 unchanged)', (SELECT left(r::text, 300) FROM t_r55));

-- ================================================================ R05 Hub cash order (cancel_cash_order_atomic)
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, source_channel, currency, order_date, total_amount, total_paid)
VALUES ('00000000-0000-0000-0000-00000000f0b1', '9051', '00000000-0000-0000-0000-0000000000c1', 'completed', 'hub_manual', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 2, 20000, 20000),
       ('00000000-0000-0000-0000-00000000f0b2', '9052', '00000000-0000-0000-0000-0000000000c1', 'completed', 'hub_manual', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 2, 20000, 20000);
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id) VALUES
  ('00000000-0000-0000-0000-00000000f0b1', 20000, 'JPY', 'square', 'sq_cap_b1'),
  ('00000000-0000-0000-0000-00000000f0b2', 20000, 'JPY', 'bank_transfer', NULL);
INSERT INTO public.square_refunds (square_refund_id, square_payment_id, cash_order_id, amount_jpy, status) VALUES
  ('rf_b1', 'sq_cap_b1', '00000000-0000-0000-0000-00000000f0b1', 20000, 'COMPLETED');
CREATE FUNCTION pg_temp.hub(p_order text, p_preview boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.cancel_cash_order_atomic(%L, %L, %L, %L, %L, %L)',
                            p_order, 'test cancel', '00000000-0000-0000-0000-00000000aaaa', 'staff@example.com', p_preview, 'staff')) $$;
SELECT pg_temp.ok((pg_temp.hub('00000000-0000-0000-0000-00000000f0b1', true) ->> 'card_refunded')::boolean, 'R05 HUB preview flags the Square refund');
CREATE TEMP TABLE t_hb1 AS SELECT pg_temp.hub('00000000-0000-0000-0000-00000000f0b1', false) AS r;
SELECT pg_temp.ok((SELECT r ->> 'raised' LIKE 'card_already_refunded:%' FROM t_hb1)
                  AND (SELECT status = 'completed' FROM public.cash_orders WHERE invoice_number = '9051')
                  AND NOT EXISTS (SELECT 1 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-00000000f0b1'),
                  'R05 HUB cancel of a Square-refunded order is refused, nothing minted', (SELECT left(r::text, 300) FROM t_hb1));
SELECT pg_temp.hub('00000000-0000-0000-0000-00000000f0b2', false);
SELECT pg_temp.ok((SELECT original_amount = 14000 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-00000000f0b2'),
                  'R05 HUB regression: bank-paid order still cancels with ¥14,000 credit (30/70)');

-- ================================================================ R05 reverse order: refund lands AFTER a cancellation credit
-- 9052 above was cancelled with ¥14,000 credit (bank-paid). Now Square reports a refund on a capture of that order.
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, captured_at, environment)
VALUES ('00000000-0000-0000-0000-00000000f0b2', 'sq_cap_b2', 'captured', true, 20000, now() - interval '2 days', 'sandbox');
CREATE TEMP TABLE t_rr AS SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_b2', 'sq_cap_b2', 'COMPLETED', 20000, 'x', now(), now(), '{}'::jsonb)$q$) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'ok')::boolean FROM t_rr)
                  AND (SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_refund_after_credit' AND metadata ->> 'refund_id' = 'rf_b2'),
                  'R05 a Square refund landing on an order already cancelled with store credit rings card_refund_after_credit', (SELECT left(r::text, 300) FROM t_rr));
SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_b2', 'sq_cap_b2', 'COMPLETED', 20000, 'x', now(), now() + interval '1 minute', '{}'::jsonb)$q$);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_refund_after_credit'),
                  'R05 the hourly re-poll of the same refund rings it only once');
-- a refund on an order WITHOUT a cancellation lot rings nothing extra (regression)
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, captured_at, environment)
VALUES ('00000000-0000-0000-0000-00000000f0a4', 'sq_cap_r54', 'captured', true, 10000, now() - interval '3 days', 'sandbox');
SELECT pg_temp.try($q$SELECT public.record_square_refund('rf_r5_4', 'sq_cap_r54', 'FAILED', 10000, 'x', now(), now(), '{}'::jsonb)$q$);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_refund_after_credit'),
                  'R05 regression: a FAILED refund, or an order with no lot, rings no card_refund_after_credit');

-- ================================================================ R01 columns
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'square_card_attempts' AND column_name = 'search_cursor')
                  AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'square_card_attempts' AND column_name = 'search_pages' AND column_default = '0'),
                  'R01 search_cursor / search_pages exist (pages default 0)');

-- ================================================================ R02 fair ordering
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency)
VALUES ('00000000-0000-0000-0000-00000000f0c1', 'TR02', '00000000-0000-0000-0000-0000000000c1', 'pending', 'CJ-W-TR02', 'web', 'JPY');
INSERT INTO public.square_card_attempts (id, cash_order_id, customer_id, reference, idempotency_key, amount_jpy, environment, location_id, status, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-00000000f0d1', '00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-0000000000c1', 'CJ-TR02-1', 'idem-r02-1', 1000, 'sandbox', 'L1', 'unknown', now() - interval '3 hours', now() - interval '3 hours'),
       ('00000000-0000-0000-0000-00000000f0d2', '00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-0000000000c1', 'CJ-TR02-2', 'idem-r02-2', 1000, 'sandbox', 'L1', 'unknown', now() - interval '2 hours', now() - interval '2 hours');
SELECT pg_temp.try($q$SELECT public.note_square_attempt_stuck('00000000-0000-0000-0000-00000000f0d1')$q$);
SELECT pg_temp.ok((SELECT a1.updated_at > a2.updated_at FROM public.square_card_attempts a1, public.square_card_attempts a2
                    WHERE a1.id = '00000000-0000-0000-0000-00000000f0d1' AND a2.id = '00000000-0000-0000-0000-00000000f0d2'),
                  'R02 a waiting attempt moves behind the untouched one in updated_at order');
SELECT pg_temp.ok((SELECT stuck_runs = 1 AND stuck_warned_at IS NULL FROM public.square_card_attempts WHERE id = '00000000-0000-0000-0000-00000000f0d1'),
                  'R02 regression: stuck_runs still counts, no bell before the 3rd run');

SELECT n, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, CASE WHEN pass THEN NULL ELSE detail END AS detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, 16 - count(*) FILTER (WHERE pass) AS failed_or_errored, 16 AS expected_checks FROM t_results;
ROLLBACK;
