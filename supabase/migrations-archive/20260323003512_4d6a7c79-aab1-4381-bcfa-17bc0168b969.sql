UPDATE layaway_schedule 
SET total_due_amount = base_installment_amount + penalty_amount,
    updated_at = now()
WHERE id = 'b13d2fd3-7c18-4dab-9d3f-9f48807610e7'