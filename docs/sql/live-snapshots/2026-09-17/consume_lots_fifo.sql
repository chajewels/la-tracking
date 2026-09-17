-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.consume_lots_fifo(p_member_id uuid, p_redemption_id uuid, p_amount integer)
--   captured  : 2026-09-17 05:21:02.267226+00 (SELECT pg_get_functiondef(oid))
--   md5       : 103778b2ca1c2a85c530032a3b04e812
--   length    : 1764 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'consume_lots_fifo';
--
-- Why these exist: on 2026-09-12 a migration rebuilt approve_redemption_atomic
-- "verbatim from the live baseline … no later migration redefines this
-- function" and silently dropped a call that had been wired live in the SQL
-- Editor on 2026-07-05 and never committed. See docs/FIXED-BUGS.md #280 and
-- DRIFT-REPORT.md beside this file. The baseline is not evidence about live.

CREATE OR REPLACE FUNCTION public.consume_lots_fifo(p_member_id uuid, p_redemption_id uuid, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining_to_consume integer := p_amount;
  v_lot record;
  v_consume_amount integer;
  v_total_consumed integer := 0;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'consume amount must be positive: %', p_amount;
  END IF;

  FOR v_lot IN
    SELECT lots.id, lots.remaining_amount
      FROM public.loyalty_point_lots AS lots
     WHERE lots.member_id        = p_member_id
       AND lots.remaining_amount > 0
       AND lots.revoked_at   IS NULL
       AND lots.expired_at IS NULL
     ORDER BY lots.expires_at ASC NULLS LAST, lots.earned_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_to_consume = 0;

    v_consume_amount := LEAST(v_lot.remaining_amount, v_remaining_to_consume);

    UPDATE public.loyalty_point_lots AS lots
       SET remaining_amount = lots.remaining_amount - v_consume_amount,
           consumed_at = CASE
             WHEN lots.remaining_amount - v_consume_amount = 0 THEN now()
             ELSE lots.consumed_at
           END,
           updated_at = now()
     WHERE lots.id = v_lot.id;

    INSERT INTO public.loyalty_lot_consumption (
      redemption_id, lot_id, amount
    ) VALUES (
      p_redemption_id, v_lot.id, v_consume_amount
    );

    v_remaining_to_consume := v_remaining_to_consume - v_consume_amount;
    v_total_consumed       := v_total_consumed       + v_consume_amount;
  END LOOP;

  IF v_remaining_to_consume > 0 THEN
    RAISE EXCEPTION 'insufficient lot balance: requested %, consumed %',
      p_amount, v_total_consumed;
  END IF;

  RETURN v_total_consumed;
END;
$function$
