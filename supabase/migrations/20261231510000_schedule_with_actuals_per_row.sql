-- ===========================================================================
-- schedule_with_actuals: sum allocations per schedule row (preventive).
--
-- Before: the view LEFT JOINed a derived table that summed EVERY payment
-- allocation in the database (8,368 rows on 2026-10-25) on every read — the
-- same pattern that made the System Audit time out (20261231500000). Fast
-- today, but it grows with total payment history.
--
-- After: allocated = per-row sum (LEFT JOIN LATERAL on pa.schedule_id, served
-- by the existing schedule_id indexes). Column names, order, types, the
-- formulas for actual_remaining / computed_status and security_invoker are
-- unchanged; grants are kept by CREATE OR REPLACE VIEW.
--
-- Verified on live before release (2026-10-25):
--   - all 9,595 rows identical, old vs new (EXCEPT ALL both ways = 0)
--   - as a staff login with RLS: one account 19 ms -> 2.6 ms;
--     Dashboard overdue/due-soon read 25 ms -> 20 ms
-- Readers: Account detail schedule, Multi-invoice payment dialog, Payment
-- Submissions, Admin Audit, Dashboard Needs Attention, and the SECURITY
-- DEFINER functions get_aging_buckets / get_forecast_6m / get_forecast_drilldown.
-- ===========================================================================

BEGIN;

CREATE OR REPLACE VIEW public.schedule_with_actuals
WITH (security_invoker = true) AS
 SELECT ls.id,
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
    ls.total_due_amount,
    COALESCE(pa.allocated, 0::numeric) AS allocated,
    GREATEST(0::numeric, LEAST(ls.base_installment_amount + COALESCE(ls.penalty_amount, 0::numeric) + COALESCE(ls.carried_amount, 0::numeric), ls.total_due_amount) - COALESCE(pa.allocated, 0::numeric)) AS actual_remaining,
        CASE
            WHEN ls.status = 'paid'::schedule_status THEN 'paid'::schedule_status
            WHEN COALESCE(pa.allocated, 0::numeric) >= (LEAST(ls.base_installment_amount + COALESCE(ls.penalty_amount, 0::numeric) + COALESCE(ls.carried_amount, 0::numeric), ls.total_due_amount) - 0.005) THEN 'paid'::schedule_status
            WHEN COALESCE(pa.allocated, 0::numeric) > 0::numeric THEN 'partially_paid'::schedule_status
            ELSE ls.status
        END AS computed_status
   FROM public.layaway_schedule ls
     LEFT JOIN LATERAL ( SELECT sum(pa_1.allocated_amount) AS allocated
           FROM public.payment_allocations pa_1
             JOIN public.payments p ON p.id = pa_1.payment_id
          WHERE pa_1.schedule_id = ls.id AND p.voided_at IS NULL) pa ON true;

DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'schedule_with_actuals'
       AND c.relkind = 'v' AND 'security_invoker=true' = ANY (coalesce(c.reloptions, '{}'))
  ) THEN
    RAISE EXCEPTION 'schedule_with_actuals: security_invoker is not set';
  END IF;
END $proof$;

COMMIT;
