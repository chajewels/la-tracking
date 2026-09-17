-- Record-only (2026-09-17). Captured from live via pg_get_functiondef after Cynthia
-- applied docs/sql/20260917_birthday_lot_expiry_owner_rule.sql — already applied;
-- replaying is a no-op.
--
--   md5    : 96836e0399ccbb0c25cbdb691c1630ae
--   length : 3104 bytes
--
-- WHAT CHANGED. The birthday-lot expiry is back to the OWNER'S RULE: a
-- birthday_bonus lot expires at the member's last_purchase_at + 180 days, or at
-- now() + 180 days when that is already past or last_purchase_at is NULL — so a
-- member's whole balance shares one expiry date. It had been overwritten on
-- 2026-09-17 by 20260917070000_relot_wire_redemption_and_birthday.sql, which
-- expired the lot at the award instant (v_awarded_at + 180 days). See
-- docs/FIXED-BUGS.md #280.
--
-- HOW IT WAS APPLIED, and why it matters: an md5-GUARDED IN-PLACE PATCH, not a
-- CREATE OR REPLACE written from a repo copy. The patch read the body live,
-- refused unless the live md5 equalled the captured one, asserted the expiry
-- expression occurred exactly once, and replaced only that expression. Per
-- CLAUDE.md "FUNCTION CHANGES START FROM LIVE" — a full-body replace from a repo
-- copy is what caused Bug #280 in the first place.
--
-- NOT RETROACTIVE. The one birthday lot in existence at the time
-- (CJ-2026-03608, BIRTHDAY-2026) was inserted by hand with an explicit expiry and
-- is untouched. This governs the next birthday award and every one after it.
--
-- GRANTS ARE NOT TOUCHED. pg_get_functiondef does not emit them and none is added
-- here.

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
  v_awarded_at timestamptz;
  v_lot_id    uuid;
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
     'Birthday bonus ' || v_year::text)
  RETURNING created_at INTO v_awarded_at;

  -- The lot. ADDED 2026-09-17 (Bug #280): this function credited the counter
  -- and the ledger and created no lot, so the points existed for the balance
  -- and for redemption but not for FIFO consumption or expiry.
  v_lot_id := public.insert_lot_and_extend(
    p_member_id        => v_member_id,
    p_source_type      => 'birthday_bonus'::loyalty_lot_source_type,
    p_source_reference => 'BIRTHDAY-' || v_year::text,
    p_amount           => v_bonus,
    p_earned_at        => v_awarded_at,
    p_expires_at       => (SELECT CASE WHEN lm.last_purchase_at IS NOT NULL
                      AND lm.last_purchase_at + INTERVAL '180 days' > now()
                     THEN lm.last_purchase_at + INTERVAL '180 days'
                     ELSE now() + INTERVAL '180 days' END
           FROM public.loyalty_members lm WHERE lm.id = v_member_id),
    p_notes            => 'Birthday bonus ' || v_year::text
  );

  RETURN jsonb_build_object('success', true, 'points_awarded', v_bonus, 'tier', v_tier_name,
                            'year', v_year, 'lot_id', v_lot_id);
END;
$function$
;
