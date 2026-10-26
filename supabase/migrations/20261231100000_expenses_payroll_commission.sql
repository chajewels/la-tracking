-- Finance -> Expenses, Phase 2: "Mark as paid" for payroll and commission (owner decisions 2026-10-25).
--
--   * Timesheet (Cost Master) and Commissions (Payout Breakdown) stay where they are. Each gets a
--     "Mark as paid" button. Both figures are computed in the browser (timesheetEngine /
--     commissionEngine), so the RPCs here RECORD the figures the button sends, with the
--     per-person breakdown kept in expenses.details.
--   * ONE expense per month per source: source 'payroll' / 'commission', source_ref 'YYYY-MM'.
--     Booked as APPROVED at once (the money has left). A month can be booked once; a VOIDED
--     booking can be booked again (expenses_source_ref_uq excludes void rows).
--   * The two RPCs insert the row directly as a draft and approve it in the same call, so the
--     Phase 1 rules stay intact: INSERT must be a draft; manual entry into the payroll /
--     commission categories stays refused (category_booked_automatically); the trigger sets
--     amount_jpy from the one peso rate at the approve write.
--   * Payroll booking also upserts timesheet_monthly_history (csr_net, liveadmin_net) for the
--     month (ON CONFLICT on its primary key month_key) — the snapshot that stopped at 2026-05
--     resumes. The snapshot is refreshed on (re-)booking only; a void leaves the last figures.
--   * Paid-on date: not in the future (Asia/Tokyo day), not before the booked month's first day.
--   * Lines are rebuilt from known keys only (canonical details), capped at 500 lines, names
--     ≤ 120 and role labels ≤ 60 characters; numbers must be plain decimals.
--   * Who: approve_expenses (admin by default). Reading the booked months: manage or approve.
--
--   New objects only. Re-runnable. No comment lines inside function bodies.

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Shared helper: book one automatic month. Not callable by clients.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.expenses_book_auto_month(
  p_source text, p_system_key text, p_month date, p_paid_on date,
  p_description text, p_amount_php numeric, p_details jsonb, p_uid uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_cat    uuid;
  v_ref    text := to_char(p_month, 'YYYY-MM');
  v_new    public.expenses%ROWTYPE;
  v_appr   public.expenses%ROWTYPE;
  v_today  date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
BEGIN
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RETURN jsonb_build_object('error', 'invalid_month');
  END IF;
  IF p_month > date_trunc('month', v_today)::date OR p_month < DATE '2020-01-01' THEN
    RETURN jsonb_build_object('error', 'invalid_month');
  END IF;
  IF p_paid_on IS NULL OR p_paid_on < p_month OR p_paid_on > v_today THEN
    RETURN jsonb_build_object('error', 'invalid_paid_on');
  END IF;
  IF p_amount_php IS NULL OR p_amount_php <= 0 OR p_amount_php > 10000000000 THEN
    RETURN jsonb_build_object('error', 'invalid_lines');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.system_settings s
                  WHERE s.key = 'php_jpy_rate' AND (s.value #>> '{}') ~ '^[0-9]*\.?[0-9]+$'
                    AND (s.value #>> '{}')::numeric > 0) THEN
    RETURN jsonb_build_object('error', 'rate_not_set');
  END IF;
  SELECT id INTO v_cat FROM public.expense_categories WHERE system_key = p_system_key AND active;
  IF v_cat IS NULL THEN RETURN jsonb_build_object('error', 'invalid_category'); END IF;

  PERFORM pg_advisory_xact_lock(hashtext('expenses_book_auto_month:' || p_source || ':' || v_ref));
  IF EXISTS (SELECT 1 FROM public.expenses e
              WHERE e.source = p_source AND e.source_ref = v_ref AND e.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'already_booked', 'month', v_ref);
  END IF;

  INSERT INTO public.expenses (expense_date, category_id, description, currency, amount, amount_jpy,
                               payment_method, status, source, source_ref, details, created_by)
  VALUES (p_paid_on, v_cat, p_description, 'PHP', round(p_amount_php, 2), 0,
          'bank_transfer', 'draft', p_source, v_ref, p_details, p_uid)
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', v_new.id, p_action, to_jsonb(v_new) || jsonb_build_object('change', 'created'), p_uid, now());

  UPDATE public.expenses
     SET status = 'approved', approved_by = p_uid, approved_at = now()
   WHERE id = v_new.id
  RETURNING * INTO v_appr;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('expense', v_new.id, 'approve_expense',
          jsonb_build_object('status', 'draft'),
          jsonb_build_object('status', 'approved', 'amount_jpy', v_appr.amount_jpy, 'currency', 'PHP',
                             'amount', v_appr.amount, 'fx_php_per_jpy', v_appr.fx_php_per_jpy, 'via', p_action),
          p_uid, now());

  RETURN jsonb_build_object('ok', true, 'expense', to_jsonb(v_appr));
END
$fn$;
REVOKE ALL ON FUNCTION public.expenses_book_auto_month(text, text, date, date, text, numeric, jsonb, uuid, text)
  FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.expenses_book_auto_month(text, text, date, date, text, numeric, jsonb, uuid, text) IS
  'Internal: books one automatic month (payroll / commission) as a PHP expense, draft then approved, two audit_logs rows. Refuses a month already booked unless that booking is void. Called only by book_payroll_month / book_commission_month.';

-- ---------------------------------------------------------------------------
-- 2. book_payroll_month(p_month, p_paid_on, p_lines)
--    lines: [{user_id, name, template (csr|live_admin), total_hours, net}]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.book_payroll_month(p_month date, p_paid_on date, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_n         integer;
  v_total     numeric;
  v_csr       numeric;
  v_live      numeric;
  v_bad       integer;
  v_lines     jsonb;
  v_res       jsonb;
  v_label     text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'approve_expenses') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 OR jsonb_array_length(p_lines) > 500 THEN
    RETURN jsonb_build_object('error', 'invalid_lines');
  END IF;
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_lines) l
   WHERE jsonb_typeof(l) <> 'object'
      OR length(btrim(coalesce(l ->> 'name', ''))) NOT BETWEEN 1 AND 120
      OR coalesce(l ->> 'template', '') NOT IN ('csr', 'live_admin')
      OR coalesce(l ->> 'net', '') !~ '^[0-9]+(\.[0-9]+)?$'
      OR coalesce(l ->> 'total_hours', '0') !~ '^[0-9]+(\.[0-9]+)?$'
      OR ((l ->> 'user_id') IS NOT NULL AND (l ->> 'user_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  IF v_bad > 0 THEN RETURN jsonb_build_object('error', 'invalid_lines'); END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'user_id', l ->> 'user_id', 'name', btrim(l ->> 'name'), 'template', l ->> 'template',
           'total_hours', coalesce(l ->> 'total_hours', '0')::numeric, 'net', (l ->> 'net')::numeric)),
         count(*), sum((l ->> 'net')::numeric),
         sum(CASE WHEN l ->> 'template' = 'csr' THEN (l ->> 'net')::numeric ELSE 0 END),
         sum(CASE WHEN l ->> 'template' = 'live_admin' THEN (l ->> 'net')::numeric ELSE 0 END)
    INTO v_lines, v_n, v_total, v_csr, v_live
    FROM jsonb_array_elements(p_lines) l;
  IF v_total <= 0 THEN RETURN jsonb_build_object('error', 'invalid_lines'); END IF;

  v_label := to_char(p_month, 'FMMonth YYYY');
  v_res := public.expenses_book_auto_month(
    'payroll', 'payroll', p_month, p_paid_on,
    'Staff payroll — ' || v_label || ' (' || v_n || ' ' || CASE WHEN v_n = 1 THEN 'person' ELSE 'people' END || ')',
    v_total,
    jsonb_build_object('month', to_char(p_month, 'YYYY-MM'), 'kind', 'payroll',
                       'csr_net', v_csr, 'liveadmin_net', v_live, 'lines', v_lines),
    v_uid, 'book_payroll_month');
  IF v_res ->> 'ok' IS DISTINCT FROM 'true' THEN RETURN v_res; END IF;

  INSERT INTO public.timesheet_monthly_history (month_key, csr_net, liveadmin_net)
  VALUES (to_char(p_month, 'YYYY-MM'), v_csr, v_live)
  ON CONFLICT (month_key) DO UPDATE SET csr_net = EXCLUDED.csr_net, liveadmin_net = EXCLUDED.liveadmin_net;

  RETURN v_res;
END
$fn$;
REVOKE ALL ON FUNCTION public.book_payroll_month(date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.book_payroll_month(date, date, jsonb) TO authenticated;
COMMENT ON FUNCTION public.book_payroll_month(date, date, jsonb) IS
  'Timesheet -> Cost Master -> Mark as paid. Records the month''s per-person net pay (PHP, as computed on screen) as ONE approved expense (source payroll, source_ref YYYY-MM, breakdown in details) and refreshes timesheet_monthly_history. Needs approve_expenses. Refusals: invalid_month, invalid_paid_on (future, or before the month), invalid_lines (shape, caps, non-numeric), already_booked, rate_not_set.';

-- ---------------------------------------------------------------------------
-- 3. book_commission_month(p_month, p_paid_on, p_lines)
--    lines: [{name, role_won, earn, bonus, total}]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.book_commission_month(p_month date, p_paid_on date, p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_n     integer;
  v_total numeric;
  v_bad   integer;
  v_lines jsonb;
  v_label text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'approve_expenses') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 OR jsonb_array_length(p_lines) > 500 THEN
    RETURN jsonb_build_object('error', 'invalid_lines');
  END IF;
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_lines) l
   WHERE jsonb_typeof(l) <> 'object'
      OR length(btrim(coalesce(l ->> 'name', ''))) NOT BETWEEN 1 AND 120
      OR length(coalesce(l ->> 'role_won', '')) > 60
      OR coalesce(l ->> 'total', '') !~ '^[0-9]+(\.[0-9]+)?$'
      OR coalesce(l ->> 'earn', '0') !~ '^[0-9]+(\.[0-9]+)?$'
      OR coalesce(l ->> 'bonus', '0') !~ '^[0-9]+(\.[0-9]+)?$';
  IF v_bad > 0 THEN RETURN jsonb_build_object('error', 'invalid_lines'); END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) l WHERE (l ->> 'total')::numeric <= 0) THEN
    RETURN jsonb_build_object('error', 'invalid_lines');
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'name', btrim(l ->> 'name'), 'role_won', l ->> 'role_won',
           'earn', coalesce(l ->> 'earn', '0')::numeric, 'bonus', coalesce(l ->> 'bonus', '0')::numeric,
           'total', (l ->> 'total')::numeric, 'top_sales', coalesce((l ->> 'top_sales')::boolean, false))),
         count(*), sum((l ->> 'total')::numeric)
    INTO v_lines, v_n, v_total FROM jsonb_array_elements(p_lines) l;

  v_label := to_char(p_month, 'FMMonth YYYY');
  RETURN public.expenses_book_auto_month(
    'commission', 'commission', p_month, p_paid_on,
    'Sales commission — ' || v_label || ' (' || v_n || ' ' || CASE WHEN v_n = 1 THEN 'agent' ELSE 'agents' END || ')',
    v_total,
    jsonb_build_object('month', to_char(p_month, 'YYYY-MM'), 'kind', 'commission', 'lines', v_lines),
    v_uid, 'book_commission_month');
END
$fn$;
REVOKE ALL ON FUNCTION public.book_commission_month(date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.book_commission_month(date, date, jsonb) TO authenticated;
COMMENT ON FUNCTION public.book_commission_month(date, date, jsonb) IS
  'Commissions -> Payout Breakdown -> Mark as paid. Records the month''s payouts (PHP, as computed on screen; Top Sales bonus included) as ONE approved expense (source commission, source_ref YYYY-MM, breakdown in details). Needs approve_expenses. Refusals: invalid_month, invalid_paid_on (future, or before the month), invalid_lines (shape, caps, non-numeric), already_booked, rate_not_set.';

-- ---------------------------------------------------------------------------
-- 4. get_booked_months(p_source): what the buttons show.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_booked_months(p_source text)
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
  IF p_source NOT IN ('payroll', 'commission') THEN RETURN jsonb_build_object('error', 'invalid_source'); END IF;
  RETURN jsonb_build_object('ok', true, 'months', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'month_key', e.source_ref, 'expense_id', e.id, 'status', e.status, 'amount', e.amount,
             'amount_jpy', e.amount_jpy, 'expense_date', e.expense_date, 'approved_at', e.approved_at,
             'voided_at', e.voided_at, 'details', e.details)
           ORDER BY e.source_ref DESC, e.created_at DESC)
      FROM public.expenses e WHERE e.source = p_source), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_booked_months(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_booked_months(text) TO authenticated;
COMMENT ON FUNCTION public.get_booked_months(text) IS
  'Every payroll or commission booking (all statuses, newest first) for the Mark as paid buttons. Needs manage_expenses or approve_expenses.';
