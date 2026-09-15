-- Remove layaway_accounts.settlement_due_at. Owner decision 2026-09-15.
--
-- The column was built to a 2026-09-14 answer without anyone asking what it was
-- FOR. Nothing reads it: no view, no index, no constraint, no policy, no
-- trigger, no cron job, no report. Only the two RPCs below accept it, and both
-- only ever write it straight back out again.
--
-- Checked before writing this, on the live database (2026-09-15):
--   layaway_accounts rows total ........................ 1449
--   rows where settlement_due_at IS NOT NULL ...........    0
--   web-channel rows ...................................    1  (settlement NULL)
--   other tables carrying a column of this name ........  none (cash_orders never had it)
--   functions / views / matviews / indexes / constraints /
--     policies / triggers / cron commands mentioning it .  the 2 RPCs only
-- No stored value is discarded by this drop.
--
-- The DEPOSIT deadline (transfer_due_at) is untouched — that is the control
-- that matters and it stays, on both layaway_accounts and cash_orders, with
-- the cash-order pairing to expires_at exactly as before.
--
-- Both functions are DROPPED and recreated rather than CREATE OR REPLACE'd.
-- p_settlement_due_at carried a DEFAULT, so replacing in place would leave two
-- overloads and every call that omits the argument would fail with
-- "function ... is not unique" (the lesson from Bug #271's revoke_loyalty_points
-- twin). Grants are re-applied below because a DROP takes the ACL with it.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. create_web_layaway_atomic — one writer for web layaway plans.
--    Identical to the live body minus the settlement parameter, its INSERT
--    column and its echo in the return payload.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, timestamptz, date);

CREATE FUNCTION public.create_web_layaway_atomic(
  p_customer_id     uuid,
  p_quote_id        uuid,
  p_lang            text DEFAULT NULL,
  p_transfer_due_at timestamptz DEFAULT NULL,
  p_order_date      date DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    source_channel, web_reference, quote_id, transfer_due_at,
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
    'web', v_reference, v_quote.id, v_due,
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
END $function$;

REVOKE ALL ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, date) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. set_account_deadlines — the one control staff move a deadline through.
--    Now a single deadline on the layaway side. The cash-order side is
--    unchanged: transfer_due_at AND expires_at, together, for the reason in
--    the comment below.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.set_account_deadlines(text, uuid, timestamptz, timestamptz, text, uuid);

CREATE FUNCTION public.set_account_deadlines(
  p_entity_type     text,
  p_entity_id       uuid,
  p_transfer_due_at timestamptz,
  p_reason          text DEFAULT NULL,
  p_user_id         uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
           jsonb_build_object('transfer_due_at', transfer_due_at)
      INTO v_status, v_old
      FROM public.layaway_accounts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- Live only. 'cancelled', 'completed', 'forfeited', 'final_forfeited' and
    -- 'final_settlement' are endings, not states a new deadline can reopen.
    IF v_status NOT IN ('active', 'overdue', 'extension_active', 'reactivated') THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;

    UPDATE public.layaway_accounts
       SET transfer_due_at = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at);
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
END $function$;

REVOKE ALL ON FUNCTION public.set_account_deadlines(text, uuid, timestamptz, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_account_deadlines(text, uuid, timestamptz, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The column itself. Dropped last, so neither function ever references a
--    column that no longer exists mid-transaction.
-- ---------------------------------------------------------------------------
ALTER TABLE public.layaway_accounts DROP COLUMN IF EXISTS settlement_due_at;

COMMIT;
