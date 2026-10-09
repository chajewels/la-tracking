-- 20261201100000_paidy_qc_pr_a.sql
-- Paidy QC PR-A, Hub database part (owner go 2026-10-09 19:44 JST, all
-- recommended options). Assessment: project doc
-- claude/paidy-qc-assessment-2026-10-09.md. Every finding below was
-- reproduced on a scratch replay whose Paidy bodies are byte-identical to
-- live (md5 per function, read 2026-10-09).
--
--   H1  A made-up Paidy id noted on a checkout window froze the order for
--       good (the window never expired, staff could not cancel or change the
--       method). NEW: staff_end_paidy_checkout_window — an audited staff exit
--       (confirm_payment, written reason, only once the window has timed out),
--       reached ONLY through the paidy-staff-action edge function, which first
--       asks Paidy what the window's payment holds. NEW columns
--       not_found_test_at / not_found_live_at: Paidy's 404 under BOTH key
--       families counts as "holds nothing" (the sweep stamps them).
--   M2  resolve_paidy_case 'end_submission' unlocked the order while Paidy
--       still held a capturable authorisation. Now refused
--       (authorization_open) until the authorisation is closed at Paidy.
--   M3  resolve_paidy_case took the Paidy row lock before the order lock (the
--       reverse of every other writer; V03-F1). Now submission → order → row.
--   M4  NEW end_paidy_submission_provider_ended_atomic: "Paidy ended this
--       authorisation" (Confirm and the sync) is ONE transaction — row status,
--       submission rejected, audit, and the customer-email intent the sweep
--       replays — instead of three separate writes.
--   M5  NEW columns paidy_webhook_events.source_ip / source_recognised: the
--       webhook records the source it saw (evidence for the header check) and
--       caps unrecognised deliveries per minute.
--   M6  file_paidy_submission_atomic wrote a waiting Paidy row even behind a
--       live card payment; that row outranks the card in the lock, so the card
--       could be charged and never recorded. Now refused (card_payment_unresolved)
--       before anything is written; the caller releases it at Paidy.
--   M7  get_paidy_settings counted test captures while live. Now this
--       environment's payments only.
--   L4  An inbox event not yet tied to an order held every customer's window
--       indefinitely. Now 2 hours at most.
--   L7  NOT changed (independent review): a refund larger than the capture is
--       still written to the ledger as before — the cancel RPCs' "no double
--       compensation" refusal (PA02) reads that ledger, so dropping the row
--       would let store credit be issued for money Paidy already returned.
--   L10 paidy_mode() was callable by any signed-in login. Now service_role only
--       (its four callers are SECURITY DEFINER and run as the owner).
--
-- HOW (CLAUDE.md "FUNCTION CHANGES START FROM LIVE"): each existing function
-- is patched IN PLACE from its live body (pg_temp.cj_patch, copied from
-- 20261130130000): refuses unless live md5 equals the one read on 2026-10-09,
-- each anchor must occur exactly once, re-run = no-op. Grants re-asserted as on
-- live. New functions: service_role only, except where noted.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Patch helper (session-only), copied from 20261130130000.
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
-- Columns and constraints
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_checkout_attempts
  ADD COLUMN IF NOT EXISTS not_found_test_at timestamptz,
  ADD COLUMN IF NOT EXISTS not_found_live_at timestamptz,
  ADD COLUMN IF NOT EXISTS ended_by uuid;
COMMENT ON COLUMN public.paidy_checkout_attempts.not_found_test_at IS
  'H1 (Paidy QC 2026-10-09): when the TEST key answered 404 for this window''s payment id. With not_found_live_at set too, Paidy holds nothing for it (verified_empty).';
COMMENT ON COLUMN public.paidy_checkout_attempts.not_found_live_at IS
  'H1 (Paidy QC 2026-10-09): when the LIVE key answered 404 for this window''s payment id.';
COMMENT ON COLUMN public.paidy_checkout_attempts.ended_by IS
  'H1 (Paidy QC 2026-10-09): the staff member who ended the window (staff_end_paidy_checkout_window).';

ALTER TABLE public.paidy_checkout_attempts DROP CONSTRAINT IF EXISTS paidy_checkout_attempts_verification_check;
ALTER TABLE public.paidy_checkout_attempts ADD CONSTRAINT paidy_checkout_attempts_verification_check
  CHECK (verification IS NULL OR verification = ANY (ARRAY['verified_empty'::text, 'unverified_no_id'::text, 'staff_ended'::text]));

ALTER TABLE public.paidy_webhook_events
  ADD COLUMN IF NOT EXISTS source_ip text,
  ADD COLUMN IF NOT EXISTS source_recognised boolean;
COMMENT ON COLUMN public.paidy_webhook_events.source_ip IS
  'M5 (Paidy QC 2026-10-09): the source address(es) the webhook saw (cf-connecting-ip | last x-forwarded-for hop). Evidence for the header check; never a decision on processing.';
COMMENT ON COLUMN public.paidy_webhook_events.source_recognised IS
  'M5 (Paidy QC 2026-10-09): true when every address the webhook saw is one of Paidy''s published IPs. Unrecognised deliveries are capped per minute.';
CREATE INDEX IF NOT EXISTS idx_paidy_webhook_events_unrecognised
  ON public.paidy_webhook_events (received_at) WHERE source_recognised = false;

-- ---------------------------------------------------------------------------
-- M2 + M3: resolve_paidy_case
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.resolve_paidy_case(uuid,text,text)', '29887dd66f546ab4038e20a49e6b28ee', jsonb_build_array(
  jsonb_build_object('old', $o$  v_sub  public.payment_submissions%ROWTYPE;
BEGIN
$o$, 'new', $n$  v_sub  public.payment_submissions%ROWTYPE;
  v_order_id uuid;
BEGIN
$n$),
  jsonb_build_object('old', $o$    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    IF v_rec.id IS NULL OR v_rec.status <> 'captured' THEN RETURN jsonb_build_object('error', 'paidy_not_captured'); END IF;
    IF coalesce(v_rec.refund_jpy, 0) <> 0 THEN RETURN jsonb_build_object('error', 'paidy_refunded'); END IF;
    PERFORM 1 FROM public.cash_orders WHERE id = v_rec.cash_order_id FOR UPDATE;
$o$, 'new', $n$    -- M3 (Paidy QC 2026-10-09): the shared lock order (V03-F1) — the order,
    -- then the Paidy row (no submission exists yet; this inserts one).
    SELECT cash_order_id INTO v_order_id FROM public.paidy_payments WHERE id = v_case.paidy_payment_row;
    PERFORM 1 FROM public.cash_orders WHERE id = v_order_id FOR UPDATE;
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    IF v_rec.id IS NULL OR v_rec.status <> 'captured' THEN RETURN jsonb_build_object('error', 'paidy_not_captured'); END IF;
    IF coalesce(v_rec.refund_jpy, 0) <> 0 THEN RETURN jsonb_build_object('error', 'paidy_refunded'); END IF;
$n$),
  jsonb_build_object('old', $o$    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    -- P01 (2026-10-06): a note never settles captured money — record it, or
$o$, 'new', $n$    -- M3 (Paidy QC 2026-10-09): the shared lock order (V03-F1) — the
    -- submission(s), then the order, then the Paidy row.
    PERFORM 1 FROM public.payment_submissions
     WHERE paidy_payment_id = v_case.paidy_payment_row
       AND (status IN ('submitted','under_review') OR (status = 'confirmed' AND confirmed_payment_id IS NULL))
     ORDER BY id FOR UPDATE;
    SELECT cash_order_id INTO v_order_id FROM public.paidy_payments WHERE id = v_case.paidy_payment_row;
    PERFORM 1 FROM public.cash_orders WHERE id = v_order_id FOR UPDATE;
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    -- M2 (Paidy QC 2026-10-09): never while Paidy still holds a capturable
    -- authorisation — ending the submission would reopen the order with the
    -- money still reserved (and capturable) at Paidy. The Hub closes it at
    -- Paidy first (paidy-staff-action close_authorization), then this runs.
    IF v_rec.status = 'authorized'
       AND coalesce(v_rec.expires_at, v_rec.authorized_at + interval '30 days') > now() THEN
      RETURN jsonb_build_object('error', 'authorization_open', 'paidy_payment_id', v_rec.paidy_payment_id);
    END IF;
    -- P01 (2026-10-06): a note never settles captured money — record it, or
$n$)
));
REVOKE ALL ON FUNCTION public.resolve_paidy_case(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_paidy_case(uuid,text,text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- M6: file_paidy_submission_atomic — a live card payment wins
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.file_paidy_submission_atomic(uuid,uuid,text,numeric,boolean,timestamp with time zone,timestamp with time zone,jsonb,date,text,text,text)', '195964b6fa65d2936fa41a0eb08699d6', jsonb_build_array(
  jsonb_build_object('old', $o$  -- The record is written BEFORE the one-payment check, so an authorisation
$o$, 'new', $n$  -- M6 (Paidy QC 2026-10-09): a card payment in flight on this order wins.
  -- An authorisation arriving behind it is NOT written: a waiting Paidy row
  -- outranks the card in cash_order_payment_lock, so the card could be
  -- captured and then refused at recording. The caller releases it at Paidy.
  IF public.cash_order_payment_lock(v_order.id, v_rec.id, true) = 'card_payment_unresolved' THEN
    RETURN jsonb_build_object('error', 'card_payment_unresolved', 'lock', 'card_payment_unresolved');
  END IF;

  -- The record is written BEFORE the one-payment check, so an authorisation
$n$)
));
REVOKE ALL ON FUNCTION public.file_paidy_submission_atomic(uuid,uuid,text,numeric,boolean,timestamp with time zone,timestamp with time zone,jsonb,date,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_paidy_submission_atomic(uuid,uuid,text,numeric,boolean,timestamp with time zone,timestamp with time zone,jsonb,date,text,text,text) TO service_role;

-- ---------------------------------------------------------------------------
-- L4: expire_paidy_checkout_attempts — an uncorrelated event holds ≤ 2 h
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.expire_paidy_checkout_attempts(uuid)', 'b6d33a3a3c60760c0ce040f18ae727f8', jsonb_build_array(
  jsonb_build_object('old', $o$          AND (e.cash_order_id = a.cash_order_id OR e.cash_order_id IS NULL));
$o$, 'new', $n$          AND (e.cash_order_id = a.cash_order_id
               -- L4 (Paidy QC 2026-10-09): an event not yet tied to any order
               -- holds a window for 2 hours at most, so a Paidy outage never
               -- freezes every customer's other payment methods.
               OR (e.cash_order_id IS NULL AND e.received_at > now() - interval '2 hours')));
$n$)
));
REVOKE ALL ON FUNCTION public.expire_paidy_checkout_attempts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_paidy_checkout_attempts(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- M7: get_paidy_settings — this environment's payments only
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.get_paidy_settings()', 'c5cf9d1780d07709195e27af2fa9c79c', jsonb_build_array(
  jsonb_build_object('old', $o$    'authorized_now',     (SELECT count(*) FROM public.paidy_payments WHERE status = 'authorized'),
    'captured_30d',       (SELECT count(*) FROM public.paidy_payments
                            WHERE status = 'captured' AND captured_at >= now() - interval '30 days'));
$o$, 'new', $n$    -- M7 (Paidy QC 2026-10-09): this environment's payments only — a test
    -- capture is never counted while live keys are in (or the reverse).
    'authorized_now',     (SELECT count(*) FROM public.paidy_payments
                            WHERE status = 'authorized' AND test = (public.paidy_mode() = 'test')),
    'captured_30d',       (SELECT count(*) FROM public.paidy_payments
                            WHERE status = 'captured' AND captured_at >= now() - interval '30 days'
                              AND test = (public.paidy_mode() = 'test')));
$n$)
));
REVOKE ALL ON FUNCTION public.get_paidy_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_paidy_settings() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- L10: paidy_mode() — service_role only (callers are SECURITY DEFINER)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.paidy_mode() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paidy_mode() TO service_role;

-- ---------------------------------------------------------------------------
-- H1: the staff exit for a stuck Paidy window
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_end_paidy_checkout_window(
  p_cash_order_id uuid, p_user_id uuid, p_reason text, p_check jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_att public.paidy_checkout_attempts%ROWTYPE;
BEGIN
  -- Reached only through the paidy-staff-action edge function (service_role),
  -- which first asks Paidy what the window's payment holds (an authorisation
  -- is filed or released, a capture opens its case) and passes the answer in
  -- p_check for the audit row.
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(p_user_id, 'confirm_payment') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;
  PERFORM 1 FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  SELECT * INTO v_att FROM public.paidy_checkout_attempts
   WHERE cash_order_id = p_cash_order_id AND status = 'open' FOR UPDATE;
  IF v_att.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'ended', 0, 'lock_after', public.cash_order_payment_lock(p_cash_order_id));
  END IF;
  -- The customer may be paying in Paidy right now: only a window that has
  -- timed out (30 minutes) can be ended by staff.
  IF v_att.expires_at > now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'window_still_open', 'expires_at', v_att.expires_at);
  END IF;
  -- The edge function's Paidy check was about the id the window held then;
  -- a callback that noted an id since is not ended unchecked.
  IF v_att.paidy_payment_id IS DISTINCT FROM NULLIF(p_check ->> 'paidy_payment_id', '') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'window_changed');
  END IF;

  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now(), end_reason = 'staff_ended',
         verification = 'staff_ended', ended_by = p_user_id
   WHERE id = v_att.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('cash_order', p_cash_order_id, 'paidy_window_ended_by_staff', p_user_id,
          jsonb_build_object('attempt_id', v_att.id, 'paidy_payment_id', v_att.paidy_payment_id,
            'started_at', v_att.started_at, 'expires_at', v_att.expires_at,
            'customer_closed_at', v_att.customer_closed_at, 'reason', btrim(p_reason),
            'paidy_check', coalesce(p_check, '{}'::jsonb)));

  RETURN jsonb_build_object('ok', true, 'ended', 1, 'attempt_id', v_att.id,
                            'lock_after', public.cash_order_payment_lock(p_cash_order_id));
END
$function$;
REVOKE ALL ON FUNCTION public.staff_end_paidy_checkout_window(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_end_paidy_checkout_window(uuid,uuid,text,jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- M4: "Paidy ended this authorisation" in ONE transaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.end_paidy_submission_provider_ended_atomic(
  p_submission_id uuid, p_paidy_row uuid, p_end_status text, p_end_reason text,
  p_reviewer_notes text, p_user_id uuid DEFAULT NULL, p_claim_at timestamptz DEFAULT NULL,
  p_payload jsonb DEFAULT NULL, p_audit jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sub      public.payment_submissions%ROWTYPE;
  v_order_id uuid;
  v_row      public.paidy_payments%ROWTYPE;
  v_n        integer := 0;
  v_key      text;
  v_followup uuid;
BEGIN
  -- Paidy itself ended the authorisation (closed / rejected / expired, nothing
  -- captured) — read back by a Confirm or by the sync. The Paidy row, the
  -- submission, the audit row and the customer-email intent are written
  -- together; the sweep replays the email if the sender is never reached.
  IF p_end_status IS NULL OR p_end_status NOT IN ('closed', 'rejected', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_end_status');
  END IF;
  -- V03-F1 lock order: submission, order, provider row.
  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;
  v_order_id := v_sub.cash_order_id;
  IF v_order_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  PERFORM 1 FROM public.cash_orders o WHERE o.id = v_order_id FOR UPDATE;
  IF v_sub.paidy_payment_id IS NULL OR v_sub.paidy_payment_id <> p_paidy_row THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_this_paidy_submission');
  END IF;
  IF v_sub.status = 'rejected' THEN
    RETURN jsonb_build_object('ok', true, 'rejected', false, 'already_rejected', true, 'submission_id', v_sub.id);
  END IF;
  -- Still queued, or claimed by the Confirm that read Paidy (same claim stamp).
  IF NOT (v_sub.status IN ('submitted', 'under_review')
          OR (p_claim_at IS NOT NULL AND v_sub.status = 'confirmed' AND v_sub.confirmed_payment_id IS NULL
              AND v_sub.processing_started_at = p_claim_at)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'status', v_sub.status);
  END IF;

  SELECT * INTO v_row FROM public.paidy_payments WHERE id = p_paidy_row FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'paidy_row_missing'); END IF;
  IF v_row.status = 'captured' THEN RETURN jsonb_build_object('ok', false, 'error', 'paidy_captured'); END IF;

  UPDATE public.paidy_payments
     SET status = p_end_status, closed_at = COALESCE(closed_at, now()),
         closed_reason = left(COALESCE(p_end_reason, 'ended at Paidy'), 200),
         last_payload = COALESCE(p_payload, last_payload), updated_at = now()
   WHERE id = p_paidy_row AND status = 'authorized';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Provider-ended, not a staff decision: no customer message (H5).
  UPDATE public.payment_submissions
     SET status = 'rejected', reviewer_user_id = p_user_id, reviewer_notes = p_reviewer_notes,
         customer_message = NULL, processing_started_at = NULL, updated_at = now()
   WHERE id = p_submission_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, old_value_json, new_value_json)
  VALUES ('cash_payment_submission', p_submission_id, 'submission_rejected', p_user_id,
          jsonb_build_object('status', v_sub.status),
          coalesce(p_audit, '{}'::jsonb) || jsonb_build_object(
            'reason', 'paidy_' || p_end_status, 'paidy_payment_id', v_row.paidy_payment_id,
            'paidy_end_status', p_end_status, 'paidy_row_updated', v_n = 1, 'atomic', true, 'provider_ended', true));

  v_key := 'payment-rejected-' || p_submission_id::text;
  INSERT INTO public.payment_submission_followups (kind, submission_id, cash_order_id, idempotency_key, payload)
  VALUES ('paidy_rejected_email', p_submission_id, v_order_id, v_key, jsonb_build_object('kind', 'provider_ended'))
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_followup;
  IF v_followup IS NULL THEN
    SELECT id INTO v_followup FROM public.payment_submission_followups WHERE idempotency_key = v_key;
  END IF;

  RETURN jsonb_build_object('ok', true, 'rejected', true, 'submission_id', p_submission_id, 'cash_order_id', v_order_id,
                            'paidy_row_updated', v_n = 1, 'followup_id', v_followup, 'followup_key', v_key);
END
$function$;
REVOKE ALL ON FUNCTION public.end_paidy_submission_provider_ended_atomic(uuid,uuid,text,text,text,uuid,timestamptz,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_paidy_submission_provider_ended_atomic(uuid,uuid,text,text,text,uuid,timestamptz,jsonb,jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- Self-checks
-- ---------------------------------------------------------------------------
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.resolve_paidy_case(uuid,text,text)'::regprocedure);
  IF position('''authorization_open''' IN d) = 0 THEN RAISE EXCEPTION 'self-check: resolve_paidy_case M2 missing'; END IF;
  IF position('PERFORM 1 FROM public.payment_submissions' IN d) > position('SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    -- M2' IN d) THEN
    RAISE EXCEPTION 'self-check: resolve_paidy_case end_submission lock order';
  END IF;
  d := pg_get_functiondef('public.file_paidy_submission_atomic(uuid,uuid,text,numeric,boolean,timestamp with time zone,timestamp with time zone,jsonb,date,text,text,text)'::regprocedure);
  IF position('''card_payment_unresolved'' THEN' IN d) = 0
     OR position('''card_payment_unresolved'' THEN' IN d) > position('INSERT INTO public.paidy_payments' IN d) THEN
    RAISE EXCEPTION 'self-check: file_paidy_submission_atomic M6 missing or after the insert';
  END IF;
  IF has_function_privilege('authenticated', 'public.paidy_mode()', 'EXECUTE') THEN
    RAISE EXCEPTION 'self-check: paidy_mode() still callable by authenticated';
  END IF;
END $$;
