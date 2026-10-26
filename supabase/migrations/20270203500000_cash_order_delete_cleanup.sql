-- ===========================================================================
-- Cash-order delete cleanup: the System Audit's 11 "info" findings.
--
-- The audit listed cash_orders as "(none - soft-cancel only)", but cash orders
-- ARE deleted: Hub Delete -> delete-cash-order -> delete_cash_order_atomic
-- (staff-made orders only, unpaid and not completed, or a test customer's).
--
-- Found 2026-10-27 (owner approved the fix the same day):
--   * A customer can press Pay by card / Paidy on a STAFF-made order from her
--     website account (website GET /me/orders lists every cash order;
--     card-rules.ts / paidy-rules.ts apply "the method she chose" to web
--     orders only). Each try leaves square_card_attempts /
--     paidy_checkout_attempts rows that block the delete.
--   * TEST-900059 (test, cancelled) has a review invite that blocks its delete.
--
-- A. delete_cash_order_atomic (base = live md5 a805b62353dddad9ff54a5aa680d6a58):
--    - REFUSES when the order has any card/Paidy money record (square/paidy
--      payments, refunds, disputes, cases, card refund exceptions) or a try
--      still in progress — checked before the loyalty revoke. Message tells
--      staff to cancel it instead (shown as-is by the Hub; no edge change).
--    - DELETES ended tries without money (card declined/failed/cancelled/
--      risk_cancelled; Paidy abandoned/expired) and the review invite + review
--      (test orders only — completed real orders are refused earlier).
-- B. audit_delete_cleanup_invariants (base = live md5 08680aa28588d2fcf7ba736ee6c8e6ff,
--    applied 2026-10-25): cash_orders is checked as 'delete-cash-order' at
--    'critical' like the other two parents; allowlist rows for all 14 children.
--
-- No edge function change, no Lovable deploy. No data changed.
-- ===========================================================================

BEGIN;

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

  -- Card / Paidy records (2026-10-27). A customer can press Pay by card or
  -- Paidy on a STAFF-made order from her website account (card-rules.ts /
  -- paidy-rules.ts apply the chosen-method rule to web orders only), and every
  -- try leaves a row that blocks this delete. Checked BEFORE the loyalty revoke,
  -- because a refusal returns (it does not roll back).
  --   Refuse: any card/Paidy MONEY record, or a try still in progress —
  --   those are cancelled, never deleted (same rule as paid orders).
  --   Remove: tries that ended without money (card declined / failed /
  --   cancelled / risk_cancelled; Paidy abandoned / expired).
  IF EXISTS (SELECT 1 FROM public.square_payments WHERE cash_order_id = p_cash_order_id)
     OR EXISTS (SELECT 1 FROM public.paidy_payments WHERE cash_order_id = p_cash_order_id)
     OR EXISTS (SELECT 1 FROM public.square_refunds WHERE cash_order_id = p_cash_order_id)
     OR EXISTS (SELECT 1 FROM public.square_disputes WHERE cash_order_id = p_cash_order_id)
     OR EXISTS (SELECT 1 FROM public.paidy_refunds WHERE cash_order_id = p_cash_order_id)
     OR EXISTS (SELECT 1 FROM public.paidy_cases WHERE cash_order_id = p_cash_order_id)
     OR EXISTS (SELECT 1 FROM public.card_refund_exceptions WHERE cash_order_id = p_cash_order_id)
     OR EXISTS (SELECT 1 FROM public.square_card_attempts WHERE cash_order_id = p_cash_order_id
                  AND status NOT IN ('declined', 'failed', 'cancelled', 'risk_cancelled'))
     OR EXISTS (SELECT 1 FROM public.paidy_checkout_attempts WHERE cash_order_id = p_cash_order_id
                  AND status NOT IN ('abandoned', 'expired')) THEN
    RETURN jsonb_build_object('error', 'card_payment_records_exist', 'invoice_number', v_invoice_number,
      'message', 'INV ' || v_invoice_number || ' has a card or Paidy payment record (or one still in progress). Orders with card or Paidy payments are never deleted — cancel it with a reason instead.');
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
  -- Ended card / Paidy tries (no money — checked above) and the review invite
  -- + review (an invite exists only for a COMPLETED order, and completed real
  -- orders are refused by delete-cash-order and trg_prevent_paid_cash_order_delete,
  -- so only TEST orders reach this). 2026-10-27.
  DELETE FROM public.square_card_attempts WHERE cash_order_id = p_cash_order_id;
  DELETE FROM public.paidy_checkout_attempts WHERE cash_order_id = p_cash_order_id;
  DELETE FROM public.product_reviews WHERE invite_id IN (SELECT id FROM public.review_invites WHERE cash_order_id = p_cash_order_id);
  DELETE FROM public.review_invites WHERE cash_order_id = p_cash_order_id;
  DELETE FROM public.cash_orders WHERE id = p_cash_order_id;
  INSERT INTO public.audit_logs ( entity_type, entity_id, action, old_value_json, performed_by_user_id )
  VALUES ( 'cash_order', p_cash_order_id, 'delete',
    jsonb_build_object('invoice_number', v_invoice_number, 'total_amount', v_total_amount,
      'total_paid', v_total_paid, 'currency', v_currency, 'status', v_status,
      'customer_id', v_customer_id, 'payment_count', v_payment_count,
      'earned_points_revoked_tx', v_revoked_tx), v_audit_user_id );
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
      -- 2026-10-27: cash orders ARE deleted (delete-cash-order -> delete_cash_order_atomic)
      ('delete-cash-order', 'cash_orders', 'cash_payments', false, false),
      ('delete-cash-order', 'cash_orders', 'generated_invoices', false, false),
      ('delete-cash-order', 'cash_orders', 'payment_proofs', false, false),
      ('delete-cash-order', 'cash_orders', 'square_card_attempts', false, false),
      ('delete-cash-order', 'cash_orders', 'paidy_checkout_attempts', false, false),
      ('delete-cash-order', 'cash_orders', 'review_invites', false, false),
      -- money records / web-only rows: the delete is refused when they exist
      ('delete-cash-order', 'cash_orders', 'square_payments', false, true),
      ('delete-cash-order', 'cash_orders', 'square_refunds', false, true),
      ('delete-cash-order', 'cash_orders', 'square_disputes', false, true),
      ('delete-cash-order', 'cash_orders', 'paidy_payments', false, true),
      ('delete-cash-order', 'cash_orders', 'paidy_refunds', false, true),
      ('delete-cash-order', 'cash_orders', 'paidy_cases', false, true),
      ('delete-cash-order', 'cash_orders', 'card_refund_exceptions', false, true),
      ('delete-cash-order', 'cash_orders', 'web_order_drafts', false, true)
  ),
  parents (parent_table, delete_function) AS (
    VALUES
      ('layaway_accounts', 'delete-account'),
      ('customers', 'delete-customer'),
      ('cash_orders', 'delete-cash-order')
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
      'missing_cleanup' AS finding_type,
      'critical' AS severity,
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
