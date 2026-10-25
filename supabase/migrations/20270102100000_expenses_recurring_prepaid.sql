-- Finance -> Expenses, Phase 3: recurring bills + prepaid amortisation (owner decisions 2026-10-25
-- 23:09 JST, D1-D6 as recommended; plan claude/expenses-phase3-recurring-plan-2026-10-25.md).
--
--   * A recurring bill is a TEMPLATE (expense_recurring_bills): category, vendor, expected amount,
--     currency, how it is paid and from which account, frequency monthly | quarterly | yearly with a
--     due day, start / end, optional "spread over N months" (prepaid), active flag. Never deleted.
--   * Each cycle the Hub creates ONE DRAFT expense (source 'recurring', source_ref '<bill id>:<due date>')
--     on the due day for the owner to confirm: edit the real amount / attach the receipt, then Approve
--     (the Phase 1 flow; Approve = paid). The Phase 1 partial unique index keeps one draft per cycle
--     and lets a voided draft be regenerated. Only the CURRENT due cycle is generated - never a
--     backlog (D5); generate_recurring_now(p_bill_id, p_for) makes a one-off draft for a chosen date.
--   * Nightly pg_cron 'expenses-recurring' at 15:20 UTC (00:20 JST), and "Generate now" from the tab.
--   * Prepaid: expenses.prepaid_months (column + ledger events live in the Phase 2b migration, which is
--     unapplied like this one): an approved prepaid expense posts Dr 1400 Prepaid expenses and the
--     ledger releases 1/N to the category account at each month end. set_expense_prepaid sets it on a
--     draft by hand; a bill copies its spread_months onto every draft it creates. Locked once approved.
--   * No new permission keys: templates and generation need manage_expenses; approving stays
--     approve_expenses. No staff bell (D6) - the Expenses tab shows "Bills to confirm".
--   * Table writes revoked from PUBLIC/anon/authenticated; every write is an audited RPC. No comment
--     lines inside any function body (Lovable strips them). Re-runnable.

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Bill templates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expense_recurring_bills (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  category_id        uuid NOT NULL REFERENCES public.expense_categories(id),
  vendor_id          uuid NULL REFERENCES public.expense_vendors(id),
  description        text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 500),
  currency           text NOT NULL CHECK (currency IN ('JPY', 'PHP')),
  amount             numeric(14,2) NOT NULL CHECK (amount > 0 AND amount <= 10000000000),
  payment_method     text NOT NULL DEFAULT 'bank_transfer'
                     CHECK (payment_method IN ('bank_transfer', 'card', 'cash', 'auto_debit', 'other')),
  paid_from          text NULL REFERENCES public.gl_accounts(code),
  frequency          text NOT NULL CHECK (frequency IN ('monthly', 'quarterly', 'yearly')),
  due_day            smallint NOT NULL CHECK (due_day BETWEEN 1 AND 28),
  starts_on          date NOT NULL,
  ends_on            date NULL CHECK (ends_on IS NULL OR ends_on >= starts_on),
  spread_months      smallint NULL CHECK (spread_months IS NULL OR spread_months BETWEEN 2 AND 36),
  active             boolean NOT NULL DEFAULT true,
  notes              text NULL CHECK (notes IS NULL OR length(notes) <= 2000),
  next_due_on        date NOT NULL,
  last_generated_on  date NULL,
  created_by         uuid NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS expense_recurring_bills_due_idx ON public.expense_recurring_bills (active, next_due_on);
ALTER TABLE public.expense_recurring_bills ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.expense_recurring_bills IS
  'Recurring bill templates (Finance -> Expenses, Phase 3). Each due cycle expenses_generate_recurring creates one DRAFT expense (source recurring, source_ref <id>:<due date>) for the owner to confirm and approve. spread_months copies onto the draft as prepaid_months. Never deleted - deactivated.';

DROP POLICY IF EXISTS expense_recurring_bills_read ON public.expense_recurring_bills;
CREATE POLICY expense_recurring_bills_read ON public.expense_recurring_bills
  FOR SELECT TO authenticated
  USING ((SELECT public.has_permission((SELECT auth.uid()), 'manage_expenses'))
      OR (SELECT public.has_permission((SELECT auth.uid()), 'approve_expenses')));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.expense_recurring_bills FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.expense_recurring_bills FROM anon;
GRANT SELECT ON public.expense_recurring_bills TO authenticated;
GRANT ALL ON public.expense_recurring_bills TO service_role;

CREATE OR REPLACE FUNCTION public.expense_recurring_bills_refuse_delete()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'recurring bills are never deleted; deactivate the bill instead' USING ERRCODE = 'check_violation';
END
$fn$;
DROP TRIGGER IF EXISTS expense_recurring_bills_no_delete ON public.expense_recurring_bills;
CREATE TRIGGER expense_recurring_bills_no_delete BEFORE DELETE ON public.expense_recurring_bills
  FOR EACH ROW EXECUTE FUNCTION public.expense_recurring_bills_refuse_delete();
DROP TRIGGER IF EXISTS expense_recurring_bills_no_truncate ON public.expense_recurring_bills;
CREATE TRIGGER expense_recurring_bills_no_truncate BEFORE TRUNCATE ON public.expense_recurring_bills
  FOR EACH STATEMENT EXECUTE FUNCTION public.expense_recurring_bills_refuse_delete();

-- ---------------------------------------------------------------------------
-- 2. Due-date math. The due day is clamped to 1..28 so every month has it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recurring_first_due(p_starts_on date, p_due_day smallint)
RETURNS date
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT CASE WHEN extract(day FROM p_starts_on)::int <= p_due_day
              THEN (date_trunc('month', p_starts_on) + ((p_due_day - 1) || ' days')::interval)::date
              ELSE (date_trunc('month', p_starts_on) + interval '1 month' + ((p_due_day - 1) || ' days')::interval)::date END
$fn$;

CREATE OR REPLACE FUNCTION public.recurring_next_due(p_due date, p_frequency text)
RETURNS date
LANGUAGE sql IMMUTABLE
AS $fn$
  SELECT (p_due + CASE p_frequency WHEN 'monthly' THEN interval '1 month'
                                   WHEN 'quarterly' THEN interval '3 months'
                                   ELSE interval '1 year' END)::date
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Template RPCs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_recurring_bills()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_permission(v_uid, 'manage_expenses') OR public.has_permission(v_uid, 'approve_expenses')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  RETURN jsonb_build_object(
    'today', (now() AT TIME ZONE 'Asia/Tokyo')::date,
    'bills', coalesce((
      SELECT jsonb_agg(to_jsonb(b) || jsonb_build_object('category_name', c.name, 'group_key', c.group_key, 'vendor_name', v.name,
               'open_draft_id', (SELECT e.id FROM public.expenses e WHERE e.source = 'recurring' AND e.status = 'draft'
                                   AND e.source_ref LIKE b.id::text || ':%' ORDER BY e.expense_date DESC LIMIT 1))
             ORDER BY b.active DESC, b.next_due_on, lower(b.name))
        FROM public.expense_recurring_bills b
        JOIN public.expense_categories c ON c.id = b.category_id
        LEFT JOIN public.expense_vendors v ON v.id = b.vendor_id), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_recurring_bills() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_recurring_bills() TO authenticated;

CREATE OR REPLACE FUNCTION public.upsert_recurring_bill(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  v_name text := btrim(coalesce(p->>'name', ''));
  v_cat uuid;
  v_vendor uuid;
  v_desc text := btrim(coalesce(p->>'description', ''));
  v_cur text := upper(btrim(coalesce(p->>'currency', '')));
  v_amount numeric;
  v_method text := btrim(coalesce(p->>'payment_method', 'bank_transfer'));
  v_paid_from text := nullif(btrim(coalesce(p->>'paid_from', '')), '');
  v_freq text := btrim(coalesce(p->>'frequency', ''));
  v_due_day smallint;
  v_starts date;
  v_ends date;
  v_spread smallint;
  v_notes text := nullif(btrim(coalesce(p->>'notes', '')), '');
  v_old public.expense_recurring_bills;
  v_new public.expense_recurring_bills;
  v_next date;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  BEGIN
    v_id := nullif(p->>'id', '')::uuid;
    v_cat := nullif(p->>'category_id', '')::uuid;
    v_vendor := nullif(p->>'vendor_id', '')::uuid;
    v_amount := nullif(btrim(coalesce(p->>'amount', '')), '')::numeric;
    v_due_day := nullif(p->>'due_day', '')::smallint;
    v_starts := nullif(p->>'starts_on', '')::date;
    v_ends := nullif(p->>'ends_on', '')::date;
    v_spread := nullif(p->>'spread_months', '')::smallint;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
    RETURN jsonb_build_object('error', 'invalid_input');
  END;
  IF length(v_name) NOT BETWEEN 1 AND 120 THEN RETURN jsonb_build_object('error', 'invalid_name'); END IF;
  IF v_cat IS NULL OR NOT EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = v_cat AND c.active) THEN
    RETURN jsonb_build_object('error', 'invalid_category');
  END IF;
  IF EXISTS (SELECT 1 FROM public.expense_categories c WHERE c.id = v_cat AND c.system_key IN ('payroll', 'commission')) THEN
    RETURN jsonb_build_object('error', 'category_booked_automatically');
  END IF;
  IF v_vendor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.expense_vendors v WHERE v.id = v_vendor AND v.active) THEN
    RETURN jsonb_build_object('error', 'invalid_vendor');
  END IF;
  IF length(v_desc) < 1 OR length(v_desc) > 500 THEN RETURN jsonb_build_object('error', 'invalid_description'); END IF;
  IF v_cur NOT IN ('JPY', 'PHP') THEN RETURN jsonb_build_object('error', 'invalid_currency'); END IF;
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > 10000000000 OR v_amount <> round(v_amount, 2)
     OR (v_cur = 'JPY' AND v_amount <> round(v_amount)) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF v_method NOT IN ('bank_transfer', 'card', 'cash', 'auto_debit', 'other') THEN RETURN jsonb_build_object('error', 'invalid_payment_method'); END IF;
  IF v_paid_from IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.gl_accounts a WHERE a.code = v_paid_from AND a.active AND a.kind = 'asset' AND a.code < '1200') THEN
    RETURN jsonb_build_object('error', 'invalid_account');
  END IF;
  IF v_freq NOT IN ('monthly', 'quarterly', 'yearly') THEN RETURN jsonb_build_object('error', 'invalid_frequency'); END IF;
  IF v_due_day IS NULL OR v_due_day NOT BETWEEN 1 AND 28 THEN RETURN jsonb_build_object('error', 'invalid_due_day'); END IF;
  IF v_starts IS NULL OR v_starts < DATE '2020-01-01' OR v_starts > (now() AT TIME ZONE 'Asia/Tokyo')::date + 366 THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  IF v_ends IS NOT NULL AND v_ends < v_starts THEN RETURN jsonb_build_object('error', 'invalid_date'); END IF;
  IF v_spread IS NOT NULL AND v_spread NOT BETWEEN 2 AND 36 THEN RETURN jsonb_build_object('error', 'invalid_spread'); END IF;
  IF v_notes IS NOT NULL AND length(v_notes) > 2000 THEN RETURN jsonb_build_object('error', 'invalid_notes'); END IF;

  IF v_id IS NOT NULL THEN
    SELECT * INTO v_old FROM public.expense_recurring_bills WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  END IF;
  v_next := public.recurring_first_due(v_starts, v_due_day);
  IF v_old.id IS NOT NULL AND v_old.starts_on = v_starts AND v_old.due_day = v_due_day AND v_old.frequency = v_freq THEN
    v_next := v_old.next_due_on;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.expense_recurring_bills (name, category_id, vendor_id, description, currency, amount, payment_method, paid_from,
                                                frequency, due_day, starts_on, ends_on, spread_months, notes, next_due_on, created_by)
    VALUES (v_name, v_cat, v_vendor, v_desc, v_cur, v_amount, v_method, v_paid_from, v_freq, v_due_day, v_starts, v_ends, v_spread, v_notes, v_next, v_uid)
    RETURNING * INTO v_new;
  ELSE
    UPDATE public.expense_recurring_bills
       SET name = v_name, category_id = v_cat, vendor_id = v_vendor, description = v_desc, currency = v_cur, amount = v_amount,
           payment_method = v_method, paid_from = v_paid_from, frequency = v_freq, due_day = v_due_day, starts_on = v_starts,
           ends_on = v_ends, spread_months = v_spread, notes = v_notes, next_due_on = v_next, updated_at = now()
     WHERE id = v_id
    RETURNING * INTO v_new;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense_recurring_bill', v_new.id, 'upsert_recurring_bill',
          CASE WHEN v_old.id IS NULL THEN NULL ELSE to_jsonb(v_old) END, to_jsonb(v_new), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'bill', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.upsert_recurring_bill(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_recurring_bill(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_recurring_bill_active(p_id uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.expense_recurring_bills;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT * INTO v_old FROM public.expense_recurring_bills WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.active = coalesce(p_active, v_old.active) THEN RETURN jsonb_build_object('ok', true, 'bill', to_jsonb(v_old)); END IF;
  UPDATE public.expense_recurring_bills SET active = p_active, updated_at = now() WHERE id = p_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense_recurring_bill', p_id, 'set_recurring_bill_active', jsonb_build_object('active', v_old.active), jsonb_build_object('active', p_active), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'bill', (SELECT to_jsonb(b) FROM public.expense_recurring_bills b WHERE b.id = p_id));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_recurring_bill_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_recurring_bill_active(uuid, boolean) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Prepaid by hand on a draft.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_expense_prepaid(p_id uuid, p_months integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_old public.expenses;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_permission(v_uid, 'manage_expenses') OR public.has_permission(v_uid, 'approve_expenses')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_months IS NOT NULL AND p_months NOT BETWEEN 2 AND 36 THEN RETURN jsonb_build_object('error', 'invalid_spread'); END IF;
  SELECT * INTO v_old FROM public.expenses WHERE id = p_id FOR UPDATE;
  IF v_old.id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status <> 'draft' THEN RETURN jsonb_build_object('error', 'not_draft', 'status', v_old.status); END IF;
  IF v_old.prepaid_months IS NOT DISTINCT FROM p_months THEN RETURN jsonb_build_object('ok', true, 'expense', to_jsonb(v_old)); END IF;
  UPDATE public.expenses SET prepaid_months = p_months WHERE id = p_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', p_id, 'set_expense_prepaid', jsonb_build_object('prepaid_months', v_old.prepaid_months), jsonb_build_object('prepaid_months', p_months), v_uid, now());
  RETURN jsonb_build_object('ok', true, 'expense', (SELECT to_jsonb(e) FROM public.expenses e WHERE e.id = p_id));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_expense_prepaid(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_expense_prepaid(uuid, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Generation. One draft for the latest due cycle on or before p_as_of; the
--    template then points at the next cycle after p_as_of (no backlog, D5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expenses_create_recurring_draft(p_bill public.expense_recurring_bills, p_due date, p_uid uuid)
RETURNS uuid
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_ref text := p_bill.id::text || ':' || p_due::text;
  v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.expenses e WHERE e.source = 'recurring' AND e.source_ref = v_ref AND e.status <> 'void') THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.expenses (expense_date, category_id, vendor_id, description, currency, amount, amount_jpy, payment_method,
                               paid_from, prepaid_months, notes, status, source, source_ref, details, created_by)
  VALUES (p_due, p_bill.category_id, p_bill.vendor_id, p_bill.description, p_bill.currency, p_bill.amount, 0, p_bill.payment_method,
          p_bill.paid_from, p_bill.spread_months, p_bill.notes, 'draft', 'recurring', v_ref,
          jsonb_build_object('kind', 'recurring_bill', 'bill_id', p_bill.id, 'bill_name', p_bill.name, 'due_on', p_due,
                             'expected_amount', p_bill.amount, 'frequency', p_bill.frequency),
          p_uid)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', v_id, 'generate_recurring_draft', jsonb_build_object('bill_id', p_bill.id, 'due_on', p_due, 'amount', p_bill.amount, 'currency', p_bill.currency), p_uid, now());
  RETURN v_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_create_recurring_draft(public.expense_recurring_bills, date, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.expenses_generate_recurring(p_as_of date DEFAULT NULL, p_uid uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_as_of date := coalesce(p_as_of, (now() AT TIME ZONE 'Asia/Tokyo')::date);
  b public.expense_recurring_bills;
  v_due date;
  v_next date;
  v_created integer := 0;
  v_skipped integer := 0;
  v_ended integer := 0;
  v_id uuid;
BEGIN
  IF (SELECT (value #>> '{}')::numeric FROM public.system_settings WHERE key = 'php_jpy_rate') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'rate_not_set');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('expenses_generate_recurring'));
  FOR b IN SELECT * FROM public.expense_recurring_bills WHERE active AND next_due_on <= v_as_of ORDER BY next_due_on, name FOR UPDATE LOOP
    v_due := b.next_due_on;
    v_next := public.recurring_next_due(v_due, b.frequency);
    WHILE v_next <= v_as_of AND (b.ends_on IS NULL OR v_next <= b.ends_on) LOOP
      v_due := v_next;
      v_next := public.recurring_next_due(v_due, b.frequency);
    END LOOP;
    IF b.ends_on IS NOT NULL AND v_due > b.ends_on THEN
      UPDATE public.expense_recurring_bills SET active = false, updated_at = now() WHERE id = b.id;
      v_ended := v_ended + 1;
      CONTINUE;
    END IF;
    v_id := public.expenses_create_recurring_draft(b, v_due, p_uid);
    IF v_id IS NULL THEN v_skipped := v_skipped + 1; ELSE v_created := v_created + 1; END IF;
    UPDATE public.expense_recurring_bills
       SET next_due_on = v_next, last_generated_on = v_due,
           active = CASE WHEN b.ends_on IS NOT NULL AND v_next > b.ends_on THEN false ELSE active END,
           updated_at = now()
     WHERE id = b.id;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'as_of', v_as_of, 'created', v_created, 'skipped', v_skipped, 'ended', v_ended);
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_generate_recurring(date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expenses_generate_recurring(date, uuid) TO service_role;
COMMENT ON FUNCTION public.expenses_generate_recurring(date, uuid) IS
  'Internal (pg_cron nightly, generate_recurring_now): for every active bill due on or before p_as_of, one DRAFT expense for the latest due cycle, then the bill points at the next cycle. Never a backlog. Ends a bill past ends_on.';

CREATE OR REPLACE FUNCTION public.generate_recurring_now(p_bill_id uuid DEFAULT NULL, p_for date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  b public.expense_recurring_bills;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_expenses') THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_bill_id IS NULL THEN
    RETURN public.expenses_generate_recurring(NULL, v_uid);
  END IF;
  SELECT * INTO b FROM public.expense_recurring_bills WHERE id = p_bill_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF p_for IS NULL THEN RETURN jsonb_build_object('error', 'invalid_date'); END IF;
  IF p_for < b.starts_on OR p_for > (now() AT TIME ZONE 'Asia/Tokyo')::date + 31 OR (b.ends_on IS NOT NULL AND p_for > b.ends_on) THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  v_id := public.expenses_create_recurring_draft(b, p_for, v_uid);
  IF v_id IS NULL THEN RETURN jsonb_build_object('error', 'already_generated'); END IF;
  RETURN jsonb_build_object('ok', true, 'expense_id', v_id, 'due_on', p_for);
END
$fn$;
REVOKE ALL ON FUNCTION public.generate_recurring_now(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_recurring_now(uuid, date) TO authenticated;
COMMENT ON FUNCTION public.generate_recurring_now(uuid, date) IS
  'Finance -> Expenses "Generate now" (manage_expenses): with no bill, runs the nightly generation; with a bill and a date, one-off draft for that due date (catch-up) without moving the schedule.';

-- ---------------------------------------------------------------------------
-- 6. Nightly at 00:20 JST (before the ledger run at 00:40). Skipped without pg_cron.
-- ---------------------------------------------------------------------------
DO $c$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expenses-recurring') THEN
      PERFORM cron.unschedule('expenses-recurring');
    END IF;
    PERFORM cron.schedule('expenses-recurring', '20 15 * * *', $job$ SELECT public.expenses_generate_recurring(NULL, NULL); $job$);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'expenses-recurring cron schedule skipped: %', SQLERRM;
END
$c$;
