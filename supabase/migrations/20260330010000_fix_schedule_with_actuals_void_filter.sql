-- Fix schedule_with_actuals to exclude voided payment allocations.
-- Defense-in-depth: even if payment_allocations rows are not deleted on void,
-- the view will not count them. Pair with void-payment edge function change
-- that deletes payment_allocations rows on void.

CREATE OR REPLACE VIEW schedule_with_actuals AS
SELECT
  ls.id,
  ls.account_id,
  ls.installment_number,
  ls.due_date,
  ls.base_installment_amount,
  ls.penalty_amount,
  ls.carried_amount,
  ls.carried_from_schedule_id,
  ls.carried_by_payment_id,
  ls.currency,
  ls.status AS db_status,
  ls.generated_at,
  ls.updated_at,
  COALESCE(pa.allocated, 0) AS allocated,
  GREATEST(
    0,
    ls.base_installment_amount
    + COALESCE(ls.penalty_amount, 0)
    + COALESCE(ls.carried_amount, 0)
    - COALESCE(pa.allocated, 0)
  ) AS actual_remaining,
  CASE
    WHEN ls.status = 'paid' THEN 'paid'
    WHEN COALESCE(pa.allocated, 0) >=
         ls.base_installment_amount
         + COALESCE(ls.penalty_amount, 0)
         + COALESCE(ls.carried_amount, 0) - 0.005 THEN 'paid'
    WHEN COALESCE(pa.allocated, 0) > 0 THEN 'partially_paid'
    ELSE ls.status
  END AS computed_status
FROM layaway_schedule ls
LEFT JOIN (
  SELECT pa.schedule_id, COALESCE(SUM(pa.allocated_amount), 0) AS allocated
  FROM payment_allocations pa
  JOIN payments p ON p.id = pa.payment_id
  WHERE p.voided_at IS NULL
  GROUP BY pa.schedule_id
) pa ON pa.schedule_id = ls.id;
