-- ============================================================
-- FIX: Restore inflated total_due_amount on pending/overdue rows
--
-- Root cause: record-payment and accept-underpayment previously
-- added the carry-over shortfall to the next row's total_due_amount.
-- This inflated future rows, causing double-counting in the
-- REMAINING column and sumOfPendingMonths audit check.
--
-- STEP 1 — Run this SELECT first to see affected rows:
--
-- SELECT COUNT(*) AS affected_rows, account_id
-- FROM layaway_schedule
-- WHERE status IN ('pending', 'overdue')
--   AND total_due_amount != base_installment_amount + COALESCE(penalty_amount, 0)
-- GROUP BY account_id
-- ORDER BY COUNT(*) DESC;
--
-- STEP 2 — This migration restores them to base + penalty:
-- ============================================================

UPDATE layaway_schedule
SET    total_due_amount = base_installment_amount + COALESCE(penalty_amount, 0),
       updated_at       = NOW()
WHERE  status IN ('pending', 'overdue')
  AND  total_due_amount != base_installment_amount + COALESCE(penalty_amount, 0);
