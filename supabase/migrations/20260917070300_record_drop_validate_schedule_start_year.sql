-- Record-only (2026-09-17). Records a DROP that already happened live — replaying is a no-op.
--
-- Bucket (c) of the drift audit: `public.validate_schedule_start_year()` and its trigger are
-- in the baseline (20260705230000, lines 6482 and 6936) and are NOT live. They were dropped
-- at some point with no migration recording it, so a fresh rebuild from supabase/migrations/
-- would re-create a guard that production deliberately does not have.
--
-- This file makes the repo agree with live. IF EXISTS on both, so it is safe to replay and
-- safe on a fresh project where the baseline created them a moment earlier.
--
-- The other (c) entry, `expire_transfer_orders`, needs nothing: a later migration already
-- carries its DROP, so once the audit honours DROP statements (it does, as of
-- scripts/function-drift-audit) the repo and live already agree about it. CLAUDE.md records
-- the decision — removed 2026-09-13, auto-expire-cash-orders is the only expiry path.

DROP TRIGGER IF EXISTS trg_validate_schedule_start_year ON public.layaway_schedule;
DROP FUNCTION IF EXISTS public.validate_schedule_start_year();
