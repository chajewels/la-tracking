-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public._award_birthday_reward(p_customer_id uuid)
--   captured  : 2026-09-17 05:21:02.267226+00 (SELECT pg_get_functiondef(oid))
--   md5       : 363e35a843d5d46fd7da6a1245dbd9d3
--   length    : 2051 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = '_award_birthday_reward';
--
-- Why these exist: on 2026-09-12 a migration rebuilt approve_redemption_atomic
-- "verbatim from the live baseline … no later migration redefines this
-- function" and silently dropped a call that had been wired live in the SQL
-- Editor on 2026-07-05 and never committed. See docs/FIXED-BUGS.md #280 and
-- DRIFT-REPORT.md beside this file. The baseline is not evidence about live.

CREATE OR REPLACE FUNCTION public._award_birthday_reward(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year      smallint := EXTRACT(YEAR  FROM (now() AT TIME ZONE 'Asia/Manila'))::smallint;
  v_month     int      := EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Manila'))::int;
  v_member_id uuid;
  v_tier_id   uuid;
  v_tier_name text;
  v_bonus     integer;
  v_guarded   int;
BEGIN
  -- Atomic guard: stamp the year ONLY if it's the birth month and not already claimed this year.
  UPDATE public.customers c
  SET last_birthday_award_year = v_year
  WHERE c.id = p_customer_id
    AND c.birthday IS NOT NULL
    AND EXTRACT(MONTH FROM c.birthday) = v_month
    AND c.last_birthday_award_year IS DISTINCT FROM v_year;
  GET DIAGNOSTICS v_guarded = ROW_COUNT;

  IF v_guarded = 0 THEN
    RAISE EXCEPTION 'Birthday reward not available: no birthday set, not your birthday month, or already claimed this year';
  END IF;

  SELECT lm.id, lm.current_tier_id INTO v_member_id, v_tier_id
  FROM public.loyalty_members lm WHERE lm.customer_id = p_customer_id;

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'No loyalty member record for this customer';
  END IF;

  SELECT lt.birthday_bonus_points, lt.name INTO v_bonus, v_tier_name
  FROM public.loyalty_tiers lt WHERE lt.id = v_tier_id;

  IF v_bonus IS NULL OR v_bonus <= 0 THEN
    RAISE EXCEPTION 'No birthday bonus configured for this tier';
  END IF;

  UPDATE public.loyalty_members lm
  SET remaining_points    = lm.remaining_points    + v_bonus,
      total_points_earned = lm.total_points_earned + v_bonus
  WHERE lm.id = v_member_id;

  INSERT INTO public.loyalty_transactions
    (member_id, transaction_type, points_amount, tier_at_time, notes)
  VALUES
    (v_member_id, 'birthday_bonus'::loyalty_transaction_type, v_bonus, v_tier_name,
     'Birthday bonus ' || v_year::text);

  RETURN jsonb_build_object('success', true, 'points_awarded', v_bonus, 'tier', v_tier_name, 'year', v_year);
END;
$function$
