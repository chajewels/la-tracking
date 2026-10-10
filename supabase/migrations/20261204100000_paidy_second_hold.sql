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
--   1. NEW columns paidy_checkout_attempts.authorization_noted_at /
--      authorization_test / stuck_bell_at and NEW function
--      note_paidy_window_authorization (under the order lock): the website's
--      filing step writes the payment id Paidy reported AUTHORIZED onto her
--      open window BEFORE it files — after reading it back from Paidy (Paidy
--      unreachable = noted anyway, fail closed; a 404 from the same key family
--      later verifies it empty). No open window left → one is opened that
--      carries the approval.
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
-- 1. The columns and the writer
-- ---------------------------------------------------------------------------
ALTER TABLE public.paidy_checkout_attempts
  ADD COLUMN IF NOT EXISTS authorization_noted_at timestamptz,
  ADD COLUMN IF NOT EXISTS authorization_test boolean,
  ADD COLUMN IF NOT EXISTS stuck_bell_at timestamptz;
COMMENT ON COLUMN public.paidy_checkout_attempts.authorization_noted_at IS
  'Paidy second-hold fix (2026-10-10): when the website''s filing step noted a payment Paidy reported AUTHORIZED (or could not be read) on this window, before filing it. Such a window is never replaced by a new one until the sweep files the payment or verifies Paidy holds nothing.';
COMMENT ON COLUMN public.paidy_checkout_attempts.authorization_test IS
  'Paidy second-hold fix: the key family (true = test) that noted the approval. A 404 from that SAME family verifies the window empty — one deployment only ever holds one key.';
COMMENT ON COLUMN public.paidy_checkout_attempts.stuck_bell_at IS
  'Paidy second-hold fix: when the sweep rang the one staff bell for a noted window still open 3 hours past its expiry.';

-- An earlier draft had a 3-argument version; never on live, removed wherever it ran.
DROP FUNCTION IF EXISTS public.note_paidy_window_authorization(uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.note_paidy_window_authorization(p_cash_order_id uuid, p_customer_id uuid, p_paidy_payment_id text, p_test boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.cash_orders%ROWTYPE;
  v_n integer;
BEGIN
  IF p_paidy_payment_id IS NULL OR p_paidy_payment_id !~ '^pay_[A-Za-z0-9_-]{6,80}$' OR p_test IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_payment_id');
  END IF;
  -- The same order lock start_paidy_checkout_attempt and the filing take, so
  -- a note and a new window queue instead of interleaving.
  SELECT * INTO v_order FROM public.cash_orders
   WHERE id = p_cash_order_id AND customer_id = p_customer_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'order_not_found'); END IF;

  -- Her open window carries the approval. An id the window learned from a
  -- closed / declined callback (no approval noted) gives way to this approved
  -- one, and its earlier verification is cleared; a window already holding a
  -- DIFFERENT approval keeps it (the sweep verifies that one).
  UPDATE public.paidy_checkout_attempts
     SET authorization_noted_at = coalesce(CASE WHEN paidy_payment_id = p_paidy_payment_id THEN authorization_noted_at END, now()),
         authorization_test = p_test,
         verified_empty_at = CASE WHEN paidy_payment_id = p_paidy_payment_id THEN verified_empty_at END,
         not_found_test_at = CASE WHEN paidy_payment_id = p_paidy_payment_id THEN not_found_test_at END,
         not_found_live_at = CASE WHEN paidy_payment_id = p_paidy_payment_id THEN not_found_live_at END,
         paidy_payment_id = p_paidy_payment_id
   WHERE cash_order_id = v_order.id AND customer_id = p_customer_id AND status = 'open'
     AND (paidy_payment_id IS NULL OR paidy_payment_id = p_paidy_payment_id OR authorization_noted_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN RETURN jsonb_build_object('ok', true, 'noted', true); END IF;

  IF EXISTS (SELECT 1 FROM public.paidy_checkout_attempts WHERE cash_order_id = v_order.id AND status = 'open') THEN
    RETURN jsonb_build_object('ok', true, 'noted', false, 'reason', 'other_approval_noted');
  END IF;
  -- No open window (it timed out before the approval came back): open one that
  -- carries the approval and holds the order until the sweep decides.
  IF v_order.remaining_balance > 0 AND v_order.status::text = 'pending'
     AND coalesce(v_order.payment_status, '') = 'pending_transfer' THEN
    INSERT INTO public.paidy_checkout_attempts (cash_order_id, customer_id, amount_jpy, expires_at,
                                                paidy_payment_id, authorization_noted_at, authorization_test, end_reason)
    VALUES (v_order.id, p_customer_id, v_order.remaining_balance, now(), p_paidy_payment_id, now(), p_test, 'approval_held');
    RETURN jsonb_build_object('ok', true, 'noted', true, 'opened', true);
  END IF;
  RETURN jsonb_build_object('ok', true, 'noted', false, 'reason', 'order_not_payable');
END
$function$;

REVOKE ALL ON FUNCTION public.note_paidy_window_authorization(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_paidy_window_authorization(uuid, uuid, text, boolean) TO service_role;

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
