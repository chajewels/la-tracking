-- Create TEST-FORFEIT-001: auto-forfeit testing account
--
-- Setup:
--   Currency: PHP | Base LA: ₱20,000 | DP: ₱6,000 (paid 2025-11-28)
--   3 installment months, all OVERDUE — never paid
--   Month 1 due 2025-12-28 → exactly 3 calendar months before today (2026-03-28)
--   → auto-forfeit-settlement should forfeit this account on next run
--
-- DO NOT MODIFY DATA — this is a locked test fixture.

-- 1. Customer
INSERT INTO public.customers (customer_code, full_name)
VALUES ('TEST-FORFEIT-001', 'TEST ACCOUNT FORFEIT-001 (Auto-Forfeit Testing)')
ON CONFLICT (customer_code) DO UPDATE
  SET full_name = EXCLUDED.full_name;

-- 2. Layaway account
INSERT INTO public.layaway_accounts (
  customer_id,
  invoice_number,
  currency,
  total_amount,
  payment_plan_months,
  order_date,
  end_date,
  status,
  total_paid,
  remaining_balance,
  downpayment_amount
)
VALUES (
  (SELECT id FROM public.customers WHERE customer_code = 'TEST-FORFEIT-001'),
  'TEST-FORFEIT-001',
  'PHP',
  20000.00,
  3,
  '2025-11-28',
  '2026-02-28',
  'overdue',
  6000.00,
  14000.00,
  6000.00
)
ON CONFLICT (invoice_number) DO NOTHING;

-- 3. Schedule rows (installments 1–3, all overdue)
--    Amounts: ₱4,667 + ₱4,667 + ₱4,666 = ₱14,000
INSERT INTO public.layaway_schedule (
  account_id,
  installment_number,
  due_date,
  base_installment_amount,
  penalty_amount,
  total_due_amount,
  paid_amount,
  currency,
  status
)
SELECT
  a.id,
  s.installment_number,
  s.due_date::date,
  s.base_amount,
  0,
  s.base_amount,
  0,
  'PHP',
  'overdue'
FROM public.layaway_accounts a
CROSS JOIN (VALUES
  (1, '2025-12-28', 4667.00),
  (2, '2026-01-27', 4667.00),
  (3, '2026-02-26', 4666.00)
) AS s(installment_number, due_date, base_amount)
WHERE a.invoice_number = 'TEST-FORFEIT-001'
ON CONFLICT (account_id, installment_number) DO NOTHING;

-- 4. Downpayment payment record
INSERT INTO public.payments (
  account_id,
  amount_paid,
  currency,
  date_paid,
  payment_method,
  reference_number,
  remarks
)
SELECT
  a.id,
  6000.00,
  'PHP',
  '2025-11-28',
  'cash',
  'DP-TEST-FORFEIT-001',
  'Downpayment'
FROM public.layaway_accounts a
WHERE a.invoice_number = 'TEST-FORFEIT-001'
  AND NOT EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.account_id = a.id
      AND p.reference_number = 'DP-TEST-FORFEIT-001'
  );
