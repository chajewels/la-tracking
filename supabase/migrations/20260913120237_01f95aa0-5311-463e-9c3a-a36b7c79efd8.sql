-- No completed or paid order may be deleted, by anyone (owner decision 2026-09-13).
--
-- Cash order 19144 (¥463,980, completed) and layaway 19278 (₱523,712,
-- completed) were hard-deleted through the Hub's delete buttons in August
-- 2026; their payment rows went with them and the money vanished from every
-- report. From now on a completed order, or any order that has received money,
-- can only be CANCELLED with a reason (the web-order rule, applied to every
-- order). A genuine correction is a reversal that stays on the books: void the
-- payment, cancel the order, or restructure — never a delete.
--
-- Three layers, innermost first:
--   1. BEFORE DELETE trigger on layaway_accounts and cash_orders — blocks SQL
--      Editor, PostgREST and any RPC alike. No bypass GUC on purpose.
--   2. delete_account_atomic / delete_cash_order_atomic refuse BEFORE touching
--      child rows, with a readable error (the trigger would roll the whole
--      transaction back anyway, but payments must never be deleted first).
--   3. delete-account / delete-cash-order edge functions answer 409, and the
--      Hub hides the Delete button on such orders.
-- Test customers (customers.is_test = true) are exempt: their orders are
-- scaffolding, not money.

CREATE OR REPLACE FUNCTION public.is_paid_or_completed_order(
  p_status text, p_total_paid numeric, p_customer_id uuid, p_has_live_payment boolean
) RETURNS boolean
LANGUAGE sql STABLE
SET search_path TO 'public'
AS $$
  SELECT NOT COALESCE((SELECT c.is_test FROM public.customers c WHERE c.id = p_customer_id), false)
     AND (p_status = 'completed' OR COALESCE(p_total_paid, 0) > 0 OR COALESCE(p_has_live_payment, false));
$$;

CREATE OR REPLACE FUNCTION public.prevent_paid_order_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_live_payment boolean;
BEGIN
  IF TG_TABLE_NAME = 'layaway_accounts' THEN
    SELECT EXISTS (SELECT 1 FROM public.payments p WHERE p.account_id = OLD.id AND p.voided_at IS NULL) INTO v_live_payment;
  ELSE
    SELECT EXISTS (SELECT 1 FROM public.cash_payments p WHERE p.cash_order_id = OLD.id AND p.voided_at IS NULL) INTO v_live_payment;
  END IF;
  IF public.is_paid_or_completed_order(OLD.status::text, OLD.total_paid, OLD.customer_id, v_live_payment) THEN
    RAISE EXCEPTION 'paid_order_delete_forbidden: % is % with % received — cancel it with a reason or void the payment; completed or paid orders are never deleted',
      OLD.invoice_number, OLD.status, OLD.total_paid
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_paid_layaway_delete ON public.layaway_accounts;
CREATE TRIGGER trg_prevent_paid_layaway_delete
  BEFORE DELETE ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_paid_order_delete();

DROP TRIGGER IF EXISTS trg_prevent_paid_cash_order_delete ON public.cash_orders;
CREATE TRIGGER trg_prevent_paid_cash_order_delete
  BEFORE DELETE ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.prevent_paid_order_delete();

-- 2. The atomic RPCs refuse first, before any child row is touched.
CREATE OR REPLACE FUNCTION public.delete_account_atomic(p_account_id uuid, p_performed_by_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_invoice_number text; v_caller_uuid uuid; v_audit_user_id uuid;
  v_total_amount numeric; v_total_paid numeric; v_customer_id uuid;
  v_status text; v_payment_count integer; v_currency text; v_live_payment boolean;
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
      'generated_invoices_deleted', true), v_audit_user_id );
  RETURN jsonb_build_object('success', true);
END; $function$;

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
  v_member_id uuid; v_revoked_tx uuid := NULL; v_live_payment boolean;
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

  -- Completed or paid orders are never deleted (2026-09-13). Checked before
  -- points are revoked or any child row is removed.
  SELECT EXISTS (SELECT 1 FROM public.cash_payments WHERE cash_order_id = p_cash_order_id AND voided_at IS NULL) INTO v_live_payment;
  IF public.is_paid_or_completed_order(v_status, v_total_paid, v_customer_id, v_live_payment) THEN
    RETURN jsonb_build_object('error', 'paid_order_delete_forbidden', 'invoice_number', v_invoice_number,
      'message', 'INV ' || v_invoice_number || ' is ' || v_status || ' with ' || v_currency || ' ' || COALESCE(v_total_paid, 0)::text ||
                 ' received. Completed or paid orders are never deleted — cancel it with a reason, or void the payment.');
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