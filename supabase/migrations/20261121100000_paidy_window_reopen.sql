-- 20261121100000_paidy_window_reopen.sql
-- Paidy P04 QA follow-up (2026-10-08, owner default "she can reopen Paidy
-- right away"): a customer who left her Paidy window open (closed the tab,
-- lost the connection) could not open Paidy again until the hourly sweep —
-- start_paidy_checkout_attempt only replaced a window she had REPORTED closed
-- (customer_closed_at). Every open attempt on her order is hers, so opening
-- Paidy again now replaces ANY open window of hers; the lock carries over to
-- the new window, nothing is released, and the sweep still decides whether
-- the old one ever took money (expire_paidy_checkout_attempts).
--
-- md5-guarded in-place patch of the LIVE body (read 2026-10-08):
--   start_paidy_checkout_attempt(uuid,uuid,integer)  21e779750fff39c4ae64391fd78db569
-- Signature unchanged; grants re-asserted to the live ACL (service_role only).
-- ---------------------------------------------------------------------------
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

SELECT pg_temp.cj_patch('public.start_paidy_checkout_attempt(uuid,uuid,integer)', '21e779750fff39c4ae64391fd78db569', jsonb_build_array(
  jsonb_build_object('old', $o$  -- nothing for the order (expire_paidy_checkout_attempts); the window she
  -- closed herself is replaced by the one she opens now — the lock carries
  -- over to it, nothing is released.
  PERFORM public.expire_paidy_checkout_attempts(v_order.id);
  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now()
   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id
     AND status = 'open' AND customer_closed_at IS NOT NULL;
$o$, 'new', $n$  -- nothing for the order (expire_paidy_checkout_attempts); ANY open window
  -- of hers (closed, or left open in a lost tab — QA 2026-10-08) is replaced
  -- by the one she opens now — the lock carries over to it, nothing is
  -- released.
  PERFORM public.expire_paidy_checkout_attempts(v_order.id);
  UPDATE public.paidy_checkout_attempts
     SET status = 'abandoned', ended_at = now(),
         end_reason = coalesce(end_reason, 'replaced')
   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id
     AND status = 'open';
$n$)));

REVOKE ALL ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) TO service_role;
