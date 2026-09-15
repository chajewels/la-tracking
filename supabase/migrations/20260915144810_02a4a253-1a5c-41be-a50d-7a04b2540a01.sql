-- A deposit deadline is never silently cleared, and a backdated one says so.
-- Harness findings 3 and A (2026-09-15).
--
-- FINDING 3. `set-account-deadlines` reads the deadline as
-- `body?.transfer_due_at ?? null` and then only rejects a NON-null value that
-- will not parse. An absent field, or an explicit null, therefore travelled all
-- the way through to this function, which wrote NULL into the column. The
-- hourly sweep selects on `transfer_due_at IS NOT NULL`, so a web plan whose
-- deadline had been cleared held its stock forever with no expiry path and no
-- error anywhere. The edge function's own comment claimed it refused to clear
-- silently; it caught '' and not null.
--
-- The fix is to REJECT null rather than to build an explicit "clear the
-- deadline" act. There is no use for an order that has a deadline and then has
-- none: the deadline is what releases the piece, and the only states that end
-- it are the ones that end the order. Building a separate clearing affordance
-- would be inventing a control nobody asked for — which is how
-- settlement_due_at happened. So: a deadline can be moved, never removed.
--
-- The guard goes here AND in the edge function, for the reason the owner gave
-- for finding 1: this function is what a direct caller reaches, so guarding
-- only the HTTP layer leaves the hole open.
--
-- OBSERVATION A. Nothing validates a date in the past, and that stays true —
-- moving a deadline backwards is how staff release a hold deliberately
-- (STEP4-ACCEPTANCE §E2 depends on it). But it arms the hourly job within the
-- hour, and until now the caller got back no hint that it had. The payload now
-- carries `deadline_in_past`, and the Hub says so in the toast. A signal, not a
-- refusal.
--
-- Everything else is byte-identical to the body this replaces.
--
-- ORDERING NOTE: 20260915150000 (harness finding 1) replaces this same function
-- again and its body CONTAINS both guards, so the two apply cleanly in filename
-- order whichever PR merges first.

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
  v_old jsonb;
  v_new jsonb;
  v_status text;
BEGIN
  IF p_entity_type NOT IN ('layaway', 'cash_order') THEN
    RETURN jsonb_build_object('error', 'bad_entity_type');
  END IF;

  -- A deadline is moved, never removed. See the header.
  IF p_transfer_due_at IS NULL THEN
    RETURN jsonb_build_object('error', 'deadline_required');
  END IF;

  IF p_entity_type = 'layaway' THEN
    SELECT status::text,
           jsonb_build_object('transfer_due_at', transfer_due_at)
      INTO v_status, v_old
      FROM public.layaway_accounts WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
    -- Live only. 'cancelled', 'completed', 'forfeited', 'final_forfeited' and
    -- 'final_settlement' are endings, not states a new deadline can reopen.
    IF v_status NOT IN ('active', 'overdue', 'extension_active', 'reactivated') THEN
      RETURN jsonb_build_object('error', 'not_live', 'status', v_status);
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