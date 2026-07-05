
-- Clean up allocations from voided payments for account 17416
DELETE FROM payment_allocations 
WHERE payment_id IN (
  SELECT id FROM payments 
  WHERE account_id = '579bc43a-13da-4f28-a608-82faaf232b21' 
  AND voided_at IS NOT NULL
);

-- Fix payment ba722389 allocations:
-- Remove wrong 500 allocation to month 1
DELETE FROM payment_allocations 
WHERE id = 'a34b0358-7261-41fa-b390-b28431680498';

-- Update month 2 allocation from 3664.18 to 4164.18
UPDATE payment_allocations 
SET allocated_amount = 4164.18 
WHERE id = '1e538465-65c0-4467-a46d-574028ad9c2c';

-- Sync schedule month 2: paid_amount = 4164.18, status = paid
UPDATE layaway_schedule 
SET paid_amount = 4164.18, status = 'paid', updated_at = now()
WHERE id = '5e0a83c3-e7f5-41c5-a9dc-f02b4dd88123';
