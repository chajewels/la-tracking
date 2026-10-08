-- 20261125100000_paidy_pr3_recovery.sql
-- Paidy reassessment PR 3 — recovery (PA05 / PA09 / PA04 / PA10), owner go
-- 2026-10-08 17:39 JST (plan: claude/paidy-pr3-recovery-plan-2026-10-08.md).
--
--   PA09  Inbox lease: claim_paidy_webhook_event (compare-and-set, 5-minute
--         lease) so a late webhook finish and the hourly sweep never process
--         one notification together. Bookkeeping errors are counted by the
--         edge code; a parked event never blocks and is never dropped.
--   PA10  Inbox classification + partition: cash_order_id / test are written
--         on an event once its payment is known; parked_reason
--         ('other_environment' | 'unknown_to_this_key') keeps an event this
--         key cannot answer OUT of the working batch and retried daily by the
--         key that can — never discarded at 30 days (owner decision).
--         tried_test / tried_live record which key answered 404, so an id
--         unknown to BOTH keys is the only one closed as not ours.
--   PA04  expire_paidy_checkout_attempts (in place, md5-guarded): the
--         pending-event guard becomes ORDER-CORRELATED (an unparked event
--         naming this order, or one not yet classified); a window that knows
--         its Paidy payment id ends only after the sweep verified with Paidy
--         that it holds nothing (verified_empty_at); the result is named
--         (verification = verified_empty | unverified_no_id).
--         note_paidy_checkout_attempt_payment (NEW): the storefront's
--         rejected/closed callback now hands the Hub the payment id Paidy gave
--         the window, so the sweep has something to verify.
--
-- Function bodies are patched IN PLACE from the live text behind an md5 guard
-- (Bug #280); the helper STOPS, changing nothing, if the function has moved or
-- an anchor is not found exactly once. Live md5 read 2026-10-08 17:30 JST:
--   expire_paidy_checkout_attempts(uuid)   81d31a6f2ed85907e5732ed2e6dcae27
-- Expected after this migration:            b6d33a3a3c60760c0ce040f18ae727f8
-- (recorded verbatim in 20261126100000_record_live_paidy_pr3_body.sql).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.cj_patch(p_sig text, p_before text, p_edits jsonb)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn   regprocedure;
  v_def  text;
  v_new  text;
  e      jsonb;
  v_n    integer;
  v_done boolean := true;
BEGIN
  v_fn := to_regprocedure(p_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', p_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    IF position(e ->> 'new' IN v_def) = 0 THEN v_done := false; END IF;
  END LOOP;
  IF v_done THEN
    RAISE NOTICE '% already patched — no change', p_sig;
    RETURN;
  END IF;
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', p_sig, md5(v_def);
  END IF;
  v_new := v_def;
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    v_n := (length(v_new) - length(replace(v_new, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'STOP — % anchor found % times, expected 1: %', p_sig, v_n, left(e ->> 'old', 120);
    END IF;
    v_new := replace(v_new, e ->> 'old', e ->> 'new');
  END LOOP;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
    RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', p_sig;
  END IF;
END
$p$;

-- ---------------------------------------------------------------------------
-- 1. Inbox columns (PA09 lease, PA10 classification + partition)
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_webhook_events
  ADD COLUMN IF NOT EXISTS claimed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_by    text,
  ADD COLUMN IF NOT EXISTS cash_order_id uuid,
  ADD COLUMN IF NOT EXISTS test          boolean,
  ADD COLUMN IF NOT EXISTS parked_reason text,
  ADD COLUMN IF NOT EXISTS tried_test    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tried_live    boolean NOT NULL DEFAULT false;
ALTER TABLE public.paidy_webhook_events DROP CONSTRAINT IF EXISTS paidy_webhook_events_parked_reason_check;
ALTER TABLE public.paidy_webhook_events
  ADD CONSTRAINT paidy_webhook_events_parked_reason_check
  CHECK (parked_reason IS NULL OR parked_reason IN ('other_environment', 'unknown_to_this_key'));
CREATE INDEX IF NOT EXISTS idx_paidy_webhook_events_working
  ON public.paidy_webhook_events (next_attempt_at) WHERE processed_at IS NULL AND parked_reason IS NULL;
CREATE INDEX IF NOT EXISTS idx_paidy_webhook_events_parked
  ON public.paidy_webhook_events (next_attempt_at) WHERE processed_at IS NULL AND parked_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_paidy_webhook_events_order
  ON public.paidy_webhook_events (cash_order_id) WHERE processed_at IS NULL;
COMMENT ON COLUMN public.paidy_webhook_events.parked_reason IS
  'PA10: other_environment = the payment belongs to the other key family (test/live) and is retried daily by that key; unknown_to_this_key = Paidy answered 404 to this key, the other key gets its turn. Parked events never block a window expiry and are never discarded (owner 2026-10-08).';
COMMENT ON COLUMN public.paidy_webhook_events.cash_order_id IS
  'PA04/PA10: the order the notification concerns, written once classified (Hub row or Paidy read-back). NULL = not yet classified; such an event holds every window expiry for that run (fail closed).';

-- Lease (PA09): the caller that wins the claim processes the event; the
-- lease expires after p_lease_seconds so a crashed worker never holds it.
CREATE OR REPLACE FUNCTION public.claim_paidy_webhook_event(p_id uuid, p_by text, p_lease_seconds integer DEFAULT 300)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.paidy_webhook_events
     SET claimed_at = now(), claimed_by = left(coalesce(p_by, 'unknown'), 40)
   WHERE id = p_id AND processed_at IS NULL
     AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => greatest(30, coalesce(p_lease_seconds, 300))));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$function$;
REVOKE ALL ON FUNCTION public.claim_paidy_webhook_event(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_paidy_webhook_event(uuid, text, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Checkout windows (PA04)
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_checkout_attempts
  ADD COLUMN IF NOT EXISTS verified_empty_at timestamptz,
  ADD COLUMN IF NOT EXISTS verification      text;
ALTER TABLE public.paidy_checkout_attempts DROP CONSTRAINT IF EXISTS paidy_checkout_attempts_verification_check;
ALTER TABLE public.paidy_checkout_attempts
  ADD CONSTRAINT paidy_checkout_attempts_verification_check
  CHECK (verification IS NULL OR verification IN ('verified_empty', 'unverified_no_id'));
COMMENT ON COLUMN public.paidy_checkout_attempts.verification IS
  'PA04: how a timed-out window was ended. verified_empty = the sweep read its Paidy payment back and it holds nothing; unverified_no_id = no payment id was ever learned (callback and webhook both lost), ended on time alone.';

-- The storefront's rejected / closed callback carries the payment id Paidy gave
-- the window; the sweep then verifies it with Paidy before the window ends.
CREATE OR REPLACE FUNCTION public.note_paidy_checkout_attempt_payment(p_attempt_id uuid, p_customer_id uuid, p_paidy_payment_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF p_paidy_payment_id IS NULL OR p_paidy_payment_id !~ '^pay_[A-Za-z0-9_-]{6,80}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_payment_id');
  END IF;
  UPDATE public.paidy_checkout_attempts
     SET paidy_payment_id = p_paidy_payment_id
   WHERE id = p_attempt_id AND customer_id = p_customer_id AND status = 'open'
     AND paidy_payment_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'noted', v_n = 1);
END
$function$;
REVOKE ALL ON FUNCTION public.note_paidy_checkout_attempt_payment(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_paidy_checkout_attempt_payment(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Capture watch without an age limit (PA10): every capture of this key
--    family that the Hub has NOT recorded and Paidy has not fully refunded is
--    money — the sweep re-reads it whatever its age, captured_at NULL
--    included. Recorded captures keep the 400-day refund window in the sweep.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.paidy_unrecorded_captures(p_test boolean, p_limit integer DEFAULT 50)
RETURNS SETOF public.paidy_payments
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT pp.*
    FROM public.paidy_payments pp
   WHERE pp.status = 'captured' AND pp.test = p_test
     AND coalesce(pp.refund_jpy, 0) < pp.amount_jpy
     AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                      WHERE s.paidy_payment_id = pp.id AND s.confirmed_payment_id IS NOT NULL)
   ORDER BY pp.last_checked_at ASC NULLS FIRST
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
$function$;
REVOKE ALL ON FUNCTION public.paidy_unrecorded_captures(boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paidy_unrecorded_captures(boolean, integer) TO service_role;

-- expire_paidy_checkout_attempts — in place from the live body.
SELECT pg_temp.cj_patch(
  'public.expire_paidy_checkout_attempts(uuid)',
  '81d31a6f2ed85907e5732ed2e6dcae27',
  jsonb_build_array(
    jsonb_build_object('old', $e$     SET status = 'expired', ended_at = now(), end_reason = coalesce(a.end_reason, 'timeout')
$e$, 'new', $e$     SET status = 'expired', ended_at = now(), end_reason = coalesce(a.end_reason, 'timeout'),
         -- PA04 (2026-10-08): the result is named honestly. verified_empty =
         -- the sweep read the window's payment back from Paidy and it holds
         -- nothing; unverified_no_id = the Hub never learned a payment id
         -- (callback and webhook both lost), so there was nothing to ask
         -- Paidy for — the lock is released on time alone and a late
         -- authorisation is still filed or released by the sweep.
         verification = CASE WHEN a.verified_empty_at IS NOT NULL THEN 'verified_empty' ELSE 'unverified_no_id' END
$e$),
    jsonb_build_object('old', $e$     AND (p_cash_order_id IS NULL OR a.cash_order_id = p_cash_order_id)
$e$, 'new', $e$     AND (p_cash_order_id IS NULL OR a.cash_order_id = p_cash_order_id)
     -- A window that knows its payment id ends only once the sweep has
     -- verified with Paidy that it holds nothing (verified_empty_at).
     AND (a.paidy_payment_id IS NULL OR a.verified_empty_at IS NOT NULL)
$e$),
    jsonb_build_object('old', $e$     AND NOT EXISTS (
       SELECT 1 FROM public.paidy_webhook_events e
        WHERE e.processed_at IS NULL AND e.received_at >= a.started_at
          AND coalesce(e.last_error, '') <> 'other_environment');
$e$, 'new', $e$     -- PA04: ORDER-CORRELATED guard — only an unprocessed, unparked
     -- notification that names THIS order, or one the sweep has not yet
     -- classified, holds the window. A stuck event on another order never
     -- hides every customer's other payment methods; parked events (other
     -- environment, unknown id) never hold anything.
     AND NOT EXISTS (
       SELECT 1 FROM public.paidy_webhook_events e
        WHERE e.processed_at IS NULL AND e.parked_reason IS NULL
          AND e.received_at >= a.started_at
          AND (e.cash_order_id = a.cash_order_id OR e.cash_order_id IS NULL));
$e$)
  ));

-- ---------------------------------------------------------------------------
-- Self-checks: STOP loudly if anything above did not land.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v text;
BEGIN
  v := pg_get_functiondef('public.expire_paidy_checkout_attempts(uuid)'::regprocedure);
  IF md5(v) <> 'b6d33a3a3c60760c0ce040f18ae727f8' THEN RAISE EXCEPTION 'self-check expire_paidy_checkout_attempts body md5 % unexpected', md5(v); END IF;
  IF position('e.parked_reason IS NULL' IN v) = 0 OR position('verified_empty_at IS NOT NULL' IN v) = 0 THEN RAISE EXCEPTION 'self-check expire_paidy_checkout_attempts failed'; END IF;
  IF to_regprocedure('public.claim_paidy_webhook_event(uuid,text,integer)') IS NULL THEN RAISE EXCEPTION 'self-check claim_paidy_webhook_event missing'; END IF;
  IF to_regprocedure('public.note_paidy_checkout_attempt_payment(uuid,uuid,text)') IS NULL THEN RAISE EXCEPTION 'self-check note_paidy_checkout_attempt_payment missing'; END IF;
  IF to_regprocedure('public.paidy_unrecorded_captures(boolean,integer)') IS NULL THEN RAISE EXCEPTION 'self-check paidy_unrecorded_captures missing'; END IF;
  PERFORM 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'paidy_webhook_events' AND column_name = 'parked_reason';
  IF NOT FOUND THEN RAISE EXCEPTION 'self-check paidy_webhook_events.parked_reason missing'; END IF;
  PERFORM 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'paidy_checkout_attempts' AND column_name = 'verified_empty_at';
  IF NOT FOUND THEN RAISE EXCEPTION 'self-check paidy_checkout_attempts.verified_empty_at missing'; END IF;
END $$;
