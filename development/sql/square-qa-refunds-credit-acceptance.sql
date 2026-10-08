-- Square QA S01/S04/S05 + B01 + cancellation-credit acceptance tests (2026-10-08, migration
-- 20261118100000). NOT a migration — never applied to live. Runs on a local Postgres copy of
-- the live schema (column-for-column copy of the tables these functions touch, the six live
-- function bodies byte-identical to live, helper functions not under test stubbed), with
-- auth.uid() = current_setting('test.uid') and is_staff / has_permission answering true.
-- One transaction, rolled back. Expected after the migration: 47 passed, 0 failed.
-- Before the migration most fail (functions/columns missing or old behaviour).
\set QUIET on
\set ON_ERROR_STOP off
\set ON_ERROR_ROLLBACK on
BEGIN;
CREATE TEMP TABLE t_results (n serial, name text, pass boolean, detail text);
CREATE FUNCTION pg_temp.ok(p_cond boolean, p_name text, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ INSERT INTO t_results (name, pass, detail) VALUES (p_name, coalesce(p_cond, false), p_detail) $$;
-- Run a statement; a raised error counts as a failed check instead of aborting the file.
CREATE FUNCTION pg_temp.try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r jsonb; BEGIN EXECUTE p_sql INTO r; RETURN r; EXCEPTION WHEN others THEN RETURN jsonb_build_object('raised', SQLERRM); END $$;

SELECT set_config('test.uid', '00000000-0000-0000-0000-00000000aaaa', false);
INSERT INTO public.customers (id, full_name, email, mobile_number) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Test Customer', 'a@example.com', '09011112222'),
  ('00000000-0000-0000-0000-0000000000c2', 'Test Customer', 'b@example.com', '09033334444');

-- ================================================================ S05 refund bells
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel)
VALUES ('00000000-0000-0000-0000-0000000005a1', 'T501', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-T501', 'web');
INSERT INTO public.square_refunds (square_refund_id, square_payment_id, cash_order_id, amount_jpy, status, provider_created_at) VALUES
  ('rf_6d',  'p1', '00000000-0000-0000-0000-0000000005a1', 5000, 'PENDING',   now() - interval '6 days'),
  ('rf_8d',  'p1', '00000000-0000-0000-0000-0000000005a1', 6000, 'PENDING',   now() - interval '8 days'),
  ('rf_15d', 'p1', '00000000-0000-0000-0000-0000000005a1', 7000, 'PENDING',   now() - interval '15 days'),
  ('rf_done','p1', '00000000-0000-0000-0000-0000000005a1', 8000, 'COMPLETED', now() - interval '20 days');
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, authorized_at, capture_by, environment)
VALUES ('00000000-0000-0000-0000-0000000005a1', 'sq_hold_near', 'authorized', true, 8640, now() - interval '6 days', now() + interval '1 day', 'sandbox');
-- updated_at rewritten hourly must not reset the age
UPDATE public.square_refunds SET updated_at = now();

CREATE TEMP TABLE t_r7 AS SELECT pg_temp.try($q$SELECT public.ring_square_deadline_bells(now())$q$) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'refund_7d')::int = 1 FROM t_r7), 'S05 one refund rings at 7 days', (SELECT r::text FROM t_r7));
SELECT pg_temp.ok((SELECT (r ->> 'hold_warnings')::int = 1 FROM t_r7), 'S05 regression: the hold-expiry bell still rings in the same run');
SELECT pg_temp.ok((SELECT count(*) = 2 FROM public.staff_notifications WHERE type = 'card_refund_pending'), 'S05 two bells in total (8d → 7-day, 15d → 14-day)');
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_refund_pending' AND metadata ->> 'stage' = '14d'
                     AND metadata ->> 'square_refund_id' = 'rf_15d' AND title LIKE '%contact Square support%'),
                  'S05 15-day refund rings the 14-day bell (support wording)');
SELECT pg_temp.ok((SELECT count(*) = 0 FROM public.staff_notifications WHERE type = 'card_refund_pending' AND metadata ->> 'square_refund_id' IN ('rf_6d','rf_done')),
                  'S05 6-day and completed refunds ring nothing');
SELECT pg_temp.ok((SELECT warned_7d_at IS NOT NULL AND warned_14d_at IS NOT NULL FROM public.square_refunds WHERE square_refund_id = 'rf_15d'),
                  'S05 14-day bell stamps both stages (no extra 7-day bell later)');
SELECT pg_temp.try($q$SELECT public.ring_square_deadline_bells(now())$q$);
SELECT pg_temp.ok((SELECT count(*) = 2 FROM public.staff_notifications WHERE type = 'card_refund_pending'), 'S05 second run rings nothing new');
UPDATE public.square_refunds SET provider_created_at = now() - interval '14 days 1 hour' WHERE square_refund_id = 'rf_8d';
CREATE TEMP TABLE t_r14 AS SELECT pg_temp.try($q$SELECT public.ring_square_deadline_bells(now())$q$) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'refund_14d')::int = 1 FROM t_r14)
                  AND (SELECT count(*) = 3 FROM public.staff_notifications WHERE type = 'card_refund_pending'),
                  'S05 the 8-day refund rings again once at 14 days');
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.square_ops_health()$q$) ->> 'refund_oldest_pending_at')::timestamptz
                   = (SELECT provider_created_at FROM public.square_refunds WHERE square_refund_id = 'rf_15d'),
                  'S05 health shows the oldest pending refund');

-- ================================================================ S01 stuck attempt
INSERT INTO public.square_card_attempts (id, cash_order_id, customer_id, reference, idempotency_key, amount_jpy, environment, location_id, status)
VALUES ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000000c1',
        'cja_stuck001', 'idem_stuck_0001', 8640, 'sandbox', 'L1', 'unknown'),
       ('00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-0000000005a1', '00000000-0000-0000-0000-0000000000c1',
        'cja_closed01', 'idem_closed_001', 8640, 'sandbox', 'L1', 'authorized');
SELECT pg_temp.try($q$SELECT public.note_square_attempt_stuck('00000000-0000-0000-0000-0000000001a1')$q$);
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.note_square_attempt_stuck('00000000-0000-0000-0000-0000000001a1')$q$) ->> 'bell')::boolean = false
                  AND (SELECT count(*) = 0 FROM public.staff_notifications WHERE type = 'card_attempt_stuck'), 'S01 no bell after 2 runs');
CREATE TEMP TABLE t_s3 AS SELECT pg_temp.try($q$SELECT public.note_square_attempt_stuck('00000000-0000-0000-0000-0000000001a1')$q$) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'bell')::boolean FROM t_s3)
                  AND (SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_attempt_stuck' AND body LIKE '%cja_stuck001%'),
                  'S01 one bell on the 3rd run, naming the reference');
SELECT pg_temp.try($q$SELECT public.note_square_attempt_stuck('00000000-0000-0000-0000-0000000001a1')$q$);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.staff_notifications WHERE type = 'card_attempt_stuck'), 'S01 4th run: no second bell');
SELECT pg_temp.ok(pg_temp.try($q$SELECT public.note_square_attempt_stuck('00000000-0000-0000-0000-0000000001a2')$q$) ->> 'error' = 'not_open',
                  'S01 a resolved attempt is not counted');
SELECT pg_temp.ok((SELECT status = 'unknown' FROM public.square_card_attempts WHERE reference = 'cja_stuck001'), 'S01 the attempt is never closed by the bell');
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.square_ops_health()$q$) ->> 'attempts_stuck')::int = 1, 'S01 health counts the stuck attempt');

-- ================================================================ S04 reassign
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, total_amount, loyalty_jpy_amount)
VALUES ('00000000-0000-0000-0000-0000000004a1', 'T401', '00000000-0000-0000-0000-0000000000c1', 'pending', 'CJ-W-T401', 'web', 8640, 8000),
       ('00000000-0000-0000-0000-0000000004a2', 'T402', '00000000-0000-0000-0000-0000000000c1', 'pending', 'CJ-W-T402', 'web', 8640, 8000);
INSERT INTO public.square_card_attempts (cash_order_id, customer_id, reference, idempotency_key, amount_jpy, environment, location_id, status)
VALUES ('00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000000c1', 'cja_reserved1', 'idem_reserved_01', 8640, 'sandbox', 'L1', 'reserved');
CREATE TEMP TABLE t_reassign AS
  SELECT pg_temp.try($q$SELECT public.reassign_order_owner_atomic('cash', '00000000-0000-0000-0000-0000000004a1', '00000000-0000-0000-0000-0000000000c2', 8000, 'test', '00000000-0000-0000-0000-00000000aaaa', false)$q$) AS r1,
         pg_temp.try($q$SELECT public.reassign_order_owner_atomic('cash', '00000000-0000-0000-0000-0000000004a2', '00000000-0000-0000-0000-0000000000c2', 8000, 'test', '00000000-0000-0000-0000-00000000aaaa', false)$q$) AS r2;
SELECT pg_temp.ok((SELECT r1::text LIKE '%"card_order"%' FROM t_reassign), 'S04 preview refuses an order with a reserved (unfiled) card attempt', (SELECT left(r1::text, 300) FROM t_reassign));
SELECT pg_temp.ok((SELECT r2::text NOT LIKE '%"card_order"%' AND r2 ->> 'raised' IS NULL FROM t_reassign), 'S04 an order with no card history is not refused for card', (SELECT left(r2::text, 300) FROM t_reassign));

-- ================================================================ B01 refund issued
-- card-only order, cancelled, refund pending, ¥10,000 card receipt
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, refund_status, currency)
VALUES ('00000000-0000-0000-0000-0000000001b1', 'T101', '00000000-0000-0000-0000-0000000000c1', 'cancelled', 'CJ-W-T101', 'web', 'refund_pending', 'JPY'),
       ('00000000-0000-0000-0000-0000000001b2', 'T102', '00000000-0000-0000-0000-0000000000c1', 'cancelled', 'CJ-W-T102', 'web', 'refund_pending', 'JPY');
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
VALUES ('00000000-0000-0000-0000-0000000001b1', 10000, 'JPY', 'square', 'sq_cap_b1'),
       ('00000000-0000-0000-0000-0000000001b2', 12000, 'JPY', 'bank_transfer', NULL);
CREATE FUNCTION pg_temp.mark(p_order text, p_method text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.mark_web_order_refund_issued_atomic(%L, %L, %L, current_date - 1, NULL)',
                            p_order, '00000000-0000-0000-0000-00000000aaaa', p_method)) $$;
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000001b1', 'card') ->> 'error' = 'no_completed_card_refund', 'B01 card: refused with no completed Square refund');
INSERT INTO public.square_refunds (square_refund_id, square_payment_id, cash_order_id, amount_jpy, status) VALUES
  ('rf_b1_pend', 'sq_cap_b1', '00000000-0000-0000-0000-0000000001b1', 6000, 'PENDING');
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000001b1', 'card') ->> 'error' = 'no_completed_card_refund', 'B01 card: a PENDING refund is not enough');
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000001b1', 'bank_transfer') ->> 'error' = 'method_mismatch', 'B01 card-paid order cannot be marked by bank transfer');
SELECT pg_temp.ok((SELECT refund_status = 'refund_pending' FROM public.cash_orders WHERE invoice_number = 'T101'), 'B01 refusals write nothing');
INSERT INTO public.square_refunds (square_refund_id, square_payment_id, cash_order_id, amount_jpy, status) VALUES
  ('rf_b1_done', 'sq_cap_b1', '00000000-0000-0000-0000-0000000001b1', 4000, 'COMPLETED');
CREATE TEMP TABLE t_b1 AS SELECT pg_temp.mark('00000000-0000-0000-0000-0000000001b1', 'card') AS r;
SELECT pg_temp.ok((SELECT (r ->> 'ok')::boolean AND (r ->> 'amount')::numeric = 4000 FROM t_b1), 'B01 card: records Square''s completed ¥4,000, not the gross ¥10,000', (SELECT r::text FROM t_b1));
SELECT pg_temp.ok((SELECT refund_status = 'refund_issued' FROM public.cash_orders WHERE invoice_number = 'T101'), 'B01 order now refund issued');
SELECT pg_temp.ok((SELECT (new_value_json ->> 'amount')::numeric = 4000 FROM public.audit_logs WHERE action = 'refund_marked_issued' AND entity_id = '00000000-0000-0000-0000-0000000001b1'),
                  'B01 audit records ¥4,000');
CREATE TEMP TABLE t_b1r AS SELECT pg_temp.mark('00000000-0000-0000-0000-0000000001b1', 'card') AS r;
SELECT pg_temp.ok((SELECT (r ->> 'already_recorded')::boolean AND (r ->> 'amount')::numeric = 4000 FROM t_b1r)
                  AND (SELECT count(*) = 1 FROM public.audit_logs WHERE action = 'refund_marked_issued' AND entity_id = '00000000-0000-0000-0000-0000000001b1'),
                  'B01 retry returns the same answer, writes nothing');
SELECT pg_temp.ok(pg_temp.mark('00000000-0000-0000-0000-0000000001b2', 'card') ->> 'error' = 'method_mismatch', 'B01 a bank-transfer order cannot be marked as card');
SELECT pg_temp.ok((pg_temp.mark('00000000-0000-0000-0000-0000000001b2', 'bank_transfer') ->> 'amount')::numeric = 12000, 'B01 bank transfer unchanged (records money received)');
-- mixed: ¥6,000 card + ¥4,000 bank transfer
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, refund_status, currency)
VALUES ('00000000-0000-0000-0000-0000000001b3', 'T103', '00000000-0000-0000-0000-0000000000c1', 'cancelled', 'CJ-W-T103', 'web', 'refund_pending', 'JPY');
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
VALUES ('00000000-0000-0000-0000-0000000001b3', 6000, 'JPY', 'square', 'sq_cap_b3'), ('00000000-0000-0000-0000-0000000001b3', 4000, 'JPY', 'bank_transfer', NULL);
SELECT pg_temp.ok((pg_temp.mark('00000000-0000-0000-0000-0000000001b3', 'bank_transfer') ->> 'amount')::numeric = 4000, 'B01 mixed payment: bank transfer records only the ¥4,000 non-card money, never the gross');

-- ================================================================ cancellation credit rule
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.cancellation_credit_split('JPY', DATE '2026-10-08', 10000, TIMESTAMPTZ '2026-10-08 23:59:59+08')$q$) ->> 'credit')::numeric = 10000,
                  'RULE 23:59 PHT on the order day → 100%');
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.cancellation_credit_split('JPY', DATE '2026-10-08', 10000, TIMESTAMPTZ '2026-10-09 00:00:01+08')$q$) ->> 'credit')::numeric = 7000,
                  'RULE 00:00:01 PHT next day → 70%');
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.cancellation_credit_split('JPY', DATE '2026-10-08', 10000, TIMESTAMPTZ '2026-10-09 00:50:00+09')$q$) ->> 'rule') = 'same_day',
                  'RULE order placed 00:30 JST (order_date = PHT 8 Oct), cancelled 00:50 JST → same day, not charged');
SELECT pg_temp.ok((SELECT (s ->> 'kept')::numeric = 12000 AND (s ->> 'credit')::numeric = 28000
                     FROM (SELECT pg_temp.try($q$SELECT public.cancellation_credit_split('JPY', DATE '2026-10-01', 40000, now())$q$) s) x),
                  'RULE part-paid ¥40,000 → ¥12,000 kept, ¥28,000 credit (owner example)');
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.cancellation_credit_split('JPY', DATE '2026-10-01', 12345, now())$q$) ->> 'kept')::numeric = 3704,
                  'RULE yen rounds half-up (12345 × 30% = 3703.5 → 3704)');
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.cancellation_credit_split('PHP', DATE '2026-10-01', 1000.55, now())$q$) ->> 'kept')::numeric = 300.17,
                  'RULE pesos round to 2 decimals');
SELECT pg_temp.ok((pg_temp.try($q$SELECT public.cancellation_credit_split('JPY', NULL, 5000, now())$q$) ->> 'credit')::numeric = 5000,
                  'RULE missing order date → never charged');

-- web order (terminate): money ¥10,000 by bank transfer
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency, order_date, total_amount, total_paid)
VALUES ('00000000-0000-0000-0000-0000000007a1', 'T701', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-T701', 'web', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date, 10000, 10000),
       ('00000000-0000-0000-0000-0000000007a2', 'T702', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-T702', 'web', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 1, 10000, 10000),
       ('00000000-0000-0000-0000-0000000007a3', 'T703', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-T703', 'web', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 3, 10000, 10000);
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method, provider_capture_id) VALUES
  ('00000000-0000-0000-0000-0000000007a1', 10000, 'JPY', 'bank_transfer', NULL),
  ('00000000-0000-0000-0000-0000000007a2', 10000, 'JPY', 'bank_transfer', NULL),
  ('00000000-0000-0000-0000-0000000007a3', 10000, 'JPY', 'square', 'sq_cap_703');
CREATE FUNCTION pg_temp.term(p_order text, p_refund text, p_preview boolean) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.terminate_web_order_atomic(%L, %L, %L, %L, %L, %L, NULL, %L, %L)',
                            p_order, 'cancelled', 'test cancel', '00000000-0000-0000-0000-00000000aaaa', 'staff@example.com',
                            p_refund, 'staff', p_preview)) $$;
CREATE TEMP TABLE t_prev AS SELECT pg_temp.term('00000000-0000-0000-0000-0000000007a2', NULL, true) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'store_credit_if_chosen')::numeric = 7000 AND (r ->> 'cancellation_charge')::numeric = 3000
                          AND r ->> 'cancellation_rule' = 'after_order_day' FROM t_prev),
                  'WEB preview (no decision yet) shows ¥7,000 credit, ¥3,000 charge', (SELECT left(r::text, 400) FROM t_prev));
SELECT pg_temp.term('00000000-0000-0000-0000-0000000007a1', 'store_credit_issued', false);
SELECT pg_temp.ok((SELECT original_amount = 10000 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-0000000007a1'),
                  'WEB same-day lot is ¥10,000');
SELECT pg_temp.term('00000000-0000-0000-0000-0000000007a2', 'store_credit_issued', false);
SELECT pg_temp.ok((SELECT original_amount = 7000 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-0000000007a2'),
                  'WEB cancelled after the order day → ¥7,000 credit lot');
SELECT pg_temp.ok((SELECT note_text LIKE '%30% cancellation charge kept: ¥3000%' FROM public.account_notes WHERE cash_order_id = '00000000-0000-0000-0000-0000000007a2'),
                  'WEB account note names the charge');
SELECT pg_temp.ok((SELECT (new_value_json -> 'cancellation_split' ->> 'kept')::numeric = 3000 FROM public.audit_logs WHERE action = 'cancel' AND entity_id = '00000000-0000-0000-0000-0000000007a2'),
                  'WEB audit records the split');
SELECT pg_temp.ok((pg_temp.term('00000000-0000-0000-0000-0000000007a3', NULL, true) ->> 'paid_by_card')::boolean, 'WEB preview flags a card-paid order');
CREATE TEMP TABLE t_t3 AS SELECT pg_temp.term('00000000-0000-0000-0000-0000000007a3', 'refund_issued', false) AS r;
SELECT pg_temp.ok((SELECT r ->> 'reason' = 'card_refund_needs_square' FROM t_t3)
                  AND (SELECT status = 'completed' FROM public.cash_orders WHERE invoice_number = 'T703'),
                  'WEB card order: "refund issued" at cancel refused, order untouched');
CREATE TEMP TABLE t_t4 AS SELECT pg_temp.term('00000000-0000-0000-0000-0000000007a3', 'refund_pending', false) AS r;
SELECT pg_temp.ok((SELECT (r ->> 'ok')::boolean FROM t_t4)
                  AND (SELECT refund_status = 'refund_pending' FROM public.cash_orders WHERE invoice_number = 'T703'),
                  'WEB card order: "refund pending" at cancel still works');

-- Hub cash order (cancel_cash_order_atomic)
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, source_channel, currency, order_date, total_amount, total_paid, shopify_order_id)
VALUES ('00000000-0000-0000-0000-0000000008a1', '801', '00000000-0000-0000-0000-0000000000c1', 'pending', 'hub_manual', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 2, 100000, 40001, NULL),
       ('00000000-0000-0000-0000-0000000008a2', '802', '00000000-0000-0000-0000-0000000000c1', 'completed', 'hub_manual', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date, 50000, 50000, NULL),
       ('00000000-0000-0000-0000-0000000008a3', '803', '00000000-0000-0000-0000-0000000000c1', 'completed', 'shopify', 'JPY', (now() AT TIME ZONE 'Asia/Manila')::date - 5, 30000, 30000, 'gid://shopify/Order/1');
INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, payment_method) VALUES
  ('00000000-0000-0000-0000-0000000008a1', 40001, 'JPY', 'bank_transfer'),
  ('00000000-0000-0000-0000-0000000008a2', 50000, 'JPY', 'cash'),
  ('00000000-0000-0000-0000-0000000008a3', 30000, 'JPY', 'shopify');
CREATE FUNCTION pg_temp.hub(p_order text, p_preview boolean, p_source text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.cancel_cash_order_atomic(%L, %L, %L, %L, %L, %L)',
                            p_order, 'test cancel', CASE WHEN p_source = 'staff' THEN '00000000-0000-0000-0000-00000000aaaa' END,
                            'staff@example.com', p_preview, p_source)) $$;
SELECT pg_temp.ok((pg_temp.hub('00000000-0000-0000-0000-0000000008a1', true, 'staff') ->> 'store_credit_to_issue')::numeric = 28001
                  AND (pg_temp.hub('00000000-0000-0000-0000-0000000008a1', true, 'staff') ->> 'cancellation_charge')::numeric = 12000,
                  'HUB preview: part-paid ¥40,001 after the order day → ¥12,000 kept, ¥28,001 credit');
SELECT pg_temp.hub('00000000-0000-0000-0000-0000000008a1', false, 'staff');
SELECT pg_temp.ok((SELECT original_amount = 28001 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-0000000008a1'), 'HUB lot ¥28,001');
SELECT pg_temp.hub('00000000-0000-0000-0000-0000000008a2', false, 'staff');
SELECT pg_temp.ok((SELECT original_amount = 50000 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-0000000008a2'), 'HUB same day → full ¥50,000');
SELECT pg_temp.hub('00000000-0000-0000-0000-0000000008a3', false, 'shopify_webhook');
SELECT pg_temp.ok((SELECT original_amount = 30000 FROM public.store_credit_lots WHERE source_cash_order_id = '00000000-0000-0000-0000-0000000008a3'), 'SHOPIFY keeps 100% (¥30,000, 5 days later)');

SELECT n, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, name, CASE WHEN pass THEN NULL ELSE detail END AS detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, 47 - count(*) FILTER (WHERE pass) AS failed_or_errored, 47 AS expected_checks FROM t_results;
ROLLBACK;
