-- revoke_loyalty_points: no "could not be reversed" bell when nothing was paid.
--
-- Owner acceptance run 2026-09-24, finding 2. Cancelling or declining a web
-- reservation raised the staff bell "Loyalty spend could not be reversed —
-- INV … was cancel, but it has no loyalty ledger row…" (live: TEST-900046,
-- -047, -048, all ¥0 received). The unsourced-reversal branch fired on
-- `total_paid > 0 OR loyalty_jpy_amount IS NOT NULL`, and every web order
-- carries loyalty_jpy_amount from checkout. Loyalty is only ever earned on
-- money received, so an order with no money has nothing to reverse.
--
-- The condition is now "money was received": the total_paid cache OR a
-- non-voided payments / cash_payments row (INVARIANT 1). The two genuine
-- bells on live (18788 auto_forfeit ₱24,695 paid; 19634 manual_forfeit
-- ₱13,104 paid) still fire. Checked on live 2026-09-24: no order carries a
-- loyalty basis, zero money and an earned/adjusted ledger row without also
-- having earned/revoked rows (the only hit, TEST-4567, has both and is silent
-- by the row count anyway), so no genuine case is silenced.
--
-- FUNCTION RULES (CLAUDE.md): the body below is the LIVE body read with
-- pg_get_functiondef on 2026-09-24 (md5 f4b2834ef9673ca14fd12d3a2f493a46,
-- 10052 chars) with exactly three edits: the v_money_received declaration,
-- one comment line, and the condition block. The guard refuses to run if
-- live has moved to anything else. After this migration the live md5 should
-- be 8f475dbfd8c1d74be3de475fae08e81b (11095 chars); replaying is a no-op.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'revoke_loyalty_points';
  IF v_md5 IS NULL OR v_md5 NOT IN ('f4b2834ef9673ca14fd12d3a2f493a46',
                                     '8f475dbfd8c1d74be3de475fae08e81b') THEN
    RAISE EXCEPTION 'revoke_loyalty_points has moved on live (md5 %); re-read it before patching', v_md5;
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

  -- Tier is re-derived unconditionally. Previously this was unreachable
  -- whenever no lots survived, because the function had already returned NULL.
  SELECT id INTO v_new_tier_id FROM loyalty_tiers WHERE min_spend_jpy <= v_new_cumulative ORDER BY min_spend_jpy DESC LIMIT 1;

  IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN
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

COMMENT ON FUNCTION public.revoke_loyalty_points(uuid, text, numeric, uuid, uuid, uuid, text, text, uuid, text) IS
  'Reverses one order''s loyalty effect. POINTS come from the surviving lots (you can only take back points that still exist). SPEND comes from loyalty_order_spend_basis -- the ledger -- independent of lots. p_spend_jpy is accepted for signature compatibility and IGNORED: every caller passes total_paid in JPY, which is money received, not the loyalty basis. Idempotent: a second call finds basis 0 and no live lots, writes nothing, and returns the earlier revoke row. When that state is reached with NO earned or revoked ledger row at all and money WAS received on the order (total_paid or a non-voided payment row), the reversal cannot be sourced: it raises audit_logs ''loyalty_reversal_unsourced'' plus a staff_notifications row of the same type and returns anyway -- it never refuses a terminal action. An order that received no money has nothing to reverse and stays silent (2026-09-24).';
