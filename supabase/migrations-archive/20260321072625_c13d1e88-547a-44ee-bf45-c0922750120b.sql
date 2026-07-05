
-- Fix the last remaining overdue schedule item that has a future due date
UPDATE layaway_schedule
SET status = 'pending', updated_at = now()
WHERE id = '1b775883-1fc3-4061-9706-53d9a06599c4'
  AND due_date > CURRENT_DATE;
