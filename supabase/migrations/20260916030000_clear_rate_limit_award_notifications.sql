-- Clear the staff notifications that asserted a failed loyalty award which was
-- never actually evaluated.
--
-- WHAT HAPPENED. The loyalty sweep's first real run (2026-09-16 02:06, run
-- 2e2d3ff9) asked award-loyalty-points about 287 candidates over a bare fetch.
-- The Deno isolate's rate limiter REJECTS rather than returning 429, so once it
-- tripped, 257 candidates failed instantly — all inside 02:06:33–34, all with
-- one trace id, each asking to be retried ~22s later — and each wrote a
-- `loyalty_award_failed` row.
--
-- WHY THEY MUST GO. Those rows say an award could not be made. Nothing of the
-- kind was established: the sweep never got an answer for any of them. Leaving
-- 257 false assertions in the bell is worse than leaving it empty, because the
-- next person to read it would conclude 257 customers had been checked and
-- found owed nothing.
--
-- The 30 candidates that WERE evaluated are unaffected, including the single
-- genuine recovery (Jeanne Arun, Inv #18983, +800 pts) which is a
-- `loyalty_award_missing` row and is not touched by this predicate.
--
-- The retry helper that prevents a recurrence ships in the same PR
-- (_shared/fetch-retry.ts), and the sweep no longer writes a per-candidate
-- failure for an unreachable service — one aggregate notification per run
-- instead, which still raises.
--
-- SELF-REPORTING ON PURPOSE. This was authored where the live database is not
-- reachable, so the block counts before it deletes and RAISEs both numbers.
-- Read the NOTICE output: `deleting N` must be the rate-limit rows and
-- `leaving M` must be every other loyalty_award_failed row, untouched.

DO $$
DECLARE
  v_junk  integer;
  v_other integer;
  v_gone  integer;
BEGIN
  SELECT count(*) INTO v_junk
    FROM public.staff_notifications
   WHERE type = 'loyalty_award_failed'
     AND body LIKE '%RateLimitError%';

  SELECT count(*) INTO v_other
    FROM public.staff_notifications
   WHERE type = 'loyalty_award_failed'
     AND body NOT LIKE '%RateLimitError%';

  RAISE NOTICE 'clear_rate_limit_award_notifications: deleting % rate-limit rows; leaving % other loyalty_award_failed rows', v_junk, v_other;

  DELETE FROM public.staff_notifications
   WHERE type = 'loyalty_award_failed'
     AND body LIKE '%RateLimitError%';

  GET DIAGNOSTICS v_gone = ROW_COUNT;
  RAISE NOTICE 'clear_rate_limit_award_notifications: deleted % rows', v_gone;

  IF v_gone <> v_junk THEN
    RAISE EXCEPTION 'count moved between the check and the delete (% vs %) — investigate before re-running', v_junk, v_gone;
  END IF;
END $$;

-- Verification after applying:
--   -- expect 0
--   SELECT count(*) FROM staff_notifications
--    WHERE type = 'loyalty_award_failed' AND body LIKE '%RateLimitError%';
--   -- expect the single genuine recovery to still be there
--   SELECT created_at, title, body FROM staff_notifications
--    WHERE type = 'loyalty_award_missing' AND created_at > '2026-09-16'::date;
