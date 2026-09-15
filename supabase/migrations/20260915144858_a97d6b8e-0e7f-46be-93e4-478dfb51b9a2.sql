-- A deadline cannot be moved once the deposit is in. Harness finding 1 (2026-09-15).
--
-- set_account_deadlines gated on STATUS alone, and a layaway whose deposit has
-- been confirmed is still 'active'. So the call succeeded: the column moved,
-- `ok: true` came back, and an audit row recorded a decision that nothing would
-- ever act on. The expiry sweep never looks at such a plan again — total_paid
-- is no longer 0 — so the date it now carries is inert. The Hub made it worse
-- by showing an enabled Change button and a dialog that said, in the same
-- breath, "Only applies while the deposit is unpaid."
--
-- That is what sent someone to test the deadline control on CJ-W-900013, whose
-- deposit was already confirmed. It was checkable from state, and nothing
-- checked it.
--
-- The refusal borrows expire_web_layaway_atomic's own vocabulary rather than
-- inventing a code: `already_paid` when the cached total says so, and
-- `payment_exists` when the cache says zero but the ledger disagrees. Same two
-- tests, in the same order, for the same reason — INVARIANT 1 makes payments
-- authoritative, and either one alone is enough to stop the write.
--
-- LAYAWAY ONLY, DELIBERATELY. A cash order's deadline IS expires_at, and
-- auto-expire-cash-orders cancels a pending order with `remaining_balance > 0`
-- whatever has been paid against it — so on a partially-paid cash order the
-- deadline is still live and still moveable. Applying `already_paid` there
-- would take away a control staff genuinely need.
--
-- SUPERSEDES 20260915140000, AND ORDER MATTERS. This is a whole-body
-- CREATE OR REPLACE, so it also carries that migration's two guards (a deadline
-- is moved, never removed; and `deadline_in_past` in the payload) — the
-- combined body is the union of both. Applied in filename order, which is what
-- Supabase does, 140000 then 150000 leaves every guard in place.
--
-- But the reverse is NOT harmless, and an earlier draft of this header said it
-- was: running 140000 AFTER this file replaces the body with one that has no
-- `already_paid` check, and finding 1 comes back silently. Measured in the
-- harness — reverse order leaves `prosrc LIKE '%already_paid%'` false.
-- So: never re-run 140000 by hand once this has been applied. If both are ever
-- replayed, replay them in filename order. This file is the current definition
-- of set_account_deadlines; any future change edits a NEW migration, never one
-- of these two.

CREATE OR REPLACE FUNCTION public.set_account_deadlines(
  p_entity_type     text,
  p_entity_id       uuid,
  p_transfer_due_at timestamptz,
  p_reason          text DEFAULT NULL,
  p_user_id         uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old  jsonb;
  v_new  jsonb;
  v_status text;
  v_paid numeric;
BEGIN
  IF p_entity_type NOT IN ('layaway', 'cash_order') THEN
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;

  -- A deadline is moved, never removed (20260915140000).
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;

  IF p_entity_type = 'layaway' THEN
    SELECT status::text, total_paid,
           jsonb_build_object('transfer_due_at', transfer_due_at)
      INTO v_status, v_paid, v_old
      FROM public.layaway_accounts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- Live only. 'cancelled', 'completed', 'forfeited', 'final_forfeited' and
    -- 'final_settlement' are endings, not states a new deadline can reopen.
    IF v_status NOT IN ('active', 'overdue', 'extension_active', 'reactivated') THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;

    -- Money received ends this deadline's job, and 'active' does not say so.
    -- Both places it can show, exactly as expire_web_layaway_atomic checks them.
    IF coalesce(v_paid, 0) > 0 THEN
      RETURN jsonb_build_object('error', 'already_paid', 'total_paid', v_paid);
    END IF;
    IF EXISTS (SELECT 1 FROM public.payments
                WHERE account_id = p_entity_id AND voided_at IS NULL) THEN
      RETURN jsonb_build_object('error', 'payment_exists');
    END IF;

    UPDATE public.layaway_accounts
       SET transfer_due_at = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at);
  ELSE
    SELECT status::text,
           jsonb_build_object('transfer_due_at', transfer_due_at, 'expires_at', expires_at)
      INTO v_status, v_old
      FROM public.cash_orders WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    IF v_status <> 'pending' THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
    END IF;
    -- No already_paid test here. See the header: a partially-paid pending cash
    -- order still expires, so its deadline is still live and still moveable.

    -- BOTH columns, deliberately. create_web_order_atomic writes the same value
    -- to each and the expiry cron reads expires_at; moving only transfer_due_at
    -- would show the customer a new deadline while the cron still cancelled on
    -- the old one.
    UPDATE public.cash_orders
       SET transfer_due_at = p_transfer_due_at,
           expires_at      = p_transfer_due_at,
           updated_at      = now()
     WHERE id = p_entity_id;

    v_new := jsonb_build_object('transfer_due_at', p_transfer_due_at, 'expires_at', p_transfer_due_at);
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES (CASE WHEN p_entity_type = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END,
          p_entity_id, 'deadlines_updated', v_old,
          v_new || jsonb_build_object('reason', p_reason),
          COALESCE(p_user_id, auth.uid()));

  RETURN jsonb_build_object(
    'ok', true, 'old', v_old, 'new', v_new,
    -- Observation A: the caller is told when it has just armed the hourly job.
    'deadline_in_past', p_transfer_due_at < now());
END $function$;