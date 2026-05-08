-- =================================================================
-- prevent_customer_code_change
-- =================================================================
-- Defense-in-depth trigger: blocks UPDATE of customers.customer_code.
-- Frontend EditCustomerDialog already locks the field (2026-04-28).
-- This trigger guards against direct PostgREST calls, future RPCs,
-- and manual SQL Editor mistakes.
--
-- LEGITIMATE FORENSIC REPAIR PATH:
--   Per CLAUDE.md "CUSTOMER CODE STANDARD" → Forensic repair:
--     BEGIN;
--     SET LOCAL app.allow_customer_code_change = 'on';
--     UPDATE public.customers SET customer_code = '<new>' WHERE id = ...;
--     INSERT INTO public.audit_logs (...);
--     COMMIT;
--
--   The GUC bypass is transaction-scoped (SET LOCAL); does not leak.
--
-- Pattern mirrors existing GUC bypasses:
--   - app.bypass_immutable_schedule_cols
--   - app.allow_base_edit
--
-- Applied to production via SQL Editor 2026-05-08.
-- All 3 smoke tests passed:
--   1. UPDATE without bypass → blocked with descriptive EXCEPTION
--   2. UPDATE with GUC bypass → succeeded
--   3. UPDATE non-customer_code column → succeeded (trigger didn't fire)
-- =================================================================

CREATE OR REPLACE FUNCTION public.prevent_customer_code_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.customer_code IS DISTINCT FROM OLD.customer_code THEN
    IF current_setting('app.allow_customer_code_change', true) = 'on' THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'customer_code is immutable post-creation. For forensic repair: SET LOCAL app.allow_customer_code_change = ''on''; before UPDATE. See CLAUDE.md "CUSTOMER CODE STANDARD" → Forensic repair.'
      USING HINT = 'Frontend EditCustomerDialog excludes customer_code. To repair, use SQL Editor with the GUC bypass and add a manual audit_logs entry.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prevent_customer_code_change() IS
  'Defense-in-depth: blocks UPDATE of customers.customer_code. Bypass via SET LOCAL app.allow_customer_code_change = ''on''. Pattern mirrors app.bypass_immutable_schedule_cols. Created 2026-05-08.';

DROP TRIGGER IF EXISTS prevent_customer_code_change ON public.customers;

CREATE TRIGGER prevent_customer_code_change
BEFORE UPDATE ON public.customers
FOR EACH ROW
EXECUTE FUNCTION public.prevent_customer_code_change();
