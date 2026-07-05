
-- Fix month 5 total_due_amount to include penalty (base 4164 + penalty 500 = 4664)
UPDATE layaway_schedule
SET total_due_amount = base_installment_amount + penalty_amount
WHERE id = '20072149-0bbb-4cf3-a790-0e2105a3daf0'
AND account_id = 'b73fc850-bd36-46cf-8e42-5ed3013fa43b';
