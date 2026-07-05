-- ─────────────────────────────────────────────────────────────────────────────
-- Fix INV #18031 Month 5 schedule row
--
-- Month 5 (due 2026-05-31) was incorrectly marked 'paid' at ₱1,886 even though
-- base_installment_amount is ₱3,014.50.  It is partially_paid with ₱1,128.50
-- remaining.
--
-- Fix:
--   status           → 'partially_paid'
--   total_due_amount → base_installment_amount - paid_amount  (= ~1,128.50)
--   paid_amount      — unchanged (1886 is correct)
--   base_installment_amount — unchanged
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

UPDATE layaway_schedule
SET   status           = 'partially_paid',
      total_due_amount = base_installment_amount - paid_amount,
      updated_at       = NOW()
WHERE account_id = 'ef0cc79f-2bdc-49e2-a3aa-38da25f9a644'
  AND due_date   = '2026-05-31'
  AND status     = 'paid';

DO $$
BEGIN
  RAISE NOTICE 'Rows updated: %', (
    SELECT COUNT(*) FROM layaway_schedule
    WHERE account_id = 'ef0cc79f-2bdc-49e2-a3aa-38da25f9a644'
      AND due_date   = '2026-05-31'
      AND status     = 'partially_paid'
  );
END $$;

-- Verify: show the fixed row
SELECT id, installment_number, due_date,
       base_installment_amount, paid_amount, total_due_amount, status
FROM   layaway_schedule
WHERE  account_id = 'ef0cc79f-2bdc-49e2-a3aa-38da25f9a644'
  AND  due_date   = '2026-05-31';

COMMIT;
