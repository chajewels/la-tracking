-- SQF01 acceptance (migration 20261129090000, owner D-SQF01 = A, Japan time). NOT a
-- migration — never applied to live. Runs on a local Postgres copy of live (the two cancel
-- RPC bodies byte-identical to live before the migration), one transaction, rolled back.
-- Expected after the migration: 12 passed, 0 failed. Before: the three "SQF01" checks fail.
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

-- The reviewer's reproduction, through the real RPCs (preview = no writes).
-- Web order created 8 Oct 2026 00:30 JST = 7 Oct 23:30 PHT → order_date written as 2026-10-07.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency, total_amount, order_date, created_at)
VALUES ('00000000-0000-0000-0000-0000000001a1', 'T1A1', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-T1A1', 'web', 'JPY', 10000, DATE '2026-10-07', TIMESTAMPTZ '2026-10-08 00:30:00+09'),
       ('00000000-0000-0000-0000-0000000001a2', 'T1A2', '00000000-0000-0000-0000-0000000000c1', 'completed', NULL, 'hub', 'JPY', 10000, DATE '2026-10-07', TIMESTAMPTZ '2026-10-08 00:30:00+09'),
       ('00000000-0000-0000-0000-0000000001a3', 'T1A3', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-T1A3', 'web', 'JPY', 10000, DATE '2026-10-05', TIMESTAMPTZ '2026-10-08 10:00:00+09');
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method)
VALUES ('00000000-0000-0000-0000-0000000001a1', 10000, 'JPY', 'bank_transfer'),
       ('00000000-0000-0000-0000-0000000001a2', 10000, 'JPY', 'bank_transfer'),
       ('00000000-0000-0000-0000-0000000001a3', 10000, 'JPY', 'bank_transfer');

-- 1. the formula itself
CREATE TEMP TABLE t_f1 AS SELECT public.cancellation_credit_split('JPY', DATE '2026-10-07', 10000, TIMESTAMPTZ '2026-10-08 12:00:00+09', TIMESTAMPTZ '2026-10-08 00:30:00+09') AS s;
SELECT pg_temp.ok((SELECT s ->> 'rule' = 'same_day' AND (s ->> 'credit')::numeric = 10000 AND s ->> 'order_day' = '2026-10-08' FROM t_f1),
                  'SQF01 formula: order 00:30 JST, cancel noon same Japan day → 100 %', (SELECT s::text FROM t_f1));
SELECT pg_temp.ok((public.cancellation_credit_split('JPY', DATE '2026-10-07', 10000, TIMESTAMPTZ '2026-10-09 00:00:01+09', TIMESTAMPTZ '2026-10-08 00:30:00+09') ->> 'kept')::numeric = 3000,
                  'formula: next Japan day 00:00:01 → 30 % kept');
SELECT pg_temp.ok((public.cancellation_credit_split('JPY', DATE '2026-10-07', 10000, TIMESTAMPTZ '2026-10-08 00:30:00+09', TIMESTAMPTZ '2026-10-07 23:30:00+09') ->> 'rule') = 'after_order_day',
                  'formula: the other midnight (23:30 JST order, 00:30 JST cancel) → after order day');
SELECT pg_temp.ok((public.cancellation_credit_split('JPY', DATE '2026-10-08', 10000, TIMESTAMPTZ '2026-10-08 23:59:59+09', TIMESTAMPTZ '2026-10-08 10:00:00+09') ->> 'rule') = 'same_day'
              AND (public.cancellation_credit_split('JPY', DATE '2026-10-08', 10000, TIMESTAMPTZ '2026-10-09 00:00:00+09', TIMESTAMPTZ '2026-10-08 10:00:00+09') ->> 'rule') = 'after_order_day',
                  'formula: 23:59:59 JST same day; 00:00:00 JST next day');
SELECT pg_temp.ok((public.cancellation_credit_split('JPY', DATE '2026-10-05', 10000, TIMESTAMPTZ '2026-10-08 11:00:00+09', TIMESTAMPTZ '2026-10-08 10:00:00+09') ->> 'order_day') = '2026-10-05',
                  'formula: an edited / typed order_date (≠ the instant''s PHT day) is read as a Japan day as it stands');
SELECT pg_temp.ok((public.cancellation_credit_split('JPY', DATE '2026-10-08', 10000, TIMESTAMPTZ '2026-10-08 23:59:59+09') ->> 'rule') = 'same_day'
              AND (public.cancellation_credit_split('JPY', DATE '2026-10-08', 10000, TIMESTAMPTZ '2026-10-09 00:00:00+09') ->> 'rule') = 'after_order_day',
                  'formula: 4-argument call (no instant) — the typed date is a Japan day, cancel day in JST');
SELECT pg_temp.ok((public.cancellation_credit_split('PHP', DATE '2026-10-01', 1000.55, now()) ->> 'kept')::numeric = 300.17
              AND (public.cancellation_credit_split('JPY', DATE '2026-10-01', 12345, now()) ->> 'kept')::numeric = 3704,
                  'formula: rounding unchanged (pesos 2 dp, yen whole)');

-- 2. through the real cancel RPCs (preview), at a fixed "now"
-- The RPCs use now() / v_now := now(); pin the transaction clock to noon JST on 8 Oct.
-- (now() is the transaction start; we re-begin via a savepoint-free trick: set a GUC and compare via split in the result.)
-- Instead of moving the clock, assert that the preview's split carries order_day = the Japan day, i.e. created_at reached the formula.
CREATE TEMP TABLE t_web AS SELECT pg_temp.try($q$SELECT public.terminate_web_order_atomic('00000000-0000-0000-0000-0000000001a1', 'cancelled', 'test', '00000000-0000-0000-0000-00000000aaaa', 'qa@example.com', 'store_credit_issued', NULL, 'staff', true)$q$) AS r;
SELECT pg_temp.ok((SELECT (r -> 'cancellation_split' ->> 'order_day') = '2026-10-08' AND (r -> 'cancellation_split' ->> 'zone') = 'Asia/Tokyo' FROM t_web),
                  'SQF01 terminate_web_order_atomic passes created_at: the preview''s order day is the Japan day (8 Oct, not the PHT 7 Oct)', (SELECT r::text FROM t_web));
CREATE TEMP TABLE t_hub AS SELECT pg_temp.try($q$SELECT public.cancel_cash_order_atomic('00000000-0000-0000-0000-0000000001a2', 'test', '00000000-0000-0000-0000-00000000aaaa', 'qa@example.com', true, 'staff')$q$) AS r;
SELECT pg_temp.ok((SELECT (r -> 'cancellation_split' ->> 'order_day') = '2026-10-08' FROM t_hub),
                  'SQF01 cancel_cash_order_atomic passes created_at: Hub cash order, same Japan day', (SELECT r::text FROM t_hub));
CREATE TEMP TABLE t_edit AS SELECT pg_temp.try($q$SELECT public.terminate_web_order_atomic('00000000-0000-0000-0000-0000000001a3', 'cancelled', 'test', '00000000-0000-0000-0000-00000000aaaa', 'qa@example.com', 'store_credit_issued', NULL, 'staff', true)$q$) AS r;
SELECT pg_temp.ok((SELECT (r -> 'cancellation_split' ->> 'order_day') = '2026-10-05' AND (r -> 'cancellation_split' ->> 'rule') = 'after_order_day' FROM t_edit),
                  'edited order_date (5 Oct) on an order created 8 Oct: the edit stands, cancel today is after it', (SELECT r::text FROM t_edit));
-- the money figures still come out of the same split
SELECT pg_temp.ok((SELECT (r ->> 'store_credit_to_issue')::numeric = 7000 AND (r ->> 'cancellation_charge')::numeric = 3000 FROM t_edit),
                  'edited-date order: 30 % kept / 70 % credit in the preview figures');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'cancellation_credit_split' AND pronargs = 4),
                  'the 4-argument overload is gone (no ambiguous calls)');

SELECT format('%s passed, %s failed', count(*) FILTER (WHERE pass), count(*) FILTER (WHERE NOT pass)) AS result FROM t_results;
SELECT n, name, detail FROM t_results WHERE NOT pass ORDER BY n;
ROLLBACK;
