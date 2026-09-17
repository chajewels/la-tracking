-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.restore_lots_for_redemption(p_redemption_id uuid)
--   captured  : 2026-09-17 05:21:02.267226+00 (SELECT pg_get_functiondef(oid))
--   md5       : 5a57c8dd28f0ba8a92c6a173e5aeac03
--   length    : 1010 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'restore_lots_for_redemption';
--
-- Why these exist: on 2026-09-12 a migration rebuilt approve_redemption_atomic
-- "verbatim from the live baseline … no later migration redefines this
-- function" and silently dropped a call that had been wired live in the SQL
-- Editor on 2026-07-05 and never committed. See docs/FIXED-BUGS.md #280 and
-- DRIFT-REPORT.md beside this file. The baseline is not evidence about live.

CREATE OR REPLACE FUNCTION public.restore_lots_for_redemption(p_redemption_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_consumption record;
  v_total_restored integer := 0;
BEGIN
  FOR v_consumption IN
    SELECT cons.id, cons.lot_id, cons.amount
      FROM public.loyalty_lot_consumption AS cons
     WHERE cons.redemption_id = p_redemption_id
       AND cons.restored_at IS NULL
     FOR UPDATE
  LOOP
    UPDATE public.loyalty_point_lots AS lots
       SET remaining_amount = lots.remaining_amount + v_consumption.amount,
           consumed_at      = NULL,
           updated_at       = now()
     WHERE lots.id = v_consumption.lot_id;

    UPDATE public.loyalty_lot_consumption AS cons
       SET restored_at     = now(),
           restored_amount = v_consumption.amount
     WHERE cons.id = v_consumption.id;

    v_total_restored := v_total_restored + v_consumption.amount;
  END LOOP;

  RETURN v_total_restored;
END;
$function$
