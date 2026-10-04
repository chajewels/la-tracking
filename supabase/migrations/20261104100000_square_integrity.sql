-- ===========================================================================
-- Square card payment integrity (2026-10-04). docs/SQUARE.md "Integrity",
-- docs/SQUARE-INTEGRITY.md. Review "Square-Payment-Integration-Deep-Review-
-- 2026-10-04" SQ01–SQ23 + section 8; owner answers 2026-10-04 (1A–6A, fraud
-- auto-cancel, production keys later).
--
-- What this adds:
--   1. square_card_attempts — one row per CreatePayment, written under the
--      order lock BEFORE Square is called, with the immutable request (amount,
--      currency, location, environment, idempotency key, reference). Square's
--      reference_id carries the attempt reference, so every webhook and every
--      listing correlates to an attempt (SQ03, SQ04, SQ05).
--   2. square_payments: provider version/status, captured amount, the ledger
--      link (cash_payment_id, unique), Confirm/Reject claim (action), exception
--      tracking, agreement binding, verification evidence (SQ06–SQ09, SQ13,
--      SQ18, SQ20).
--   3. square_webhook_events becomes a durable inbox: status, attempts, lease,
--      next retry, completion (SQ01, SQ02).
--   4. square_refunds and square_disputes — one row per provider id, each with
--      its own lifecycle and a staff decision (SQ15, SQ16; owner 2A).
--   5. guard_provider_submission — a card/Paidy submission cannot be relabelled,
--      re-amounted or moved; a card submission cannot be customer-cancelled;
--      nothing becomes 'square' without its hold (SQ10).
--   6. The atomic functions every Square path uses (SECURITY DEFINER,
--      service_role only unless marked staff): square_order_unresolved,
--      reserve_square_attempt, resolve_square_attempt,
--      file_square_authorization_atomic, apply_square_payment_state,
--      claim_square_action, release_square_action, record_square_refund,
--      record_square_dispute, ring_square_deadline_bells, claim_square_event,
--      finish_square_event, square_fraud_cancel; staff: decide_square_case,
--      square_settlement_report.
--   7. finalize_cash_submission_atomic — Square guard + ledger binding (SQ08).
--   8. terminate_web_order_atomic — automated termination also stands down for
--      a claimed-but-unrecorded Confirm; every termination stands down while a
--      card attempt/hold/capture is unresolved (SQ10, SQ11).
--   9. cash_order_payment_lock (Paidy follow-up, 20261103100000) answers
--      'card_payment_unresolved' too, so the ONE "can this order take another
--      payment?" answer covers card money (owner 3A): Paidy start / filing,
--      the portal, the website, submit-cash-payment and expiry all follow it.
--
-- 7, 8 and 9 are full replacements built from the LIVE bodies (prosrc md5
-- ebb5309c38b192d8e301277d9f14b9ae — the Paidy follow-up body —,
-- 8422cf9aa5bcc8b94036f4e8ee3d6ce4 and 98b0bd6c102ec9067f7d433f7cde166c, read
-- 2026-10-04, byte-identical to the repo copies) with only the marked edits;
-- the pre-check below aborts the whole file if live has moved.
--
-- Bells (staff_notifications) are written INSIDE the same transaction as the
-- state change they announce: they are the durable outbox (review section 8).
-- Idempotent: safe to re-run.
-- ===========================================================================

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Pre-check: the two live functions this file replaces are the ones it was
--    written against (or already this file's version on a re-run).
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE v_t text; v_f text; v_l text;
BEGIN
  SELECT md5(prosrc) INTO v_t FROM pg_proc
   WHERE oid = 'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure;
  SELECT md5(prosrc) INTO v_f FROM pg_proc
   WHERE oid = 'public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)'::regprocedure;
  SELECT md5(prosrc) INTO v_l FROM pg_proc
   WHERE oid = 'public.cash_order_payment_lock(uuid,uuid,boolean)'::regprocedure;
  IF v_t NOT IN ('8422cf9aa5bcc8b94036f4e8ee3d6ce4', '873059443104e55b35d3b209f361bd7a') THEN
    RAISE EXCEPTION 'square integrity: terminate_web_order_atomic on live has moved (md5 %) — stop, read live, rebuild', v_t;
  END IF;
  IF v_f NOT IN ('ebb5309c38b192d8e301277d9f14b9ae', '15daada758f0ed1446975306b3f4d302') THEN
    RAISE EXCEPTION 'square integrity: finalize_cash_submission_atomic on live has moved (md5 %) — stop, read live, rebuild', v_f;
  END IF;
  IF v_l NOT IN ('98b0bd6c102ec9067f7d433f7cde166c', '91b33668173071731d78205febc1722f') THEN
    RAISE EXCEPTION 'square integrity: cash_order_payment_lock on live has moved (md5 %) — stop, read live, rebuild', v_l;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. square_card_attempts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.square_card_attempts (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id          uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  customer_id            uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  reference              text NOT NULL UNIQUE CHECK (char_length(reference) BETWEEN 8 AND 40),
  idempotency_key        text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 8 AND 45),
  amount_jpy             bigint NOT NULL CHECK (amount_jpy > 0),
  currency               text NOT NULL DEFAULT 'JPY' CHECK (currency = 'JPY'),
  environment            text NOT NULL CHECK (environment IN ('sandbox','production')),
  location_id            text NOT NULL,
  app_id                 text,
  test                   boolean NOT NULL DEFAULT false,
  status                 text NOT NULL DEFAULT 'reserved'
                         CHECK (status IN ('reserved','unknown','cancelling','authorized','declined',
                                           'failed','mismatch','cancelled','risk_cancelled')),
  square_payment_id      text,
  error_code             text,
  detail                 text,
  risk_level             text,
  verification           text,
  evidence               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at            timestamptz
);
CREATE INDEX IF NOT EXISTS idx_square_card_attempts_order_time ON public.square_card_attempts (cash_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_square_card_attempts_customer_time ON public.square_card_attempts (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_square_card_attempts_open ON public.square_card_attempts (created_at)
  WHERE status IN ('reserved','unknown','cancelling');
CREATE INDEX IF NOT EXISTS idx_square_card_attempts_payment ON public.square_card_attempts (square_payment_id)
  WHERE square_payment_id IS NOT NULL;
ALTER TABLE public.square_card_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS square_card_attempts_staff_select ON public.square_card_attempts;
CREATE POLICY square_card_attempts_staff_select ON public.square_card_attempts
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.square_card_attempts FROM anon;
GRANT SELECT ON public.square_card_attempts TO authenticated;
GRANT ALL ON public.square_card_attempts TO service_role;
COMMENT ON TABLE public.square_card_attempts IS
  'One row per Square CreatePayment from the website, written under the order lock BEFORE Square is called (reserve_square_attempt) with the immutable request. reference = Square reference_id (correlates webhooks and listings); idempotency_key never changes for the attempt. reserved/unknown/cancelling = unresolved (blocks every other payment on the order). evidence: terms + agreement + billing summary as received. No card data, no source token.';

-- ---------------------------------------------------------------------------
-- 2. square_payments: provider truth, ledger link, claims, exceptions, evidence.
-- ---------------------------------------------------------------------------
ALTER TABLE public.square_payments
  ADD COLUMN IF NOT EXISTS attempt_id             uuid REFERENCES public.square_card_attempts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reference              text,
  ADD COLUMN IF NOT EXISTS environment            text,
  ADD COLUMN IF NOT EXISTS location_id            text,
  ADD COLUMN IF NOT EXISTS currency               text NOT NULL DEFAULT 'JPY',
  ADD COLUMN IF NOT EXISTS provider_status        text,
  ADD COLUMN IF NOT EXISTS provider_version       text,
  ADD COLUMN IF NOT EXISTS provider_updated_at    timestamptz,
  ADD COLUMN IF NOT EXISTS captured_amount_jpy    bigint,
  ADD COLUMN IF NOT EXISTS cash_payment_id        uuid REFERENCES public.cash_payments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS risk_level             text,
  ADD COLUMN IF NOT EXISTS verification           text,
  ADD COLUMN IF NOT EXISTS provider_verification  jsonb,
  ADD COLUMN IF NOT EXISTS action                 text,
  ADD COLUMN IF NOT EXISTS action_started_at      timestamptz,
  ADD COLUMN IF NOT EXISTS action_by              uuid,
  ADD COLUMN IF NOT EXISTS exception              text,
  ADD COLUMN IF NOT EXISTS exception_at           timestamptz,
  ADD COLUMN IF NOT EXISTS exception_note         text,
  ADD COLUMN IF NOT EXISTS exception_resolved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS exception_resolved_by  uuid,
  ADD COLUMN IF NOT EXISTS agreement_customer_id  uuid,
  ADD COLUMN IF NOT EXISTS agreement_amount_jpy   bigint,
  ADD COLUMN IF NOT EXISTS agreement_received_at  timestamptz,
  ADD COLUMN IF NOT EXISTS terms_received_at      timestamptz,
  ADD COLUMN IF NOT EXISTS billing_summary        jsonb;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'square_payments_action_check') THEN
    ALTER TABLE public.square_payments ADD CONSTRAINT square_payments_action_check
      CHECK (action IS NULL OR action IN ('capture','void'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'square_payments_exception_check') THEN
    ALTER TABLE public.square_payments ADD CONSTRAINT square_payments_exception_check
      CHECK (exception IS NULL OR exception IN ('captured_after_close','captured_unallocated','amount_mismatch',
                                                'unfiled_hold','risk_high','void_unconfirmed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'square_payments_environment_check') THEN
    ALTER TABLE public.square_payments ADD CONSTRAINT square_payments_environment_check
      CHECK (environment IS NULL OR environment IN ('sandbox','production'));
  END IF;
END
$c$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_square_payments_cash_payment ON public.square_payments (cash_payment_id)
  WHERE cash_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_square_payments_open ON public.square_payments (cash_order_id)
  WHERE status = 'authorized' OR (status = 'captured' AND cash_payment_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_square_payments_attempt ON public.square_payments (attempt_id) WHERE attempt_id IS NOT NULL;

-- Backfill the existing (sandbox) rows: environment from test, provider status
-- from the local status, captured amount, and the ledger link from the
-- confirmed submission.
UPDATE public.square_payments
   SET environment = CASE WHEN test THEN 'sandbox' ELSE 'production' END
 WHERE environment IS NULL;
UPDATE public.square_payments
   SET provider_status = CASE status WHEN 'captured' THEN 'COMPLETED' WHEN 'authorized' THEN 'APPROVED'
                                     WHEN 'failed' THEN 'FAILED' ELSE 'CANCELED' END
 WHERE provider_status IS NULL;
UPDATE public.square_payments
   SET captured_amount_jpy = round(amount_jpy)::bigint
 WHERE status = 'captured' AND captured_amount_jpy IS NULL;
UPDATE public.square_payments sp
   SET cash_payment_id = s.confirmed_payment_id
  FROM public.payment_submissions s
 WHERE s.square_payment_id = sp.id AND s.confirmed_payment_id IS NOT NULL
   AND sp.cash_payment_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.square_payments x WHERE x.cash_payment_id = s.confirmed_payment_id);

COMMENT ON COLUMN public.square_payments.cash_payment_id IS
  'The cash_payments row this capture was recorded as (finalize_cash_submission_atomic). Unique: one capture is credited once. NULL + status captured = captured money not yet recorded (an open item until recorded or resolved).';
COMMENT ON COLUMN public.square_payments.action IS
  'capture | void while a reviewer Confirm / Reject holds the claim (claim_square_action, 5-minute lease). Confirm and Reject can never both act on one hold.';
COMMENT ON COLUMN public.square_payments.exception IS
  'Money that needs a person: captured_after_close (Square completed a payment the Hub had closed), captured_unallocated (captured, but the order can no longer take it), amount_mismatch, unfiled_hold (a hold whose order could not take it), risk_high (Square risk HIGH — voided), void_unconfirmed (local closed, Square still holds). Resolved by decide_square_case.';
COMMENT ON COLUMN public.square_payments.verification IS
  'Truthful 3-D Secure evidence (SQ18): sdk_tokenize_with_verification (the storefront tokenised with verificationDetails — Square runs SCA inside the token), verification_token_supplied, or unknown. Never "verified": Square returns no authentication verdict for an online card payment.';

-- ---------------------------------------------------------------------------
-- 3. square_webhook_events → durable inbox.
-- ---------------------------------------------------------------------------
ALTER TABLE public.square_webhook_events
  ADD COLUMN IF NOT EXISTS status                text NOT NULL DEFAULT 'received',
  ADD COLUMN IF NOT EXISTS attempts              integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at       timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at          timestamptz,
  ADD COLUMN IF NOT EXISTS last_error            text,
  ADD COLUMN IF NOT EXISTS object_id             text,
  ADD COLUMN IF NOT EXISTS environment           text;
DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'square_webhook_events_status_check') THEN
    ALTER TABLE public.square_webhook_events ADD CONSTRAINT square_webhook_events_status_check
      CHECK (status IN ('received','processing','done','failed','quarantined','ignored','dead'));
  END IF;
END
$c$;
-- Existing rows: synced → done; ignored_unknown → ignored (historical sandbox
-- declines that arrived before the Hub had a row; nothing to recover); any
-- other outcome (read failures) → failed, retried by square-reconcile.
UPDATE public.square_webhook_events
   SET status = CASE WHEN outcome = 'synced' THEN 'done'
                     WHEN outcome IN ('ignored_unknown','ignored','duplicate') THEN 'ignored'
                     ELSE 'failed' END,
       completed_at = CASE WHEN outcome IN ('synced','ignored_unknown','ignored','duplicate') THEN received_at ELSE NULL END,
       next_attempt_at = CASE WHEN outcome IN ('synced','ignored_unknown','ignored','duplicate') THEN NULL ELSE now() END
 WHERE status = 'received' AND attempts = 0 AND processing_started_at IS NULL AND received_at < now();
CREATE INDEX IF NOT EXISTS idx_square_webhook_events_retry ON public.square_webhook_events (next_attempt_at)
  WHERE status IN ('received','processing','failed','quarantined');
COMMENT ON TABLE public.square_webhook_events IS
  'Durable inbox of verified Square webhooks (SQ01). status: received → processing (lease) → done | ignored | failed (retried, next_attempt_at) | quarantined (a Cha Jewels reference with no match yet — retried) | dead (12 failed attempts — bell). A duplicate delivery of an unfinished event resumes it; a finished one answers duplicate.';

-- ---------------------------------------------------------------------------
-- 4. square_refunds and square_disputes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.square_refunds (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  square_refund_id       text NOT NULL UNIQUE,
  square_payment_row     uuid NOT NULL REFERENCES public.square_payments(id) ON DELETE RESTRICT,
  square_payment_id      text NOT NULL,
  cash_order_id          uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  amount_jpy             bigint NOT NULL CHECK (amount_jpy >= 0),
  status                 text NOT NULL,
  reason                 text,
  provider_created_at    timestamptz,
  provider_updated_at    timestamptz,
  last_payload           jsonb,
  decision               text,
  decision_note          text,
  decided_at             timestamptz,
  decided_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_square_refunds_payment ON public.square_refunds (square_payment_row);
CREATE INDEX IF NOT EXISTS idx_square_refunds_open ON public.square_refunds (created_at) WHERE decided_at IS NULL;
ALTER TABLE public.square_refunds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS square_refunds_staff_select ON public.square_refunds;
CREATE POLICY square_refunds_staff_select ON public.square_refunds
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.square_refunds FROM anon;
GRANT SELECT ON public.square_refunds TO authenticated;
GRANT ALL ON public.square_refunds TO service_role;
COMMENT ON TABLE public.square_refunds IS
  'One row per Square refund (made in the Square Dashboard — owner 2A). status = Square''s (PENDING | COMPLETED | FAILED | REJECTED). Order accounting is NEVER changed from here: staff record the decision on the order and mark the refund decided (decide_square_case). A FAILED/REJECTED refund is never shown as paid back.';

CREATE TABLE IF NOT EXISTS public.square_disputes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  square_dispute_id      text NOT NULL UNIQUE,
  square_payment_row     uuid NOT NULL REFERENCES public.square_payments(id) ON DELETE RESTRICT,
  square_payment_id      text NOT NULL,
  cash_order_id          uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  amount_jpy             bigint,
  state                  text NOT NULL,
  reason                 text,
  due_at                 timestamptz,
  reminded_3d_at         timestamptz,
  reminded_1d_at         timestamptz,
  provider_created_at    timestamptz,
  provider_updated_at    timestamptz,
  last_payload           jsonb,
  decision               text,
  decision_note          text,
  decided_at             timestamptz,
  decided_by             uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_square_disputes_payment ON public.square_disputes (square_payment_row);
CREATE INDEX IF NOT EXISTS idx_square_disputes_due ON public.square_disputes (due_at)
  WHERE state NOT IN ('WON','LOST','ACCEPTED');
ALTER TABLE public.square_disputes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS square_disputes_staff_select ON public.square_disputes;
CREATE POLICY square_disputes_staff_select ON public.square_disputes
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.square_disputes FROM anon;
GRANT SELECT ON public.square_disputes TO authenticated;
GRANT ALL ON public.square_disputes TO service_role;
COMMENT ON TABLE public.square_disputes IS
  'One row per Square dispute (chargeback). state = Square''s; due_at = evidence deadline (bells 3 days and 1 day before). Evidence is handled in the Square Dashboard; the Hub keeps the case, its owner decision and the outcome.';

-- ---------------------------------------------------------------------------
-- 5. guard_provider_submission
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6a. square_order_unresolved — the one admission gate (SQ11, owner 3A).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_order_unresolved(p_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.square_card_attempts
                  WHERE cash_order_id = p_order_id AND status IN ('reserved','unknown','cancelling'))
      OR EXISTS (SELECT 1 FROM public.square_payments
                  WHERE cash_order_id = p_order_id
                    AND (status = 'authorized'
                         OR (status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL)));
$fn$;
REVOKE ALL ON FUNCTION public.square_order_unresolved(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.square_order_unresolved(uuid) TO service_role;
COMMENT ON FUNCTION public.square_order_unresolved(uuid) IS
  'true while the order has a card attempt in flight (reserved/unknown/cancelling), a live hold, or captured card money not yet recorded. While true: no other payment (card, Paidy, transfer), no expiry, no cancel. service_role only.';

-- 9 (placed here: it calls square_order_unresolved). cash_order_payment_lock —
-- the Paidy follow-up's one answer, plus the card branch (marked).
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
    -- Square (2026-10-04, owner 3A / SQ11): a card attempt in flight, a live
    -- card hold, or captured card money not yet recorded — no other payment
    -- until it is resolved (public.square_order_unresolved). Not a paidy_*
    -- reason, so the Paidy guard trigger lets the card's own filing through;
    -- guard_provider_submission enforces it for everything else.
    WHEN public.square_order_unresolved(p_cash_order_id)
      THEN 'card_payment_unresolved'
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
  'Why a cash order cannot take another payment now, or NULL. paidy_* reasons (captured_unrecorded, submission_pending, authorized, checkout_open) close EVERY other payment route, staff included (guard trigger); card_payment_unresolved (a card attempt in flight, a live card hold, or captured card money not yet recorded — square_order_unresolved) closes every other route too (guard_provider_submission); submission_pending is the ordinary one-pending-payment rule. Owner rules 2026-10-04: while Paidy or a card is processing, nothing else; after a verified Reject / void / close the order opens again.';

-- Refusal counters for the caps and the fraud rule.
CREATE OR REPLACE FUNCTION public.square_refusal_counts(p_order_id uuid, p_customer_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT jsonb_build_object(
    'order_refusals',
      (SELECT count(*) FROM public.square_card_attempts
        WHERE cash_order_id = p_order_id AND status = 'declined' AND created_at > now() - interval '24 hours')
      + (SELECT count(*) FROM public.square_attempts
        WHERE cash_order_id = p_order_id AND outcome = 'declined' AND created_at > now() - interval '24 hours'),
    'order_failures',
      (SELECT count(*) FROM public.square_card_attempts
        WHERE cash_order_id = p_order_id AND status IN ('declined','failed','mismatch','risk_cancelled')
          AND created_at > now() - interval '24 hours')
      + (SELECT count(*) FROM public.square_attempts
        WHERE cash_order_id = p_order_id AND outcome IN ('declined','refused','mismatch')
          AND created_at > now() - interval '24 hours'),
    'customer_refusals',
      CASE WHEN p_customer_id IS NULL THEN 0 ELSE
      (SELECT count(*) FROM public.square_card_attempts
        WHERE customer_id = p_customer_id AND status = 'declined' AND created_at > now() - interval '24 hours')
      + (SELECT count(*) FROM public.square_attempts
        WHERE customer_id = p_customer_id AND outcome = 'declined' AND created_at > now() - interval '24 hours') END);
$fn$;
REVOKE ALL ON FUNCTION public.square_refusal_counts(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.square_refusal_counts(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 6b. reserve_square_attempt — before Square is called (SQ04, SQ05, SQ12).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_square_attempt(
  p_cash_order_id uuid, p_customer_id uuid, p_amount_jpy bigint, p_environment text,
  p_location_id text, p_app_id text, p_test boolean, p_idempotency_key text, p_reference text,
  p_verification text, p_evidence jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_order  public.cash_orders%ROWTYPE;
  v_att    public.square_card_attempts%ROWTYPE;
  v_counts jsonb;
BEGIN
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 THEN RETURN jsonb_build_object('error', 'bad_amount'); END IF;
  IF p_environment IS NULL OR p_environment NOT IN ('sandbox','production') THEN
    RETURN jsonb_build_object('error', 'bad_environment');
  END IF;
  IF coalesce(p_location_id, '') = '' THEN RETURN jsonb_build_object('error', 'bad_location'); END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 45
     OR p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 8 AND 40 THEN
    RETURN jsonb_build_object('error', 'bad_key');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;

  -- Same request again (same order + same card token → same key): hand back
  -- the attempt; the caller replays the SAME immutable request or reports its
  -- recorded outcome. Never a second commitment.
  SELECT * INTO v_att FROM public.square_card_attempts WHERE idempotency_key = p_idempotency_key;
  IF v_att.id IS NOT NULL THEN
    IF v_att.cash_order_id <> p_cash_order_id THEN RETURN jsonb_build_object('error', 'bad_key'); END IF;
    RETURN jsonb_build_object('ok', true, 'outcome', 'existing', 'attempt', to_jsonb(v_att));
  END IF;

  IF v_order.customer_id IS DISTINCT FROM p_customer_id THEN RETURN jsonb_build_object('error', 'wrong_customer'); END IF;
  IF v_order.status::text <> 'pending' THEN
    RETURN jsonb_build_object('error', 'order_not_payable', 'status', v_order.status::text);
  END IF;
  IF v_order.currency::text <> 'JPY' THEN RETURN jsonb_build_object('error', 'not_jpy'); END IF;
  -- Integer yen only (SQ12): a fractional balance is never rounded into a card amount.
  IF v_order.remaining_balance <> trunc(v_order.remaining_balance) THEN
    RETURN jsonb_build_object('error', 'fractional_balance', 'remaining_balance', v_order.remaining_balance);
  END IF;
  IF v_order.remaining_balance <> p_amount_jpy::numeric THEN
    RETURN jsonb_build_object('error', 'amount_changed', 'remaining_balance', v_order.remaining_balance);
  END IF;

  -- Nothing while Paidy holds the order (Paidy follow-up owner rule): a Paidy
  -- window open, an authorisation waiting, a capture not yet recorded.
  IF coalesce(public.cash_order_payment_lock(p_cash_order_id), '') LIKE 'paidy%' THEN
    RETURN jsonb_build_object('error', 'paidy_in_progress', 'lock', public.cash_order_payment_lock(p_cash_order_id));
  END IF;

  SELECT * INTO v_att FROM public.square_card_attempts
   WHERE cash_order_id = p_cash_order_id AND status IN ('reserved','unknown','cancelling')
   ORDER BY created_at DESC LIMIT 1;
  IF v_att.id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'attempt_in_progress', 'attempt', to_jsonb(v_att));
  END IF;
  IF EXISTS (SELECT 1 FROM public.square_payments
              WHERE cash_order_id = p_cash_order_id
                AND (status = 'authorized' OR (status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL))) THEN
    RETURN jsonb_build_object('error', 'card_hold_active');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_submissions
              WHERE cash_order_id = p_cash_order_id
                AND (status::text IN ('submitted','under_review')
                     OR (status::text = 'confirmed' AND confirmed_payment_id IS NULL))) THEN
    RETURN jsonb_build_object('error', 'submission_pending');
  END IF;

  v_counts := public.square_refusal_counts(p_cash_order_id, p_customer_id);
  IF (v_counts->>'order_failures')::int >= 5 THEN
    RETURN jsonb_build_object('error', 'too_many_attempts', 'scope', 'order', 'counts', v_counts);
  END IF;
  IF (v_counts->>'customer_refusals')::int >= 10 THEN
    RETURN jsonb_build_object('error', 'too_many_attempts', 'scope', 'customer', 'counts', v_counts);
  END IF;

  INSERT INTO public.square_card_attempts (cash_order_id, customer_id, reference, idempotency_key, amount_jpy,
         environment, location_id, app_id, test, status, verification, evidence)
  VALUES (p_cash_order_id, p_customer_id, p_reference, p_idempotency_key, p_amount_jpy,
          p_environment, p_location_id, p_app_id, coalesce(p_test, false), 'reserved', p_verification,
          coalesce(p_evidence, '{}'::jsonb))
  RETURNING * INTO v_att;

  RETURN jsonb_build_object('ok', true, 'outcome', 'reserved', 'attempt', to_jsonb(v_att));
END
$fn$;
REVOKE ALL ON FUNCTION public.reserve_square_attempt(uuid, uuid, bigint, text, text, text, boolean, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_square_attempt(uuid, uuid, bigint, text, text, text, boolean, text, text, text, jsonb) TO service_role;
COMMENT ON FUNCTION public.reserve_square_attempt(uuid, uuid, bigint, text, text, text, boolean, text, text, text, jsonb) IS
  'Locks the order and reserves ONE card attempt before Square is called. Refuses: bad_amount, bad_environment, bad_location, bad_key, order_not_found, wrong_customer, order_not_payable, not_jpy, fractional_balance, amount_changed (exact integer yen = remaining), paidy_in_progress, attempt_in_progress, card_hold_active, submission_pending, too_many_attempts (5 failures per order, 10 declines per customer, rolling 24 h). Same idempotency key → outcome existing. service_role only (website).';

-- ---------------------------------------------------------------------------
-- 6c. resolve_square_attempt — compare-and-set of an attempt's outcome.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_square_attempt(
  p_attempt_id uuid, p_status text, p_from text[], p_square_payment_id text,
  p_error_code text, p_detail text, p_risk_level text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_att    public.square_card_attempts%ROWTYPE;
  v_counts jsonb;
  v_fraud  text := NULL;
BEGIN
  IF p_status NOT IN ('reserved','unknown','cancelling','authorized','declined','failed','mismatch','cancelled','risk_cancelled') THEN
    RETURN jsonb_build_object('error', 'bad_status');
  END IF;
  UPDATE public.square_card_attempts
     SET status = p_status,
         square_payment_id = coalesce(p_square_payment_id, square_payment_id),
         error_code = coalesce(p_error_code, error_code),
         detail = coalesce(left(p_detail, 500), detail),
         risk_level = coalesce(p_risk_level, risk_level),
         resolved_at = CASE WHEN p_status IN ('reserved','unknown','cancelling') THEN NULL ELSE now() END,
         updated_at = now()
   WHERE id = p_attempt_id AND status = ANY (p_from)
  RETURNING * INTO v_att;
  IF v_att.id IS NULL THEN
    SELECT * INTO v_att FROM public.square_card_attempts WHERE id = p_attempt_id;
    RETURN jsonb_build_object('ok', false, 'error', CASE WHEN v_att.id IS NULL THEN 'attempt_not_found' ELSE 'state_changed' END,
                              'attempt', to_jsonb(v_att));
  END IF;

  v_counts := public.square_refusal_counts(v_att.cash_order_id, v_att.customer_id);
  IF p_status = 'risk_cancelled' THEN
    v_fraud := 'risk_high';
  ELSIF p_status = 'declined' AND (v_counts->>'order_refusals')::int >= 5 THEN
    v_fraud := 'order_refusals';
  ELSIF p_status = 'declined' AND (v_counts->>'customer_refusals')::int >= 10 THEN
    v_fraud := 'customer_refusals';
  END IF;
  RETURN jsonb_build_object('ok', true, 'attempt', to_jsonb(v_att), 'counts', v_counts, 'fraud', v_fraud);
END
$fn$;
REVOKE ALL ON FUNCTION public.resolve_square_attempt(uuid, text, text[], text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_square_attempt(uuid, text, text[], text, text, text, text) TO service_role;
COMMENT ON FUNCTION public.resolve_square_attempt(uuid, text, text[], text, text, text, text) IS
  'Moves an attempt to p_status only from one of p_from (CAS). Returns the refusal counters and fraud = risk_high | order_refusals (5 declines on the order in 24 h) | customer_refusals (10 across her orders) | null. service_role only.';

-- ---------------------------------------------------------------------------
-- 6d. file_square_authorization_atomic — record + submission + audit + bell
--     in one transaction under the order lock (SQ03, SQ05).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_square_authorization_atomic(
  p_attempt_id uuid, p_square_payment_id text, p_amount_jpy bigint, p_currency text, p_location_id text,
  p_card_brand text, p_card_last4 text, p_receipt_url text, p_authorized_at timestamptz, p_capture_by timestamptz,
  p_risk_level text, p_provider_verification jsonb, p_provider_version text, p_provider_updated_at timestamptz,
  p_payload jsonb, p_payment_date date, p_sender_name text, p_notes text, p_reference_label text, p_path text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_att     public.square_card_attempts%ROWTYPE;
  v_order   public.cash_orders%ROWTYPE;
  v_sq      public.square_payments%ROWTYPE;
  v_sub     public.payment_submissions%ROWTYPE;
  v_ev      jsonb;
  v_reason  text := NULL;
  v_exc     text := NULL;
BEGIN
  SELECT * INTO v_att FROM public.square_card_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_att.id IS NULL THEN RETURN jsonb_build_object('error', 'attempt_not_found'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_att.cash_order_id FOR UPDATE;
  v_ev := coalesce(v_att.evidence, '{}'::jsonb);

  -- Idempotent on the provider payment id.
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
  IF v_sq.id IS NOT NULL THEN
    IF v_sq.attempt_id IS DISTINCT FROM v_att.id AND v_sq.attempt_id IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'payment_belongs_to_other_attempt');
    END IF;
    SELECT * INTO v_sub FROM public.payment_submissions WHERE square_payment_id = v_sq.id
     ORDER BY created_at DESC LIMIT 1;
    -- The payment is already recorded: its attempt is answered. An attempt
    -- still open here (a lost answer recovered later, a cancel-by-key that put
    -- it back to unknown) would lock the order forever — close it; the
    -- square_payments row now carries the lock until the hold is closed.
    UPDATE public.square_card_attempts
       SET status = 'authorized', square_payment_id = p_square_payment_id,
           resolved_at = coalesce(resolved_at, now()), updated_at = now()
     WHERE id = v_att.id AND status IN ('reserved','unknown','cancelling');
    IF v_sub.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'outcome', 'already_filed', 'filed', true,
        'submission', to_jsonb(v_sub), 'square_row_id', v_sq.id);
    END IF;
    IF v_sq.exception IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'outcome', 'already_recorded_exception', 'filed', false,
        'reason', v_sq.exception, 'square_row_id', v_sq.id);
    END IF;
  END IF;

  -- What came back must be exactly what the attempt asked for.
  IF coalesce(p_currency, '') <> 'JPY' THEN v_reason := 'not_jpy';
  ELSIF p_location_id IS DISTINCT FROM v_att.location_id THEN v_reason := 'location';
  ELSIF p_amount_jpy IS DISTINCT FROM v_att.amount_jpy THEN v_reason := 'amount';
  END IF;
  IF v_reason IS NOT NULL THEN
    v_exc := 'amount_mismatch';
  ELSIF upper(coalesce(p_risk_level, '')) = 'HIGH' THEN
    v_reason := 'risk_high'; v_exc := 'risk_high';
  ELSIF v_att.status NOT IN ('reserved','unknown','authorized') THEN
    v_reason := 'attempt_' || v_att.status; v_exc := 'unfiled_hold';
  ELSIF v_order.status::text <> 'pending' THEN
    v_reason := 'order_' || v_order.status::text; v_exc := 'unfiled_hold';
  ELSIF v_order.remaining_balance <> p_amount_jpy::numeric THEN
    v_reason := 'balance_changed'; v_exc := 'unfiled_hold';
  ELSIF coalesce(public.cash_order_payment_lock(v_order.id), '') LIKE 'paidy%' THEN
    -- Paidy took the order meanwhile (its guard would refuse the insert):
    -- recorded as an exception, never a dead transaction with a live hold.
    v_reason := 'paidy_in_progress'; v_exc := 'unfiled_hold';
  ELSIF EXISTS (SELECT 1 FROM public.payment_submissions
                 WHERE cash_order_id = v_order.id
                   AND (status::text IN ('submitted','under_review')
                        OR (status::text = 'confirmed' AND confirmed_payment_id IS NULL))) THEN
    v_reason := 'submission_pending'; v_exc := 'unfiled_hold';
  ELSIF EXISTS (SELECT 1 FROM public.square_payments
                 WHERE cash_order_id = v_order.id AND square_payment_id <> p_square_payment_id
                   AND (status = 'authorized' OR (status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL))) THEN
    v_reason := 'other_hold_active'; v_exc := 'unfiled_hold';
  END IF;

  IF v_sq.id IS NULL THEN
    INSERT INTO public.square_payments (
      cash_order_id, customer_id, square_payment_id, status, test, amount_jpy, currency,
      card_brand, card_last4, three_ds_status, verification, provider_verification, receipt_url,
      terms_accepted_at, terms_version, terms_ip, terms_user_agent, terms_received_at,
      agreement_version, agreement_signed_at, agreement_customer_id, agreement_amount_jpy, agreement_received_at,
      billing_summary, authorized_at, capture_by, last_payload, attempt_id, reference, environment, location_id,
      provider_status, provider_version, provider_updated_at, risk_level, exception, exception_at, exception_note)
    VALUES (
      v_att.cash_order_id, v_att.customer_id, p_square_payment_id, 'authorized', v_att.test, p_amount_jpy, 'JPY',
      p_card_brand, p_card_last4, v_att.verification, v_att.verification, p_provider_verification, p_receipt_url,
      nullif(v_ev->>'terms_accepted_at', '')::timestamptz, v_ev->>'terms_version', v_ev->>'terms_ip',
      v_ev->>'terms_user_agent', nullif(v_ev->>'received_at', '')::timestamptz,
      v_ev->>'agreement_version', nullif(v_ev->>'agreement_signed_at', '')::timestamptz,
      nullif(v_ev->>'agreement_customer_id', '')::uuid, nullif(v_ev->>'agreement_amount_jpy', '')::bigint,
      nullif(v_ev->>'received_at', '')::timestamptz,
      v_ev->'billing', coalesce(p_authorized_at, now()), p_capture_by, p_payload, v_att.id, v_att.reference,
      v_att.environment, p_location_id, 'APPROVED', p_provider_version, p_provider_updated_at, p_risk_level,
      v_exc, CASE WHEN v_exc IS NOT NULL THEN now() END, v_reason)
    RETURNING * INTO v_sq;
  ELSIF v_exc IS NOT NULL THEN
    UPDATE public.square_payments SET exception = v_exc, exception_at = now(), exception_note = v_reason,
           attempt_id = coalesce(attempt_id, v_att.id), updated_at = now()
     WHERE id = v_sq.id RETURNING * INTO v_sq;
  END IF;

  IF v_exc IS NOT NULL THEN
    UPDATE public.square_card_attempts
       SET status = CASE WHEN v_exc = 'risk_high' THEN 'risk_cancelled'
                         WHEN v_exc = 'amount_mismatch' THEN 'mismatch'
                         -- unfiled_hold: Square answered APPROVED, so the
                         -- attempt is answered; the hold (square_payments
                         -- row, exception set) carries the order lock until
                         -- it is voided, captured or decided by staff.
                         ELSE 'authorized' END,
           square_payment_id = p_square_payment_id, risk_level = coalesce(p_risk_level, risk_level),
           detail = left(coalesce(v_reason, detail), 500),
           resolved_at = now(),
           updated_at = now()
     WHERE id = v_att.id AND status IN ('reserved','unknown','authorized');
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
    VALUES ('cash_order', v_order.id, 'card_hold_unfiled',
            jsonb_build_object('square_payment_id', p_square_payment_id, 'attempt', v_att.reference,
              'amount_jpy', p_amount_jpy, 'reason', v_reason, 'exception', v_exc, 'path', p_path));
    IF v_exc IN ('unfiled_hold') THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_hold_unfiled', 'Card hold needs a decision',
              coalesce(p_reference_label, v_order.invoice_number, '') || ' · ¥' || to_char(p_amount_jpy, 'FM999,999,999')
                || ' is held on the customer''s card but the order could not take it (' || v_reason
                || '). Open Website → Card payments: record it or void it in the Square Dashboard.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_order.id, 'square_payment_id', p_square_payment_id,
                                 'reason', v_reason, 'test', v_att.test));
    END IF;
    RETURN jsonb_build_object('ok', true, 'outcome', 'exception', 'filed', false, 'reason', v_reason,
                              'exception', v_exc, 'square_row_id', v_sq.id);
  END IF;

  INSERT INTO public.payment_submissions (account_id, cash_order_id, customer_id, submitted_amount, payment_date,
         payment_method, reference_number, sender_name, proof_url, notes, status, submission_type, square_payment_id)
  VALUES (NULL, v_order.id, v_att.customer_id, p_amount_jpy, coalesce(p_payment_date, current_date),
          'square', p_square_payment_id, p_sender_name, NULL, p_notes, 'submitted', 'cash_payment', v_sq.id)
  RETURNING * INTO v_sub;

  UPDATE public.square_card_attempts
     SET status = 'authorized', square_payment_id = p_square_payment_id,
         risk_level = coalesce(p_risk_level, risk_level), resolved_at = now(), updated_at = now()
   WHERE id = v_att.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
  VALUES ('cash_payment_submission', v_sub.id, 'submission_created',
          jsonb_build_object('cash_order_id', v_order.id, 'invoice_number', v_order.invoice_number,
            'amount', p_amount_jpy, 'method', 'square', 'reference', p_square_payment_id,
            'attempt', v_att.reference, 'path', coalesce(p_path, 'website_card'), 'test', v_att.test,
            'path_function', 'file_square_authorization_atomic'));

  INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
  VALUES ('card_authorized', 'Card payment awaiting Confirm',
          coalesce(p_reference_label, v_order.invoice_number, '') || ' · ¥' || to_char(p_amount_jpy, 'FM999,999,999')
            || ' · ' || coalesce(p_sender_name, '') || ' · ' || coalesce(p_card_brand, 'card') || ' ····'
            || coalesce(p_card_last4, '') || ' · capture on Confirm before '
            || coalesce(to_char(p_capture_by AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST', 'Square''s deadline'),
          v_order.customer_id, v_order.invoice_number,
          jsonb_build_object('cash_order_id', v_order.id, 'submission_id', v_sub.id,
            'square_payment_id', p_square_payment_id, 'test', v_att.test, 'path', p_path));

  RETURN jsonb_build_object('ok', true, 'outcome', 'filed', 'filed', true, 'submission', to_jsonb(v_sub),
                            'square_row_id', v_sq.id);
END
$fn$;
REVOKE ALL ON FUNCTION public.file_square_authorization_atomic(uuid, text, bigint, text, text, text, text, text, timestamptz, timestamptz, text, jsonb, text, timestamptz, jsonb, date, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_square_authorization_atomic(uuid, text, bigint, text, text, text, text, text, timestamptz, timestamptz, text, jsonb, text, timestamptz, jsonb, date, text, text, text, text) TO service_role;
COMMENT ON FUNCTION public.file_square_authorization_atomic(uuid, text, bigint, text, text, text, text, text, timestamptz, timestamptz, text, jsonb, text, timestamptz, jsonb, date, text, text, text, text) IS
  'Records an APPROVED Square payment for its attempt: square_payments row + payment submission + audit + card_authorized bell, one transaction, order lock. Idempotent on the Square payment id (already_filed). A hold the order cannot take (amount/location/currency differs, risk HIGH, attempt closed, order not pending, balance changed, other payment pending) is recorded with an exception and NO submission (outcome exception; unfiled_hold rings card_hold_unfiled). Used by the website, the webhook and square-reconcile. service_role only.';

-- ---------------------------------------------------------------------------
-- 6e. apply_square_payment_state — provider truth wins (SQ02, SQ13).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_square_payment_state(
  p_square_payment_id text, p_provider_status text, p_amount_jpy bigint, p_refunded_jpy bigint,
  p_currency text, p_provider_version text, p_provider_updated_at timestamptz, p_captured_at timestamptz,
  p_capture_by timestamptz, p_card_brand text, p_card_last4 text, p_receipt_url text, p_risk_level text,
  p_provider_verification jsonb, p_payload jsonb, p_source text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_sq     public.square_payments%ROWTYPE;
  v_order  public.cash_orders%ROWTYPE;
  v_sub    public.payment_submissions%ROWTYPE;
  v_ps     text := upper(coalesce(p_provider_status, ''));
  v_from   text;
  v_to     text;
  v_exc    text := NULL;
  v_subact text := NULL;
  v_ref    text;
  v_amt    text;
BEGIN
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;
  v_from := v_sq.status;
  v_ref := coalesce(v_order.web_reference, v_order.invoice_number, '');
  v_amt := '¥' || to_char(coalesce(p_amount_jpy, round(v_sq.amount_jpy)::bigint), 'FM999,999,999');

  -- The payment exists in Square and in the Hub: its attempt is answered. An
  -- attempt still open (lost answer recovered by webhook/reconcile, a
  -- cancel-by-key that put it back to unknown) would lock the order forever
  -- (review 2026-10-04 #1) — close it; this row carries the lock from here.
  UPDATE public.square_card_attempts
     SET status = CASE WHEN v_ps IN ('CANCELED','FAILED') THEN 'cancelled' ELSE 'authorized' END,
         square_payment_id = coalesce(square_payment_id, p_square_payment_id),
         resolved_at = coalesce(resolved_at, now()), updated_at = now()
   WHERE status IN ('reserved','unknown','cancelling')
     AND (id = v_sq.attempt_id OR (v_sq.reference IS NOT NULL AND reference = v_sq.reference));

  -- An older observation never overwrites a newer one.
  IF p_provider_updated_at IS NOT NULL AND v_sq.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_sq.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true, 'status', v_from);
  END IF;

  -- The rule: Square COMPLETED is captured whatever the Hub concluded before;
  -- captured never goes back; APPROVED means the hold is live (a local
  -- "voided/expired" was wrong); CANCELED/FAILED close a live hold only.
  v_to := CASE
    WHEN v_ps = 'COMPLETED' THEN 'captured'
    WHEN v_from = 'captured' THEN 'captured'
    WHEN v_ps = 'APPROVED' THEN 'authorized'
    WHEN v_ps = 'CANCELED' AND v_from = 'authorized' THEN
      CASE WHEN coalesce(p_capture_by, v_sq.capture_by) IS NOT NULL AND now() >= coalesce(p_capture_by, v_sq.capture_by)
           THEN 'expired' ELSE 'voided' END
    WHEN v_ps = 'FAILED' AND v_from = 'authorized' THEN 'failed'
    ELSE v_from END;

  IF v_to = 'captured' AND v_from <> 'captured' THEN
    IF v_from IN ('voided','expired','failed','rejected') THEN v_exc := 'captured_after_close'; END IF;
    IF coalesce(p_currency, 'JPY') <> 'JPY' OR p_amount_jpy IS DISTINCT FROM round(v_sq.amount_jpy)::bigint THEN
      v_exc := 'amount_mismatch';
    END IF;
  ELSIF v_to = 'authorized' AND v_from IN ('voided','expired','failed','rejected') THEN
    v_exc := 'void_unconfirmed';
  END IF;

  UPDATE public.square_payments
     SET status = v_to,
         provider_status = coalesce(nullif(v_ps, ''), provider_status),
         provider_version = coalesce(p_provider_version, provider_version),
         provider_updated_at = coalesce(p_provider_updated_at, provider_updated_at),
         captured_at = CASE WHEN v_to = 'captured' AND captured_at IS NULL THEN coalesce(p_captured_at, now()) ELSE captured_at END,
         captured_amount_jpy = CASE WHEN v_to = 'captured' AND captured_amount_jpy IS NULL THEN p_amount_jpy ELSE captured_amount_jpy END,
         voided_at = CASE WHEN v_to IN ('voided','expired') AND v_from = 'authorized' THEN now()
                          WHEN v_to = 'authorized' THEN NULL ELSE voided_at END,
         voided_reason = CASE WHEN v_to IN ('voided','expired') AND v_from = 'authorized' THEN coalesce(p_source, 'square')
                              WHEN v_to = 'authorized' THEN NULL ELSE voided_reason END,
         capture_by = coalesce(p_capture_by, capture_by),
         refund_jpy = greatest(coalesce(p_refunded_jpy, 0), 0),
         card_brand = coalesce(card_brand, p_card_brand),
         card_last4 = coalesce(card_last4, p_card_last4),
         receipt_url = coalesce(p_receipt_url, receipt_url),
         risk_level = coalesce(p_risk_level, risk_level),
         provider_verification = coalesce(p_provider_verification, provider_verification),
         last_payload = coalesce(p_payload, last_payload),
         last_webhook_at = CASE WHEN p_source = 'webhook' THEN now() ELSE last_webhook_at END,
         exception = CASE WHEN v_exc IS NOT NULL THEN v_exc ELSE exception END,
         exception_at = CASE WHEN v_exc IS NOT NULL THEN now() ELSE exception_at END,
         exception_note = CASE WHEN v_exc IS NOT NULL THEN 'Square ' || v_ps || ' while the Hub had ' || v_from ELSE exception_note END,
         exception_resolved_at = CASE WHEN v_exc IS NOT NULL THEN NULL ELSE exception_resolved_at END,
         updated_at = now()
   WHERE id = v_sq.id
  RETURNING * INTO v_sq;

  SELECT * INTO v_sub FROM public.payment_submissions WHERE square_payment_id = v_sq.id
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;

  IF v_to IN ('voided','expired','failed') AND v_from = 'authorized' THEN
    -- The hold is gone: a submission still waiting is rejected so she can pay
    -- again (owner 3A). A claimed Confirm is left to its own read-back.
    IF v_sub.id IS NOT NULL AND v_sub.status::text IN ('submitted','under_review') THEN
      UPDATE public.payment_submissions
         SET status = 'rejected',
             reviewer_notes = 'Card hold closed by Square (' || v_ps || ', ' || v_to || ') — nothing was charged.',
             updated_at = now()
       WHERE id = v_sub.id;
      v_subact := 'rejected';
    END IF;
    IF coalesce(p_source, '') NOT IN ('void') THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_closed_externally', 'Card hold closed by Square',
              v_ref || ' · ' || v_amt || ' — Square reports the hold as ' || v_ps || ' (' || v_to || '). Nothing was charged; '
                || CASE WHEN v_subact = 'rejected' THEN 'the submission was rejected and the customer can pay again.' ELSE 'no submission was waiting.' END,
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'status', v_to, 'source', p_source, 'test', v_sq.test));
    END IF;
  ELSIF v_to = 'captured' AND v_from <> 'captured' THEN
    IF v_sub.id IS NULL OR v_sub.status::text IN ('rejected','cancelled') THEN
      IF v_exc IS NULL THEN
        v_exc := 'captured_unallocated';
        UPDATE public.square_payments SET exception = v_exc, exception_at = now(),
               exception_note = 'Captured with no live submission', exception_resolved_at = NULL
         WHERE id = v_sq.id;
      END IF;
    END IF;
    -- A reviewer's Confirm that already claimed the submission (status
    -- 'confirmed', not yet recorded) is the Hub's own capture: no "captured
    -- outside the Hub" bell for it (webhook racing the Confirm, Finish recording).
    IF v_exc IS NOT NULL
       OR (coalesce(p_source, '') <> 'capture'
           AND NOT (v_sub.id IS NOT NULL AND v_sub.status::text = 'confirmed' AND v_sub.confirmed_payment_id IS NULL)) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES (CASE WHEN v_exc IS NOT NULL THEN 'card_capture_exception' ELSE 'card_captured_externally' END,
              CASE WHEN v_exc IS NOT NULL THEN 'Card money captured — needs a decision' ELSE 'Card captured outside the Hub' END,
              v_ref || ' · ' || v_amt || ' — Square shows this card payment COMPLETED'
                || CASE WHEN v_exc IS NOT NULL THEN ' (' || v_exc || '). Open Website → Card payments to record it or refund it in the Square Dashboard.'
                        ELSE '. Open Payments Hub and press Confirm / Finish recording to record it.' END,
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'exception', v_exc, 'source', p_source, 'test', v_sq.test));
    END IF;
  ELSIF v_exc = 'void_unconfirmed' THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_void_failed', 'Card hold is still live',
            v_ref || ' · ' || v_amt || ' — the Hub had this hold as ' || v_from || ' but Square still holds it (APPROVED). Void it from Payments Hub or the Square Dashboard.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id, 'test', v_sq.test));
  END IF;

  IF v_to IS DISTINCT FROM v_from OR v_exc IS NOT NULL THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
    VALUES ('square_payment', v_sq.id, 'square_state',
            jsonb_build_object('status', v_from),
            jsonb_build_object('status', v_to, 'provider_status', v_ps, 'exception', v_exc, 'submission', v_subact,
                               'source', p_source, 'square_payment_id', p_square_payment_id),
            p_user_id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'changed', v_to IS DISTINCT FROM v_from, 'from', v_from, 'to', v_to,
                            'exception', v_exc, 'submission_action', v_subact, 'square_row_id', v_sq.id,
                            'cash_order_id', v_sq.cash_order_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.apply_square_payment_state(text, text, bigint, bigint, text, text, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_square_payment_state(text, text, bigint, bigint, text, text, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb, text, uuid) TO service_role;
COMMENT ON FUNCTION public.apply_square_payment_state(text, text, bigint, bigint, text, text, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb, text, uuid) IS
  'Applies what Square says about a payment to its square_payments row, the linked submission, audit and bells, in one transaction. COMPLETED → captured even after a local close (exception captured_after_close); captured never downgrades; APPROVED after a local close → void_unconfirmed; CANCELED/FAILED of a live hold → voided/expired/failed and a waiting submission rejected. Older observations (provider updated_at) are ignored. p_source: webhook | reconcile | capture | void | website | review. service_role only.';

-- ---------------------------------------------------------------------------
-- 6f. claim_square_action / release_square_action (SQ10).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_square_action(p_square_row_id uuid, p_action text, p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_sq public.square_payments%ROWTYPE;
BEGIN
  IF p_action NOT IN ('capture','void') THEN RETURN jsonb_build_object('error', 'bad_action'); END IF;
  UPDATE public.square_payments
     SET action = p_action, action_started_at = now(), action_by = p_user_id, updated_at = now()
   WHERE id = p_square_row_id
     AND (action IS NULL OR action_started_at < now() - interval '5 minutes' OR action = p_action)
  RETURNING * INTO v_sq;
  IF v_sq.id IS NULL THEN
    SELECT * INTO v_sq FROM public.square_payments WHERE id = p_square_row_id;
    RETURN jsonb_build_object('ok', false, 'error', CASE WHEN v_sq.id IS NULL THEN 'not_found' ELSE 'busy' END,
                              'action', v_sq.action, 'action_started_at', v_sq.action_started_at);
  END IF;
  RETURN jsonb_build_object('ok', true, 'square_payment', to_jsonb(v_sq));
END
$fn$;
REVOKE ALL ON FUNCTION public.claim_square_action(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_square_action(uuid, text, uuid) TO service_role;
COMMENT ON FUNCTION public.claim_square_action(uuid, text, uuid) IS
  'A reviewer Confirm (capture) or Reject (void) claims the hold before calling Square. A different action inside the 5-minute lease answers busy; the same action may resume (Finish recording). service_role only.';

CREATE OR REPLACE FUNCTION public.release_square_action(p_square_row_id uuid, p_action text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  UPDATE public.square_payments SET action = NULL, action_started_at = NULL, action_by = NULL, updated_at = now()
   WHERE id = p_square_row_id AND action = p_action;
$fn$;
REVOKE ALL ON FUNCTION public.release_square_action(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_square_action(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 6g. record_square_refund / record_square_dispute (SQ15, SQ16).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_square_refund(
  p_refund_id text, p_square_payment_id text, p_status text, p_amount_jpy bigint, p_reason text,
  p_provider_created_at timestamptz, p_provider_updated_at timestamptz, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_sq    public.square_payments%ROWTYPE;
  v_order public.cash_orders%ROWTYPE;
  v_old   public.square_refunds%ROWTYPE;
  v_new   public.square_refunds%ROWTYPE;
  v_st    text := upper(coalesce(p_status, 'PENDING'));
BEGIN
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;
  SELECT * INTO v_old FROM public.square_refunds WHERE square_refund_id = p_refund_id FOR UPDATE;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_old.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id,
         amount_jpy, status, reason, provider_created_at, provider_updated_at, last_payload)
  VALUES (p_refund_id, v_sq.id, p_square_payment_id, v_sq.cash_order_id, greatest(coalesce(p_amount_jpy, 0), 0),
          v_st, left(p_reason, 500), p_provider_created_at, p_provider_updated_at, p_payload)
  ON CONFLICT (square_refund_id) DO UPDATE
     SET status = EXCLUDED.status, amount_jpy = EXCLUDED.amount_jpy, reason = coalesce(EXCLUDED.reason, square_refunds.reason),
         provider_updated_at = coalesce(EXCLUDED.provider_updated_at, square_refunds.provider_updated_at),
         last_payload = EXCLUDED.last_payload, updated_at = now()
  RETURNING * INTO v_new;
  IF v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_refunded',
            CASE v_st WHEN 'COMPLETED' THEN 'Card refund completed' WHEN 'FAILED' THEN 'Card refund FAILED'
                      WHEN 'REJECTED' THEN 'Card refund REJECTED' ELSE 'Card refund started' END,
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
              || ' refund ' || lower(v_st)
              || CASE WHEN v_st IN ('FAILED','REJECTED') THEN ' — the customer has NOT been paid back.'
                      ELSE '. Record the decision on the order (Website → Card payments → Refunds).' END,
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json)
    VALUES ('square_refund', v_new.id, 'square_refund_state', jsonb_build_object('status', v_old.status),
            jsonb_build_object('status', v_st, 'amount_jpy', v_new.amount_jpy, 'refund_id', p_refund_id));
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status,
                            'refund', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.record_square_refund(text, text, text, bigint, text, timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_square_refund(text, text, text, bigint, text, timestamptz, timestamptz, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.record_square_dispute(
  p_dispute_id text, p_square_payment_id text, p_state text, p_reason text, p_amount_jpy bigint,
  p_due_at timestamptz, p_provider_created_at timestamptz, p_provider_updated_at timestamptz, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_sq    public.square_payments%ROWTYPE;
  v_order public.cash_orders%ROWTYPE;
  v_old   public.square_disputes%ROWTYPE;
  v_new   public.square_disputes%ROWTYPE;
  v_st    text := upper(coalesce(p_state, 'UNKNOWN'));
BEGIN
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;
  SELECT * INTO v_old FROM public.square_disputes WHERE square_dispute_id = p_dispute_id FOR UPDATE;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_old.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  INSERT INTO public.square_disputes (square_dispute_id, square_payment_row, square_payment_id, cash_order_id,
         amount_jpy, state, reason, due_at, provider_created_at, provider_updated_at, last_payload)
  VALUES (p_dispute_id, v_sq.id, p_square_payment_id, v_sq.cash_order_id, p_amount_jpy, v_st, left(p_reason, 200),
          p_due_at, p_provider_created_at, p_provider_updated_at, p_payload)
  ON CONFLICT (square_dispute_id) DO UPDATE
     SET state = EXCLUDED.state, amount_jpy = coalesce(EXCLUDED.amount_jpy, square_disputes.amount_jpy),
         reason = coalesce(EXCLUDED.reason, square_disputes.reason), due_at = coalesce(EXCLUDED.due_at, square_disputes.due_at),
         provider_updated_at = coalesce(EXCLUDED.provider_updated_at, square_disputes.provider_updated_at),
         last_payload = EXCLUDED.last_payload, updated_at = now()
  RETURNING * INTO v_new;
  -- The first dispute also stamps the hold (legacy columns kept for the UI).
  UPDATE public.square_payments SET disputed_at = coalesce(disputed_at, now()), dispute_id = coalesce(dispute_id, p_dispute_id),
         updated_at = now()
   WHERE id = v_sq.id AND disputed_at IS NULL;
  IF v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES (CASE WHEN v_old.id IS NULL THEN 'card_dispute_opened' ELSE 'card_dispute_updated' END,
            CASE WHEN v_old.id IS NULL THEN 'Card dispute opened' ELSE 'Card dispute ' || lower(v_st) END,
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · '
              || coalesce('¥' || to_char(v_new.amount_jpy, 'FM999,999,999'), '') || ' · ' || coalesce(v_new.reason, 'no reason given')
              || ' · state ' || v_st
              || coalesce(' · evidence due ' || to_char(v_new.due_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') || ' JST', '')
              || '. Evidence is submitted in the Square Dashboard; record the decision in Website → Card payments.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'dispute_id', p_dispute_id, 'state', v_st, 'due_at', v_new.due_at, 'test', v_sq.test));
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json)
    VALUES ('square_dispute', v_new.id, 'square_dispute_state', jsonb_build_object('state', v_old.state),
            jsonb_build_object('state', v_st, 'due_at', v_new.due_at, 'dispute_id', p_dispute_id));
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state,
                            'dispute', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.record_square_dispute(text, text, text, text, bigint, timestamptz, timestamptz, timestamptz, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_square_dispute(text, text, text, text, bigint, timestamptz, timestamptz, timestamptz, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 6h. ring_square_deadline_bells — the bell and its stamp in one statement,
--     so a failed bell is retried next hour (SQ14).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ring_square_deadline_bells(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_holds int := 0; v_d3 int := 0; v_d1 int := 0;
BEGIN
  WITH due AS (
    SELECT sp.id, sp.cash_order_id, sp.square_payment_id, sp.amount_jpy, sp.capture_by, sp.test,
           o.customer_id, o.invoice_number, coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_payments sp JOIN public.cash_orders o ON o.id = sp.cash_order_id
     WHERE sp.status = 'authorized' AND sp.warned_at IS NULL AND sp.capture_by IS NOT NULL
       AND sp.capture_by - interval '2 days' <= p_now
     FOR UPDATE OF sp SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_hold_expiring', 'Card hold expires soon',
           ref || ' · ¥' || to_char(round(amount_jpy), 'FM999,999,999') || ' — Square cancels this hold on '
             || to_char(capture_by AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST. Confirm or Reject it in Payments Hub before then.',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'square_payment_id', square_payment_id,
                              'capture_by', capture_by, 'test', test)
      FROM due
    RETURNING 1
  )
  UPDATE public.square_payments sp SET warned_at = p_now, updated_at = now()
    FROM due WHERE sp.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_holds = ROW_COUNT;

  WITH due AS (
    SELECT d.id, d.cash_order_id, d.square_dispute_id, d.amount_jpy, d.due_at, d.state, o.customer_id, o.invoice_number,
           coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_disputes d JOIN public.cash_orders o ON o.id = d.cash_order_id
     WHERE d.due_at IS NOT NULL AND d.reminded_3d_at IS NULL AND d.state NOT IN ('WON','LOST','ACCEPTED')
       AND d.due_at - interval '3 days' <= p_now
     FOR UPDATE OF d SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_dispute_deadline', 'Dispute evidence due in 3 days',
           ref || ' · dispute ' || square_dispute_id || ' · evidence due ' || to_char(due_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST (Square Dashboard).',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'dispute_id', square_dispute_id, 'due_at', due_at)
      FROM due RETURNING 1
  )
  UPDATE public.square_disputes d SET reminded_3d_at = p_now, updated_at = now()
    FROM due WHERE d.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_d3 = ROW_COUNT;

  WITH due AS (
    SELECT d.id, d.cash_order_id, d.square_dispute_id, d.due_at, o.customer_id, o.invoice_number,
           coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_disputes d JOIN public.cash_orders o ON o.id = d.cash_order_id
     WHERE d.due_at IS NOT NULL AND d.reminded_1d_at IS NULL AND d.state NOT IN ('WON','LOST','ACCEPTED')
       AND d.due_at - interval '1 day' <= p_now
     FOR UPDATE OF d SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_dispute_deadline', 'Dispute evidence due within a day',
           ref || ' · dispute ' || square_dispute_id || ' · evidence due ' || to_char(due_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST (Square Dashboard).',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'dispute_id', square_dispute_id, 'due_at', due_at)
      FROM due RETURNING 1
  )
  UPDATE public.square_disputes d SET reminded_1d_at = p_now, updated_at = now()
    FROM due WHERE d.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_d1 = ROW_COUNT;

  RETURN jsonb_build_object('hold_warnings', v_holds, 'dispute_3d', v_d3, 'dispute_1d', v_d1);
END
$fn$;
REVOKE ALL ON FUNCTION public.ring_square_deadline_bells(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ring_square_deadline_bells(timestamptz) TO service_role;
COMMENT ON FUNCTION public.ring_square_deadline_bells(timestamptz) IS
  'Hourly (square-reconcile): card_hold_expiring 2 days before Square''s own capture deadline (capture_by = delayed_until), dispute evidence reminders 3 days and 1 day before due_at. Each bell and its stamp are one statement: a failed run stamps nothing and rings next hour. service_role only.';

-- ---------------------------------------------------------------------------
-- 6i. claim_square_event / finish_square_event — the inbox lease (SQ01).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_square_event(p_event_id text, p_lease_seconds integer DEFAULT 120)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_ev public.square_webhook_events%ROWTYPE;
BEGIN
  UPDATE public.square_webhook_events
     SET status = 'processing', attempts = attempts + 1, processing_started_at = now()
   WHERE event_id = p_event_id
     AND (status IN ('received','failed','quarantined')
          OR (status = 'processing' AND processing_started_at < now() - make_interval(secs => greatest(p_lease_seconds, 30))))
  RETURNING * INTO v_ev;
  IF v_ev.event_id IS NULL THEN
    SELECT * INTO v_ev FROM public.square_webhook_events WHERE event_id = p_event_id;
    RETURN jsonb_build_object('claimed', false, 'status', v_ev.status);
  END IF;
  RETURN jsonb_build_object('claimed', true, 'event', to_jsonb(v_ev));
END
$fn$;
REVOKE ALL ON FUNCTION public.claim_square_event(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_square_event(text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_square_event(
  p_event_id text, p_status text, p_outcome text, p_error text, p_retry_seconds integer DEFAULT 300)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_ev public.square_webhook_events%ROWTYPE; v_status text := p_status;
BEGIN
  IF p_status NOT IN ('done','failed','quarantined','ignored') THEN RETURN jsonb_build_object('error', 'bad_status'); END IF;
  SELECT * INTO v_ev FROM public.square_webhook_events WHERE event_id = p_event_id FOR UPDATE;
  IF v_ev.event_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_status IN ('failed','quarantined') AND v_ev.attempts >= 12 THEN v_status := 'dead'; END IF;
  UPDATE public.square_webhook_events
     SET status = v_status, outcome = coalesce(p_outcome, outcome), error = left(p_error, 500),
         last_error = CASE WHEN p_error IS NOT NULL THEN left(p_error, 500) ELSE last_error END,
         processing_started_at = NULL,
         completed_at = CASE WHEN v_status IN ('done','ignored') THEN now() ELSE NULL END,
         next_attempt_at = CASE WHEN v_status IN ('failed','quarantined')
                                THEN now() + make_interval(secs => greatest(coalesce(p_retry_seconds, 300), 60) * least(v_ev.attempts, 12))
                                ELSE NULL END
   WHERE event_id = p_event_id;
  IF v_status = 'dead' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES ('square_event_failed', 'Square event could not be processed',
            'Square event ' || p_event_id || ' (' || v_ev.event_type || ') failed 12 times: ' || coalesce(left(p_error, 200), 'unknown error')
              || '. Website → Card payments lists it; the payment is still read hourly by square-reconcile.',
            jsonb_build_object('event_id', p_event_id, 'event_type', v_ev.event_type, 'payment_id', v_ev.payment_id));
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END
$fn$;
REVOKE ALL ON FUNCTION public.finish_square_event(text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_square_event(text, text, text, text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 6j. square_fraud_cancel — owner 2026-10-04: suspected fraud cancels the
--     invoice. Never while card money is unresolved, never when other money
--     was received (terminate refuses → staff bell).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_fraud_cancel(p_order_id uuid, p_trigger text, p_detail jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_order  public.cash_orders%ROWTYPE;
  v_res    jsonb;
  v_reason text;
BEGIN
  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_order_id;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'order_not_found'); END IF;
  v_reason := 'Card payment stopped for suspected fraud (' ||
    CASE p_trigger WHEN 'order_refusals' THEN '5 declined cards on this order within 24 h'
                   WHEN 'customer_refusals' THEN '10 declined cards across this customer''s orders within 24 h'
                   WHEN 'risk_high' THEN 'Square risk evaluation HIGH'
                   ELSE coalesce(p_trigger, 'unspecified') END || ') — auto-cancelled';
  IF public.square_order_unresolved(p_order_id) THEN
    v_res := jsonb_build_object('ok', false, 'reason', 'card_payment_unresolved');
  ELSE
    BEGIN
      v_res := public.terminate_web_order_atomic(p_order_id, 'cancelled', v_reason, NULL, NULL, NULL, NULL, 'system', false);
    EXCEPTION WHEN OTHERS THEN
      v_res := jsonb_build_object('ok', false, 'reason', SQLERRM);
    END;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
  VALUES ('cash_order', p_order_id, 'card_fraud_auto_cancel',
          jsonb_build_object('trigger', p_trigger, 'detail', p_detail, 'result', v_res,
                             'invoice_number', v_order.invoice_number, 'source', 'system'));
  INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
  VALUES (CASE WHEN coalesce((v_res->>'ok')::boolean, false) THEN 'card_fraud_cancelled' ELSE 'card_fraud_suspected' END,
          CASE WHEN coalesce((v_res->>'ok')::boolean, false) THEN 'Invoice auto-cancelled: suspected card fraud'
               ELSE 'Suspected card fraud — needs a decision' END,
          coalesce(v_order.web_reference, v_order.invoice_number, '') || ' — ' || v_reason
            || CASE WHEN coalesce((v_res->>'ok')::boolean, false)
                    THEN '. Stock is back on sale. If this was a genuine customer, revive the order from its page.'
                    ELSE '. The invoice was NOT cancelled (' || coalesce(v_res->>'reason', 'refused') || '); review it now.' END,
          v_order.customer_id, v_order.invoice_number,
          jsonb_build_object('cash_order_id', p_order_id, 'trigger', p_trigger, 'detail', p_detail, 'result', v_res));
  RETURN coalesce(v_res, '{}'::jsonb) || jsonb_build_object('trigger', p_trigger);
END
$fn$;
REVOKE ALL ON FUNCTION public.square_fraud_cancel(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.square_fraud_cancel(uuid, text, jsonb) TO service_role;
COMMENT ON FUNCTION public.square_fraud_cancel(uuid, text, jsonb) IS
  'Suspected card fraud (trigger order_refusals | customer_refusals | risk_high): cancels the invoice through terminate_web_order_atomic (source system, stock back) unless card money is unresolved or terminate refuses (pending submission, money received → refund decision). Always audits and rings card_fraud_cancelled or card_fraud_suspected. The caller voids any hold first. Revive: revive_web_cash_order_atomic. service_role only.';

-- ---------------------------------------------------------------------------
-- 6k. decide_square_case — staff record a decision (owner 2A). Staff only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_square_case(p_kind text, p_id uuid, p_decision text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE v_uid uuid := auth.uid(); v_n int := 0;
BEGIN
  IF v_uid IS NULL OR NOT public.is_staff(v_uid) THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF coalesce(btrim(p_decision), '') = '' THEN RETURN jsonb_build_object('error', 'decision_required'); END IF;
  IF p_kind = 'refund' THEN
    IF p_decision NOT IN ('order_cancelled_refunded','partial_refund_order_kept','refund_failed_followed_up','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    UPDATE public.square_refunds SET decision = p_decision, decision_note = left(p_note, 1000), decided_at = now(),
           decided_by = v_uid, updated_at = now() WHERE id = p_id;
  ELSIF p_kind = 'dispute' THEN
    IF p_decision NOT IN ('evidence_submitted','accepted','won','lost','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    UPDATE public.square_disputes SET decision = p_decision, decision_note = left(p_note, 1000), decided_at = now(),
           decided_by = v_uid, updated_at = now() WHERE id = p_id;
  ELSIF p_kind = 'exception' THEN
    IF p_decision NOT IN ('recorded_manually','refunded_in_square','voided_in_square','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    IF coalesce(btrim(p_note), '') = '' THEN RETURN jsonb_build_object('error', 'note_required'); END IF;
    -- Resolving an exception releases the order gate while card money may be
    -- unrecorded: admin or finance only (CLAUDE.md: mutating paths check a
    -- real role, Bug #170).
    IF NOT (public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'finance')) THEN
      RETURN jsonb_build_object('error', 'not_permitted');
    END IF;
    UPDATE public.square_payments SET exception_resolved_at = now(), exception_resolved_by = v_uid,
           exception_note = left(coalesce(exception_note, '') || ' | resolved: ' || p_decision || ' — ' || p_note, 1000),
           updated_at = now()
     WHERE id = p_id AND exception IS NOT NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 0 THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- A Confirm that captured but could not record stays claimed ('confirmed',
    -- no payment) and would freeze the order forever: the staff decision
    -- closes it (the money was handled outside the Hub's automatic path).
    UPDATE public.payment_submissions
       SET status = 'rejected', processing_started_at = NULL, updated_at = now(),
           reviewer_notes = left('Card exception resolved by staff: ' || p_decision || ' — ' || p_note, 1000)
     WHERE square_payment_id = p_id AND status = 'confirmed' AND confirmed_payment_id IS NULL;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('square_exception', p_id, 'square_case_decided',
            jsonb_build_object('decision', p_decision, 'note', left(p_note, 1000)), v_uid);
    RETURN jsonb_build_object('ok', true);
  ELSE
    RETURN jsonb_build_object('error', 'bad_kind');
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('square_' || p_kind, p_id, 'square_case_decided',
          jsonb_build_object('decision', p_decision, 'note', left(p_note, 1000)), v_uid);
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.decide_square_case(text, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_square_case(text, uuid, text, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.decide_square_case(text, uuid, text, text) IS
  'Staff record the decision on a card refund (order_cancelled_refunded | partial_refund_order_kept | refund_failed_followed_up | other), dispute (evidence_submitted | accepted | won | lost | other) or exception (recorded_manually | refunded_in_square | voided_in_square | other; note required — it releases the order gate; admin or finance only). Audited. Staff only (is_staff).';

-- ---------------------------------------------------------------------------
-- 6l. square_settlement_report — gross card receipts vs Square fees, refunds
--     and disputes, by Japan day (review section 8). Staff, through RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_settlement_report(p_from date, p_to date, p_include_test boolean DEFAULT false)
RETURNS TABLE (day date, captures integer, gross_jpy bigint, fees_jpy bigint, refunds_completed_jpy bigint,
               refunds_open_jpy bigint, disputes_lost_jpy bigint, net_jpy bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $fn$
  WITH cap AS (
    SELECT (sp.captured_at AT TIME ZONE 'Asia/Tokyo')::date AS d,
           count(*)::int AS n,
           sum(coalesce(sp.captured_amount_jpy, 0))::bigint AS gross,
           sum(coalesce((SELECT sum((f->'amount_money'->>'amount')::bigint)
                           FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sp.last_payload->'processing_fee') = 'array'
                                                          THEN sp.last_payload->'processing_fee' ELSE '[]'::jsonb END) f), 0))::bigint AS fees
      FROM public.square_payments sp
     WHERE sp.status = 'captured' AND sp.captured_at IS NOT NULL AND (p_include_test OR NOT sp.test)
     GROUP BY 1
  ), ref AS (
    SELECT (coalesce(r.provider_updated_at, r.updated_at) AT TIME ZONE 'Asia/Tokyo')::date AS d,
           sum(CASE WHEN r.status = 'COMPLETED' THEN r.amount_jpy ELSE 0 END)::bigint AS done,
           sum(CASE WHEN r.status = 'PENDING' THEN r.amount_jpy ELSE 0 END)::bigint AS open
      FROM public.square_refunds r JOIN public.square_payments sp ON sp.id = r.square_payment_row
     WHERE (p_include_test OR NOT sp.test)
     GROUP BY 1
  ), dis AS (
    SELECT (coalesce(d.provider_updated_at, d.updated_at) AT TIME ZONE 'Asia/Tokyo')::date AS d,
           sum(CASE WHEN d.state = 'LOST' OR d.state = 'ACCEPTED' THEN coalesce(d.amount_jpy, 0) ELSE 0 END)::bigint AS lost
      FROM public.square_disputes d JOIN public.square_payments sp ON sp.id = d.square_payment_row
     WHERE (p_include_test OR NOT sp.test)
     GROUP BY 1
  ), days AS (
    SELECT d FROM cap UNION SELECT d FROM ref UNION SELECT d FROM dis
  )
  SELECT days.d, coalesce(cap.n, 0), coalesce(cap.gross, 0), coalesce(cap.fees, 0), coalesce(ref.done, 0),
         coalesce(ref.open, 0), coalesce(dis.lost, 0),
         coalesce(cap.gross, 0) - coalesce(cap.fees, 0) - coalesce(ref.done, 0) - coalesce(dis.lost, 0)
    FROM days LEFT JOIN cap ON cap.d = days.d LEFT JOIN ref ON ref.d = days.d LEFT JOIN dis ON dis.d = days.d
   WHERE days.d BETWEEN p_from AND p_to
   ORDER BY days.d;
$fn$;
REVOKE ALL ON FUNCTION public.square_settlement_report(date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.square_settlement_report(date, date, boolean) TO authenticated, service_role;
COMMENT ON FUNCTION public.square_settlement_report(date, date, boolean) IS
  'Card money by Japan day: captures and gross (what the customer paid — invoice credit), Square processing fees (from the captured payment), completed and pending refunds, lost/accepted disputes, and net to Cha Jewels. Bank payouts are not read (needs PAYOUTS_READ; Square Dashboard → Balance). SECURITY INVOKER: staff only through RLS.';

-- ---------------------------------------------------------------------------
-- 7. finalize_cash_submission_atomic — Square guard + ledger binding (SQ08).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_cash_submission_atomic(p_submission_id uuid, p_reviewer_user_id uuid, p_reviewer_notes text, p_date_paid date, p_submitted_by_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_sq         public.square_payments%ROWTYPE;
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

  -- Square (2026-10-04, SQ08/SQ10/SQ12): card money is recorded only from a
  -- hold the Hub holds as CAPTURED, on this order and customer, in JPY, for
  -- exactly the captured integer yen, and only once (cash_payment_id). A card
  -- label without its hold, or a hold under another label, is refused.
  IF lower(coalesce(v_sub.payment_method, '')) = 'square' OR v_sub.square_payment_id IS NOT NULL THEN
    IF lower(coalesce(v_sub.payment_method, '')) <> 'square' OR v_sub.square_payment_id IS NULL THEN
      RETURN jsonb_build_object('error', 'square_link_mismatch');
    END IF;
    SELECT * INTO v_sq FROM public.square_payments WHERE id = v_sub.square_payment_id FOR UPDATE;
    IF v_sq.id IS NULL THEN RETURN jsonb_build_object('error', 'square_payment_missing'); END IF;
    IF v_sq.status <> 'captured' THEN
      RETURN jsonb_build_object('error', 'square_not_captured', 'square_status', v_sq.status);
    END IF;
    IF v_sq.cash_payment_id IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'square_already_allocated', 'cash_payment_id', v_sq.cash_payment_id);
    END IF;
    IF v_sq.cash_order_id <> v_order.id OR v_sq.customer_id IS DISTINCT FROM v_order.customer_id
       OR v_sq.customer_id IS DISTINCT FROM v_sub.customer_id THEN
      RETURN jsonb_build_object('error', 'square_order_mismatch');
    END IF;
    IF v_order.currency::text <> 'JPY' OR coalesce(v_sq.currency, 'JPY') <> 'JPY' THEN
      RETURN jsonb_build_object('error', 'square_currency_mismatch');
    END IF;
    IF v_sq.captured_amount_jpy IS NULL OR v_amount <> trunc(v_amount)
       OR v_amount <> v_sq.captured_amount_jpy::numeric THEN
      RETURN jsonb_build_object('error', 'square_amount_mismatch',
        'captured_amount_jpy', v_sq.captured_amount_jpy, 'submitted_amount', v_amount);
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

  -- The card capture is now credited: bind it to this ledger row (unique).
  IF v_sq.id IS NOT NULL THEN
    UPDATE public.square_payments SET cash_payment_id = v_payment.id, updated_at = now() WHERE id = v_sq.id;
  END IF;

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
$function$;
REVOKE ALL ON FUNCTION public.finalize_cash_submission_atomic(uuid, uuid, text, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_cash_submission_atomic(uuid, uuid, text, date, text) TO service_role;
COMMENT ON FUNCTION public.finalize_cash_submission_atomic(uuid, uuid, text, date, text) IS
  'Records a CLAIMED cash-order payment submission in one transaction: cash_payments insert (Paidy: provider_capture_id), cash_orders totals/completed, submission confirmed + confirmed_payment_id, audit_logs confirm; a Square capture is bound to its cash payment (square_payments.cash_payment_id, unique). Locks the submission, the order and (Paidy/Square) the provider record. Idempotent (already_recorded). Errors: submission_not_found, not_a_cash_submission, cash_order_not_found, not_claimed, order_closed, bad_amount, exceeds_remaining; Paidy: paidy_not_captured, paidy_binding_mismatch, paidy_amount_mismatch, paidy_refunded, capture_already_recorded; Square: square_link_mismatch, square_payment_missing, square_not_captured, square_already_allocated, square_order_mismatch, square_currency_mismatch, square_amount_mismatch (exact captured integer yen). service_role only.';

-- ---------------------------------------------------------------------------
-- 8. terminate_web_order_atomic — stands down for unresolved card money (SQ11).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.terminate_web_order_atomic(p_order_id uuid, p_outcome text, p_reason text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_user_email text DEFAULT NULL::text, p_refund_status text DEFAULT NULL::text, p_refund_note text DEFAULT NULL::text, p_source text DEFAULT 'staff'::text, p_preview boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text; v_currency account_currency; v_customer_id uuid; v_invoice text; v_web_ref text;
  v_total_paid numeric(12,2);
  v_money_received numeric(12,2); v_loyalty_synthetic numeric(12,2);
  v_partial_credit numeric(12,2); v_issue_amount numeric(12,2) := 0;
  v_member_id uuid; v_credit jsonb := NULL; v_revoked_tx uuid := NULL;
  v_points_to_revoke numeric := 0; v_spend_to_reverse numeric := 0;
  v_reason text; v_is_system boolean; v_stock_lines integer := 0; v_restored integer := 0;
  v_flipped integer := 0; v_now timestamptz := now();
BEGIN
  IF p_outcome NOT IN ('expired','cancelled') THEN
    RAISE EXCEPTION 'bad_outcome: %', p_outcome USING ERRCODE='P0001';
  END IF;
  v_is_system := (p_source IN ('system','shopify_webhook'));

  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid
  FROM public.cash_orders
  WHERE id = p_order_id AND source_channel = 'web'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'not_web_order');
  END IF;
  IF v_status IN ('cancelled','expired') THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'already_terminal',
      'status', v_status, 'already_cancelled', (v_status = 'cancelled'));
  END IF;

  -- INVARIANT 12: an unconfirmed payment submission freezes AUTOMATED status.
  -- The money may already be in the bank and only the reviewer knows, so a
  -- lapse (always automated) and any system-sourced cancel stand down here.
  -- A staff cancel is a person acting deliberately and is NOT blocked.
  IF (p_outcome = 'expired' OR v_is_system) AND EXISTS (
       SELECT 1 FROM public.payment_submissions
        WHERE cash_order_id = p_order_id
          AND (status IN ('submitted','under_review')
               -- a Confirm claimed but not yet recorded (2026-10-04): the money may be taken
               OR (status = 'confirmed' AND confirmed_payment_id IS NULL))) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'submission_pending',
      'status', v_status);
  END IF;
  -- Square (2026-10-04, SQ10/SQ11): a card attempt in flight, a live hold or
  -- captured card money not yet recorded stops EVERY termination, staff
  -- included — the hold is closed (Reject) or the capture recorded first, so a
  -- cancelled order never leaves money on a card.
  IF public.square_order_unresolved(p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_payment_unresolved',
      'status', v_status);
  END IF;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_money_received
  FROM public.cash_payments
  WHERE cash_order_id = p_order_id AND voided_at IS NULL
    AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_loyalty_synthetic
  FROM public.cash_payments
  WHERE cash_order_id = p_order_id AND voided_at IS NULL
    AND COALESCE(reference_number, '') LIKE 'LOYALTY-%';
  SELECT COALESCE(SUM(original_amount), 0) INTO v_partial_credit
  FROM public.store_credit_lots
  WHERE source_cash_order_id = p_order_id
    AND source_type = 'shopify_partial_refund' AND status <> 'voided';
  SELECT COUNT(*) INTO v_stock_lines
  FROM public.cash_order_items WHERE cash_order_id = p_order_id AND variant_id IS NOT NULL;

  IF p_outcome = 'expired' THEN
    -- A lapse only ever ends an order nobody paid for. A partially paid web
    -- order is a staff decision, never an automatic one.
    IF v_status <> 'pending' OR v_money_received > 0 OR COALESCE(v_total_paid, 0) > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'not_pending_or_paid',
        'status', v_status, 'money_received', v_money_received);
    END IF;
    v_reason := COALESCE(NULLIF(btrim(p_reason), ''), 'Bank transfer not received by the deadline (auto-expired)');
  ELSE
    IF NOT p_preview AND NOT v_is_system AND p_user_id IS NULL THEN
      RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
    END IF;
    IF v_status NOT IN ('pending','completed') THEN
      RAISE EXCEPTION 'cash_order_not_cancellable: status is %', v_status USING ERRCODE='P0001';
    END IF;
    v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
    IF NOT p_preview AND v_reason IS NULL THEN
      RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE='P0001';
    END IF;
    IF p_refund_status IS NOT NULL AND p_refund_status NOT IN ('refund_issued','refund_pending','store_credit_issued','no_refund') THEN
      RAISE EXCEPTION 'bad_refund_status: %', p_refund_status USING ERRCODE='P0001';
    END IF;
    IF NOT p_preview AND v_money_received > 0 AND p_refund_status IS NULL THEN
      RAISE EXCEPTION 'refund_decision_required' USING ERRCODE='P0001';
    END IF;
    -- Store credit is minted ONLY when staff choose "store credit issued"
    -- (money received, minus credit already minted by Shopify partial refunds).
    -- A refund never doubles as credit; "no refund" is a forfeiture and mints
    -- nothing. Never automatic (owner decision 2026-09-13).
    IF p_refund_status = 'store_credit_issued' THEN
      v_issue_amount := GREATEST(0, v_money_received - v_partial_credit);
    END IF;
  END IF;

  -- Resolve what the reversal would actually do, so the preview can tell the
  -- truth and the write path does not repeat the lookup. Points are what
  -- still exists in the lots; spend is what the ledger says this order put
  -- on the counter. They are different quantities and can differ: points
  -- already redeemed or expired leave spend to reverse and no points.
  SELECT id INTO v_member_id FROM public.loyalty_members WHERE customer_id = v_customer_id;
  IF v_member_id IS NOT NULL AND v_invoice IS NOT NULL THEN
    SELECT COALESCE(SUM(remaining_amount), 0) INTO v_points_to_revoke
      FROM public.loyalty_point_lots
     WHERE member_id = v_member_id AND source_reference = v_invoice
       AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;
    v_spend_to_reverse := public.loyalty_order_spend_basis(v_member_id, v_invoice);
  END IF;

  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'is_web', true, 'invoice_number', v_invoice, 'web_reference', v_web_ref,
      'status', v_status, 'currency', v_currency, 'money_received', v_money_received,
      'loyalty_redemption_excluded', v_loyalty_synthetic,
      'partial_refund_credit_already_issued', v_partial_credit,
      'store_credit_to_issue', v_issue_amount,
      'refund_decision_required', (v_money_received > 0),
      'stock_lines', v_stock_lines,
      -- Was unconditionally true, which promised staff a reversal that could
      -- not happen once the points were gone. Now it reports both quantities.
      'earned_points_will_be_revoked', (v_points_to_revoke > 0),
      'earned_points_to_revoke', v_points_to_revoke,
      'lifetime_spend_to_reverse_jpy', v_spend_to_reverse);
  END IF;

  -- 1. Points from the lots, lifetime spend from the ledger — a ledger row plus
  --    lots marked revoked. p_spend_jpy stays 0: the basis is derived inside
  --    revoke_loyalty_points, which is the only place that knows it. Idempotent.
  IF v_member_id IS NOT NULL AND v_invoice IS NOT NULL THEN
    v_revoked_tx := public.revoke_loyalty_points(
      p_member_id => v_member_id, p_source_reference => v_invoice, p_spend_jpy => 0,
      p_account_id => NULL, p_cash_order_id => p_order_id, p_payment_id => NULL,
      p_invoice_number => v_invoice,
      p_notes => 'Revoked: web order ' || p_outcome || ' (' || v_reason || ')',
      p_created_by_user_id => p_user_id, p_trigger_event => 'cancel');
  END IF;

  -- 2. Store credit (cancelled + store_credit_issued only).
  IF v_issue_amount > 0 THEN
    v_credit := public.issue_store_credit_atomic(
      p_customer_id => v_customer_id, p_currency => v_currency, p_amount => v_issue_amount,
      p_source_type => 'cancelled_cash', p_source_account_id => NULL,
      p_source_cash_order_id => p_order_id, p_user_id => p_user_id,
      p_user_email => COALESCE(p_user_email, p_source),
      p_notes => 'Auto-issued on cancellation of ' || COALESCE(v_web_ref, v_invoice) || ' — ' || v_reason,
      p_source => p_source);
  END IF;

  -- 3. Status flip — the guard that makes everything below run exactly once.
  IF p_outcome = 'expired' THEN
    UPDATE public.cash_orders
       SET status = 'expired'::cash_order_status, expired_at = v_now,
           cancellation_reason = v_reason, updated_at = v_now
     WHERE id = p_order_id AND status NOT IN ('cancelled','expired');
  ELSE
    UPDATE public.cash_orders
       SET status = 'cancelled'::cash_order_status, cancellation_reason = v_reason,
           cancelled_at = v_now, cancelled_by_user_id = p_user_id,
           refund_status = CASE WHEN v_money_received > 0 THEN p_refund_status ELSE NULL END,
           refund_note = CASE WHEN v_money_received > 0 THEN NULLIF(btrim(COALESCE(p_refund_note,'')), '') ELSE NULL END,
           refund_decided_at = CASE WHEN v_money_received > 0 THEN v_now ELSE NULL END,
           refund_decided_by_user_id = CASE WHEN v_money_received > 0 THEN p_user_id ELSE NULL END,
           updated_at = v_now
     WHERE id = p_order_id AND status NOT IN ('cancelled','expired');
  END IF;
  GET DIAGNOSTICS v_flipped = ROW_COUNT;
  IF v_flipped = 0 THEN
    RAISE EXCEPTION 'terminal_flip_failed for %', p_order_id USING ERRCODE='P0001';
  END IF;

  -- 4. Stock back on sale — once, because step 3 ran once.
  UPDATE public.website_product_variants v
     SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
    FROM public.cash_order_items i
   WHERE i.cash_order_id = p_order_id AND i.variant_id = v.id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  -- 5. Trail.
  INSERT INTO public.account_notes (cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (p_order_id,
    CASE WHEN p_outcome = 'expired' THEN 'Web order expired: ' ELSE 'Web order cancelled: ' END || v_reason
    || CASE
         WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
         WHEN v_money_received > 0 AND p_refund_status IN ('refund_issued','refund_pending') THEN ' — ' || replace(p_refund_status, '_', ' ') || ', no store credit'
         WHEN v_money_received > 0 AND p_refund_status = 'no_refund' THEN ' — no refund (forfeited), no store credit'
         WHEN v_money_received > 0 THEN ' — no additional store credit (already issued via partial refunds)'
         ELSE ' — no payments received'
       END
    || ' — stock restored on ' || v_restored || ' line(s)',
    p_user_id, CASE WHEN v_is_system THEN 'System' ELSE COALESCE(p_user_email, 'System') END);

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('cash_order', p_order_id, CASE WHEN p_outcome = 'expired' THEN 'auto_expired' ELSE 'cancel' END, p_user_id,
    jsonb_build_object(
      'invoice_number', v_invoice, 'web_reference', v_web_ref, 'reason', v_reason, 'prior_status', v_status,
      'currency', v_currency, 'money_received', v_money_received,
      'loyalty_redemption_excluded', v_loyalty_synthetic,
      'partial_refund_credit_already_issued', v_partial_credit,
      'refund_status', p_refund_status, 'refund_note', p_refund_note,
      'store_credit_issued', v_credit, 'earned_points_revoked_tx', v_revoked_tx,
      'earned_points_revoked', v_points_to_revoke,
      'lifetime_spend_reversed_jpy', v_spend_to_reverse,
      'stock_lines_restored', v_restored, 'source', p_source,
      'actor', CASE WHEN v_is_system THEN p_source ELSE COALESCE(p_user_email, 'unknown') END));

  RETURN jsonb_build_object(
    'ok', true, 'success', true, 'outcome', p_outcome, 'is_web', true,
    'cash_order_id', p_order_id, 'order_id', p_order_id,
    'invoice_number', v_invoice, 'web_reference', v_web_ref,
    'prior_status', v_status, 'currency', v_currency, 'money_received', v_money_received,
    'loyalty_redemption_excluded', v_loyalty_synthetic,
    'partial_refund_credit_already_issued', v_partial_credit,
    'refund_status', p_refund_status,
    'store_credit', v_credit, 'earned_points_revoked_tx', v_revoked_tx,
    'earned_points_revoked', v_points_to_revoke,
    'lifetime_spend_reversed_jpy', v_spend_to_reverse,
    'lines_restored', v_restored, 'source', p_source);
END;
$function$;
REVOKE ALL ON FUNCTION public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- 10. Self-checks.
-- ---------------------------------------------------------------------------
DO $chk$
DECLARE f text;
BEGIN
  IF to_regclass('public.square_card_attempts') IS NULL OR to_regclass('public.square_refunds') IS NULL
     OR to_regclass('public.square_disputes') IS NULL THEN
    RAISE EXCEPTION 'square integrity: a table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'square_payments' AND column_name = 'cash_payment_id') THEN
    RAISE EXCEPTION 'square integrity: square_payments.cash_payment_id missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                  AND table_name = 'square_webhook_events' AND column_name = 'next_attempt_at') THEN
    RAISE EXCEPTION 'square integrity: inbox columns missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_provider_submission') THEN
    RAISE EXCEPTION 'square integrity: guard trigger missing';
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'public.square_order_unresolved(uuid)', 'public.square_refusal_counts(uuid, uuid)',
    'public.reserve_square_attempt(uuid, uuid, bigint, text, text, text, boolean, text, text, text, jsonb)',
    'public.resolve_square_attempt(uuid, text, text[], text, text, text, text)',
    'public.file_square_authorization_atomic(uuid, text, bigint, text, text, text, text, text, timestamptz, timestamptz, text, jsonb, text, timestamptz, jsonb, date, text, text, text, text)',
    'public.apply_square_payment_state(text, text, bigint, bigint, text, text, timestamptz, timestamptz, timestamptz, text, text, text, text, jsonb, jsonb, text, uuid)',
    'public.claim_square_action(uuid, text, uuid)', 'public.release_square_action(uuid, text)',
    'public.record_square_refund(text, text, text, bigint, text, timestamptz, timestamptz, jsonb)',
    'public.record_square_dispute(text, text, text, text, bigint, timestamptz, timestamptz, timestamptz, jsonb)',
    'public.ring_square_deadline_bells(timestamptz)', 'public.claim_square_event(text, integer)',
    'public.finish_square_event(text, text, text, text, integer)', 'public.square_fraud_cancel(uuid, text, jsonb)',
    'public.finalize_cash_submission_atomic(uuid, uuid, text, date, text)',
    'public.cash_order_payment_lock(uuid, uuid, boolean)',
    'public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean)']
  LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'square integrity: % is executable by a client role', f;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.decide_square_case(text, uuid, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'square integrity: decide_square_case is executable by anon';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)'::regprocedure)
     <> '15daada758f0ed1446975306b3f4d302' THEN
    RAISE EXCEPTION 'square integrity: finalize_cash_submission_atomic body is not this file''s';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.cash_order_payment_lock(uuid,uuid,boolean)'::regprocedure)
     <> '91b33668173071731d78205febc1722f' THEN
    RAISE EXCEPTION 'square integrity: cash_order_payment_lock body is not this file''s';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure)
     <> '873059443104e55b35d3b209f361bd7a' THEN
    RAISE EXCEPTION 'square integrity: terminate_web_order_atomic body is not this file''s';
  END IF;
END
$chk$;
