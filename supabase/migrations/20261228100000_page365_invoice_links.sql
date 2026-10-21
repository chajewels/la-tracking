-- =============================================================================
-- Page365 void → Hub cancel / renew → Hub restore (owner decisions 2026-10-21)
-- Plan: project doc claude/page365-void-sync-plan-2026-10-21.md
--
-- WHAT THE OWNER DECIDED
--   - A Page365 invoice whose stage reads 'voided' (staff void it by hand in
--     Page365) cancels the matching LIVE Hub order. An order already closed in
--     the Hub (forfeited, final_forfeited, cancelled, completed layaway, expired
--     cash) is left as it is.
--   - A Page365 invoice that is renewed (stage leaves 'voided', e.g. 'unpaid')
--     restores the Hub order — ONLY an order this sync itself cancelled. A
--     manual Hub cancel is never restored here.
--   - Triggered by the staff "Re-read Page365" button OR the 30-minute check,
--     whichever comes first. No grace period.
--   - Restore keeps the ORIGINAL due dates; penalties / forfeiture then follow
--     the normal rules.
--   - 'expires_on' and Page365 expiry are ignored.
--
-- VERIFIED BEFORE WRITING (live, 2026-10-21)
--   - Re-reading the pasted invoice link works weeks later; field `stage`;
--     cycle voided → unpaid → voided tested on INV 19848, same slug + sig.
--   - Without ?sig= Page365 answers 401 — the sig is the only way in.
--   - Customers can SELECT their own cash_orders / layaway_accounts rows, so the
--     sig is NOT a column on the order tables: it lives in
--     page365_invoice_links, RLS on with NO policy (server only).
--   - cancel_layaway_atomic def md5 2cc9eaea9c5802eac1961b8cbd9ffd04 (= the
--     recorded body of 20261227100100); cancel_cash_order_atomic def md5
--     06fb9394e5e4d8d3f3113aa3f5937261.
--
-- WHAT THIS FILE DOES
--   1. page365_invoice_links (server-only) + page365_invoice_link_upsert.
--   2. Two one-line, md5-guarded patches so the automatic run can call the
--      EXISTING cancel writers without a staff user, like the Shopify webhook:
--        cancel_layaway_atomic   — user-identity guard skips p_source 'page365_sync'
--        cancel_cash_order_atomic — same, on its own guard line ONLY (v_is_system
--          is NOT widened: it also switches the Shopify credit split and labels).
--      issue_store_credit_atomic is NOT patched: an automatic run never cancels
--      a cash order that has received money (it would mint store credit without
--      a person) — it raises a staff bell instead, and the button cancels it with
--      the staff member's identity.
--   3. page365_apply_invoice_stage — the ONE writer: records the read, cancels
--      on 'voided' (capturing what a restore needs), restores on renewal.
--   4. page365_invoice_due_links — what the sweep reads.
--   5. page365_invoice_link_status — staff-readable status, never the sig.
--   6. pg_cron page365-invoice-check at :17 and :47 (Vault key; CRON AUTH RULE).
--
-- INVARIANT 12: an order carrying a payment submission in 'submitted' or
-- 'under_review' is never cancelled or restored here (any source) — the result
-- says 'submission_pending' and staff get a bell.
--
-- Comment lines inside function bodies are kept out deliberately (Lovable drops
-- them on apply); all explanation lives up here.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-checks — refuse the whole file if live is not what it was written for.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_md5     text;
BEGIN
  IF to_regclass('public.layaway_accounts')               IS NULL THEN v_missing := v_missing || 'layaway_accounts'::text; END IF;
  IF to_regclass('public.cash_orders')                    IS NULL THEN v_missing := v_missing || 'cash_orders'::text; END IF;
  IF to_regclass('public.layaway_schedule')               IS NULL THEN v_missing := v_missing || 'layaway_schedule'::text; END IF;
  IF to_regclass('public.sales_log')                      IS NULL THEN v_missing := v_missing || 'sales_log'::text; END IF;
  IF to_regclass('public.payment_submissions')            IS NULL THEN v_missing := v_missing || 'payment_submissions'::text; END IF;
  IF to_regclass('public.payment_submission_allocations') IS NULL THEN v_missing := v_missing || 'payment_submission_allocations'::text; END IF;
  IF to_regclass('public.store_credit_lots')              IS NULL THEN v_missing := v_missing || 'store_credit_lots'::text; END IF;
  IF to_regclass('public.staff_notifications')            IS NULL THEN v_missing := v_missing || 'staff_notifications'::text; END IF;
  IF to_regclass('public.account_notes')                  IS NULL THEN v_missing := v_missing || 'account_notes'::text; END IF;
  IF to_regclass('public.audit_logs')                     IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('cron.job')                              IS NULL THEN v_missing := v_missing || 'cron.job (pg_cron)'::text; END IF;
  IF to_regclass('vault.secrets')                         IS NULL THEN v_missing := v_missing || 'vault.secrets'::text; END IF;
  IF to_regprocedure('public.restore_loyalty_points(uuid,uuid)') IS NULL THEN v_missing := v_missing || 'restore_loyalty_points(uuid,uuid)'::text; END IF;
  IF to_regprocedure('public.assert_staff_caller(text)')         IS NULL THEN v_missing := v_missing || 'assert_staff_caller(text)'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_invoice_links: missing: %. Nothing changed.', array_to_string(v_missing, ', ');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
    RAISE EXCEPTION 'page365_invoice_links: Vault secret email_queue_service_role_key missing — the other Vault-backed crons use it; do not create a second key. Nothing changed.';
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'page365-invoice-check') THEN
    RAISE EXCEPTION 'page365_invoice_links: cron job page365-invoice-check already exists — inspect it before re-running. Nothing changed.';
  END IF;

  v_md5 := md5(pg_get_functiondef('public.cancel_layaway_atomic(uuid,text,uuid,text,boolean,text)'::regprocedure));
  IF v_md5 NOT IN ('2cc9eaea9c5802eac1961b8cbd9ffd04') AND position('page365_sync' IN pg_get_functiondef('public.cancel_layaway_atomic(uuid,text,uuid,text,boolean,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — cancel_layaway_atomic has md5 %, expected 2cc9eaea9c5802eac1961b8cbd9ffd04. Re-read live. Nothing changed.', v_md5;
  END IF;
  v_md5 := md5(pg_get_functiondef('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)'::regprocedure));
  IF v_md5 NOT IN ('06fb9394e5e4d8d3f3113aa3f5937261') AND position('page365_sync' IN pg_get_functiondef('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'STOP — cancel_cash_order_atomic has md5 %, expected 06fb9394e5e4d8d3f3113aa3f5937261. Re-read live. Nothing changed.', v_md5;
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. In-place patch helper (copied from 20261227100000, Bug #280 pattern).
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

-- 2a. cancel_layaway_atomic: the automatic Page365 run may cancel without a staff user.
SELECT pg_temp.cj_patch('public.cancel_layaway_atomic(uuid,text,uuid,text,boolean,text)', '2cc9eaea9c5802eac1961b8cbd9ffd04', jsonb_build_array(
  jsonb_build_object(
    'old', $o$IF NOT p_preview AND p_user_id IS NULL THEN$o$,
    'new', $n$IF NOT p_preview AND p_user_id IS NULL AND p_source IS DISTINCT FROM 'page365_sync' THEN$n$)
));

-- 2b. cancel_cash_order_atomic: same, on the identity guard line only (v_is_system untouched).
SELECT pg_temp.cj_patch('public.cancel_cash_order_atomic(uuid,text,uuid,text,boolean,text)', '06fb9394e5e4d8d3f3113aa3f5937261', jsonb_build_array(
  jsonb_build_object(
    'old', $o$IF NOT p_preview AND NOT v_is_system AND p_user_id IS NULL THEN$o$,
    'new', $n$IF NOT p_preview AND NOT v_is_system AND p_source IS DISTINCT FROM 'page365_sync' AND p_user_id IS NULL THEN$n$)
));

-- ---------------------------------------------------------------------------
-- 3. The link table — server only. One row per imported Page365 invoice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.page365_invoice_links (
  page365_no            bigint PRIMARY KEY,
  page365_slug          text NOT NULL,
  page365_sig           text NOT NULL,
  last_stage            text,
  last_checked_at       timestamptz,
  last_check_error      text,
  last_notified_stage   text,
  cancelled_by_page365  boolean NOT NULL DEFAULT false,
  cancelled_at          timestamptz,
  status_before_cancel  text,
  cancelled_schedule    jsonb,
  sales_log_before      jsonb,
  revoked_points_tx     uuid,
  restored_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT page365_invoice_links_slug_chk CHECK (page365_slug ~ '^[A-Za-z0-9]+$'),
  CONSTRAINT page365_invoice_links_sig_chk  CHECK (page365_sig ~ '^[A-Za-z0-9]+$')
);

ALTER TABLE public.page365_invoice_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.page365_invoice_links FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.page365_invoice_links TO service_role;

COMMENT ON TABLE public.page365_invoice_links IS
  'Page365 invoice links (slug + ?sig=) kept ONLY so page365-invoice-check can re-read the invoice stage. Server only: RLS on, no policy. The sig is never logged and never returned to any browser.';

-- ---------------------------------------------------------------------------
-- 4. page365_invoice_link_upsert — called by page365-fetch-order (import) and
--    by the staff "Add Page365 link" path. Service role only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_invoice_link_upsert(p_page365_no bigint, p_slug text, p_sig text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_page365_no IS NULL OR p_page365_no <= 0 THEN
    RAISE EXCEPTION 'page365_no_required' USING ERRCODE = 'P0001';
  END IF;
  IF COALESCE(p_slug, '') !~ '^[A-Za-z0-9]+$' OR COALESCE(p_sig, '') !~ '^[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'page365_link_invalid' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.page365_invoice_links (page365_no, page365_slug, page365_sig)
  VALUES (p_page365_no, p_slug, p_sig)
  ON CONFLICT (page365_no) DO UPDATE
     SET page365_slug = EXCLUDED.page365_slug,
         page365_sig  = EXCLUDED.page365_sig,
         updated_at   = now();
END
$function$;

REVOKE ALL ON FUNCTION public.page365_invoice_link_upsert(bigint, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_invoice_link_upsert(bigint, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. page365_apply_invoice_stage — THE writer. Service role only; the edge
--    function passes the staff user for the button and NULL for the sweep.
--    Result 'action': cancelled | restored | no_action | submission_pending |
--    needs_staff | order_not_found | link_not_found.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_apply_invoice_stage(
  p_page365_no bigint,
  p_stage      text,
  p_user_id    uuid DEFAULT NULL::uuid,
  p_user_email text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_link       public.page365_invoice_links%ROWTYPE;
  v_kind       text;
  v_id         uuid;
  v_status     text;
  v_invoice    text;
  v_customer   uuid;
  v_paid       numeric := 0;
  v_channel    text;
  v_pending    integer := 0;
  v_source     text;
  v_actor      text;
  v_reason     text := 'Voided in Page365';
  v_result     jsonb;
  v_sched      jsonb;
  v_sales      jsonb;
  v_restored_tx uuid;
  v_credit     integer := 0;
  v_now        timestamptz := now();
  v_live       boolean;
  v_bell_type  text;
  v_bell_title text;
  v_bell_body  text;
BEGIN
  IF p_stage IS NULL OR btrim(p_stage) = '' THEN
    RAISE EXCEPTION 'page365_stage_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_link FROM public.page365_invoice_links WHERE page365_no = p_page365_no FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('action', 'link_not_found', 'page365_no', p_page365_no);
  END IF;

  UPDATE public.page365_invoice_links
     SET last_stage = p_stage, last_checked_at = v_now, last_check_error = NULL, updated_at = v_now
   WHERE page365_no = p_page365_no;

  SELECT 'layaway', id, status::text, invoice_number, customer_id, COALESCE(total_paid, 0), source_channel
    INTO v_kind, v_id, v_status, v_invoice, v_customer, v_paid, v_channel
    FROM public.layaway_accounts WHERE page365_no = p_page365_no FOR UPDATE;
  IF NOT FOUND THEN
    SELECT 'cash', id, status::text, invoice_number, customer_id, COALESCE(total_paid, 0), source_channel
      INTO v_kind, v_id, v_status, v_invoice, v_customer, v_paid, v_channel
      FROM public.cash_orders WHERE page365_no = p_page365_no FOR UPDATE;
  END IF;
  IF v_id IS NULL THEN
    RETURN jsonb_build_object('action', 'order_not_found', 'page365_no', p_page365_no, 'stage', p_stage);
  END IF;
  IF COALESCE(v_channel, '') = 'web' THEN
    RETURN jsonb_build_object('action', 'no_action', 'why', 'web_order', 'page365_no', p_page365_no, 'stage', p_stage);
  END IF;

  v_source := CASE WHEN p_user_id IS NULL THEN 'page365_sync' ELSE 'staff' END;
  v_actor  := COALESCE(p_user_email, CASE WHEN p_user_id IS NULL THEN 'page365_sync' ELSE 'staff' END);

  IF v_kind = 'layaway' THEN
    SELECT count(DISTINCT s.id) INTO v_pending
      FROM public.payment_submissions s
      LEFT JOIN public.payment_submission_allocations a ON a.submission_id = s.id
     WHERE s.status::text IN ('submitted', 'under_review')
       AND (s.account_id = v_id OR a.account_id = v_id);
  ELSE
    SELECT count(*) INTO v_pending
      FROM public.payment_submissions s
     WHERE s.status::text IN ('submitted', 'under_review') AND s.cash_order_id = v_id;
  END IF;

  IF p_stage = 'voided' THEN
    v_live := CASE WHEN v_kind = 'layaway'
                   THEN v_status IN ('active', 'overdue', 'extension_active', 'reactivated', 'final_settlement')
                   ELSE v_status IN ('pending', 'completed') END;
    IF NOT v_live THEN
      RETURN jsonb_build_object('action', 'no_action', 'why', 'already_closed', 'status', v_status,
                                'kind', v_kind, 'order_id', v_id, 'invoice_number', v_invoice, 'stage', p_stage);
    END IF;

    IF v_pending > 0 THEN
      v_bell_type := 'page365_void_blocked';
      v_bell_title := 'Page365 voided — payment waiting for review';
      v_bell_body := 'Invoice ' || COALESCE(v_invoice, p_page365_no::text) || ' was voided in Page365, but a payment submission is still waiting. Confirm or reject it, then press Re-read Page365.';
      IF v_link.last_notified_stage IS DISTINCT FROM 'voided_blocked' THEN
        INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
        VALUES (v_bell_type, v_bell_title, v_bell_body,
                CASE WHEN v_kind = 'layaway' THEN v_id END, v_customer, v_invoice,
                jsonb_build_object('page365_no', p_page365_no, 'kind', v_kind, 'order_id', v_id));
        UPDATE public.page365_invoice_links SET last_notified_stage = 'voided_blocked' WHERE page365_no = p_page365_no;
      END IF;
      RETURN jsonb_build_object('action', 'submission_pending', 'pending_submissions', v_pending,
                                'kind', v_kind, 'order_id', v_id, 'invoice_number', v_invoice, 'stage', p_stage);
    END IF;

    IF v_kind = 'cash' AND p_user_id IS NULL AND v_paid > 0 THEN
      IF v_link.last_notified_stage IS DISTINCT FROM 'voided_needs_staff' THEN
        INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
        VALUES ('page365_void_needs_staff', 'Page365 voided — paid cash order needs staff',
                'Invoice ' || COALESCE(v_invoice, p_page365_no::text) || ' was voided in Page365. It has money received, so store credit applies: open the order and press Re-read Page365 to cancel it.',
                NULL, v_customer, v_invoice,
                jsonb_build_object('page365_no', p_page365_no, 'kind', v_kind, 'order_id', v_id, 'total_paid', v_paid));
        UPDATE public.page365_invoice_links SET last_notified_stage = 'voided_needs_staff' WHERE page365_no = p_page365_no;
      END IF;
      RETURN jsonb_build_object('action', 'needs_staff', 'why', 'cash_money_received',
                                'kind', v_kind, 'order_id', v_id, 'invoice_number', v_invoice, 'stage', p_stage);
    END IF;

    IF v_kind = 'layaway' THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'status', status::text)), '[]'::jsonb)
        INTO v_sched
        FROM public.layaway_schedule WHERE account_id = v_id AND status::text <> 'paid' AND status::text <> 'cancelled';
    ELSE
      v_sched := '[]'::jsonb;
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'status', status, 'eligible', eligible)), '[]'::jsonb)
      INTO v_sales
      FROM public.sales_log WHERE invoice_number = v_invoice AND status IS DISTINCT FROM 'Cancelled';

    IF v_kind = 'layaway' THEN
      v_result := public.cancel_layaway_atomic(v_id, v_reason, p_user_id, v_actor, false, v_source);
    ELSE
      v_result := public.cancel_cash_order_atomic(v_id, v_reason, p_user_id, v_actor, false, v_source);
    END IF;

    UPDATE public.page365_invoice_links
       SET cancelled_by_page365 = true,
           cancelled_at         = v_now,
           status_before_cancel = v_status,
           cancelled_schedule   = v_sched,
           sales_log_before     = v_sales,
           revoked_points_tx    = NULLIF(v_result ->> 'earned_points_revoked_tx', '')::uuid,
           restored_at          = NULL,
           last_notified_stage  = 'voided',
           updated_at           = v_now
     WHERE page365_no = p_page365_no;

    INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
    VALUES ('page365_invoice_voided', 'Cancelled — voided in Page365',
            'Invoice ' || COALESCE(v_invoice, p_page365_no::text) || ' was voided in Page365, so the Hub cancelled it' ||
            CASE WHEN p_user_id IS NULL THEN ' automatically.' ELSE '.' END,
            CASE WHEN v_kind = 'layaway' THEN v_id END, v_customer, v_invoice,
            jsonb_build_object('page365_no', p_page365_no, 'kind', v_kind, 'order_id', v_id, 'source', v_source));

    INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
    VALUES (CASE WHEN v_kind = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END, v_id,
            'page365_void_cancel', p_user_id,
            jsonb_build_object('page365_no', p_page365_no, 'invoice_number', v_invoice, 'prior_status', v_status,
                               'source', v_source, 'actor', v_actor, 'cancel_result', v_result));

    RETURN jsonb_build_object('action', 'cancelled', 'kind', v_kind, 'order_id', v_id,
                              'invoice_number', v_invoice, 'prior_status', v_status, 'stage', p_stage,
                              'source', v_source, 'cancel_result', v_result);
  END IF;

  IF NOT v_link.cancelled_by_page365 OR v_status <> 'cancelled' THEN
    IF v_link.last_notified_stage IS DISTINCT FROM p_stage AND v_link.last_notified_stage IN ('voided_blocked', 'voided_needs_staff') THEN
      UPDATE public.page365_invoice_links SET last_notified_stage = NULL WHERE page365_no = p_page365_no;
    END IF;
    RETURN jsonb_build_object('action', 'no_action', 'why', 'not_cancelled_by_page365', 'status', v_status,
                              'kind', v_kind, 'order_id', v_id, 'invoice_number', v_invoice, 'stage', p_stage);
  END IF;

  IF v_pending > 0 THEN
    RETURN jsonb_build_object('action', 'submission_pending', 'pending_submissions', v_pending,
                              'kind', v_kind, 'order_id', v_id, 'invoice_number', v_invoice, 'stage', p_stage);
  END IF;

  IF v_kind = 'cash' THEN
    SELECT count(*) INTO v_credit
      FROM public.store_credit_lots
     WHERE source_cash_order_id = v_id AND source_type = 'cancelled_cash' AND status::text <> 'voided';
    IF v_credit > 0 THEN
      IF v_link.last_notified_stage IS DISTINCT FROM 'renewed_needs_staff' THEN
        INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
        VALUES ('page365_renew_needs_staff', 'Page365 renewed — store credit was issued',
                'Invoice ' || COALESCE(v_invoice, p_page365_no::text) || ' was renewed in Page365, but store credit was issued when it was cancelled. It cannot be restored automatically — handle it by hand.',
                NULL, v_customer, v_invoice,
                jsonb_build_object('page365_no', p_page365_no, 'kind', v_kind, 'order_id', v_id));
        UPDATE public.page365_invoice_links SET last_notified_stage = 'renewed_needs_staff' WHERE page365_no = p_page365_no;
      END IF;
      RETURN jsonb_build_object('action', 'needs_staff', 'why', 'store_credit_issued',
                                'kind', v_kind, 'order_id', v_id, 'invoice_number', v_invoice, 'stage', p_stage);
    END IF;

    UPDATE public.cash_orders
       SET status               = v_link.status_before_cancel::cash_order_status,
           cancellation_reason  = NULL,
           cancelled_at         = NULL,
           cancelled_by_user_id = NULL,
           updated_at           = v_now
     WHERE id = v_id AND status::text = 'cancelled';
  ELSE
    UPDATE public.layaway_accounts
       SET status               = v_link.status_before_cancel::account_status,
           cancellation_reason  = NULL,
           cancelled_at         = NULL,
           cancelled_by_user_id = NULL,
           updated_at           = v_now
     WHERE id = v_id AND status::text = 'cancelled';

    UPDATE public.layaway_schedule ls
       SET status = (x.r ->> 'status')::schedule_status, updated_at = v_now
      FROM jsonb_array_elements(COALESCE(v_link.cancelled_schedule, '[]'::jsonb)) AS x(r)
     WHERE ls.id = (x.r ->> 'id')::uuid AND ls.account_id = v_id AND ls.status::text = 'cancelled';
  END IF;

  UPDATE public.sales_log sl
     SET status = x.r ->> 'status', eligible = (x.r ->> 'eligible')::boolean, updated_at = v_now
    FROM jsonb_array_elements(COALESCE(v_link.sales_log_before, '[]'::jsonb)) AS x(r)
   WHERE sl.id = (x.r ->> 'id')::uuid AND sl.status = 'Cancelled';

  IF v_link.revoked_points_tx IS NOT NULL THEN
    v_restored_tx := public.restore_loyalty_points(v_link.revoked_points_tx, p_user_id);
  END IF;

  UPDATE public.page365_invoice_links
     SET cancelled_by_page365 = false,
         restored_at          = v_now,
         last_notified_stage  = p_stage,
         updated_at           = v_now
   WHERE page365_no = p_page365_no;

  INSERT INTO public.account_notes (account_id, cash_order_id, note_text, created_by_user_id, created_by_name)
  VALUES (CASE WHEN v_kind = 'layaway' THEN v_id END, CASE WHEN v_kind = 'cash' THEN v_id END,
          'Restored: invoice renewed in Page365 (stage ' || p_stage || '). Status back to ' || v_link.status_before_cancel ||
          '; original due dates kept.', p_user_id, v_actor);

  INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
  VALUES ('page365_invoice_renewed', 'Restored — renewed in Page365',
          'Invoice ' || COALESCE(v_invoice, p_page365_no::text) || ' was renewed in Page365, so the Hub restored it to ' ||
          v_link.status_before_cancel || CASE WHEN p_user_id IS NULL THEN ' automatically.' ELSE '.' END,
          CASE WHEN v_kind = 'layaway' THEN v_id END, v_customer, v_invoice,
          jsonb_build_object('page365_no', p_page365_no, 'kind', v_kind, 'order_id', v_id, 'source', v_source));

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES (CASE WHEN v_kind = 'layaway' THEN 'layaway_account' ELSE 'cash_order' END, v_id,
          'page365_renew_restore', p_user_id,
          jsonb_build_object('page365_no', p_page365_no, 'invoice_number', v_invoice, 'stage', p_stage,
                             'restored_status', v_link.status_before_cancel, 'source', v_source, 'actor', v_actor,
                             'schedule_rows', jsonb_array_length(COALESCE(v_link.cancelled_schedule, '[]'::jsonb)),
                             'points_restore_tx', v_restored_tx));

  RETURN jsonb_build_object('action', 'restored', 'kind', v_kind, 'order_id', v_id,
                            'invoice_number', v_invoice, 'restored_status', v_link.status_before_cancel,
                            'stage', p_stage, 'source', v_source, 'points_restore_tx', v_restored_tx);
END
$function$;

REVOKE ALL ON FUNCTION public.page365_apply_invoice_stage(bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_apply_invoice_stage(bigint, text, uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 5b. page365_record_check_error — a read that failed (network, 401/403/404).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_record_check_error(p_page365_no bigint, p_error text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE public.page365_invoice_links
     SET last_checked_at = now(), last_check_error = left(COALESCE(p_error, 'unknown'), 300), updated_at = now()
   WHERE page365_no = p_page365_no;
$function$;

REVOKE ALL ON FUNCTION public.page365_record_check_error(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_record_check_error(bigint, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. page365_invoice_due_links — what the 30-minute sweep reads: live orders,
--    plus orders this sync cancelled (watched indefinitely for a renewal).
--    Service role only (returns the sig).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_invoice_due_links()
RETURNS TABLE(page365_no bigint, page365_slug text, page365_sig text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT l.page365_no, l.page365_slug, l.page365_sig
    FROM public.page365_invoice_links l
    LEFT JOIN public.layaway_accounts la ON la.page365_no = l.page365_no
    LEFT JOIN public.cash_orders co      ON co.page365_no = l.page365_no
   WHERE COALESCE(la.source_channel, co.source_channel, '') <> 'web'
     AND (
          la.status::text IN ('active', 'overdue', 'extension_active', 'reactivated', 'final_settlement')
       OR co.status::text IN ('pending', 'completed')
       OR (l.cancelled_by_page365 AND (la.status::text = 'cancelled' OR co.status::text = 'cancelled'))
     )
   ORDER BY l.last_checked_at NULLS FIRST, l.page365_no;
$function$;

REVOKE ALL ON FUNCTION public.page365_invoice_due_links() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_invoice_due_links() TO service_role;

-- ---------------------------------------------------------------------------
-- 7. page365_invoice_link_status — for the Hub (staff only). Never the sig.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_invoice_link_status(p_page365_no bigint)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row public.page365_invoice_links%ROWTYPE;
BEGIN
  PERFORM public.assert_staff_caller();
  SELECT * INTO v_row FROM public.page365_invoice_links WHERE page365_no = p_page365_no;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('has_link', false, 'page365_no', p_page365_no);
  END IF;
  RETURN jsonb_build_object(
    'has_link', true,
    'page365_no', v_row.page365_no,
    'last_stage', v_row.last_stage,
    'last_checked_at', v_row.last_checked_at,
    'last_check_error', v_row.last_check_error,
    'cancelled_by_page365', v_row.cancelled_by_page365,
    'cancelled_at', v_row.cancelled_at,
    'restored_at', v_row.restored_at);
END
$function$;

REVOKE ALL ON FUNCTION public.page365_invoice_link_status(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.page365_invoice_link_status(bigint) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Cron: every 30 minutes at :17 and :47 (clear of the 00:00–00:35 UTC
--    daily chain). Vault key read at fire time (CRON AUTH RULE).
-- ---------------------------------------------------------------------------
SELECT cron.schedule(
  'page365-invoice-check',
  '17,47 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/page365-invoice-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{"action":"sweep"}'::jsonb
  );
  $cron$
);

COMMIT;
