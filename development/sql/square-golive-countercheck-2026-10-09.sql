-- Square go-live counter-check (2026-10-09 evening). NOT a migration — never applied to live.
-- Runs on a local copy carrying the live bodies AND
-- supabase/migrations/20261130180000_square_golive_countercheck.sql. One transaction, rolled back.
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

SELECT pg_temp.ok(position('card_disputed' IN pg_get_functiondef('public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)'::regprocedure)) > 0,
  'SANITY the fixed finalize body is installed');

INSERT INTO auth.users (id, email) VALUES ('84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'admin-test@example.com') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'admin') ON CONFLICT DO NOTHING;
INSERT INTO public.customers (id, full_name, email, mobile_number, customer_code, is_test) VALUES
  ('00000000-0000-0000-0000-0000000000c9', 'Dispute Customer', 'c9@example.com', '09011119999', 'CJ-2026-90009', false)
ON CONFLICT (id) DO NOTHING;
CREATE FUNCTION pg_temp.o(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000e0' || lpad(i::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.sp(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000e1' || lpad(i::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.sub(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000e2' || lpad(i::text, 2, '0'))::uuid $$;

-- Orders 1-4: open yen web orders of ¥10,000; Square CAPTURED ¥10,000 but the Hub has not recorded it
-- (the "Finish recording" state: a claimed submission with no ledger row).
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency,
                                order_date, total_amount, total_paid, remaining_balance)
SELECT pg_temp.o(i), 'GLC' || i, '00000000-0000-0000-0000-0000000000c9', 'pending', 'CJ-W-GLC' || i, 'web', 'JPY',
       (now() AT TIME ZONE 'Asia/Manila')::date - 3, 10000, 0, 10000
FROM generate_series(1, 4) i;
INSERT INTO public.square_payments (id, cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, captured_amount_jpy,
                                    authorized_at, captured_at, environment, currency)
SELECT pg_temp.sp(i), pg_temp.o(i), '00000000-0000-0000-0000-0000000000c9', 'sq_glc' || i, 'captured', true, 10000, 10000,
       now() - interval '2 days', now() - interval '1 day', 'sandbox', 'JPY'
FROM generate_series(1, 4) i;
INSERT INTO public.payment_submissions (id, cash_order_id, customer_id, submitted_amount, payment_method, status, square_payment_id, payment_date)
SELECT pg_temp.sub(i), pg_temp.o(i), '00000000-0000-0000-0000-0000000000c9', 10000, 'square', 'confirmed', pg_temp.sp(i), current_date
FROM generate_series(1, 4) i;
-- Orders 1 and 3: the bank took the money back (LOST). Order 4: an inquiry only (no money held).
INSERT INTO public.square_disputes (square_dispute_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, state)
VALUES ('dp_glc1', pg_temp.sp(1), 'sq_glc1', pg_temp.o(1), 10000, 'LOST'),
       ('dp_glc3', pg_temp.sp(3), 'sq_glc3', pg_temp.o(3), 10000, 'EVIDENCE_REQUIRED'),
       ('dp_glc4', pg_temp.sp(4), 'sq_glc4', pg_temp.o(4), 10000, 'INQUIRY_EVIDENCE_REQUIRED');

-- CODE-M1: "Finish recording" never books a capture the card network took back.
SELECT pg_temp.ok(r ->> 'error' = 'card_disputed', 'CODE-M1 finalize refuses a capture on an order with a LOST dispute', r::text)
  FROM (SELECT pg_temp.try(format('SELECT public.finalize_cash_submission_atomic(%L, %L, NULL, current_date, %L)',
                                  pg_temp.sub(1), '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'staff')) r) x;
SELECT pg_temp.ok((SELECT total_paid = 0 AND status::text = 'pending' FROM public.cash_orders WHERE id = pg_temp.o(1))
                  AND NOT EXISTS (SELECT 1 FROM public.cash_payments WHERE cash_order_id = pg_temp.o(1)),
  'CODE-M1 nothing written on the disputed order');
SELECT pg_temp.ok(r ->> 'error' = 'card_disputed', 'CODE-M1 finalize refuses while evidence is required (money held)', r::text)
  FROM (SELECT pg_temp.try(format('SELECT public.finalize_cash_submission_atomic(%L, %L, NULL, current_date, %L)',
                                  pg_temp.sub(3), '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'staff')) r) x;
-- Controls: no dispute, and an inquiry (no money held) still record.
SELECT pg_temp.ok(r ->> 'outcome' = 'recorded', 'CONTROL finalize records a capture with no dispute', r::text)
  FROM (SELECT pg_temp.try(format('SELECT public.finalize_cash_submission_atomic(%L, %L, NULL, current_date, %L)',
                                  pg_temp.sub(2), '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'staff')) r) x;
SELECT pg_temp.ok(r ->> 'outcome' = 'recorded', 'CONTROL an inquiry (no money held) does not block recording', r::text)
  FROM (SELECT pg_temp.try(format('SELECT public.finalize_cash_submission_atomic(%L, %L, NULL, current_date, %L)',
                                  pg_temp.sub(4), '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'staff')) r) x;

-- CODE-M1: the staff decision "record the capture on the order" refuses too (admin caller).
UPDATE public.square_payments SET exception = 'captured_unallocated', exception_at = now() WHERE id = pg_temp.sp(1);
UPDATE public.payment_submissions SET processing_started_at = NULL WHERE id = pg_temp.sub(1);
SELECT set_config('request.jwt.claims', json_build_object('sub', '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'role', 'authenticated')::text, true);
SELECT pg_temp.ok(r ->> 'error' = 'card_disputed', 'CODE-M1 decide record_on_order refuses on a disputed order', r::text)
  FROM (SELECT pg_temp.try(format('SELECT public.decide_square_case(%L, %L, %L, %L)',
                                  'exception', pg_temp.sp(1), 'record_on_order', 'test: bank took it back')) r) x;
SELECT set_config('request.jwt.claims', '', true);
SELECT pg_temp.ok((SELECT count(*) = 1 FROM public.payment_submissions WHERE cash_order_id = pg_temp.o(1)),
  'CODE-M1 no replacement submission was filed');

-- L1: record_square_dispute locks the order before it reads it.
SELECT pg_temp.ok(position('WHERE id = v_sq.cash_order_id FOR UPDATE' IN
  pg_get_functiondef('public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)'::regprocedure)) > 0,
  'L1 record_square_dispute locks the order first');

SELECT name, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result, left(coalesce(detail, ''), 160) AS detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) || ' passed, ' || count(*) FILTER (WHERE NOT pass) || ' failed' AS summary FROM t_results;
ROLLBACK;
