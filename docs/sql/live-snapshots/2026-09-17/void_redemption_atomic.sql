-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text)
--   captured  : 2026-09-17 05:21:02.267226+00 (SELECT pg_get_functiondef(oid))
--   md5       : 9854da8d14473afdf088af9cd9c790bb
--   length    : 14178 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'void_redemption_atomic';
--
-- Why these exist: on 2026-09-12 a migration rebuilt approve_redemption_atomic
-- "verbatim from the live baseline … no later migration redefines this
-- function" and silently dropped a call that had been wired live in the SQL
-- Editor on 2026-07-05 and never committed. See docs/FIXED-BUGS.md #280 and
-- DRIFT-REPORT.md beside this file. The baseline is not evidence about live.

CREATE OR REPLACE FUNCTION public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lots_restored integer;
  r record;
  m record;
  v_pts integer;
  v_before_balance integer;
  v_new_remaining integer;
  v_tier_name text;
  v_refund_tx_id uuid;
  v_updated_count integer;
  v_stock_re_incremented boolean := false;
  v_reward record;
  v_jpy_to_restore numeric := 0;
  v_currency text;
  v_synth_payment record;
  v_alloc record;
  v_sched record;
  v_new_paid numeric;
  v_new_status text;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_acct record;
  v_refund_amount numeric := 0;
  v_new_total_paid numeric;
  v_new_remaining_balance numeric;
  v_any_overdue boolean;
  v_new_account_status text;
  v_cash_synth record;
  v_cash_new_total numeric;
  v_cash_order record;
  v_cash_new_remaining numeric;
  v_truncated_reason text;
  v_void_notes text;
  v_ref_ref text;
  v_note text;
  v_order_side_done boolean := false;
BEGIN
  v_truncated_reason := substring(coalesce(p_void_reason, ''), 1, 250);
  
  -- ---------------------------------------------------------------------
  -- Step 1: Lock redemption row, validate status
  -- ---------------------------------------------------------------------
  SELECT id, status, member_id, reward_id, redemption_type, points_redeemed,
         transaction_id, account_id, cash_order_id, invoice_number, value_applied_jpy
  INTO r
  FROM public.loyalty_redemptions
  WHERE id = p_redemption_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'redemption_not_found' USING ERRCODE = 'P0001';
  END IF;
  
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'redemption_not_confirmed: %', r.status USING ERRCODE = 'P0001';
  END IF;
  
  v_pts := r.points_redeemed;
  v_ref_ref := 'LOYALTY-' || r.id::text;
  v_void_notes := 'Loyalty redemption voided: ' || v_truncated_reason;
  
  -- ---------------------------------------------------------------------
  -- Step 2: Lock member row, fetch tier name
  -- ---------------------------------------------------------------------
  SELECT id, remaining_points, total_points_redeemed, current_tier_id
  INTO m
  FROM public.loyalty_members
  WHERE id = r.member_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'P0001';
  END IF;
  
  v_before_balance := COALESCE(m.remaining_points, 0);
  v_new_remaining := v_before_balance + v_pts;
  
  SELECT name INTO v_tier_name
  FROM public.loyalty_tiers
  WHERE id = m.current_tier_id;
  
  -- ---------------------------------------------------------------------
  -- Step 3: Insert refund loyalty_transactions row
  -- ---------------------------------------------------------------------
  INSERT INTO public.loyalty_transactions (
    member_id, transaction_type, points_amount,
    account_id, cash_order_id, invoice_number,
    tier_at_time, notes
  )
  VALUES (
    m.id, 'refunded', v_pts,
    r.account_id, r.cash_order_id, NULL,
    v_tier_name,
    CASE WHEN r.transaction_id IS NOT NULL
      THEN 'Refund of voided redemption #' || substring(r.id::text, 1, 8) || ' — original tx: ' || r.transaction_id::text
      ELSE 'Refund of voided redemption #' || substring(r.id::text, 1, 8)
    END
  )
  RETURNING id INTO v_refund_tx_id;
  
  -- ---------------------------------------------------------------------
  -- Step 4: Mark redemption cancelled (defensive race guard)
  -- ---------------------------------------------------------------------
  UPDATE public.loyalty_redemptions
  SET status = 'cancelled',
      cancelled_by_user_id = p_user_id,
      cancelled_at = now(),
      cancellation_reason = v_truncated_reason
  WHERE id = r.id
    AND status = 'confirmed';
  
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  
  IF v_updated_count = 0 THEN
    RAISE EXCEPTION 'redemption_void_race' USING ERRCODE = 'P0001';
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 5: Restore member balance (relative arithmetic, race-safe)
  -- ---------------------------------------------------------------------
  UPDATE public.loyalty_members
  SET remaining_points = COALESCE(remaining_points, 0) + v_pts,
      total_points_redeemed = GREATEST(0, COALESCE(total_points_redeemed, 0) - v_pts)
  WHERE id = m.id;

  -- Restore consumed lots from the ledger (wired 2026-07-05). Redemptions
  -- approved before lot-wiring have no ledger rows and restore 0; top up
  -- the shortfall with a synthetic lot so the lot/counter invariant holds.
  v_lots_restored := public.restore_lots_for_redemption(p_redemption_id);
  IF v_lots_restored < v_pts::integer THEN
    INSERT INTO public.loyalty_point_lots
      (member_id, source_type, source_reference, original_amount, remaining_amount, earned_at, expires_at, notes)
    VALUES
      (m.id, 'admin_adjust'::loyalty_lot_source_type, 'VOID-TOPUP-' || p_redemption_id::text,
       v_pts::integer - v_lots_restored, v_pts::integer - v_lots_restored, now(), NULL,
       'Synthetic lot: void of pre-lot-wiring redemption');
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 6: Order-side reversal (only for new_order_discount with FK)
  -- ---------------------------------------------------------------------
  IF r.redemption_type = 'new_order_discount' 
     AND (r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL) THEN
    
    -- Step 6a: Restore loyalty_jpy_amount on the order
    v_jpy_to_restore := COALESCE(r.value_applied_jpy, 0);
    
    IF v_jpy_to_restore > 0 THEN
      IF r.account_id IS NOT NULL THEN
        UPDATE public.layaway_accounts
        SET loyalty_jpy_amount = COALESCE(loyalty_jpy_amount, 0) + v_jpy_to_restore
        WHERE id = r.account_id;
      ELSE
        UPDATE public.cash_orders
        SET loyalty_jpy_amount = COALESCE(loyalty_jpy_amount, 0) + v_jpy_to_restore
        WHERE id = r.cash_order_id;
      END IF;
    END IF;
    
    -- Step 6b: Layaway branch
    IF r.account_id IS NOT NULL THEN
      SELECT id, voided_at, amount_paid
      INTO v_synth_payment
      FROM public.payments
      WHERE reference_number = v_ref_ref
      LIMIT 1;
      
      IF v_synth_payment.id IS NOT NULL AND v_synth_payment.voided_at IS NULL THEN
        
        -- Void the synthetic payment
        UPDATE public.payments
        SET voided_at = now(),
            voided_by_user_id = p_user_id,
            void_reason = v_void_notes
        WHERE id = v_synth_payment.id;
        
        -- Revert each allocation: schedule row revert + allocation delete
        FOR v_alloc IN
          SELECT id, schedule_id, allocated_amount, allocation_type
          FROM public.payment_allocations
          WHERE payment_id = v_synth_payment.id
        LOOP
          SELECT id, total_due_amount, paid_amount, status, due_date
          INTO v_sched
          FROM public.layaway_schedule
          WHERE id = v_alloc.schedule_id;
          
          IF NOT FOUND THEN
            RAISE EXCEPTION 'schedule_row_not_found: %', v_alloc.schedule_id 
              USING ERRCODE = 'P0001';
          END IF;
          
          v_new_paid := GREATEST(0, COALESCE(v_sched.paid_amount, 0) - COALESCE(v_alloc.allocated_amount, 0));
          
          -- Status reversal (faithful port of TS L1008-1028)
          IF v_new_paid >= v_sched.total_due_amount THEN
            v_new_status := 'paid';
          ELSIF v_new_paid = 0 THEN
            v_new_status := CASE WHEN v_sched.due_date < v_today THEN 'overdue' ELSE 'pending' END;
          ELSIF v_sched.status = 'paid' THEN
            v_new_status := CASE WHEN v_sched.due_date < v_today THEN 'overdue' ELSE 'partially_paid' END;
          ELSE
            v_new_status := v_sched.status;
          END IF;
          
          UPDATE public.layaway_schedule
          SET paid_amount = v_new_paid,
              status = v_new_status::schedule_status
          WHERE id = v_sched.id;
          
          DELETE FROM public.payment_allocations
          WHERE id = v_alloc.id;
        END LOOP;
        
        -- Revert account totals + status
        SELECT total_paid, remaining_balance, status, currency
        INTO v_acct
        FROM public.layaway_accounts
        WHERE id = r.account_id;
        
        v_refund_amount := COALESCE(v_synth_payment.amount_paid, 0);
        v_new_total_paid := GREATEST(0, COALESCE(v_acct.total_paid, 0) - v_refund_amount);
        v_new_remaining_balance := COALESCE(v_acct.remaining_balance, 0) + v_refund_amount;
        
        v_new_account_status := v_acct.status;
        IF v_acct.status = 'completed' AND v_new_remaining_balance > 0.01 THEN
          SELECT EXISTS(
            SELECT 1 FROM public.layaway_schedule
            WHERE account_id = r.account_id AND status = 'overdue'
          ) INTO v_any_overdue;
          v_new_account_status := CASE WHEN v_any_overdue THEN 'overdue' ELSE 'active' END;
        END IF;
        
        UPDATE public.layaway_accounts
        SET total_paid = v_new_total_paid,
            remaining_balance = v_new_remaining_balance,
            status = v_new_account_status::account_status
        WHERE id = r.account_id;
        
        v_currency := v_acct.currency;
        v_order_side_done := true;
      END IF;
    END IF;
    
    -- Step 6c: Cash order branch
    IF r.cash_order_id IS NOT NULL THEN
      SELECT id, voided_at, amount_paid
      INTO v_cash_synth
      FROM public.cash_payments
      WHERE reference_number = v_ref_ref
      LIMIT 1;
      
      IF v_cash_synth.id IS NOT NULL AND v_cash_synth.voided_at IS NULL THEN
        
        -- Void the synthetic cash_payment
        UPDATE public.cash_payments
        SET voided_at = now(),
            voided_by_user_id = p_user_id,
            void_reason = v_void_notes
        WHERE id = v_cash_synth.id;
        
        -- Recompute total_paid from all non-voided cash_payments
        SELECT COALESCE(SUM(amount_paid), 0)
        INTO v_cash_new_total
        FROM public.cash_payments
        WHERE cash_order_id = r.cash_order_id
          AND voided_at IS NULL;
        
        SELECT total_amount, status, currency
        INTO v_cash_order
        FROM public.cash_orders
        WHERE id = r.cash_order_id;
        
        v_cash_new_remaining := COALESCE(v_cash_order.total_amount, 0) - v_cash_new_total;
        
        IF v_cash_order.status = 'completed' AND v_cash_new_remaining > 0 THEN
          UPDATE public.cash_orders
          SET total_paid = v_cash_new_total,
              remaining_balance = v_cash_new_remaining,
              status = 'pending'::cash_order_status,
              completed_at = NULL,
              updated_at = now()
          WHERE id = r.cash_order_id;
        ELSE
          UPDATE public.cash_orders
          SET total_paid = v_cash_new_total,
              remaining_balance = v_cash_new_remaining,
              updated_at = now()
          WHERE id = r.cash_order_id;
        END IF;
        
        v_refund_amount := COALESCE(v_cash_synth.amount_paid, 0);
        v_currency := v_cash_order.currency;
        v_order_side_done := true;
      END IF;
    END IF;
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 7: Re-increment catalog stock (when reward exists with finite stock)
  -- ---------------------------------------------------------------------
  IF r.reward_id IS NOT NULL THEN
    SELECT id, current_stock
    INTO v_reward
    FROM public.loyalty_rewards
    WHERE id = r.reward_id
    FOR UPDATE;
    
    IF v_reward.id IS NOT NULL AND v_reward.current_stock IS NOT NULL THEN
      UPDATE public.loyalty_rewards
      SET current_stock = COALESCE(current_stock, 0) + 1
      WHERE id = r.reward_id;
      v_stock_re_incremented := true;
    END IF;
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 8: Audit log
  -- ---------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    entity_type, entity_id, action, performed_by_user_id,
    old_value_json, new_value_json
  )
  VALUES (
    'loyalty_redemption', r.id, 'redemption_voided', p_user_id,
    jsonb_build_object(
      'status', 'confirmed',
      'member_remaining_points', v_before_balance
    ),
    jsonb_build_object(
      'status', 'cancelled',
      'cancellation_reason', v_truncated_reason,
      'member_remaining_points', v_new_remaining,
      'refund_transaction_id', v_refund_tx_id,
      'stock_re_incremented', v_stock_re_incremented
    )
  );
  
  -- ---------------------------------------------------------------------
  -- Step 9: Account note (atomic, symmetric format with approve)
  -- ---------------------------------------------------------------------
  IF r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL THEN
    v_note := 'Loyalty: redemption voided — ' || v_pts::text || ' pts refunded (' || r.redemption_type::text || ')';
    
    IF v_refund_amount > 0 AND v_currency IS NOT NULL THEN
      v_note := v_note || ' — ' ||
                CASE WHEN v_currency = 'PHP' THEN '₱' ELSE '¥' END ||
                v_refund_amount::text ||
                ' removed from balance';
    END IF;
    
    INSERT INTO public.account_notes (
      account_id, cash_order_id, note_text,
      created_by_user_id, created_by_name
    )
    VALUES (
      r.account_id, r.cash_order_id, v_note,
      p_user_id, 'System (Loyalty)'
    );
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Return payload
  -- ---------------------------------------------------------------------
  RETURN jsonb_build_object(
    'redemption_id', r.id,
    'refund_transaction_id', v_refund_tx_id,
    'points_refunded', v_pts,
    'new_remaining_points', v_new_remaining,
    'stock_re_incremented', v_stock_re_incremented,
    'jpy_restored', v_jpy_to_restore,
    'order_side_reverted', v_order_side_done,
    'refund_amount', v_refund_amount,
    'currency', v_currency
  );
END;
$function$
