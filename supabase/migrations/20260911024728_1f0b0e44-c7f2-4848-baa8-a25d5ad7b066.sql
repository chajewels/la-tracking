-- Phase 2, step 2 — cart, checkout quote, transfer orders.
-- Plan: docs/PHASE2-WEBSITE.md · task: cha-jewels-web docs/tasks/phase2-step2-checkout.md
--
-- ============================================================================
-- WHAT THE TASK ASSUMED vs WHAT IS LIVE  (checked against the database 2026-09-11)
-- ============================================================================
-- The task says "`orders`, `order_items`, `layaway_plans`, `layaway_payments`
-- already exist for Live/DM sales. Extend, never fork." None of those four
-- tables exist. What exists is:
--
--     orders            -> cash_orders            (39 cols, 153 rows)
--     order_items       -> cash_order_items       (11 cols, maps nearly 1:1)
--     layaway_plans     -> layaway_accounts       (40 cols)
--     layaway_payments  -> payments + layaway_schedule
--
-- The task's own escape hatch applies: "if a different shape exists, map to
-- it." So this migration EXTENDS cash_orders / cash_order_items rather than
-- creating orders / order_items, which would be exactly the fork the task
-- forbids. Creating a parallel order table would also make every web order
-- invisible to machinery that is keyed on cash_orders today:
--
--   * award-loyalty-points (cash orders award on full completion)
--   * the store-credit cancellation policy (cash orders only)
--   * test-account exclusion (numeric invoice_number regex)
--   * Finance Overview KPIs, Trade Program metrics, staff_notifications
--   * CLAUDE.md "ACCOUNT-SCOPE COVERAGE" — cash orders are first-class accounts
--
-- cash_orders already carries source_channel, shipping_fee, is_test, is_trade,
-- loyalty_jpy_amount and five triggers. A web order is a cash order whose
-- source_channel is 'web'.
--
-- ============================================================================
-- INVOICE NUMBER vs WEB REFERENCE — why there are two
-- ============================================================================
-- cash_orders.invoice_number is NOT NULL and UNIQUE, and CLAUDE.md's
-- TEST ACCOUNT EXCLUSION makes `invoice_number ~ '^[0-9]+$'` the test for "is
-- this a real account" on every financial surface. A web order IS real, so it
-- needs a NUMERIC invoice number or it silently drops out of Finance.
--
-- Staff invoice numbers come from a physical book; the highest live value is
-- 19656 (layaway) / 19650 (cash). Web orders therefore draw from a dedicated
-- sequence starting at 900001 — numeric, so the regex admits them, and far
-- above the book so the two can never collide.
--
-- web_reference ('CJ-W-000123') is the code shown to the CUSTOMER, derived
-- from the same sequence value, so staff can cross-reference either way. It is
-- a display code, never a financial key.
--
-- Test customers are unaffected: enforce_test_invoice_prefix() still rewrites
-- the number to TEST-900001 at write time, which is the intended behaviour.

-- ================================================== 1. cash_orders: channel
-- 'web' is not currently an allowed source_channel. Replace the CHECK rather
-- than adding a second one, so there is a single definition to read.
ALTER TABLE public.cash_orders DROP CONSTRAINT IF EXISTS cash_orders_source_channel_check;
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_source_channel_check
  CHECK (source_channel = ANY (ARRAY['hub_manual','shopify_direct','social_manual','pancake','web']));

-- ================================================ 2. cash_orders: web fields
-- All nullable or defaulted, so the 153 existing rows are untouched and every
-- existing writer keeps working without knowing these columns exist.
ALTER TABLE public.cash_orders
  ADD COLUMN IF NOT EXISTS order_type        text,
  ADD COLUMN IF NOT EXISTS payment_method    text,
  ADD COLUMN IF NOT EXISTS payment_status    text,
  ADD COLUMN IF NOT EXISTS ship_to_address_id uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recipient_name    text,
  ADD COLUMN IF NOT EXISTS recipient_phone   text,
  ADD COLUMN IF NOT EXISTS gift_note         text,
  ADD COLUMN IF NOT EXISTS quote_id          uuid,
  ADD COLUMN IF NOT EXISTS web_reference     text,
  ADD COLUMN IF NOT EXISTS transfer_due_at   timestamptz;

DO $$ BEGIN
  ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_order_type_check
    CHECK (order_type IS NULL OR order_type = ANY (ARRAY['SELF','GIFT','PROXY']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_payment_method_check
    CHECK (payment_method IS NULL OR payment_method = ANY (ARRAY['square','transfer']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_payment_status_check
    CHECK (payment_status IS NULL OR payment_status = ANY (
      ARRAY['pending_transfer','paid','failed','refunded','cancelled']));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS cash_orders_web_reference_unique
  ON public.cash_orders (web_reference) WHERE web_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cash_orders_web_pending
  ON public.cash_orders (transfer_due_at)
  WHERE source_channel = 'web' AND payment_status = 'pending_transfer';

COMMENT ON COLUMN public.cash_orders.payment_status IS
  'Web-checkout payment state. The cash_order_status enum (pending/completed/cancelled/expired) is unchanged and still drives every existing Hub surface: a web order awaiting a bank transfer is status=''pending'' + payment_status=''pending_transfer''. Confirming the transfer sets status=''completed'' + payment_status=''paid'', which is what award-loyalty-points already watches for.';
COMMENT ON COLUMN public.cash_orders.transfer_due_at IS
  'Deadline for a bank/GCash transfer (72h from order). Deliberately NOT expires_at: the auto-expire-cash-orders cron acts on expires_at and would flip the order to ''expired'' WITHOUT restoring the stock it holds. expire_transfer_orders() owns this column and does both.';
COMMENT ON COLUMN public.cash_orders.web_reference IS
  'Customer-facing order code (CJ-W-000123). Display only — invoice_number remains the financial key and stays numeric so the test-account regex admits web orders.';

-- =========================================== 3. cash_order_items: variant link
-- title / sku / quantity / unit_price_jpy / line_total_jpy already exist and
-- match the task's order_items shape. Only the variant pointer is missing.
ALTER TABLE public.cash_order_items
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cash_order_items_variant
  ON public.cash_order_items (variant_id) WHERE variant_id IS NOT NULL;

-- ==================================================== 4. web invoice sequence
-- 900001+. See the header for why this range.
CREATE SEQUENCE IF NOT EXISTS public.web_order_number_seq
  AS bigint START WITH 900001 MINVALUE 900001 INCREMENT BY 1 NO CYCLE;
REVOKE ALL ON SEQUENCE public.web_order_number_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SEQUENCE public.web_order_number_seq TO service_role;

-- ======================================================= 5. shipping_rates
-- A rate card, which is what the task means by shipping_rates. The existing
-- shipping_methods table is carrier + tracking and is a different thing.
-- Rule: the matching row is the one with the HIGHEST min_subtotal_jpy that the
-- subtotal clears, for that country; no row for the country => manual quote.
CREATE TABLE IF NOT EXISTS public.shipping_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL,
  min_subtotal_jpy integer NOT NULL DEFAULT 0 CHECK (min_subtotal_jpy >= 0),
  fee_jpy integer NOT NULL CHECK (fee_jpy >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, min_subtotal_jpy)
);

COMMENT ON TABLE public.shipping_rates IS
  'Storefront shipping rate card. Read by the website function''s /checkout/quote. A country with no active row returns shipping: null + requires_manual_quote: true rather than guessing a fee.';

DROP TRIGGER IF EXISTS trg_shipping_rates_updated_at ON public.shipping_rates;
CREATE TRIGGER trg_shipping_rates_updated_at
  BEFORE UPDATE ON public.shipping_rates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.shipping_rates ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.shipping_rates TO service_role;

-- Staff need to read and edit the card in the Hub. Unlike customer_addresses,
-- this table holds no customer data, and the policy references only
-- has_role(), not another RLS-protected table — so Bug #165's fail-closed
-- trap does not apply here.
DO $$ BEGIN
  CREATE POLICY shipping_rates_staff_read ON public.shipping_rates
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY shipping_rates_admin_write ON public.shipping_rates
    FOR ALL TO authenticated
    USING (public.has_role(auth.uid(), 'admin'::app_role))
    WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO public.shipping_rates (country, min_subtotal_jpy, fee_jpy)
VALUES ('JP', 0, 800), ('JP', 50000, 0), ('PH', 0, 3500), ('PH', 100000, 0)
ON CONFLICT (country, min_subtotal_jpy) DO NOTHING;

-- ================================================== 6. payment_instructions
-- Transfer details, per country, in both languages. PLACEHOLDER TEXT ONLY —
-- Cynthia supplies the real bank and GCash details. Account numbers are never
-- invented here; the storefront shows whatever this table holds.
CREATE TABLE IF NOT EXISTS public.payment_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL UNIQUE,
  method_label_ja text NOT NULL,
  method_label_en text NOT NULL,
  body_ja text NOT NULL,
  body_en text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.payment_instructions IS
  'Bank / GCash transfer instructions shown at checkout and on the order page, keyed by shipping country. Seeded with placeholders: real account details are entered by Cynthia in the Hub. Never populate this with invented account numbers.';

DROP TRIGGER IF EXISTS trg_payment_instructions_updated_at ON public.payment_instructions;
CREATE TRIGGER trg_payment_instructions_updated_at
  BEFORE UPDATE ON public.payment_instructions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.payment_instructions ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.payment_instructions TO service_role;

DO $$ BEGIN
  CREATE POLICY payment_instructions_staff_read ON public.payment_instructions
    FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY payment_instructions_admin_write ON public.payment_instructions
    FOR ALL TO authenticated
    USING (public.has_role(auth.uid(), 'admin'::app_role))
    WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO public.payment_instructions (country, method_label_ja, method_label_en, body_ja, body_en)
VALUES
  ('JP', '銀行振込', 'Bank transfer',
   E'【お振込先は準備中です】\n担当者より、ご注文確認メールにてお振込先の口座情報をご案内いたします。\nお振込名義はご注文者さまのお名前でお願いいたします。\n恐れ入りますが、振込手数料はお客さまのご負担となります。',
   E'[Bank details are being finalised.]\nOur team will send the transfer account details with your order confirmation email.\nPlease transfer under the name used on the order.\nTransfer fees are paid by the customer.'),
  ('PH', 'GCash / 銀行振込', 'GCash / bank transfer',
   E'【お振込先は準備中です】\n担当者より、ご注文確認メールにて GCash または銀行口座の情報をご案内いたします。\nお振込後、送金確認画面のスクリーンショットをお送りください。',
   E'[Payment details are being finalised.]\nOur team will send the GCash or bank account details with your order confirmation email.\nAfter paying, please send a screenshot of the confirmation.')
ON CONFLICT (country) DO NOTHING;

-- ======================================================= 7. checkout_quotes
CREATE TABLE IF NOT EXISTS public.checkout_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  items jsonb NOT NULL,
  mode text NOT NULL DEFAULT 'full' CHECK (mode = ANY (ARRAY['full','layaway'])),
  term_months integer,
  order_type text NOT NULL DEFAULT 'SELF' CHECK (order_type = ANY (ARRAY['SELF','GIFT','PROXY'])),
  ship_to_address_id uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL,
  recipient_name text,
  recipient_phone text,
  gift_note text,
  subtotal_jpy integer NOT NULL CHECK (subtotal_jpy >= 0),
  shipping_jpy integer,
  total_jpy integer NOT NULL CHECK (total_jpy >= 0),
  deposit_jpy integer,
  schedule jsonb,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.checkout_quotes IS
  'A priced basket held for 30 minutes. A quote does NOT reserve stock — stock is decremented only by create_web_order_atomic at pay time, so an abandoned checkout never holds a one-of-a-kind piece hostage.';

CREATE INDEX IF NOT EXISTS idx_checkout_quotes_customer
  ON public.checkout_quotes (customer_id, created_at DESC);

ALTER TABLE public.checkout_quotes ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.checkout_quotes TO service_role;
-- No anon/authenticated policy, deliberately: reached only through the website
-- edge function under service role, same posture as customer_addresses.

-- ================================================ 8. create_web_order_atomic
-- One transaction for: re-price check, stock decrement, order, items, quote
-- consumption. Split across PostgREST calls this would be a race — two buyers
-- could both pass a stock check before either decremented — and a failure
-- halfway would leave stock decremented with no order against it.
-- Follows CLAUDE.md's LOCKED RULE (2026-05-17): one RPC, one transaction.
CREATE OR REPLACE FUNCTION public.create_web_order_atomic(
  p_customer_id uuid,
  p_quote_id uuid,
  p_method text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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

    INSERT INTO public.cash_order_items (
      cash_order_id, product_id, variant_id, title, sku, quantity,
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
END $$;

REVOKE ALL ON FUNCTION public.create_web_order_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_order_atomic(uuid, uuid, text) TO service_role;

-- ================================================ 9. expire_transfer_orders
-- Hourly. Cancels web transfer orders past their deadline and PUTS THE STOCK
-- BACK. Written as a SQL function called directly by pg_cron rather than an
-- edge function: no HTTP hop, no Vault service key to drift out of sync (the
-- failure mode CLAUDE.md's CRON AUTH RULE exists to prevent), and the cancel
-- plus the stock restore land in one transaction.
--
-- 'cancelled' is TERMINAL for cash_orders, so the guard below is not optional:
-- it must never re-cancel, and must never touch an order that has been paid.
CREATE OR REPLACE FUNCTION public.expire_transfer_orders()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order  record;
  v_item   record;
  v_count  integer := 0;
BEGIN
  FOR v_order IN
    SELECT id, web_reference FROM public.cash_orders
     WHERE source_channel = 'web'
       AND payment_method = 'transfer'
       AND payment_status = 'pending_transfer'
       AND status = 'pending'
       AND status <> 'cancelled'
       AND total_paid = 0
       AND transfer_due_at IS NOT NULL
       AND transfer_due_at <= now()
     FOR UPDATE SKIP LOCKED
  LOOP
    FOR v_item IN
      SELECT variant_id, quantity FROM public.cash_order_items
       WHERE cash_order_id = v_order.id AND variant_id IS NOT NULL
    LOOP
      UPDATE public.website_product_variants
         SET stock_qty = stock_qty + v_item.quantity, updated_at = now()
       WHERE id = v_item.variant_id;
    END LOOP;

    UPDATE public.cash_orders
       SET status = 'cancelled'::cash_order_status,
           payment_status = 'cancelled',
           cancelled_at = now(),
           cancellation_reason = 'Bank transfer not received within 72 hours (auto-cancelled)'
     WHERE id = v_order.id AND status <> 'cancelled';

    v_count := v_count + 1;
  END LOOP;

  RETURN jsonb_build_object('cancelled', v_count, 'ran_at', now());
END $$;

REVOKE ALL ON FUNCTION public.expire_transfer_orders() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_transfer_orders() TO service_role;

-- Hourly at :17, clear of the 00:00-00:45 UTC daily chain so it never competes
-- with reminders / penalties / forfeiture / reconciliation.
SELECT cron.unschedule('expire-transfer-orders')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-transfer-orders');
SELECT cron.schedule('expire-transfer-orders', '17 * * * *',
                     $cron$SELECT public.expire_transfer_orders();$cron$);

-- ============================================================ VERIFICATION
--   -- 'web' accepted, 4 shipping rows, 2 instruction rows, cron present
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conname = 'cash_orders_source_channel_check';
--   SELECT country, min_subtotal_jpy, fee_jpy FROM public.shipping_rates ORDER BY country, min_subtotal_jpy;
--   SELECT country FROM public.payment_instructions ORDER BY country;
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'expire-transfer-orders';
--   -- next web order number (does not consume it)
--   SELECT last_value, is_called FROM public.web_order_number_seq;

-- ========================================= 10. payment_status follows status
-- "Confirm transfer received" in the Hub is NOT a bespoke write. Staff record
-- the payment through the existing path (submit-cash-payment ->
-- review-payment-submission), which is the only writer of the payments table
-- and the thing that fires award-loyalty-points and the receipt. That path
-- knows nothing about payment_status, so this trigger keeps the web-facing
-- column honest instead of asking every caller to remember it.
--
-- 'cancelled' is TERMINAL: the cancelled branch only ever writes when the row
-- is arriving at cancelled, and never reopens a cancelled order.
CREATE OR REPLACE FUNCTION public.sync_web_order_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public AS $$
BEGIN
  IF NEW.source_channel IS DISTINCT FROM 'web' THEN
    RETURN NEW;
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'completed' THEN
    NEW.payment_status := 'paid';
    NEW.transfer_due_at := NULL;   -- deadline is spent; stop the expiry job
  ELSIF NEW.status IN ('cancelled', 'expired') THEN
    NEW.payment_status := 'cancelled';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_web_order_payment_status ON public.cash_orders;
CREATE TRIGGER trg_sync_web_order_payment_status
  BEFORE UPDATE ON public.cash_orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_web_order_payment_status();

-- ============================================ 11. staff bell for web orders
-- The existing INSERT trigger reads "created by <staff name>", which is empty
-- for a web order (created_by_user_id is NULL — nobody in the Hub made it).
-- Same notifier, same 'account_created' type, just a body that says where the
-- order came from. Behaviour for every non-web channel is unchanged.
CREATE OR REPLACE FUNCTION public.notify_cash_order_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF NEW.source_channel = 'web' THEN
      PERFORM public.staff_notify(
        'account_created', 'Website order placed',
        'Order ' || COALESCE(NEW.web_reference, NEW.invoice_number, '?') ||
          ' — awaiting bank transfer',
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object('cash_order_id', NEW.id, 'source_channel', 'web',
                           'web_reference', NEW.web_reference)
      );
    ELSE
      PERFORM public.staff_notify(
        'account_created', 'Cash order created',
        'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object('cash_order_id', NEW.id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;