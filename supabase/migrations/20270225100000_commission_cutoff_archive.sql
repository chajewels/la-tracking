-- Commission cut-off (21st-20th) + Sales Log archive (owner-confirmed plan 2026-10-30; docs/COMMISSIONS.md).
--
--   * commission_splits.cutoff_day (1-28, NULL = end of month). A commission period is named after the
--     month it ENDS in. NULL on every existing row, so every past month stays a calendar month.
--   * commission_period_month(date) = the period key (first of month) a sale_date belongs to; the same rule as
--     periodKeyForDate in src/lib/commissionEngine.ts. commission_period_is_closed(date) = that period ended
--     before today in Philippine time.
--   * sales_log_archive_guard: a DIRECT edit from the screen (current_user = 'authenticated') on a sale in a
--     closed period is refused unless public.can_manage_payslips(auth.uid()) (admin, or Brenda).
--     service_role and SECURITY DEFINER functions (owner role) pass untouched, so the automatic Pending -> Paid
--     flip, cancel, rename and the Page365 sync keep working on archived sales. The guard never modifies NEW.
--
--   Additive only: nothing existing is redefined (not autocheck_sales_log_eligible, not the sales_log policy).
--   Re-runnable. No comment lines inside any function body (Lovable strips them).

SET lock_timeout = '15s';

ALTER TABLE public.commission_splits
  ADD COLUMN IF NOT EXISTS cutoff_day smallint NULL;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.commission_splits'::regclass
                    AND conname = 'commission_splits_cutoff_day_range') THEN
    ALTER TABLE public.commission_splits
      ADD CONSTRAINT commission_splits_cutoff_day_range CHECK (cutoff_day BETWEEN 1 AND 28);
  END IF;
END
$c$;
COMMENT ON COLUMN public.commission_splits.cutoff_day IS
  'Last day of the commission period that ENDS in this month (1-28). NULL = end of month. Inherits forward like the percentages.';

CREATE OR REPLACE FUNCTION public.commission_period_month(p_date date)
RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE
           WHEN s.cutoff_day IS NULL OR EXTRACT(day FROM p_date) <= s.cutoff_day
             THEN date_trunc('month', p_date)::date
           ELSE (date_trunc('month', p_date) + interval '1 month')::date
         END
    FROM (SELECT 1) x
    LEFT JOIN LATERAL (
      SELECT cs.cutoff_day FROM public.commission_splits cs
       WHERE cs.month <= date_trunc('month', p_date)::date
       ORDER BY cs.month DESC LIMIT 1
    ) s ON true
$fn$;
REVOKE ALL ON FUNCTION public.commission_period_month(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commission_period_month(date) TO authenticated, service_role;
COMMENT ON FUNCTION public.commission_period_month(date) IS
  'First-of-month key of the commission period a sale_date belongs to. Split resolved like resolveSplit (exact month, else latest month <= target). NULL cutoff_day or day <= cutoff_day: the date''s own month; otherwise the next month.';

CREATE OR REPLACE FUNCTION public.commission_period_is_closed(p_date date)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT p_date IS NOT NULL AND (
    SELECT CASE WHEN s.cutoff_day IS NULL
                THEN (k.key + interval '1 month')::date - 1
                ELSE (k.key + (s.cutoff_day - 1) * interval '1 day')::date
           END
      FROM (SELECT public.commission_period_month(p_date) AS key) k
      LEFT JOIN LATERAL (
        SELECT cs.cutoff_day FROM public.commission_splits cs
         WHERE cs.month <= k.key ORDER BY cs.month DESC LIMIT 1
      ) s ON true
  ) < (now() AT TIME ZONE 'Asia/Manila')::date
$fn$;
REVOKE ALL ON FUNCTION public.commission_period_is_closed(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commission_period_is_closed(date) TO authenticated, service_role;
COMMENT ON FUNCTION public.commission_period_is_closed(date) IS
  'True when the commission period of p_date ended before today in Philippine time (period end = the cutoff_day of its month, or month end).';

CREATE OR REPLACE FUNCTION public.sales_log_archive_guard()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF current_user <> 'authenticated' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF (TG_OP IN ('UPDATE', 'DELETE') AND public.commission_period_is_closed(OLD.sale_date))
     OR (TG_OP IN ('INSERT', 'UPDATE') AND public.commission_period_is_closed(NEW.sale_date))
  THEN
    IF NOT public.can_manage_payslips(auth.uid()) THEN
      RAISE EXCEPTION 'This sale is in an archived commission period. Only Admin or Brenda can change it.'
        USING ERRCODE = 'CJA01';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.sales_log_archive_guard() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.sales_log_archive_guard() IS
  'Refuses a direct (role authenticated) insert/update/delete of a sales_log row in a closed commission period unless can_manage_payslips. service_role and SECURITY DEFINER functions pass. Never modifies NEW. SQLSTATE CJA01.';

DROP TRIGGER IF EXISTS sales_log_archive_guard ON public.sales_log;
CREATE TRIGGER sales_log_archive_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.sales_log
  FOR EACH ROW EXECUTE FUNCTION public.sales_log_archive_guard();
COMMENT ON TRIGGER sales_log_archive_guard ON public.sales_log IS
  'Archive guard: direct edits of a closed commission period are Admin/Brenda only.';
