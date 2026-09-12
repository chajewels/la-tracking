-- Bug #265 (2026-09-12): a closed order can never back a loyalty redemption.
--
-- approve_redemption_atomic checked only "no payments yet" on the layaway
-- branch and nothing at all about status, so a cancelled / forfeited /
-- completed / settled layaway with total_paid = 0 could be approved — and the
-- approval inserted a loyalty payment onto a closed account. The cash branch
-- required status = 'pending' at request time but not here.
--
-- Body copied verbatim from the live baseline (20260705230000, lines
-- 1899-2081 — no later migration redefines this function) with exactly two
-- insertions, each immediately after the branch's FOR UPDATE lock:
--   layaway: RAISE account_not_open:<status> when status is closed
--   cash:    RAISE account_not_open:<status> when status <> 'pending'
-- process-loyalty-redemption maps the exception to 409; the transaction rolls
-- back, so nothing is debited. Request-time guards (portal form + create) are
-- in the same commit.

CREATE OR REPLACE FUNCTION public.approve_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  m record;
  v_tier_name text;
  v_tx_id uuid;
  v_payment_id uuid;
  v_pts numeric;
  v_payment_amount numeric;
  v_currency text;
  v_total_amount numeric;
  v_new_total_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_reduce_jpy numeric;
  v_stock int;
  v_rows int;
  v_today date := CURRENT_DATE;
  v_ref text;
  v_remarks text;
  v_note text;
BEGIN
  -- 1. Lock redemption; must be pending (closes double-approve race)
  SELECT * INTO r FROM public.loyalty_redemptions WHERE id = p_redemption_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'redemption_not_found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'redemption_not_pending:%', r.status; END IF;
  v_pts := r.points_redeemed;

  -- 2. Lock member; validate balance
  SELECT id, customer_id, remaining_points, total_points_redeemed, current_tier_id
    INTO m FROM public.loyalty_members WHERE id = r.member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member_not_found'; END IF;
  IF v_pts > COALESCE(m.remaining_points, 0) THEN RAISE EXCEPTION 'insufficient_points'; END IF;
  SELECT name INTO v_tier_name FROM public.loyalty_tiers WHERE id = m.current_tier_id;

  -- 3. Redemption transaction
  INSERT INTO public.loyalty_transactions
    (member_id, transaction_type, points_amount, account_id, cash_order_id, invoice_number, tier_at_time, notes)
  VALUES
    (m.id, 'redeemed', -v_pts, r.account_id, r.cash_order_id, r.invoice_number, v_tier_name,
     'Redemption: ' || r.redemption_type)
  RETURNING id INTO v_tx_id;

  -- 4. Flip redemption
  UPDATE public.loyalty_redemptions
     SET status = 'confirmed', transaction_id = v_tx_id,
         processed_by_user_id = p_user_id, processed_at = now()
   WHERE id = r.id;

  -- 5. Debit member (relative arithmetic — closes lost-update race)
  UPDATE public.loyalty_members
     SET remaining_points = remaining_points - v_pts,
         total_points_redeemed = COALESCE(total_points_redeemed, 0) + v_pts
   WHERE id = m.id;

  -- 6. Catalog stock — depletion aborts the entire approve
  IF r.redemption_type = 'catalog_reward' AND r.reward_id IS NOT NULL THEN
    SELECT current_stock INTO v_stock FROM public.loyalty_rewards WHERE id = r.reward_id FOR UPDATE;
    IF FOUND AND v_stock IS NOT NULL THEN
      UPDATE public.loyalty_rewards SET current_stock = current_stock - 1
       WHERE id = r.reward_id AND current_stock > 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN RAISE EXCEPTION 'reward_out_of_stock'; END IF;
    END IF;
  END IF;

  -- 7. new_order_discount: net-spend reduce + synthetic payment + totals
  IF r.redemption_type = 'new_order_discount' AND (r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL) THEN
    v_ref := 'LOYALTY-' || r.id;
    v_reduce_jpy := COALESCE(r.value_applied_jpy, 0);

    IF r.account_id IS NOT NULL THEN
      IF v_reduce_jpy > 0 THEN
        UPDATE public.layaway_accounts
           SET loyalty_jpy_amount = GREATEST(0, COALESCE(loyalty_jpy_amount, 0) - v_reduce_jpy)
         WHERE id = r.account_id;
      END IF;
      SELECT currency::text INTO v_currency FROM public.layaway_accounts WHERE id = r.account_id FOR UPDATE;
      -- Closed-order guard (2026-09-12): never apply a redemption to a cancelled/forfeited/completed/settled layaway.
      PERFORM 1 FROM public.layaway_accounts
        WHERE id = r.account_id
          AND status IN ('cancelled','forfeited','completed','final_settlement');
      IF FOUND THEN RAISE EXCEPTION 'account_not_open:%', (SELECT status FROM public.layaway_accounts WHERE id = r.account_id); END IF;
      v_payment_amount := CASE WHEN v_currency = 'PHP' THEN COALESCE(r.value_applied_php, 0)
                               ELSE COALESCE(r.value_applied_jpy, 0) END;
      IF v_payment_amount > 0 AND v_currency IS NOT NULL THEN
        v_remarks := 'Loyalty redemption: ' || v_pts || ' pts (' || r.redemption_type || ') (applied to downpayment)';
        INSERT INTO public.payments
          (account_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks,
           entered_by_user_id, submitted_by_type, submitted_by_name)
        VALUES
          (r.account_id, v_payment_amount, v_currency::account_currency, v_today, 'loyalty_redemption', v_ref, v_remarks,
           p_user_id, 'staff', COALESCE(p_user_email, 'Admin'))
        RETURNING id INTO v_payment_id;

        SELECT total_paid, remaining_balance, status::text
          INTO v_new_total_paid, v_new_remaining, v_new_status
          FROM public.layaway_accounts WHERE id = r.account_id;
        v_new_total_paid := COALESCE(v_new_total_paid, 0) + v_payment_amount;
        v_new_remaining := COALESCE(v_new_remaining, 0) - v_payment_amount;
        IF v_new_remaining <= 0.01 THEN
          v_new_status := 'completed';
        ELSIF v_new_status = 'overdue' AND NOT EXISTS (
          SELECT 1 FROM public.layaway_schedule
           WHERE account_id = r.account_id AND status = 'overdue'::schedule_status
        ) THEN
          v_new_status := 'active';
        END IF;
        UPDATE public.layaway_accounts
           SET total_paid = v_new_total_paid,
               remaining_balance = v_new_remaining,
               status = v_new_status::account_status
         WHERE id = r.account_id;
      END IF;

    ELSE
      IF v_reduce_jpy > 0 THEN
        UPDATE public.cash_orders
           SET loyalty_jpy_amount = GREATEST(0, COALESCE(loyalty_jpy_amount, 0) - v_reduce_jpy)
         WHERE id = r.cash_order_id;
      END IF;
      SELECT currency::text, total_amount INTO v_currency, v_total_amount
        FROM public.cash_orders WHERE id = r.cash_order_id FOR UPDATE;
      -- Closed-order guard (2026-09-12): cash order must still be pending.
      PERFORM 1 FROM public.cash_orders WHERE id = r.cash_order_id AND status <> 'pending';
      IF FOUND THEN RAISE EXCEPTION 'account_not_open:%', (SELECT status FROM public.cash_orders WHERE id = r.cash_order_id); END IF;
      v_payment_amount := CASE WHEN v_currency = 'PHP' THEN COALESCE(r.value_applied_php, 0)
                               ELSE COALESCE(r.value_applied_jpy, 0) END;
      IF v_payment_amount > 0 AND v_currency IS NOT NULL THEN
        v_remarks := 'Loyalty redemption: ' || v_pts || ' pts (' || r.redemption_type || ')';
        INSERT INTO public.cash_payments
          (cash_order_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks,
           entered_by_user_id, submitted_by_type, submitted_by_name)
        VALUES
          (r.cash_order_id, v_payment_amount, v_currency::account_currency, v_today, 'loyalty_redemption', v_ref, v_remarks,
           p_user_id, 'staff', COALESCE(p_user_email, 'Admin'));

        SELECT COALESCE(SUM(amount_paid), 0) INTO v_new_total_paid
          FROM public.cash_payments
         WHERE cash_order_id = r.cash_order_id AND voided_at IS NULL;
        v_new_remaining := COALESCE(v_total_amount, 0) - v_new_total_paid;
        UPDATE public.cash_orders
           SET total_paid = v_new_total_paid,
               remaining_balance = v_new_remaining,
               updated_at = now(),
               status = CASE WHEN v_new_remaining <= 0 THEN 'completed' ELSE status END,
               completed_at = CASE WHEN v_new_remaining <= 0 THEN now() ELSE completed_at END
         WHERE id = r.cash_order_id;
      END IF;
    END IF;
  END IF;

  -- 7b. Loyalty trail — account note (only when linked to an account or cash order)
  IF r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL THEN
    v_note := 'Loyalty: ' || v_pts || ' pts redeemed (' || r.redemption_type || ')';
    IF v_payment_amount IS NOT NULL AND v_payment_amount > 0 THEN
      v_note := v_note || ' — ' || CASE WHEN v_currency = 'PHP' THEN '₱' ELSE '¥' END
                || v_payment_amount || ' applied to balance';
    END IF;
    INSERT INTO public.account_notes
      (account_id, cash_order_id, note_text, created_by_user_id, created_by_name)
    VALUES
      (r.account_id, r.cash_order_id, v_note, p_user_id, 'System (Loyalty)');
  END IF;

  -- 8. Audit log
  INSERT INTO public.audit_logs
    (entity_type, entity_id, action, performed_by_user_id, old_value_json, new_value_json)
  VALUES
    ('loyalty_redemption', r.id, 'redemption_approved', p_user_id,
     jsonb_build_object('status', 'pending'),
     jsonb_build_object('status', 'confirmed', 'transaction_id', v_tx_id,
                        'points_redeemed', v_pts, 'redemption_type', r.redemption_type,
                        'invoice_number', r.invoice_number));

  RETURN jsonb_build_object(
    'transaction_id', v_tx_id,
    'payment_id', v_payment_id,
    'new_remaining_points', COALESCE(m.remaining_points, 0) - v_pts,
    'tier_name', v_tier_name,
    'account_status', v_new_status,
    'payment_amount', v_payment_amount,
    'currency', v_currency
  );
END
$function$;

REVOKE ALL ON FUNCTION public.approve_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text) TO sandbox_exec;
