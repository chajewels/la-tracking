-- Web checkout never produced an order: cash_order_items.product_id is a
-- foreign key to public.products (the Shopify sync table), but a website order
-- line references a website_products row. create_web_order_atomic therefore
-- failed on every /checkout/pay with
--   23503 insert or update on table "cash_order_items" violates foreign key
--         constraint "cash_order_items_product_id_fkey"
-- which the edge function turned into a 500 and the storefront into
-- "We could not complete your order". Reproduced 2026-09-13 01:01 UTC inside a
-- rolled-back DO block against quote 3ce49899 (Bug #266).
--
-- Two catalogs, two columns: product_id stays the Shopify reference,
-- website_product_id is the storefront reference. variant_id already points at
-- website_product_variants and is unchanged. Idempotent.

ALTER TABLE public.cash_order_items
  ADD COLUMN IF NOT EXISTS website_product_id uuid
    REFERENCES public.website_products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cash_order_items_website_product
  ON public.cash_order_items (website_product_id);

COMMENT ON COLUMN public.cash_order_items.product_id IS
  'Shopify catalog reference (public.products). NULL for website orders — see website_product_id.';
COMMENT ON COLUMN public.cash_order_items.website_product_id IS
  'Storefront catalog reference (public.website_products). Written by create_web_order_atomic; NULL for Shopify orders.';

-- Same function as before; the ONLY change is the cash_order_items INSERT,
-- which now writes website_product_id instead of product_id.
CREATE OR REPLACE FUNCTION public.create_web_order_atomic(p_customer_id uuid, p_quote_id uuid, p_method text)
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
    -- Same answer as a missing quote: do not confirm that someone else's
    -- quote id exists.
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
    payment_status, ship_to_address_id, recipient_name, recipient_phone,
    gift_note, quote_id, web_reference, transfer_due_at, shipping_fee,
    loyalty_jpy_amount, item_description, order_date
  ) VALUES (
    v_invoice, p_customer_id, v_currency::account_currency, v_quote.total_jpy, 0,
    v_quote.total_jpy, 'pending'::cash_order_status, 'web', v_quote.order_type, 'transfer',
    'pending_transfer', v_quote.ship_to_address_id, v_quote.recipient_name, v_quote.recipient_phone,
    v_quote.gift_note, v_quote.id, v_reference, v_due, COALESCE(v_quote.shipping_jpy, 0),
    -- Loyalty basis is the PRODUCT amount only: shipping never earns points.
    v_quote.subtotal_jpy, 'Website order ' || v_reference, CURRENT_DATE
  ) RETURNING id INTO v_order_id;

  -- Items + stock, one variant at a time. The WHERE stock_qty >= qty guard is
  -- what makes the decrement safe: if another buyer took the last piece
  -- between the quote and now, zero rows update and the whole transaction
  -- rolls back with out_of_stock.
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
    -- Turn the sentinel RAISEs above into a payload the edge function can map
    -- to a 409, instead of a 500 that says nothing useful to the shopper.
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;