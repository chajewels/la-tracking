-- Record-only (2026-10-08). Already applied on live — replaying is a no-op.
--
-- Why: 20261118100000_square_qa_refunds_credit changed these six functions with
-- md5-guarded IN-PLACE patches (pg_temp.cj_patch, Bug #280). The drift audit
-- reads only CREATE FUNCTION statements, so the repo's newest copy of each was
-- the PRE-patch body. This file records the bodies exactly as live runs them
-- after the Lovable apply of 2026-10-08 02:45Z (md5(prosrc) read from live,
-- equal to the bodies below):
--
--   cancel_cash_order_atomic(p_cash_order_id uuid, p_reason text  90909be1bd683a539cc031d80fb3719a
--   mark_web_order_refund_issued_atomic(p_order_id uuid, p_user_  e2bb8dcee5a233ec59a2e3bc97605a2c
--   reassign_order_owner_atomic(p_kind text, p_order_id uuid, p_  182f05b5089592ca0340f54320f70edd
--   ring_square_deadline_bells(p_now timestamp with time zone)    43472c8c97c8990a8242fa6bf2a771b6
--   square_ops_health()                                           b97d8444f1cc835f7cfc24488bd25dbf
--   terminate_web_order_atomic(p_order_id uuid, p_outcome text,   b54a9c3c538736073984df6a8880b865
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

-- ---------------------------------------------------------------------------
-- cancel_cash_order_atomic
-- ---------------------------------------------------------------------------
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
  v_order_date date; v_shopify_id text; v_split jsonb;
BEGIN
  v_is_system := (p_source = 'shopify_webhook');
  IF NOT p_preview AND NOT v_is_system AND p_user_id IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE='P0001';
  END IF;
  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF NOT p_preview AND v_reason IS NULL THEN
    RAISE EXCEPTION 'cancellation_reason_required' USING ERRCODE='P0001';
  END IF;
  SELECT status::text, currency, customer_id, invoice_number, order_date, shopify_order_id
    INTO v_status, v_currency, v_customer_id, v_invoice, v_order_date, v_shopify_id
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
  -- Cancellation credit rule (owner 2026-10-06/08): a Hub cash order
  -- cancelled on its order_date → 100 % credit; later → 30 % of the
  -- money paid is kept, 70 % credit. Shopify orders keep 100 % (owner E3).
  IF v_is_system OR v_shopify_id IS NOT NULL THEN
    v_split := jsonb_build_object('rule', 'shopify_full', 'charge_pct', 0, 'money', v_money_received,
                                  'kept', 0, 'credit', v_money_received, 'order_date', v_order_date);
  ELSE
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, now());
  END IF;
  v_issue_amount := GREATEST(0, (v_split ->> 'credit')::numeric - v_partial_credit);
  IF p_preview THEN
    RETURN jsonb_build_object(
      'preview', true, 'invoice_number', v_invoice, 'status', v_status,
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
$function$

;

-- ---------------------------------------------------------------------------
-- mark_web_order_refund_issued_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_web_order_refund_issued_atomic(p_order_id uuid, p_user_id uuid, p_method text, p_refunded_on date, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_amount  numeric(12,2);
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_method  text := lower(btrim(COALESCE(p_method, '')));
  v_prev    jsonb;
  v_card_paid boolean;
  v_noncard numeric(12,2);
  v_card_refunded numeric(12,2);
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_order.source_channel IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_web_order');
  END IF;
  IF v_order.status::text <> 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelled', 'status', v_order.status::text);
  END IF;
  -- B01 (2026-10-08): the same request again after it succeeded (a retry
  -- after a lost answer) gets the same answer and writes nothing.
  IF v_order.refund_status = 'refund_issued' THEN
    SELECT a.new_value_json INTO v_prev FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued'
     ORDER BY a.created_at DESC LIMIT 1;
    IF v_prev IS NOT NULL AND v_prev ->> 'method' = v_method THEN
      RETURN jsonb_build_object('ok', true, 'already_recorded', true,
                                'amount', (v_prev ->> 'amount')::numeric, 'currency', v_prev ->> 'currency',
                                'method', v_method, 'refunded_on', v_prev ->> 'refunded_on',
                                'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
    END IF;
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
  IF v_method NOT IN ('bank_transfer', 'paidy', 'card', 'cash', 'other') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_method');
  END IF;
  IF p_refunded_on IS NULL OR p_refunded_on > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
  END IF;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_amount
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';

  -- B01 (2026-10-08): card money goes back only through Square. A card-paid
  -- order is marked with method 'card', only once Square shows a COMPLETED
  -- refund, and the amount recorded is what Square completed (owner E7) —
  -- never the gross received. Other methods only for money that did not come
  -- by card.
  v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                          WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_noncard
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(payment_method, '') <> 'square'
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  IF v_method = 'card' AND NOT v_card_paid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
  END IF;
  IF v_method <> 'card' AND v_card_paid AND v_noncard <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_card');
  END IF;
  -- Mixed payment (card + something else): a non-card method records only the
  -- non-card money; the card part comes back through Square and is recorded by
  -- Square's own refund email / the card row. Never the gross.
  IF v_method <> 'card' AND v_card_paid THEN
    v_amount := v_noncard;
  END IF;
  IF v_method = 'card' THEN
    SELECT COALESCE(SUM(amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds WHERE cash_order_id = p_order_id AND status = 'COMPLETED';
    IF v_card_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := LEAST(v_amount, v_card_refunded);
  END IF;

  UPDATE public.cash_orders
     SET refund_status = 'refund_issued',
         refund_note = CASE
           WHEN v_note IS NULL THEN refund_note
           WHEN refund_note IS NULL OR btrim(refund_note) = '' THEN v_note
           ELSE refund_note || E'\n' || v_note END
   WHERE id = p_order_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'refund_marked_issued',
          jsonb_build_object('refund_status', 'refund_pending'),
          jsonb_build_object('refund_status', 'refund_issued', 'method', v_method, 'refunded_on', p_refunded_on,
                             'amount', v_amount, 'currency', v_order.currency::text, 'note', v_note,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'currency', v_order.currency::text,
                            'method', v_method, 'refunded_on', p_refunded_on,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
END
$function$

;

-- ---------------------------------------------------------------------------
-- reassign_order_owner_atomic
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reassign_order_owner_atomic(p_kind text, p_order_id uuid, p_new_customer_id uuid, p_loyalty_jpy_amount numeric, p_reason text, p_user_id uuid, p_apply boolean, p_allow_unmatched boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  -- order
  v_invoice        text;
  v_old_cust       uuid;
  v_status         text;
  v_order_date     date;
  v_loyalty_stored numeric;
  v_quote_id       uuid;
  v_completed_at   timestamptz;
  v_total          numeric;
  v_source_channel text;
  v_shopify_id     text;
  v_ship_addr      uuid;
  v_ship_snap      jsonb;
  -- customers / members
  v_old            public.customers%ROWTYPE;
  v_new            public.customers%ROWTYPE;
  v_old_m          public.loyalty_members%ROWTYPE;
  v_new_m          public.loyalty_members%ROWTYPE;
  v_old_has        boolean := false;
  v_new_has        boolean := false;
  v_old_tier       text;
  v_new_tier       text;
  -- decisions
  v_refusals       jsonb := '[]'::jsonb;
  v_markers        text[] := ARRAY[]::text[];
  v_split          text;
  v_split_n        integer := 0;
  v_loyalty_eff    numeric;
  v_loyalty_change boolean := false;
  v_award_at       timestamptz;
  v_award_source   text;
  v_grace_days     integer := 3;
  v_catch_up       boolean := false;
  v_catch_reason   text;
  v_expired        boolean := false;
  v_lot_expires_on date;
  v_expected_pts   integer := 0;
  v_mult           numeric;
  v_cur_min        numeric;
  v_new_cum        numeric;
  v_new_tier_min   numeric;
  v_new_tier_mult  numeric;
  v_requalified    boolean := true;
  v_requalify_tgt  numeric;
  v_upgraded       boolean := false;
  v_loyalty_on     boolean := false;
  v_flag           text;
  -- identity match (R11)
  v_matched_on     text[] := ARRAY[]::text[];
  v_unmatched      boolean := false;
  v_override_ok    boolean := false;
  v_override_used  boolean := false;
  -- counts
  n_submissions    integer := 0;
  n_extensions     integer := 0;
  n_service_jobs   integer := 0;
  n_service_reqs   integer := 0;
  n_quotes         integer := 0;
  n_csr            integer := 0;
  n_address        integer := 0;
  v_counts         jsonb;
  v_result         jsonb;
  v_account_type   text;
BEGIN
  -- ---- input ---------------------------------------------------------------
  IF p_kind IS NULL OR p_kind NOT IN ('layaway', 'cash') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_kind',
      'message', 'kind must be layaway or cash.');
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required',
      'message', 'A written reason is required to reassign an order.');
  END IF;
  -- Service-role-only function, so the edge function's permission gate is the
  -- real one; this repeats it so a direct caller cannot skip it.
  IF p_user_id IS NULL OR NOT public.has_permission(p_user_id, 'reassign_owner') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden',
      'message', 'You do not have the Reassign Owner permission.');
  END IF;

  -- ---- the order, locked ---------------------------------------------------
  IF p_kind = 'layaway' THEN
    SELECT la.invoice_number, la.customer_id, la.status::text, la.order_date,
           la.loyalty_jpy_amount, la.quote_id, la.completed_at, la.total_amount,
           la.source_channel, NULL::text, NULL::uuid, NULL::jsonb
      INTO v_invoice, v_old_cust, v_status, v_order_date,
           v_loyalty_stored, v_quote_id, v_completed_at, v_total,
           v_source_channel, v_shopify_id, v_ship_addr, v_ship_snap
      FROM public.layaway_accounts la
     WHERE la.id = p_order_id
     FOR UPDATE;
  ELSE
    SELECT co.invoice_number, co.customer_id, co.status::text, co.order_date,
           co.loyalty_jpy_amount, co.quote_id, co.completed_at, co.total_amount,
           co.source_channel, co.shopify_order_id::text, co.ship_to_address_id, co.ship_to_snapshot
      INTO v_invoice, v_old_cust, v_status, v_order_date,
           v_loyalty_stored, v_quote_id, v_completed_at, v_total,
           v_source_channel, v_shopify_id, v_ship_addr, v_ship_snap
      FROM public.cash_orders co
     WHERE co.id = p_order_id
     FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'Order not found.');
  END IF;

  SELECT * INTO v_new FROM public.customers WHERE id = p_new_customer_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'The customer to move this order to was not found.');
  END IF;
  SELECT * INTO v_old FROM public.customers WHERE id = v_old_cust;

  IF v_old_cust = p_new_customer_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'same_owner',
      'message', 'This order already belongs to ' || v_new.full_name || '.');
  END IF;

  -- ---- loyalty accounts of both sides (R1) ---------------------------------
  SELECT * INTO v_old_m FROM public.loyalty_members WHERE customer_id = v_old_cust;
  IF FOUND THEN
    v_old_has := COALESCE(v_old_m.total_points_earned, 0) > 0
              OR COALESCE(v_old_m.cumulative_spend_jpy, 0) > 0
              OR COALESCE(v_old_m.spend_baseline_jpy, 0) > 0;
    SELECT name INTO v_old_tier FROM public.loyalty_tiers WHERE id = v_old_m.current_tier_id;
  END IF;
  SELECT * INTO v_new_m FROM public.loyalty_members WHERE customer_id = p_new_customer_id;
  IF FOUND THEN
    v_new_has := COALESCE(v_new_m.total_points_earned, 0) > 0
              OR COALESCE(v_new_m.cumulative_spend_jpy, 0) > 0
              OR COALESCE(v_new_m.spend_baseline_jpy, 0) > 0;
    SELECT name, min_spend_jpy, points_multiplier
      INTO v_new_tier, v_cur_min, v_mult
      FROM public.loyalty_tiers WHERE id = v_new_m.current_tier_id;
  END IF;

  -- ---- refusals, in check order --------------------------------------------
  IF (p_kind = 'layaway' AND v_status IN ('cancelled', 'forfeited', 'final_forfeited'))
     OR (p_kind = 'cash' AND v_status IN ('cancelled', 'expired')) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'status_closed',
      'message', 'This order is ' || replace(v_status, '_', ' ') || '. A closed order cannot change owner.');
  END IF;

  IF COALESCE(v_old.is_test, false) <> COALESCE(v_new.is_test, false) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'test_boundary',
      'message', 'One of these customers is a test customer and the other is not. An order cannot move between test and real customers.');
  END IF;

  -- R1 — FIRST loyalty check. The order never leaves a points account.
  IF v_old_has AND v_new_has THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'both_have_points',
      'message', 'Both accounts have loyalty history — contact the owner.');
  ELSIF v_old_has THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'points_account_is_current_owner',
      'message', 'This order stays with ' || v_old.full_name || ': ' || v_old.full_name || '''s account has loyalty history.');
  END IF;

  -- R5 — already earned by ANY member. Every marker counts, including an
  -- in-flight award (a claim whose transaction_id is still NULL).
  IF EXISTS (SELECT 1 FROM public.loyalty_award_claims c
              WHERE c.source_kind = p_kind AND c.source_id = p_order_id AND c.transaction_id IS NULL) THEN
    v_markers := array_append(v_markers, 'an award in progress');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_award_claims c
              WHERE c.source_kind = p_kind AND c.source_id = p_order_id AND c.transaction_id IS NOT NULL) THEN
    v_markers := array_append(v_markers, 'an award claim');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
              WHERE t.transaction_type = 'earned'
                AND ((p_kind = 'layaway' AND t.account_id = p_order_id)
                  OR (p_kind = 'cash' AND t.cash_order_id = p_order_id)
                  OR t.invoice_number = v_invoice)) THEN
    v_markers := array_append(v_markers, 'an earned ledger row');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_transactions t
              WHERE t.transaction_type = 'bonus' AND t.invoice_number = v_invoice) THEN
    v_markers := array_append(v_markers, 'a bonus ledger row');
  END IF;
  IF EXISTS (SELECT 1 FROM public.loyalty_point_lots l
              WHERE l.source_type IN ('order_earn', 'promo_bonus')
                AND l.source_reference = v_invoice) THEN
    v_markers := array_append(v_markers, 'a points lot');
  END IF;
  IF array_length(v_markers, 1) > 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'already_earned',
      'message', 'This order has already earned loyalty points (' || array_to_string(v_markers, ', ') || '). Points cannot follow the order to another customer.');
  END IF;

  IF v_invoice ILIKE 'SH-%' OR COALESCE(v_source_channel, '') ILIKE 'shopify%' OR v_shopify_id IS NOT NULL THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'shopify_order',
      'message', 'This is a Shopify order. Its owner comes from Shopify and cannot be changed here.');
  END IF;

  -- A split payment submission covering more than one order cannot be moved:
  -- one half would follow the order and the other would stay behind.
  WITH subs AS (
    SELECT ps.id, ps.account_id, ps.cash_order_id
      FROM public.payment_submissions ps
     WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
              OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
        OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id)
  ), orders AS (
    -- UNION (not UNION ALL) — one row per (submission, order) pair.
    SELECT s.id AS sid, s.account_id AS la_id, NULL::uuid AS co_id FROM subs s WHERE s.account_id IS NOT NULL
    UNION SELECT s.id, NULL::uuid, s.cash_order_id FROM subs s WHERE s.cash_order_id IS NOT NULL
    UNION SELECT a.submission_id, a.account_id, NULL::uuid
            FROM public.payment_submission_allocations a JOIN subs s ON s.id = a.submission_id
  ), wide AS (
    SELECT sid FROM orders GROUP BY sid HAVING count(*) > 1
  )
  SELECT count(*), string_agg(DISTINCT COALESCE(la.invoice_number, co.invoice_number), ', ')
    INTO v_split_n, v_split
    FROM orders o
    JOIN wide w ON w.sid = o.sid
    LEFT JOIN public.layaway_accounts la ON la.id = o.la_id
    LEFT JOIN public.cash_orders co ON co.id = o.co_id
   WHERE NOT ((p_kind = 'layaway' AND o.la_id IS NOT DISTINCT FROM p_order_id)
           OR (p_kind = 'cash' AND o.co_id IS NOT DISTINCT FROM p_order_id));
  IF v_split_n > 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'split_submission',
      'message', 'A payment submission for this order also pays ' || COALESCE('invoice ' || v_split, 'another order')
        || '. A split payment cannot be divided between two customers.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.loyalty_redemptions r
              WHERE r.status <> 'cancelled'
                AND ((p_kind = 'layaway' AND r.account_id = p_order_id)
                  OR (p_kind = 'cash' AND r.cash_order_id = p_order_id)
                  OR r.invoice_number = v_invoice)) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_redemption',
      'message', 'A loyalty redemption is attached to this order. It belongs to the account that redeemed the points.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.store_credit_transactions x
              WHERE (p_kind = 'layaway' AND x.account_id = p_order_id)
                 OR (p_kind = 'cash' AND x.cash_order_id = p_order_id))
     OR EXISTS (SELECT 1 FROM public.store_credit_lots l
              WHERE (p_kind = 'layaway' AND l.source_account_id = p_order_id)
                 OR (p_kind = 'cash' AND l.source_cash_order_id = p_order_id)) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'store_credit',
      'message', 'Store credit was applied to or issued from this order. Store credit belongs to one customer and cannot move with the order.');
  END IF;

  -- Paidy (owner 2026-10-04): a Paidy order is a website order paid from the
  -- customer's own signed-in account, so it never changes owner. Any Paidy
  -- history counts (a payment record, a checkout window, a Paidy submission).
  IF p_kind = 'cash' AND (
       EXISTS (SELECT 1 FROM public.paidy_payments pp WHERE pp.cash_order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM public.paidy_checkout_attempts pa WHERE pa.cash_order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM public.payment_submissions ps
                WHERE ps.cash_order_id = p_order_id
                  AND (ps.payment_method = 'paidy' OR ps.paidy_payment_id IS NOT NULL))) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'paidy_order',
      'message', 'This order was paid, or started to be paid, with Paidy. A Paidy order belongs to the customer who signed in and paid, and cannot change owner.');
  END IF;

  -- Square (S04, 2026-10-08): a card order is paid from the customer's own
  -- signed-in account, so it never changes owner. Any card history counts —
  -- an attempt (even one only reserved, not yet filed), a card payment row or
  -- a card submission. The order row is locked above, and
  -- reserve_square_attempt locks it too, so the two cannot interleave.
  IF p_kind = 'cash' AND (
       EXISTS (SELECT 1 FROM public.square_card_attempts sa WHERE sa.cash_order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id)
    OR EXISTS (SELECT 1 FROM public.payment_submissions ps
                WHERE ps.cash_order_id = p_order_id
                  AND (ps.payment_method = 'square' OR ps.square_payment_id IS NOT NULL))) THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'card_order',
      'message', 'This order was paid, or started to be paid, by card. A card order belongs to the customer who signed in and paid, and cannot change owner.');
  END IF;

  -- R11 — IDENTITY MATCH. The target must be another account of the SAME
  -- customer: at least one of full name, Facebook name, mobile or email
  -- matches the CURRENT owner, normalised exactly as find_customer_matches
  -- does (names: lower-case, trim, collapse spaces; mobile: last 10 digits,
  -- only when both sides have >= 10; email: trimmed, case-insensitive). An
  -- empty field never matches — the left side is NULLed when empty.
  v_matched_on := array_remove(ARRAY[
    CASE WHEN nullif(lower(regexp_replace(btrim(coalesce(v_old.full_name, '')), '\s+', ' ', 'g')), '')
            = lower(regexp_replace(btrim(coalesce(v_new.full_name, '')), '\s+', ' ', 'g'))
         THEN 'full_name' END,
    CASE WHEN nullif(lower(regexp_replace(btrim(coalesce(v_old.facebook_name, '')), '\s+', ' ', 'g')), '')
            = lower(regexp_replace(btrim(coalesce(v_new.facebook_name, '')), '\s+', ' ', 'g'))
         THEN 'facebook_name' END,
    CASE WHEN length(regexp_replace(coalesce(v_old.mobile_number, ''), '\D', '', 'g')) >= 10
          AND length(regexp_replace(coalesce(v_new.mobile_number, ''), '\D', '', 'g')) >= 10
          AND right(regexp_replace(v_old.mobile_number, '\D', '', 'g'), 10)
            = right(regexp_replace(v_new.mobile_number, '\D', '', 'g'), 10)
         THEN 'mobile' END,
    CASE WHEN nullif(lower(btrim(coalesce(v_old.email, ''))), '')
            = lower(btrim(coalesce(v_new.email, '')))
         THEN 'email' END
  ], NULL);
  v_unmatched := cardinality(v_matched_on) = 0;
  -- The override is honoured only for a holder of reassign_owner_unmatched;
  -- the edge function checks it too, this repeats it so a direct caller
  -- cannot skip it. It bypasses R11 ONLY — every other refusal still stands.
  v_override_ok := COALESCE(p_allow_unmatched, false)
               AND public.has_permission(p_user_id, 'reassign_owner_unmatched');
  IF v_unmatched THEN
    IF v_override_ok THEN
      v_override_used := true;
    ELSE
      v_refusals := v_refusals || jsonb_build_object('code', 'different_customer_details',
        'message', 'Different customer details — this order can only move to another account of the same customer. Contact the owner.');
    END IF;
  END IF;

  -- R4 — the loyalty amount must be set (> 0) for every reassign.
  v_loyalty_eff := COALESCE(p_loyalty_jpy_amount, v_loyalty_stored);
  v_loyalty_change := p_loyalty_jpy_amount IS NOT NULL
                  AND p_loyalty_jpy_amount IS DISTINCT FROM v_loyalty_stored;
  IF v_loyalty_eff IS NULL OR v_loyalty_eff <= 0 THEN
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_amount_required',
      'message', 'Set the loyalty product amount (product only — no shipping or service fees) before reassigning.');
  ELSIF v_loyalty_change AND NOT public.has_permission(p_user_id, 'edit_loyalty_amount') THEN
    -- R3. trg_guard_loyalty_jpy_amount does not fire for a service-role
    -- caller, so the permission is checked here.
    v_refusals := v_refusals || jsonb_build_object('code', 'loyalty_permission_required',
      'message', 'Changing the loyalty amount needs the Edit Loyalty Amount permission.');
  END IF;

  -- ---- award point (R6) ----------------------------------------------------
  IF p_kind = 'layaway' THEN
    SELECT min(p.created_at) INTO v_award_at
      FROM public.payments p
     WHERE p.account_id = p_order_id
       AND p.voided_at IS NULL
       AND (p.reference_number LIKE 'DP-%' OR p.remarks ILIKE '%down%')
       AND COALESCE(p.reference_number, '') NOT LIKE 'LOYALTY-%';
    IF v_award_at IS NOT NULL THEN
      v_award_source := 'downpayment_payment';
    ELSE
      SELECT min(ps.updated_at) INTO v_award_at
        FROM public.payment_submissions ps
       WHERE ps.account_id = p_order_id
         AND ps.status = 'confirmed'
         AND ps.submission_type = 'downpayment';
      IF v_award_at IS NOT NULL THEN v_award_source := 'downpayment_submission'; END IF;
    END IF;
  ELSIF v_status = 'completed' THEN
    v_award_at := v_completed_at;
    IF v_award_at IS NOT NULL THEN
      v_award_source := 'completed_at';
    ELSE
      SELECT x.created_at INTO v_award_at FROM (
        SELECT cp.created_at,
               sum(cp.amount_paid) OVER (ORDER BY cp.created_at, cp.id) AS running
          FROM public.cash_payments cp
         WHERE cp.cash_order_id = p_order_id AND cp.voided_at IS NULL
      ) x WHERE x.running >= v_total ORDER BY x.created_at LIMIT 1;
      IF v_award_at IS NOT NULL THEN v_award_source := 'fully_paid_payment'; END IF;
    END IF;
  END IF;

  SELECT (value #>> '{}') INTO v_flag FROM public.system_settings WHERE key = 'loyalty_enrollment_grace_days';
  IF v_flag ~ '^[0-9]+$' THEN v_grace_days := v_flag::integer; END IF;
  SELECT (value #>> '{}') INTO v_flag FROM public.system_settings WHERE key = 'loyalty_enabled';
  v_loyalty_on := lower(COALESCE(v_flag, '')) = 'true';

  -- ---- catch-up decision (R6/R7) -------------------------------------------
  v_lot_expires_on := v_order_date + 180;
  IF v_new_m.id IS NULL THEN
    v_catch_reason := 'not_enrolled';
  ELSIF v_award_at IS NULL THEN
    v_catch_reason := 'not_at_award_point';
  ELSIF v_award_at < v_new_m.enrolled_at - make_interval(days => v_grace_days) THEN
    v_catch_reason := 'paid_before_enrollment';
  ELSE
    v_catch_up := true;
    v_catch_reason := 'eligible';
    v_expired := v_lot_expires_on <= (now() AT TIME ZONE 'Asia/Manila')::date;
  END IF;

  -- Expected points — the award function's own arithmetic: current tier, with
  -- the ratchet to the post-purchase tier (and the requalify gate), no promo.
  IF v_catch_up AND COALESCE(v_loyalty_eff, 0) >= 10000 THEN
    v_new_cum := COALESCE(v_new_m.cumulative_spend_jpy, 0) + v_loyalty_eff;
    SELECT min_spend_jpy, points_multiplier INTO v_new_tier_min, v_new_tier_mult
      FROM public.loyalty_tiers WHERE min_spend_jpy <= v_new_cum
     ORDER BY min_spend_jpy DESC LIMIT 1;
    IF v_new_m.is_downgraded AND v_new_m.downgrade_spend_baseline IS NOT NULL AND v_new_m.earned_tier_id IS NOT NULL THEN
      SELECT requalify_spend_jpy INTO v_requalify_tgt FROM public.loyalty_tiers WHERE id = v_new_m.earned_tier_id;
      IF v_requalify_tgt IS NOT NULL THEN
        v_requalified := (v_new_cum - v_new_m.downgrade_spend_baseline) >= v_requalify_tgt;
      END IF;
    END IF;
    v_upgraded := v_requalified AND v_new_tier_min IS NOT NULL AND v_new_tier_min > COALESCE(v_cur_min, 0);
    v_expected_pts := (floor(v_loyalty_eff / 10000) * 100
                       * CASE WHEN v_upgraded THEN COALESCE(v_new_tier_mult, 1) ELSE COALESCE(v_mult, 1) END)::integer;
  END IF;

  -- ---- child rows that move with the order ---------------------------------
  v_account_type := CASE WHEN p_kind = 'layaway' THEN 'layaway' ELSE 'cash_order' END;
  SELECT count(*) INTO n_submissions FROM public.payment_submissions ps
   WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
            OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
      OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id);
  IF p_kind = 'layaway' THEN
    SELECT count(*) INTO n_extensions FROM public.extension_requests WHERE account_id = p_order_id;
    SELECT count(*) INTO n_csr FROM public.csr_notifications WHERE account_id = p_order_id;
  END IF;
  SELECT count(*) INTO n_service_jobs FROM public.service_jobs
   WHERE invoice_number = v_invoice AND account_type = v_account_type;
  SELECT count(*) INTO n_service_reqs FROM public.service_requests
   WHERE (p_kind = 'layaway' AND layaway_account_id = p_order_id)
      OR (p_kind = 'cash' AND cash_order_id = p_order_id);
  IF v_quote_id IS NOT NULL THEN
    SELECT count(*) INTO n_quotes FROM public.checkout_quotes WHERE id = v_quote_id;
  END IF;
  IF v_ship_addr IS NOT NULL THEN n_address := 1; END IF;

  v_counts := jsonb_build_object(
    'payment_submissions', n_submissions, 'extension_requests', n_extensions,
    'service_jobs', n_service_jobs, 'service_requests', n_service_reqs,
    'checkout_quotes', n_quotes, 'csr_notifications', n_csr,
    'ship_to_address_detached', n_address);

  v_result := jsonb_build_object(
    'ok', true,
    'applied', false,
    'kind', p_kind,
    'order_id', p_order_id,
    'invoice_number', v_invoice,
    'status', v_status,
    'order_date', v_order_date,
    'current', jsonb_build_object(
      'customer_id', v_old_cust, 'full_name', v_old.full_name, 'is_test', COALESCE(v_old.is_test, false),
      'enrolled', v_old_m.id IS NOT NULL, 'tier', v_old_tier,
      'points', COALESCE(v_old_m.remaining_points, 0), 'points_earned', COALESCE(v_old_m.total_points_earned, 0),
      'spend_jpy', COALESCE(v_old_m.cumulative_spend_jpy, 0), 'has_points', v_old_has),
    'target', jsonb_build_object(
      'customer_id', p_new_customer_id, 'full_name', v_new.full_name, 'is_test', COALESCE(v_new.is_test, false),
      'enrolled', v_new_m.id IS NOT NULL, 'enrolled_at', v_new_m.enrolled_at, 'tier', v_new_tier,
      'points', COALESCE(v_new_m.remaining_points, 0), 'points_earned', COALESCE(v_new_m.total_points_earned, 0),
      'spend_jpy', COALESCE(v_new_m.cumulative_spend_jpy, 0), 'has_points', v_new_has),
    'refusals', v_refusals,
    'can_apply', jsonb_array_length(v_refusals) = 0,
    'matched_on', to_jsonb(v_matched_on),
    'unmatched', v_unmatched,
    'loyalty_jpy_amount', jsonb_build_object(
      'stored', v_loyalty_stored, 'proposed', p_loyalty_jpy_amount, 'effective', v_loyalty_eff,
      'changes', v_loyalty_change),
    'award_point', jsonb_build_object('at', v_award_at, 'source', v_award_source),
    'catch_up', jsonb_build_object(
      'eligible', v_catch_up, 'reason', v_catch_reason, 'grace_days', v_grace_days,
      'expected_points', v_expected_pts, 'below_minimum', v_catch_up AND COALESCE(v_loyalty_eff, 0) < 10000,
      'expired_on_award', v_expired, 'lot_expires_on', v_lot_expires_on,
      'loyalty_enabled', v_loyalty_on),
    'child_rows', v_counts);

  IF NOT COALESCE(p_apply, false) THEN
    RETURN v_result;
  END IF;

  IF jsonb_array_length(v_refusals) > 0 THEN
    RETURN v_result || jsonb_build_object('ok', false,
      'error', v_refusals -> 0 ->> 'code', 'message', v_refusals -> 0 ->> 'message');
  END IF;

  -- ---- apply ---------------------------------------------------------------
  IF v_loyalty_change THEN
    IF p_kind = 'layaway' THEN
      UPDATE public.layaway_accounts SET loyalty_jpy_amount = p_loyalty_jpy_amount WHERE id = p_order_id;
    ELSE
      UPDATE public.cash_orders SET loyalty_jpy_amount = p_loyalty_jpy_amount WHERE id = p_order_id;
    END IF;
  END IF;

  IF p_kind = 'layaway' THEN
    UPDATE public.layaway_accounts SET customer_id = p_new_customer_id WHERE id = p_order_id;
  ELSE
    -- The saved address belongs to the old owner's address book. Keep what
    -- the order shipped to as its snapshot, then drop the link.
    UPDATE public.cash_orders
       SET customer_id = p_new_customer_id,
           ship_to_snapshot = CASE WHEN ship_to_address_id IS NOT NULL AND ship_to_snapshot IS NULL
                                   THEN public.address_snapshot(ship_to_address_id)
                                   ELSE ship_to_snapshot END,
           ship_to_address_id = NULL
     WHERE id = p_order_id;
  END IF;

  UPDATE public.payment_submissions ps
     SET customer_id = p_new_customer_id, portal_token = NULL
   WHERE (p_kind = 'layaway' AND (ps.account_id = p_order_id
            OR ps.id IN (SELECT a.submission_id FROM public.payment_submission_allocations a WHERE a.account_id = p_order_id)))
      OR (p_kind = 'cash' AND ps.cash_order_id = p_order_id);
  GET DIAGNOSTICS n_submissions = ROW_COUNT;

  IF p_kind = 'layaway' THEN
    UPDATE public.extension_requests
       SET customer_id = p_new_customer_id, portal_token = NULL
     WHERE account_id = p_order_id;
    GET DIAGNOSTICS n_extensions = ROW_COUNT;
    UPDATE public.csr_notifications SET customer_id = p_new_customer_id WHERE account_id = p_order_id;
    GET DIAGNOSTICS n_csr = ROW_COUNT;
  END IF;

  UPDATE public.service_jobs SET customer_id = p_new_customer_id
   WHERE invoice_number = v_invoice AND account_type = v_account_type;
  GET DIAGNOSTICS n_service_jobs = ROW_COUNT;

  UPDATE public.service_requests SET customer_id = p_new_customer_id
   WHERE (p_kind = 'layaway' AND layaway_account_id = p_order_id)
      OR (p_kind = 'cash' AND cash_order_id = p_order_id);
  GET DIAGNOSTICS n_service_reqs = ROW_COUNT;

  IF v_quote_id IS NOT NULL THEN
    UPDATE public.checkout_quotes SET customer_id = p_new_customer_id WHERE id = v_quote_id;
    GET DIAGNOSTICS n_quotes = ROW_COUNT;
  END IF;

  v_counts := jsonb_build_object(
    'payment_submissions', n_submissions, 'extension_requests', n_extensions,
    'service_jobs', n_service_jobs, 'service_requests', n_service_reqs,
    'checkout_quotes', n_quotes, 'csr_notifications', n_csr,
    'ship_to_address_detached', n_address);

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (
    CASE WHEN p_kind = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END,
    p_order_id,
    'reassign_owner',
    jsonb_build_object(
      'customer_id', v_old_cust, 'customer_name', v_old.full_name,
      'loyalty_jpy_amount', v_loyalty_stored),
    jsonb_build_object(
      'customer_id', p_new_customer_id, 'customer_name', v_new.full_name,
      'loyalty_jpy_amount', v_loyalty_eff,
      'reason', btrim(p_reason),
      'invoice_number', v_invoice,
      'moved', v_counts,
      'award_point', v_award_at, 'award_point_source', v_award_source,
      'catch_up', v_catch_up, 'catch_up_reason', v_catch_reason,
      'catch_up_expected_points', v_expected_pts, 'catch_up_expired_on_award', v_expired,
      'matched_on', to_jsonb(v_matched_on), 'unmatched', v_unmatched,
      'override_used', v_override_used),
    p_user_id);

  RETURN v_result || jsonb_build_object('applied', true, 'child_rows', v_counts,
    'loyalty_jpy_amount', (v_result -> 'loyalty_jpy_amount') || jsonb_build_object('stored', v_loyalty_eff));
END;
$function$

;

-- ---------------------------------------------------------------------------
-- ring_square_deadline_bells
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ring_square_deadline_bells(p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_holds int := 0; v_d3 int := 0; v_d1 int := 0; v_r14 int := 0; v_r7 int := 0;
BEGIN
  WITH due AS (
    -- HUB-7 (2026-10-05): a hold without capture_by (Square sent no
    -- delayed_until) is warned against authorized_at + 7 days, Square's
    -- default window for an online card payment — the same fallback as
    -- card-rules.ts cardHoldWarnDue — and the bell says it is an estimate.
    SELECT sp.id, sp.cash_order_id, sp.square_payment_id, sp.amount_jpy,
           coalesce(sp.capture_by, sp.authorized_at + interval '7 days') AS capture_by,
           (sp.capture_by IS NULL) AS estimated, sp.test,
           o.customer_id, o.invoice_number, coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_payments sp JOIN public.cash_orders o ON o.id = sp.cash_order_id
     WHERE sp.status = 'authorized' AND sp.warned_at IS NULL
       AND coalesce(sp.capture_by, sp.authorized_at + interval '7 days') IS NOT NULL
       AND coalesce(sp.capture_by, sp.authorized_at + interval '7 days') - interval '2 days' <= p_now
     FOR UPDATE OF sp SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_hold_expiring', 'Card hold expires soon',
           ref || ' · ¥' || to_char(round(amount_jpy), 'FM999,999,999') || ' — Square cancels this hold on '
             || CASE WHEN estimated THEN 'about ' ELSE '' END || to_char(capture_by AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST. Confirm or Reject it in Payments Hub before then.',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'square_payment_id', square_payment_id,
                              'capture_by', capture_by, 'capture_by_estimated', estimated, 'test', test)
      FROM due
    RETURNING 1
  )
  UPDATE public.square_payments sp SET warned_at = p_now, updated_at = now()
    FROM due WHERE sp.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_holds = ROW_COUNT;

  -- HUB-2/HUB-8 (2026-10-05): evidence reminders only while Square still
  -- waits for evidence (EVIDENCE_REQUIRED / INQUIRY_EVIDENCE_REQUIRED) and
  -- staff have not recorded it as submitted. PROCESSING / INQUIRY_PROCESSING
  -- mean the evidence is in; WON / LOST / ACCEPTED / INQUIRY_CLOSED are closed.
  WITH due AS (
    SELECT d.id, d.cash_order_id, d.square_dispute_id, d.amount_jpy, d.due_at, d.state, o.customer_id, o.invoice_number,
           coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_disputes d JOIN public.cash_orders o ON o.id = d.cash_order_id
     WHERE d.due_at IS NOT NULL AND d.reminded_3d_at IS NULL AND d.state IN ('EVIDENCE_REQUIRED','INQUIRY_EVIDENCE_REQUIRED')
       AND d.decision IS DISTINCT FROM 'evidence_submitted'
       AND d.due_at - interval '3 days' <= p_now
     FOR UPDATE OF d SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_dispute_deadline', 'Dispute evidence due in 3 days',
           ref || ' · dispute ' || square_dispute_id || ' · evidence due ' || to_char(due_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST (Square Dashboard).',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'dispute_id', square_dispute_id, 'due_at', due_at)
      FROM due RETURNING 1
  )
  UPDATE public.square_disputes d SET reminded_3d_at = p_now, updated_at = now()
    FROM due WHERE d.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_d3 = ROW_COUNT;

  WITH due AS (
    SELECT d.id, d.cash_order_id, d.square_dispute_id, d.due_at, o.customer_id, o.invoice_number,
           coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_disputes d JOIN public.cash_orders o ON o.id = d.cash_order_id
     WHERE d.due_at IS NOT NULL AND d.reminded_1d_at IS NULL AND d.state IN ('EVIDENCE_REQUIRED','INQUIRY_EVIDENCE_REQUIRED')
       AND d.decision IS DISTINCT FROM 'evidence_submitted'
       AND d.due_at - interval '1 day' <= p_now
     FOR UPDATE OF d SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_dispute_deadline', 'Dispute evidence due within a day',
           ref || ' · dispute ' || square_dispute_id || ' · evidence due ' || to_char(due_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI') || ' JST (Square Dashboard).',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'dispute_id', square_dispute_id, 'due_at', due_at)
      FROM due RETURNING 1
  )
  UPDATE public.square_disputes d SET reminded_1d_at = p_now, updated_at = now()
    FROM due WHERE d.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_d1 = ROW_COUNT;

  -- S05 (2026-10-08): a Square refund that is still not finished. Age is
  -- counted from Square's own creation time (updated_at is rewritten by every
  -- hourly read). Every day counts (owner E1). 14 days first, so a refund
  -- first seen that old rings once, with the support wording.
  WITH due AS (
    SELECT r.id, r.cash_order_id, r.square_refund_id, r.amount_jpy, r.status,
           coalesce(r.provider_created_at, r.created_at) AS started_at,
           o.customer_id, o.invoice_number, coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_refunds r JOIN public.cash_orders o ON o.id = r.cash_order_id
     WHERE r.status NOT IN ('COMPLETED','FAILED','REJECTED') AND r.warned_14d_at IS NULL
       AND coalesce(r.provider_created_at, r.created_at) <= p_now - interval '14 days'
     FOR UPDATE OF r SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_refund_pending', 'Card refund still not finished after 14 days — contact Square support',
           ref || ' · ¥' || to_char(round(amount_jpy), 'FM999,999,999') || ' — Square refund ' || square_refund_id
             || ' is still ' || status || ' since ' || to_char(started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') || ' JST ('
             || floor(extract(epoch FROM p_now - started_at) / 86400)::int || ' days). Contact Square support from the Square Dashboard.',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'square_refund_id', square_refund_id, 'amount_jpy', amount_jpy,
                              'status', status, 'started_at', started_at, 'stage', '14d')
      FROM due RETURNING 1
  )
  UPDATE public.square_refunds r SET warned_14d_at = p_now, warned_7d_at = coalesce(r.warned_7d_at, p_now)
    FROM due WHERE r.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_r14 = ROW_COUNT;

  WITH due AS (
    SELECT r.id, r.cash_order_id, r.square_refund_id, r.amount_jpy, r.status,
           coalesce(r.provider_created_at, r.created_at) AS started_at,
           o.customer_id, o.invoice_number, coalesce(o.web_reference, o.invoice_number, '') AS ref
      FROM public.square_refunds r JOIN public.cash_orders o ON o.id = r.cash_order_id
     WHERE r.status NOT IN ('COMPLETED','FAILED','REJECTED') AND r.warned_7d_at IS NULL
       AND coalesce(r.provider_created_at, r.created_at) <= p_now - interval '7 days'
     FOR UPDATE OF r SKIP LOCKED
  ), bell AS (
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    SELECT 'card_refund_pending', 'Card refund still not finished after 7 days',
           ref || ' · ¥' || to_char(round(amount_jpy), 'FM999,999,999') || ' — Square refund ' || square_refund_id
             || ' is still ' || status || ' since ' || to_char(started_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') || ' JST ('
             || floor(extract(epoch FROM p_now - started_at) / 86400)::int || ' days). Our policy promises 7 days — check it in the Square Dashboard.',
           customer_id, invoice_number,
           jsonb_build_object('cash_order_id', cash_order_id, 'square_refund_id', square_refund_id, 'amount_jpy', amount_jpy,
                              'status', status, 'started_at', started_at, 'stage', '7d')
      FROM due RETURNING 1
  )
  UPDATE public.square_refunds r SET warned_7d_at = p_now
    FROM due WHERE r.id = due.id AND (SELECT count(*) FROM bell) >= 0;
  GET DIAGNOSTICS v_r7 = ROW_COUNT;

  RETURN jsonb_build_object('hold_warnings', v_holds, 'dispute_3d', v_d3, 'dispute_1d', v_d1,
                            'refund_7d', v_r7, 'refund_14d', v_r14);
END
$function$

;

-- ---------------------------------------------------------------------------
-- square_ops_health
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_ops_health()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v jsonb;
BEGIN
  -- Staff only (review #2: current_user is the owner inside SECURITY
  -- DEFINER, so it can never identify the caller).
  IF v_uid IS NULL OR NOT public.is_staff(v_uid) THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'last_run',            (SELECT value FROM public.square_sync_state WHERE key = 'reconcile_last_run'),
    'last_ok_at',          (SELECT value->>'at' FROM public.square_sync_state WHERE key = 'reconcile_last_ok'),
    'events_backlog',      (SELECT count(*) FROM public.square_webhook_events WHERE status IN ('received','processing','failed','quarantined')),
    'events_dead',         (SELECT count(*) FROM public.square_webhook_events WHERE status = 'dead'),
    'holds_live',          (SELECT count(*) FROM public.square_payments WHERE status = 'authorized'),
    'attempts_open',       (SELECT count(*) FROM public.square_card_attempts WHERE status IN ('reserved','unknown','cancelling')),
    'captured_unrecorded', (SELECT count(*) FROM public.square_payments WHERE status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL),
    'exceptions_open',     (SELECT count(*) FROM public.square_payments WHERE exception IS NOT NULL AND exception_resolved_at IS NULL),
    'refunds_open',        (SELECT count(*) FROM public.square_refunds WHERE status NOT IN ('COMPLETED','FAILED','REJECTED')),
    'refund_oldest_pending_at', (SELECT min(coalesce(provider_created_at, created_at)) FROM public.square_refunds
                                  WHERE status NOT IN ('COMPLETED','FAILED','REJECTED')),
    'attempts_stuck',      (SELECT count(*) FROM public.square_card_attempts
                             WHERE status IN ('reserved','unknown','cancelling') AND stuck_warned_at IS NOT NULL),
    'disputes_open',       (SELECT count(*) FROM public.square_disputes WHERE state NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')),
    'checkpoints',         (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) FROM public.square_sync_state
                             WHERE key NOT IN ('reconcile_last_run','reconcile_last_ok'))
  ) INTO v;
  RETURN v;
END
$function$

;

-- ---------------------------------------------------------------------------
-- terminate_web_order_atomic
-- ---------------------------------------------------------------------------
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
  v_order_date date; v_split jsonb := NULL; v_card_paid boolean := false;
  v_points_to_revoke numeric := 0; v_spend_to_reverse numeric := 0;
  v_reason text; v_is_system boolean; v_stock_lines integer := 0; v_restored integer := 0;
  v_flipped integer := 0; v_now timestamptz := now();
BEGIN
  IF p_outcome NOT IN ('expired','cancelled') THEN
    RAISE EXCEPTION 'bad_outcome: %', p_outcome USING ERRCODE='P0001';
  END IF;
  v_is_system := (p_source IN ('system','shopify_webhook'));

  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid, order_date
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid, v_order_date
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
    -- Cancellation credit rule (owner 2026-10-06/08): same day as order_date →
    -- 100 %; later → 30 % of the money paid kept, 70 % credit. No override.
    v_split := public.cancellation_credit_split(v_currency, v_order_date, v_money_received, v_now);
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
      'store_credit_if_chosen', GREATEST(0, COALESCE((v_split ->> 'credit')::numeric, 0) - v_partial_credit),
      'cancellation_rule', v_split ->> 'rule',
      'cancellation_charge', COALESCE((v_split ->> 'kept')::numeric, 0),
      'cancellation_split', v_split,
      'paid_by_card', v_card_paid,
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
$function$

;
