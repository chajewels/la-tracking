-- 20261116100000_paidy_reassessment.sql
-- Paidy QA/QC reassessment 2026-10-06 (Paidy chat): P01 + P02 database side.
--
-- P01  A staff note never releases Paidy money:
--   - cash_order_payment_lock: captured-but-unrecorded Paidy money keeps the
--     order locked until it is RECORDED or Paidy's own refund ledger shows it
--     refunded in full (refund_jpy >= amount_jpy). A resolved case no longer
--     releases it. A capture case with no Paidy record (orphan) locks its
--     order while the case is open.
--   - resolve_paidy_case 'end_submission': refused while Paidy holds captured
--     money that is not fully refunded (captured_not_settled), and refused
--     while a Confirm is recording it (recording_in_progress, 5-minute lease).
-- P02  Captured is terminal, refunds only grow (database guard, behind the
--     compare-and-set writes in _shared/paidy-sync.ts):
--   - guard_paidy_payment_identity: a captured row never leaves 'captured';
--     refund_jpy never decreases; a capture id is never erased.
--
-- md5-guarded in-place patches of the LIVE bodies (read 2026-10-06):
--   cash_order_payment_lock(uuid,uuid,boolean)  c2b378948c042d89a9c3e491e9c92bcd
--   resolve_paidy_case(uuid,text,text)          f94287975ced83bbc9d6c44c93da1dc0
--   guard_paidy_payment_identity()              3f0540230b4e17a7d66257797fae940b
-- Signatures unchanged; grants re-asserted to the live ACL.
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

-- P01a. The lock: only recording or a full Paidy refund releases captured money.
SELECT pg_temp.cj_patch('public.cash_order_payment_lock(uuid,uuid,boolean)', 'c2b378948c042d89a9c3e491e9c92bcd', jsonb_build_array(
  jsonb_build_object('old', $o$         AND NOT EXISTS (SELECT 1 FROM public.paidy_cases c
                          WHERE c.paidy_payment_row = pp.id AND c.status = 'resolved'
                            AND c.kind IN ('captured_unrecorded','captured_no_submission','refund_before_record','record_failed')))
      THEN 'paidy_captured_unrecorded'
$o$, 'new', $n$         -- P01 (2026-10-06): a staff note never releases it — only a full
         -- refund in Paidy's own ledger does.
         AND coalesce(pp.refund_jpy, 0) < pp.amount_jpy)
      THEN 'paidy_captured_unrecorded'
    -- P01: a Paidy capture case with no Paidy record locks its order while open.
    WHEN EXISTS (
      SELECT 1 FROM public.paidy_cases c
       WHERE c.cash_order_id = p_cash_order_id AND c.paidy_payment_row IS NULL AND c.status = 'open'
         AND c.kind IN ('captured_unrecorded','captured_no_submission','record_failed'))
      THEN 'paidy_captured_unrecorded'
$n$)));

-- P01b. Ending a Paidy submission needs settled money and no running Confirm.
SELECT pg_temp.cj_patch('public.resolve_paidy_case(uuid,text,text)', 'f94287975ced83bbc9d6c44c93da1dc0', jsonb_build_array(
  jsonb_build_object('old', $o$    PERFORM 1 FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    UPDATE public.payment_submissions
$o$, 'new', $n$    SELECT * INTO v_rec FROM public.paidy_payments WHERE id = v_case.paidy_payment_row FOR UPDATE;
    -- P01 (2026-10-06): a note never settles captured money — record it, or
    -- refund it in full in Paidy (the ledger shows it) first.
    IF v_rec.status = 'captured' AND coalesce(v_rec.refund_jpy, 0) < v_rec.amount_jpy THEN
      RETURN jsonb_build_object('error', 'captured_not_settled');
    END IF;
    -- P01: never under a Confirm that is recording it right now (5-minute lease).
    IF EXISTS (SELECT 1 FROM public.payment_submissions
                WHERE paidy_payment_id = v_case.paidy_payment_row AND status = 'confirmed'
                  AND confirmed_payment_id IS NULL
                  AND processing_started_at IS NOT NULL AND processing_started_at > now() - interval '5 minutes') THEN
      RETURN jsonb_build_object('error', 'recording_in_progress');
    END IF;
    UPDATE public.payment_submissions
$n$)));

-- P02. Captured is terminal; refunds only grow; a capture id is never erased.
SELECT pg_temp.cj_patch('public.guard_paidy_payment_identity()', '3f0540230b4e17a7d66257797fae940b', jsonb_build_array(
  jsonb_build_object('old', $o$  RETURN NEW;
END
$o$, 'new', $n$  -- P02 (2026-10-06): an older answer arriving late never undoes money.
  IF OLD.status = 'captured' AND NEW.status IS DISTINCT FROM 'captured' THEN
    RAISE EXCEPTION 'paidy_payment_locked: a captured Paidy payment stays captured' USING ERRCODE = 'P0001';
  END IF;
  IF coalesce(NEW.refund_jpy, 0) < coalesce(OLD.refund_jpy, 0) THEN
    RAISE EXCEPTION 'paidy_payment_locked: a Paidy refund total never decreases' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.capture_id IS NOT NULL AND NEW.capture_id IS NULL THEN
    NEW.capture_id := OLD.capture_id;
  END IF;
  RETURN NEW;
END
$n$)));

REVOKE ALL ON FUNCTION public.cash_order_payment_lock(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_order_payment_lock(uuid, uuid, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.resolve_paidy_case(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_paidy_case(uuid, text, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_paidy_payment_identity() FROM PUBLIC, anon, authenticated;
