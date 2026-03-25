
-- ═══════════════════════════════════════════════════════════════
-- FIX remaining_balance for #17416 and #17737
-- remaining_balance must equal SUM(unpaid base_installment_amount) from schedule
-- ═══════════════════════════════════════════════════════════════

-- #17416 (579bc43a): Month 6 has 500 already paid, so remaining = base 4162.14 - paid 500 = 3662.14
UPDATE layaway_accounts 
SET remaining_balance = 3662.14, updated_at = now()
WHERE id = '579bc43a-13da-4f28-a608-82faaf232b21'
  AND invoice_number = '17416';

-- #17737 (581b19f8): Unpaid principal = month 5 (3054-2500=554) + month 6 (2954.73-0=2954.73) = 3508.73
UPDATE layaway_accounts 
SET remaining_balance = 3508.73, updated_at = now()
WHERE id = '581b19f8-d35f-4f32-bc81-31f70a1936d6'
  AND invoice_number = '17737';
