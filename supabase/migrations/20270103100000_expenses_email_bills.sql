-- Finance -> Expenses, Phase 4: emailed bills -> drafts (owner decisions 2026-10-26 04:15 JST, D1-D6 as
-- recommended; plan claude/expenses-phase4-email-bills-plan-2026-10-26.md).
--
--   * The edge function expenses-email-bills (service role; pg_cron every 30 minutes; "Check mail now")
--     reads the sales@chajewelsjp.com mailbox read-only through the Hub's Google service account
--     (domain-wide delegation + gmail.readonly), classifies each new message with the Lovable AI gateway
--     and records ONE row per Gmail message here. A bill with a confident JPY/PHP amount becomes a DRAFT
--     expense (source 'email', source_ref = Gmail message id, receipts in expense-receipts/<id>/...);
--     a bill that matches an open recurring draft (Phase 3) is attached to it instead; everything else
--     waits as needs_review (figure missing / other currency) or skipped (not a bill) for the owner to
--     rescue with "Make expense" or dismiss. Nothing is approved automatically.
--   * system_settings.expenses_email_enabled ("false" until the Google Admin permission is granted and the
--     owner turns it on) gates the function: off = it exits quietly.
--   * No new permission keys: owners with manage_expenses read the mail list, make expenses and dismiss;
--     approve_expenses may read. Table writes revoked; service-role RPCs do the recording.
--   * Retention: skipped rows older than 90 days are deleted by the function's housekeeping call - they are
--     classification notes, not money records; every row that produced an expense is kept.
--   * No comment lines inside any function body (Lovable strips them). Re-runnable.

SET lock_timeout = '15s';

INSERT INTO public.system_settings (key, value)
VALUES ('expenses_email_enabled', '"false"'::jsonb)
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value)
VALUES ('expenses_email_mailbox', '"sales@chajewelsjp.com"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- A holding category for emailed bills the reader could not place (owner D4): the draft is created here,
-- flagged "needs a category", and cannot be APPROVED until the owner moves it to a real category. Hidden
-- from the manual picker; posts to 6900 if it ever reached the ledger.
INSERT INTO public.expense_categories (group_key, name, sort_order, system_key, gl_account_code)
SELECT 'office', 'Needs a category (from email)', 900, 'uncategorised', '6900'
 WHERE NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE system_key = 'uncategorised');

CREATE OR REPLACE FUNCTION public.expenses_refuse_uncategorised_approval()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.status = 'approved' AND OLD.status = 'draft'
     AND EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = NEW.category_id AND c.system_key = 'uncategorised') THEN
    RAISE EXCEPTION 'category_required' USING ERRCODE = 'check_violation',
      HINT = 'Pick a real category for this emailed bill before approving it.';
  END IF;
  RETURN NEW;
END
$fn$;
DROP TRIGGER IF EXISTS expenses_uncategorised_guard ON public.expenses;
CREATE TRIGGER expenses_uncategorised_guard BEFORE UPDATE OF status ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.expenses_refuse_uncategorised_approval();

-- ---------------------------------------------------------------------------
-- 1. One row per Gmail message the Hub looked at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expense_email_messages (
  gmail_message_id    text PRIMARY KEY CHECK (length(gmail_message_id) BETWEEN 1 AND 64),
  thread_id           text NULL,
  mailbox             text NOT NULL,
  from_email          text NULL,
  from_name           text NULL,
  subject             text NULL,
  received_at         timestamptz NULL,
  status              text NOT NULL CHECK (status IN ('drafted', 'matched', 'needs_review', 'skipped', 'dismissed', 'error')),
  confidence          numeric(4,3) NULL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  extracted           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extracted) = 'object'),
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  expense_id          uuid NULL REFERENCES public.expenses(id),
  matched_expense_id  uuid NULL REFERENCES public.expenses(id),
  error               text NULL,
  reviewed_by         uuid NULL,
  reviewed_at         timestamptz NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expense_email_messages_status_idx ON public.expense_email_messages (status, received_at DESC);
ALTER TABLE public.expense_email_messages ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expense_email_messages IS
  'Phase 4: every Gmail message the expenses-email-bills function classified. drafted = a draft expense was created (expense_id); matched = attached to an open recurring draft (matched_expense_id); needs_review = looks like a bill but a figure is missing; skipped = not a bill (kept 90 days); dismissed = owner closed it; error = the function failed on it.';

DROP POLICY IF EXISTS expense_email_messages_read ON public.expense_email_messages;
CREATE POLICY expense_email_messages_read ON public.expense_email_messages
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'manage_expenses'))
      OR (SELECT public.has_permission((SELECT auth.uid()), 'approve_expenses')));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expense_email_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.expense_email_messages FROM anon;
GRANT SELECT ON public.expense_email_messages TO authenticated;
GRANT ALL ON public.expense_email_messages TO service_role;

CREATE TABLE IF NOT EXISTS public.expense_email_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz NULL,
  trigger       text NOT NULL CHECK (trigger IN ('cron', 'manual')),
  run_by        uuid NULL,
  looked_at     integer NOT NULL DEFAULT 0,
  drafted       integer NOT NULL DEFAULT 0,
  matched       integer NOT NULL DEFAULT 0,
  needs_review  integer NOT NULL DEFAULT 0,
  skipped       integer NOT NULL DEFAULT 0,
  errors        integer NOT NULL DEFAULT 0,
  note          text NULL
);
ALTER TABLE public.expense_email_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_email_runs_read ON public.expense_email_runs;
CREATE POLICY expense_email_runs_read ON public.expense_email_runs
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'manage_expenses'))
      OR (SELECT public.has_permission((SELECT auth.uid()), 'approve_expenses')));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expense_email_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.expense_email_runs FROM anon;
GRANT SELECT ON public.expense_email_runs TO authenticated;
GRANT ALL ON public.expense_email_runs TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Shared draft maker (internal): a DRAFT expense from extracted figures.
--    Used by the function (service role) and by "Make expense" (owner).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expenses_email_build_draft(p jsonb, p_message_id text, p_uid uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_id uuid := coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid());
  v_date date;
  v_cat uuid;
  v_vendor uuid;
  v_vname text := nullif(btrim(coalesce(p->>'vendor_name', '')), '');
  v_desc text := left(btrim(coalesce(p->>'description', '')), 500);
  v_cur text := upper(btrim(coalesce(p->>'currency', '')));
  v_amount numeric;
  v_method text := coalesce(nullif(btrim(p->>'payment_method'), ''), 'other');
  v_paid_from text := nullif(btrim(coalesce(p->>'paid_from', '')), '');
  v_receipt text := nullif(btrim(coalesce(p->>'receipt_path', '')), '');
  v_rate numeric := (SELECT (value #>> '{}')::numeric FROM public.system_settings WHERE key = 'php_jpy_rate');
  v_vrow public.expense_vendors;
  v_new public.expenses;
BEGIN
  IF v_rate IS NULL OR v_rate <= 0 THEN RETURN jsonb_build_object('error', 'rate_not_set'); END IF;
  IF EXISTS (SELECT 1 FROM public.expenses e WHERE e.source = 'email' AND e.source_ref = p_message_id AND e.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'already_generated');
  END IF;
  BEGIN
    v_date := nullif(p->>'expense_date', '')::date;
    v_cat := nullif(p->>'category_id', '')::uuid;
    v_vendor := nullif(p->>'vendor_id', '')::uuid;
    v_amount := nullif(btrim(coalesce(p->>'amount', '')), '')::numeric;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
    RETURN jsonb_build_object('error', 'invalid_input');
  END;
  IF v_date IS NULL OR v_date < DATE '2020-01-01' OR v_date > (now() AT TIME ZONE 'Asia/Tokyo')::date + 31 THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  IF v_cat IS NULL THEN
    SELECT id INTO v_cat FROM public.expense_categories c WHERE c.system_key = 'uncategorised' AND c.active LIMIT 1;
  END IF;
  IF v_cat IS NULL OR NOT EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = v_cat AND c.active) THEN
    RETURN jsonb_build_object('error', 'invalid_category');
  END IF;
  IF EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = v_cat AND c.system_key IN ('payroll', 'commission')) THEN
    RETURN jsonb_build_object('error', 'category_booked_automatically');
  END IF;
  IF length(v_desc) < 1 THEN RETURN jsonb_build_object('error', 'invalid_description'); END IF;
  IF v_cur NOT IN ('JPY', 'PHP') THEN RETURN jsonb_build_object('error', 'invalid_currency'); END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > 10000000000 OR v_amount <> round(v_amount, 2)
     OR (v_cur = 'JPY' AND v_amount <> round(v_amount)) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF v_method NOT IN ('bank_transfer', 'card', 'cash', 'auto_debit', 'other') THEN RETURN jsonb_build_object('error', 'invalid_payment_method'); END IF;
  IF v_paid_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = v_paid_from AND a.active AND a.kind = 'asset' AND a.code < '1200') THEN
    RETURN jsonb_build_object('error', 'invalid_account');
  END IF;
  IF v_receipt IS NOT NULL AND (v_receipt NOT LIKE v_id::text || '/%' OR v_receipt LIKE '%..%') THEN
    RETURN jsonb_build_object('error', 'invalid_receipt_path');
  END IF;
  IF v_vendor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.expense_vendors v WHERE v.id = v_vendor AND v.active) THEN v_vendor := NULL; END IF;
  IF v_vendor IS NULL AND v_vname IS NOT NULL AND length(v_vname) <= 120 THEN
    SELECT * INTO v_vrow FROM public.expense_vendors v WHERE lower(btrim(v.name)) = lower(v_vname);
    IF FOUND THEN
      IF v_vrow.active THEN v_vendor := v_vrow.id; END IF;
    ELSE
      BEGIN
        INSERT INTO public.expense_vendors (name, default_category_id, created_by) VALUES (v_vname, v_cat, p_uid) RETURNING * INTO v_vrow;
        INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
        VALUES ('expense_vendor', v_vrow.id, 'create_expense_vendor', to_jsonb(v_vrow), p_uid, now());
        v_vendor := v_vrow.id;
      EXCEPTION WHEN unique_violation THEN
        SELECT * INTO v_vrow FROM public.expense_vendors v WHERE lower(btrim(v.name)) = lower(v_vname);
        IF FOUND AND v_vrow.active THEN v_vendor := v_vrow.id; END IF;
      END;
    END IF;
  END IF;
  INSERT INTO public.expenses (id, expense_date, category_id, vendor_id, description, currency, amount, amount_jpy, payment_method,
                               paid_from, receipt_path, notes, status, source, source_ref, details, created_by)
  VALUES (v_id, v_date, v_cat, v_vendor, v_desc, v_cur, v_amount, 0, v_method, v_paid_from, v_receipt,
          nullif(left(btrim(coalesce(p->>'notes', '')), 2000), ''), 'draft', 'email', p_message_id,
          jsonb_build_object('kind', 'email_bill', 'gmail_message_id', p_message_id)
            || CASE WHEN jsonb_typeof(p->'details') = 'object' THEN p->'details' ELSE '{}'::jsonb END, p_uid)
  RETURNING * INTO v_new;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', v_id, p_action, to_jsonb(v_new), p_uid, now());
  RETURN jsonb_build_object('ok', true, 'expense', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_email_build_draft(jsonb, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Service-role RPCs (the edge function).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expenses_email_record(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_id text := btrim(coalesce(p->>'gmail_message_id', ''));
  v_status text := p->>'status';
  v_old public.expense_email_messages;
  v_received timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_id) NOT BETWEEN 1 AND 64 THEN RETURN jsonb_build_object('error', 'invalid_input'); END IF;
  IF v_status NOT IN ('drafted', 'matched', 'needs_review', 'skipped', 'error') THEN RETURN jsonb_build_object('error', 'invalid_status'); END IF;
  BEGIN
    v_received := nullif(p->>'received_at', '')::timestamptz;
  EXCEPTION WHEN OTHERS THEN
    v_received := NULL;
  END;
  SELECT * INTO v_old FROM public.expense_email_messages WHERE gmail_message_id = v_id FOR UPDATE;
  IF v_old.gmail_message_id IS NOT NULL AND v_old.status IN ('drafted', 'matched', 'dismissed') THEN
    RETURN jsonb_build_object('ok', true, 'unchanged', true, 'status', v_old.status);
  END IF;
  INSERT INTO public.expense_email_messages (gmail_message_id, thread_id, mailbox, from_email, from_name, subject, received_at, status,
                                             confidence, extracted, attachments, expense_id, matched_expense_id, error)
  VALUES (v_id, left(p->>'thread_id', 64), left(coalesce(p->>'mailbox', ''), 200), left(p->>'from_email', 320), left(p->>'from_name', 200),
          left(p->>'subject', 500), v_received, v_status,
          CASE WHEN (p->>'confidence') ~ '^[0-9.]+$' THEN least((p->>'confidence')::numeric, 1) ELSE NULL END,
          CASE WHEN jsonb_typeof(p->'extracted') = 'object' THEN p->'extracted' ELSE '{}'::jsonb END,
          CASE WHEN jsonb_typeof(p->'attachments') = 'array' THEN p->'attachments' ELSE '[]'::jsonb END,
          nullif(p->>'expense_id', '')::uuid, nullif(p->>'matched_expense_id', '')::uuid, left(p->>'error', 1000))
  ON CONFLICT (gmail_message_id) DO UPDATE
     SET status = EXCLUDED.status, confidence = EXCLUDED.confidence, extracted = EXCLUDED.extracted, attachments = EXCLUDED.attachments,
         expense_id = coalesce(EXCLUDED.expense_id, public.expense_email_messages.expense_id),
         matched_expense_id = coalesce(EXCLUDED.matched_expense_id, public.expense_email_messages.matched_expense_id),
         error = EXCLUDED.error, updated_at = now();
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_email_record(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_email_record(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.expenses_create_email_draft(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_msg text := btrim(coalesce(p->>'gmail_message_id', ''));
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_msg) NOT BETWEEN 1 AND 64 THEN RETURN jsonb_build_object('error', 'invalid_input'); END IF;
  RETURN public.expenses_email_build_draft(p, v_msg, NULL, 'generate_email_draft');
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_create_email_draft(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_create_email_draft(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.expenses_email_match_recurring(p_vendor text, p_category_id uuid, p_amount numeric, p_currency text, p_date date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_row record;
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_currency NOT IN ('JPY', 'PHP') OR p_date IS NULL THEN RETURN jsonb_build_object('match', NULL); END IF;
  SELECT e.id, e.description, e.amount, e.expense_date, e.receipt_path INTO v_row
    FROM public.expenses e
    LEFT JOIN public.expense_vendors v ON v.id = e.vendor_id
   WHERE e.source = 'recurring' AND e.status = 'draft' AND e.currency = p_currency
     AND e.expense_date BETWEEN p_date - 7 AND p_date + 7
     AND abs(e.amount - p_amount) <= greatest(round(p_amount * 0.01, 2), CASE WHEN p_currency = 'JPY' THEN 1 ELSE 0.01 END)
     AND ((p_category_id IS NOT NULL AND e.category_id = p_category_id)
          OR (p_vendor IS NOT NULL AND v.name IS NOT NULL AND (lower(v.name) = lower(btrim(p_vendor)) OR position(lower(v.name) IN lower(p_vendor)) > 0 OR position(lower(btrim(p_vendor)) IN lower(v.name)) > 0))
          OR (p_vendor IS NOT NULL AND position(lower(btrim(p_vendor)) IN lower(e.description)) > 0)
          OR (p_vendor IS NOT NULL AND position(lower(btrim(p_vendor)) IN lower(coalesce(e.details->>'bill_name', ''))) > 0))
   ORDER BY abs(e.expense_date - p_date), abs(e.amount - p_amount)
   LIMIT 1;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('match', NULL); END IF;
  RETURN jsonb_build_object('match', jsonb_build_object('id', v_row.id, 'description', v_row.description, 'amount', v_row.amount,
                                                        'expense_date', v_row.expense_date, 'has_receipt', v_row.receipt_path IS NOT NULL));
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_email_match_recurring(text, uuid, numeric, text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_email_match_recurring(text, uuid, numeric, text, date) TO service_role;

CREATE OR REPLACE FUNCTION public.expenses_email_attach_to_draft(p_expense_id uuid, p_receipt_path text, p_amount numeric, p_email jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_old public.expenses;
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT * INTO v_old FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF v_old.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status <> 'draft' OR v_old.source <> 'recurring' THEN RETURN jsonb_build_object('error', 'not_draft'); END IF;
  IF p_receipt_path IS NOT NULL AND (p_receipt_path NOT LIKE p_expense_id::text || '/%' OR p_receipt_path LIKE '%..%') THEN
    RETURN jsonb_build_object('error', 'invalid_receipt_path');
  END IF;
  UPDATE public.expenses
     SET receipt_path = coalesce(p_receipt_path, receipt_path),
         amount = CASE WHEN p_amount IS NOT NULL AND p_amount > 0 THEN p_amount ELSE amount END,
         details = coalesce(details, '{}'::jsonb) || jsonb_build_object('email', coalesce(p_email, '{}'::jsonb))
   WHERE id = p_expense_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', p_expense_id, 'attach_email_bill', to_jsonb(v_old), (SELECT to_jsonb(e) FROM public.expenses e WHERE e.id = p_expense_id), NULL, now());
  RETURN jsonb_build_object('ok', true, 'expense', (SELECT to_jsonb(e) FROM public.expenses e WHERE e.id = p_expense_id));
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_email_attach_to_draft(uuid, text, numeric, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_email_attach_to_draft(uuid, text, numeric, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.expenses_email_run(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_id uuid;
  v_deleted integer := 0;
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p->>'phase' = 'start' THEN
    INSERT INTO public.expense_email_runs (trigger, run_by)
    VALUES (CASE WHEN p->>'trigger' = 'manual' THEN 'manual' ELSE 'cron' END, nullif(p->>'run_by', '')::uuid)
    RETURNING id INTO v_id;
    RETURN jsonb_build_object('ok', true, 'run_id', v_id);
  END IF;
  UPDATE public.expense_email_runs
     SET finished_at = now(), looked_at = coalesce((p->>'looked_at')::int, 0), drafted = coalesce((p->>'drafted')::int, 0),
         matched = coalesce((p->>'matched')::int, 0), needs_review = coalesce((p->>'needs_review')::int, 0),
         skipped = coalesce((p->>'skipped')::int, 0), errors = coalesce((p->>'errors')::int, 0), note = left(p->>'note', 2000)
   WHERE id = nullif(p->>'run_id', '')::uuid;
  DELETE FROM public.expense_email_messages WHERE status = 'skipped' AND created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'housekept', v_deleted);
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_email_run(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_email_run(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.expenses_email_context()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.uid() IS NOT NULL THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  RETURN jsonb_build_object(
    'enabled', coalesce((SELECT (value #>> '{}') FROM public.system_settings WHERE key = 'expenses_email_enabled'), 'false') = 'true',
    'mailbox', coalesce((SELECT (value #>> '{}') FROM public.system_settings WHERE key = 'expenses_email_mailbox'), 'sales@chajewelsjp.com'),
    'rate_set', (SELECT (value #>> '{}')::numeric FROM public.system_settings WHERE key = 'php_jpy_rate') IS NOT NULL,
    'known_ids', coalesce((SELECT jsonb_agg(m.gmail_message_id) FROM public.expense_email_messages m WHERE m.created_at > now() - interval '14 days'), '[]'::jsonb),
    'categories', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'group_key', c.group_key) ORDER BY c.group_key, c.sort_order)
                              FROM public.expense_categories c WHERE c.active AND (c.system_key IS NULL OR c.system_key NOT IN ('payroll', 'commission', 'uncategorised'))), '[]'::jsonb),
    'vendors', coalesce((SELECT jsonb_agg(v.name ORDER BY lower(v.name)) FROM public.expense_vendors v WHERE v.active), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_email_context() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_email_context() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Owner RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_email_bills(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 180);
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_permission(v_uid, 'manage_expenses') OR public.has_permission(v_uid, 'approve_expenses')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  RETURN jsonb_build_object(
    'enabled', coalesce((SELECT (value #>> '{}') FROM public.system_settings WHERE key = 'expenses_email_enabled'), 'false') = 'true',
    'mailbox', coalesce((SELECT (value #>> '{}') FROM public.system_settings WHERE key = 'expenses_email_mailbox'), 'sales@chajewelsjp.com'),
    'can_manage', public.has_permission(v_uid, 'manage_expenses'),
    'last_run', (SELECT to_jsonb(r) FROM public.expense_email_runs r ORDER BY r.started_at DESC LIMIT 1),
    'messages', coalesce((
      SELECT jsonb_agg(to_jsonb(m) || jsonb_build_object(
               'expense_status', e.status, 'expense_date', e.expense_date, 'matched_description', me.description)
             ORDER BY m.received_at DESC NULLS LAST, m.created_at DESC)
        FROM public.expense_email_messages m
        LEFT JOIN public.expenses e ON e.id = m.expense_id
        LEFT JOIN public.expenses me ON me.id = m.matched_expense_id
       WHERE m.created_at > now() - (v_days || ' days')::interval), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_email_bills(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_email_bills(integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.email_bill_make_expense(p_message_id text, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_msg public.expense_email_messages;
  r jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT * INTO v_msg FROM public.expense_email_messages WHERE gmail_message_id = p_message_id FOR UPDATE;
  IF v_msg.gmail_message_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_msg.status IN ('drafted', 'matched') THEN RETURN jsonb_build_object('error', 'already_generated'); END IF;
  r := public.expenses_email_build_draft(
         (p - 'receipt_path' - 'id') || jsonb_build_object('details', jsonb_build_object('from', v_msg.from_email, 'subject', v_msg.subject, 'received_at', v_msg.received_at, 'made_by_hand', true)),
         p_message_id, v_uid, 'make_expense_from_email');
  IF r->>'ok' IS DISTINCT FROM 'true' THEN RETURN r; END IF;
  UPDATE public.expense_email_messages
     SET status = 'drafted', expense_id = (r->'expense'->>'id')::uuid, reviewed_by = v_uid, reviewed_at = now(), updated_at = now()
   WHERE gmail_message_id = p_message_id;
  RETURN r || jsonb_build_object('attachments', v_msg.attachments);
END
$fn$;
REVOKE ALL ON FUNCTION public.email_bill_make_expense(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.email_bill_make_expense(text, jsonb) TO authenticated;
COMMENT ON FUNCTION public.email_bill_make_expense(text, jsonb) IS
  'Finance -> Expenses -> Emails "Make expense": a draft from a skipped / needs_review / error email with the owner''s figures (manage_expenses). The email''s attachments are copied onto the new draft by the client through copy_email_attachment.';

CREATE OR REPLACE FUNCTION public.email_bill_dismiss(p_message_id text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_msg public.expense_email_messages;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT * INTO v_msg FROM public.expense_email_messages WHERE gmail_message_id = p_message_id FOR UPDATE;
  IF v_msg.gmail_message_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_msg.status IN ('drafted', 'matched') THEN RETURN jsonb_build_object('error', 'already_generated'); END IF;
  UPDATE public.expense_email_messages SET status = 'dismissed', reviewed_by = v_uid, reviewed_at = now(), updated_at = now()
   WHERE gmail_message_id = p_message_id;
  RETURN jsonb_build_object('ok', true);
END
$fn$;
REVOKE ALL ON FUNCTION public.email_bill_dismiss(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.email_bill_dismiss(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_email_bills_enabled(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'admin_settings') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  INSERT INTO public.system_settings (key, value) VALUES ('expenses_email_enabled', to_jsonb(CASE WHEN p_enabled THEN 'true' ELSE 'false' END))
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense_setting', gen_random_uuid(), 'set_email_bills_enabled', jsonb_build_object('enabled', p_enabled), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'enabled', p_enabled);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_email_bills_enabled(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_email_bills_enabled(boolean) TO authenticated;

-- "Make expense" copies the email's stored attachment onto the new draft's folder (storage, client side).
-- The storage INSERT policy from Phase 1 already allows manage_expenses to upload into an existing draft's
-- folder; the email attachments themselves are stored by the function (service role) under
-- expense-receipts/email/<gmail message id>/<file>, readable with manage or approve via the Phase 1 read policy.

-- ---------------------------------------------------------------------------
-- 5. Schedule: every 30 minutes, the edge function. Needs the Vault bearer the
--    other jobs use; skipped where pg_cron / vault is absent (local harness).
-- ---------------------------------------------------------------------------
DO $c$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') AND EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'vault') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expenses-email-bills') THEN
      PERFORM cron.unschedule('expenses-email-bills');
    END IF;
    PERFORM cron.schedule('expenses-email-bills', '7,37 * * * *', $job$
      SELECT net.http_post(
        url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/expenses-email-bills',
        headers := jsonb_build_object('Content-Type', 'application/json',
                                      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')),
        body := '{"trigger":"cron"}'::jsonb);
    $job$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'expenses-email-bills cron schedule skipped: %', SQLERRM;
END
$c$;
