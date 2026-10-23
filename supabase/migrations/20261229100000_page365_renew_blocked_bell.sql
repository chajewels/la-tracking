-- Page365 void sync — bell when a RENEWAL is blocked by a waiting payment
-- (review finding 2026-10-23, owner "go").
--
-- page365_apply_invoice_stage already refuses to restore an order while a
-- payment submission is 'submitted' / 'under_review' (INVARIANT 12) and
-- returns action 'submission_pending'. The VOID side rings a staff bell
-- (page365_void_blocked) in that case; the RENEW side returned silently, so a
-- renewal caught by the 30-minute check left nobody told. This adds the same
-- bell on the renew side: type page365_renew_blocked, once per invoice
-- (last_notified_stage 'renewed_blocked'), account_id on layaway only — exactly
-- the void-side shape. Nothing else changes: the order is still not restored.
--
-- Live base: page365_apply_invoice_stage pg_get_functiondef md5
-- 9e84ceb9ec3273b5b2d48da45ffeda72 (= migration 20261228100000 as applied
-- 2026-10-22; prosrc md5 18895e88f9721da8da70329d8ae762e0, read 2026-10-23).
-- One md5-guarded in-place edit (pattern of 20261228100000). Safe to re-run:
-- an already-patched function is left alone. CREATE OR REPLACE keeps the
-- function's grants (service_role only).

BEGIN;

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
END;
$p$;

SELECT pg_temp.cj_patch(
  'public.page365_apply_invoice_stage(bigint,text,uuid,text)',
  '9e84ceb9ec3273b5b2d48da45ffeda72',
  jsonb_build_array(jsonb_build_object(
    'old', $old$
  IF v_pending > 0 THEN
    RETURN jsonb_build_object('action', 'submission_pending', 'pending_submissions', v_pending,$old$,
    'new', $new$
  IF v_pending > 0 THEN
    IF v_link.last_notified_stage IS DISTINCT FROM 'renewed_blocked' THEN
      INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
      VALUES ('page365_renew_blocked', 'Page365 renewed — payment waiting for review',
              'Invoice ' || COALESCE(v_invoice, p_page365_no::text) || ' was renewed in Page365, but a payment submission is still waiting. Confirm or reject it, then press Re-read Page365 to restore the order.',
              CASE WHEN v_kind = 'layaway' THEN v_id END, v_customer, v_invoice,
              jsonb_build_object('page365_no', p_page365_no, 'kind', v_kind, 'order_id', v_id));
      UPDATE public.page365_invoice_links SET last_notified_stage = 'renewed_blocked' WHERE page365_no = p_page365_no;
    END IF;
    RETURN jsonb_build_object('action', 'submission_pending', 'pending_submissions', v_pending,$new$
  ))
);

-- Self-check: the patched function rings the new bell and still refuses the restore.
DO $chk$
DECLARE v_def text := pg_get_functiondef('public.page365_apply_invoice_stage(bigint,text,uuid,text)'::regprocedure);
BEGIN
  IF position('page365_renew_blocked' IN v_def) = 0 OR position('page365_void_blocked' IN v_def) = 0 THEN
    RAISE EXCEPTION 'STOP — page365_apply_invoice_stage is missing a bell after the patch; rolled back';
  END IF;
  IF has_function_privilege('authenticated', 'public.page365_apply_invoice_stage(bigint,text,uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — page365_apply_invoice_stage became callable by authenticated; rolled back';
  END IF;
END
$chk$;

COMMIT;
