-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.allocate_payment_atomic(p_account_id uuid, p_amount_paid numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_remarks text, p_user_id uuid, p_currency text, p_is_downpayment boolean, p_submitted_by_type text, p_submitted_by_name text, p_preview boolean)
--   captured  : 2026-09-17 05:50:22.096422+00 (SELECT pg_get_functiondef(oid))
--   md5       : 77aca9392fecf08824b765c02025e014
--   length    : 11179 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'allocate_payment_atomic';
--
-- Captured for the live-vs-repo diff pass (DIFF-FINDINGS.md beside this file).
-- The repo is NOT evidence about live — see CLAUDE.md, "A SQL EDITOR CHANGE
-- THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD".

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
$function$
