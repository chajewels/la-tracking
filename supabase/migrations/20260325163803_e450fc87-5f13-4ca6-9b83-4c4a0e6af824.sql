
-- ═══════════════════════════════════════════════════════════════
-- SYSTEM-WIDE FIX: Sync remaining_balance to actual unpaid principal
-- remaining_balance = SUM(base_installment_amount - paid_amount) for non-paid/non-cancelled schedule rows
-- This corrects all accounts where penalty payments incorrectly reduced the principal balance
-- ═══════════════════════════════════════════════════════════════

UPDATE layaway_accounts la
SET remaining_balance = COALESCE(schedule_unpaid.unpaid_principal, 0),
    updated_at = now()
FROM (
  SELECT 
    ls.account_id,
    SUM(GREATEST(0, ls.base_installment_amount - ls.paid_amount)) as unpaid_principal
  FROM layaway_schedule ls
  WHERE ls.status NOT IN ('paid', 'cancelled')
  GROUP BY ls.account_id
) schedule_unpaid
WHERE la.id = schedule_unpaid.account_id
  AND la.status NOT IN ('forfeited', 'final_forfeited', 'cancelled', 'completed')
  AND ABS(la.remaining_balance - schedule_unpaid.unpaid_principal) > 1;
