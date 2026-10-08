-- Square QC adverse checks (2026-10-09). NOT a migration — never applied to live.
-- Runs on the local Postgres copy (one transaction, rolled back).
-- Every check states the CORRECT behaviour. Today a FAIL = a confirmed defect (QC ids in the name);
-- after the fixes this same file must report 0 failed.
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
DECLARE r jsonb; BEGIN EXECUTE p_sql INTO r; RETURN coalesce(r, '{}'::jsonb); EXCEPTION WHEN others THEN RETURN jsonb_build_object('raised', SQLERRM); END $$;
CREATE FUNCTION pg_temp.try_exec(p_sql text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE p_sql; RETURN 'ok'; EXCEPTION WHEN others THEN RETURN 'raised: ' || SQLERRM; END $$;

-- The live guard trigger on payment_submissions (body from 20261104100000, the only definition) —
-- the local copy does not carry the trigger, so install it for this transaction.
-- (inlined so the suite is reproducible from the repo)
CREATE OR REPLACE FUNCTION public.guard_provider_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  -- Paidy's own rules (link, relabel, money fields, re-queue, Paidy holds the
  -- order) live in trg_guard_payment_submission_paidy (Paidy follow-up). This
  -- trigger carries the CARD rules and the card side of the payment lock.

  -- Nothing is a card payment without its hold.
  IF lower(coalesce(NEW.payment_method, '')) = 'square' AND NEW.square_payment_id IS NULL THEN
    RAISE EXCEPTION 'square_link_required: a card (square) submission must carry its Square hold'
      USING ERRCODE = 'P0001';
  END IF;

  -- Owner 3A / SQ11: while a card attempt is in flight, a hold is live or
  -- captured card money is not recorded, no OTHER payment enters the queue for
  -- that order — a new submission, or a rejected/cancelled one restored. The
  -- card's own filing (square_payment_id set) is the one exception. Order row
  -- locked first, like the Paidy guard, so this check and
  -- reserve_square_attempt serialise.
  IF NEW.cash_order_id IS NOT NULL AND NEW.square_payment_id IS NULL
     AND NEW.status::text IN ('submitted','under_review')
     AND (TG_OP = 'INSERT' OR OLD.status::text NOT IN ('submitted','under_review')) THEN
    PERFORM 1 FROM public.cash_orders WHERE id = NEW.cash_order_id FOR UPDATE;
    IF public.square_order_unresolved(NEW.cash_order_id) THEN
      RAISE EXCEPTION 'card_payment_unresolved: a card payment on this order is still being processed — another payment is accepted only after it is declined, voided or recorded'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- A card submission keeps its money facts (SQ10): the reviewer branch,
    -- the finalizer and the card record all rely on them.
    IF OLD.square_payment_id IS NOT NULL AND (
         NEW.payment_method    IS DISTINCT FROM OLD.payment_method
      OR NEW.submitted_amount  IS DISTINCT FROM OLD.submitted_amount
      OR NEW.cash_order_id     IS DISTINCT FROM OLD.cash_order_id
      OR NEW.account_id        IS DISTINCT FROM OLD.account_id
      OR NEW.customer_id       IS DISTINCT FROM OLD.customer_id
      OR NEW.square_payment_id IS DISTINCT FROM OLD.square_payment_id) THEN
      RAISE EXCEPTION 'provider_submission_locked: method, amount, order, customer and card hold of a card submission cannot change'
        USING ERRCODE = 'P0001';
    END IF;
    -- Only file_square_authorization_atomic links a hold, at insert.
    IF OLD.square_payment_id IS NULL AND NEW.square_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'provider_submission_locked: a submission cannot be linked to a card hold after it was filed'
        USING ERRCODE = 'P0001';
    END IF;
    -- A card submission ends by Confirm (capture) or Reject (void), never by a
    -- plain cancel that would leave the hold on her card, and a rejected one is
    -- never re-queued (the hold was voided; she pays again).
    IF OLD.square_payment_id IS NOT NULL AND NEW.status::text = 'cancelled' AND OLD.status::text <> 'cancelled' THEN
      RAISE EXCEPTION 'card_submission_not_cancellable: reject it so the hold is voided' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.square_payment_id IS NOT NULL AND OLD.status::text IN ('rejected','cancelled')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'card_submission_ended: a rejected card submission is never re-queued — the customer pays again' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_provider_submission() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_provider_submission ON public.payment_submissions;
CREATE TRIGGER trg_guard_provider_submission
  BEFORE INSERT OR UPDATE ON public.payment_submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_provider_submission();

INSERT INTO public.user_roles (user_id, role) VALUES
  ('84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457', 'admin'), ('00000000-0000-0000-0000-00000000bbbb', 'staff') ON CONFLICT DO NOTHING;
CREATE FUNCTION pg_temp.admin() RETURNS uuid LANGUAGE sql AS $$ SELECT '84a8b62c-ec75-4eeb-8ec0-e43ad8ed3457'::uuid $$;
CREATE FUNCTION pg_temp.staff() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-00000000bbbb'::uuid $$;
INSERT INTO public.customers (id, full_name, email, mobile_number, customer_code, is_test) VALUES
  ('00000000-0000-0000-0000-0000000000c1', 'Card Customer', 'c1@example.com', '09011112222', 'CJ-2026-90001', false)
ON CONFLICT (id) DO NOTHING;
CREATE FUNCTION pg_temp.o(i int) RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-0000-0000-00000000f0' || lpad(i::text, 2, '0'))::uuid $$;
CREATE FUNCTION pg_temp.today() RETURNS text LANGUAGE sql AS $$ SELECT ((now() AT TIME ZONE 'Asia/Manila')::date)::text $$;

-- Orders 1-3: cancelled card-paid web orders awaiting a refund decision; ¥10,000 captured AND recorded
-- (square_payments.cash_payment_id linked to the ledger row).
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, refund_status, web_reference, source_channel, currency,
                                order_date, total_amount, total_paid, cancelled_at)
SELECT pg_temp.o(i), 'QC' || i, '00000000-0000-0000-0000-0000000000c1', 'cancelled', 'refund_pending', 'CJ-W-QC' || i, 'web', 'JPY',
       (now() AT TIME ZONE 'Asia/Manila')::date - 10, 10000, 10000, now() - interval '2 days'
FROM generate_series(1, 3) i;
INSERT INTO public.cash_payments (id, cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
SELECT ('00000000-0000-0000-0000-00000000a0' || lpad(i::text, 2, '0'))::uuid, pg_temp.o(i), 10000, 'JPY', 'square', 'sq_q' || i
FROM generate_series(1, 3) i;
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, authorized_at, captured_at,
                                    environment, cash_payment_id)
SELECT pg_temp.o(i), 'sq_q' || i, 'captured', true, 10000, now() - interval '9 days', now() - interval '8 days', 'sandbox',
       ('00000000-0000-0000-0000-00000000a0' || lpad(i::text, 2, '0'))::uuid
FROM generate_series(1, 3) i;
CREATE FUNCTION pg_temp.refund(pid text, rid text, st text, amt bigint) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, status)
  SELECT rid, sp.id, sp.square_payment_id, sp.cash_order_id, amt, st FROM public.square_payments sp WHERE sp.square_payment_id = pid $$;
CREATE FUNCTION pg_temp.record(i int, method text, who uuid, exc jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT pg_temp.try(format('SELECT public.mark_web_order_refund_issued_atomic(%L, %L, %L, %L::date, NULL, %L::jsonb)',
                            pg_temp.o(i), who, method, pg_temp.today(), exc::text)) $$;

-- =========================================================== F-03
-- A second capture on order 1 that was NEVER recorded on the ledger (captured_after_close,
-- resolved "refunded in Square") is fully refunded. The recorded capture sq_q1 was never refunded.
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, authorized_at, captured_at, environment)
VALUES (pg_temp.o(1), 'sq_q1_stray', 'captured', true, 10000, now() - interval '8 days', now() - interval '7 days', 'sandbox');
SELECT pg_temp.refund('sq_q1_stray', 'rf_stray', 'COMPLETED', 10000);
CREATE TEMP TABLE t_f03 AS SELECT pg_temp.record(1, 'card', pg_temp.admin()) AS r;
SELECT pg_temp.ok((SELECT coalesce(r ->> 'error', '') = 'no_completed_card_refund' FROM t_f03),
  'F-03 "Mark refund issued — card" counts only refunds of RECORDED captures (a refund of a stray, unrecorded capture is not her refund)',
  (SELECT r::text FROM t_f03));

-- =========================================================== F-04
-- Order 2: a partial Square refund COMPLETED (¥4,000) and a second one FAILED; an admin approved a
-- bank-transfer exception for the remaining ¥6,000. A non-admin then marks "card".
SELECT pg_temp.refund('sq_q2', 'rf_q2_ok', 'COMPLETED', 4000);
SELECT pg_temp.refund('sq_q2', 'rf_q2_failed', 'FAILED', 6000);
CREATE TEMP TABLE t_f04a AS SELECT pg_temp.try(format('SELECT public.approve_card_refund_exception_atomic(%L, %L, %L, %L, %L, 6000, NULL)',
       pg_temp.o(2), pg_temp.admin(), 'bank_transfer', 'rf_q2_failed', 'SQ-QC-2')) AS r;
SELECT pg_temp.ok((SELECT r ->> 'ok' = 'true' FROM t_f04a), 'F-04 setup: exception approved for ¥6,000', (SELECT r::text FROM t_f04a));
CREATE TEMP TABLE t_f04 AS SELECT pg_temp.record(2, 'card', pg_temp.staff()) AS r;
SELECT pg_temp.ok((SELECT r ? 'error' FROM t_f04),
  'F-04 while an exception is APPROVED, "Mark refund issued — card" is refused (else the approved bank transfer can never be recorded)',
  (SELECT r::text FROM t_f04));

-- =========================================================== F-02 (cancel side)
-- Order 4: a Hub (non-web) cash order paid by card, captured and recorded, then a chargeback LOST
-- (the bank pulled the money back). Cancelling it must not mint store credit for money already returned.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, currency, order_date, total_amount, total_paid)
VALUES (pg_temp.o(4), 'QC4', '00000000-0000-0000-0000-0000000000c1', 'completed', 'JPY',
        (now() AT TIME ZONE 'Asia/Manila')::date - 20, 10000, 10000);
INSERT INTO public.cash_payments (id, cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
VALUES ('00000000-0000-0000-0000-00000000a004', pg_temp.o(4), 10000, 'JPY', 'square', 'sq_q4');
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, authorized_at, captured_at, environment, cash_payment_id)
VALUES (pg_temp.o(4), 'sq_q4', 'captured', true, 10000, now() - interval '20 days', now() - interval '19 days', 'sandbox',
        '00000000-0000-0000-0000-00000000a004');
INSERT INTO public.square_disputes (square_dispute_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, state)
SELECT 'dp_q4', sp.id, sp.square_payment_id, sp.cash_order_id, 10000, 'LOST' FROM public.square_payments sp WHERE sp.square_payment_id = 'sq_q4';
CREATE TEMP TABLE t_f02 AS SELECT pg_temp.try(format('SELECT public.cancel_cash_order_atomic(%L, %L, %L, NULL, false, %L)',
       pg_temp.o(4), 'QC chargeback lost', pg_temp.admin(), 'staff')) AS r;
SELECT pg_temp.ok((SELECT coalesce(r ->> 'reason', r ->> 'error', r ->> 'raised', '') ILIKE '%dispute%'
                    OR NOT EXISTS (SELECT 1 FROM public.store_credit_lots WHERE source_cash_order_id = pg_temp.o(4)) FROM t_f02),
  'F-02 a card order whose chargeback was LOST is not cancelled into store credit (money already returned by the bank)',
  (SELECT r::text FROM t_f02));

-- =========================================================== F-02 (exception cap side)
-- Order 3: a Square refund FAILED, and a chargeback LOST for the full amount. The exception cap must be 0.
SELECT pg_temp.refund('sq_q3', 'rf_q3_failed', 'FAILED', 10000);
INSERT INTO public.square_disputes (square_dispute_id, square_payment_row, square_payment_id, cash_order_id, amount_jpy, state)
SELECT 'dp_q3', sp.id, sp.square_payment_id, sp.cash_order_id, 10000, 'LOST' FROM public.square_payments sp WHERE sp.square_payment_id = 'sq_q3';
CREATE TEMP TABLE t_f02b AS SELECT pg_temp.try(format('SELECT public.approve_card_refund_exception_atomic(%L, %L, %L, %L, %L, 10000, NULL)',
       pg_temp.o(3), pg_temp.admin(), 'bank_transfer', 'rf_q3_failed', 'SQ-QC-3')) AS r;
SELECT pg_temp.ok((SELECT coalesce(r ->> 'error', '') IN ('exception_nothing_owed', 'exception_over_cap') FROM t_f02b),
  'F-02 the refund-outside-Square cap subtracts a LOST chargeback (no second payout)', (SELECT r::text FROM t_f02b));

-- =========================================================== Q-UX1 (preview predicts the R05 refusal)
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency, order_date, total_amount, total_paid)
VALUES (pg_temp.o(6), 'QC6', '00000000-0000-0000-0000-0000000000c1', 'completed', 'CJ-W-QC6', 'web', 'JPY',
        (now() AT TIME ZONE 'Asia/Manila')::date - 3, 10000, 10000);
INSERT INTO public.cash_payments (id, cash_order_id, amount_paid, currency, payment_method, provider_capture_id)
VALUES ('00000000-0000-0000-0000-00000000a006', pg_temp.o(6), 10000, 'JPY', 'square', 'sq_q6');
INSERT INTO public.square_payments (cash_order_id, square_payment_id, status, test, amount_jpy, authorized_at, captured_at, environment, cash_payment_id)
VALUES (pg_temp.o(6), 'sq_q6', 'captured', true, 10000, now() - interval '4 days', now() - interval '3 days', 'sandbox', '00000000-0000-0000-0000-00000000a006');
SELECT pg_temp.refund('sq_q6', 'rf_q6', 'COMPLETED', 10000);
CREATE TEMP TABLE t_ux1 AS SELECT pg_temp.try(format('SELECT public.terminate_web_order_atomic(%L, %L, %L, %L, NULL, %L, NULL, %L, true)',
       pg_temp.o(6), 'cancelled', 'qc', pg_temp.admin(), 'store_credit_issued', 'staff')) AS r;
CREATE TEMP TABLE t_ux1b AS SELECT pg_temp.try(format('SELECT public.terminate_web_order_atomic(%L, %L, %L, %L, NULL, %L, NULL, %L, false)',
       pg_temp.o(6), 'cancelled', 'qc', pg_temp.admin(), 'store_credit_issued', 'staff')) AS r;
SELECT pg_temp.ok((SELECT r ->> 'reason' = 'card_already_refunded' FROM t_ux1b), 'R05 still holds: the real cancel with credit is refused (card_already_refunded)', (SELECT r::text FROM t_ux1b));
SELECT pg_temp.ok((SELECT coalesce((r ->> 'store_credit_if_chosen')::numeric, 0) = 0 OR r ? 'refusal' FROM t_ux1),
  'Q-UX1 the cancel PREVIEW does not promise store credit that the real cancel will refuse', (SELECT left(r::text, 200) FROM t_ux1));

-- =========================================================== F-01 / Q-DB1 (submission status)
-- A filed card submission (live hold) on order 5.
INSERT INTO public.cash_orders (id, invoice_number, customer_id, status, web_reference, source_channel, currency, order_date,
                                total_amount, total_paid, payment_status)
VALUES (pg_temp.o(5), 'QC5', '00000000-0000-0000-0000-0000000000c1', 'pending', 'CJ-W-QC5', 'web', 'JPY',
        (now() AT TIME ZONE 'Asia/Manila')::date, 10000, 0, 'pending_transfer');
INSERT INTO public.square_payments (id, cash_order_id, square_payment_id, status, test, amount_jpy, authorized_at, environment)
VALUES ('00000000-0000-0000-0000-00000000b005', pg_temp.o(5), 'sq_q5', 'authorized', true, 10000, now() - interval '1 hour', 'sandbox');
INSERT INTO public.payment_submissions (id, cash_order_id, customer_id, submitted_amount, payment_method, status, square_payment_id)
VALUES ('00000000-0000-0000-0000-00000000d005', pg_temp.o(5), '00000000-0000-0000-0000-0000000000c1', 10000, 'square', 'submitted',
        '00000000-0000-0000-0000-00000000b005');
SELECT pg_temp.ok(pg_temp.try_exec($q$UPDATE public.payment_submissions SET status = 'cancelled' WHERE id = '00000000-0000-0000-0000-00000000d005'$q$) LIKE '%card_submission_not_cancellable%',
  'SANITY the live guard trigger is installed in this run (a card submission cannot be plainly cancelled)');
SELECT pg_temp.ok(pg_temp.try_exec($q$UPDATE public.payment_submissions SET status = 'needs_clarification' WHERE id = '00000000-0000-0000-0000-00000000d005'$q$) LIKE 'raised%',
  'F-01 a card submission cannot be moved to needs_clarification (it would strand the live hold with no Confirm/Reject)');
SELECT pg_temp.ok(pg_temp.try_exec($q$UPDATE public.payment_submissions SET status = 'confirmed' WHERE id = '00000000-0000-0000-0000-00000000d005'$q$) LIKE 'raised%',
  'Q-DB1 a card submission cannot be set "confirmed" by a direct write (only the reviewer capture path, via finalize)');
SELECT pg_temp.ok(pg_temp.try_exec($q$UPDATE public.payment_submissions SET status = 'rejected' WHERE id = '00000000-0000-0000-0000-00000000d005'$q$) LIKE 'raised%',
  'Q-DB1 a card submission with a LIVE hold cannot be set "rejected" by a direct write (the hold would stay on her card)');

-- =========================================================== Q-DB2 (staff email exposure)
SELECT set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-4000-8000-0000000000aa', 'role', 'authenticated')::text, true);
SELECT pg_temp.ok(NOT has_function_privilege('authenticated', 'public.staff_bell_email_recipients()', 'EXECUTE'),
  'Q-DB2 staff_bell_email_recipients() is not executable by signed-in users (it returns staff email addresses)');

-- =========================================================== Q-DB3 (table grants, defence in depth)
SELECT pg_temp.ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['square_payments','square_refunds','square_disputes','square_card_attempts','square_webhook_events','square_attempts']) t
   WHERE to_regclass('public.' || t) IS NOT NULL AND (has_table_privilege('authenticated', 'public.' || t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
      OR has_table_privilege('authenticated', 'public.' || t, 'DELETE'))),
  'Q-DB3 signed-in users hold no INSERT/UPDATE/DELETE grant on the Square ledger tables (RLS is not the only wall)');

SELECT format('%s %s%s', CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END, name, CASE WHEN pass OR detail IS NULL THEN '' ELSE '  -> ' || left(detail, 300) END)
  FROM t_results ORDER BY n;
SELECT format('%s passed, %s failed', count(*) FILTER (WHERE pass), count(*) FILTER (WHERE NOT pass)) FROM t_results;
ROLLBACK;
