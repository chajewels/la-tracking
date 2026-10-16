-- Website → Settings → Card payments: the settings card counts the LIVE Square
-- environment only (2026-10-16, owner "go" on QA's 16 Oct production
-- inspection; claude/qa-brief-live-production-2026-10-11.md §8).
--
-- Defect: get_square_settings() computed authorized_now / captured_30d /
-- disputes_open over every square_payments / square_disputes row, so the card
-- read "11 captured in the last 30 days" on production while production had 1
-- (the other 10 were sandbox test captures). The operations panel
-- (square_ops_health, 20261212100000) already counts the live environment;
-- the settings card now follows the same rule:
--   * authorized_now, captured_30d: environment = square_live_environment()
--     (mode 'test' → sandbox, else production); a row with NULL environment
--     counts under the live environment, as in square_ops_health — never
--     silently dropped.
--   * disputes_open: a dispute has no environment column; it takes its parent
--     payment's (square_disputes.square_payment_row → square_payments.id).
--   * a new key 'environment' so the card can name what it counts.
-- Nothing else in the function changes; the Hub card text is in
-- src/components/settings/SquareSettingsCard.tsx (same PR).
--
-- FUNCTION CHANGES START FROM LIVE (Bug #280): get_square_settings() is
-- patched IN PLACE from live with pg_temp.cj_patch (live md5(pg_get_functiondef)
-- ee547d9d8e38338302f4c08d2eb11021, read 2026-10-16; the repo copy in
-- 20261130170000 is that same body). The patch STOPs on any other live body
-- and is a no-op once applied. The patched body hashes to
-- e160e8911889258201cdaf8bda8e7d0f (checked on a local replay of the exact
-- live text); section 2 asserts that and records the post-patch body in full
-- so the function drift audit (scripts/function-drift-audit) reads it.
--
-- RECORD-ONLY CATCH-UP (sections 3–4): the drift audit of 2026-10-16 found
-- two functions whose newest repo CREATE differs from live, both already
-- live, neither changed here in substance:
--   * mark_web_order_refund_issued_atomic — patched in place by 20261212100000
--     (applied 2026-10-15) and never recorded since. Live md5
--     d0ae5262522ad32279e9574da1f9b1f3 = the 20261207100000 body + that patch
--     (checked byte for byte).
--   * cart_reminder_candidates — the repo CREATE (20261216100000) carries a
--     three-line "-- Stage B" comment inside the body that Lovable dropped on
--     apply (the DOC-4 comment-drop), so live (61c614c74ba3f7bf98b70f568df6e8fa)
--     is the repo body minus those comment lines and nothing else. The guard
--     accepts either hash (live, or the comment-ful body a local replay
--     produces) and writes the live text.
-- Each record is guarded: an unexpected md5 → STOP, nothing changed; after the
-- replace the md5 is checked again, so a body that does not reproduce live
-- rolls the whole migration back. GRANTS ARE NOT TOUCHED (CREATE OR REPLACE
-- keeps each function's live ACL). No comment lines inside the cj_patch 'new'
-- blocks (Lovable drops them on apply).

-- ---------------------------------------------------------------------------
-- 0. The patch helper (session-only; same as 20261212100000).
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
-- 1. get_square_settings(): count the live environment only.
-- ---------------------------------------------------------------------------
SELECT pg_temp.cj_patch('public.get_square_settings()', 'ee547d9d8e38338302f4c08d2eb11021', jsonb_build_array(
  jsonb_build_object('old', $o0$    'authorized_now',        (SELECT count(*) FROM public.square_payments WHERE status = 'authorized'),
$o0$, 'new', $n0$    'environment',           public.square_live_environment(),
    'authorized_now',        (SELECT count(*) FROM public.square_payments
                               WHERE status = 'authorized'
                                 AND coalesce(environment, public.square_live_environment()) = public.square_live_environment()),
$n0$),
  jsonb_build_object('old', $o1$                               WHERE status = 'captured' AND captured_at >= now() - interval '30 days'),
$o1$, 'new', $n1$                               WHERE status = 'captured' AND captured_at >= now() - interval '30 days'
                                 AND coalesce(environment, public.square_live_environment()) = public.square_live_environment()),
$n1$),
  jsonb_build_object('old', $o2$    'disputes_open',         (SELECT count(*) FROM public.square_disputes
                               WHERE upper(coalesce(state, '')) NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')));
$o2$, 'new', $n2$    'disputes_open',         (SELECT count(*) FROM public.square_disputes d
                               LEFT JOIN public.square_payments p ON p.id = d.square_payment_row
                               WHERE upper(coalesce(d.state, '')) NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')
                                 AND coalesce(p.environment, public.square_live_environment()) = public.square_live_environment()));
$n2$)
));

-- ---------------------------------------------------------------------------
-- 2. The post-patch body, asserted and recorded for the drift audit.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.get_square_settings()');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.get_square_settings() is not on live; nothing changed';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> 'e160e8911889258201cdaf8bda8e7d0f' THEN
    RAISE EXCEPTION 'STOP — public.get_square_settings() has md5 %, expected e160e8911889258201cdaf8bda8e7d0f; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.get_square_settings() matches (post-patch) — the replace below writes the recorded body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_square_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_name text;
  v_by   uuid;
  v_at   timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role) OR public.has_permission(v_uid, 'admin_settings')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  -- The most recent change among the four rows names the last editor.
  SELECT updated_by_user_id, updated_at INTO v_by, v_at
    FROM public.system_settings
   WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')
     AND updated_by_user_id IS NOT NULL
   ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  IF v_by IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found', (SELECT count(*) FROM public.system_settings
               WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')) = 4,
    'mode',                  public.square_mode(),
    'raw_mode',              (SELECT value FROM public.system_settings WHERE key = 'square_mode'),
    'app_id',                coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_app_id'), ''),
    'location_id',           coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_location_id'), ''),
    'agreement_min_jpy',     coalesce(((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'card_agreement_min_jpy'))::numeric, 0),
    'updated_at',            v_at,
    'updated_by_user_id',    v_by,
    'updated_by_name',       v_name,
    'audience',              public.square_audience(),
    'card_customers',        coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'code', c.customer_code, 'name', c.full_name) ORDER BY c.customer_code)
                                         FROM public.customers c
                                        WHERE c.id::text IN (SELECT jsonb_array_elements_text(public.square_card_customer_ids_json()))), '[]'::jsonb),
    'preflight',             (SELECT value || jsonb_build_object('updated_at', updated_at) FROM public.square_sync_state WHERE key = 'preflight:production'),
    'can_change',            public.has_role(v_uid, 'admin'::public.app_role),
    'environment',           public.square_live_environment(),
    'authorized_now',        (SELECT count(*) FROM public.square_payments
                               WHERE status = 'authorized'
                                 AND coalesce(environment, public.square_live_environment()) = public.square_live_environment()),
    'captured_30d',          (SELECT count(*) FROM public.square_payments
                               WHERE status = 'captured' AND captured_at >= now() - interval '30 days'
                                 AND coalesce(environment, public.square_live_environment()) = public.square_live_environment()),
    'disputes_open',         (SELECT count(*) FROM public.square_disputes d
                               LEFT JOIN public.square_payments p ON p.id = d.square_payment_row
                               WHERE upper(coalesce(d.state, '')) NOT IN ('WON','LOST','ACCEPTED','INQUIRY_CLOSED')
                                 AND coalesce(p.environment, public.square_live_environment()) = public.square_live_environment()));
END
$function$;
DO $check$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.get_square_settings()'))) <> 'e160e8911889258201cdaf8bda8e7d0f' THEN
    RAISE EXCEPTION 'STOP — public.get_square_settings() does not hash to e160e8911889258201cdaf8bda8e7d0f after the replace; rolled back';
  END IF;
END
$check$;

-- ---------------------------------------------------------------------------
-- 3. Record-only: mark_web_order_refund_issued_atomic as live runs it.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb) is not on live; nothing changed';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> 'd0ae5262522ad32279e9574da1f9b1f3' THEN
    RAISE EXCEPTION 'STOP — public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb) has md5 %, expected d0ae5262522ad32279e9574da1f9b1f3; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb) matches (live) — the replace below writes the recorded body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.mark_web_order_refund_issued_atomic(p_order_id uuid, p_user_id uuid, p_method text, p_refunded_on date, p_note text DEFAULT NULL::text, p_exception jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_order   public.cash_orders%ROWTYPE;
  v_amount  numeric(12,2);
  v_note    text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_method  text := lower(btrim(COALESCE(p_method, '')));
  v_prev    jsonb;
  v_card_paid boolean;
  v_noncard numeric(12,2);
  v_card_refunded numeric(12,2);
  v_paidy_paid numeric(12,2) := 0;
  v_paidy_refunded numeric(12,2) := 0;
  v_paidy_remaining numeric(12,2) := 0;
  v_exc jsonb := NULL;
  v_exc_trigger text := NULL;
  v_exc_amount numeric(12,2) := 0;
  v_card_captured numeric(12,2) := 0;
  v_credit_issued numeric(12,2) := 0;
  v_cap numeric(12,2) := 0;
  v_lot public.store_credit_lots%ROWTYPE;
  v_cre public.card_refund_exceptions%ROWTYPE;
  v_payout text;
  v_card_disputed numeric(12,2) := 0;
  v_further boolean := false;
  v_marked_card numeric(12,2) := 0;
  v_marked_noncard boolean := false;
  v_marked_exc boolean := false;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'user_identity_required');
  END IF;

  SELECT * INTO v_order FROM public.cash_orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  IF v_order.source_channel IS DISTINCT FROM 'web' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_web_order');
  END IF;
  IF v_order.status::text <> 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_cancelled', 'status', v_order.status::text);
  END IF;
  -- B01 (2026-10-08): the same request again after it succeeded (a retry
  -- after a lost answer) gets the same answer and writes nothing.
  IF v_order.refund_status = 'refund_issued' THEN
    SELECT a.new_value_json INTO v_prev FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued'
       AND a.new_value_json ->> 'method' = v_method
     ORDER BY a.created_at DESC LIMIT 1;
    SELECT coalesce(sum((a.new_value_json ->> 'amount')::numeric) FILTER (WHERE a.new_value_json ->> 'method' = 'card'), 0),
           coalesce(bool_or(a.new_value_json ->> 'method' IN ('bank_transfer', 'paidy', 'cash', 'other')), false),
           coalesce(bool_or(a.new_value_json ->> 'method' IN ('bank_transfer_exception', 'store_credit_exception')), false)
      INTO v_marked_card, v_marked_noncard, v_marked_exc
      FROM public.audit_logs a
     WHERE a.entity_type = 'cash_order' AND a.entity_id = p_order_id AND a.action = 'refund_marked_issued';
    v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                            WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
    SELECT COALESCE(SUM(amount_paid), 0) INTO v_noncard
      FROM public.cash_payments
     WHERE cash_order_id = p_order_id AND voided_at IS NULL
       AND COALESCE(payment_method, '') <> 'square'
       AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
    IF v_method = 'card' THEN
      v_further := NOT v_marked_exc AND public.square_order_card_refund_recordable_jpy(p_order_id) > v_marked_card + 0.005;
    ELSIF v_method IN ('bank_transfer', 'paidy', 'cash', 'other') THEN
      v_further := v_prev IS NULL AND NOT v_marked_noncard AND v_card_paid AND v_noncard > 0;
    END IF;
    IF NOT v_further AND v_prev IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'already_recorded', true,
                                'amount', (v_prev ->> 'amount')::numeric, 'currency', v_prev ->> 'currency',
                                'method', v_method, 'refunded_on', v_prev ->> 'refunded_on',
                                'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
    END IF;
  END IF;
  IF v_order.refund_status IS DISTINCT FROM 'refund_pending' AND NOT v_further THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_refund_pending', 'refund_status', v_order.refund_status);
  END IF;
  IF v_method NOT IN ('bank_transfer', 'paidy', 'card', 'cash', 'other', 'bank_transfer_exception', 'store_credit_exception') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_method');
  END IF;
  IF p_refunded_on IS NULL OR p_refunded_on > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_date');
  END IF;
  IF v_method NOT IN ('bank_transfer_exception', 'store_credit_exception')
     AND EXISTS (SELECT 1 FROM public.card_refund_exceptions WHERE cash_order_id = p_order_id AND status = 'approved') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exception_approved_pending');
  END IF;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_amount
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';

  -- B01 (2026-10-08): card money goes back only through Square. A card-paid
  -- order is marked with method 'card', only once Square shows a COMPLETED
  -- refund, and the amount recorded is what Square completed (owner E7) —
  -- never the gross received. Other methods only for money that did not come
  -- by card.
  v_card_paid := EXISTS (SELECT 1 FROM public.cash_payments
                          WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'square');
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_noncard
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL
     AND COALESCE(payment_method, '') <> 'square'
     AND COALESCE(reference_number, '') NOT LIKE 'LOYALTY-%';
  IF v_method = 'card' AND NOT v_card_paid THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
  END IF;
  IF v_method IN ('bank_transfer_exception', 'store_credit_exception') THEN
    IF NOT v_card_paid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_card');
    END IF;
    IF NOT public.has_role(p_user_id, 'admin') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'admin_only');
    END IF;
    v_payout := CASE v_method WHEN 'bank_transfer_exception' THEN 'bank_transfer' ELSE 'store_credit' END;
    SELECT * INTO v_cre FROM public.card_refund_exceptions
     WHERE cash_order_id = p_order_id AND status = 'approved' FOR UPDATE;
    IF v_cre.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_not_approved');
    END IF;
    IF v_cre.payout <> v_payout THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_payout_mismatch', 'approved_payout', v_cre.payout);
    END IF;
    IF EXISTS (SELECT 1 FROM public.square_refunds r
                WHERE r.cash_order_id = p_order_id AND r.status NOT IN ('COMPLETED', 'FAILED', 'REJECTED')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_refund_in_progress');
    END IF;
    SELECT coalesce(sum(round(sp.amount_jpy)), 0) INTO v_card_captured
      FROM public.square_payments sp WHERE sp.cash_order_id = p_order_id AND sp.status = 'captured';
    SELECT coalesce(sum(r.amount_jpy), 0) INTO v_card_refunded
      FROM public.square_refunds r WHERE r.cash_order_id = p_order_id AND r.status = 'COMPLETED';
    SELECT coalesce(sum(round(l.original_amount)), 0) INTO v_credit_issued
      FROM public.store_credit_lots l WHERE l.source_cash_order_id = p_order_id AND l.status::text <> 'voided';
    v_card_disputed := public.square_order_disputed_jpy(p_order_id);
    v_cap := v_card_captured - v_card_refunded - v_credit_issued - v_card_disputed;
    IF v_cre.amount_jpy > v_cap THEN
      RETURN jsonb_build_object('ok', false, 'error', 'exception_superseded', 'cap_jpy', v_cap, 'approved_jpy', v_cre.amount_jpy,
                                'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded, 'credit_issued_jpy', v_credit_issued);
    END IF;
    v_exc := COALESCE(p_exception, '{}'::jsonb);
    IF v_payout = 'bank_transfer' THEN
      IF COALESCE(v_exc ->> 'transfer_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_date');
      END IF;
      IF (v_exc ->> 'transfer_date')::date > (now() AT TIME ZONE 'Asia/Manila')::date
         OR (v_exc ->> 'transfer_date')::date < (v_cre.approved_at AT TIME ZONE 'Asia/Manila')::date THEN
        RETURN jsonb_build_object('ok', false, 'error', 'bad_date', 'detail', 'transfer_date');
      END IF;
      IF NULLIF(btrim(COALESCE(v_exc ->> 'transfer_reference', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'transfer_reference');
      END IF;
      UPDATE public.card_refund_exceptions
         SET status = 'recorded', recorded_by = p_user_id, recorded_at = now(),
             transfer_date = (v_exc ->> 'transfer_date')::date,
             transfer_reference = left(btrim(v_exc ->> 'transfer_reference'), 200), updated_at = now()
       WHERE id = v_cre.id
      RETURNING * INTO v_cre;
    ELSE
      IF NULLIF(btrim(COALESCE(v_exc ->> 'customer_request', '')), '') IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'customer_request');
      END IF;
      IF COALESCE(v_exc ->> 'store_credit_lot_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_evidence_required', 'missing', 'store_credit_lot_id');
      END IF;
      SELECT * INTO v_lot FROM public.store_credit_lots WHERE id = (v_exc ->> 'store_credit_lot_id')::uuid FOR UPDATE;
      IF v_lot.id IS NULL OR v_lot.customer_id IS DISTINCT FROM v_order.customer_id OR v_lot.currency::text <> 'JPY'
         OR v_lot.status::text <> 'active' OR v_lot.expires_at <= now() OR v_lot.remaining_amount <> v_lot.original_amount
         OR v_lot.original_amount <> v_cre.amount_jpy OR v_lot.source_cash_order_id IS NOT NULL
         OR v_lot.issued_at < v_cre.approved_at
         OR EXISTS (SELECT 1 FROM public.card_refund_exceptions x WHERE x.store_credit_lot_id = v_lot.id) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'exception_lot_mismatch', 'detail',
          CASE WHEN v_lot.id IS NULL THEN 'lot_not_found'
               WHEN v_lot.customer_id IS DISTINCT FROM v_order.customer_id THEN 'lot_not_this_customer'
               WHEN v_lot.currency::text <> 'JPY' THEN 'lot_not_jpy'
               WHEN v_lot.status::text <> 'active' THEN 'lot_not_active'
               WHEN v_lot.expires_at <= now() THEN 'lot_expired'
               WHEN v_lot.remaining_amount <> v_lot.original_amount THEN 'lot_already_spent'
               WHEN v_lot.source_cash_order_id IS NOT NULL THEN 'lot_tied_to_an_order'
               WHEN v_lot.issued_at < v_cre.approved_at THEN 'lot_issued_before_approval'
               WHEN v_lot.original_amount <> v_cre.amount_jpy THEN 'lot_amount_differs'
               ELSE 'lot_already_allocated' END,
          'lot_amount', v_lot.original_amount, 'approved_jpy', v_cre.amount_jpy);
      END IF;
      UPDATE public.card_refund_exceptions
         SET status = 'recorded', recorded_by = p_user_id, recorded_at = now(), store_credit_lot_id = v_lot.id,
             customer_request = left(btrim(v_exc ->> 'customer_request'), 500), updated_at = now()
       WHERE id = v_cre.id
      RETURNING * INTO v_cre;
    END IF;
    v_amount := v_cre.amount_jpy;
    v_exc := jsonb_build_object('exception_id', v_cre.id, 'trigger', v_cre.trigger_kind, 'payout', v_cre.payout,
                                'square_refund_id', v_cre.square_refund_id, 'square_support_ticket', v_cre.square_support_ticket,
                                'transfer_date', v_cre.transfer_date, 'transfer_reference', v_cre.transfer_reference,
                                'store_credit_lot_id', v_cre.store_credit_lot_id, 'customer_request', v_cre.customer_request,
                                'approved_by', v_cre.approved_by, 'approved_at', v_cre.approved_at,
                                'cap_jpy', v_cap, 'card_captured_jpy', v_card_captured, 'card_refunded_jpy', v_card_refunded,
                                'credit_issued_jpy', v_credit_issued);
  END IF;
  IF v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') AND v_card_paid AND v_noncard <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_card');
  END IF;
  -- Mixed payment (card + something else): a non-card method records only the
  -- non-card money; the card part comes back through Square and is recorded by
  -- Square's own refund email / the card row. Never the gross.
  IF v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') AND v_card_paid THEN
    v_amount := v_noncard;
  END IF;
  IF v_method = 'card' THEN
    v_card_refunded := public.square_order_card_refund_recordable_jpy(p_order_id);
    IF v_card_refunded - v_marked_card <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_completed_card_refund');
    END IF;
    v_amount := v_card_refunded - v_marked_card;
  END IF;
  -- PA03 (owner 2026-10-08): Paidy money goes back only through the Paidy
  -- dashboard and counts only once the Hub has read the refund back from
  -- Paidy (paidy_refunds, written by record_paidy_refund). Method 'paidy'
  -- needs Paidy money on the order and at least one verified refund; the
  -- amount recorded is the verified total, capped at the Paidy money, and the
  -- audit carries cumulative refunded + remaining — never the gross. A
  -- non-Paidy method on a mixed order records only the non-Paidy money.
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_paidy_paid
    FROM public.cash_payments
   WHERE cash_order_id = p_order_id AND voided_at IS NULL AND payment_method = 'paidy';
  SELECT COALESCE(SUM(r.amount_jpy), 0) INTO v_paidy_refunded
    FROM public.paidy_refunds r WHERE r.cash_order_id = p_order_id;
  IF v_method = 'paidy' AND v_paidy_paid <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'not_paid_by_paidy');
  END IF;
  IF v_method = 'paidy' THEN
    IF v_paidy_refunded <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_verified_paidy_refund', 'paidy_paid_jpy', v_paidy_paid);
    END IF;
    -- QC PR-B M-1 (2026-10-10): the same rule as terminate_web_order_atomic
    -- (paidy_refund_needs_dashboard) — marked issued only once Paidy's verified
    -- refunds cover the Paidy money; a partial refund keeps refund_pending.
    IF v_paidy_refunded < v_paidy_paid THEN
      RETURN jsonb_build_object('ok', false, 'error', 'paidy_refund_incomplete',
        'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_jpy', v_paidy_refunded,
        'message', 'Paidy has refunded ¥' || to_char(v_paidy_refunded, 'FM999,999,999') || ' of ¥'
          || to_char(v_paidy_paid, 'FM999,999,999') || '. Refund the rest in the Paidy dashboard, then mark it.');
    END IF;
    v_amount := LEAST(v_paidy_paid, v_paidy_refunded);
    v_paidy_remaining := GREATEST(0, v_paidy_paid - v_paidy_refunded);
  ELSIF v_paidy_paid > 0 AND v_method NOT IN ('card', 'bank_transfer_exception', 'store_credit_exception') THEN
    IF v_amount - v_paidy_paid <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'method_mismatch', 'detail', 'paid_by_paidy');
    END IF;
    v_amount := v_amount - v_paidy_paid;
  END IF;

  UPDATE public.cash_orders
     SET refund_status = 'refund_issued',
         refund_note = CASE
           WHEN v_note IS NULL THEN refund_note
           WHEN refund_note IS NULL OR btrim(refund_note) = '' THEN v_note
           ELSE refund_note || E'\n' || v_note END
   WHERE id = p_order_id;

  IF v_method = 'card' THEN
    UPDATE public.square_refunds
       SET decision = 'order_cancelled_refunded', decided_at = now(), decided_by = p_user_id,
           decision_note = COALESCE(decision_note, 'Recorded by "Mark refund issued — card"'), updated_at = now()
     WHERE cash_order_id = p_order_id AND status = 'COMPLETED' AND decision IS NULL;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('cash_order', p_order_id, 'refund_marked_issued',
          jsonb_build_object('refund_status', v_order.refund_status),
          jsonb_build_object('refund_status', 'refund_issued', 'method', v_method, 'refunded_on', p_refunded_on,
                             'amount', v_amount, 'currency', v_order.currency::text, 'note', v_note,
                             'paidy_paid_jpy', v_paidy_paid, 'paidy_refunded_total_jpy', v_paidy_refunded,
                             'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                             'further_mark', v_further, 'card_marked_before_jpy', v_marked_card,
                             'invoice_number', v_order.invoice_number, 'web_reference', v_order.web_reference),
          p_user_id);

  RETURN jsonb_build_object('ok', true, 'amount', v_amount, 'currency', v_order.currency::text,
                            'method', v_method, 'refunded_on', p_refunded_on,
                            'paidy_refunded_total_jpy', v_paidy_refunded, 'paidy_remaining_jpy', v_paidy_remaining, 'exception', v_exc,
                            'further_mark', v_further,
                            'reference', COALESCE(v_order.web_reference, v_order.invoice_number));
END
$function$;
DO $check$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb)'))) <> 'd0ae5262522ad32279e9574da1f9b1f3' THEN
    RAISE EXCEPTION 'STOP — public.mark_web_order_refund_issued_atomic(uuid,uuid,text,date,text,jsonb) does not hash to d0ae5262522ad32279e9574da1f9b1f3 after the replace; rolled back';
  END IF;
END
$check$;

-- ---------------------------------------------------------------------------
-- 4. Record-only: cart_reminder_candidates as live runs it (comment lines dropped).
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  v_fn regprocedure := to_regprocedure('public.cart_reminder_candidates(integer)');
  v_md5 text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP — public.cart_reminder_candidates(integer) is not on live; nothing changed';
  END IF;
  v_md5 := md5(pg_get_functiondef(v_fn));
  IF v_md5 <> '61c614c74ba3f7bf98b70f568df6e8fa' AND v_md5 <> '9cd8f79f32a0e1134cb43f7521bbe211' THEN
    RAISE EXCEPTION 'STOP — public.cart_reminder_candidates(integer) has md5 %, expected 61c614c74ba3f7bf98b70f568df6e8fa or 9cd8f79f32a0e1134cb43f7521bbe211; re-read live before recording. Nothing changed.', v_md5;
  END IF;
  RAISE NOTICE 'public.cart_reminder_candidates(integer) matches (live, or the repo body with its comment lines) — the replace below writes the recorded body';
END
$guard$;

CREATE OR REPLACE FUNCTION public.cart_reminder_candidates(p_limit integer DEFAULT 50)
 RETURNS TABLE(customer_id uuid, email text, lang text, cycle_id uuid, unsubscribe_token uuid, items jsonb, quote_mode text, quote_currency text, quote_term integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_mode text := coalesce((SELECT value #>> '{}' FROM system_settings WHERE key = 'cart_reminders_mode'), 'off');
  v_raw  text := (SELECT value #>> '{}' FROM system_settings WHERE key = 'cart_reminder_idle_minutes');
  v_idle interval := make_interval(mins => greatest(5, CASE WHEN v_raw ~ '^[0-9]{1,6}$' THEN v_raw::int ELSE 1440 END));
BEGIN
  IF v_mode NOT IN ('owner_only','on') THEN RETURN; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT k.customer_id, btrim(cu.email) AS email, k.lang, k.cycle_id, k.cycle_started_at, k.updated_at, c.unsubscribe_token,
           CASE WHEN cu.location ILIKE '%philippines%' THEN 'Asia/Manila' ELSE 'Asia/Tokyo' END AS tz,
           (lower(btrim(cu.email)) = 'chajewelsjapan@gmail.com' OR lower(btrim(cu.email)) LIKE '%@chajewelsjp.com') AS owner_addr,
           cu.is_test
      FROM customer_carts k
      JOIN customers cu ON cu.id = k.customer_id
      JOIN customer_email_consents c ON c.customer_id = k.customer_id AND c.kind = 'cart_reminder' AND c.opted_in
     WHERE cu.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       AND k.updated_at <= now() - v_idle
       AND k.updated_at >= now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM suppressed_emails s WHERE lower(s.email) = lower(btrim(cu.email)))
       AND NOT EXISTS (SELECT 1 FROM cart_reminder_sends s WHERE s.cycle_id = k.cycle_id)
       AND NOT EXISTS (SELECT 1 FROM cart_reminder_sends s WHERE s.customer_id = k.customer_id AND s.claimed_at > now() - interval '7 days')
       AND NOT EXISTS (SELECT 1 FROM cash_orders o WHERE o.customer_id = k.customer_id AND o.created_at >= k.updated_at)
       AND NOT EXISTS (SELECT 1 FROM layaway_accounts a WHERE a.customer_id = k.customer_id AND a.created_at >= k.updated_at)
  ), eligible AS (
    SELECT * FROM base b
     WHERE (CASE WHEN v_mode = 'owner_only' THEN b.owner_addr ELSE (NOT b.is_test OR b.owner_addr) END)
       AND extract(hour FROM now() AT TIME ZONE b.tz) BETWEEN 9 AND 19
  )
  SELECT e.customer_id, e.email, e.lang, e.cycle_id, e.unsubscribe_token, it.items,
         q.mode, q.settlement_currency, q.term_months
    FROM eligible e
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'variant_id', v.id, 'product_id', p.id, 'slug', p.slug,
               'name', p.name, 'name_ja', nullif(btrim(p.name_ja), ''),
               'size', v.size, 'stone', v.stone,
               'qty', least(l.qty, v.stock_qty), 'price_jpy', public.website_variant_price_jpy(v),
               'image_url', (SELECT m.url FROM website_product_media m WHERE m.variant_id = v.id ORDER BY m.sort LIMIT 1)
             ) ORDER BY l.added_at) AS items
        FROM customer_cart_lines l
        JOIN website_product_variants v ON v.id = l.variant_id
        JOIN website_products p ON p.id = v.product_id
       WHERE l.customer_id = e.customer_id AND p.status = 'active' AND v.stock_qty >= 1
    ) it
    LEFT JOIN LATERAL (
      SELECT cq.mode, cq.settlement_currency, cq.term_months
        FROM checkout_quotes cq
       WHERE cq.customer_id = e.customer_id
         AND cq.created_at >= e.cycle_started_at
         AND cq.consumed_at IS NULL
       ORDER BY cq.created_at DESC
       LIMIT 1
    ) q ON true
   WHERE it.items IS NOT NULL
   ORDER BY e.updated_at
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END $function$;
DO $check$
BEGIN
  IF md5(pg_get_functiondef(to_regprocedure('public.cart_reminder_candidates(integer)'))) <> '61c614c74ba3f7bf98b70f568df6e8fa' THEN
    RAISE EXCEPTION 'STOP — public.cart_reminder_candidates(integer) does not hash to 61c614c74ba3f7bf98b70f568df6e8fa after the replace; rolled back';
  END IF;
END
$check$;

