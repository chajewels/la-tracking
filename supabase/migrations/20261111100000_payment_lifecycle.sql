-- Website payment lifecycle, Hub task H1 (plan claude/payment-lifecycle-plan-2026-10-05).
--
-- WHAT CHANGES
--   1. payment_submissions.customer_message — the reviewer's text the CUSTOMER
--      sees, written only on a staff reject or needs-clarification. Nullable,
--      no default; no existing row changes.
--   2. switch_web_payment_method_by_customer_atomic — the customer's own
--      payment-method switch on a website cash order. Owner rule C1 stays: the
--      checkout method is locked for her, EXCEPT after her latest decided
--      payment was REJECTED and nothing is in progress. needs_clarification is
--      not a rejection (INVARIANT 12 unchanged; it does not freeze automation).
--      Mirrors the staff switch change_web_payment_method_atomic (live
--      pg_get_functiondef md5 c53a73f430cc8f2f0b66253a570bea92, body md5
--      4a0d04ebeb0bc387d7dbccc54b70ca65, read 2026-10-05): same method set,
--      same payable test, same lock (public.cash_order_payment_lock), same
--      yen rule, same audit_logs shape — but the actor is the customer
--      (performed_by_user_id NULL, new_value_json.actor = 'customer'), and an
--      order that is not hers answers not_found (never reveals existence).
--      TS mirror of the refusal order: supabase/functions/_shared/method-switch-rules.ts
--      (canCustomerSwitch) — change one, change the other.
--      ONE SWITCH PER REJECTION (controller ruling, H6 fix round 1): after a
--      rejection she may switch once; a second switch before another decision
--      answers already_switched. Refusal order:
--        not_found, not_web_order, not_payable, payment_in_progress,
--        not_rejected, already_switched, bad_method, unchanged,
--        method_requires_yen
--   3. cash_order_payment_locks(uuid[]) — the batched read of
--      cash_order_payment_lock for the website's order list (one call per page,
--      never a per-row fan-out). It calls the existing function per id, so the
--      answer is identical by construction. At most 100 ids.
--
--   web_payment_reminder_eligible is deliberately NOT touched (controller
--   ruling R1): the reminder sender reads cash_orders.payment_method itself.
--
-- FUNCTION RULES (CLAUDE.md, Bug #280): no existing function body changes
-- here. The two new functions are created fresh; REVOKE/GRANT asserted below.

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 0. Preconditions: the lock helper the switch relies on is the live one.
-- ---------------------------------------------------------------------------
DO $pre$
BEGIN
  IF to_regprocedure('public.cash_order_payment_lock(uuid,uuid,boolean)') IS NULL THEN
    RAISE EXCEPTION 'STOP — public.cash_order_payment_lock(uuid,uuid,boolean) is missing; nothing written';
  END IF;
  IF to_regprocedure('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'STOP — the staff switch this mirrors is missing; nothing written';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Column.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_submissions
  ADD COLUMN IF NOT EXISTS customer_message text NULL;
COMMENT ON COLUMN public.payment_submissions.customer_message IS
  'Reviewer text shown to the customer. Written only on a staff reject or needs-clarification (payment lifecycle, 2026-10-05); never internal notes.';

-- ---------------------------------------------------------------------------
-- 2. The customer's own method switch (after a rejection only).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.switch_web_payment_method_by_customer_atomic(
  p_order_id uuid, p_customer_id uuid, p_method text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_owner    uuid;
  v_old      text;
  v_cur      text;
  v_status   text;
  v_pay      text;
  v_chan     text;
  v_lock     text;
  v_ref      text;
  v_decision text;
  v_decision_id uuid;
  v_decided_at timestamptz;
BEGIN
  IF p_order_id IS NULL OR p_customer_id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT customer_id, coalesce(payment_method, 'transfer'), currency::text, status::text, payment_status,
         source_channel, coalesce(web_reference, invoice_number)
    INTO v_owner, v_old, v_cur, v_status, v_pay, v_chan, v_ref
    FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  -- Another customer's order answers exactly like a missing one.
  IF NOT FOUND OR v_owner IS DISTINCT FROM p_customer_id THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  IF v_chan IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('error', 'not_web_order');
  END IF;
  IF v_status <> 'pending' OR coalesce(v_pay, '') <> 'pending_transfer' THEN
    RETURN jsonb_build_object('error', 'not_payable');
  END IF;
  -- Owner rule 2026-10-04: while Paidy, a card hold or any other payment is in
  -- progress, nothing about how the order is paid changes.
  v_lock := public.cash_order_payment_lock(p_order_id);
  IF v_lock IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payment_in_progress');
  END IF;
  -- C1: only after her latest DECIDED payment was rejected. Latest decision =
  -- newest by updated_at (decision time) among rejected / needs_clarification /
  -- confirmed.
  SELECT s.status::text, s.id, coalesce(s.updated_at, s.created_at)
    INTO v_decision, v_decision_id, v_decided_at
    FROM public.payment_submissions s
   WHERE s.cash_order_id = p_order_id
     AND s.status IN ('rejected', 'needs_clarification', 'confirmed')
   ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC, s.id DESC
   LIMIT 1;
  IF v_decision IS DISTINCT FROM 'rejected' THEN
    RETURN jsonb_build_object('error', 'not_rejected');
  END IF;
  -- One customer switch per rejection: a customer switch audited AFTER the
  -- deciding rejection (its updated_at, else created_at) spends it. Staff
  -- switches never count against her.
  IF EXISTS (
    SELECT 1 FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id
       AND a.action = 'payment_method_changed'
       AND a.new_value_json->>'actor' = 'customer'
       AND a.created_at > v_decided_at
  ) THEN
    RETURN jsonb_build_object('error', 'already_switched');
  END IF;
  IF p_method IS NULL OR p_method NOT IN ('transfer', 'paidy', 'square') THEN
    RETURN jsonb_build_object('error', 'bad_method');
  END IF;
  IF v_old = p_method THEN
    RETURN jsonb_build_object('error', 'unchanged', 'payment_method', v_old);
  END IF;
  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;

  UPDATE public.cash_orders SET payment_method = p_method, updated_at = now() WHERE id = p_order_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'payment_method_changed',
          jsonb_build_object('payment_method', v_old),
          jsonb_build_object('payment_method', p_method, 'actor', 'customer',
                             'customer_id', p_customer_id, 'reference', v_ref),
          NULL);

  RETURN jsonb_build_object('ok', true, 'old_method', v_old, 'payment_method', p_method, 'reference', v_ref,
                            'decision_id', v_decision_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.switch_web_payment_method_by_customer_atomic(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.switch_web_payment_method_by_customer_atomic(uuid, uuid, text) TO service_role;
COMMENT ON FUNCTION public.switch_web_payment_method_by_customer_atomic(uuid, uuid, text) IS
  'Payment lifecycle (2026-10-05): the customer changes how she pays a website cash order, ONLY after her latest decided payment was rejected and with no payment in progress (C1 otherwise holds). Audited with actor customer. Service role only (the website edge function passes the signed-in customer). TS mirror: _shared/method-switch-rules.ts.';

-- ---------------------------------------------------------------------------
-- 3. Batched payment-lock read for the website's order list.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_order_payment_locks(p_ids uuid[])
RETURNS TABLE(id uuid, lock text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF coalesce(cardinality(p_ids), 0) > 100 THEN
    RAISE EXCEPTION 'cash_order_payment_locks: at most 100 ids (got %)', cardinality(p_ids);
  END IF;
  RETURN QUERY
    SELECT x.order_id, public.cash_order_payment_lock(x.order_id)
      FROM unnest(coalesce(p_ids, ARRAY[]::uuid[])) AS x(order_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.cash_order_payment_locks(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_order_payment_locks(uuid[]) TO service_role;
COMMENT ON FUNCTION public.cash_order_payment_locks(uuid[]) IS
  'Payment lifecycle (2026-10-05): cash_order_payment_lock for up to 100 orders in one call (the website order list). Same answer per id by construction. Service role only.';

-- ---------------------------------------------------------------------------
-- 4. Post-checks. Any failure rolls the whole migration back.
-- ---------------------------------------------------------------------------
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'payment_submissions'
                    AND column_name = 'customer_message' AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION 'STOP — payment_submissions.customer_message is not a nullable column without default; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — the customer switch is executable by a signed-in or anonymous caller; rolled back';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.switch_web_payment_method_by_customer_atomic(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — service_role cannot execute the customer switch; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.cash_order_payment_locks(uuid[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cash_order_payment_locks(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — the batched lock read is executable by a signed-in or anonymous caller; rolled back';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.cash_order_payment_locks(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — service_role cannot execute the batched lock read; rolled back';
  END IF;
END
$check$;
