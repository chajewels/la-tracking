-- Web layaway schema (Phase 2 step 4, commit 2 of 3).
--
-- A web layaway is a layaway_accounts row with source_channel = 'web'. It is the
-- same account every Hub rule already knows: the same statuses, the same
-- schedule, the same payments table, the same penalty and forfeiture lifecycle.
-- What it needs that a Hub-created account does not is a customer-facing
-- reference, the quote it came from, the two settable deadlines, the language to
-- write to the customer in, and the item lines whose stock it holds.
--
-- ITEM LINES — why a separate table, and what the alternative would have cost.
-- The build order asked whether cash_order_items could carry a nullable
-- layaway_account_id instead. It could be made to, and it should not:
--   * cash_order_items.cash_order_id is NOT NULL and is the anchor of both its
--     FK and its ON DELETE CASCADE. Carrying layaway lines means dropping that
--     NOT NULL, so every existing insert that omits the column stops erroring
--     and starts creating orphans — an integrity regression on the cash side
--     paid to serve the layaway side.
--   * Its customer-facing RLS policy ("Customers can view own cash order items")
--     scopes rows through a subquery on cash_orders. It would have to become a
--     two-branch OR across two parent tables; getting that wrong shows one
--     customer another customer's lines. Rewriting a live customer-visible
--     policy is not a side effect worth taking on.
--   * 21 references across 9 files read the table assuming a cash order parent.
-- The schema already has the answer to this exact question: money received lives
-- in `payments` for layaway and in the parallel `cash_payments` for cash orders,
-- same shape, each keyed to its own parent. CLAUDE.md names that pair approvingly.
-- `layaway_account_items` is that established pattern, not the `orders`-shaped
-- fork the plan warns against — that warning is about duplicating the ACCOUNT
-- table everything else keys on, which this does not touch.
--
-- CURRENCY (owner decision 2026-09-13). The customer chooses yen or peso
-- settlement at checkout and the account follows. The catalog is priced in yen,
-- so a peso plan converts at the Hub's daily rate; the rate and its date are
-- stored on the account so the figure is auditable years later.
-- loyalty_jpy_amount stays in YEN whatever the settlement currency — tiers are
-- yen thresholds on lifetime spend — and it comes from the yen product subtotal
-- directly, never from the converted total.

-- ---------------------------------------------------------------- accounts
ALTER TABLE public.layaway_accounts
  ADD COLUMN IF NOT EXISTS source_channel    text NOT NULL DEFAULT 'hub_manual',
  ADD COLUMN IF NOT EXISTS web_reference     text,
  ADD COLUMN IF NOT EXISTS quote_id          uuid REFERENCES public.checkout_quotes(id),
  ADD COLUMN IF NOT EXISTS transfer_due_at   timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_lang     text,
  ADD COLUMN IF NOT EXISTS expired_at        timestamptz,
  ADD COLUMN IF NOT EXISTS fx_rate_used      numeric(12,6),
  ADD COLUMN IF NOT EXISTS fx_rate_date      date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'layaway_accounts_source_channel_check') THEN
    ALTER TABLE public.layaway_accounts
      ADD CONSTRAINT layaway_accounts_source_channel_check
      CHECK (source_channel IN ('hub_manual', 'web'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'layaway_accounts_customer_lang_check') THEN
    ALTER TABLE public.layaway_accounts
      ADD CONSTRAINT layaway_accounts_customer_lang_check
      CHECK (customer_lang IS NULL OR customer_lang IN ('ja', 'en'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS layaway_accounts_web_reference_key
  ON public.layaway_accounts (web_reference) WHERE web_reference IS NOT NULL;

-- The expiry sweep's own predicate, as an index: a web plan whose deposit never
-- arrived. Keeps the hourly scan off the full table.
CREATE INDEX IF NOT EXISTS idx_layaway_accounts_web_awaiting_deposit
  ON public.layaway_accounts (transfer_due_at)
  WHERE source_channel = 'web' AND total_paid = 0 AND expired_at IS NULL;

COMMENT ON COLUMN public.layaway_accounts.source_channel IS
  'hub_manual (staff created it) or web (the customer reserved it on the storefront). Mirrors cash_orders.source_channel.';
COMMENT ON COLUMN public.layaway_accounts.transfer_due_at IS
  'Deadline for the UNPAID deposit. Settable at creation and editable while the plan is live (set_account_deadlines, edit_account permission). The expiry sweep fires on it only while no payment exists; once a deposit is confirmed the plan is confirmed and this is history.';
COMMENT ON COLUMN public.layaway_accounts.settlement_due_at IS
  'Payment-settlement due date. Stored, shown, and settable under the same rule as transfer_due_at. It drives no automation in step 4.';
COMMENT ON COLUMN public.layaway_accounts.fx_rate_used IS
  'For a PHP-settled web plan: the jpy_php rate applied to the yen catalog price at creation. Stored so the peso figures can be audited later. NULL for yen plans.';

-- -------------------------------------------------------------- quote input
-- The settlement choice is captured on the QUOTE, not read fresh at pay time:
-- the rate the customer was shown is the rate they are charged, and the quote's
-- 30-minute TTL bounds how stale it can be.
ALTER TABLE public.checkout_quotes
  ADD COLUMN IF NOT EXISTS settlement_currency text NOT NULL DEFAULT 'JPY',
  ADD COLUMN IF NOT EXISTS fx_rate             numeric(12,6),
  ADD COLUMN IF NOT EXISTS fx_rate_date        date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checkout_quotes_settlement_currency_check') THEN
    ALTER TABLE public.checkout_quotes
      ADD CONSTRAINT checkout_quotes_settlement_currency_check
      CHECK (settlement_currency IN ('JPY', 'PHP'));
  END IF;
END $$;

COMMENT ON COLUMN public.checkout_quotes.settlement_currency IS
  'Currency the customer chose to settle in. The *_jpy columns stay in yen — they are the catalog truth and the loyalty basis; the account is created in this currency using fx_rate.';

-- ------------------------------------------------------------------- items
CREATE TABLE IF NOT EXISTS public.layaway_account_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  website_product_id uuid REFERENCES public.website_products(id) ON DELETE SET NULL,
  variant_id         uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL,
  title              text NOT NULL,
  sku                text,
  quantity           integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_jpy     numeric NOT NULL,
  line_total_jpy     numeric NOT NULL,
  image_url          text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_layaway_account_items_account ON public.layaway_account_items (account_id);

COMMENT ON TABLE public.layaway_account_items IS
  'Catalog lines a web layaway holds stock for. The layaway-side twin of cash_order_items, exactly as payments is the twin of cash_payments. Prices stay in YEN (the catalog currency) whatever the account settles in.';

ALTER TABLE public.layaway_account_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all_layaway_account_items ON public.layaway_account_items;
CREATE POLICY admin_all_layaway_account_items ON public.layaway_account_items
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS staff_read_layaway_account_items ON public.layaway_account_items;
CREATE POLICY staff_read_layaway_account_items ON public.layaway_account_items
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'staff'::public.app_role)
      OR public.has_role(auth.uid(), 'finance'::public.app_role)
      OR public.has_role(auth.uid(), 'csr'::public.app_role));

-- Same shape as the cash-order policy: a customer sees the lines of their own
-- accounts and no others.
DROP POLICY IF EXISTS customers_read_own_layaway_account_items ON public.layaway_account_items;
CREATE POLICY customers_read_own_layaway_account_items ON public.layaway_account_items
  FOR SELECT TO authenticated
  USING (account_id IN (
    SELECT la.id FROM public.layaway_accounts la
     WHERE la.customer_id IN (SELECT c.id FROM public.customers c WHERE c.auth_user_id = auth.uid())
  ));

-- Writes are service-role only (create_web_layaway_atomic). No INSERT/UPDATE
-- policy for authenticated is granted on purpose.

-- ------------------------------------------------------------ delete guard
-- Same reasoning as trg_prevent_web_order_delete: the customer's order history,
-- the stock hold and the points reversal all hang off the row. A web plan
-- expires (deposit never paid) or runs its lifecycle. It is never deleted.
-- The paid-order guard from 20260913110000 already covers it once money lands;
-- this covers it from the first minute, before any payment exists.
CREATE OR REPLACE FUNCTION public.prevent_web_layaway_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.source_channel = 'web' THEN
    RAISE EXCEPTION 'web_layaway_delete_forbidden: % is a web layaway — it expires or runs its lifecycle, it is never deleted',
      COALESCE(OLD.web_reference, OLD.invoice_number)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_prevent_web_layaway_delete ON public.layaway_accounts;
CREATE TRIGGER trg_prevent_web_layaway_delete
  BEFORE DELETE ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.prevent_web_layaway_delete();