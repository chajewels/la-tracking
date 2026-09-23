-- ============================================================================
-- WEB LAYAWAY STOCK FOLLOWS EVERY FORFEIT; REACTIVATION IS ALL-OR-NOTHING
--
-- Owner-approved 2026-09-23 (follow-up to #298, closing docs/OPEN-BUGS.md
-- "web-order lifecycle follow-ups" items 2 and 3).
--
-- 1. AUTOMATIC FORFEITS RETURN THE PIECES. #298 made the STAFF forfeit put a
--    web plan's pieces back on sale (manual_forfeit_layaway_atomic). The
--    automatic path did not. The ONLY automatic forfeit writer is the edge
--    function auto-forfeit-settlement (cron daily-auto-forfeit, 00:10 UTC),
--    which sets the status at four places:
--      extension_active -> final_forfeited   extension expired
--      extension_active -> final_forfeited   extension-month penalty cap
--      active/overdue   -> forfeited         PATH 1, final-month penalty cap
--      active/overdue   -> forfeited         PATH 2, 3 months overdue
--    No SQL function and no other cron writes either status (searched
--    2026-09-23). auto-forfeit-settlement is a LOCKED function, so the stock
--    is returned HERE, by a trigger on the status change itself: the pieces go
--    back in the same statement — so the same transaction — as the forfeit,
--    whichever writer made it, and the forfeiture logic is untouched.
--
--    The trigger acts only when stock_released_at is NULL, i.e. the plan still
--    holds its pieces. manual_forfeit_layaway_atomic stamps stock_released_at
--    in the same UPDATE that sets 'forfeited', so the trigger stands aside
--    there and nothing is ever returned twice; forfeited -> final_forfeited on
--    a plan already released is likewise a no-op. A plan re-held by
--    reactivation (trg_rehold_released_web_layaway_stock clears the column)
--    releases again if it later reaches final_forfeited.
--
-- 2. REACTIVATION IS ONE TRANSACTION. reactivate-account un-cancelled the
--    schedule rows BEFORE updating the account, as separate PostgREST calls.
--    When the re-hold trigger refused the status change because a piece had
--    sold, the account stayed forfeited but its rows were already 'overdue'.
--    reactivate_layaway_atomic now does the three core writes — un-cancel,
--    account flip, Extension Month row — in one transaction, and checks the
--    pieces BEFORE writing anything: out_of_stock names the lines and changes
--    nothing. If a piece sells between that check and the flip, the trigger's
--    exception rolls the whole function back. The values written are exactly
--    what the edge function wrote before. The one tolerance it had is kept:
--    a failed Extension Month insert never blocked reactivation (the edge
--    function ignored the error), so it runs in its own subtransaction and is
--    reported, not raised.
--
-- FUNCTION RULES. No existing function body is changed by this file: the
-- trigger function and the RPC are new. The existing
-- rehold_released_web_layaway_stock trigger (20260923120000) is relied on, not
-- redefined.
-- ============================================================================

-- ======================================= 1. release on every web forfeit
CREATE OR REPLACE FUNCTION public.release_forfeited_web_layaway_stock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_restored integer := 0;
  v_now      timestamptz := now();
BEGIN
  IF NEW.source_channel IS DISTINCT FROM 'web'
     OR NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW.status::text NOT IN ('forfeited', 'final_forfeited')
     OR NEW.stock_released_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.website_product_variants v
     SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
    FROM public.layaway_account_items i
   WHERE i.account_id = NEW.id AND i.variant_id = v.id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  NEW.stock_released_at := v_now;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id,
                                 old_value_json, new_value_json)
  VALUES ('layaway_account', NEW.id, 'web_layaway_stock_released', auth.uid(),
          jsonb_build_object('status', OLD.status),
          jsonb_build_object('status', NEW.status, 'invoice_number', NEW.invoice_number,
                             'web_reference', NEW.web_reference,
                             'stock_lines_restored', v_restored,
                             'released_by', 'forfeit status change'));

  RETURN NEW;
END $function$;

REVOKE EXECUTE ON FUNCTION public.release_forfeited_web_layaway_stock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_release_forfeited_web_layaway_stock ON public.layaway_accounts;
CREATE TRIGGER trg_release_forfeited_web_layaway_stock
  BEFORE UPDATE OF status ON public.layaway_accounts
  FOR EACH ROW EXECUTE FUNCTION public.release_forfeited_web_layaway_stock();

-- ========================================= 2. all-or-nothing reactivation
-- Called by reactivate-account after its own guards, with the values it has
-- always computed (extension end = today + 1 month; penalty count preserved).
-- Refusals mirror those guards so a race between them and the lock is still
-- answered, never written: not_found, final_forfeited, not_forfeited,
-- already_reactivated, out_of_stock (lines named).
CREATE OR REPLACE FUNCTION public.reactivate_layaway_atomic(
  p_account_id         uuid,
  p_user_id            uuid,
  p_extension_end_date date,
  p_penalty_count      integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status      text;
  v_reactivated boolean;
  v_channel     text;
  v_released    timestamptz;
  v_months      integer;
  v_currency    account_currency;
  v_short       jsonb;
  v_rehold      boolean;
  v_uncancelled integer := 0;
  v_ext_ok      boolean := false;
  v_ext_error   text;
  v_now         timestamptz := now();
BEGIN
  SELECT status::text, is_reactivated, source_channel, stock_released_at, payment_plan_months, currency
    INTO v_status, v_reactivated, v_channel, v_released, v_months, v_currency
    FROM public.layaway_accounts
   WHERE id = p_account_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_status = 'final_forfeited' THEN
    RETURN jsonb_build_object('error', 'final_forfeited');
  END IF;
  IF v_status <> 'forfeited' THEN
    RETURN jsonb_build_object('error', 'not_forfeited', 'status', v_status);
  END IF;
  IF v_reactivated THEN
    RETURN jsonb_build_object('error', 'already_reactivated');
  END IF;

  -- The pieces first, before any write. Same test as
  -- trg_rehold_released_web_layaway_stock, answered as data instead of an
  -- exception so staff are told which piece blocked it.
  v_rehold := (v_channel = 'web' AND v_released IS NOT NULL);
  IF v_rehold THEN
    SELECT jsonb_agg(jsonb_build_object(
             'variant_id', i.variant_id, 'title', i.title, 'sku', i.sku,
             'wanted', i.quantity, 'available', coalesce(v.stock_qty, 0)))
      INTO v_short
      FROM public.layaway_account_items i
      LEFT JOIN public.website_product_variants v ON v.id = i.variant_id
     WHERE i.account_id = p_account_id
       AND (v.id IS NULL OR v.stock_qty < i.quantity);
    IF v_short IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'lines', v_short);
    END IF;
  END IF;

  -- (a) un-cancel the remaining schedule rows — exactly the rows, and the
  --     value, the edge function wrote one by one before.
  UPDATE public.layaway_schedule
     SET status = 'overdue', updated_at = v_now
   WHERE account_id = p_account_id AND status = 'cancelled';
  GET DIAGNOSTICS v_uncancelled = ROW_COUNT;

  -- (b) the account. For a released web plan the re-hold trigger takes the
  --     pieces back in this statement, or raises and rolls back (a) with it.
  UPDATE public.layaway_accounts
     SET status                        = 'extension_active'::account_status,
         is_reactivated                = true,
         reactivated_at                = v_now,
         reactivated_by_user_id        = p_user_id,
         extension_end_date            = p_extension_end_date,
         penalty_count_at_reactivation = p_penalty_count,
         updated_at                    = v_now
   WHERE id = p_account_id;

  -- (c) the Extension Month row. The edge function never checked this
  --     insert's result, so a failure never blocked reactivation; that is
  --     kept, in a subtransaction, and reported instead of swallowed.
  BEGIN
    INSERT INTO public.layaway_schedule (account_id, installment_number, due_date,
                                         base_installment_amount, total_due_amount, currency, status)
    VALUES (p_account_id, v_months + 1, p_extension_end_date, 0, 0, v_currency, 'pending');
    v_ext_ok := true;
  EXCEPTION WHEN OTHERS THEN
    v_ext_error := SQLERRM;
  END;

  RETURN jsonb_build_object('ok', true,
                            'schedule_rows_uncancelled', v_uncancelled,
                            'extension_row_inserted', v_ext_ok,
                            'extension_row_error', v_ext_error,
                            'stock_reheld', v_rehold);
END $function$;

COMMENT ON FUNCTION public.reactivate_layaway_atomic(uuid, uuid, date, integer) IS
  'The three core writes of a one-time reactivation (forfeited -> extension_active) in one transaction: un-cancel the schedule, flip the account, add the Extension Month row. For a web plan whose pieces were released it refuses out_of_stock (lines named) before writing anything. Called only by reactivate-account.';

REVOKE ALL ON FUNCTION public.reactivate_layaway_atomic(uuid, uuid, date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reactivate_layaway_atomic(uuid, uuid, date, integer) TO service_role;

-- ============================================================================
-- VERIFY (read-only). Expect all four true.
--
-- SELECT to_regprocedure('public.release_forfeited_web_layaway_stock()') IS NOT NULL AS release_fn,
--        to_regprocedure('public.reactivate_layaway_atomic(uuid,uuid,date,integer)') IS NOT NULL AS reactivate_fn,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_release_forfeited_web_layaway_stock') AS release_trigger,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_rehold_released_web_layaway_stock') AS rehold_trigger;
-- ============================================================================