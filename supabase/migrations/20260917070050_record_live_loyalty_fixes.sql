-- Record-only (2026-09-17). Captured from live via pg_get_functiondef — already applied;
-- replaying is a no-op.
--
-- The two loyalty-lot bodies that Cynthia patched LIVE in the SQL Editor on 2026-09-17 and
-- that NO migration carries. Each patch was md5-guarded against the snapshots in
-- docs/sql/live-snapshots/2026-09-17/.
--
--   C. insert_lot_and_extend    rolling extension set is now
--                               ('order_earn','admin_adjust','birthday_bonus') — a birthday
--                               lot's expiry is now rolled forward by a later purchase.
--   D. restore_loyalty_points   the misplaced tier_changed block is GONE from the idempotency
--                               early exit, where v_member and v_new_tier_id were both
--                               unassigned and the block could only raise.
--
-- WHAT IS NOT IN THIS FILE, AND WHY. Two more functions were hand-patched the same way —
-- approve_redemption_atomic (the consume_lots_fifo call) and _award_birthday_reward (the lot
-- write). They are NOT recorded here because 20260917070000_relot_wire_redemption_and_birthday.sql
-- was applied to live at ~06:10 on 2026-09-17, between this capture and its verification, and
-- that migration now defines both. The repo and live agree about them without this file.
--
-- ONE BEHAVIOUR WAS CHANGED BY THAT APPLY, and it is a decision, not a defect (see
-- docs/FIXED-BUGS.md #280): the hand patch expired a birthday lot at
-- last_purchase_at + 180 days (falling back to now() + 180 days), tying it to the member's
-- purchase clock. The migration expires it at awarded_at + 180 days, which is LATER for any
-- member who has bought recently. Nothing retroactive — the one birthday lot in existence
-- (CJ-2026-03608, BIRTHDAY-2026) was inserted by hand with an explicit expiry and is
-- untouched. If the purchase-clock rule was the intended one it needs its own migration.
--
-- Captured at 2026-09-17 06:07:24.874502+00. Bodies are byte-for-byte pg_get_functiondef output with a terminating
-- semicolon added; the md5 and length in each comment are of that output.
--
-- GRANTS ARE NOT TOUCHED. pg_get_functiondef does not emit them and none is added here; the
-- live ACL is recorded in each comment as observed (pg_proc.proacl) and nothing more.

-- ─────────────────────────────────────────────────────────────────────────────
-- public.insert_lot_and_extend(p_member_id uuid, p_source_type loyalty_lot_source_type, p_source_reference text, p_amount integer, p_earned_at timestamp with time zone, p_expires_at timestamp with time zone, p_notes text)
--   md5    : 68dd571baaec085daf1c8312877b1948
--   length : 1627 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insert_lot_and_extend(p_member_id uuid, p_source_type loyalty_lot_source_type, p_source_reference text, p_amount integer, p_earned_at timestamp with time zone DEFAULT now(), p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lot_id uuid;
  v_computed_expires_at timestamptz;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'lot amount must be positive: %', p_amount;
  END IF;

  v_computed_expires_at := COALESCE(p_expires_at,
    CASE p_source_type
      WHEN 'order_earn' THEN p_earned_at + INTERVAL '180 days'
      ELSE NULL  -- birthday/promo/admin_adjust set explicit expires_at
    END);

  INSERT INTO public.loyalty_point_lots (
    member_id, source_type, source_reference,
    original_amount, remaining_amount,
    earned_at, expires_at, notes
  ) VALUES (
    p_member_id, p_source_type, p_source_reference,
    p_amount, p_amount,
    p_earned_at, v_computed_expires_at, p_notes
  )
  RETURNING id INTO v_lot_id;

  -- Rolling extension on order_earn purchases ONLY
  IF p_source_type = 'order_earn' THEN
    UPDATE public.loyalty_point_lots AS lots
       SET expires_at = p_earned_at + INTERVAL '180 days',
           updated_at = now()
     WHERE lots.member_id   = p_member_id
       AND lots.source_type IN ('order_earn', 'admin_adjust', 'birthday_bonus')
       AND lots.remaining_amount > 0
       AND lots.expired_at IS NULL
       AND lots.id <> v_lot_id;
  END IF;

  RETURN v_lot_id;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.restore_loyalty_points(p_revoke_transaction_id uuid, p_created_by_user_id uuid)
--   md5    : 094503f187aa7e9e75e479dcecceb5d9
--   length : 4907 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_loyalty_points(p_revoke_transaction_id uuid, p_created_by_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_revoke RECORD;
  v_old_lot RECORD;
  v_new_tx_id UUID;
  v_total_restored_remaining NUMERIC := 0;
  v_total_restored_original NUMERIC := 0;
  v_member RECORD;
  v_current_tier_name TEXT;
  v_new_cumulative NUMERIC;
  v_new_tier_id UUID;
BEGIN
  -- Load original revoke transaction
  SELECT * INTO v_revoke FROM loyalty_transactions
   WHERE id = p_revoke_transaction_id AND transaction_type = 'revoked';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore: revoke transaction % not found', p_revoke_transaction_id;
  END IF;

  -- Idempotency check
  SELECT id INTO v_new_tx_id FROM loyalty_transactions
   WHERE member_id = v_revoke.member_id
     AND transaction_type = 'earned'
     AND notes LIKE '%Restored from revoke ' || p_revoke_transaction_id::text || '%'
   LIMIT 1;
  IF FOUND THEN
    RAISE NOTICE 'restore: already done as transaction %', v_new_tx_id;
    RETURN v_new_tx_id;
  END IF;

  -- Load member + current tier
  SELECT m.*, t.name AS tier_name
    INTO v_member
    FROM loyalty_members m
    LEFT JOIN loyalty_tiers t ON t.id = m.current_tier_id
   WHERE m.id = v_revoke.member_id;
  v_current_tier_name := v_member.tier_name;

  -- Insert restore transaction
  INSERT INTO loyalty_transactions (
    member_id, account_id, cash_order_id, payment_id, transaction_type,
    points_amount, spend_amount_jpy, invoice_number, tier_at_time, notes,
    created_by_user_id
  ) VALUES (
    v_revoke.member_id, v_revoke.account_id, v_revoke.cash_order_id, v_revoke.payment_id, 'earned',
    v_revoke.points_amount, v_revoke.spend_amount_jpy, v_revoke.invoice_number, v_current_tier_name,
    'Restored from revoke ' || p_revoke_transaction_id::text,
    p_created_by_user_id
  ) RETURNING id INTO v_new_tx_id;

  -- Create new lot for each previously revoked lot, inheriting expires_at AND spend_basis_jpy
  FOR v_old_lot IN
    SELECT * FROM loyalty_point_lots WHERE revoked_by_transaction_id = p_revoke_transaction_id
  LOOP
    INSERT INTO loyalty_point_lots (
      member_id, source_type, source_reference,
      original_amount, remaining_amount, spend_basis_jpy,
      earned_at, expires_at, expired_at, notes
    ) VALUES (
      v_old_lot.member_id,
      v_old_lot.source_type,
      v_old_lot.source_reference,
      v_old_lot.original_amount,
      CASE WHEN v_old_lot.expires_at <= NOW() THEN 0
           ELSE v_old_lot.remaining_amount
      END,
      v_old_lot.spend_basis_jpy,
      NOW(),
      v_old_lot.expires_at,
      CASE WHEN v_old_lot.expires_at <= NOW() THEN NOW()
           ELSE NULL
      END,
      'Restored from revoke ' || p_revoke_transaction_id::text
    );
    v_total_restored_original := v_total_restored_original + v_old_lot.original_amount;
    IF v_old_lot.expires_at IS NULL OR v_old_lot.expires_at > NOW() THEN  -- ← FIX: treat NULL expiry as not-expired
      v_total_restored_remaining := v_total_restored_remaining + v_old_lot.remaining_amount;
    END IF;
  END LOOP;

  -- Restore counters
  UPDATE loyalty_members
     SET remaining_points = remaining_points + v_total_restored_remaining,
         total_points_earned = total_points_earned + v_total_restored_original,
         cumulative_spend_jpy = cumulative_spend_jpy + v_revoke.spend_amount_jpy,
         updated_at = NOW()
   WHERE id = v_revoke.member_id
   RETURNING cumulative_spend_jpy INTO v_new_cumulative;

  -- Tier re-eval
  SELECT id INTO v_new_tier_id
    FROM loyalty_tiers
   WHERE min_spend_jpy <= v_new_cumulative
   ORDER BY min_spend_jpy DESC
   LIMIT 1;

  IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN
    UPDATE loyalty_members
       SET current_tier_id = v_new_tier_id,
           is_downgraded = false, downgrade_spend_baseline = NULL,
           updated_at = NOW()
     WHERE id = v_revoke.member_id;
    RAISE NOTICE 'restore: tier change for member %, new tier %', v_revoke.member_id, v_new_tier_id;
  END IF;

  IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN
    INSERT INTO public.loyalty_transactions (
      member_id, transaction_type, points_amount, spend_amount_jpy,
      tier_at_time, account_id, cash_order_id, invoice_number, notes, created_by_user_id
    ) VALUES (
      v_revoke.member_id, 'tier_changed', 0, NULL,
      (SELECT name FROM public.loyalty_tiers WHERE id = v_new_tier_id),
      v_revoke.account_id, v_revoke.cash_order_id, v_revoke.invoice_number,
      'Tier restored: '
        || (SELECT name FROM public.loyalty_tiers WHERE id = v_member.current_tier_id)
        || ' → ' || (SELECT name FROM public.loyalty_tiers WHERE id = v_new_tier_id)
        || ' — points restored',
      p_created_by_user_id
    );
  END IF;
  RETURN v_new_tx_id;
END;
$function$;

