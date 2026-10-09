-- Square go-live counter-check fixes (2026-10-09 evening).
-- Project doc: claude/square-golive-countercheck-2026-10-09-evening.md
--
--   CODE-M1  A card capture is never booked as paid while the card network holds or took back
--            money on that order (square_order_disputed_jpy > 0, D-QC1): the recording itself
--            (finalize_cash_submission_atomic, Square block) and the staff decision to record a
--            capture (decide_square_case record_on_order / record_net_after_refund) refuse with
--            card_disputed. The capture stays an open case for a person to decide.
--   L1       record_square_dispute locks the ORDER first (as record_square_refund does, R05), so
--            a dispute and a store-credit cancel on the same order are serialised and the
--            card_dispute_after_credit bell is never missed.
--
--   Every patch starts from the live text behind an md5 guard (Bug #280); no comment line inside
--   any patch anchor or new text (Lovable's runner drops such lines). A re-run is a no-op.

CREATE OR REPLACE FUNCTION pg_temp.cj_patch(p_sig text, p_before text, p_edits jsonb)
RETURNS void LANGUAGE plpgsql AS $p$
DECLARE
  v_fn   regprocedure;
  v_def  text;
  v_new  text;
  e      jsonb;
  v_n    integer;
  v_done boolean := true;
BEGIN
  v_fn := to_regprocedure(p_sig);
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — % is not on live; nothing changed', p_sig;
  END IF;
  v_def := pg_get_functiondef(v_fn);
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    IF position(e ->> 'new' IN v_def) = 0 THEN v_done := false; END IF;
  END LOOP;
  IF v_done THEN
    RAISE NOTICE '% already patched — no change', p_sig;
    RETURN;
  END IF;
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION 'STOP — % has moved on live (md5 %); re-read it before patching. Nothing changed.', p_sig, md5(v_def);
  END IF;
  v_new := v_def;
  FOR e IN SELECT * FROM jsonb_array_elements(p_edits) LOOP
    v_n := (length(v_new) - length(replace(v_new, e ->> 'old', ''))) / length(e ->> 'old');
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'STOP — % anchor found % times, expected 1: %', p_sig, v_n, left(e ->> 'old', 120);
    END IF;
    v_new := replace(v_new, e ->> 'old', e ->> 'new');
  END LOOP;
  EXECUTE v_new;
  IF md5(pg_get_functiondef(v_fn)) <> md5(v_new) THEN
    RAISE EXCEPTION 'STOP — % did not store the patched body exactly; rolled back', p_sig;
  END IF;
END
$p$;

SELECT pg_temp.cj_patch('public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)', 'fcb5598404a34fe02d01508b5a7363fd', jsonb_build_array(
  jsonb_build_object('old', $o$    IF v_order.currency::text <> 'JPY' OR coalesce(v_sq.currency, 'JPY') <> 'JPY' THEN
      RETURN jsonb_build_object('error', 'square_currency_mismatch');
    END IF;
$o$,
                     'new', $n$    IF v_order.currency::text <> 'JPY' OR coalesce(v_sq.currency, 'JPY') <> 'JPY' THEN
      RETURN jsonb_build_object('error', 'square_currency_mismatch');
    END IF;
    IF public.square_order_disputed_jpy(v_order.id) > 0 THEN
      RETURN jsonb_build_object('error', 'card_disputed', 'disputed_jpy', public.square_order_disputed_jpy(v_order.id));
    END IF;
$n$)
));

SELECT pg_temp.cj_patch('public.decide_square_case(text,uuid,text,text)', 'bc2b1a76fb561a39b5f80200b17e2d3d', jsonb_build_array(
  jsonb_build_object('old', $o$      ELSIF v_order.status::text IN ('cancelled','expired') THEN
        v_err := 'order_closed';
$o$,
                     'new', $n$      ELSIF v_order.status::text IN ('cancelled','expired') THEN
        v_err := 'order_closed';
      ELSIF public.square_order_disputed_jpy(v_order.id) > 0 THEN
        v_err := 'card_disputed';
$n$)
));

SELECT pg_temp.cj_patch('public.record_square_dispute(text,text,text,text,bigint,timestamp with time zone,timestamp with time zone,timestamp with time zone,jsonb)', 'bfc43e9c9555f3e0053e9d747e34f3fb', jsonb_build_array(
  jsonb_build_object('old', $o$  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id;
$o$,
                     'new', $n$  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_sq.cash_order_id FOR UPDATE;
$n$)
));

DO $self$
BEGIN
  IF position('card_disputed' IN pg_get_functiondef('public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)'::regprocedure)) = 0
     OR position('card_disputed' IN pg_get_functiondef('public.decide_square_case(text,uuid,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — CODE-M1 not complete';
  END IF;
  IF position('WHERE id = v_sq.cash_order_id FOR UPDATE' IN pg_get_functiondef('public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — L1 not complete';
  END IF;
  IF has_function_privilege('anon', 'public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.finalize_cash_submission_atomic(uuid,uuid,text,date,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.decide_square_case(text,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — grants changed';
  END IF;
END
$self$;