-- Square ops environment-true counters + card mark = refund decision (migration
-- 20261212100000). NOT a migration — never applied to live. Runs on the local
-- replay Postgres (scripts/structure-drift-audit replay), one transaction,
-- rolled back. Expected after the migration: 13 passed, 0 failed. Before it:
-- the function square_ops_counts does not exist, so the script stops at T1.
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;

SET session_replication_role = replica;  -- fixtures only: no triggers / FK checks on the rows below
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-00000000aaaa', 'staff@example.com');
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-00000000aaaa', 'admin');
INSERT INTO public.customers (id, full_name, email, mobile_number, is_test) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Test Customer', 'a@example.com', '09011112222', true);
-- Two card-paid, CANCELLED web orders waiting for "Mark refund issued": one per environment.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, refund_status, web_reference, source_channel, currency, order_date, total_amount, total_paid, remaining_balance)
VALUES ('00000000-0000-0000-0000-0000000003a1', 'TEST-3A1', '00000000-0000-0000-0000-0000000000c1', 'cancelled', 'refund_pending', 'CJ-W-3A1', 'web', 'JPY', current_date - 3, 10000, 10000, 0),
       ('00000000-0000-0000-0000-0000000003a2', 'TEST-3A2', '00000000-0000-0000-0000-0000000000c1', 'cancelled', 'refund_pending', 'CJ-W-3A2', 'web', 'JPY', current_date - 3, 20000, 20000, 0);
INSERT INTO public.cash_payments (id, cash_order_id, amount_paid, currency, payment_method, provider_capture_id, date_paid)
VALUES ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000003a1', 10000, 'JPY', 'square', 'sq_prod_3a1', current_date - 2),
       ('00000000-0000-0000-0000-0000000004a2', '00000000-0000-0000-0000-0000000003a2', 20000, 'JPY', 'square', 'sq_sand_3a2', current_date - 2);
INSERT INTO public.square_payments (id, cash_order_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy, captured_at, environment, cash_payment_id)
VALUES ('00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000003a1', 'sq_prod_3a1', 'captured', false, 10000, 10000, now() - interval '2 days', 'production', '00000000-0000-0000-0000-0000000004a1'),
       ('00000000-0000-0000-0000-0000000005a2', '00000000-0000-0000-0000-0000000003a2', 'sq_sand_3a2', 'captured', true, 20000, 20000, now() - interval '2 days', 'sandbox', '00000000-0000-0000-0000-0000000004a2');
-- Residue in BOTH environments: an open hold, an open attempt, an open (PENDING) refund, a dead event.
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, environment)
VALUES ('00000000-0000-0000-0000-0000000003a1', 'sq_hold_prod', 'authorized', false, 500, 'production'),
       ('00000000-0000-0000-0000-0000000003a2', 'sq_hold_sand1', 'authorized', true, 500, 'sandbox'),
       ('00000000-0000-0000-0000-0000000003a2', 'sq_hold_sand2', 'authorized', true, 500, 'sandbox');
INSERT INTO public.square_card_attempts (cash_order_id, customer_id, reference, amount_jpy, status, environment, test, idempotency_key, location_id)
VALUES ('00000000-0000-0000-0000-0000000003a2', '00000000-0000-0000-0000-0000000000c1', 'CJ-W-3A2', 500, 'reserved', 'sandbox', true, 'idem-3a2', 'LTEST');
INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
VALUES ('rf_prod_done',   '00000000-0000-0000-0000-0000000005a1', 'sq_prod_3a1', '00000000-0000-0000-0000-0000000003a1', 10000, 'COMPLETED'),
       ('rf_sand_done_a', '00000000-0000-0000-0000-0000000005a2', 'sq_sand_3a2', '00000000-0000-0000-0000-0000000003a2', 5000,  'COMPLETED'),
       ('rf_sand_done_b', '00000000-0000-0000-0000-0000000005a2', 'sq_sand_3a2', '00000000-0000-0000-0000-0000000003a2', 5000,  'COMPLETED'),
       ('rf_sand_pending','00000000-0000-0000-0000-0000000005a2', 'sq_sand_3a2', '00000000-0000-0000-0000-0000000003a2', 1000,  'PENDING');
-- one sandbox refund already decided by a person — the card mark must leave it alone
UPDATE public.square_refunds SET decision = 'partial_refund_order_kept', decided_at = now() - interval '1 day', decided_by = '00000000-0000-0000-0000-00000000aaaa'
 WHERE square_refund_id = 'rf_sand_done_b';
INSERT INTO public.square_webhook_events (event_id, event_type, status, environment, payload)
VALUES ('ev_dead_prod', 'dispute.created', 'dead', 'production', '{}'::jsonb),
       ('ev_dead_sand', 'payment.updated', 'dead', 'sandbox', '{}'::jsonb),
       ('ev_dead_unknown', 'dispute.created', 'dead', NULL, '{}'::jsonb),
       ('ev_fail_sand', 'refund.updated', 'failed', 'sandbox', '{}'::jsonb);
SET session_replication_role = origin;

-- The caller is staff; the live environment follows the mode switch (the
-- settings guard is bypassed here ONLY because this is a fixture on a scratch DB).
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000aaaa', false);
CREATE FUNCTION pg_temp.mode(p text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('session_replication_role', 'replica', true);
  DELETE FROM public.system_settings WHERE key = 'square_mode';
  INSERT INTO public.system_settings (key, value) VALUES ('square_mode', to_jsonb(p));
  PERFORM set_config('session_replication_role', 'origin', true);
END $$;
SELECT pg_temp.mode('on');

-- T1 production is live: counters are production only; unknown-environment rows count here.
CREATE TEMP TABLE t_h1 AS SELECT public.square_ops_health() AS h;
SELECT pg_temp.ok((SELECT h ->> 'environment' = 'production'
                      AND (h ->> 'holds_live')::int = 1 AND (h ->> 'attempts_open')::int = 0
                      AND (h ->> 'refunds_open')::int = 0 AND (h ->> 'events_dead')::int = 2 AND (h ->> 'events_backlog')::int = 0
                      AND (h ->> 'refunds_undecided')::int = 1 FROM t_h1),
                  'T1 live = production: 1 hold, 0 attempts, 0 open refunds, 2 dead events (1 production + 1 unknown), 1 undecided refund',
                  (SELECT (h - 'checkpoints' - 'other_environment')::text FROM t_h1));
SELECT pg_temp.ok((SELECT h -> 'other_environment' ->> 'environment' = 'sandbox'
                      AND (h -> 'other_environment' ->> 'holds_live')::int = 2 AND (h -> 'other_environment' ->> 'attempts_open')::int = 1
                      AND (h -> 'other_environment' ->> 'refunds_open')::int = 1 AND (h -> 'other_environment' ->> 'events_dead')::int = 1
                      AND (h -> 'other_environment' ->> 'events_backlog')::int = 1 AND (h -> 'other_environment' ->> 'refunds_undecided')::int = 2 FROM t_h1),
                  'T1 sandbox residue reported separately: 2 holds, 1 attempt, 1 open refund, 1 dead + 1 backlog event, 2 undecided refunds',
                  (SELECT (h -> 'other_environment')::text FROM t_h1));
SELECT pg_temp.ok((SELECT h ? 'last_run' AND h ? 'last_ok_at' AND h ? 'checkpoints' AND h ? 'refund_oldest_pending_at' AND h ? 'attempts_stuck'
                      AND h ? 'captured_unrecorded' AND h ? 'exceptions_open' AND h ? 'disputes_open' FROM t_h1),
                  'T1 every pre-existing top-level key is still present (the panel keeps working)');

-- T2 mode Test → sandbox is live; the same rows flip sides.
SELECT pg_temp.mode('test');
CREATE TEMP TABLE t_h2 AS SELECT public.square_ops_health() AS h;
SELECT pg_temp.ok((SELECT h ->> 'environment' = 'sandbox' AND (h ->> 'holds_live')::int = 2 AND (h ->> 'refunds_open')::int = 1
                      AND (h ->> 'events_dead')::int = 2 AND (h -> 'other_environment' ->> 'events_dead')::int = 1
                      AND (h -> 'other_environment' ->> 'holds_live')::int = 1 FROM t_h2),
                  'T2 mode Test: sandbox is live (2 holds, 1 open refund, 1 sandbox + 1 unknown dead event); production is the residue',
                  (SELECT (h - 'checkpoints')::text FROM t_h2));
SELECT pg_temp.mode('off');
SELECT pg_temp.ok((SELECT public.square_ops_health() ->> 'environment') = 'production', 'T2 mode Off keeps watching production');
SELECT pg_temp.mode('on');

-- T3 not staff → refused, as before.
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000bbbb', false);
SELECT pg_temp.ok(false, 'T3 not_staff refused');  -- replaced below if the call raised
DO $$ BEGIN PERFORM public.square_ops_health(); EXCEPTION WHEN sqlstate '42501' THEN
  UPDATE t_results SET pass = true, detail = 'raised 42501' WHERE name = 'T3 not_staff refused'; END $$;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000aaaa', false);
-- the counts helper is not for signed-in users
SELECT pg_temp.ok(NOT has_function_privilege('authenticated', 'public.square_ops_counts(text, boolean)', 'EXECUTE')
                  AND has_function_privilege('service_role', 'public.square_ops_counts(text, boolean)', 'EXECUTE')
                  AND has_function_privilege('authenticated', 'public.square_live_environment()', 'EXECUTE'),
                  'T3 ACL: square_ops_counts service_role only; square_live_environment readable by staff');

-- T4 card mark decides the undecided COMPLETED refunds of that order, nothing else.
CREATE TEMP TABLE t_m1 AS SELECT public.mark_web_order_refund_issued_atomic('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-00000000aaaa', 'card', current_date, NULL, NULL) AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 10000 FROM t_m1),
                  'T4 production order: card mark records ¥10,000', (SELECT r::text FROM t_m1));
SELECT pg_temp.ok((SELECT decision = 'order_cancelled_refunded' AND decided_by = '00000000-0000-0000-0000-00000000aaaa' AND decided_at IS NOT NULL
                      AND decision_note = 'Recorded by "Mark refund issued — card"' FROM public.square_refunds WHERE square_refund_id = 'rf_prod_done'),
                  'T4 its COMPLETED refund is decided order_cancelled_refunded by the same person');
SELECT pg_temp.ok((SELECT count(*) FROM public.square_refunds WHERE cash_order_id = '00000000-0000-0000-0000-0000000003a2' AND decision IS NOT NULL) = 1,
                  'T4 the other order''s refunds are untouched');
CREATE TEMP TABLE t_m2 AS SELECT public.mark_web_order_refund_issued_atomic('00000000-0000-0000-0000-0000000003a2', '00000000-0000-0000-0000-00000000aaaa', 'card', current_date, NULL, NULL) AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' AND (r ->> 'amount')::numeric = 10000 FROM t_m2),
                  'T4 sandbox order: card mark records the two COMPLETED refunds (¥10,000), not the PENDING one', (SELECT r::text FROM t_m2));
SELECT pg_temp.ok((SELECT decision FROM public.square_refunds WHERE square_refund_id = 'rf_sand_done_a') = 'order_cancelled_refunded'
                  AND (SELECT decision FROM public.square_refunds WHERE square_refund_id = 'rf_sand_done_b') = 'partial_refund_order_kept'
                  AND (SELECT decision FROM public.square_refunds WHERE square_refund_id = 'rf_sand_pending') IS NULL,
                  'T4 undecided COMPLETED → decided; a person''s earlier decision kept; PENDING left undecided');
SELECT pg_temp.ok((SELECT (public.square_ops_health() ->> 'refunds_undecided')::int) = 0, 'T4 the live panel shows 0 undecided afterwards');

\set QUIET off
SELECT name, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, CASE WHEN pass THEN NULL ELSE detail END AS detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM t_results;
ROLLBACK;
