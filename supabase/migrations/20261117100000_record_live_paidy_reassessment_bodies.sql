-- Record-only (2026-10-08). Already applied on live — replaying is a no-op.
--
-- Why: 20261116100000_paidy_reassessment changed these three functions with
-- md5-guarded IN-PLACE patches (pg_temp.cj_patch, Bug #280). The drift audit
-- reads only CREATE FUNCTION statements, so the repo's newest copy of each was
-- the PRE-patch body. This file records the bodies exactly as live runs them
-- after release #418 (pg_get_functiondef read 2026-10-08), md5 of each equal
-- to live:
--
--   cash_order_payment_lock(uuid,uuid,boolean)  35d820e8e8c5adb8499e73aad93e4454
--   resolve_paidy_case(uuid,text,text)          bd8ae39af2d8fd14fd7b328c58b05bfe
--   guard_paidy_payment_identity()              db35c093e5862704918adea9d0221218
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

-- ---------------------------------------------------------------------------
-- cash_order_payment_lock
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_order_payment_lock(p_cash_order_id uuid, p_ignore_paidy_row uuid DEFAULT NULL::uuid, p_ignore_attempts boolean DEFAULT false)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    -- Paidy took money the Hub has not recorded and no staff decision closed it.
    WHEN EXISTS (
      SELECT 1 FROM public.paidy_payments pp
       WHERE pp.cash_order_id = p_cash_order_id AND pp.status = 'captured'
         AND pp.id IS DISTINCT FROM p_ignore_paidy_row
         AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                          WHERE s.paidy_payment_id = pp.id AND s.confirmed_payment_id IS NOT NULL)
         -- P01 (2026-10-06): a staff note never releases it — only a full
         -- refund in Paidy's own ledger does.
         AND coalesce(pp.refund_jpy, 0) < pp.amount_jpy)
      THEN 'paidy_captured_unrecorded'
    -- P01: a Paidy capture case with no Paidy record locks its order while open.
    WHEN EXISTS (
      SELECT 1 FROM public.paidy_cases c
       WHERE c.cash_order_id = p_cash_order_id AND c.paidy_payment_row IS NULL AND c.status = 'open'
         AND c.kind IN ('captured_unrecorded','captured_no_submission','record_failed'))
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
$function$;

-- ---------------------------------------------------------------------------
-- resolve_paidy_case
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_paidy_case(p_case_id uuid, p_resolution text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_case public.paidy_cases%ROWTYPE;
  v_rec  public.paidy_payments%ROWTYPE;
  v_sub  public.payment_submissions%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'confirm_payment') THEN
    RETURN jsonb_build_object('error', 'forbidden');
  END IF;
  IF p_resolution NOT IN ('handled_in_paidy','refunded_in_paidy','released','record_capture','end_submission','no_action') THEN
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

  -- "End the Paidy submission": staff decided the Paidy payment will not be
  -- recorded (refunded / handled in the Paidy dashboard / order closed). Its
  -- still-queued submission is rejected with the written reason, so the order
  -- is no longer held by it. Nothing is written to the order's money.
  IF p_resolution = 'end_submission' THEN
    IF v_case.paidy_payment_row IS NULL THEN RETURN jsonb_build_object('error', 'no_paidy_record'); END IF;
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    -- P01 (2026-10-06): a note never settles captured money — record it, or
    -- refund it in full in Paidy (the ledger shows it) first.
    IF v_rec.status = 'captured' AND coalesce(v_rec.refund_jpy, 0) < v_rec.amount_jpy THEN
      RETURN jsonb_build_object('error', 'captured_not_settled');
    END IF;
    -- P01: never under a Confirm that is recording it right now (5-minute lease).
    IF EXISTS (SELECT 1 FROM public.payment_submissions
                WHERE paidy_payment_id = v_case.paidy_payment_row AND status = 'confirmed'
                  AND confirmed_payment_id IS NULL
                  AND processing_started_at IS NOT NULL AND processing_started_at > now() - interval '5 minutes') THEN
      RETURN jsonb_build_object('error', 'recording_in_progress');
    END IF;
    UPDATE public.payment_submissions
       SET status = 'rejected', processing_started_at = NULL, reviewer_user_id = v_uid, updated_at = now(),
           reviewer_notes = 'Paidy case resolved by staff: ' || btrim(p_note)
     WHERE paidy_payment_id = v_case.paidy_payment_row
       AND (status IN ('submitted','under_review') OR (status = 'confirmed' AND confirmed_payment_id IS NULL))
    RETURNING * INTO v_sub;
    IF v_sub.id IS NOT NULL THEN
      INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
      VALUES ('cash_payment_submission', v_sub.id, 'submission_rejected',
              jsonb_build_object('reason', 'paidy_case_end_submission', 'case_id', v_case.id, 'note', btrim(p_note)), v_uid);
    END IF;
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
$function$;

-- ---------------------------------------------------------------------------
-- guard_paidy_payment_identity
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_paidy_payment_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- P02 (2026-10-06): an older answer arriving late never undoes money.
  IF OLD.status = 'captured' AND NEW.status IS DISTINCT FROM 'captured' THEN
    RAISE EXCEPTION 'paidy_payment_locked: a captured Paidy payment stays captured' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(NEW.refund_jpy, 0) < coalesce(OLD.refund_jpy, 0) THEN
    RAISE EXCEPTION 'paidy_payment_locked: a Paidy refund total never decreases' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.capture_id IS NOT NULL AND NEW.capture_id IS NULL THEN
    NEW.capture_id := OLD.capture_id;
  END IF;
  RETURN NEW;
END
$function$;
