-- ===========================================================================
-- Paidy follow-up (2026-10-04). docs/PAIDY.md "Integrity" + "Follow-up".
-- Review "Paidy API Integration Follow-Up Review 2026-10-04" R01–R18 and the
-- owner's hide-options requirement; owner answers 2026-10-04 (capture in the
-- Paidy dashboard, Hub auto-records · Paidy only when nothing is paid yet ·
-- fallback = staff press Reject · a refund on an unrecorded payment is held
-- for a staff decision).
--
-- What this adds:
--   1. Columns: paidy_payments.last_checked_at / check_failures (fair sweep,
--      R18); cash_payments.provider_capture_id, UNIQUE (a capture is recorded
--      once, R02).
--   2. paidy_checkout_attempts — the customer's Paidy window, persisted BEFORE
--      Paidy opens, so every other payment option is closed while it runs.
--   3. paidy_cases — the durable exception queue staff resolve (close failed,
--      captured but unrecorded, refund before recording, unmatched …).
--   4. paidy_webhook_events — the webhook inbox: stored before Paidy gets its
--      200; the sweep drains anything not processed (R08/R09).
--   5. cash_order_payment_lock(order) — ONE answer to "can this order take
--      another payment right now?" (owner hide-options rule, R16).
--   6. Guards: a Paidy-linked submission's money fields never change and it is
--      never re-queued once rejected/cancelled; no row is relabelled to or from
--      'paidy'; a non-Paidy cash submission is refused while Paidy holds the
--      order (R01/R03/R16). paidy_payments identity is immutable, never deleted.
--   7. file_paidy_submission_atomic / finalize_cash_submission_atomic — same
--      signatures, stricter: exact yen, JPY only, nothing paid before, the
--      capture bound to its own order/customer/amount, never a refunded
--      capture (R02/R14/R15/R17). Replaced in place under an md5 guard
--      (both were created by 20261102100000 and are unchanged on live).
--   8. start/end_paidy_checkout_attempt, open_paidy_case, resolve_paidy_case.
--
-- Idempotent: safe to re-run (the md5 guard accepts the old OR the new body).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Live-first guard (CLAUDE.md "FUNCTION CHANGES START FROM LIVE").
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_file text := md5(pg_get_functiondef('public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text)'::regprocedure));
  v_fin  text := md5(pg_get_functiondef('public.finalize_cash_submission_atomic(uuid, uuid, text, date, text)'::regprocedure));
BEGIN
  IF v_file <> 'fed1f3d0996490352cd9e82900c39102'
     AND position('stale_authorization' in pg_get_functiondef('public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'paidy follow-up: file_paidy_submission_atomic on this database is not the 20261102100000 body (md5 %) — stop and compare with live', v_file;
  END IF;
  IF v_fin <> 'bec077fd56cb9cda07dd41e0b8aa62df'
     AND position('capture_already_recorded' in pg_get_functiondef('public.finalize_cash_submission_atomic(uuid, uuid, text, date, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'paidy follow-up: finalize_cash_submission_atomic on this database is not the 20261102100000 body (md5 %) — stop and compare with live', v_fin;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_payments
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS check_failures integer NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.paidy_payments.last_checked_at IS
  'When paidy-reconcile last read this payment from Paidy (success or failure). The sweep takes the oldest first, so a failing row never starves the rest (R18).';

ALTER TABLE public.cash_payments
  ADD COLUMN IF NOT EXISTS provider_capture_id text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_payments_provider_capture
  ON public.cash_payments (provider_capture_id) WHERE provider_capture_id IS NOT NULL;
COMMENT ON COLUMN public.cash_payments.provider_capture_id IS
  'The provider capture this payment records (Paidy cap_…). UNIQUE: one capture is recorded once, on its own order (R02). Written only by finalize_cash_submission_atomic.';

-- ---------------------------------------------------------------------------
-- 2. paidy_checkout_attempts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.paidy_checkout_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id    uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  customer_id      uuid NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','filed','abandoned','expired')),
  amount_jpy       numeric(12,2) NOT NULL,
  paidy_payment_id text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  end_reason       text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_paidy_checkout_attempt_open
  ON public.paidy_checkout_attempts (cash_order_id) WHERE status = 'open';
COMMENT ON TABLE public.paidy_checkout_attempts IS
  'The customer''s Paidy window on a confirmed order, persisted BEFORE Paidy.launch (owner rule 2026-10-04: while Paidy is being processed the customer can pay no other way). Open → filed (authorisation filed) | abandoned (Paidy reported closed/rejected) | expired (30 min, nothing came back). An authorisation that arrives later through the webhook is still filed or released. Written only by start/end_paidy_checkout_attempt and file_paidy_submission_atomic.';
ALTER TABLE public.paidy_checkout_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paidy_checkout_attempts_staff_select ON public.paidy_checkout_attempts;
CREATE POLICY paidy_checkout_attempts_staff_select ON public.paidy_checkout_attempts
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.paidy_checkout_attempts FROM anon;
GRANT SELECT ON public.paidy_checkout_attempts TO authenticated;
GRANT ALL ON public.paidy_checkout_attempts TO service_role;

-- ---------------------------------------------------------------------------
-- 3. paidy_cases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.paidy_cases (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN (
                      'close_failed','captured_unrecorded','captured_no_submission',
                      'refund_before_record','refund_after_record','record_failed',
                      'unmatched_authorization','provider_unreadable','stale_authorization')),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  cash_order_id     uuid REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  paidy_payment_row uuid REFERENCES public.paidy_payments(id) ON DELETE RESTRICT,
  paidy_payment_id  text NOT NULL,
  submission_id     uuid,
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  attempts          integer NOT NULL DEFAULT 0,
  resolved_at       timestamptz,
  resolved_by       uuid,
  resolution        text,
  resolution_note   text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_paidy_case_open
  ON public.paidy_cases (paidy_payment_id, kind) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_paidy_cases_status ON public.paidy_cases (status, opened_at);
COMMENT ON TABLE public.paidy_cases IS
  'Durable Paidy exceptions staff must resolve (R03/R08/R16/R17/R18): a close Paidy did not accept (retried by paidy-reconcile), a capture the Hub could not record, a refund on a payment not yet recorded (owner: held for a staff decision), an authorisation with no order … One open case per payment and kind. Opened only by open_paidy_case (service role); resolved only by resolve_paidy_case (confirm_payment permission, written reason, audited). Nothing is ever applied to an order from a case automatically.';
ALTER TABLE public.paidy_cases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paidy_cases_staff_select ON public.paidy_cases;
CREATE POLICY paidy_cases_staff_select ON public.paidy_cases
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.paidy_cases FROM anon;
GRANT SELECT ON public.paidy_cases TO authenticated;
GRANT ALL ON public.paidy_cases TO service_role;

-- ---------------------------------------------------------------------------
-- 4. paidy_webhook_events (inbox)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.paidy_webhook_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paidy_payment_id text NOT NULL,
  event            text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  last_error       text
);
CREATE INDEX IF NOT EXISTS idx_paidy_webhook_events_pending
  ON public.paidy_webhook_events (next_attempt_at) WHERE processed_at IS NULL;
COMMENT ON TABLE public.paidy_webhook_events IS
  'Paidy webhook inbox (R08): one row per notification, stored BEFORE the 200. Only the payment id is kept — the body is unsigned and never trusted; processing reads Paidy back. paidy-reconcile drains rows still unprocessed. Service role only.';
ALTER TABLE public.paidy_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paidy_webhook_events_staff_select ON public.paidy_webhook_events;
CREATE POLICY paidy_webhook_events_staff_select ON public.paidy_webhook_events
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.paidy_webhook_events FROM anon;
GRANT SELECT ON public.paidy_webhook_events TO authenticated;
GRANT ALL ON public.paidy_webhook_events TO service_role;

-- ---------------------------------------------------------------------------
-- 5. cash_order_payment_lock
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_order_payment_lock(
  p_cash_order_id    uuid,
  p_ignore_paidy_row uuid DEFAULT NULL,
  p_ignore_attempts  boolean DEFAULT false)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE
    -- Paidy took money the Hub has not recorded and no staff decision closed it.
    WHEN EXISTS (
      SELECT 1 FROM public.paidy_payments pp
       WHERE pp.cash_order_id = p_cash_order_id AND pp.status = 'captured'
         AND pp.id IS DISTINCT FROM p_ignore_paidy_row
         AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                          WHERE s.paidy_payment_id = pp.id AND s.confirmed_payment_id IS NOT NULL)
         AND NOT EXISTS (SELECT 1 FROM public.paidy_cases c
                          WHERE c.paidy_payment_row = pp.id AND c.status = 'resolved'
                            AND c.kind IN ('captured_unrecorded','captured_no_submission','refund_before_record','record_failed')))
      THEN 'paidy_captured_unrecorded'
    -- A Paidy submission waiting for the capture, or a Confirm claimed but not recorded.
    WHEN EXISTS (
      SELECT 1 FROM public.payment_submissions s
       WHERE s.cash_order_id = p_cash_order_id AND s.paidy_payment_id IS NOT NULL
         AND s.paidy_payment_id IS DISTINCT FROM p_ignore_paidy_row
         AND (s.status IN ('submitted','under_review') OR (s.status = 'confirmed' AND s.confirmed_payment_id IS NULL)))
      THEN 'paidy_submission_pending'
    -- An authorisation Paidy still holds that no reviewer rejected (e.g. one
    -- waiting to be filed). Past its expiry it no longer holds the order.
    WHEN EXISTS (
      SELECT 1 FROM public.paidy_payments pp
       WHERE pp.cash_order_id = p_cash_order_id AND pp.status = 'authorized'
         AND pp.id IS DISTINCT FROM p_ignore_paidy_row
         AND coalesce(pp.expires_at, pp.authorized_at + interval '30 days') > now()
         AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                          WHERE s.paidy_payment_id = pp.id AND s.status IN ('rejected','cancelled')))
      THEN 'paidy_authorized'
    -- The customer's Paidy window is open right now.
    WHEN NOT p_ignore_attempts AND EXISTS (
      SELECT 1 FROM public.paidy_checkout_attempts a
       WHERE a.cash_order_id = p_cash_order_id AND a.status = 'open' AND a.expires_at > now())
      THEN 'paidy_checkout_open'
    -- Any other payment waiting for a reviewer (one pending payment per order).
    WHEN EXISTS (
      SELECT 1 FROM public.payment_submissions s
       WHERE s.cash_order_id = p_cash_order_id AND s.paidy_payment_id IS NULL
         AND (s.status IN ('submitted','under_review') OR (s.status = 'confirmed' AND s.confirmed_payment_id IS NULL)))
      THEN 'submission_pending'
    ELSE NULL
  END
$fn$;
REVOKE ALL ON FUNCTION public.cash_order_payment_lock(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_order_payment_lock(uuid, uuid, boolean) TO service_role;
COMMENT ON FUNCTION public.cash_order_payment_lock(uuid, uuid, boolean) IS
  'Why a cash order cannot take another payment now, or NULL. paidy_* reasons (captured_unrecorded, submission_pending, authorized, checkout_open) close EVERY other payment route, staff included (guard trigger); submission_pending is the ordinary one-pending-payment rule. Owner rule 2026-10-04: while Paidy is processing, nothing else; after a verified Reject / Paidy close the order opens again.';

-- ---------------------------------------------------------------------------
-- 6. Guards.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_payment_submission_paidy()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_lock text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payment_method = 'paidy' AND NEW.paidy_payment_id IS NULL THEN
      RAISE EXCEPTION 'paidy_submission_unlinked: a Paidy submission is filed only from Paidy''s own read-back' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.cash_order_id IS NOT NULL AND NEW.paidy_payment_id IS NULL
       AND NEW.status IN ('submitted','under_review') THEN
      v_lock := public.cash_order_payment_lock(NEW.cash_order_id);
      IF v_lock LIKE 'paidy%' THEN
        RAISE EXCEPTION 'paidy_in_progress: % — this order is being paid with Paidy; another payment is accepted only after staff Reject it', v_lock USING ERRCODE = 'P0001';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.paidy_payment_id IS NOT NULL THEN
    IF NEW.paidy_payment_id IS DISTINCT FROM OLD.paidy_payment_id
       OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
       OR NEW.submitted_amount IS DISTINCT FROM OLD.submitted_amount
       OR NEW.cash_order_id IS DISTINCT FROM OLD.cash_order_id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
      RAISE EXCEPTION 'paidy_submission_locked: a Paidy submission''s method, amount, order and customer never change — Reject it and the customer pays again another way' USING ERRCODE = 'P0001';
    END IF;
    IF OLD.status IN ('rejected','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'paidy_submission_ended: a rejected or cancelled Paidy submission is never re-queued' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF NEW.paidy_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'paidy_submission_locked: a submission cannot be linked to Paidy after it was filed' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.payment_method = 'paidy' AND OLD.payment_method IS DISTINCT FROM 'paidy' THEN
      RAISE EXCEPTION 'paidy_submission_locked: a submission cannot be relabelled as Paidy' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_payment_submission_paidy() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_payment_submission_paidy ON public.payment_submissions;
CREATE TRIGGER trg_guard_payment_submission_paidy
  BEFORE INSERT OR UPDATE ON public.payment_submissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_submission_paidy();

CREATE OR REPLACE FUNCTION public.guard_paidy_payment_identity()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'paidy_payment_locked: Paidy payment records are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.cash_order_id IS DISTINCT FROM OLD.cash_order_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.paidy_payment_id IS DISTINCT FROM OLD.paidy_payment_id
     OR NEW.amount_jpy IS DISTINCT FROM OLD.amount_jpy
     OR NEW.test IS DISTINCT FROM OLD.test THEN
    RAISE EXCEPTION 'paidy_payment_locked: a Paidy payment''s order, customer, id, amount and environment never change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_paidy_payment_identity() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_paidy_payment_identity ON public.paidy_payments;
CREATE TRIGGER trg_guard_paidy_payment_identity
  BEFORE UPDATE OR DELETE ON public.paidy_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_paidy_payment_identity();

-- ---------------------------------------------------------------------------
-- 7a. file_paidy_submission_atomic (same signature, stricter).
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
  v_lock    text;
BEGIN
  IF p_paidy_payment_id IS NULL OR p_paidy_payment_id !~ '^pay_[A-Za-z0-9_-]{6,80}$' THEN
    RETURN jsonb_build_object('error', 'bad_id');
  END IF;
  -- R14: exact whole yen, never a rounded comparison.
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 OR p_amount_jpy <> trunc(p_amount_jpy) THEN
    RETURN jsonb_build_object('error', 'bad_amount');
  END IF;

  -- The order lock serialises every Paidy filing and payment on this order.
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id
   FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;

  SELECT * INTO v_rec FROM public.paidy_payments WHERE paidy_payment_id = p_paidy_payment_id FOR UPDATE;
  IF v_rec.id IS NOT NULL THEN
    IF v_rec.cash_order_id <> v_order.id OR v_rec.customer_id IS DISTINCT FROM p_customer_id THEN
      RETURN jsonb_build_object('error', 'paidy_payment_other_order');
    END IF;
    -- Already filed and still live: the retry gets the same submission back.
    SELECT * INTO v_sub FROM public.payment_submissions
     WHERE paidy_payment_id = v_rec.id AND status IN ('submitted','under_review','confirmed')
     ORDER BY created_at DESC LIMIT 1;
    IF v_sub.id IS NOT NULL THEN
      UPDATE public.paidy_checkout_attempts
         SET status = 'filed', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = 'filed'
       WHERE cash_order_id = v_order.id AND status = 'open';
      RETURN jsonb_build_object('ok', true, 'outcome', 'existing', 'paidy_record_id', v_rec.id,
        'submission', jsonb_build_object('id', v_sub.id, 'status', v_sub.status,
          'submitted_amount', v_sub.submitted_amount, 'payment_date', v_sub.payment_date));
    END IF;
    IF v_rec.status <> 'authorized' THEN
      RETURN jsonb_build_object('error', 'paidy_payment_not_authorized', 'status', v_rec.status);
    END IF;
    -- Rejected by a reviewer OR cancelled: a deliberate end, never recovered
    -- as an "interrupted filing" (R03).
    IF EXISTS (SELECT 1 FROM public.payment_submissions
                WHERE paidy_payment_id = v_rec.id AND status IN ('rejected','cancelled')) THEN
      RETURN jsonb_build_object('error', 'paidy_payment_rejected_by_reviewer');
    END IF;
    v_outcome := 'recovered';
  END IF;

  -- The order must still be able to take THIS payment (R15: checked on the
  -- locked row, not on what the caller read before).
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'order_cannot_take_payment', 'status', v_order.status::text,
                              'payment_status', v_order.payment_status);
  END IF;
  IF v_order.currency::text <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'order_not_jpy');
  END IF;
  -- Owner 2026-10-04: Paidy only while nothing has been paid on the order.
  IF v_order.total_paid <> 0 THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'order_part_paid');
  END IF;
  IF coalesce(v_rec.amount_jpy, p_amount_jpy) <> v_order.remaining_balance THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'amount_differs_from_balance',
                              'amount_jpy', coalesce(v_rec.amount_jpy, p_amount_jpy), 'remaining_balance', v_order.remaining_balance);
  END IF;
  IF coalesce(p_expires_at, v_rec.expires_at, coalesce(p_authorized_at, now()) + interval '30 days') <= now() THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'expired');
  END IF;

  -- The record is written BEFORE the one-payment check, so an authorisation
  -- that has to wait is still known to the Hub (the sweep files or releases it).
  IF v_rec.id IS NULL THEN
    INSERT INTO public.paidy_payments (cash_order_id, customer_id, paidy_payment_id, status, test,
                                       amount_jpy, authorized_at, expires_at, last_payload)
    VALUES (v_order.id, p_customer_id, p_paidy_payment_id, 'authorized', coalesce(p_test, false),
            p_amount_jpy, coalesce(p_authorized_at, now()), p_expires_at, p_payload)
    RETURNING * INTO v_rec;
  ELSE
    UPDATE public.paidy_payments
       SET expires_at = coalesce(p_expires_at, expires_at),
           last_payload = coalesce(p_payload, last_payload),
           updated_at = now()
     WHERE id = v_rec.id
    RETURNING * INTO v_rec;
  END IF;

  -- One payment at a time per order: anything else pending, any other Paidy
  -- authorisation or capture still open (the customer's own open Paidy window
  -- is this payment, so attempts are ignored here).
  v_lock := public.cash_order_payment_lock(v_order.id, v_rec.id, true);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'submission_pending', 'lock', v_lock, 'paidy_record_id', v_rec.id);
  END IF;

  INSERT INTO public.payment_submissions (account_id, cash_order_id, customer_id, submitted_amount,
         payment_date, payment_method, reference_number, sender_name, proof_url, notes, status,
         submission_type, paidy_payment_id)
  VALUES (NULL, v_order.id, p_customer_id, v_rec.amount_jpy, p_payment_date, 'paidy',
          v_rec.paidy_payment_id, p_sender_name, NULL, p_notes, 'submitted', 'cash_payment', v_rec.id)
  RETURNING * INTO v_sub;

  UPDATE public.paidy_checkout_attempts
     SET status = 'filed', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = 'filed'
   WHERE cash_order_id = v_order.id AND status = 'open';

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
  VALUES ('cash_payment_submission', v_sub.id, 'submission_created',
          jsonb_build_object('cash_order_id', v_order.id, 'invoice_number', v_order.invoice_number,
            'amount', v_rec.amount_jpy, 'method', 'paidy', 'reference', v_rec.paidy_payment_id,
            'path', coalesce(p_path, 'website_paidy'), 'outcome', v_outcome));

  RETURN jsonb_build_object('ok', true, 'outcome', v_outcome, 'paidy_record_id', v_rec.id,
    'submission', jsonb_build_object('id', v_sub.id, 'status', v_sub.status,
      'submitted_amount', v_sub.submitted_amount, 'payment_date', v_sub.payment_date));
END
$fn$;
REVOKE ALL ON FUNCTION public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text) TO service_role;
COMMENT ON FUNCTION public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text) IS
  'Files a Paidy authorisation the caller has ALREADY read back from Paidy: paidy_payments + payment_submissions + audit_logs in one transaction under a lock on the order; closes the customer''s open checkout attempt. Outcomes created | existing | recovered. Errors: bad_id, bad_amount (not whole yen), order_not_found, order_cannot_take_payment, stale_authorization (detail order_not_jpy | order_part_paid | amount_differs_from_balance | expired — the caller releases it), paidy_payment_other_order, paidy_payment_not_authorized, paidy_payment_rejected_by_reviewer (rejected or cancelled: never re-filed), submission_pending (lock reason given; the paidy_payments record IS kept). service_role only.';

-- ---------------------------------------------------------------------------
-- 7b. finalize_cash_submission_atomic (same signature, Paidy binding).
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
  v_rec        public.paidy_payments%ROWTYPE;
  v_amount     numeric;
  v_captured   numeric;
  v_capture_id text;
  v_new_paid   numeric;
  v_new_remain numeric;
  v_full       boolean;
  v_status_before text;
  v_status_after  text;
BEGIN
  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('error', 'submission_not_found'); END IF;
  IF v_sub.cash_order_id IS NULL THEN RETURN jsonb_build_object('error', 'not_a_cash_submission'); END IF;

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

  IF v_sub.status <> 'confirmed' THEN
    RETURN jsonb_build_object('error', 'not_claimed', 'status', v_sub.status::text);
  END IF;
  IF v_order.status::text IN ('cancelled', 'expired') THEN
    RETURN jsonb_build_object('error', 'order_closed', 'status', v_order.status::text);
  END IF;

  v_amount := v_sub.submitted_amount;
  IF v_amount IS NULL OR v_amount <= 0 THEN RETURN jsonb_build_object('error', 'bad_amount'); END IF;

  -- A Paidy payment is recorded only as Paidy's own capture, bound to THIS
  -- order, customer and exact amount, never refunded, never twice (R02/R14/R17).
  IF v_sub.paidy_payment_id IS NOT NULL OR v_sub.payment_method = 'paidy' THEN
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_sub.paidy_payment_id FOR UPDATE;
    IF v_rec.id IS NULL OR v_rec.status <> 'captured' THEN
      RETURN jsonb_build_object('error', 'paidy_not_captured');
    END IF;
    IF v_rec.cash_order_id <> v_order.id OR v_rec.customer_id IS DISTINCT FROM v_order.customer_id
       OR v_sub.customer_id IS DISTINCT FROM v_order.customer_id THEN
      RETURN jsonb_build_object('error', 'paidy_binding_mismatch');
    END IF;
    IF v_order.currency::text <> 'JPY' OR v_amount <> trunc(v_amount) OR v_rec.amount_jpy <> v_amount THEN
      RETURN jsonb_build_object('error', 'paidy_amount_mismatch', 'submitted', v_amount, 'authorized', v_rec.amount_jpy);
    END IF;
    SELECT coalesce(sum((c->>'amount')::numeric), 0) INTO v_captured
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_rec.last_payload->'captures') = 'array'
                                     THEN v_rec.last_payload->'captures' ELSE '[]'::jsonb END) c;
    IF v_captured <> v_amount THEN
      RETURN jsonb_build_object('error', 'paidy_amount_mismatch', 'submitted', v_amount, 'captured', v_captured);
    END IF;
    IF coalesce(v_rec.refund_jpy, 0) <> 0
       OR EXISTS (SELECT 1 FROM public.paidy_refunds WHERE paidy_payment_row = v_rec.id) THEN
      RETURN jsonb_build_object('error', 'paidy_refunded');
    END IF;
    v_capture_id := v_rec.capture_id;
    IF v_capture_id IS NULL THEN RETURN jsonb_build_object('error', 'paidy_not_captured'); END IF;
    IF EXISTS (SELECT 1 FROM public.cash_payments WHERE provider_capture_id = v_capture_id) THEN
      RETURN jsonb_build_object('error', 'capture_already_recorded');
    END IF;
  END IF;

  -- INVARIANT 4 on the LOCKED balance.
  IF v_amount > v_order.remaining_balance + 0.005 THEN
    RETURN jsonb_build_object('error', 'exceeds_remaining',
      'submitted_amount', v_amount, 'remaining_balance', v_order.remaining_balance);
  END IF;

  INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method,
         reference_number, remarks, entered_by_user_id, submitted_by_type, submitted_by_name, provider_capture_id)
  VALUES (v_order.id, v_amount, v_order.currency, coalesce(p_date_paid, v_sub.payment_date),
          v_sub.payment_method, v_sub.reference_number, v_sub.notes, p_reviewer_user_id,
          p_submitted_by_type, v_sub.sender_name, v_capture_id)
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
            'date_paid', v_payment.date_paid, 'provider_capture_id', v_capture_id,
            'path', 'finalize_cash_submission_atomic'),
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
  'Records a CLAIMED cash-order payment submission in one transaction: cash_payments insert (Paidy: provider_capture_id), cash_orders totals/completed, submission confirmed + confirmed_payment_id, audit_logs confirm. Locks the submission, the order and (Paidy) the Paidy record. Idempotent (already_recorded). Errors: submission_not_found, not_a_cash_submission, cash_order_not_found, not_claimed, order_closed, bad_amount, exceeds_remaining; Paidy: paidy_not_captured, paidy_binding_mismatch, paidy_amount_mismatch (not whole yen / authorised / captured differs), paidy_refunded (a refund exists — staff decide), capture_already_recorded. service_role only.';

-- ---------------------------------------------------------------------------
-- 8. Checkout attempts and cases.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_paidy_checkout_attempt(
  p_cash_order_id uuid,
  p_customer_id   uuid,
  p_ttl_minutes   integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_lock    text;
  v_attempt public.paidy_checkout_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'order_cannot_take_payment');
  END IF;
  IF v_order.currency::text <> 'JPY' OR v_order.total_paid <> 0
     OR v_order.remaining_balance <= 0 OR v_order.remaining_balance <> trunc(v_order.remaining_balance) THEN
    RETURN jsonb_build_object('error', 'paidy_not_offered');
  END IF;

  UPDATE public.paidy_checkout_attempts
     SET status = 'expired', ended_at = now(), end_reason = 'timeout'
   WHERE cash_order_id = v_order.id AND status = 'open' AND expires_at <= now();

  v_lock := public.cash_order_payment_lock(v_order.id);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', v_lock);
  END IF;

  INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, amount_jpy, expires_at)
  VALUES (v_order.id, p_customer_id, v_order.remaining_balance,
          now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes, 30), 60))))
  RETURNING * INTO v_attempt;
  RETURN jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'expires_at', v_attempt.expires_at,
                            'amount_jpy', v_attempt.amount_jpy);
END
$fn$;
REVOKE ALL ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) TO service_role;
COMMENT ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) IS
  'Opens the customer''s Paidy window on her order BEFORE Paidy.launch — refused (payment_in_progress + lock reason) while any payment or Paidy attempt is open. The open attempt closes every other payment route (cash_order_payment_lock). service_role only (website POST /orders/:id/paidy/start).';

CREATE OR REPLACE FUNCTION public.end_paidy_checkout_attempt(
  p_attempt_id  uuid,
  p_customer_id uuid,
  p_reason      text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now(), end_reason = left(coalesce(p_reason, 'closed'), 40)
   WHERE id = p_attempt_id AND customer_id = p_customer_id AND status = 'open';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'ended', v_n = 1);
END
$fn$;
REVOKE ALL ON FUNCTION public.end_paidy_checkout_attempt(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_paidy_checkout_attempt(uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION public.end_paidy_checkout_attempt(uuid, uuid, text) IS
  'Ends the customer''s open Paidy window when Paidy reports it closed or rejected (no authorisation). An authorisation that nevertheless arrives later via the webhook is filed or released as usual. service_role only.';

CREATE OR REPLACE FUNCTION public.open_paidy_case(
  p_kind              text,
  p_paidy_payment_id  text,
  p_cash_order_id     uuid DEFAULT NULL,
  p_paidy_payment_row uuid DEFAULT NULL,
  p_submission_id     uuid DEFAULT NULL,
  p_detail            jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_case public.paidy_cases%ROWTYPE;
  v_new  boolean := false;
BEGIN
  SELECT * INTO v_case FROM public.paidy_cases
   WHERE paidy_payment_id = p_paidy_payment_id AND kind = p_kind AND status = 'open' FOR UPDATE;
  -- A case staff already resolved is not reopened by the next sweep seeing the
  -- same state; only a genuinely new event (detail.reopen = true) opens another.
  IF v_case.id IS NULL AND NOT coalesce((p_detail->>'reopen')::boolean, false)
     AND EXISTS (SELECT 1 FROM public.paidy_cases
                  WHERE paidy_payment_id = p_paidy_payment_id AND kind = p_kind AND status = 'resolved') THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'resolved_before', 'new', false);
  END IF;
  IF v_case.id IS NULL THEN
    BEGIN
      INSERT INTO public.paidy_cases (kind, paidy_payment_id, cash_order_id, paidy_payment_row, submission_id, detail)
      VALUES (p_kind, p_paidy_payment_id, p_cash_order_id, p_paidy_payment_row, p_submission_id, coalesce(p_detail, '{}'::jsonb))
      RETURNING * INTO v_case;
      v_new := true;
    EXCEPTION WHEN unique_violation THEN
      SELECT * INTO v_case FROM public.paidy_cases
       WHERE paidy_payment_id = p_paidy_payment_id AND kind = p_kind AND status = 'open' FOR UPDATE;
    END;
  END IF;
  IF NOT v_new THEN
    UPDATE public.paidy_cases
       SET last_seen_at = now(), attempts = attempts + 1,
           detail = detail || coalesce(p_detail, '{}'::jsonb),
           cash_order_id = coalesce(cash_order_id, p_cash_order_id),
           paidy_payment_row = coalesce(paidy_payment_row, p_paidy_payment_row),
           submission_id = coalesce(submission_id, p_submission_id)
     WHERE id = v_case.id
    RETURNING * INTO v_case;
  END IF;
  RETURN jsonb_build_object('ok', true, 'case_id', v_case.id, 'new', v_new);
END
$fn$;
REVOKE ALL ON FUNCTION public.open_paidy_case(text, text, uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_paidy_case(text, text, uuid, uuid, uuid, jsonb) TO service_role;
COMMENT ON FUNCTION public.open_paidy_case(text, text, uuid, uuid, uuid, jsonb) IS
  'Opens (or refreshes) the one open Paidy case of this kind for this payment; returns new = true only the first time (the caller bells then). service_role only.';

CREATE OR REPLACE FUNCTION public.resolve_paidy_case(
  p_case_id    uuid,
  p_resolution text,
  p_note       text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_case public.paidy_cases%ROWTYPE;
  v_rec  public.paidy_payments%ROWTYPE;
  v_sub  public.payment_submissions%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'confirm_payment') THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_resolution NOT IN ('handled_in_paidy','refunded_in_paidy','released','record_capture','no_action') THEN
    RETURN jsonb_build_object('error', 'bad_resolution');
  END IF;
  IF length(btrim(coalesce(p_note, ''))) < 5 THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  SELECT * INTO v_case FROM public.paidy_cases WHERE id = p_case_id FOR UPDATE;
  IF v_case.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_case.status <> 'open' THEN RETURN jsonb_build_object('error', 'already_resolved'); END IF;

  -- "Record this capture": a capture with no live submission gets a fresh
  -- Paidy-linked submission; the Hub then records it from Paidy's read-back
  -- (Confirm, or the next automatic sync). Provider-bound, never a hand entry (R18).
  IF p_resolution = 'record_capture' THEN
    IF v_case.kind NOT IN ('captured_unrecorded','captured_no_submission','record_failed') THEN
      RETURN jsonb_build_object('error', 'not_a_capture_case');
    END IF;
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    IF v_rec.id IS NULL OR v_rec.status <> 'captured' THEN RETURN jsonb_build_object('error', 'paidy_not_captured'); END IF;
    IF coalesce(v_rec.refund_jpy, 0) <> 0 THEN RETURN jsonb_build_object('error', 'paidy_refunded'); END IF;
    PERFORM 1 FROM public.cash_orders WHERE id = v_rec.cash_order_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.payment_submissions WHERE paidy_payment_id = v_rec.id
                AND (confirmed_payment_id IS NOT NULL OR status IN ('submitted','under_review','confirmed'))) THEN
      RETURN jsonb_build_object('error', 'submission_exists');
    END IF;
    INSERT INTO public.payment_submissions (account_id, cash_order_id, customer_id, submitted_amount,
           payment_date, payment_method, reference_number, sender_name, proof_url, notes, status,
           submission_type, paidy_payment_id)
    VALUES (NULL, v_rec.cash_order_id, v_rec.customer_id, v_rec.amount_jpy,
            (coalesce(v_rec.captured_at, now()) AT TIME ZONE 'Asia/Tokyo')::date, 'paidy',
            v_rec.paidy_payment_id, NULL, NULL, 'Paidy capture re-queued from a Paidy case: ' || btrim(p_note),
            'submitted', 'cash_payment', v_rec.id)
    RETURNING * INTO v_sub;
  END IF;

  UPDATE public.paidy_cases
     SET status = 'resolved', resolved_at = now(), resolved_by = v_uid,
         resolution = p_resolution, resolution_note = btrim(p_note),
         submission_id = coalesce(v_sub.id, submission_id)
   WHERE id = v_case.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('paidy_case', v_case.id, 'paidy_case_resolved',
          jsonb_build_object('kind', v_case.kind, 'paidy_payment_id', v_case.paidy_payment_id,
            'cash_order_id', v_case.cash_order_id, 'resolution', p_resolution, 'note', btrim(p_note),
            'submission_id', v_sub.id), v_uid);
  RETURN jsonb_build_object('ok', true, 'case_id', v_case.id, 'submission_id', v_sub.id);
END
$fn$;
REVOKE ALL ON FUNCTION public.resolve_paidy_case(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_paidy_case(uuid, text, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.resolve_paidy_case(uuid, text, text) IS
  'Staff close a Paidy case with a written reason (confirm_payment permission, audited). record_capture re-queues a captured payment that has no live submission as a Paidy-linked submission so the Hub records it from Paidy''s read-back. Nothing else is written to an order.';

CREATE OR REPLACE FUNCTION public.close_paidy_case_system(
  p_case_id    uuid,
  p_resolution text,
  p_note       text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.paidy_cases
     SET status = 'resolved', resolved_at = now(), resolved_by = NULL,
         resolution = left(coalesce(p_resolution, 'system'), 40), resolution_note = p_note
   WHERE id = p_case_id AND status = 'open';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
    VALUES ('paidy_case', p_case_id, 'paidy_case_resolved',
            jsonb_build_object('resolution', p_resolution, 'note', p_note, 'by', 'system'));
  END IF;
  RETURN jsonb_build_object('ok', true, 'closed', v_n = 1);
END
$fn$;
REVOKE ALL ON FUNCTION public.close_paidy_case_system(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_paidy_case_system(uuid, text, text) TO service_role;
COMMENT ON FUNCTION public.close_paidy_case_system(uuid, text, text) IS
  'The sweep closes a case whose condition Paidy itself has resolved (e.g. a retried close succeeded, or a captured payment got recorded). Audited as by system. service_role only.';

-- ---------------------------------------------------------------------------
-- 9. Self-checks.
-- ---------------------------------------------------------------------------
DO $chk$
BEGIN
  IF to_regclass('public.paidy_cases') IS NULL OR to_regclass('public.paidy_checkout_attempts') IS NULL
     OR to_regclass('public.paidy_webhook_events') IS NULL THEN
    RAISE EXCEPTION 'paidy follow-up: a table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_payment_submission_paidy')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_paidy_payment_identity') THEN
    RAISE EXCEPTION 'paidy follow-up: a guard trigger is missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.cash_order_payment_lock(uuid, uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.start_paidy_checkout_attempt(uuid, uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.open_paidy_case(text, text, uuid, uuid, uuid, jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.finalize_cash_submission_atomic(uuid, uuid, text, date, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.resolve_paidy_case(uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'paidy follow-up: a service-only function is executable by a client role';
  END IF;
  IF position('capture_already_recorded' in pg_get_functiondef('public.finalize_cash_submission_atomic(uuid, uuid, text, date, text)'::regprocedure)) = 0
     OR position('stale_authorization' in pg_get_functiondef('public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamptz, timestamptz, jsonb, date, text, text, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'paidy follow-up: a function body was not replaced';
  END IF;
END
$chk$;
