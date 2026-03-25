
-- ═══════════════════════════════════════════════════════════════
-- FIX Invoice 17416 (account 579bc43a): month 1 allocation
-- Delete wrong 500 penalty allocation from month 5, update month 1 to full amount
-- ═══════════════════════════════════════════════════════════════

-- Delete the incorrect penalty allocation (500 from payment cab08d17 to month 5)
DELETE FROM payment_allocations WHERE id = 'e208fa40-7636-4d7c-926b-5a9479083d6d';

-- Update month 1 allocation to full payment amount (3665.27 → 4165.27)
UPDATE payment_allocations 
SET allocated_amount = 4165.27 
WHERE id = '618580e6-681b-446c-a936-212bea4c5602';

-- Sync month 5 paid_amount: remove the 500 penalty allocation effect
-- Month 5 has installment alloc 4164.91 only now
UPDATE layaway_schedule 
SET paid_amount = 4164.91, status = 'paid', updated_at = now()
WHERE id = 'ea233fc4-8c97-45af-a07f-71c94674d0bb';

-- Month 6: has 500 installment allocation, partially_paid is correct already

-- ═══════════════════════════════════════════════════════════════
-- FIX Invoice 18015 (account 65ba552d): schedule + account totals
-- ═══════════════════════════════════════════════════════════════

-- Month 3: actual allocation is 4762, fix paid_amount and status
UPDATE layaway_schedule 
SET paid_amount = 4762.00, status = 'partially_paid', updated_at = now()
WHERE id = 'dceeb2e4-6dd6-4207-abb2-8a91611efd30';

-- Fix account totals: actual payments sum = 13194+5131+5500+5500 = 29325
-- Penalty paid = 0 (all waived), so remaining = 43980 - 29325 = 14655
UPDATE layaway_accounts 
SET total_paid = 29325.00, 
    remaining_balance = 14655.00, 
    updated_at = now()
WHERE id = '65ba552d-da56-44fe-b54d-96cb7f9b3a3c';
