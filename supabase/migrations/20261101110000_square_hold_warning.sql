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

-- ---------------------------------------------------------------------------
-- Card attempts (review finding S6, 2026-10-04): a declined card never creates
-- a submission, so the 3-per-24h submission cap cannot see card testing. One
-- row per CreatePayment attempt on an order (any outcome), written by
-- `website` only; POST /orders/:id/card refuses 429 too_many_attempts at
-- CARD_ATTEMPTS_PER_DAY (5) per order per rolling 24 h BEFORE calling Square.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.square_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id      uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE CASCADE,
  customer_id        uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  outcome            text NOT NULL,
  detail             text,
  square_payment_id  text,
  test               boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_square_attempts_order_time ON public.square_attempts (cash_order_id, created_at DESC);
ALTER TABLE public.square_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS square_attempts_staff_select ON public.square_attempts;
CREATE POLICY square_attempts_staff_select ON public.square_attempts
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.square_attempts FROM anon;
GRANT SELECT ON public.square_attempts TO authenticated;
GRANT ALL ON public.square_attempts TO service_role;
COMMENT ON TABLE public.square_attempts IS
  'One row per Square CreatePayment attempt from the website (authorized | declined | refused | mismatch | error). Rate-limit evidence only; money state lives in square_payments.';

DO $chk2$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'square_attempts') THEN
    RAISE EXCEPTION 'square: square_attempts missing';
  END IF;
END
$chk2$;
