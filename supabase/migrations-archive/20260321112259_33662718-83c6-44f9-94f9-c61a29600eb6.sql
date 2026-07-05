
-- Fix broken schedule chronology: 37 accounts where installments 2+ have dates BEFORE installment 1
-- These installments need +1 year to be chronologically after installment 1

-- Step 1: Shift the broken installments by +1 year
WITH first_installment AS (
  SELECT account_id, due_date as first_due
  FROM layaway_schedule
  WHERE installment_number = 1 AND status != 'cancelled'
)
UPDATE layaway_schedule ls
SET due_date = ls.due_date + INTERVAL '1 year',
    updated_at = now()
FROM first_installment fi
WHERE ls.account_id = fi.account_id
  AND ls.installment_number > 1
  AND ls.status != 'cancelled'
  AND ls.due_date < fi.first_due;

-- Step 2: Update account end_date to match the corrected max schedule date
UPDATE layaway_accounts la
SET end_date = sub.max_due,
    updated_at = now()
FROM (
  SELECT ls.account_id, MAX(ls.due_date) as max_due
  FROM layaway_schedule ls
  WHERE ls.status != 'cancelled'
  GROUP BY ls.account_id
) sub
WHERE la.id = sub.account_id
  AND la.end_date IS DISTINCT FROM sub.max_due;

-- Step 3: Fix schedule statuses - future unpaid items should be 'pending' not 'overdue'
UPDATE layaway_schedule
SET status = 'pending', updated_at = now()
WHERE status = 'overdue'
  AND due_date > CURRENT_DATE
  AND paid_amount < total_due_amount;

-- Step 4: Mark past-due unpaid items as 'overdue'
UPDATE layaway_schedule
SET status = 'overdue', updated_at = now()
WHERE status = 'pending'
  AND due_date < CURRENT_DATE
  AND paid_amount < total_due_amount;

-- Step 5: Fix account statuses
-- Accounts with past-due unpaid installments should be 'overdue'
UPDATE layaway_accounts la
SET status = 'overdue', updated_at = now()
WHERE la.status = 'active'
  AND EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = la.id
      AND ls.status != 'cancelled'
      AND ls.paid_amount < ls.total_due_amount
      AND ls.due_date < CURRENT_DATE
  );

-- Accounts with NO past-due unpaid installments should be 'active' (not overdue)
UPDATE layaway_accounts la
SET status = 'active', updated_at = now()
WHERE la.status = 'overdue'
  AND NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = la.id
      AND ls.status != 'cancelled'
      AND ls.paid_amount < ls.total_due_amount
      AND ls.due_date <= CURRENT_DATE
  )
  AND EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = la.id
      AND ls.status != 'cancelled'
      AND ls.paid_amount < ls.total_due_amount
  );

-- Step 6: Add pg_cron job for penalty engine (daily at 8:05 AM PHT = 00:05 UTC)
SELECT cron.schedule(
  'daily-penalty-engine',
  '5 0 * * *',
  $$
  SELECT net.http_post(
    url:='https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/penalty-engine',
    headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmb2ljYWxwemRjbXl4enZ3eWh6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1NzIyMTIsImV4cCI6MjA4OTE0ODIxMn0.pshjGSTgmkn1dLSI_uWQMEczyYZhYVtEUulDxyutZyU"}'::jsonb,
    body:='{}'::jsonb
  ) AS request_id;
  $$
);
