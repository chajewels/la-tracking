
-- Fix schedule item statuses: items with future due dates should not be 'overdue'
-- They should be 'pending' if unpaid with due_date > today
UPDATE layaway_schedule
SET status = 'pending', updated_at = now()
WHERE status = 'overdue'
  AND due_date > CURRENT_DATE
  AND paid_amount < total_due_amount;

-- Fix account statuses: accounts marked 'overdue' where ALL unpaid installments are in the future
-- should be 'active' instead
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
