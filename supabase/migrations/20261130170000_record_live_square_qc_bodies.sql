-- Record-only (2026-10-09). Already applied on live — replaying is a no-op.
--
-- Why: 20261130150000 (Square QC close-out) changed these eleven functions with md5-guarded
-- IN-PLACE patches (pg_temp.cj_patch). The drift audit reads only CREATE FUNCTION statements, so
-- the repo's newest copy of each was the PRE-patch body. This file records the bodies exactly as
-- live runs them after the Lovable apply of 2026-10-09 ~08:50Z (pg_get_functiondef read from
-- live; md5(prosrc) below). square_order_disputed_jpy and close_square_attempt_atomic were
-- created by full CREATE statements in 20261130150000 and are not repeated here.
--
--   apply_square_payment_state            dd2b7efe8bc31c1d45d0578c7bda8468
--   approve_card_refund_exception_atomic  c2b90eb27f3ea6bdf888fbdfa15db765
--   cancel_cash_order_atomic              3523990793018b42db1ad7f5d81a8982
--   decide_square_case                    3ab2d405d642c30799f6cd195c67e4ff
--   get_square_settings                   4c8009c34152ea4c02c26bbb43b37b7f
--   get_staff_bell_emails                 dc058be8f74695b1ca7f91566226705e
--   guard_provider_submission             5dca515937b16b19480524754a92135b
--   mark_web_order_refund_issued_atomic   ff7e5c7aa686e9cd4d9bd07d4ce4564b
--   record_square_dispute                 3e524ad293bf4fc835b1f1f601b6d212
--   resolve_paidy_case                    7b79aedbf733122397ed7462d021055c
--   terminate_web_order_atomic            30cb8237c0347a42e497f20f4960c11b
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

-- ---------------------------------------------------------------------------
-- apply_square_payment_state
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
    IF v_sub.id IS NOT NULL AND v_sub.status::text IN ('submitted','under_review','needs_clarification') THEN
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
                || CASE WHEN v_subact = 'rejected' THEN 'the submission was rejected and the customer can pay again.'
                        WHEN v_sub.id IS NOT NULL THEN 'its latest submission is ' || replace(v_sub.status::text, '_', ' ') || ' — check it in Payments Hub.'
                        ELSE 'no submission was waiting.' END,
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
-- approve_card_refund_exception_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_card_refund_exception_atomic(p_order_id uuid, p_user_id uuid, p_payout text, p_square_refund_id text, p_ticket text, p_amount_jpy bigint, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order    public.cash_orders%ROWTYPE;
  v_trigger  text;
  v_rid      text := nullif(btrim(coalesce(p_square_refund_id, '')), '');
  v_ticket   text := nullif(btrim(coalesce(p_ticket, '')), '');
  v_captured bigint;
  v_refunded bigint;
  v_credit   bigint;
  v_cap      bigint;
  v_disputed bigint := 0;
  v_open     jsonb;
  v_row      public.card_refund_exceptions%ROWTYPE;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required'); END IF;
  IF NOT public.has_role(p_user_id, 'admin') THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF p_payout IS NULL OR p_payout NOT IN ('bank_transfer', 'store_credit') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_payout');
  END IF;
  IF v_ticket IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'square_support_ticket');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_order.source_channel IS DISTINCT FROM 'web' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_web_order'); END IF;
  IF v_order.status::text <> 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelled', 'status', v_order.status::text);
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.cash_payments
                  WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
  END IF;
  IF EXISTS (SELECT 1 FROM public.card_refund_exceptions WHERE cash_order_id = p_order_id AND status <> 'cancelled') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_exists');
  END IF;

  SELECT jsonb_agg(jsonb_build_object('refund_id', r.square_refund_id, 'status', r.status, 'amount_jpy', r.amount_jpy))
    INTO v_open
    FROM public.square_refunds r
   WHERE r.cash_order_id = p_order_id AND r.status NOT IN ('COMPLETED', 'FAILED', 'REJECTED');
  IF v_open IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_refund_in_progress', 'refunds', v_open);
  END IF;

  IF v_rid IS NOT NULL THEN
    SELECT 'refund_' || lower(r.status) INTO v_trigger
      FROM public.square_refunds r
     WHERE r.cash_order_id = p_order_id AND r.square_refund_id = v_rid AND r.status IN ('FAILED', 'REJECTED');
    IF v_trigger IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_not_triggered', 'detail', 'refund_not_failed_or_rejected');
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.square_payments sp
                 WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured'
                   AND sp.authorized_at < now() - interval '1 year') THEN
    v_trigger := 'payment_over_1_year';
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'exception_not_triggered', 'detail', 'no_failed_refund_and_payment_within_1_year');
  END IF;

  SELECT coalesce(sum(round(sp.amount_jpy)), 0)::bigint INTO v_captured
    FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured';
  SELECT coalesce(sum(r.amount_jpy), 0)::bigint INTO v_refunded
    FROM public.square_refunds r WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED';
  SELECT coalesce(sum(round(l.original_amount)), 0)::bigint INTO v_credit
    FROM public.store_credit_lots l WHERE l.source_cash_order_id = p_order_id AND l.status::text <> 'voided';
  v_disputed := public.square_order_disputed_jpy(p_order_id);
  v_cap := v_captured - v_refunded - v_credit - v_disputed;
  IF v_cap <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_nothing_owed', 'cap_jpy', v_cap,
                              'card_captured_jpy', v_captured, 'card_refunded_jpy', v_refunded, 'credit_issued_jpy', v_credit);
  END IF;
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 OR p_amount_jpy > v_cap THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_over_cap', 'cap_jpy', v_cap, 'requested_jpy', p_amount_jpy,
                              'card_captured_jpy', v_captured, 'card_refunded_jpy', v_refunded, 'credit_issued_jpy', v_credit);
  END IF;

  INSERT INTO public.card_refund_exceptions (cash_order_id, status, payout, trigger_kind, square_refund_id,
         square_support_ticket, amount_jpy, cap_jpy, card_captured_jpy, card_refunded_jpy, credit_issued_jpy,
         approved_by, approval_note)
  VALUES (p_order_id, 'approved', p_payout, v_trigger, v_rid, v_ticket, p_amount_jpy, v_cap, v_captured, v_refunded,
          v_credit, p_user_id, nullif(btrim(coalesce(p_note, '')), ''))
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'card_refund_exception_approved', NULL, to_jsonb(v_row), p_user_id);
  INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
  VALUES ('card_refund_exception_approved', 'Refund outside Square approved — pay it now',
          coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(p_amount_jpy, 'FM999,999,999')
            || ' approved to be refunded by ' || replace(p_payout, '_', ' ') || ' (Square ' || replace(v_trigger, '_', ' ')
            || ', ticket ' || v_ticket || '). Pay it, then record it on the order with "Mark refund issued".',
          v_order.customer_id, v_order.invoice_number,
          jsonb_build_object('cash_order_id', p_order_id, 'exception_id', v_row.id, 'amount_jpy', p_amount_jpy, 'payout', p_payout));

  RETURN jsonb_build_object('ok', true, 'exception', to_jsonb(v_row), 'cap_jpy', v_cap,
                            'reference', coalesce(v_order.web_reference, v_order.invoice_number));
END
$function$;

-- ---------------------------------------------------------------------------
-- cancel_cash_order_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_cash_order_atomic(p_cash_order_id uuid, p_reason text, p_user_id uuid DEFAULT NULL::uuid, p_user_email text DEFAULT NULL::text, p_preview boolean DEFAULT false, p_source text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text; v_currency account_currency; v_customer_id uuid; v_invoice text;
  v_money_received numeric(12,2); v_loyalty_synthetic numeric(12,2);
  v_partial_credit numeric(12,2); v_issue_amount numeric(12,2);
  v_member_id uuid; v_credit jsonb := NULL; v_revoked_tx uuid := NULL;
  v_reason text; v_is_system boolean;
  v_order_date date; v_order_at timestamptz; v_shopify_id text; v_split jsonb;
  v_card_refunded boolean := false;
  v_paidy_refunded numeric(12,2) := 0;
  v_card_disputed bigint := 0;
  v_unresolved boolean := false;
BEGIN
  v_is_system := (p_source = 'shopify_webhook');
  IF NOT p_preview AND NOT v_is_system AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF NOT p_preview AND v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE='P0001';
  END IF;
  SELECT status::text, currency, customer_id, invoice_number, order_date, shopify_order_id, created_at
    INTO v_status, v_currency, v_customer_id, v_invoice, v_order_date, v_shopify_id, v_order_at
  FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cash_order_not_found: %', p_cash_order_id USING ERRCODE='P0001';
  END IF;
  IF v_status = 'cancelled' AND v_is_system THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true, 'cash_order_id', p_cash_order_id, 'invoice_number', v_invoice);
  END IF;
  IF v_status NOT IN ('pending','completed') THEN
    RAISE EXCEPTION 'cash_order_not_cancellable: status is %', v_status USING ERRCODE='P0001';
  END IF;
  v_unresolved := public.square_order_unresolved(p_cash_order_id);
  IF NOT p_preview AND v_unresolved THEN
    RAISE EXCEPTION 'card_payment_unresolved: a card payment on this order is still being processed — close the hold or record the capture first' USING ERRCODE='P0001';
  END IF;
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_money_received
  FROM public.cash_payments
  WHERE cash_order_id = p_cash_order_id AND voided_at IS NULL
    AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_loyalty_synthetic
  FROM public.cash_payments
  WHERE cash_order_id = p_cash_order_id AND voided_at IS NULL
    AND COALESCE(reference_number, '') LIKE 'LOYALTY-%';
  -- F2: credit already minted for this order via Shopify partial refunds must not
  -- be minted a second time on full cancellation. Invariant: total credit issued
  -- for an order never exceeds money actually received.
  SELECT COALESCE(SUM(original_amount), 0) INTO v_partial_credit
  FROM public.store_credit_lots
  WHERE source_cash_order_id = p_cash_order_id
    AND source_type = 'shopify_partial_refund' AND status <> 'voided';
  -- Cancellation credit rule (owner 2026-10-06/08): a Hub cash order
  -- cancelled on its order_date → 100 % credit; later → 30 % of the
  -- money paid is kept, 70 % credit. Shopify orders keep 100 % (owner E3).
  IF v_is_system OR v_shopify_id IS NOT NULL THEN
    v_split := jsonb_build_object('rule', 'shopify_full', 'charge_pct', 0, 'money', v_money_received,
                                  'kept', 0, 'credit', v_money_received, 'order_date', v_order_date);
  ELSE
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, now(), v_order_at);
  END IF;
  v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
  -- R05 (owner 2026-10-08, refuse): money already given back through Square
  -- never comes back again as store credit — the cancel itself is refused so
  -- staff pick the refund path, exactly as on a web order.
  v_card_refunded := EXISTS (SELECT 1 FROM public.square_refunds
                              WHERE cash_order_id = p_cash_order_id AND status NOT IN ('FAILED','REJECTED'));
  IF NOT p_preview AND v_card_refunded AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'card_already_refunded: money on this order was already refunded through Square — it cannot be issued again as store credit' USING ERRCODE='P0001';
  END IF;
  -- PA02 (owner 2026-10-08, refuse): money already given back through Paidy
  -- (a verified paidy_refunds row — an exception to the no-cash-refund policy)
  -- never comes back again as store credit; staff finish it by hand.
  SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded
    FROM public.paidy_refunds r WHERE r.cash_order_id = p_cash_order_id;
  IF NOT p_preview AND v_paidy_refunded > 0 AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'paidy_already_refunded: ¥% of this order was already refunded in the Paidy dashboard — it cannot be issued again as store credit', v_paidy_refunded::bigint USING ERRCODE='P0001';
  END IF;
  v_card_disputed := public.square_order_disputed_jpy(p_cash_order_id);
  IF NOT p_preview AND v_card_disputed > 0 AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'card_disputed: ¥% of this order is held or taken back by a card chargeback — it cannot be issued again as store credit', v_card_disputed USING ERRCODE='P0001';
  END IF;
  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'invoice_number', v_invoice, 'status', v_status,
      'card_refunded', v_card_refunded,
      'paidy_refunded_jpy', v_paidy_refunded,
      'card_disputed_jpy', v_card_disputed,
      'card_payment_unresolved', v_unresolved,
      'refusal', CASE WHEN v_unresolved THEN 'card_payment_unresolved'
                      WHEN v_issue_amount > 0 AND v_card_refunded THEN 'card_already_refunded'
                      WHEN v_issue_amount > 0 AND v_paidy_refunded > 0 THEN 'paidy_already_refunded'
                      WHEN v_issue_amount > 0 AND v_card_disputed > 0 THEN 'card_disputed' END,
      'currency', v_currency, 'money_received', v_money_received,
      'loyalty_redemption_excluded', v_loyalty_synthetic,
      'partial_refund_credit_already_issued', v_partial_credit,
      'store_credit_to_issue', v_issue_amount,
      'cancellation_rule', v_split ->> 'rule',
      'cancellation_charge', COALESCE((v_split ->> 'kept')::numeric, 0),
      'cancellation_split', v_split,
      'earned_points_will_be_revoked', true);
  END IF;
  SELECT id INTO v_member_id FROM public.loyalty_members WHERE customer_id = v_customer_id;
  IF v_member_id IS NOT NULL AND v_invoice IS NOT NULL THEN
    v_revoked_tx := public.revoke_loyalty_points(
      p_member_id => v_member_id, p_source_reference => v_invoice, p_spend_jpy => 0,
      p_account_id => NULL, p_cash_order_id => p_cash_order_id, p_payment_id => NULL,
      p_invoice_number => v_invoice,
      p_notes => 'Revoked: cash order cancelled (' || v_reason || ')',
      p_created_by_user_id => p_user_id);
  END IF;
  IF v_issue_amount > 0 THEN
    v_credit := public.issue_store_credit_atomic(
      p_customer_id => v_customer_id, p_currency => v_currency, p_amount => v_issue_amount,
      p_source_type => 'cancelled_cash', p_source_account_id => NULL,
      p_source_cash_order_id => p_cash_order_id, p_user_id => p_user_id,
      p_user_email => COALESCE(p_user_email, p_source),
      p_notes => 'Auto-issued on cancellation of ' || COALESCE(v_invoice,'cash order') || ' — ' || v_reason,
      p_source => p_source);
  END IF;
  UPDATE public.cash_orders
     SET status = 'cancelled', cancellation_reason = v_reason, cancelled_at = now(),
         cancelled_by_user_id = p_user_id, updated_at = now()
   WHERE id = p_cash_order_id;
  INSERT INTO public.account_notes (cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (p_cash_order_id,
    'Cash order cancelled: ' || v_reason ||
    CASE
      WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
        || CASE WHEN COALESCE((v_split ->> 'kept')::numeric, 0) > 0
                THEN ' (30% cancellation charge kept: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || (v_split ->> 'kept') || ')'
                ELSE '' END
      WHEN v_money_received > 0 THEN ' — no additional store credit (already issued via partial refunds: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_partial_credit || ')'
      ELSE ' — no payments received, no store credit'
    END,
    p_user_id, CASE WHEN v_is_system THEN 'Shopify (webhook)' ELSE COALESCE(p_user_email, 'System') END);
  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('cash_order', p_cash_order_id, 'cancel', p_user_id, jsonb_build_object(
    'invoice_number', v_invoice, 'reason', v_reason, 'prior_status', v_status,
    'currency', v_currency, 'money_received', v_money_received,
    'loyalty_redemption_excluded', v_loyalty_synthetic,
    'partial_refund_credit_already_issued', v_partial_credit,
    'store_credit_issued', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
    'source', p_source,
    'actor', CASE WHEN v_is_system THEN 'shopify_webhook' ELSE COALESCE(p_user_email, 'unknown') END,
    'user_email', p_user_email));
  RETURN jsonb_build_object(
    'success', true, 'cash_order_id', p_cash_order_id, 'invoice_number', v_invoice,
    'prior_status', v_status, 'money_received', v_money_received,
    'loyalty_redemption_excluded', v_loyalty_synthetic,
    'partial_refund_credit_already_issued', v_partial_credit,
    'store_credit', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx, 'source', p_source);
END;
$function$;

-- ---------------------------------------------------------------------------
-- decide_square_case
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decide_square_case(p_kind text, p_id uuid, p_decision text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  PERFORM set_config('app.provider_submission_writer', 'on', true);

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
$function$;

-- ---------------------------------------------------------------------------
-- get_square_settings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_square_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_name text;
  v_by   uuid;
  v_at   timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role) OR public.has_permission(v_uid, 'admin_settings')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  -- The most recent change among the four rows names the last editor.
  SELECT updated_by_user_id, updated_at INTO v_by, v_at
    FROM public.system_settings
   WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')
     AND updated_by_user_id IS NOT NULL
   ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  IF v_by IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found', (SELECT count(*) FROM public.system_settings
               WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')) = 4,
    'mode',                  public.square_mode(),
    'raw_mode',              (SELECT value FROM public.system_settings WHERE key = 'square_mode'),
    'app_id',                coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_app_id'), ''),
    'location_id',           coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_location_id'), ''),
    'agreement_min_jpy',     coalesce(((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'card_agreement_min_jpy'))::numeric, 0),
    'updated_at',            v_at,
    'updated_by_user_id',    v_by,
    'updated_by_name',       v_name,
    'audience',              public.square_audience(),
    'card_customers',        coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'code', c.customer_code, 'name', c.full_name) ORDER BY c.customer_code)
                                         FROM public.customers c
                                        WHERE c.id::text IN (SELECT jsonb_array_elements_text(public.square_card_customer_ids_json()))), '[]'::jsonb),
    'preflight',             (SELECT value || jsonb_build_object('updated_at', updated_at) FROM public.square_sync_state WHERE key = 'preflight:production'),
    'can_change',            public.has_role(v_uid, 'admin'::public.app_role),
    'authorized_now',        (SELECT count(*) FROM public.square_payments WHERE status = 'authorized'),
    'captured_30d',          (SELECT count(*) FROM public.square_payments
                               WHERE status = 'captured' AND captured_at >= now() - interval '30 days'),
    'disputes_open',         (SELECT count(*) FROM public.square_disputes
                               WHERE upper(coalesce(state, '')) NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')));
END
$function$;

-- ---------------------------------------------------------------------------
-- get_staff_bell_emails
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_staff_bell_emails()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_types public.system_settings%ROWTYPE;
  v_rcpt  public.system_settings%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.is_staff(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT * INTO v_types FROM public.system_settings WHERE key = 'staff_bell_email_types';
  SELECT * INTO v_rcpt  FROM public.system_settings WHERE key = 'staff_bell_email_recipients';
  IF v_types.id IS NULL OR v_rcpt.id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN jsonb_build_object(
    'found', true,
    'types', to_jsonb(public.staff_bell_email_types()),
    'addresses', coalesce(v_rcpt.value->'addresses', '[]'::jsonb),
    'roles', coalesce(v_rcpt.value->'roles', '[]'::jsonb),
    'resolved_recipients', to_jsonb(public.staff_bell_email_recipients()),
    'can_change', public.has_role(v_uid, 'admin'::public.app_role),
    'updated_at', greatest(v_types.updated_at, v_rcpt.updated_at),
    'updated_by_name', (SELECT p.full_name FROM public.profiles p
                         WHERE p.user_id = CASE WHEN v_types.updated_at >= v_rcpt.updated_at THEN v_types.updated_by_user_id ELSE v_rcpt.updated_by_user_id END
                         LIMIT 1),
    'sent_7d', (SELECT count(*) FROM public.staff_bell_emails e WHERE e.status = 'sent' AND e.sent_at > now() - interval '7 days'),
    'pending', (SELECT count(*) FROM public.staff_bell_emails e WHERE e.status IN ('pending','sending')),
    'failed_7d', (SELECT count(*) FROM public.staff_bell_emails e WHERE e.status = 'failed' AND e.created_at > now() - interval '7 days'));
END
$function$;

-- ---------------------------------------------------------------------------
-- guard_provider_submission
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_provider_submission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  /* F-01 (QC 2026-10-09): a card or Paidy submission ends by Confirm or Reject, never by Clarify. */
  IF (NEW.square_payment_id IS NOT NULL OR NEW.paidy_payment_id IS NOT NULL)
     AND NEW.status::text = 'needs_clarification'
     AND (TG_OP = 'INSERT' OR OLD.status::text IS DISTINCT FROM 'needs_clarification') THEN
    RAISE EXCEPTION 'provider_submission_no_clarify: a card or Paidy submission is Confirmed or Rejected, never sent for clarification'
      USING ERRCODE = 'P0001';
  END IF;
  /* Q-DB1 (QC 2026-10-09): a signed-in caller writing this table directly never files or moves a card / Paidy
     submission. The reviewer, provider and sweep paths run as service_role; decide_square_case and
     resolve_paidy_case mark their own transaction. */
  IF (NEW.square_payment_id IS NOT NULL OR NEW.paidy_payment_id IS NOT NULL)
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role', '') IN ('authenticated', 'anon')
     AND coalesce(current_setting('app.provider_submission_writer', true), '') <> 'on' THEN
    RAISE EXCEPTION 'provider_submission_status_locked: a card or Paidy submission changes status only through Confirm / Reject in Payments Hub'
      USING ERRCODE = 'P0001';
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
$function$;

-- ---------------------------------------------------------------------------
-- mark_web_order_refund_issued_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_web_order_refund_issued_atomic(p_order_id uuid, p_user_id uuid, p_method text, p_refunded_on date, p_note text DEFAULT NULL::text, p_exception jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_amount  numeric(12,2);
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_method  text := lower(btrim(COALESCE(p_method, '')));
  v_prev    jsonb;
  v_card_paid boolean;
  v_noncard numeric(12,2);
  v_card_refunded numeric(12,2);
  v_paidy_paid numeric(12,2) := 0;
  v_paidy_refunded numeric(12,2) := 0;
  v_paidy_remaining numeric(12,2) := 0;
  v_exc jsonb := NULL;
  v_exc_trigger text := NULL;
  v_exc_amount numeric(12,2) := 0;
  v_card_captured numeric(12,2) := 0;
  v_credit_issued numeric(12,2) := 0;
  v_cap numeric(12,2) := 0;
  v_lot public.store_credit_lots%ROWTYPE;
  v_cre public.card_refund_exceptions%ROWTYPE;
  v_payout text;
  v_card_disputed numeric(12,2) := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_order.source_channel IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_web_order');
  END IF;
  IF v_order.status::text <> 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelled', 'status', v_order.status::text);
  END IF;
  -- B01 (2026-10-08): the same request again after it succeeded (a retry
  -- after a lost answer) gets the same answer and writes nothing.
  IF v_order.refund_status = 'refund_issued' THEN
    SELECT a.new_value_json INTO v_prev FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued'
     ORDER BY a.created_at DESC LIMIT 1;
    IF v_prev IS NOT NULL AND v_prev ->> 'method' = v_method THEN
      RETURN jsonb_build_object('ok', true, 'already_recorded', true,
                                'amount', (v_prev ->> 'amount')::numeric, 'currency', v_prev ->> 'currency',
                                'method', v_method, 'refunded_on', v_prev ->> 'refunded_on',
                                'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
    END IF;
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
  IF v_method NOT IN ('bank_transfer', 'paidy', 'card', 'cash', 'other', 'bank_transfer_exception', 'store_credit_exception') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_method');
  END IF;
  IF p_refunded_on IS NULL OR p_refunded_on > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
  END IF;
  IF v_method NOT IN ('bank_transfer_exception', 'store_credit_exception')
     AND EXISTS (SELECT 1 FROM public.card_refund_exceptions WHERE cash_order_id = p_order_id AND status = 'approved') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_approved_pending');
  END IF;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_amount
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';

  -- B01 (2026-10-08): card money goes back only through Square. A card-paid
  -- order is marked with method 'card', only once Square shows a COMPLETED
  -- refund, and the amount recorded is what Square completed (owner E7) —
  -- never the gross received. Other methods only for money that did not come
  -- by card.
  v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                          WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_noncard
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(payment_method, '') <> 'square'
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  IF v_method = 'card' AND NOT v_card_paid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
  END IF;
  IF v_method IN ('bank_transfer_exception', 'store_credit_exception') THEN
    IF NOT v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
    END IF;
    IF NOT public.has_role(p_user_id, 'admin') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
    END IF;
    v_payout := CASE v_method WHEN 'bank_transfer_exception' THEN 'bank_transfer' ELSE 'store_credit' END;
    SELECT * INTO v_cre FROM public.card_refund_exceptions
     WHERE cash_order_id = p_order_id AND status = 'approved' FOR UPDATE;
    IF v_cre.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_not_approved');
    END IF;
    IF v_cre.payout <> v_payout THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_payout_mismatch', 'approved_payout', v_cre.payout);
    END IF;
    IF EXISTS (SELECT 1 FROM public.square_refunds r
                WHERE r.cash_order_id = p_order_id AND r.status NOT IN ('COMPLETED', 'FAILED', 'REJECTED')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_refund_in_progress');
    END IF;
    SELECT coalesce(sum(round(sp.amount_jpy)), 0) INTO v_card_captured
      FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured';
    SELECT coalesce(sum(r.amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds r WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED';
    SELECT coalesce(sum(round(l.original_amount)), 0) INTO v_credit_issued
      FROM public.store_credit_lots l WHERE l.source_cash_order_id = p_order_id AND l.status::text <> 'voided';
    v_card_disputed := public.square_order_disputed_jpy(p_order_id);
    v_cap := v_card_captured - v_card_refunded - v_credit_issued - v_card_disputed;
    IF v_cre.amount_jpy > v_cap THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_superseded', 'cap_jpy', v_cap, 'approved_jpy', v_cre.amount_jpy,
                                'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded, 'credit_issued_jpy', v_credit_issued);
    END IF;
    v_exc := COALESCE(p_exception, '{}'::jsonb);
    IF v_payout = 'bank_transfer' THEN
      IF COALESCE(v_exc ->> 'transfer_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_date');
      END IF;
      IF (v_exc ->> 'transfer_date')::date > (now() AT TIME ZONE 'Asia/Manila')::date
         OR (v_exc ->> 'transfer_date')::date < (v_cre.approved_at AT TIME ZONE 'Asia/Manila')::date THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_date', 'detail', 'transfer_date');
      END IF;
      IF NULLIF(btrim(COALESCE(v_exc ->> 'transfer_reference', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_reference');
      END IF;
      UPDATE public.card_refund_exceptions
         SET status = 'recorded', recorded_by = p_user_id, recorded_at = now(),
             transfer_date = (v_exc ->> 'transfer_date')::date,
             transfer_reference = left(btrim(v_exc ->> 'transfer_reference'), 200), updated_at = now()
       WHERE id = v_cre.id
      RETURNING * INTO v_cre;
    ELSE
      IF NULLIF(btrim(COALESCE(v_exc ->> 'customer_request', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'customer_request');
      END IF;
      IF COALESCE(v_exc ->> 'store_credit_lot_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'store_credit_lot_id');
      END IF;
      SELECT * INTO v_lot FROM public.store_credit_lots WHERE id = (v_exc ->> 'store_credit_lot_id')::uuid FOR UPDATE;
      IF v_lot.id IS NULL OR v_lot.customer_id IS DISTINCT FROM v_order.customer_id OR v_lot.currency::text <> 'JPY'
         OR v_lot.status::text <> 'active' OR v_lot.expires_at <= now() OR v_lot.remaining_amount <> v_lot.original_amount
         OR v_lot.original_amount <> v_cre.amount_jpy OR v_lot.source_cash_order_id IS NOT NULL
         OR v_lot.issued_at < v_cre.approved_at
         OR EXISTS (SELECT 1 FROM public.card_refund_exceptions x WHERE x.store_credit_lot_id = v_lot.id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_lot_mismatch', 'detail',
          CASE WHEN v_lot.id IS NULL THEN 'lot_not_found'
               WHEN v_lot.customer_id IS DISTINCT FROM v_order.customer_id THEN 'lot_not_this_customer'
               WHEN v_lot.currency::text <> 'JPY' THEN 'lot_not_jpy'
               WHEN v_lot.status::text <> 'active' THEN 'lot_not_active'
               WHEN v_lot.expires_at <= now() THEN 'lot_expired'
               WHEN v_lot.remaining_amount <> v_lot.original_amount THEN 'lot_already_spent'
               WHEN v_lot.source_cash_order_id IS NOT NULL THEN 'lot_tied_to_an_order'
               WHEN v_lot.issued_at < v_cre.approved_at THEN 'lot_issued_before_approval'
               WHEN v_lot.original_amount <> v_cre.amount_jpy THEN 'lot_amount_differs'
               ELSE 'lot_already_allocated' END,
          'lot_amount', v_lot.original_amount, 'approved_jpy', v_cre.amount_jpy);
      END IF;
      UPDATE public.card_refund_exceptions
         SET status = 'recorded', recorded_by = p_user_id, recorded_at = now(), store_credit_lot_id = v_lot.id,
             customer_request = left(btrim(v_exc ->> 'customer_request'), 500), updated_at = now()
       WHERE id = v_cre.id
      RETURNING * INTO v_cre;
    END IF;
    v_amount := v_cre.amount_jpy;
    v_exc := jsonb_build_object('exception_id', v_cre.id, 'trigger', v_cre.trigger_kind, 'payout', v_cre.payout,
                                'square_refund_id', v_cre.square_refund_id, 'square_support_ticket', v_cre.square_support_ticket,
                                'transfer_date', v_cre.transfer_date, 'transfer_reference', v_cre.transfer_reference,
                                'store_credit_lot_id', v_cre.store_credit_lot_id, 'customer_request', v_cre.customer_request,
                                'approved_by', v_cre.approved_by, 'approved_at', v_cre.approved_at,
                                'cap_jpy', v_cap, 'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded,
                                'credit_issued_jpy', v_credit_issued);
  END IF;
  IF v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') AND v_card_paid AND v_noncard <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_card');
  END IF;
  -- Mixed payment (card + something else): a non-card method records only the
  -- non-card money; the card part comes back through Square and is recorded by
  -- Square's own refund email / the card row. Never the gross.
  IF v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') AND v_card_paid THEN
    v_amount := v_noncard;
  END IF;
  IF v_method = 'card' THEN
    SELECT COALESCE(SUM(LEAST(x.done, x.cap)), 0) INTO v_card_refunded
      FROM (SELECT SUM(r.amount_jpy) AS done,
                   MAX(COALESCE(sp.captured_amount_jpy, round(sp.amount_jpy)::bigint)) AS cap
              FROM public.square_refunds r
              JOIN public.square_payments sp ON sp.id = r.square_payment_row
             WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED' AND sp.cash_payment_id IS NOT NULL
             GROUP BY sp.id) x;
    IF v_card_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := LEAST(v_amount, v_card_refunded);
  END IF;
  -- PA03 (owner 2026-10-08): Paidy money goes back only through the Paidy
  -- dashboard and counts only once the Hub has read the refund back from
  -- Paidy (paidy_refunds, written by record_paidy_refund). Method 'paidy'
  -- needs Paidy money on the order and at least one verified refund; the
  -- amount recorded is the verified total, capped at the Paidy money, and the
  -- audit carries cumulative refunded + remaining — never the gross. A
  -- non-Paidy method on a mixed order records only the non-Paidy money.
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_paidy_paid
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'paidy';
  SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded
    FROM public.paidy_refunds r WHERE r.cash_order_id = p_order_id;
  IF v_method = 'paidy' AND v_paidy_paid <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_paidy');
  END IF;
  IF v_method = 'paidy' THEN
    IF v_paidy_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_verified_paidy_refund', 'paidy_paid_jpy', v_paidy_paid);
    END IF;
    v_amount := LEAST(v_paidy_paid, v_paidy_refunded);
    v_paidy_remaining := GREATEST(0, v_paidy_paid - v_paidy_refunded);
  ELSIF v_paidy_paid > 0 AND v_method NOT IN ('bank_transfer_exception', 'store_credit_exception') THEN
    IF v_amount - v_paidy_paid <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_paidy');
    END IF;
    v_amount := v_amount - v_paidy_paid;
  END IF;

  UPDATE public.cash_orders
     SET refund_status = 'refund_issued',
         refund_note = CASE
           WHEN v_note IS NULL THEN refund_note
           WHEN refund_note IS NULL OR btrim(refund_note) = '' THEN v_note
           ELSE refund_note || E'\n' || v_note END
   WHERE id = p_order_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'refund_marked_issued',
          jsonb_build_object('refund_status', 'refund_pending'),
          jsonb_build_object('refund_status', 'refund_issued', 'method', v_method, 'refunded_on', p_refunded_on,
                             'amount', v_amount, 'currency', v_order.currency::text, 'note', v_note,
                             'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_total_jpy', v_paidy_refunded,
                             'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'currency', v_order.currency::text,
                            'method', v_method, 'refunded_on', p_refunded_on,
                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
END
$function$;

-- ---------------------------------------------------------------------------
-- record_square_dispute
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_square_dispute(p_dispute_id text, p_square_payment_id text, p_state text, p_reason text, p_amount_jpy bigint, p_due_at timestamp with time zone, p_provider_created_at timestamp with time zone, p_provider_updated_at timestamp with time zone, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- QC10 (2026-10-05): one writer per provider case at a time, including the
  -- very first insert (two first observations used to both pass the check).
  PERFORM pg_advisory_xact_lock(hashtextextended('square_dispute:' || p_dispute_id, 0));
  SELECT * INTO v_old FROM public.square_disputes WHERE square_dispute_id = p_dispute_id FOR UPDATE;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_old.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- A terminal provider state never goes back to an open one (QC10).
  IF v_old.id IS NOT NULL AND v_old.state IN ('WON','LOST','ACCEPTED') AND v_st NOT IN ('WON','LOST','ACCEPTED') THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true, 'terminal', v_old.state);
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
   WHERE square_disputes.provider_updated_at IS NULL OR EXCLUDED.provider_updated_at IS NULL
      OR EXCLUDED.provider_updated_at >= square_disputes.provider_updated_at
  RETURNING * INTO v_new;
  IF v_new.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
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
  IF v_st IN ('EVIDENCE_REQUIRED','PROCESSING','LOST','ACCEPTED')
     AND (v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state) THEN
    IF EXISTS (SELECT 1 FROM public.store_credit_lots l
                WHERE l.source_cash_order_id = v_sq.cash_order_id AND l.status::text <> 'voided') THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_dispute_after_credit', 'Chargeback on an order already given store credit',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · '
                || coalesce('¥' || to_char(v_new.amount_jpy, 'FM999,999,999'), '') || ' · state ' || v_st
                || ' — the card network holds or took back this money, but the order already carries store credit. The customer may be compensated twice: a staff case (void the unspent credit, or contest the dispute in the Square Dashboard).',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'dispute_id', p_dispute_id, 'state', v_st, 'test', v_sq.test));
    END IF;
    IF EXISTS (SELECT 1 FROM public.card_refund_exceptions x
                WHERE x.cash_order_id = v_sq.cash_order_id AND x.status IN ('approved','recorded')) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_dispute_after_exception', 'Chargeback on an order refunded outside Square',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · '
                || coalesce('¥' || to_char(v_new.amount_jpy, 'FM999,999,999'), '') || ' · state ' || v_st
                || ' — the card network holds or took back this money, but a refund outside Square is approved or paid on this order. Do not pay an approved one; if it is paid, contest the dispute in the Square Dashboard.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'dispute_id', p_dispute_id, 'state', v_st, 'test', v_sq.test));
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state,
                            'dispute', to_jsonb(v_new));
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
  PERFORM set_config('app.provider_submission_writer', 'on', true);
  SELECT * INTO v_case FROM public.paidy_cases WHERE id = p_case_id FOR UPDATE;
  IF v_case.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_case.status <> 'open' THEN RETURN jsonb_build_object('error', 'already_resolved'); END IF;

  -- PA01 (owner brief 2026-10-08): a capture case with NO payment row is an
  -- orphan — Paidy took money the Hub has no receipt for, and this open case
  -- is the order's only lock (cash_order_payment_lock). A note never settles
  -- it: it closes through record_capture once a Hub payment row exists, or
  -- when paidy-reconcile has verified with Paidy that the capture was fully
  -- refunded (resolution refunded_in_paidy, written by the sweep itself).
  IF v_case.paidy_payment_row IS NULL
     AND v_case.kind IN ('captured_unrecorded','captured_no_submission','record_failed')
     AND p_resolution IN ('no_action','handled_in_paidy','released','refunded_in_paidy','end_submission') THEN
    RETURN jsonb_build_object('error', 'orphan_capture_unsettled', 'paidy_payment_id', v_case.paidy_payment_id);
  END IF;

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
-- terminate_web_order_atomic
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
  v_order_date date; v_order_at timestamptz; v_split jsonb := NULL; v_card_paid boolean := false;
  v_card_refunded boolean := false;
  v_card_disputed bigint := 0;
  v_credit_refusal text := NULL;
  v_paidy_paid numeric(12,2) := 0; v_paidy_refunded numeric(12,2) := 0;
  v_points_to_revoke numeric := 0; v_spend_to_reverse numeric := 0;
  v_reason text; v_is_system boolean; v_stock_lines integer := 0; v_restored integer := 0;
  v_flipped integer := 0; v_now timestamptz := now();
BEGIN
  IF p_outcome NOT IN ('expired','cancelled') THEN
    RAISE EXCEPTION 'bad_outcome: %', p_outcome USING ERRCODE='P0001';
  END IF;
  v_is_system := (p_source IN ('system','shopify_webhook'));

  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid, order_date, created_at
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid, v_order_date, v_order_at
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
  -- Paidy (H10, qc-audit P2-3): a Paidy authorisation, a capture not yet
  -- recorded, a Paidy submission awaiting Confirm or an open Paidy window stops
  -- EVERY termination, staff included — Reject or record the Paidy payment
  -- first, so a cancelled order never leaves Paidy money behind.
  IF NOT (p_preview AND p_outcome = 'cancelled' AND p_source = 'staff')   -- owner 2026-10-06: cancel closes Paidy first
     AND coalesce(public.cash_order_payment_lock(p_order_id), '') LIKE 'paidy%' THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_payment_unresolved',
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
    -- Points are a discount, not money (2026-10-05): an order carrying only a
    -- checkout points redemption still lapses. Rule 9: the points stay spent.
    IF v_status <> 'pending' OR v_money_received > 0 OR COALESCE(v_total_paid, 0) - v_loyalty_synthetic > 0 THEN
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
    -- B01 (2026-10-08): card money goes back only through Square, so a card
    -- order cannot be closed as "refund issued" here: choose "refund pending",
    -- refund in Square, then "Mark refund issued" once Square shows it.
    v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                            WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
    IF NOT p_preview AND v_money_received > 0 AND p_refund_status = 'refund_issued' AND v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_refund_needs_square',
        'status', v_status);
    END IF;
    -- PA03 (owner 2026-10-08): Paidy money goes back only through the Paidy
    -- dashboard, and only a refund the Hub has read back from Paidy counts.
    -- "Refund issued" on a Paidy-paid order needs verified Paidy refunds that
    -- cover the Paidy money; otherwise choose "refund pending", refund in
    -- Paidy, and "Mark refund issued" once the Hub has recorded it.
    SELECT COALESCE(SUM(amount_paid), 0) INTO v_paidy_paid FROM public.cash_payments
     WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'paidy';
    SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded FROM public.paidy_refunds r
     WHERE r.cash_order_id = p_order_id;
    IF NOT p_preview AND v_paidy_paid > 0 AND p_refund_status = 'refund_issued' AND v_paidy_refunded < v_paidy_paid THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_refund_needs_dashboard',
        'status', v_status, 'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_jpy', v_paidy_refunded);
    END IF;
    -- R05 (owner 2026-10-08, refuse): money already given back through Square
    -- (any refund not FAILED / REJECTED — pending counts, it is committed) can
    -- never come back a second time as store credit. Staff see the reason and
    -- use "refund pending" → "Mark refund issued" instead.
    v_card_refunded := EXISTS (SELECT 1 FROM public.square_refunds
                                WHERE cash_order_id = p_order_id AND status NOT IN ('FAILED','REJECTED'));
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_card_refunded THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_already_refunded',
        'status', v_status);
    END IF;
    -- PA02 (owner 2026-10-08, refuse): money already given back through Paidy
    -- (a verified paidy_refunds row — an exception to the no-cash-refund
    -- policy) can never come back a second time as store credit. Staff see
    -- the reason and use "refund pending" → "Mark refund issued" instead.
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_paidy_refunded > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_already_refunded',
        'status', v_status, 'paidy_refunded_jpy', v_paidy_refunded);
    END IF;
    v_card_disputed := public.square_order_disputed_jpy(p_order_id);
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_card_disputed > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_disputed',
        'status', v_status, 'disputed_jpy', v_card_disputed);
    END IF;
    v_credit_refusal := CASE WHEN v_card_refunded THEN 'card_already_refunded'
                             WHEN v_paidy_refunded > 0 THEN 'paidy_already_refunded'
                             WHEN v_card_disputed > 0 THEN 'card_disputed' END;
    -- Cancellation credit rule (owner 2026-10-06/08): same day as order_date →
    -- 100 %; later → 30 % of the money paid kept, 70 % credit. No override.
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now, v_order_at);
    -- Store credit is minted ONLY when staff choose "store credit issued"
    -- (money received, minus credit already minted by Shopify partial refunds).
    -- A refund never doubles as credit; "no refund" is a forfeiture and mints
    -- nothing. Never automatic (owner decision 2026-09-13).
    IF p_refund_status = 'store_credit_issued' THEN
      v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
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
      'store_credit_if_chosen', CASE WHEN v_credit_refusal IS NOT NULL THEN 0
                                     ELSE GREATEST(0, COALESCE((v_split ->> 'credit')::numeric, 0) - v_partial_credit) END,
      'store_credit_refusal', v_credit_refusal,
      'card_disputed_jpy', v_card_disputed,
      'cancellation_rule', v_split ->> 'rule',
      'cancellation_charge', COALESCE((v_split ->> 'kept')::numeric, 0),
      'cancellation_split', v_split,
      'paid_by_card', v_card_paid,
      'card_refunded', v_card_refunded,
      'paid_by_paidy', (v_paidy_paid > 0),
      'paidy_paid_jpy', v_paidy_paid,
      'paidy_refunded_jpy', v_paidy_refunded,
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
           || CASE WHEN COALESCE((v_split ->> 'kept')::numeric, 0) > 0
                   THEN ' (30% cancellation charge kept: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || (v_split ->> 'kept') || ')'
                   ELSE '' END
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
      'store_credit_issued', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
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
    'store_credit', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
    'earned_points_revoked', v_points_to_revoke,
    'lifetime_spend_reversed_jpy', v_spend_to_reverse,
    'lines_restored', v_restored, 'source', p_source);
END;
$function$;
