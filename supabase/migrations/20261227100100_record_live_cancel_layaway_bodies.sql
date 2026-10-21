-- Record-only (2026-10-21). Already applied on live — replaying is a no-op.
--
-- Why: 20261227100000 (layaway Cancel) changed these six functions with md5-guarded IN-PLACE
-- patches (pg_temp.cj_patch). The drift audit reads only CREATE FUNCTION statements, so the
-- repo's newest copy of each was the PRE-patch body. This file records the bodies exactly as
-- live runs them after the apply of 2026-10-21 ~14:25 JST (owner-approved in chat, applied by
-- Claude Code through the Lovable database connection after a 0/0/0 drift check). Each body is
-- the last recorded one (md5 = the pre-patch md5 in 20261227100000) plus that migration's edits,
-- rebuilt in a scratch database and checked to hash to the live md5 before this file was written.
--
--   allocate_payment_atomic                     fab3b0eb1843cfa20e2e85b97ca54cc3
--   cancel_cash_order_atomic                    06fb9394e5e4d8d3f3113aa3f5937261
--   terminate_web_order_atomic                  2c72d6c1d488cf11e1cd61a8d23bc6f6
--   get_monthly_sales                           4ce37e63cbe6c037352d2a6b7e72341d
--   get_trade_kpis                              53039b01010c09f7c434c64bb7f2bca9
--   get_trade_monthly_trends                    713440f1ec4e052b233db31898195cb0
--   cancel_layaway_atomic (created in full by 20261227100000; checked only)
--                                               2cc9eaea9c5802eac1961b8cbd9ffd04
--
-- GUARDS: before each replace, a DO block reads md5(pg_get_functiondef) on the database. Equal
-- to the live md5 → it says so and the replace writes the identical body (a no-op). Anything
-- else → STOP, nothing changed. After each replace the md5 is checked again, so a body that
-- does not reproduce live exactly rolls the migration back.
--
-- GRANTS ARE NOT TOUCHED. The replace keeps each function's live ACL.

-- ---------------------------------------------------------------------------
-- allocate_payment_atomic
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> 'fab3b0eb1843cfa20e2e85b97ca54cc3' THEN
    RAISE EXCEPTION 'STOP — public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean) has md5 %, expected fab3b0eb1843cfa20e2e85b97ca54cc3; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean) matches live — the replace below rewrites the identical body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.allocate_payment_atomic(p_account_id uuid, p_amount_paid numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_remarks text, p_user_id uuid, p_currency text, p_is_downpayment boolean DEFAULT false, p_submitted_by_type text DEFAULT 'staff'::text, p_submitted_by_name text DEFAULT NULL::text, p_preview boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Verbatim translation of review-payment-submission allocatePaymentToAccount
-- (the SINGLE live payment-write path per CLAUDE.md §1299 / Bug #219).
-- Row-scoped waterfall (STEP A-D), carry-over guard, Keep-credit ceiling.
-- INVARIANT 11 (2026-07-06, Bug #250): DP up to downpayment_amount does NOT
-- allocate; DP paid in EXCESS of downpayment_amount waterfalls into installments
-- (Month 1 onward) exactly like an installment payment. Only the excess portion
-- of a DP payment is fed into the waterfall; the required portion is recorded as
-- a payment (INVARIANT 1) but creates no schedule allocation.
DECLARE
  v_remaining     numeric := round(p_amount_paid, 2);
  v_allocations   jsonb := '[]'::jsonb;
  v_pen_updates   jsonb := '[]'::jsonb;
  v_sched_updates jsonb := '[]'::jsonb;
  rec             record;
  pen             record;
  v_next_carried  numeric;
  v_row_pen       numeric;
  v_to_pay        numeric;
  v_already       numeric;
  v_natural       numeric;
  v_ceiling       numeric;
  v_due           numeric;
  v_apply         numeric;
  v_new_paid      numeric;
  v_fully         boolean;
  v_paid_amt      numeric;
  v_row_status    text;
  v_payment_id    uuid := NULL;
  v_total_paid    numeric;
  v_pen_active    numeric;
  v_total_amount  numeric;
  v_cur_status    text;
  v_new_remaining numeric;
  v_new_status    text;
  v_has_overdue   boolean;
  elem            jsonb;
  merged          record;
  v_dp_required   numeric;
  v_dp_paid_before numeric;
  v_dp_excess     numeric;
BEGIN
  IF p_account_id IS NULL OR p_amount_paid IS NULL OR p_amount_paid <= 0 THEN
    RAISE EXCEPTION 'invalid_input: account_id and positive amount required';
  END IF;

  -- ── DP excess split (INVARIANT 11, 2026-07-06) ──
  -- For a DP payment, only the portion beyond the required downpayment_amount
  -- enters the waterfall. Prior non-voided DP payments count toward the required
  -- amount (canonical DP heuristic: reference_number 'DP-%' OR remarks ILIKE
  -- '%down%'). For a non-DP payment, the full amount waterfalls as before.
  IF p_is_downpayment THEN
    SELECT coalesce(downpayment_amount, 0) INTO v_dp_required
    FROM layaway_accounts WHERE id = p_account_id;

    SELECT coalesce(sum(amount_paid), 0) INTO v_dp_paid_before
    FROM payments
    WHERE account_id = p_account_id
      AND voided_at IS NULL
      AND (reference_number LIKE 'DP-%' OR remarks ILIKE '%down%');

    -- excess carried by THIS payment = how much (prior DP + this) exceeds required,
    -- capped at this payment's amount
    v_dp_excess := least(
      round(p_amount_paid, 2),
      greatest(0, round((v_dp_paid_before + p_amount_paid) - v_dp_required, 2))
    );
    v_remaining := v_dp_excess;
  END IF;

  -- ── Waterfall ──
  -- Runs for all installment payments, and for the DP EXCESS portion (v_remaining
  -- set above). Pure within-DP payments have v_remaining = 0 → loop is a no-op,
  -- preserving INVARIANT 11 for the required downpayment.
  IF (NOT p_is_downpayment) OR v_remaining > 0 THEN
    FOR rec IN
      SELECT * FROM layaway_schedule
      WHERE account_id = p_account_id
        AND status NOT IN ('paid','cancelled')
      ORDER BY installment_number ASC
    LOOP
      EXIT WHEN v_remaining <= 0;

      -- Carry-over guard: if NEXT row already holds carried_amount, this row
      -- was administratively closed via carry-over — skip it.
      SELECT carried_amount INTO v_next_carried
      FROM layaway_schedule
      WHERE account_id = p_account_id
        AND installment_number = rec.installment_number + 1;
      IF coalesce(v_next_carried, 0) > 0.005 THEN
        CONTINUE;
      END IF;

      -- STEP A — this row's unpaid penalties only (penalty_date ASC)
      v_row_pen := 0;
      FOR pen IN
        SELECT id, penalty_amount FROM penalty_fees
        WHERE account_id = p_account_id
          AND status = 'unpaid'
          AND schedule_id = rec.id
        ORDER BY penalty_date ASC
      LOOP
        EXIT WHEN v_remaining <= 0;
        v_to_pay    := round(least(v_remaining, pen.penalty_amount), 2);
        v_remaining := v_remaining - v_to_pay;
        v_row_pen   := v_row_pen + v_to_pay;
        v_allocations := v_allocations || jsonb_build_object(
          'schedule_id', rec.id, 'allocation_type', 'penalty',
          'allocated_amount', v_to_pay);
        v_pen_updates := v_pen_updates || jsonb_build_object(
          'id', pen.id,
          'status', CASE WHEN v_to_pay >= pen.penalty_amount THEN 'paid' ELSE 'unpaid' END);
      END LOOP;

      EXIT WHEN v_remaining <= 0;

      -- STEP B — this row's base installment.
      SELECT coalesce(sum(pa.allocated_amount), 0) INTO v_already
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa.payment_id
      WHERE pa.schedule_id = rec.id AND p.voided_at IS NULL;

      v_natural := rec.base_installment_amount
                 + coalesce(rec.penalty_amount, 0)
                 + coalesce(rec.carried_amount, 0);
      v_ceiling := CASE WHEN rec.total_due_amount IS NOT NULL AND rec.total_due_amount <> 0
                        THEN least(v_natural, rec.total_due_amount)
                        ELSE v_natural END;
      v_due := greatest(0, v_ceiling - v_already - v_row_pen);
      IF v_due <= 0 THEN CONTINUE; END IF;

      v_apply    := round(least(v_remaining, v_due), 2);
      v_new_paid := v_already + v_apply;
      v_fully    := (v_new_paid + v_row_pen >= v_ceiling - 0.005);

      IF v_fully AND rec.status = 'partially_paid' THEN
        v_paid_amt := v_ceiling; v_row_status := 'paid';
      ELSIF v_fully THEN
        v_paid_amt := v_new_paid; v_row_status := 'paid';
      ELSE
        v_paid_amt := v_new_paid; v_row_status := 'partially_paid';
      END IF;
      v_allocations := v_allocations || jsonb_build_object(
        'schedule_id', rec.id, 'allocation_type', 'installment',
        'allocated_amount', v_apply);
      v_sched_updates := v_sched_updates || jsonb_build_object(
        'id', rec.id, 'paid_amount', v_paid_amt, 'status', v_row_status);

      v_remaining := v_remaining - v_apply;
      EXIT WHEN v_remaining <= 0;
    END LOOP;
  END IF;

  -- ── Merge penalty allocations per schedule_id (unique-constraint safety) ──
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_allocations
  FROM (
    SELECT jsonb_build_object(
             'schedule_id', a->>'schedule_id',
             'allocation_type', 'penalty',
             'allocated_amount', sum((a->>'allocated_amount')::numeric)) AS x
    FROM jsonb_array_elements(v_allocations) a
    WHERE a->>'allocation_type' = 'penalty'
    GROUP BY a->>'schedule_id'
    UNION ALL
    SELECT a FROM jsonb_array_elements(v_allocations) a
    WHERE a->>'allocation_type' = 'installment'
  ) m;

  -- ── Derived totals (INVARIANT 1: SUM of non-voided payments) ──
  SELECT coalesce(sum(amount_paid), 0) INTO v_total_paid
  FROM payments WHERE account_id = p_account_id AND voided_at IS NULL;
  SELECT coalesce(sum(penalty_amount), 0) INTO v_pen_active
  FROM penalty_fees WHERE account_id = p_account_id AND status <> 'waived';
  SELECT total_amount, status::text INTO v_total_amount, v_cur_status
  FROM layaway_accounts WHERE id = p_account_id;
  IF v_total_amount IS NULL THEN
    RAISE EXCEPTION 'account_not_found: %', p_account_id;
  END IF;
  IF v_cur_status = 'cancelled' THEN
    RAISE EXCEPTION 'account_cancelled: layaway % is cancelled — no payment can be recorded on it', p_account_id USING ERRCODE = 'P0001';
  END IF;

  -- ── PREVIEW MODE: return the plan, write NOTHING ──
  IF p_preview THEN
    v_total_paid    := v_total_paid + round(p_amount_paid, 2);
    v_new_remaining := greatest(0, round(v_total_amount + v_pen_active - v_total_paid, 2));
    v_new_status := CASE WHEN v_new_remaining <= 0 THEN 'completed' ELSE v_cur_status END;
    RETURN jsonb_build_object(
      'preview', true, 'payment_id', NULL,
      'allocations', v_allocations,
      'penalty_updates', v_pen_updates,
      'schedule_updates', v_sched_updates,
      'new_total_paid', v_total_paid,
      'new_remaining_balance', v_new_remaining,
      'new_status', v_new_status);
  END IF;

  -- ── WRITE MODE: all writes below commit or roll back together ──
  INSERT INTO payments (
    account_id, amount_paid, currency, date_paid, payment_method,
    reference_number, remarks, entered_by_user_id,
    submitted_by_type, submitted_by_name
  ) VALUES (
    p_account_id, p_amount_paid, p_currency::account_currency, p_payment_date,
    p_payment_method, p_reference_number, p_remarks, p_user_id,
    p_submitted_by_type, p_submitted_by_name
  ) RETURNING id INTO v_payment_id;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_allocations) LOOP
    INSERT INTO payment_allocations (payment_id, schedule_id, allocation_type, allocated_amount)
    VALUES (v_payment_id, (elem->>'schedule_id')::uuid,
            (elem->>'allocation_type')::allocation_type,
            (elem->>'allocated_amount')::numeric);
  END LOOP;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_pen_updates) LOOP
    UPDATE penalty_fees
    SET status = (elem->>'status')::penalty_fee_status
    WHERE id = (elem->>'id')::uuid;
  END LOOP;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_sched_updates) LOOP
    UPDATE layaway_schedule
    SET paid_amount = (elem->>'paid_amount')::numeric,
        status      = (elem->>'status')::schedule_status
    WHERE id = (elem->>'id')::uuid;
  END LOOP;

  SELECT coalesce(sum(amount_paid), 0) INTO v_total_paid
  FROM payments WHERE account_id = p_account_id AND voided_at IS NULL;
  SELECT coalesce(sum(penalty_amount), 0) INTO v_pen_active
  FROM penalty_fees WHERE account_id = p_account_id AND status <> 'waived';
  v_new_remaining := greatest(0, round(v_total_amount + v_pen_active - v_total_paid, 2));

  v_new_status := NULL;
  IF v_new_remaining <= 0 THEN
    v_new_status := 'completed';
  ELSIF v_cur_status IN ('active','overdue') THEN
    SELECT EXISTS (
      SELECT 1 FROM layaway_schedule
      WHERE account_id = p_account_id
        AND status NOT IN ('paid','cancelled')
        AND due_date < CURRENT_DATE
    ) INTO v_has_overdue;
    v_new_status := CASE WHEN v_has_overdue THEN 'overdue' ELSE 'active' END;
  END IF;

  IF v_new_status IS NOT NULL THEN
    UPDATE layaway_accounts
    SET total_paid = v_total_paid, remaining_balance = v_new_remaining,
        status = v_new_status::account_status
    WHERE id = p_account_id;
  ELSE
    UPDATE layaway_accounts
    SET total_paid = v_total_paid, remaining_balance = v_new_remaining
    WHERE id = p_account_id;
  END IF;

  RETURN jsonb_build_object(
    'preview', false, 'payment_id', v_payment_id,
    'allocations', v_allocations,
    'penalty_updates', v_pen_updates,
    'schedule_updates', v_sched_updates,
    'new_total_paid', v_total_paid,
    'new_remaining_balance', v_new_remaining,
    'new_status', coalesce(v_new_status, v_cur_status));
END;
$function$;

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> 'fab3b0eb1843cfa20e2e85b97ca54cc3' THEN
    RAISE EXCEPTION 'STOP — public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean) has md5 % after the replace, expected fab3b0eb1843cfa20e2e85b97ca54cc3; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.allocate_payment_atomic(uuid,numeric,date,text,text,text,uuid,text,boolean,text,text,boolean) recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- cancel_cash_order_atomic
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '06fb9394e5e4d8d3f3113aa3f5937261' THEN
    RAISE EXCEPTION 'STOP — public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) has md5 %, expected 06fb9394e5e4d8d3f3113aa3f5937261; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) matches live — the replace below rewrites the identical body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.cancel_cash_order_atomic(p_cash_order_id uuid, p_reason text, p_user_id uuid DEFAULT NULL::uuid, p_user_email text DEFAULT NULL::text, p_preview boolean DEFAULT false, p_source text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text; v_currency account_currency; v_customer_id uuid; v_invoice text;
  v_money_received numeric(12,2); v_loyalty_synthetic numeric(12,2);
  v_partial_credit numeric(12,2); v_issue_amount numeric(12,2);
  v_member_id uuid; v_credit jsonb := NULL; v_revoked_tx uuid := NULL;
  v_reason text; v_is_system boolean;
  v_order_date date; v_order_at timestamptz; v_shopify_id text; v_split jsonb;
  v_card_refunded boolean := false;
  v_paidy_refunded numeric(12,2) := 0;
  v_card_disputed bigint := 0;
  v_unresolved boolean := false;
BEGIN
  v_is_system := (p_source = 'shopify_webhook');
  IF NOT p_preview AND NOT v_is_system AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF NOT p_preview AND v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE='P0001';
  END IF;
  SELECT status::text, currency, customer_id, invoice_number, order_date, shopify_order_id, created_at
    INTO v_status, v_currency, v_customer_id, v_invoice, v_order_date, v_shopify_id, v_order_at
  FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cash_order_not_found: %', p_cash_order_id USING ERRCODE='P0001';
  END IF;
  IF v_status = 'cancelled' AND v_is_system THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true, 'cash_order_id', p_cash_order_id, 'invoice_number', v_invoice);
  END IF;
  IF v_status NOT IN ('pending','completed') THEN
    RAISE EXCEPTION 'cash_order_not_cancellable: status is %', v_status USING ERRCODE='P0001';
  END IF;
  v_unresolved := public.square_order_unresolved(p_cash_order_id);
  IF NOT p_preview AND v_unresolved THEN
    RAISE EXCEPTION 'card_payment_unresolved: a card payment on this order is still being processed — close the hold or record the capture first' USING ERRCODE='P0001';
  END IF;
  -- QC PR-B L-1 (2026-10-10): the same rule terminate_web_order_atomic applies —
  -- never cancel while Paidy holds the order (an authorisation, a capture not
  -- recorded, a submission, or her open window) — the preview says the same.
  IF coalesce(public.cash_order_payment_lock(p_cash_order_id), '') LIKE 'paidy%' THEN
    RAISE EXCEPTION 'paidy_payment_unresolved: Paidy holds this order — Reject or record the Paidy payment first' USING ERRCODE='P0001';
  END IF;
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_money_received
  FROM public.cash_payments
  WHERE cash_order_id = p_cash_order_id AND voided_at IS NULL
    AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_loyalty_synthetic
  FROM public.cash_payments
  WHERE cash_order_id = p_cash_order_id AND voided_at IS NULL
    AND COALESCE(reference_number, '') LIKE 'LOYALTY-%';
  -- F2: credit already minted for this order via Shopify partial refunds must not
  -- be minted a second time on full cancellation. Invariant: total credit issued
  -- for an order never exceeds money actually received.
  SELECT COALESCE(SUM(original_amount), 0) INTO v_partial_credit
  FROM public.store_credit_lots
  WHERE source_cash_order_id = p_cash_order_id
    AND source_type = 'shopify_partial_refund' AND status <> 'voided';
  -- Cancellation credit rule (owner 2026-10-06/08): a Hub cash order
  -- cancelled on its order_date → 100 % credit; later → 30 % of the
  -- money paid is kept, 70 % credit. Shopify orders keep 100 % (owner E3).
  IF v_is_system OR v_shopify_id IS NOT NULL THEN
    v_split := jsonb_build_object('rule', 'shopify_full', 'charge_pct', 0, 'money', v_money_received,
                                  'kept', 0, 'credit', v_money_received, 'order_date', v_order_date);
  ELSE
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, now(), v_order_at);
  END IF;
  v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
  -- R05 (owner 2026-10-08, refuse): money already given back through Square
  -- never comes back again as store credit — the cancel itself is refused so
  -- staff pick the refund path, exactly as on a web order.
  v_card_refunded := EXISTS (SELECT 1 FROM public.square_refunds
                              WHERE cash_order_id = p_cash_order_id AND status NOT IN ('FAILED','REJECTED'));
  IF NOT p_preview AND v_card_refunded AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'card_already_refunded: money on this order was already refunded through Square — it cannot be issued again as store credit' USING ERRCODE='P0001';
  END IF;
  -- PA02 (owner 2026-10-08, refuse): money already given back through Paidy
  -- (a verified paidy_refunds row — an exception to the no-cash-refund policy)
  -- never comes back again as store credit; staff finish it by hand.
  SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded
    FROM public.paidy_refunds r WHERE r.cash_order_id = p_cash_order_id;
  IF NOT p_preview AND v_paidy_refunded > 0 AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'paidy_already_refunded: ¥% of this order was already refunded in the Paidy dashboard — it cannot be issued again as store credit', v_paidy_refunded::bigint USING ERRCODE='P0001';
  END IF;
  v_card_disputed := public.square_order_disputed_jpy(p_cash_order_id);
  IF NOT p_preview AND v_card_disputed > 0 AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'card_disputed: ¥% of this order is held or taken back by a card chargeback — it cannot be issued again as store credit', v_card_disputed USING ERRCODE='P0001';
  END IF;
  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'invoice_number', v_invoice, 'status', v_status,
      'card_refunded', v_card_refunded,
      'paidy_refunded_jpy', v_paidy_refunded,
      'card_disputed_jpy', v_card_disputed,
      'card_payment_unresolved', v_unresolved,
      'refusal', CASE WHEN v_unresolved THEN 'card_payment_unresolved'
                      WHEN v_issue_amount > 0 AND v_card_refunded THEN 'card_already_refunded'
                      WHEN v_issue_amount > 0 AND v_paidy_refunded > 0 THEN 'paidy_already_refunded'
                      WHEN v_issue_amount > 0 AND v_card_disputed > 0 THEN 'card_disputed' END,
      'currency', v_currency, 'money_received', v_money_received,
      'loyalty_redemption_excluded', v_loyalty_synthetic,
      'partial_refund_credit_already_issued', v_partial_credit,
      'store_credit_to_issue', v_issue_amount,
      'cancellation_rule', v_split ->> 'rule',
      'cancellation_charge', COALESCE((v_split ->> 'kept')::numeric, 0),
      'cancellation_split', v_split,
      'earned_points_will_be_revoked', true);
  END IF;
  SELECT id INTO v_member_id FROM public.loyalty_members WHERE customer_id = v_customer_id;
  IF v_member_id IS NOT NULL AND v_invoice IS NOT NULL THEN
    v_revoked_tx := public.revoke_loyalty_points(
      p_member_id => v_member_id, p_source_reference => v_invoice, p_spend_jpy => 0,
      p_account_id => NULL, p_cash_order_id => p_cash_order_id, p_payment_id => NULL,
      p_invoice_number => v_invoice,
      p_notes => 'Revoked: cash order cancelled (' || v_reason || ')',
      p_created_by_user_id => p_user_id);
  END IF;
  IF v_issue_amount > 0 THEN
    v_credit := public.issue_store_credit_atomic(
      p_customer_id => v_customer_id, p_currency => v_currency, p_amount => v_issue_amount,
      p_source_type => 'cancelled_cash', p_source_account_id => NULL,
      p_source_cash_order_id => p_cash_order_id, p_user_id => p_user_id,
      p_user_email => COALESCE(p_user_email, p_source),
      p_notes => 'Auto-issued on cancellation of ' || COALESCE(v_invoice,'cash order') || ' — ' || v_reason,
      p_source => p_source);
  END IF;
  UPDATE public.cash_orders
     SET status = 'cancelled', cancellation_reason = v_reason, cancelled_at = now(),
         cancelled_by_user_id = p_user_id, updated_at = now()
   WHERE id = p_cash_order_id;
  UPDATE public.sales_log
     SET status = 'Cancelled', eligible = false, updated_at = now()
   WHERE invoice_number = v_invoice AND status IS DISTINCT FROM 'Cancelled';
  INSERT INTO public.account_notes (cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (p_cash_order_id,
    'Cash order cancelled: ' || v_reason ||
    CASE
      WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
        || CASE WHEN COALESCE((v_split ->> 'kept')::numeric, 0) > 0
                THEN ' (30% cancellation charge kept: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || (v_split ->> 'kept') || ')'
                ELSE '' END
      WHEN v_money_received > 0 THEN ' — no additional store credit (already issued via partial refunds: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_partial_credit || ')'
      ELSE ' — no payments received, no store credit'
    END,
    p_user_id, CASE WHEN v_is_system THEN 'Shopify (webhook)' ELSE COALESCE(p_user_email, 'System') END);
  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('cash_order', p_cash_order_id, 'cancel', p_user_id, jsonb_build_object(
    'invoice_number', v_invoice, 'reason', v_reason, 'prior_status', v_status,
    'currency', v_currency, 'money_received', v_money_received,
    'loyalty_redemption_excluded', v_loyalty_synthetic,
    'partial_refund_credit_already_issued', v_partial_credit,
    'store_credit_issued', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
    'source', p_source,
    'actor', CASE WHEN v_is_system THEN 'shopify_webhook' ELSE COALESCE(p_user_email, 'unknown') END,
    'user_email', p_user_email));
  RETURN jsonb_build_object(
    'success', true, 'cash_order_id', p_cash_order_id, 'invoice_number', v_invoice,
    'prior_status', v_status, 'money_received', v_money_received,
    'loyalty_redemption_excluded', v_loyalty_synthetic,
    'partial_refund_credit_already_issued', v_partial_credit,
    'store_credit', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx, 'source', p_source);
END;
$function$;

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '06fb9394e5e4d8d3f3113aa3f5937261' THEN
    RAISE EXCEPTION 'STOP — public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) has md5 % after the replace, expected 06fb9394e5e4d8d3f3113aa3f5937261; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text) recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- terminate_web_order_atomic
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '2c72d6c1d488cf11e1cd61a8d23bc6f6' THEN
    RAISE EXCEPTION 'STOP — public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) has md5 %, expected 2c72d6c1d488cf11e1cd61a8d23bc6f6; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) matches live — the replace below rewrites the identical body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.terminate_web_order_atomic(p_order_id uuid, p_outcome text, p_reason text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid, p_user_email text DEFAULT NULL::text, p_refund_status text DEFAULT NULL::text, p_refund_note text DEFAULT NULL::text, p_source text DEFAULT 'staff'::text, p_preview boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text; v_currency account_currency; v_customer_id uuid; v_invoice text; v_web_ref text;
  v_total_paid numeric(12,2);
  v_money_received numeric(12,2); v_loyalty_synthetic numeric(12,2);
  v_partial_credit numeric(12,2); v_issue_amount numeric(12,2) := 0;
  v_member_id uuid; v_credit jsonb := NULL; v_revoked_tx uuid := NULL;
  v_order_date date; v_order_at timestamptz; v_split jsonb := NULL; v_card_paid boolean := false;
  v_card_refunded boolean := false;
  v_card_disputed bigint := 0;
  v_credit_refusal text := NULL;
  v_paidy_paid numeric(12,2) := 0; v_paidy_refunded numeric(12,2) := 0;
  v_points_to_revoke numeric := 0; v_spend_to_reverse numeric := 0;
  v_reason text; v_is_system boolean; v_stock_lines integer := 0; v_restored integer := 0;
  v_flipped integer := 0; v_now timestamptz := now();
BEGIN
  IF p_outcome NOT IN ('expired','cancelled') THEN
    RAISE EXCEPTION 'bad_outcome: %', p_outcome USING ERRCODE='P0001';
  END IF;
  v_is_system := (p_source IN ('system','shopify_webhook'));

  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid, order_date, created_at
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid, v_order_date, v_order_at
  FROM public.cash_orders
  WHERE id = p_order_id AND source_channel = 'web'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'not_web_order');
  END IF;
  IF v_status IN ('cancelled','expired') THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'already_terminal',
      'status', v_status, 'already_cancelled', (v_status = 'cancelled'));
  END IF;
  IF (p_outcome = 'expired' OR v_is_system)
     AND EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_order_id AND shipped_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'shipped', 'status', v_status);
  END IF;
  IF (p_outcome = 'expired' OR v_is_system)
     AND EXISTS (SELECT 1 FROM public.cash_orders WHERE id = p_order_id AND payment_method = 'cod') THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'cod_no_deadline', 'status', v_status);
  END IF;

  -- INVARIANT 12: an unconfirmed payment submission freezes AUTOMATED status.
  -- The money may already be in the bank and only the reviewer knows, so a
  -- lapse (always automated) and any system-sourced cancel stand down here.
  -- A staff cancel is a person acting deliberately and is NOT blocked.
  IF (p_outcome = 'expired' OR v_is_system) AND EXISTS (
       SELECT 1 FROM public.payment_submissions
        WHERE cash_order_id = p_order_id
          AND (status IN ('submitted','under_review')
               -- a Confirm claimed but not yet recorded (2026-10-04): the money may be taken
               OR (status = 'confirmed' AND confirmed_payment_id IS NULL))) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'submission_pending',
      'status', v_status);
  END IF;
  -- Square (2026-10-04, SQ10/SQ11): a card attempt in flight, a live hold or
  -- captured card money not yet recorded stops EVERY termination, staff
  -- included — the hold is closed (Reject) or the capture recorded first, so a
  -- cancelled order never leaves money on a card.
  IF public.square_order_unresolved(p_order_id) THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_payment_unresolved',
      'status', v_status);
  END IF;
  -- Paidy (H10, qc-audit P2-3): a Paidy authorisation, a capture not yet
  -- recorded, a Paidy submission awaiting Confirm or an open Paidy window stops
  -- EVERY termination, staff included — Reject or record the Paidy payment
  -- first, so a cancelled order never leaves Paidy money behind.
  IF NOT (p_preview AND p_outcome = 'cancelled' AND p_source = 'staff')   -- owner 2026-10-06: cancel closes Paidy first
     AND coalesce(public.cash_order_payment_lock(p_order_id), '') LIKE 'paidy%' THEN
    RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_payment_unresolved',
      'status', v_status);
  END IF;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_money_received
  FROM public.cash_payments
  WHERE cash_order_id = p_order_id AND voided_at IS NULL
    AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_loyalty_synthetic
  FROM public.cash_payments
  WHERE cash_order_id = p_order_id AND voided_at IS NULL
    AND COALESCE(reference_number, '') LIKE 'LOYALTY-%';
  SELECT COALESCE(SUM(original_amount), 0) INTO v_partial_credit
  FROM public.store_credit_lots
  WHERE source_cash_order_id = p_order_id
    AND source_type = 'shopify_partial_refund' AND status <> 'voided';
  SELECT COUNT(*) INTO v_stock_lines
  FROM public.cash_order_items WHERE cash_order_id = p_order_id AND variant_id IS NOT NULL;

  IF p_outcome = 'expired' THEN
    -- A lapse only ever ends an order nobody paid for. A partially paid web
    -- order is a staff decision, never an automatic one.
    -- Points are a discount, not money (2026-10-05): an order carrying only a
    -- checkout points redemption still lapses. Rule 9: the points stay spent.
    IF v_status <> 'pending' OR v_money_received > 0 OR COALESCE(v_total_paid, 0) - v_loyalty_synthetic > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'not_pending_or_paid',
        'status', v_status, 'money_received', v_money_received);
    END IF;
    v_reason := COALESCE(NULLIF(btrim(p_reason), ''), 'Bank transfer not received by the deadline (auto-expired)');
  ELSE
    IF NOT p_preview AND NOT v_is_system AND p_user_id IS NULL THEN
      RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
    END IF;
    IF v_status NOT IN ('pending','completed') THEN
      RAISE EXCEPTION 'cash_order_not_cancellable: status is %', v_status USING ERRCODE='P0001';
    END IF;
    v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
    IF NOT p_preview AND v_reason IS NULL THEN
      RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE='P0001';
    END IF;
    IF p_refund_status IS NOT NULL AND p_refund_status NOT IN ('refund_issued','refund_pending','store_credit_issued','no_refund') THEN
      RAISE EXCEPTION 'bad_refund_status: %', p_refund_status USING ERRCODE='P0001';
    END IF;
    IF NOT p_preview AND v_money_received > 0 AND p_refund_status IS NULL THEN
      RAISE EXCEPTION 'refund_decision_required' USING ERRCODE='P0001';
    END IF;
    -- B01 (2026-10-08): card money goes back only through Square, so a card
    -- order cannot be closed as "refund issued" here: choose "refund pending",
    -- refund in Square, then "Mark refund issued" once Square shows it.
    v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                            WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
    IF NOT p_preview AND v_money_received > 0 AND p_refund_status = 'refund_issued' AND v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_refund_needs_square',
        'status', v_status);
    END IF;
    -- PA03 (owner 2026-10-08): Paidy money goes back only through the Paidy
    -- dashboard, and only a refund the Hub has read back from Paidy counts.
    -- "Refund issued" on a Paidy-paid order needs verified Paidy refunds that
    -- cover the Paidy money; otherwise choose "refund pending", refund in
    -- Paidy, and "Mark refund issued" once the Hub has recorded it.
    SELECT COALESCE(SUM(amount_paid), 0) INTO v_paidy_paid FROM public.cash_payments
     WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'paidy';
    SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded FROM public.paidy_refunds r
     WHERE r.cash_order_id = p_order_id;
    IF NOT p_preview AND v_paidy_paid > 0 AND p_refund_status = 'refund_issued' AND v_paidy_refunded < v_paidy_paid THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_refund_needs_dashboard',
        'status', v_status, 'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_jpy', v_paidy_refunded);
    END IF;
    -- R05 (owner 2026-10-08, refuse): money already given back through Square
    -- (any refund not FAILED / REJECTED — pending counts, it is committed) can
    -- never come back a second time as store credit. Staff see the reason and
    -- use "refund pending" → "Mark refund issued" instead.
    v_card_refunded := EXISTS (SELECT 1 FROM public.square_refunds
                                WHERE cash_order_id = p_order_id AND status NOT IN ('FAILED','REJECTED'));
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_card_refunded THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_already_refunded',
        'status', v_status);
    END IF;
    -- PA02 (owner 2026-10-08, refuse): money already given back through Paidy
    -- (a verified paidy_refunds row — an exception to the no-cash-refund
    -- policy) can never come back a second time as store credit. Staff see
    -- the reason and use "refund pending" → "Mark refund issued" instead.
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_paidy_refunded > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_already_refunded',
        'status', v_status, 'paidy_refunded_jpy', v_paidy_refunded);
    END IF;
    v_card_disputed := public.square_order_disputed_jpy(p_order_id);
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_card_disputed > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_disputed',
        'status', v_status, 'disputed_jpy', v_card_disputed);
    END IF;
    v_credit_refusal := CASE WHEN v_card_refunded THEN 'card_already_refunded'
                             WHEN v_paidy_refunded > 0 THEN 'paidy_already_refunded'
                             WHEN v_card_disputed > 0 THEN 'card_disputed' END;
    -- Cancellation credit rule (owner 2026-10-06/08): same day as order_date →
    -- 100 %; later → 30 % of the money paid kept, 70 % credit. No override.
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now, v_order_at);
    -- Store credit is minted ONLY when staff choose "store credit issued"
    -- (money received, minus credit already minted by Shopify partial refunds).
    -- A refund never doubles as credit; "no refund" is a forfeiture and mints
    -- nothing. Never automatic (owner decision 2026-09-13).
    IF p_refund_status = 'store_credit_issued' THEN
      v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
    END IF;
  END IF;

  -- Resolve what the reversal would actually do, so the preview can tell the
  -- truth and the write path does not repeat the lookup. Points are what
  -- still exists in the lots; spend is what the ledger says this order put
  -- on the counter. They are different quantities and can differ: points
  -- already redeemed or expired leave spend to reverse and no points.
  SELECT id INTO v_member_id FROM public.loyalty_members WHERE customer_id = v_customer_id;
  IF v_member_id IS NOT NULL AND v_invoice IS NOT NULL THEN
    SELECT COALESCE(SUM(remaining_amount), 0) INTO v_points_to_revoke
      FROM public.loyalty_point_lots
     WHERE member_id = v_member_id AND source_reference = v_invoice
       AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;
    v_spend_to_reverse := public.loyalty_order_spend_basis(v_member_id, v_invoice);
  END IF;

  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'is_web', true, 'invoice_number', v_invoice, 'web_reference', v_web_ref,
      'status', v_status, 'currency', v_currency, 'money_received', v_money_received,
      'loyalty_redemption_excluded', v_loyalty_synthetic,
      'partial_refund_credit_already_issued', v_partial_credit,
      'store_credit_to_issue', v_issue_amount,
      'store_credit_if_chosen', CASE WHEN v_credit_refusal IS NOT NULL THEN 0
                                     ELSE GREATEST(0, COALESCE((v_split ->> 'credit')::numeric, 0) - v_partial_credit) END,
      'store_credit_refusal', v_credit_refusal,
      'card_disputed_jpy', v_card_disputed,
      'cancellation_rule', v_split ->> 'rule',
      'cancellation_charge', COALESCE((v_split ->> 'kept')::numeric, 0),
      'cancellation_split', v_split,
      'paid_by_card', v_card_paid,
      'card_refunded', v_card_refunded,
      'paid_by_paidy', (v_paidy_paid > 0),
      'paidy_paid_jpy', v_paidy_paid,
      'paidy_refunded_jpy', v_paidy_refunded,
      'refund_decision_required', (v_money_received > 0),
      'stock_lines', v_stock_lines,
      -- Was unconditionally true, which promised staff a reversal that could
      -- not happen once the points were gone. Now it reports both quantities.
      'earned_points_will_be_revoked', (v_points_to_revoke > 0),
      'earned_points_to_revoke', v_points_to_revoke,
      'lifetime_spend_to_reverse_jpy', v_spend_to_reverse);
  END IF;

  -- 1. Points from the lots, lifetime spend from the ledger — a ledger row plus
  --    lots marked revoked. p_spend_jpy stays 0: the basis is derived inside
  --    revoke_loyalty_points, which is the only place that knows it. Idempotent.
  IF v_member_id IS NOT NULL AND v_invoice IS NOT NULL THEN
    v_revoked_tx := public.revoke_loyalty_points(
      p_member_id => v_member_id, p_source_reference => v_invoice, p_spend_jpy => 0,
      p_account_id => NULL, p_cash_order_id => p_order_id, p_payment_id => NULL,
      p_invoice_number => v_invoice,
      p_notes => 'Revoked: web order ' || p_outcome || ' (' || v_reason || ')',
      p_created_by_user_id => p_user_id, p_trigger_event => 'cancel');
  END IF;

  -- 2. Store credit (cancelled + store_credit_issued only).
  IF v_issue_amount > 0 THEN
    v_credit := public.issue_store_credit_atomic(
      p_customer_id => v_customer_id, p_currency => v_currency, p_amount => v_issue_amount,
      p_source_type => 'cancelled_cash', p_source_account_id => NULL,
      p_source_cash_order_id => p_order_id, p_user_id => p_user_id,
      p_user_email => COALESCE(p_user_email, p_source),
      p_notes => 'Auto-issued on cancellation of ' || COALESCE(v_web_ref, v_invoice) || ' — ' || v_reason,
      p_source => p_source);
  END IF;

  -- 3. Status flip — the guard that makes everything below run exactly once.
  IF p_outcome = 'expired' THEN
    UPDATE public.cash_orders
       SET status = 'expired'::cash_order_status, expired_at = v_now,
           cancellation_reason = v_reason, updated_at = v_now
     WHERE id = p_order_id AND status NOT IN ('cancelled','expired');
  ELSE
    UPDATE public.cash_orders
       SET status = 'cancelled'::cash_order_status, cancellation_reason = v_reason,
           cancelled_at = v_now, cancelled_by_user_id = p_user_id,
           refund_status = CASE WHEN v_money_received > 0 THEN p_refund_status ELSE NULL END,
           refund_note = CASE WHEN v_money_received > 0 THEN NULLIF(btrim(COALESCE(p_refund_note,'')), '') ELSE NULL END,
           refund_decided_at = CASE WHEN v_money_received > 0 THEN v_now ELSE NULL END,
           refund_decided_by_user_id = CASE WHEN v_money_received > 0 THEN p_user_id ELSE NULL END,
           updated_at = v_now
     WHERE id = p_order_id AND status NOT IN ('cancelled','expired');
  END IF;
  GET DIAGNOSTICS v_flipped = ROW_COUNT;
  IF v_flipped = 0 THEN
    RAISE EXCEPTION 'terminal_flip_failed for %', p_order_id USING ERRCODE='P0001';
  END IF;
  IF p_outcome <> 'expired' THEN
    UPDATE public.sales_log
       SET status = 'Cancelled', eligible = false, updated_at = v_now
     WHERE invoice_number = v_invoice AND status IS DISTINCT FROM 'Cancelled';
  END IF;

  -- 4. Stock back on sale — once, because step 3 ran once.
  UPDATE public.website_product_variants v
     SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
    FROM public.cash_order_items i
   WHERE i.cash_order_id = p_order_id AND i.variant_id = v.id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  -- 5. Trail.
  INSERT INTO public.account_notes (cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (p_order_id,
    CASE WHEN p_outcome = 'expired' THEN 'Web order expired: ' ELSE 'Web order cancelled: ' END || v_reason
    || CASE
         WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
           || CASE WHEN COALESCE((v_split ->> 'kept')::numeric, 0) > 0
                   THEN ' (30% cancellation charge kept: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || (v_split ->> 'kept') || ')'
                   ELSE '' END
         WHEN v_money_received > 0 AND p_refund_status IN ('refund_issued','refund_pending') THEN ' — ' || replace(p_refund_status, '_', ' ') || ', no store credit'
         WHEN v_money_received > 0 AND p_refund_status = 'no_refund' THEN ' — no refund (forfeited), no store credit'
         WHEN v_money_received > 0 THEN ' — no additional store credit (already issued via partial refunds)'
         ELSE ' — no payments received'
       END
    || ' — stock restored on ' || v_restored || ' line(s)',
    p_user_id, CASE WHEN v_is_system THEN 'System' ELSE COALESCE(p_user_email, 'System') END);

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('cash_order', p_order_id, CASE WHEN p_outcome = 'expired' THEN 'auto_expired' ELSE 'cancel' END, p_user_id,
    jsonb_build_object(
      'invoice_number', v_invoice, 'web_reference', v_web_ref, 'reason', v_reason, 'prior_status', v_status,
      'currency', v_currency, 'money_received', v_money_received,
      'loyalty_redemption_excluded', v_loyalty_synthetic,
      'partial_refund_credit_already_issued', v_partial_credit,
      'refund_status', p_refund_status, 'refund_note', p_refund_note,
      'store_credit_issued', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
      'earned_points_revoked', v_points_to_revoke,
      'lifetime_spend_reversed_jpy', v_spend_to_reverse,
      'stock_lines_restored', v_restored, 'source', p_source,
      'actor', CASE WHEN v_is_system THEN p_source ELSE COALESCE(p_user_email, 'unknown') END));

  RETURN jsonb_build_object(
    'ok', true, 'success', true, 'outcome', p_outcome, 'is_web', true,
    'cash_order_id', p_order_id, 'order_id', p_order_id,
    'invoice_number', v_invoice, 'web_reference', v_web_ref,
    'prior_status', v_status, 'currency', v_currency, 'money_received', v_money_received,
    'loyalty_redemption_excluded', v_loyalty_synthetic,
    'partial_refund_credit_already_issued', v_partial_credit,
    'refund_status', p_refund_status,
    'store_credit', v_credit, 'cancellation_split', v_split, 'earned_points_revoked_tx', v_revoked_tx,
    'earned_points_revoked', v_points_to_revoke,
    'lifetime_spend_reversed_jpy', v_spend_to_reverse,
    'lines_restored', v_restored, 'source', p_source);
END;
$function$;

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '2c72d6c1d488cf11e1cd61a8d23bc6f6' THEN
    RAISE EXCEPTION 'STOP — public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) has md5 % after the replace, expected 2c72d6c1d488cf11e1cd61a8d23bc6f6; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- get_monthly_sales
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_monthly_sales(text,integer)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.get_monthly_sales(text,integer) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '4ce37e63cbe6c037352d2a6b7e72341d' THEN
    RAISE EXCEPTION 'STOP — public.get_monthly_sales(text,integer) has md5 %, expected 4ce37e63cbe6c037352d2a6b7e72341d; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.get_monthly_sales(text,integer) matches live — the replace below rewrites the identical body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_monthly_sales(currency_mode text DEFAULT 'ALL'::text, months_back integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.assert_staff_caller();
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.month ASC)
    FROM (
      SELECT
        TO_CHAR(DATE_TRUNC('month', la.order_date::DATE), 'Mon YYYY') AS month,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN currency_mode <> 'ALL' THEN la.total_amount
                 WHEN la.currency = 'JPY' THEN la.total_amount
                 WHEN la.currency = 'PHP' THEN la.total_amount / r.rate
                 ELSE la.total_amount END) AS total_sales_value
      FROM layaway_accounts la
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE la.is_test = false
        AND (la.status <> 'cancelled'::account_status OR la.cancelled_at IS NOT NULL)
        AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
        AND EXISTS (SELECT 1 FROM payments p WHERE p.account_id = la.id AND p.voided_at IS NULL)
        AND DATE_TRUNC('month', la.order_date::DATE) >= DATE_TRUNC('month', CURRENT_DATE - (months_back || ' months')::INTERVAL)
      GROUP BY DATE_TRUNC('month', la.order_date::DATE)
      ORDER BY DATE_TRUNC('month', la.order_date::DATE) ASC
    ) t
  );
END;
$function$;

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_monthly_sales(text,integer)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.get_monthly_sales(text,integer) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '4ce37e63cbe6c037352d2a6b7e72341d' THEN
    RAISE EXCEPTION 'STOP — public.get_monthly_sales(text,integer) has md5 % after the replace, expected 4ce37e63cbe6c037352d2a6b7e72341d; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.get_monthly_sales(text,integer) recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- get_trade_kpis
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_trade_kpis()');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.get_trade_kpis() is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '53039b01010c09f7c434c64bb7f2bca9' THEN
    RAISE EXCEPTION 'STOP — public.get_trade_kpis() has md5 %, expected 53039b01010c09f7c434c64bb7f2bca9; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.get_trade_kpis() matches live — the replace below rewrites the identical body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_trade_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric;
  v_active_count int;
  v_total_count int;
  v_completed_count int;
  v_total_value_jpy numeric;
  v_all_accounts_count int;
  v_share_percent numeric;
BEGIN
  PERFORM public.assert_staff_caller();
  -- Canonical PHP→JPY rate (¥1 = ₱[rate]; divide PHP by rate to get JPY)
  -- Use #>> '{}' to handle both JSON string and JSON number storage
  SELECT (value #>> '{}')::numeric INTO v_rate
  FROM public.system_settings
  WHERE key = 'php_jpy_rate';
  v_rate := COALESCE(v_rate, 0.42);

  SELECT COUNT(*) INTO v_active_count
  FROM public.layaway_accounts
  WHERE is_trade = true
    AND status IN ('active','overdue','extension_active','reactivated');

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts
     WHERE is_trade = true AND (status::text != 'cancelled' OR cancelled_at IS NOT NULL))
    + (SELECT COUNT(*) FROM public.cash_orders
       WHERE is_trade = true AND status::text != 'cancelled')
  INTO v_total_count;

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts
     WHERE is_trade = true AND status = 'completed')
    + (SELECT COUNT(*) FROM public.cash_orders
       WHERE is_trade = true AND status = 'completed')
  INTO v_completed_count;

  SELECT
    COALESCE((
      SELECT SUM(
        CASE
          WHEN currency = 'JPY' THEN total_amount
          WHEN currency = 'PHP' THEN total_amount / v_rate
          ELSE total_amount
        END
      )
      FROM public.layaway_accounts
      WHERE is_trade = true AND (status::text != 'cancelled' OR cancelled_at IS NOT NULL)
    ), 0)
    + COALESCE((
      SELECT SUM(
        CASE
          WHEN currency = 'JPY' THEN total_amount
          WHEN currency = 'PHP' THEN total_amount / v_rate
          ELSE total_amount
        END
      )
      FROM public.cash_orders
      WHERE is_trade = true AND status::text != 'cancelled'
    ), 0)
  INTO v_total_value_jpy;

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts WHERE (status::text != 'cancelled' OR cancelled_at IS NOT NULL))
    + (SELECT COUNT(*) FROM public.cash_orders WHERE status::text != 'cancelled')
  INTO v_all_accounts_count;

  v_share_percent := CASE
    WHEN v_all_accounts_count = 0 THEN 0
    ELSE (v_total_count::numeric / v_all_accounts_count::numeric) * 100
  END;

  RETURN jsonb_build_object(
    'active_count', v_active_count,
    'total_count', v_total_count,
    'completed_count', v_completed_count,
    'total_value_jpy', ROUND(v_total_value_jpy),
    'share_percent', ROUND(v_share_percent, 2),
    'all_accounts_count', v_all_accounts_count
  );
END;
$function$;

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_trade_kpis()');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.get_trade_kpis() is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '53039b01010c09f7c434c64bb7f2bca9' THEN
    RAISE EXCEPTION 'STOP — public.get_trade_kpis() has md5 % after the replace, expected 53039b01010c09f7c434c64bb7f2bca9; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.get_trade_kpis() recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- get_trade_monthly_trends
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_trade_monthly_trends(integer)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.get_trade_monthly_trends(integer) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '713440f1ec4e052b233db31898195cb0' THEN
    RAISE EXCEPTION 'STOP — public.get_trade_monthly_trends(integer) has md5 %, expected 713440f1ec4e052b233db31898195cb0; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.get_trade_monthly_trends(integer) matches live — the replace below rewrites the identical body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_trade_monthly_trends(p_months_back integer DEFAULT 12)
 RETURNS TABLE(month text, trade_count integer, trade_value_jpy numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric; v_start_date date; v_end_date date;
BEGIN
  PERFORM public.assert_staff_caller();
  SELECT (value #>> '{}')::numeric INTO v_rate FROM public.system_settings WHERE key = 'php_jpy_rate';
  v_rate := COALESCE(v_rate, 0.42);
  v_start_date := date_trunc('month', (now() AT TIME ZONE 'Asia/Manila') - ((p_months_back - 1) || ' months')::interval)::date;
  v_end_date := (now() AT TIME ZONE 'Asia/Manila')::date;
  RETURN QUERY
  WITH all_months AS (
    SELECT to_char(generate_series(v_start_date, v_end_date, '1 month'::interval), 'YYYY-MM') AS month_key
  ),
  layaway_trades AS (
    SELECT to_char(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month_key,
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN currency = 'JPY' THEN total_amount
                    WHEN currency = 'PHP' THEN total_amount / v_rate
                    ELSE total_amount END) AS val_jpy
    FROM public.layaway_accounts
    WHERE is_trade = true
      AND is_test = false
      AND (status::text != 'cancelled' OR cancelled_at IS NOT NULL)
      AND EXISTS (SELECT 1 FROM public.payments p WHERE p.account_id = layaway_accounts.id AND p.voided_at IS NULL)
      AND COALESCE(order_date, created_at::date) >= v_start_date
      AND COALESCE(order_date, created_at::date) <= v_end_date
    GROUP BY month_key
  ),
  cash_trades AS (
    SELECT to_char(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month_key,
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN currency = 'JPY' THEN total_amount
                    WHEN currency = 'PHP' THEN total_amount / v_rate
                    ELSE total_amount END) AS val_jpy
    FROM public.cash_orders
    WHERE is_trade = true
      AND is_test = false
      AND status::text != 'cancelled'
      AND EXISTS (SELECT 1 FROM public.cash_payments cp WHERE cp.cash_order_id = cash_orders.id AND cp.voided_at IS NULL)
      AND COALESCE(order_date, created_at::date) >= v_start_date
      AND COALESCE(order_date, created_at::date) <= v_end_date
    GROUP BY month_key
  )
  SELECT am.month_key AS month,
         (COALESCE(lt.cnt, 0) + COALESCE(ct.cnt, 0))::int AS trade_count,
         ROUND(COALESCE(lt.val_jpy, 0) + COALESCE(ct.val_jpy, 0))::numeric AS trade_value_jpy
  FROM all_months am
  LEFT JOIN layaway_trades lt ON lt.month_key = am.month_key
  LEFT JOIN cash_trades ct ON ct.month_key = am.month_key
  ORDER BY am.month_key;
END;
$function$;

DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_trade_monthly_trends(integer)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.get_trade_monthly_trends(integer) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '713440f1ec4e052b233db31898195cb0' THEN
    RAISE EXCEPTION 'STOP — public.get_trade_monthly_trends(integer) has md5 % after the replace, expected 713440f1ec4e052b233db31898195cb0; the recorded body does not reproduce live — rolled back.', v_md5;
  END IF;
  RAISE NOTICE 'public.get_trade_monthly_trends(integer) recorded body verified';
END
$guard$;

-- ---------------------------------------------------------------------------
-- cancel_layaway_atomic: created whole by 20261227100000, so it is already on record. Checked only.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.cancel_layaway_atomic(uuid,text,uuid,text,boolean,text)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.cancel_layaway_atomic(uuid,text,uuid,text,boolean,text) is not on live; apply 20261227100000 first. Nothing changed.';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '2cc9eaea9c5802eac1961b8cbd9ffd04' THEN
    RAISE EXCEPTION 'STOP — public.cancel_layaway_atomic(uuid,text,uuid,text,boolean,text) has md5 %, expected 2cc9eaea9c5802eac1961b8cbd9ffd04; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.cancel_layaway_atomic(uuid,text,uuid,text,boolean,text) recorded body verified';
END
$guard$;
