-- Record-only (2026-09-17). Captured from live via pg_get_functiondef — already applied;
-- replaying is a no-op.
--
-- functions that exist live and have never appeared in any migration
--
-- Captured at 2026-09-17 06:07:24.874502+00. Every body below is byte-for-byte the pg_get_functiondef output, with a
-- terminating semicolon added. The md5 and length in each per-function comment are of that
-- output, so any one of them can be re-verified against live at any time:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = '<fn>';
--
-- GRANTS ARE NOT TOUCHED. pg_get_functiondef does not emit them and none is added here; the
-- live ACL is recorded in each comment as observed (pg_proc.proacl) and nothing more.
--
-- Bucket (b) of the drift audit: live has these, the repo has never had them.
-- They cannot be REVERTED by a rebuild — there is nothing to rebuild them from — but a
-- fresh project built from supabase/migrations/ would simply not have them, so the repo's
-- claim to be a faithful rebuild was false until this file.
--
-- Four of the five store-credit RPCs are here, and four of the note_* account-trail triggers.

-- ─────────────────────────────────────────────────────────────────────────────
-- public.auto_waive_same_day_penalties()
--   md5    : eb3c07a4778669358fda7cd32f07ca0f
--   length : 2586 bytes
--   acl    : =X/postgres | postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_waive_same_day_penalties()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_date date; v_pen RECORD; v_sched numeric; v_base numeric;
        v_carried numeric; v_pen_acct numeric; v_svc numeric; v_paid numeric;
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;
  BEGIN
    v_date := (NEW.created_at AT TIME ZONE 'Asia/Tokyo')::date;

    FOR v_pen IN
      SELECT * FROM penalty_fees
      WHERE account_id = NEW.account_id AND status = 'unpaid' AND penalty_date = v_date
    LOOP
      INSERT INTO penalty_waiver_requests (
        account_id, schedule_id, penalty_fee_id, penalty_amount,
        requested_by_user_id, reason, status, approved_at, is_auto, source_submission_id)
      VALUES (v_pen.account_id, v_pen.schedule_id, v_pen.id, v_pen.penalty_amount,
        NULL, 'Auto-waived: payment submitted on the same date the penalty was applied.',
        'approved', now(), true, NEW.id);

      UPDATE penalty_fees SET status = 'waived', waived_at = now() WHERE id = v_pen.id;

      SELECT COALESCE(SUM(penalty_amount),0) INTO v_sched FROM penalty_fees
        WHERE schedule_id = v_pen.schedule_id AND status::text <> 'waived';
      SELECT base_installment_amount, COALESCE(carried_amount,0) INTO v_base, v_carried
        FROM layaway_schedule WHERE id = v_pen.schedule_id;
      UPDATE layaway_schedule
        SET penalty_amount = v_sched, total_due_amount = v_base + v_sched + v_carried
        WHERE id = v_pen.schedule_id;

      SELECT COALESCE(SUM(penalty_amount),0) INTO v_pen_acct FROM penalty_fees
        WHERE account_id = v_pen.account_id AND status::text <> 'waived';
      SELECT COALESCE(SUM(amount),0) INTO v_svc FROM account_services
        WHERE account_id = v_pen.account_id;
      SELECT COALESCE(SUM(amount_paid),0) INTO v_paid FROM payments
        WHERE account_id = v_pen.account_id AND voided_at IS NULL;
      UPDATE layaway_accounts
        SET remaining_balance = GREATEST(0, total_amount + v_pen_acct + v_svc - v_paid)
        WHERE id = v_pen.account_id;

      INSERT INTO audit_logs (entity_type, entity_id, action, new_value_json)
      VALUES ('penalty_waiver', v_pen.account_id, 'auto_waiver_approved',
        jsonb_build_object('penalty_fee_id', v_pen.id, 'schedule_id', v_pen.schedule_id,
          'penalty_amount', v_pen.penalty_amount, 'penalty_date', v_pen.penalty_date,
          'submission_id', NEW.id, 'submission_date_jst', v_date));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.cancel_cash_order_atomic(p_cash_order_id uuid, p_reason text, p_user_id uuid, p_user_email text, p_preview boolean, p_source text)
--   md5    : 1d3a1f5004e7b12127f5c6f0604bea55
--   length : 6062 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
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
BEGIN
  v_is_system := (p_source = 'shopify_webhook');
  IF NOT p_preview AND NOT v_is_system AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF NOT p_preview AND v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE='P0001';
  END IF;
  SELECT status::text, currency, customer_id, invoice_number
    INTO v_status, v_currency, v_customer_id, v_invoice
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
  v_issue_amount := GREATEST(0, v_money_received - v_partial_credit);
  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'invoice_number', v_invoice, 'status', v_status,
      'currency', v_currency, 'money_received', v_money_received,
      'loyalty_redemption_excluded', v_loyalty_synthetic,
      'partial_refund_credit_already_issued', v_partial_credit,
      'store_credit_to_issue', v_issue_amount,
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
  INSERT INTO public.account_notes (cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (p_cash_order_id,
    'Cash order cancelled: ' || v_reason ||
    CASE
      WHEN v_issue_amount > 0 THEN ' — store credit issued: ' || (CASE WHEN v_currency='PHP' THEN '₱' ELSE '¥' END) || v_issue_amount
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
    'store_credit_issued', v_credit, 'earned_points_revoked_tx', v_revoked_tx,
    'source', p_source,
    'actor', CASE WHEN v_is_system THEN 'shopify_webhook' ELSE COALESCE(p_user_email, 'unknown') END,
    'user_email', p_user_email));
  RETURN jsonb_build_object(
    'success', true, 'cash_order_id', p_cash_order_id, 'invoice_number', v_invoice,
    'prior_status', v_status, 'money_received', v_money_received,
    'loyalty_redemption_excluded', v_loyalty_synthetic,
    'partial_refund_credit_already_issued', v_partial_credit,
    'store_credit', v_credit, 'earned_points_revoked_tx', v_revoked_tx, 'source', p_source);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.consume_store_credit_for_shopify_atomic(p_customer_id uuid, p_currency account_currency, p_amount numeric, p_cash_order_id uuid, p_shopify_reference text, p_source text)
--   md5    : 96167e6f912126431cc206d344dad6bc
--   length : 3790 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.consume_store_credit_for_shopify_atomic(p_customer_id uuid, p_currency account_currency, p_amount numeric, p_cash_order_id uuid DEFAULT NULL::uuid, p_shopify_reference text DEFAULT NULL::text, p_source text DEFAULT 'shopify_webhook'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amount numeric(12,2);
  v_available numeric(12,2);
  v_to_draw numeric(12,2);
  v_remaining_to_draw numeric(12,2);
  v_credit_balance numeric(12,2);
  v_shortfall numeric(12,2);
  v_lot record;
  v_take numeric(12,2);
  v_lots_drawn jsonb := '[]'::jsonb;
  v_ref text;
BEGIN
  v_amount := round(COALESCE(p_amount, 0), 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_amount: %', p_amount USING ERRCODE='P0001';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'customer_not_found: %', p_customer_id USING ERRCODE='P0001';
  END IF;

  v_ref := COALESCE(NULLIF(btrim(p_shopify_reference), ''), 'shopify');

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_available
  FROM public.store_credit_lots
  WHERE customer_id = p_customer_id AND currency = p_currency
    AND status = 'active' AND expires_at > now();

  v_to_draw := LEAST(v_amount, v_available);
  v_shortfall := v_amount - v_to_draw;

  v_remaining_to_draw := v_to_draw;
  v_credit_balance := v_available;

  IF v_to_draw > 0 THEN
    FOR v_lot IN
      SELECT id, remaining_amount
      FROM public.store_credit_lots
      WHERE customer_id = p_customer_id AND currency = p_currency
        AND status = 'active' AND expires_at > now() AND remaining_amount > 0
      ORDER BY expires_at ASC, issued_at ASC, id ASC
      FOR UPDATE
    LOOP
      EXIT WHEN v_remaining_to_draw <= 0;
      v_take := LEAST(v_lot.remaining_amount, v_remaining_to_draw);

      UPDATE public.store_credit_lots
         SET remaining_amount = remaining_amount - v_take,
             status = CASE WHEN remaining_amount - v_take <= 0
                           THEN 'consumed'::store_credit_lot_status
                           ELSE status END
       WHERE id = v_lot.id;

      v_remaining_to_draw := v_remaining_to_draw - v_take;
      v_credit_balance := v_credit_balance - v_take;

      INSERT INTO public.store_credit_transactions
        (customer_id, lot_id, txn_type, amount, currency,
         account_id, cash_order_id, balance_after, notes, performed_by_user_id)
      VALUES
        (p_customer_id, v_lot.id, 'redeemed', v_take, p_currency,
         NULL, p_cash_order_id, v_credit_balance,
         'Spent at Shopify checkout (' || v_ref || ')', NULL);

      v_lots_drawn := v_lots_drawn || jsonb_build_object('lot_id', v_lot.id, 'amount', v_take);
    END LOOP;
  END IF;

  INSERT INTO public.audit_logs
    (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES
    ('store_credit_redemption', COALESCE(p_cash_order_id, p_customer_id),
     'shopify_consume', NULL,
     jsonb_build_object(
       'customer_id', p_customer_id,
       'currency', p_currency,
       'shopify_spent', v_amount,
       'hub_available', v_available,
       'consumed', v_to_draw,
       'shortfall', v_shortfall,
       'lots_drawn', v_lots_drawn,
       'new_credit_balance', v_credit_balance,
       'cash_order_id', p_cash_order_id,
       'shopify_reference', p_shopify_reference,
       'source', p_source,
       'actor', 'shopify_webhook'));

  RETURN jsonb_build_object(
    'success', true,
    'customer_id', p_customer_id,
    'currency', p_currency,
    'shopify_spent', v_amount,
    'hub_available', v_available,
    'consumed', v_to_draw,
    'shortfall', v_shortfall,
    'lots_drawn', v_lots_drawn,
    'new_credit_balance', v_credit_balance);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.derive_cash_order_loyalty_jpy(p_cash_order_id uuid)
--   md5    : af04ad4483bae465c0a77f2eb2eeaff1
--   length : 665 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.derive_cash_order_loyalty_jpy(p_cash_order_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_rate numeric; v_result numeric;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_rate FROM system_settings WHERE key = 'php_jpy_rate';
  UPDATE cash_orders co
  SET loyalty_jpy_amount = CASE WHEN co.currency::text = 'JPY' THEN co.total_amount
                                ELSE round(co.total_amount / v_rate) END,
      updated_at = now()
  WHERE co.id = p_cash_order_id AND co.loyalty_jpy_amount IS NULL
  RETURNING co.loyalty_jpy_amount INTO v_result;
  RETURN v_result;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.get_daily_cash_orders()
--   md5    : 257022526e1ab659943f82439c2ebd2f
--   length : 895 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres | =X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_daily_cash_orders()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.day ASC)
    FROM (
      SELECT
        TO_CHAR(co.order_date::DATE, 'YYYY-MM-DD') AS day,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN co.currency = 'PHP' THEN co.total_amount / r.rate
                 ELSE co.total_amount END) AS total_sales_value
      FROM cash_orders co
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE co.is_test = false
        AND co.status = 'completed'::cash_order_status
        AND DATE_TRUNC('month', co.order_date::DATE) = DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY co.order_date::DATE
      ORDER BY co.order_date::DATE ASC
    ) t
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.get_daily_cash_orders_last_month()
--   md5    : 9c069077054876b2f446108362ec35be
--   length : 927 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres | =X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_daily_cash_orders_last_month()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.day ASC)
    FROM (
      SELECT
        TO_CHAR(co.order_date::DATE, 'YYYY-MM-DD') AS day,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN co.currency = 'PHP' THEN co.total_amount / r.rate
                 ELSE co.total_amount END) AS total_sales_value
      FROM cash_orders co
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE co.is_test = false
        AND co.status = 'completed'::cash_order_status
        AND DATE_TRUNC('month', co.order_date::DATE) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
      GROUP BY co.order_date::DATE
      ORDER BY co.order_date::DATE ASC
    ) t
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.issue_store_credit_atomic(p_customer_id uuid, p_currency account_currency, p_amount numeric, p_source_type text, p_source_account_id uuid, p_source_cash_order_id uuid, p_user_id uuid, p_user_email text, p_notes text, p_source text, p_source_refund_id text)
--   md5    : 0ce2b779d10fdff896c25b736bf513ce
--   length : 5268 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.issue_store_credit_atomic(p_customer_id uuid, p_currency account_currency, p_amount numeric, p_source_type text, p_source_account_id uuid DEFAULT NULL::uuid, p_source_cash_order_id uuid DEFAULT NULL::uuid, p_user_id uuid DEFAULT NULL::uuid, p_user_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_source text DEFAULT 'staff'::text, p_source_refund_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_amount numeric(12,2); v_lot_id uuid; v_txn_id uuid; v_expires_at timestamptz;
  v_new_balance numeric(12,2); v_cust_exists boolean; v_dup_count integer;
  v_notes text; v_is_system boolean;
BEGIN
  v_is_system := (p_source = 'shopify_webhook');
  IF NOT v_is_system AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE = 'P0001';
  END IF;
  v_amount := round(COALESCE(p_amount, 0), 2);
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'invalid_amount: %', p_amount USING ERRCODE = 'P0001';
  END IF;
  IF p_source_type NOT IN ('cancelled_layaway','cancelled_cash','manual_admin','shopify_partial_refund') THEN
    RAISE EXCEPTION 'invalid_source_type: %', p_source_type USING ERRCODE = 'P0001';
  END IF;
  IF p_source_type = 'cancelled_layaway' AND p_source_account_id IS NULL THEN
    RAISE EXCEPTION 'source_account_id_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_type = 'cancelled_cash' AND p_source_cash_order_id IS NULL THEN
    RAISE EXCEPTION 'source_cash_order_id_required' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_type = 'shopify_partial_refund' AND (p_source_cash_order_id IS NULL OR p_source_refund_id IS NULL) THEN
    RAISE EXCEPTION 'source_cash_order_id_and_refund_id_required' USING ERRCODE = 'P0001';
  END IF;
  SELECT EXISTS(SELECT 1 FROM public.customers WHERE id = p_customer_id) INTO v_cust_exists;
  IF NOT v_cust_exists THEN
    RAISE EXCEPTION 'customer_not_found: %', p_customer_id USING ERRCODE = 'P0001';
  END IF;
  IF p_source_type = 'cancelled_layaway' THEN
    SELECT count(*) INTO v_dup_count FROM public.store_credit_lots
     WHERE source_account_id = p_source_account_id AND source_type = 'cancelled_layaway' AND status <> 'voided';
    IF v_dup_count > 0 THEN
      RAISE EXCEPTION 'store_credit_already_issued_for_account: %', p_source_account_id USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_source_type = 'cancelled_cash' THEN
    SELECT count(*) INTO v_dup_count FROM public.store_credit_lots
     WHERE source_cash_order_id = p_source_cash_order_id AND source_type = 'cancelled_cash' AND status <> 'voided';
    IF v_dup_count > 0 THEN
      RAISE EXCEPTION 'store_credit_already_issued_for_cash_order: %', p_source_cash_order_id USING ERRCODE = 'P0001';
    END IF;
  ELSIF p_source_type = 'shopify_partial_refund' THEN
    SELECT count(*) INTO v_dup_count FROM public.store_credit_lots
     WHERE source_refund_id = p_source_refund_id AND status <> 'voided';
    IF v_dup_count > 0 THEN
      RAISE EXCEPTION 'store_credit_already_issued_for_refund: %', p_source_refund_id USING ERRCODE = 'P0001';
    END IF;
  END IF;
  v_expires_at := now() + interval '1 year';
  v_notes := NULLIF(substring(coalesce(p_notes, ''), 1, 500), '');
  INSERT INTO public.store_credit_lots (
    customer_id, currency, original_amount, remaining_amount, status, source_type,
    source_account_id, source_cash_order_id, source_refund_id, rate_snapshot, notes,
    issued_by_user_id, issued_at, expires_at
  ) VALUES (
    p_customer_id, p_currency, v_amount, v_amount, 'active', p_source_type,
    p_source_account_id, p_source_cash_order_id, p_source_refund_id, NULL, v_notes,
    p_user_id, now(), v_expires_at
  ) RETURNING id INTO v_lot_id;
  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_new_balance
  FROM public.store_credit_lots
  WHERE customer_id = p_customer_id AND currency = p_currency
    AND status = 'active' AND expires_at > now();
  INSERT INTO public.store_credit_transactions (
    customer_id, lot_id, txn_type, amount, currency, account_id, cash_order_id,
    balance_after, notes, performed_by_user_id
  ) VALUES (
    p_customer_id, v_lot_id, 'issued', v_amount, p_currency, p_source_account_id,
    p_source_cash_order_id, v_new_balance, v_notes, p_user_id
  ) RETURNING id INTO v_txn_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES (
    'store_credit_lot', v_lot_id, 'issue',
    jsonb_build_object(
      'customer_id', p_customer_id, 'currency', p_currency, 'amount', v_amount,
      'source_type', p_source_type, 'source_account_id', p_source_account_id,
      'source_cash_order_id', p_source_cash_order_id,
      'source_refund_id', p_source_refund_id,
      'expires_at', v_expires_at, 'new_balance', v_new_balance, 'source', p_source,
      'actor', CASE WHEN v_is_system THEN 'shopify_webhook' ELSE COALESCE(p_user_email, 'unknown') END,
      'user_email', p_user_email
    ), p_user_id
  );
  RETURN jsonb_build_object(
    'success', true, 'lot_id', v_lot_id, 'transaction_id', v_txn_id,
    'customer_id', p_customer_id, 'amount', v_amount, 'currency', p_currency,
    'expires_at', v_expires_at, 'new_balance', v_new_balance
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.note_account_status_change()
--   md5    : a6c6a6a22452059c58f0e631d0ce56ab
--   length : 1174 bytes
--   acl    : =X/postgres | postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.note_account_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_note text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  v_note := CASE NEW.status::text
    WHEN 'forfeited'        THEN 'Account forfeited (was ' || OLD.status::text || ')'
    WHEN 'final_forfeited'  THEN 'Account FINAL FORFEITED — permanent, no reactivation (was ' || OLD.status::text || ')'
    WHEN 'extension_active' THEN 'Account reactivated to extension'
                                 || COALESCE(' — extension ends ' || NEW.extension_end_date::text, '')
    WHEN 'completed'        THEN 'Account completed — fully paid'
    WHEN 'overdue'          THEN 'Account moved to overdue (was ' || OLD.status::text || ')'
    WHEN 'active'           THEN 'Account status active (was ' || OLD.status::text || ')'
    ELSE 'Account status ' || OLD.status::text || ' → ' || NEW.status::text
  END;

  INSERT INTO public.account_notes (account_id, note_text, created_by_user_id, created_by_name)
  VALUES (NEW.id, v_note, NULL, 'System');
  RETURN NEW;
END; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.note_extension_request()
--   md5    : fe9b82123275a67489ba476f65fe9bbf
--   length : 1317 bytes
--   acl    : =X/postgres | postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.note_extension_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_note text;
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;

  IF TG_OP = 'INSERT' THEN
    v_note := 'Extension requested by customer'
              || COALESCE(' — ' || left(NEW.reason, 200), '');
    INSERT INTO public.account_notes (account_id, note_text, created_by_user_id, created_by_name)
    VALUES (NEW.account_id, v_note, NULL, 'System (Extension)');
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_note := CASE NEW.status
      WHEN 'approved' THEN 'Extension request APPROVED'
                           || COALESCE(' — expiry ' || NEW.extension_expiry_date::text, '')
      WHEN 'rejected' THEN 'Extension request rejected'
      ELSE 'Extension request ' || COALESCE(OLD.status,'?') || ' → ' || COALESCE(NEW.status,'?')
    END;
    IF NEW.reviewer_notes IS NOT NULL AND NEW.reviewer_notes <> '' THEN
      v_note := v_note || ' — ' || left(NEW.reviewer_notes, 150);
    END IF;
    INSERT INTO public.account_notes (account_id, note_text, created_by_user_id, created_by_name)
    VALUES (NEW.account_id, v_note, NEW.reviewed_by, 'System (Extension)');
  END IF;
  RETURN NEW;
END; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.note_loyalty_transaction()
--   md5    : 2dc3585289f475f4af5bcf987687238e
--   length : 1841 bytes
--   acl    : =X/postgres | postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.note_loyalty_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_note text;
BEGIN
  IF NEW.transaction_type IN ('earned','redeemed') THEN RETURN NEW; END IF;
  IF NEW.account_id IS NULL AND NEW.cash_order_id IS NULL THEN RETURN NEW; END IF;

  v_note := CASE NEW.transaction_type
    WHEN 'revoked'        THEN 'Loyalty: ' || abs(NEW.points_amount)::text || ' pts revoked'
                               || COALESCE(', ' || NEW.spend_amount_jpy::text || ' JPY spend deducted', '')
    WHEN 'restored'       THEN 'Loyalty: ' || NEW.points_amount::text || ' pts restored'
                               || COALESCE(', ' || NEW.spend_amount_jpy::text || ' JPY spend restored', '')
    WHEN 'expired'        THEN 'Loyalty: ' || abs(NEW.points_amount)::text || ' pts expired'
    WHEN 'adjusted'       THEN 'Loyalty: manual adjustment ' || NEW.points_amount::text || ' pts'
                               || COALESCE(', ' || NEW.spend_amount_jpy::text || ' JPY spend', '')
    WHEN 'refunded'       THEN 'Loyalty: ' || NEW.points_amount::text || ' pts refunded'
    WHEN 'birthday_bonus' THEN 'Loyalty: birthday bonus ' || NEW.points_amount::text || ' pts'
    WHEN 'tier_changed'   THEN 'Loyalty: tier changed'
    WHEN 'enrolled'       THEN 'Loyalty: enrolled in Cha Jewels Circle'
    ELSE 'Loyalty: ' || NEW.transaction_type::text || ' ' || NEW.points_amount::text || ' pts'
  END;

  IF NEW.notes IS NOT NULL AND NEW.notes <> '' THEN
    v_note := v_note || ' — ' || left(NEW.notes, 200);
  END IF;

  INSERT INTO public.account_notes (account_id, cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (NEW.account_id, NEW.cash_order_id, v_note, NEW.created_by_user_id, 'System (Loyalty)');
  RETURN NEW;
END; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.note_penalty_waiver()
--   md5    : 84f6696b4b80ccd3d384ae351eff43e6
--   length : 1476 bytes
--   acl    : =X/postgres | postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.note_penalty_waiver()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_note text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_note := 'Penalty waiver requested — ' || NEW.penalty_amount::text
              || COALESCE(' (' || left(NEW.reason, 150) || ')', '')
              || CASE WHEN NEW.is_auto THEN ' [auto]' ELSE '' END;
    INSERT INTO public.account_notes (account_id, note_text, created_by_user_id, created_by_name)
    VALUES (NEW.account_id, v_note, NEW.requested_by_user_id, 'System (Penalty)');
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_note := CASE NEW.status::text
      WHEN 'approved' THEN 'Penalty waiver APPROVED — ' || NEW.penalty_amount::text
      WHEN 'rejected' THEN 'Penalty waiver rejected — ' || NEW.penalty_amount::text
      ELSE 'Penalty waiver ' || OLD.status::text || ' → ' || NEW.status::text
    END;
    INSERT INTO public.account_notes (account_id, note_text, created_by_user_id, created_by_name)
    VALUES (NEW.account_id, v_note, NEW.approved_by_user_id, 'System (Penalty)');
  ELSIF NEW.auto_unwaived_at IS NOT NULL AND OLD.auto_unwaived_at IS NULL THEN
    INSERT INTO public.account_notes (account_id, note_text, created_by_user_id, created_by_name)
    VALUES (NEW.account_id, 'Penalty waiver auto-unwaived — ' || NEW.penalty_amount::text, NULL, 'System (Penalty)');
  END IF;
  RETURN NEW;
END; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.redeem_store_credit_atomic(p_customer_id uuid, p_account_id uuid, p_cash_order_id uuid, p_amount numeric, p_user_id uuid, p_user_email text, p_preview boolean)
--   md5    : 8e551b917c2df83d0ba777cf0b12823d
--   length : 9241 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.redeem_store_credit_atomic(p_customer_id uuid DEFAULT NULL::uuid, p_account_id uuid DEFAULT NULL::uuid, p_cash_order_id uuid DEFAULT NULL::uuid, p_amount numeric DEFAULT NULL::numeric, p_user_id uuid DEFAULT NULL::uuid, p_user_email text DEFAULT NULL::text, p_preview boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_layaway boolean;
  v_order_currency account_currency;
  v_order_total numeric(12,2);
  v_order_paid numeric(12,2);
  v_order_remaining numeric(12,2);
  v_order_status text;
  v_order_customer uuid;
  v_invoice text;
  v_dp_required numeric(12,2);
  v_dp_prior numeric(12,2);
  v_is_dp boolean := false;
  v_available numeric(12,2);
  v_requested numeric(12,2);
  v_apply numeric(12,2);
  v_ref text;
  v_app_id uuid := gen_random_uuid();
  v_payment_id uuid;
  v_alloc jsonb;
  v_remaining_to_draw numeric(12,2);
  v_lot record;
  v_take numeric(12,2);
  v_new_paid numeric(12,2);
  v_new_remaining numeric(12,2);
  v_new_status text;
  v_credit_balance numeric(12,2);
  v_lots_drawn jsonb := '[]'::jsonb;
  v_note text;
BEGIN
  IF NOT p_preview AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
  END IF;

  IF (p_account_id IS NULL) = (p_cash_order_id IS NULL) THEN
    RAISE EXCEPTION 'exactly_one_order_ref_required' USING ERRCODE='P0001';
  END IF;
  v_is_layaway := p_account_id IS NOT NULL;

  IF v_is_layaway THEN
    SELECT currency, total_amount, total_paid, remaining_balance, status::text, customer_id,
           COALESCE(downpayment_amount, 0), invoice_number
      INTO v_order_currency, v_order_total, v_order_paid, v_order_remaining, v_order_status,
           v_order_customer, v_dp_required, v_invoice
    FROM public.layaway_accounts WHERE id = p_account_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found: %', p_account_id USING ERRCODE='P0001'; END IF;
    IF v_order_status IN ('completed','cancelled','forfeited') THEN
      RAISE EXCEPTION 'order_not_open: account status is %', v_order_status USING ERRCODE='P0001';
    END IF;

    SELECT COALESCE(SUM(amount_paid), 0) INTO v_dp_prior
    FROM public.payments
    WHERE account_id = p_account_id
      AND voided_at IS NULL
      AND (reference_number LIKE 'DP-%' OR remarks ILIKE '%down%');
    v_is_dp := (v_dp_required > 0 AND v_dp_prior < v_dp_required);
  ELSE
    SELECT currency, total_amount, total_paid, remaining_balance, status::text, customer_id, invoice_number
      INTO v_order_currency, v_order_total, v_order_paid, v_order_remaining, v_order_status,
           v_order_customer, v_invoice
    FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'cash_order_not_found: %', p_cash_order_id USING ERRCODE='P0001'; END IF;
    IF v_order_status <> 'pending' THEN
      RAISE EXCEPTION 'order_not_open: cash order status is %', v_order_status USING ERRCODE='P0001';
    END IF;
  END IF;

  IF p_customer_id IS NOT NULL AND p_customer_id <> v_order_customer THEN
    RAISE EXCEPTION 'customer_mismatch' USING ERRCODE='P0001';
  END IF;

  SELECT COALESCE(SUM(remaining_amount),0) INTO v_available
  FROM public.store_credit_lots
  WHERE customer_id = v_order_customer AND currency = v_order_currency
    AND status = 'active' AND expires_at > now();

  v_requested := CASE WHEN p_amount IS NULL THEN COALESCE(v_order_remaining,0) ELSE round(p_amount,2) END;
  IF v_requested <= 0 THEN RAISE EXCEPTION 'invalid_amount: %', p_amount USING ERRCODE='P0001'; END IF;

  v_apply := LEAST(v_requested, v_available, COALESCE(v_order_remaining,0));
  IF v_apply <= 0 THEN
    RAISE EXCEPTION 'no_applicable_store_credit (available=%, order_remaining=%)', v_available, v_order_remaining USING ERRCODE='P0001';
  END IF;

  IF p_preview THEN
    RETURN jsonb_build_object('preview', true, 'currency', v_order_currency,
      'customer_id', v_order_customer, 'invoice_number', v_invoice,
      'available', v_available, 'order_remaining', v_order_remaining,
      'applicable', v_apply, 'is_downpayment', v_is_dp);
  END IF;

  v_ref := 'SC-' || v_app_id::text;

  IF v_is_layaway THEN
    v_alloc := public.allocate_payment_atomic(
      p_account_id        => p_account_id,
      p_amount_paid       => v_apply,
      p_payment_date      => CURRENT_DATE,
      p_payment_method    => 'store_credit',
      p_reference_number  => v_ref,
      p_remarks           => 'Store credit applied',
      p_user_id           => p_user_id,
      p_currency          => v_order_currency::text,
      p_is_downpayment    => v_is_dp,
      p_submitted_by_type => 'staff',
      p_submitted_by_name => COALESCE(p_user_email, 'Admin'),
      p_preview           => false
    );
    v_payment_id    := (v_alloc->>'payment_id')::uuid;
    v_new_paid      := (v_alloc->>'new_total_paid')::numeric;
    v_new_remaining := (v_alloc->>'new_remaining_balance')::numeric;
    v_new_status    := v_alloc->>'new_status';
  ELSE
    INSERT INTO public.cash_payments
      (cash_order_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks,
       entered_by_user_id, submitted_by_type, submitted_by_name)
    VALUES
      (p_cash_order_id, v_apply, v_order_currency, CURRENT_DATE, 'store_credit', v_ref,
       'Store credit applied', p_user_id, 'staff', COALESCE(p_user_email,'Admin'))
    RETURNING id INTO v_payment_id;

    SELECT COALESCE(SUM(amount_paid),0) INTO v_new_paid
      FROM public.cash_payments WHERE cash_order_id = p_cash_order_id AND voided_at IS NULL;
    v_new_remaining := COALESCE(v_order_total,0) - v_new_paid;
    UPDATE public.cash_orders
       SET total_paid = v_new_paid, remaining_balance = v_new_remaining, updated_at = now(),
           status = CASE WHEN v_new_remaining <= 0 THEN 'completed' ELSE status END,
           completed_at = CASE WHEN v_new_remaining <= 0 THEN now() ELSE completed_at END
     WHERE id = p_cash_order_id
    RETURNING status::text INTO v_new_status;
  END IF;

  v_remaining_to_draw := v_apply;
  v_credit_balance := v_available;
  FOR v_lot IN
    SELECT id, remaining_amount FROM public.store_credit_lots
    WHERE customer_id = v_order_customer AND currency = v_order_currency
      AND status = 'active' AND expires_at > now() AND remaining_amount > 0
    ORDER BY expires_at ASC, issued_at ASC, id ASC
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_to_draw <= 0;
    v_take := LEAST(v_lot.remaining_amount, v_remaining_to_draw);
    UPDATE public.store_credit_lots
       SET remaining_amount = remaining_amount - v_take,
           status = CASE WHEN remaining_amount - v_take <= 0 THEN 'consumed'::store_credit_lot_status ELSE status END
     WHERE id = v_lot.id;
    v_remaining_to_draw := v_remaining_to_draw - v_take;
    v_credit_balance := v_credit_balance - v_take;
    INSERT INTO public.store_credit_transactions
      (customer_id, lot_id, txn_type, amount, currency, account_id, cash_order_id, balance_after, notes, performed_by_user_id)
    VALUES
      (v_order_customer, v_lot.id, 'redeemed', v_take, v_order_currency, p_account_id, p_cash_order_id,
       v_credit_balance, v_ref, p_user_id);
    v_lots_drawn := v_lots_drawn || jsonb_build_object('lot_id', v_lot.id, 'amount', v_take);
  END LOOP;

  IF v_remaining_to_draw > 0.01 THEN
    RAISE EXCEPTION 'lot_drawdown_shortfall: %', v_remaining_to_draw USING ERRCODE='P0001';
  END IF;

  v_note := 'Store credit applied: ' || (CASE WHEN v_order_currency='PHP' THEN '₱' ELSE '¥' END)
            || v_apply || CASE WHEN v_is_dp THEN ' (downpayment)' ELSE '' END || ' (' || v_ref || ')';
  INSERT INTO public.account_notes (account_id, cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (p_account_id, p_cash_order_id, v_note, p_user_id, 'System (Store Credit)');

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('store_credit_redemption', COALESCE(p_account_id, p_cash_order_id), 'redeem', p_user_id,
    jsonb_build_object('customer_id', v_order_customer, 'currency', v_order_currency,
      'invoice_number', v_invoice,
      'amount_applied', v_apply, 'is_downpayment', v_is_dp,
      'order_type', CASE WHEN v_is_layaway THEN 'layaway' ELSE 'cash' END,
      'account_id', p_account_id, 'cash_order_id', p_cash_order_id, 'payment_ref', v_ref,
      'lots_drawn', v_lots_drawn, 'new_order_total_paid', v_new_paid,
      'new_order_remaining', v_new_remaining, 'new_order_status', v_new_status,
      'new_credit_balance', v_credit_balance, 'user_email', p_user_email));

  RETURN jsonb_build_object('success', true, 'amount_applied', v_apply, 'currency', v_order_currency,
    'customer_id', v_order_customer,
    'invoice_number', v_invoice,
    'order_type', CASE WHEN v_is_layaway THEN 'layaway' ELSE 'cash' END,
    'is_downpayment', v_is_dp, 'payment_id', v_payment_id, 'payment_ref', v_ref,
    'lots_drawn', v_lots_drawn, 'new_order_total_paid', v_new_paid,
    'new_order_remaining', v_new_remaining, 'new_order_status', v_new_status,
    'new_credit_balance', v_credit_balance,
    'allocations', CASE WHEN v_is_layaway THEN v_alloc->'allocations' ELSE NULL END);
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.rename_invoice_number_atomic(p_account_id uuid, p_new_invoice_number text, p_performed_by_user_id uuid)
--   md5    : aef844b67fe77329ab1cf2daa3c51cf5
--   length : 3129 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres | authenticated=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rename_invoice_number_atomic(p_account_id uuid, p_new_invoice_number text, p_performed_by_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE v_old text; v_new text; v_caller_uuid uuid; v_audit_user_id uuid;
BEGIN
  v_caller_uuid := auth.uid();
  IF v_caller_uuid IS NOT NULL
     AND NOT public.has_role(v_caller_uuid, 'admin')
     AND NOT public.has_role(v_caller_uuid, 'staff') THEN
    RAISE EXCEPTION 'admin or staff role required for rename_invoice_number_atomic' USING ERRCODE = '42501';
  END IF;
  v_audit_user_id := COALESCE(p_performed_by_user_id, v_caller_uuid);
  IF v_audit_user_id IS NULL THEN
    RAISE EXCEPTION 'caller identity required (auth.uid() or p_performed_by_user_id)';
  END IF;
  v_new := btrim(p_new_invoice_number);
  IF v_new IS NULL OR v_new = '' THEN RETURN jsonb_build_object('error', 'New invoice number required'); END IF;
  SELECT invoice_number INTO v_old FROM public.layaway_accounts WHERE id = p_account_id;
  IF v_old IS NULL THEN RETURN jsonb_build_object('error', 'Account not found'); END IF;
  IF v_old = v_new THEN RETURN jsonb_build_object('success', true, 'unchanged', true); END IF;
  IF EXISTS (SELECT 1 FROM public.layaway_accounts WHERE invoice_number = v_new)
     OR EXISTS (SELECT 1 FROM public.cash_orders WHERE invoice_number = v_new) THEN
    RETURN jsonb_build_object('error', 'Invoice number ' || v_new || ' already exists');
  END IF;
  UPDATE public.layaway_accounts SET invoice_number = v_new WHERE id = p_account_id;
  UPDATE public.staff_notifications SET invoice_number = v_new WHERE invoice_number = v_old;
  UPDATE public.csr_notifications SET invoice_number = v_new WHERE invoice_number = v_old;
  UPDATE public.reconciliation_log SET invoice_number = v_new WHERE invoice_number = v_old;
  UPDATE public.service_jobs SET invoice_number = v_new WHERE invoice_number = v_old;
  UPDATE public.trade_ins SET old_invoice_number = v_new WHERE old_invoice_number = v_old;
  UPDATE public.trade_ins SET new_invoice_number = v_new WHERE new_invoice_number = v_old;
  UPDATE public.sales_log SET invoice_number = v_new WHERE invoice_number = v_old;
  UPDATE public.loyalty_transactions SET invoice_number = v_new WHERE invoice_number = v_old;
  UPDATE public.loyalty_redemptions SET invoice_number = v_new WHERE invoice_number = v_old;
  UPDATE public.loyalty_point_lots SET source_reference = v_new WHERE source_reference = v_old;
  UPDATE public.payment_submission_allocations SET invoice_number = v_new WHERE invoice_number = v_old;
  UPDATE public.promo_views SET invoice_number = v_new WHERE invoice_number = v_old;
  INSERT INTO public.audit_logs ( entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id )
  VALUES ( 'layaway_account', p_account_id, 'update_invoice_number',
    jsonb_build_object('invoice_number', v_old), jsonb_build_object('invoice_number', v_new), v_audit_user_id );
  RETURN jsonb_build_object('success', true, 'old_invoice_number', v_old, 'new_invoice_number', v_new);
END; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.revert_auto_waive_on_rejection()
--   md5    : 82158e2475b692356e5b72c592b7dc0b
--   length : 2203 bytes
--   acl    : =X/postgres | postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.revert_auto_waive_on_rejection()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_w RECORD; v_sched numeric; v_base numeric; v_carried numeric;
        v_pen_acct numeric; v_svc numeric; v_paid numeric;
BEGIN
  IF NEW.status::text <> 'rejected' OR OLD.status::text = 'rejected' THEN RETURN NEW; END IF;
  BEGIN
    FOR v_w IN
      SELECT * FROM penalty_waiver_requests
      WHERE source_submission_id = NEW.id AND is_auto = true AND status = 'approved'
    LOOP
      UPDATE penalty_fees SET status = 'unpaid', waived_at = NULL WHERE id = v_w.penalty_fee_id;
      UPDATE penalty_waiver_requests
        SET status = 'rejected', rejected_at = now(), approved_at = NULL WHERE id = v_w.id;

      SELECT COALESCE(SUM(penalty_amount),0) INTO v_sched FROM penalty_fees
        WHERE schedule_id = v_w.schedule_id AND status::text <> 'waived';
      SELECT base_installment_amount, COALESCE(carried_amount,0) INTO v_base, v_carried
        FROM layaway_schedule WHERE id = v_w.schedule_id;
      UPDATE layaway_schedule
        SET penalty_amount = v_sched, total_due_amount = v_base + v_sched + v_carried
        WHERE id = v_w.schedule_id;

      SELECT COALESCE(SUM(penalty_amount),0) INTO v_pen_acct FROM penalty_fees
        WHERE account_id = v_w.account_id AND status::text <> 'waived';
      SELECT COALESCE(SUM(amount),0) INTO v_svc FROM account_services
        WHERE account_id = v_w.account_id;
      SELECT COALESCE(SUM(amount_paid),0) INTO v_paid FROM payments
        WHERE account_id = v_w.account_id AND voided_at IS NULL;
      UPDATE layaway_accounts
        SET remaining_balance = GREATEST(0, total_amount + v_pen_acct + v_svc - v_paid)
        WHERE id = v_w.account_id;

      INSERT INTO audit_logs (entity_type, entity_id, action, new_value_json)
      VALUES ('penalty_waiver', v_w.account_id, 'auto_waiver_reverted',
        jsonb_build_object('penalty_fee_id', v_w.penalty_fee_id, 'waiver_id', v_w.id,
          'submission_id', NEW.id, 'note', 'Payment submission rejected — auto-waive reversed.'));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- public.void_store_credit_lot_atomic(p_lot_id uuid, p_reason text, p_user_id uuid, p_user_email text)
--   md5    : 7f359197c31b8056208a7e349c526aea
--   length : 2834 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.void_store_credit_lot_atomic(p_lot_id uuid, p_reason text, p_user_id uuid DEFAULT NULL::uuid, p_user_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_customer_id uuid;
  v_currency account_currency;
  v_status store_credit_lot_status;
  v_remaining numeric(12,2);
  v_original numeric(12,2);
  v_new_balance numeric(12,2);
  v_reason text;
  v_txn_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'void_reason_required' USING ERRCODE='P0001';
  END IF;

  SELECT customer_id, currency, status, remaining_amount, original_amount
    INTO v_customer_id, v_currency, v_status, v_remaining, v_original
  FROM public.store_credit_lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot_not_found: %', p_lot_id USING ERRCODE='P0001';
  END IF;

  IF v_status = 'voided' THEN
    RAISE EXCEPTION 'lot_already_voided' USING ERRCODE='P0001';
  END IF;

  -- Only the UNSPENT remainder can be voided. Any consumed portion is already a
  -- real payment on a real order and must be reversed there, not here.
  IF COALESCE(v_remaining, 0) <= 0 THEN
    RAISE EXCEPTION 'nothing_to_void: lot is fully consumed or expired (remaining=%)', v_remaining
      USING ERRCODE='P0001';
  END IF;

  UPDATE public.store_credit_lots
     SET status = 'voided', remaining_amount = 0, updated_at = now()
   WHERE id = p_lot_id;

  SELECT COALESCE(SUM(remaining_amount), 0) INTO v_new_balance
  FROM public.store_credit_lots
  WHERE customer_id = v_customer_id AND currency = v_currency
    AND status = 'active' AND expires_at > now();

  INSERT INTO public.store_credit_transactions
    (customer_id, lot_id, txn_type, amount, currency, balance_after, notes, performed_by_user_id)
  VALUES
    (v_customer_id, p_lot_id, 'voided', v_remaining, v_currency, v_new_balance,
     'Voided: ' || v_reason, p_user_id)
  RETURNING id INTO v_txn_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('store_credit_lot', p_lot_id, 'void', p_user_id,
    jsonb_build_object('customer_id', v_customer_id, 'currency', v_currency,
      'reason', v_reason, 'original_amount', v_original,
      'voided_amount', v_remaining, 'prior_status', v_status,
      'new_balance', v_new_balance, 'user_email', p_user_email));

  RETURN jsonb_build_object('success', true, 'lot_id', p_lot_id,
    'customer_id', v_customer_id, 'currency', v_currency,
    'voided_amount', v_remaining, 'original_amount', v_original,
    'transaction_id', v_txn_id, 'new_balance', v_new_balance);
END;
$function$;

