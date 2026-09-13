-- Web orders: one reference everywhere, a language for the customer's emails,
-- and an expiry that actually runs.
--
-- 1. cash_orders.customer_lang — the language the storefront was in when the
--    order was placed ('ja' | 'en'). Every customer email about that order is
--    written in it, English below. NULL means "unknown, use Japanese".
-- 2. create_web_order_atomic gains p_lang and sets expires_at = transfer_due_at,
--    so auto-expire-cash-orders (which selects on expires_at) sees web orders.
--    Until now a web order had transfer_due_at only and would never expire.
-- 3. expire_web_order_atomic(order) — status → expired AND the stock the order
--    was holding goes back on sale, in one transaction. Used by the cron.
-- 4. Staff-notification text for cash-order submissions names the web
--    reference (CJ-W-000123) when the order is a web order — the same reference
--    the customer sees. invoice_number stays the linking key in the row.
--
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.

ALTER TABLE public.cash_orders
  ADD COLUMN IF NOT EXISTS customer_lang text
    CHECK (customer_lang IS NULL OR customer_lang IN ('ja', 'en'));

COMMENT ON COLUMN public.cash_orders.customer_lang IS
  'Storefront language at order time (ja | en). Customer emails about this order are written in it, English below. NULL = ja.';

-- The 3-argument signature is replaced by the 4-argument one (p_lang has a
-- default, so the website function may still call it with three).
DROP FUNCTION IF EXISTS public.create_web_order_atomic(uuid, uuid, text);

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

REVOKE ALL ON FUNCTION public.create_web_order_atomic(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_order_atomic(uuid, uuid, text, text) TO service_role;

-- Expire ONE web order: status → expired (the BEFORE trigger sets
-- payment_status = cancelled) and every line's stock goes back on sale.
-- One transaction, so an order is never expired with its stock still held.
-- Returns {ok:false, reason} when the order is not a pending web order — the
-- caller (auto-expire-cash-orders) then leaves it alone.
CREATE OR REPLACE FUNCTION public.expire_web_order_atomic(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_updated  integer;
  v_restored integer := 0;
BEGIN
  UPDATE public.cash_orders
     SET status = 'expired'::cash_order_status, expired_at = now()
   WHERE id = p_order_id
     AND source_channel = 'web'
     AND status = 'pending'::cash_order_status;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_pending_web_order');
  END IF;

  UPDATE public.website_product_variants v
     SET stock_qty = v.stock_qty + i.quantity, updated_at = now()
    FROM public.cash_order_items i
   WHERE i.cash_order_id = p_order_id
     AND i.variant_id = v.id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'order_id', p_order_id, 'lines_restored', v_restored);
END $function$;

REVOKE ALL ON FUNCTION public.expire_web_order_atomic(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_web_order_atomic(uuid) TO service_role;

-- Staff bell: a cash-order submission is named by the reference the customer
-- quotes. Web order → CJ-W-000123; Hub order → its invoice number.
CREATE OR REPLACE FUNCTION public.notify_submission_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice text;
  v_label   text;
BEGIN
  BEGIN
    SELECT invoice_number INTO v_invoice
      FROM public.layaway_accounts WHERE id = NEW.account_id;
    v_label := v_invoice;
    IF v_invoice IS NULL AND NEW.cash_order_id IS NOT NULL THEN
      SELECT invoice_number,
             CASE WHEN source_channel = 'web' AND web_reference IS NOT NULL THEN web_reference ELSE invoice_number END
        INTO v_invoice, v_label
        FROM public.cash_orders WHERE id = NEW.cash_order_id;
    END IF;
    PERFORM public.staff_notify(
      'submission_created',
      'New payment submission',
      COALESCE(
        NEW.sender_name,
        (SELECT full_name FROM public.customers WHERE id = NEW.customer_id),
        'Unknown sender'
      )
      || ' submitted ' || COALESCE(NEW.submitted_amount::text, '?')
      || COALESCE(' · ' || CASE WHEN v_label LIKE 'CJ-W-%' THEN 'Order ' ELSE 'Inv #' END || v_label, ''),
      NEW.account_id,
      NEW.customer_id,
      v_invoice,
      jsonb_build_object('submission_id', NEW.id, 'method', NEW.payment_method)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.notify_submission_reviewed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice text;
  v_label   text;
BEGIN
  BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::text IN ('confirmed','rejected') THEN
      SELECT invoice_number INTO v_invoice FROM public.layaway_accounts WHERE id = NEW.account_id;
      v_label := v_invoice;
      IF v_invoice IS NULL AND NEW.cash_order_id IS NOT NULL THEN
        SELECT invoice_number,
               CASE WHEN source_channel = 'web' AND web_reference IS NOT NULL THEN web_reference ELSE invoice_number END
          INTO v_invoice, v_label
          FROM public.cash_orders WHERE id = NEW.cash_order_id;
      END IF;
      PERFORM public.staff_notify(
        'submission_' || NEW.status::text, 'Payment ' || NEW.status::text,
        COALESCE(NEW.submitted_amount::text,'?') || ' from ' || COALESCE(NEW.sender_name,'Unknown')
          || ' ' || NEW.status::text || ' by ' || public.staff_display_name(NEW.reviewer_user_id)
          || COALESCE(' · ' || CASE WHEN v_label LIKE 'CJ-W-%' THEN 'Order ' ELSE 'Inv #' END || v_label, ''),
        NEW.account_id, NEW.customer_id, v_invoice,
        jsonb_build_object('submission_id', NEW.id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

-- ============================================================ VERIFICATION
--   SELECT column_name FROM information_schema.columns WHERE table_name='cash_orders' AND column_name='customer_lang';  -- 1 row
--   SELECT pg_get_function_identity_arguments(oid) FROM pg_proc WHERE proname='create_web_order_atomic';
--     -- exactly one row: p_customer_id uuid, p_quote_id uuid, p_method text, p_lang text
--   SELECT count(*) FROM pg_proc WHERE proname='expire_web_order_atomic';  -- 1
--   SELECT prosrc LIKE '%web_reference%' FROM pg_proc WHERE proname='notify_submission_created';  -- true
