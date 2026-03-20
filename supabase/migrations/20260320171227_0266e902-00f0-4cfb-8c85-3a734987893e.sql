-- Fix invoice 16846: add 1000 penalty to installments 1,2,3 per source DOCX
UPDATE layaway_schedule 
SET penalty_amount = 1000, 
    total_due_amount = base_installment_amount + 1000,
    updated_at = now()
WHERE account_id = '19302796-c7c8-4143-a01b-43f27bd433a1'
AND installment_number IN (1, 2, 3);

-- Recalculate remaining_balance for this account
UPDATE layaway_accounts 
SET remaining_balance = (
  SELECT SUM(GREATEST(0, total_due_amount - paid_amount))
  FROM layaway_schedule 
  WHERE account_id = '19302796-c7c8-4143-a01b-43f27bd433a1'
  AND status NOT IN ('paid', 'cancelled')
),
updated_at = now()
WHERE id = '19302796-c7c8-4143-a01b-43f27bd433a1';

-- Insert penalty_fees records for 16846 installments 1-3
INSERT INTO penalty_fees (account_id, schedule_id, currency, penalty_amount, penalty_stage, penalty_cycle, penalty_date, status)
SELECT 
  '19302796-c7c8-4143-a01b-43f27bd433a1',
  id,
  'PHP',
  1000,
  'week1',
  1,
  '2024-09-16',
  'unpaid'
FROM layaway_schedule
WHERE account_id = '19302796-c7c8-4143-a01b-43f27bd433a1'
AND installment_number IN (1, 2, 3)
AND NOT EXISTS (
  SELECT 1 FROM penalty_fees pf WHERE pf.schedule_id = layaway_schedule.id
);