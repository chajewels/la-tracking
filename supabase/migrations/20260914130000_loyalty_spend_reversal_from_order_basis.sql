-- Loyalty: separate the SPEND reversal from the POINTS reversal.
--
-- Points and spend are different quantities and were being reversed from the
-- same source. revoke_loyalty_points derived BOTH from the surviving
-- loyalty_point_lots, so:
--
--   Case A  no live lots  -> it returned NULL before writing anything. No
--           ledger row, no spend deducted, no tier re-check. The order was
--           cancelled and its spend counted towards the tier forever.
--   Case B  lots partly consumed/expired -> only the surviving lots' spend
--           basis came back, so spend under-reversed in proportion to how
--           many points the customer had already used.
--
-- The fallback that would have rescued case A required BOTH p_spend_jpy > 0
-- AND p_trigger_event IN ('manual_forfeit','auto_forfeit','final_forfeit').
-- terminate_web_order_atomic and delete_cash_order_atomic pass
-- p_spend_jpy => 0 with 'cancel' / 'delete_account', so both halves were off.
--
-- The separation:
--   POINTS  stay lot-derived. You can only take back points that still exist.
--   SPEND   comes from the order's own loyalty basis, independent of lots.
--           Spend happened; redeeming the points later does not un-happen it.
--
-- See docs/FIXED-BUGS.md Bug #271.

-- ---------------------------------------------------------------------------
-- 1. The authoritative spend basis for one order.
-- ---------------------------------------------------------------------------
-- WHY THE LEDGER AND NOT cash_orders/layaway_accounts.loyalty_jpy_amount:
--
--   a. loyalty_jpy_amount is MUTABLE after the award. The net-spend rule
--      (2026-05-26) has approve_redemption_atomic reduce it when a redemption
--      is approved and void_redemption_atomic restore it. edit-account can
--      change it too. Its value at cancellation time is not necessarily the
--      value that was added to cumulative_spend_jpy.
--   b. loyalty_transactions is append-only (trg_loyalty_transactions_immutable,
--      BEFORE DELETE OR UPDATE). The 'earned' row records exactly what
--      award-loyalty-points added to the counter, and cannot drift afterwards.
--   c. The delete paths need the basis while deleting the order row. Reading
--      the ledger is ordering-independent; reading the order is not.
--
-- Verified against live data 2026-09-14: for every surviving order with an
-- earned row, ledger net == the order's current loyalty_jpy_amount (the only
-- two exceptions are Test Customer rows whose orders were deleted). The two
-- agree today; only the ledger is guaranteed to keep agreeing.
--
-- p_spend_jpy is deliberately NOT consulted. Every caller passes total_paid
-- converted to JPY -- money received, not the loyalty basis. For Angelyn
-- Mijares (19443) that would have been ~JPY 164,440 against a real basis of
-- JPY 1,138,540. It was only ever right by accident, when live lots happened
-- to win the branch.
--
-- 'adjusted' rows are excluded on purpose. They are manual corrections with no
-- consistent sign convention (CJ-2026-01504's 2026-08-26 rows record a
-- DEDUCTION as a positive spend_amount_jpy). loyalty_integrity_report applies
-- its own convention to them at member level; per-order reversal must not.
CREATE OR REPLACE FUNCTION public.loyalty_order_spend_basis(
  p_member_id uuid,
  p_reference text
) RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT GREATEST(0, COALESCE(SUM(
           CASE WHEN t.transaction_type = 'earned'  THEN  COALESCE(t.spend_amount_jpy, 0)
                WHEN t.transaction_type = 'revoked' THEN -COALESCE(t.spend_amount_jpy, 0)
                ELSE 0 END), 0))
    FROM public.loyalty_transactions t
   WHERE t.member_id = p_member_id
     AND t.invoice_number = p_reference
     AND t.transaction_type IN ('earned', 'revoked');
$function$;

COMMENT ON FUNCTION public.loyalty_order_spend_basis(uuid, text) IS
  'Net JPY spend one order has contributed to loyalty_members.cumulative_spend_jpy: SUM(earned) - SUM(revoked) over its ledger rows, floored at 0. This is the ONLY authoritative spend basis for a reversal. Reaches 0 once fully reversed, which is what makes revoke_loyalty_points idempotent.';

-- ---------------------------------------------------------------------------
-- 2. revoke_loyalty_points -- points from lots, spend from the order basis.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_loyalty_points(
  p_member_id uuid,
  p_source_reference text,
  p_spend_jpy numeric,
  p_account_id uuid DEFAULT NULL::uuid,
  p_cash_order_id uuid DEFAULT NULL::uuid,
  p_payment_id uuid DEFAULT NULL::uuid,
  p_invoice_number text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text,
  p_created_by_user_id uuid DEFAULT NULL::uuid,
  p_trigger_event text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id UUID;
  v_existing_tx UUID;
  v_total_remaining NUMERIC := 0;
  v_total_original NUMERIC := 0;
  v_spend_basis NUMERIC := 0;
  v_lot_count INTEGER := 0;
  v_ledger_ref TEXT;
  v_member RECORD;
  v_current_tier_name TEXT;
  v_new_cumulative NUMERIC;
  v_new_tier_id UUID;
BEGIN
  -- The ledger keys on invoice_number; the lots key on source_reference.
  -- award-loyalty-points writes the same string to both, but callers pass them
  -- as separate arguments, so resolve explicitly rather than assuming.
  v_ledger_ref := COALESCE(p_invoice_number, p_source_reference);

  SELECT m.*, t.name AS tier_name INTO v_member
  FROM loyalty_members m LEFT JOIN loyalty_tiers t ON t.id = m.current_tier_id
  WHERE m.id = p_member_id FOR UPDATE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'revoke: member % not found', p_member_id; END IF;
  v_current_tier_name := v_member.tier_name;

  -- POINTS: only what still exists.
  SELECT COALESCE(SUM(remaining_amount), 0), COALESCE(SUM(original_amount), 0), COUNT(*)
    INTO v_total_remaining, v_total_original, v_lot_count
  FROM loyalty_point_lots
  WHERE member_id = p_member_id AND source_reference = p_source_reference
    AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;

  -- SPEND: what this order actually put on the counter, lots or no lots.
  v_spend_basis := public.loyalty_order_spend_basis(p_member_id, v_ledger_ref);

  -- IDEMPOTENCY. Not GREATEST(0, ...) -- that is a floor, it still deducts on
  -- every call until it hits the floor. The guard is that both quantities are
  -- self-cancelling: a successful revoke writes a ledger row carrying
  -- spend_amount_jpy = v_spend_basis, so the next call's basis is 0; and it
  -- stamps revoked_at on the lots, so the next call's lot sum is 0. When both
  -- are 0 there is nothing left to take back -- return the earlier revoke row
  -- (for the caller's audit trail) and write nothing. This covers cancel twice,
  -- delete after cancel, and the edge function and the RPC both calling in.
  IF v_total_remaining = 0 AND v_spend_basis = 0 THEN
    SELECT id INTO v_existing_tx FROM loyalty_transactions
     WHERE member_id = p_member_id
       AND transaction_type = 'revoked'
       AND (invoice_number = v_ledger_ref
            OR (p_cash_order_id IS NOT NULL AND cash_order_id = p_cash_order_id)
            OR (p_payment_id IS NOT NULL AND payment_id = p_payment_id))
     ORDER BY created_at DESC LIMIT 1;
    RETURN v_existing_tx;
  END IF;

  INSERT INTO loyalty_transactions (
    member_id, account_id, cash_order_id, payment_id, transaction_type, points_amount, spend_amount_jpy,
    invoice_number, tier_at_time, notes, created_by_user_id
  ) VALUES (
    p_member_id, p_account_id, p_cash_order_id, p_payment_id, 'revoked', -v_total_remaining, v_spend_basis,
    p_invoice_number, v_current_tier_name,
    COALESCE(p_notes, 'Revoked: ' || p_source_reference)
      || CASE WHEN v_lot_count = 0 AND v_spend_basis > 0
              THEN ' — points already spent or expired; lifetime spend reversed in full'
              ELSE '' END,
    p_created_by_user_id
  ) RETURNING id INTO v_transaction_id;

  UPDATE loyalty_point_lots
  SET revoked_at = NOW(), revoked_by_transaction_id = v_transaction_id, updated_at = NOW()
  WHERE member_id = p_member_id AND source_reference = p_source_reference
    AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;

  UPDATE loyalty_members
  SET remaining_points     = GREATEST(0, remaining_points - v_total_remaining),
      total_points_earned  = GREATEST(0, total_points_earned - v_total_original),
      cumulative_spend_jpy = GREATEST(0, cumulative_spend_jpy - v_spend_basis),
      updated_at = NOW()
  WHERE id = p_member_id
  RETURNING cumulative_spend_jpy INTO v_new_cumulative;

  -- Tier is re-derived unconditionally. Previously this was unreachable
  -- whenever no lots survived, because the function had already returned NULL.
  SELECT id INTO v_new_tier_id FROM loyalty_tiers WHERE min_spend_jpy <= v_new_cumulative ORDER BY min_spend_jpy DESC LIMIT 1;

  IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN
    UPDATE loyalty_members
    SET current_tier_id = v_new_tier_id, is_downgraded = false, downgrade_spend_baseline = NULL, updated_at = NOW()
    WHERE id = p_member_id;
    INSERT INTO public.loyalty_transactions (
      member_id, transaction_type, points_amount, spend_amount_jpy, tier_at_time, account_id, cash_order_id, invoice_number, notes, created_by_user_id
    ) VALUES (
      p_member_id, 'tier_changed', 0, NULL,
      (SELECT name FROM public.loyalty_tiers WHERE id = v_new_tier_id),
      p_account_id, p_cash_order_id, p_invoice_number,
      'Tier downgraded: ' || (SELECT name FROM public.loyalty_tiers WHERE id = v_member.current_tier_id)
        || ' → ' || (SELECT name FROM public.loyalty_tiers WHERE id = v_new_tier_id)
        || ' — points revoked (' || COALESCE(p_trigger_event, 'revoke') || ')',
      p_created_by_user_id
    );
  END IF;
  RETURN v_transaction_id;
END;
$function$;

COMMENT ON FUNCTION public.revoke_loyalty_points(uuid, text, numeric, uuid, uuid, uuid, text, text, uuid, text) IS
  'Reverses one order''s loyalty effect. POINTS come from the surviving lots (you can only take back points that still exist). SPEND comes from loyalty_order_spend_basis -- the ledger -- independent of lots. p_spend_jpy is accepted for signature compatibility and IGNORED: every caller passes total_paid in JPY, which is money received, not the loyalty basis. Idempotent: a second call finds basis 0 and no live lots, writes nothing, and returns the earlier revoke row.';

-- ---------------------------------------------------------------------------
-- 3. delete_account_atomic -- revoke inside the delete transaction.
-- ---------------------------------------------------------------------------
-- The layaway delete path had no revoke in the RPC at all; the delete-account
-- edge function fired one over HTTP beforehand, so a delete that then failed
-- still revoked the points. Moving it in makes it atomic with the delete, and
-- it reads the basis before the ledger's order row is gone.
CREATE OR REPLACE FUNCTION public.delete_account_atomic(
  p_account_id uuid,
  p_performed_by_user_id uuid DEFAULT NULL::uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_invoice_number text; v_caller_uuid uuid; v_audit_user_id uuid;
  v_total_amount numeric; v_total_paid numeric; v_customer_id uuid;
  v_status text; v_payment_count integer; v_currency text; v_live_payment boolean;
  v_member_id uuid; v_revoked_tx uuid := NULL;
BEGIN
  v_caller_uuid := auth.uid();
  IF v_caller_uuid IS NOT NULL AND NOT public.has_role(v_caller_uuid, 'admin') THEN
    RAISE EXCEPTION 'admin role required for delete_account_atomic' USING ERRCODE = '42501', HINT = 'Only admin role can delete accounts. See role_permissions table.';
  END IF;
  v_audit_user_id := COALESCE(p_performed_by_user_id, v_caller_uuid);
  IF v_audit_user_id IS NULL THEN
    RAISE EXCEPTION 'caller identity required (auth.uid() or p_performed_by_user_id)';
  END IF;
  SELECT invoice_number, total_amount, total_paid, customer_id, status::text, currency
    INTO v_invoice_number, v_total_amount, v_total_paid, v_customer_id, v_status, v_currency
    FROM public.layaway_accounts WHERE id = p_account_id;
  IF v_invoice_number IS NULL THEN RETURN jsonb_build_object('error', 'Account not found'); END IF;

  -- Completed or paid orders are never deleted (2026-09-13). Checked before
  -- any child row is removed so payments are never lost on the way to a refusal.
  SELECT EXISTS (SELECT 1 FROM public.payments WHERE account_id = p_account_id AND voided_at IS NULL) INTO v_live_payment;
  IF public.is_paid_or_completed_order(v_status, v_total_paid, v_customer_id, v_live_payment) THEN
    RETURN jsonb_build_object('error', 'paid_order_delete_forbidden', 'invoice_number', v_invoice_number,
      'message', 'INV ' || v_invoice_number || ' is ' || v_status || ' with ' || v_currency || ' ' || COALESCE(v_total_paid, 0)::text ||
                 ' received. Completed or paid accounts are never deleted — cancel it with a reason, or void the payment.');
  END IF;

  -- Points + spend, in the same transaction as the delete. Idempotent, so a
  -- lagging delete-account build that still calls the edge function first is
  -- harmless -- the second call finds nothing left and writes nothing.
  SELECT id INTO v_member_id FROM public.loyalty_members WHERE customer_id = v_customer_id;
  IF v_member_id IS NOT NULL THEN
    v_revoked_tx := public.revoke_loyalty_points(
      p_member_id => v_member_id, p_source_reference => v_invoice_number, p_spend_jpy => 0,
      p_account_id => p_account_id, p_cash_order_id => NULL, p_payment_id => NULL,
      p_invoice_number => v_invoice_number,
      p_notes => 'Revoked: layaway account deleted (' || v_invoice_number || ')',
      p_created_by_user_id => v_audit_user_id, p_trigger_event => 'delete_account');
  END IF;

  SELECT COUNT(*) INTO v_payment_count FROM public.payments WHERE account_id = p_account_id;
  PERFORM set_config('app.allow_schedule_delete', 'on', true);
  DELETE FROM public.payment_submission_allocations WHERE account_id = p_account_id;
  DELETE FROM public.payment_submissions WHERE account_id = p_account_id;
  DELETE FROM public.payment_allocations WHERE payment_id IN (SELECT id FROM public.payments WHERE account_id = p_account_id);
  DELETE FROM public.penalty_waiver_requests WHERE account_id = p_account_id;
  DELETE FROM public.penalty_fees WHERE account_id = p_account_id;
  DELETE FROM public.csr_notifications WHERE account_id = p_account_id;
  DELETE FROM public.staff_notifications WHERE account_id = p_account_id;
  DELETE FROM public.extension_requests WHERE account_id = p_account_id;
  DELETE FROM public.reminder_logs WHERE account_id = p_account_id;
  DELETE FROM public.reconciliation_log WHERE account_id = p_account_id;
  DELETE FROM public.account_services WHERE account_id = p_account_id;
  DELETE FROM public.final_settlement_records WHERE account_id = p_account_id;
  DELETE FROM public.penalty_cap_overrides WHERE account_id = p_account_id;
  DELETE FROM public.generated_invoices WHERE account_id = p_account_id;
  DELETE FROM public.payments WHERE account_id = p_account_id;
  DELETE FROM public.layaway_schedule WHERE account_id = p_account_id;
  DELETE FROM public.layaway_accounts WHERE id = p_account_id;
  INSERT INTO public.audit_logs ( entity_type, entity_id, action, old_value_json, performed_by_user_id )
  VALUES ( 'layaway_account', p_account_id, 'delete',
    jsonb_build_object('invoice_number', v_invoice_number, 'total_amount', v_total_amount,
      'total_paid', v_total_paid, 'currency', v_currency, 'status', v_status,
      'customer_id', v_customer_id, 'payment_count', v_payment_count,
      'generated_invoices_deleted', true, 'earned_points_revoked_tx', v_revoked_tx), v_audit_user_id );
  RETURN jsonb_build_object('success', true, 'earned_points_revoked_tx', v_revoked_tx);
END; $function$;

-- ---------------------------------------------------------------------------
-- 4. The three callers. None of them computes the basis: it is derived once,
--    inside revoke_loyalty_points. Three call sites each computing it is how
--    this bug came to have three copies.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delete_cash_order_atomic(p_cash_order_id uuid, p_performed_by_user_id uuid DEFAULT NULL::uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_invoice_number text; v_caller_uuid uuid; v_audit_user_id uuid;
  v_total_amount numeric; v_total_paid numeric; v_customer_id uuid;
  v_status text; v_currency text; v_payment_count integer;
  v_source_channel text; v_web_reference text;
  v_member_id uuid; v_revoked_tx uuid := NULL;
BEGIN
  v_caller_uuid := auth.uid();
  IF v_caller_uuid IS NOT NULL AND NOT public.has_role(v_caller_uuid, 'admin') THEN
    RAISE EXCEPTION 'admin role required for delete_cash_order_atomic' USING ERRCODE = '42501', HINT = 'Only admin role can delete cash orders. See role_permissions table.';
  END IF;
  v_audit_user_id := COALESCE(p_performed_by_user_id, v_caller_uuid);
  IF v_audit_user_id IS NULL THEN
    RAISE EXCEPTION 'caller identity required (auth.uid() or p_performed_by_user_id)';
  END IF;
  SELECT invoice_number, total_amount, total_paid, customer_id, status::text, currency, source_channel, web_reference
    INTO v_invoice_number, v_total_amount, v_total_paid, v_customer_id, v_status, v_currency, v_source_channel, v_web_reference
    FROM public.cash_orders WHERE id = p_cash_order_id;
  IF v_invoice_number IS NULL THEN RETURN jsonb_build_object('error', 'Cash order not found'); END IF;
  IF v_source_channel = 'web' THEN
    RETURN jsonb_build_object('error', 'web_order_delete_forbidden', 'web_reference', v_web_reference,
      'message', 'Web orders are cancelled, never deleted.');
  END IF;

  -- Points + spend: same-transaction revoke. p_spend_jpy stays 0 on purpose —
  -- revoke_loyalty_points derives the spend basis from the ledger itself
  -- (loyalty_order_spend_basis), so it is correct even when the points were
  -- already redeemed or expired and no lot survives. Idempotent.
  SELECT id INTO v_member_id FROM public.loyalty_members WHERE customer_id = v_customer_id;
  IF v_member_id IS NOT NULL THEN
    v_revoked_tx := public.revoke_loyalty_points(
      p_member_id => v_member_id, p_source_reference => v_invoice_number, p_spend_jpy => 0,
      p_account_id => NULL, p_cash_order_id => p_cash_order_id, p_payment_id => NULL,
      p_invoice_number => v_invoice_number,
      p_notes => 'Revoked: cash order deleted (' || v_invoice_number || ')',
      p_created_by_user_id => v_audit_user_id, p_trigger_event => 'delete_account');
  END IF;

  SELECT COUNT(*) INTO v_payment_count FROM public.cash_payments WHERE cash_order_id = p_cash_order_id;
  DELETE FROM public.staff_notifications WHERE account_id = p_cash_order_id;
  DELETE FROM public.payment_proofs WHERE cash_order_id = p_cash_order_id;
  DELETE FROM public.generated_invoices WHERE cash_order_id = p_cash_order_id;
  DELETE FROM public.cash_payments WHERE cash_order_id = p_cash_order_id;
  DELETE FROM public.cash_orders WHERE id = p_cash_order_id;
  INSERT INTO public.audit_logs ( entity_type, entity_id, action, old_value_json, performed_by_user_id )
  VALUES ( 'cash_order', p_cash_order_id, 'delete',
    jsonb_build_object('invoice_number', v_invoice_number, 'total_amount', v_total_amount,
      'total_paid', v_total_paid, 'currency', v_currency, 'status', v_status,
      'customer_id', v_customer_id, 'payment_count', v_payment_count,
      'earned_points_revoked_tx', v_revoked_tx), v_audit_user_id );
  RETURN jsonb_build_object('success', true, 'earned_points_revoked_tx', v_revoked_tx);
END; $function$;

CREATE OR REPLACE FUNCTION public.terminate_web_order_atomic(
  p_order_id uuid,
  p_outcome text,
  p_reason text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_user_email text DEFAULT NULL,
  p_refund_status text DEFAULT NULL,
  p_refund_note text DEFAULT NULL,
  p_source text DEFAULT 'staff',
  p_preview boolean DEFAULT false
)
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
    v_reason := COALESCE(NULLIF(btrim(p_reason), ''), 'Bank transfer not received within 72 hours (auto-expired)');
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

-- ---------------------------------------------------------------------------
-- 5. loyalty_integrity_report -- a fourth predicate that can see this class.
-- ---------------------------------------------------------------------------
-- The report had three predicates and none of them could detect a corrupted
-- cumulative_spend_jpy. The third derives the EXPECTED TIER **from**
-- cumulative_spend_jpy, so whatever that column says is correct by
-- construction: inflate it and the tier inflates with it and the row still
-- passes. That is why this ran undetected from the web-order launch until a
-- points-earned email happened to print the figure.
--
-- TWO predicates are added, not one, because "counter vs ledger" is necessary
-- but NOT sufficient. Measured on a faithful reproduction of the failure:
-- when case A struck, revoke_loyalty_points returned before writing anything,
-- so the counter kept the spend AND the ledger kept the earned row. The two
-- agree with each other -- both wrong in the same way -- and a counter-vs-ledger
-- check passes. Predicate 4 catches a counter that drifted from its ledger
-- (Test Customer's May test-era churn, or a counter written with no ledger row).
-- Predicate 5 is the one that catches THIS defect: an order in a terminal state
-- whose ledger still shows spend standing against it.
--
-- THE MIGRATION-SEED PROBLEM. Seven real members carry lifetime spend that
-- entered the counter before the Hub ledger existed (enrolled 2025, seeded
-- from the Google Sheets tracker at the 2026-05-15 migration). A naive
-- "counter must equal ledger net" predicate flags all seven on every run,
-- forever, for a reason no one can act on -- and a check that always shows
-- seven rows is a check people stop reading, which is worse than no check.
--
-- The fix is a per-member baseline, frozen once here, not an exclusion. The
-- member stays checked: the predicate compares the counter against
-- baseline + ledger net, so the seeded amount is accounted for and any NEW
-- drift on those same members still surfaces. Exclusion would have made them
-- permanently unwatchable.
ALTER TABLE public.loyalty_members
  ADD COLUMN IF NOT EXISTS spend_baseline_jpy numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.loyalty_members.spend_baseline_jpy IS
  'Lifetime spend that entered cumulative_spend_jpy before the Hub ledger existed (Google Sheets migration, 2026-05-15). The ledger cannot account for it, so loyalty_integrity_report treats it as the starting point rather than as drift. Frozen at backfill; a later award or reversal moves cumulative_spend_jpy, never this.';

-- Backfill, once. Deliberately scoped to members enrolled before the Hub
-- ledger era and NOT test customers.
--
-- Test Customer (CJ-2026-05088, enrolled 2026-04-26) is excluded ON PURPOSE.
-- She carries JPY 3,080,000 of May-2026 test-era revoke/restore drift plus
-- JPY 701,960 of unreversed cancellations. Giving her a baseline would launder
-- exactly the corruption this migration exists to expose. She will show in the
-- report until that data decision is made, which is the intended outcome.
UPDATE public.loyalty_members m
   SET spend_baseline_jpy = m.cumulative_spend_jpy - (
         SELECT COALESCE(SUM(
                  CASE WHEN t.transaction_type = 'earned'   THEN  COALESCE(t.spend_amount_jpy, 0)
                       WHEN t.transaction_type = 'revoked'  THEN -COALESCE(t.spend_amount_jpy, 0)
                       WHEN t.transaction_type = 'adjusted' THEN -COALESCE(t.spend_amount_jpy, 0)
                       ELSE 0 END), 0)
           FROM public.loyalty_transactions t WHERE t.member_id = m.id)
  FROM public.customers c
 WHERE c.id = m.customer_id
   AND m.enrolled_at < '2026-04-01'
   AND COALESCE(c.is_test, false) = false
   AND m.cumulative_spend_jpy - (
         SELECT COALESCE(SUM(
                  CASE WHEN t.transaction_type = 'earned'   THEN  COALESCE(t.spend_amount_jpy, 0)
                       WHEN t.transaction_type = 'revoked'  THEN -COALESCE(t.spend_amount_jpy, 0)
                       WHEN t.transaction_type = 'adjusted' THEN -COALESCE(t.spend_amount_jpy, 0)
                       ELSE 0 END), 0)
           FROM public.loyalty_transactions t WHERE t.member_id = m.id) > 0;

DROP FUNCTION IF EXISTS public.loyalty_integrity_report();

CREATE OR REPLACE FUNCTION public.loyalty_integrity_report()
 RETURNS TABLE(member_id uuid, customer_code text, full_name text, counter_points numeric,
               lots_live numeric, ledger_net numeric, tier_now text, tier_from_spend text,
               is_downgraded boolean, spend_stored numeric, spend_expected numeric,
               terminal_order_spend numeric, problem text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Staff only. Customers hold authenticated sessions too, so the role check
  -- lives inside the function, not in the grant.
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance')
    OR public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'csr')) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH lots AS (
    SELECT l.member_id, SUM(l.remaining_amount)::numeric AS live FROM public.loyalty_point_lots l
     WHERE l.revoked_at IS NULL AND l.expired_at IS NULL AND l.consumed_at IS NULL GROUP BY l.member_id),
  led AS (SELECT t.member_id, SUM(t.points_amount)::numeric AS net FROM public.loyalty_transactions t GROUP BY t.member_id),
  -- Spend ledger. 'adjusted' rows are DEDUCTIONS recorded as a positive
  -- spend_amount_jpy (the convention CJ-2026-01504's 2026-08-26 manual
  -- corrections set, and the only way the type is used: 3 rows, all positive).
  spend_led AS (
    SELECT t.member_id,
           SUM(CASE WHEN t.transaction_type = 'earned'   THEN  COALESCE(t.spend_amount_jpy, 0)
                    WHEN t.transaction_type = 'revoked'  THEN -COALESCE(t.spend_amount_jpy, 0)
                    WHEN t.transaction_type = 'adjusted' THEN -COALESCE(t.spend_amount_jpy, 0)
                    ELSE 0 END)::numeric AS net
      FROM public.loyalty_transactions t GROUP BY t.member_id),
  spend_tier AS (
    SELECT m.id AS member_id,
           (SELECT x.name FROM public.loyalty_tiers x WHERE x.min_spend_jpy <= m.cumulative_spend_jpy ORDER BY x.min_spend_jpy DESC LIMIT 1) AS name
      FROM public.loyalty_members m),
  -- Spend still standing against orders that are over. A cancelled, expired or
  -- forfeited order must have given its spend back; if loyalty_order_spend_basis
  -- is still positive, the reversal never happened.
  terminal AS (
    SELECT m.id AS member_id,
           COALESCE(SUM(public.loyalty_order_spend_basis(m.id, o.invoice_number)), 0)::numeric AS spend
      FROM public.loyalty_members m
      JOIN LATERAL (
        SELECT la.invoice_number FROM public.layaway_accounts la
         WHERE la.customer_id = m.customer_id
           AND la.status::text IN ('cancelled', 'forfeited', 'final_forfeited')
        UNION ALL
        SELECT co.invoice_number FROM public.cash_orders co
         WHERE co.customer_id = m.customer_id
           AND co.status::text IN ('cancelled', 'expired')
      ) o ON true
     GROUP BY m.id)
  SELECT m.id, c.customer_code, c.full_name,
         m.remaining_points, COALESCE(l.live, 0), COALESCE(d.net, 0),
         t.name, st.name, m.is_downgraded,
         m.cumulative_spend_jpy,
         COALESCE(m.spend_baseline_jpy, 0) + COALESCE(s.net, 0),
         COALESCE(tm.spend, 0),
         concat_ws('; ',
           CASE WHEN m.remaining_points <> COALESCE(l.live, 0) THEN 'counter ≠ live lots' END,
           CASE WHEN m.remaining_points <> COALESCE(d.net, 0) THEN 'counter ≠ ledger net' END,
           CASE WHEN NOT m.is_downgraded AND t.name IS DISTINCT FROM st.name THEN 'tier ≠ tier from lifetime spend' END,
           -- Predicate 4. Catches a cancellation that did not reverse its
           -- spend, which predicate 3 cannot see because it reads the tier
           -- back out of the same number.
           CASE WHEN m.cumulative_spend_jpy <> COALESCE(m.spend_baseline_jpy, 0) + COALESCE(s.net, 0)
                THEN 'lifetime spend ≠ migration baseline + ledger spend' END,
           -- Predicate 5. The one that would have caught TEST-900008 the day it
           -- was cancelled. Independent of predicate 4: here the counter and the
           -- ledger agree, and both are wrong.
           CASE WHEN COALESCE(tm.spend, 0) > 0
                THEN 'cancelled/forfeited order still counting ' || COALESCE(tm.spend, 0)::text || ' JPY of lifetime spend' END)
    FROM public.loyalty_members m
    JOIN public.customers c ON c.id = m.customer_id
    LEFT JOIN public.loyalty_tiers t ON t.id = m.current_tier_id
    LEFT JOIN lots l ON l.member_id = m.id
    LEFT JOIN led d ON d.member_id = m.id
    LEFT JOIN spend_led s ON s.member_id = m.id
    LEFT JOIN spend_tier st ON st.member_id = m.id
    LEFT JOIN terminal tm ON tm.member_id = m.id
   WHERE m.remaining_points <> COALESCE(l.live, 0)
      OR m.remaining_points <> COALESCE(d.net, 0)
      OR (NOT m.is_downgraded AND t.name IS DISTINCT FROM st.name)
      OR m.cumulative_spend_jpy <> COALESCE(m.spend_baseline_jpy, 0) + COALESCE(s.net, 0)
      OR COALESCE(tm.spend, 0) > 0
   ORDER BY c.customer_code;
END $function$;

REVOKE ALL ON FUNCTION public.loyalty_integrity_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_integrity_report() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.loyalty_order_spend_basis(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_order_spend_basis(uuid, text) TO authenticated, service_role;
