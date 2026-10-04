-- Record-only (2026-10-05). Already applied on live — replaying is a no-op.
--
-- Why: 20261107100000_checkout_payment_choice_and_points changed these thirteen
-- functions with md5-guarded IN-PLACE patches (pg_temp.cj_patch). scripts/function-
-- drift-audit only reads CREATE FUNCTION statements, so the repo's newest copy of each
-- was the PRE-patch body. Lovable also applied a hand-copied version of that file whose
-- whitespace differs on two lines (create_web_draft_atomic 'points_available',
-- decline_web_draft_atomic 'points_redemptions_released') — same logic, different text.
-- This file records the bodies exactly as live runs them, so a rebuild from
-- supabase/migrations/ produces what live runs, and the audit stays at 0.
--
-- How each body was built: pg_get_functiondef() of the live function, captured
-- 2026-10-05 after the apply, written here verbatim. Audit comparator md5
-- (whitespace-collapsed prosrc, first 12) of each:
--
--   approve_redemption_atomic            6817c48947d9
--   create_web_draft_atomic              29566f913a74
--   decline_web_draft_atomic             ac15cbe97e45
--   expire_web_layaway_atomic            a94e1b197a16
--   file_paidy_submission_atomic         e829261582e7
--   materialize_web_draft_atomic         ad51ef01eff9
--   page365_web_holds                    68ae64c8e3ed
--   reactivate_web_layaway_atomic        a96ba3cffc28
--   reserve_square_attempt               e340acb8792e
--   set_account_deadlines                3d522322afe3
--   start_paidy_checkout_attempt         87674e0bad4b
--   terminate_web_order_atomic           0b218bcd85a3
--   web_payment_reminder_eligible        8fa12b81f07c
--
-- GRANTS ARE NOT TOUCHED. CREATE OR REPLACE keeps each function's live ACL.

-- ---------------------------------------------------------------------------
-- approve_redemption_atomic (live audit md5 6817c48947d9)
-- ---------------------------------------------------------------------------
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
  v_lots_consumed integer;
BEGIN
  -- 1. Lock redemption; must be pending (closes double-approve race)
  SELECT * INTO r FROM public.loyalty_redemptions WHERE id = p_redemption_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'redemption_not_found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'redemption_not_pending:%', r.status; END IF;
  v_pts := r.points_redeemed;
  -- A WEBSITE CHECKOUT's points (2026-10-05, owner C5) are approved only by
  -- staff Confirm of that draft, which links the new order first. Approving
  -- one before that would take the points and apply them to nothing.
  IF r.web_draft_id IS NOT NULL AND r.account_id IS NULL AND r.cash_order_id IS NULL THEN
    RAISE EXCEPTION 'web_draft_redemption: approved automatically when staff confirm the website order';
  END IF;

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

  -- 5b. Consume the point lots FIFO, and record which lots paid for this
  --     redemption. RESTORED 2026-09-17 (Bug #280) — this call was wired live
  --     on 2026-07-05, was absent from the baseline, and was lost when
  --     20260912000000 rebuilt this function from that baseline.
  --     Not optional and not best-effort: loyalty_lot_consumption is what
  --     void_redemption_atomic reads to give the points back, so a redemption
  --     without these rows cannot be reversed correctly. An insufficiency
  --     raises and rolls back the entire approve.
  v_lots_consumed := public.consume_lots_fifo(m.id, r.id, v_pts::integer);

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
                        'invoice_number', r.invoice_number,
                        'lots_consumed', v_lots_consumed));

  RETURN jsonb_build_object(
    'transaction_id', v_tx_id,
    'payment_id', v_payment_id,
    'new_remaining_points', COALESCE(m.remaining_points, 0) - v_pts,
    'tier_name', v_tier_name,
    'account_status', v_new_status,
    'payment_amount', v_payment_amount,
    'currency', v_currency,
    'lots_consumed', v_lots_consumed
  );
END
$function$;

-- ---------------------------------------------------------------------------
-- create_web_draft_atomic (live audit md5 29566f913a74)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_web_draft_atomic(p_customer_id uuid, p_quote_id uuid, p_lang text DEFAULT NULL::text, p_agreement_version text DEFAULT NULL::text, p_agreement_signed_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote     public.checkout_quotes%ROWTYPE;
  v_item      jsonb;
  v_variant   public.website_product_variants%ROWTYPE;
  v_qty       integer;
  v_updated   integer;
  v_seq       bigint;
  v_reference text;
  v_draft_id  uuid;
  v_lang      text := CASE WHEN p_lang IN ('ja', 'en') THEN p_lang ELSE NULL END;
  v_agr_ver   text := nullif(btrim(coalesce(p_agreement_version, '')), '');
  v_cur       text;
  v_rate      numeric(12,6);
  v_total     numeric(12,2);
  v_shipping  numeric(12,2);
  v_subtotal  numeric(12,2);
  v_snapshot  jsonb;
  v_country   text;
  v_q         jsonb;
  v_deposit   numeric(12,2);
  v_schedule  jsonb;
  v_title     text;
  v_lines     integer := 0;
  v_method    text;
  v_points    integer := 0;
  v_pts_value numeric(12,2) := 0;
  v_member    public.loyalty_members%ROWTYPE;
  v_held      numeric := 0;
  v_red_id    uuid;
BEGIN
  -- Dormant until the owner flips the switch (PR 8): the edge function only
  -- calls this in 'draft' mode, and this refuses otherwise.
  IF public.web_checkout_mode() <> 'draft' THEN
    RETURN jsonb_build_object('error', 'checkout_mode_not_draft');
  END IF;

  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND OR v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode NOT IN ('full', 'layaway') THEN
    RETURN jsonb_build_object('error', 'unsupported_mode');
  END IF;
  IF coalesce(v_quote.total_jpy, 0) <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;
  IF v_quote.mode = 'layaway' AND (v_agr_ver IS NULL OR p_agreement_signed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'agreement_missing');
  END IF;

  v_snapshot := public.address_snapshot(v_quote.ship_to_address_id);
  v_country  := upper(nullif(btrim(coalesce(v_snapshot ->> 'country', '')), ''));

  -- Shipping may be added at confirmation (R4) — but never for a destination
  -- that HAS a rate card: there the quote must carry the fee.
  IF v_quote.shipping_jpy IS NULL AND v_country IS NOT NULL AND EXISTS (
       SELECT 1 FROM public.shipping_rates r WHERE r.country = v_country AND r.is_active) THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;

  -- The customer's currency, converted ONCE at the quote's rate: the same
  -- arithmetic as create_web_order_atomic / create_web_layaway_atomic (whole
  -- pesos half-up; shipping on its own, items the remainder).
  v_cur := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_cur = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := CASE WHEN v_quote.shipping_jpy IS NULL THEN NULL ELSE round(v_quote.shipping_jpy * v_rate) END;
  ELSE
    v_cur      := 'JPY';
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := v_quote.shipping_jpy;
  END IF;
  v_subtotal := v_total - coalesce(v_shipping, 0);

  -- A layaway is checked against the plan minimum now (as today), so a draft
  -- that could never be confirmed is never written. Figures are provisional.
  IF v_quote.mode = 'layaway' THEN
    v_q := public.layaway_quote(v_subtotal::integer, v_quote.term_months, v_cur,
                                (now() AT TIME ZONE 'Asia/Manila')::date, coalesce(v_shipping, 0)::integer, 0);
    IF NOT coalesce((v_q ->> 'eligible')::boolean, false)
       OR coalesce((v_q ->> 'term_downgraded')::boolean, false) THEN
      RETURN jsonb_build_object('error', 'below_plan_minimum', 'total', v_total, 'currency', v_cur,
                                'requested_term_months', v_quote.term_months,
                                'max_term_months', v_q -> 'max_term_months');
    END IF;
    v_deposit  := (v_q ->> 'deposit')::numeric;
    v_schedule := v_q -> 'schedule';
  END IF;

  -- CHECKOUT PAYMENT CHOICE + POINTS (2026-10-05, owner C1–C7). The website
  -- stored the customer's choice on the quote; it is checked again here, in
  -- the transaction that holds the pieces, so a draft only ever carries a
  -- method the order can take and points the customer really has.
  v_method := coalesce(nullif(btrim(coalesce(v_quote.payment_method, '')), ''), 'transfer');
  IF v_method NOT IN ('transfer', 'paidy', 'square') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
  IF v_method <> 'transfer' AND v_quote.mode = 'layaway' THEN
    RETURN jsonb_build_object('error', 'method_full_payment_only', 'method', v_method);
  END IF;
  IF v_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen', 'method', v_method);
  END IF;
  IF (v_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP'))
     OR (v_method = 'square' AND public.square_mode() = 'off') THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', v_method);
  END IF;
  v_points := coalesce(v_quote.points, 0);
  IF v_points < 0 THEN
    RETURN jsonb_build_object('error', 'bad_points');
  END IF;
  IF v_points > 0 THEN
    IF coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'loyalty_enabled'), '') <> 'true' THEN
      RETURN jsonb_build_object('error', 'points_unavailable');
    END IF;
    -- The member row lock serialises two checkouts spending the same points.
    SELECT * INTO v_member FROM public.loyalty_members WHERE customer_id = p_customer_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('error', 'points_not_enrolled');
    END IF;
    SELECT coalesce(sum(points_redeemed), 0) INTO v_held
      FROM public.loyalty_redemptions WHERE member_id = v_member.id AND status = 'pending';
    IF v_points > coalesce(v_member.remaining_points, 0) - v_held THEN
      RETURN jsonb_build_object('error', 'points_insufficient',
                                 'points_available', greatest(coalesce(v_member.remaining_points, 0) - v_held, 0));
    END IF;
    -- C4: points never pay shipping — at most the pieces subtotal, in yen.
    IF v_points > coalesce(v_quote.subtotal_jpy, 0) THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0));
    END IF;
    -- 1 pt = ¥1; a peso order converts once at the quote's rate, half-up, as
    -- every other figure on it.
    v_pts_value := CASE WHEN v_cur = 'PHP' THEN round(v_points * v_rate) ELSE v_points END;
    IF v_quote.mode = 'layaway' AND v_pts_value > coalesce(v_deposit, 0) THEN
      RETURN jsonb_build_object('error', 'points_exceed_deposit', 'deposit', v_deposit);
    END IF;
    IF v_quote.mode = 'full' AND v_pts_value > v_subtotal THEN
      RETURN jsonb_build_object('error', 'points_exceed_subtotal', 'max_points', coalesce(v_quote.subtotal_jpy, 0));
    END IF;
  END IF;

  -- The number: a layaway's was reserved at quote time (the agreement was
  -- signed against it); a cash order's is drawn now.
  v_seq       := CASE WHEN v_quote.mode = 'layaway'
                      THEN coalesce(v_quote.reserved_invoice_seq, public.next_web_invoice_seq())
                      ELSE public.next_web_invoice_seq() END;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.web_order_drafts (
    quote_id, customer_id, mode, term_months,
    settlement_currency, fx_rate, fx_rate_date,
    subtotal_jpy, shipping_jpy, total_jpy, subtotal, shipping, total, deposit, schedule,
    ship_to_address_id, ship_to_snapshot, country, order_type, recipient_name, recipient_phone, gift_note,
    customer_lang, agreement_version, agreement_signed_at, invoice_seq, web_reference
  ) VALUES (
    v_quote.id, p_customer_id, v_quote.mode, CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    v_cur, v_rate, CASE WHEN v_rate IS NULL THEN NULL ELSE v_quote.fx_rate_date END,
    v_quote.subtotal_jpy, v_quote.shipping_jpy, v_quote.total_jpy, v_subtotal, v_shipping, v_total, v_deposit, v_schedule,
    v_quote.ship_to_address_id, v_snapshot, v_country, coalesce(v_quote.order_type, 'SELF'),
    v_quote.recipient_name, v_quote.recipient_phone, v_quote.gift_note,
    v_lang,
    CASE WHEN v_quote.mode = 'layaway' THEN v_agr_ver END,
    CASE WHEN v_quote.mode = 'layaway' THEN p_agreement_signed_at END,
    v_seq, v_reference
  ) RETURNING id INTO v_draft_id;

  -- The points are HELD by a pending redemption; staff Confirm approves it.
  IF v_points > 0 THEN
    INSERT INTO public.loyalty_redemptions (
      member_id, redemption_type, points_redeemed, value_applied_jpy, value_applied_php,
      rate_snapshot, invoice_number, status, notes, web_draft_id
    ) VALUES (
      v_member.id, 'new_order_discount', v_points, v_points,
      CASE WHEN v_cur = 'PHP' THEN v_pts_value END,
      coalesce(v_rate, (SELECT (value #>> '{}')::numeric FROM public.system_settings WHERE key = 'php_jpy_rate')),
      v_seq::text, 'pending',
      'Website checkout ' || v_reference || ' — approved automatically when staff confirm the order',
      v_draft_id
    ) RETURNING id INTO v_red_id;
  END IF;
  UPDATE public.web_order_drafts
     SET payment_method = v_method, points = v_points, points_value = v_pts_value,
         points_redemption_id = v_red_id
   WHERE id = v_draft_id;

  -- Hold the pieces: the same guarded decrement as the order writers.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(coalesce((v_item ->> 'qty')::int, 1), 1);
    SELECT * INTO v_variant FROM public.website_product_variants WHERE id = (v_item ->> 'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item ->> 'variant_id';
    END IF;
    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;
    SELECT trim(both ' ' FROM p.name
                 || coalesce(' / ' || nullif(v_variant.size, ''), '')
                 || coalesce(' / ' || nullif(v_variant.stone, ''), ''))
      INTO v_title FROM public.website_products p WHERE p.id = v_variant.product_id;
    INSERT INTO public.web_order_draft_lines (
      draft_id, variant_id, website_product_id, title, sku, qty, unit_price_jpy, line_total_jpy
    ) VALUES (
      v_draft_id, v_variant.id, v_variant.product_id, coalesce(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty, v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
    v_lines := v_lines + 1;
  END LOOP;

  IF v_lines = 0 THEN
    RAISE EXCEPTION 'empty_quote:';
  END IF;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true, 'draft_id', v_draft_id, 'web_reference', v_reference, 'invoice_number', v_seq::text,
    'mode', v_quote.mode, 'currency', v_cur, 'total', v_total, 'total_jpy', v_quote.total_jpy,
    'shipping_pending', v_shipping IS NULL, 'deposit', v_deposit, 'schedule', v_schedule,
    'term_months', CASE WHEN v_quote.mode = 'layaway' THEN v_quote.term_months END,
    'fx_rate', v_rate, 'awaiting_confirmation', true,
    'payment_method', v_method, 'points', v_points, 'points_value', v_pts_value);
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'empty_quote:%' THEN
      RETURN jsonb_build_object('error', 'empty_quote');
    END IF;
    RAISE;
END
$function$;

-- ---------------------------------------------------------------------------
-- decline_web_draft_atomic (live audit md5 ac15cbe97e45)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decline_web_draft_atomic(p_draft_id uuid, p_reason text, p_user_id uuid DEFAULT NULL::uuid, p_source text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_is_system boolean := (p_source = 'system');
  v_draft     public.web_order_drafts%ROWTYPE;
  v_restored  integer := 0;
  v_now       timestamptz := now();
  v_points_released integer := 0;
BEGIN
  IF v_reason IS NULL THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF NOT v_is_system THEN
    IF p_user_id IS NULL THEN
      RETURN jsonb_build_object('error', 'user_identity_required');
    END IF;
    IF NOT public.has_permission(p_user_id, 'confirm_web_order_ready') THEN
      RETURN jsonb_build_object('error', 'permission_denied');
    END IF;
  END IF;

  SELECT * INTO v_draft FROM public.web_order_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_draft.status <> 'to_confirm' THEN
    RETURN jsonb_build_object('error', 'not_open', 'status', v_draft.status);
  END IF;

  WITH released AS (
    UPDATE public.web_order_draft_lines l
       SET hold_state = 'released', released_at = v_now
     WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     RETURNING l.variant_id, l.qty
  ), per_variant AS (
    SELECT variant_id, sum(qty)::integer AS qty FROM released WHERE variant_id IS NOT NULL GROUP BY variant_id
  ), restored AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty + pv.qty, updated_at = v_now
      FROM per_variant pv
     WHERE v.id = pv.variant_id
     RETURNING v.id
  )
  SELECT count(*) INTO v_restored FROM restored;

  -- Points held by this draft go back to the customer (2026-10-05, owner):
  -- the pending redemption is cancelled, nothing was debited.
  UPDATE public.loyalty_redemptions
     SET status = 'cancelled', cancelled_at = v_now, cancelled_by_user_id = p_user_id,
         cancellation_reason = 'Website order ' || coalesce(v_draft.web_reference, '')
                               || ' was not confirmed (' || coalesce(v_reason, 'no reason given') || ') — points kept'
   WHERE web_draft_id = p_draft_id AND status = 'pending';
  GET DIAGNOSTICS v_points_released = ROW_COUNT;

  UPDATE public.web_order_drafts
     SET status = CASE WHEN v_is_system THEN 'expired' ELSE 'declined' END,
         decided_at = v_now, decided_by = p_user_id, decline_reason = v_reason, updated_at = v_now
   WHERE id = p_draft_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('web_order_draft', p_draft_id,
          CASE WHEN v_is_system THEN 'web_draft_expired' ELSE 'web_draft_declined' END,
          jsonb_build_object('web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                             'mode', v_draft.mode, 'reason', v_reason, 'stock_variants_restored', v_restored,
                              'points_redemptions_released', v_points_released,
                             'source', p_source),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'draft_id', p_draft_id, 'status',
                            CASE WHEN v_is_system THEN 'expired' ELSE 'declined' END,
                            'web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                            'mode', v_draft.mode, 'customer_id', v_draft.customer_id,
                            'customer_lang', v_draft.customer_lang, 'stock_variants_restored', v_restored,
                            'points_redemptions_released', v_points_released);
END
$function$;

-- ---------------------------------------------------------------------------
-- expire_web_layaway_atomic (live audit md5 a94e1b197a16)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expire_web_layaway_atomic(p_account_id uuid, p_source text DEFAULT 'system'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status    text;
  v_invoice   text;
  v_web_ref   text;
  v_paid      numeric;
  v_due       timestamptz;
  v_restored  integer := 0;
  v_cancelled integer := 0;
  v_now       timestamptz := now();
BEGIN
  SELECT status::text, invoice_number, web_reference, total_paid, transfer_due_at
    INTO v_status, v_invoice, v_web_ref, v_paid, v_due
    FROM public.layaway_accounts
   WHERE id = p_account_id AND source_channel = 'web'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_web_layaway');
  END IF;
  IF v_status <> 'active' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active', 'status', v_status);
  END IF;

  -- Money received, in either of the two places it can show: the cached total
  -- and the ledger itself. INVARIANT 1 makes payments authoritative, so both
  -- are checked and either one stops the expiry.
  -- Points (a LOYALTY- discount) are not money; a deposit wholly covered by
  -- points counts as paid (2026-10-05, owner).
  IF coalesce(v_paid, 0) > 0 AND public.layaway_deposit_started(p_account_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_paid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_account_id AND voided_at IS NULL
                AND coalesce(reference_number, '') NOT LIKE 'LOYALTY-%') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'payment_exists');
  END IF;

  -- INVARIANT 12: an account with an unconfirmed submission does not move.
  -- The customer may have transferred and be waiting on review; expiring the
  -- plan out from under that submission would release the piece and strand
  -- their money.
  IF EXISTS (SELECT 1 FROM public.payment_submissions
              WHERE account_id = p_account_id
                AND status IN ('submitted', 'under_review')) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'submission_pending');
  END IF;

  UPDATE public.layaway_accounts
     SET status     = 'cancelled',
         expired_at = v_now,
         updated_at = v_now,
         notes      = COALESCE(notes || E'\n', '')
                      || 'Expired ' || to_char(v_now AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                      || ' PHT — deposit not received by the deadline'
                      || COALESCE(' (' || to_char(v_due AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI') || ' PHT)', '')
   WHERE id = p_account_id;

  UPDATE public.layaway_schedule
     SET status = 'cancelled', updated_at = v_now
   WHERE account_id = p_account_id AND status IN ('pending', 'overdue');
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  -- Stock back on sale, once, from the lines this plan was holding.
  WITH restored AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND v.id = i.variant_id
     RETURNING v.id
  )
  SELECT count(*) INTO v_restored FROM restored;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_account_id, 'web_layaway_expired',
          jsonb_build_object(
            'invoice_number', v_invoice, 'web_reference', v_web_ref,
            'transfer_due_at', v_due, 'expired_at', v_now,
            'schedule_rows_cancelled', v_cancelled, 'stock_lines_restored', v_restored,
            'source', p_source),
          auth.uid());

  RETURN jsonb_build_object('ok', true, 'web_reference', v_web_ref,
                            'invoice_number', v_invoice,
                            'schedule_rows_cancelled', v_cancelled,
                            'stock_lines_restored', v_restored);
END $function$;

-- ---------------------------------------------------------------------------
-- file_paidy_submission_atomic (live audit md5 e829261582e7)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.file_paidy_submission_atomic(p_cash_order_id uuid, p_customer_id uuid, p_paidy_payment_id text, p_amount_jpy numeric, p_test boolean, p_authorized_at timestamp with time zone, p_expires_at timestamp with time zone, p_payload jsonb, p_payment_date date, p_sender_name text, p_notes text, p_path text DEFAULT 'website_paidy'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_rec     public.paidy_payments%ROWTYPE;
  v_sub     public.payment_submissions%ROWTYPE;
  v_outcome text := 'created';
  v_lock    text;
BEGIN
  IF p_paidy_payment_id IS NULL OR p_paidy_payment_id !~ '^pay_[A-Za-z0-9_-]{6,80}$' THEN
    RETURN jsonb_build_object('error', 'bad_id');
  END IF;
  -- R14: exact whole yen, never a rounded comparison.
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 OR p_amount_jpy <> trunc(p_amount_jpy) THEN
    RETURN jsonb_build_object('error', 'bad_amount');
  END IF;

  -- The order lock serialises every Paidy filing and payment on this order.
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id
   FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;

  SELECT * INTO v_rec FROM public.paidy_payments WHERE paidy_payment_id = p_paidy_payment_id FOR UPDATE;
  IF v_rec.id IS NOT NULL THEN
    IF v_rec.cash_order_id <> v_order.id OR v_rec.customer_id IS DISTINCT FROM p_customer_id THEN
      RETURN jsonb_build_object('error', 'paidy_payment_other_order');
    END IF;
    -- Already filed and still live: the retry gets the same submission back.
    SELECT * INTO v_sub FROM public.payment_submissions
     WHERE paidy_payment_id = v_rec.id AND status IN ('submitted','under_review','confirmed')
     ORDER BY created_at DESC LIMIT 1;
    IF v_sub.id IS NOT NULL THEN
      UPDATE public.paidy_checkout_attempts
         SET status = 'filed', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = 'filed'
       WHERE cash_order_id = v_order.id AND status = 'open';
      RETURN jsonb_build_object('ok', true, 'outcome', 'existing', 'paidy_record_id', v_rec.id,
        'submission', jsonb_build_object('id', v_sub.id, 'status', v_sub.status,
          'submitted_amount', v_sub.submitted_amount, 'payment_date', v_sub.payment_date));
    END IF;
    IF v_rec.status <> 'authorized' THEN
      RETURN jsonb_build_object('error', 'paidy_payment_not_authorized', 'status', v_rec.status);
    END IF;
    -- Rejected by a reviewer OR cancelled: a deliberate end, never recovered
    -- as an "interrupted filing" (R03).
    IF EXISTS (SELECT 1 FROM public.payment_submissions
                WHERE paidy_payment_id = v_rec.id AND status IN ('rejected','cancelled')) THEN
      RETURN jsonb_build_object('error', 'paidy_payment_rejected_by_reviewer');
    END IF;
    v_outcome := 'recovered';
  END IF;

  -- The order must still be able to take THIS payment (R15: checked on the
  -- locked row, not on what the caller read before).
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'order_cannot_take_payment', 'status', v_order.status::text,
                              'payment_status', v_order.payment_status);
  END IF;
  IF v_order.currency::text <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'order_not_jpy');
  END IF;
  -- Owner 2026-10-04: Paidy only while nothing has been paid on the order.
  IF v_order.total_paid - public.cash_order_points_paid(v_order.id) <> 0 THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'order_part_paid');
  END IF;
  IF coalesce(v_rec.amount_jpy, p_amount_jpy) <> v_order.remaining_balance THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'amount_differs_from_balance',
                              'amount_jpy', coalesce(v_rec.amount_jpy, p_amount_jpy), 'remaining_balance', v_order.remaining_balance);
  END IF;
  IF coalesce(p_expires_at, v_rec.expires_at, coalesce(p_authorized_at, now()) + interval '30 days') <= now() THEN
    RETURN jsonb_build_object('error', 'stale_authorization', 'detail', 'expired');
  END IF;

  -- The record is written BEFORE the one-payment check, so an authorisation
  -- that has to wait is still known to the Hub (the sweep files or releases it).
  IF v_rec.id IS NULL THEN
    INSERT INTO public.paidy_payments (cash_order_id, customer_id, paidy_payment_id, status, test,
                                       amount_jpy, authorized_at, expires_at, last_payload)
    VALUES (v_order.id, p_customer_id, p_paidy_payment_id, 'authorized', coalesce(p_test, false),
            p_amount_jpy, coalesce(p_authorized_at, now()), p_expires_at, p_payload)
    RETURNING * INTO v_rec;
  ELSE
    UPDATE public.paidy_payments
       SET expires_at = coalesce(p_expires_at, expires_at),
           last_payload = coalesce(p_payload, last_payload),
           updated_at = now()
     WHERE id = v_rec.id
    RETURNING * INTO v_rec;
  END IF;

  -- One payment at a time per order: anything else pending, any other Paidy
  -- authorisation or capture still open (the customer's own open Paidy window
  -- is this payment, so attempts are ignored here).
  v_lock := public.cash_order_payment_lock(v_order.id, v_rec.id, true);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'submission_pending', 'lock', v_lock, 'paidy_record_id', v_rec.id);
  END IF;

  INSERT INTO public.payment_submissions (account_id, cash_order_id, customer_id, submitted_amount,
         payment_date, payment_method, reference_number, sender_name, proof_url, notes, status,
         submission_type, paidy_payment_id)
  VALUES (NULL, v_order.id, p_customer_id, v_rec.amount_jpy, p_payment_date, 'paidy',
          v_rec.paidy_payment_id, p_sender_name, NULL, p_notes, 'submitted', 'cash_payment', v_rec.id)
  RETURNING * INTO v_sub;

  UPDATE public.paidy_checkout_attempts
     SET status = 'filed', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = 'filed'
   WHERE cash_order_id = v_order.id AND status = 'open';

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
  VALUES ('cash_payment_submission', v_sub.id, 'submission_created',
          jsonb_build_object('cash_order_id', v_order.id, 'invoice_number', v_order.invoice_number,
            'amount', v_rec.amount_jpy, 'method', 'paidy', 'reference', v_rec.paidy_payment_id,
            'path', coalesce(p_path, 'website_paidy'), 'outcome', v_outcome));

  RETURN jsonb_build_object('ok', true, 'outcome', v_outcome, 'paidy_record_id', v_rec.id,
    'submission', jsonb_build_object('id', v_sub.id, 'status', v_sub.status,
      'submitted_amount', v_sub.submitted_amount, 'payment_date', v_sub.payment_date));
END
$function$;

-- ---------------------------------------------------------------------------
-- materialize_web_draft_atomic (live audit md5 ad51ef01eff9)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.materialize_web_draft_atomic(p_draft_id uuid, p_user_id uuid, p_order jsonb, p_schedule jsonb DEFAULT NULL::jsonb, p_service_lines jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_draft     public.web_order_drafts%ROWTYPE;
  v_now       timestamptz := now();
  v_total     numeric(12,2);
  v_shipping  numeric(12,2);
  v_discount  numeric(12,2);
  v_due       timestamptz;
  v_date      date;
  v_loyalty   numeric;
  v_courier   uuid;
  v_notes     text;
  v_trade     boolean;
  v_dp        numeric(12,2);
  v_term      integer;
  v_end       date;
  v_sum       numeric(12,2);
  v_rows      integer;
  v_order_id  uuid;
  v_row       jsonb;
  v_n         integer;
  v_lines     integer;
  v_services  integer := 0;
  v_requests  integer := 0;
  v_rate      numeric;
  v_rate_date date;
  v_red       public.loyalty_redemptions%ROWTYPE;
  v_pts_value numeric(12,2) := 0;
  v_invoice   text;
  v_approve   jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT public.has_permission(p_user_id, 'confirm_web_order_ready') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_draft FROM public.web_order_drafts WHERE id = p_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_draft.status <> 'to_confirm' THEN
    RETURN jsonb_build_object('error', 'not_open', 'status', v_draft.status);
  END IF;
  IF NOT public.has_permission(p_user_id, CASE WHEN v_draft.mode = 'full' THEN 'create_cash_order' ELSE 'create_account' END) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT count(*) FILTER (WHERE hold_state = 'held'), count(*) INTO v_lines, v_n
    FROM public.web_order_draft_lines WHERE draft_id = p_draft_id;
  IF v_lines = 0 OR v_lines <> v_n THEN
    RETURN jsonb_build_object('error', 'hold_lost');
  END IF;

  p_order := coalesce(p_order, '{}'::jsonb);
  v_total    := (p_order ->> 'total_amount')::numeric;
  v_shipping := coalesce((p_order ->> 'shipping_fee')::numeric, 0);
  v_discount := coalesce((p_order ->> 'discount_amount')::numeric, 0);
  v_due      := (p_order ->> 'transfer_due_at')::timestamptz;
  v_date     := coalesce((p_order ->> 'order_date')::date, (v_now AT TIME ZONE 'Asia/Manila')::date);
  v_loyalty  := coalesce((p_order ->> 'loyalty_jpy_amount')::numeric, v_draft.subtotal_jpy);
  v_courier  := nullif(p_order ->> 'planned_shipping_method_id', '')::uuid;
  v_notes    := nullif(btrim(coalesce(p_order ->> 'notes', '')), '');
  v_trade    := coalesce((p_order ->> 'is_trade')::boolean, false);
  v_rate      := CASE WHEN v_draft.settlement_currency = 'PHP' THEN v_draft.fx_rate END;
  v_rate_date := CASE WHEN v_draft.settlement_currency = 'PHP' THEN v_draft.fx_rate_date END;

  IF v_total IS NULL OR v_total <= 0 THEN
    RETURN jsonb_build_object('error', 'total_required');
  END IF;
  IF v_shipping < 0 OR v_discount < 0 OR v_loyalty < 0 THEN
    RETURN jsonb_build_object('error', 'negative_amount');
  END IF;
  -- A deadline is moved, never removed (WEB LAYAWAY rule): Confirm starts it.
  IF v_due IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
  IF jsonb_typeof(coalesce(p_service_lines, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('error', 'service_lines_invalid');
  END IF;
  FOR v_row IN SELECT * FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) LOOP
    IF nullif(btrim(coalesce(v_row ->> 'title', '')), '') IS NULL
       OR coalesce((v_row ->> 'quantity')::numeric, 0) <= 0
       OR (v_row ->> 'quantity')::numeric <> trunc((v_row ->> 'quantity')::numeric)
       OR coalesce((v_row ->> 'unit_price_jpy')::numeric, -1) < 0
       OR coalesce((v_row ->> 'line_total_jpy')::numeric, -1) < 0 THEN
      RETURN jsonb_build_object('error', 'service_lines_invalid');
    END IF;
  END LOOP;

  -- POINTS chosen at checkout (2026-10-05, owner C3–C5): the draft's pending
  -- redemption is approved below, in this transaction. Checked first against
  -- the figures staff are confirming, so nothing is written if it cannot apply.
  IF v_draft.points_redemption_id IS NOT NULL THEN
    SELECT * INTO v_red FROM public.loyalty_redemptions WHERE id = v_draft.points_redemption_id FOR UPDATE;
    IF NOT FOUND OR v_red.status::text <> 'pending' THEN
      RETURN jsonb_build_object('error', 'points_hold_lost');
    END IF;
    v_pts_value := CASE WHEN v_draft.settlement_currency = 'PHP' THEN coalesce(v_red.value_applied_php, 0)
                        ELSE coalesce(v_red.value_applied_jpy, 0) END;
    IF v_draft.mode = 'layaway' THEN
      -- On a layaway the points pay the deposit, and may cover all of it.
      IF v_pts_value > coalesce((p_order ->> 'downpayment_amount')::numeric, 0) THEN
        RETURN jsonb_build_object('error', 'points_exceed_deposit', 'points_value', v_pts_value);
      END IF;
    ELSIF v_pts_value > v_total - v_shipping THEN
      -- C4: never on shipping.
      RETURN jsonb_build_object('error', 'points_exceed_total', 'points_value', v_pts_value);
    END IF;
  END IF;

  IF v_draft.mode = 'layaway' THEN
    v_dp   := (p_order ->> 'downpayment_amount')::numeric;
    v_term := coalesce((p_order ->> 'payment_plan_months')::integer, v_draft.term_months);
    IF v_term IS DISTINCT FROM v_draft.term_months THEN
      RETURN jsonb_build_object('error', 'term_locked', 'term_months', v_draft.term_months);
    END IF;
    IF v_draft.agreement_version IS NULL OR v_draft.agreement_signed_at IS NULL THEN
      RETURN jsonb_build_object('error', 'agreement_missing');
    END IF;
    IF v_dp IS NULL OR v_dp <= 0 THEN
      RETURN jsonb_build_object('error', 'downpayment_required');
    END IF;
    IF jsonb_typeof(coalesce(p_schedule, 'null'::jsonb)) <> 'array' THEN
      RETURN jsonb_build_object('error', 'schedule_required');
    END IF;
    SELECT count(*), coalesce(sum((s ->> 'amount')::numeric), 0), max((s ->> 'due_date')::date)
      INTO v_rows, v_sum, v_end
      FROM jsonb_array_elements(p_schedule) s;
    IF v_rows <> v_term
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_schedule) s
                   WHERE coalesce((s ->> 'amount')::numeric, 0) <= 0 OR (s ->> 'due_date') IS NULL)
       OR (SELECT count(DISTINCT (s ->> 'installment_number')::integer) FROM jsonb_array_elements(p_schedule) s
            WHERE (s ->> 'installment_number')::integer BETWEEN 1 AND v_term) <> v_term THEN
      RETURN jsonb_build_object('error', 'schedule_invalid');
    END IF;
    IF v_dp + v_sum <> v_total THEN
      RETURN jsonb_build_object('error', 'schedule_mismatch', 'total_amount', v_total,
                                'downpayment', v_dp, 'installments', v_sum);
    END IF;
    v_end := coalesce((p_order ->> 'end_date')::date, v_end);

    INSERT INTO public.layaway_accounts (
      invoice_number, customer_id, currency, total_amount, payment_plan_months,
      order_date, end_date, status, total_paid, remaining_balance,
      downpayment_amount, loyalty_jpy_amount, shipping_fee,
      discount_amount, discount_type, discount_value,
      source_channel, web_reference, quote_id, transfer_due_at, ship_to_snapshot,
      customer_lang, fx_rate_used, fx_rate_date, notes, is_trade,
      agreement_version, agreement_acceptance_date,
      ready_confirmed_at, ready_confirmed_by, created_by_user_id, planned_shipping_method_id
    ) VALUES (
      v_draft.invoice_seq::text, v_draft.customer_id, v_draft.settlement_currency::account_currency, v_total, v_term,
      v_date, v_end, 'active', 0, v_total,
      v_dp, v_loyalty, v_shipping,
      v_discount, nullif(p_order ->> 'discount_type', ''), (p_order ->> 'discount_value')::numeric,
      'web', v_draft.web_reference, v_draft.quote_id, v_due, v_draft.ship_to_snapshot,
      v_draft.customer_lang, v_rate, v_rate_date,
      'Website layaway ' || v_draft.web_reference || coalesce(E'\n' || v_notes, ''), v_trade,
      v_draft.agreement_version, v_draft.agreement_signed_at,
      v_now, p_user_id, p_user_id, v_courier
    ) RETURNING id INTO v_order_id;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_schedule) ORDER BY (value ->> 'installment_number')::integer LOOP
      INSERT INTO public.layaway_schedule (
        account_id, installment_number, due_date, base_installment_amount,
        penalty_amount, total_due_amount, paid_amount, currency, status
      ) VALUES (
        v_order_id, (v_row ->> 'installment_number')::integer, (v_row ->> 'due_date')::date,
        (v_row ->> 'amount')::numeric, 0, (v_row ->> 'amount')::numeric, 0,
        v_draft.settlement_currency::account_currency, 'pending'
      );
    END LOOP;

    INSERT INTO public.layaway_account_items (account_id, website_product_id, variant_id, title, sku, quantity,
                                              unit_price_jpy, line_total_jpy, image_url)
    SELECT v_order_id, l.website_product_id, l.variant_id, l.title, l.sku, l.qty, l.unit_price_jpy, l.line_total_jpy, l.image_url
      FROM public.web_order_draft_lines l WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     ORDER BY l.created_at, l.id;

    INSERT INTO public.layaway_account_items (account_id, title, quantity, unit_price_jpy, line_total_jpy)
    SELECT v_order_id, btrim(s ->> 'title'), (s ->> 'quantity')::integer,
           (s ->> 'unit_price_jpy')::numeric, (s ->> 'line_total_jpy')::numeric
      FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) s;
    GET DIAGNOSTICS v_services = ROW_COUNT;
  ELSE
    INSERT INTO public.cash_orders (
      invoice_number, customer_id, currency, total_amount, total_paid,
      remaining_balance, status, source_channel, order_type, payment_method,
      payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
      gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
      discount_amount, discount_type, discount_value,
      loyalty_jpy_amount, item_description, order_date, customer_lang, notes, is_trade,
      ready_confirmed_at, ready_confirmed_by, created_by_user_id, fx_rate_used, fx_rate_date,
      planned_shipping_method_id
    ) VALUES (
      v_draft.invoice_seq::text, v_draft.customer_id, v_draft.settlement_currency::account_currency, v_total, 0,
      v_total, 'pending'::cash_order_status, 'web', v_draft.order_type, coalesce(v_draft.payment_method, 'transfer'),
      'pending_transfer', v_draft.ship_to_address_id, v_draft.ship_to_snapshot, v_draft.recipient_name, v_draft.recipient_phone,
      -- expires_at = transfer_due_at: the deadline the expiry cron reads.
      v_draft.gift_note, v_draft.quote_id, v_draft.web_reference, v_due, v_due, v_shipping,
      v_discount, nullif(p_order ->> 'discount_type', ''), (p_order ->> 'discount_value')::numeric,
      v_loyalty, 'Website order ' || v_draft.web_reference, v_date, v_draft.customer_lang, v_notes, v_trade,
      v_now, p_user_id, p_user_id, v_rate, v_rate_date,
      v_courier
    ) RETURNING id INTO v_order_id;

    INSERT INTO public.cash_order_items (cash_order_id, website_product_id, variant_id, title, sku, quantity,
                                         unit_price_jpy, line_total_jpy, image_url)
    SELECT v_order_id, l.website_product_id, l.variant_id, l.title, l.sku, l.qty, l.unit_price_jpy, l.line_total_jpy, l.image_url
      FROM public.web_order_draft_lines l WHERE l.draft_id = p_draft_id AND l.hold_state = 'held'
     ORDER BY l.created_at, l.id;

    INSERT INTO public.cash_order_items (cash_order_id, title, quantity, unit_price_jpy, line_total_jpy)
    SELECT v_order_id, btrim(s ->> 'title'), (s ->> 'quantity')::integer,
           (s ->> 'unit_price_jpy')::numeric, (s ->> 'line_total_jpy')::numeric
      FROM jsonb_array_elements(coalesce(p_service_lines, '[]'::jsonb)) s;
    GET DIAGNOSTICS v_services = ROW_COUNT;
  END IF;

  -- The checkout's points, approved now (owner C5): the redemption is linked
  -- to the new order and approve_redemption_atomic writes the LOYALTY-
  -- discount, nets the loyalty basis and consumes the lots, all in this
  -- transaction. Any refusal (e.g. insufficient_points) rolls back the Confirm.
  IF v_draft.points_redemption_id IS NOT NULL THEN
    IF v_draft.mode = 'full' THEN
      SELECT invoice_number INTO v_invoice FROM public.cash_orders WHERE id = v_order_id;
    ELSE
      SELECT invoice_number INTO v_invoice FROM public.layaway_accounts WHERE id = v_order_id;
    END IF;
    UPDATE public.loyalty_redemptions
       SET cash_order_id  = CASE WHEN v_draft.mode = 'full' THEN v_order_id END,
           account_id     = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END,
           invoice_number = v_invoice
     WHERE id = v_red.id;
    v_approve := public.approve_redemption_atomic(v_red.id, p_user_id, 'Website checkout points');
  END IF;

  -- The hold becomes the order's: NO second stock movement (risk 3). From here
  -- page365_web_holds counts the order line instead of the draft line.
  UPDATE public.web_order_draft_lines
     SET hold_state = 'transferred', transferred_at = v_now
   WHERE draft_id = p_draft_id AND hold_state = 'held';

  UPDATE public.web_order_drafts
     SET status = 'confirmed', decided_at = v_now, decided_by = p_user_id, updated_at = v_now,
         cash_order_id      = CASE WHEN v_draft.mode = 'full'    THEN v_order_id END,
         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END
   WHERE id = p_draft_id;

  -- A service request filed on the draft now belongs to the order (W2-5).
  UPDATE public.service_requests
     SET cash_order_id      = CASE WHEN v_draft.mode = 'full'    THEN v_order_id ELSE cash_order_id END,
         layaway_account_id = CASE WHEN v_draft.mode = 'layaway' THEN v_order_id ELSE layaway_account_id END,
         updated_at = v_now
   WHERE web_draft_id = p_draft_id;
  GET DIAGNOSTICS v_requests = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('web_order_draft', p_draft_id, 'web_draft_confirmed',
          jsonb_build_object('web_reference', v_draft.web_reference, 'invoice_number', v_draft.invoice_seq::text,
                             'mode', v_draft.mode,
                             'entity_type', CASE WHEN v_draft.mode = 'full' THEN 'cash_order' ELSE 'layaway_account' END,
                             'entity_id', v_order_id, 'currency', v_draft.settlement_currency,
                             'quoted_total', v_draft.total, 'total_amount', v_total,
                             'shipping_fee', v_shipping, 'discount_amount', v_discount,
                             'service_lines', v_services, 'service_requests_moved', v_requests,
                             'transfer_due_at', v_due, 'planned_shipping_method_id', v_courier,
                             'payment_method', v_draft.payment_method, 'points', v_draft.points,
                             'points_value', v_pts_value),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'draft_id', p_draft_id,
                            'entity_type', CASE WHEN v_draft.mode = 'full' THEN 'cash_order' ELSE 'layaway_account' END,
                            'entity_id', v_order_id,
                            'order_id',   CASE WHEN v_draft.mode = 'full'    THEN v_order_id END,
                            'account_id', CASE WHEN v_draft.mode = 'layaway' THEN v_order_id END,
                            'invoice_number', v_draft.invoice_seq::text, 'web_reference', v_draft.web_reference,
                            'service_lines', v_services, 'service_requests_moved', v_requests,
                            'payment_method', v_draft.payment_method, 'points', v_draft.points,
                            'points_value', v_pts_value, 'points_approval', v_approve);
END
$function$;

-- ---------------------------------------------------------------------------
-- page365_web_holds (live audit md5 68ae64c8e3ed)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_web_holds(p_variant_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (
    coalesce((SELECT sum(i.quantity) FROM public.cash_order_items i
                JOIN public.cash_orders o ON o.id = i.cash_order_id
               WHERE i.variant_id = p_variant_id AND o.source_channel = 'web' AND o.status = 'pending'), 0)
  + coalesce((SELECT sum(i.quantity) FROM public.layaway_account_items i
                JOIN public.layaway_accounts a ON a.id = i.account_id
               WHERE i.variant_id = p_variant_id AND a.source_channel = 'web' AND a.stock_released_at IS NULL
                 AND a.status IN ('active','overdue') AND NOT public.layaway_deposit_started(a.id)), 0)
  + coalesce((SELECT sum(l.qty) FROM public.web_order_draft_lines l
               WHERE l.variant_id = p_variant_id AND l.hold_state = 'held'), 0)
  )::integer
$function$;

-- ---------------------------------------------------------------------------
-- reactivate_web_layaway_atomic (live audit md5 a96ba3cffc28)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reactivate_web_layaway_atomic(p_account_id uuid, p_transfer_due_at timestamp with time zone, p_reason text, p_user_id uuid DEFAULT NULL::uuid, p_source text DEFAULT 'staff'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status    text;
  v_expired   timestamptz;
  v_invoice   text;
  v_web_ref   text;
  v_paid      numeric;
  v_old_due   timestamptz;
  v_short     jsonb;
  v_taken     integer := 0;
  v_restored  integer := 0;
  v_reason    text := btrim(coalesce(p_reason, ''));
  v_now       timestamptz := now();
BEGIN
  IF v_reason = '' THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;
  IF p_transfer_due_at <= v_now THEN
    RETURN jsonb_build_object('error', 'deadline_in_past', 'transfer_due_at', p_transfer_due_at);
  END IF;

  SELECT status::text, expired_at, invoice_number, web_reference, total_paid, transfer_due_at
    INTO v_status, v_expired, v_invoice, v_web_ref, v_paid, v_old_due
    FROM public.layaway_accounts
   WHERE id = p_account_id AND source_channel = 'web'
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_web_layaway');
  END IF;

  IF v_status <> 'cancelled' OR v_expired IS NULL THEN
    RETURN jsonb_build_object('error', 'not_expired', 'status', v_status,
                              'expired_at', v_expired);
  END IF;

  -- Points are not money; a deposit wholly covered by points counts as paid.
  IF coalesce(v_paid, 0) > 0 AND public.layaway_deposit_started(p_account_id) THEN
    RETURN jsonb_build_object('error', 'already_paid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_account_id AND voided_at IS NULL
                AND coalesce(reference_number, '') NOT LIKE 'LOYALTY-%') THEN
    RETURN jsonb_build_object('error', 'payment_exists');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'variant_id', i.variant_id, 'title', i.title, 'sku', i.sku,
           'wanted', i.quantity, 'available', coalesce(v.stock_qty, 0)))
    INTO v_short
    FROM public.layaway_account_items i
    LEFT JOIN public.website_product_variants v ON v.id = i.variant_id
   WHERE i.account_id = p_account_id
     AND (v.id IS NULL OR v.stock_qty < i.quantity);
  IF v_short IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'out_of_stock', 'lines', v_short);
  END IF;

  WITH taken AS (
    UPDATE public.website_product_variants v
       SET stock_qty = v.stock_qty - i.quantity, updated_at = v_now
      FROM public.layaway_account_items i
     WHERE i.account_id = p_account_id AND v.id = i.variant_id
       AND v.stock_qty >= i.quantity
     RETURNING v.id
  )
  SELECT count(*) INTO v_taken FROM taken;

  SELECT count(*) INTO v_restored
    FROM public.layaway_account_items WHERE account_id = p_account_id;

  IF v_taken <> v_restored THEN
    RAISE EXCEPTION 'reactivate_web_layaway: took % of % lines — a piece sold during the reactivation; nothing applied', v_taken, v_restored;
  END IF;

  UPDATE public.layaway_accounts
     SET status          = 'active',
         expired_at      = NULL,
         transfer_due_at = p_transfer_due_at,
         updated_at      = v_now,
         notes           = COALESCE(notes || E'\n', '')
                           || 'Reactivated ' || to_char(v_now AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                           || ' PHT — new deposit deadline '
                           || to_char(p_transfer_due_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD HH24:MI')
                           || ' PHT — ' || v_reason
   WHERE id = p_account_id;

  UPDATE public.layaway_schedule
     SET status = 'pending', updated_at = v_now
   WHERE account_id = p_account_id AND status = 'cancelled';
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  INSERT INTO public.audit_logs (entity_type, entity_id, action,
                                 old_value_json, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_account_id, 'web_layaway_reactivated',
          jsonb_build_object('status', 'cancelled', 'expired_at', v_expired,
                             'transfer_due_at', v_old_due),
          jsonb_build_object('status', 'active', 'expired_at', NULL,
                             'transfer_due_at', p_transfer_due_at,
                             'invoice_number', v_invoice, 'web_reference', v_web_ref,
                             'schedule_rows_restored', v_restored,
                             'stock_lines_taken', v_taken,
                             'reason', v_reason, 'source', p_source),
          coalesce(p_user_id, auth.uid()));

  RETURN jsonb_build_object('ok', true,
                            'web_reference', v_web_ref,
                            'invoice_number', v_invoice,
                            'transfer_due_at', p_transfer_due_at,
                            'schedule_rows_restored', v_restored,
                            'stock_lines_taken', v_taken);
END $function$;

-- ---------------------------------------------------------------------------
-- reserve_square_attempt (live audit md5 e340acb8792e)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_square_attempt(p_cash_order_id uuid, p_customer_id uuid, p_amount_jpy bigint, p_environment text, p_location_id text, p_app_id text, p_test boolean, p_idempotency_key text, p_reference text, p_verification text, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order  public.cash_orders%ROWTYPE;
  v_att    public.square_card_attempts%ROWTYPE;
  v_counts jsonb;
BEGIN
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 THEN RETURN jsonb_build_object('error', 'bad_amount'); END IF;
  IF p_environment IS NULL OR p_environment NOT IN ('sandbox','production') THEN
    RETURN jsonb_build_object('error', 'bad_environment');
  END IF;
  IF coalesce(p_location_id, '') = '' THEN RETURN jsonb_build_object('error', 'bad_location'); END IF;
  IF p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 45
     OR p_reference IS NULL OR char_length(p_reference) NOT BETWEEN 8 AND 40 THEN
    RETURN jsonb_build_object('error', 'bad_key');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_cash_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;

  -- Same request again (same order + same card token → same key): hand back
  -- the attempt; the caller replays the SAME immutable request or reports its
  -- recorded outcome. Never a second commitment.
  SELECT * INTO v_att FROM public.square_card_attempts WHERE idempotency_key = p_idempotency_key;
  IF v_att.id IS NOT NULL THEN
    IF v_att.cash_order_id <> p_cash_order_id THEN RETURN jsonb_build_object('error', 'bad_key'); END IF;
    RETURN jsonb_build_object('ok', true, 'outcome', 'existing', 'attempt', to_jsonb(v_att));
  END IF;

  IF v_order.customer_id IS DISTINCT FROM p_customer_id THEN RETURN jsonb_build_object('error', 'wrong_customer'); END IF;
  IF v_order.status::text <> 'pending' THEN
    RETURN jsonb_build_object('error', 'order_not_payable', 'status', v_order.status::text);
  END IF;
  -- The customer chose how to pay at checkout (2026-10-05, owner C1).
  IF v_order.source_channel = 'web' AND coalesce(v_order.payment_method, 'transfer') <> 'square' THEN
    RETURN jsonb_build_object('error', 'method_not_chosen', 'payment_method', coalesce(v_order.payment_method, 'transfer'));
  END IF;
  IF v_order.currency::text <> 'JPY' THEN RETURN jsonb_build_object('error', 'not_jpy'); END IF;
  -- Integer yen only (SQ12): a fractional balance is never rounded into a card amount.
  IF v_order.remaining_balance <> trunc(v_order.remaining_balance) THEN
    RETURN jsonb_build_object('error', 'fractional_balance', 'remaining_balance', v_order.remaining_balance);
  END IF;
  IF v_order.remaining_balance <> p_amount_jpy::numeric THEN
    RETURN jsonb_build_object('error', 'amount_changed', 'remaining_balance', v_order.remaining_balance);
  END IF;

  -- Nothing while Paidy holds the order (Paidy follow-up owner rule): a Paidy
  -- window open, an authorisation waiting, a capture not yet recorded.
  IF coalesce(public.cash_order_payment_lock(p_cash_order_id), '') LIKE 'paidy%' THEN
    RETURN jsonb_build_object('error', 'paidy_in_progress', 'lock', public.cash_order_payment_lock(p_cash_order_id));
  END IF;

  SELECT * INTO v_att FROM public.square_card_attempts
   WHERE cash_order_id = p_cash_order_id AND status IN ('reserved','unknown','cancelling')
   ORDER BY created_at DESC LIMIT 1;
  IF v_att.id IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'attempt_in_progress', 'attempt', to_jsonb(v_att));
  END IF;
  IF EXISTS (SELECT 1 FROM public.square_payments
              WHERE cash_order_id = p_cash_order_id
                AND (status = 'authorized' OR (status = 'captured' AND cash_payment_id IS NULL AND exception_resolved_at IS NULL))) THEN
    RETURN jsonb_build_object('error', 'card_hold_active');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_submissions
              WHERE cash_order_id = p_cash_order_id
                AND (status::text IN ('submitted','under_review')
                     OR (status::text = 'confirmed' AND confirmed_payment_id IS NULL))) THEN
    RETURN jsonb_build_object('error', 'submission_pending');
  END IF;

  v_counts := public.square_refusal_counts(p_cash_order_id, p_customer_id);
  IF (v_counts->>'order_failures')::int >= 5 THEN
    RETURN jsonb_build_object('error', 'too_many_attempts', 'scope', 'order', 'counts', v_counts);
  END IF;
  IF (v_counts->>'customer_refusals')::int >= 10 THEN
    RETURN jsonb_build_object('error', 'too_many_attempts', 'scope', 'customer', 'counts', v_counts);
  END IF;

  INSERT INTO public.square_card_attempts (cash_order_id, customer_id, reference, idempotency_key, amount_jpy,
         environment, location_id, app_id, test, status, verification, evidence)
  VALUES (p_cash_order_id, p_customer_id, p_reference, p_idempotency_key, p_amount_jpy,
          p_environment, p_location_id, p_app_id, coalesce(p_test, false), 'reserved', p_verification,
          coalesce(p_evidence, '{}'::jsonb))
  RETURNING * INTO v_att;

  RETURN jsonb_build_object('ok', true, 'outcome', 'reserved', 'attempt', to_jsonb(v_att));
END
$function$;

-- ---------------------------------------------------------------------------
-- set_account_deadlines (live audit md5 3d522322afe3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_account_deadlines(p_entity_type text, p_entity_id uuid, p_transfer_due_at timestamp with time zone, p_reason text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_old  jsonb;
  v_new  jsonb;
  v_status text;
  v_paid numeric;
  v_channel text;
  v_ready timestamptz;
BEGIN
  IF p_entity_type NOT IN ('layaway', 'cash_order') THEN
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;

  -- A deadline is moved, never removed (20260915140000).
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;

  IF p_entity_type = 'layaway' THEN
    SELECT status::text, total_paid,
           jsonb_build_object('transfer_due_at', transfer_due_at),
           source_channel, ready_confirmed_at
      INTO v_status, v_paid, v_old, v_channel, v_ready
      FROM public.layaway_accounts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- Live only. 'cancelled', 'completed', 'forfeited', 'final_forfeited' and
    -- 'final_settlement' are endings, not states a new deadline can reopen.
    IF v_status NOT IN ('active', 'overdue', 'extension_active', 'reactivated') THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;

    -- RESERVE-FIRST (A1): a web reservation has no deadline to move until staff
    -- confirm it ready for dispatch. Confirming is what starts the deadline.
    IF v_channel = 'web' AND v_ready IS NULL THEN
      RETURN jsonb_build_object('error', 'not_ready');
    END IF;

    -- Money received ends this deadline's job, and 'active' does not say so.
    -- Both places it can show, exactly as expire_web_layaway_atomic checks them.
    -- Points are not money; a deposit wholly covered by points counts as paid.
    IF coalesce(v_paid, 0) > 0 AND public.layaway_deposit_started(p_entity_id) THEN
      RETURN jsonb_build_object('error', 'already_paid', 'total_paid', v_paid);
    END IF;
    IF EXISTS (SELECT 1 FROM public.payments
                WHERE account_id = p_entity_id AND voided_at IS NULL
                  AND coalesce(reference_number, '') NOT LIKE 'LOYALTY-%') THEN
      RETURN jsonb_build_object('error', 'payment_exists');
    END IF;

    UPDATE public.layaway_accounts
       SET transfer_due_at = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at);
  ELSE
    SELECT status::text,
           jsonb_build_object('transfer_due_at', transfer_due_at, 'expires_at', expires_at),
           source_channel, ready_confirmed_at
      INTO v_status, v_old, v_channel, v_ready
      FROM public.cash_orders WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_status <> 'pending' THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;
    -- RESERVE-FIRST (A1): same refusal as the layaway branch.
    IF v_channel = 'web' AND v_ready IS NULL THEN
      RETURN jsonb_build_object('error', 'not_ready');
    END IF;
    -- No already_paid test here. See the header: a partially-paid pending cash
    -- order still expires, so its deadline is still live and still moveable.

    -- BOTH columns, deliberately. create_web_order_atomic writes the same value
    -- to each and the expiry cron reads expires_at; moving only transfer_due_at
    -- would show the customer a new deadline while the cron still cancelled on
    -- the old one.
    UPDATE public.cash_orders
       SET transfer_due_at = p_transfer_due_at,
           expires_at      = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at, 'expires_at', p_transfer_due_at);
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_entity_type = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END,
          p_entity_id, 'deadlines_updated', v_old,
          v_new || jsonb_build_object('reason', p_reason),
          COALESCE(p_user_id, auth.uid()));

  RETURN jsonb_build_object(
    'ok', true, 'old', v_old, 'new', v_new,
    -- Observation A: the caller is told when it has just armed the hourly job.
    'deadline_in_past', p_transfer_due_at < now());
END $function$;

-- ---------------------------------------------------------------------------
-- start_paidy_checkout_attempt (live audit md5 87674e0bad4b)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_paidy_checkout_attempt(p_cash_order_id uuid, p_customer_id uuid, p_ttl_minutes integer DEFAULT 30)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_lock    text;
  v_attempt public.paidy_checkout_attempts%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('error', 'order_not_found'); END IF;
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('error', 'order_cannot_take_payment');
  END IF;
  -- The customer chose how to pay at checkout (2026-10-05, owner C1): a
  -- website order takes Paidy only when Paidy is its method; staff change it.
  IF v_order.source_channel = 'web' AND coalesce(v_order.payment_method, 'transfer') <> 'paidy' THEN
    RETURN jsonb_build_object('error', 'method_not_chosen', 'payment_method', coalesce(v_order.payment_method, 'transfer'));
  END IF;
  IF v_order.currency::text <> 'JPY' OR v_order.total_paid - public.cash_order_points_paid(v_order.id) <> 0
     OR v_order.remaining_balance <= 0 OR v_order.remaining_balance <> trunc(v_order.remaining_balance) THEN
    RETURN jsonb_build_object('error', 'paidy_not_offered');
  END IF;

  UPDATE public.paidy_checkout_attempts
     SET status = 'expired', ended_at = now(), end_reason = 'timeout'
   WHERE cash_order_id = v_order.id AND status = 'open' AND expires_at <= now();

  v_lock := public.cash_order_payment_lock(v_order.id);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', v_lock);
  END IF;

  BEGIN
    INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, amount_jpy, expires_at)
    VALUES (v_order.id, p_customer_id, v_order.remaining_balance,
            now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes, 30), 60))))
    RETURNING * INTO v_attempt;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'payment_in_progress', 'lock', 'paidy_checkout_open');
  END;
  RETURN jsonb_build_object('ok', true, 'attempt_id', v_attempt.id, 'expires_at', v_attempt.expires_at,
                            'amount_jpy', v_attempt.amount_jpy);
END
$function$;

-- ---------------------------------------------------------------------------
-- terminate_web_order_atomic (live audit md5 0b218bcd85a3)
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
  v_points_to_revoke numeric := 0; v_spend_to_reverse numeric := 0;
  v_reason text; v_is_system boolean; v_stock_lines integer := 0; v_restored integer := 0;
  v_flipped integer := 0; v_now timestamptz := now();
BEGIN
  IF p_outcome NOT IN ('expired','cancelled') THEN
    RAISE EXCEPTION 'bad_outcome: %', p_outcome USING ERRCODE='P0001';
  END IF;
  v_is_system := (p_source IN ('system','shopify_webhook'));

  SELECT status::text, currency, customer_id, invoice_number, web_reference, total_paid
    INTO v_status, v_currency, v_customer_id, v_invoice, v_web_ref, v_total_paid
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
    -- Store credit is minted ONLY when staff choose "store credit issued"
    -- (money received, minus credit already minted by Shopify partial refunds).
    -- A refund never doubles as credit; "no refund" is a forfeiture and mints
    -- nothing. Never automatic (owner decision 2026-09-13).
    IF p_refund_status = 'store_credit_issued' THEN
      v_issue_amount := GREATEST(0, v_money_received - v_partial_credit);
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
      'store_credit_issued', v_credit, 'earned_points_revoked_tx', v_revoked_tx,
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
    'store_credit', v_credit, 'earned_points_revoked_tx', v_revoked_tx,
    'earned_points_revoked', v_points_to_revoke,
    'lifetime_spend_reversed_jpy', v_spend_to_reverse,
    'lines_restored', v_restored, 'source', p_source);
END;
$function$;

-- ---------------------------------------------------------------------------
-- web_payment_reminder_eligible (live audit md5 8fa12b81f07c)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.web_payment_reminder_eligible(p_entity_type text, p_entity_id uuid)
 RETURNS TABLE(entity_type text, entity_id uuid, deadline timestamp with time zone, reference text, customer_id uuid, email text, is_test boolean, lang text, currency text, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH e AS (
    SELECT 'cash_order'::text AS entity_type, o.id AS entity_id, o.transfer_due_at AS deadline,
           o.ready_confirmed_at, coalesce(o.web_reference, o.invoice_number::text) AS reference,
           o.customer_id, btrim(cu.email) AS email, coalesce(cu.is_test, false) AS is_test,
           CASE WHEN o.customer_lang = 'en' THEN 'en' ELSE 'ja' END AS lang,   -- pickLang: anything but 'en' is 'ja'
           o.currency::text AS currency, o.remaining_balance AS amount
      FROM public.cash_orders o
      JOIN public.customers cu ON cu.id = o.customer_id
     WHERE (p_entity_type IS NULL OR p_entity_type = 'cash_order')
       AND (p_entity_id IS NULL OR o.id = p_entity_id)
       AND o.source_channel = 'web'
       AND o.status::text = 'pending'
       AND o.payment_status = 'pending_transfer'
       AND o.ready_confirmed_at IS NOT NULL
       AND o.transfer_due_at IS NOT NULL
       AND o.remaining_balance > 0
       AND o.web_released_at IS NULL   -- W2-7: a part-paid web order is not chased
       AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                        WHERE s.cash_order_id = o.id AND s.status::text IN ('submitted','under_review'))
    UNION ALL
    SELECT 'layaway'::text, a.id, a.transfer_due_at,
           a.ready_confirmed_at, coalesce(a.web_reference, a.invoice_number::text),
           a.customer_id, btrim(cu.email), coalesce(cu.is_test, false),
           'en'::text,                                   -- layaway emails are English only, always
           a.currency::text, a.downpayment_amount - public.layaway_points_paid(a.id)
      FROM public.layaway_accounts a
      JOIN public.customers cu ON cu.id = a.customer_id
     WHERE (p_entity_type IS NULL OR p_entity_type = 'layaway')
       AND (p_entity_id IS NULL OR a.id = p_entity_id)
       AND a.source_channel = 'web'
       AND a.status::text = 'active'
       AND a.ready_confirmed_at IS NOT NULL
       AND a.transfer_due_at IS NOT NULL
       AND NOT public.layaway_deposit_started(a.id)   -- points are not money (2026-10-05)
       AND a.downpayment_amount > 0
       AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                        WHERE s.account_id = a.id AND s.status::text IN ('submitted','under_review'))
       AND NOT EXISTS (SELECT 1 FROM public.payment_submission_allocations psa
                         JOIN public.payment_submissions s ON s.id = psa.submission_id
                        WHERE psa.account_id = a.id AND s.status::text IN ('submitted','under_review'))
  )
  SELECT e.entity_type, e.entity_id, e.deadline, e.reference, e.customer_id, e.email, e.is_test,
         e.lang, e.currency, e.amount
    FROM e
   WHERE e.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     -- the storefront test gate: a test customer only at an owner-readable address
     AND (NOT e.is_test OR lower(e.email) = 'chajewelsjapan@gmail.com' OR lower(e.email) LIKE '%@chajewelsjp.com')
     AND e.currency IN ('JPY','PHP')
     AND e.deadline > now() + interval '1 hour'
     AND e.deadline - now() <= CASE WHEN e.deadline - e.ready_confirmed_at <= interval '30 hours'
                                    THEN interval '6 hours' ELSE interval '24 hours' END
     AND NOT EXISTS (SELECT 1 FROM public.web_payment_reminders r
                      WHERE r.entity_type = e.entity_type AND r.entity_id = e.entity_id AND r.deadline = e.deadline)
     AND (SELECT count(*) FROM public.web_payment_reminders r
           WHERE r.entity_type = e.entity_type AND r.entity_id = e.entity_id) < 2
$function$;
