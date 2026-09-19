-- Store credit applied AS a downpayment must be visible to the DP detectors.
-- Bug #285, 2026-09-19.
--
-- THE DEFECT. redeem_store_credit_atomic already decides correctly WHETHER a
-- store-credit application is a downpayment: when the account still owes one it
-- sets v_is_dp = TRUE and passes p_is_downpayment => true, and INVARIANT 11 then
-- correctly declines to allocate it against the schedule. What it does NOT do is
-- LABEL the payment as a downpayment. It writes reference_number 'SC-<uuid>' and
-- remarks 'Store credit applied', and the Hub's DP heuristic is
--   reference_number LIKE 'DP-%' OR remarks ILIKE '%down%'
-- which neither of those matches. The payment is a downpayment that no DP
-- calculation can see.
--
-- WHAT THAT COST, on invoice 19774 (PHP), 2026-09-19:
--   02:10:11  PHP   445.00 store credit, ref SC-dbde1416-…, 0 allocations.
--                   Correct at that moment -- no DP had been paid, so v_is_dp
--                   was TRUE and a DP does not allocate.
--   02:15:45  PHP 2,500.00 downpayment, ref DP-19774.
--                   allocate_payment_atomic counted prior DP = 0 (the 445 is
--                   invisible to it), so (0 + 2500) - 2500 = 0 excess, the
--                   waterfall gate never opened, and 0 allocations were written.
--   Result: PHP 445 of genuine excess over the downpayment requirement never
--   reached installment 1, and no future payment can ever see it -- each one
--   recomputes prior DP from the same blind predicate.
--
-- WHY BOTH THE REFERENCE AND THE REMARKS CHANGE. Four incompatible DP predicates
-- exist in the codebase and no single field satisfies them all:
--   * SQL + most edge functions ...... remarks ILIKE '%down%'
--   * void/restore/AccountDetail ..... substring 'down' OR 'dp'
--   * five portal/customer surfaces .. remarks = 'downpayment' EXACTLY
--   * fix-account-totals ............. remarks only, never the reference
-- The 'DP-' reference covers the exact-equality surfaces (they test the
-- reference too); the remarks cover fix-account-totals, which never looks at a
-- reference. Changing only one leaves half the Hub still blind.
--
-- SCOPE. redeem_store_credit_atomic only, and only where v_is_dp is TRUE on the
-- LAYAWAY branch. A cash order has no downpayment concept, and a non-DP layaway
-- application is an ordinary installment payment -- both keep 'SC-' || v_app_id
-- and 'Store credit applied' byte-for-byte. allocate_payment_atomic is NOT
-- touched (live md5 77aca9392fecf08824b765c02025e014 / 11179 bytes, matching
-- 20260917070200_record_live_drifted_functions.sql).
--
-- NOTHING READS THE 'SC-' PREFIX. Verified by grep across supabase/ and src/:
-- the only occurrence anywhere is the assignment being changed here. No parser,
-- no LIKE 'SC-%', no startsWith. Changing the format breaks no reader.
--
-- THE BODY BELOW IS THE LIVE BODY. Copied verbatim from
-- 20260917070100_record_live_only_functions.sql:661-853, whose recorded header is
--   md5    : 8e551b917c2df83d0ba777cf0b12823d
--   length : 9241 bytes
--   acl    : postgres=X/postgres | service_role=X/postgres | sandbox_exec_pfoicalpzdcmyxzvwyhz=X/postgres
-- and which live confirmed as a MATCH on 2026-09-19 before this file was written
-- (CLAUDE.md "FUNCTION CHANGES START FROM LIVE"). Only the two places described
-- above differ; every other line is byte-identical. Signature, SECURITY DEFINER,
-- search_path and the ACL are unchanged -- CREATE OR REPLACE preserves the
-- existing grants, and none is re-issued here.
--
-- TWO BEHAVIOUR CHANGES THIS CREATES, both intended, both consequences of the
-- payment finally being a recognised downpayment:
--   1. void-payment:322 will now revoke loyalty points when such a payment is
--      voided. Correct -- the award fired on DP confirmation, so the reversal
--      belongs with it.
--   2. restore-payment:127 will now take the DP short-circuit: unvoid and
--      recompute totals, no waterfall. For a DP whose amount is within the
--      downpayment requirement that is exactly right (it had no allocations to
--      restore). For a DP carrying EXCESS it is incomplete -- the excess'
--      allocations are not rebuilt. That gap is pre-existing for every DP-shaped
--      payment since INVARIANT 11 (2026-07-06) and is NOT introduced here; it is
--      filed rather than fixed, because widening restore-payment is a separate
--      change with its own blast radius.
--
-- Re-runnable and self-contained. Replaying it is a no-op.

BEGIN;

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

  -- A store-credit payment that is BEING TREATED as the downpayment must be
  -- VISIBLE to the Hub's DP detectors, or every later DP calculation undercounts
  -- (Bug #285, invoice 19774). Both halves matter: the 'DP-' reference satisfies
  -- the five portal surfaces that test remarks = 'downpayment' EXACTLY, and the
  -- remarks below satisfy fix-account-totals, which reads remarks and never the
  -- reference. Cash orders have no downpayment, and a non-DP layaway application
  -- is an ordinary installment payment -- both keep the original 'SC-' form.
  v_ref := CASE
             WHEN v_is_layaway AND v_is_dp
               THEN 'DP-' || COALESCE(v_invoice, p_account_id::text)
                    || '-SC-' || left(v_app_id::text, 8)
             ELSE 'SC-' || v_app_id::text
           END;

  IF v_is_layaway THEN
    v_alloc := public.allocate_payment_atomic(
      p_account_id        => p_account_id,
      p_amount_paid       => v_apply,
      p_payment_date      => CURRENT_DATE,
      p_payment_method    => 'store_credit',
      p_reference_number  => v_ref,
      p_remarks           => CASE WHEN v_is_dp
                                  THEN 'Store credit applied (downpayment)'
                                  ELSE 'Store credit applied' END,
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

COMMIT;