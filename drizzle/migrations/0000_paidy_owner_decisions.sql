-- 20261114100000_paidy_owner_decisions.sql
-- Paidy chat, owner decisions 2026-10-06 (quality-check items #2 and #4).
--
-- 1. create_web_draft_atomic (qc-audit P3 #1, owner "correct"):
--    - each draft line is priced at the QUOTE's unit price (what the customer
--      was shown and the draft total is made of), not the variant's price now;
--    - a product unpublished after the quote is refused (product_unavailable).
-- 2. change_web_payment_method_atomic (qc-audit P3 #3, owner "correct"):
--    staff can switch an order to Paidy only while Paidy is on and the order
--    ships to Japan, and to card only while card payments are on — the same
--    check create_web_draft_atomic applies at checkout. Otherwise
--    method_unavailable, nothing written.
-- 3. terminate_web_order_atomic (owner decision: cancel closes Paidy): a staff
--    cancel PREVIEW no longer refuses on a Paidy lock — cancel-cash-order now
--    closes the authorisation (read back from Paidy) before the real cancel,
--    and the real cancel still refuses while any Paidy money is unresolved.
--
-- Both are md5-guarded in-place patches of the LIVE bodies (read 2026-10-06):
--   create_web_draft_atomic(uuid,uuid,text,text,timestamptz)  f2ead814bf682cc01fd2e67f68557f29
--   change_web_payment_method_atomic(text,uuid,text,text,uuid) c53a73f430cc8f2f0b66253a570bea92
--   terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean) 833eacb86f34dc8f5affbbcdcd84a6f9
-- Signatures unchanged; grants re-asserted to the live ACL (service_role only).
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

-- 1. Draft lines: the quote's price; an unpublished product is refused.
SELECT pg_temp.cj_patch('public.create_web_draft_atomic(uuid,uuid,text,text,timestamp with time zone)', 'f2ead814bf682cc01fd2e67f68557f29', jsonb_build_array(
  jsonb_build_object('old', $o$    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item ->> 'variant_id';
    END IF;
$o$, 'new', $n$    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_missing:%', v_item ->> 'variant_id';
    END IF;
    -- QC 2026-10-06: a product unpublished after the quote is not drafted.
    IF NOT EXISTS (SELECT 1 FROM public.website_products p
                    WHERE p.id = v_variant.product_id AND p.status = 'active') THEN
      RAISE EXCEPTION 'product_unavailable:%', v_variant.id;
    END IF;
$n$),
  jsonb_build_object('old', $o$      v_qty, v_variant.price_jpy, v_variant.price_jpy * v_qty
$o$, 'new', $n$      -- QC 2026-10-06: the quote's unit price (what the customer saw and
      -- the draft total is made of), the variant's price only as a fallback.
      v_qty, coalesce((v_item ->> 'unit_price_jpy')::numeric, v_variant.price_jpy),
      coalesce((v_item ->> 'unit_price_jpy')::numeric, v_variant.price_jpy) * v_qty
$n$),
  jsonb_build_object('old', $o$    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
$o$, 'new', $n$    ELSIF SQLERRM LIKE 'product_unavailable:%' THEN
      RETURN jsonb_build_object('error', 'product_unavailable', 'variant_id', split_part(SQLERRM, ':', 2));
    ELSIF SQLERRM LIKE 'variant_missing:%' THEN
$n$)));

-- 2. Staff method change: only to a method the order can take.
SELECT pg_temp.cj_patch('public.change_web_payment_method_atomic(text,uuid,text,text,uuid)', 'c53a73f430cc8f2f0b66253a570bea92', jsonb_build_array(
  jsonb_build_object('old', $o$  v_ref    text;
BEGIN
$o$, 'new', $n$  v_ref    text;
  v_country text;
BEGIN
$n$),
  jsonb_build_object('old', $o$    SELECT payment_method, mode, settlement_currency, status, web_reference
      INTO v_old, v_mode, v_cur, v_status, v_ref
$o$, 'new', $n$    SELECT payment_method, mode, settlement_currency, status, web_reference, upper(nullif(btrim(coalesce(country, '')), ''))
      INTO v_old, v_mode, v_cur, v_status, v_ref, v_country
$n$),
  jsonb_build_object('old', $o$           ready_confirmed_at, source_channel, coalesce(web_reference, invoice_number)
      INTO v_old, v_mode, v_cur, v_status, v_pay, v_ready, v_chan, v_ref
$o$, 'new', $n$           ready_confirmed_at, source_channel, coalesce(web_reference, invoice_number),
           upper(nullif(btrim(coalesce(ship_to_snapshot ->> 'country', '')), ''))
      INTO v_old, v_mode, v_cur, v_status, v_pay, v_ready, v_chan, v_ref, v_country
$n$),
  jsonb_build_object('old', $o$  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;
$o$, 'new', $n$  IF p_method <> 'transfer' AND v_cur <> 'JPY' THEN
    RETURN jsonb_build_object('error', 'method_requires_yen');
  END IF;
  -- QC 2026-10-06: the same availability check as checkout
  -- (create_web_draft_atomic), so a customer is never told to pay by a method
  -- the order cannot take.
  IF (p_method = 'paidy' AND (public.paidy_mode() = 'off' OR coalesce(v_country, '') <> 'JP'))
     OR (p_method = 'square' AND public.square_mode() = 'off') THEN
    RETURN jsonb_build_object('error', 'method_unavailable', 'method', p_method);
  END IF;
$n$)));

-- 3. Staff cancel preview: no Paidy refusal (the real cancel still refuses).
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '833eacb86f34dc8f5affbbcdcd84a6f9', jsonb_build_array(
  jsonb_build_object('old', $o$  IF coalesce(public.cash_order_payment_lock(p_order_id), '') LIKE 'paidy%' THEN
$o$, 'new', $n$  IF NOT (p_preview AND p_outcome = 'cancelled' AND p_source = 'staff')   -- owner 2026-10-06: cancel closes Paidy first
     AND coalesce(public.cash_order_payment_lock(p_order_id), '') LIKE 'paidy%' THEN
$n$)));

REVOKE ALL ON FUNCTION public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_web_order_atomic(uuid, text, text, uuid, text, text, text, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.create_web_draft_atomic(uuid, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_web_draft_atomic(uuid, uuid, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.change_web_payment_method_atomic(text, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_web_payment_method_atomic(text, uuid, text, text, uuid) TO service_role;