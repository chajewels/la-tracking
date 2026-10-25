-- ===========================================================================
-- System Audit timeout: audit_account CHECK 7 sums allocations per row.
--
-- Before: CHECK 7 ("schedule status consistent with allocations") joined each
-- schedule row to a derived table that summed EVERY payment allocation in the
-- database (8,368 rows on 2026-10-25), once per account. audit_all_accounts
-- calls audit_account for every open layaway account (531), so the Dashboard
-- "Run System Audit" took 12.7 s and was cancelled by the authenticated role's
-- 8 s statement_timeout ("canceling statement due to statement timeout").
--
-- After: CHECK 7 sums only that schedule row's allocations (LEFT JOIN LATERAL
-- on pa.schedule_id, served by the existing schedule_id indexes). Verified
-- before release: old vs new output identical for all 531 audited accounts;
-- full run ~1.6 s.
--
-- Unchanged: every other check, the labels, tolerances, skip rule, return
-- shape, SECURITY DEFINER, search_path and the assert_staff_caller() guard.
-- Base body = live definition (md5 15aecbb452a9204af7e3a2cbfba0f2c6), recorded
-- in 20261207100000_record_live_function_bodies.sql.
-- ===========================================================================

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
    -- Per-row sum (2026-10-25): the old derived table summed EVERY allocation
    -- in the database for each account (~17 ms each, 12.7 s for 531 accounts),
    -- which tripped the 8 s statement timeout for staff. Same result per row.
    LEFT JOIN LATERAL (
      SELECT SUM(pa.allocated_amount) AS total_allocated
      FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
      WHERE pa.schedule_id = ls.id AND p.voided_at IS NULL
    ) alloc ON true
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
