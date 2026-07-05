UPDATE layaway_accounts 
SET remaining_balance = (
  SELECT COALESCE(SUM(total_due_amount - paid_amount), 0)
  FROM layaway_schedule 
  WHERE account_id = '972b7a55-721d-4c63-a86f-7de1e5473894'
    AND status NOT IN ('paid', 'cancelled')
),
updated_at = now()
WHERE id = '972b7a55-721d-4c63-a86f-7de1e5473894'