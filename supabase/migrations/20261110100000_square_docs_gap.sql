-- Square docs-gap fixes (2026-10-05) — owner: "proceed to step 1, fix first
-- the needs for correction". Review against developer.squareup.com:
-- Project doc claude/square-docs-gap-review-2026-10-05.md (HUB-1..HUB-9).
--
--   HUB-2  Square's DisputeState INQUIRY_CLOSED ("the inquiry is complete") is
--          closed for counting, reminders and decisions: square_ops_health
--          'disputes_open', decide_square_case (evidence_submitted refused),
--          the due-date index, the evidence bells. record_square_dispute is NOT
--          changed: Square's docs do not say whether a closed inquiry can be
--          escalated on the same dispute id, so INQUIRY_CLOSED is not made
--          terminal there — a later open state is still recorded, never hidden.
--   HUB-3  apply_square_payment_state: a live hold whose Square risk rises to
--          HIGH after filing rings bell 'card_risk_high' once. No exception is
--          set, so square-reconcile does not void it automatically;
--          review-payment-submission refuses to capture it; the reviewer Rejects.
--   HUB-7  a hold without capture_by falls back to authorized_at + 7 days
--          (Square's default online window) in apply_square_payment_state
--          (expired vs voided) and ring_square_deadline_bells (the warning) —
--          the same fallback as card-rules.ts cardHoldWarnDue / nextSquareRowStatus.
--   HUB-8  dispute evidence reminders ring only while Square waits for evidence
--          (EVIDENCE_REQUIRED / INQUIRY_EVIDENCE_REQUIRED) and staff have not
--          recorded evidence_submitted.
--   HUB-9  record-only: the live pg_cron job 'square-reconcile' (53 * * * *,
--          Vault key) is written here so a rebuild keeps it. It is created only
--          when missing; an existing job is left exactly as it is.
--
-- FUNCTION RULES (CLAUDE.md, Bug #280): every body below is the LIVE body
-- (md5(prosrc) checked against live 2026-10-05, equal to the newest repo copy)
-- with anchored edits only. The guard stops the migration if live has moved;
-- replaying it is a no-op (it accepts the already-patched md5).
-- CREATE OR REPLACE keeps each function's live ACL (no signature changes).

DO $guard$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,jsonb,jsonb,text,uuid)', '8ad64c42440eb9dea459007baea8a9df', '7829cbc0647cafc24122719b37c991ee'),
    ('public.decide_square_case(text,uuid,text,text)', '983c3d19218a2687008677a83f42bbfb', '6e988fb59d643953abe56ae77aad8864'),
    ('public.ring_square_deadline_bells(timestamptz)', '1645c0b5880aed4fe9ff44bc0153f91a', '49c2fc5cc13621d5b8192a91653721d2'),
    ('public.square_ops_health()', 'd3c93ebcfde5c865b321c086b4df5c82', '01a39c90b6c3e05cae0da29459696e23')) AS t(sig, live_md5, new_md5)
  LOOP
    SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL THEN
      RAISE EXCEPTION 'STOP — % is not on live; nothing changed', r.sig;
    END IF;
    IF v_md5 NOT IN (r.live_md5, r.new_md5) THEN
      RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', r.sig, v_md5;
    END IF;
  END LOOP;
END
$guard$;

-- ---------------------------------------------------------------------------
-- HUB-2: the open-dispute index excludes INQUIRY_CLOSED too.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.idx_square_disputes_due;
CREATE INDEX idx_square_disputes_due ON public.square_disputes (due_at)
  WHERE state NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED');

-- ---------------------------------------------------------------------------
-- apply_square_payment_state (live md5(prosrc) 8ad64c42440eb9dea459007baea8a9df)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_square_payment_state(p_square_payment_id text, p_provider_status text, p_amount_jpy bigint, p_refunded_jpy bigint, p_currency text, p_provider_version text, p_provider_updated_at timestamp with time zone, p_captured_at timestamp with time zone, p_capture_by timestamp with time zone, p_card_brand text, p_card_last4 text, p_receipt_url text, p_risk_level text, p_provider_verification jsonb, p_payload jsonb, p_source text, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_old_risk     text;
BEGIN
  -- One lock order everywhere (review 2026-10-05 A): the latest submission,
  -- then the card row — the order finalize_cash_submission_atomic and
  -- decide_square_case take — so a webhook / reconcile state change never
  -- deadlocks with a Finish or a staff decision on the same payment.
  PERFORM 1 FROM public.payment_submissions
   WHERE square_payment_id = (SELECT id FROM public.square_payments WHERE square_payment_id = p_square_payment_id)
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;
  v_from := v_sq.status;
  v_old_risk := upper(coalesce(v_sq.risk_level, ''));
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
      -- HUB-7 (2026-10-05): no capture_by → Square's default 7-day window.
      CASE WHEN coalesce(p_capture_by, v_sq.capture_by, v_sq.authorized_at + interval '7 days') IS NOT NULL
                AND now() >= coalesce(p_capture_by, v_sq.capture_by, v_sq.authorized_at + interval '7 days')
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

  -- HUB-3 (2026-10-05): Square's risk can rise to HIGH after the hold was
  -- filed (it was PENDING then). Staff are told once (bell 'card_risk_high');
  -- review-payment-submission refuses to capture while Square says HIGH, so
  -- the reviewer Rejects (the hold is voided, nothing is charged). No
  -- exception is set here: an automatic void of a customer's hold stays the
  -- filing-time fraud rule only (owner decision pending; docs/SQUARE.md).
  IF v_to = 'authorized' AND upper(coalesce(p_risk_level, '')) = 'HIGH' AND v_old_risk <> 'HIGH' THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_risk_high', 'Card payment now HIGH risk',
            v_ref || ' · ' || v_amt || ' — Square raised this card payment to HIGH risk after it was filed. Do not capture it: Confirm is refused. Reject it in Payments Hub (the hold is voided, nothing is charged).',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                               'risk_level', 'HIGH', 'source', p_source, 'test', v_sq.test));
  END IF;

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
$function$;

-- ---------------------------------------------------------------------------
-- decide_square_case (live md5(prosrc) 983c3d19218a2687008677a83f42bbfb)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_square_case(p_kind text, p_id uuid, p_decision text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_n        int := 0;
  v_dec      text := btrim(coalesce(p_decision, ''));
  v_sq       public.square_payments%ROWTYPE;
  v_order    public.cash_orders%ROWTYPE;
  v_rf       public.square_refunds%ROWTYPE;
  v_dp       public.square_disputes%ROWTYPE;
  v_done     bigint := 0;
  v_open     integer := 0;
  v_claim    uuid;
  v_busy     boolean := false;
  v_sub      uuid;
  v_amount   bigint;
  v_resolved boolean := false;
  v_err      text := NULL;
BEGIN
  IF v_uid IS NULL OR NOT public.is_staff(v_uid) THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF v_dec = '' THEN RETURN jsonb_build_object('error', 'decision_required'); END IF;

  IF p_kind = 'refund' THEN
    IF v_dec NOT IN ('order_cancelled_refunded','partial_refund_order_kept','refund_failed_followed_up','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    SELECT * INTO v_rf FROM public.square_refunds WHERE id = p_id FOR UPDATE;
    IF v_rf.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- A staff decision is an annotation of what Square reports (QC02).
    IF (v_dec IN ('order_cancelled_refunded','partial_refund_order_kept') AND v_rf.status <> 'COMPLETED')
       OR (v_dec = 'refund_failed_followed_up' AND v_rf.status NOT IN ('FAILED','REJECTED')) THEN
      RETURN jsonb_build_object('error', 'state_mismatch', 'square_status', v_rf.status);
    END IF;
    UPDATE public.square_refunds SET decision = v_dec, decision_note = left(p_note, 1000), decided_at = now(),
           decided_by = v_uid, updated_at = now() WHERE id = p_id;
  ELSIF p_kind = 'dispute' THEN
    IF v_dec NOT IN ('evidence_submitted','accepted','won','lost','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    SELECT * INTO v_dp FROM public.square_disputes WHERE id = p_id FOR UPDATE;
    IF v_dp.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF (v_dec = 'won' AND v_dp.state <> 'WON') OR (v_dec = 'lost' AND v_dp.state <> 'LOST')
       OR (v_dec = 'accepted' AND v_dp.state <> 'ACCEPTED')
       OR (v_dec = 'evidence_submitted' AND v_dp.state IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')) THEN
      RETURN jsonb_build_object('error', 'state_mismatch', 'square_state', v_dp.state);
    END IF;
    UPDATE public.square_disputes SET decision = v_dec, decision_note = left(p_note, 1000), decided_at = now(),
           decided_by = v_uid, updated_at = now() WHERE id = p_id;
  ELSIF p_kind = 'exception' THEN
    IF v_dec = 'recorded_manually' THEN v_dec := 'record_on_order'; END IF;
    IF v_dec NOT IN ('record_on_order','record_net_after_refund','refunded_in_square','voided_in_square','other') THEN
      RETURN jsonb_build_object('error', 'bad_decision');
    END IF;
    IF coalesce(btrim(p_note), '') = '' THEN RETURN jsonb_build_object('error', 'note_required'); END IF;
    -- Card money decisions: admin or finance only (CLAUDE.md, Bug #170).
    IF NOT (public.has_role(v_uid, 'admin') OR public.has_role(v_uid, 'finance')) THEN
      RETURN jsonb_build_object('error', 'not_permitted');
    END IF;
    -- Locks in finalize_cash_submission_atomic's order — the claimed
    -- submission, then the order, then the card row — so the two never
    -- deadlock (review #5).
    SELECT id INTO v_claim FROM public.payment_submissions
     WHERE square_payment_id = p_id AND status = 'confirmed' AND confirmed_payment_id IS NULL
     ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    SELECT * INTO v_order FROM public.cash_orders
     WHERE id = (SELECT cash_order_id FROM public.square_payments WHERE id = p_id) FOR UPDATE;
    SELECT * INTO v_sq FROM public.square_payments WHERE id = p_id FOR UPDATE;
    -- A Confirm still inside its 5-minute lease (review-payment-submission's
    -- claim, PAIDY_CONFIRM_LEASE_MS) is never pulled from under it (review B).
    SELECT coalesce(processing_started_at > now() - interval '5 minutes', false) INTO v_busy
      FROM public.payment_submissions WHERE id = v_claim;
    v_busy := coalesce(v_busy, false);
    IF v_sq.id IS NULL OR NOT (v_sq.exception IS NOT NULL OR (v_sq.status = 'captured' AND v_sq.cash_payment_id IS NULL)) THEN
      RETURN jsonb_build_object('error', 'not_found');
    END IF;
    SELECT coalesce(sum(amount_jpy) FILTER (WHERE status = 'COMPLETED'), 0),
           count(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED','REJECTED'))
      INTO v_done, v_open
      FROM public.square_refunds WHERE square_payment_row = v_sq.id;
    v_done := greatest(v_done, coalesce(v_sq.refund_jpy, 0)::bigint);

    -- The decision itself is always recorded (QC02: decision ≠ resolution).
    UPDATE public.square_payments
       SET exception_decision = v_dec, exception_decided_at = now(), exception_decided_by = v_uid,
           exception_note = left(coalesce(exception_note, '') || ' | decision: ' || v_dec || ' — ' || p_note, 1000),
           updated_at = now()
     WHERE id = v_sq.id;

    IF v_dec = 'other' THEN
      NULL; -- a note: nothing is resolved

    ELSIF v_dec = 'voided_in_square' THEN
      IF v_sq.status IN ('voided','expired','failed','rejected') THEN v_resolved := true;
      ELSE v_err := 'void_not_verified'; END IF;

    ELSIF v_dec = 'refunded_in_square' THEN
      IF v_busy THEN
        v_err := 'confirm_in_progress';
      ELSIF v_sq.status = 'captured' AND v_open = 0 AND v_sq.captured_amount_jpy IS NOT NULL
         AND v_done >= v_sq.captured_amount_jpy THEN
        v_resolved := true;
        -- The claimed Confirm can never record refunded money: close it.
        UPDATE public.payment_submissions
           SET status = 'rejected', processing_started_at = NULL, updated_at = now(),
               reviewer_notes = left('Card capture refunded in full in Square (verified): ' || p_note, 1000)
         WHERE id = v_claim;
      ELSE
        v_err := 'refund_not_verified';
      END IF;

    ELSE -- record_on_order / record_net_after_refund
      IF v_sq.status <> 'captured' OR v_sq.cash_payment_id IS NOT NULL THEN
        v_err := CASE WHEN v_sq.cash_payment_id IS NOT NULL THEN 'already_recorded' ELSE 'not_captured' END;
      ELSIF v_order.status::text IN ('cancelled','expired') THEN
        v_err := 'order_closed';
      ELSIF v_dec = 'record_on_order' AND (v_done > 0 OR v_open > 0) THEN
        v_err := 'square_refunded';
      ELSIF v_dec = 'record_net_after_refund' AND v_open > 0 THEN
        v_err := 'refund_pending';
      ELSIF v_dec = 'record_net_after_refund' AND (v_done <= 0 OR v_done >= v_sq.captured_amount_jpy) THEN
        v_err := CASE WHEN v_done <= 0 THEN 'no_refund' ELSE 'fully_refunded' END;
      ELSE
        v_amount := v_sq.captured_amount_jpy - CASE WHEN v_dec = 'record_net_after_refund' THEN v_done ELSE 0 END;
        IF v_amount > v_order.remaining_balance + 0.005 THEN
          v_err := 'exceeds_remaining';
        ELSIF v_dec = 'record_on_order' AND v_claim IS NOT NULL
              AND (SELECT submitted_amount = v_amount AND submission_type = 'cash_payment'
                     FROM public.payment_submissions WHERE id = v_claim) THEN
          v_sub := v_claim; -- the existing claimed Confirm is exactly this capture
        ELSIF v_busy THEN
          v_err := 'confirm_in_progress'; -- never replace a Confirm that is running
        ELSE
          IF v_claim IS NOT NULL THEN
            UPDATE public.payment_submissions
               SET status = 'rejected', processing_started_at = NULL, updated_at = now(),
                   reviewer_notes = left('Replaced by a recording for the captured amount (staff decision): ' || p_note, 1000)
             WHERE id = v_claim;
          END IF;
          INSERT INTO public.payment_submissions (customer_id, cash_order_id, submitted_amount, payment_date, payment_method,
                 reference_number, sender_name, notes, status, reviewer_user_id, square_payment_id, submission_type)
          VALUES (coalesce(v_sq.customer_id, v_order.customer_id), v_order.id, v_amount,
                  coalesce((v_sq.captured_at AT TIME ZONE 'Asia/Tokyo')::date, current_date), 'square',
                  NULL, NULL,
                  left(CASE WHEN v_dec = 'record_net_after_refund'
                            THEN 'Card capture less completed refunds (¥' || v_done || '), recorded by staff decision: '
                            ELSE 'Card capture recorded by staff decision: ' END || p_note, 1000),
                  'confirmed', v_uid, v_sq.id,
                  CASE WHEN v_dec = 'record_net_after_refund' THEN 'card_net_after_refund' ELSE 'cash_payment' END)
          RETURNING id INTO v_sub;
        END IF;
      END IF;
    END IF;

    IF v_resolved THEN
      UPDATE public.square_payments SET exception_resolved_at = now(), exception_resolved_by = v_uid, updated_at = now()
       WHERE id = v_sq.id;
    END IF;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('square_exception', p_id, 'square_case_decided',
            jsonb_build_object('decision', v_dec, 'note', left(p_note, 1000), 'resolved', v_resolved, 'error', v_err,
                               'submission_id', v_sub, 'refunds_completed_jpy', v_done, 'refunds_pending', v_open), v_uid);
    IF v_err IS NOT NULL THEN
      RETURN jsonb_build_object('error', v_err, 'decision_recorded', true, 'resolved', false,
                                'refunds_completed_jpy', v_done, 'refunds_pending', v_open);
    END IF;
    RETURN jsonb_build_object('ok', true, 'resolved', v_resolved, 'decision', v_dec, 'submission_id', v_sub,
                              'next', CASE WHEN v_sub IS NOT NULL THEN 'confirm_submission' END);
  ELSE
    RETURN jsonb_build_object('error', 'bad_kind');
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('square_' || p_kind, p_id, 'square_case_decided',
          jsonb_build_object('decision', v_dec, 'note', left(p_note, 1000)), v_uid);
  RETURN jsonb_build_object('ok', true);
END
$fn$;

-- ---------------------------------------------------------------------------
-- ring_square_deadline_bells (live md5(prosrc) 1645c0b5880aed4fe9ff44bc0153f91a)
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
    -- HUB-7 (2026-10-05): a hold without capture_by (Square sent no
    -- delayed_until) is warned against authorized_at + 7 days, Square's
    -- default window for an online card payment — the same fallback as
    -- card-rules.ts cardHoldWarnDue — and the bell says it is an estimate.
    SELECT sp.id, sp.cash_order_id, sp.square_payment_id, sp.amount_jpy,
           coalesce(sp.capture_by, sp.authorized_at + interval '7 days') AS capture_by,
           (sp.capture_by IS NULL) AS estimated, sp.test,
           o.customer_id, o.invoice_number, coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_payments sp JOIN public.cash_orders o ON o.id = sp.cash_order_id
     WHERE sp.status = 'authorized' AND sp.warned_at IS NULL
       AND coalesce(sp.capture_by, sp.authorized_at + interval '7 days') IS NOT NULL
       AND coalesce(sp.capture_by, sp.authorized_at + interval '7 days') - interval '2 days' <= p_now
     FOR UPDATE OF sp SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_hold_expiring', 'Card hold expires soon',
           ref || ' · ¥' || to_char(round(amount_jpy), 'FM999,999,999') || ' — Square cancels this hold on '
             || CASE WHEN estimated THEN 'about ' ELSE '' END || to_char(capture_by AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST. Confirm or Reject it in Payments Hub before then.',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'square_payment_id', square_payment_id,
                              'capture_by', capture_by, 'capture_by_estimated', estimated, 'test', test)
      FROM due
    RETURNING 1
  )
  UPDATE public.square_payments sp SET warned_at = p_now, updated_at = now()
    FROM due WHERE sp.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_holds = ROW_COUNT;

  -- HUB-2/HUB-8 (2026-10-05): evidence reminders only while Square still
  -- waits for evidence (EVIDENCE_REQUIRED / INQUIRY_EVIDENCE_REQUIRED) and
  -- staff have not recorded it as submitted. PROCESSING / INQUIRY_PROCESSING
  -- mean the evidence is in; WON / LOST / ACCEPTED / INQUIRY_CLOSED are closed.
  WITH due AS (
    SELECT d.id, d.cash_order_id, d.square_dispute_id, d.amount_jpy, d.due_at, d.state, o.customer_id, o.invoice_number,
           coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_disputes d JOIN public.cash_orders o ON o.id = d.cash_order_id
     WHERE d.due_at IS NOT NULL AND d.reminded_3d_at IS NULL AND d.state IN ('EVIDENCE_REQUIRED','INQUIRY_EVIDENCE_REQUIRED')
       AND d.decision IS DISTINCT FROM 'evidence_submitted'
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
     WHERE d.due_at IS NOT NULL AND d.reminded_1d_at IS NULL AND d.state IN ('EVIDENCE_REQUIRED','INQUIRY_EVIDENCE_REQUIRED')
       AND d.decision IS DISTINCT FROM 'evidence_submitted'
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

-- ---------------------------------------------------------------------------
-- square_ops_health (live md5(prosrc) d3c93ebcfde5c865b321c086b4df5c82)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_ops_health()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_uid uuid := auth.uid(); v jsonb;
BEGIN
  -- Staff only (review #2: current_user is the owner inside SECURITY
  -- DEFINER, so it can never identify the caller).
  IF v_uid IS NULL OR NOT public.is_staff(v_uid) THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'last_run',            (SELECT value FROM public.square_sync_state WHERE key = 'reconcile_last_run'),
    'last_ok_at',          (SELECT value->>'at' FROM public.square_sync_state WHERE key = 'reconcile_last_ok'),
    'events_backlog',      (SELECT count(*) FROM public.square_webhook_events WHERE status IN ('received','processing','failed','quarantined')),
    'events_dead',         (SELECT count(*) FROM public.square_webhook_events WHERE status = 'dead'),
    'holds_live',          (SELECT count(*) FROM public.square_payments WHERE status = 'authorized'),
    'attempts_open',       (SELECT count(*) FROM public.square_card_attempts WHERE status IN ('reserved','unknown','cancelling')),
    'captured_unrecorded', (SELECT count(*) FROM public.square_payments WHERE status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL),
    'exceptions_open',     (SELECT count(*) FROM public.square_payments WHERE exception IS NOT NULL AND exception_resolved_at IS NULL),
    'refunds_open',        (SELECT count(*) FROM public.square_refunds WHERE status NOT IN ('COMPLETED','FAILED','REJECTED')),
    'disputes_open',       (SELECT count(*) FROM public.square_disputes WHERE state NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')),
    'checkpoints',         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM public.square_sync_state
                             WHERE key NOT IN ('reconcile_last_run','reconcile_last_ok'))
  ) INTO v;
  RETURN v;
END
$fn$;

COMMENT ON FUNCTION public.ring_square_deadline_bells(timestamptz) IS
  'Hourly (square-reconcile): card_hold_expiring 2 days before Square''s own capture deadline (capture_by = delayed_until; when Square sent none, authorized_at + 7 days, marked as an estimate — HUB-7), dispute evidence reminders 3 days and 1 day before due_at while Square waits for evidence (EVIDENCE_REQUIRED / INQUIRY_EVIDENCE_REQUIRED) and staff have not recorded evidence_submitted (HUB-8). Each bell and its stamp are one statement: a failed run stamps nothing and rings next hour. service_role only.';

-- ---------------------------------------------------------------------------
-- HUB-9 record-only: the square-reconcile cron as it runs on live (created by
-- the owner in the SQL Editor). Created ONLY when missing; never altered here.
-- ---------------------------------------------------------------------------
DO $cron$
BEGIN
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'square-reconcile cron: pg_cron not installed here — skipped';
  ELSIF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'square-reconcile') THEN
    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
      RAISE EXCEPTION 'square-reconcile cron: Vault secret email_queue_service_role_key missing — do not create a second key';
    END IF;
    PERFORM cron.schedule('square-reconcile', '53 * * * *', $job$ SELECT net.http_post( url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/square-reconcile', headers := jsonb_build_object( 'Content-Type', 'application/json', 'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key') ), body := '{}'::jsonb ); $job$);
  END IF;
END
$cron$;
