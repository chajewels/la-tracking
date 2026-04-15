-- Promotions: add optional expiration timestamp.
-- When expires_at IS NOT NULL AND expires_at < now(), the promo is
-- considered expired and is hidden from the customer portal banner,
-- regardless of is_active.
ALTER TABLE public.promotions
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS promotions_expires_at_idx
  ON public.promotions (expires_at)
  WHERE expires_at IS NOT NULL;
