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