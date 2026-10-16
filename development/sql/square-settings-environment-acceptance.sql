-- Settings card counts the live Square environment only (migration
-- 20261223100000). NOT a migration — never applied to live. Runs on the local
-- replay Postgres (scripts/structure-drift-audit replay) AFTER the migration,
-- one transaction, rolled back. Expected: 9 passed, 0 failed. Before the
-- migration 7 of the 9 fail (11 captured, 3 holds, 1 dispute, no 'environment' key)
-- — that is the defect QA saw on 2026-10-16.
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;

SET session_replication_role = replica;  -- fixtures only: no triggers / FK checks on the rows below
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-00000000aaaa', 'admin@example.com');
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-00000000aaaa', 'admin');
INSERT INTO public.customers (id, full_name, email, mobile_number, is_test) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Test Customer', 'a@example.com', '09011112222', true);
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency, order_date, total_amount, total_paid, remaining_balance)
VALUES ('00000000-0000-0000-0000-0000000003b1', 'TEST-3B1', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-3B1', 'web', 'JPY', current_date - 3, 10000, 10000, 0),
       ('00000000-0000-0000-0000-0000000003b2', 'TEST-3B2', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-3B2', 'web', 'JPY', current_date - 3, 20000, 20000, 0);
-- What production had on 2026-10-16: ONE production capture in the window and
-- TEN sandbox test captures; the card said 11.
INSERT INTO public.square_payments (id, cash_order_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy, captured_at, environment)
VALUES ('00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000003b1', 'sq_prod_cap', 'captured', false, 10000, 10000, now() - interval '2 days', 'production');
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy, captured_at, environment)
SELECT '00000000-0000-0000-0000-0000000003b2', 'sq_sand_cap_' || g, 'captured', true, 2000, 2000, now() - interval '1 day', 'sandbox'
  FROM generate_series(1, 10) g;
-- an old production capture outside the 30-day window, an untagged capture
-- (counts under the live environment), holds in both environments
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy, captured_at, environment)
VALUES ('00000000-0000-0000-0000-0000000003b1', 'sq_prod_old', 'captured', false, 500, 500, now() - interval '40 days', 'production'),
       ('00000000-0000-0000-0000-0000000003b1', 'sq_untagged_cap', 'captured', false, 700, 700, now() - interval '3 days', NULL),
       ('00000000-0000-0000-0000-0000000003b1', 'sq_prod_hold', 'authorized', false, 300, NULL, NULL, 'production'),
       ('00000000-0000-0000-0000-0000000003b2', 'sq_sand_hold_1', 'authorized', true, 300, NULL, NULL, 'sandbox'),
       ('00000000-0000-0000-0000-0000000003b2', 'sq_sand_hold_2', 'authorized', true, 300, NULL, NULL, 'sandbox');
-- one OPEN dispute on a sandbox payment, one closed (WON) on the production one
INSERT INTO public.square_disputes (square_dispute_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, state)
VALUES ('dp_sand_open', (SELECT id FROM public.square_payments WHERE square_payment_id = 'sq_sand_cap_1'), 'sq_sand_cap_1', '00000000-0000-0000-0000-0000000003b2', 2000, 'EVIDENCE_REQUIRED'),
       ('dp_prod_won',  '00000000-0000-0000-0000-0000000005b1', 'sq_prod_cap', '00000000-0000-0000-0000-0000000003b1', 10000, 'WON');
SET session_replication_role = origin;

-- The caller is an admin; the live environment follows the mode switch (the
-- settings guard is bypassed here ONLY because this is a fixture on a scratch DB).
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000aaaa', false);
CREATE FUNCTION pg_temp.mode(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  DELETE FROM public.system_settings WHERE key = 'square_mode';
  INSERT INTO public.system_settings (key, value) VALUES ('square_mode', to_jsonb(p));
  PERFORM set_config('session_replication_role', 'origin', true);
END $$;

-- T1–T4 mode On: production is live.
SELECT pg_temp.mode('on');
CREATE TEMP TABLE t_s1 AS SELECT public.get_square_settings() AS s;
SELECT pg_temp.ok((SELECT s ->> 'environment' = 'production' FROM t_s1), 'T1 On: the card names production', (SELECT s ->> 'environment' FROM t_s1));
SELECT pg_temp.ok((SELECT (s ->> 'captured_30d')::int = 2 FROM t_s1),
                  'T2 On: captured_30d = 2 (the production capture + the untagged one), never the 10 sandbox captures or the 40-day-old one',
                  (SELECT s ->> 'captured_30d' FROM t_s1));
SELECT pg_temp.ok((SELECT (s ->> 'authorized_now')::int = 1 FROM t_s1), 'T3 On: authorized_now = 1 (the production hold only)', (SELECT s ->> 'authorized_now' FROM t_s1));
SELECT pg_temp.ok((SELECT (s ->> 'disputes_open')::int = 0 FROM t_s1), 'T4 On: disputes_open = 0 (the open dispute is on a sandbox payment; the production one is WON)', (SELECT s ->> 'disputes_open' FROM t_s1));

-- T5–T7 mode Test: sandbox is live.
SELECT pg_temp.mode('test');
CREATE TEMP TABLE t_s2 AS SELECT public.get_square_settings() AS s;
SELECT pg_temp.ok((SELECT s ->> 'environment' = 'sandbox' AND (s ->> 'captured_30d')::int = 11 FROM t_s2),
                  'T5 Test: the card names sandbox and counts 10 sandbox captures + the untagged one', (SELECT s ->> 'captured_30d' FROM t_s2));
SELECT pg_temp.ok((SELECT (s ->> 'authorized_now')::int = 2 FROM t_s2), 'T6 Test: authorized_now = 2 sandbox holds', (SELECT s ->> 'authorized_now' FROM t_s2));
SELECT pg_temp.ok((SELECT (s ->> 'disputes_open')::int = 1 FROM t_s2), 'T7 Test: disputes_open = 1 (the sandbox dispute)', (SELECT s ->> 'disputes_open' FROM t_s2));

-- T8 mode Off: production stays the environment watched (same rule as square_ops_health).
SELECT pg_temp.mode('off');
SELECT pg_temp.ok((SELECT s ->> 'environment' = 'production' AND (s ->> 'captured_30d')::int = 2 FROM (SELECT public.get_square_settings() AS s) x),
                  'T8 Off: production is still what the card counts');

-- T9 every pre-existing key is still returned (the card keeps working).
SELECT pg_temp.ok((SELECT s ? 'found' AND s ? 'mode' AND s ? 'raw_mode' AND s ? 'app_id' AND s ? 'location_id' AND s ? 'agreement_min_jpy'
                      AND s ? 'updated_at' AND s ? 'updated_by_user_id' AND s ? 'updated_by_name' AND s ? 'audience' AND s ? 'card_customers'
                      AND s ? 'preflight' AND s ? 'can_change' AND s ? 'authorized_now' AND s ? 'captured_30d' AND s ? 'disputes_open' FROM t_s1),
                  'T9 every pre-existing top-level key is still present');

\set QUIET off
SELECT name, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, CASE WHEN pass THEN NULL ELSE detail END AS detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM t_results;
ROLLBACK;
