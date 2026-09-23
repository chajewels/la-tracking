-- ============================================================================
-- WEB ORDER GAPS — three fixes found in the 2026-09-23 Rule A investigation
--
-- Owner-approved 2026-09-23, before any Rule A (reservation-first) work.
--
--   1. INVARIANT 12 on the cash side. CLAUDE.md said cash-order expiry
--      "inherits" the freeze on automated status while a payment submission is
--      unconfirmed. It did not: auto-expire-cash-orders expired the order and
--      then AUTO-REJECTED the pending submission, and terminate_web_order_atomic
--      had no pending-submission test at all. This adds the test to
--      terminate_web_order_atomic (the edge function stops rejecting, in the
--      same PR).
--
--   2. "Revive Order" on an expired WEB cash order was three client-side
--      column writes: it did not take the stock back off sale, left
--      payment_status at 'cancelled' and did not move transfer_due_at. It is
--      now ONE RPC, revive_web_cash_order_atomic.
--
--   3. Forfeiting a web layaway never put its pieces back on sale — only expiry
--      and reactivate-web-layaway ever touched website_product_variants for a
--      plan. manual_forfeit_layaway_atomic does the status flip, the schedule
--      and (for web plans) the stock in one transaction. Because a forfeited
--      plan can be reactivated once, a trigger takes the stock BACK when a
--      forfeited web plan whose stock was released returns to a live status,
--      and refuses the reactivation if a piece has sold in the meantime.
--
-- FUNCTION RULES (CLAUDE.md "FUNCTION CHANGES START FROM LIVE"). The only
-- EXISTING function changed is terminate_web_order_atomic. Its new body is the
-- live body recorded in 20260917070200_record_live_drifted_functions.sql with
-- ONE block inserted (marked INVARIANT 12). Section 0 refuses to run unless live
-- still md5-matches that recorded body, and section 1b refuses to finish unless
-- the replaced function md5-matches the predicted result — so this file either
-- lands exactly the intended change on exactly the expected body, or aborts and
-- changes nothing. Everything else here is new.
--
--   terminate_web_order_atomic  live md5 (pg_get_functiondef), captured 2026-09-17:
--     before 7a93ec09925ee1b76aed21d1c0a8fea9   (11639 chars)
--     after  115d73a4c1dcc943c312171c67ac301b   (12279 chars)
-- ============================================================================

-- ---------------------------------------------------------------- 0. guard
DO $guard$
DECLARE
  v_expected CONSTANT text := '7a93ec09925ee1b76aed21d1c0a8fea9';
  v_def text;
BEGIN
  v_def := pg_get_functiondef(
    'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure);
  IF md5(v_def) <> v_expected THEN
    RAISE EXCEPTION
      'STOP — terminate_web_order_atomic has changed since 2026-09-17. Expected md5 %, live is % (% chars). Nothing was modified. Re-capture the live body and re-derive this migration.',
      v_expected, md5(v_def), length(v_def);
  END IF;
END
$guard$;

-- ------------------------------ 1. terminate_web_order_atomic + INVARIANT 12
-- Automated termination (outcome 'expired', or p_source 'system' /
-- 'shopify_webhook') now refuses with reason 'submission_pending' while the
-- order carries a payment_submissions row in 'submitted' or 'under_review'.
-- Staff cancels are unaffected, as INVARIANT 12 requires.
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
          AND status IN ('submitted','under_review')) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'submission_pending',
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

-- ------------------------------------------------ 1b. prove what landed
DO $proof$
DECLARE
  v_expected CONSTANT text := '115d73a4c1dcc943c312171c67ac301b';
  v_def text;
BEGIN
  v_def := pg_get_functiondef(
    'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure);
  IF md5(v_def) <> v_expected THEN
    RAISE EXCEPTION
      'STOP — terminate_web_order_atomic did not land as predicted. Expected md5 %, got % (% chars). The migration is rolled back.',
      v_expected, md5(v_def), length(v_def);
  END IF;
END
$proof$;

-- ============================================ 2. revive an expired web order
-- Staff bring an EXPIRED web cash order back. Mirrors
-- reactivate_web_layaway_atomic, with the deadline taken from the SAME rule
-- the order was created under (web_deposit_deadline_hours: 24h first order,
-- 72h returning) rather than typed by staff — owner decision 2026-09-23.
--
-- The deadline is computed BEFORE the status flip, while this order is still
-- 'expired': web_deposit_deadline_hours counts a customer's orders that are
-- not cancelled/expired, so computing it after would count the order itself
-- and every revival would get 72h.
--
-- Refusals, in order: reason_required, not_web_order, not_expired,
-- already_paid / payment_exists (an expired web order has received nothing by
-- construction — terminate_web_order_atomic refuses to expire one that has),
-- out_of_stock (expiry put the pieces back on sale and one may have sold; the
-- lines are named and NOTHING is written).
--
-- Lines whose variant_id is NULL (the variant was deleted, ON DELETE SET NULL)
-- cannot be held and are reported as unheld_lines rather than refused —
-- terminate_web_order_atomic restores only matched lines, so there is nothing
-- of theirs to take back.
CREATE OR REPLACE FUNCTION public.revive_web_cash_order_atomic(
  p_order_id   uuid,
  p_reason     text,
  p_user_id    uuid DEFAULT NULL::uuid,
  p_user_email text DEFAULT NULL::text,
  p_source     text DEFAULT 'staff'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status      text;
  v_customer_id uuid;
  v_invoice     text;
  v_web_ref     text;
  v_paid        numeric;
  v_old_due     timestamptz;
  v_old_expires timestamptz;
  v_expired_at  timestamptz;
  v_old_reason  text;
  v_old_pstatus text;
  v_hours       integer;
  v_due         timestamptz;
  v_short       jsonb;
  v_lines       integer := 0;
  v_unheld      integer := 0;
  v_taken       integer := 0;
  v_flipped     integer := 0;
  v_reason      text := btrim(coalesce(p_reason, ''));
  v_now         timestamptz := now();
BEGIN
  IF v_reason = '' THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;

  SELECT status::text, customer_id, invoice_number, web_reference, total_paid,
         transfer_due_at, expires_at, expired_at, cancellation_reason, payment_status
    INTO v_status, v_customer_id, v_invoice, v_web_ref, v_paid,
         v_old_due, v_old_expires, v_expired_at, v_old_reason, v_old_pstatus
    FROM public.cash_orders
   WHERE id = p_order_id AND source_channel = 'web'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_web_order');
  END IF;

  IF v_status <> 'expired' THEN
    RETURN jsonb_build_object('error', 'not_expired', 'status', v_status);
  END IF;

  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'already_paid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_payments
              WHERE cash_order_id = p_order_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'payment_exists');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'variant_id', i.variant_id, 'title', i.title, 'sku', i.sku,
           'wanted', i.quantity, 'available', coalesce(v.stock_qty, 0)))
    INTO v_short
    FROM public.cash_order_items i
    JOIN public.website_product_variants v ON v.id = i.variant_id
   WHERE i.cash_order_id = p_order_id
     AND v.stock_qty < i.quantity;
  IF v_short IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'out_of_stock', 'lines', v_short);
  END IF;

  SELECT count(*) FILTER (WHERE variant_id IS NOT NULL),
         count(*) FILTER (WHERE variant_id IS NULL)
    INTO v_lines, v_unheld
    FROM public.cash_order_items WHERE cash_order_id = p_order_id;

  -- The rule the order was placed under, measured while it is still expired.
  v_hours := public.web_deposit_deadline_hours(v_customer_id);
  v_due   := v_now + make_interval(hours => v_hours);

  WITH taken AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty - i.quantity, updated_at = v_now
      FROM public.cash_order_items i
     WHERE i.cash_order_id = p_order_id AND v.id = i.variant_id
       AND v.stock_qty >= i.quantity
     RETURNING v.id
  )
  SELECT count(*) INTO v_taken FROM taken;

  IF v_taken <> v_lines THEN
    RAISE EXCEPTION 'revive_web_cash_order: took % of % lines — a piece sold during the revival; nothing applied', v_taken, v_lines
      USING ERRCODE = 'P0001';
  END IF;

  -- payment_status is set explicitly: sync_web_order_payment_status only acts
  -- on arrival at completed / cancelled / expired, never on a return to pending.
  UPDATE public.cash_orders
     SET status              = 'pending'::cash_order_status,
         payment_status      = 'pending_transfer',
         expired_at          = NULL,
         cancellation_reason = NULL,
         transfer_due_at     = v_due,
         expires_at          = v_due,
         updated_at          = v_now
   WHERE id = p_order_id AND status = 'expired';
  GET DIAGNOSTICS v_flipped = ROW_COUNT;
  IF v_flipped = 0 THEN
    RAISE EXCEPTION 'revive_web_cash_order: status flip failed for %', p_order_id USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.account_notes (cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (p_order_id,
          'Web order revived — new transfer deadline '
          || to_char(v_due AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') || ' PHT ('
          || v_hours || 'h rule) — stock re-held on ' || v_taken || ' line(s) — ' || v_reason,
          p_user_id, COALESCE(p_user_email, 'System'));

  INSERT INTO public.audit_logs (entity_type, entity_id, action,
                                 old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'web_order_revived',
          jsonb_build_object('status', 'expired', 'payment_status', v_old_pstatus,
                             'expired_at', v_expired_at, 'transfer_due_at', v_old_due,
                             'expires_at', v_old_expires, 'cancellation_reason', v_old_reason),
          jsonb_build_object('status', 'pending', 'payment_status', 'pending_transfer',
                             'transfer_due_at', v_due, 'expires_at', v_due,
                             'deadline_hours', v_hours,
                             'invoice_number', v_invoice, 'web_reference', v_web_ref,
                             'stock_lines_taken', v_taken, 'unheld_lines', v_unheld,
                             'reason', v_reason, 'source', p_source,
                             'actor', COALESCE(p_user_email, p_source)),
          coalesce(p_user_id, auth.uid()));

  RETURN jsonb_build_object('ok', true,
                            'web_reference', v_web_ref,
                            'invoice_number', v_invoice,
                            'transfer_due_at', v_due,
                            'deadline_hours', v_hours,
                            'stock_lines_taken', v_taken,
                            'unheld_lines', v_unheld);
END $function$;

COMMENT ON FUNCTION public.revive_web_cash_order_atomic(uuid, text, uuid, text, text) IS
  'Brings an EXPIRED web cash order back to pending in one transaction: re-takes its stock (refuses out_of_stock naming the lines), resets payment_status to pending_transfer, sets transfer_due_at = expires_at from web_deposit_deadline_hours (24h first order / 72h returning, measured before the flip), writes account_notes + audit_logs web_order_revived. Called by the revive-web-cash-order edge function (edit_account).';

REVOKE ALL ON FUNCTION public.revive_web_cash_order_atomic(uuid, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revive_web_cash_order_atomic(uuid, text, uuid, text, text) TO service_role;

-- ======================================= 3. forfeit, with the stock for web
-- Marker: when a forfeit puts a web plan's pieces back on sale it stamps this,
-- so the plan knows its stock is no longer held. Cleared by the trigger in
-- section 5 when the stock is taken back. NULL on every plan that still holds
-- its stock — including web plans forfeited by auto-forfeit-settlement, which
-- this migration deliberately does not change (owner scope: staff forfeits).
ALTER TABLE public.layaway_accounts
  ADD COLUMN IF NOT EXISTS stock_released_at timestamptz;

COMMENT ON COLUMN public.layaway_accounts.stock_released_at IS
  'Set when a staff forfeit (manual_forfeit_layaway_atomic) returned a WEB layaway''s pieces to website_product_variants. While set, the plan holds no stock. trg_rehold_released_web_layaway_stock takes the stock back and clears it if the plan returns to a live status (e.g. one-time reactivation), refusing if a piece has sold. Expiry does not use this column — an expired web plan is identified by expired_at.';

-- The manual-forfeit edge function used to do these writes as three separate
-- PostgREST calls (account, schedule, audit). They are now one transaction, and
-- for a web plan the stock goes back in the same transaction — the status flip
-- is the guard that makes it happen exactly once. The account-level effects
-- are otherwise identical: status 'forfeited', forfeited_at, every non-paid
-- schedule row 'cancelled', one audit_logs 'manual_forfeit' row carrying the
-- same keys as before plus the new ones.
CREATE OR REPLACE FUNCTION public.manual_forfeit_layaway_atomic(
  p_account_id uuid,
  p_user_id    uuid DEFAULT NULL::uuid,
  p_source     text DEFAULT 'staff'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status   text;
  v_channel  text;
  v_invoice  text;
  v_web_ref  text;
  v_is_web   boolean;
  v_flipped  integer := 0;
  v_sched    integer := 0;
  v_restored integer := 0;
  v_now      timestamptz := now();
BEGIN
  SELECT status::text, source_channel, invoice_number, web_reference
    INTO v_status, v_channel, v_invoice, v_web_ref
    FROM public.layaway_accounts
   WHERE id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_status IN ('forfeited', 'final_forfeited', 'completed', 'cancelled') THEN
    RETURN jsonb_build_object('error', 'not_forfeitable', 'status', v_status);
  END IF;

  v_is_web := (v_channel = 'web');

  UPDATE public.layaway_accounts
     SET status            = 'forfeited'::account_status,
         forfeited_at      = v_now,
         updated_at        = v_now,
         stock_released_at = CASE WHEN v_is_web THEN v_now ELSE stock_released_at END
   WHERE id = p_account_id
     AND status NOT IN ('forfeited', 'final_forfeited', 'completed', 'cancelled');
  GET DIAGNOSTICS v_flipped = ROW_COUNT;
  IF v_flipped = 0 THEN
    RAISE EXCEPTION 'manual_forfeit: status flip failed for %', p_account_id USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.layaway_schedule
     SET status = 'cancelled', updated_at = v_now
   WHERE account_id = p_account_id AND status <> 'paid';
  GET DIAGNOSTICS v_sched = ROW_COUNT;

  -- Stock back on sale — once, because the flip above ran once.
  IF v_is_web THEN
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND i.variant_id = v.id;
    GET DIAGNOSTICS v_restored = ROW_COUNT;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('layaway_account', p_account_id, 'manual_forfeit', coalesce(p_user_id, auth.uid()),
          jsonb_build_object('invoice_number', v_invoice,
                             'previous_status', v_status,
                             'forfeited_at', v_now,
                             'source_channel', v_channel,
                             'web_reference', v_web_ref,
                             'schedule_rows_cancelled', v_sched,
                             'stock_lines_restored', v_restored,
                             'source', p_source));

  RETURN jsonb_build_object('ok', true,
                            'invoice_number', v_invoice,
                            'web_reference', v_web_ref,
                            'is_web', v_is_web,
                            'previous_status', v_status,
                            'forfeited_at', v_now,
                            'schedule_rows_cancelled', v_sched,
                            'stock_lines_restored', v_restored);
END $function$;

COMMENT ON FUNCTION public.manual_forfeit_layaway_atomic(uuid, uuid, text) IS
  'Staff forfeit of a layaway in one transaction: status forfeited + forfeited_at, non-paid schedule rows cancelled, and for a WEB plan the pieces returned to website_product_variants with stock_released_at stamped; one audit_logs manual_forfeit row. Called by the manual-forfeit edge function (forfeit_account), which then sends the customer email, the staff bell and the loyalty revoke.';

REVOKE ALL ON FUNCTION public.manual_forfeit_layaway_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manual_forfeit_layaway_atomic(uuid, uuid, text) TO service_role;

-- ================== 4. a forfeited web plan that comes back takes its stock back
-- reactivate-account (forfeited -> extension_active, one-time) is a LOCKED
-- function and is deliberately not edited here. This trigger makes it correct
-- anyway, for that caller and for any other writer: when a web plan whose stock
-- was released returns to a live status, the stock is taken back in the SAME
-- statement as the status change. If a piece has sold meanwhile it RAISES, the
-- status change fails, and the plan stays forfeited — the caller surfaces the
-- message. It never holds a piece the shelf says is sold, and never leaves a
-- live plan whose piece is on sale.
CREATE OR REPLACE FUNCTION public.rehold_released_web_layaway_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_short jsonb;
  v_lines integer := 0;
  v_taken integer := 0;
  v_now   timestamptz := now();
BEGIN
  IF NEW.source_channel IS DISTINCT FROM 'web'
     OR OLD.stock_released_at IS NULL
     OR NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW.status::text NOT IN ('active', 'overdue', 'extension_active', 'reactivated', 'final_settlement') THEN
    RETURN NEW;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'variant_id', i.variant_id, 'title', i.title, 'sku', i.sku,
           'wanted', i.quantity, 'available', coalesce(v.stock_qty, 0)))
    INTO v_short
    FROM public.layaway_account_items i
    LEFT JOIN public.website_product_variants v ON v.id = i.variant_id
   WHERE i.account_id = NEW.id
     AND (v.id IS NULL OR v.stock_qty < i.quantity);
  IF v_short IS NOT NULL THEN
    RAISE EXCEPTION 'web_layaway_stock_unavailable: % — a piece released at forfeiture is no longer in stock: %',
      coalesce(NEW.web_reference, NEW.invoice_number), v_short
      USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_lines FROM public.layaway_account_items WHERE account_id = NEW.id;

  WITH taken AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty - i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = NEW.id AND v.id = i.variant_id
       AND v.stock_qty >= i.quantity
     RETURNING v.id
  )
  SELECT count(*) INTO v_taken FROM taken;

  IF v_taken <> v_lines THEN
    RAISE EXCEPTION 'web_layaway_stock_unavailable: % — took % of % lines; nothing applied',
      coalesce(NEW.web_reference, NEW.invoice_number), v_taken, v_lines
      USING ERRCODE = 'P0001';
  END IF;

  NEW.stock_released_at := NULL;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id,
                                 old_value_json, new_value_json)
  VALUES ('layaway_account', NEW.id, 'web_layaway_stock_reheld', auth.uid(),
          jsonb_build_object('status', OLD.status, 'stock_released_at', OLD.stock_released_at),
          jsonb_build_object('status', NEW.status, 'invoice_number', NEW.invoice_number,
                             'web_reference', NEW.web_reference, 'stock_lines_taken', v_taken));

  RETURN NEW;
END $function$;

REVOKE EXECUTE ON FUNCTION public.rehold_released_web_layaway_stock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_rehold_released_web_layaway_stock ON public.layaway_accounts;
CREATE TRIGGER trg_rehold_released_web_layaway_stock
  BEFORE UPDATE OF status ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.rehold_released_web_layaway_stock();

-- ============================================================================
-- VERIFY (read-only). Expect: terminate_md5 = 115d73a4c1dcc943c312171c67ac301b,
-- the three new functions present, the column and trigger present.
--
-- SELECT md5(pg_get_functiondef('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure)) AS terminate_md5,
--        to_regprocedure('public.revive_web_cash_order_atomic(uuid,text,uuid,text,text)') IS NOT NULL AS revive_ok,
--        to_regprocedure('public.manual_forfeit_layaway_atomic(uuid,uuid,text)') IS NOT NULL AS forfeit_ok,
--        to_regprocedure('public.rehold_released_web_layaway_stock()') IS NOT NULL AS rehold_ok,
--        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
--                  AND table_name='layaway_accounts' AND column_name='stock_released_at') AS column_ok,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_rehold_released_web_layaway_stock') AS trigger_ok;
-- ============================================================================
