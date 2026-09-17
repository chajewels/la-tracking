-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.admin_update_schedule_base(p_schedule_id uuid, p_new_base numeric, p_new_total_due numeric, p_is_paid boolean)
--   captured  : 2026-09-17 05:50:22.096422+00 (SELECT pg_get_functiondef(oid))
--   md5       : 5669e145dd72eb3a00467c3ab6c08c76
--   length    : 2182 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'admin_update_schedule_base';
--
-- Captured for the live-vs-repo diff pass (DIFF-FINDINGS.md beside this file).
-- The repo is NOT evidence about live — see CLAUDE.md, "A SQL EDITOR CHANGE
-- THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD".

CREATE OR REPLACE FUNCTION public.admin_update_schedule_base(p_schedule_id uuid, p_new_base numeric, p_new_total_due numeric, p_is_paid boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id  uuid;
  v_allocated   numeric;
  v_total_due   numeric;
  v_status      schedule_status;
BEGIN
  PERFORM set_config('app.bypass_immutable_schedule_cols', 'on', true);
  UPDATE layaway_schedule
  SET
    base_installment_amount = p_new_base,
    total_due_amount        = p_new_total_due,
    paid_amount             = CASE WHEN p_is_paid THEN p_new_total_due
                                   ELSE paid_amount END
  WHERE id = p_schedule_id
  RETURNING account_id, total_due_amount, status
  INTO v_account_id, v_total_due, v_status;

  IF v_account_id IS NULL THEN
    RETURN;
  END IF;

  -- Bug #253: changing the base changes the denominator, so a row whose
  -- existing allocations now fully cover total_due_amount must be re-marked
  -- 'paid'. UPWARD ONLY — never downgrades a 'paid' row (that case is left
  -- for audit_account CHECK 7 ARM A to surface for human review).
  SELECT COALESCE(SUM(pa.allocated_amount), 0)
  INTO v_allocated
  FROM payment_allocations pa
  JOIN payments p ON p.id = pa.payment_id
  WHERE pa.schedule_id = p_schedule_id
    AND p.voided_at IS NULL;

  IF v_status NOT IN ('paid', 'cancelled')
     AND v_total_due > 0
     AND v_allocated >= v_total_due - 0.01 THEN
    UPDATE layaway_schedule
    SET status      = 'paid',
        paid_amount = v_allocated
    WHERE id = p_schedule_id;

    -- Account may now be fully settled. Guarded: zero balance, fully paid,
    -- and no schedule row left open.
    UPDATE layaway_accounts la
    SET status       = 'completed',
        completed_at = COALESCE(la.completed_at, now())
    WHERE la.id = v_account_id
      AND la.status IN ('active', 'overdue')
      AND la.remaining_balance <= 0.01
      AND la.total_paid >= la.total_amount - 0.01
      AND NOT EXISTS (
        SELECT 1 FROM layaway_schedule ls
        WHERE ls.account_id = la.id
          AND ls.status NOT IN ('paid', 'cancelled')
      );
  END IF;
END;
$function$
