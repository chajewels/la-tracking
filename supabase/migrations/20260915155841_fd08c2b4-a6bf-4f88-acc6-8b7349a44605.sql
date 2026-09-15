CREATE OR REPLACE FUNCTION public.address_snapshot(p_address_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
  SELECT jsonb_build_object(
    'address_id',     a.id,
    'label',          a.label,
    'recipient_name', a.recipient_name,
    'line1',          a.line1,
    'line2',          a.line2,
    'city',           a.city,
    'region',         a.region,
    'postal_code',    a.postal_code,
    'country',        a.country,
    'phone',          a.phone,
    'captured_at',    now()
  )
  FROM public.customer_addresses a
  WHERE a.id = p_address_id;
$function$;

COMMENT ON FUNCTION public.address_snapshot(uuid) IS
  'The canonical shape of an order address snapshot. Used by create_web_order_atomic, create_web_layaway_atomic and any backfill, so all three agree by construction. Returns NULL when the address id is NULL or gone.';

ALTER TABLE public.cash_orders      ADD COLUMN IF NOT EXISTS ship_to_snapshot jsonb;
ALTER TABLE public.layaway_accounts ADD COLUMN IF NOT EXISTS ship_to_snapshot jsonb;

COMMENT ON COLUMN public.cash_orders.ship_to_snapshot IS
  'Delivery address AS IT WAS at order creation. Authoritative for this order: the display reads this, not the FK. ship_to_address_id stays as a convenience link to the live address book and may go NULL when the customer edits it — that must never change where this order was sent.';
COMMENT ON COLUMN public.layaway_accounts.ship_to_snapshot IS
  'Delivery address AS IT WAS at plan creation, resolved through the checkout quote. layaway_accounts has no ship_to_address_id: this column is the only address the plan carries.';

CREATE OR REPLACE FUNCTION public.upsert_customer_addresses(
  p_customer_id uuid,
  p_addresses   jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_entry     jsonb;
  v_id        uuid;
  v_matched   uuid;
  v_inserted  int := 0;
  v_updated   int := 0;
  v_want_def  uuid;
  v_def_count int;
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'customer_id_required');
  END IF;
  IF p_addresses IS NULL OR jsonb_typeof(p_addresses) <> 'array' THEN
    RETURN jsonb_build_object('error', 'addresses_must_be_array');
  END IF;
  IF jsonb_array_length(p_addresses) > 20 THEN
    RETURN jsonb_build_object('error', 'too_many_addresses');
  END IF;

  -- Reject the whole payload rather than silently dropping entries the
  -- customer believes they saved. Unchanged from the function this replaces.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_addresses) e
    WHERE COALESCE(btrim(e->>'line1'), '') = ''
  ) THEN
    RETURN jsonb_build_object('error', 'line1_required');
  END IF;

  SELECT count(*) INTO v_def_count
    FROM jsonb_array_elements(p_addresses) e
   WHERE COALESCE((e->>'is_default')::boolean, false);

  FOR v_entry IN SELECT * FROM jsonb_array_elements(p_addresses) LOOP
    -- A malformed id is treated as absent, not as an error.
    BEGIN
      v_id := NULLIF(btrim(v_entry->>'id'), '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_id := NULL;
    END;

    v_matched := NULL;
    IF v_id IS NOT NULL THEN
      SELECT a.id INTO v_matched FROM public.customer_addresses a
       WHERE a.id = v_id AND a.customer_id = p_customer_id;
    END IF;

    IF v_matched IS NOT NULL THEN
      UPDATE public.customer_addresses SET
        label          = NULLIF(btrim(v_entry->>'label'), ''),
        recipient_name = NULLIF(btrim(v_entry->>'recipient_name'), ''),
        line1          = btrim(v_entry->>'line1'),
        line2          = NULLIF(btrim(v_entry->>'line2'), ''),
        city           = NULLIF(btrim(v_entry->>'city'), ''),
        region         = NULLIF(btrim(v_entry->>'region'), ''),
        postal_code    = NULLIF(btrim(v_entry->>'postal_code'), ''),
        country        = COALESCE(NULLIF(btrim(v_entry->>'country'), ''), 'JP'),
        phone          = NULLIF(btrim(v_entry->>'phone'), '')
      WHERE id = v_matched;
      v_updated := v_updated + 1;
    ELSE
      INSERT INTO public.customer_addresses
        (customer_id, label, recipient_name, line1, line2, city, region, postal_code, country, phone, is_default)
      VALUES (
        p_customer_id,
        NULLIF(btrim(v_entry->>'label'), ''),
        NULLIF(btrim(v_entry->>'recipient_name'), ''),
        btrim(v_entry->>'line1'),
        NULLIF(btrim(v_entry->>'line2'), ''),
        NULLIF(btrim(v_entry->>'city'), ''),
        NULLIF(btrim(v_entry->>'region'), ''),
        NULLIF(btrim(v_entry->>'postal_code'), ''),
        COALESCE(NULLIF(btrim(v_entry->>'country'), ''), 'JP'),
        NULLIF(btrim(v_entry->>'phone'), ''),
        false
      ) RETURNING id INTO v_matched;
      v_inserted := v_inserted + 1;
    END IF;

    IF v_def_count = 1 AND COALESCE((v_entry->>'is_default')::boolean, false) THEN
      v_want_def := v_matched;
    END IF;
  END LOOP;

  -- The default, in two steps because customer_addresses_one_default is a
  -- partial unique index: clear before setting.
  IF v_want_def IS NOT NULL THEN
    UPDATE public.customer_addresses SET is_default = false
     WHERE customer_id = p_customer_id AND is_default AND id <> v_want_def;
    UPDATE public.customer_addresses SET is_default = true  WHERE id = v_want_def;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM public.customer_addresses
                    WHERE customer_id = p_customer_id AND is_default) THEN
      UPDATE public.customer_addresses SET is_default = true
       WHERE id = (SELECT id FROM public.customer_addresses
                    WHERE customer_id = p_customer_id
                    ORDER BY created_at, id LIMIT 1);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'updated',  v_updated,
    'count', (SELECT count(*) FROM public.customer_addresses WHERE customer_id = p_customer_id));
END $function$;

REVOKE ALL ON FUNCTION public.upsert_customer_addresses(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_customer_addresses(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.replace_customer_addresses(
  p_customer_id uuid,
  p_addresses   jsonb
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.upsert_customer_addresses(p_customer_id, p_addresses);
$function$;

COMMENT ON FUNCTION public.replace_customer_addresses(uuid, jsonb) IS
  'DEPRECATED, and no longer replaces anything: forwards to upsert_customer_addresses. Retained only so a stale caller cannot reach the old DELETE-then-INSERT body, which blanked the shipping address on every order pointing at the deleted rows (ON DELETE SET NULL). Call upsert_customer_addresses directly.';

REVOKE ALL ON FUNCTION public.replace_customer_addresses(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_customer_addresses(uuid, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.create_web_order_atomic(p_customer_id uuid, p_quote_id uuid, p_method text, p_lang text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_quote        public.checkout_quotes%ROWTYPE;
  v_item         jsonb;
  v_variant      public.website_product_variants%ROWTYPE;
  v_qty          integer;
  v_updated      integer;
  v_seq          bigint;
  v_invoice      text;
  v_reference    text;
  v_order_id     uuid;
  v_currency     text := 'JPY';
  v_due          timestamptz := now() + interval '72 hours';
  v_title        text;
  v_lang         text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
BEGIN
  IF p_method IS DISTINCT FROM 'transfer' THEN
    RETURN jsonb_build_object('error', 'unsupported_method');
  END IF;

  -- Lock the quote so a double-submit cannot produce two orders from it.
  SELECT * INTO v_quote FROM public.checkout_quotes
    WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'quote_already_used');
  END IF;
  IF v_quote.expires_at <= now() THEN
    RETURN jsonb_build_object('error', 'quote_expired');
  END IF;
  IF v_quote.mode <> 'full' THEN
    RETURN jsonb_build_object('error', 'layaway_not_yet');
  END IF;
  IF v_quote.shipping_jpy IS NULL THEN
    RETURN jsonb_build_object('error', 'shipping_quote_required');
  END IF;
  IF v_quote.total_jpy <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_quote');
  END IF;

  v_seq       := nextval('public.web_order_number_seq');
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.cash_orders (
    invoice_number, customer_id, currency, total_amount, total_paid,
    remaining_balance, status, source_channel, order_type, payment_method,
    payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
    gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
    loyalty_jpy_amount, item_description, order_date, customer_lang
  ) VALUES (
    v_invoice, p_customer_id, v_currency::account_currency, v_quote.total_jpy, 0,
    v_quote.total_jpy, 'pending'::cash_order_status, 'web', v_quote.order_type, 'transfer',
    'pending_transfer', v_quote.ship_to_address_id,
    -- The address AS IT WAS, so editing the address book later cannot move
    -- where this order was sent. The FK beside it stays a convenience link.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_quote.recipient_name, v_quote.recipient_phone,
    -- expires_at = transfer_due_at: the 72-hour deadline is what the expiry cron reads.
    v_quote.gift_note, v_quote.id, v_reference, v_due, v_due, COALESCE(v_quote.shipping_jpy, 0),
    -- Loyalty basis is the PRODUCT amount only: shipping never earns points.
    v_quote.subtotal_jpy, 'Website order ' || v_reference, CURRENT_DATE, v_lang
  ) RETURNING id INTO v_order_id;

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

    -- website_product_id, NOT product_id: product_id is the Shopify FK
    -- (public.products) and a website_products id violates it (Bug #266).
    INSERT INTO public.cash_order_items (
      cash_order_id, website_product_id, variant_id, title, sku, quantity,
      unit_price_jpy, line_total_jpy
    ) VALUES (
      v_order_id, v_variant.product_id, v_variant.id,
      COALESCE(v_title, 'Item'),
      (SELECT p.sku FROM public.website_products p WHERE p.id = v_variant.product_id),
      v_qty, v_variant.price_jpy, v_variant.price_jpy * v_qty
    );
  END LOOP;

  UPDATE public.checkout_quotes SET consumed_at = now() WHERE id = v_quote.id;

  RETURN jsonb_build_object(
    'ok', true,
    'order_id', v_order_id,
    'web_reference', v_reference,
    'invoice_number', v_invoice,
    'total_jpy', v_quote.total_jpy,
    'transfer_due_at', v_due
  );
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;

REVOKE ALL ON FUNCTION public.create_web_order_atomic(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_order_atomic(uuid, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.create_web_layaway_atomic(
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
  v_total      integer;
  v_shipping   integer;
  v_subtotal   integer;
  v_quote_out  jsonb;
  v_term       integer;
  v_deposit    integer;
  v_due        timestamptz;
  v_end_date   date;
  v_title      text;
  v_row        jsonb;
  v_order_date date := COALESCE(p_order_date, CURRENT_DATE);
BEGIN
  SELECT * INTO v_quote FROM public.checkout_quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'quote_not_found');
  END IF;
  IF v_quote.customer_id <> p_customer_id THEN
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

  v_quote_out := public.layaway_quote(
    v_subtotal, v_quote.term_months, v_cur, v_order_date, v_shipping, 0
  );
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
    source_channel, web_reference, quote_id, transfer_due_at, ship_to_snapshot,
    customer_lang, fx_rate_used, fx_rate_date, notes
  ) VALUES (
    v_invoice, p_customer_id, v_cur::account_currency, v_total, v_term,
    v_order_date, v_end_date, 'active', 0, v_total,
    v_deposit,
    -- LOYALTY BASE: the PRODUCT amount, in YEN, always.
    v_quote.subtotal_jpy,
    v_shipping,
    'web', v_reference, v_quote.id, v_due,
    -- layaway_accounts has no ship_to_address_id: this snapshot, resolved
    -- through the quote, is the only delivery address the plan carries.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_lang, v_rate, v_quote.fx_rate_date,
    'Website layaway ' || v_reference
  ) RETURNING id INTO v_account_id;

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
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;

REVOKE ALL ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_layaway_atomic(uuid, uuid, text, timestamptz, date) TO service_role;

UPDATE public.cash_orders c
   SET ship_to_snapshot = public.address_snapshot(c.ship_to_address_id)
 WHERE c.source_channel = 'web'
   AND c.ship_to_snapshot IS NULL
   AND c.ship_to_address_id IS NOT NULL
   AND public.address_snapshot(c.ship_to_address_id) IS NOT NULL;

UPDATE public.layaway_accounts l
   SET ship_to_snapshot = public.address_snapshot(q.ship_to_address_id)
  FROM public.checkout_quotes q
 WHERE q.id = l.quote_id
   AND l.source_channel = 'web'
   AND l.ship_to_snapshot IS NULL
   AND q.ship_to_address_id IS NOT NULL
   AND public.address_snapshot(q.ship_to_address_id) IS NOT NULL;

DO $do$
DECLARE
  v_cash_filled  int;
  v_lay_filled   int;
  v_cash_missing int;
  v_lay_missing  int;
BEGIN
  SELECT count(*) INTO v_cash_filled
    FROM public.cash_orders
   WHERE source_channel = 'web' AND ship_to_snapshot IS NOT NULL;

  SELECT count(*) INTO v_lay_filled
    FROM public.layaway_accounts
   WHERE source_channel = 'web' AND ship_to_snapshot IS NOT NULL;

  SELECT count(*) INTO v_cash_missing
    FROM public.cash_orders c
   WHERE c.source_channel = 'web' AND c.ship_to_snapshot IS NULL
     AND public.address_snapshot(c.ship_to_address_id) IS NOT NULL;

  SELECT count(*) INTO v_lay_missing
    FROM public.layaway_accounts l
    JOIN public.checkout_quotes q ON q.id = l.quote_id
   WHERE l.source_channel = 'web' AND l.ship_to_snapshot IS NULL
     AND public.address_snapshot(q.ship_to_address_id) IS NOT NULL;

  RAISE NOTICE 'ship_to_snapshot backfill — cash filled: %, layaway filled: % (expected 4 and 2)',
    v_cash_filled, v_lay_filled;

  IF v_cash_missing > 0 OR v_lay_missing > 0 THEN
    RAISE EXCEPTION 'ship_to_snapshot backfill left % cash and % layaway rows unfilled with a resolvable address',
      v_cash_missing, v_lay_missing;
  END IF;
END $do$;