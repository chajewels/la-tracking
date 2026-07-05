
-- Delete all corrupt allocations for INV #17456 so reconcile-account can recreate them cleanly
DELETE FROM payment_allocations
WHERE schedule_id IN (
  SELECT id FROM layaway_schedule
  WHERE account_id = 'bd9dd0fe-5e84-4185-bb7c-573e3837f0b3'
);
