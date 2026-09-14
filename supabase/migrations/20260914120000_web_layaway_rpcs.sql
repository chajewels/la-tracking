-- Web layaway RPCs (Phase 2 step 4, commit 3 of 3).
--
-- Three functions, all SECURITY DEFINER and service-role only, called by the
-- `website`, `auto-expire-cash-orders` and `set-account-deadlines` edge
-- functions. They are the layaway twins of create_web_order_atomic /
-- expire_web_order_atomic, and they follow the same rule: everything that
-- matters happens inside one transaction, and the storefront's numbers are
-- RECOMPUTED here rather than trusted.

-- ============================================================================
-- create_web_layaway_atomic — a reservation becomes a layaway account
-- ============================================================================
CREATE OR REPLACE FUNCTION public.create_web_layaway_atomic(
  p_customer_id       uuid,
  p_quote_id          uuid,
  p_lang              text        DEFAULT NULL,
  p_transfer_due_at   timestamptz DEFAULT NULL,
  p_settlement_due_at timestamptz DEFAULT NULL,
  -- The caller passes PHT today (CLAUDE.md TIMEZONE STANDARD) and passes the
  -- SAME date it quoted with. Left to CURRENT_DATE the quote and the account
  -- could land on different days either side of UTC midnight, and every due
  -- date in the schedule would shift with it.
  p_order_date        date        DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_quote      public.checkout_quotes%ROWTYPE;
  v_item       jsonb;
  v_variant    public.website_product_variants%ROWTYPE;
  v_qty        integer;
  v_updated    integer;
  v_seq        bigint;
  v_invoice    text;
  v_reference  text;
  v_account_id uuid;
  v_lang       text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
  v_cur        text;
  v_rate       numeric;
  v_total      integer;   -- in the settlement currency
  v_shipping   integer;   -- in the settlement currency
  v_subtotal   integer;   -- in the settlement currency
  v_quote_out  jsonb;
  v_term       integer;
  v_deposit    integer;
  v_due        timestamptz;
  v_end_date   date;
  v_title      text;
  v_row        jsonb;
  v_order_date date := COALESCE(p_order_date, CURRENT_DATE);
BEGIN
  -- Lock the quote so a double-submit cannot produce two plans from it.
  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
    -- Same answer as a missing quote: never confirm that someone else's exists.
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode <> 'layaway' THEN
    RETURN jsonb_build_object('error', 'not_a_layaway_quote');
  END IF;
  IF v_quote.shipping_jpy IS NULL THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;
  IF coalesce(v_quote.total_jpy, 0) <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;

  -- Settlement currency. The catalog is yen; a peso plan converts at the rate
  -- captured on the quote — the rate the customer was shown. Shipping is
  -- converted and the subtotal is the remainder, so the two always sum to the
  -- total exactly (converting each and adding can differ by one unit).
  v_cur := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_cur = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := round(coalesce(v_quote.shipping_jpy, 0) * v_rate);
    v_subtotal := v_total - v_shipping;
  ELSE
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := coalesce(v_quote.shipping_jpy, 0);
    v_subtotal := v_total - v_shipping;
  END IF;

  -- The terms, deposit and schedule are RECOMPUTED from the same function the
  -- storefront quoted with. The quote's stored jsonb is display history; it is
  -- never the source of what gets written.
  v_quote_out := public.layaway_quote(
    v_subtotal, v_quote.term_months, v_cur, v_order_date, v_shipping, 0
  );
  -- Two ways this basket can fail the plan rules, and both are the same
  -- refusal: nothing is sellable at this amount, or the term the customer
  -- agreed to is not reachable and layaway_quote fell back to a shorter one.
  -- A shorter term means bigger monthly payments than the customer accepted,
  -- so it is never written silently.
  IF NOT coalesce((v_quote_out->>'eligible')::boolean, false)
     OR coalesce((v_quote_out->>'term_downgraded')::boolean, false) THEN
    RETURN jsonb_build_object(
      'error', 'below_plan_minimum',
      'total', v_total,
      'currency', v_cur,
      'requested_term_months', v_quote.term_months,
      'max_term_months', v_quote_out->'max_term_months'
    );
  END IF;
  v_term    := (v_quote_out->>'term_months')::integer;
  v_deposit := (v_quote_out->>'deposit')::integer;

  -- Deposit deadline: what staff asked for, else 72 hours (owner decision 1).
  v_due := coalesce(p_transfer_due_at, now() + interval '72 hours');
  SELECT max((s->>'due_date')::date) INTO v_end_date
    FROM jsonb_array_elements(v_quote_out->'schedule') s;

  v_seq       := nextval('public.web_order_number_seq');
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.layaway_accounts (
    invoice_number, customer_id, currency, total_amount, payment_plan_months,
    order_date, end_date, status, total_paid, remaining_balance,
    downpayment_amount, loyalty_jpy_amount, shipping_fee,
    source_channel, web_reference, quote_id, transfer_due_at, settlement_due_at,
    customer_lang, fx_rate_used, fx_rate_date, notes
  ) VALUES (
    v_invoice, p_customer_id, v_cur::account_currency, v_total, v_term,
    v_order_date, v_end_date, 'active', 0, v_total,
    v_deposit,
    -- LOYALTY BASE: the PRODUCT amount, in YEN, always — never the settlement
    -- total and never shipping. Tiers are yen thresholds on lifetime spend, so
    -- a peso plan must not accrue peso-sized progress. The net-spend rule
    -- (process-loyalty-redemption) then adjusts this figure as it does for
    -- every other account.
    v_quote.subtotal_jpy,
    v_shipping,
    'web', v_reference, v_quote.id, v_due, p_settlement_due_at,
    v_lang, v_rate, v_quote.fx_rate_date,
    'Website layaway ' || v_reference
  ) RETURNING id INTO v_account_id;

  -- Schedule rows, ascending: validate_schedule_chronology compares each row
  -- with the one before it, so the order of insertion matters.
  FOR v_row IN SELECT * FROM jsonb_array_elements(v_quote_out->'schedule') LOOP
    INSERT INTO public.layaway_schedule (
      account_id, installment_number, due_date, base_installment_amount,
      penalty_amount, total_due_amount, paid_amount, currency, status
    ) VALUES (
      v_account_id,
      (v_row->>'installment_number')::integer,
      (v_row->>'due_date')::date,
      (v_row->>'amount')::numeric,
      0,
      (v_row->>'amount')::numeric,
      0,
      v_cur::account_currency,
      'pending'
    );
  END LOOP;

  -- Items and the stock hold. The `stock_qty >= qty` guard is what makes the
  -- decrement safe: if someone took the last piece between the quote and now,
  -- zero rows update and the whole transaction rolls back.
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_quote.items) LOOP
    v_qty := GREATEST(COALESCE((v_item->>'qty')::int, 1), 1);

    SELECT * INTO v_variant FROM public.website_product_variants
      WHERE id = (v_item->>'variant_id')::uuid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item->>'variant_id';
    END IF;

    UPDATE public.website_product_variants
       SET stock_qty = stock_qty - v_qty, updated_at = now()
     WHERE id = v_variant.id AND stock_qty >= v_qty;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'out_of_stock:%', v_variant.id;
    END IF;

    SELECT trim(both ' ' FROM
             p.name ||
             COALESCE(' / ' || NULLIF(v_variant.size, ''), '') ||
             COALESCE(' / ' || NULLIF(v_variant.stone, ''), ''))
      INTO v_title
      FROM public.website_products p WHERE p.id = v_variant.product_id;

    INSERT INTO public.layaway_account_items (
      account_id, website_product_id, variant_id, title, sku, quantity,
      unit_price_jpy, line_total_jpy
    ) VALUES (
      v_account_id, v_variant.product_id, v_variant.id,
      COALESCE(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty,
      -- Item money stays in YEN: it is the catalog price, not the settlement.
      v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
  END LOOP;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true,
    'account_id', v_account_id,
    'web_reference', v_reference,
    'invoice_number', v_invoice,
    'currency', v_cur,
    'total', v_total,
    'deposit', v_deposit,
    'term_months', v_term,
    'schedule', v_quote_out->'schedule',
    'transfer_due_at', v_due,
    'settlement_due_at', p_settlement_due_at,
    'loyalty_jpy_amount', v_quote.subtotal_jpy,
    'fx_rate', v_rate
  );
EXCEPTION
  WHEN raise_exception THEN
    -- Turn the sentinel RAISEs into a payload the edge function maps to a 409,
    -- instead of a 500 that tells the shopper nothing.
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $$;

-- ============================================================================
-- expire_web_layaway_atomic — the deposit never came
-- ============================================================================
-- Fires ONLY on a plan that has received nothing. There is no
-- cancel-after-deposit: once a deposit is confirmed the order is confirmed and
-- the Hub's own lifecycle (overdue, penalties, extension, forfeiture) is the
-- only way out. Owner decision 2026-09-13.
CREATE OR REPLACE FUNCTION public.expire_web_layaway_atomic(
  p_account_id uuid,
  p_source     text DEFAULT 'system'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  IF coalesce(v_paid, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_paid');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
              WHERE account_id = p_account_id AND voided_at IS NULL) THEN
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
END $$;

-- ============================================================================
-- set_account_deadlines — one control, both tables
-- ============================================================================
-- Owner decision 2026-09-13: the deadline is a settable field, not a computed
-- rule, and an extension is simply a new deadline set while the order is LIVE.
-- An expired or cancelled order is never revived — if the customer comes back
-- it is created fresh, so there is no stock re-hold path to get wrong.
CREATE OR REPLACE FUNCTION public.set_account_deadlines(
  p_entity_type       text,
  p_entity_id         uuid,
  p_transfer_due_at   timestamptz,
  p_settlement_due_at timestamptz DEFAULT NULL,
  p_reason            text        DEFAULT NULL,
  p_user_id           uuid        DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_status text;
BEGIN
  IF p_entity_type NOT IN ('layaway', 'cash_order') THEN
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;

  IF p_entity_type = 'layaway' THEN
    SELECT status::text,
           jsonb_build_object('transfer_due_at', transfer_due_at, 'settlement_due_at', settlement_due_at)
      INTO v_status, v_old
      FROM public.layaway_accounts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- Live only. 'cancelled', 'completed', 'forfeited', 'final_forfeited' and
    -- 'final_settlement' are endings, not states a new deadline can reopen.
    IF v_status NOT IN ('active', 'overdue', 'extension_active', 'reactivated') THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;

    UPDATE public.layaway_accounts
       SET transfer_due_at   = p_transfer_due_at,
           settlement_due_at = p_settlement_due_at,
           updated_at        = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at, 'settlement_due_at', p_settlement_due_at);
  ELSE
    SELECT status::text,
           jsonb_build_object('transfer_due_at', transfer_due_at, 'expires_at', expires_at)
      INTO v_status, v_old
      FROM public.cash_orders WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_status <> 'pending' THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;

    -- BOTH columns, deliberately. create_web_order_atomic writes the same value
    -- to each and the expiry cron reads expires_at; moving only transfer_due_at
    -- would show the customer a new deadline while the cron still cancels on
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

  RETURN jsonb_build_object('ok', true, 'old', v_old, 'new', v_new);
END $$;

-- Service role only: these are called by edge functions, never from a browser.
REVOKE ALL ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, timestamptz, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_web_layaway_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_account_deadlines(text, uuid, timestamptz, timestamptz, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, timestamptz, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_web_layaway_atomic(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_account_deadlines(text, uuid, timestamptz, timestamptz, text, uuid) TO service_role;
