-- customer_addresses, and the two foreign keys that make the destruction
-- possible. Copied from live 2026-09-15:
--   information_schema.columns for the table,
--   pg_get_constraintdef for both FKs — each is ON DELETE SET NULL, which is
--   precisely why deleting an address blanks the shipping address on every
--   order and quote pointing at it.
-- The partial unique index is the live customer_addresses_one_default.
--
-- 01_schema.sql already creates cash_orders.ship_to_address_id and
-- checkout_quotes.ship_to_address_id as bare uuid columns; the FKs were not
-- copied because nothing before this exercised them. They are added here.

-- Supabase ships anon / authenticated / service_role; a bare Postgres does not,
-- and the migrations under test REVOKE from and GRANT to them. Created here so
-- a migration can be loaded on top of a fresh build without editing it.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN; END IF;
END $roles$;

CREATE TABLE IF NOT EXISTS public.customer_addresses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id    uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  label          text,
  recipient_name text,
  line1          text NOT NULL,
  line2          text,
  city           text,
  region         text,
  postal_code    text,
  country        text NOT NULL DEFAULT 'JP',
  phone          text,
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_customer
  ON public.customer_addresses (customer_id);

CREATE UNIQUE INDEX IF NOT EXISTS customer_addresses_one_default
  ON public.customer_addresses (customer_id) WHERE is_default;

ALTER TABLE public.cash_orders
  DROP CONSTRAINT IF EXISTS cash_orders_ship_to_address_id_fkey;
ALTER TABLE public.cash_orders
  ADD CONSTRAINT cash_orders_ship_to_address_id_fkey
  FOREIGN KEY (ship_to_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL;

ALTER TABLE public.checkout_quotes
  DROP CONSTRAINT IF EXISTS checkout_quotes_ship_to_address_id_fkey;
ALTER TABLE public.checkout_quotes
  ADD CONSTRAINT checkout_quotes_ship_to_address_id_fkey
  FOREIGN KEY (ship_to_address_id) REFERENCES public.customer_addresses(id) ON DELETE SET NULL;

-- The PRE-FIX body, byte for byte from live (md5(prosrc)
-- 8a5345b7b07f0c9a6d671a1af6e65775, measured 2026-09-15). The harness baseline
-- is always the code production runs; load
-- ../../supabase/migrations/20260915160000_checkout_never_destroys_the_address_book.sql
-- on top of a fresh build to exercise the fix.
CREATE OR REPLACE FUNCTION public.replace_customer_addresses(p_customer_id uuid, p_addresses jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
  v_inserted int;
BEGIN
  IF p_customer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'customer_id_required');
  END IF;
  IF p_addresses IS NULL OR jsonb_typeof(p_addresses) <> 'array' THEN
    RETURN jsonb_build_object('error', 'addresses_must_be_array');
  END IF;

  v_count := jsonb_array_length(p_addresses);
  IF v_count > 20 THEN
    RETURN jsonb_build_object('error', 'too_many_addresses');
  END IF;

  -- Every entry needs a line1; reject the whole payload rather than silently
  -- dropping entries the customer thinks they saved.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_addresses) e
    WHERE COALESCE(btrim(e->>'line1'), '') = ''
  ) THEN
    RETURN jsonb_build_object('error', 'line1_required');
  END IF;

  DELETE FROM public.customer_addresses WHERE customer_id = p_customer_id;

  -- The first entry is the default unless exactly one entry says is_default.
  -- customer_addresses_one_default would otherwise reject a payload marking two.
  WITH src AS (
    SELECT e, row_number() OVER () AS rn,
           COALESCE((e->>'is_default')::boolean, false) AS wants_default
    FROM jsonb_array_elements(p_addresses) e
  ), flagged AS (
    SELECT e, rn,
           CASE
             WHEN (SELECT count(*) FROM src s2 WHERE s2.wants_default) = 1 THEN wants_default
             ELSE rn = 1
           END AS is_default
    FROM src
  )
  INSERT INTO public.customer_addresses
    (customer_id, label, recipient_name, line1, line2, city, region, postal_code, country, phone, is_default)
  SELECT
    p_customer_id,
    NULLIF(btrim(e->>'label'), ''),
    NULLIF(btrim(e->>'recipient_name'), ''),
    btrim(e->>'line1'),
    NULLIF(btrim(e->>'line2'), ''),
    NULLIF(btrim(e->>'city'), ''),
    NULLIF(btrim(e->>'region'), ''),
    NULLIF(btrim(e->>'postal_code'), ''),
    COALESCE(NULLIF(btrim(e->>'country'), ''), 'JP'),
    NULLIF(btrim(e->>'phone'), ''),
    is_default
  FROM flagged;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'count', v_inserted);
END $function$;

-- ---------------------------------------------------------------------------
-- cash_order_items and create_web_order_atomic: the CASH writer, so the
-- snapshot can be proven on the table that actually carries the FK.
-- Columns from live information_schema.columns 2026-09-15; the table has no
-- triggers on live, so none are copied.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cash_order_items (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id        uuid NOT NULL,
  product_id           uuid,
  shopify_line_item_id text,
  title                text NOT NULL,
  sku                  text,
  quantity             integer NOT NULL DEFAULT 1,
  unit_price_jpy       numeric NOT NULL,
  line_total_jpy       numeric NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  image_url            text,
  variant_id           uuid,
  website_product_id   uuid
);

CREATE SEQUENCE IF NOT EXISTS public.web_order_number_seq START 900001;

-- create_web_order_atomic, byte for byte from live (md5(prosrc)
-- fbd3766066f014271d7cf3b8dd7b1d14, measured 2026-09-15). PRE-FIX: it does
-- not write ship_to_snapshot. 00_verify_fidelity.sql checks this hash.
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
    gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
    loyalty_jpy_amount, item_description, order_date, customer_lang
  ) VALUES (
    v_invoice, p_customer_id, v_currency::account_currency, v_quote.total_jpy, 0,
    v_quote.total_jpy, 'pending'::cash_order_status, 'web', v_quote.order_type, 'transfer',
    'pending_transfer', v_quote.ship_to_address_id, v_quote.recipient_name, v_quote.recipient_phone,
    -- expires_at = transfer_due_at: the 72-hour deadline is what the expiry cron reads.
    v_quote.gift_note, v_quote.id, v_reference, v_due, v_due, COALESCE(v_quote.shipping_jpy, 0),
    -- Loyalty basis is the PRODUCT amount only: shipping never earns points.
    v_quote.subtotal_jpy, 'Website order ' || v_reference, CURRENT_DATE, v_lang
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
