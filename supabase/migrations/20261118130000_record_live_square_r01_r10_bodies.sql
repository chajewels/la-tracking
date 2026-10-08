-- Record-only (2026-10-08). Already applied on live — replaying is a no-op.
--
-- Why: 20261118120000_square_r01_r10_closeout changed these four functions with
-- md5-guarded IN-PLACE patches (pg_temp.cj_patch, Bug #280). The drift audit
-- reads only CREATE FUNCTION statements, so the repo's newest copy of each was
-- the PRE-patch body. This file records the bodies exactly as live runs them
-- after the Lovable apply of 2026-10-08 05:33Z (md5(prosrc) read from live,
-- equal to the bodies below). One comment line in terminate_web_order_atomic
-- carries straight quotes where the migration file had typographic ones
-- (Lovable re-typed the patch); the logic is identical and THIS file is live.
--
--   cancel_cash_order_atomic(p_cash_order_id uuid, p_reason text  87e305b572505f06ac7ea6c7ed4cc9ad
--   note_square_attempt_stuck(p_attempt_id uuid)                  c2de1fc78a1048d2360571d1e017e425
--   record_square_refund(p_refund_id text, p_square_payment_id t  7c9f0c0843220a9b6865ef8fd6b5f2fd
--   terminate_web_order_atomic(p_order_id uuid, p_outcome text,   50208fc8ebc0f679f7f9a359de638ba3
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

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
  v_order_date date; v_shopify_id text; v_split jsonb;
  v_card_refunded boolean := false;
BEGIN
  v_is_system := (p_source = 'shopify_webhook');
  IF NOT p_preview AND NOT v_is_system AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF NOT p_preview AND v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE='P0001';
  END IF;
  SELECT status::text, currency, customer_id, invoice_number, order_date, shopify_order_id
    INTO v_status, v_currency, v_customer_id, v_invoice, v_order_date, v_shopify_id
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
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, now());
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
  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'invoice_number', v_invoice, 'status', v_status,
      'card_refunded', v_card_refunded,
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
$function$

;

-- ---------------------------------------------------------------------------
-- note_square_attempt_stuck
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.note_square_attempt_stuck(p_attempt_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.square_card_attempts%ROWTYPE;
  v_ref text; v_inv text; v_cust uuid;
BEGIN
  -- S01 (2026-10-08): square-reconcile calls this once per run in which the
  -- attempt is still open after its give-up time and could not be settled
  -- (Square's payment list could not be read to the end, or the payment it
  -- found is still processing). The third such run rings one bell; the
  -- attempt itself is never closed here (an incomplete search proves nothing).
  UPDATE public.square_card_attempts
     SET stuck_runs = stuck_runs + 1, updated_at = now()   -- R02: fair ordering for the next run
   WHERE id = p_attempt_id AND status IN ('reserved','unknown','cancelling')
  RETURNING * INTO v;
  IF v.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open');
  END IF;
  IF v.stuck_runs >= 3 AND v.stuck_warned_at IS NULL THEN
    SELECT coalesce(o.web_reference, o.invoice_number, ''), o.invoice_number, o.customer_id
      INTO v_ref, v_inv, v_cust FROM public.cash_orders o WHERE o.id = v.cash_order_id;
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('card_attempt_stuck', 'Card payment check could not finish',
            v_ref || ' · ¥' || to_char(v.amount_jpy, 'FM999,999,999') || ' — the hourly check could not settle card attempt '
              || v.reference || ' after ' || v.stuck_runs || ' tries (Square''s payment list could not be read to the end, or the payment is still processing). Look for this reference in the Square Dashboard (Transactions).',
            v_cust, v_inv,
            jsonb_build_object('cash_order_id', v.cash_order_id, 'attempt_id', v.id, 'reference', v.reference,
                               'environment', v.environment, 'stuck_runs', v.stuck_runs));
    UPDATE public.square_card_attempts SET stuck_warned_at = now() WHERE id = v.id;
    RETURN jsonb_build_object('ok', true, 'stuck_runs', v.stuck_runs, 'bell', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'stuck_runs', v.stuck_runs, 'bell', false);
END
$function$

;

-- ---------------------------------------------------------------------------
-- record_square_refund
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_square_refund(p_refund_id text, p_square_payment_id text, p_status text, p_amount_jpy bigint, p_reason text, p_provider_created_at timestamp with time zone, p_provider_updated_at timestamp with time zone, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sq    public.square_payments%ROWTYPE;
  v_order public.cash_orders%ROWTYPE;
  v_old   public.square_refunds%ROWTYPE;
  v_new   public.square_refunds%ROWTYPE;
  v_st    text := upper(coalesce(p_status, 'PENDING'));
BEGIN
  -- Locked: a recording (finalize) and this refund serialise on the payment (review #4).
  -- R05 race (2026-10-08): the ORDER is locked first (order → payment, as in
  -- finalize), so a cancel-with-store-credit in flight and this refund never
  -- overlap: whichever commits second sees the other's row.
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id;
  IF v_sq.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id FOR UPDATE;
  SELECT * INTO v_sq FROM public.square_payments WHERE square_payment_id = p_square_payment_id FOR UPDATE;
  -- QC10 (2026-10-05): one writer per provider case at a time, including the
  -- very first insert (two first observations used to both pass the check).
  PERFORM pg_advisory_xact_lock(hashtextextended('square_refund:' || p_refund_id, 0));
  SELECT * INTO v_old FROM public.square_refunds WHERE square_refund_id = p_refund_id FOR UPDATE;
  IF v_old.id IS NOT NULL AND p_provider_updated_at IS NOT NULL AND v_old.provider_updated_at IS NOT NULL
     AND p_provider_updated_at < v_old.provider_updated_at THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- A terminal provider state never goes back to an open one (QC10).
  IF v_old.id IS NOT NULL AND v_old.status IN ('COMPLETED','FAILED','REJECTED') AND v_st NOT IN ('COMPLETED','FAILED','REJECTED') THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true, 'terminal', v_old.status);
  END IF;
  INSERT INTO public.square_refunds (square_refund_id, square_payment_row, square_payment_id, cash_order_id,
         amount_jpy, status, reason, provider_created_at, provider_updated_at, last_payload)
  VALUES (p_refund_id, v_sq.id, p_square_payment_id, v_sq.cash_order_id, greatest(coalesce(p_amount_jpy, 0), 0),
          v_st, left(p_reason, 500), p_provider_created_at, p_provider_updated_at, p_payload)
  ON CONFLICT (square_refund_id) DO UPDATE
     SET status = EXCLUDED.status, amount_jpy = EXCLUDED.amount_jpy, reason = coalesce(EXCLUDED.reason, square_refunds.reason),
         provider_updated_at = coalesce(EXCLUDED.provider_updated_at, square_refunds.provider_updated_at),
         last_payload = EXCLUDED.last_payload, updated_at = now()
   WHERE square_refunds.provider_updated_at IS NULL OR EXCLUDED.provider_updated_at IS NULL
      OR EXCLUDED.provider_updated_at >= square_refunds.provider_updated_at
  RETURNING * INTO v_new;
  IF v_new.id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'stale', true);
  END IF;
  -- QC01: a refund (not failed) on captured card money the Hub has not
  -- recorded is flagged, so it is never recorded in full by mistake.
  IF v_st NOT IN ('FAILED','REJECTED') AND v_sq.status = 'captured' AND v_sq.cash_payment_id IS NULL THEN
    UPDATE public.square_payments
       SET exception = 'refunded_before_record', exception_at = now(),
           exception_note = 'Square refund ' || p_refund_id || ' (' || v_st || ') on a capture the Hub has not recorded',
           updated_at = now()
     WHERE id = v_sq.id AND status = 'captured' AND cash_payment_id IS NULL
       AND exception_resolved_at IS NULL AND exception IS DISTINCT FROM 'refunded_before_record';
  END IF;
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
    -- R05 (2026-10-08): the order already holds a cancellation store-credit
    -- lot — the same money is now going back twice. One bell per refund.
    IF v_st NOT IN ('FAILED','REJECTED') AND EXISTS (
         SELECT 1 FROM public.store_credit_lots l
          WHERE l.source_cash_order_id = v_sq.cash_order_id AND l.source_type = 'cancelled_cash' AND l.status <> 'voided')
       AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                        WHERE n.type = 'card_refund_after_credit' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_refund_after_credit', 'Card refund on an order that already has store credit',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · ¥' || to_char(v_new.amount_jpy, 'FM999,999,999')
                || ' refunded in Square (' || lower(v_st) || ') but this order was cancelled with STORE CREDIT. The customer is being paid back twice: void the store-credit lot (Settings → Store Credit) or reverse the Square refund.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'refund_id', p_refund_id, 'status', v_st, 'test', v_sq.test));
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.status IS DISTINCT FROM v_new.status,
                            'refund', to_jsonb(v_new));
END
$function$

;

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
  v_order_date date; v_split jsonb := NULL; v_card_paid boolean := false;
  v_card_refunded boolean := false;
  v_points_to_revoke numeric := 0; v_spend_to_reverse numeric := 0;
  v_reason text; v_is_system boolean; v_stock_lines integer := 0; v_restored integer := 0;
  v_flipped integer := 0; v_now timestamptz := now();
BEGIN
  IF p_outcome NOT IN ('expired','cancelled') THEN
    RAISE EXCEPTION 'bad_outcome: %', p_outcome USING ERRCODE='P0001';
  END IF;
  v_is_system := (p_source IN ('system','shopify_webhook'));

  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid, order_date
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid, v_order_date
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
    -- Cancellation credit rule (owner 2026-10-06/08): same day as order_date →
    -- 100 %; later → 30 % of the money paid kept, 70 % credit. No override.
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now);
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
      'store_credit_if_chosen', GREATEST(0, COALESCE((v_split ->> 'credit')::numeric, 0) - v_partial_credit),
      'cancellation_rule', v_split ->> 'rule',
      'cancellation_charge', COALESCE((v_split ->> 'kept')::numeric, 0),
      'cancellation_split', v_split,
      'paid_by_card', v_card_paid,
      'card_refunded', v_card_refunded,
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
$function$

;
