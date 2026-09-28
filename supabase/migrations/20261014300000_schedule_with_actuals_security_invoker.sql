-- Lovable scan 2026-09-29, finding L2 (security): the schedule view bypasses RLS.
--
-- public.schedule_with_actuals is owned by postgres and was created without
-- security_invoker, so every read of it runs with the OWNER's rights and skips
-- the row-level security on layaway_schedule, payment_allocations and
-- payments. Verified on live 2026-09-29 as a signed-in PORTAL CUSTOMER:
--   SELECT count(*) FROM layaway_schedule       → 0     (RLS works)
--   SELECT count(*) FROM schedule_with_actuals  → 9,223 (every customer's schedule)
--
-- Fix: security_invoker = true. Reads then run as the caller, so the existing
-- policies apply: staff (is_staff) still see everything; a customer sees only
-- her own schedule rows. Nothing customer-facing reads this view with a user
-- session (the portal and the storefront go through service-role edge
-- functions), and the three SECURITY DEFINER functions that read it
-- (get_aging_buckets, get_forecast_6m, get_forecast_drilldown) run as their
-- owner, so they are unaffected. get_collection_analytics (SECURITY INVOKER)
-- is called by staff, who pass the staff policies.
--
-- ORDER: apply AFTER 20261014200000_rls_staff_check_once.sql — once the view
-- runs as the caller, the per-row staff check would otherwise be paid on every
-- schedule, allocation and payment row the view touches.
-- The view definition and its grants are unchanged. Idempotent.

BEGIN;

ALTER VIEW public.schedule_with_actuals SET (security_invoker = true);

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
