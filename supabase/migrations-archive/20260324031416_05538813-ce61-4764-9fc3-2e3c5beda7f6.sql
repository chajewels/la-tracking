
-- Fix corrupted schedule data for inv 17789 (account 98dd9296-55d4-4eb2-bb4d-9a8335a8aaa6)
-- Installments 4 and 5 incorrectly show as paid from a voided payment's allocations

-- Reset inst 4 (due 2026-03-26) - only allocation is from voided payment
UPDATE layaway_schedule SET paid_amount = 0, status = 'pending'
WHERE id = 'e7f17b99-234c-4c20-9d30-c1c3a4f63aff';

-- Reset inst 5 (due 2026-04-26) - only allocation is from voided payment  
UPDATE layaway_schedule SET paid_amount = 0, status = 'pending'
WHERE id = '6ffc64c6-177f-44bc-898e-95c990d60bcd';

-- Delete orphaned allocations from voided payment 73bb885f
DELETE FROM payment_allocations 
WHERE payment_id = '73bb885f-7b6e-454d-83ab-a068da190704';

-- Fix account totals: total_paid = sum of non-voided payments = 22929.19
-- remaining_balance = 35271.76 - 22929.19 = 12342.57
UPDATE layaway_accounts SET 
  total_paid = 22929.19,
  remaining_balance = 12342.57,
  status = 'active'
WHERE id = '98dd9296-55d4-4eb2-bb4d-9a8335a8aaa6';
