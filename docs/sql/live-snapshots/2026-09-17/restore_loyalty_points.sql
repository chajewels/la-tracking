-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.restore_loyalty_points(p_revoke_transaction_id uuid, p_created_by_user_id uuid)
--   captured  : 2026-09-17 05:50:22.096422+00 (SELECT pg_get_functiondef(oid))
--   md5       : 66836e742f08bb38001c59bf92067256
--   length    : 5663 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'restore_loyalty_points';
--
-- Captured for the live-vs-repo diff pass (DIFF-FINDINGS.md beside this file).
-- The repo is NOT evidence about live — see CLAUDE.md, "A SQL EDITOR CHANGE
-- THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD".

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
$function$
