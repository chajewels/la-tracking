-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.insert_lot_and_extend(p_member_id uuid, p_source_type loyalty_lot_source_type, p_source_reference text, p_amount integer, p_earned_at timestamp with time zone, p_expires_at timestamp with time zone, p_notes text)
--   captured  : 2026-09-17 05:21:02.267226+00 (SELECT pg_get_functiondef(oid))
--   md5       : 121c55080c0a5e775a8d8a8cbbfbb45b
--   length    : 1609 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'insert_lot_and_extend';
--
-- Why these exist: on 2026-09-12 a migration rebuilt approve_redemption_atomic
-- "verbatim from the live baseline … no later migration redefines this
-- function" and silently dropped a call that had been wired live in the SQL
-- Editor on 2026-07-05 and never committed. See docs/FIXED-BUGS.md #280 and
-- DRIFT-REPORT.md beside this file. The baseline is not evidence about live.

CREATE OR REPLACE FUNCTION public.insert_lot_and_extend(p_member_id uuid, p_source_type loyalty_lot_source_type, p_source_reference text, p_amount integer, p_earned_at timestamp with time zone DEFAULT now(), p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lot_id uuid;
  v_computed_expires_at timestamptz;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'lot amount must be positive: %', p_amount;
  END IF;

  v_computed_expires_at := COALESCE(p_expires_at,
    CASE p_source_type
      WHEN 'order_earn' THEN p_earned_at + INTERVAL '180 days'
      ELSE NULL  -- birthday/promo/admin_adjust set explicit expires_at
    END);

  INSERT INTO public.loyalty_point_lots (
    member_id, source_type, source_reference,
    original_amount, remaining_amount,
    earned_at, expires_at, notes
  ) VALUES (
    p_member_id, p_source_type, p_source_reference,
    p_amount, p_amount,
    p_earned_at, v_computed_expires_at, p_notes
  )
  RETURNING id INTO v_lot_id;

  -- Rolling extension on order_earn purchases ONLY
  IF p_source_type = 'order_earn' THEN
    UPDATE public.loyalty_point_lots AS lots
       SET expires_at = p_earned_at + INTERVAL '180 days',
           updated_at = now()
     WHERE lots.member_id   = p_member_id
       AND lots.source_type IN ('order_earn', 'admin_adjust')
       AND lots.remaining_amount > 0
       AND lots.expired_at IS NULL
       AND lots.id <> v_lot_id;
  END IF;

  RETURN v_lot_id;
END;
$function$
