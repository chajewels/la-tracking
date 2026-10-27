-- Payslips + timesheet: cash advances, employee ID, hire date, CASH BOND, PAY SETTINGS HISTORY and
-- April-May 2026 (owner-confirmed 2026-10-27 12:05-12:20; docs/PAYSLIPS.md "Cash advances, employee ID,
-- cash bond and April-May", docs/TIMESHEET-SPEC.md "Pay settings history").
--
--   * Cash advances (payslip_cash_advances): several per staff member per month, each with a date, a
--     note and its own optional proof (payslip-proofs, advances/<advance id>/<file>). They are
--     DEDUCTED: total earnings (total_php) - total cash advances = net pay. Add / attach proof / void
--     only while the month has no non-void payslip; mistakes are voided with a reason, never deleted.
--   * Employee ID (required before Finalize, unique case-insensitive, 1-30 letters/digits/hyphens) and
--     hire date (optional) on staff_payroll_details; a new 5-argument save_staff_payroll_details. The
--     3-argument one is unchanged.
--   * Cash bond: the payslip of the month containing the hire date holds floor(net pay / 2) to the
--     centavo (not when ticked "Final pay"); the next month's payslip releases it, or earlier a payslip
--     ticked "Final pay". All decided server-side in the new 4-argument finalize_payslip; the
--     3-argument finalize_payslip becomes a thin wrapper (final pay = false). The 4th argument has NO
--     default: a default would make every 3-argument call ambiguous ("function is not unique").
--   * payslips gets the snapshot / advance / bond columns plus two GENERATED columns (net_pay_php,
--     amount_due_php). Existing rows are not updated. payslips_before_write leaves the two generated
--     columns out of its frozen-row comparison: in a BEFORE UPDATE trigger they read as NULL in NEW,
--     and they are computed only from frozen columns, so every column stays frozen.
--   * Pay settings history (timesheet_pay_settings): a CSR's basic salary and allowance per month
--     (latest row with effective_from <= the 1st of the month; profile values as the fallback). Written
--     only by set_timesheet_pay_setting (admin). finalize_payslip refuses a CSR payload whose basic /
--     allowance differ from the settings in force (pay_settings_mismatch).
--   * April-May 2026: payslips, cash advances and timesheet corrections from 2026-04-01 (was
--     2026-06-01). get_payslip_book also lists INACTIVE profiles with entries in the month's 31-row
--     window, and finalize accepts them.
--   * get_payslip_book returns "features" so the frontend (released first) can tell this migration is
--     applied.
--
--   Function bodies replaced here start from live: each full replace is guarded by the md5 of its
--   live prosrc (read from the live-identical migrations 20270201100000 / 20270202100000, verified
--   byte-identical to live 2026-10-26) and STOPs if live has moved. Re-runnable: an already-applied
--   body is recognised and left alone by the guard, tables/columns use IF NOT EXISTS, policies and
--   constraints are catalog-checked. No comment lines inside any function body (Lovable strips them).

SET lock_timeout = '15s';

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Guards: every function this migration REPLACES must still be the live body we started from
--    (or already this migration's body, on a re-run).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.cj_guard(p_sig text, p_live_md5 text, p_marker text)
RETURNS void LANGUAGE plpgsql AS $g$
DECLARE
  v_fn  regprocedure := to_regprocedure(p_sig);
  v_src text;
BEGIN
  IF v_fn IS NULL THEN
    RAISE EXCEPTION 'STOP - % is not on this database; nothing changed', p_sig;
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_fn;
  IF md5(v_src) = p_live_md5 THEN RETURN; END IF;
  IF position(p_marker IN v_src) > 0 THEN
    RAISE NOTICE '% already replaced by this migration', p_sig;
    RETURN;
  END IF;
  RAISE EXCEPTION 'STOP - % has moved on live (prosrc md5 %); re-read it before replacing. Nothing changed.', p_sig, md5(v_src);
END;
$g$;

SELECT pg_temp.cj_guard('public.payslips_before_write()', '9fea0e493f6d9b512fafbf4d47afedb4', 'v_gen');
SELECT pg_temp.cj_guard('public.get_payslip_book(date)', 'a7adebb71b87d8bc25ebd9ac82465f70', 'from_april');
SELECT pg_temp.cj_guard('public.finalize_payslip(uuid,date,jsonb)', '52490497e5c71b9aba0e77d97c5da99f', 'p_payload, false');
SELECT pg_temp.cj_guard('public.correct_timesheet_day(uuid,date,timestamptz,timestamptz,timestamptz,timestamptz,text)',
                        '94d7c032775ebdcdd588ab9b2077f56b', 'DATE ''2026-04-01''');

-- ---------------------------------------------------------------------------
-- 1. Pay settings history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timesheet_pay_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL,
  effective_from  date NOT NULL CHECK (effective_from = date_trunc('month', effective_from)::date),
  basic_salary    numeric(12,2) NULL CHECK (basic_salary IS NULL OR basic_salary >= 0),
  allowance       numeric(12,2) NULL CHECK (allowance IS NULL OR allowance >= 0),
  note            text NULL CHECK (note IS NULL OR (length(note) BETWEEN 1 AND 200 AND note = btrim(note))),
  created_by      uuid NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid NULL,
  updated_at      timestamptz NULL,
  CONSTRAINT timesheet_pay_settings_user_month_key UNIQUE (user_id, effective_from)
);
ALTER TABLE public.timesheet_pay_settings ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.timesheet_pay_settings IS
  'CSR basic salary / allowance history (owner 2026-10-27). A month uses the latest row with effective_from <= its 1st; a null field, or no row, falls back to timesheet_profiles. Written only by set_timesheet_pay_setting (admin, audited without amounts); never deleted.';

DROP POLICY IF EXISTS timesheet_pay_settings_read ON public.timesheet_pay_settings;
CREATE POLICY timesheet_pay_settings_read ON public.timesheet_pay_settings
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::app_role))
      OR (SELECT public.has_role((SELECT auth.uid()), 'finance'::app_role))
      OR (SELECT public.timesheet_can_view_all((SELECT auth.uid())))
      OR user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.timesheet_pay_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.timesheet_pay_settings FROM anon;
GRANT SELECT ON public.timesheet_pay_settings TO authenticated;
GRANT ALL ON public.timesheet_pay_settings TO service_role;

CREATE OR REPLACE FUNCTION public.timesheet_pay_settings_refuse_delete()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'pay settings are history and are never deleted (% refused)', TG_OP USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.timesheet_pay_settings_refuse_delete() IS
  'BEFORE DELETE (row) and BEFORE TRUNCATE (statement) on timesheet_pay_settings: always refused.';
REVOKE ALL ON FUNCTION public.timesheet_pay_settings_refuse_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS timesheet_pay_settings_refuse_delete ON public.timesheet_pay_settings;
CREATE TRIGGER timesheet_pay_settings_refuse_delete
  BEFORE DELETE ON public.timesheet_pay_settings
  FOR EACH ROW EXECUTE FUNCTION public.timesheet_pay_settings_refuse_delete();
DROP TRIGGER IF EXISTS timesheet_pay_settings_refuse_truncate ON public.timesheet_pay_settings;
CREATE TRIGGER timesheet_pay_settings_refuse_truncate
  BEFORE TRUNCATE ON public.timesheet_pay_settings
  FOR EACH STATEMENT EXECUTE FUNCTION public.timesheet_pay_settings_refuse_delete();

-- ---------------------------------------------------------------------------
-- 2. Staff details: employee ID + hire date.
-- ---------------------------------------------------------------------------
ALTER TABLE public.staff_payroll_details
  ADD COLUMN IF NOT EXISTS employee_id text NULL
    CONSTRAINT staff_payroll_details_employee_id_check CHECK (employee_id IS NULL OR employee_id ~ '^[A-Za-z0-9-]{1,30}$'),
  ADD COLUMN IF NOT EXISTS hire_date date NULL
    CONSTRAINT staff_payroll_details_hire_date_check CHECK (hire_date IS NULL OR hire_date >= DATE '2020-01-01');
CREATE UNIQUE INDEX IF NOT EXISTS staff_payroll_details_employee_id_key
  ON public.staff_payroll_details (upper(employee_id)) WHERE employee_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Payslip columns. ADD COLUMN fires no row trigger; existing rows read cash_advances [],
--    advances 0, bond 0, is_final_pay false, net_pay_php = amount_due_php = total_php.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS employee_id text NULL,
  ADD COLUMN IF NOT EXISTS hire_date date NULL,
  ADD COLUMN IF NOT EXISTS cash_advances jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS cash_advance_php numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_final_pay boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cash_bond_held_php numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_bond_released_php numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_bond_source_payslip_id uuid NULL REFERENCES public.payslips (id);
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS net_pay_php numeric(14,2) GENERATED ALWAYS AS (total_php - cash_advance_php) STORED,
  ADD COLUMN IF NOT EXISTS amount_due_php numeric(14,2)
    GENERATED ALWAYS AS (total_php - cash_advance_php - cash_bond_held_php + cash_bond_released_php) STORED;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_cash_advances_array') THEN
    ALTER TABLE public.payslips ADD CONSTRAINT payslips_cash_advances_array CHECK (jsonb_typeof(cash_advances) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_cash_advance_range') THEN
    ALTER TABLE public.payslips ADD CONSTRAINT payslips_cash_advance_range CHECK (cash_advance_php >= 0 AND cash_advance_php <= total_php);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_cash_bond_held_range') THEN
    ALTER TABLE public.payslips ADD CONSTRAINT payslips_cash_bond_held_range
      CHECK (cash_bond_held_php >= 0 AND cash_bond_held_php <= total_php - cash_advance_php);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_cash_bond_released') THEN
    ALTER TABLE public.payslips ADD CONSTRAINT payslips_cash_bond_released
      CHECK (cash_bond_released_php >= 0 AND (cash_bond_source_payslip_id IS NULL) = (cash_bond_released_php = 0));
  END IF;
END
$c$;
CREATE UNIQUE INDEX IF NOT EXISTS payslips_one_live_bond_release
  ON public.payslips (cash_bond_source_payslip_id) WHERE status <> 'void' AND cash_bond_source_payslip_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.payslips_before_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_pay  text[] := ARRAY['status', 'jpy_sent', 'php_received', 'php_per_jpy', 'paid_on', 'proof_path', 'paid_by', 'paid_at'];
  v_void text[] := ARRAY['status', 'voided_by', 'voided_at', 'void_reason'];
  v_gen  text[] := ARRAY['net_pay_php', 'amount_due_php'];
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
    IF (to_jsonb(NEW) - v_pay - v_gen) IS DISTINCT FROM (to_jsonb(OLD) - v_pay - v_gen) THEN
      RAISE EXCEPTION 'recording a payment changes the payment fields only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('finalized', 'paid') AND NEW.status = 'void' THEN
    IF (to_jsonb(NEW) - v_void - v_gen) IS DISTINCT FROM (to_jsonb(OLD) - v_void - v_gen) THEN
      RAISE EXCEPTION 'voiding a payslip changes the void fields only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a payslip is locked: it can only be marked paid (from finalized) or voided'
    USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslips_before_write() IS
  'BEFORE INSERT/UPDATE/DELETE on payslips. Insert must be finalized with no payment/void fields. Update allowed only finalized -> paid (payment fields only) and finalized|paid -> void (void fields only); snapshot, figure, advance and cash-bond columns never change (the generated net_pay_php / amount_due_php are left out of the comparison: they read NULL in a BEFORE trigger and derive only from frozen columns). DELETE always refused.';
REVOKE ALL ON FUNCTION public.payslips_before_write() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Cash advances.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payslip_cash_advances (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  pay_month     date NOT NULL CHECK (pay_month = date_trunc('month', pay_month)::date),
  advance_date  date NOT NULL,
  amount_php    numeric(14,2) NOT NULL CHECK (amount_php > 0),
  note          text NOT NULL CHECK (length(note) BETWEEN 1 AND 200 AND note = btrim(note)),
  proof_path    text NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason   text NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_by     uuid NULL,
  voided_at     timestamptz NULL,
  payslip_id    uuid NULL REFERENCES public.payslips (id),
  CONSTRAINT payslip_cash_advances_proof_path CHECK (proof_path IS NULL OR proof_path LIKE 'advances/' || id::text || '/%'),
  CONSTRAINT payslip_cash_advances_void_fields CHECK (
    (status = 'void' AND voided_by IS NOT NULL AND voided_at IS NOT NULL
       AND length(btrim(coalesce(void_reason, ''))) BETWEEN 3 AND 500)
    OR (status = 'active' AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS payslip_cash_advances_user_month_idx ON public.payslip_cash_advances (user_id, pay_month);
ALTER TABLE public.payslip_cash_advances ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.payslip_cash_advances IS
  'Cash advances deducted on a payslip (owner 2026-10-27): one row per advance (date, amount, note, optional proof advances/<id>/<file>). Added / proof attached / voided only while the staff month has no non-void payslip; finalize copies the active ones into payslips.cash_advances and sets payslip_id. Never deleted. Written only through add_cash_advance / attach_cash_advance_proof / void_cash_advance / finalize_payslip.';

DROP POLICY IF EXISTS payslip_cash_advances_read ON public.payslip_cash_advances;
CREATE POLICY payslip_cash_advances_read ON public.payslip_cash_advances
  FOR SELECT TO authenticated
  USING ((SELECT public.can_manage_payslips((SELECT auth.uid()))));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payslip_cash_advances FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payslip_cash_advances FROM anon;
GRANT SELECT ON public.payslip_cash_advances TO authenticated;
GRANT ALL ON public.payslip_cash_advances TO service_role;

CREATE OR REPLACE FUNCTION public.payslip_cash_advances_before_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_void text[] := ARRAY['status', 'void_reason', 'voided_by', 'voided_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'cash advances are never deleted; void the advance instead' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.payslip_id IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a cash advance starts as active, with no payslip' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND OLD.proof_path IS NULL AND NEW.proof_path IS NOT NULL
     AND (to_jsonb(NEW) - 'proof_path') = (to_jsonb(OLD) - 'proof_path') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND NEW.status = 'void'
     AND (to_jsonb(NEW) - v_void) = (to_jsonb(OLD) - v_void) THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND NEW.payslip_id IS NOT NULL AND NEW.payslip_id IS DISTINCT FROM OLD.payslip_id
     AND (to_jsonb(NEW) - 'payslip_id') = (to_jsonb(OLD) - 'payslip_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a cash advance is locked: a proof can be attached once, it can be voided, or linked to its payslip'
    USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslip_cash_advances_before_write() IS
  'BEFORE INSERT/UPDATE/DELETE on payslip_cash_advances. Insert must be active with no payslip. Update allowed only on an active advance and only: proof_path null -> set (nothing else), active -> void (void fields only), payslip_id set to a new payslip (nothing else). DELETE always refused.';
REVOKE ALL ON FUNCTION public.payslip_cash_advances_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payslip_cash_advances_before_write ON public.payslip_cash_advances;
CREATE TRIGGER payslip_cash_advances_before_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.payslip_cash_advances
  FOR EACH ROW EXECUTE FUNCTION public.payslip_cash_advances_before_write();

CREATE OR REPLACE FUNCTION public.payslip_cash_advances_refuse_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'cash advances are never deleted (TRUNCATE refused)' USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslip_cash_advances_refuse_truncate() IS
  'BEFORE TRUNCATE on payslip_cash_advances: always refused.';
REVOKE ALL ON FUNCTION public.payslip_cash_advances_refuse_truncate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payslip_cash_advances_refuse_truncate ON public.payslip_cash_advances;
CREATE TRIGGER payslip_cash_advances_refuse_truncate
  BEFORE TRUNCATE ON public.payslip_cash_advances
  FOR EACH STATEMENT EXECUTE FUNCTION public.payslip_cash_advances_refuse_truncate();

-- ---------------------------------------------------------------------------
-- 5. RPCs. jsonb {ok: true, ...} or {error: <code>}; raw database errors never reach the caller.
-- ---------------------------------------------------------------------------

-- set_timesheet_pay_setting: admin only; upsert one month's CSR basic salary / allowance.
CREATE OR REPLACE FUNCTION public.set_timesheet_pay_setting(p_user_id uuid, p_effective_from date,
                                                            p_basic_salary numeric, p_allowance numeric, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_month   date := date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date)::date;
  v_note    text := nullif(btrim(coalesce(p_note, '')), '');
  v_profile public.timesheet_profiles%ROWTYPE;
  v_issued  date;
  v_row     public.timesheet_pay_settings%ROWTYPE;
  v_existed boolean;
  v_synced  boolean := false;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_profile FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id;
  IF p_user_id IS NULL OR NOT FOUND THEN RETURN jsonb_build_object('error', 'staff_not_found'); END IF;
  IF v_profile.template_type <> 'csr' THEN RETURN jsonb_build_object('error', 'not_csr'); END IF;
  IF p_effective_from IS NULL OR p_effective_from <> date_trunc('month', p_effective_from)::date
     OR p_effective_from < DATE '2026-04-01' OR p_effective_from > (v_month + interval '12 months')::date THEN
    RETURN jsonb_build_object('error', 'invalid_month');
  END IF;
  IF (p_basic_salary IS NULL AND p_allowance IS NULL)
     OR (p_basic_salary IS NOT NULL AND (p_basic_salary < 0 OR p_basic_salary > 10000000 OR p_basic_salary <> round(p_basic_salary, 2)))
     OR (p_allowance IS NOT NULL AND (p_allowance < 0 OR p_allowance > 10000000 OR p_allowance <> round(p_allowance, 2))) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 200 THEN RETURN jsonb_build_object('error', 'invalid_note'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payslip-bond:' || p_user_id::text, 0));
  SELECT min(p.pay_month) INTO v_issued FROM public.payslips p
   WHERE p.user_id = p_user_id AND p.status <> 'void' AND p.pay_month >= p_effective_from;
  IF v_issued IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'payslips_issued', 'month', v_issued);
  END IF;

  v_existed := EXISTS (SELECT 1 FROM public.timesheet_pay_settings s
                        WHERE s.user_id = p_user_id AND s.effective_from = p_effective_from);
  INSERT INTO public.timesheet_pay_settings (user_id, effective_from, basic_salary, allowance, note, created_by, created_at)
  VALUES (p_user_id, p_effective_from, p_basic_salary, p_allowance, v_note, v_uid, now())
  ON CONFLICT (user_id, effective_from) DO UPDATE
     SET basic_salary = EXCLUDED.basic_salary, allowance = EXCLUDED.allowance, note = EXCLUDED.note,
         updated_by = v_uid, updated_at = now()
  RETURNING * INTO v_row;

  IF p_effective_from <= v_month
     AND NOT EXISTS (SELECT 1 FROM public.timesheet_pay_settings s
                      WHERE s.user_id = p_user_id AND s.effective_from > p_effective_from AND s.effective_from <= v_month) THEN
    UPDATE public.timesheet_profiles
       SET basic_salary = coalesce(p_basic_salary, basic_salary), allowance = coalesce(p_allowance, allowance)
     WHERE user_id = p_user_id;
    v_synced := true;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('timesheet_pay_setting', v_row.id, 'set_timesheet_pay_setting',
          jsonb_build_object('user_id', p_user_id, 'effective_from', p_effective_from, 'created', NOT v_existed,
                             'profile_synced', v_synced),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'setting', to_jsonb(v_row), 'profile_synced', v_synced);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_timesheet_pay_setting(uuid, date, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_timesheet_pay_setting(uuid, date, numeric, numeric, text) TO authenticated;
COMMENT ON FUNCTION public.set_timesheet_pay_setting(uuid, date, numeric, numeric, text) IS
  'Admin only. Upserts a CSR''s basic salary / allowance from p_effective_from (first of month, 2026-04 .. 12 months after this month, Manila); a null field keeps the profile value. Refuses permission_denied, staff_not_found, not_csr, invalid_month, invalid_amount (both null, negative, > 2 decimals), invalid_note (> 200), payslips_issued (a non-void payslip in that month or later; void it first). When the row is the latest one in force this month it also updates timesheet_profiles. One audit_logs row (no amounts).';

-- save_staff_payroll_details (5 arguments): the 3-argument rules plus employee ID and hire date.
CREATE OR REPLACE FUNCTION public.save_staff_payroll_details(p_user_id uuid, p_address text, p_date_of_birth date,
                                                             p_employee_id text, p_hire_date date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_today   date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_address text := nullif(btrim(coalesce(p_address, '')), '');
  v_emp     text := nullif(btrim(coalesce(p_employee_id, '')), '');
  v_old     public.staff_payroll_details%ROWTYPE;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id) THEN
    RETURN jsonb_build_object('error', 'staff_not_found');
  END IF;
  IF v_address IS NOT NULL AND length(v_address) > 500 THEN RETURN jsonb_build_object('error', 'invalid_address'); END IF;
  IF p_date_of_birth IS NOT NULL AND (p_date_of_birth < DATE '1900-01-01' OR p_date_of_birth > v_today) THEN
    RETURN jsonb_build_object('error', 'invalid_date_of_birth');
  END IF;
  IF v_emp IS NOT NULL AND v_emp !~ '^[A-Za-z0-9-]{1,30}$' THEN RETURN jsonb_build_object('error', 'invalid_employee_id'); END IF;
  IF p_hire_date IS NOT NULL AND (p_hire_date < DATE '2020-01-01' OR p_hire_date > (v_today + interval '1 year')::date) THEN
    RETURN jsonb_build_object('error', 'invalid_hire_date');
  END IF;
  IF v_emp IS NOT NULL AND EXISTS (SELECT 1 FROM public.staff_payroll_details d
                                    WHERE upper(d.employee_id) = upper(v_emp) AND d.user_id <> p_user_id) THEN
    RETURN jsonb_build_object('error', 'employee_id_taken');
  END IF;

  SELECT * INTO v_old FROM public.staff_payroll_details WHERE user_id = p_user_id FOR UPDATE;
  IF v_old.address IS DISTINCT FROM v_address THEN v_changed := array_append(v_changed, 'address'); END IF;
  IF v_old.date_of_birth IS DISTINCT FROM p_date_of_birth THEN v_changed := array_append(v_changed, 'date_of_birth'); END IF;
  IF v_old.employee_id IS DISTINCT FROM v_emp THEN v_changed := array_append(v_changed, 'employee_id'); END IF;
  IF v_old.hire_date IS DISTINCT FROM p_hire_date THEN v_changed := array_append(v_changed, 'hire_date'); END IF;
  IF cardinality(v_changed) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'changed', '[]'::jsonb);
  END IF;

  BEGIN
    INSERT INTO public.staff_payroll_details (user_id, address, date_of_birth, employee_id, hire_date, updated_by, updated_at)
    VALUES (p_user_id, v_address, p_date_of_birth, v_emp, p_hire_date, v_uid, now())
    ON CONFLICT (user_id) DO UPDATE
       SET address = EXCLUDED.address, date_of_birth = EXCLUDED.date_of_birth, employee_id = EXCLUDED.employee_id,
           hire_date = EXCLUDED.hire_date, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'employee_id_taken');
  END;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('staff_payroll_details', p_user_id, 'save_staff_payroll_details',
          jsonb_build_object('changed_fields', to_jsonb(v_changed), 'created', v_old.user_id IS NULL),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'changed', to_jsonb(v_changed));
END
$fn$;
REVOKE ALL ON FUNCTION public.save_staff_payroll_details(uuid, text, date, text, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_staff_payroll_details(uuid, text, date, text, date) TO authenticated;
COMMENT ON FUNCTION public.save_staff_payroll_details(uuid, text, date, text, date) IS
  'Saves address, date of birth (as the 3-argument version), employee ID (trimmed, empty clears, 1-30 letters/digits/hyphens, unique ignoring case) and hire date (2020-01-01 .. one year after today Japan time; null clears). Refuses permission_denied, staff_not_found, invalid_address, invalid_date_of_birth, invalid_employee_id, employee_id_taken, invalid_hire_date. One audit_logs row naming the changed fields only.';

-- add_cash_advance: one advance for a staff month that has no non-void payslip yet.
CREATE OR REPLACE FUNCTION public.add_cash_advance(p_user_id uuid, p_pay_month date, p_advance_date date,
                                                   p_amount_php numeric, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_note  text := btrim(coalesce(p_note, ''));
  v_new   public.payslip_cash_advances%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id) THEN
    RETURN jsonb_build_object('error', 'staff_not_found');
  END IF;
  IF p_pay_month IS NULL OR p_pay_month <> date_trunc('month', p_pay_month)::date
     OR p_pay_month < DATE '2026-04-01' OR p_pay_month > date_trunc('month', v_today)::date THEN
    RETURN jsonb_build_object('error', 'invalid_month');
  END IF;
  IF p_advance_date IS NULL OR p_advance_date > v_today
     OR p_advance_date < (date_trunc('month', v_today) - interval '1 month')::date THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  IF p_amount_php IS NULL OR p_amount_php <= 0 OR p_amount_php > 10000000 OR p_amount_php <> round(p_amount_php, 2) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF length(v_note) = 0 THEN RETURN jsonb_build_object('error', 'note_required'); END IF;
  IF length(v_note) > 200 THEN RETURN jsonb_build_object('error', 'note_too_long'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payslip:' || p_user_id::text || ':' || p_pay_month::text, 0));
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = p_user_id AND p.pay_month = p_pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'month_finalized');
  END IF;

  INSERT INTO public.payslip_cash_advances (user_id, pay_month, advance_date, amount_php, note, status, created_by, created_at)
  VALUES (p_user_id, p_pay_month, p_advance_date, p_amount_php, v_note, 'active', v_uid, now())
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip_cash_advance', v_new.id, 'add_cash_advance',
          jsonb_build_object('user_id', p_user_id, 'pay_month', p_pay_month, 'status', 'active'),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'advance', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.add_cash_advance(uuid, date, date, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_cash_advance(uuid, date, date, numeric, text) TO authenticated;
COMMENT ON FUNCTION public.add_cash_advance(uuid, date, date, numeric, text) IS
  'Adds a cash advance (deducted on the payslip) for p_pay_month (first of month, 2026-04 .. this month Japan time) of a staff member with a timesheet profile (active or not). advance_date from the 1st of the previous month to today Japan time; amount > 0 with 2 decimals; note 1-200 characters. Refuses permission_denied, staff_not_found, invalid_month, invalid_date, invalid_amount, note_required, note_too_long, month_finalized (a non-void payslip exists; same lock as finalize). One audit_logs row (no amount, no note).';

-- attach_cash_advance_proof: the one optional proof of an active advance.
CREATE OR REPLACE FUNCTION public.attach_cash_advance_proof(p_id uuid, p_path text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_path text := btrim(coalesce(p_path, ''));
  v_old  public.payslip_cash_advances%ROWTYPE;
  v_new  public.payslip_cash_advances%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_old FROM public.payslip_cash_advances WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payslip:' || v_old.user_id::text || ':' || v_old.pay_month::text, 0));
  SELECT * INTO v_old FROM public.payslip_cash_advances WHERE id = p_id FOR UPDATE;
  IF v_old.status <> 'active' THEN RETURN jsonb_build_object('error', 'advance_void'); END IF;
  IF v_old.proof_path IS NOT NULL THEN RETURN jsonb_build_object('error', 'proof_already_attached'); END IF;
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = v_old.user_id AND p.pay_month = v_old.pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'month_finalized');
  END IF;
  IF v_path = '' THEN RETURN jsonb_build_object('error', 'proof_required'); END IF;
  IF v_path NOT LIKE 'advances/' || p_id::text || '/%' OR length(split_part(v_path, '/', 3)) = 0
     OR split_part(v_path, '/', 4) <> '' OR v_path LIKE '%..%' OR length(v_path) > 300 THEN
    RETURN jsonb_build_object('error', 'invalid_proof_path');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payslip-proofs' AND o.name = v_path) THEN
    RETURN jsonb_build_object('error', 'proof_missing');
  END IF;

  UPDATE public.payslip_cash_advances SET proof_path = v_path WHERE id = p_id RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip_cash_advance', p_id, 'attach_cash_advance_proof',
          jsonb_build_object('user_id', v_old.user_id, 'pay_month', v_old.pay_month, 'proof_attached', true),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'advance', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.attach_cash_advance_proof(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_cash_advance_proof(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.attach_cash_advance_proof(uuid, text) IS
  'Attaches the proof advances/<p_id>/<file> (already uploaded to payslip-proofs) to an ACTIVE advance with no proof whose month has no non-void payslip. Refuses permission_denied, not_found, advance_void, proof_already_attached, month_finalized, proof_required, invalid_proof_path, proof_missing. One audit_logs row.';

-- void_cash_advance: active -> void with a reason, while the month is not finalized.
CREATE OR REPLACE FUNCTION public.void_cash_advance(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    public.payslip_cash_advances%ROWTYPE;
  v_new    public.payslip_cash_advances%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_old FROM public.payslip_cash_advances WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payslip:' || v_old.user_id::text || ':' || v_old.pay_month::text, 0));
  SELECT * INTO v_old FROM public.payslip_cash_advances WHERE id = p_id FOR UPDATE;
  IF v_old.status = 'void' THEN RETURN jsonb_build_object('error', 'already_void'); END IF;
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = v_old.user_id AND p.pay_month = v_old.pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'month_finalized');
  END IF;

  UPDATE public.payslip_cash_advances
     SET status = 'void', void_reason = v_reason, voided_by = v_uid, voided_at = now()
   WHERE id = p_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip_cash_advance', p_id, 'void_cash_advance',
          jsonb_build_object('status', 'active'),
          jsonb_build_object('user_id', v_old.user_id, 'pay_month', v_old.pay_month, 'status', 'void'),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'advance', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.void_cash_advance(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_cash_advance(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.void_cash_advance(uuid, text) IS
  'Voids an active cash advance with a reason (3-500 characters) while its month has no non-void payslip; never deletes. Refuses permission_denied, reason_required, not_found, already_void, month_finalized. One audit_logs row (no amount, note or reason).';

-- get_payslip_book(p_pay_month): everything the Payslips tab needs for one month.
CREATE OR REPLACE FUNCTION public.get_payslip_book(p_pay_month date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_month date;
  v_rate  numeric;
  v_staff uuid[];
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_pay_month IS NULL THEN RETURN jsonb_build_object('error', 'invalid_month'); END IF;
  v_month := date_trunc('month', p_pay_month)::date;
  SELECT CASE WHEN (s.value #>> '{}') ~ '^[0-9]*\.?[0-9]+$' THEN (s.value #>> '{}')::numeric END
    INTO v_rate FROM public.system_settings s WHERE s.key = 'php_jpy_rate';
  SELECT coalesce(array_agg(tp.user_id), ARRAY[]::uuid[]) INTO v_staff
    FROM public.timesheet_profiles tp
   WHERE tp.active
      OR EXISTS (SELECT 1 FROM public.timesheet_entries e
                  WHERE e.user_id = tp.user_id AND e.work_date BETWEEN v_month AND v_month + 30);

  RETURN jsonb_build_object(
    'ok', true,
    'month', v_month,
    'can_manage', true,
    'php_jpy_rate', v_rate,
    'features', jsonb_build_object('cash_advances', true, 'employee_id', true, 'cash_bond', true,
                                   'pay_history', true, 'from_april', true),
    'payslips', coalesce((
      SELECT jsonb_agg(to_jsonb(p) || jsonb_build_object('cash_bond_source_month', src.pay_month)
                       ORDER BY p.staff_name, p.created_at)
        FROM public.payslips p
        LEFT JOIN public.payslips src ON src.id = p.cash_bond_source_payslip_id
       WHERE p.pay_month = v_month), '[]'::jsonb),
    'details', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'user_id', tp.user_id, 'address', d.address, 'date_of_birth', d.date_of_birth, 'updated_at', d.updated_at,
               'employee_id', d.employee_id, 'hire_date', d.hire_date, 'active', tp.active,
               'first_month_issued', CASE WHEN d.hire_date IS NULL THEN NULL ELSE EXISTS (
                   SELECT 1 FROM public.payslips f
                    WHERE f.user_id = tp.user_id AND f.pay_month = date_trunc('month', d.hire_date)::date
                      AND f.status <> 'void') END,
               'cash_bond_pending', (
                 SELECT jsonb_build_object('source_payslip_id', s.id, 'pay_month', s.pay_month, 'amount', s.cash_bond_held_php)
                   FROM public.payslips s
                  WHERE s.user_id = tp.user_id AND s.status <> 'void' AND s.cash_bond_held_php > 0
                    AND NOT EXISTS (SELECT 1 FROM public.payslips r
                                     WHERE r.cash_bond_source_payslip_id = s.id AND r.status <> 'void')
                  ORDER BY s.pay_month DESC LIMIT 1)))
        FROM public.timesheet_profiles tp
        LEFT JOIN public.staff_payroll_details d ON d.user_id = tp.user_id
       WHERE tp.user_id = ANY (v_staff)), '[]'::jsonb),
    'cash_advances', coalesce((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC)
        FROM public.payslip_cash_advances a WHERE a.pay_month = v_month), '[]'::jsonb),
    'pay_settings', coalesce((
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.user_id, s.effective_from)
        FROM public.timesheet_pay_settings s WHERE s.user_id = ANY (v_staff)), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_payslip_book(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payslip_book(date) TO authenticated;
COMMENT ON FUNCTION public.get_payslip_book(date) IS
  'Timesheet -> Payslips: every payslip of the month (all statuses, each with cash_bond_source_month); the payroll details (address, date of birth, employee ID, hire date, first_month_issued, cash_bond_pending) of every active timesheet profile and of every inactive one with entries in the month''s 31-row window; the month''s cash advances (all statuses, newest first); those staff members'' pay settings; the one peso rate; can_manage; features. Needs the payslip gate.';

-- finalize_payslip (4 arguments): freeze one staff member's payslip, with advances and cash bond.
CREATE OR REPLACE FUNCTION public.finalize_payslip(p_user_id uuid, p_pay_month date, p_payload jsonb, p_is_final_pay boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_today    date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_final    boolean := coalesce(p_is_final_pay, false);
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
  v_first    date;
  v_basic    numeric;
  v_allow    numeric;
  v_adv      jsonb;
  v_adv_sum  numeric;
  v_held     numeric := 0;
  v_released numeric := 0;
  v_source   uuid;
  v_pending  public.payslips%ROWTYPE;
  v_new      public.payslips%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_pay_month IS NULL OR p_pay_month <> date_trunc('month', p_pay_month)::date
     OR p_pay_month < DATE '2026-04-01' OR p_pay_month > date_trunc('month', v_today)::date THEN
    RETURN jsonb_build_object('error', 'invalid_month');
  END IF;
  SELECT * INTO v_profile FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id;
  IF p_user_id IS NULL OR NOT FOUND THEN RETURN jsonb_build_object('error', 'staff_not_found'); END IF;
  IF v_profile.template_type NOT IN ('csr', 'live_admin') THEN RETURN jsonb_build_object('error', 'staff_not_found'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payslip-bond:' || p_user_id::text, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('payslip:' || p_user_id::text || ':' || p_pay_month::text, 0));
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = p_user_id AND p.pay_month = p_pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'already_issued');
  END IF;

  SELECT nullif(btrim(pr.full_name), '') INTO v_name FROM public.profiles pr WHERE pr.user_id = p_user_id LIMIT 1;
  IF v_name IS NULL THEN RETURN jsonb_build_object('error', 'name_missing'); END IF;
  SELECT * INTO v_details FROM public.staff_payroll_details d WHERE d.user_id = p_user_id;
  IF v_details.address IS NULL OR v_details.date_of_birth IS NULL OR v_details.employee_id IS NULL THEN
    RETURN jsonb_build_object('error', 'details_missing');
  END IF;

  v_first := date_trunc('month', v_details.hire_date)::date;
  IF v_first IS NOT NULL AND v_first >= DATE '2026-04-01' AND p_pay_month > v_first
     AND NOT EXISTS (SELECT 1 FROM public.payslips f
                      WHERE f.user_id = p_user_id AND f.pay_month = v_first AND f.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'cash_bond_order', 'first_month', v_first);
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
    SELECT round(coalesce(s.basic_salary, v_profile.basic_salary, 0), 2), round(coalesce(s.allowance, v_profile.allowance, 0), 2)
      INTO v_basic, v_allow
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (SELECT ps.basic_salary, ps.allowance FROM public.timesheet_pay_settings ps
                          WHERE ps.user_id = p_user_id AND ps.effective_from <= p_pay_month
                          ORDER BY ps.effective_from DESC LIMIT 1) s ON true;
    IF (v_ts ->> 'basic_salary')::numeric <> v_basic OR (v_ts ->> 'monthly_allowance')::numeric <> v_allow THEN
      RETURN jsonb_build_object('error', 'pay_settings_mismatch');
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

  SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'advance_date', a.advance_date, 'amount_php', a.amount_php,
                                               'note', a.note, 'proof_path', a.proof_path)
                            ORDER BY a.advance_date, a.created_at), '[]'::jsonb),
         coalesce(sum(a.amount_php), 0)
    INTO v_adv, v_adv_sum
    FROM public.payslip_cash_advances a
   WHERE a.user_id = p_user_id AND a.pay_month = p_pay_month AND a.status = 'active';
  IF v_adv_sum > v_total THEN RETURN jsonb_build_object('error', 'advance_exceeds_pay'); END IF;

  IF v_first IS NOT NULL AND v_first = p_pay_month AND NOT v_final THEN
    v_held := floor((v_total - v_adv_sum) * 50) / 100;
  ELSE
    SELECT s.* INTO v_pending
      FROM public.payslips s
     WHERE s.user_id = p_user_id AND s.status <> 'void' AND s.cash_bond_held_php > 0 AND s.pay_month < p_pay_month
       AND NOT EXISTS (SELECT 1 FROM public.payslips r
                        WHERE r.cash_bond_source_payslip_id = s.id AND r.status <> 'void')
     ORDER BY s.pay_month DESC LIMIT 1;
    IF FOUND AND (p_pay_month = (v_pending.pay_month + interval '1 month')::date OR v_final) THEN
      v_released := v_pending.cash_bond_held_php;
      v_source := v_pending.id;
    END IF;
  END IF;

  INSERT INTO public.payslips (user_id, pay_month, status, staff_name, address, date_of_birth, job_title, template_type,
                               timesheet, commission, timesheet_net_php, commission_php, total_php, finalized_by, finalized_at,
                               employee_id, hire_date, cash_advances, cash_advance_php, is_final_pay,
                               cash_bond_held_php, cash_bond_released_php, cash_bond_source_payslip_id)
  VALUES (p_user_id, p_pay_month, 'finalized', v_name, v_details.address, v_details.date_of_birth,
          nullif(btrim(coalesce(v_profile.job_title, '')), ''), v_profile.template_type,
          v_ts, v_cm, v_ts_net, v_cm_total, v_total, v_uid, now(),
          v_details.employee_id, v_details.hire_date, v_adv, v_adv_sum, v_final,
          v_held, v_released, v_source)
  RETURNING * INTO v_new;

  UPDATE public.payslip_cash_advances SET payslip_id = v_new.id
   WHERE user_id = p_user_id AND pay_month = p_pay_month AND status = 'active';

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip', v_new.id, 'finalize_payslip',
          jsonb_build_object('user_id', p_user_id, 'pay_month', p_pay_month, 'status', 'finalized',
                             'is_final_pay', v_final, 'advances', jsonb_array_length(v_adv),
                             'cash_bond', CASE WHEN v_held > 0 THEN 'held' WHEN v_source IS NOT NULL THEN 'released' ELSE 'none' END),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'payslip', to_jsonb(v_new));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'already_issued');
END
$fn$;
REVOKE ALL ON FUNCTION public.finalize_payslip(uuid, date, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_payslip(uuid, date, jsonb, boolean) TO authenticated;
COMMENT ON FUNCTION public.finalize_payslip(uuid, date, jsonb, boolean) IS
  'Freezes a staff member''s payslip for p_pay_month (first of month, 2026-04 .. this month Japan time; the profile may be inactive). Name, job title, template, address, date of birth, employee ID and hire date are copied server-side; breakdowns rebuilt from known keys; a CSR''s basic_salary / monthly_allowance must equal the pay settings in force (else profile). The month''s ACTIVE cash advances are copied into cash_advances and deducted (cash_advance_php) and linked to the payslip. Cash bond: the hire month holds floor(net/2) to the centavo unless p_is_final_pay; otherwise a pending bond is released on its month + 1 or on a final-pay payslip. Refuses permission_denied, invalid_month, staff_not_found, already_issued, name_missing, details_missing (address, date of birth or employee ID), cash_bond_order (the first-month payslip is not issued yet), invalid_figures, invalid_totals, pay_settings_mismatch, advance_exceeds_pay. No default on p_is_final_pay (it would make 3-argument calls ambiguous). One audit_logs row (no figures).';

-- finalize_payslip (3 arguments): kept for the frontend released before this migration.
CREATE OR REPLACE FUNCTION public.finalize_payslip(p_user_id uuid, p_pay_month date, p_payload jsonb)
RETURNS jsonb
LANGUAGE sql SET search_path TO 'public'
AS $fn$
  SELECT public.finalize_payslip(p_user_id, p_pay_month, p_payload, false)
$fn$;
REVOKE ALL ON FUNCTION public.finalize_payslip(uuid, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_payslip(uuid, date, jsonb) TO authenticated;
COMMENT ON FUNCTION public.finalize_payslip(uuid, date, jsonb) IS
  'Thin wrapper: finalize_payslip(p_user_id, p_pay_month, p_payload, false). Same rules and refusals as the 4-argument version.';

-- correct_timesheet_day: live body (20270202100000) with ONLY the date floor moved 2026-06-01 -> 2026-04-01.
-- correct_timesheet_day: rewrite one staff member's four punches for one day, with a comment.
CREATE OR REPLACE FUNCTION public.correct_timesheet_day(
  p_user_id uuid, p_work_date date,
  p_am_in timestamptz, p_am_out timestamptz, p_pm_in timestamptz, p_pm_out timestamptz,
  p_comment text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_comment  text := btrim(coalesce(p_comment, ''));
  v_tz       text;
  v_old      jsonb;
  v_new      jsonb;
  v_punch    timestamptz;
  v_local    timestamp;
  v_prev     timestamptz;
  v_eff      timestamptz;
  v_key      text;
  v_corr     public.timesheet_corrections%ROWTYPE;
  v_entry    jsonb;
BEGIN
  IF NOT public.can_correct_timesheet(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT coalesce(nullif(btrim(tp.timezone), ''), 'Asia/Manila') INTO v_tz
    FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id;
  IF p_user_id IS NULL OR NOT FOUND THEN RETURN jsonb_build_object('error', 'staff_not_found'); END IF;
  IF length(v_comment) < 3 OR length(v_comment) > 500 THEN RETURN jsonb_build_object('error', 'comment_required'); END IF;
  IF p_work_date IS NULL OR p_work_date < DATE '2026-04-01'
     OR p_work_date > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN v_tz := 'Asia/Manila'; END IF;

  v_new := jsonb_build_object('am_in', p_am_in, 'am_out', p_am_out, 'pm_in', p_pm_in, 'pm_out', p_pm_out);
  v_prev := NULL;
  FOREACH v_key IN ARRAY ARRAY['am_in', 'am_out', 'pm_in', 'pm_out'] LOOP
    v_punch := (v_new ->> v_key)::timestamptz;
    CONTINUE WHEN v_punch IS NULL;
    v_local := v_punch AT TIME ZONE v_tz;
    v_eff := v_punch;
    IF v_local::date = p_work_date THEN
      IF v_key = 'pm_out' AND v_local::time = TIME '00:00' THEN
        v_eff := v_punch + interval '1 day';
      END IF;
    ELSIF NOT (v_key = 'pm_out' AND v_local::date = p_work_date + 1 AND v_local::time <= TIME '06:00') THEN
      RETURN jsonb_build_object('error', 'invalid_punch', 'field', v_key);
    END IF;
    IF v_prev IS NOT NULL AND v_eff < v_prev THEN
      RETURN jsonb_build_object('error', 'invalid_order', 'field', v_key);
    END IF;
    v_prev := v_eff;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('timesheet:' || p_user_id::text || ':' || p_work_date::text, 0));

  SELECT jsonb_build_object('am_in', e.am_in, 'am_out', e.am_out, 'pm_in', e.pm_in, 'pm_out', e.pm_out)
    INTO v_old FROM public.timesheet_entries e WHERE e.user_id = p_user_id AND e.work_date = p_work_date;
  v_old := coalesce(v_old, jsonb_build_object('am_in', NULL, 'am_out', NULL, 'pm_in', NULL, 'pm_out', NULL));

  BEGIN
    INSERT INTO public.timesheet_entries (user_id, work_date, am_in, am_out, pm_in, pm_out)
    VALUES (p_user_id, p_work_date, p_am_in, p_am_out, p_pm_in, p_pm_out)
    ON CONFLICT (user_id, work_date) DO UPDATE
       SET am_in = EXCLUDED.am_in, am_out = EXCLUDED.am_out, pm_in = EXCLUDED.pm_in, pm_out = EXCLUDED.pm_out;

    INSERT INTO public.timesheet_corrections (user_id, work_date, old_punches, new_punches, comment, corrected_by, corrected_at)
    VALUES (p_user_id, p_work_date, v_old, v_new, v_comment, v_uid, clock_timestamp())
    RETURNING * INTO v_corr;

    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
    VALUES ('timesheet_correction', v_corr.id, 'correct_timesheet_day',
            jsonb_build_object('user_id', p_user_id, 'work_date', p_work_date), v_uid, now());
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', 'save_failed');
  END;

  SELECT jsonb_build_object('user_id', e.user_id, 'work_date', e.work_date, 'am_in', e.am_in, 'am_out', e.am_out,
                            'pm_in', e.pm_in, 'pm_out', e.pm_out)
    INTO v_entry FROM public.timesheet_entries e WHERE e.user_id = p_user_id AND e.work_date = p_work_date;

  RETURN jsonb_build_object('ok', true, 'correction', to_jsonb(v_corr), 'entry', v_entry);
END
$fn$;
REVOKE ALL ON FUNCTION public.correct_timesheet_day(uuid, date, timestamptz, timestamptz, timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_timesheet_day(uuid, date, timestamptz, timestamptz, timestamptz, timestamptz, text) TO authenticated;
COMMENT ON FUNCTION public.correct_timesheet_day(uuid, date, timestamptz, timestamptz, timestamptz, timestamptz, text) IS
  'Consolidation correction: sets the four punches of (p_user_id, p_work_date) (upsert, note untouched), appends a timesheet_corrections row (old -> new, comment) and one audit_logs row (user_id + work_date only). Needs the corrections gate. Refuses permission_denied, staff_not_found, comment_required (3-500), invalid_date (2026-04-01 .. today Manila), invalid_punch (not on the work date in the profile timezone; pm_out may be next day 00:00-06:00), invalid_order (am_in <= am_out <= pm_in <= pm_out; a 00:00 pm_out on the work date is midnight), save_failed.';

-- ---------------------------------------------------------------------------
-- 6. Cash advance proofs: payslip-proofs/advances/<active advance id>/<file>.
-- ---------------------------------------------------------------------------
DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                  AND policyname = 'Payslip managers can upload cash advance proofs') THEN
    CREATE POLICY "Payslip managers can upload cash advance proofs" ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'payslip-proofs'
                  AND (SELECT public.can_manage_payslips((SELECT auth.uid())))
                  AND split_part(name, '/', 1) = 'advances'
                  AND EXISTS (SELECT 1 FROM public.payslip_cash_advances a
                               WHERE a.id::text = split_part(name, '/', 2)
                                 AND a.status = 'active'
                                 AND a.proof_path IS NULL
                                 AND NOT EXISTS (SELECT 1 FROM public.payslips p
                                                  WHERE p.user_id = a.user_id AND p.pay_month = a.pay_month
                                                    AND p.status <> 'void'))
                  AND length(split_part(name, '/', 3)) > 0
                  AND split_part(name, '/', 4) = ''
                  AND name NOT LIKE '%..%');
  END IF;
END
$p$;

COMMIT;
