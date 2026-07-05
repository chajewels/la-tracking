
-- Revert 3 prematurely forfeited accounts back to overdue
-- #17495 (Sheryl) - forfeit date Mar 24, not yet reached
-- #17561 (Sheryl) - forfeit date Mar 30, not yet reached  
-- #17818 (Rose Perez Cezar) - forfeit date Mar 30, not yet reached
UPDATE layaway_accounts SET status = 'overdue', updated_at = now()
WHERE id IN (
  'a695b262-baad-4d38-ae50-8465942a0746',
  '792e5857-6c4a-4bfc-ac7d-acd1292bd621',
  '107ebf5a-5b13-4c39-a787-911b0d703bb6'
);

-- Un-cancel their schedule items
UPDATE layaway_schedule SET status = 'overdue', updated_at = now()
WHERE account_id IN (
  'a695b262-baad-4d38-ae50-8465942a0746',
  '792e5857-6c4a-4bfc-ac7d-acd1292bd621',
  '107ebf5a-5b13-4c39-a787-911b0d703bb6'
) AND status = 'cancelled';
