
-- Restore INV #17456 account totals
UPDATE layaway_accounts
SET total_paid = 12647.77,
    remaining_balance = 1666.23,
    status = 'active',
    updated_at = now()
WHERE id = 'bd9dd0fe-5e84-4185-bb7c-573e3837f0b3';

-- Restore schedule rows 1-5 to paid with correct amounts
UPDATE layaway_schedule SET paid_amount = 1672.41, status = 'paid', updated_at = now()
WHERE id = '7a0dce8d-5743-4d72-b7f4-2753ff6cdd10';

UPDATE layaway_schedule SET paid_amount = 1670.09, status = 'paid', updated_at = now()
WHERE id = '87581556-e0a6-4fae-9ce2-300ee90e10d7';

UPDATE layaway_schedule SET paid_amount = 1670.40, status = 'paid', updated_at = now()
WHERE id = 'cfc07ffb-d3d5-4a75-8f5c-70ffa59050f1';

UPDATE layaway_schedule SET paid_amount = 1670.41, status = 'paid', updated_at = now()
WHERE id = '3f210c7f-2387-4625-8516-0a12421e76fc';

UPDATE layaway_schedule SET paid_amount = 1670.46, status = 'paid', updated_at = now()
WHERE id = '91a1c97d-8e34-4ffb-845a-c2b6dcfcaa2d';

-- Installment 6 stays pending/0
UPDATE layaway_schedule SET paid_amount = 0, status = 'pending', updated_at = now()
WHERE id = '3add5ce1-6801-4dca-82ed-bb74db8477c1';
