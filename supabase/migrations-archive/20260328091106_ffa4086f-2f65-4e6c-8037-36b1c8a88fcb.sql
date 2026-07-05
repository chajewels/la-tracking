
-- Fix INV #17456 inst #5: remove 2 duplicate allocations, update remaining to correct amount
-- Keep allocation 398d1482, delete the other 2 duplicates
DELETE FROM payment_allocations WHERE id IN (
  '5ca2440e-b966-4271-b133-a7286b3340c8',
  '37e88636-66c2-43e5-be09-3cedfeb134a0'
);

-- Update the remaining allocation to the full base amount
UPDATE payment_allocations 
SET allocated_amount = 1670.46
WHERE id = '398d1482-cdd1-4e3c-9644-1cb1887df55e';

-- Fix the schedule row directly
UPDATE layaway_schedule
SET paid_amount = 1670.46, status = 'paid', updated_at = now()
WHERE id = '91a1c97d-8e34-4ffb-845a-c2b6dcfcaa2d';
