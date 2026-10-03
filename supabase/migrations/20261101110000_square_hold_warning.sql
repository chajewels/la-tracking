-- ===========================================================================
-- Square card payments, S2 (2026-10-04): the hold-expiry warning stamp.
-- docs/SQUARE.md. Owner Q2 (2026-10-04 01:07): an unconfirmed hold is
-- cancelled by Square at the end of its 7-day window and the submission
-- auto-rejects; the Hub rings card_hold_expiring once from day 5 so a reviewer
-- acts first. auto-expire-cash-orders writes warned_at (once per hold) and
-- nothing else; orders and submissions are untouched (INVARIANT 12).
-- Idempotent: safe to re-run.
-- ===========================================================================
ALTER TABLE public.square_payments
  ADD COLUMN IF NOT EXISTS warned_at timestamptz;
COMMENT ON COLUMN public.square_payments.warned_at IS
  'When the card_hold_expiring bell rang for this hold (once; auto-expire-cash-orders, from day 5 of the 7-day window). NULL = not yet.';
CREATE INDEX IF NOT EXISTS idx_square_payments_hold_warning
  ON public.square_payments (authorized_at)
  WHERE status = 'authorized' AND warned_at IS NULL;

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'square_payments' AND column_name = 'warned_at') THEN
    RAISE EXCEPTION 'square: warned_at missing';
  END IF;
END
$chk$;
