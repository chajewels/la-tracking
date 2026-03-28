-- Fix INV #17456 Month 5: partial allocation gap
--
-- Root cause: a pre-existing payment_allocations row allocated only ₱1,482.95
-- of the Mar 16 payment (₱1,670.46) to Month 5, leaving ₱187.51 unallocated.
-- The WHERE NOT EXISTS guard in the previous migration prevented the correct
-- full-amount row from being inserted.
--
-- This migration inserts the missing gap allocation and ensures the schedule
-- row reflects the correct paid/₱1,670.46 state.

DO $$
DECLARE
  v_account_id        UUID;
  v_month5_id         UUID;
  v_month5_base       NUMERIC;
  v_pay_mar_id        UUID;
  v_existing_alloc    NUMERIC;
  v_gap               NUMERIC;
BEGIN
  -- Resolve account
  SELECT id INTO v_account_id
  FROM public.layaway_accounts
  WHERE invoice_number = '17456';

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'INV #17456 not found';
  END IF;

  -- Get Month 5 schedule row
  SELECT id, base_installment_amount
    INTO v_month5_id, v_month5_base
  FROM public.layaway_schedule
  WHERE account_id = v_account_id
    AND installment_number = 5
  LIMIT 1;

  IF v_month5_id IS NULL THEN
    RAISE EXCEPTION 'Month 5 schedule row not found for INV #17456';
  END IF;

  -- Find the Mar 16 payment
  SELECT id INTO v_pay_mar_id
  FROM public.payments
  WHERE account_id = v_account_id
    AND date_paid = '2026-03-16'
    AND voided_at IS NULL
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_pay_mar_id IS NULL THEN
    RAISE EXCEPTION 'Mar 16 payment not found for INV #17456';
  END IF;

  -- Sum all existing allocations for this payment → Month 5
  SELECT COALESCE(SUM(allocated_amount), 0)
    INTO v_existing_alloc
  FROM public.payment_allocations
  WHERE payment_id = v_pay_mar_id
    AND schedule_id = v_month5_id
    AND allocation_type = 'installment';

  v_gap := v_month5_base - v_existing_alloc;

  RAISE NOTICE 'INV #17456 Month 5: base=₱%, existing_alloc=₱%, gap=₱%',
    v_month5_base, v_existing_alloc, v_gap;

  -- Insert the missing gap allocation if needed
  IF v_gap > 0.005 THEN
    INSERT INTO public.payment_allocations
      (payment_id, schedule_id, allocation_type, allocated_amount)
    VALUES
      (v_pay_mar_id, v_month5_id, 'installment', v_gap);

    RAISE NOTICE 'Inserted gap allocation of ₱% for payment % → Month 5', v_gap, v_pay_mar_id;
  ELSE
    RAISE NOTICE 'No gap allocation needed (gap = ₱%)', v_gap;
  END IF;

  -- Force schedule row to paid / base amount (reconcile-account will confirm this)
  UPDATE public.layaway_schedule
  SET paid_amount     = v_month5_base,
      status          = 'paid',
      penalty_amount  = 0,
      total_due_amount = v_month5_base,
      updated_at      = NOW()
  WHERE id = v_month5_id;

  RAISE NOTICE 'Month 5 set to paid/₱%', v_month5_base;
END $$;
