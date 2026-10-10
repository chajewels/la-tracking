-- Record-only (2026-10-10). Already applied on live — replaying is a no-op.
--
-- Why: 20261201120000 (Square L2–L8) and 20261202100000 (Cash on Delivery) changed these twelve
-- functions with md5-guarded IN-PLACE patches (pg_temp.cj_patch). The drift audit reads only CREATE
-- FUNCTION statements, so the repo's newest copy of each was the PRE-patch body. This file records
-- the bodies exactly as live runs them after the Lovable applies of 2026-10-10 ~04:40Z and ~04:47Z
-- (pg_get_functiondef read from live; md5(pg_get_functiondef) below).
--
--   apply_square_payment_state                    17df6d2d2572341f43009edf4d3413c4
--   change_web_payment_method_atomic              8900a8096048167550678395068e0453
--   close_square_attempt_atomic                   7d1a75097e5703c946df2e9fbd8ad6f0
--   create_web_draft_atomic                       aa47ddeb19aeeb84d0449801f5d8bfd3
--   file_square_authorization_atomic              1c3ec249a51c62f3ed0703385295e3d5
--   mark_web_order_refund_issued_atomic           fdece38f899856663b73f4533cf5e286
--   materialize_web_draft_atomic                  a52553d50cccf5bbfc28b898f0750179
--   record_square_dispute                         121e15547756e051d4b0ec7bfa5cabb1
--   set_account_deadlines                         b172774a88845e733f39e77ac501f647
--   switch_web_payment_method_by_customer_atomic  483bba9800f706fe56f841e687ad11fd
--   terminate_web_order_atomic                    13b97cb1a440ab10ff6dd9cd9af7f4fe
--   web_payment_reminder_eligible                 b1a8eba2bf7b1209808de0fcc619d2c5
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
  PERFORM 1 FROM public.square_card_attempts a
   WHERE a.id = (SELECT attempt_id FROM public.square_payments WHERE square_payment_id = p_square_payment_id)
      OR a.reference = (SELECT reference FROM public.square_payments WHERE square_payment_id = p_square_payment_id)
   ORDER BY a.id FOR UPDATE;
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
         refund_jpy = CASE WHEN p_refunded_jpy IS NULL THEN refund_jpy ELSE greatest(p_refunded_jpy, 0) END,
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
-- change_web_payment_method_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.change_web_payment_method_atomic(p_entity_type text, p_entity_id uuid, p_method text, p_reason text, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old    text;
  v_mode   text;
  v_cur    text;
  v_status text;
  v_pay    text;
  v_ready  timestamptz;
  v_chan   text;
  v_lock   text;
  v_ref    text;
  v_country text;
  v_cust   uuid;
  v_base   numeric(12,2);
  v_old_fee numeric(12,2) := 0;
  v_new_fee integer := 0;
  v_dl     jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT public.has_permission(p_user_id, 'confirm_payment') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;

  IF p_entity_type = 'draft' THEN
    SELECT payment_method, mode, settlement_currency, status, web_reference, upper(nullif(btrim(coalesce(country, '')), '')), customer_id
      INTO v_old, v_mode, v_cur, v_status, v_ref, v_country, v_cust
      FROM public.web_order_drafts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_status <> 'to_confirm' THEN
      RETURN jsonb_build_object('error', 'not_open', 'status', v_status);
    END IF;
  ELSIF p_entity_type = 'cash_order' THEN
    SELECT coalesce(payment_method, 'transfer'), 'full', currency::text, status::text, payment_status,
           ready_confirmed_at, source_channel, coalesce(web_reference, invoice_number),
           upper(nullif(btrim(coalesce(ship_to_snapshot ->> 'country', '')), '')), customer_id
      INTO v_old, v_mode, v_cur, v_status, v_pay, v_ready, v_chan, v_ref, v_country, v_cust
      FROM public.cash_orders WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_chan IS DISTINCT FROM 'web' THEN
      RETURN jsonb_build_object('error', 'not_web_order');
    END IF;
    IF v_status <> 'pending' OR coalesce(v_pay, '') <> 'pending_transfer' THEN
      RETURN jsonb_build_object('error', 'not_payable', 'status', v_status);
    END IF;
    -- Owner rule 2026-10-04: while Paidy, a card hold or any other payment is
    -- in progress, nothing about how the order is paid changes. Paidy declined
    -- = staff Reject first, then the method can change.
    v_lock := public.cash_order_payment_lock(p_entity_id);
    IF v_lock IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', v_lock);
    END IF;
  ELSE
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;

  IF v_old = p_method THEN
    RETURN jsonb_build_object('error', 'unchanged', 'payment_method', v_old);
  END IF;
  IF p_method <> 'transfer' AND v_mode = 'layaway' THEN
    RETURN jsonb_build_object('error', 'method_full_payment_only');
  END IF;
  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;
  -- QC 2026-10-06: the same availability check as checkout
  -- (create_web_draft_atomic), so a customer is never told to pay by a method
  -- the order cannot take.
  IF (p_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP'))
     OR (p_method = 'square' AND NOT public.square_card_allowed(v_cust))
     OR (p_method = 'cod' AND (public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP')) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
  END IF;

  IF p_entity_type = 'draft' THEN
    SELECT total - coalesce(cod_fee, 0) - coalesce(points_value, 0), coalesce(cod_fee, 0)
      INTO v_base, v_old_fee FROM public.web_order_drafts WHERE id = p_entity_id;
  ELSE
    SELECT remaining_balance - coalesce(cod_fee, 0), coalesce(cod_fee, 0)
      INTO v_base, v_old_fee FROM public.cash_orders WHERE id = p_entity_id;
  END IF;
  IF p_method = 'cod' THEN
    v_new_fee := public.cod_fee_jpy(v_base);
    IF v_new_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_base <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', p_method, 'collected', v_base, 'limit', public.cod_limit_jpy());
    END IF;
  END IF;
  IF p_entity_type = 'draft' THEN
    UPDATE public.web_order_drafts
       SET payment_method = p_method, cod_fee_jpy = v_new_fee, cod_fee = v_new_fee,
           total = total - v_old_fee + v_new_fee, total_jpy = total_jpy - v_old_fee::integer + v_new_fee,
           updated_at = now()
     WHERE id = p_entity_id;
  ELSE
    UPDATE public.cash_orders
       SET payment_method = p_method, cod_fee = v_new_fee,
           total_amount = total_amount - v_old_fee + v_new_fee,
           remaining_balance = remaining_balance - v_old_fee + v_new_fee,
           transfer_due_at = CASE WHEN p_method = 'cod' THEN NULL ELSE transfer_due_at END,
           expires_at = CASE WHEN p_method = 'cod' THEN NULL ELSE expires_at END,
           updated_at = now()
     WHERE id = p_entity_id;
    IF v_old = 'cod' AND p_method <> 'cod' AND v_ready IS NOT NULL THEN
      v_dl := public.set_account_deadlines('cash_order', p_entity_id,
                now() + make_interval(hours => public.web_deposit_deadline_hours(v_cust, p_entity_id)),
                'Payment method changed from cash on delivery: ' || v_reason, p_user_id);
      IF v_dl ? 'error' THEN
        RAISE EXCEPTION 'deadline_not_set: %', v_dl ->> 'error';
      END IF;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_entity_type = 'draft' THEN 'web_order_draft' ELSE 'cash_order' END, p_entity_id,
          'payment_method_changed',
          jsonb_build_object('payment_method', v_old),
          jsonb_build_object('payment_method', p_method, 'reason', v_reason, 'reference', v_ref,
                             'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'entity_type', p_entity_type, 'entity_id', p_entity_id,
                            'old_method', v_old, 'payment_method', p_method, 'reference', v_ref,
                            'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer, 'fee_delta', v_new_fee - v_old_fee::integer,
                            'transfer_due_at', v_dl -> 'new' ->> 'transfer_due_at');
END
$function$;

-- ---------------------------------------------------------------------------
-- close_square_attempt_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_square_attempt_atomic(p_attempt_id uuid, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_att  public.square_card_attempts%ROWTYPE;
  v_old  text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF v_note IS NULL OR length(v_note) < 10 THEN RETURN jsonb_build_object('ok', false, 'error', 'note_required'); END IF;
  SELECT * INTO v_att FROM public.square_card_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_att.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  PERFORM 1 FROM public.cash_orders WHERE id = v_att.cash_order_id FOR UPDATE;
  IF v_att.status NOT IN ('reserved', 'unknown', 'cancelling') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open', 'status', v_att.status);
  END IF;
  IF v_att.created_at > now() - interval '30 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_recent', 'created_at', v_att.created_at);
  END IF;
  IF v_att.square_payment_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.square_payments sp
                 WHERE sp.attempt_id = v_att.id OR (v_att.reference IS NOT NULL AND sp.reference = v_att.reference)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_exists');
  END IF;
  v_old := v_att.status;
  UPDATE public.square_card_attempts
     SET status = 'cancelled', error_code = 'closed_by_admin',
         detail = left('Closed by an admin after checking the Square Dashboard: ' || v_note, 500),
         resolved_at = now(), updated_at = now()
   WHERE id = v_att.id
  RETURNING * INTO v_att;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('square_card_attempt', v_att.id, 'square_attempt_closed_by_admin', jsonb_build_object('status', v_old),
          jsonb_build_object('status', 'cancelled', 'note', v_note, 'cash_order_id', v_att.cash_order_id,
                             'reference', v_att.reference, 'amount_jpy', v_att.amount_jpy), v_uid);
  RETURN jsonb_build_object('ok', true, 'attempt_id', v_att.id, 'from', v_old, 'cash_order_id', v_att.cash_order_id);
END
$function$;

-- ---------------------------------------------------------------------------
-- create_web_draft_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_web_draft_atomic(p_customer_id uuid, p_quote_id uuid, p_lang text DEFAULT NULL::text, p_agreement_version text DEFAULT NULL::text, p_agreement_signed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote     public.checkout_quotes%ROWTYPE;
  v_item      jsonb;
  v_variant   public.website_product_variants%ROWTYPE;
  v_qty       integer;
  v_updated   integer;
  v_seq       bigint;
  v_reference text;
  v_draft_id  uuid;
  v_lang      text := CASE WHEN p_lang IN ('ja', 'en') THEN p_lang ELSE NULL END;
  v_agr_ver   text := nullif(btrim(coalesce(p_agreement_version, '')), '');
  v_cur       text;
  v_rate      numeric(12,6);
  v_total     numeric(12,2);
  v_shipping  numeric(12,2);
  v_subtotal  numeric(12,2);
  v_snapshot  jsonb;
  v_country   text;
  v_q         jsonb;
  v_deposit   numeric(12,2);
  v_schedule  jsonb;
  v_title     text;
  v_lines     integer := 0;
  v_method    text;
  v_points    integer := 0;
  v_pts_value numeric(12,2) := 0;
  v_member    public.loyalty_members%ROWTYPE;
  v_held      numeric := 0;
  v_red_id    uuid;
  v_cod_fee   integer := 0;
BEGIN
  -- Dormant until the owner flips the switch (PR 8): the edge function only
  -- calls this in 'draft' mode, and this refuses otherwise.
  IF public.web_checkout_mode() <> 'draft' THEN
    RETURN jsonb_build_object('error', 'checkout_mode_not_draft');
  END IF;

  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND OR v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode NOT IN ('full', 'layaway') THEN
    RETURN jsonb_build_object('error', 'unsupported_mode');
  END IF;
  IF coalesce(v_quote.total_jpy, 0) <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;
  IF v_quote.mode = 'layaway' AND (v_agr_ver IS NULL OR p_agreement_signed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'agreement_missing');
  END IF;

  v_snapshot := public.address_snapshot(v_quote.ship_to_address_id);
  v_country  := upper(nullif(btrim(coalesce(v_snapshot ->> 'country', '')), ''));

  -- Shipping may be added at confirmation (R4) — but never for a destination
  -- that HAS a rate card: there the quote must carry the fee.
  IF v_quote.shipping_jpy IS NULL AND v_country IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.shipping_rates r WHERE r.country = v_country AND r.is_active) THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;

  -- The customer's currency, converted ONCE at the quote's rate: the same
  -- arithmetic as create_web_order_atomic / create_web_layaway_atomic (whole
  -- pesos half-up; shipping on its own, items the remainder).
  v_cur := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_cur = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := CASE WHEN v_quote.shipping_jpy IS NULL THEN NULL ELSE round(v_quote.shipping_jpy * v_rate) END;
  ELSE
    v_cur      := 'JPY';
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := v_quote.shipping_jpy;
  END IF;
  v_subtotal := v_total - coalesce(v_shipping, 0);

  -- A layaway is checked against the plan minimum now (as today), so a draft
  -- that could never be confirmed is never written. Figures are provisional.
  IF v_quote.mode = 'layaway' THEN
    v_q := public.layaway_quote(v_subtotal::integer, v_quote.term_months, v_cur,
                                (now() AT TIME ZONE 'Asia/Manila')::date, coalesce(v_shipping, 0)::integer, 0);
    IF NOT coalesce((v_q ->> 'eligible')::boolean, false)
       OR coalesce((v_q ->> 'term_downgraded')::boolean, false) THEN
      RETURN jsonb_build_object('error', 'below_plan_minimum', 'total', v_total, 'currency', v_cur,
                                'requested_term_months', v_quote.term_months,
                                'max_term_months', v_q -> 'max_term_months');
    END IF;
    v_deposit  := (v_q ->> 'deposit')::numeric;
    v_schedule := v_q -> 'schedule';
  END IF;

  -- CHECKOUT PAYMENT CHOICE + POINTS (2026-10-05, owner C1–C7). The website
  -- stored the customer's choice on the quote; it is checked again here, in
  -- the transaction that holds the pieces, so a draft only ever carries a
  -- method the order can take and points the customer really has.
  v_method := coalesce(nullif(btrim(coalesce(v_quote.payment_method, '')), ''), 'transfer');
  IF v_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
  IF v_method <> 'transfer' AND v_quote.mode = 'layaway' THEN
    RETURN jsonb_build_object('error', 'method_full_payment_only', 'method', v_method);
  END IF;
  IF v_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen', 'method', v_method);
  END IF;
  IF (v_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP'))
     OR (v_method = 'square' AND NOT public.square_card_allowed(p_customer_id))
     OR (v_method = 'cod' AND (public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP')) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', v_method);
  END IF;
  v_points := coalesce(v_quote.points, 0);
  IF v_points < 0 THEN
    RETURN jsonb_build_object('error', 'bad_points');
  END IF;
  IF v_points > 0 THEN
    IF coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'loyalty_enabled'), '') <> 'true' THEN
      RETURN jsonb_build_object('error', 'points_unavailable');
    END IF;
    -- The member row lock serialises two checkouts spending the same points.
    SELECT * INTO v_member FROM public.loyalty_members WHERE customer_id = p_customer_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'points_not_enrolled');
    END IF;
    SELECT coalesce(sum(points_redeemed), 0) INTO v_held
      FROM public.loyalty_redemptions WHERE member_id = v_member.id AND status = 'pending';
    IF v_points > coalesce(v_member.remaining_points, 0) - v_held THEN
      RETURN jsonb_build_object('error', 'points_insufficient',
                                 'points_available', greatest(coalesce(v_member.remaining_points, 0) - v_held, 0));
    END IF;
    -- C4: points never pay shipping — at most the pieces subtotal, in yen.
    IF v_points > coalesce(v_quote.subtotal_jpy, 0) THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0));
    END IF;
    -- 1 pt = ¥1; a peso order converts once at the quote's rate, half-up, as
    -- every other figure on it.
    v_pts_value := CASE WHEN v_cur = 'PHP' THEN round(v_points * v_rate) ELSE v_points END;
    IF v_quote.mode = 'layaway' AND v_pts_value > coalesce(v_deposit, 0) THEN
      RETURN jsonb_build_object('error', 'points_exceed_deposit', 'deposit', v_deposit);
    END IF;
    IF v_quote.mode = 'full' AND v_pts_value > v_subtotal THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0));
    END IF;
  END IF;

  -- The number: a layaway's was reserved at quote time (the agreement was
  -- signed against it); a cash order's is drawn now.
  IF v_method = 'cod' THEN
    v_cod_fee := public.cod_fee_jpy(v_total - v_pts_value);
    IF v_cod_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_total - v_pts_value <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', v_method, 'collected', v_total - v_pts_value, 'limit', public.cod_limit_jpy());
    END IF;
  END IF;
  v_seq       := CASE WHEN v_quote.mode = 'layaway'
                      THEN coalesce(v_quote.reserved_invoice_seq, public.next_web_invoice_seq())
                      ELSE public.next_web_invoice_seq() END;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.web_order_drafts (
    quote_id, customer_id, mode, term_months,
    settlement_currency, fx_rate, fx_rate_date,
    subtotal_jpy, shipping_jpy, total_jpy, subtotal, shipping, total, deposit, schedule,
    ship_to_address_id, ship_to_snapshot, country, order_type, recipient_name, recipient_phone, gift_note,
    customer_lang, agreement_version, agreement_signed_at, invoice_seq, web_reference
  ) VALUES (
    v_quote.id, p_customer_id, v_quote.mode, CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    v_cur, v_rate, CASE WHEN v_rate IS NULL THEN NULL ELSE v_quote.fx_rate_date END,
    v_quote.subtotal_jpy, v_quote.shipping_jpy, v_quote.total_jpy, v_subtotal, v_shipping, v_total, v_deposit, v_schedule,
    v_quote.ship_to_address_id, v_snapshot, v_country, coalesce(v_quote.order_type, 'SELF'),
    v_quote.recipient_name, v_quote.recipient_phone, v_quote.gift_note,
    v_lang,
    CASE WHEN v_quote.mode = 'layaway' THEN v_agr_ver END,
    CASE WHEN v_quote.mode = 'layaway' THEN p_agreement_signed_at END,
    v_seq, v_reference
  ) RETURNING id INTO v_draft_id;

  -- The points are HELD by a pending redemption; staff Confirm approves it.
  IF v_points > 0 THEN
    INSERT INTO public.loyalty_redemptions (
      member_id, redemption_type, points_redeemed, value_applied_jpy, value_applied_php,
      rate_snapshot, invoice_number, status, notes, web_draft_id
    ) VALUES (
      v_member.id, 'new_order_discount', v_points, v_points,
      CASE WHEN v_cur = 'PHP' THEN v_pts_value END,
      coalesce(v_rate, (SELECT (value #>> '{}')::numeric FROM public.system_settings WHERE key = 'php_jpy_rate')),
      v_seq::text, 'pending',
      'Website checkout ' || v_reference || ' — approved automatically when staff confirm the order',
      v_draft_id
    ) RETURNING id INTO v_red_id;
  END IF;
  UPDATE public.web_order_drafts
     SET payment_method = v_method, points = v_points, points_value = v_pts_value,
         points_redemption_id = v_red_id,
         cod_fee_jpy = v_cod_fee, cod_fee = v_cod_fee,
         total = total + v_cod_fee, total_jpy = total_jpy + v_cod_fee
   WHERE id = v_draft_id;

  -- Hold the pieces: the same guarded decrement as the order writers.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(coalesce((v_item ->> 'qty')::int, 1), 1);
    SELECT * INTO v_variant FROM public.website_product_variants WHERE id = (v_item ->> 'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item ->> 'variant_id';
    END IF;
    -- QC 2026-10-06: a product unpublished after the quote is not drafted.
    IF NOT EXISTS (SELECT 1 FROM public.website_products p
                    WHERE p.id = v_variant.product_id AND p.status = 'active') THEN
      RAISE EXCEPTION 'product_unavailable:%', v_variant.id;
    END IF;
    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;
    SELECT trim(both ' ' FROM p.name
                 || coalesce(' / ' || nullif(v_variant.size, ''), '')
                 || coalesce(' / ' || nullif(v_variant.stone, ''), ''))
      INTO v_title FROM public.website_products p WHERE p.id = v_variant.product_id;
    INSERT INTO public.web_order_draft_lines (
      draft_id, variant_id, website_product_id, title, sku, qty, unit_price_jpy, line_total_jpy
    ) VALUES (
      v_draft_id, v_variant.id, v_variant.product_id, coalesce(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      -- QC 2026-10-06: the quote's unit price (what the customer saw and
      -- the draft total is made of), the variant's price only as a fallback.
      v_qty, coalesce((v_item ->> 'unit_price_jpy')::numeric, v_variant.price_jpy),
      coalesce((v_item ->> 'unit_price_jpy')::numeric, v_variant.price_jpy) * v_qty
    );
    v_lines := v_lines + 1;
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'empty_quote:';
  END IF;

  UPDATE public.checkout_quotes SET consumed_at = now(), cod_fee_jpy = v_cod_fee WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true, 'draft_id', v_draft_id, 'web_reference', v_reference, 'invoice_number', v_seq::text,
    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total + v_cod_fee, 'total_jpy', v_quote.total_jpy + v_cod_fee,
    'cod_fee', v_cod_fee,
    'shipping_pending', v_shipping IS NULL, 'deposit', v_deposit, 'schedule', v_schedule,
    'term_months', CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    'fx_rate', v_rate, 'awaiting_confirmation', true,
    'payment_method', v_method, 'points', v_points, 'points_value', v_pts_value);
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'product_unavailable:%' THEN
      RETURN jsonb_build_object('error', 'product_unavailable', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'empty_quote:%' THEN
      RETURN jsonb_build_object('error', 'empty_quote');
    END IF;
    RAISE;
END
$function$;

-- ---------------------------------------------------------------------------
-- file_square_authorization_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_square_authorization_atomic(p_attempt_id uuid, p_square_payment_id text, p_amount_jpy bigint, p_currency text, p_location_id text, p_card_brand text, p_card_last4 text, p_receipt_url text, p_authorized_at timestamp with time zone, p_capture_by timestamp with time zone, p_risk_level text, p_provider_verification jsonb, p_provider_version text, p_provider_updated_at timestamp with time zone, p_payload jsonb, p_payment_date date, p_sender_name text, p_notes text, p_reference_label text, p_path text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
                || CASE WHEN left(v_reason, 8) = 'attempt_'
                        THEN '). Its card attempt was already closed, so the Hub voids this hold automatically. A "Card hold could not be voided" bell follows only if that fails.'
                        ELSE '). Open Website → Card payments: record it or void it in the Square Dashboard.' END,
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
  v_further boolean := false;
  v_marked_card numeric(12,2) := 0;
  v_marked_noncard boolean := false;
  v_marked_exc boolean := false;
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
       AND a.new_value_json ->> 'method' = v_method
     ORDER BY a.created_at DESC LIMIT 1;
    SELECT coalesce(sum((a.new_value_json ->> 'amount')::numeric) FILTER (WHERE a.new_value_json ->> 'method' = 'card'), 0),
           coalesce(bool_or(a.new_value_json ->> 'method' IN ('bank_transfer', 'paidy', 'cash', 'other')), false),
           coalesce(bool_or(a.new_value_json ->> 'method' IN ('bank_transfer_exception', 'store_credit_exception')), false)
      INTO v_marked_card, v_marked_noncard, v_marked_exc
      FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued';
    v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                            WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
    SELECT COALESCE(SUM(amount_paid), 0) INTO v_noncard
      FROM public.cash_payments
     WHERE cash_order_id = p_order_id AND voided_at IS NULL
       AND COALESCE(payment_method, '') <> 'square'
       AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
    IF v_method = 'card' THEN
      v_further := NOT v_marked_exc AND public.square_order_card_refund_recordable_jpy(p_order_id) > v_marked_card + 0.005;
    ELSIF v_method IN ('bank_transfer', 'paidy', 'cash', 'other') THEN
      v_further := v_prev IS NULL AND NOT v_marked_noncard AND v_card_paid AND v_noncard > 0;
    END IF;
    IF NOT v_further AND v_prev IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'already_recorded', true,
                                'amount', (v_prev ->> 'amount')::numeric, 'currency', v_prev ->> 'currency',
                                'method', v_method, 'refunded_on', v_prev ->> 'refunded_on',
                                'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
    END IF;
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' AND NOT v_further THEN
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
    v_card_refunded := public.square_order_card_refund_recordable_jpy(p_order_id);
    IF v_card_refunded - v_marked_card <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := v_card_refunded - v_marked_card;
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
  ELSIF v_paidy_paid > 0 AND v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') THEN
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
          jsonb_build_object('refund_status', v_order.refund_status),
          jsonb_build_object('refund_status', 'refund_issued', 'method', v_method, 'refunded_on', p_refunded_on,
                             'amount', v_amount, 'currency', v_order.currency::text, 'note', v_note,
                             'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_total_jpy', v_paidy_refunded,
                             'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                             'further_mark', v_further, 'card_marked_before_jpy', v_marked_card,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'currency', v_order.currency::text,
                            'method', v_method, 'refunded_on', p_refunded_on,
                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                            'further_mark', v_further,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
END
$function$;

-- ---------------------------------------------------------------------------
-- materialize_web_draft_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.materialize_web_draft_atomic(p_draft_id uuid, p_user_id uuid, p_order jsonb, p_schedule jsonb DEFAULT NULL::jsonb, p_service_lines jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft     public.web_order_drafts%ROWTYPE;
  v_now       timestamptz := now();
  v_total     numeric(12,2);
  v_shipping  numeric(12,2);
  v_discount  numeric(12,2);
  v_due       timestamptz;
  v_date      date;
  v_loyalty   numeric;
  v_courier   uuid;
  v_notes     text;
  v_trade     boolean;
  v_dp        numeric(12,2);
  v_term      integer;
  v_end       date;
  v_sum       numeric(12,2);
  v_rows      integer;
  v_order_id  uuid;
  v_row       jsonb;
  v_n         integer;
  v_lines     integer;
  v_services  integer := 0;
  v_requests  integer := 0;
  v_rate      numeric;
  v_rate_date date;
  v_red       public.loyalty_redemptions%ROWTYPE;
  v_pts_value numeric(12,2) := 0;
  v_invoice   text;
  v_approve   jsonb;
  v_cod       numeric(12,2) := 0;
  v_collect   numeric(12,2);
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT public.has_permission(p_user_id, 'confirm_web_order_ready') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_draft FROM public.web_order_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_draft.status <> 'to_confirm' THEN
    RETURN jsonb_build_object('error', 'not_open', 'status', v_draft.status);
  END IF;
  IF NOT public.has_permission(p_user_id, CASE WHEN v_draft.mode = 'full' THEN 'create_cash_order' ELSE 'create_account' END) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT count(*) FILTER (WHERE hold_state = 'held'), count(*) INTO v_lines, v_n
    FROM public.web_order_draft_lines WHERE draft_id = p_draft_id;
  IF v_lines = 0 OR v_lines <> v_n THEN
    RETURN jsonb_build_object('error', 'hold_lost');
  END IF;

  p_order := coalesce(p_order, '{}'::jsonb);
  v_total    := (p_order ->> 'total_amount')::numeric;
  v_shipping := coalesce((p_order ->> 'shipping_fee')::numeric, 0);
  v_discount := coalesce((p_order ->> 'discount_amount')::numeric, 0);
  v_due      := (p_order ->> 'transfer_due_at')::timestamptz;
  v_date     := coalesce((p_order ->> 'order_date')::date, (v_now AT TIME ZONE 'Asia/Manila')::date);
  v_loyalty  := coalesce((p_order ->> 'loyalty_jpy_amount')::numeric, v_draft.subtotal_jpy);
  v_courier  := nullif(p_order ->> 'planned_shipping_method_id', '')::uuid;
  v_notes    := nullif(btrim(coalesce(p_order ->> 'notes', '')), '');
  v_trade    := coalesce((p_order ->> 'is_trade')::boolean, false);
  v_rate      := CASE WHEN v_draft.settlement_currency = 'PHP' THEN v_draft.fx_rate END;
  v_rate_date := CASE WHEN v_draft.settlement_currency = 'PHP' THEN v_draft.fx_rate_date END;

  IF v_total IS NULL OR v_total <= 0 THEN
    RETURN jsonb_build_object('error', 'total_required');
  END IF;
  IF v_shipping < 0 OR v_discount < 0 OR v_loyalty < 0 THEN
    RETURN jsonb_build_object('error', 'negative_amount');
  END IF;
  -- A deadline is moved, never removed (WEB LAYAWAY rule): Confirm starts it.
  IF coalesce(v_draft.payment_method, 'transfer') = 'cod' THEN
    v_due := NULL;
  ELSIF v_due IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
  IF jsonb_typeof(coalesce(p_service_lines, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('error', 'service_lines_invalid');
  END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) LOOP
    IF nullif(btrim(coalesce(v_row ->> 'title', '')), '') IS NULL
       OR coalesce((v_row ->> 'quantity')::numeric, 0) <= 0
       OR (v_row ->> 'quantity')::numeric <> trunc((v_row ->> 'quantity')::numeric)
       OR coalesce((v_row ->> 'unit_price_jpy')::numeric, -1) < 0
       OR coalesce((v_row ->> 'line_total_jpy')::numeric, -1) < 0 THEN
      RETURN jsonb_build_object('error', 'service_lines_invalid');
    END IF;
  END LOOP;

  -- POINTS chosen at checkout (2026-10-05, owner C3–C5): the draft's pending
  -- redemption is approved below, in this transaction. Checked first against
  -- the figures staff are confirming, so nothing is written if it cannot apply.
  v_cod := coalesce((p_order ->> 'cod_fee')::numeric, 0);
  IF coalesce(v_draft.payment_method, 'transfer') = 'cod' THEN
    IF v_draft.mode <> 'full' OR v_draft.settlement_currency <> 'JPY' THEN
      RETURN jsonb_build_object('error', 'method_full_payment_only');
    END IF;
    v_collect := v_total - v_cod - coalesce(v_draft.points_value, 0);
    IF public.cod_fee_jpy(v_collect) IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_collect <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'collected', v_collect, 'limit', public.cod_limit_jpy());
    END IF;
    IF v_cod <> public.cod_fee_jpy(v_collect) THEN
      RETURN jsonb_build_object('error', 'cod_fee_mismatch', 'cod_fee', public.cod_fee_jpy(v_collect), 'sent', v_cod);
    END IF;
  ELSIF v_cod <> 0 THEN
    RETURN jsonb_build_object('error', 'cod_fee_not_cod');
  END IF;
  IF v_draft.points_redemption_id IS NOT NULL THEN
    SELECT * INTO v_red FROM public.loyalty_redemptions WHERE id = v_draft.points_redemption_id FOR UPDATE;
    IF NOT FOUND OR v_red.status::text <> 'pending' THEN
      RETURN jsonb_build_object('error', 'points_hold_lost');
    END IF;
    v_pts_value := CASE WHEN v_draft.settlement_currency = 'PHP' THEN coalesce(v_red.value_applied_php, 0)
                        ELSE coalesce(v_red.value_applied_jpy, 0) END;
    IF v_draft.mode = 'layaway' THEN
      -- On a layaway the points pay the deposit, and may cover all of it.
      IF v_pts_value > coalesce((p_order ->> 'downpayment_amount')::numeric, 0) THEN
        RETURN jsonb_build_object('error', 'points_exceed_deposit', 'points_value', v_pts_value);
      END IF;
    ELSIF v_pts_value > v_total - v_shipping - v_cod THEN
      -- C4: never on shipping.
      RETURN jsonb_build_object('error', 'points_exceed_total', 'points_value', v_pts_value);
    END IF;
  END IF;

  IF v_draft.mode = 'layaway' THEN
    v_dp   := (p_order ->> 'downpayment_amount')::numeric;
    v_term := coalesce((p_order ->> 'payment_plan_months')::integer, v_draft.term_months);
    IF v_term IS DISTINCT FROM v_draft.term_months THEN
      RETURN jsonb_build_object('error', 'term_locked', 'term_months', v_draft.term_months);
    END IF;
    IF v_draft.agreement_version IS NULL OR v_draft.agreement_signed_at IS NULL THEN
      RETURN jsonb_build_object('error', 'agreement_missing');
    END IF;
    IF v_dp IS NULL OR v_dp <= 0 THEN
      RETURN jsonb_build_object('error', 'downpayment_required');
    END IF;
    IF jsonb_typeof(coalesce(p_schedule, 'null'::jsonb)) <> 'array' THEN
      RETURN jsonb_build_object('error', 'schedule_required');
    END IF;
    SELECT count(*), coalesce(sum((s ->> 'amount')::numeric), 0), max((s ->> 'due_date')::date)
      INTO v_rows, v_sum, v_end
      FROM jsonb_array_elements(p_schedule) s;
    IF v_rows <> v_term
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_schedule) s
                   WHERE coalesce((s ->> 'amount')::numeric, 0) <= 0 OR (s ->> 'due_date') IS NULL)
       OR (SELECT count(DISTINCT (s ->> 'installment_number')::integer) FROM jsonb_array_elements(p_schedule) s
            WHERE (s ->> 'installment_number')::integer BETWEEN 1 AND v_term) <> v_term THEN
      RETURN jsonb_build_object('error', 'schedule_invalid');
    END IF;
    IF v_dp + v_sum <> v_total THEN
      RETURN jsonb_build_object('error', 'schedule_mismatch', 'total_amount', v_total,
                                'downpayment', v_dp, 'installments', v_sum);
    END IF;
    v_end := coalesce((p_order ->> 'end_date')::date, v_end);

    INSERT INTO public.layaway_accounts (
      invoice_number, customer_id, currency, total_amount, payment_plan_months,
      order_date, end_date, status, total_paid, remaining_balance,
      downpayment_amount, loyalty_jpy_amount, shipping_fee,
      discount_amount, discount_type, discount_value,
      source_channel, web_reference, quote_id, transfer_due_at, ship_to_snapshot,
      customer_lang, fx_rate_used, fx_rate_date, notes, is_trade,
      agreement_version, agreement_acceptance_date,
      ready_confirmed_at, ready_confirmed_by, created_by_user_id, planned_shipping_method_id
    ) VALUES (
      v_draft.invoice_seq::text, v_draft.customer_id, v_draft.settlement_currency::account_currency, v_total, v_term,
      v_date, v_end, 'active', 0, v_total,
      v_dp, v_loyalty, v_shipping,
      v_discount, nullif(p_order ->> 'discount_type', ''), (p_order ->> 'discount_value')::numeric,
      'web', v_draft.web_reference, v_draft.quote_id, v_due, v_draft.ship_to_snapshot,
      v_draft.customer_lang, v_rate, v_rate_date,
      'Website layaway ' || v_draft.web_reference || coalesce(E'\n' || v_notes, ''), v_trade,
      v_draft.agreement_version, v_draft.agreement_signed_at,
      v_now, p_user_id, p_user_id, v_courier
    ) RETURNING id INTO v_order_id;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_schedule) ORDER BY (value ->> 'installment_number')::integer LOOP
      INSERT INTO public.layaway_schedule (
        account_id, installment_number, due_date, base_installment_amount,
        penalty_amount, total_due_amount, paid_amount, currency, status
      ) VALUES (
        v_order_id, (v_row ->> 'installment_number')::integer, (v_row ->> 'due_date')::date,
        (v_row ->> 'amount')::numeric, 0, (v_row ->> 'amount')::numeric, 0,
        v_draft.settlement_currency::account_currency, 'pending'
      );
    END LOOP;

    INSERT INTO public.layaway_account_items (account_id, website_product_id, variant_id, title, sku, quantity,
                                              unit_price_jpy, line_total_jpy, image_url)
    SELECT v_order_id, l.website_product_id, l.variant_id, l.title, l.sku, l.qty, l.unit_price_jpy, l.line_total_jpy, l.image_url
      FROM public.web_order_draft_lines l WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     ORDER BY l.created_at, l.id;

    INSERT INTO public.layaway_account_items (account_id, title, quantity, unit_price_jpy, line_total_jpy)
    SELECT v_order_id, btrim(s ->> 'title'), (s ->> 'quantity')::integer,
           (s ->> 'unit_price_jpy')::numeric, (s ->> 'line_total_jpy')::numeric
      FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) s;
    GET DIAGNOSTICS v_services = ROW_COUNT;
  ELSE
    INSERT INTO public.cash_orders (
      invoice_number, customer_id, currency, total_amount, total_paid,
      remaining_balance, status, source_channel, order_type, payment_method,
      payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
      gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
      discount_amount, discount_type, discount_value,
      loyalty_jpy_amount, item_description, order_date, customer_lang, notes, is_trade,
      ready_confirmed_at, ready_confirmed_by, created_by_user_id, fx_rate_used, fx_rate_date,
      planned_shipping_method_id, cod_fee
    ) VALUES (
      v_draft.invoice_seq::text, v_draft.customer_id, v_draft.settlement_currency::account_currency, v_total, 0,
      v_total, 'pending'::cash_order_status, 'web', v_draft.order_type, coalesce(v_draft.payment_method, 'transfer'),
      'pending_transfer', v_draft.ship_to_address_id, v_draft.ship_to_snapshot, v_draft.recipient_name, v_draft.recipient_phone,
      -- expires_at = transfer_due_at: the deadline the expiry cron reads.
      v_draft.gift_note, v_draft.quote_id, v_draft.web_reference, v_due, v_due, v_shipping,
      v_discount, nullif(p_order ->> 'discount_type', ''), (p_order ->> 'discount_value')::numeric,
      v_loyalty, 'Website order ' || v_draft.web_reference, v_date, v_draft.customer_lang, v_notes, v_trade,
      v_now, p_user_id, p_user_id, v_rate, v_rate_date,
      v_courier, v_cod
    ) RETURNING id INTO v_order_id;

    INSERT INTO public.cash_order_items (cash_order_id, website_product_id, variant_id, title, sku, quantity,
                                         unit_price_jpy, line_total_jpy, image_url)
    SELECT v_order_id, l.website_product_id, l.variant_id, l.title, l.sku, l.qty, l.unit_price_jpy, l.line_total_jpy, l.image_url
      FROM public.web_order_draft_lines l WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     ORDER BY l.created_at, l.id;

    INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy)
    SELECT v_order_id, btrim(s ->> 'title'), (s ->> 'quantity')::integer,
           (s ->> 'unit_price_jpy')::numeric, (s ->> 'line_total_jpy')::numeric
      FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) s;
    GET DIAGNOSTICS v_services = ROW_COUNT;
  END IF;

  -- The checkout's points, approved now (owner C5): the redemption is linked
  -- to the new order and approve_redemption_atomic writes the LOYALTY-
  -- discount, nets the loyalty basis and consumes the lots, all in this
  -- transaction. Any refusal (e.g. insufficient_points) rolls back the Confirm.
  IF v_draft.points_redemption_id IS NOT NULL THEN
    IF v_draft.mode = 'full' THEN
      SELECT invoice_number INTO v_invoice FROM public.cash_orders WHERE id = v_order_id;
    ELSE
      SELECT invoice_number INTO v_invoice FROM public.layaway_accounts WHERE id = v_order_id;
    END IF;
    UPDATE public.loyalty_redemptions
       SET cash_order_id  = CASE WHEN v_draft.mode = 'full' THEN v_order_id END,
           account_id     = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END,
           invoice_number = v_invoice
     WHERE id = v_red.id;
    v_approve := public.approve_redemption_atomic(v_red.id, p_user_id, 'Website checkout points');
  END IF;

  -- The hold becomes the order's: NO second stock movement (risk 3). From here
  -- page365_web_holds counts the order line instead of the draft line.
  UPDATE public.web_order_draft_lines
     SET hold_state = 'transferred', transferred_at = v_now
   WHERE draft_id = p_draft_id AND hold_state = 'held';

  UPDATE public.web_order_drafts
     SET status = 'confirmed', decided_at = v_now, decided_by = p_user_id, updated_at = v_now,
         cash_order_id      = CASE WHEN v_draft.mode = 'full'    THEN v_order_id END,
         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END
   WHERE id = p_draft_id;

  -- A service request filed on the draft now belongs to the order (W2-5).
  UPDATE public.service_requests
     SET cash_order_id      = CASE WHEN v_draft.mode = 'full'    THEN v_order_id ELSE cash_order_id END,
         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id ELSE layaway_account_id END,
         updated_at = v_now
   WHERE web_draft_id = p_draft_id;
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('web_order_draft', p_draft_id, 'web_draft_confirmed',
          jsonb_build_object('web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                             'mode', v_draft.mode,
                             'entity_type', CASE WHEN v_draft.mode = 'full' THEN 'cash_order' ELSE 'layaway_account' END,
                             'entity_id', v_order_id, 'currency', v_draft.settlement_currency,
                             'quoted_total', v_draft.total, 'total_amount', v_total,
                             'shipping_fee', v_shipping, 'discount_amount', v_discount,
                             'service_lines', v_services, 'service_requests_moved', v_requests,
                             'transfer_due_at', v_due, 'planned_shipping_method_id', v_courier,
                             'payment_method', v_draft.payment_method, 'points', v_draft.points,
                             'points_value', v_pts_value, 'cod_fee', v_cod),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'draft_id', p_draft_id,
                            'entity_type', CASE WHEN v_draft.mode = 'full' THEN 'cash_order' ELSE 'layaway_account' END,
                            'entity_id', v_order_id,
                            'order_id',   CASE WHEN v_draft.mode = 'full'    THEN v_order_id END,
                            'account_id', CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END,
                            'invoice_number', v_draft.invoice_seq::text, 'web_reference', v_draft.web_reference,
                            'service_lines', v_services, 'service_requests_moved', v_requests,
                            'payment_method', v_draft.payment_method, 'points', v_draft.points,
                            'points_value', v_pts_value, 'points_approval', v_approve,
                            'cod_fee', v_cod);
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
  v_refuse text := NULL;
  v_amount bigint := NULL;
  v_cur    text := upper(nullif(btrim(coalesce(p_payload -> 'amount_money' ->> 'currency', '')), ''));
BEGIN
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id FOR UPDATE;
  -- QC10 (2026-10-05): one writer per provider case at a time, including the
  -- very first insert (two first observations used to both pass the check).
  PERFORM pg_advisory_xact_lock(hashtextextended('square_dispute:' || p_dispute_id, 0));
  SELECT * INTO v_old FROM public.square_disputes WHERE square_dispute_id = p_dispute_id FOR UPDATE;
  IF v_cur IS NOT NULL AND v_cur <> 'JPY' THEN v_refuse := 'bad_currency';
  ELSIF v_old.id IS NOT NULL AND v_old.square_payment_id <> p_square_payment_id THEN v_refuse := 'parent_mismatch';
  ELSIF coalesce(p_amount_jpy, 0) > 0 AND v_cur = 'JPY'
        AND (p_payload -> 'amount_money' ->> 'amount') IS NOT DISTINCT FROM p_amount_jpy::text THEN v_amount := p_amount_jpy;
  END IF;
  IF v_refuse IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                    WHERE n.type = 'card_dispute_unrecorded' AND n.metadata ->> 'dispute_id' = p_dispute_id AND n.metadata ->> 'error' = v_refuse) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_dispute_unrecorded', 'Square dispute NOT recorded — needs a look',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · Square dispute ' || p_dispute_id || ' (' || lower(v_st) || ', '
                || coalesce(p_payload -> 'amount_money' ->> 'amount', coalesce(p_amount_jpy, 0)::text) || ' ' || coalesce(p_payload -> 'amount_money' ->> 'currency', '?')
                || ') was refused: ' || v_refuse
                || CASE v_refuse
                     WHEN 'parent_mismatch' THEN ' — this dispute id is already recorded on payment ' || v_old.square_payment_id || '.'
                     ELSE ' — not a yen dispute.' END
                || ' The Hub ledger was not changed, so this order is NOT marked as disputed: do not refund it or issue store credit on it until the dispute is checked in the Square Dashboard.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id, 'dispute_id', p_dispute_id,
                                 'state', v_st, 'error', v_refuse, 'amount_jpy', p_amount_jpy, 'test', v_sq.test));
    END IF;
    RETURN jsonb_build_object('ok', false, 'error', v_refuse);
  END IF;
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
  VALUES (p_dispute_id, v_sq.id, p_square_payment_id, v_sq.cash_order_id, v_amount, v_st, left(p_reason, 200),
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
  IF v_amount IS NULL AND v_new.amount_jpy IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                      WHERE n.type = 'card_dispute_amount_unreadable' AND n.metadata ->> 'dispute_id' = p_dispute_id) THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_dispute_amount_unreadable', 'Card dispute recorded WITHOUT its amount',
            coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · Square dispute ' || p_dispute_id || ' (' || lower(v_st) || ', amount sent: '
              || coalesce(p_payload -> 'amount_money' ->> 'amount', 'none') || ' ' || coalesce(p_payload -> 'amount_money' ->> 'currency', '?')
              || ') — the Hub could not read the disputed amount as whole yen, so it recorded the dispute with NO amount and counts the WHOLE card payment as disputed (no store credit or refund on this order while it is open). Check the amount in the Square Dashboard.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id, 'dispute_id', p_dispute_id,
                               'state', v_st, 'amount_sent', p_payload -> 'amount_money', 'amount_jpy', p_amount_jpy, 'test', v_sq.test));
  END IF;
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
-- set_account_deadlines
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_account_deadlines(p_entity_type text, p_entity_id uuid, p_transfer_due_at timestamp with time zone, p_reason text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old  jsonb;
  v_new  jsonb;
  v_status text;
  v_paid numeric;
  v_channel text;
  v_ready timestamptz;
BEGIN
  IF p_entity_type NOT IN ('layaway', 'cash_order') THEN
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;

  -- A deadline is moved, never removed (20260915140000).
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;

  IF p_entity_type = 'layaway' THEN
    SELECT status::text, total_paid,
           jsonb_build_object('transfer_due_at', transfer_due_at),
           source_channel, ready_confirmed_at
      INTO v_status, v_paid, v_old, v_channel, v_ready
      FROM public.layaway_accounts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- Live only. 'cancelled', 'completed', 'forfeited', 'final_forfeited' and
    -- 'final_settlement' are endings, not states a new deadline can reopen.
    IF v_status NOT IN ('active', 'overdue', 'extension_active', 'reactivated') THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;

    -- RESERVE-FIRST (A1): a web reservation has no deadline to move until staff
    -- confirm it ready for dispatch. Confirming is what starts the deadline.
    IF v_channel = 'web' AND v_ready IS NULL THEN
      RETURN jsonb_build_object('error', 'not_ready');
    END IF;

    -- Money received ends this deadline's job, and 'active' does not say so.
    -- Both places it can show, exactly as expire_web_layaway_atomic checks them.
    -- Points are not money; a deposit wholly covered by points counts as paid.
    IF coalesce(v_paid, 0) > 0 AND public.layaway_deposit_started(p_entity_id) THEN
      RETURN jsonb_build_object('error', 'already_paid', 'total_paid', v_paid);
    END IF;
    IF EXISTS (SELECT 1 FROM public.payments
                WHERE account_id = p_entity_id AND voided_at IS NULL
                  AND coalesce(reference_number, '') NOT LIKE 'LOYALTY-%') THEN
      RETURN jsonb_build_object('error', 'payment_exists');
    END IF;

    UPDATE public.layaway_accounts
       SET transfer_due_at = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at);
  ELSE
    SELECT status::text,
           jsonb_build_object('transfer_due_at', transfer_due_at, 'expires_at', expires_at),
           source_channel, ready_confirmed_at
      INTO v_status, v_old, v_channel, v_ready
      FROM public.cash_orders WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_status <> 'pending' THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;
    -- RESERVE-FIRST (A1): same refusal as the layaway branch.
    IF v_channel = 'web' AND v_ready IS NULL THEN
      RETURN jsonb_build_object('error', 'not_ready');
    END IF;
    -- No already_paid test here. See the header: a partially-paid pending cash
    -- order still expires, so its deadline is still live and still moveable.

    -- BOTH columns, deliberately. create_web_order_atomic writes the same value
    -- to each and the expiry cron reads expires_at; moving only transfer_due_at
    -- would show the customer a new deadline while the cron still cancelled on
    -- the old one.
    IF EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_entity_id AND payment_method = 'cod') THEN
      RETURN jsonb_build_object('error', 'cod_no_deadline');
    END IF;
    UPDATE public.cash_orders
       SET transfer_due_at = p_transfer_due_at,
           expires_at      = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at, 'expires_at', p_transfer_due_at);
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_entity_type = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END,
          p_entity_id, 'deadlines_updated', v_old,
          v_new || jsonb_build_object('reason', p_reason),
          COALESCE(p_user_id, auth.uid()));

  RETURN jsonb_build_object(
    'ok', true, 'old', v_old, 'new', v_new,
    -- Observation A: the caller is told when it has just armed the hourly job.
    'deadline_in_past', p_transfer_due_at < now());
END $function$;

-- ---------------------------------------------------------------------------
-- switch_web_payment_method_by_customer_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.switch_web_payment_method_by_customer_atomic(p_order_id uuid, p_customer_id uuid, p_method text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner    uuid;
  v_old      text;
  v_cur      text;
  v_status   text;
  v_pay      text;
  v_chan     text;
  v_lock     text;
  v_ref      text;
  v_decision text;
  v_decision_id uuid;
  v_decided_at timestamptz;
  v_base     numeric(12,2);
  v_old_fee  numeric(12,2) := 0;
  v_new_fee  integer := 0;
  v_country  text;
  v_dl       jsonb;
BEGIN
  IF p_order_id IS NULL OR p_customer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT customer_id, coalesce(payment_method, 'transfer'), currency::text, status::text, payment_status,
         source_channel, coalesce(web_reference, invoice_number)
    INTO v_owner, v_old, v_cur, v_status, v_pay, v_chan, v_ref
    FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  -- Another customer's order answers exactly like a missing one.
  IF NOT FOUND OR v_owner IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_chan IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('error', 'not_web_order');
  END IF;
  IF v_status <> 'pending' OR coalesce(v_pay, '') <> 'pending_transfer' THEN
    RETURN jsonb_build_object('error', 'not_payable');
  END IF;
  -- Owner rule 2026-10-04: while Paidy, a card hold or any other payment is in
  -- progress, nothing about how the order is paid changes.
  v_lock := public.cash_order_payment_lock(p_order_id);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_in_progress');
  END IF;
  -- C1: only after her latest DECIDED payment was rejected. Latest decision =
  -- newest by updated_at (decision time) among rejected / needs_clarification /
  -- confirmed.
  SELECT s.status::text, s.id, coalesce(s.updated_at, s.created_at)
    INTO v_decision, v_decision_id, v_decided_at
    FROM public.payment_submissions s
   WHERE s.cash_order_id = p_order_id
     AND s.status IN ('rejected', 'needs_clarification', 'confirmed')
   ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC, s.id DESC
   LIMIT 1;
  IF v_decision IS DISTINCT FROM 'rejected' THEN
    RETURN jsonb_build_object('error', 'not_rejected');
  END IF;
  -- One customer switch per rejection: a customer switch audited AFTER the
  -- deciding rejection (its updated_at, else created_at) spends it. Staff
  -- switches never count against her.
  IF EXISTS (
    SELECT 1 FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id
       AND a.action = 'payment_method_changed'
       AND a.new_value_json->>'actor' = 'customer'
       AND a.created_at > v_decided_at
  ) THEN
    RETURN jsonb_build_object('error', 'already_switched');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square', 'cod') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
  IF v_old = p_method THEN
    RETURN jsonb_build_object('error', 'unchanged', 'payment_method', v_old);
  END IF;
  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;
  IF p_method = 'square' AND NOT public.square_card_allowed(p_customer_id) THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
  END IF;

  SELECT remaining_balance - coalesce(cod_fee, 0), coalesce(cod_fee, 0),
         upper(nullif(btrim(coalesce(ship_to_snapshot ->> 'country', '')), ''))
    INTO v_base, v_old_fee, v_country FROM public.cash_orders WHERE id = p_order_id;
  IF p_method = 'cod' THEN
    IF public.cod_mode() <> 'on' OR coalesce(v_country, '') <> 'JP' THEN
      RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
    END IF;
    v_new_fee := public.cod_fee_jpy(v_base);
    IF v_new_fee IS NULL THEN
      RETURN jsonb_build_object('error', CASE WHEN v_base <= 0 THEN 'cod_nothing_to_collect' ELSE 'over_cod_limit' END,
                                'method', p_method);
    END IF;
  END IF;
  UPDATE public.cash_orders
     SET payment_method = p_method, cod_fee = v_new_fee,
         total_amount = total_amount - v_old_fee + v_new_fee,
         remaining_balance = remaining_balance - v_old_fee + v_new_fee,
         transfer_due_at = CASE WHEN p_method = 'cod' THEN NULL ELSE transfer_due_at END,
         expires_at = CASE WHEN p_method = 'cod' THEN NULL ELSE expires_at END,
         updated_at = now()
   WHERE id = p_order_id;
  IF v_old = 'cod' AND p_method <> 'cod' THEN
    v_dl := public.set_account_deadlines('cash_order', p_order_id,
              now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id, p_order_id)),
              'Customer switched from cash on delivery after a rejected payment', NULL);
    IF v_dl ? 'error' THEN
      RAISE EXCEPTION 'deadline_not_set: %', v_dl ->> 'error';
    END IF;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'payment_method_changed',
          jsonb_build_object('payment_method', v_old),
          jsonb_build_object('payment_method', p_method, 'actor', 'customer',
                             'customer_id', p_customer_id, 'reference', v_ref,
                             'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer),
          NULL);

  RETURN jsonb_build_object('ok', true, 'old_method', v_old, 'payment_method', p_method, 'reference', v_ref,
                            'decision_id', v_decision_id, 'cod_fee', v_new_fee, 'old_cod_fee', v_old_fee::integer);
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
  IF (p_outcome = 'expired' OR v_is_system)
     AND EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_order_id AND shipped_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'shipped', 'status', v_status);
  END IF;
  IF (p_outcome = 'expired' OR v_is_system)
     AND EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_order_id AND payment_method = 'cod') THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'cod_no_deadline', 'status', v_status);
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

-- ---------------------------------------------------------------------------
-- web_payment_reminder_eligible
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.web_payment_reminder_eligible(p_entity_type text, p_entity_id uuid)
 RETURNS TABLE(entity_type text, entity_id uuid, deadline timestamp with time zone, reference text, customer_id uuid, email text, is_test boolean, lang text, currency text, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH e AS (
    SELECT 'cash_order'::text AS entity_type, o.id AS entity_id, o.transfer_due_at AS deadline,
           o.ready_confirmed_at, coalesce(o.web_reference, o.invoice_number::text) AS reference,
           o.customer_id, btrim(cu.email) AS email, coalesce(cu.is_test, false) AS is_test,
           CASE WHEN o.customer_lang = 'en' THEN 'en' ELSE 'ja' END AS lang,   -- pickLang: anything but 'en' is 'ja'
           o.currency::text AS currency, o.remaining_balance AS amount
      FROM public.cash_orders o
      JOIN public.customers cu ON cu.id = o.customer_id
     WHERE (p_entity_type IS NULL OR p_entity_type = 'cash_order')
       AND (p_entity_id IS NULL OR o.id = p_entity_id)
       AND o.source_channel = 'web'
       AND o.status::text = 'pending'
       AND o.payment_status = 'pending_transfer'
       AND o.ready_confirmed_at IS NOT NULL
       AND o.transfer_due_at IS NOT NULL
       AND o.remaining_balance > 0
       AND coalesce(o.payment_method, 'transfer') <> 'cod'
       AND o.web_released_at IS NULL   -- W2-7: a part-paid web order is not chased
       AND public.cash_order_payment_lock(o.id) IS NULL   -- H10: Paidy/card money may already be held
       AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                        WHERE s.cash_order_id = o.id AND s.status::text IN ('submitted','under_review'))
    UNION ALL
    SELECT 'layaway'::text, a.id, a.transfer_due_at,
           a.ready_confirmed_at, coalesce(a.web_reference, a.invoice_number::text),
           a.customer_id, btrim(cu.email), coalesce(cu.is_test, false),
           'en'::text,                                   -- layaway emails are English only, always
           a.currency::text, a.downpayment_amount - public.layaway_points_paid(a.id)
      FROM public.layaway_accounts a
      JOIN public.customers cu ON cu.id = a.customer_id
     WHERE (p_entity_type IS NULL OR p_entity_type = 'layaway')
       AND (p_entity_id IS NULL OR a.id = p_entity_id)
       AND a.source_channel = 'web'
       AND a.status::text = 'active'
       AND a.ready_confirmed_at IS NOT NULL
       AND a.transfer_due_at IS NOT NULL
       AND NOT public.layaway_deposit_started(a.id)   -- points are not money (2026-10-05)
       AND a.downpayment_amount > 0
       AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                        WHERE s.account_id = a.id AND s.status::text IN ('submitted','under_review'))
       AND NOT EXISTS (SELECT 1 FROM public.payment_submission_allocations psa
                         JOIN public.payment_submissions s ON s.id = psa.submission_id
                        WHERE psa.account_id = a.id AND s.status::text IN ('submitted','under_review'))
  )
  SELECT e.entity_type, e.entity_id, e.deadline, e.reference, e.customer_id, e.email, e.is_test,
         e.lang, e.currency, e.amount
    FROM e
   WHERE e.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     -- the storefront test gate: a test customer only at an owner-readable address
     AND (NOT e.is_test OR lower(e.email) = 'chajewelsjapan@gmail.com' OR lower(e.email) LIKE '%@chajewelsjp.com')
     AND e.currency IN ('JPY','PHP')
     AND e.deadline > now() + interval '1 hour'
     AND e.deadline - now() <= CASE WHEN e.deadline - e.ready_confirmed_at <= interval '30 hours'
                                    THEN interval '6 hours' ELSE interval '24 hours' END
     AND NOT EXISTS (SELECT 1 FROM public.web_payment_reminders r
                      WHERE r.entity_type = e.entity_type AND r.entity_id = e.entity_id AND r.deadline = e.deadline)
     AND (SELECT count(*) FROM public.web_payment_reminders r
           WHERE r.entity_type = e.entity_type AND r.entity_id = e.entity_id) < 2
$function$;
