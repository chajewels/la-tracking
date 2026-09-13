-- =============================================================================
-- Web order lifecycle + loyalty points integrity (2026-09-13)
--
-- A. cash_orders: refund decision columns for cancelled paid orders.
-- B. Web orders can never be hard-deleted (trigger + RPC guard); deleting a
--    Hub cash order revokes its points inside the same transaction.
-- C. terminate_web_order_atomic(): the ONE terminal RPC for web orders.
--    'expired' (72h lapse) and 'cancelled' (staff) both: lock the row, revoke
--    earned points as a ledger row, decide store credit from the refund
--    decision, flip the status, put the held stock back on sale, note + audit.
--    expire_web_order_atomic() becomes a thin wrapper.
-- D. One expiry path: the hourly SQL cron expire_transfer_orders() is dropped;
--    auto-expire-cash-orders (edge function: stock, submissions, audit, email)
--    runs hourly instead of once a day.
-- E. Points integrity: loyalty_award_claims (idempotent award keyed on the
--    order), loyalty_transactions immutability, revoke ledger rows record the
--    points actually removed, one-time ledger reconciliation to live lots,
--    loyalty_integrity_report() for any-time reconciliation.
-- =============================================================================

-- ---------------------------------------------------------------- A. refund decision
ALTER TABLE public.cash_orders
  ADD COLUMN IF NOT EXISTS refund_status text,
  ADD COLUMN IF NOT EXISTS refund_note text,
  ADD COLUMN IF NOT EXISTS refund_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_decided_by_user_id uuid;

ALTER TABLE public.cash_orders DROP CONSTRAINT IF EXISTS cash_orders_refund_status_check;
ALTER TABLE public.cash_orders
  ADD CONSTRAINT cash_orders_refund_status_check
  CHECK (refund_status IS NULL OR refund_status IN ('refund_issued','refund_pending','no_refund'));

COMMENT ON COLUMN public.cash_orders.refund_status IS
  'Decision recorded when a PAID order is cancelled: refund_issued / refund_pending (money goes back, no store credit) / no_refund (money received becomes store credit). Shown to the customer.';

-- ---------------------------------------------------------------- B. web orders are never deleted
CREATE OR REPLACE FUNCTION public.prevent_web_order_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.source_channel = 'web' THEN
    RAISE EXCEPTION 'web_order_delete_forbidden: % is a web order — cancel it, never delete it (order history, stock hold and points reversal depend on the row)',
      COALESCE(OLD.web_reference, OLD.invoice_number)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_web_order_delete ON public.cash_orders;
CREATE TRIGGER trg_prevent_web_order_delete
  BEFORE DELETE ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.prevent_web_order_delete();

-- delete_cash_order_atomic: refuse web orders up front (clear JSON error instead
-- of a trigger exception) and revoke the order's points INSIDE the transaction.
-- The edge function used to fire revoke-loyalty-points over HTTP and not wait —
-- the 2026-08-25 ledger note records a delete whose revoke never ran.
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

  -- Points: same-transaction revoke (idempotent; no-op when nothing was awarded).
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

-- ---------------------------------------------------------------- C. the one terminal RPC for web orders
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
    IF p_refund_status IS NOT NULL AND p_refund_status NOT IN ('refund_issued','refund_pending','no_refund') THEN
      RAISE EXCEPTION 'bad_refund_status: %', p_refund_status USING ERRCODE='P0001';
    END IF;
    IF NOT p_preview AND v_money_received > 0 AND p_refund_status IS NULL THEN
      RAISE EXCEPTION 'refund_decision_required' USING ERRCODE='P0001';
    END IF;
    -- Store credit follows the decision: money going back to the customer is
    -- never ALSO minted as credit. Only "no refund" keeps the locked cash-order
    -- policy (money received becomes store credit, minus credit already minted
    -- by Shopify partial refunds).
    IF COALESCE(p_refund_status, 'no_refund') = 'no_refund' THEN
      v_issue_amount := GREATEST(0, v_money_received - v_partial_credit);
    END IF;
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
      'earned_points_will_be_revoked', true);
  END IF;

  -- 1. Points: a ledger row + lots marked revoked (idempotent, no-op if none).
  SELECT id INTO v_member_id FROM public.loyalty_members WHERE customer_id = v_customer_id;
  IF v_member_id IS NOT NULL AND v_invoice IS NOT NULL THEN
    v_revoked_tx := public.revoke_loyalty_points(
      p_member_id => v_member_id, p_source_reference => v_invoice, p_spend_jpy => 0,
      p_account_id => NULL, p_cash_order_id => p_order_id, p_payment_id => NULL,
      p_invoice_number => v_invoice,
      p_notes => 'Revoked: web order ' || p_outcome || ' (' || v_reason || ')',
      p_created_by_user_id => p_user_id, p_trigger_event => 'cancel');
  END IF;

  -- 2. Store credit (cancelled + no_refund only).
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
    'lines_restored', v_restored, 'source', p_source);
END;
$function$;

REVOKE ALL ON FUNCTION public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean) TO service_role;

-- expire_web_order_atomic keeps its signature (auto-expire-cash-orders calls it)
-- and delegates: same lock, same guards, same trail.
CREATE OR REPLACE FUNCTION public.expire_web_order_atomic(p_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN public.terminate_web_order_atomic(p_order_id, 'expired', NULL, NULL, NULL, NULL, NULL, 'system', false);
END $function$;

-- ---------------------------------------------------------------- D. one expiry path
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'expire-transfer-orders';
DROP FUNCTION IF EXISTS public.expire_transfer_orders();
-- auto-expire-cash-orders: hourly at :40, clear of the 00:00–00:30 UTC layaway
-- chain (reminders → penalties → forfeit → reconciliation → loyalty check).
SELECT cron.alter_job(job_id := jobid, schedule := '40 * * * *')
  FROM cron.job WHERE jobname = 'auto-expire-cash-orders';

-- ---------------------------------------------------------------- E. points integrity
-- E1. Idempotent award keyed on the order. The claim is an INSERT into a
--     primary-keyed table, so two concurrent awards for the same order cannot
--     both win, whatever the edge function reads first.
CREATE TABLE IF NOT EXISTS public.loyalty_award_claims (
  source_kind text NOT NULL CHECK (source_kind IN ('cash','layaway')),
  source_id uuid NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  transaction_id uuid,
  PRIMARY KEY (source_kind, source_id)
);
ALTER TABLE public.loyalty_award_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.loyalty_award_claims FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.loyalty_award_claims TO service_role;

-- Backfill: every order that already has an earned row is already claimed.
INSERT INTO public.loyalty_award_claims (source_kind, source_id, claimed_at, transaction_id)
SELECT 'cash', t.cash_order_id, MIN(t.created_at), (array_agg(t.id ORDER BY t.created_at))[1]
  FROM public.loyalty_transactions t
 WHERE t.transaction_type = 'earned' AND t.cash_order_id IS NOT NULL
 GROUP BY t.cash_order_id
ON CONFLICT DO NOTHING;
INSERT INTO public.loyalty_award_claims (source_kind, source_id, claimed_at, transaction_id)
SELECT 'layaway', t.account_id, MIN(t.created_at), (array_agg(t.id ORDER BY t.created_at))[1]
  FROM public.loyalty_transactions t
 WHERE t.transaction_type = 'earned' AND t.account_id IS NOT NULL
 GROUP BY t.account_id
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_loyalty_award(p_source_kind text, p_source_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_inserted integer;
BEGIN
  INSERT INTO public.loyalty_award_claims (source_kind, source_id)
  VALUES (p_source_kind, p_source_id)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted = 1;
END $$;

CREATE OR REPLACE FUNCTION public.release_loyalty_award_claim(p_source_kind text, p_source_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  DELETE FROM public.loyalty_award_claims
   WHERE source_kind = p_source_kind AND source_id = p_source_id AND transaction_id IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.confirm_loyalty_award_claim(p_source_kind text, p_source_id uuid, p_transaction_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.loyalty_award_claims SET transaction_id = p_transaction_id
   WHERE source_kind = p_source_kind AND source_id = p_source_id;
$$;

REVOKE ALL ON FUNCTION public.claim_loyalty_award(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_loyalty_award_claim(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_loyalty_award_claim(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_loyalty_award(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_loyalty_award_claim(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_loyalty_award_claim(text, uuid, uuid) TO service_role;

-- E2. The ledger is append-only. The only column that may change after insert
--     is the Google Sheet sync marker.
CREATE OR REPLACE FUNCTION public.loyalty_transactions_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'loyalty_transactions rows are immutable (delete refused for %)', OLD.id USING ERRCODE='P0001';
  END IF;
  IF row_to_json(NEW)::jsonb - 'synced_to_sheet_at' IS DISTINCT FROM row_to_json(OLD)::jsonb - 'synced_to_sheet_at' THEN
    RAISE EXCEPTION 'loyalty_transactions rows are immutable (only synced_to_sheet_at may change, row %)', OLD.id USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_loyalty_transactions_immutable ON public.loyalty_transactions;
CREATE TRIGGER trg_loyalty_transactions_immutable
  BEFORE UPDATE OR DELETE ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION public.loyalty_transactions_guard_update();

-- E3. revoke_loyalty_points: the ledger row records the points actually taken
--     away (the lots' REMAINING amount), matching what leaves remaining_points.
--     It used to write -original, so a lot partly spent before a revoke left the
--     ledger below the balance by the spent portion. Everything else unchanged.
CREATE OR REPLACE FUNCTION public.revoke_loyalty_points(p_member_id uuid, p_source_reference text, p_spend_jpy numeric, p_account_id uuid DEFAULT NULL::uuid, p_cash_order_id uuid DEFAULT NULL::uuid, p_payment_id uuid DEFAULT NULL::uuid, p_invoice_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_created_by_user_id uuid DEFAULT NULL::uuid, p_trigger_event text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id UUID;
  v_existing_tx UUID;
  v_total_remaining NUMERIC := 0;
  v_total_original NUMERIC := 0;
  v_total_spend_basis NUMERIC := 0;
  v_lot_count INTEGER := 0;
  v_member RECORD;
  v_current_tier_name TEXT;
  v_new_cumulative NUMERIC;
  v_new_tier_id UUID;
BEGIN
  IF p_payment_id IS NOT NULL THEN
    SELECT id INTO v_existing_tx FROM loyalty_transactions
    WHERE payment_id = p_payment_id AND transaction_type = 'revoked' ORDER BY created_at DESC LIMIT 1;
    IF v_existing_tx IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM loyalty_point_lots WHERE member_id = p_member_id AND source_reference = p_source_reference
        AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL) THEN
      RETURN v_existing_tx;
    END IF;
  END IF;
  IF p_cash_order_id IS NOT NULL THEN
    SELECT id INTO v_existing_tx FROM loyalty_transactions
    WHERE cash_order_id = p_cash_order_id AND transaction_type = 'revoked' ORDER BY created_at DESC LIMIT 1;
    IF v_existing_tx IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM loyalty_point_lots WHERE member_id = p_member_id AND source_reference = p_source_reference
        AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL) THEN
      RETURN v_existing_tx;
    END IF;
  END IF;

  SELECT m.*, t.name AS tier_name INTO v_member
  FROM loyalty_members m LEFT JOIN loyalty_tiers t ON t.id = m.current_tier_id
  WHERE m.id = p_member_id FOR UPDATE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'revoke: member % not found', p_member_id; END IF;
  v_current_tier_name := v_member.tier_name;

  SELECT COALESCE(SUM(remaining_amount), 0), COALESCE(SUM(original_amount), 0), COALESCE(SUM(spend_basis_jpy), 0), COUNT(*)
  INTO v_total_remaining, v_total_original, v_total_spend_basis, v_lot_count
  FROM loyalty_point_lots
  WHERE member_id = p_member_id AND source_reference = p_source_reference
    AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;

  IF v_lot_count = 0 THEN
    IF p_trigger_event IN ('manual_forfeit','auto_forfeit','final_forfeit') AND COALESCE(p_spend_jpy, 0) > 0 THEN
      v_total_remaining := 0; v_total_original := 0; v_total_spend_basis := p_spend_jpy;
    ELSE
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO loyalty_transactions (
    member_id, account_id, cash_order_id, payment_id, transaction_type, points_amount, spend_amount_jpy,
    invoice_number, tier_at_time, notes, created_by_user_id
  ) VALUES (
    p_member_id, p_account_id, p_cash_order_id, p_payment_id, 'revoked', -v_total_remaining, v_total_spend_basis,
    p_invoice_number, v_current_tier_name, COALESCE(p_notes, 'Revoked: ' || p_source_reference), p_created_by_user_id
  ) RETURNING id INTO v_transaction_id;

  UPDATE loyalty_point_lots
  SET revoked_at = NOW(), revoked_by_transaction_id = v_transaction_id, updated_at = NOW()
  WHERE member_id = p_member_id AND source_reference = p_source_reference
    AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;

  UPDATE loyalty_members
  SET remaining_points = GREATEST(0, remaining_points - v_total_remaining),
      total_points_earned = GREATEST(0, total_points_earned - v_total_original),
      cumulative_spend_jpy = GREATEST(0, cumulative_spend_jpy - v_total_spend_basis),
      updated_at = NOW()
  WHERE id = p_member_id
  RETURNING cumulative_spend_jpy INTO v_new_cumulative;

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

-- E4. One-time ledger reconciliation: after this, ledger net = live lots =
--     remaining_points for every member (31 members drifted on 2026-09-13 from
--     historical restores and manual backfills that wrote lots without rows).
INSERT INTO public.loyalty_transactions (member_id, transaction_type, points_amount, spend_amount_jpy, tier_at_time, notes)
SELECT m.id, 'adjusted'::loyalty_transaction_type, m.remaining_points - COALESCE(d.net, 0), NULL::numeric, t.name,
       'Ledger reconciliation 2026-09-13: aligns the ledger to live lots (historical restores/backfills, Bug #269)'
  FROM public.loyalty_members m
  LEFT JOIN public.loyalty_tiers t ON t.id = m.current_tier_id
  LEFT JOIN (SELECT member_id, SUM(points_amount) AS net FROM public.loyalty_transactions GROUP BY member_id) d ON d.member_id = m.id
 WHERE m.remaining_points <> COALESCE(d.net, 0);

-- E5. Reconciliation you can run any time: SELECT * FROM loyalty_integrity_report();
--     Empty result = ledger, lots, counters and tier all agree for every member.
CREATE OR REPLACE FUNCTION public.loyalty_integrity_report()
RETURNS TABLE (
  member_id uuid, customer_code text, full_name text,
  counter_points numeric, lots_live numeric, ledger_net numeric,
  tier_now text, tier_from_spend text, is_downgraded boolean,
  problem text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  spend_tier AS (
    SELECT m.id AS member_id,
           (SELECT x.name FROM public.loyalty_tiers x WHERE x.min_spend_jpy <= m.cumulative_spend_jpy ORDER BY x.min_spend_jpy DESC LIMIT 1) AS name
      FROM public.loyalty_members m)
  SELECT m.id, c.customer_code, c.full_name,
         m.remaining_points, COALESCE(l.live, 0), COALESCE(d.net, 0),
         t.name, st.name, m.is_downgraded,
         concat_ws('; ',
           CASE WHEN m.remaining_points <> COALESCE(l.live, 0) THEN 'counter ≠ live lots' END,
           CASE WHEN m.remaining_points <> COALESCE(d.net, 0) THEN 'counter ≠ ledger net' END,
           CASE WHEN NOT m.is_downgraded AND t.name IS DISTINCT FROM st.name THEN 'tier ≠ tier from lifetime spend' END)
    FROM public.loyalty_members m
    JOIN public.customers c ON c.id = m.customer_id
    LEFT JOIN public.loyalty_tiers t ON t.id = m.current_tier_id
    LEFT JOIN lots l ON l.member_id = m.id
    LEFT JOIN led d ON d.member_id = m.id
    LEFT JOIN spend_tier st ON st.member_id = m.id
   WHERE m.remaining_points <> COALESCE(l.live, 0)
      OR m.remaining_points <> COALESCE(d.net, 0)
      OR (NOT m.is_downgraded AND t.name IS DISTINCT FROM st.name)
   ORDER BY c.customer_code;
END $$;
REVOKE ALL ON FUNCTION public.loyalty_integrity_report() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loyalty_integrity_report() TO authenticated, service_role;
