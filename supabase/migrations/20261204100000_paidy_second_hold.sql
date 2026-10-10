-- 20261204100000_paidy_second_hold.sql
-- Paidy: no second hold after an approved payment the Hub could not file
-- (owner go 2026-10-10 15:02 JST, Paidy QC follow-up to PR-B H3).
--
-- THE GAP. Paidy approved a payment (AUTHORIZED) but the Hub's filing never
-- finished (connection dropped, timeout, a refusal such as paidy_not_offered).
-- Nothing on the Hub named that payment, so when she pressed Paidy again
-- start_paidy_checkout_attempt REPLACED her open window and Paidy could take a
-- SECOND hold on her limit. Only her own browser waited, and only 30 minutes.
--
-- THE FIX (Hub side; the storefront waits up to 90 minutes, its own PR):
--   1. NEW column paidy_checkout_attempts.authorization_noted_at and NEW
--      function note_paidy_window_authorization: the website's filing step
--      writes the payment id Paidy reported AUTHORIZED onto her open window
--      BEFORE it files — after reading it back from Paidy (the same check as
--      the abandon note; Paidy unreachable = noted anyway, fail closed).
--   2. start_paidy_checkout_attempt never replaces a window that carries an
--      approved payment id not yet verified empty: the order stays locked
--      (paidy_checkout_open → payment_in_progress) until the hourly sweep has
--      read the payment back from Paidy and filed it (the window ends as
--      'filed') or found it holds nothing (verified_empty). A window she closed
--      herself, or that Paidy declined, is still replaced at once, as before.
--
-- HOW (CLAUDE.md "FUNCTION CHANGES START FROM LIVE"): start_paidy_checkout_attempt
-- is patched IN PLACE from its live body (md5 0ab389929a0e53cf8a2980a9dc2b4935,
-- read 2026-10-10 15:10 JST); the anchor must occur exactly once; re-run = no-op.
-- Grants re-asserted as on live (service_role only).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Patch helper (session-only), copied from 20261201100000.
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

-- ---------------------------------------------------------------------------
-- 1. The column and the writer
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_checkout_attempts
  ADD COLUMN IF NOT EXISTS authorization_noted_at timestamptz;
COMMENT ON COLUMN public.paidy_checkout_attempts.authorization_noted_at IS
  'Paidy second-hold fix (2026-10-10): when the website''s filing step noted a payment Paidy reported AUTHORIZED on this window, before filing it. Such a window is never replaced by a new one until the sweep files the payment or verifies Paidy holds nothing.';

CREATE OR REPLACE FUNCTION public.note_paidy_window_authorization(p_cash_order_id uuid, p_customer_id uuid, p_paidy_payment_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer;
BEGIN
  IF p_paidy_payment_id IS NULL OR p_paidy_payment_id !~ '^pay_[A-Za-z0-9_-]{6,80}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_payment_id');
  END IF;
  -- Her open window on this order. A window that already names ANOTHER payment
  -- keeps that one (the sweep verifies it); the same id is idempotent.
  UPDATE public.paidy_checkout_attempts
     SET paidy_payment_id = p_paidy_payment_id,
         authorization_noted_at = coalesce(authorization_noted_at, now())
   WHERE cash_order_id = p_cash_order_id AND customer_id = p_customer_id AND status = 'open'
     AND (paidy_payment_id IS NULL OR paidy_payment_id = p_paidy_payment_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'noted', v_n = 1);
END
$function$;

REVOKE ALL ON FUNCTION public.note_paidy_window_authorization(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_paidy_window_authorization(uuid, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. start_paidy_checkout_attempt: never replace a window holding an approval
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.start_paidy_checkout_attempt(uuid,uuid,integer)', '0ab389929a0e53cf8a2980a9dc2b4935', jsonb_build_array(
  jsonb_build_object(
    'old', E'         end_reason = coalesce(end_reason, ''replaced'')\n   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id\n     AND status = ''open'';',
    'new', E'         end_reason = coalesce(end_reason, ''replaced'')\n   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id\n     AND status = ''open''\n     -- Second-hold fix (2026-10-10): a window holding a payment Paidy\n     -- APPROVED that the Hub has not filed is never replaced; the lock below\n     -- then refuses (paidy_checkout_open) until the sweep files it or\n     -- verifies Paidy holds nothing.\n     AND NOT (authorization_noted_at IS NOT NULL AND verified_empty_at IS NULL);')
));

REVOKE ALL ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_paidy_checkout_attempt(uuid, uuid, integer) TO service_role;
