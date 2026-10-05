-- Square docs-gap acceptance tests (2026-10-05, migration 20261110100000). NOT a migration — never
-- applied to live. Runs on a local Postgres copy of the live schema (or the column-subset stub the
-- review used) with 20261110100000 applied, auth.uid() stubbed as current_setting('test.uid') and
-- is_staff / has_role answering true. One transaction, rolled back. Expected: 15 passed, 0 failed (before the migration: 5 passed, 10 failed).
\set QUIET on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;

-- one order, two holds, one submission
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'T900', '00000000-0000-0000-0000-0000000000c1', 'pending', 'CJ-W-T900');
INSERT INTO public.square_payments (id, cash_order_id, square_payment_id, status, test, amount_jpy, authorized_at, capture_by, risk_level, environment)
VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'sq_risk', 'authorized', true, 8640, now() - interval '1 day', now() + interval '6 days', 'PENDING', 'sandbox'),
       ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'sq_nocb_old', 'authorized', true, 8640, now() - interval '8 days', NULL, NULL, 'sandbox'),
       ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 'sq_nocb_new', 'authorized', true, 8640, now() - interval '2 days', NULL, NULL, 'sandbox'),
       ('00000000-0000-0000-0000-0000000000b4', '00000000-0000-0000-0000-0000000000a1', 'sq_nocb_warn', 'authorized', true, 8640, now() - interval '6 days', NULL, NULL, 'sandbox'),
       ('00000000-0000-0000-0000-0000000000b5', '00000000-0000-0000-0000-0000000000a1', 'sq_mism', 'authorized', true, 8640, now(), now() + interval '6 days', 'PENDING', 'sandbox');
UPDATE public.square_payments SET exception = 'amount_mismatch', exception_at = now() WHERE id = '00000000-0000-0000-0000-0000000000b5';

CREATE FUNCTION pg_temp.apply(p_id text, p_status text, p_risk text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.apply_square_payment_state(p_id, p_status, 8640, 0, 'JPY', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
                                           p_risk, NULL, NULL, 'reconcile', NULL) $$;

-- HUB-3: risk rises PENDING → HIGH on a live hold → one bell, no exception (no automatic void)
SELECT pg_temp.ok((pg_temp.apply('sq_risk', 'APPROVED', 'HIGH'))->>'to' = 'authorized', 'HUB-3 rise to HIGH keeps the hold authorised');
SELECT pg_temp.ok((SELECT exception IS NULL AND risk_level = 'HIGH' AND status = 'authorized'
                     FROM public.square_payments WHERE square_payment_id = 'sq_risk'), 'HUB-3 risk stored, no exception (reconcile never auto-voids it)');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_risk_high'), 'HUB-3 one card_risk_high bell');
SELECT pg_temp.ok((pg_temp.apply('sq_risk', 'APPROVED', 'HIGH'))->>'exception' IS NULL
                  AND (SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_risk_high'), 'HUB-3 HIGH again: no second bell');
SELECT pg_temp.ok((pg_temp.apply('sq_mism', 'APPROVED', 'HIGH'))->>'exception' IS NULL
                  AND (SELECT exception = 'amount_mismatch' FROM public.square_payments WHERE square_payment_id = 'sq_mism'),
                  'HUB-3 an open exception is left as it is');

-- HUB-7: CANCELED without capture_by → authorized_at + 7 days decides expired vs voided
SELECT pg_temp.ok((pg_temp.apply('sq_nocb_old', 'CANCELED', NULL))->>'to' = 'expired', 'HUB-7 no capture_by, authorised 8 days ago → expired');
SELECT pg_temp.ok((pg_temp.apply('sq_nocb_new', 'CANCELED', NULL))->>'to' = 'voided', 'HUB-7 no capture_by, authorised 2 days ago → voided');

-- HUB-7: hold warning falls back to authorized_at + 7 days, marked as an estimate
SELECT pg_temp.ok((public.ring_square_deadline_bells(now()))->>'hold_warnings' = '1', 'HUB-7 hold without capture_by is warned (6 days old)');
SELECT pg_temp.ok((SELECT body LIKE '%cancels this hold on about %' AND (metadata->>'capture_by_estimated')::boolean
                     FROM public.staff_notifications WHERE type = 'card_hold_expiring'), 'HUB-7 bell says the date is an estimate');

-- HUB-2 / HUB-8: evidence reminders only while Square waits for evidence and staff have not submitted it
INSERT INTO public.square_disputes (square_dispute_id, cash_order_id, square_payment_id, state, due_at, decision) VALUES
  ('d_req',      '00000000-0000-0000-0000-0000000000a1', 'sq_risk', 'EVIDENCE_REQUIRED',         now() + interval '12 hours', NULL),
  ('d_inq_req',  '00000000-0000-0000-0000-0000000000a1', 'sq_risk', 'INQUIRY_EVIDENCE_REQUIRED', now() + interval '12 hours', NULL),
  ('d_sent',     '00000000-0000-0000-0000-0000000000a1', 'sq_risk', 'EVIDENCE_REQUIRED',         now() + interval '12 hours', 'evidence_submitted'),
  ('d_proc',     '00000000-0000-0000-0000-0000000000a1', 'sq_risk', 'PROCESSING',                now() + interval '12 hours', NULL),
  ('d_inq_proc', '00000000-0000-0000-0000-0000000000a1', 'sq_risk', 'INQUIRY_PROCESSING',        now() + interval '12 hours', NULL),
  ('d_inq_cl',   '00000000-0000-0000-0000-0000000000a1', 'sq_risk', 'INQUIRY_CLOSED',            now() + interval '12 hours', NULL);
DO $$ DECLARE r jsonb := public.ring_square_deadline_bells(now()); BEGIN
  PERFORM pg_temp.ok(r->>'dispute_3d' = '2' AND r->>'dispute_1d' = '2', 'HUB-8 only the two waiting-for-evidence disputes ring', r::text);
END $$;
SELECT pg_temp.ok((SELECT bool_and(reminded_3d_at IS NULL) FROM public.square_disputes WHERE square_dispute_id IN ('d_sent','d_proc','d_inq_proc','d_inq_cl')),
                  'HUB-8 submitted / processing / closed are never stamped');

-- HUB-2: INQUIRY_CLOSED is closed for the ops counter and for decisions
SELECT set_config('test.uid', 'a0000000-0000-0000-0000-000000000001', true);
SELECT pg_temp.ok((public.square_ops_health())->>'disputes_open' = '5', 'HUB-2 disputes_open excludes INQUIRY_CLOSED (5 of 6 open)');
SELECT pg_temp.ok((public.decide_square_case('dispute', (SELECT id FROM public.square_disputes WHERE square_dispute_id = 'd_inq_cl'), 'evidence_submitted', NULL))->>'error' = 'state_mismatch',
                  'HUB-2 evidence_submitted refused on INQUIRY_CLOSED');
SELECT pg_temp.ok((public.decide_square_case('dispute', (SELECT id FROM public.square_disputes WHERE square_dispute_id = 'd_inq_cl'), 'other', 'closed by bank'))->>'error' IS NULL,
                  'HUB-2 "other" still allowed on INQUIRY_CLOSED');
SELECT pg_temp.ok((SELECT indexdef LIKE '%INQUIRY_CLOSED%' FROM pg_indexes WHERE indexname = 'idx_square_disputes_due'), 'HUB-2 due-date index excludes INQUIRY_CLOSED');

SELECT n, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM t_results;
ROLLBACK;
