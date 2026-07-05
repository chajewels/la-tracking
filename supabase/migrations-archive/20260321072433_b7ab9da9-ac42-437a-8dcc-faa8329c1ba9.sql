
-- Fix payment schedule year assignments across all invoices
-- Rule: Sep-Dec months → year 2025, Jan-Aug months → year 2026
-- All affected accounts currently have dates 1 year too early (need +1 year)

-- Step 1: Add 1 year to all schedule items for accounts whose 1st installment has wrong year
UPDATE layaway_schedule
SET due_date = due_date + INTERVAL '1 year',
    updated_at = now()
WHERE account_id IN (
  SELECT DISTINCT ls.account_id
  FROM layaway_schedule ls
  WHERE ls.installment_number = 1
    AND (
      (EXTRACT(MONTH FROM ls.due_date) BETWEEN 9 AND 12 AND EXTRACT(YEAR FROM ls.due_date) != 2025)
      OR
      (EXTRACT(MONTH FROM ls.due_date) BETWEEN 1 AND 8 AND EXTRACT(YEAR FROM ls.due_date) != 2026)
    )
);

-- Step 2: Update order_date and end_date on the corresponding layaway_accounts
UPDATE layaway_accounts
SET order_date = order_date + INTERVAL '1 year',
    end_date = end_date + INTERVAL '1 year',
    updated_at = now()
WHERE id IN (
  SELECT DISTINCT ls.account_id
  FROM layaway_schedule ls
  WHERE ls.installment_number = 1
    AND (
      (EXTRACT(MONTH FROM ls.due_date) BETWEEN 9 AND 12 AND EXTRACT(YEAR FROM ls.due_date) != 2025)
      OR
      (EXTRACT(MONTH FROM ls.due_date) BETWEEN 1 AND 8 AND EXTRACT(YEAR FROM ls.due_date) != 2026)
    )
);
