-- ============================================================================
-- PESO FULL PAYMENT ON THE WEBSITE (H1, 2026-09-25, owner-approved plan:
-- peso-full-payment-investigation.md).
--
-- A one-time (full-payment) web order may now settle in pesos, exactly as a
-- web layaway already can. Yen stays the price of record:
--   * cash_order_items (unit_price_jpy / line_total_jpy) stay YEN;
--   * cash_orders.loyalty_jpy_amount stays the YEN product subtotal
--     (v_quote.subtotal_jpy) — points never move with FX;
--   * total_amount / remaining_balance / shipping_fee are written in the
--     order's currency: for PHP, converted ONCE at the jpy_php rate captured
--     on the checkout quote (never today's), rounded HALF-UP to a whole peso —
--     round(total_jpy * fx_rate), the arithmetic create_web_layaway_atomic
--     already uses. Shipping is converted on its own; the items are the
--     remainder, so the parts always sum to the total.
--   * The rate and its fx_rates date are stored on the order
--     (cash_orders.fx_rate_used / fx_rate_date, mirroring layaway_accounts).
-- A YEN quote writes exactly the values it wrote before this migration; the
-- only difference on a yen order is two new columns left NULL, and three new
-- keys in the RPC's result (currency 'JPY', total = total_jpy, fx_rate null).
--
-- FUNCTION RULES (CLAUDE.md "FUNCTION CHANGES START FROM LIVE", Bug #280).
-- The new body is the reserve_first_a1 body (20260923140000) with the edits
-- marked PESO FULL PAYMENT, made by exact-text replacement. Reversing those
-- replacements reproduces that body byte for byte (md5 checked while writing
-- this file). md5 = scripts/function-drift-audit's comparator: md5 of prosrc
-- with whitespace collapsed and trimmed.
--
--   create_web_order_atomic   live (expected)  bcb37311b07b0935e3c05406083d68bc
--                             after this file   38d1396df0eb23e4d2810b722cd51f5e
--
-- bcb37311… is the md5 reserve_first_a1 section 11 required of live when it
-- finished. Section 0 below refuses to run unless live still carries it and
-- has exactly ONE overload; section 4 refuses to COMMIT unless the new body
-- md5-matches, the new columns have the right types, and EXECUTE is held by
-- service_role only. Either the intended change lands on the expected state,
-- or nothing does.
--
-- CREATE OR REPLACE, SAME SIGNATURE: no DROP, so no second overload and the
-- function keeps its owner. Its grants are re-asserted anyway (service_role
-- only — every caller is the website edge function with the service role, or
-- a SECURITY DEFINER function running as owner; 20260924130343 audit), per the
-- 2026-09-24 lesson in CLAUDE.md.
--
-- ADDITIVE: two nullable columns, one CHECK, one function body. Nothing is
-- removed. Safe to run before the edge functions deploy: until the website
-- function stops refusing peso full-payment quotes, no quote can reach the
-- PHP branch.
--
-- Run ONCE in the Supabase SQL Editor, as a whole. Self-resolving — nothing to
-- fill in. If section 0 stops, nothing changed: send the error text back.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------- 0. guards
DO $guard$
DECLARE
  v_n    integer;
  v_md5  text;
  v_bad  text := '';
  v_col  text;
BEGIN
  SELECT count(*), min(md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))))
    INTO v_n, v_md5
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_web_order_atomic';
  IF v_n <> 1 THEN
    v_bad := v_bad || format(E'\n  create_web_order_atomic: %s overloads live, expected exactly 1', v_n);
  ELSIF to_regprocedure('public.create_web_order_atomic(uuid,uuid,text,text,boolean)') IS NULL THEN
    v_bad := v_bad || E'\n  create_web_order_atomic(uuid,uuid,text,text,boolean) is not the live signature';
  ELSIF v_md5 = '38d1396df0eb23e4d2810b722cd51f5e' THEN
    v_bad := v_bad || E'\n  create_web_order_atomic already carries this migration''s body — it has run before';
  ELSIF v_md5 <> 'bcb37311b07b0935e3c05406083d68bc' THEN
    v_bad := v_bad || format(E'\n  create_web_order_atomic: live body md5 %s, expected bcb37311b07b0935e3c05406083d68bc (reserve_first_a1)', v_md5);
  END IF;

  -- The quote columns this body reads (20260914110000_web_layaway_schema).
  FOREACH v_col IN ARRAY ARRAY['settlement_currency', 'fx_rate', 'fx_rate_date'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'checkout_quotes' AND column_name = v_col) THEN
      v_bad := v_bad || format(E'\n  checkout_quotes.%s is missing', v_col);
    END IF;
  END LOOP;

  -- The columns this file adds must not already exist in some other shape.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'cash_orders'
                AND column_name IN ('fx_rate_used', 'fx_rate_date')) THEN
    v_bad := v_bad || E'\n  cash_orders.fx_rate_used / fx_rate_date already exist — this migration has run before or something else added them';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — live is not the state this migration was written against. Nothing was modified.%', v_bad;
  END IF;
END
$guard$;

-- ------------------------------------------------------------ 1. columns
-- The rate a peso web order was charged at, as on layaway_accounts.
ALTER TABLE public.cash_orders
  ADD COLUMN fx_rate_used numeric(12,6),
  ADD COLUMN fx_rate_date date;

COMMENT ON COLUMN public.cash_orders.fx_rate_used IS
  'For a PHP-settled WEB order: the fx_rates.jpy_php rate (PHP per 1 JPY) captured on the checkout quote and applied once to the yen total (half-up, whole pesos). NULL for yen orders and for Hub-arranged orders. Written only by create_web_order_atomic.';
COMMENT ON COLUMN public.cash_orders.fx_rate_date IS
  'The fx_rates date of fx_rate_used. NULL when fx_rate_used is NULL.';

-- A stored rate only ever belongs to a peso order. Every existing row has
-- NULL here, so the constraint validates instantly.
ALTER TABLE public.cash_orders
  ADD CONSTRAINT cash_orders_fx_rate_only_on_php
  CHECK (fx_rate_used IS NULL OR (currency = 'PHP'::account_currency AND fx_rate_used > 0));

-- ------------------------------------------- 2. create_web_order_atomic
-- reserve_first_a1 body + PESO FULL PAYMENT edits. Same signature.
CREATE OR REPLACE FUNCTION public.create_web_order_atomic(p_customer_id uuid, p_quote_id uuid, p_method text, p_lang text DEFAULT NULL::text, p_reserve boolean DEFAULT false)
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
  -- PESO FULL PAYMENT (2026-09-25): the quote's settlement currency, set below.
  v_currency     text;
  v_rate         numeric(12,6);
  v_total        numeric(12,2);
  v_shipping     numeric(12,2);
  -- RESERVE-FIRST (A1): a reservation has NO payment deadline until staff
  -- confirm it ready for dispatch (confirm_web_order_ready_atomic starts it).
  v_due          timestamptz := CASE WHEN p_reserve THEN NULL
                                     ELSE now() + make_interval(hours => public.web_deposit_deadline_hours(p_customer_id)) END;
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

  -- PESO FULL PAYMENT (2026-09-25). The customer's currency, at the rate
  -- captured on the quote (never today's). integer * numeric is exact and
  -- round(numeric) is half-up for positive amounts: whole pesos. Shipping is
  -- converted on its own and the items are the remainder, so the parts always
  -- sum to the total. The same arithmetic as create_web_layaway_atomic. Yen
  -- writes exactly what it always wrote.
  v_currency := coalesce(v_quote.settlement_currency, 'JPY');
  IF v_currency = 'PHP' THEN
    v_rate := v_quote.fx_rate;
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RETURN jsonb_build_object('error', 'fx_rate_missing');
    END IF;
    v_total    := round(v_quote.total_jpy * v_rate);
    v_shipping := round(coalesce(v_quote.shipping_jpy, 0) * v_rate);
  ELSE
    v_currency := 'JPY';
    v_rate     := NULL;
    v_total    := v_quote.total_jpy;
    v_shipping := coalesce(v_quote.shipping_jpy, 0);
  END IF;

  v_seq       := nextval('public.web_order_number_seq');
  v_invoice   := v_seq::text;
  v_reference := 'CJ-W-' || lpad(v_seq::text, 6, '0');

  INSERT INTO public.cash_orders (
    invoice_number, customer_id, currency, total_amount, total_paid,
    remaining_balance, status, source_channel, order_type, payment_method,
    payment_status, ship_to_address_id, ship_to_snapshot, recipient_name, recipient_phone,
    gift_note, quote_id, web_reference, transfer_due_at, expires_at, shipping_fee,
    loyalty_jpy_amount, item_description, order_date, customer_lang,
    ready_confirmed_at, fx_rate_used, fx_rate_date
  ) VALUES (
    v_invoice, p_customer_id, v_currency::account_currency, v_total, 0,
    v_total, 'pending'::cash_order_status, 'web', v_quote.order_type, 'transfer',
    CASE WHEN p_reserve THEN 'awaiting_confirmation' ELSE 'pending_transfer' END, v_quote.ship_to_address_id,
    -- The address AS IT WAS, so editing the address book later cannot move
    -- where this order was sent. The FK beside it stays a convenience link.
    public.address_snapshot(v_quote.ship_to_address_id),
    v_quote.recipient_name, v_quote.recipient_phone,
    -- expires_at = transfer_due_at: the 72-hour deadline is what the expiry cron reads.
    v_quote.gift_note, v_quote.id, v_reference, v_due, v_due, v_shipping,
    -- Loyalty basis is the PRODUCT amount only: shipping never earns points.
    -- Always YEN, whatever the settlement currency: FX never moves points.
    v_quote.subtotal_jpy, 'Website order ' || v_reference, CURRENT_DATE, v_lang,
    -- A non-reserved order is ready from the moment it exists; a reservation
    -- waits for staff (NULL = awaiting confirmation).
    CASE WHEN p_reserve THEN NULL ELSE now() END,
    -- The rate this order was charged at; NULL on a yen order.
    v_rate, CASE WHEN v_rate IS NULL THEN NULL ELSE v_quote.fx_rate_date END
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
    -- Lines stay in YEN on every order: the price of record.
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
    'currency', v_currency,
    'total', v_total,
    'fx_rate', v_rate,
    'transfer_due_at', v_due
  ) || CASE WHEN p_reserve THEN jsonb_build_object('reserved', true) ELSE '{}'::jsonb END;
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'out_of_stock:%' THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
      RETURN jsonb_build_object('error', 'variant_missing', 'variant_id', split_part(SQLERRM, ':', 2));
    END IF;
    RAISE;
END $function$;

COMMENT ON FUNCTION public.create_web_order_atomic(uuid, uuid, text, text, boolean) IS
  'Sole writer of a web (full-payment) cash order. Consumes a checkout quote, inserts the order and its item lines and decrements stock, one transaction. Settles in the quote''s settlement_currency: PHP converts total and shipping once at the quote''s fx_rate (half-up, whole pesos) and stores the rate in fx_rate_used / fx_rate_date; item lines and loyalty_jpy_amount stay in yen. p_reserve true (reserve-first) creates a RESERVATION: no deadline, payment_status awaiting_confirmation, ready_confirmed_at NULL until confirm_web_order_ready_atomic.';

-- ------------------------------------------------------------- 3. grants
-- Re-asserted, not changed: service_role only.
REVOKE ALL ON FUNCTION public.create_web_order_atomic(uuid, uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_order_atomic(uuid, uuid, text, text, boolean) TO service_role;

-- -------------------------------------------------------- 4. post-checks
DO $post$
DECLARE
  v_fn   CONSTANT regprocedure := 'public.create_web_order_atomic(uuid,uuid,text,text,boolean)'::regprocedure;
  v_n    integer;
  v_md5  text;
  v_bad  text := '';
BEGIN
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_web_order_atomic';
  SELECT md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g'))) INTO v_md5
    FROM pg_proc WHERE oid = v_fn;
  IF v_n <> 1 THEN
    v_bad := v_bad || format(E'\n  %s overloads of create_web_order_atomic, expected 1', v_n);
  END IF;
  IF v_md5 IS DISTINCT FROM '38d1396df0eb23e4d2810b722cd51f5e' THEN
    v_bad := v_bad || format(E'\n  new body md5 %s, expected 38d1396df0eb23e4d2810b722cd51f5e', v_md5);
  END IF;

  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
       WHERE attrelid = 'public.cash_orders'::regclass AND attname = 'fx_rate_used' AND NOT attisdropped)
     IS DISTINCT FROM 'numeric(12,6)' THEN
    v_bad := v_bad || E'\n  cash_orders.fx_rate_used is not numeric(12,6)';
  END IF;
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
       WHERE attrelid = 'public.cash_orders'::regclass AND attname = 'fx_rate_date' AND NOT attisdropped)
     IS DISTINCT FROM 'date' THEN
    v_bad := v_bad || E'\n  cash_orders.fx_rate_date is not date';
  END IF;

  IF has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    v_bad := v_bad || E'\n  anon or authenticated can still EXECUTE create_web_order_atomic';
  END IF;
  IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    v_bad := v_bad || E'\n  service_role cannot EXECUTE create_web_order_atomic';
  END IF;

  IF v_bad <> '' THEN
    RAISE EXCEPTION E'STOP — post-checks failed; the whole migration is rolled back.%', v_bad;
  END IF;
END
$post$;

COMMIT;

-- ============================================================================
-- READ-ONLY VERIFICATION — run after COMMIT. Expected result in [brackets].
-- ============================================================================

-- A. The two columns. [2 rows: fx_rate_date | date ; fx_rate_used | numeric(12,6)]
SELECT a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type
  FROM pg_attribute a
 WHERE a.attrelid = 'public.cash_orders'::regclass
   AND a.attname IN ('fx_rate_used', 'fx_rate_date') AND NOT a.attisdropped
 ORDER BY 1;

-- B. The function. [overloads 1 | body_md5 38d1396df0eb23e4d2810b722cd51f5e |
--    reads_quote_rate true | loyalty_still_yen true | anon false |
--    authenticated false | service_role true]
SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'create_web_order_atomic') AS overloads,
       md5(btrim(regexp_replace(prosrc, '\s+', ' ', 'g')))                    AS body_md5,
       position('v_rate := v_quote.fx_rate;' IN prosrc) > 0                     AS reads_quote_rate,
       position('v_quote.subtotal_jpy, ''Website order '' || v_reference' IN prosrc) > 0 AS loyalty_still_yen,
       has_function_privilege('anon', oid, 'EXECUTE')                           AS anon,
       has_function_privilege('authenticated', oid, 'EXECUTE')                  AS authenticated,
       has_function_privilege('service_role', oid, 'EXECUTE')                   AS service_role
  FROM pg_proc
 WHERE oid = 'public.create_web_order_atomic(uuid,uuid,text,text,boolean)'::regprocedure;

-- C. Nothing existing was touched. [rows_with_rate 0 | php_web_orders 0
--    until the first real peso web order]
SELECT count(*) FILTER (WHERE fx_rate_used IS NOT NULL)                   AS rows_with_rate,
       count(*) FILTER (WHERE source_channel = 'web' AND currency = 'PHP') AS php_web_orders
  FROM public.cash_orders;

-- D. Postgres half-up on exact .5 products — what the website edge function
--    mirrors with integer maths. [30835 | 32528 | 129086]
--    In JavaScript floating point each of these products lands just BELOW .5
--    (100000 * 0.308345 = 30834.499999999996), so Math.round would quote ₱1
--    less than the order stores. That is why the edge does not use it.
SELECT round(100000 * 0.308345::numeric(12,6)) AS "100000 x 0.308345 = 30834.5",
       round(75000  * 0.433700::numeric(12,6)) AS "75000 x 0.4337 = 32527.5",
       round(375000 * 0.344228::numeric(12,6)) AS "375000 x 0.344228 = 129085.5";
