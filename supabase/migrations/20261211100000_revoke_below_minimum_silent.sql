-- revoke_loyalty_points: an order below the loyalty minimum is silent on
-- reversal (2026-10-11). award-loyalty-points writes nothing for a
-- loyalty_jpy_amount under 10000 (reason "below_minimum"), so there is no
-- ledger row and no spend to reverse. The unsourced-reversal bell
-- (loyalty_reversal_unsourced) fired on every such cancel and told staff the
-- spend "was seeded outside the Hub" (TEST-900080, 2026-10-11). It now stays
-- silent when the basis is known and below the minimum; a NULL basis, or one
-- at/above the minimum with no ledger row, still rings.
--
-- FUNCTION CHANGES START FROM LIVE: this is the live body (pg_get_functiondef
-- md5 9ac8a0f02cff3bb6606faf584d25fb6d on 2026-10-11 14:15 JST; repo copy
-- 20261017100000 verified identical by normalised-body md5
-- 0cee0f35107e4bbdcd9ca5b01ba7c17a) with ONE block added before
-- "IF v_money_received THEN". The guard refuses to run on any other live body.
-- Signature and ACL unchanged (CREATE OR REPLACE keeps the live grants).

DO $guard$
DECLARE v_def text; v_md5 text;
BEGIN
  v_def := pg_get_functiondef('public.revoke_loyalty_points(uuid,text,numeric,uuid,uuid,uuid,text,text,uuid,text)'::regprocedure);
  IF position('BELOW THE MINIMUM (2026-10-11)' IN v_def) > 0 THEN
    RAISE NOTICE 'revoke_loyalty_points already patched - no change';
    RETURN;
  END IF;
  v_md5 := md5(v_def);
  IF v_md5 <> '9ac8a0f02cff3bb6606faf584d25fb6d' THEN
    RAISE EXCEPTION 'STOP - revoke_loyalty_points has moved on live (md5 %); re-read it before patching. Nothing changed.', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.revoke_loyalty_points(p_member_id uuid, p_source_reference text, p_spend_jpy numeric, p_account_id uuid DEFAULT NULL::uuid, p_cash_order_id uuid DEFAULT NULL::uuid, p_payment_id uuid DEFAULT NULL::uuid, p_invoice_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_created_by_user_id uuid DEFAULT NULL::uuid, p_trigger_event text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id UUID;
  v_existing_tx UUID;
  v_total_remaining NUMERIC := 0;
  v_total_original NUMERIC := 0;
  v_spend_basis NUMERIC := 0;
  v_lot_count INTEGER := 0;
  v_ledger_ref TEXT;
  v_member RECORD;
  v_ledger_rows INTEGER := 0;
  v_order_paid NUMERIC;
  v_order_basis NUMERIC;
  v_order_customer UUID;
  v_money_received BOOLEAN := false;
  v_current_tier_name TEXT;
  v_new_cumulative NUMERIC;
  v_new_tier_id UUID;
BEGIN
  -- The ledger keys on invoice_number; the lots key on source_reference.
  -- award-loyalty-points writes the same string to both, but callers pass them
  -- as separate arguments, so resolve explicitly rather than assuming.
  v_ledger_ref := COALESCE(p_invoice_number, p_source_reference);

  SELECT m.*, t.name AS tier_name INTO v_member
  FROM loyalty_members m LEFT JOIN loyalty_tiers t ON t.id = m.current_tier_id
  WHERE m.id = p_member_id FOR UPDATE OF m;
  IF NOT FOUND THEN RAISE EXCEPTION 'revoke: member % not found', p_member_id; END IF;
  v_current_tier_name := v_member.tier_name;

  -- POINTS: only what still exists.
  SELECT COALESCE(SUM(remaining_amount), 0), COALESCE(SUM(original_amount), 0), COUNT(*)
    INTO v_total_remaining, v_total_original, v_lot_count
  FROM loyalty_point_lots
  WHERE member_id = p_member_id AND source_reference = p_source_reference
    AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;

  -- SPEND: what this order actually put on the counter, lots or no lots.
  v_spend_basis := public.loyalty_order_spend_basis(p_member_id, v_ledger_ref);

  -- IDEMPOTENCY. Not GREATEST(0, ...) -- that is a floor, it still deducts on
  -- every call until it hits the floor. The guard is that both quantities are
  -- self-cancelling: a successful revoke writes a ledger row carrying
  -- spend_amount_jpy = v_spend_basis, so the next call's basis is 0; and it
  -- stamps revoked_at on the lots, so the next call's lot sum is 0. When both
  -- are 0 there is nothing left to take back -- return the earlier revoke row
  -- (for the caller's audit trail) and write nothing. This covers cancel twice,
  -- delete after cancel, and the edge function and the RPC both calling in.
  IF v_total_remaining = 0 AND v_spend_basis = 0 THEN
    SELECT id INTO v_existing_tx FROM loyalty_transactions
     WHERE member_id = p_member_id
       AND transaction_type = 'revoked'
       AND (invoice_number = v_ledger_ref
            OR (p_cash_order_id IS NOT NULL AND cash_order_id = p_cash_order_id)
            OR (p_payment_id IS NOT NULL AND payment_id = p_payment_id))
     ORDER BY created_at DESC LIMIT 1;

    -- UNSOURCED REVERSAL (2026-09-14). Reaching here means two different
    -- things and they must not be confused:
    --
    --   Already reversed  -- the order earned, and a 'revoked' row took it
    --     back. Ledger rows EXIST and net to zero. Nothing left to do; this is
    --     the idempotency path working as designed and it stays silent.
    --
    --   Never sourced     -- the order has NO 'earned' and NO 'revoked' row at
    --     all, yet money was received on it. Its spend was
    --     seeded outside the Hub (pre-Hub migration, a manual 'adjusted'
    --     correction) so the ledger cannot say what this order contributed.
    --     Before Bug #271 the code guessed here and guessed wrong. It no longer
    --     guesses -- but staying silent hides a real reversal that did not
    --     happen, so a person is told instead.
    --
    -- The discriminator is the COUNT of earned/revoked rows, not the net: a
    -- reversed order nets to zero WITH rows, an unsourced one has none.
    --
    -- It NOTIFIES, IT DOES NOT REFUSE. Blocking a forfeit or a cancellation
    -- because the customer's loyalty history predates the Hub would be a worse
    -- failure than the gap it closes -- a legitimate terminal action must
    -- always complete. A CSR reconciles the spend by hand afterwards.
    SELECT COUNT(*) INTO v_ledger_rows FROM loyalty_transactions
     WHERE member_id = p_member_id AND invoice_number = v_ledger_ref
       AND transaction_type IN ('earned', 'revoked');

    IF v_ledger_rows = 0 THEN
      IF p_account_id IS NOT NULL THEN
        SELECT total_paid, loyalty_jpy_amount, customer_id
          INTO v_order_paid, v_order_basis, v_order_customer
          FROM layaway_accounts WHERE id = p_account_id;
      ELSIF p_cash_order_id IS NOT NULL THEN
        SELECT total_paid, loyalty_jpy_amount, customer_id
          INTO v_order_paid, v_order_basis, v_order_customer
          FROM cash_orders WHERE id = p_cash_order_id;
      END IF;

      -- NOTHING TO REVERSE (2026-09-24). Loyalty is earned only on money
      -- received -- a layaway on its downpayment confirm, a cash order on the
      -- payment that completes it -- so an order that never received money
      -- cannot have put spend on the counter, whatever loyalty_jpy_amount
      -- says. A web order cancelled, declined or lapsed before payment carries
      -- its checkout basis and no money; that is nothing to reverse, not an
      -- unsourced reversal, and it stays silent. The basis alone used to raise
      -- the bell on every such order. Money is read from the ledger as well as
      -- the cache (INVARIANT 1).
      v_money_received := COALESCE(v_order_paid, 0) > 0
        OR (p_account_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM payments
               WHERE account_id = p_account_id AND voided_at IS NULL))
        OR (p_account_id IS NULL AND p_cash_order_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM cash_payments
               WHERE cash_order_id = p_cash_order_id AND voided_at IS NULL));

      -- BELOW THE MINIMUM (2026-10-11). award-loyalty-points skips an order
      -- whose loyalty_jpy_amount is under 10000 ("below_minimum") and writes
      -- NOTHING -- no points, no spend. Such an order never put anything on the
      -- counter, so a cancel, forfeit or void has nothing to reverse and nothing
      -- to tell a person about. Live 2026-10-11: TEST-900080 (basis 7840, paid
      -- 8570) rang the bell on cancel and told staff its spend "was seeded
      -- outside the Hub" -- it was not; it was simply below the minimum. Only a
      -- basis that COULD have earned (>= 10000) keeps the bell. A NULL basis
      -- still rings: the ledger cannot say and a person must look.
      IF v_money_received AND v_order_basis IS NOT NULL AND v_order_basis < 10000 THEN
        v_money_received := false;
      END IF;

      IF v_money_received THEN
        INSERT INTO public.audit_logs (
          entity_type, entity_id, action, old_value_json, performed_by_user_id
        ) VALUES (
          CASE WHEN p_cash_order_id IS NOT NULL THEN 'cash_order' ELSE 'layaway_account' END,
          COALESCE(p_account_id, p_cash_order_id, p_member_id),
          'loyalty_reversal_unsourced',
          jsonb_build_object(
            'member_id', p_member_id, 'invoice_number', v_ledger_ref,
            'trigger_event', p_trigger_event,
            'total_paid', v_order_paid, 'loyalty_jpy_amount', v_order_basis,
            'cumulative_spend_jpy', v_member.cumulative_spend_jpy,
            'reason', 'no earned or revoked ledger row for this order; spend basis could not be determined'),
          p_created_by_user_id
        );

        -- account_id is left NULL ON PURPOSE. delete_account_atomic and
        -- delete_cash_order_atomic both run
        -- DELETE FROM staff_notifications WHERE account_id = <order id>
        -- AFTER calling this function, so a notification carrying the order id
        -- would be erased by the same transaction that raised it. The ids live
        -- in metadata; invoice_number is the handle the CSR actually uses.
        INSERT INTO public.staff_notifications (
          type, title, body, account_id, customer_id, invoice_number, metadata
        ) VALUES (
          'loyalty_reversal_unsourced',
          'Loyalty spend could not be reversed — INV ' || COALESCE(v_ledger_ref, '(no invoice)'),
          'INV ' || COALESCE(v_ledger_ref, '(no invoice)') || ' was '
            || COALESCE(p_trigger_event, 'reversed')
            || ', but it has no loyalty ledger row, so there is no basis to reverse. '
            || 'The order''s lifetime spend was seeded outside the Hub and is still counting '
            || 'towards this member''s tier. Review the member''s lifetime spend by hand.',
          NULL, v_order_customer, v_ledger_ref,
          jsonb_build_object(
            'member_id', p_member_id,
            'account_id', p_account_id, 'cash_order_id', p_cash_order_id,
            'trigger_event', p_trigger_event,
            'total_paid', v_order_paid, 'loyalty_jpy_amount', v_order_basis,
            'cumulative_spend_jpy', v_member.cumulative_spend_jpy)
        );
      END IF;
    END IF;

    RETURN v_existing_tx;
  END IF;

  INSERT INTO loyalty_transactions (
    member_id, account_id, cash_order_id, payment_id, transaction_type, points_amount, spend_amount_jpy,
    invoice_number, tier_at_time, notes, created_by_user_id
  ) VALUES (
    p_member_id, p_account_id, p_cash_order_id, p_payment_id, 'revoked', -v_total_remaining, v_spend_basis,
    p_invoice_number, v_current_tier_name,
    COALESCE(p_notes, 'Revoked: ' || p_source_reference)
      || CASE WHEN v_lot_count = 0 AND v_spend_basis > 0
              THEN ' — points already spent or expired; lifetime spend reversed in full'
              ELSE '' END,
    p_created_by_user_id
  ) RETURNING id INTO v_transaction_id;

  UPDATE loyalty_point_lots
  SET revoked_at = NOW(), revoked_by_transaction_id = v_transaction_id, updated_at = NOW()
  WHERE member_id = p_member_id AND source_reference = p_source_reference
    AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;

  UPDATE loyalty_members
  SET remaining_points     = GREATEST(0, remaining_points - v_total_remaining),
      total_points_earned  = GREATEST(0, total_points_earned - v_total_original),
      cumulative_spend_jpy = GREATEST(0, cumulative_spend_jpy - v_spend_basis),
      updated_at = NOW()
  WHERE id = p_member_id
  RETURNING cumulative_spend_jpy INTO v_new_cumulative;

  -- Tier after a revoke (20261017100000, owner 2026-09-29): a revoke only ever
  -- LOWERS the tier, never raises it. The spend tier is re-derived from the new
  -- lifetime spend; the member moves to it only when it is BELOW the current
  -- tier. A member stepped down by the 180-day inactivity rule sits BELOW their
  -- spend tier on purpose (LOYALTY RULE 11: the step-down holds until
  -- requalify_spend_jpy is met), so a revoke leaves them, and their step-down
  -- fields, exactly as they are. Before this, the re-derivation was
  -- unconditional and re-promoted them (Test Customer Radiant -> Elite,
  -- 2026-09-29), labelled "Tier downgraded".
  SELECT id INTO v_new_tier_id FROM loyalty_tiers WHERE min_spend_jpy <= v_new_cumulative ORDER BY min_spend_jpy DESC LIMIT 1;

  IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id
     AND COALESCE((SELECT min_spend_jpy FROM loyalty_tiers WHERE id = v_new_tier_id), 0)
         < COALESCE((SELECT min_spend_jpy FROM loyalty_tiers WHERE id = v_member.current_tier_id), 'Infinity'::numeric) THEN
    UPDATE loyalty_members
    SET current_tier_id = v_new_tier_id, is_downgraded = false, downgrade_spend_baseline = NULL, updated_at = NOW()
    WHERE id = p_member_id;
    INSERT INTO public.loyalty_transactions (
      member_id, transaction_type, points_amount, spend_amount_jpy, tier_at_time, account_id, cash_order_id, invoice_number, notes, created_by_user_id
    ) VALUES (
      p_member_id, 'tier_changed', 0, NULL,
      (SELECT name FROM public.loyalty_tiers WHERE id = v_new_tier_id),
      p_account_id, p_cash_order_id, p_invoice_number,
      'Tier downgraded: ' || (SELECT name FROM public.loyalty_tiers WHERE id = v_member.current_tier_id)
        || ' → ' || (SELECT name FROM public.loyalty_tiers WHERE id = v_new_tier_id)
        || ' — points revoked (' || COALESCE(p_trigger_event, 'revoke') || ')',
      p_created_by_user_id
    );
  END IF;
  RETURN v_transaction_id;
END;
$function$;
