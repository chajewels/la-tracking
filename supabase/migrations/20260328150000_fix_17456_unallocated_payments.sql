-- Fix INV #17456: allocate Feb 16 and Mar 16 payments to Month 4 and Month 5
--
-- Problem: payments were recorded in the payments table but no payment_allocations
-- rows were created, so layaway_schedule rows for Month 4 (due 2026-02-16) and
-- Month 5 (due 2026-03-16) remained at paid_amount = 0 / status = 'overdue'.
-- The penalty engine then charged penalties on those months incorrectly.
--
-- Fix steps:
--   1. Waive all unpaid penalties on Month 4 and Month 5
--   2. Reset penalty_amount = 0, total_due_amount = base on those rows
--   3. Set paid_amount and status = 'paid' on Month 4 and Month 5
--   4. Insert payment_allocations (idempotent — skips if already exists)
--   5. Recalculate layaway_accounts.total_paid and remaining_balance
--      from SUM(payments) as single source of truth

DO $$
DECLARE
  v_account_id   uuid;
  v_month4_id    uuid;
  v_month5_id    uuid;
  v_pay_feb_id   uuid;
  v_pay_mar_id   uuid;
  v_base_month4  numeric;
  v_base_month5  numeric;
  v_total_paid   numeric;
  v_total_amount numeric;
  v_waived_count int;
BEGIN
  -- ── 0. Resolve account ──────────────────────────────────────────────────────
  SELECT id, total_amount
  INTO v_account_id, v_total_amount
  FROM public.layaway_accounts
  WHERE invoice_number = '17456';

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'Account INV #17456 not found';
  END IF;

  RAISE NOTICE 'Account found: % (total_amount = %)', v_account_id, v_total_amount;

  -- ── 1. Resolve schedule rows ─────────────────────────────────────────────────
  SELECT id, base_installment_amount
  INTO v_month4_id, v_base_month4
  FROM public.layaway_schedule
  WHERE account_id = v_account_id
    AND installment_number = 4;

  SELECT id, base_installment_amount
  INTO v_month5_id, v_base_month5
  FROM public.layaway_schedule
  WHERE account_id = v_account_id
    AND installment_number = 5;

  IF v_month4_id IS NULL THEN
    RAISE EXCEPTION 'Month 4 schedule row not found for account %', v_account_id;
  END IF;
  IF v_month5_id IS NULL THEN
    RAISE EXCEPTION 'Month 5 schedule row not found for account %', v_account_id;
  END IF;

  RAISE NOTICE 'Month 4: % (base = %), Month 5: % (base = %)',
    v_month4_id, v_base_month4, v_month5_id, v_base_month5;

  -- ── 2. Resolve payment rows ──────────────────────────────────────────────────
  -- Feb 16 payment (₱1,670.41)
  SELECT id INTO v_pay_feb_id
  FROM public.payments
  WHERE account_id = v_account_id
    AND date_paid = '2026-02-16'
    AND amount_paid = 1670.41
    AND voided_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  -- Mar 16 payment (₱1,670.46)
  SELECT id INTO v_pay_mar_id
  FROM public.payments
  WHERE account_id = v_account_id
    AND date_paid = '2026-03-16'
    AND amount_paid = 1670.46
    AND voided_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_pay_feb_id IS NULL THEN
    RAISE EXCEPTION 'Feb 16 payment (₱1,670.41) not found for account %', v_account_id;
  END IF;
  IF v_pay_mar_id IS NULL THEN
    RAISE EXCEPTION 'Mar 16 payment (₱1,670.46) not found for account %', v_account_id;
  END IF;

  RAISE NOTICE 'Feb 16 payment: %, Mar 16 payment: %', v_pay_feb_id, v_pay_mar_id;

  -- ── 3. Waive all unpaid penalties on Month 4 and Month 5 ────────────────────
  -- These were incorrectly charged because those months appeared overdue.
  -- NOTE: penalty_fee_status enum is 'unpaid'|'paid'|'waived' — 'active' does not exist.
  UPDATE public.penalty_fees
  SET status     = 'waived',
      waived_at  = now(),
      updated_at = now()
  WHERE schedule_id IN (v_month4_id, v_month5_id)
    AND status = 'unpaid';

  GET DIAGNOSTICS v_waived_count = ROW_COUNT;
  RAISE NOTICE 'Waived % penalty row(s) on Month 4 and Month 5', v_waived_count;

  -- ── 4. Reset schedule rows: strip penalties, set paid ───────────────────────
  -- Month 4
  UPDATE public.layaway_schedule
  SET penalty_amount     = 0,
      total_due_amount   = base_installment_amount,
      paid_amount        = 1670.41,
      status             = 'paid',
      updated_at         = now()
  WHERE id = v_month4_id;

  -- Month 5
  UPDATE public.layaway_schedule
  SET penalty_amount     = 0,
      total_due_amount   = base_installment_amount,
      paid_amount        = 1670.46,
      status             = 'paid',
      updated_at         = now()
  WHERE id = v_month5_id;

  RAISE NOTICE 'Schedule rows updated: Month 4 paid_amount=1670.41, Month 5 paid_amount=1670.46';

  -- ── 5. Insert payment_allocations (idempotent) ───────────────────────────────
  INSERT INTO public.payment_allocations
    (payment_id, schedule_id, allocation_type, allocated_amount)
  SELECT v_pay_feb_id, v_month4_id, 'installment', 1670.41
  WHERE NOT EXISTS (
    SELECT 1 FROM public.payment_allocations
    WHERE payment_id = v_pay_feb_id AND schedule_id = v_month4_id
  );

  INSERT INTO public.payment_allocations
    (payment_id, schedule_id, allocation_type, allocated_amount)
  SELECT v_pay_mar_id, v_month5_id, 'installment', 1670.46
  WHERE NOT EXISTS (
    SELECT 1 FROM public.payment_allocations
    WHERE payment_id = v_pay_mar_id AND schedule_id = v_month5_id
  );

  RAISE NOTICE 'payment_allocations inserted (idempotent)';

  -- ── 6. Recalculate account totals from payments (single source of truth) ─────
  SELECT COALESCE(SUM(amount_paid), 0)
  INTO v_total_paid
  FROM public.payments
  WHERE account_id = v_account_id
    AND voided_at IS NULL;

  UPDATE public.layaway_accounts
  SET total_paid        = v_total_paid,
      remaining_balance = total_amount - v_total_paid,
      status            = CASE
                            WHEN total_amount - v_total_paid <= 0 THEN 'completed'
                            ELSE status
                          END,
      updated_at        = now()
  WHERE id = v_account_id;

  RAISE NOTICE 'Account totals updated: total_paid=%, remaining_balance=%',
    v_total_paid, v_total_amount - v_total_paid;

  RAISE NOTICE 'Fix complete for INV #17456';
END $$;
