-- 20261206100000_paidy_qc_pr_b.sql
-- Paidy QC PR-B: the database half of the 2026-10-10 independent review
-- (owner go 2026-10-10 17:10 JST, "proceed with the plan and recommended").
--
--   DB M-1  mark_web_order_refund_issued_atomic: a Paidy refund is marked
--           issued only once Paidy's verified refunds cover the Paidy money
--           (paidy_refund_incomplete), the same rule terminate applies.
--   DB M-2  file_paidy_submission_atomic: while her window notes a DIFFERENT
--           approval Paidy reported (not verified empty), a new approval is
--           refused (submission_pending / paidy_approval_noted) and the caller
--           releases it — first payment wins; that window is never overwritten.
--   DB M-3  adopt_paidy_orphan_capture_atomic (NEW, service_role): an admin
--           records a Paidy capture the Hub never filed, from Paidy's own
--           read-back, after the same checks as any Paidy payment.
--   DB L-1  cancel_cash_order_atomic refuses while Paidy holds the order.
--   DB L-2  reject_paidy_submission_atomic never ends a submission with no end
--           status while Paidy still holds a capturable authorisation.
--   DB L-3  file_paidy_submission_atomic binds the environment: a test payment
--           only for an is_test customer and only in test mode; a live payment
--           never in test mode.
--   DB L-5  record_paidy_refund: on refund_exceeds_capture refund_jpy is still
--           raised to the captured amount (monotonic), so a fully refunded
--           capture never stays locked.
--   UI M3   cash_order_payment_lock_for_staff (NEW): the order's payment lock,
--           for staff screens (assert_staff_caller first).
--
-- HOW (CLAUDE.md "FUNCTION CHANGES START FROM LIVE"): every existing function is
-- patched IN PLACE from its live body (md5s read 2026-10-10 18:00 JST, equal on
-- the replay); each anchor must occur exactly once; a re-run is a no-op.

SET LOCAL lock_timeout = '5s';

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
-- DB M-2 + DB L-3: file_paidy_submission_atomic
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.file_paidy_submission_atomic(uuid,uuid,text,numeric,boolean,timestamp with time zone,timestamp with time zone,jsonb,date,text,text,text)',
  '3e770287adf43a82728d426d3e786bac',
  jsonb_build_array(
    jsonb_build_object(
      'old', E'      UPDATE public.paidy_checkout_attempts\n         SET status = ''filed'', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = ''filed''\n       WHERE cash_order_id = v_order.id AND status = ''open'';',
      'new', E'      UPDATE public.paidy_checkout_attempts\n         SET status = ''filed'', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = ''filed''\n       WHERE cash_order_id = v_order.id AND status = ''open''\n         -- QC PR-B M-2: a window noting a DIFFERENT approval stays open.\n         AND NOT (authorization_noted_at IS NOT NULL AND verified_empty_at IS NULL\n                  AND paidy_payment_id IS DISTINCT FROM p_paidy_payment_id);'),
    jsonb_build_object(
      'old', E'  v_lock := public.cash_order_payment_lock(v_order.id, v_rec.id, true);\n  IF v_lock IS NOT NULL THEN\n    RETURN jsonb_build_object(''error'', ''submission_pending'', ''lock'', v_lock, ''paidy_record_id'', v_rec.id);\n  END IF;\n',
      'new', E'  v_lock := public.cash_order_payment_lock(v_order.id, v_rec.id, true);\n  IF v_lock IS NOT NULL THEN\n    RETURN jsonb_build_object(''error'', ''submission_pending'', ''lock'', v_lock, ''paidy_record_id'', v_rec.id);\n  END IF;\n  -- QC PR-B M-2 (owner 2026-10-10, first payment wins): her window already\n  -- notes ANOTHER approval Paidy reported and nobody has verified it empty.\n  -- That approval came first; this one waits for nothing — the caller\n  -- releases it. (The noted one is filed when it arrives, or its window ends\n  -- once the sweep verifies Paidy holds nothing.)\n  IF EXISTS (SELECT 1 FROM public.paidy_checkout_attempts a\n              WHERE a.cash_order_id = v_order.id AND a.status = ''open''\n                AND a.authorization_noted_at IS NOT NULL AND a.verified_empty_at IS NULL\n                AND a.paidy_payment_id IS DISTINCT FROM p_paidy_payment_id) THEN\n    RETURN jsonb_build_object(''error'', ''submission_pending'', ''lock'', ''paidy_approval_noted'', ''paidy_record_id'', v_rec.id);\n  END IF;\n'),
    jsonb_build_object(
      'old', E'  -- The order must still be able to take THIS payment (R15: checked on the\n',
      'new', E'  -- QC PR-B L-3 (2026-10-10): the environment is bound in the database too —\n  -- a test payment only in test mode and only for an is_test customer; a live\n  -- payment never in test mode. Never released from here (the other\n  -- environment''s money is not this Hub''s to close).\n  IF coalesce(p_test, false) <> (public.paidy_mode() = ''test'')\n     OR (coalesce(p_test, false) AND NOT EXISTS (SELECT 1 FROM public.customers c\n                                                 WHERE c.id = p_customer_id AND c.is_test)) THEN\n    RETURN jsonb_build_object(''error'', ''paidy_environment_mismatch'', ''test'', coalesce(p_test, false));\n  END IF;\n\n  -- The order must still be able to take THIS payment (R15: checked on the\n'),
    jsonb_build_object(
      'old', E'  UPDATE public.paidy_checkout_attempts\n     SET status = ''filed'', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = ''filed''\n   WHERE cash_order_id = v_order.id AND status = ''open'';\n\n  INSERT INTO public.audit_logs',
      'new', E'  UPDATE public.paidy_checkout_attempts\n     SET status = ''filed'', paidy_payment_id = p_paidy_payment_id, ended_at = now(), end_reason = ''filed''\n   WHERE cash_order_id = v_order.id AND status = ''open''\n     -- QC PR-B M-2 (2026-10-10): a window noting a DIFFERENT approval Paidy\n     -- reported stays open — that approval is still on her Paidy limit and\n     -- the sweep must verify it; overwriting it would forget it.\n     AND NOT (authorization_noted_at IS NOT NULL AND verified_empty_at IS NULL\n              AND paidy_payment_id IS DISTINCT FROM p_paidy_payment_id);\n\n  INSERT INTO public.audit_logs')
  ));

-- ---------------------------------------------------------------------------
-- DB M-1: mark_web_order_refund_issued_atomic (Paidy branch)
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)',
  'fdece38f899856663b73f4533cf5e286',
  jsonb_build_array(jsonb_build_object(
    'old', E'      RETURN jsonb_build_object(''ok'', false, ''error'', ''no_verified_paidy_refund'', ''paidy_paid_jpy'', v_paidy_paid);\n    END IF;\n',
    'new', E'      RETURN jsonb_build_object(''ok'', false, ''error'', ''no_verified_paidy_refund'', ''paidy_paid_jpy'', v_paidy_paid);\n    END IF;\n    -- QC PR-B M-1 (2026-10-10): the same rule as terminate_web_order_atomic\n    -- (paidy_refund_needs_dashboard) — marked issued only once Paidy''s verified\n    -- refunds cover the Paidy money; a partial refund keeps refund_pending.\n    IF v_paidy_refunded < v_paidy_paid THEN\n      RETURN jsonb_build_object(''ok'', false, ''error'', ''paidy_refund_incomplete'',\n        ''paidy_paid_jpy'', v_paidy_paid, ''paidy_refunded_jpy'', v_paidy_refunded,\n        ''message'', ''Paidy has refunded ¥'' || to_char(v_paidy_refunded, ''FM999,999,999'') || '' of ¥''\n          || to_char(v_paidy_paid, ''FM999,999,999'') || ''. Refund the rest in the Paidy dashboard, then mark it.'');\n    END IF;\n')
  ));

-- ---------------------------------------------------------------------------
-- DB L-2: reject_paidy_submission_atomic
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.reject_paidy_submission_atomic(uuid,uuid,text,uuid,text,text,jsonb)',
  '07ac74de7588a55abe0a6ba19f9c240a',
  jsonb_build_array(jsonb_build_object(
    'old', E'  IF v_row.status = ''captured'' THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''paidy_captured''); END IF;\n',
    'new', E'  IF v_row.status = ''captured'' THEN RETURN jsonb_build_object(''ok'', false, ''error'', ''paidy_captured''); END IF;\n  -- QC PR-B L-2 (2026-10-10): never reopen the order while Paidy still holds a\n  -- capturable authorisation — the caller ends it at Paidy and passes its end.\n  IF p_end_status IS NULL AND v_row.status = ''authorized''\n     AND coalesce(v_row.expires_at, v_row.authorized_at + interval ''30 days'') > now() THEN\n    RETURN jsonb_build_object(''ok'', false, ''error'', ''authorization_open'');\n  END IF;\n')
  ));

-- ---------------------------------------------------------------------------
-- DB L-5: record_paidy_refund
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.record_paidy_refund(text,uuid,numeric,text,timestamp with time zone,jsonb)',
  'b74650c77ac470c8fcf9043dba26a6f8',
  jsonb_build_array(jsonb_build_object(
    'old', E'    -- rows (they are Paidy''s facts) but say so; nothing else is written.\n',
    'new', E'    -- rows (they are Paidy''s facts) but say so. QC PR-B L-5 (2026-10-10):\n    -- refund_jpy still rises to the captured amount (monotonic), so a capture\n    -- refunded in full never keeps its order locked.\n    UPDATE public.paidy_payments SET refund_jpy = v_rec.amount_jpy, updated_at = now()\n     WHERE id = p_paidy_payment_row AND (refund_jpy IS NULL OR refund_jpy < v_rec.amount_jpy);\n')
  ));

-- ---------------------------------------------------------------------------
-- DB L-1: cancel_cash_order_atomic
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch(
  'public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)',
  '79832d1661493102dde99658eff479eb',
  jsonb_build_array(jsonb_build_object(
    'old', E'    RAISE EXCEPTION ''card_payment_unresolved: a card payment on this order is still being processed — close the hold or record the capture first'' USING ERRCODE=''P0001'';\n  END IF;\n',
    'new', E'    RAISE EXCEPTION ''card_payment_unresolved: a card payment on this order is still being processed — close the hold or record the capture first'' USING ERRCODE=''P0001'';\n  END IF;\n  -- QC PR-B L-1 (2026-10-10): the same rule terminate_web_order_atomic applies —\n  -- never cancel while Paidy holds the order (an authorisation, a capture not\n  -- recorded, a submission, or her open window) — the preview says the same.\n  IF coalesce(public.cash_order_payment_lock(p_cash_order_id), '''') LIKE ''paidy%'' THEN\n    RAISE EXCEPTION ''paidy_payment_unresolved: Paidy holds this order — Reject or record the Paidy payment first'' USING ERRCODE=''P0001'';\n  END IF;\n')
  ));

-- ---------------------------------------------------------------------------
-- UI M3: cash_order_payment_lock_for_staff (NEW)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_order_payment_lock_for_staff(p_cash_order_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Customers are `authenticated` too: staff only (CLAUDE.md, 2026-10-09).
  PERFORM public.assert_staff_caller(NULL);
  RETURN public.cash_order_payment_lock(p_cash_order_id);
END
$function$;
REVOKE ALL ON FUNCTION public.cash_order_payment_lock_for_staff(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_order_payment_lock_for_staff(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- DB M-3: adopt_paidy_orphan_capture_atomic (NEW, service_role only)
-- ---------------------------------------------------------------------------
-- Called ONLY by paidy-staff-action record_orphan_capture, after it read the
-- payment back from Paidy (status captured, captures = amount, nothing
-- refunded, order_ref / environment bound). It writes the Hub's receipt of the
-- capture and queues it for the ONE recording path (the edge function then
-- runs the paidy_auto Confirm through finalize_cash_submission_atomic). The
-- case is resolved as record_capture, exactly as resolve_paidy_case does once
-- a payment row exists. Lock order: the case, then the order (as
-- resolve_paidy_case).
CREATE OR REPLACE FUNCTION public.adopt_paidy_orphan_capture_atomic(
  p_case_id uuid, p_user_id uuid, p_reason text, p_amount_jpy numeric, p_test boolean,
  p_authorized_at timestamp with time zone, p_captured_at timestamp with time zone,
  p_capture_id text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_case  public.paidy_cases%ROWTYPE;
  v_order public.cash_orders%ROWTYPE;
  v_rec   public.paidy_payments%ROWTYPE;
  v_sub   public.payment_submissions%ROWTYPE;
  v_cust  public.customers%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR NOT public.has_role(p_user_id, 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden_admin_only');
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;
  IF p_amount_jpy IS NULL OR p_amount_jpy <= 0 OR p_amount_jpy <> trunc(p_amount_jpy) OR p_test IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_amount');
  END IF;

  SELECT * INTO v_case FROM public.paidy_cases WHERE id = p_case_id FOR UPDATE;
  IF v_case.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'case_not_found'); END IF;
  IF v_case.status <> 'open' THEN RETURN jsonb_build_object('ok', false, 'error', 'case_not_open'); END IF;
  IF v_case.paidy_payment_row IS NOT NULL
     OR v_case.kind NOT IN ('captured_unrecorded','captured_no_submission','record_failed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'case_not_orphan');
  END IF;
  IF v_case.cash_order_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'order_missing'); END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = v_case.cash_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'order_missing'); END IF;
  IF EXISTS (SELECT 1 FROM public.paidy_payments WHERE paidy_payment_id = v_case.paidy_payment_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'already_recorded');
  END IF;
  IF v_order.status::text <> 'pending' OR coalesce(v_order.payment_status, '') <> 'pending_transfer'
     OR (v_order.source_channel = 'web' AND v_order.ready_confirmed_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order_cannot_take_payment', 'status', v_order.status::text,
                              'payment_status', v_order.payment_status);
  END IF;
  IF v_order.currency::text <> 'JPY' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_yen'); END IF;
  IF v_order.total_paid - public.cash_order_points_paid(v_order.id) <> 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'order_part_paid');
  END IF;
  IF p_amount_jpy <> v_order.remaining_balance THEN
    RETURN jsonb_build_object('ok', false, 'error', 'amount_differs_from_balance',
                              'amount_jpy', p_amount_jpy, 'remaining_balance', v_order.remaining_balance);
  END IF;
  SELECT * INTO v_cust FROM public.customers WHERE id = v_order.customer_id;
  IF p_test <> (public.paidy_mode() = 'test') OR (p_test AND NOT coalesce(v_cust.is_test, false)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'paidy_environment_mismatch', 'test', p_test);
  END IF;
  -- One payment at a time: nothing else may be waiting on this order (the
  -- case itself is the only Paidy hold allowed).
  IF EXISTS (SELECT 1 FROM public.paidy_cases c
              WHERE c.cash_order_id = v_order.id AND c.id <> v_case.id AND c.status = 'open'
                AND c.paidy_payment_row IS NULL
                AND c.kind IN ('captured_unrecorded','captured_no_submission','record_failed'))
     OR EXISTS (SELECT 1 FROM public.payment_submissions s
                 WHERE s.cash_order_id = v_order.id
                   AND (s.status IN ('submitted','under_review') OR (s.status = 'confirmed' AND s.confirmed_payment_id IS NULL)))
     OR EXISTS (SELECT 1 FROM public.paidy_payments pp
                 WHERE pp.cash_order_id = v_order.id
                   AND ((pp.status = 'authorized' AND coalesce(pp.expires_at, pp.authorized_at + interval '30 days') > now())
                        OR (pp.status = 'captured' AND coalesce(pp.refund_jpy, 0) < pp.amount_jpy
                            AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s2
                                             WHERE s2.paidy_payment_id = pp.id AND s2.confirmed_payment_id IS NOT NULL))))
     OR EXISTS (SELECT 1 FROM public.paidy_checkout_attempts a
                 WHERE a.cash_order_id = v_order.id AND a.status = 'open'
                   AND a.authorization_noted_at IS NOT NULL AND a.verified_empty_at IS NULL
                   AND a.paidy_payment_id IS DISTINCT FROM v_case.paidy_payment_id)
     OR public.square_order_unresolved(v_order.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_in_progress');
  END IF;

  INSERT INTO public.paidy_payments (cash_order_id, customer_id, paidy_payment_id, status, test, amount_jpy,
                                     authorized_at, captured_at, capture_id, last_payload)
  VALUES (v_order.id, v_order.customer_id, v_case.paidy_payment_id, 'captured', p_test, p_amount_jpy,
          coalesce(p_authorized_at, p_captured_at, now()), coalesce(p_captured_at, now()), p_capture_id, p_payload)
  RETURNING * INTO v_rec;

  INSERT INTO public.payment_submissions (account_id, cash_order_id, customer_id, submitted_amount,
         payment_date, payment_method, reference_number, sender_name, proof_url, notes, status,
         submission_type, paidy_payment_id)
  VALUES (NULL, v_order.id, v_order.customer_id, p_amount_jpy,
          (coalesce(p_captured_at, now()) AT TIME ZONE 'Asia/Tokyo')::date, 'paidy',
          v_case.paidy_payment_id, v_cust.full_name, NULL,
          'Paidy capture the Hub never filed, recorded by an admin from Paidy''s read-back: ' || btrim(p_reason),
          'submitted', 'cash_payment', v_rec.id)
  RETURNING * INTO v_sub;

  -- Her Paidy window (if one is still open) ends here: this capture IS the
  -- payment it was opened for (review MED-1: a window left open would lock
  -- the completed order).
  UPDATE public.paidy_checkout_attempts
     SET status = 'filed', paidy_payment_id = v_case.paidy_payment_id, ended_at = now(), end_reason = 'filed'
   WHERE cash_order_id = v_order.id AND status = 'open';

  UPDATE public.paidy_cases
     SET paidy_payment_row = v_rec.id, submission_id = v_sub.id,
         status = 'resolved', resolved_at = now(), resolved_by = p_user_id,
         resolution = 'record_capture', resolution_note = btrim(p_reason)
   WHERE id = v_case.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
  VALUES ('cash_payment_submission', v_sub.id, 'submission_created',
          jsonb_build_object('cash_order_id', v_order.id, 'invoice_number', v_order.invoice_number,
            'amount', p_amount_jpy, 'method', 'paidy', 'reference', v_case.paidy_payment_id,
            'path', 'orphan_capture_adopted', 'case_id', v_case.id), p_user_id),
         ('paidy_case', v_case.id, 'paidy_case_resolved',
          jsonb_build_object('kind', v_case.kind, 'paidy_payment_id', v_case.paidy_payment_id,
            'cash_order_id', v_order.id, 'resolution', 'record_capture', 'note', btrim(p_reason),
            'submission_id', v_sub.id, 'adopted_orphan', true), p_user_id);

  RETURN jsonb_build_object('ok', true, 'submission_id', v_sub.id, 'paidy_record_id', v_rec.id,
                            'cash_order_id', v_order.id);
END
$function$;
REVOKE ALL ON FUNCTION public.adopt_paidy_orphan_capture_atomic(uuid, uuid, text, numeric, boolean, timestamp with time zone, timestamp with time zone, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adopt_paidy_orphan_capture_atomic(uuid, uuid, text, numeric, boolean, timestamp with time zone, timestamp with time zone, text, jsonb) TO service_role;

-- Grants of the patched functions re-asserted as on live.
REVOKE ALL ON FUNCTION public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamp with time zone, timestamp with time zone, jsonb, date, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.file_paidy_submission_atomic(uuid, uuid, text, numeric, boolean, timestamp with time zone, timestamp with time zone, jsonb, date, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.reject_paidy_submission_atomic(uuid, uuid, text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_paidy_submission_atomic(uuid, uuid, text, uuid, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.record_paidy_refund(text, uuid, numeric, text, timestamp with time zone, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_paidy_refund(text, uuid, numeric, text, timestamp with time zone, jsonb) TO service_role;
