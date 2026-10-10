-- 20261208150000_paidy_recorded_bell_once.sql
-- Paidy reassessment F2, QA reopen (2026-10-10 23:21 JST; owner go 23:24).
--
-- The "Paidy payment recorded" bell was rung by two paths (review-payment-
-- submission at recording time, paidy-reconcile late) with a read-then-insert,
-- and the late sweep read only the 50 oldest recordings. QA reproduced:
--   (1) a missing bell beyond the first 50 recordings was never reached;
--   (2) two overlapping sweeps (or a sweep and the normal ring) could both see
--       "no bell" and both insert.
--
-- This migration makes both properties hold in the database:
--   * uq_staff_notifications_paidy_recorded — at most ONE paidy_payment_recorded
--     bell per cash payment (metadata->>'cash_payment_id').
--   * ring_paidy_payment_recorded_bell(...) — the ONE writer of that bell, used
--     by BOTH paths: INSERT … ON CONFLICT DO NOTHING; returns true only when it
--     inserted (so the staff-email fan-out trigger fires once, for that row).
--   * paidy_recorded_bell_missing(...) — lists ONLY the confirmed Paidy
--     recordings in the window that have no bell, keyset-paged, so the sweep
--     walks all of them however many already have bells.
--
-- Touches no money: no payment, order, submission or allocation is read for
-- writing or written. New objects only; no existing function is redefined.
-- Live check 2026-10-10 23:23 JST: 0 duplicate paidy_payment_recorded bells,
-- 0 bells of that type in total.

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.staff_notifications
     WHERE type = 'paidy_payment_recorded' AND metadata->>'cash_payment_id' IS NOT NULL
     GROUP BY metadata->>'cash_payment_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'STOP — duplicate paidy_payment_recorded bells exist on live; report them, do not delete';
  END IF;
END
$guard$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_notifications_paidy_recorded
  ON public.staff_notifications ((metadata->>'cash_payment_id'))
  WHERE type = 'paidy_payment_recorded';

CREATE OR REPLACE FUNCTION public.ring_paidy_payment_recorded_bell(
  p_title text, p_body text, p_metadata jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata->'cash_payment_id') IS DISTINCT FROM 'string'
     OR (p_metadata->>'cash_payment_id') !~ '^[0-9a-fA-F-]{36}$' THEN
    RAISE EXCEPTION 'cash_payment_id_required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.staff_notifications (type, title, body, metadata)
  VALUES ('paidy_payment_recorded', p_title, p_body, p_metadata)
  ON CONFLICT ((metadata->>'cash_payment_id')) WHERE type = 'paidy_payment_recorded'
  DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id IS NOT NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.ring_paidy_payment_recorded_bell(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ring_paidy_payment_recorded_bell(text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.paidy_recorded_bell_missing(
  p_since timestamptz, p_until timestamptz,
  p_after_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  cash_payment_id uuid, payment_created_at timestamptz, amount_paid numeric,
  cash_order_id uuid, submission_id uuid, sender_name text, reviewer_user_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT cp.id, cp.created_at, cp.amount_paid, cp.cash_order_id, s.id, s.sender_name, s.reviewer_user_id
    FROM public.payment_submissions s
    JOIN public.cash_payments cp ON cp.id = s.confirmed_payment_id
   WHERE s.paidy_payment_id IS NOT NULL
     AND s.status = 'confirmed'
     AND cp.voided_at IS NULL
     AND cp.created_at >= p_since
     AND cp.created_at <= p_until
     AND (p_after_at IS NULL OR (cp.created_at, cp.id) > (p_after_at, p_after_id))
     AND NOT EXISTS (
       SELECT 1 FROM public.staff_notifications n
        WHERE n.type = 'paidy_payment_recorded'
          AND n.metadata->>'cash_payment_id' = cp.id::text)
   ORDER BY cp.created_at, cp.id
   LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;

REVOKE ALL ON FUNCTION public.paidy_recorded_bell_missing(timestamptz, timestamptz, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paidy_recorded_bell_missing(timestamptz, timestamptz, timestamptz, uuid, integer) TO service_role;
