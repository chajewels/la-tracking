-- =================================================================
-- delete_account_atomic
-- =================================================================
-- Atomic delete of layaway_account + all FK children. Replaces the
-- partial-failure-prone TypeScript delete sequence in
-- supabase/functions/delete-account/index.ts with a single
-- transactional plpgsql RPC.
--
-- DESIGN DECISIONS (per 2026-05-08 SOP cycle):
--   1. Defensive cleanup — explicit DELETE on all 16 child tables
--      including CASCADE FKs; mirrors current edge function for
--      defensive parity against future schema drift.
--   2. Atomic-or-nothing audit — audit_logs INSERT inside the
--      transaction. If audit fails, entire delete rolls back.
--      Eliminates silent audit gaps. Verified in smoke test:
--      wrong-UUID attempt for performed_by_user_id raised FK
--      exception → all 16 deletes rolled back atomically.
--   3. Defense-in-depth admin guard — RPC checks has_role for
--      direct PostgREST callers; edge function adds separate
--      admin check (closes prior security gap where any
--      authenticated user could call delete-account directly).
--
-- INVOCATION:
--   - Edge function path (production): delete-account/index.ts
--     calls via service_role; passes p_performed_by_user_id from
--     validated JWT user.id.
--   - Direct PostgREST path: auth.uid() check enforces admin role.
--
-- Applied to production via SQL Editor 2026-05-08.
-- All 5 smoke tests passed:
--   1. Pre-delete inventory baseline (1 account, 3 schedule rows)
--   2. RPC returned {"success": true} on first valid call
--   3. Cleanup verified: account=0, schedule=0, audit_logs=1
--   4. Re-call on deleted UUID returned {"error": "Account not found"}
--   5. (Bonus) Atomic rollback — wrong-UUID FK exception rolled
--      back all 16 deletes
-- =================================================================

CREATE OR REPLACE FUNCTION public.delete_account_atomic(
  p_account_id uuid,
  p_performed_by_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_invoice_number text;
  v_caller_uuid uuid;
  v_audit_user_id uuid;
BEGIN
  v_caller_uuid := auth.uid();

  IF v_caller_uuid IS NOT NULL AND NOT public.has_role(v_caller_uuid, 'admin') THEN
    RAISE EXCEPTION 'admin role required for delete_account_atomic'
      USING ERRCODE = '42501',
            HINT = 'Only admin role can delete accounts. See role_permissions table.';
  END IF;

  v_audit_user_id := COALESCE(p_performed_by_user_id, v_caller_uuid);

  IF v_audit_user_id IS NULL THEN
    RAISE EXCEPTION 'caller identity required (auth.uid() or p_performed_by_user_id)';
  END IF;

  SELECT invoice_number INTO v_invoice_number
    FROM public.layaway_accounts
   WHERE id = p_account_id;

  IF v_invoice_number IS NULL THEN
    RETURN jsonb_build_object('error', 'Account not found');
  END IF;

  -- Cleanup in dependency order — 16 explicit DELETEs (defensive)
  DELETE FROM public.payment_submission_allocations WHERE account_id = p_account_id;
  DELETE FROM public.payment_submissions WHERE account_id = p_account_id;
  DELETE FROM public.payment_allocations
   WHERE payment_id IN (SELECT id FROM public.payments WHERE account_id = p_account_id);
  DELETE FROM public.penalty_waiver_requests WHERE account_id = p_account_id;
  DELETE FROM public.penalty_fees WHERE account_id = p_account_id;
  DELETE FROM public.csr_notifications WHERE account_id = p_account_id;
  DELETE FROM public.extension_requests WHERE account_id = p_account_id;
  DELETE FROM public.reminder_logs WHERE account_id = p_account_id;
  DELETE FROM public.reconciliation_log WHERE account_id = p_account_id;
  DELETE FROM public.account_services WHERE account_id = p_account_id;
  DELETE FROM public.final_settlement_records WHERE account_id = p_account_id;
  DELETE FROM public.penalty_cap_overrides WHERE account_id = p_account_id;
  DELETE FROM public.statement_tokens WHERE account_id = p_account_id;
  DELETE FROM public.payments WHERE account_id = p_account_id;
  DELETE FROM public.layaway_schedule WHERE account_id = p_account_id;
  DELETE FROM public.layaway_accounts WHERE id = p_account_id;

  -- Atomic audit log (failure rolls back entire transaction)
  INSERT INTO public.audit_logs (
    entity_type, entity_id, action, old_value_json, performed_by_user_id
  ) VALUES (
    'layaway_account', p_account_id, 'delete',
    jsonb_build_object('invoice_number', v_invoice_number),
    v_audit_user_id
  );

  RETURN jsonb_build_object('success', true);
END;
$$;

COMMENT ON FUNCTION public.delete_account_atomic(uuid, uuid) IS
  'Atomic delete of layaway_account + all FK children. SECURITY DEFINER with admin guard. Mirrors delete-account edge function cleanup list (16 ordered DELETEs + audit). Single transaction — partial failures roll back. Created 2026-05-08.';

GRANT EXECUTE ON FUNCTION public.delete_account_atomic(uuid, uuid) TO authenticated;
