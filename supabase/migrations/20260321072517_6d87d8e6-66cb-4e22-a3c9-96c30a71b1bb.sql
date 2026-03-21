
-- Fix account-level order_date and end_date to match corrected schedule dates
-- These accounts still have old year on order_date/end_date because the first migration
-- shifted schedule dates before the subquery in step 2 could match them.

-- Update order_date and end_date to match their actual schedule min/max dates
UPDATE layaway_accounts la
SET 
  order_date = sub.min_due - INTERVAL '1 month',
  end_date = sub.max_due,
  updated_at = now()
FROM (
  SELECT 
    ls.account_id,
    MIN(ls.due_date) as min_due,
    MAX(ls.due_date) as max_due
  FROM layaway_schedule ls
  WHERE ls.status != 'cancelled'
  GROUP BY ls.account_id
) sub
WHERE la.id = sub.account_id
  AND (
    EXTRACT(YEAR FROM la.end_date) != EXTRACT(YEAR FROM sub.max_due)
    OR EXTRACT(YEAR FROM la.order_date) < EXTRACT(YEAR FROM sub.min_due) - 1
  );
