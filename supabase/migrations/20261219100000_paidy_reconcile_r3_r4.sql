-- ===========================================================================
-- Paidy hourly check (paidy-reconcile): recovery limits R3 and R4
-- (owner go 2026-10-16 15:41 JST; QA assessment of 2026-10-11 13:15 JST).
--
-- R3 — step 5 ("Confirms left half-way") read 100 matching submissions in no
--      order and applied the 5-minute lease AFTER reading them, so the same
--      100 (some still inside their lease) could come back every run and the
--      rest were never read. Now:
--        * paidy_stuck_confirms(lease_cut, after_at, after_id, limit) lists
--          ONLY Confirms past their lease (a missing processing_started_at
--          counts as past it, as paidyConfirmLeaseExpired does), oldest first,
--          keyset-paged on (coalesce(processing_started_at, '-infinity'), id),
--          so the sweep walks every one of them.
--
-- R4 — capped lists that keep unresolved rows at the front of the line:
--        * paidy_checkout_attempts.verify_tried_at — stamped on every window
--          verification attempt; the step orders by it (never tried first),
--          so a window Paidy cannot answer for rotates to the back.
--        * paidy_cases.sweep_tried_at — the same for the orphan capture case
--          check. last_seen_at / attempts keep their meaning (a successful
--          Paidy read), so the staff Paidy cases panel is unchanged.
--
-- Additive only: two nullable columns (no default, no backfill — NULL means
-- "never tried", which sorts first, i.e. today's order for existing rows),
-- three partial indexes, one new read-only function. No existing function is
-- redefined. Touches no money.
-- ===========================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.paidy_checkout_attempts ADD COLUMN IF NOT EXISTS verify_tried_at timestamptz;
ALTER TABLE public.paidy_cases ADD COLUMN IF NOT EXISTS sweep_tried_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_paidy_checkout_attempts_verify_queue
  ON public.paidy_checkout_attempts (verify_tried_at NULLS FIRST, expires_at)
  WHERE status = 'open' AND paidy_payment_id IS NOT NULL AND verified_empty_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_paidy_cases_orphan_queue
  ON public.paidy_cases (sweep_tried_at NULLS FIRST, opened_at)
  WHERE status = 'open' AND paidy_payment_row IS NULL;

CREATE INDEX IF NOT EXISTS idx_payment_submissions_stuck_confirm
  ON public.payment_submissions ((coalesce(processing_started_at, '-infinity'::timestamptz)), id)
  WHERE status = 'confirmed' AND confirmed_payment_id IS NULL AND cash_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.paidy_stuck_confirms(
  p_lease_cut timestamptz, p_after_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  submission_id uuid, cash_order_id uuid, payment_method text, reference_number text,
  processing_started_at timestamptz, paidy_payment_id text, sort_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT s.id, s.cash_order_id, s.payment_method::text, s.reference_number,
         s.processing_started_at,
         coalesce(pp.paidy_payment_id, s.paidy_payment_id::text),
         coalesce(s.processing_started_at, '-infinity'::timestamptz)
    FROM public.payment_submissions s
    LEFT JOIN public.paidy_payments pp ON pp.id = s.paidy_payment_id
   WHERE s.cash_order_id IS NOT NULL
     AND s.status = 'confirmed'
     AND s.confirmed_payment_id IS NULL
     AND (s.processing_started_at IS NULL OR s.processing_started_at <= p_lease_cut)
     AND (p_after_at IS NULL
          OR (coalesce(s.processing_started_at, '-infinity'::timestamptz), s.id) > (p_after_at, p_after_id))
   ORDER BY coalesce(s.processing_started_at, '-infinity'::timestamptz), s.id
   LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;

REVOKE ALL ON FUNCTION public.paidy_stuck_confirms(timestamptz, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paidy_stuck_confirms(timestamptz, timestamptz, uuid, integer) TO service_role;
