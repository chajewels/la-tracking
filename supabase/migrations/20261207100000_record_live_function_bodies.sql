-- Record-only (2026-10-10). Already applied on live — replaying is a no-op.
--
-- Why: these 25 functions were changed on live with md5-guarded IN-PLACE patches
-- (pg_temp.cj_guard in 20261130160000; pg_temp.cj_patch in 20261130180000,
-- 20261201100000, 20261204100000, 20261206100000). The function drift audit reads only
-- CREATE FUNCTION statements, so the repo's newest copy of each was the PRE-patch body
-- (a_differs = 25 on 2026-10-10). This file records each body exactly as live runs it.
--
-- How it was produced: a full local replay of supabase/migrations (scripts/
-- structure-drift-audit replay), then pg_get_functiondef of each function. Every one was
-- checked against LIVE before writing: md5(pg_get_functiondef) local = live, below.
-- The Paidy session paused function changes for this (owner, 2026-10-10 20:04 JST) and
-- confirmed its nine Paidy functions are final.
--
--   admin_keep_allocation_override       34589e1d39b82c4ae2e70b436e0161d0
--   audit_account                        15aecbb452a9204af7e3a2cbfba0f2c6
--   audit_all_accounts                   a8606b9c06dd90de079b73a55f3a21dc
--   audit_delete_cleanup_invariants      153d64fadfcc6371fa0e55d5f70d66f0
--   cancel_cash_order_atomic             25621d49d58e9cc9dc09c70e5f3928a8
--   decide_square_case                   bbda272649b8cc31e000b2dd61307507
--   expire_paidy_checkout_attempts       716032cb27863261535235e59e67dc07
--   file_paidy_submission_atomic         ac5e8b3d8fd01747de3258dd322398f2
--   finalize_cash_submission_atomic      5b2b352661e13c27116142f053746202
--   get_aging_buckets                    2132dfdf815028bd965509e5f26b513d
--   get_cash_orders_monthly              f803bcaf0fe60f2e1a07e8bb87c4eaea
--   get_forecast_6m                      c3cd3dc7217b9dff7d6d4aa184df24e6
--   get_forecast_drilldown               dfd33626026258ef2c5ac2ef25d2ebe8
--   get_monthly_analytics                14a48b463eb505766d510fa38c80fffb
--   get_monthly_sales                    9798341e4b75f262a173c2751cc60ef3
--   get_paidy_settings                   472ffbef691db786a0032ed87397458b
--   get_staff_performance                8f2d9dfc7878d815728c2af101e94581
--   get_trade_kpis                       c6f95e42eed4823b17d245409054a463
--   get_trade_monthly_trends             bc06913760c3f7ddd22d2c60b07ea91c
--   mark_web_order_refund_issued_atomic  0637d241d65fa7c04312b147d1c9601b
--   monthly_inflow_by_plan_6m            d8c8dffe3dc561f359aa49b75c687a49
--   record_paidy_refund                  24e72a805142ec2d53688cd1959c8483
--   reject_paidy_submission_atomic       f4d7bf17e446e83fd557f05046e57b32
--   resolve_paidy_case                   8b7320764367847c4cf8e2e85e8086ab
--   start_paidy_checkout_attempt         120cc7f2e3a104ede6b2c515983ca5f4
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

-- ---------------------------------------------------------------------------
-- admin_keep_allocation_override
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_keep_allocation_override(p_allocation_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.assert_staff_caller('edit_schedule');
  PERFORM set_config('app.bypass_allocation_ceiling', 'on', true);
  UPDATE payment_allocations
  SET allocated_amount = p_amount
  WHERE id = p_allocation_id;
END;
$function$;
-- ---------------------------------------------------------------------------
-- audit_account
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_account(p_invoice_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account layaway_accounts%ROWTYPE;
  v_total_paid numeric;
  v_active_penalties numeric;
  v_services numeric;
  v_canonical_remaining numeric;
  v_sum_bases numeric;
  v_sum_pending numeric;
  v_dp_paid numeric;
  v_dp_allocated numeric;
  v_unpaid_dp numeric;
  v_sum_schedule_paid numeric;
  v_paid_penalties numeric;
  v_waterfall_absorbed numeric;
  v_effective_unpaid_dp numeric;
  v_dp_overpaid numeric;
  v_checks jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.assert_staff_caller();
  SELECT * INTO v_account FROM layaway_accounts WHERE invoice_number = p_invoice_number;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Account not found');
  END IF;

  -- DP paid so far (detection: reference_number 'DP-%' or remarks ILIKE '%down%')
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_dp_paid
  FROM payments
  WHERE account_id = v_account.id AND voided_at IS NULL
    AND (reference_number LIKE 'DP-%' OR remarks ILIKE '%down%');

  -- CHANGED 2026-06-19: skip accounts with no downpayment payment yet (still onboarding)
  IF v_dp_paid = 0 THEN
    RETURN jsonb_build_object('invoice_number', p_invoice_number, 'status', v_account.status, 'all_pass', NULL, 'audit_skipped', true, 'skip_reason', 'No downpayment payment yet', 'checks', '[]'::jsonb);
  END IF;

  -- CHECK 1
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_total_paid FROM payments WHERE account_id = v_account.id AND voided_at IS NULL;
  v_checks := v_checks || jsonb_build_object('label', 'total_paid matches payments table', 'expected', v_total_paid, 'stored', v_account.total_paid, 'pass', ABS(v_total_paid - v_account.total_paid) < 1);

  -- CHECK 2
  SELECT COALESCE(SUM(pf.penalty_amount), 0) INTO v_active_penalties FROM penalty_fees pf WHERE pf.account_id = v_account.id AND pf.status != 'waived';
  SELECT COALESCE(SUM(amount), 0) INTO v_services FROM account_services WHERE account_id = v_account.id;
  v_canonical_remaining := v_account.total_amount + v_active_penalties - v_total_paid;
  v_checks := v_checks || jsonb_build_object('label', 'remaining_balance matches canonical formula', 'expected', v_canonical_remaining, 'stored', v_account.remaining_balance, 'pass', ABS(v_canonical_remaining - v_account.remaining_balance) < 1);

  -- CHECK 3
  SELECT COALESCE(SUM(ls.base_installment_amount), 0) INTO v_sum_bases FROM layaway_schedule ls WHERE ls.account_id = v_account.id AND ls.status != 'cancelled';
  v_checks := v_checks || jsonb_build_object('label', 'total_amount matches DP + sum of bases + services', 'expected', v_account.downpayment_amount + v_sum_bases + v_services, 'stored', v_account.total_amount, 'pass', ABS(v_account.total_amount - (v_account.downpayment_amount + v_sum_bases + v_services)) < 2);

  -- CHECK 4
  v_checks := v_checks || jsonb_build_object('label', 'no duplicate allocations', 'pass', NOT EXISTS (
    SELECT 1 FROM payments p JOIN payment_allocations pa ON pa.payment_id = p.id
    WHERE p.account_id = v_account.id AND p.voided_at IS NULL
    GROUP BY p.id, p.amount_paid HAVING COUNT(pa.id) > 1 AND SUM(pa.allocated_amount) > p.amount_paid + 1));

  -- CHECK 5
  v_checks := v_checks || jsonb_build_object('label', 'no orphaned allocations from voided payments', 'pass', NOT EXISTS (
    SELECT 1 FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    JOIN layaway_schedule ls ON ls.id = pa.schedule_id
    WHERE ls.account_id = v_account.id AND p.voided_at IS NOT NULL));

  -- CHECK 6
  v_checks := v_checks || jsonb_build_object('label', 'no schedule rows with paid_amount but no allocations', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = v_account.id AND ls.status != 'cancelled' AND ls.paid_amount > 0
    AND NOT EXISTS (SELECT 1 FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.schedule_id = ls.id AND p.voided_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM layaway_schedule dest WHERE dest.carried_from_schedule_id = ls.id AND dest.carried_amount > 0)));

  -- CHECK 7
  v_checks := v_checks || jsonb_build_object('label', 'schedule status consistent with allocations', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    LEFT JOIN (
      SELECT pa.schedule_id, SUM(pa.allocated_amount) AS total_allocated
      FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
      WHERE p.voided_at IS NULL GROUP BY pa.schedule_id
    ) alloc ON alloc.schedule_id = ls.id
    WHERE ls.account_id = v_account.id AND ls.status != 'cancelled'
    AND (
      (ls.status = 'paid' AND COALESCE(alloc.total_allocated,0) < (ls.total_due_amount - 1) AND NOT EXISTS (SELECT 1 FROM layaway_schedule dest WHERE dest.carried_from_schedule_id = ls.id AND dest.carried_amount > 0))
      OR (ls.status != 'paid' AND COALESCE(alloc.total_allocated,0) >= (ls.total_due_amount - 0.01) AND NOT (ls.total_due_amount = 0 AND COALESCE(ls.base_installment_amount,0) = 0 AND ls.installment_number > v_account.payment_plan_months))
    )));

  -- CHECK 8
  v_checks := v_checks || jsonb_build_object('label', 'schedule penalty_amount matches penalty_fees sum', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = v_account.id AND ls.status != 'cancelled'
    AND ABS(COALESCE(ls.penalty_amount,0) - COALESCE((SELECT SUM(pf.penalty_amount) FROM penalty_fees pf WHERE pf.schedule_id = ls.id AND pf.status != 'waived'),0)) > 0.01));

  -- CHECK 9
  v_checks := v_checks || jsonb_build_object('label', 'carried_amount consistent with source row shortfall', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    JOIN layaway_schedule src ON src.id = ls.carried_from_schedule_id
    WHERE ls.account_id = v_account.id AND ls.carried_amount > 0
    AND ABS(ls.carried_amount - (src.base_installment_amount + COALESCE(src.penalty_amount,0) + COALESCE(src.carried_amount,0) - src.paid_amount)) > 0.01));

  -- CHECK 10
  v_checks := v_checks || jsonb_build_object('label', 'no carry-over from unpaid source row', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    JOIN layaway_schedule src ON src.id = ls.carried_from_schedule_id
    WHERE ls.account_id = v_account.id AND ls.carried_amount > 0 AND src.paid_amount = 0));

  -- CHECK 11
  v_checks := v_checks || jsonb_build_object('label', 'no orphaned carried_amount without source reference', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = v_account.id AND ls.carried_amount > 0 AND ls.carried_from_schedule_id IS NULL AND ls.status != 'cancelled'));

  -- CHECK 12 (v2 — 2026-05-29): handles unpaid DP, partial overdue rows, and waterfall absorption
  SELECT COALESCE(SUM(
    CASE WHEN ls.status = 'partially_paid' THEN
      ls.total_due_amount - COALESCE((SELECT SUM(pa.allocated_amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.schedule_id = ls.id AND p.voided_at IS NULL), 0)
    ELSE
      GREATEST(0, ls.total_due_amount - COALESCE((SELECT SUM(pa.allocated_amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.schedule_id = ls.id AND p.voided_at IS NULL), 0))
    END
  ), 0) INTO v_sum_pending
  FROM layaway_schedule ls
  WHERE ls.account_id = v_account.id AND ls.status IN ('pending','overdue','partially_paid');

  v_unpaid_dp := GREATEST(0, v_account.downpayment_amount - v_dp_paid);
  SELECT COALESCE(SUM(paid_amount), 0) INTO v_sum_schedule_paid FROM layaway_schedule WHERE account_id = v_account.id AND status != 'cancelled';
  SELECT COALESCE(SUM(penalty_amount), 0) INTO v_paid_penalties FROM penalty_fees WHERE account_id = v_account.id AND status = 'paid';
  v_waterfall_absorbed := GREATEST(0, v_total_paid - v_dp_paid - v_sum_schedule_paid - v_paid_penalties);
  v_effective_unpaid_dp := GREATEST(0, v_unpaid_dp - v_waterfall_absorbed);
  v_sum_pending := v_sum_pending + v_effective_unpaid_dp;

  -- DP overage (2026-07-06, Bug #250): excess DP now WATERFALLS into schedule rows via allocate_payment_atomic, so it is already counted in v_sum_pending above. The prior subtraction here would double-count it. Removed.

  v_dp_allocated := COALESCE((SELECT SUM(pa.allocated_amount)
                     FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                     WHERE p.account_id = v_account.id AND p.voided_at IS NULL
                       AND (p.reference_number LIKE 'DP-%' OR p.remarks ILIKE '%down%')), 0);
  v_sum_pending := v_sum_pending - GREATEST(0, GREATEST(0, v_dp_paid - v_account.downpayment_amount) - v_dp_allocated);

  v_checks := v_checks || jsonb_build_object('label', 'sum of pending months matches remaining balance', 'expected', v_canonical_remaining, 'stored', v_sum_pending, 'pass', ABS(v_sum_pending - v_canonical_remaining) < 2);

  RETURN jsonb_build_object('invoice_number', p_invoice_number, 'status', v_account.status, 'all_pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_checks) c WHERE (c->>'pass')::boolean = false), 'audit_skipped', false, 'checks', v_checks);
END;
$function$;
-- ---------------------------------------------------------------------------
-- audit_all_accounts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.audit_all_accounts()
 RETURNS TABLE(invoice_number text, status text, all_pass boolean, failed_checks text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account RECORD;
  v_result JSONB;
  v_failed_checks text[];
  v_all_pass boolean;
  v_audit_skipped boolean;
BEGIN
  PERFORM public.assert_staff_caller();
  FOR v_account IN
    SELECT la.invoice_number
    FROM layaway_accounts la
    WHERE la.status NOT IN ('forfeited', 'final_forfeited', 'cancelled', 'completed')
    ORDER BY la.invoice_number
  LOOP
    SELECT audit_account(v_account.invoice_number) INTO v_result;

    v_audit_skipped := COALESCE((v_result->>'audit_skipped')::boolean, false);

    -- Skip rows where audit was not applicable
    IF v_audit_skipped THEN
      CONTINUE;
    END IF;

    v_all_pass := (v_result->>'all_pass')::boolean;

    SELECT ARRAY_AGG(c->>'label')
    INTO v_failed_checks
    FROM jsonb_array_elements(v_result->'checks') c
    WHERE (c->>'pass')::boolean = false;

    RETURN QUERY SELECT
      v_result->>'invoice_number',
      v_result->>'status',
      v_all_pass,
      COALESCE(v_failed_checks, ARRAY[]::text[]);
  END LOOP;
END;
$function$;
-- ---------------------------------------------------------------------------
-- audit_delete_cleanup_invariants
-- ---------------------------------------------------------------------------
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
      ('delete-customer', 'customers', 'customer_analytics', true, false),
      ('delete-customer', 'customers', 'layaway_accounts', false, true),
      ('delete-customer', 'customers', 'cash_orders', false, true),
      ('delete-customer', 'customers', 'extension_requests', false, false),
      ('delete-customer', 'customers', 'payment_submissions', false, false),
      ('delete-customer', 'customers', 'service_jobs', false, false),
      ('delete-customer', 'customers', 'trade_ins', false, false),
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
  -- QC PR-B L-1 (2026-10-10): the same rule terminate_web_order_atomic applies —
  -- never cancel while Paidy holds the order (an authorisation, a capture not
  -- recorded, a submission, or her open window) — the preview says the same.
  IF coalesce(public.cash_order_payment_lock(p_cash_order_id), '') LIKE 'paidy%' THEN
    RAISE EXCEPTION 'paidy_payment_unresolved: Paidy holds this order — Reject or record the Paidy payment first' USING ERRCODE='P0001';
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
      ELSIF public.square_order_disputed_jpy(v_order.id) > 0 THEN
        v_err := 'card_disputed';
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
-- expire_paidy_checkout_attempts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_paidy_checkout_attempts(p_cash_order_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.paidy_checkout_attempts a
     SET status = 'expired', ended_at = now(), end_reason = coalesce(a.end_reason, 'timeout'),
         -- PA04 (2026-10-08): the result is named honestly. verified_empty =
         -- the sweep read the window's payment back from Paidy and it holds
         -- nothing; unverified_no_id = the Hub never learned a payment id
         -- (callback and webhook both lost), so there was nothing to ask
         -- Paidy for — the lock is released on time alone and a late
         -- authorisation is still filed or released by the sweep.
         verification = CASE WHEN a.verified_empty_at IS NOT NULL THEN 'verified_empty' ELSE 'unverified_no_id' END
   WHERE a.status = 'open' AND a.expires_at <= now()
     AND (p_cash_order_id IS NULL OR a.cash_order_id = p_cash_order_id)
     -- A window that knows its payment id ends only once the sweep has
     -- verified with Paidy that it holds nothing (verified_empty_at).
     AND (a.paidy_payment_id IS NULL OR a.verified_empty_at IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM public.paidy_payments pp
        WHERE pp.cash_order_id = a.cash_order_id
          AND (pp.status = 'captured'
               OR (pp.status = 'authorized'
                   AND coalesce(pp.expires_at, pp.authorized_at + interval '30 days') > now()
                   AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                                    WHERE s.paidy_payment_id = pp.id AND s.status IN ('rejected','cancelled')))))
     -- PA04: ORDER-CORRELATED guard — only an unprocessed, unparked
     -- notification that names THIS order, or one the sweep has not yet
     -- classified, holds the window. A stuck event on another order never
     -- hides every customer's other payment methods; parked events (other
     -- environment, unknown id) never hold anything.
     AND NOT EXISTS (
       SELECT 1 FROM public.paidy_webhook_events e
        WHERE e.processed_at IS NULL AND e.parked_reason IS NULL
          AND e.received_at >= a.started_at
          AND (e.cash_order_id = a.cash_order_id
               -- L4 (Paidy QC 2026-10-09): an event not yet tied to any order
               -- holds a window for 2 hours at most, so a Paidy outage never
               -- freezes every customer's other payment methods.
               OR (e.cash_order_id IS NULL AND e.received_at > now() - interval '2 hours')));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$function$;
-- ---------------------------------------------------------------------------
-- file_paidy_submission_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_paidy_submission_atomic(p_cash_order_id uuid, p_customer_id uuid, p_paidy_payment_id text, p_amount_jpy numeric, p_test boolean, p_authorized_at timestamp with time zone, p_expires_at timestamp with time zone, p_payload jsonb, p_payment_date date, p_sender_name text, p_notes text, p_path text DEFAULT 'website_paidy'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_rec     public.paidy_payments%ROWTYPE;
  v_sub     public.payment_submissions%ROWTYPE;
  v_outcome text := 'created';
  v_lock    text;
BEGIN
  IF p_paidy_payment_id IS NULL OR p_paidy_payment_id !~ '^pay_[A-Za-z0-9_-]{6,80}$' THEN
    RETURN jsonb_build_object('error', 'bad_id');
  END IF;
  -- R14: exact whole yen, never a rounded comparison.
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 OR p_amount_jpy <> trunc(p_amount_jpy) THEN
    RETURN jsonb_build_object('error', 'bad_amount');
  END IF;

  -- The order lock serialises every Paidy filing and payment on this order.
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id
   FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;

  SELECT * INTO v_rec FROM public.paidy_payments WHERE paidy_payment_id = p_paidy_payment_id FOR UPDATE;
  IF v_rec.id IS NOT NULL THEN
    IF v_rec.cash_order_id <> v_order.id OR v_rec.customer_id IS DISTINCT FROM p_customer_id THEN
      RETURN jsonb_build_object('error', 'paidy_payment_other_order');
    END IF;
    -- Already filed and still live: the retry gets the same submission back.
    SELECT * INTO v_sub FROM public.payment_submissions
     WHERE paidy_payment_id = v_rec.id AND status IN ('submitted','under_review','confirmed')
     ORDER BY created_at DESC LIMIT 1;
    IF v_sub.id IS NOT NULL THEN
      UPDATE public.paidy_checkout_attempts
         SET status = 'filed', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = 'filed'
       WHERE cash_order_id = v_order.id AND status = 'open'
         -- QC PR-B M-2: a window noting a DIFFERENT approval stays open.
         AND NOT (authorization_noted_at IS NOT NULL AND verified_empty_at IS NULL
                  AND paidy_payment_id IS DISTINCT FROM p_paidy_payment_id);
      RETURN jsonb_build_object('ok', true, 'outcome', 'existing', 'paidy_record_id', v_rec.id,
        'submission', jsonb_build_object('id', v_sub.id, 'status', v_sub.status,
          'submitted_amount', v_sub.submitted_amount, 'payment_date', v_sub.payment_date));
    END IF;
    IF v_rec.status <> 'authorized' THEN
      RETURN jsonb_build_object('error', 'paidy_payment_not_authorized', 'status', v_rec.status);
    END IF;
    -- Rejected by a reviewer OR cancelled: a deliberate end, never recovered
    -- as an "interrupted filing" (R03).
    IF EXISTS (SELECT 1 FROM public.payment_submissions
                WHERE paidy_payment_id = v_rec.id AND status IN ('rejected','cancelled')) THEN
      RETURN jsonb_build_object('error', 'paidy_payment_rejected_by_reviewer');
    END IF;
    v_outcome := 'recovered';
  END IF;

  -- QC PR-B L-3 (2026-10-10): the environment is bound in the database too —
  -- a test payment only in test mode and only for an is_test customer; a live
  -- payment never in test mode. Never released from here (the other
  -- environment's money is not this Hub's to close).
  IF coalesce(p_test, false) <> (public.paidy_mode() = 'test')
     OR (coalesce(p_test, false) AND NOT EXISTS (SELECT 1 FROM public.customers c
                                                 WHERE c.id = p_customer_id AND c.is_test)) THEN
    RETURN jsonb_build_object('error', 'paidy_environment_mismatch', 'test', coalesce(p_test, false));
  END IF;

  -- The order must still be able to take THIS payment (R15: checked on the
  -- locked row, not on what the caller read before).
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'order_cannot_take_payment', 'status', v_order.status::text,
                              'payment_status', v_order.payment_status);
  END IF;
  IF v_order.currency::text <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'order_not_jpy');
  END IF;
  -- Owner 2026-10-04: Paidy only while nothing has been paid on the order.
  IF v_order.total_paid - public.cash_order_points_paid(v_order.id) <> 0 THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'order_part_paid');
  END IF;
  IF coalesce(v_rec.amount_jpy, p_amount_jpy) <> v_order.remaining_balance THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'amount_differs_from_balance',
                              'amount_jpy', coalesce(v_rec.amount_jpy, p_amount_jpy), 'remaining_balance', v_order.remaining_balance);
  END IF;
  IF coalesce(p_expires_at, v_rec.expires_at, coalesce(p_authorized_at, now()) + interval '30 days') <= now() THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'expired');
  END IF;

  -- M6 (Paidy QC 2026-10-09): a card payment in flight on this order wins.
  -- An authorisation arriving behind it is NOT written: a waiting Paidy row
  -- outranks the card in cash_order_payment_lock, so the card could be
  -- captured and then refused at recording. The caller releases it at Paidy.
  IF public.cash_order_payment_lock(v_order.id, v_rec.id, true) = 'card_payment_unresolved' THEN
    RETURN jsonb_build_object('error', 'card_payment_unresolved', 'lock', 'card_payment_unresolved');
  END IF;

  -- The record is written BEFORE the one-payment check, so an authorisation
  -- that has to wait is still known to the Hub (the sweep files or releases it).
  IF v_rec.id IS NULL THEN
    INSERT INTO public.paidy_payments (cash_order_id, customer_id, paidy_payment_id, status, test,
                                       amount_jpy, authorized_at, expires_at, last_payload)
    VALUES (v_order.id, p_customer_id, p_paidy_payment_id, 'authorized', coalesce(p_test, false),
            p_amount_jpy, coalesce(p_authorized_at, now()), p_expires_at, p_payload)
    RETURNING * INTO v_rec;
  ELSE
    UPDATE public.paidy_payments
       SET expires_at = coalesce(p_expires_at, expires_at),
           last_payload = coalesce(p_payload, last_payload),
           updated_at = now()
     WHERE id = v_rec.id
    RETURNING * INTO v_rec;
  END IF;

  -- One payment at a time per order: anything else pending, any other Paidy
  -- authorisation or capture still open (the customer's own open Paidy window
  -- is this payment, so attempts are ignored here).
  v_lock := public.cash_order_payment_lock(v_order.id, v_rec.id, true);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'submission_pending', 'lock', v_lock, 'paidy_record_id', v_rec.id);
  END IF;
  -- QC PR-B M-2 (owner 2026-10-10, first payment wins): her window already
  -- notes ANOTHER approval Paidy reported and nobody has verified it empty.
  -- That approval came first; this one waits for nothing — the caller
  -- releases it. (The noted one is filed when it arrives, or its window ends
  -- once the sweep verifies Paidy holds nothing.)
  IF EXISTS (SELECT 1 FROM public.paidy_checkout_attempts a
              WHERE a.cash_order_id = v_order.id AND a.status = 'open'
                AND a.authorization_noted_at IS NOT NULL AND a.verified_empty_at IS NULL
                AND a.paidy_payment_id IS DISTINCT FROM p_paidy_payment_id) THEN
    RETURN jsonb_build_object('error', 'submission_pending', 'lock', 'paidy_approval_noted', 'paidy_record_id', v_rec.id);
  END IF;

  INSERT INTO public.payment_submissions (account_id, cash_order_id, customer_id, submitted_amount,
         payment_date, payment_method, reference_number, sender_name, proof_url, notes, status,
         submission_type, paidy_payment_id)
  VALUES (NULL, v_order.id, p_customer_id, v_rec.amount_jpy, p_payment_date, 'paidy',
          v_rec.paidy_payment_id, p_sender_name, NULL, p_notes, 'submitted', 'cash_payment', v_rec.id)
  RETURNING * INTO v_sub;

  UPDATE public.paidy_checkout_attempts
     SET status = 'filed', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = 'filed'
   WHERE cash_order_id = v_order.id AND status = 'open'
     -- QC PR-B M-2 (2026-10-10): a window noting a DIFFERENT approval Paidy
     -- reported stays open — that approval is still on her Paidy limit and
     -- the sweep must verify it; overwriting it would forget it.
     AND NOT (authorization_noted_at IS NOT NULL AND verified_empty_at IS NULL
              AND paidy_payment_id IS DISTINCT FROM p_paidy_payment_id);

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
  VALUES ('cash_payment_submission', v_sub.id, 'submission_created',
          jsonb_build_object('cash_order_id', v_order.id, 'invoice_number', v_order.invoice_number,
            'amount', v_rec.amount_jpy, 'method', 'paidy', 'reference', v_rec.paidy_payment_id,
            'path', coalesce(p_path, 'website_paidy'), 'outcome', v_outcome));

  RETURN jsonb_build_object('ok', true, 'outcome', v_outcome, 'paidy_record_id', v_rec.id,
    'submission', jsonb_build_object('id', v_sub.id, 'status', v_sub.status,
      'submitted_amount', v_sub.submitted_amount, 'payment_date', v_sub.payment_date));
END
$function$;
-- ---------------------------------------------------------------------------
-- finalize_cash_submission_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_cash_submission_atomic(p_submission_id uuid, p_reviewer_user_id uuid, p_reviewer_notes text, p_date_paid date, p_submitted_by_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sub        public.payment_submissions%ROWTYPE;
  v_order      public.cash_orders%ROWTYPE;
  v_payment    public.cash_payments%ROWTYPE;
  v_rec        public.paidy_payments%ROWTYPE;
  v_amount     numeric;
  v_captured   numeric;
  v_capture_id text;
  v_new_paid   numeric;
  v_new_remain numeric;
  v_full       boolean;
  v_status_before text;
  v_status_after  text;
  v_sq         public.square_payments%ROWTYPE;
  v_ref_done   bigint := 0;
  v_ref_open   integer := 0;
  v_net_path   boolean := false;
BEGIN
  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;
  IF v_sub.id IS NULL THEN RETURN jsonb_build_object('error', 'submission_not_found'); END IF;
  IF v_sub.cash_order_id IS NULL THEN RETURN jsonb_build_object('error', 'not_a_cash_submission'); END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sub.cash_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'cash_order_not_found'); END IF;

  -- Idempotent: already recorded → return it, write nothing.
  IF v_sub.confirmed_payment_id IS NOT NULL THEN
    SELECT * INTO v_payment FROM public.cash_payments WHERE id = v_sub.confirmed_payment_id;
    RETURN jsonb_build_object('ok', true, 'outcome', 'already_recorded',
      'cash_payment', to_jsonb(v_payment), 'cash_order', to_jsonb(v_order),
      'new_total_paid', v_order.total_paid, 'new_remaining', v_order.remaining_balance,
      'is_fully_paid', v_order.remaining_balance <= 0.005, 'status_after', v_order.status::text);
  END IF;

  IF v_sub.status <> 'confirmed' THEN
    RETURN jsonb_build_object('error', 'not_claimed', 'status', v_sub.status::text);
  END IF;
  IF v_order.status::text IN ('cancelled', 'expired') THEN
    RETURN jsonb_build_object('error', 'order_closed', 'status', v_order.status::text);
  END IF;

  v_amount := v_sub.submitted_amount;
  IF v_amount IS NULL OR v_amount <= 0 THEN RETURN jsonb_build_object('error', 'bad_amount'); END IF;

  -- A Paidy payment is recorded only as Paidy's own capture, bound to THIS
  -- order, customer and exact amount, never refunded, never twice (R02/R14/R17).
  IF v_sub.paidy_payment_id IS NOT NULL OR v_sub.payment_method = 'paidy' THEN
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_sub.paidy_payment_id FOR UPDATE;
    IF v_rec.id IS NULL OR v_rec.status <> 'captured' THEN
      RETURN jsonb_build_object('error', 'paidy_not_captured');
    END IF;
    IF v_rec.cash_order_id <> v_order.id OR v_rec.customer_id IS DISTINCT FROM v_order.customer_id
       OR v_sub.customer_id IS DISTINCT FROM v_order.customer_id THEN
      RETURN jsonb_build_object('error', 'paidy_binding_mismatch');
    END IF;
    IF v_order.currency::text <> 'JPY' OR v_amount <> trunc(v_amount) OR v_rec.amount_jpy <> v_amount THEN
      RETURN jsonb_build_object('error', 'paidy_amount_mismatch', 'submitted', v_amount, 'authorized', v_rec.amount_jpy);
    END IF;
    SELECT coalesce(sum((c->>'amount')::numeric), 0) INTO v_captured
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_rec.last_payload->'captures') = 'array'
                                     THEN v_rec.last_payload->'captures' ELSE '[]'::jsonb END) c;
    IF v_captured <> v_amount THEN
      RETURN jsonb_build_object('error', 'paidy_amount_mismatch', 'submitted', v_amount, 'captured', v_captured);
    END IF;
    IF coalesce(v_rec.refund_jpy, 0) <> 0
       OR EXISTS (SELECT 1 FROM public.paidy_refunds WHERE paidy_payment_row = v_rec.id) THEN
      RETURN jsonb_build_object('error', 'paidy_refunded');
    END IF;
    v_capture_id := v_rec.capture_id;
    IF v_capture_id IS NULL THEN RETURN jsonb_build_object('error', 'paidy_not_captured'); END IF;
    IF EXISTS (SELECT 1 FROM public.cash_payments WHERE provider_capture_id = v_capture_id) THEN
      RETURN jsonb_build_object('error', 'capture_already_recorded');
    END IF;
  END IF;

  -- Square (2026-10-04, SQ08/SQ10/SQ12): card money is recorded only from a
  -- hold the Hub holds as CAPTURED, on this order and customer, in JPY, for
  -- exactly the captured integer yen, and only once (cash_payment_id). A card
  -- label without its hold, or a hold under another label, is refused.
  IF lower(coalesce(v_sub.payment_method, '')) = 'square' OR v_sub.square_payment_id IS NOT NULL THEN
    IF lower(coalesce(v_sub.payment_method, '')) <> 'square' OR v_sub.square_payment_id IS NULL THEN
      RETURN jsonb_build_object('error', 'square_link_mismatch');
    END IF;
    SELECT * INTO v_sq FROM public.square_payments WHERE id = v_sub.square_payment_id FOR UPDATE;
    IF v_sq.id IS NULL THEN RETURN jsonb_build_object('error', 'square_payment_missing'); END IF;
    IF v_sq.status <> 'captured' THEN
      RETURN jsonb_build_object('error', 'square_not_captured', 'square_status', v_sq.status);
    END IF;
    IF v_sq.cash_payment_id IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'square_already_allocated', 'cash_payment_id', v_sq.cash_payment_id);
    END IF;
    IF v_sq.cash_order_id <> v_order.id OR v_sq.customer_id IS DISTINCT FROM v_order.customer_id
       OR v_sq.customer_id IS DISTINCT FROM v_sub.customer_id THEN
      RETURN jsonb_build_object('error', 'square_order_mismatch');
    END IF;
    IF v_order.currency::text <> 'JPY' OR coalesce(v_sq.currency, 'JPY') <> 'JPY' THEN
      RETURN jsonb_build_object('error', 'square_currency_mismatch');
    END IF;
    IF public.square_order_disputed_jpy(v_order.id) > 0 THEN
      RETURN jsonb_build_object('error', 'card_disputed', 'disputed_jpy', public.square_order_disputed_jpy(v_order.id));
    END IF;
    -- QC01 (2026-10-05): money Square has refunded, or is refunding, is never
    -- credited in full. Completed refunds are summed (and refunded_money on
    -- the payment as a floor); a refund neither COMPLETED nor FAILED/REJECTED
    -- is pending. The only way to record the net is an explicit admin/finance
    -- decision (decide_square_case record_net_after_refund), which files a
    -- 'card_net_after_refund' submission for exactly captured − completed.
    SELECT coalesce(sum(amount_jpy) FILTER (WHERE status = 'COMPLETED'), 0),
           count(*) FILTER (WHERE status NOT IN ('COMPLETED','FAILED','REJECTED'))
      INTO v_ref_done, v_ref_open
      FROM public.square_refunds WHERE square_payment_row = v_sq.id;
    v_ref_done := greatest(v_ref_done, coalesce(v_sq.refund_jpy, 0)::bigint);
    v_net_path := v_sub.submission_type = 'card_net_after_refund'
                  AND v_sq.exception_decision = 'record_net_after_refund';
    IF v_ref_open > 0 OR (v_ref_done > 0 AND NOT v_net_path) THEN
      UPDATE public.square_payments
         SET exception = 'refunded_before_record', exception_at = now(),
             exception_note = 'Square reports a refund on this capture (completed ¥' || v_ref_done
                              || ', pending refunds ' || v_ref_open || ') — it was not recorded in full',
             exception_resolved_at = NULL, updated_at = now()
       WHERE id = v_sq.id AND (exception IS DISTINCT FROM 'refunded_before_record' OR exception_resolved_at IS NOT NULL);
      RETURN jsonb_build_object('error', 'square_refunded', 'refunded_jpy', v_ref_done, 'pending_refunds', v_ref_open);
    END IF;
    IF v_sq.captured_amount_jpy IS NULL OR v_amount <> trunc(v_amount)
       OR v_amount <> (v_sq.captured_amount_jpy - CASE WHEN v_net_path THEN v_ref_done ELSE 0 END)::numeric THEN
      RETURN jsonb_build_object('error', 'square_amount_mismatch',
        'captured_amount_jpy', v_sq.captured_amount_jpy, 'submitted_amount', v_amount,
        'refunded_jpy', v_ref_done, 'net_after_refund', v_net_path);
    END IF;
    -- QC03: the ledger row carries Square's payment id (unique), so one
    -- capture can never be credited twice and the cash_payments guard can
    -- check the row against its captured payment.
    v_capture_id := v_sq.square_payment_id;
    IF EXISTS (SELECT 1 FROM public.cash_payments WHERE provider_capture_id = v_capture_id) THEN
      RETURN jsonb_build_object('error', 'capture_already_recorded');
    END IF;
  END IF;

  -- INVARIANT 4 on the LOCKED balance.
  IF v_amount > v_order.remaining_balance + 0.005 THEN
    RETURN jsonb_build_object('error', 'exceeds_remaining',
      'submitted_amount', v_amount, 'remaining_balance', v_order.remaining_balance);
  END IF;

  -- The ledger guard accepts a card / Paidy row only inside this recording
  -- (transaction-local marker = the capture being recorded; review #6).
  PERFORM set_config('app.provider_recording', coalesce(v_capture_id, ''), true);
  INSERT INTO public.cash_payments (cash_order_id, amount_paid, currency, date_paid, payment_method,
         reference_number, remarks, entered_by_user_id, submitted_by_type, submitted_by_name, provider_capture_id)
  VALUES (v_order.id, v_amount, v_order.currency, coalesce(p_date_paid, v_sub.payment_date),
          v_sub.payment_method, v_sub.reference_number, v_sub.notes, p_reviewer_user_id,
          p_submitted_by_type, v_sub.sender_name, v_capture_id)
  RETURNING * INTO v_payment;
  PERFORM set_config('app.provider_recording', '', true);

  -- The card capture is now credited: bind it to this ledger row (unique).
  IF v_sq.id IS NOT NULL THEN
    UPDATE public.square_payments
       SET cash_payment_id = v_payment.id,
           -- recording the capture is what resolves its open exception (QC02)
           exception_resolved_at = CASE WHEN exception IS NOT NULL AND exception_resolved_at IS NULL THEN now() ELSE exception_resolved_at END,
           exception_resolved_by = CASE WHEN exception IS NOT NULL AND exception_resolved_at IS NULL THEN p_reviewer_user_id ELSE exception_resolved_by END,
           updated_at = now()
     WHERE id = v_sq.id;
  END IF;

  v_status_before := v_order.status::text;
  v_new_paid   := round(v_order.total_paid + v_amount, 2);
  v_new_remain := greatest(0, round(v_order.remaining_balance - v_amount, 2));
  v_full       := v_new_remain <= 0.005;
  v_status_after := CASE WHEN v_full THEN 'completed' ELSE v_status_before END;

  UPDATE public.cash_orders
     SET total_paid = v_new_paid,
         remaining_balance = v_new_remain,
         status = CASE WHEN v_full THEN 'completed'::public.cash_order_status ELSE status END,
         completed_at = CASE WHEN v_full THEN now() ELSE completed_at END
   WHERE id = v_order.id
  RETURNING * INTO v_order;

  UPDATE public.payment_submissions
     SET status = 'confirmed',
         reviewer_user_id = p_reviewer_user_id,
         reviewer_notes = nullif(p_reviewer_notes, ''),
         confirmed_payment_id = v_payment.id,
         processing_started_at = NULL,
         updated_at = now()
   WHERE id = v_sub.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_payment_submission', v_sub.id, 'confirm',
          jsonb_build_object('status', 'claimed', 'order_status', v_status_before),
          jsonb_build_object('cash_payment_id', v_payment.id, 'amount_confirmed', v_amount,
            'remaining_after', v_new_remain, 'status_after', v_status_after,
            'date_paid', v_payment.date_paid, 'provider_capture_id', v_capture_id,
            'path', 'finalize_cash_submission_atomic'),
          p_reviewer_user_id);

  RETURN jsonb_build_object('ok', true, 'outcome', 'recorded',
    'cash_payment', to_jsonb(v_payment), 'cash_order', to_jsonb(v_order),
    'new_total_paid', v_new_paid, 'new_remaining', v_new_remain,
    'is_fully_paid', v_full, 'status_after', v_status_after);
END
$function$;
-- ---------------------------------------------------------------------------
-- get_aging_buckets
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_aging_buckets(p_scope text DEFAULT 'all_collectible'::text)
 RETURNS TABLE(bucket text, currency text, account_count bigint, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT public.assert_staff_caller();
  WITH valid_statuses AS (
    SELECT CASE
      WHEN p_scope = 'active_flow'
        THEN ARRAY['active', 'overdue']
      ELSE ARRAY['active', 'overdue', 'extension_active', 'final_settlement']
    END AS statuses
  ),
  rows AS (
    SELECT
      a.id AS account_id,
      a.currency::text AS currency,
      GREATEST(
        0,
        (CURRENT_DATE AT TIME ZONE 'Asia/Manila')::date
        - (sw.due_date AT TIME ZONE 'Asia/Manila')::date
      ) AS days_overdue,
      sw.actual_remaining
    FROM schedule_with_actuals sw
    JOIN layaway_accounts a ON a.id = sw.account_id
    CROSS JOIN valid_statuses vs
    WHERE sw.computed_status IN ('pending', 'overdue', 'partially_paid')
      AND sw.actual_remaining > 0
      AND a.status::text = ANY(vs.statuses)
      AND a.is_test = false
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN days_overdue <= 0  THEN 'current'
        WHEN days_overdue <= 7  THEN 'd1_7'
        WHEN days_overdue <= 30 THEN 'd8_30'
        ELSE 'd31_plus'
      END AS bucket,
      currency,
      account_id,
      actual_remaining
    FROM rows
  )
  SELECT
    bucket,
    currency,
    COUNT(DISTINCT account_id) AS account_count,
    SUM(actual_remaining) AS amount
  FROM bucketed
  GROUP BY bucket, currency
  ORDER BY
    CASE bucket
      WHEN 'current'  THEN 1
      WHEN 'd1_7'     THEN 2
      WHEN 'd8_30'    THEN 3
      WHEN 'd31_plus' THEN 4
    END,
    currency;
$function$;
-- ---------------------------------------------------------------------------
-- get_cash_orders_monthly
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cash_orders_monthly()
 RETURNS TABLE(month date, cash_jpy numeric, order_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT public.assert_staff_caller();
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  )
  SELECT
    date_trunc('month', co.order_date)::date AS month,
    SUM(CASE WHEN co.currency = 'JPY' THEN co.total_amount
             WHEN co.currency = 'PHP' THEN co.total_amount / (SELECT r FROM rate)
             ELSE co.total_amount END) AS cash_jpy,
    COUNT(*)::bigint AS order_count
  FROM cash_orders co
  WHERE co.cancelled_at IS NULL
    AND co.is_test = false
    AND co.order_date >= DATE '2020-01-01'
  GROUP BY 1
  ORDER BY 1;
$function$;
-- ---------------------------------------------------------------------------
-- get_forecast_6m
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_forecast_6m()
 RETURNS TABLE(month date, currency text, installments bigint, remaining numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT public.assert_staff_caller();
  SELECT date_trunc('month', s.due_date)::date, a.currency::text, COUNT(*), SUM(s.actual_remaining)
  FROM schedule_with_actuals s
  JOIN layaway_accounts a ON a.id = s.account_id
  WHERE s.due_date < date_trunc('month', now()) + INTERVAL '7 months'
    AND s.computed_status IN ('pending', 'partially_paid', 'overdue')
    AND a.status IN ('active', 'overdue', 'final_settlement', 'extension_active')
    AND a.is_test = false
  GROUP BY 1, 2
  ORDER BY 1, 2;
$function$;
-- ---------------------------------------------------------------------------
-- get_forecast_drilldown
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_forecast_drilldown(p_month text)
 RETURNS TABLE(schedule_id uuid, due_date date, computed_status text, actual_remaining numeric, account_id uuid, invoice_number text, account_status text, currency text, customer_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT public.assert_staff_caller();
  WITH parsed AS (
    SELECT (p_month LIKE 'AGED:%') AS include_older,
           CASE WHEN p_month LIKE 'AGED:%' THEN substring(p_month FROM 6) ELSE p_month END AS ym
  ),
  bounds AS (
    SELECT (ym || '-01')::date AS month_start,
           ((ym || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS month_end,
           include_older
    FROM parsed
  )
  SELECT swa.id, swa.due_date, swa.computed_status::text, swa.actual_remaining,
         a.id, a.invoice_number, a.status::text, a.currency::text, c.full_name
  FROM schedule_with_actuals swa
  JOIN layaway_accounts a ON a.id = swa.account_id
  LEFT JOIN customers c ON c.id = a.customer_id
  CROSS JOIN bounds b
  WHERE swa.due_date <= b.month_end
    AND (b.include_older OR swa.due_date >= b.month_start)
    AND swa.computed_status IN ('pending', 'partially_paid', 'overdue')
    AND a.status IN ('active', 'overdue', 'final_settlement', 'extension_active')
    AND a.is_test = false
    AND swa.actual_remaining > 0
  ORDER BY swa.due_date ASC;
$function$;
-- ---------------------------------------------------------------------------
-- get_monthly_analytics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_monthly_analytics()
 RETURNS TABLE(month date, collected_jpy numeric, forfeited_jpy numeric, penalties_jpy numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
SELECT public.assert_staff_caller();
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r
    FROM system_settings
    WHERE key = 'php_jpy_rate'
  ),
  collected AS (
    SELECT
      date_trunc('month', p.date_paid)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN p.amount_paid
               WHEN a.currency = 'PHP' THEN p.amount_paid / (SELECT r FROM rate)
               ELSE p.amount_paid END) AS jpy
    FROM payments p
    JOIN layaway_accounts a ON a.id = p.account_id
    WHERE p.voided_at IS NULL
      AND a.is_test = false
    GROUP BY 1
  ),
  forfeited AS (
    SELECT
      date_trunc('month', a.updated_at)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN a.remaining_balance
               WHEN a.currency = 'PHP' THEN a.remaining_balance / (SELECT r FROM rate)
               ELSE a.remaining_balance END) AS jpy
    FROM layaway_accounts a
    WHERE a.status IN ('forfeited', 'final_forfeited')
      AND a.is_test = false
    GROUP BY 1
  ),
  penalties AS (
    SELECT
      date_trunc('month', pf.penalty_date)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN pf.penalty_amount
               WHEN a.currency = 'PHP' THEN pf.penalty_amount / (SELECT r FROM rate)
               ELSE pf.penalty_amount END) AS jpy
    FROM penalty_fees pf
    JOIN layaway_accounts a ON a.id = pf.account_id
    WHERE pf.status = 'paid'
      AND a.is_test = false
    GROUP BY 1
  ),
  all_months AS (
    SELECT month FROM collected
    UNION SELECT month FROM forfeited
    UNION SELECT month FROM penalties
  )
  SELECT
    m.month,
    COALESCE(c.jpy,   0) AS collected_jpy,
    COALESCE(f.jpy,   0) AS forfeited_jpy,
    COALESCE(pen.jpy, 0) AS penalties_jpy
  FROM all_months m
  LEFT JOIN collected  c   ON c.month = m.month
  LEFT JOIN forfeited  f   ON f.month = m.month
  LEFT JOIN penalties  pen ON pen.month = m.month
  ORDER BY 1;
$function$;
-- ---------------------------------------------------------------------------
-- get_monthly_sales
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_monthly_sales(currency_mode text DEFAULT 'ALL'::text, months_back integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.assert_staff_caller();
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.month ASC)
    FROM (
      SELECT
        TO_CHAR(DATE_TRUNC('month', la.order_date::DATE), 'Mon YYYY') AS month,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN currency_mode <> 'ALL' THEN la.total_amount
                 WHEN la.currency = 'JPY' THEN la.total_amount
                 WHEN la.currency = 'PHP' THEN la.total_amount / r.rate
                 ELSE la.total_amount END) AS total_sales_value
      FROM layaway_accounts la
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE la.is_test = false
        AND la.status <> 'cancelled'::account_status
        AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
        AND EXISTS (SELECT 1 FROM payments p WHERE p.account_id = la.id AND p.voided_at IS NULL)
        AND DATE_TRUNC('month', la.order_date::DATE) >= DATE_TRUNC('month', CURRENT_DATE - (months_back || ' months')::INTERVAL)
      GROUP BY DATE_TRUNC('month', la.order_date::DATE)
      ORDER BY DATE_TRUNC('month', la.order_date::DATE) ASC
    ) t
  );
END;
$function$;
-- ---------------------------------------------------------------------------
-- get_paidy_settings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_paidy_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_mode public.system_settings%ROWTYPE;
  v_key  public.system_settings%ROWTYPE;
  v_name text;
  v_by   uuid;
  v_at   timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role) OR public.has_permission(v_uid, 'admin_settings')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_mode FROM public.system_settings WHERE key = 'paidy_mode';
  SELECT * INTO v_key  FROM public.system_settings WHERE key = 'paidy_public_key';
  IF v_key.updated_at IS NOT NULL AND (v_mode.updated_at IS NULL OR v_key.updated_at > v_mode.updated_at)
     AND v_key.updated_by_user_id IS NOT NULL THEN
    v_by := v_key.updated_by_user_id; v_at := v_key.updated_at;
  ELSE
    v_by := v_mode.updated_by_user_id; v_at := v_mode.updated_at;
  END IF;
  IF v_by IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found',              v_mode.id IS NOT NULL AND v_key.id IS NOT NULL,
    'mode',               public.paidy_mode(),
    'raw_mode',           v_mode.value,
    'public_key',         coalesce(v_key.value #>> '{}', ''),
    'updated_at',         v_at,
    'updated_by_user_id', v_by,
    'updated_by_name',    v_name,
    'can_change',         public.has_role(v_uid, 'admin'::public.app_role),
    -- M7 (Paidy QC 2026-10-09): this environment's payments only — a test
    -- capture is never counted while live keys are in (or the reverse).
    'authorized_now',     (SELECT count(*) FROM public.paidy_payments
                            WHERE status = 'authorized' AND test = (public.paidy_mode() = 'test')),
    'captured_30d',       (SELECT count(*) FROM public.paidy_payments
                            WHERE status = 'captured' AND captured_at >= now() - interval '30 days'
                              AND test = (public.paidy_mode() = 'test')));
END
$function$;
-- ---------------------------------------------------------------------------
-- get_staff_performance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_staff_performance(months_back integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.assert_staff_caller();
  RETURN (
    SELECT jsonb_agg(row_to_json(t))
    FROM (
      SELECT 
        u.email AS staff_email,
        COUNT(ps.id) AS payments_confirmed,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (ps.updated_at - ps.created_at))/3600
        )::NUMERIC, 1) AS avg_confirmation_hours
      FROM payment_submissions ps
      JOIN auth.users u ON u.id = ps.reviewer_user_id
      WHERE ps.status = 'confirmed'
      AND ps.updated_at >= CURRENT_DATE - (months_back * 30 || ' days')::INTERVAL
      GROUP BY u.email
      ORDER BY payments_confirmed DESC
    ) t
  );
END;
$function$;
-- ---------------------------------------------------------------------------
-- get_trade_kpis
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_trade_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric;
  v_active_count int;
  v_total_count int;
  v_completed_count int;
  v_total_value_jpy numeric;
  v_all_accounts_count int;
  v_share_percent numeric;
BEGIN
  PERFORM public.assert_staff_caller();
  -- Canonical PHP→JPY rate (¥1 = ₱[rate]; divide PHP by rate to get JPY)
  -- Use #>> '{}' to handle both JSON string and JSON number storage
  SELECT (value #>> '{}')::numeric INTO v_rate
  FROM public.system_settings
  WHERE key = 'php_jpy_rate';
  v_rate := COALESCE(v_rate, 0.42);

  SELECT COUNT(*) INTO v_active_count
  FROM public.layaway_accounts
  WHERE is_trade = true
    AND status IN ('active','overdue','extension_active','reactivated');

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts
     WHERE is_trade = true AND status::text != 'cancelled')
    + (SELECT COUNT(*) FROM public.cash_orders
       WHERE is_trade = true AND status::text != 'cancelled')
  INTO v_total_count;

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts
     WHERE is_trade = true AND status = 'completed')
    + (SELECT COUNT(*) FROM public.cash_orders
       WHERE is_trade = true AND status = 'completed')
  INTO v_completed_count;

  SELECT
    COALESCE((
      SELECT SUM(
        CASE
          WHEN currency = 'JPY' THEN total_amount
          WHEN currency = 'PHP' THEN total_amount / v_rate
          ELSE total_amount
        END
      )
      FROM public.layaway_accounts
      WHERE is_trade = true AND status::text != 'cancelled'
    ), 0)
    + COALESCE((
      SELECT SUM(
        CASE
          WHEN currency = 'JPY' THEN total_amount
          WHEN currency = 'PHP' THEN total_amount / v_rate
          ELSE total_amount
        END
      )
      FROM public.cash_orders
      WHERE is_trade = true AND status::text != 'cancelled'
    ), 0)
  INTO v_total_value_jpy;

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts WHERE status::text != 'cancelled')
    + (SELECT COUNT(*) FROM public.cash_orders WHERE status::text != 'cancelled')
  INTO v_all_accounts_count;

  v_share_percent := CASE
    WHEN v_all_accounts_count = 0 THEN 0
    ELSE (v_total_count::numeric / v_all_accounts_count::numeric) * 100
  END;

  RETURN jsonb_build_object(
    'active_count', v_active_count,
    'total_count', v_total_count,
    'completed_count', v_completed_count,
    'total_value_jpy', ROUND(v_total_value_jpy),
    'share_percent', ROUND(v_share_percent, 2),
    'all_accounts_count', v_all_accounts_count
  );
END;
$function$;
-- ---------------------------------------------------------------------------
-- get_trade_monthly_trends
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_trade_monthly_trends(p_months_back integer DEFAULT 12)
 RETURNS TABLE(month text, trade_count integer, trade_value_jpy numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric; v_start_date date; v_end_date date;
BEGIN
  PERFORM public.assert_staff_caller();
  SELECT (value #>> '{}')::numeric INTO v_rate FROM public.system_settings WHERE key = 'php_jpy_rate';
  v_rate := COALESCE(v_rate, 0.42);
  v_start_date := date_trunc('month', (now() AT TIME ZONE 'Asia/Manila') - ((p_months_back - 1) || ' months')::interval)::date;
  v_end_date := (now() AT TIME ZONE 'Asia/Manila')::date;
  RETURN QUERY
  WITH all_months AS (
    SELECT to_char(generate_series(v_start_date, v_end_date, '1 month'::interval), 'YYYY-MM') AS month_key
  ),
  layaway_trades AS (
    SELECT to_char(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month_key,
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN currency = 'JPY' THEN total_amount
                    WHEN currency = 'PHP' THEN total_amount / v_rate
                    ELSE total_amount END) AS val_jpy
    FROM public.layaway_accounts
    WHERE is_trade = true
      AND is_test = false
      AND status::text != 'cancelled'
      AND EXISTS (SELECT 1 FROM public.payments p WHERE p.account_id = layaway_accounts.id AND p.voided_at IS NULL)
      AND COALESCE(order_date, created_at::date) >= v_start_date
      AND COALESCE(order_date, created_at::date) <= v_end_date
    GROUP BY month_key
  ),
  cash_trades AS (
    SELECT to_char(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month_key,
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN currency = 'JPY' THEN total_amount
                    WHEN currency = 'PHP' THEN total_amount / v_rate
                    ELSE total_amount END) AS val_jpy
    FROM public.cash_orders
    WHERE is_trade = true
      AND is_test = false
      AND status::text != 'cancelled'
      AND EXISTS (SELECT 1 FROM public.cash_payments cp WHERE cp.cash_order_id = cash_orders.id AND cp.voided_at IS NULL)
      AND COALESCE(order_date, created_at::date) >= v_start_date
      AND COALESCE(order_date, created_at::date) <= v_end_date
    GROUP BY month_key
  )
  SELECT am.month_key AS month,
         (COALESCE(lt.cnt, 0) + COALESCE(ct.cnt, 0))::int AS trade_count,
         ROUND(COALESCE(lt.val_jpy, 0) + COALESCE(ct.val_jpy, 0))::numeric AS trade_value_jpy
  FROM all_months am
  LEFT JOIN layaway_trades lt ON lt.month_key = am.month_key
  LEFT JOIN cash_trades ct ON ct.month_key = am.month_key
  ORDER BY am.month_key;
END;
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
    -- QC PR-B M-1 (2026-10-10): the same rule as terminate_web_order_atomic
    -- (paidy_refund_needs_dashboard) — marked issued only once Paidy's verified
    -- refunds cover the Paidy money; a partial refund keeps refund_pending.
    IF v_paidy_refunded < v_paidy_paid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'paidy_refund_incomplete',
        'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_jpy', v_paidy_refunded,
        'message', 'Paidy has refunded ¥' || to_char(v_paidy_refunded, 'FM999,999,999') || ' of ¥'
          || to_char(v_paidy_paid, 'FM999,999,999') || '. Refund the rest in the Paidy dashboard, then mark it.');
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
-- monthly_inflow_by_plan_6m
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.monthly_inflow_by_plan_6m()
 RETURNS TABLE(month text, payment_plan_months integer, jpy_total numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric;
  v_start_date date;
  v_end_date date;
BEGIN
  PERFORM public.assert_staff_caller();
  SELECT (value #>> '{}')::numeric INTO v_rate FROM system_settings WHERE key = 'php_jpy_rate';
  IF v_rate IS NULL OR v_rate <= 0 THEN v_rate := 0.42; END IF;
  v_start_date := date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date - interval '5 months')::date;
  v_end_date := (now() AT TIME ZONE 'Asia/Manila')::date;
  RETURN QUERY
  SELECT to_char(p.date_paid, 'YYYY-MM') AS month,
         la.payment_plan_months,
         SUM(CASE WHEN p.currency = 'JPY' THEN p.amount_paid ELSE ROUND(p.amount_paid / v_rate) END)::numeric AS jpy_total
  FROM payments p
  JOIN layaway_accounts la ON la.id = p.account_id
  WHERE p.voided_at IS NULL
    AND p.date_paid >= v_start_date
    AND p.date_paid <= v_end_date
    AND la.is_test = false
  GROUP BY 1, 2
  ORDER BY 1, 2;
END;
$function$;
-- ---------------------------------------------------------------------------
-- record_paidy_refund
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_paidy_refund(p_refund_id text, p_paidy_payment_row uuid, p_amount_jpy numeric, p_capture_id text, p_refunded_at timestamp with time zone, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rec    public.paidy_payments%ROWTYPE;
  v_order  public.cash_orders%ROWTYPE;
  v_new    boolean := false;
  v_total  numeric(12,2);
  v_credit numeric(12,2);
  v_bell   boolean := false;
BEGIN
  IF p_refund_id IS NULL OR btrim(p_refund_id) = '' THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_refund_id'); END IF;
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 OR p_amount_jpy <> trunc(p_amount_jpy) THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_amount'); END IF;
  -- Lock the ORDER first (the cancel RPCs hold the same lock), then the payment:
  -- a refund and a cancel serialise, and a cancel that lands first sees this refund.
  SELECT o.* INTO v_order FROM public.paidy_payments pp JOIN public.cash_orders o ON o.id = pp.cash_order_id
   WHERE pp.id = p_paidy_payment_row FOR UPDATE OF o;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_payment'); END IF;
  SELECT * INTO v_rec FROM public.paidy_payments WHERE id = p_paidy_payment_row FOR UPDATE;
  IF v_rec.status <> 'captured' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_captured', 'status', v_rec.status); END IF;
  IF p_capture_id IS NOT NULL AND v_rec.capture_id IS NOT NULL AND p_capture_id <> v_rec.capture_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'capture_mismatch', 'capture_id', v_rec.capture_id);
  END IF;

  INSERT INTO public.paidy_refunds (paidy_payment_row, cash_order_id, refund_id, amount_jpy, refunded_at, payload)
  VALUES (p_paidy_payment_row, v_order.id, p_refund_id, p_amount_jpy, p_refunded_at, COALESCE(p_payload, '{}'::jsonb))
  ON CONFLICT (refund_id) DO NOTHING;
  v_new := FOUND;

  SELECT COALESCE(SUM(amount_jpy), 0) INTO v_total FROM public.paidy_refunds WHERE paidy_payment_row = p_paidy_payment_row;
  IF v_total > v_rec.amount_jpy THEN
    -- More refunded than captured can only be a Paidy-side anomaly: keep the
    -- rows (they are Paidy's facts) but say so. QC PR-B L-5 (2026-10-10):
    -- refund_jpy still rises to the captured amount (monotonic), so a capture
    -- refunded in full never keeps its order locked.
    UPDATE public.paidy_payments SET refund_jpy = v_rec.amount_jpy, updated_at = now()
     WHERE id = p_paidy_payment_row AND (refund_jpy IS NULL OR refund_jpy < v_rec.amount_jpy);
    RETURN jsonb_build_object('ok', false, 'error', 'refund_exceeds_capture', 'refunded_jpy', v_total, 'captured_jpy', v_rec.amount_jpy, 'inserted', v_new);
  END IF;
  -- Monotonic: the ledger total never lowers a previously observed figure.
  UPDATE public.paidy_payments SET refund_jpy = v_total, updated_at = now()
   WHERE id = p_paidy_payment_row AND (refund_jpy IS NULL OR refund_jpy < v_total);

  -- Reconciliation (owner correction 2): a refund landing on an order that
  -- ALREADY holds a cancellation credit lot rings paidy_refund_after_credit
  -- once per refund — a human voids the lot (Settings → Store Credit).
  SELECT COALESCE(SUM(original_amount), 0) INTO v_credit FROM public.store_credit_lots l
   WHERE l.source_cash_order_id = v_order.id AND l.source_type = 'cancelled_cash' AND l.status <> 'voided';
  IF v_new AND v_credit > 0
     AND NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                      WHERE n.type = 'paidy_refund_after_credit' AND n.metadata ->> 'refund_id' = p_refund_id) THEN
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('paidy_refund_after_credit', 'Paidy refund on an order that already has store credit',
            COALESCE(v_order.web_reference, v_order.invoice_number) || ' · ¥' || p_amount_jpy::bigint || ' refunded in the Paidy dashboard (' || p_refund_id
              || ') but ¥' || v_credit::bigint || ' store credit was already issued on cancellation. Void the credit lot (Settings → Store Credit) or the customer is compensated twice.',
            v_order.customer_id, v_order.invoice_number,
            jsonb_build_object('refund_id', p_refund_id, 'paidy_payment_id', v_rec.paidy_payment_id, 'cash_order_id', v_order.id,
                               'refund_jpy', p_amount_jpy, 'credit_jpy', v_credit, 'refunded_total_jpy', v_total));
    v_bell := true;
  END IF;

  RETURN jsonb_build_object('ok', true, 'inserted', v_new, 'refunded_total_jpy', v_total,
                            'captured_jpy', v_rec.amount_jpy, 'remaining_jpy', v_rec.amount_jpy - v_total,
                            'credit_already_issued_jpy', v_credit, 'bell', v_bell);
END
$function$;
-- ---------------------------------------------------------------------------
-- reject_paidy_submission_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_paidy_submission_atomic(p_submission_id uuid, p_user_id uuid, p_notes text, p_paidy_row uuid, p_end_status text, p_end_reason text, p_payload jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sub      public.payment_submissions%ROWTYPE;
  v_order_id uuid;
  v_row      public.paidy_payments%ROWTYPE;
  v_n        integer := 0;
  v_key      text;
  v_followup uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required'); END IF;
  IF p_end_status IS NOT NULL AND p_end_status NOT IN ('closed', 'rejected', 'expired') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_end_status');
  END IF;

  -- V03-F1 (2026-10-09): ONE lock order everywhere — the submission, then the
  -- order, then the provider row — the order finalize_cash_submission_atomic,
  -- decide_square_case and apply_square_payment_state take. Locking the order
  -- first here (the old order) deadlocked against a Confirm recording the same
  -- capture (V03 race R3); now the later one waits and sees the earlier result.
  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;
  v_order_id := v_sub.cash_order_id;
  IF v_order_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  PERFORM 1 FROM public.cash_orders o WHERE o.id = v_order_id FOR UPDATE;
  IF v_sub.paidy_payment_id IS NULL OR v_sub.paidy_payment_id <> p_paidy_row THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_this_paidy_submission');
  END IF;
  IF v_sub.status = 'rejected' THEN
    RETURN jsonb_build_object('ok', true, 'already_rejected', true, 'submission_id', v_sub.id);
  END IF;
  -- R04: a Paidy Reject claims only a still-queued submission; a Confirm that
  -- claimed it (status confirmed) wins.
  IF v_sub.status NOT IN ('submitted', 'under_review') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'conflict', 'status', v_sub.status);
  END IF;

  SELECT * INTO v_row FROM public.paidy_payments WHERE id = p_paidy_row FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'paidy_row_missing'); END IF;
  -- A capture is terminal: never rejected here (the edge function refuses
  -- before calling; this is the database saying the same).
  IF v_row.status = 'captured' THEN RETURN jsonb_build_object('ok', false, 'error', 'paidy_captured'); END IF;
  -- QC PR-B L-2 (2026-10-10): never reopen the order while Paidy still holds a
  -- capturable authorisation — the caller ends it at Paidy and passes its end.
  IF p_end_status IS NULL AND v_row.status = 'authorized'
     AND coalesce(v_row.expires_at, v_row.authorized_at + interval '30 days') > now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'authorization_open');
  END IF;

  IF p_end_status IS NOT NULL THEN
    UPDATE public.paidy_payments
       SET status = p_end_status, closed_at = COALESCE(closed_at, now()),
           closed_reason = left(COALESCE(p_end_reason, 'rejected by reviewer'), 200),
           last_payload = COALESCE(p_payload, last_payload), updated_at = now()
     WHERE id = p_paidy_row AND status = 'authorized';
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;

  UPDATE public.payment_submissions
     SET status = 'rejected', reviewer_user_id = p_user_id, reviewer_notes = p_notes,
         customer_message = p_notes, processing_started_at = NULL, updated_at = now()
   WHERE id = p_submission_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, old_value_json, new_value_json)
  VALUES ('payment_submission', p_submission_id, 'submission_rejected', p_user_id,
          jsonb_build_object('status', v_sub.status),
          jsonb_build_object('status', 'rejected', 'reviewer_notes', p_notes, 'confirmed_payment_ids', '[]'::jsonb,
                             'allocation_count', 0, 'paidy_payment_id', v_row.paidy_payment_id,
                             'paidy_end_status', p_end_status, 'paidy_row_updated', v_n = 1, 'atomic', true));

  -- The customer email the Hub now owes (same key the sender uses).
  v_key := 'payment-rejected-' || p_submission_id::text;
  INSERT INTO public.payment_submission_followups (kind, submission_id, cash_order_id, idempotency_key, payload)
  VALUES ('paidy_rejected_email', p_submission_id, v_order_id, v_key,
          jsonb_build_object('kind', 'staff', 'reason', p_notes))
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_followup;
  IF v_followup IS NULL THEN
    SELECT id INTO v_followup FROM public.payment_submission_followups WHERE idempotency_key = v_key;
  END IF;

  RETURN jsonb_build_object('ok', true, 'submission_id', p_submission_id, 'cash_order_id', v_order_id,
                            'paidy_row_updated', v_n = 1, 'followup_id', v_followup, 'followup_key', v_key);
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
  v_order_id uuid;
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
    -- M3 (Paidy QC 2026-10-09): the shared lock order (V03-F1) — the order,
    -- then the Paidy row (no submission exists yet; this inserts one).
    SELECT cash_order_id INTO v_order_id FROM public.paidy_payments WHERE id = v_case.paidy_payment_row;
    PERFORM 1 FROM public.cash_orders WHERE id = v_order_id FOR UPDATE;
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    IF v_rec.id IS NULL OR v_rec.status <> 'captured' THEN RETURN jsonb_build_object('error', 'paidy_not_captured'); END IF;
    IF coalesce(v_rec.refund_jpy, 0) <> 0 THEN RETURN jsonb_build_object('error', 'paidy_refunded'); END IF;
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
    -- M3 (Paidy QC 2026-10-09): the shared lock order (V03-F1) — the
    -- submission(s), then the order, then the Paidy row.
    PERFORM 1 FROM public.payment_submissions
     WHERE paidy_payment_id = v_case.paidy_payment_row
       AND (status IN ('submitted','under_review') OR (status = 'confirmed' AND confirmed_payment_id IS NULL))
     ORDER BY id FOR UPDATE;
    SELECT cash_order_id INTO v_order_id FROM public.paidy_payments WHERE id = v_case.paidy_payment_row;
    PERFORM 1 FROM public.cash_orders WHERE id = v_order_id FOR UPDATE;
    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    -- M2 (Paidy QC 2026-10-09): never while Paidy still holds a capturable
    -- authorisation — ending the submission would reopen the order with the
    -- money still reserved (and capturable) at Paidy. The Hub closes it at
    -- Paidy first (paidy-staff-action close_authorization), then this runs.
    IF v_rec.status = 'authorized'
       AND coalesce(v_rec.expires_at, v_rec.authorized_at + interval '30 days') > now() THEN
      RETURN jsonb_build_object('error', 'authorization_open', 'paidy_payment_id', v_rec.paidy_payment_id);
    END IF;
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
-- start_paidy_checkout_attempt
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_paidy_checkout_attempt(p_cash_order_id uuid, p_customer_id uuid, p_ttl_minutes integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_lock    text;
  v_attempt public.paidy_checkout_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'order_cannot_take_payment');
  END IF;
  -- The customer chose how to pay at checkout (2026-10-05, owner C1): a
  -- website order takes Paidy only when Paidy is its method; staff change it.
  IF v_order.source_channel = 'web' AND coalesce(v_order.payment_method, 'transfer') <> 'paidy' THEN
    RETURN jsonb_build_object('error', 'method_not_chosen', 'payment_method', coalesce(v_order.payment_method, 'transfer'));
  END IF;
  IF v_order.currency::text <> 'JPY' OR v_order.total_paid - public.cash_order_points_paid(v_order.id) <> 0
     OR v_order.remaining_balance <= 0 OR v_order.remaining_balance <> trunc(v_order.remaining_balance) THEN
    RETURN jsonb_build_object('error', 'paidy_not_offered');
  END IF;

  -- P04 (2026-10-08): a timed-out window ends only when Paidy may hold
  -- nothing for the order (expire_paidy_checkout_attempts); ANY open window
  -- of hers (closed, or left open in a lost tab — QA 2026-10-08) is replaced
  -- by the one she opens now — the lock carries over to it, nothing is
  -- released.
  PERFORM public.expire_paidy_checkout_attempts(v_order.id);
  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now(),
         end_reason = coalesce(end_reason, 'replaced')
   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id
     AND status = 'open'
     -- Second-hold fix (2026-10-10): a window holding a payment Paidy
     -- APPROVED that the Hub has not filed is never replaced; the lock below
     -- then refuses (paidy_checkout_open) until the sweep files it or
     -- verifies Paidy holds nothing.
     AND NOT (authorization_noted_at IS NOT NULL AND verified_empty_at IS NULL);

  v_lock := public.cash_order_payment_lock(v_order.id);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', v_lock);
  END IF;

  BEGIN
    INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, amount_jpy, expires_at)
    VALUES (v_order.id, p_customer_id, v_order.remaining_balance,
            now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes, 30), 60))))
    RETURNING * INTO v_attempt;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', 'paidy_checkout_open');
  END;
  RETURN jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'expires_at', v_attempt.expires_at,
                            'amount_jpy', v_attempt.amount_jpy);
END
$function$;