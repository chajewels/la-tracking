-- Promotions: add price + currency (required for all promos).
-- Also allow public read of the php_jpy_rate row in system_settings so the
-- customer portal banner can render the live conversion next to the price.

ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS price numeric(12, 2),
  ADD COLUMN IF NOT EXISTS currency text;

-- Currency constraint: must be PHP or JPY.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'promotions_currency_check'
  ) THEN
    ALTER TABLE public.promotions
      ADD CONSTRAINT promotions_currency_check
      CHECK (currency IS NULL OR currency IN ('PHP', 'JPY'));
  END IF;
END $$;

-- Public read of just the php_jpy_rate row — the rest of system_settings
-- stays staff-only. Needed by the unauthenticated /portal banner.
DROP POLICY IF EXISTS "Public read php_jpy_rate" ON public.system_settings;
CREATE POLICY "Public read php_jpy_rate"
  ON public.system_settings
  FOR SELECT
  TO anon, authenticated
  USING (key = 'php_jpy_rate');
