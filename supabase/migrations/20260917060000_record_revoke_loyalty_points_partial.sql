-- Record-only (2026-09-17): live definition of public.revoke_loyalty_points_partial, captured via pg_get_functiondef.
-- It was created directly in the live DB and never committed. Do NOT re-run blindly; it is already live.
--
-- Called by shopify-webhook on a Shopify partial refund (source_type
-- shopify_partial_refund, keyed per refund id). See CLAUDE.md LOYALTY SYSTEM
-- RULES rule 10 and docs/SCHEMA-FACTS.md.
--
-- Captured verbatim: md5(pg_get_functiondef(oid)) = 6c0de21d7ad1f3ec5d36df821f69d523,
-- length 5967 bytes. The text below is byte-identical to that output; only the
-- terminating semicolon is added.

CREATE OR REPLACE FUNCTION public.revoke_loyalty_points_partial(p_customer_id uuid, p_source_reference text, p_refund_spend_jpy numeric, p_cash_order_id uuid DEFAULT NULL::uuid, p_refund_id text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_created_by_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_member RECORD; v_lot RECORD; v_refund numeric(12,2);
  v_old_units integer; v_new_basis numeric(12,2); v_new_units integer;
  v_entitled integer; v_consumed integer; v_new_remaining integer;
  v_delta_original integer; v_delta_remaining integer;
  v_tx_id uuid := NULL; v_new_lot_id uuid := NULL;
  v_new_cumulative numeric; v_new_tier_id uuid; v_tier_changed boolean := false;
BEGIN
  v_refund := round(COALESCE(p_refund_spend_jpy, 0), 2);
  IF v_refund <= 0 THEN
    RAISE EXCEPTION 'invalid_refund_amount: %', p_refund_spend_jpy USING ERRCODE = 'P0001';
  END IF;

  SELECT m.* INTO v_member FROM public.loyalty_members m WHERE m.customer_id = p_customer_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'noop', 'no_member');
  END IF;

  -- The single active order_earn lot for this invoice (uniqueness enforced by
  -- uq_lots_active_order_earn_source). promo_bonus lots are deliberately
  -- untouched on partial refunds (policy 2026-07-15).
  SELECT * INTO v_lot FROM public.loyalty_point_lots
  WHERE member_id = v_member.id
    AND source_type = 'order_earn'
    AND source_reference = p_source_reference
    AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', true, 'noop', 'no_active_lot');
  END IF;

  -- Recompute entitlement on the reduced basis with the lot's own effective
  -- multiplier (original = floor(basis/10000)*100*mult at award time).
  v_old_units := floor(COALESCE(v_lot.spend_basis_jpy, 0) / 10000)::integer;
  v_new_basis := GREATEST(0, COALESCE(v_lot.spend_basis_jpy, 0) - v_refund);
  v_new_units := floor(v_new_basis / 10000)::integer;

  IF v_old_units <= 0 OR v_lot.original_amount <= 0 THEN
    v_entitled := v_lot.original_amount;  -- nothing recomputable; basis-only update
  ELSE
    v_entitled := round(v_new_units * v_lot.original_amount::numeric / v_old_units)::integer;
  END IF;

  v_delta_original := GREATEST(0, v_lot.original_amount - v_entitled);
  v_consumed := v_lot.original_amount - v_lot.remaining_amount;  -- redeemed stays redeemed
  v_new_remaining := GREATEST(0, v_entitled - v_consumed);
  v_delta_remaining := GREATEST(0, v_lot.remaining_amount - v_new_remaining);

  IF v_delta_original > 0 THEN
    -- Audit transaction first (replacement lot references nothing; old lot
    -- records which tx revoked it).
    INSERT INTO public.loyalty_transactions (
      member_id, cash_order_id, transaction_type, points_amount,
      spend_amount_jpy, invoice_number, tier_at_time, notes, created_by_user_id
    )
    SELECT v_member.id, p_cash_order_id, 'revoked', -v_delta_original,
           v_refund, p_source_reference, t.name,
           COALESCE(p_notes, 'Partial refund' || COALESCE(' ' || p_refund_id, '') ||
             ': basis ' || COALESCE(v_lot.spend_basis_jpy, 0) || ' -> ' || v_new_basis ||
             ', points ' || v_lot.original_amount || ' -> ' || v_entitled),
           p_created_by_user_id
    FROM public.loyalty_members m
    LEFT JOIN public.loyalty_tiers t ON t.id = m.current_tier_id
    WHERE m.id = v_member.id
    RETURNING id INTO v_tx_id;

    -- Revoke-and-replace: history preserved on the old lot; expiry clock
    -- preserved on the replacement.
    UPDATE public.loyalty_point_lots
    SET revoked_at = now(), revoked_by_transaction_id = v_tx_id, updated_at = now()
    WHERE id = v_lot.id;

    IF v_entitled > 0 THEN
      INSERT INTO public.loyalty_point_lots (
        member_id, source_type, source_reference, original_amount, remaining_amount,
        earned_at, expires_at, spend_basis_jpy, notes
      ) VALUES (
        v_member.id, 'order_earn', p_source_reference, v_entitled, v_new_remaining,
        v_lot.earned_at, v_lot.expires_at, v_new_basis,
        'Replacement after partial refund' || COALESCE(' ' || p_refund_id, '')
      ) RETURNING id INTO v_new_lot_id;
    END IF;
  ELSE
    -- Entitlement unchanged (sub-granularity refund): shrink the basis only so
    -- subsequent refunds compute from the true remaining spend.
    UPDATE public.loyalty_point_lots
    SET spend_basis_jpy = v_new_basis, updated_at = now()
    WHERE id = v_lot.id;
  END IF;

  -- Member counters + tier (mirrors revoke_loyalty_points mechanics).
  UPDATE public.loyalty_members
  SET remaining_points     = GREATEST(0, remaining_points - v_delta_remaining),
      total_points_earned  = GREATEST(0, total_points_earned - v_delta_original),
      cumulative_spend_jpy = GREATEST(0, cumulative_spend_jpy - v_refund),
      updated_at = now()
  WHERE id = v_member.id
  RETURNING cumulative_spend_jpy INTO v_new_cumulative;

  SELECT id INTO v_new_tier_id FROM public.loyalty_tiers
  WHERE min_spend_jpy <= v_new_cumulative
  ORDER BY min_spend_jpy DESC LIMIT 1;

  IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN
    UPDATE public.loyalty_members
    SET current_tier_id = v_new_tier_id,
        is_downgraded = (v_new_tier_id IS DISTINCT FROM v_member.earned_tier_id),
        updated_at = now()
    WHERE id = v_member.id;
    v_tier_changed := true;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'member_id', v_member.id,
    'revoked_lot_id', CASE WHEN v_delta_original > 0 THEN v_lot.id ELSE NULL END,
    'replacement_lot_id', v_new_lot_id,
    'points_delta', v_delta_original,
    'remaining_delta', v_delta_remaining,
    'old_basis', v_lot.spend_basis_jpy,
    'new_basis', v_new_basis,
    'entitled', v_entitled,
    'tier_changed', v_tier_changed,
    'transaction_id', v_tx_id
  );
END;
$function$;
