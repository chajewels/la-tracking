-- Payslips: BONUSES (owner-confirmed 2026-10-27 14:04; docs/PAYSLIPS.md "Bonuses").
--
--   * payslip_bonuses: typed per staff member per month by the payslip gate (Admin / Brenda), like cash
--     advances: category (performance = "Performance / KPI bonus", holiday = "Holiday / Christmas bonus"),
--     date, amount, note, up to two optional proof files (payslip-proofs, bonuses/<bonus id>/<file>).
--     Add / attach proof / void only while the month has no non-void payslip; mistakes are voided with a
--     reason, never deleted. The commission Top Sales bonus is unchanged (automatic, from the commission).
--   * Bonuses are EARNINGS: payslips.total_php = timesheet_net_php + commission_php + bonus_php (the
--     payslips_total check is replaced; every existing row has bonus_php = 0). finalize_payslip sums the
--     month's ACTIVE bonuses server-side (the client payload still carries timesheet + commission only),
--     freezes them in payslips.bonuses and links them. Net pay = total earnings - cash advances; the
--     first-month cash bond is half of that net pay, so bonuses are included (owner choice).
--   * payslips_before_write needs no change: bonuses / bonus_php are snapshot columns and stay frozen.
--   * get_payslip_book: the month's bonuses (all statuses) and features.bonuses.
--
-- Guarded: each replaced function must still be the version this migration was written against (or
-- already this migration's version); otherwise it stops and nothing changes.

SET lock_timeout = '15s';

BEGIN;

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

SELECT pg_temp.cj_guard('public.finalize_payslip(uuid,date,jsonb,boolean)', '72246e4dc65862e58f50f0e23fc4deaf', 'v_bonus_sum');
SELECT pg_temp.cj_guard('public.get_payslip_book(date)', '529b0a2efa8656cb71d7d0aad28e8c06', '''bonuses'', true');

-- ---------------------------------------------------------------------------
-- 1. payslips: the bonus snapshot and the new total rule.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payslips
  ADD COLUMN IF NOT EXISTS bonuses jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bonus_php numeric(14,2) NOT NULL DEFAULT 0;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_bonuses_array') THEN
    ALTER TABLE public.payslips ADD CONSTRAINT payslips_bonuses_array CHECK (jsonb_typeof(bonuses) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_bonus_php_range') THEN
    ALTER TABLE public.payslips ADD CONSTRAINT payslips_bonus_php_range CHECK (bonus_php >= 0);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_total'
              AND pg_get_constraintdef(oid) NOT LIKE '%bonus_php%') THEN
    ALTER TABLE public.payslips DROP CONSTRAINT payslips_total;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_total') THEN
    ALTER TABLE public.payslips ADD CONSTRAINT payslips_total CHECK (total_php = timesheet_net_php + commission_php + bonus_php);
  END IF;
END
$c$;

-- ---------------------------------------------------------------------------
-- 2. payslip_bonuses.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payslip_bonuses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  pay_month     date NOT NULL CHECK (pay_month = date_trunc('month', pay_month)::date),
  bonus_date    date NOT NULL,
  category      text NOT NULL CHECK (category IN ('performance', 'holiday')),
  amount_php    numeric(14,2) NOT NULL CHECK (amount_php > 0),
  note          text NOT NULL CHECK (length(note) BETWEEN 1 AND 200 AND note = btrim(note)),
  proof_path    text NULL,
  proof_path_2  text NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  void_reason   text NULL,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  voided_by     uuid NULL,
  voided_at     timestamptz NULL,
  payslip_id    uuid NULL REFERENCES public.payslips (id),
  CONSTRAINT payslip_bonuses_proof_path CHECK (proof_path IS NULL OR proof_path LIKE 'bonuses/' || id::text || '/%'),
  CONSTRAINT payslip_bonuses_proof_path_2 CHECK (proof_path_2 IS NULL
    OR (proof_path IS NOT NULL AND proof_path_2 <> proof_path AND proof_path_2 LIKE 'bonuses/' || id::text || '/%')),
  CONSTRAINT payslip_bonuses_void_fields CHECK (
    (status = 'void' AND voided_by IS NOT NULL AND voided_at IS NOT NULL
       AND length(btrim(coalesce(void_reason, ''))) BETWEEN 3 AND 500)
    OR (status = 'active' AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL))
);
CREATE INDEX IF NOT EXISTS payslip_bonuses_user_month_idx ON public.payslip_bonuses (user_id, pay_month);
ALTER TABLE public.payslip_bonuses ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.payslip_bonuses IS
  'Bonuses added to a payslip''s earnings (owner 2026-10-27): one row per bonus (category performance | holiday, date, amount, note, up to two optional proofs bonuses/<id>/<file>). Added / proof attached / voided only while the staff month has no non-void payslip; finalize copies the active ones into payslips.bonuses, adds them to total_php (bonus_php) and sets payslip_id. Never deleted. Written only through add_payslip_bonus / attach_payslip_bonus_proof / void_payslip_bonus / finalize_payslip.';

DROP POLICY IF EXISTS payslip_bonuses_read ON public.payslip_bonuses;
CREATE POLICY payslip_bonuses_read ON public.payslip_bonuses
  FOR SELECT TO authenticated
  USING ((SELECT public.can_manage_payslips((SELECT auth.uid()))));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.payslip_bonuses FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.payslip_bonuses FROM anon;
GRANT SELECT ON public.payslip_bonuses TO authenticated;
GRANT ALL ON public.payslip_bonuses TO service_role;

CREATE OR REPLACE FUNCTION public.payslip_bonuses_before_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_void text[] := ARRAY['status', 'void_reason', 'voided_by', 'voided_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'bonuses are never deleted; void the bonus instead' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'active' OR NEW.payslip_id IS NOT NULL OR NEW.voided_at IS NOT NULL
       OR NEW.proof_path IS NOT NULL OR NEW.proof_path_2 IS NOT NULL THEN
      RAISE EXCEPTION 'a bonus starts as active, with no payslip and no proof' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND OLD.proof_path IS NULL AND NEW.proof_path IS NOT NULL
     AND (to_jsonb(NEW) - 'proof_path') = (to_jsonb(OLD) - 'proof_path') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'active' AND OLD.proof_path IS NOT NULL AND OLD.proof_path_2 IS NULL AND NEW.proof_path_2 IS NOT NULL
     AND (to_jsonb(NEW) - 'proof_path_2') = (to_jsonb(OLD) - 'proof_path_2') THEN
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

  RAISE EXCEPTION 'a bonus is locked: up to two proofs can be attached once each, it can be voided, or linked to its payslip'
    USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslip_bonuses_before_write() IS
  'BEFORE INSERT/UPDATE/DELETE on payslip_bonuses. Insert must be active with no payslip and no proof. Update allowed only on an active bonus and only: proof_path null -> set, proof_path_2 null -> set once proof_path is set, active -> void (void fields only), payslip_id set to a new payslip (each changing nothing else). DELETE always refused.';
REVOKE ALL ON FUNCTION public.payslip_bonuses_before_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payslip_bonuses_before_write ON public.payslip_bonuses;
CREATE TRIGGER payslip_bonuses_before_write
  BEFORE INSERT OR UPDATE OR DELETE ON public.payslip_bonuses
  FOR EACH ROW EXECUTE FUNCTION public.payslip_bonuses_before_write();

CREATE OR REPLACE FUNCTION public.payslip_bonuses_refuse_truncate()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'bonuses are never deleted (TRUNCATE refused)' USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslip_bonuses_refuse_truncate() IS
  'BEFORE TRUNCATE on payslip_bonuses: always refused.';
REVOKE ALL ON FUNCTION public.payslip_bonuses_refuse_truncate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payslip_bonuses_refuse_truncate ON public.payslip_bonuses;
CREATE TRIGGER payslip_bonuses_refuse_truncate
  BEFORE TRUNCATE ON public.payslip_bonuses
  FOR EACH STATEMENT EXECUTE FUNCTION public.payslip_bonuses_refuse_truncate();

-- ---------------------------------------------------------------------------
-- 3. RPCs: add, attach a proof (slot 1, then 2), void.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_payslip_bonus(p_user_id uuid, p_pay_month date, p_bonus_date date, p_category text,
                                                    p_amount_php numeric, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Asia/Tokyo')::date;
  v_note  text := btrim(coalesce(p_note, ''));
  v_new   public.payslip_bonuses%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id) THEN
    RETURN jsonb_build_object('error', 'staff_not_found');
  END IF;
  IF p_pay_month IS NULL OR p_pay_month <> date_trunc('month', p_pay_month)::date
     OR p_pay_month < DATE '2026-04-01' OR p_pay_month > date_trunc('month', v_today)::date THEN
    RETURN jsonb_build_object('error', 'invalid_month');
  END IF;
  IF p_bonus_date IS NULL OR p_bonus_date > v_today OR p_bonus_date < DATE '2026-04-01' THEN
    RETURN jsonb_build_object('error', 'invalid_bonus_date');
  END IF;
  IF p_category IS NULL OR p_category NOT IN ('performance', 'holiday') THEN
    RETURN jsonb_build_object('error', 'invalid_category');
  END IF;
  IF p_amount_php IS NULL OR p_amount_php <= 0 OR p_amount_php > 10000000 OR p_amount_php <> round(p_amount_php, 2) THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;
  IF length(v_note) = 0 THEN RETURN jsonb_build_object('error', 'bonus_note_required'); END IF;
  IF length(v_note) > 200 THEN RETURN jsonb_build_object('error', 'note_too_long'); END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('payslip:' || p_user_id::text || ':' || p_pay_month::text, 0));
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = p_user_id AND p.pay_month = p_pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'bonus_month_finalized');
  END IF;

  INSERT INTO public.payslip_bonuses (user_id, pay_month, bonus_date, category, amount_php, note, status, created_by, created_at)
  VALUES (p_user_id, p_pay_month, p_bonus_date, p_category, p_amount_php, v_note, 'active', v_uid, now())
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip_bonus', v_new.id, 'add_payslip_bonus',
          jsonb_build_object('user_id', p_user_id, 'pay_month', p_pay_month, 'category', p_category, 'status', 'active'),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'bonus', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.add_payslip_bonus(uuid, date, date, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_payslip_bonus(uuid, date, date, text, numeric, text) TO authenticated;
COMMENT ON FUNCTION public.add_payslip_bonus(uuid, date, date, text, numeric, text) IS
  'Adds a bonus (added to earnings on the payslip) for p_pay_month (first of month, 2026-04 .. this month Japan time) of a staff member with a timesheet profile (active or not). category performance | holiday; bonus_date 2026-04-01 .. today Japan time; amount > 0 with 2 decimals; note 1-200 characters. Refuses permission_denied, staff_not_found, invalid_month, invalid_bonus_date, invalid_category, invalid_amount, bonus_note_required, note_too_long, bonus_month_finalized (a non-void payslip exists; same lock as finalize). One audit_logs row (no amount, no note).';

CREATE OR REPLACE FUNCTION public.attach_payslip_bonus_proof(p_id uuid, p_path text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_path text := btrim(coalesce(p_path, ''));
  v_old  public.payslip_bonuses%ROWTYPE;
  v_new  public.payslip_bonuses%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_old FROM public.payslip_bonuses WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payslip:' || v_old.user_id::text || ':' || v_old.pay_month::text, 0));
  SELECT * INTO v_old FROM public.payslip_bonuses WHERE id = p_id FOR UPDATE;
  IF v_old.status <> 'active' THEN RETURN jsonb_build_object('error', 'bonus_void'); END IF;
  IF v_old.proof_path IS NOT NULL AND v_old.proof_path_2 IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'bonus_proofs_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = v_old.user_id AND p.pay_month = v_old.pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'bonus_month_finalized');
  END IF;
  IF v_path = '' THEN RETURN jsonb_build_object('error', 'proof_required'); END IF;
  IF v_path NOT LIKE 'bonuses/' || p_id::text || '/%' OR length(split_part(v_path, '/', 3)) = 0
     OR split_part(v_path, '/', 4) <> '' OR v_path LIKE '%..%' OR length(v_path) > 300
     OR v_path = v_old.proof_path THEN
    RETURN jsonb_build_object('error', 'invalid_proof_path');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payslip-proofs' AND o.name = v_path) THEN
    RETURN jsonb_build_object('error', 'proof_missing');
  END IF;

  IF v_old.proof_path IS NULL THEN
    UPDATE public.payslip_bonuses SET proof_path = v_path WHERE id = p_id RETURNING * INTO v_new;
  ELSE
    UPDATE public.payslip_bonuses SET proof_path_2 = v_path WHERE id = p_id RETURNING * INTO v_new;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip_bonus', p_id, 'attach_payslip_bonus_proof',
          jsonb_build_object('user_id', v_old.user_id, 'pay_month', v_old.pay_month, 'proof_attached', true,
                             'slot', CASE WHEN v_old.proof_path IS NULL THEN 1 ELSE 2 END),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'bonus', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.attach_payslip_bonus_proof(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_payslip_bonus_proof(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.attach_payslip_bonus_proof(uuid, text) IS
  'Attaches the proof bonuses/<p_id>/<file> (already uploaded to payslip-proofs) to an ACTIVE bonus whose month has no non-void payslip: slot 1 (proof_path) when empty, else slot 2 (proof_path_2). Refuses permission_denied, not_found, bonus_void, bonus_proofs_full, bonus_month_finalized, proof_required, invalid_proof_path (wrong shape, or the 1st file again), proof_missing. One audit_logs row.';

CREATE OR REPLACE FUNCTION public.void_payslip_bonus(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    public.payslip_bonuses%ROWTYPE;
  v_new    public.payslip_bonuses%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_old FROM public.payslip_bonuses WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payslip:' || v_old.user_id::text || ':' || v_old.pay_month::text, 0));
  SELECT * INTO v_old FROM public.payslip_bonuses WHERE id = p_id FOR UPDATE;
  IF v_old.status = 'void' THEN RETURN jsonb_build_object('error', 'bonus_already_void'); END IF;
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = v_old.user_id AND p.pay_month = v_old.pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'bonus_month_finalized');
  END IF;

  UPDATE public.payslip_bonuses
     SET status = 'void', void_reason = v_reason, voided_by = v_uid, voided_at = now()
   WHERE id = p_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip_bonus', p_id, 'void_payslip_bonus',
          jsonb_build_object('status', 'active'),
          jsonb_build_object('user_id', v_old.user_id, 'pay_month', v_old.pay_month, 'status', 'void'),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'bonus', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.void_payslip_bonus(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_payslip_bonus(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.void_payslip_bonus(uuid, text) IS
  'Voids an active bonus with a reason (3-500 characters) while its month has no non-void payslip; never deletes. Refuses permission_denied, reason_required, not_found, bonus_already_void, bonus_month_finalized. One audit_logs row (no amount, note or reason).';

-- ---------------------------------------------------------------------------
-- 4. finalize_payslip: bonuses are earnings (only change).
-- ---------------------------------------------------------------------------
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
  v_bonus     jsonb;
  v_bonus_sum numeric;
  v_earn      numeric;
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
                                               'note', a.note, 'proof_path', a.proof_path, 'proof_path_2', a.proof_path_2)
                            ORDER BY a.advance_date, a.created_at), '[]'::jsonb),
         coalesce(sum(a.amount_php), 0)
    INTO v_adv, v_adv_sum
    FROM public.payslip_cash_advances a
   WHERE a.user_id = p_user_id AND a.pay_month = p_pay_month AND a.status = 'active';
  -- Bonuses (owner 2026-10-27): the month's ACTIVE bonuses are earnings; summed here, never taken from the client.
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'bonus_date', b.bonus_date, 'category', b.category,
                                               'amount_php', b.amount_php, 'note', b.note,
                                               'proof_path', b.proof_path, 'proof_path_2', b.proof_path_2)
                            ORDER BY b.bonus_date, b.created_at), '[]'::jsonb),
         coalesce(sum(b.amount_php), 0)
    INTO v_bonus, v_bonus_sum
    FROM public.payslip_bonuses b
   WHERE b.user_id = p_user_id AND b.pay_month = p_pay_month AND b.status = 'active';
  v_earn := v_total + v_bonus_sum;
  IF v_adv_sum > v_earn THEN RETURN jsonb_build_object('error', 'advance_exceeds_pay'); END IF;

  IF v_first IS NOT NULL AND v_first = p_pay_month AND NOT v_final THEN
    v_held := floor((v_earn - v_adv_sum) * 50) / 100;
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
                               cash_bond_held_php, cash_bond_released_php, cash_bond_source_payslip_id, bonuses, bonus_php)
  VALUES (p_user_id, p_pay_month, 'finalized', v_name, v_details.address, v_details.date_of_birth,
          nullif(btrim(coalesce(v_profile.job_title, '')), ''), v_profile.template_type,
          v_ts, v_cm, v_ts_net, v_cm_total, v_earn, v_uid, now(),
          v_details.employee_id, v_details.hire_date, v_adv, v_adv_sum, v_final,
          v_held, v_released, v_source, v_bonus, v_bonus_sum)
  RETURNING * INTO v_new;

  UPDATE public.payslip_cash_advances SET payslip_id = v_new.id
   WHERE user_id = p_user_id AND pay_month = p_pay_month AND status = 'active';
  UPDATE public.payslip_bonuses SET payslip_id = v_new.id
   WHERE user_id = p_user_id AND pay_month = p_pay_month AND status = 'active';

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip', v_new.id, 'finalize_payslip',
          jsonb_build_object('user_id', p_user_id, 'pay_month', p_pay_month, 'status', 'finalized',
                             'is_final_pay', v_final, 'advances', jsonb_array_length(v_adv), 'bonuses', jsonb_array_length(v_bonus),
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
  'Freezes a staff member''s payslip for p_pay_month (first of month, 2026-04 .. this month Japan time; the profile may be inactive). Name, job title, template, address, date of birth, employee ID and hire date are copied server-side; breakdowns rebuilt from known keys; a CSR''s basic_salary / monthly_allowance must equal the pay settings in force (else profile). The month''s ACTIVE bonuses are copied into bonuses and ADDED to earnings (total_php = timesheet + commission + bonus_php; the payload''s total_php is timesheet + commission) and linked. The month''s ACTIVE cash advances are copied into cash_advances (with both proof paths) and deducted (cash_advance_php) and linked to the payslip. Cash bond: the hire month holds floor(net/2) (net = earnings incl. bonuses - advances) to the centavo unless p_is_final_pay; otherwise a pending bond is released on its month + 1 or on a final-pay payslip. Refuses permission_denied, invalid_month, staff_not_found, already_issued, name_missing, details_missing (address, date of birth or employee ID), cash_bond_order (the first-month payslip is not issued yet), invalid_figures, invalid_totals, pay_settings_mismatch, advance_exceeds_pay. No default on p_is_final_pay (it would make 3-argument calls ambiguous). One audit_logs row (no figures).';

-- ---------------------------------------------------------------------------
-- 5. get_payslip_book: the month's bonuses and features.bonuses (only change).
-- ---------------------------------------------------------------------------
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
                                   'pay_history', true, 'from_april', true, 'second_proof', true, 'bonuses', true),
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
    'bonuses', coalesce((
      SELECT jsonb_agg(to_jsonb(b) ORDER BY b.created_at DESC)
        FROM public.payslip_bonuses b WHERE b.pay_month = v_month), '[]'::jsonb),
    'pay_settings', coalesce((
      SELECT jsonb_agg(to_jsonb(s) ORDER BY s.user_id, s.effective_from)
        FROM public.timesheet_pay_settings s WHERE s.user_id = ANY (v_staff)), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_payslip_book(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_payslip_book(date) TO authenticated;
COMMENT ON FUNCTION public.get_payslip_book(date) IS
  'Timesheet -> Payslips: every payslip of the month (all statuses, each with cash_bond_source_month); the payroll details (address, date of birth, employee ID, hire date, first_month_issued, cash_bond_pending) of every active timesheet profile and of every inactive one with entries in the month''s 31-row window; the month''s cash advances and bonuses (all statuses, newest first); those staff members'' pay settings; the one peso rate; can_manage; features (second_proof once migration 20270205100000 is applied, bonuses once 20270206100000 is). Needs the payslip gate.';

-- ---------------------------------------------------------------------------
-- 6. Storage: upload a bonus proof while a slot is free and the month is open.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Payslip managers can upload bonus proofs" ON storage.objects;
CREATE POLICY "Payslip managers can upload bonus proofs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payslip-proofs'
              AND (SELECT public.can_manage_payslips((SELECT auth.uid())))
              AND split_part(name, '/', 1) = 'bonuses'
              AND EXISTS (SELECT 1 FROM public.payslip_bonuses b
                           WHERE b.id::text = split_part(name, '/', 2)
                             AND b.status = 'active'
                             AND (b.proof_path IS NULL OR b.proof_path_2 IS NULL)
                             AND NOT EXISTS (SELECT 1 FROM public.payslips p
                                              WHERE p.user_id = b.user_id AND p.pay_month = b.pay_month
                                                AND p.status <> 'void'))
              AND length(split_part(name, '/', 3)) > 0
              AND split_part(name, '/', 4) = ''
              AND name NOT LIKE '%..%');

COMMIT;
