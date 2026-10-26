-- ===========================================================================
-- Delete cleanup: System Audit's 9 critical "missing_cleanup" findings.
--
-- Owner decisions 2026-10-25:
--   1. A customer with no orders but a declined checkout, coupon use or article
--      comments: delete those rows first, then the customer (delete-customer
--      edge function step 6b — deployed separately through Lovable).
--   2. Completed TEST accounts with a review invite may be deleted: the invite
--      and its review are removed (delete_account_atomic below).
--
-- This migration:
--   A. delete_account_atomic — deletes product_reviews (via the account's
--      review invites) and review_invites before the account. Base = live body
--      md5 32fbdbbc8c7b88136fbb45ec723a42f1; nothing else changed.
--   B. audit_delete_cleanup_invariants — allowlist rows for the 9 findings.
--      loyalty_signups / website_live_claims were already cleared by
--      delete-customer (false alarms); review_invites / product_reviews on
--      customers and web_order_drafts on layaway_accounts are protected by
--      existing refusals (pre_check_protected). Base = live body
--      md5 153d64fadfcc6371fa0e55d5f70d66f0; only VALUES rows added.
--
-- Live check 2026-10-25: 0 customers / accounts are blocked today.
-- ===========================================================================

BEGIN;

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
  -- Review invite + review (2026-10-25): an invite exists only for a COMPLETED
  -- order, and completed real orders are refused above, so this runs for TEST
  -- accounts only (owner decision: test accounts may be deleted).
  DELETE FROM public.product_reviews WHERE invite_id IN (SELECT id FROM public.review_invites WHERE layaway_account_id = p_account_id);
  DELETE FROM public.review_invites WHERE layaway_account_id = p_account_id;
  DELETE FROM public.layaway_accounts WHERE id = p_account_id;
  INSERT INTO public.audit_logs ( entity_type, entity_id, action, old_value_json, performed_by_user_id )
  VALUES ( 'layaway_account', p_account_id, 'delete',
    jsonb_build_object('invoice_number', v_invoice_number, 'total_amount', v_total_amount,
      'total_paid', v_total_paid, 'currency', v_currency, 'status', v_status,
      'customer_id', v_customer_id, 'payment_count', v_payment_count,
      'generated_invoices_deleted', true, 'earned_points_revoked_tx', v_revoked_tx), v_audit_user_id );
  RETURN jsonb_build_object('success', true, 'earned_points_revoked_tx', v_revoked_tx);
END; $function$;

CREATE OR REPLACE FUNCTION public.audit_delete_cleanup_invariants()
 RETURNS TABLE(delete_function text, parent_table text, child_table text, fk_name text, on_delete text, in_allowlist boolean, finding_type text, severity text, message text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT public.assert_staff_caller();
  WITH allowlist (delete_function, parent_table, child_table, defensive, pre_check_protected) AS (
    VALUES
      ('delete-account', 'layaway_accounts', 'payment_submission_allocations', false, false),
      ('delete-account', 'layaway_accounts', 'payment_submissions', false, false),
      ('delete-account', 'layaway_accounts', 'penalty_waiver_requests', true, false),
      ('delete-account', 'layaway_accounts', 'penalty_fees', true, false),
      ('delete-account', 'layaway_accounts', 'csr_notifications', true, false),
      ('delete-account', 'layaway_accounts', 'extension_requests', false, false),
      ('delete-account', 'layaway_accounts', 'reminder_logs', true, false),
      ('delete-account', 'layaway_accounts', 'reconciliation_log', false, false),
      ('delete-account', 'layaway_accounts', 'account_services', true, false),
      ('delete-account', 'layaway_accounts', 'final_settlement_records', false, false),
      ('delete-account', 'layaway_accounts', 'penalty_cap_overrides', true, false),
      ('delete-account', 'layaway_accounts', 'payments', false, false),
      ('delete-account', 'layaway_accounts', 'layaway_schedule', true, false),
      ('delete-account', 'layaway_accounts', 'generated_invoices', true, false),
      -- 2026-10-25: deleted by delete_account_atomic (test accounts only)
      ('delete-account', 'layaway_accounts', 'review_invites', false, false),
      -- 2026-10-25: set only on confirmed web drafts -> web plans cannot be deleted
      ('delete-account', 'layaway_accounts', 'web_order_drafts', false, true),
      ('delete-customer', 'customers', 'customer_analytics', true, false),
      ('delete-customer', 'customers', 'layaway_accounts', false, true),
      ('delete-customer', 'customers', 'cash_orders', false, true),
      ('delete-customer', 'customers', 'extension_requests', false, false),
      ('delete-customer', 'customers', 'payment_submissions', false, false),
      ('delete-customer', 'customers', 'service_jobs', false, false),
      ('delete-customer', 'customers', 'trade_ins', false, false),
      -- 2026-10-25: rows delete-customer already cleared but the list lacked
      ('delete-customer', 'customers', 'loyalty_signups', false, false),
      ('delete-customer', 'customers', 'website_live_claims', false, false),
      -- 2026-10-25: cleared by delete-customer step 6b (owner rule)
      ('delete-customer', 'customers', 'web_order_drafts', false, false),
      ('delete-customer', 'customers', 'website_coupon_uses', false, false),
      ('delete-customer', 'customers', 'website_post_comments', false, false),
      -- 2026-10-25: exist only with a completed order -> customer delete refused
      ('delete-customer', 'customers', 'review_invites', false, true),
      ('delete-customer', 'customers', 'product_reviews', false, true),
      ('(none - soft-cancel only)', 'cash_orders', 'cash_payments', false, false),
      ('(none - soft-cancel only)', 'cash_orders', 'generated_invoices', false, false),
      ('(none - soft-cancel only)', 'cash_orders', 'payment_proofs', false, false)
  ),
  parents (parent_table, delete_function) AS (
    VALUES
      ('layaway_accounts', 'delete-account'),
      ('customers', 'delete-customer'),
      ('cash_orders', '(none - soft-cancel only)')
  ),
  fks AS (
    SELECT p.parent_table, p.delete_function,
      regexp_replace(c.conrelid::regclass::text, '^public\.', '') AS child_table,
      c.conname AS fk_name,
      CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' END AS on_delete
    FROM pg_constraint c
    JOIN parents p ON c.confrelid = ('public.' || p.parent_table)::regclass
    WHERE c.contype = 'f' AND c.confdeltype IN ('a','r')
  ),
  missing AS (
    SELECT f.delete_function, f.parent_table, f.child_table, f.fk_name, f.on_delete,
      false AS in_allowlist,
      CASE WHEN f.parent_table = 'cash_orders' THEN 'preventive_no_delete_fn' ELSE 'missing_cleanup' END AS finding_type,
      CASE WHEN f.parent_table = 'cash_orders' THEN 'info' ELSE 'critical' END AS severity,
      format('%s blocks DELETE on %s but is not in the %s cleanup list. Add an explicit DELETE in the edge function.',
        f.fk_name, f.parent_table, f.delete_function) AS message
    FROM fks f
    WHERE NOT EXISTS (
      SELECT 1 FROM allowlist a
      WHERE a.parent_table = f.parent_table AND a.child_table = f.child_table
    )
  ),
  stale AS (
    SELECT a.delete_function, a.parent_table, a.child_table,
      NULL::text AS fk_name, NULL::text AS on_delete,
      true AS in_allowlist,
      'stale_allowlist_entry' AS finding_type,
      'warning' AS severity,
      format('Allowlist tracks %s.%s for %s but no NO ACTION/RESTRICT FK to %s exists. The FK may have been changed to CASCADE/SET NULL, or the table was dropped.',
        a.parent_table, a.child_table, a.delete_function, a.parent_table) AS message
    FROM allowlist a
    WHERE a.defensive = false AND a.pre_check_protected = false
      AND NOT EXISTS (
        SELECT 1 FROM fks f
        WHERE f.parent_table = a.parent_table AND f.child_table = a.child_table
      )
  )
  SELECT * FROM missing
  UNION ALL
  SELECT * FROM stale
  ORDER BY severity DESC, parent_table, child_table;
$function$;

COMMIT;
