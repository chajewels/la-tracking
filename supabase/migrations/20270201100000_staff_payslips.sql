-- Timesheet -> Payslips (owner-confirmed plan 2026-10-26; docs/PAYSLIPS.md).
--
--   * Who: admin, or a timesheet user flagged can_view_all (today only Brenda). The same gate
--     as the Timesheet Cost Master. Staff never see their own payslip through this feature.
--     One helper, public.can_manage_payslips(uid), answers it for RLS, storage and every RPC;
--     it only ever answers for the caller (uid must be auth.uid()), so nobody can probe others.
--   * staff_payroll_details: address + date of birth per staff member (user_id = auth uid, the
--     same id as timesheet_profiles.user_id). Edited on the Payslips tab.
--   * payslips: one per staff member per month (partial unique, void rows excluded). Finalize
--     FREEZES the figures and the staff details (copied server-side from profiles,
--     timesheet_profiles and staff_payroll_details) - the browser only sends the timesheet and
--     commission breakdown, and the function keeps KNOWN KEYS ONLY. A changed figure later is
--     fixed by void + re-issue, never by an edit.
--   * Status: finalized -> paid (payment fields only) and finalized | paid -> void (void fields
--     only). Every other update, every DELETE and TRUNCATE is refused by triggers, whoever runs
--     them. php_per_jpy is the ACTUAL remittance rate: php_received / jpy_sent, stored.
--   * The tables have NO write policies; INSERT/UPDATE/DELETE/TRUNCATE are revoked from PUBLIC,
--     anon and authenticated. Writes only through save_staff_payroll_details, finalize_payslip,
--     record_payslip_payment and void_payslip (SECURITY DEFINER, gate checked, one audit_logs
--     row each). Audit rows carry no money figures, address or date of birth: audit_logs is
--     readable by the finance role, which is wider than the payslip gate.
--   * Proof of payment: private bucket payslip-proofs, path <payslip_id>/<file>. Read = the gate;
--     upload = the gate AND the folder is an existing FINALIZED payslip; no update, no delete.
--
--   New objects only; nothing existing is changed. Re-runnable (IF NOT EXISTS / ON CONFLICT /
--   catalog-checked policies). No comment lines inside any function body (Lovable strips them).

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. The gate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_manage_payslips(p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT p_uid IS NOT NULL
     AND p_uid = auth.uid()
     AND (public.has_role(p_uid, 'admin'::app_role) OR public.timesheet_can_view_all(p_uid))
$fn$;
REVOKE ALL ON FUNCTION public.can_manage_payslips(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_payslips(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.can_manage_payslips(uuid) IS
  'Payslips gate: true when p_uid is the caller (auth.uid()) and has role admin or timesheet_profiles.can_view_all. Used by the payslip RLS policies, the payslip-proofs storage policies and every payslip RPC.';

-- ---------------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_payroll_details (
  user_id        uuid PRIMARY KEY,
  address        text NULL CHECK (address IS NULL OR (length(address) BETWEEN 1 AND 500 AND address = btrim(address))),
  date_of_birth  date NULL CHECK (date_of_birth IS NULL OR date_of_birth >= DATE '1900-01-01'),
  updated_by     uuid NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.staff_payroll_details ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.staff_payroll_details IS
  'Payslip staff details (address, date of birth) per staff member; user_id = auth uid = timesheet_profiles.user_id. Read by the payslip gate; written only by save_staff_payroll_details (audited, field names only).';

CREATE TABLE IF NOT EXISTS public.payslips (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  pay_month          date NOT NULL CHECK (pay_month = date_trunc('month', pay_month)::date),
  status             text NOT NULL DEFAULT 'finalized' CHECK (status IN ('finalized', 'paid', 'void')),
  staff_name         text NOT NULL CHECK (length(btrim(staff_name)) BETWEEN 1 AND 200),
  address            text NOT NULL CHECK (length(address) BETWEEN 1 AND 500),
  date_of_birth      date NOT NULL,
  job_title          text NULL,
  template_type      text NOT NULL CHECK (template_type IN ('csr', 'live_admin')),
  timesheet          jsonb NOT NULL CHECK (jsonb_typeof(timesheet) = 'object'),
  commission         jsonb NOT NULL CHECK (jsonb_typeof(commission) = 'object'),
  timesheet_net_php  numeric(14,2) NOT NULL CHECK (timesheet_net_php >= 0),
  commission_php     numeric(14,2) NOT NULL CHECK (commission_php >= 0),
  total_php          numeric(14,2) NOT NULL CHECK (total_php >= 0),
  jpy_sent           integer NULL CHECK (jpy_sent IS NULL OR jpy_sent > 0),
  php_received       numeric(14,2) NULL CHECK (php_received IS NULL OR php_received > 0),
  php_per_jpy        numeric(12,6) NULL CHECK (php_per_jpy IS NULL OR php_per_jpy > 0),
  paid_on            date NULL,
  proof_path         text NULL,
  finalized_by       uuid NOT NULL,
  finalized_at       timestamptz NOT NULL DEFAULT now(),
  paid_by            uuid NULL,
  paid_at            timestamptz NULL,
  voided_by          uuid NULL,
  voided_at          timestamptz NULL,
  void_reason        text NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payslips_total CHECK (total_php = timesheet_net_php + commission_php),
  CONSTRAINT payslips_proof_path CHECK (proof_path IS NULL OR proof_path LIKE id::text || '/%'),
  CONSTRAINT payslips_paid_fields CHECK (
    (jpy_sent IS NULL AND php_received IS NULL AND php_per_jpy IS NULL AND paid_on IS NULL
       AND proof_path IS NULL AND paid_by IS NULL AND paid_at IS NULL)
    OR (jpy_sent IS NOT NULL AND php_received IS NOT NULL AND php_per_jpy IS NOT NULL AND paid_on IS NOT NULL
       AND proof_path IS NOT NULL AND paid_by IS NOT NULL AND paid_at IS NOT NULL)),
  CONSTRAINT payslips_paid_status CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CONSTRAINT payslips_finalized_status CHECK (status <> 'finalized' OR paid_at IS NULL),
  CONSTRAINT payslips_void_fields CHECK (
    (status = 'void' AND voided_by IS NOT NULL AND voided_at IS NOT NULL
       AND length(btrim(coalesce(void_reason, ''))) >= 3)
    OR (status <> 'void' AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS payslips_one_live_per_month
  ON public.payslips (user_id, pay_month) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS payslips_pay_month_idx ON public.payslips (pay_month);
ALTER TABLE public.payslips ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.payslips IS
  'Staff payslips (Timesheet -> Payslips, owner 2026-10-26). Figures and staff details frozen at finalize; finalized -> paid (payment fields only) or -> void (void fields only); never deleted. php_per_jpy = php_received / jpy_sent (actual remittance rate). Written only through finalize_payslip / record_payslip_payment / void_payslip (audited); no write policies.';

-- ---------------------------------------------------------------------------
-- 3. Read policies (the gate). Scalar sub-selects per docs/MIGRATIONS.md.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS staff_payroll_details_read ON public.staff_payroll_details;
CREATE POLICY staff_payroll_details_read ON public.staff_payroll_details
  FOR SELECT TO authenticated
  USING ((SELECT public.can_manage_payslips((SELECT auth.uid()))));

DROP POLICY IF EXISTS payslips_read ON public.payslips;
CREATE POLICY payslips_read ON public.payslips
  FOR SELECT TO authenticated
  USING ((SELECT public.can_manage_payslips((SELECT auth.uid()))));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.staff_payroll_details, public.payslips
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.staff_payroll_details, public.payslips FROM anon;
GRANT SELECT ON public.staff_payroll_details, public.payslips TO authenticated;
GRANT ALL ON public.staff_payroll_details, public.payslips TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Guard triggers on payslips.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payslips_before_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_pay  text[] := ARRAY['status', 'jpy_sent', 'php_received', 'php_per_jpy', 'paid_on', 'proof_path', 'paid_by', 'paid_at'];
  v_void text[] := ARRAY['status', 'voided_by', 'voided_at', 'void_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payslips are never deleted; void the payslip instead' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'finalized' OR NEW.paid_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a payslip starts as finalized' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'finalized' AND NEW.status = 'paid' THEN
    IF (to_jsonb(NEW) - v_pay) IS DISTINCT FROM (to_jsonb(OLD) - v_pay) THEN
      RAISE EXCEPTION 'recording a payment changes the payment fields only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('finalized', 'paid') AND NEW.status = 'void' THEN
    IF (to_jsonb(NEW) - v_void) IS DISTINCT FROM (to_jsonb(OLD) - v_void) THEN
      RAISE EXCEPTION 'voiding a payslip changes the void fields only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a payslip is locked: it can only be marked paid (from finalized) or voided'
    USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslips_before_write() IS
  'BEFORE INSERT/UPDATE/DELETE on payslips. Insert must be finalized with no payment/void fields. Update allowed only finalized -> paid (payment fields only) and finalized|paid -> void (void fields only); snapshot and figure columns never change. DELETE always refused.';
REVOKE ALL ON FUNCTION public.payslips_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payslips_before_write ON public.payslips;
CREATE TRIGGER payslips_before_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.payslips
  FOR EACH ROW EXECUTE FUNCTION public.payslips_before_write();

CREATE OR REPLACE FUNCTION public.payslips_refuse_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'payslips are never deleted (TRUNCATE refused)' USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslips_refuse_truncate() IS
  'BEFORE TRUNCATE on payslips: always refused (the row trigger does not fire on TRUNCATE).';
REVOKE ALL ON FUNCTION public.payslips_refuse_truncate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payslips_refuse_truncate ON public.payslips;
CREATE TRIGGER payslips_refuse_truncate
  BEFORE TRUNCATE ON public.payslips
  FOR EACH STATEMENT EXECUTE FUNCTION public.payslips_refuse_truncate();

-- ---------------------------------------------------------------------------
-- 5. RPCs. Each returns jsonb: {ok: true, ...} or {error: <code>}. Raw database
--    errors never reach the caller.
-- ---------------------------------------------------------------------------

-- payslip_figure(v, p_int): a JSON number or numeric string as a plain decimal >= 0
-- (whole number when p_int); NULL when it is not one. Used by finalize_payslip only.
CREATE OR REPLACE FUNCTION public.payslip_figure(v jsonb, p_int boolean)
RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE
    WHEN v IS NULL OR jsonb_typeof(v) NOT IN ('number', 'string') THEN NULL
    WHEN p_int AND (v #>> '{}') ~ '^[0-9]{1,6}$' THEN (v #>> '{}')::numeric
    WHEN NOT p_int AND (v #>> '{}') ~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' THEN (v #>> '{}')::numeric
    ELSE NULL
  END
$fn$;
REVOKE ALL ON FUNCTION public.payslip_figure(jsonb, boolean) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.payslip_figure(jsonb, boolean) IS
  'finalize_payslip helper: a JSON number or numeric string as a plain decimal >= 0 with at most 2 decimals (a whole number when p_int); NULL otherwise.';

-- get_payslip_book(p_pay_month): everything the Payslips tab needs for one month.
CREATE OR REPLACE FUNCTION public.get_payslip_book(p_pay_month date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_month date;
  v_rate  numeric;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_pay_month IS NULL THEN RETURN jsonb_build_object('error', 'invalid_month'); END IF;
  v_month := date_trunc('month', p_pay_month)::date;
  SELECT CASE WHEN (s.value #>> '{}') ~ '^[0-9]*\.?[0-9]+$' THEN (s.value #>> '{}')::numeric END
    INTO v_rate FROM public.system_settings s WHERE s.key = 'php_jpy_rate';

  RETURN jsonb_build_object(
    'ok', true,
    'month', v_month,
    'can_manage', true,
    'php_jpy_rate', v_rate,
    'payslips', coalesce((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.staff_name, p.created_at)
        FROM public.payslips p WHERE p.pay_month = v_month), '[]'::jsonb),
    'details', coalesce((
      SELECT jsonb_agg(jsonb_build_object('user_id', tp.user_id, 'address', d.address,
                                          'date_of_birth', d.date_of_birth, 'updated_at', d.updated_at))
        FROM public.timesheet_profiles tp
        LEFT JOIN public.staff_payroll_details d ON d.user_id = tp.user_id
       WHERE tp.active), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_payslip_book(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payslip_book(date) TO authenticated;
COMMENT ON FUNCTION public.get_payslip_book(date) IS
  'Timesheet -> Payslips: every payslip of the month (all statuses), the payroll details of every active timesheet profile, the one peso rate and can_manage. Needs the payslip gate.';

-- save_staff_payroll_details(p_user_id, p_address, p_date_of_birth): upsert. An empty address
-- or a null date clears that field.
CREATE OR REPLACE FUNCTION public.save_staff_payroll_details(p_user_id uuid, p_address text, p_date_of_birth date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_old     public.staff_payroll_details%ROWTYPE;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id) THEN
    RETURN jsonb_build_object('error', 'staff_not_found');
  END IF;
  IF v_address IS NOT NULL AND length(v_address) > 500 THEN RETURN jsonb_build_object('error', 'invalid_address'); END IF;
  IF p_date_of_birth IS NOT NULL
     AND (p_date_of_birth < DATE '1900-01-01' OR p_date_of_birth > (now() AT TIME ZONE 'Asia/Tokyo')::date) THEN
    RETURN jsonb_build_object('error', 'invalid_date_of_birth');
  END IF;

  SELECT * INTO v_old FROM public.staff_payroll_details WHERE user_id = p_user_id FOR UPDATE;
  IF v_old.address IS DISTINCT FROM v_address THEN v_changed := array_append(v_changed, 'address'); END IF;
  IF v_old.date_of_birth IS DISTINCT FROM p_date_of_birth THEN v_changed := array_append(v_changed, 'date_of_birth'); END IF;
  IF cardinality(v_changed) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'changed', '[]'::jsonb);
  END IF;

  INSERT INTO public.staff_payroll_details (user_id, address, date_of_birth, updated_by, updated_at)
  VALUES (p_user_id, v_address, p_date_of_birth, v_uid, now())
  ON CONFLICT (user_id) DO UPDATE
     SET address = EXCLUDED.address, date_of_birth = EXCLUDED.date_of_birth,
         updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('staff_payroll_details', p_user_id, 'save_staff_payroll_details',
          jsonb_build_object('changed_fields', to_jsonb(v_changed), 'created', v_old.user_id IS NULL),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'changed', to_jsonb(v_changed));
END
$fn$;
REVOKE ALL ON FUNCTION public.save_staff_payroll_details(uuid, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_staff_payroll_details(uuid, text, date) TO authenticated;
COMMENT ON FUNCTION public.save_staff_payroll_details(uuid, text, date) IS
  'Saves a staff member''s payslip address (<= 500 characters, trimmed; empty clears) and date of birth (1900-01-01 .. today Japan time; null clears). The staff member must have a timesheet profile. Needs the payslip gate; one audit_logs row naming the changed fields only (never the values).';

-- finalize_payslip(p_user_id, p_pay_month, p_payload): freeze one staff member's payslip.
CREATE OR REPLACE FUNCTION public.finalize_payslip(p_user_id uuid, p_pay_month date, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_profile  public.timesheet_profiles%ROWTYPE;
  v_details  public.staff_payroll_details%ROWTYPE;
  v_name     text;
  v_in_ts    jsonb;
  v_in_cm    jsonb;
  v_ts       jsonb := '{}'::jsonb;
  v_cm       jsonb := '{}'::jsonb;
  v_key      text;
  v_num      numeric;
  v_ts_net   numeric;
  v_cm_total numeric;
  v_total    numeric;
  v_role     text;
  v_new      public.payslips%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_pay_month IS NULL OR p_pay_month <> date_trunc('month', p_pay_month)::date
     OR p_pay_month < DATE '2026-06-01' OR p_pay_month > date_trunc('month', v_today)::date THEN
    RETURN jsonb_build_object('error', 'invalid_month');
  END IF;
  SELECT * INTO v_profile FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id;
  IF p_user_id IS NULL OR NOT FOUND THEN RETURN jsonb_build_object('error', 'staff_not_found'); END IF;
  IF v_profile.template_type NOT IN ('csr', 'live_admin') THEN RETURN jsonb_build_object('error', 'staff_not_found'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payslip:' || p_user_id::text || ':' || p_pay_month::text, 0));
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = p_user_id AND p.pay_month = p_pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'already_issued');
  END IF;

  SELECT nullif(btrim(pr.full_name), '') INTO v_name FROM public.profiles pr WHERE pr.user_id = p_user_id LIMIT 1;
  IF v_name IS NULL THEN RETURN jsonb_build_object('error', 'name_missing'); END IF;
  SELECT * INTO v_details FROM public.staff_payroll_details d WHERE d.user_id = p_user_id;
  IF v_details.address IS NULL OR v_details.date_of_birth IS NULL THEN
    RETURN jsonb_build_object('error', 'details_missing');
  END IF;

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN RETURN jsonb_build_object('error', 'invalid_figures'); END IF;
  v_in_ts := p_payload -> 'timesheet';
  v_in_cm := p_payload -> 'commission';
  IF v_in_ts IS NULL OR jsonb_typeof(v_in_ts) <> 'object' OR v_in_cm IS NULL OR jsonb_typeof(v_in_cm) <> 'object' THEN
    RETURN jsonb_build_object('error', 'invalid_figures');
  END IF;

  IF v_profile.template_type = 'csr' THEN
    FOREACH v_key IN ARRAY ARRAY['days_worked', 'forfeited_weeks'] LOOP
      v_num := public.payslip_figure(v_in_ts -> v_key, true);
      IF v_num IS NULL THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', v_key); END IF;
      v_ts := v_ts || jsonb_build_object(v_key, v_num);
    END LOOP;
    FOREACH v_key IN ARRAY ARRAY['total_hours', 'daily_pay_sum', 'basic_salary', 'capped_gross',
                                 'monthly_allowance', 'allowance_paid', 'net'] LOOP
      v_num := public.payslip_figure(v_in_ts -> v_key, false);
      IF v_num IS NULL THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', v_key); END IF;
      v_ts := v_ts || jsonb_build_object(v_key, v_num);
    END LOOP;
    IF (v_ts ->> 'forfeited_weeks')::numeric > 4 OR (v_ts ->> 'days_worked')::numeric > 31 THEN
      RETURN jsonb_build_object('error', 'invalid_figures');
    END IF;
    IF abs((v_ts ->> 'net')::numeric - (v_ts ->> 'capped_gross')::numeric - (v_ts ->> 'allowance_paid')::numeric) > 0.01 THEN
      RETURN jsonb_build_object('error', 'invalid_totals');
    END IF;
  ELSE
    FOREACH v_key IN ARRAY ARRAY['days_at_500', 'days_at_300'] LOOP
      v_num := public.payslip_figure(v_in_ts -> v_key, true);
      IF v_num IS NULL THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', v_key); END IF;
      v_ts := v_ts || jsonb_build_object(v_key, v_num);
    END LOOP;
    FOREACH v_key IN ARRAY ARRAY['total_hours', 'net'] LOOP
      v_num := public.payslip_figure(v_in_ts -> v_key, false);
      IF v_num IS NULL THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', v_key); END IF;
      v_ts := v_ts || jsonb_build_object(v_key, v_num);
    END LOOP;
    IF (v_ts ->> 'days_at_500')::numeric + (v_ts ->> 'days_at_300')::numeric > 31 THEN
      RETURN jsonb_build_object('error', 'invalid_figures');
    END IF;
    IF (v_ts ->> 'net')::numeric <> 500 * (v_ts ->> 'days_at_500')::numeric + 300 * (v_ts ->> 'days_at_300')::numeric THEN
      RETURN jsonb_build_object('error', 'invalid_totals');
    END IF;
  END IF;

  v_num := public.payslip_figure(v_in_cm -> 'top_sales_tier', true);
  IF v_num IS NULL OR v_num > 2 THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', 'top_sales_tier'); END IF;
  v_cm := v_cm || jsonb_build_object('top_sales_tier', v_num);
  FOREACH v_key IN ARRAY ARRAY['earnings', 'top_sales_bonus', 'total'] LOOP
    v_num := public.payslip_figure(v_in_cm -> v_key, false);
    IF v_num IS NULL THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', v_key); END IF;
    v_cm := v_cm || jsonb_build_object(v_key, v_num);
  END LOOP;
  IF v_in_cm ? 'role_won' AND jsonb_typeof(v_in_cm -> 'role_won') <> 'null' THEN
    IF jsonb_typeof(v_in_cm -> 'role_won') <> 'string' THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', 'role_won'); END IF;
    v_role := nullif(btrim(v_in_cm ->> 'role_won'), '');
    IF v_role IS NOT NULL AND length(v_role) > 60 THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', 'role_won'); END IF;
  END IF;
  v_cm := v_cm || jsonb_build_object('role_won', v_role);
  IF (v_cm ->> 'total')::numeric <> (v_cm ->> 'earnings')::numeric + (v_cm ->> 'top_sales_bonus')::numeric
     OR ((v_cm ->> 'top_sales_tier')::numeric = 0) <> ((v_cm ->> 'top_sales_bonus')::numeric = 0) THEN
    RETURN jsonb_build_object('error', 'invalid_totals');
  END IF;

  v_ts_net   := public.payslip_figure(p_payload -> 'timesheet_net_php', false);
  v_cm_total := public.payslip_figure(p_payload -> 'commission_php', false);
  v_total    := public.payslip_figure(p_payload -> 'total_php', false);
  IF v_ts_net IS NULL OR v_cm_total IS NULL OR v_total IS NULL THEN RETURN jsonb_build_object('error', 'invalid_figures'); END IF;
  IF v_ts_net <> (v_ts ->> 'net')::numeric OR v_cm_total <> (v_cm ->> 'total')::numeric
     OR v_total <> v_ts_net + v_cm_total THEN
    RETURN jsonb_build_object('error', 'invalid_totals');
  END IF;

  INSERT INTO public.payslips (user_id, pay_month, status, staff_name, address, date_of_birth, job_title, template_type,
                               timesheet, commission, timesheet_net_php, commission_php, total_php, finalized_by, finalized_at)
  VALUES (p_user_id, p_pay_month, 'finalized', v_name, v_details.address, v_details.date_of_birth,
          nullif(btrim(coalesce(v_profile.job_title, '')), ''), v_profile.template_type,
          v_ts, v_cm, v_ts_net, v_cm_total, v_total, v_uid, now())
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip', v_new.id, 'finalize_payslip',
          jsonb_build_object('user_id', p_user_id, 'pay_month', p_pay_month, 'status', 'finalized'),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'payslip', to_jsonb(v_new));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'already_issued');
END
$fn$;
REVOKE ALL ON FUNCTION public.finalize_payslip(uuid, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_payslip(uuid, date, jsonb) TO authenticated;
COMMENT ON FUNCTION public.finalize_payslip(uuid, date, jsonb) IS
  'Freezes a staff member''s payslip for p_pay_month (first of month, 2026-06 .. this month Japan time). Name, job title, template, address and date of birth are copied server-side; the timesheet / commission breakdown is rebuilt from known keys only (plain decimals >= 0); total_php must equal timesheet_net_php + commission_php. Refuses permission_denied, invalid_month, staff_not_found, already_issued, name_missing, details_missing, invalid_figures, invalid_totals. One audit_logs row (no figures).';

-- record_payslip_payment(p_id, p_jpy_sent, p_php_received, p_paid_on, p_proof_path): finalized -> paid.
CREATE OR REPLACE FUNCTION public.record_payslip_payment(p_id uuid, p_jpy_sent integer, p_php_received numeric,
                                                         p_paid_on date, p_proof_path text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_path text := btrim(coalesce(p_proof_path, ''));
  v_old  public.payslips%ROWTYPE;
  v_new  public.payslips%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_old FROM public.payslips WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status <> 'finalized' THEN RETURN jsonb_build_object('error', 'not_finalized', 'status', v_old.status); END IF;
  IF p_jpy_sent IS NULL OR p_jpy_sent <= 0 OR p_jpy_sent > 100000000 THEN RETURN jsonb_build_object('error', 'invalid_jpy_sent'); END IF;
  IF p_php_received IS NULL OR p_php_received <= 0 OR p_php_received > 10000000000
     OR p_php_received <> round(p_php_received, 2) THEN
    RETURN jsonb_build_object('error', 'invalid_php_received');
  END IF;
  IF p_paid_on IS NULL OR p_paid_on > (now() AT TIME ZONE 'Asia/Tokyo')::date OR p_paid_on < v_old.pay_month THEN
    RETURN jsonb_build_object('error', 'invalid_paid_on');
  END IF;
  IF v_path = '' THEN RETURN jsonb_build_object('error', 'proof_required'); END IF;
  IF v_path NOT LIKE p_id::text || '/%' OR length(split_part(v_path, '/', 2)) = 0
     OR v_path LIKE '%..%' OR length(v_path) > 300 THEN
    RETURN jsonb_build_object('error', 'invalid_proof_path');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payslip-proofs' AND o.name = v_path) THEN
    RETURN jsonb_build_object('error', 'proof_missing');
  END IF;

  UPDATE public.payslips
     SET status = 'paid', jpy_sent = p_jpy_sent, php_received = p_php_received,
         php_per_jpy = round(p_php_received / p_jpy_sent, 6), paid_on = p_paid_on, proof_path = v_path,
         paid_by = v_uid, paid_at = now()
   WHERE id = p_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip', p_id, 'record_payslip_payment',
          jsonb_build_object('status', v_old.status),
          jsonb_build_object('status', v_new.status, 'paid_on', v_new.paid_on, 'proof_path', v_new.proof_path),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'payslip', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text) TO authenticated;
COMMENT ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text) IS
  'Records the remittance on a FINALIZED payslip: whole yen sent > 0, pesos received > 0 (2 decimals), paid on pay_month .. today Japan time, proof <payslip_id>/<file> already uploaded to payslip-proofs. Stores php_per_jpy = round(php_received / jpy_sent, 6) (the actual rate) and sets status paid. Needs the payslip gate; one audit_logs row (no figures).';

-- void_payslip(p_id, p_reason): finalized or paid -> void, reason required.
CREATE OR REPLACE FUNCTION public.void_payslip(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    public.payslips%ROWTYPE;
  v_new    public.payslips%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_old FROM public.payslips WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status = 'void' THEN RETURN jsonb_build_object('error', 'already_void'); END IF;

  UPDATE public.payslips
     SET status = 'void', voided_by = v_uid, voided_at = now(), void_reason = v_reason
   WHERE id = p_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip', p_id, 'void_payslip',
          jsonb_build_object('status', v_old.status),
          jsonb_build_object('status', v_new.status, 'void_reason', v_reason),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'payslip', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.void_payslip(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_payslip(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.void_payslip(uuid, text) IS
  'Voids a finalized or paid payslip with a written reason (3-500 characters); a new payslip can then be issued for the month. Never deletes. Needs the payslip gate; one audit_logs row.';

-- ---------------------------------------------------------------------------
-- 6. Private proof-of-payment bucket + object policies (read + upload only).
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('payslip-proofs', 'payslip-proofs', false, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;

DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'Payslip managers can read payslip proofs') THEN
    CREATE POLICY "Payslip managers can read payslip proofs" ON storage.objects
      FOR SELECT TO authenticated
      USING (bucket_id = 'payslip-proofs'
             AND (SELECT public.can_manage_payslips((SELECT auth.uid()))));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'Payslip managers can upload payslip proofs') THEN
    CREATE POLICY "Payslip managers can upload payslip proofs" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'payslip-proofs'
                  AND (SELECT public.can_manage_payslips((SELECT auth.uid())))
                  AND EXISTS (SELECT 1 FROM public.payslips p
                               WHERE p.id::text = split_part(name, '/', 1)
                                 AND p.status = 'finalized')
                  AND name NOT LIKE '%..%'
                  AND length(split_part(name, '/', 2)) > 0);
  END IF;
END
$p$;
