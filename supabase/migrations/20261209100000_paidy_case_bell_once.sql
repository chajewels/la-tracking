-- 20261209100000_paidy_case_bell_once.sql
-- Paidy "case" bell: one bell per case, enforced by the database (owner go
-- "fix 6c", 2026-10-11; the residual QA kept open in its 2026-10-11 verdict).
--
-- A Paidy case's first bell (paidy_case_<kind>) is rung by openPaidyCase when
-- the case opens, and late by paidy-reconcile step 6c when the first ring did
-- not stick (PA07). Both used read-then-insert, so two overlapping writers
-- could both see "no bell" and both insert — the same defect class as F2. The
-- sweep also read only the 25 oldest unrung cases, so cases whose ring kept
-- failing could hide the ones after them.
--
--   * uq_staff_notifications_paidy_case — at most ONE paidy_case_* bell per
--     metadata->>'case_id'.
--   * ring_paidy_case_bell(case_id, title, body, metadata) — the ONE writer,
--     used by both paths. Locks the case row, derives the bell type from the
--     case's own kind, INSERT … ON CONFLICT DO NOTHING, and stamps
--     paidy_cases.bell_rung_at in the same transaction. Returns 'rung' only
--     when it inserted (so the staff-email fan-out fires once), 'exists' when
--     a bell was already there, 'closed' when the case is no longer open
--     (nothing written).
--   * paidy_case_bell_missing(after_at, after_id, limit) — open cases with no
--     bell stamp, keyset-paged on (opened_at, id), so the sweep walks all of
--     them however many keep failing.
--
-- Touches no money. New objects only; no existing function is redefined.
-- Live check 2026-10-11 10:50 JST: 0 bells carry metadata.case_id, 0
-- paidy_cases rows, no SQL function writes a case bell.

SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.staff_notifications
     WHERE type LIKE 'paidy\_case\_%' AND metadata->>'case_id' IS NOT NULL
     GROUP BY metadata->>'case_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'STOP — duplicate paidy_case bells exist on live; report them, do not delete';
  END IF;
END
$guard$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_notifications_paidy_case
  ON public.staff_notifications ((metadata->>'case_id'))
  WHERE type LIKE 'paidy\_case\_%';

CREATE OR REPLACE FUNCTION public.ring_paidy_case_bell(
  p_case_id uuid, p_title text, p_body text, p_metadata jsonb
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_case public.paidy_cases%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_case_id IS NULL THEN
    RAISE EXCEPTION 'case_id_required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_case FROM public.paidy_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_case.status <> 'open' THEN
    RETURN 'closed';
  END IF;
  INSERT INTO public.staff_notifications (type, title, body, metadata)
  VALUES ('paidy_case_' || v_case.kind, p_title, p_body,
          coalesce(p_metadata, '{}'::jsonb)
            || jsonb_build_object('case_id', v_case.id::text, 'kind', v_case.kind,
                                  'paidy_payment_id', v_case.paidy_payment_id))
  ON CONFLICT ((metadata->>'case_id')) WHERE type LIKE 'paidy\_case\_%'
  DO NOTHING
  RETURNING id INTO v_id;
  UPDATE public.paidy_cases SET bell_rung_at = coalesce(bell_rung_at, now()) WHERE id = p_case_id;
  RETURN CASE WHEN v_id IS NOT NULL THEN 'rung' ELSE 'exists' END;
END
$fn$;

REVOKE ALL ON FUNCTION public.ring_paidy_case_bell(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ring_paidy_case_bell(uuid, text, text, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.paidy_case_bell_missing(
  p_after_at timestamptz DEFAULT NULL, p_after_id uuid DEFAULT NULL, p_limit integer DEFAULT 100
) RETURNS TABLE (
  case_id uuid, kind text, paidy_payment_id text, cash_order_id uuid, detail jsonb,
  opened_at timestamptz, reference text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT c.id, c.kind, c.paidy_payment_id, c.cash_order_id, c.detail, c.opened_at,
         coalesce(o.web_reference, o.invoice_number::text)
    FROM public.paidy_cases c
    LEFT JOIN public.cash_orders o ON o.id = c.cash_order_id
   WHERE c.status = 'open'
     AND c.bell_rung_at IS NULL
     AND (p_after_at IS NULL OR (c.opened_at, c.id) > (p_after_at, p_after_id))
   ORDER BY c.opened_at, c.id
   LIMIT greatest(1, least(coalesce(p_limit, 100), 500));
$fn$;

REVOKE ALL ON FUNCTION public.paidy_case_bell_missing(timestamptz, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paidy_case_bell_missing(timestamptz, uuid, integer) TO service_role;
