-- Record-only (2026-09-17). Captured from live via pg_get_functiondef — already applied;
-- replaying is a no-op.
--
-- functions whose live body had drifted from the newest repo copy
--
-- Captured at 2026-09-17 06:07:24.874502+00. Every body below is byte-for-byte the pg_get_functiondef output, with a
-- terminating semicolon added. The md5 and length in each per-function comment are of that
-- output, so any one of them can be re-verified against live at any time:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = '<fn>';
--
-- GRANTS ARE NOT TOUCHED. pg_get_functiondef does not emit them and none is added here; the
-- live ACL is recorded in each comment as observed (pg_proc.proacl) and nothing more.
--
-- Bucket (a) of the drift audit, minus the four in 20260917070000. Every one of these was
-- changed live and never committed, so the repo's newest copy was stale. Each is the live
-- body as of the capture below — nothing here is a proposal.
--
-- Worth knowing what some of them carry, because a rebuild from the old repo copy would
-- silently undo it (see docs/sql/live-snapshots/2026-09-17/DIFF-FINDINGS.md):
--
--   create_web_order_atomic       deposit deadline = make_interval(hours =>
--   create_web_layaway_atomic       public.web_deposit_deadline_hours(p_customer_id)).
--                                 The repo copies still hardcode interval '72 hours'.
--   terminate_web_order_atomic    auto-expiry reason reads "not received by the deadline",
--                                 not "within 72 hours".
--   consume_lots_fifo             carries the whole Bug #244 fix (AND lots.revoked_at IS NULL).
--   void_redemption_atomic        carries the restore + synthetic top-up block.
--   audit_account                 subtracts only the UNALLOCATED DP overage (Bug #233 plus a
--                                 later v_dp_allocated refinement with no separate record).
--   allocate_payment_atomic       the Bug #250 DP-excess computation.
--   get_recent_qualifying_order   the Bug #256 cash branch (OR co.loyalty_jpy_amount IS NULL).
--   admin_update_schedule_base    the Bug #254 status recompute.
--   loyalty_integrity_report      NOT in this file. 20260917070000_relot_wire_redemption_and_birthday.sql
--                                 was applied to live at ~06:10 on 2026-09-17 and now defines
--                                 it (predicate 6 included), so repo and live already agree.
--   notify_website_revalidate     differs from the repo only in comments and layout; recorded
--   reactivate_web_layaway_atomic   for completeness so the audit reads zero.

-- ─────────────────────────────────────────────────────────────────────────────
-- public.admin_update_schedule_base(p_schedule_id uuid, p_new_base numeric, p_new_total_due numeric, p_is_paid boolean)
--   md5    : 5669e145dd72eb3a00467c3ab6c08c76
--   length : 2182 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_update_schedule_base(p_schedule_id uuid, p_new_base numeric, p_new_total_due numeric, p_is_paid boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id  uuid;
  v_allocated   numeric;
  v_total_due   numeric;
  v_status      schedule_status;
BEGIN
  PERFORM set_config('app.bypass_immutable_schedule_cols', 'on', true);
  UPDATE layaway_schedule
  SET
    base_installment_amount = p_new_base,
    total_due_amount        = p_new_total_due,
    paid_amount             = CASE WHEN p_is_paid THEN p_new_total_due
                                   ELSE paid_amount END
  WHERE id = p_schedule_id
  RETURNING account_id, total_due_amount, status
  INTO v_account_id, v_total_due, v_status;

  IF v_account_id IS NULL THEN
    RETURN;
  END IF;

  -- Bug #253: changing the base changes the denominator, so a row whose
  -- existing allocations now fully cover total_due_amount must be re-marked
  -- 'paid'. UPWARD ONLY — never downgrades a 'paid' row (that case is left
  -- for audit_account CHECK 7 ARM A to surface for human review).
  SELECT COALESCE(SUM(pa.allocated_amount), 0)
  INTO v_allocated
  FROM payment_allocations pa
  JOIN payments p ON p.id = pa.payment_id
  WHERE pa.schedule_id = p_schedule_id
    AND p.voided_at IS NULL;

  IF v_status NOT IN ('paid', 'cancelled')
     AND v_total_due > 0
     AND v_allocated >= v_total_due - 0.01 THEN
    UPDATE layaway_schedule
    SET status      = 'paid',
        paid_amount = v_allocated
    WHERE id = p_schedule_id;

    -- Account may now be fully settled. Guarded: zero balance, fully paid,
    -- and no schedule row left open.
    UPDATE layaway_accounts la
    SET status       = 'completed',
        completed_at = COALESCE(la.completed_at, now())
    WHERE la.id = v_account_id
      AND la.status IN ('active', 'overdue')
      AND la.remaining_balance <= 0.01
      AND la.total_paid >= la.total_amount - 0.01
      AND NOT EXISTS (
        SELECT 1 FROM layaway_schedule ls
        WHERE ls.account_id = la.id
          AND ls.status NOT IN ('paid', 'cancelled')
      );
  END IF;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.allocate_payment_atomic(p_account_id uuid, p_amount_paid numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_remarks text, p_user_id uuid, p_currency text, p_is_downpayment boolean, p_submitted_by_type text, p_submitted_by_name text, p_preview boolean)
--   md5    : 77aca9392fecf08824b765c02025e014
--   length : 11179 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.allocate_payment_atomic(p_account_id uuid, p_amount_paid numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_remarks text, p_user_id uuid, p_currency text, p_is_downpayment boolean DEFAULT false, p_submitted_by_type text DEFAULT 'staff'::text, p_submitted_by_name text DEFAULT NULL::text, p_preview boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Verbatim translation of review-payment-submission allocatePaymentToAccount
-- (the SINGLE live payment-write path per CLAUDE.md §1299 / Bug #219).
-- Row-scoped waterfall (STEP A-D), carry-over guard, Keep-credit ceiling.
-- INVARIANT 11 (2026-07-06, Bug #250): DP up to downpayment_amount does NOT
-- allocate; DP paid in EXCESS of downpayment_amount waterfalls into installments
-- (Month 1 onward) exactly like an installment payment. Only the excess portion
-- of a DP payment is fed into the waterfall; the required portion is recorded as
-- a payment (INVARIANT 1) but creates no schedule allocation.
DECLARE
  v_remaining     numeric := round(p_amount_paid, 2);
  v_allocations   jsonb := '[]'::jsonb;
  v_pen_updates   jsonb := '[]'::jsonb;
  v_sched_updates jsonb := '[]'::jsonb;
  rec             record;
  pen             record;
  v_next_carried  numeric;
  v_row_pen       numeric;
  v_to_pay        numeric;
  v_already       numeric;
  v_natural       numeric;
  v_ceiling       numeric;
  v_due           numeric;
  v_apply         numeric;
  v_new_paid      numeric;
  v_fully         boolean;
  v_paid_amt      numeric;
  v_row_status    text;
  v_payment_id    uuid := NULL;
  v_total_paid    numeric;
  v_pen_active    numeric;
  v_total_amount  numeric;
  v_cur_status    text;
  v_new_remaining numeric;
  v_new_status    text;
  v_has_overdue   boolean;
  elem            jsonb;
  merged          record;
  v_dp_required   numeric;
  v_dp_paid_before numeric;
  v_dp_excess     numeric;
BEGIN
  IF p_account_id IS NULL OR p_amount_paid IS NULL OR p_amount_paid <= 0 THEN
    RAISE EXCEPTION 'invalid_input: account_id and positive amount required';
  END IF;

  -- ── DP excess split (INVARIANT 11, 2026-07-06) ──
  -- For a DP payment, only the portion beyond the required downpayment_amount
  -- enters the waterfall. Prior non-voided DP payments count toward the required
  -- amount (canonical DP heuristic: reference_number 'DP-%' OR remarks ILIKE
  -- '%down%'). For a non-DP payment, the full amount waterfalls as before.
  IF p_is_downpayment THEN
    SELECT coalesce(downpayment_amount, 0) INTO v_dp_required
    FROM layaway_accounts WHERE id = p_account_id;

    SELECT coalesce(sum(amount_paid), 0) INTO v_dp_paid_before
    FROM payments
    WHERE account_id = p_account_id
      AND voided_at IS NULL
      AND (reference_number LIKE 'DP-%' OR remarks ILIKE '%down%');

    -- excess carried by THIS payment = how much (prior DP + this) exceeds required,
    -- capped at this payment's amount
    v_dp_excess := least(
      round(p_amount_paid, 2),
      greatest(0, round((v_dp_paid_before + p_amount_paid) - v_dp_required, 2))
    );
    v_remaining := v_dp_excess;
  END IF;

  -- ── Waterfall ──
  -- Runs for all installment payments, and for the DP EXCESS portion (v_remaining
  -- set above). Pure within-DP payments have v_remaining = 0 → loop is a no-op,
  -- preserving INVARIANT 11 for the required downpayment.
  IF (NOT p_is_downpayment) OR v_remaining > 0 THEN
    FOR rec IN
      SELECT * FROM layaway_schedule
      WHERE account_id = p_account_id
        AND status NOT IN ('paid','cancelled')
      ORDER BY installment_number ASC
    LOOP
      EXIT WHEN v_remaining <= 0;

      -- Carry-over guard: if NEXT row already holds carried_amount, this row
      -- was administratively closed via carry-over — skip it.
      SELECT carried_amount INTO v_next_carried
      FROM layaway_schedule
      WHERE account_id = p_account_id
        AND installment_number = rec.installment_number + 1;
      IF coalesce(v_next_carried, 0) > 0.005 THEN
        CONTINUE;
      END IF;

      -- STEP A — this row's unpaid penalties only (penalty_date ASC)
      v_row_pen := 0;
      FOR pen IN
        SELECT id, penalty_amount FROM penalty_fees
        WHERE account_id = p_account_id
          AND status = 'unpaid'
          AND schedule_id = rec.id
        ORDER BY penalty_date ASC
      LOOP
        EXIT WHEN v_remaining <= 0;
        v_to_pay    := round(least(v_remaining, pen.penalty_amount), 2);
        v_remaining := v_remaining - v_to_pay;
        v_row_pen   := v_row_pen + v_to_pay;
        v_allocations := v_allocations || jsonb_build_object(
          'schedule_id', rec.id, 'allocation_type', 'penalty',
          'allocated_amount', v_to_pay);
        v_pen_updates := v_pen_updates || jsonb_build_object(
          'id', pen.id,
          'status', CASE WHEN v_to_pay >= pen.penalty_amount THEN 'paid' ELSE 'unpaid' END);
      END LOOP;

      EXIT WHEN v_remaining <= 0;

      -- STEP B — this row's base installment.
      SELECT coalesce(sum(pa.allocated_amount), 0) INTO v_already
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa.payment_id
      WHERE pa.schedule_id = rec.id AND p.voided_at IS NULL;

      v_natural := rec.base_installment_amount
                 + coalesce(rec.penalty_amount, 0)
                 + coalesce(rec.carried_amount, 0);
      v_ceiling := CASE WHEN rec.total_due_amount IS NOT NULL AND rec.total_due_amount <> 0
                        THEN least(v_natural, rec.total_due_amount)
                        ELSE v_natural END;
      v_due := greatest(0, v_ceiling - v_already - v_row_pen);
      IF v_due <= 0 THEN CONTINUE; END IF;

      v_apply    := round(least(v_remaining, v_due), 2);
      v_new_paid := v_already + v_apply;
      v_fully    := (v_new_paid + v_row_pen >= v_ceiling - 0.005);

      IF v_fully AND rec.status = 'partially_paid' THEN
        v_paid_amt := v_ceiling; v_row_status := 'paid';
      ELSIF v_fully THEN
        v_paid_amt := v_new_paid; v_row_status := 'paid';
      ELSE
        v_paid_amt := v_new_paid; v_row_status := 'partially_paid';
      END IF;
      v_allocations := v_allocations || jsonb_build_object(
        'schedule_id', rec.id, 'allocation_type', 'installment',
        'allocated_amount', v_apply);
      v_sched_updates := v_sched_updates || jsonb_build_object(
        'id', rec.id, 'paid_amount', v_paid_amt, 'status', v_row_status);

      v_remaining := v_remaining - v_apply;
      EXIT WHEN v_remaining <= 0;
    END LOOP;
  END IF;

  -- ── Merge penalty allocations per schedule_id (unique-constraint safety) ──
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_allocations
  FROM (
    SELECT jsonb_build_object(
             'schedule_id', a->>'schedule_id',
             'allocation_type', 'penalty',
             'allocated_amount', sum((a->>'allocated_amount')::numeric)) AS x
    FROM jsonb_array_elements(v_allocations) a
    WHERE a->>'allocation_type' = 'penalty'
    GROUP BY a->>'schedule_id'
    UNION ALL
    SELECT a FROM jsonb_array_elements(v_allocations) a
    WHERE a->>'allocation_type' = 'installment'
  ) m;

  -- ── Derived totals (INVARIANT 1: SUM of non-voided payments) ──
  SELECT coalesce(sum(amount_paid), 0) INTO v_total_paid
  FROM payments WHERE account_id = p_account_id AND voided_at IS NULL;
  SELECT coalesce(sum(penalty_amount), 0) INTO v_pen_active
  FROM penalty_fees WHERE account_id = p_account_id AND status <> 'waived';
  SELECT total_amount, status::text INTO v_total_amount, v_cur_status
  FROM layaway_accounts WHERE id = p_account_id;
  IF v_total_amount IS NULL THEN
    RAISE EXCEPTION 'account_not_found: %', p_account_id;
  END IF;

  -- ── PREVIEW MODE: return the plan, write NOTHING ──
  IF p_preview THEN
    v_total_paid    := v_total_paid + round(p_amount_paid, 2);
    v_new_remaining := greatest(0, round(v_total_amount + v_pen_active - v_total_paid, 2));
    v_new_status := CASE WHEN v_new_remaining <= 0 THEN 'completed' ELSE v_cur_status END;
    RETURN jsonb_build_object(
      'preview', true, 'payment_id', NULL,
      'allocations', v_allocations,
      'penalty_updates', v_pen_updates,
      'schedule_updates', v_sched_updates,
      'new_total_paid', v_total_paid,
      'new_remaining_balance', v_new_remaining,
      'new_status', v_new_status);
  END IF;

  -- ── WRITE MODE: all writes below commit or roll back together ──
  INSERT INTO payments (
    account_id, amount_paid, currency, date_paid, payment_method,
    reference_number, remarks, entered_by_user_id,
    submitted_by_type, submitted_by_name
  ) VALUES (
    p_account_id, p_amount_paid, p_currency::account_currency, p_payment_date,
    p_payment_method, p_reference_number, p_remarks, p_user_id,
    p_submitted_by_type, p_submitted_by_name
  ) RETURNING id INTO v_payment_id;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_allocations) LOOP
    INSERT INTO payment_allocations (payment_id, schedule_id, allocation_type, allocated_amount)
    VALUES (v_payment_id, (elem->>'schedule_id')::uuid,
            (elem->>'allocation_type')::allocation_type,
            (elem->>'allocated_amount')::numeric);
  END LOOP;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_pen_updates) LOOP
    UPDATE penalty_fees
    SET status = (elem->>'status')::penalty_fee_status
    WHERE id = (elem->>'id')::uuid;
  END LOOP;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_sched_updates) LOOP
    UPDATE layaway_schedule
    SET paid_amount = (elem->>'paid_amount')::numeric,
        status      = (elem->>'status')::schedule_status
    WHERE id = (elem->>'id')::uuid;
  END LOOP;

  SELECT coalesce(sum(amount_paid), 0) INTO v_total_paid
  FROM payments WHERE account_id = p_account_id AND voided_at IS NULL;
  SELECT coalesce(sum(penalty_amount), 0) INTO v_pen_active
  FROM penalty_fees WHERE account_id = p_account_id AND status <> 'waived';
  v_new_remaining := greatest(0, round(v_total_amount + v_pen_active - v_total_paid, 2));

  v_new_status := NULL;
  IF v_new_remaining <= 0 THEN
    v_new_status := 'completed';
  ELSIF v_cur_status IN ('active','overdue') THEN
    SELECT EXISTS (
      SELECT 1 FROM layaway_schedule
      WHERE account_id = p_account_id
        AND status NOT IN ('paid','cancelled')
        AND due_date < CURRENT_DATE
    ) INTO v_has_overdue;
    v_new_status := CASE WHEN v_has_overdue THEN 'overdue' ELSE 'active' END;
  END IF;

  IF v_new_status IS NOT NULL THEN
    UPDATE layaway_accounts
    SET total_paid = v_total_paid, remaining_balance = v_new_remaining,
        status = v_new_status::account_status
    WHERE id = p_account_id;
  ELSE
    UPDATE layaway_accounts
    SET total_paid = v_total_paid, remaining_balance = v_new_remaining
    WHERE id = p_account_id;
  END IF;

  RETURN jsonb_build_object(
    'preview', false, 'payment_id', v_payment_id,
    'allocations', v_allocations,
    'penalty_updates', v_pen_updates,
    'schedule_updates', v_sched_updates,
    'new_total_paid', v_total_paid,
    'new_remaining_balance', v_new_remaining,
    'new_status', coalesce(v_new_status, v_cur_status));
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.audit_account(p_invoice_number text)
--   md5    : eec1d67d7605bd60f035b4695d8cb173
--   length : 9131 bytes
--   acl    : postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- public.consume_lots_fifo(p_member_id uuid, p_redemption_id uuid, p_amount integer)
--   md5    : 103778b2ca1c2a85c530032a3b04e812
--   length : 1764 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.consume_lots_fifo(p_member_id uuid, p_redemption_id uuid, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining_to_consume integer := p_amount;
  v_lot record;
  v_consume_amount integer;
  v_total_consumed integer := 0;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'consume amount must be positive: %', p_amount;
  END IF;

  FOR v_lot IN
    SELECT lots.id, lots.remaining_amount
      FROM public.loyalty_point_lots AS lots
     WHERE lots.member_id        = p_member_id
       AND lots.remaining_amount > 0
       AND lots.revoked_at   IS NULL
       AND lots.expired_at IS NULL
     ORDER BY lots.expires_at ASC NULLS LAST, lots.earned_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_to_consume = 0;

    v_consume_amount := LEAST(v_lot.remaining_amount, v_remaining_to_consume);

    UPDATE public.loyalty_point_lots AS lots
       SET remaining_amount = lots.remaining_amount - v_consume_amount,
           consumed_at = CASE
             WHEN lots.remaining_amount - v_consume_amount = 0 THEN now()
             ELSE lots.consumed_at
           END,
           updated_at = now()
     WHERE lots.id = v_lot.id;

    INSERT INTO public.loyalty_lot_consumption (
      redemption_id, lot_id, amount
    ) VALUES (
      p_redemption_id, v_lot.id, v_consume_amount
    );

    v_remaining_to_consume := v_remaining_to_consume - v_consume_amount;
    v_total_consumed       := v_total_consumed       + v_consume_amount;
  END LOOP;

  IF v_remaining_to_consume > 0 THEN
    RAISE EXCEPTION 'insufficient lot balance: requested %, consumed %',
      p_amount, v_total_consumed;
  END IF;

  RETURN v_total_consumed;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.create_web_layaway_atomic(p_customer_id uuid, p_quote_id uuid, p_lang text, p_transfer_due_at timestamp with time zone, p_order_date date)
--   md5    : 3304fe8847e353d54c8015775c2659bb
--   length : 7141 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_web_layaway_atomic(p_customer_id uuid, p_quote_id uuid, p_lang text DEFAULT NULL::text, p_transfer_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_order_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote      public.checkout_quotes%ROWTYPE;
  v_item       jsonb;
  v_variant    public.website_product_variants%ROWTYPE;
  v_qty        integer;
  v_updated    integer;
  v_seq        bigint;
  v_invoice    text;
  v_reference  text;
  v_account_id uuid;
  v_lang       text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
  v_cur        text;
  v_rate       numeric;
  v_total      integer;
  v_shipping   integer;
  v_subtotal   integer;
  v_quote_out  jsonb;
  v_term       integer;
  v_deposit    integer;
  v_due        timestamptz;
  v_end_date   date;
  v_title      text;
  v_row        jsonb;
  v_order_date date := COALESCE(p_order_date, CURRENT_DATE);
BEGIN
  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode <> 'layaway' THEN
    RETURN jsonb_build_object('error', 'not_a_layaway_quote');
  END IF;
  IF v_quote.shipping_jpy IS NULL THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;
  IF coalesce(v_quote.total_jpy, 0) <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;

  v_cur := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_cur = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := round(coalesce(v_quote.shipping_jpy, 0) * v_rate);
    v_subtotal := v_total - v_shipping;
  ELSE
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := coalesce(v_quote.shipping_jpy, 0);
    v_subtotal := v_total - v_shipping;
  END IF;

  v_quote_out := public.layaway_quote(
    v_subtotal, v_quote.term_months, v_cur, v_order_date, v_shipping, 0
  );
  IF NOT coalesce((v_quote_out->>'eligible')::boolean, false)
     OR coalesce((v_quote_out->>'term_downgraded')::boolean, false) THEN
    RETURN jsonb_build_object(
      'error', 'below_plan_minimum',
      'total', v_total,
      'currency', v_cur,
      'requested_term_months', v_quote.term_months,
      'max_term_months', v_quote_out->'max_term_months'
    );
  END IF;
  v_term    := (v_quote_out->>'term_months')::integer;
  v_deposit := (v_quote_out->>'deposit')::integer;

  v_due := coalesce(p_transfer_due_at, now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)));
  SELECT max((s->>'due_date')::date) INTO v_end_date
    FROM jsonb_array_elements(v_quote_out->'schedule') s;

  v_seq       := nextval('public.web_order_number_seq');
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.layaway_accounts (
    invoice_number, customer_id, currency, total_amount, payment_plan_months,
    order_date, end_date, status, total_paid, remaining_balance,
    downpayment_amount, loyalty_jpy_amount, shipping_fee,
    source_channel, web_reference, quote_id, transfer_due_at, ship_to_snapshot,
    customer_lang, fx_rate_used, fx_rate_date, notes
  ) VALUES (
    v_invoice, p_customer_id, v_cur::account_currency, v_total, v_term,
    v_order_date, v_end_date, 'active', 0, v_total,
    v_deposit,
    -- LOYALTY BASE: the PRODUCT amount, in YEN, always.
    v_quote.subtotal_jpy,
    v_shipping,
    'web', v_reference, v_quote.id, v_due,
    -- layaway_accounts has no ship_to_address_id: this snapshot, resolved
    -- through the quote, is the only delivery address the plan carries.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_lang, v_rate, v_quote.fx_rate_date,
    'Website layaway ' || v_reference
  ) RETURNING id INTO v_account_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_quote_out->'schedule') LOOP
    INSERT INTO public.layaway_schedule (
      account_id, installment_number, due_date, base_installment_amount,
      penalty_amount, total_due_amount, paid_amount, currency, status
    ) VALUES (
      v_account_id,
      (v_row->>'installment_number')::integer,
      (v_row->>'due_date')::date,
      (v_row->>'amount')::numeric,
      0,
      (v_row->>'amount')::numeric,
      0,
      v_cur::account_currency,
      'pending'
    );
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(COALESCE((v_item->>'qty')::int, 1), 1);

    SELECT * INTO v_variant FROM public.website_product_variants
      WHERE id = (v_item->>'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item->>'variant_id';
    END IF;

    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;

    SELECT trim(both ' ' FROM
             p.name ||
             COALESCE(' / ' || NULLIF(v_variant.size, ''), '') ||
             COALESCE(' / ' || NULLIF(v_variant.stone, ''), ''))
      INTO v_title
      FROM public.website_products p WHERE p.id = v_variant.product_id;

    INSERT INTO public.layaway_account_items (
      account_id, website_product_id, variant_id, title, sku, quantity,
      unit_price_jpy, line_total_jpy
    ) VALUES (
      v_account_id, v_variant.product_id, v_variant.id,
      COALESCE(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty,
      v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
  END LOOP;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true,
    'account_id', v_account_id,
    'web_reference', v_reference,
    'invoice_number', v_invoice,
    'currency', v_cur,
    'total', v_total,
    'deposit', v_deposit,
    'term_months', v_term,
    'schedule', v_quote_out->'schedule',
    'transfer_due_at', v_due,
    'loyalty_jpy_amount', v_quote.subtotal_jpy,
    'fx_rate', v_rate
  );
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.create_web_order_atomic(p_customer_id uuid, p_quote_id uuid, p_method text, p_lang text)
--   md5    : 334a29a2bada3c2deee92a6f23106b1f
--   length : 5400 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_web_order_atomic(p_customer_id uuid, p_quote_id uuid, p_method text, p_lang text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote        public.checkout_quotes%ROWTYPE;
  v_item         jsonb;
  v_variant      public.website_product_variants%ROWTYPE;
  v_qty          integer;
  v_updated      integer;
  v_seq          bigint;
  v_invoice      text;
  v_reference    text;
  v_order_id     uuid;
  v_currency     text := 'JPY';
  v_due          timestamptz := now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id));
  v_title        text;
  v_lang         text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
BEGIN
  IF p_method IS DISTINCT FROM 'transfer' THEN
    RETURN jsonb_build_object('error', 'unsupported_method');
  END IF;

  -- Lock the quote so a double-submit cannot produce two orders from it.
  SELECT * INTO v_quote FROM public.checkout_quotes
    WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode <> 'full' THEN
    RETURN jsonb_build_object('error', 'layaway_not_yet');
  END IF;
  IF v_quote.shipping_jpy IS NULL THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;
  IF v_quote.total_jpy <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;

  v_seq       := nextval('public.web_order_number_seq');
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.cash_orders (
    invoice_number, customer_id, currency, total_amount, total_paid,
    remaining_balance, status, source_channel, order_type, payment_method,
    payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
    gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
    loyalty_jpy_amount, item_description, order_date, customer_lang
  ) VALUES (
    v_invoice, p_customer_id, v_currency::account_currency, v_quote.total_jpy, 0,
    v_quote.total_jpy, 'pending'::cash_order_status, 'web', v_quote.order_type, 'transfer',
    'pending_transfer', v_quote.ship_to_address_id,
    -- The address AS IT WAS, so editing the address book later cannot move
    -- where this order was sent. The FK beside it stays a convenience link.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_quote.recipient_name, v_quote.recipient_phone,
    -- expires_at = transfer_due_at: the 72-hour deadline is what the expiry cron reads.
    v_quote.gift_note, v_quote.id, v_reference, v_due, v_due, COALESCE(v_quote.shipping_jpy, 0),
    -- Loyalty basis is the PRODUCT amount only: shipping never earns points.
    v_quote.subtotal_jpy, 'Website order ' || v_reference, CURRENT_DATE, v_lang
  ) RETURNING id INTO v_order_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(COALESCE((v_item->>'qty')::int, 1), 1);

    SELECT * INTO v_variant FROM public.website_product_variants
      WHERE id = (v_item->>'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item->>'variant_id';
    END IF;

    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;

    SELECT trim(both ' ' FROM
             p.name ||
             COALESCE(' / ' || NULLIF(v_variant.size, ''), '') ||
             COALESCE(' / ' || NULLIF(v_variant.stone, ''), ''))
      INTO v_title
      FROM public.website_products p WHERE p.id = v_variant.product_id;

    -- website_product_id, NOT product_id: product_id is the Shopify FK
    -- (public.products) and a website_products id violates it (Bug #266).
    INSERT INTO public.cash_order_items (
      cash_order_id, website_product_id, variant_id, title, sku, quantity,
      unit_price_jpy, line_total_jpy
    ) VALUES (
      v_order_id, v_variant.product_id, v_variant.id,
      COALESCE(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty, v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
  END LOOP;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'web_reference', v_reference,
    'invoice_number', v_invoice,
    'total_jpy', v_quote.total_jpy,
    'transfer_due_at', v_due
  );
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer)
--   md5    : eaa9c4f2ac4ccb9ba89f8c6e46c11213
--   length : 1826 bytes
--   acl    : =X/postgres | postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer DEFAULT 3)
 RETURNS TABLE(source_kind text, account_id uuid, cash_order_id uuid, invoice_number text, loyalty_jpy_amount numeric, total_amount numeric, currency text, confirmed_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT q.source_kind, q.account_id, q.cash_order_id, q.invoice_number,
         q.loyalty_jpy_amount, q.total_amount, q.currency, q.confirmed_at
  FROM (
    SELECT 'layaway'::text AS source_kind, la.id AS account_id, NULL::uuid AS cash_order_id,
           la.invoice_number, la.loyalty_jpy_amount, la.total_amount, la.currency::text AS currency,
           ps.updated_at AS confirmed_at
    FROM layaway_accounts la
    JOIN payment_submissions ps
      ON ps.account_id = la.id AND ps.status::text = 'confirmed'
     AND ( ps.submission_type::text = 'downpayment'
        OR ps.reference_number ILIKE 'DP-%'
        OR ps.notes ~* '\y(down(payment)?|dp)\y' )
    WHERE la.customer_id = p_customer_id
      AND (la.loyalty_jpy_amount >= 10000 OR la.loyalty_jpy_amount IS NULL)
      AND la.status::text NOT IN ('cancelled','forfeited','final_forfeited')
      AND ps.updated_at >= now() - make_interval(days => p_lookback_days)
    UNION ALL
    SELECT 'cash'::text, NULL::uuid, co.id, co.invoice_number, co.loyalty_jpy_amount, co.total_amount,
           co.currency::text, co.completed_at
    FROM cash_orders co
    WHERE co.customer_id = p_customer_id
      AND (co.loyalty_jpy_amount >= 10000 OR co.loyalty_jpy_amount IS NULL)
      AND co.status::text = 'completed'
      AND co.completed_at IS NOT NULL
      AND co.completed_at >= now() - make_interval(days => p_lookback_days)
  ) q
  ORDER BY q.confirmed_at DESC
  LIMIT 1;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.notify_website_revalidate()
--   md5    : c163d58c9df7af3c416d06a016cfbaab
--   length : 1898 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_website_revalidate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE v_product_id uuid; v_collection_id uuid; v_product_slug text; v_collection_slug text; v_key text; BEGIN IF TG_TABLE_NAME = 'website_products' THEN v_product_id := COALESCE(NEW.id, OLD.id); v_product_slug := COALESCE(NEW.slug, OLD.slug); ELSIF TG_TABLE_NAME = 'website_collections' THEN v_collection_id := COALESCE(NEW.id, OLD.id); v_collection_slug := COALESCE(NEW.slug, OLD.slug); ELSIF TG_TABLE_NAME = 'website_product_variants' THEN v_product_id := COALESCE(NEW.product_id, OLD.product_id); ELSIF TG_TABLE_NAME = 'website_product_media' THEN SELECT product_id INTO v_product_id FROM website_product_variants WHERE id = COALESCE(NEW.variant_id, OLD.variant_id); ELSIF TG_TABLE_NAME = 'website_collection_products' THEN v_product_id := COALESCE(NEW.product_id, OLD.product_id); v_collection_id := COALESCE(NEW.collection_id, OLD.collection_id); END IF; IF v_product_id IS NOT NULL AND v_product_slug IS NULL THEN SELECT slug INTO v_product_slug FROM website_products WHERE id = v_product_id; END IF; IF v_collection_id IS NOT NULL AND v_collection_slug IS NULL THEN SELECT slug INTO v_collection_slug FROM website_collections WHERE id = v_collection_id; END IF; SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'; IF v_key IS NOT NULL AND (v_product_slug IS NOT NULL OR v_collection_slug IS NOT NULL) THEN PERFORM net.http_post(url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key), body := jsonb_strip_nulls(jsonb_build_object('productSlug', v_product_slug, 'collectionSlug', v_collection_slug))); END IF; RETURN COALESCE(NEW, OLD); END $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.reactivate_web_layaway_atomic(p_account_id uuid, p_transfer_due_at timestamp with time zone, p_reason text, p_user_id uuid, p_source text)
--   md5    : ff6447f90e6fd38ebed7176a36abb9db
--   length : 4922 bytes
--   acl    : =X/postgres | postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reactivate_web_layaway_atomic(p_account_id uuid, p_transfer_due_at timestamp with time zone, p_reason text, p_user_id uuid DEFAULT NULL::uuid, p_source text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status    text;
  v_expired   timestamptz;
  v_invoice   text;
  v_web_ref   text;
  v_paid      numeric;
  v_old_due   timestamptz;
  v_short     jsonb;
  v_taken     integer := 0;
  v_restored  integer := 0;
  v_reason    text := btrim(coalesce(p_reason, ''));
  v_now       timestamptz := now();
BEGIN
  IF v_reason = '' THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
  IF p_transfer_due_at <= v_now THEN
    RETURN jsonb_build_object('error', 'deadline_in_past', 'transfer_due_at', p_transfer_due_at);
  END IF;

  SELECT status::text, expired_at, invoice_number, web_reference, total_paid, transfer_due_at
    INTO v_status, v_expired, v_invoice, v_web_ref, v_paid, v_old_due
    FROM public.layaway_accounts
   WHERE id = p_account_id AND source_channel = 'web'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_web_layaway');
  END IF;

  IF v_status <> 'cancelled' OR v_expired IS NULL THEN
    RETURN jsonb_build_object('error', 'not_expired', 'status', v_status,
                              'expired_at', v_expired);
  END IF;

  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('error', 'already_paid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_account_id AND voided_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'payment_exists');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'variant_id', i.variant_id, 'title', i.title, 'sku', i.sku,
           'wanted', i.quantity, 'available', coalesce(v.stock_qty, 0)))
    INTO v_short
    FROM public.layaway_account_items i
    LEFT JOIN public.website_product_variants v ON v.id = i.variant_id
   WHERE i.account_id = p_account_id
     AND (v.id IS NULL OR v.stock_qty < i.quantity);
  IF v_short IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'out_of_stock', 'lines', v_short);
  END IF;

  WITH taken AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty - i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND v.id = i.variant_id
       AND v.stock_qty >= i.quantity
     RETURNING v.id
  )
  SELECT count(*) INTO v_taken FROM taken;

  SELECT count(*) INTO v_restored
    FROM public.layaway_account_items WHERE account_id = p_account_id;

  IF v_taken <> v_restored THEN
    RAISE EXCEPTION 'reactivate_web_layaway: took % of % lines — a piece sold during the reactivation; nothing applied', v_taken, v_restored;
  END IF;

  UPDATE public.layaway_accounts
     SET status          = 'active',
         expired_at      = NULL,
         transfer_due_at = p_transfer_due_at,
         updated_at      = v_now,
         notes           = COALESCE(notes || E'\n', '')
                           || 'Reactivated ' || to_char(v_now AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                           || ' PHT — new deposit deadline '
                           || to_char(p_transfer_due_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                           || ' PHT — ' || v_reason
   WHERE id = p_account_id;

  UPDATE public.layaway_schedule
     SET status = 'pending', updated_at = v_now
   WHERE account_id = p_account_id AND status = 'cancelled';
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action,
                                 old_value_json, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_account_id, 'web_layaway_reactivated',
          jsonb_build_object('status', 'cancelled', 'expired_at', v_expired,
                             'transfer_due_at', v_old_due),
          jsonb_build_object('status', 'active', 'expired_at', NULL,
                             'transfer_due_at', p_transfer_due_at,
                             'invoice_number', v_invoice, 'web_reference', v_web_ref,
                             'schedule_rows_restored', v_restored,
                             'stock_lines_taken', v_taken,
                             'reason', v_reason, 'source', p_source),
          coalesce(p_user_id, auth.uid()));

  RETURN jsonb_build_object('ok', true,
                            'web_reference', v_web_ref,
                            'invoice_number', v_invoice,
                            'transfer_due_at', p_transfer_due_at,
                            'schedule_rows_restored', v_restored,
                            'stock_lines_taken', v_taken);
END $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.terminate_web_order_atomic(p_order_id uuid, p_outcome text, p_reason text, p_user_id uuid, p_user_email text, p_refund_status text, p_refund_note text, p_source text, p_preview boolean)
--   md5    : 7a93ec09925ee1b76aed21d1c0a8fea9
--   length : 11639 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────────
-- public.upsert_customer_addresses(p_customer_id uuid, p_addresses jsonb)
--   md5    : 6df5be2722347f5af8c20114bbdda40f
--   length : 4264 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_customer_addresses(p_customer_id uuid, p_addresses jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_entry     jsonb;
  v_id        uuid;
  v_matched   uuid;
  v_inserted  int := 0;
  v_updated   int := 0;
  v_want_def  uuid;
  v_def_count int;
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'customer_id_required');
  END IF;
  IF p_addresses IS NULL OR jsonb_typeof(p_addresses) <> 'array' THEN
    RETURN jsonb_build_object('error', 'addresses_must_be_array');
  END IF;
  IF jsonb_array_length(p_addresses) > 20 THEN
    RETURN jsonb_build_object('error', 'too_many_addresses');
  END IF;

  -- Reject the whole payload rather than silently dropping entries the
  -- customer believes they saved. Unchanged from the function this replaces.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_addresses) e
    WHERE COALESCE(btrim(e->>'line1'), '') = ''
  ) THEN
    RETURN jsonb_build_object('error', 'line1_required');
  END IF;

  SELECT count(*) INTO v_def_count
    FROM jsonb_array_elements(p_addresses) e
   WHERE COALESCE((e->>'is_default')::boolean, false);

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_addresses) LOOP
    -- A malformed id is treated as absent, not as an error.
    BEGIN
      v_id := NULLIF(btrim(v_entry->>'id'), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_id := NULL;
    END;

    v_matched := NULL;
    IF v_id IS NOT NULL THEN
      SELECT a.id INTO v_matched FROM public.customer_addresses a
       WHERE a.id = v_id AND a.customer_id = p_customer_id;
    END IF;

    IF v_matched IS NOT NULL THEN
      UPDATE public.customer_addresses SET
        label          = NULLIF(btrim(v_entry->>'label'), ''),
        recipient_name = NULLIF(btrim(v_entry->>'recipient_name'), ''),
        line1          = btrim(v_entry->>'line1'),
        line2          = NULLIF(btrim(v_entry->>'line2'), ''),
        city           = NULLIF(btrim(v_entry->>'city'), ''),
        region         = NULLIF(btrim(v_entry->>'region'), ''),
        postal_code    = NULLIF(btrim(v_entry->>'postal_code'), ''),
        country        = COALESCE(NULLIF(btrim(v_entry->>'country'), ''), 'JP'),
        phone          = NULLIF(btrim(v_entry->>'phone'), '')
      WHERE id = v_matched;
      v_updated := v_updated + 1;
    ELSE
      INSERT INTO public.customer_addresses
        (customer_id, label, recipient_name, line1, line2, city, region, postal_code, country, phone, is_default)
      VALUES (
        p_customer_id,
        NULLIF(btrim(v_entry->>'label'), ''),
        NULLIF(btrim(v_entry->>'recipient_name'), ''),
        btrim(v_entry->>'line1'),
        NULLIF(btrim(v_entry->>'line2'), ''),
        NULLIF(btrim(v_entry->>'city'), ''),
        NULLIF(btrim(v_entry->>'region'), ''),
        NULLIF(btrim(v_entry->>'postal_code'), ''),
        COALESCE(NULLIF(btrim(v_entry->>'country'), ''), 'JP'),
        NULLIF(btrim(v_entry->>'phone'), ''),
        false
      ) RETURNING id INTO v_matched;
      v_inserted := v_inserted + 1;
    END IF;

    IF v_def_count = 1 AND COALESCE((v_entry->>'is_default')::boolean, false) THEN
      v_want_def := v_matched;
    END IF;
  END LOOP;

  -- The default, in two steps because customer_addresses_one_default is a
  -- partial unique index: clear before setting.
  IF v_want_def IS NOT NULL THEN
    UPDATE public.customer_addresses SET is_default = false
     WHERE customer_id = p_customer_id AND is_default AND id <> v_want_def;
    UPDATE public.customer_addresses SET is_default = true  WHERE id = v_want_def;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.customer_addresses
                    WHERE customer_id = p_customer_id AND is_default) THEN
      UPDATE public.customer_addresses SET is_default = true
       WHERE id = (SELECT id FROM public.customer_addresses
                    WHERE customer_id = p_customer_id
                    ORDER BY created_at, id LIMIT 1);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'updated',  v_updated,
    'count', (SELECT count(*) FROM public.customer_addresses WHERE customer_id = p_customer_id));
END $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text)
--   md5    : 9854da8d14473afdf088af9cd9c790bb
--   length : 14178 bytes
--   acl    : =X/postgres | postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lots_restored integer;
  r record;
  m record;
  v_pts integer;
  v_before_balance integer;
  v_new_remaining integer;
  v_tier_name text;
  v_refund_tx_id uuid;
  v_updated_count integer;
  v_stock_re_incremented boolean := false;
  v_reward record;
  v_jpy_to_restore numeric := 0;
  v_currency text;
  v_synth_payment record;
  v_alloc record;
  v_sched record;
  v_new_paid numeric;
  v_new_status text;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_acct record;
  v_refund_amount numeric := 0;
  v_new_total_paid numeric;
  v_new_remaining_balance numeric;
  v_any_overdue boolean;
  v_new_account_status text;
  v_cash_synth record;
  v_cash_new_total numeric;
  v_cash_order record;
  v_cash_new_remaining numeric;
  v_truncated_reason text;
  v_void_notes text;
  v_ref_ref text;
  v_note text;
  v_order_side_done boolean := false;
BEGIN
  v_truncated_reason := substring(coalesce(p_void_reason, ''), 1, 250);
  
  -- ---------------------------------------------------------------------
  -- Step 1: Lock redemption row, validate status
  -- ---------------------------------------------------------------------
  SELECT id, status, member_id, reward_id, redemption_type, points_redeemed,
         transaction_id, account_id, cash_order_id, invoice_number, value_applied_jpy
  INTO r
  FROM public.loyalty_redemptions
  WHERE id = p_redemption_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'redemption_not_found' USING ERRCODE = 'P0001';
  END IF;
  
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'redemption_not_confirmed: %', r.status USING ERRCODE = 'P0001';
  END IF;
  
  v_pts := r.points_redeemed;
  v_ref_ref := 'LOYALTY-' || r.id::text;
  v_void_notes := 'Loyalty redemption voided: ' || v_truncated_reason;
  
  -- ---------------------------------------------------------------------
  -- Step 2: Lock member row, fetch tier name
  -- ---------------------------------------------------------------------
  SELECT id, remaining_points, total_points_redeemed, current_tier_id
  INTO m
  FROM public.loyalty_members
  WHERE id = r.member_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'P0001';
  END IF;
  
  v_before_balance := COALESCE(m.remaining_points, 0);
  v_new_remaining := v_before_balance + v_pts;
  
  SELECT name INTO v_tier_name
  FROM public.loyalty_tiers
  WHERE id = m.current_tier_id;
  
  -- ---------------------------------------------------------------------
  -- Step 3: Insert refund loyalty_transactions row
  -- ---------------------------------------------------------------------
  INSERT INTO public.loyalty_transactions (
    member_id, transaction_type, points_amount,
    account_id, cash_order_id, invoice_number,
    tier_at_time, notes
  )
  VALUES (
    m.id, 'refunded', v_pts,
    r.account_id, r.cash_order_id, NULL,
    v_tier_name,
    CASE WHEN r.transaction_id IS NOT NULL
      THEN 'Refund of voided redemption #' || substring(r.id::text, 1, 8) || ' — original tx: ' || r.transaction_id::text
      ELSE 'Refund of voided redemption #' || substring(r.id::text, 1, 8)
    END
  )
  RETURNING id INTO v_refund_tx_id;
  
  -- ---------------------------------------------------------------------
  -- Step 4: Mark redemption cancelled (defensive race guard)
  -- ---------------------------------------------------------------------
  UPDATE public.loyalty_redemptions
  SET status = 'cancelled',
      cancelled_by_user_id = p_user_id,
      cancelled_at = now(),
      cancellation_reason = v_truncated_reason
  WHERE id = r.id
    AND status = 'confirmed';
  
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  
  IF v_updated_count = 0 THEN
    RAISE EXCEPTION 'redemption_void_race' USING ERRCODE = 'P0001';
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 5: Restore member balance (relative arithmetic, race-safe)
  -- ---------------------------------------------------------------------
  UPDATE public.loyalty_members
  SET remaining_points = COALESCE(remaining_points, 0) + v_pts,
      total_points_redeemed = GREATEST(0, COALESCE(total_points_redeemed, 0) - v_pts)
  WHERE id = m.id;

  -- Restore consumed lots from the ledger (wired 2026-07-05). Redemptions
  -- approved before lot-wiring have no ledger rows and restore 0; top up
  -- the shortfall with a synthetic lot so the lot/counter invariant holds.
  v_lots_restored := public.restore_lots_for_redemption(p_redemption_id);
  IF v_lots_restored < v_pts::integer THEN
    INSERT INTO public.loyalty_point_lots
      (member_id, source_type, source_reference, original_amount, remaining_amount, earned_at, expires_at, notes)
    VALUES
      (m.id, 'admin_adjust'::loyalty_lot_source_type, 'VOID-TOPUP-' || p_redemption_id::text,
       v_pts::integer - v_lots_restored, v_pts::integer - v_lots_restored, now(), NULL,
       'Synthetic lot: void of pre-lot-wiring redemption');
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 6: Order-side reversal (only for new_order_discount with FK)
  -- ---------------------------------------------------------------------
  IF r.redemption_type = 'new_order_discount' 
     AND (r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL) THEN
    
    -- Step 6a: Restore loyalty_jpy_amount on the order
    v_jpy_to_restore := COALESCE(r.value_applied_jpy, 0);
    
    IF v_jpy_to_restore > 0 THEN
      IF r.account_id IS NOT NULL THEN
        UPDATE public.layaway_accounts
        SET loyalty_jpy_amount = COALESCE(loyalty_jpy_amount, 0) + v_jpy_to_restore
        WHERE id = r.account_id;
      ELSE
        UPDATE public.cash_orders
        SET loyalty_jpy_amount = COALESCE(loyalty_jpy_amount, 0) + v_jpy_to_restore
        WHERE id = r.cash_order_id;
      END IF;
    END IF;
    
    -- Step 6b: Layaway branch
    IF r.account_id IS NOT NULL THEN
      SELECT id, voided_at, amount_paid
      INTO v_synth_payment
      FROM public.payments
      WHERE reference_number = v_ref_ref
      LIMIT 1;
      
      IF v_synth_payment.id IS NOT NULL AND v_synth_payment.voided_at IS NULL THEN
        
        -- Void the synthetic payment
        UPDATE public.payments
        SET voided_at = now(),
            voided_by_user_id = p_user_id,
            void_reason = v_void_notes
        WHERE id = v_synth_payment.id;
        
        -- Revert each allocation: schedule row revert + allocation delete
        FOR v_alloc IN
          SELECT id, schedule_id, allocated_amount, allocation_type
          FROM public.payment_allocations
          WHERE payment_id = v_synth_payment.id
        LOOP
          SELECT id, total_due_amount, paid_amount, status, due_date
          INTO v_sched
          FROM public.layaway_schedule
          WHERE id = v_alloc.schedule_id;
          
          IF NOT FOUND THEN
            RAISE EXCEPTION 'schedule_row_not_found: %', v_alloc.schedule_id 
              USING ERRCODE = 'P0001';
          END IF;
          
          v_new_paid := GREATEST(0, COALESCE(v_sched.paid_amount, 0) - COALESCE(v_alloc.allocated_amount, 0));
          
          -- Status reversal (faithful port of TS L1008-1028)
          IF v_new_paid >= v_sched.total_due_amount THEN
            v_new_status := 'paid';
          ELSIF v_new_paid = 0 THEN
            v_new_status := CASE WHEN v_sched.due_date < v_today THEN 'overdue' ELSE 'pending' END;
          ELSIF v_sched.status = 'paid' THEN
            v_new_status := CASE WHEN v_sched.due_date < v_today THEN 'overdue' ELSE 'partially_paid' END;
          ELSE
            v_new_status := v_sched.status;
          END IF;
          
          UPDATE public.layaway_schedule
          SET paid_amount = v_new_paid,
              status = v_new_status::schedule_status
          WHERE id = v_sched.id;
          
          DELETE FROM public.payment_allocations
          WHERE id = v_alloc.id;
        END LOOP;
        
        -- Revert account totals + status
        SELECT total_paid, remaining_balance, status, currency
        INTO v_acct
        FROM public.layaway_accounts
        WHERE id = r.account_id;
        
        v_refund_amount := COALESCE(v_synth_payment.amount_paid, 0);
        v_new_total_paid := GREATEST(0, COALESCE(v_acct.total_paid, 0) - v_refund_amount);
        v_new_remaining_balance := COALESCE(v_acct.remaining_balance, 0) + v_refund_amount;
        
        v_new_account_status := v_acct.status;
        IF v_acct.status = 'completed' AND v_new_remaining_balance > 0.01 THEN
          SELECT EXISTS(
            SELECT 1 FROM public.layaway_schedule
            WHERE account_id = r.account_id AND status = 'overdue'
          ) INTO v_any_overdue;
          v_new_account_status := CASE WHEN v_any_overdue THEN 'overdue' ELSE 'active' END;
        END IF;
        
        UPDATE public.layaway_accounts
        SET total_paid = v_new_total_paid,
            remaining_balance = v_new_remaining_balance,
            status = v_new_account_status::account_status
        WHERE id = r.account_id;
        
        v_currency := v_acct.currency;
        v_order_side_done := true;
      END IF;
    END IF;
    
    -- Step 6c: Cash order branch
    IF r.cash_order_id IS NOT NULL THEN
      SELECT id, voided_at, amount_paid
      INTO v_cash_synth
      FROM public.cash_payments
      WHERE reference_number = v_ref_ref
      LIMIT 1;
      
      IF v_cash_synth.id IS NOT NULL AND v_cash_synth.voided_at IS NULL THEN
        
        -- Void the synthetic cash_payment
        UPDATE public.cash_payments
        SET voided_at = now(),
            voided_by_user_id = p_user_id,
            void_reason = v_void_notes
        WHERE id = v_cash_synth.id;
        
        -- Recompute total_paid from all non-voided cash_payments
        SELECT COALESCE(SUM(amount_paid), 0)
        INTO v_cash_new_total
        FROM public.cash_payments
        WHERE cash_order_id = r.cash_order_id
          AND voided_at IS NULL;
        
        SELECT total_amount, status, currency
        INTO v_cash_order
        FROM public.cash_orders
        WHERE id = r.cash_order_id;
        
        v_cash_new_remaining := COALESCE(v_cash_order.total_amount, 0) - v_cash_new_total;
        
        IF v_cash_order.status = 'completed' AND v_cash_new_remaining > 0 THEN
          UPDATE public.cash_orders
          SET total_paid = v_cash_new_total,
              remaining_balance = v_cash_new_remaining,
              status = 'pending'::cash_order_status,
              completed_at = NULL,
              updated_at = now()
          WHERE id = r.cash_order_id;
        ELSE
          UPDATE public.cash_orders
          SET total_paid = v_cash_new_total,
              remaining_balance = v_cash_new_remaining,
              updated_at = now()
          WHERE id = r.cash_order_id;
        END IF;
        
        v_refund_amount := COALESCE(v_cash_synth.amount_paid, 0);
        v_currency := v_cash_order.currency;
        v_order_side_done := true;
      END IF;
    END IF;
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 7: Re-increment catalog stock (when reward exists with finite stock)
  -- ---------------------------------------------------------------------
  IF r.reward_id IS NOT NULL THEN
    SELECT id, current_stock
    INTO v_reward
    FROM public.loyalty_rewards
    WHERE id = r.reward_id
    FOR UPDATE;
    
    IF v_reward.id IS NOT NULL AND v_reward.current_stock IS NOT NULL THEN
      UPDATE public.loyalty_rewards
      SET current_stock = COALESCE(current_stock, 0) + 1
      WHERE id = r.reward_id;
      v_stock_re_incremented := true;
    END IF;
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 8: Audit log
  -- ---------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    entity_type, entity_id, action, performed_by_user_id,
    old_value_json, new_value_json
  )
  VALUES (
    'loyalty_redemption', r.id, 'redemption_voided', p_user_id,
    jsonb_build_object(
      'status', 'confirmed',
      'member_remaining_points', v_before_balance
    ),
    jsonb_build_object(
      'status', 'cancelled',
      'cancellation_reason', v_truncated_reason,
      'member_remaining_points', v_new_remaining,
      'refund_transaction_id', v_refund_tx_id,
      'stock_re_incremented', v_stock_re_incremented
    )
  );
  
  -- ---------------------------------------------------------------------
  -- Step 9: Account note (atomic, symmetric format with approve)
  -- ---------------------------------------------------------------------
  IF r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL THEN
    v_note := 'Loyalty: redemption voided — ' || v_pts::text || ' pts refunded (' || r.redemption_type::text || ')';
    
    IF v_refund_amount > 0 AND v_currency IS NOT NULL THEN
      v_note := v_note || ' — ' ||
                CASE WHEN v_currency = 'PHP' THEN '₱' ELSE '¥' END ||
                v_refund_amount::text ||
                ' removed from balance';
    END IF;
    
    INSERT INTO public.account_notes (
      account_id, cash_order_id, note_text,
      created_by_user_id, created_by_name
    )
    VALUES (
      r.account_id, r.cash_order_id, v_note,
      p_user_id, 'System (Loyalty)'
    );
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Return payload
  -- ---------------------------------------------------------------------
  RETURN jsonb_build_object(
    'redemption_id', r.id,
    'refund_transaction_id', v_refund_tx_id,
    'points_refunded', v_pts,
    'new_remaining_points', v_new_remaining,
    'stock_re_incremented', v_stock_re_incremented,
    'jpy_restored', v_jpy_to_restore,
    'order_side_reverted', v_order_side_done,
    'refund_amount', v_refund_amount,
    'currency', v_currency
  );
END;
$function$;

