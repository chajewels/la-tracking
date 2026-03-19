UPDATE layaway_schedule 
SET base_installment_amount = 11314, total_due_amount = 11314 + penalty_amount
WHERE account_id = '10f02e15-5cfe-44fe-94aa-a78a2354167c'
  AND installment_number IN (5, 6)
  AND status != 'paid'