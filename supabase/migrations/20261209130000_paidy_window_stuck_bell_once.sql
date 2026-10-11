-- 20261209130000_paidy_window_stuck_bell_once.sql
-- "A Paidy approval is still waiting to be checked" bell (paidy_window_stuck):
-- one bell per checkout window, enforced by the database (owner go 2026-10-11
-- 11:43 JST "check and fix and document"; residual noted by QA in its
-- 2026-10-11 11:41 verdict on item 4).
--
-- paidy-reconcile rang it by reading open, noted windows with no
-- stuck_bell_at, inserting the bell, then stamping stuck_bell_at in a second
-- call. Two overlapping runs could both read "no stamp" and both insert, and
-- the read took only 25 rows (no order), so windows whose ring kept failing
-- could hide others.
--
--   * uq_staff_notifications_paidy_window_stuck — at most ONE
--     paidy_window_stuck bell per metadata->>'attempt_id'.
--   * ring_paidy_window_stuck_bell(attempt_id, title, body, metadata) — the
--     ONE writer. Locks the window, refuses one that is no longer open or
--     holds no noted approval ('closed', nothing written), INSERT … ON
--     CONFLICT DO NOTHING, stamps stuck_bell_at in the same transaction.
--     Returns 'rung' only when it inserted (the staff-email fan-out fires
--     once), 'exists' when a bell was already there.
--   * paidy_window_stuck_missing(cutoff, after_at, after_id, limit) — open,
--     noted windows past the cutoff with no stamp, keyset-paged on
--     (expires_at, id), so the sweep walks all of them.
--
-- Touches no money. New objects only; no existing function is redefined.
-- Live check 2026-10-11 11:45 JST: 0 paidy_window_stuck bells, 0 stamped
-- windows, 12 checkout windows in total.

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.staff_notifications
     WHERE type = 'paidy_window_stuck' AND metadata->>'attempt_id' IS NOT NULL
     GROUP BY metadata->>'attempt_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'STOP — duplicate paidy_window_stuck bells exist on live; report them, do not delete';
  END IF;
END
$guard$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_notifications_paidy_window_stuck
  ON public.staff_notifications ((metadata->>'attempt_id'))
  WHERE type = 'paidy_window_stuck';

CREATE OR REPLACE FUNCTION public.ring_paidy_window_stuck_bell(
  p_attempt_id uuid, p_title text, p_body text, p_metadata jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_w public.paidy_checkout_attempts%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_attempt_id IS NULL THEN
    RAISE EXCEPTION 'attempt_id_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_w FROM public.paidy_checkout_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_w.status <> 'open' OR v_w.authorization_noted_at IS NULL THEN
    RETURN 'closed';
  END IF;
  INSERT INTO public.staff_notifications (type, title, body, metadata)
  VALUES ('paidy_window_stuck', p_title, p_body,
          coalesce(p_metadata, '{}'::jsonb)
            || jsonb_build_object('attempt_id', v_w.id::text, 'cash_order_id', v_w.cash_order_id,
                                  'paidy_payment_id', v_w.paidy_payment_id))
  ON CONFLICT ((metadata->>'attempt_id')) WHERE type = 'paidy_window_stuck'
  DO NOTHING
  RETURNING id INTO v_id;
  UPDATE public.paidy_checkout_attempts SET stuck_bell_at = coalesce(stuck_bell_at, now()) WHERE id = p_attempt_id;
  RETURN CASE WHEN v_id IS NOT NULL THEN 'rung' ELSE 'exists' END;
END
$fn$;

REVOKE ALL ON FUNCTION public.ring_paidy_window_stuck_bell(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ring_paidy_window_stuck_bell(uuid, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.paidy_window_stuck_missing(
  p_cutoff timestamptz, p_after_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 100
) RETURNS TABLE (
  attempt_id uuid, cash_order_id uuid, paidy_payment_id text, expires_at timestamptz, reference text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT a.id, a.cash_order_id, a.paidy_payment_id, a.expires_at,
         coalesce(o.web_reference, o.invoice_number::text, a.cash_order_id::text)
    FROM public.paidy_checkout_attempts a
    LEFT JOIN public.cash_orders o ON o.id = a.cash_order_id
   WHERE a.status = 'open'
     AND a.authorization_noted_at IS NOT NULL
     AND a.stuck_bell_at IS NULL
     AND a.expires_at <= p_cutoff
     AND (p_after_at IS NULL OR (a.expires_at, a.id) > (p_after_at, p_after_id))
   ORDER BY a.expires_at, a.id
   LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;

REVOKE ALL ON FUNCTION public.paidy_window_stuck_missing(timestamptz, timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paidy_window_stuck_missing(timestamptz, timestamptz, uuid, integer) TO service_role;
