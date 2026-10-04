-- ===========================================================================
-- Paidy payment integrity (2026-10-04). docs/PAIDY.md "Integrity".
-- Review "Cha-Jewels-Paidy-Payment-Review-2026-10-04" P01–P12; owner answers
-- 2026-10-04 12:23 JST (Q1 c, Q2, Q3, Q4 a, Q5 Japan time).
--
-- What this adds:
--   1. paidy_payments.expires_at (Paidy's own expiry, P07) and
--      capture_started_at (when a reviewer Confirm asked Paidy to capture).
--   2. paidy_refunds — one row per Paidy refund id, idempotent (P11). Order
--      accounting is NEVER changed from it: refunds stay a staff decision.
--   3. payment_submissions.processing_started_at — the lease a reviewer Confirm
--      holds between its claim and the recorded payment (P02). A Paidy claim
--      whose lease is older than 5 minutes may be resumed ("Finish recording").
--   4. file_paidy_submission_atomic — the Paidy authorisation record, its
--      payment submission and the audit row in ONE transaction, under a lock on
--      the order (P01, P04). Idempotent on the Paidy payment id: a retry gets
--      the same submission back; an authorisation whose submission is missing
--      gets one (owner Q3: the money is with Paidy — staff Confirm it, the
--      customer never pays twice).
--   5. finalize_cash_submission_atomic — the cash payment, the order totals,
--      the submission link and the audit row in ONE transaction, under locks
--      on the order and the submission (P02; owner Q1 c: every cash-order
--      Confirm, any method). Idempotent: a submission already linked to a
--      payment returns that payment and writes nothing.
--
-- Both functions are SECURITY DEFINER, service_role only. No existing function
-- body is touched. Idempotent: safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_payments
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS capture_started_at timestamptz;
COMMENT ON COLUMN public.paidy_payments.expires_at IS
  'Paidy''s own expires_at for this authorisation (read back from Paidy). Null = not sent by Paidy; the Hub then falls back to authorized_at + 30 days (docs/PAIDY.md).';
COMMENT ON COLUMN public.paidy_payments.capture_started_at IS
  'Set by review-payment-submission just before it asks Paidy to capture. A row with this set and status still authorized is resolved by reading Paidy back, never by assuming the capture failed.';

ALTER TABLE public.payment_submissions
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
COMMENT ON COLUMN public.payment_submissions.processing_started_at IS
  'Lease stamped by review-payment-submission when a Confirm claims the submission; cleared when the payment is recorded. A Paidy submission left ''confirmed'' with no confirmed_payment_id and a lease older than 5 minutes was interrupted — staff resume it with "Finish recording".';

-- ---------------------------------------------------------------------------
-- 2. paidy_refunds
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.paidy_refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paidy_payment_row uuid NOT NULL REFERENCES public.paidy_payments(id) ON DELETE RESTRICT,
  cash_order_id     uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  refund_id         text NOT NULL UNIQUE,
  amount_jpy        numeric(12,2) NOT NULL CHECK (amount_jpy > 0),
  refunded_at       timestamptz,
  payload           jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paidy_refunds_payment ON public.paidy_refunds (paidy_payment_row);
COMMENT ON TABLE public.paidy_refunds IS
  'One row per refund Paidy reports on a captured payment (paidy-webhook / paidy-reconcile; UNIQUE refund_id makes a repeated notification a no-op). Recorded and belled only — order balances and refund decisions are never changed from here (docs/PAIDY.md).';
ALTER TABLE public.paidy_refunds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paidy_refunds_staff_select ON public.paidy_refunds;
CREATE POLICY paidy_refunds_staff_select ON public.paidy_refunds
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.paidy_refunds FROM anon;
GRANT SELECT ON public.paidy_refunds TO authenticated;
GRANT ALL ON public.paidy_refunds TO service_role;

-- ---------------------------------------------------------------------------
-- 3. file_paidy_submission_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_paidy_submission_atomic(
  p_cash_order_id    uuid,
  p_customer_id      uuid,
  p_paidy_payment_id text,
  p_amount_jpy       numeric,
  p_test             boolean,
  p_authorized_at    timestamptz,
  p_expires_at       timestamptz,
  p_payload          jsonb,
  p_payment_date     date,
  p_sender_name      text,
  p_notes            text,
  p_path             text DEFAULT 'website_paidy')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_rec     public.paidy_payments%ROWTYPE;
  v_sub     public.payment_submissions%ROWTYPE;
  v_outcome text := 'created';
BEGIN
  IF p_paidy_payment_id IS NULL OR p_paidy_payment_id !~ '^pay_[A-Za-z0-9_-]{6,80}$' THEN
    RETURN jsonb_build_object('error', 'bad_id');
  END IF;
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 THEN
    RETURN jsonb_build_object('error', 'bad_amount');
  END IF;

  -- The order lock serialises every Paidy filing on this order (P04): two
  -- authorisations finishing at the same moment cannot both pass the
  -- pending-submission check below.
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id
   FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;

  SELECT * INTO v_rec FROM public.paidy_payments WHERE paidy_payment_id = p_paidy_payment_id FOR UPDATE;
  IF v_rec.id IS NOT NULL THEN
    IF v_rec.cash_order_id <> v_order.id THEN
      RETURN jsonb_build_object('error', 'paidy_payment_other_order');
    END IF;
    -- Already filed and still live: the retry gets the same submission back.
    SELECT * INTO v_sub FROM public.payment_submissions
     WHERE paidy_payment_id = v_rec.id AND status IN ('submitted','under_review','confirmed')
     ORDER BY created_at DESC LIMIT 1;
    IF v_sub.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'outcome', 'existing', 'paidy_record_id', v_rec.id,
        'submission', jsonb_build_object('id', v_sub.id, 'status', v_sub.status,
          'submitted_amount', v_sub.submitted_amount, 'payment_date', v_sub.payment_date));
    END IF;
    -- Record without a live submission (an interrupted filing): give it one,
    -- but only while Paidy still holds it as an authorisation.
    IF v_rec.status <> 'authorized' THEN
      RETURN jsonb_build_object('error', 'paidy_payment_not_authorized', 'status', v_rec.status);
    END IF;
    -- A reviewer already REJECTED this authorisation (its close at Paidy may
    -- have failed): never hand it a new submission (review 2026-10-04 #3).
    IF EXISTS (SELECT 1 FROM public.payment_submissions
                WHERE paidy_payment_id = v_rec.id AND status = 'rejected') THEN
      RETURN jsonb_build_object('error', 'paidy_payment_rejected_by_reviewer');
    END IF;
    v_outcome := 'recovered';
  END IF;

  -- The order must still be able to take a payment — one rule for the
  -- website callback, the webhook and the hourly check (review 2026-10-04 #7).
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'order_cannot_take_payment', 'status', v_order.status::text,
                              'payment_status', v_order.payment_status);
  END IF;

  -- The record is written BEFORE the one-pending check, so an authorisation
  -- that has to wait behind another payment is still known to the Hub and the
  -- hourly check files or releases it later (review 2026-10-04 #4). Returning
  -- an error below does not roll this insert back (no exception is raised).
  IF v_rec.id IS NULL THEN
    INSERT INTO public.paidy_payments (cash_order_id, customer_id, paidy_payment_id, status, test,
                                       amount_jpy, authorized_at, expires_at, last_payload)
    VALUES (v_order.id, p_customer_id, p_paidy_payment_id, 'authorized', coalesce(p_test, false),
            round(p_amount_jpy), coalesce(p_authorized_at, now()), p_expires_at, p_payload)
    RETURNING * INTO v_rec;
  ELSE
    UPDATE public.paidy_payments
       SET expires_at = coalesce(p_expires_at, expires_at),
           last_payload = coalesce(p_payload, last_payload),
           updated_at = now()
     WHERE id = v_rec.id
    RETURNING * INTO v_rec;
  END IF;

  -- One pending payment per order (owner Q2). A transfer or card submission
  -- waiting for review, or a Confirm claimed but not yet recorded (status
  -- 'confirmed', no payment linked — the money may be with Paidy), blocks a
  -- Paidy filing (review 2026-10-04 #1).
  IF EXISTS (SELECT 1 FROM public.payment_submissions
              WHERE cash_order_id = v_order.id
                AND (status IN ('submitted','under_review')
                     OR (status = 'confirmed' AND confirmed_payment_id IS NULL))) THEN
    RETURN jsonb_build_object('error', 'submission_pending', 'paidy_record_id', v_rec.id);
  END IF;

  INSERT INTO public.payment_submissions (account_id, cash_order_id, customer_id, submitted_amount,
         payment_date, payment_method, reference_number, sender_name, proof_url, notes, status,
         submission_type, paidy_payment_id)
  VALUES (NULL, v_order.id, p_customer_id, round(v_rec.amount_jpy), p_payment_date, 'paidy',
          v_rec.paidy_payment_id, p_sender_name, NULL, p_notes, 'submitted', 'cash_payment', v_rec.id)
  RETURNING * INTO v_sub;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
  VALUES ('cash_payment_submission', v_sub.id, 'submission_created',
          jsonb_build_object('cash_order_id', v_order.id, 'invoice_number', v_order.invoice_number,
            'amount', round(v_rec.amount_jpy), 'method', 'paidy', 'reference', v_rec.paidy_payment_id,
            'path', coalesce(p_path, 'website_paidy'), 'outcome', v_outcome));

  RETURN jsonb_build_object('ok', true, 'outcome', v_outcome, 'paidy_record_id', v_rec.id,
    'submission', jsonb_build_object('id', v_sub.id, 'status', v_sub.status,
      'submitted_amount', v_sub.submitted_amount, 'payment_date', v_sub.payment_date));
END
$fn$;
REVOKE ALL ON FUNCTION public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text) TO service_role;
COMMENT ON FUNCTION public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text) IS
  'Files a Paidy authorisation the caller has ALREADY read back from Paidy: paidy_payments + payment_submissions + audit_logs in one transaction under a lock on the order. Outcomes created | existing (retry: same submission returned, nothing written) | recovered (record had no live submission: one is created). Errors: bad_id, bad_amount, order_not_found, order_cannot_take_payment, paidy_payment_other_order, paidy_payment_not_authorized, paidy_payment_rejected_by_reviewer, submission_pending (the paidy_payments record IS kept so the hourly check can file or release it). service_role only (website POST /orders/:id/paidy, paidy-reconcile).';

-- ---------------------------------------------------------------------------
-- 4. finalize_cash_submission_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_cash_submission_atomic(
  p_submission_id     uuid,
  p_reviewer_user_id  uuid,
  p_reviewer_notes    text,
  p_date_paid         date,
  p_submitted_by_type text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_sub        public.payment_submissions%ROWTYPE;
  v_order      public.cash_orders%ROWTYPE;
  v_payment    public.cash_payments%ROWTYPE;
  v_amount     numeric;
  v_new_paid   numeric;
  v_new_remain numeric;
  v_full       boolean;
  v_status_before text;
  v_status_after  text;
BEGIN
  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('error', 'submission_not_found'); END IF;
  IF v_sub.cash_order_id IS NULL THEN RETURN jsonb_build_object('error', 'not_a_cash_submission'); END IF;

  -- Order lock: concurrent confirms on different submissions of the same order
  -- see each other's balance (P04).
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sub.cash_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'cash_order_not_found'); END IF;

  -- Idempotent: already recorded → return it, write nothing.
  IF v_sub.confirmed_payment_id IS NOT NULL THEN
    SELECT * INTO v_payment FROM public.cash_payments WHERE id = v_sub.confirmed_payment_id;
    RETURN jsonb_build_object('ok', true, 'outcome', 'already_recorded',
      'cash_payment', to_jsonb(v_payment), 'cash_order', to_jsonb(v_order),
      'new_total_paid', v_order.total_paid, 'new_remaining', v_order.remaining_balance,
      'is_fully_paid', v_order.remaining_balance <= 0.005, 'status_after', v_order.status::text);
  END IF;

  -- The caller claims the submission (status 'confirmed') before any external
  -- call; recording an unclaimed submission is refused.
  IF v_sub.status <> 'confirmed' THEN
    RETURN jsonb_build_object('error', 'not_claimed', 'status', v_sub.status::text);
  END IF;
  IF v_order.status::text IN ('cancelled', 'expired') THEN
    RETURN jsonb_build_object('error', 'order_closed', 'status', v_order.status::text);
  END IF;

  -- A Paidy payment is recorded only once the Hub holds Paidy's capture
  -- (review 2026-10-04 #6): never money in the books that Paidy has not taken.
  IF v_sub.payment_method = 'paidy' AND v_sub.paidy_payment_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.paidy_payments
                      WHERE id = v_sub.paidy_payment_id AND status = 'captured') THEN
    RETURN jsonb_build_object('error', 'paidy_not_captured');
  END IF;

  v_amount := v_sub.submitted_amount;
  IF v_amount IS NULL OR v_amount <= 0 THEN RETURN jsonb_build_object('error', 'bad_amount'); END IF;
  -- INVARIANT 4 on the LOCKED balance.
  IF v_amount > v_order.remaining_balance + 0.005 THEN
    RETURN jsonb_build_object('error', 'exceeds_remaining',
      'submitted_amount', v_amount, 'remaining_balance', v_order.remaining_balance);
  END IF;

  INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method,
         reference_number, remarks, entered_by_user_id, submitted_by_type, submitted_by_name)
  VALUES (v_order.id, v_amount, v_order.currency, coalesce(p_date_paid, v_sub.payment_date),
          v_sub.payment_method, v_sub.reference_number, v_sub.notes, p_reviewer_user_id,
          p_submitted_by_type, v_sub.sender_name)
  RETURNING * INTO v_payment;

  v_status_before := v_order.status::text;
  v_new_paid   := round(v_order.total_paid + v_amount, 2);
  v_new_remain := greatest(0, round(v_order.remaining_balance - v_amount, 2));
  v_full       := v_new_remain <= 0.005;
  v_status_after := CASE WHEN v_full THEN 'completed' ELSE v_status_before END;

  UPDATE public.cash_orders
     SET total_paid = v_new_paid,
         remaining_balance = v_new_remain,
         status = CASE WHEN v_full THEN 'completed'::public.cash_order_status ELSE status END,
         completed_at = CASE WHEN v_full THEN now() ELSE completed_at END
   WHERE id = v_order.id
  RETURNING * INTO v_order;

  UPDATE public.payment_submissions
     SET status = 'confirmed',
         reviewer_user_id = p_reviewer_user_id,
         reviewer_notes = nullif(p_reviewer_notes, ''),
         confirmed_payment_id = v_payment.id,
         processing_started_at = NULL,
         updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_payment_submission', v_sub.id, 'confirm',
          jsonb_build_object('status', 'claimed', 'order_status', v_status_before),
          jsonb_build_object('cash_payment_id', v_payment.id, 'amount_confirmed', v_amount,
            'remaining_after', v_new_remain, 'status_after', v_status_after,
            'date_paid', v_payment.date_paid, 'path', 'finalize_cash_submission_atomic'),
          p_reviewer_user_id);

  RETURN jsonb_build_object('ok', true, 'outcome', 'recorded',
    'cash_payment', to_jsonb(v_payment), 'cash_order', to_jsonb(v_order),
    'new_total_paid', v_new_paid, 'new_remaining', v_new_remain,
    'is_fully_paid', v_full, 'status_after', v_status_after);
END
$fn$;
REVOKE ALL ON FUNCTION public.finalize_cash_submission_atomic(uuid, uuid, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_cash_submission_atomic(uuid, uuid, text, date, text) TO service_role;
COMMENT ON FUNCTION public.finalize_cash_submission_atomic(uuid, uuid, text, date, text) IS
  'Records a CLAIMED cash-order payment submission in one transaction: cash_payments insert, cash_orders total_paid / remaining_balance / completed, submission confirmed + confirmed_payment_id, audit_logs confirm. Locks the order and the submission. Idempotent (already_recorded). Errors: submission_not_found, not_a_cash_submission, cash_order_not_found, not_claimed, order_closed, paidy_not_captured (a Paidy submission whose paidy_payments row is not captured), bad_amount, exceeds_remaining. service_role only (review-payment-submission, every cash method).';

-- ---------------------------------------------------------------------------
-- 5. Self-checks.
-- ---------------------------------------------------------------------------
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'paidy_payments' AND column_name = 'expires_at') THEN
    RAISE EXCEPTION 'paidy integrity: paidy_payments.expires_at missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'payment_submissions' AND column_name = 'processing_started_at') THEN
    RAISE EXCEPTION 'paidy integrity: payment_submissions.processing_started_at missing';
  END IF;
  IF has_function_privilege('anon', 'public.finalize_cash_submission_atomic(uuid, uuid, text, date, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.finalize_cash_submission_atomic(uuid, uuid, text, date, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'paidy integrity: finalize_cash_submission_atomic is executable by a client role';
  END IF;
  IF has_function_privilege('anon', 'public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'paidy integrity: file_paidy_submission_atomic is executable by a client role';
  END IF;
END
$chk$;
