-- Let a CSR mark their own Page365 draft consumed. 2026-09-19.
--
-- WHY AN RPC AND NOT A POLICY. 20260919100000 gave page365_drafts a SELECT
-- policy and deliberately no INSERT/UPDATE/DELETE policy, so that a CSR cannot
-- forge or alter a draft carrying prices Page365 never returned. That is still
-- the right shape — but it also means the review screen cannot stamp
-- consumed_at after it creates an order. A blanket UPDATE policy would reopen
-- exactly what the original migration closed (RLS grants a whole row, not a
-- column), so the narrow act gets its own SECURITY DEFINER function instead:
-- it touches consumed_at and nothing else, only on a row the caller created,
-- and only once.
--
-- THIS IS A CONVENIENCE, NOT THE IDEMPOTENCY GUARD. The real protection against
-- importing one Page365 invoice twice is uq_cash_orders_page365_no /
-- uq_layaway_accounts_page365_no plus the 409 already_imported both create
-- functions return. consumed_at is the CSR-facing signal ("this draft has been
-- used"), which is why the UI treats a failure here as non-fatal: the order
-- already exists and is authoritative.

BEGIN;

CREATE OR REPLACE FUNCTION public.consume_page365_draft(p_draft_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_owner uuid;
  v_consumed timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'user_identity_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT created_by, consumed_at INTO v_owner, v_consumed
  FROM public.page365_drafts WHERE id = p_draft_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'draft_not_found');
  END IF;

  -- Only the CSR who pasted the link may retire their own draft.
  IF v_owner IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_owner');
  END IF;

  -- Already retired: report it rather than re-stamping, so the timestamp keeps
  -- recording the FIRST use.
  IF v_consumed IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_consumed', true, 'consumed_at', v_consumed);
  END IF;

  UPDATE public.page365_drafts SET consumed_at = now() WHERE id = p_draft_id;

  RETURN jsonb_build_object('ok', true, 'already_consumed', false, 'consumed_at', now());
END
$function$;

COMMENT ON FUNCTION public.consume_page365_draft(uuid) IS
  'Stamps page365_drafts.consumed_at for a draft the calling user created. The only write path to that table for a non-service caller, deliberately narrow: no other column can be reached and another CSR''s draft is refused. Not the double-import guard — uq_*_page365_no is.';

REVOKE ALL ON FUNCTION public.consume_page365_draft(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_page365_draft(uuid) TO authenticated, service_role;

COMMIT;