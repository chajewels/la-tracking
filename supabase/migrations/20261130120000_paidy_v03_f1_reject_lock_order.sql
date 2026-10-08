-- 20261130120000_paidy_v03_f1_reject_lock_order.sql
-- Paidy sign-off V03, finding F1 (owner go 2026-10-09 02:42 JST).
-- Evidence: project doc claude/paidy-v02-v03-evidence-2026-10-09.md.
--
-- The Hub's payment writers lock in ONE order: the submission, then the order,
-- then the provider row (finalize_cash_submission_atomic, decide_square_case,
-- apply_square_payment_state). reject_paidy_submission_atomic was the only one
-- that took the ORDER first. A Paidy Reject and a Confirm recording the same
-- capture at the same moment could therefore deadlock (reproduced on a
-- live-identical scratch database). Postgres cancelled one side, so money
-- stayed correct, but staff saw an error and a cancelled Confirm left the
-- order locked until it was retried.
--
-- The fix moves the Reject to the shared order. Only the opening locks change;
-- every check and write after them is untouched. md5-guarded in-place patch
-- from LIVE (pg_get_functiondef md5 35539cd1f11b891abb5b9c1a7272f201, read
-- 2026-10-09). Grants re-asserted as on live (service_role). Re-run = no-op.

-- ---------------------------------------------------------------------------
-- Patch helper (session-only), copied from 20261130110000.
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

SELECT pg_temp.cj_patch('public.reject_paidy_submission_atomic(uuid,uuid,text,uuid,text,text,jsonb)', '35539cd1f11b891abb5b9c1a7272f201', jsonb_build_array(
  jsonb_build_object('old', E'  -- The ORDER lock first: finalize_cash_submission_atomic (the auto-recorder)\n  -- and file_paidy_submission_atomic take the same lock, so a capture being\n  -- recorded and this Reject queue instead of interleaving.\n  SELECT s.cash_order_id INTO v_order_id FROM public.payment_submissions s WHERE s.id = p_submission_id;\n  IF v_order_id IS NULL THEN RETURN jsonb_build_object(\'ok\', false, \'error\', \'not_found\'); END IF;\n  PERFORM 1 FROM public.cash_orders o WHERE o.id = v_order_id FOR UPDATE;\n\n  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;\n',
                     'new', E'  -- V03-F1 (2026-10-09): ONE lock order everywhere — the submission, then the\n  -- order, then the provider row — the order finalize_cash_submission_atomic,\n  -- decide_square_case and apply_square_payment_state take. Locking the order\n  -- first here (the old order) deadlocked against a Confirm recording the same\n  -- capture (V03 race R3); now the later one waits and sees the earlier result.\n  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;\n  v_order_id := v_sub.cash_order_id;\n  IF v_order_id IS NULL THEN RETURN jsonb_build_object(\'ok\', false, \'error\', \'not_found\'); END IF;\n  PERFORM 1 FROM public.cash_orders o WHERE o.id = v_order_id FOR UPDATE;\n')
));

REVOKE ALL ON FUNCTION public.reject_paidy_submission_atomic(uuid,uuid,text,uuid,text,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_paidy_submission_atomic(uuid,uuid,text,uuid,text,text,jsonb) TO service_role;

DO $$
DECLARE d text := pg_get_functiondef('public.reject_paidy_submission_atomic(uuid,uuid,text,uuid,text,text,jsonb)'::regprocedure);
BEGIN
  IF position('V03-F1 (2026-10-09)' IN d) = 0 THEN
    RAISE EXCEPTION 'self-check: reject_paidy_submission_atomic not patched';
  END IF;
  IF position('SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id FOR UPDATE;' IN d)
     > position('PERFORM 1 FROM public.cash_orders o WHERE o.id = v_order_id FOR UPDATE;' IN d) THEN
    RAISE EXCEPTION 'self-check: reject_paidy_submission_atomic still locks the order before the submission';
  END IF;
END $$;
