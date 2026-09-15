-- Payment region by CURRENCY, not by shipping country.
--
-- THE DEFECT (found in the 2026-09-15 step-4 acceptance run, a blocker):
-- a peso-settled layaway plan on a Japanese address was shown Rakuten Bank, a
-- yen-only account. The customer cannot pay pesos into it, so the plan could
-- not be placed at all.
--
-- ROOT CAUSE: shipping country and payment account were one value. The website
-- function's regionForCountry() maps the SHIPPING ADDRESS country to
-- 'JP' | 'OVERSEAS' and selects transfer_payment_methods on that region. Those
-- are two different questions:
--     where does the parcel go?          -> the address country
--     what can the account RECEIVE?      -> the currency the customer chose
-- They coincided only by accident of the live data: two active rows, JP/Rakuten
-- happening to take yen and OVERSEAS/Metrobank happening to take pesos. Nothing
-- recorded which currency a method can actually accept, so nothing could select
-- on it. A Japan-resident Filipino settling in pesos is the case that breaks —
-- and it is a case the business explicitly supports (settlement currency is the
-- customer's choice at checkout, owner decision 2026-09-13).
--
-- WHAT THIS DOES: records the currency each method receives, so the bank can
-- follow the currency. region is NOT removed — it still groups the methods for
-- staff in Settings and still describes the destination. Shipping is untouched:
-- shippingFor() reads shipping_rates by address country and keeps doing so.

-- ============================================================ 1. the column
-- Nullable first so the backfill can run before the constraints bite.
ALTER TABLE public.transfer_payment_methods
  ADD COLUMN IF NOT EXISTS currency text;

-- ============================================================== 2. backfill
-- region is what currency has meant in practice, so it is the honest source:
-- the JP account receives yen, the overseas account receives pesos. Verified
-- against the live rows before writing this (2026-09-15) — two active rows,
-- both method_type 'bank', both complete, and NEITHER contradicts the mapping:
--   JP       -> Rakuten Bank Ltd (楽天銀行), 普通 7555832   -> yen
--   OVERSEAS -> Metrobank, Current 397-7-397-55124-1      -> pesos
-- Guarded on IS NULL so a re-run never overwrites a currency staff have since
-- set by hand.
UPDATE public.transfer_payment_methods
   SET currency = 'JPY'
 WHERE currency IS NULL AND region = 'JP';

UPDATE public.transfer_payment_methods
   SET currency = 'PHP'
 WHERE currency IS NULL AND region = 'OVERSEAS';

-- Any row a future region value left behind would break the NOT NULL below, so
-- fail loudly here with the count rather than at the ALTER with no explanation.
DO $$
DECLARE v_unset int;
BEGIN
  SELECT count(*) INTO v_unset
    FROM public.transfer_payment_methods WHERE currency IS NULL;
  IF v_unset > 0 THEN
    RAISE EXCEPTION
      'transfer_payment_methods: % row(s) have no currency after backfill. '
      'Set them by hand (Settings -> Payment Methods) before re-running.', v_unset;
  END IF;
END $$;

-- ========================================================== 3. constraints
-- NOT NULL with NO DEFAULT, deliberately. A default would mean a new Philippine
-- account added without touching the currency field silently becomes JPY and
-- gets offered to yen customers — a wrong-account bug of exactly the kind this
-- migration exists to remove. Better that a writer which forgets the column
-- fails loudly. The only writer is Settings -> Payment Methods, updated in the
-- same change to always send it.
ALTER TABLE public.transfer_payment_methods
  ALTER COLUMN currency SET NOT NULL;

ALTER TABLE public.transfer_payment_methods
  DROP CONSTRAINT IF EXISTS transfer_payment_methods_currency_check;
ALTER TABLE public.transfer_payment_methods
  ADD CONSTRAINT transfer_payment_methods_currency_check
  CHECK (currency = ANY (ARRAY['JPY'::text, 'PHP'::text]));

COMMENT ON COLUMN public.transfer_payment_methods.currency IS
  'The currency this account can RECEIVE. The website function selects methods by this, not by region: a customer settling in pesos must be shown a peso-capable account whatever country they ship to. JPY or PHP.';

COMMENT ON COLUMN public.transfer_payment_methods.region IS
  'Where the order ships: JP or OVERSEAS. Groups methods for staff and describes the destination. It does NOT decide which account a customer is shown — currency does. The two were one value until 2026-09-15 and that conflation was the blocker.';

-- The website function filters active methods by currency on every quote, every
-- pay, and every order/plan read, so the lookup is worth an index even at two
-- rows — it stays cheap as methods are added.
CREATE INDEX IF NOT EXISTS idx_transfer_payment_methods_currency
  ON public.transfer_payment_methods (currency)
  WHERE is_active;

-- Verification after applying — expect exactly the two rows, each with the
-- currency its account actually receives, and no nulls:
--   SELECT region, currency, method_type, bank_name, is_active
--     FROM public.transfer_payment_methods ORDER BY currency, sort_order;
--   -- expect 0
--   SELECT count(*) FROM public.transfer_payment_methods WHERE currency IS NULL;
