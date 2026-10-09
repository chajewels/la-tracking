-- Square QC close-out (2026-10-09). Project doc: claude/square-qc-assessment-2026-10-09.md
-- Owner decisions taken as recommended (D-QC1, D-QC5).
--
--   Q-DB2  get_staff_bell_emails() answers staff only; staff_bell_email_recipients()
--          (it returns staff email addresses) is no longer executable by signed-in
--          users. The fan-out and the settings readers are SECURITY DEFINER and keep
--          working.
--   F-01   A card or Paidy submission is never sent for clarification
--          (provider_submission_no_clarify). A hold closed by Square also rejects a
--          legacy needs_clarification submission.
--   Q-DB1  A signed-in caller writing payment_submissions directly can no longer
--          move or file a card / Paidy submission (provider_submission_status_locked).
--          The reviewer, provider and sweep paths run as service_role; the two staff
--          case functions (decide_square_case, resolve_paidy_case) mark their own
--          transaction with app.provider_submission_writer, inside the same SECURITY
--          DEFINER call (one transaction, not the two-call pattern of Bug #39).
--   F-02   A chargeback where the bank holds or took the money (EVIDENCE_REQUIRED,
--          PROCESSING, LOST, ACCEPTED) counts as money already returned:
--          square_order_disputed_jpy(order). Both cancel paths refuse store credit
--          (card_disputed); the refund-outside-Square cap subtracts it (approve and
--          record); record_square_dispute rings card_dispute_after_credit /
--          card_dispute_after_exception when such a state reaches an order that
--          already carries credit or an exception.
--   F-03   "Mark refund issued — card" counts only COMPLETED refunds of captures that
--          were recorded on the order (square_payments.cash_payment_id), capped per
--          payment at its captured amount.
--   F-04   While a refund-outside-Square approval is open, every other method is
--          refused (exception_approved_pending): cancel the approval first.
--   F-13   cancel_cash_order_atomic refuses while a card payment is unresolved.
--   Q-UX1  Both cancel previews say what the real cancel would refuse
--          (store_credit_refusal / refusal) instead of promising credit.
--   Q-UI1  get_square_settings.disputes_open counts disputes not yet decided.
--   Q-DB3  authenticated / anon hold no INSERT / UPDATE / DELETE / TRUNCATE grant on
--          the Square ledger tables (RLS stays; this is the second wall).
--   F-08   close_square_attempt_atomic: an admin closes a card attempt stuck as
--          reserved / unknown / cancelling after checking the Square Dashboard
--          (note required, audited, refused when Square already gave a payment id).
--
--   Every patch starts from the live text behind an md5 guard (Bug #280); no `--`
--   line inside any patch anchor or new text (Lovable's runner drops such lines).
--   A re-run is a no-op.

-- ---------------------------------------------------------------------------
-- 1. Patch helper (session-only).
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
-- 2. F-02 — money the card network holds or took back, per order.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_order_disputed_jpy(p_order_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
  SELECT coalesce(sum(coalesce(d.amount_jpy, round(sp.amount_jpy)::bigint)), 0)::bigint
    FROM public.square_disputes d
    LEFT JOIN public.square_payments sp ON sp.id = d.square_payment_row
   WHERE d.cash_order_id = p_order_id
     AND upper(coalesce(d.state, '')) IN ('EVIDENCE_REQUIRED', 'PROCESSING', 'LOST', 'ACCEPTED');
$fn$;
REVOKE ALL ON FUNCTION public.square_order_disputed_jpy(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.square_order_disputed_jpy(uuid) TO service_role;
COMMENT ON FUNCTION public.square_order_disputed_jpy(uuid) IS
  'F-02 (2026-10-09, owner D-QC1): yen on this order that a card chargeback holds or took back (EVIDENCE_REQUIRED, PROCESSING, LOST, ACCEPTED). Counts as money already returned: no store credit, and the refund-outside-Square cap subtracts it.';

-- ---------------------------------------------------------------------------
-- 3. Q-DB2 — staff email addresses are for staff only.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.get_staff_bell_emails()', '5a5c2af3c0bdc72d3214ca404bb694cb', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
$o$,
                     'new', $n$  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.is_staff(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
$n$)
));
REVOKE ALL ON FUNCTION public.staff_bell_email_recipients() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_bell_email_recipients() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. F-01 + Q-DB1 — the card / Paidy submission status rules.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.guard_provider_submission()', 'c40481a6f89999423f90221a5d845679', jsonb_build_array(
  jsonb_build_object('old', $o$  IF TG_OP = 'UPDATE' THEN
$o$,
                     'new', $n$  /* F-01 (QC 2026-10-09): a card or Paidy submission ends by Confirm or Reject, never by Clarify. */
  IF (NEW.square_payment_id IS NOT NULL OR NEW.paidy_payment_id IS NOT NULL)
     AND NEW.status::text = 'needs_clarification'
     AND (TG_OP = 'INSERT' OR OLD.status::text IS DISTINCT FROM 'needs_clarification') THEN
    RAISE EXCEPTION 'provider_submission_no_clarify: a card or Paidy submission is Confirmed or Rejected, never sent for clarification'
      USING ERRCODE = 'P0001';
  END IF;
  /* Q-DB1 (QC 2026-10-09): a signed-in caller writing this table directly never files or moves a card / Paidy
     submission. The reviewer, provider and sweep paths run as service_role; decide_square_case and
     resolve_paidy_case mark their own transaction. */
  IF (NEW.square_payment_id IS NOT NULL OR NEW.paidy_payment_id IS NOT NULL)
     AND (TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status)
     AND coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role', '') IN ('authenticated', 'anon')
     AND coalesce(current_setting('app.provider_submission_writer', true), '') <> 'on' THEN
    RAISE EXCEPTION 'provider_submission_status_locked: a card or Paidy submission changes status only through Confirm / Reject in Payments Hub'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' THEN
$n$)
));

SELECT pg_temp.cj_patch('public.decide_square_case(text,uuid,text,text)', 'ea8ea5da81b66cebc297d69fddaf1e34', jsonb_build_array(
  jsonb_build_object('old', $o$  IF v_dec = '' THEN RETURN jsonb_build_object('error', 'decision_required'); END IF;
$o$,
                     'new', $n$  IF v_dec = '' THEN RETURN jsonb_build_object('error', 'decision_required'); END IF;
  PERFORM set_config('app.provider_submission_writer', 'on', true);
$n$)
));

SELECT pg_temp.cj_patch('public.resolve_paidy_case(uuid,text,text)', '9109a207f44ad599840de763d7e8e60e', jsonb_build_array(
  jsonb_build_object('old', $o$    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
$o$,
                     'new', $n$    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
  PERFORM set_config('app.provider_submission_writer', 'on', true);
$n$)
));

-- ---------------------------------------------------------------------------
-- 5. F-01 + F-16 — a hold closed by Square also ends a legacy needs_clarification
--    submission, and the bell says what the submission really is.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.apply_square_payment_state(text,text,bigint,bigint,text,text,timestamptz,timestamptz,timestamptz,text,text,text,text,jsonb,jsonb,text,uuid)', 'dbce7999df0f187a21d42a4cd8d07ee0', jsonb_build_array(
  jsonb_build_object('old', $o$    IF v_sub.id IS NOT NULL AND v_sub.status::text IN ('submitted','under_review') THEN$o$,
                     'new', $n$    IF v_sub.id IS NOT NULL AND v_sub.status::text IN ('submitted','under_review','needs_clarification') THEN$n$),
  jsonb_build_object('old', $o$                || CASE WHEN v_subact = 'rejected' THEN 'the submission was rejected and the customer can pay again.' ELSE 'no submission was waiting.' END,$o$,
                     'new', $n$                || CASE WHEN v_subact = 'rejected' THEN 'the submission was rejected and the customer can pay again.'
                        WHEN v_sub.id IS NOT NULL THEN 'its latest submission is ' || replace(v_sub.status::text, '_', ' ') || ' — check it in Payments Hub.'
                        ELSE 'no submission was waiting.' END,$n$)
));

-- ---------------------------------------------------------------------------
-- 6. F-02 + Q-UX1 — web order cancel.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)', '061ff17474545cb4d5c51d204c158341', jsonb_build_array(
  jsonb_build_object('old', $o$  v_card_refunded boolean := false;
  v_paidy_paid numeric(12,2) := 0;$o$,
                     'new', $n$  v_card_refunded boolean := false;
  v_card_disputed bigint := 0;
  v_credit_refusal text := NULL;
  v_paidy_paid numeric(12,2) := 0;$n$),
  jsonb_build_object('old', $o$    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_paidy_refunded > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_already_refunded',
        'status', v_status, 'paidy_refunded_jpy', v_paidy_refunded);
    END IF;
$o$,
                     'new', $n$    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_paidy_refunded > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'paidy_already_refunded',
        'status', v_status, 'paidy_refunded_jpy', v_paidy_refunded);
    END IF;
    v_card_disputed := public.square_order_disputed_jpy(p_order_id);
    IF NOT p_preview AND p_refund_status = 'store_credit_issued' AND v_card_disputed > 0 THEN
      RETURN jsonb_build_object('ok', false, 'success', false, 'reason', 'card_disputed',
        'status', v_status, 'disputed_jpy', v_card_disputed);
    END IF;
    v_credit_refusal := CASE WHEN v_card_refunded THEN 'card_already_refunded'
                             WHEN v_paidy_refunded > 0 THEN 'paidy_already_refunded'
                             WHEN v_card_disputed > 0 THEN 'card_disputed' END;
$n$),
  jsonb_build_object('old', $o$      'store_credit_if_chosen', GREATEST(0, COALESCE((v_split ->> 'credit')::numeric, 0) - v_partial_credit),$o$,
                     'new', $n$      'store_credit_if_chosen', CASE WHEN v_credit_refusal IS NOT NULL THEN 0
                                     ELSE GREATEST(0, COALESCE((v_split ->> 'credit')::numeric, 0) - v_partial_credit) END,
      'store_credit_refusal', v_credit_refusal,
      'card_disputed_jpy', v_card_disputed,$n$)
));

-- ---------------------------------------------------------------------------
-- 7. F-02 + F-13 + Q-UX1 — Hub cash order cancel.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)', '048ce7636504d60837967715cd10112e', jsonb_build_array(
  jsonb_build_object('old', $o$  v_card_refunded boolean := false;
  v_paidy_refunded numeric(12,2) := 0;
$o$,
                     'new', $n$  v_card_refunded boolean := false;
  v_paidy_refunded numeric(12,2) := 0;
  v_card_disputed bigint := 0;
  v_unresolved boolean := false;
$n$),
  jsonb_build_object('old', $o$  IF v_status NOT IN ('pending','completed') THEN
    RAISE EXCEPTION 'cash_order_not_cancellable: status is %', v_status USING ERRCODE='P0001';
  END IF;
$o$,
                     'new', $n$  IF v_status NOT IN ('pending','completed') THEN
    RAISE EXCEPTION 'cash_order_not_cancellable: status is %', v_status USING ERRCODE='P0001';
  END IF;
  v_unresolved := public.square_order_unresolved(p_cash_order_id);
  IF NOT p_preview AND v_unresolved THEN
    RAISE EXCEPTION 'card_payment_unresolved: a card payment on this order is still being processed — close the hold or record the capture first' USING ERRCODE='P0001';
  END IF;
$n$),
  jsonb_build_object('old', $o$  IF NOT p_preview AND v_paidy_refunded > 0 AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'paidy_already_refunded: ¥% of this order was already refunded in the Paidy dashboard — it cannot be issued again as store credit', v_paidy_refunded::bigint USING ERRCODE='P0001';
  END IF;
$o$,
                     'new', $n$  IF NOT p_preview AND v_paidy_refunded > 0 AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'paidy_already_refunded: ¥% of this order was already refunded in the Paidy dashboard — it cannot be issued again as store credit', v_paidy_refunded::bigint USING ERRCODE='P0001';
  END IF;
  v_card_disputed := public.square_order_disputed_jpy(p_cash_order_id);
  IF NOT p_preview AND v_card_disputed > 0 AND v_issue_amount > 0 THEN
    RAISE EXCEPTION 'card_disputed: ¥% of this order is held or taken back by a card chargeback — it cannot be issued again as store credit', v_card_disputed USING ERRCODE='P0001';
  END IF;
$n$),
  jsonb_build_object('old', $o$      'paidy_refunded_jpy', v_paidy_refunded,
$o$,
                     'new', $n$      'paidy_refunded_jpy', v_paidy_refunded,
      'card_disputed_jpy', v_card_disputed,
      'card_payment_unresolved', v_unresolved,
      'refusal', CASE WHEN v_unresolved THEN 'card_payment_unresolved'
                      WHEN v_issue_amount > 0 AND v_card_refunded THEN 'card_already_refunded'
                      WHEN v_issue_amount > 0 AND v_paidy_refunded > 0 THEN 'paidy_already_refunded'
                      WHEN v_issue_amount > 0 AND v_card_disputed > 0 THEN 'card_disputed' END,
$n$)
));

-- ---------------------------------------------------------------------------
-- 8. F-02 — the refund-outside-Square cap subtracts chargeback money (approve).
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.approve_card_refund_exception_atomic(uuid,uuid,text,text,text,bigint,text)', 'db0c56f264f6a191e667738b7a753507', jsonb_build_array(
  jsonb_build_object('old', $o$  v_cap      bigint;
$o$,
                     'new', $n$  v_cap      bigint;
  v_disputed bigint := 0;
$n$),
  jsonb_build_object('old', $o$  v_cap := v_captured - v_refunded - v_credit;
$o$,
                     'new', $n$  v_disputed := public.square_order_disputed_jpy(p_order_id);
  v_cap := v_captured - v_refunded - v_credit - v_disputed;
$n$)
));

-- ---------------------------------------------------------------------------
-- 9. F-02 (record cap) + F-03 + F-04 — "Mark refund issued".
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)', 'cad96859812dba952667a296e0e390e4', jsonb_build_array(
  jsonb_build_object('old', $o$  v_payout text;
$o$,
                     'new', $n$  v_payout text;
  v_card_disputed numeric(12,2) := 0;
$n$),
  jsonb_build_object('old', $o$  IF p_refunded_on IS NULL OR p_refunded_on > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
  END IF;
$o$,
                     'new', $n$  IF p_refunded_on IS NULL OR p_refunded_on > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
  END IF;
  IF v_method NOT IN ('bank_transfer_exception', 'store_credit_exception')
     AND EXISTS (SELECT 1 FROM public.card_refund_exceptions WHERE cash_order_id = p_order_id AND status = 'approved') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_approved_pending');
  END IF;
$n$),
  jsonb_build_object('old', $o$    v_cap := v_card_captured - v_card_refunded - v_credit_issued;
$o$,
                     'new', $n$    v_card_disputed := public.square_order_disputed_jpy(p_order_id);
    v_cap := v_card_captured - v_card_refunded - v_credit_issued - v_card_disputed;
$n$),
  jsonb_build_object('old', $o$    SELECT COALESCE(SUM(amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds WHERE cash_order_id = p_order_id AND status = 'COMPLETED';
$o$,
                     'new', $n$    SELECT COALESCE(SUM(LEAST(x.done, x.cap)), 0) INTO v_card_refunded
      FROM (SELECT SUM(r.amount_jpy) AS done,
                   MAX(COALESCE(sp.captured_amount_jpy, round(sp.amount_jpy)::bigint)) AS cap
              FROM public.square_refunds r
              JOIN public.square_payments sp ON sp.id = r.square_payment_row
             WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED' AND sp.cash_payment_id IS NOT NULL
             GROUP BY sp.id) x;
$n$)
));

-- ---------------------------------------------------------------------------
-- 10. F-02 — a chargeback that reaches an order already compensated rings a bell.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)', '06e0a73476bc6e8dbdf97921f435d828', jsonb_build_array(
  jsonb_build_object('old', $o$  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state,
$o$,
                     'new', $n$  IF v_st IN ('EVIDENCE_REQUIRED','PROCESSING','LOST','ACCEPTED')
     AND (v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state) THEN
    IF EXISTS (SELECT 1 FROM public.store_credit_lots l
                WHERE l.source_cash_order_id = v_sq.cash_order_id AND l.status::text <> 'voided') THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_dispute_after_credit', 'Chargeback on an order already given store credit',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · '
                || coalesce('¥' || to_char(v_new.amount_jpy, 'FM999,999,999'), '') || ' · state ' || v_st
                || ' — the card network holds or took back this money, but the order already carries store credit. The customer may be compensated twice: a staff case (void the unspent credit, or contest the dispute in the Square Dashboard).',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'dispute_id', p_dispute_id, 'state', v_st, 'test', v_sq.test));
    END IF;
    IF EXISTS (SELECT 1 FROM public.card_refund_exceptions x
                WHERE x.cash_order_id = v_sq.cash_order_id AND x.status IN ('approved','recorded')) THEN
      INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
      VALUES ('card_dispute_after_exception', 'Chargeback on an order refunded outside Square',
              coalesce(v_order.web_reference, v_order.invoice_number, '') || ' · '
                || coalesce('¥' || to_char(v_new.amount_jpy, 'FM999,999,999'), '') || ' · state ' || v_st
                || ' — the card network holds or took back this money, but a refund outside Square is approved or paid on this order. Do not pay an approved one; if it is paid, contest the dispute in the Square Dashboard.',
              v_order.customer_id, v_order.invoice_number,
              jsonb_build_object('cash_order_id', v_sq.cash_order_id, 'square_payment_id', p_square_payment_id,
                                 'dispute_id', p_dispute_id, 'state', v_st, 'test', v_sq.test));
    END IF;
  END IF;
  RETURN jsonb_build_object('ok', true, 'changed', v_old.id IS NULL OR v_old.state IS DISTINCT FROM v_new.state,
$n$)
));

-- ---------------------------------------------------------------------------
-- 11. Q-UI1 — "disputes open" means disputes not yet decided.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.get_square_settings()', 'cb504d316e9926196ea0644c0c9157f5', jsonb_build_array(
  jsonb_build_object('old', $o$    'disputes_open',         (SELECT count(*) FROM public.square_payments WHERE disputed_at IS NOT NULL AND status = 'captured'));$o$,
                     'new', $n$    'disputes_open',         (SELECT count(*) FROM public.square_disputes
                               WHERE upper(coalesce(state, '')) NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')));$n$)
));

-- ---------------------------------------------------------------------------
-- 12. F-08 — an admin closes a stuck card attempt after checking the Square
--     Dashboard (owner D-QC5). Called from the Hub (Website → Card payments).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_square_attempt_atomic(p_attempt_id uuid, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_att  public.square_card_attempts%ROWTYPE;
  v_old  text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN RETURN jsonb_build_object('ok', false, 'error', 'admin_only'); END IF;
  IF v_note IS NULL OR length(v_note) < 10 THEN RETURN jsonb_build_object('ok', false, 'error', 'note_required'); END IF;
  SELECT * INTO v_att FROM public.square_card_attempts WHERE id = p_attempt_id;
  IF v_att.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  PERFORM 1 FROM public.cash_orders WHERE id = v_att.cash_order_id FOR UPDATE;
  SELECT * INTO v_att FROM public.square_card_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF v_att.status NOT IN ('reserved', 'unknown', 'cancelling') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open', 'status', v_att.status);
  END IF;
  IF v_att.created_at > now() - interval '30 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_recent', 'created_at', v_att.created_at);
  END IF;
  IF v_att.square_payment_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.square_payments sp
                 WHERE sp.attempt_id = v_att.id OR (v_att.reference IS NOT NULL AND sp.reference = v_att.reference)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_exists');
  END IF;
  v_old := v_att.status;
  UPDATE public.square_card_attempts
     SET status = 'cancelled', error_code = 'closed_by_admin',
         detail = left('Closed by an admin after checking the Square Dashboard: ' || v_note, 500),
         resolved_at = now(), updated_at = now()
   WHERE id = v_att.id
  RETURNING * INTO v_att;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('square_card_attempt', v_att.id, 'square_attempt_closed_by_admin', jsonb_build_object('status', v_old),
          jsonb_build_object('status', 'cancelled', 'note', v_note, 'cash_order_id', v_att.cash_order_id,
                             'reference', v_att.reference, 'amount_jpy', v_att.amount_jpy), v_uid);
  RETURN jsonb_build_object('ok', true, 'attempt_id', v_att.id, 'from', v_old, 'cash_order_id', v_att.cash_order_id);
END
$fn$;
REVOKE ALL ON FUNCTION public.close_square_attempt_atomic(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_square_attempt_atomic(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 13. Q-DB3 — signed-in users hold no write grant on the Square ledger tables.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['square_payments','square_refunds','square_disputes','square_card_attempts',
                           'square_webhook_events','square_attempts'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM PUBLIC, anon, authenticated', t);
    END IF;
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 14. Self-check (structure; behaviour: development/sql/square-qc-adverse-2026-10-09.sql).
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  t text;
BEGIN
  IF has_function_privilege('authenticated', 'public.staff_bell_email_recipients()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.staff_bell_email_recipients()', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — Q-DB2: signed-in users can still execute staff_bell_email_recipients';
  END IF;
  IF position('is_staff(v_uid)' IN pg_get_functiondef('public.get_staff_bell_emails()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — Q-DB2: get_staff_bell_emails is not staff-only';
  END IF;
  IF position('provider_submission_no_clarify' IN pg_get_functiondef('public.guard_provider_submission()'::regprocedure)) = 0
     OR position('provider_submission_status_locked' IN pg_get_functiondef('public.guard_provider_submission()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — F-01 / Q-DB1 guard missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_provider_submission'
                    AND tgrelid = 'public.payment_submissions'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'STOP — trg_guard_provider_submission is not on payment_submissions';
  END IF;
  IF position('app.provider_submission_writer' IN pg_get_functiondef('public.decide_square_case(text,uuid,text,text)'::regprocedure)) = 0
     OR position('app.provider_submission_writer' IN pg_get_functiondef('public.resolve_paidy_case(uuid,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — a staff case function does not mark its transaction';
  END IF;
  IF position('card_disputed' IN pg_get_functiondef('public.terminate_web_order_atomic(uuid,text,text,uuid,text,text,text,text,boolean)'::regprocedure)) = 0
     OR position('card_disputed' IN pg_get_functiondef('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)'::regprocedure)) = 0
     OR position('square_order_disputed_jpy' IN pg_get_functiondef('public.approve_card_refund_exception_atomic(uuid,uuid,text,text,text,bigint,text)'::regprocedure)) = 0
     OR position('square_order_disputed_jpy' IN pg_get_functiondef('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)'::regprocedure)) = 0
     OR position('card_dispute_after_credit' IN pg_get_functiondef('public.record_square_dispute(text,text,text,text,bigint,timestamptz,timestamptz,timestamptz,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — F-02 not complete';
  END IF;
  IF position('exception_approved_pending' IN pg_get_functiondef('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)'::regprocedure)) = 0
     OR position('sp.cash_payment_id IS NOT NULL' IN pg_get_functiondef('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — F-03 / F-04 not complete';
  END IF;
  IF has_function_privilege('authenticated', 'public.square_order_disputed_jpy(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.close_square_attempt_atomic(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP — grants on the new functions are wrong';
  END IF;
  FOREACH t IN ARRAY ARRAY['square_payments','square_refunds','square_disputes','square_card_attempts',
                           'square_webhook_events','square_attempts'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND (has_table_privilege('authenticated', 'public.' || t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
            OR has_table_privilege('authenticated', 'public.' || t, 'DELETE')) THEN
      RAISE EXCEPTION 'STOP — Q-DB3: authenticated can still write %', t;
    END IF;
  END LOOP;
END
$self$;
