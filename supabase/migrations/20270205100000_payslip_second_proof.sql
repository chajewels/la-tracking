-- Payslips: a SECOND proof file on the payment proof and on each cash advance (owner-confirmed
-- 2026-10-27 13:15; docs/PAYSLIPS.md "Second proof file").
--
--   * payslips.proof_path_2 (optional): the 2nd proof-of-payment file, <payslip_id>/<file>.
--     record_payslip_payment gets a 6-argument version (p_proof_path_2 may be null) that saves one or
--     two files; the 5-argument version becomes a thin wrapper (second file = null). Neither has a
--     default, so no call is ambiguous.
--   * A forgotten 2nd file can be added AFTER the payment is recorded: attach_payslip_proof(p_id,
--     p_path) on a PAID payslip whose proof_path_2 is empty, once. payslips_before_write allows
--     exactly that change (paid -> paid, proof_path_2 null -> set, nothing else); every other column of
--     a paid payslip stays frozen. One audit_logs row.
--   * payslip_cash_advances.proof_path_2 (optional): attach_cash_advance_proof now fills slot 1, then
--     slot 2, and refuses a third (proof_already_attached). As before, only while the month has no
--     non-void payslip. finalize_payslip copies proof_path_2 into the payslip's cash_advances snapshot.
--   * Storage upload policies: a payment proof may also be uploaded for a PAID payslip with no 2nd
--     file; an advance proof while either slot is empty.
--   * get_payslip_book "features" gets second_proof, so the frontend (released first) can tell this
--     migration is applied.
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

SELECT pg_temp.cj_guard('public.payslips_before_write()', '1a5f935e3c76e63c9ad8f026e8e05ad6', 'v_proof2');
SELECT pg_temp.cj_guard('public.payslip_cash_advances_before_write()', '94cc63f73481b700b0b07be7dfff1a78', 'proof_path_2');
SELECT pg_temp.cj_guard('public.record_payslip_payment(uuid,integer,numeric,date,text)', '430b4f55d31de444ec6f651ecc555b36', 'NULL::text');
SELECT pg_temp.cj_guard('public.attach_cash_advance_proof(uuid,text)', 'a6e6f8ab5c9ffe5ca8815781ed7f9d13', 'proof_path_2');
SELECT pg_temp.cj_guard('public.finalize_payslip(uuid,date,jsonb,boolean)', 'b427f31b2b0b50215568c68ccdc78c46', 'proof_path_2');
SELECT pg_temp.cj_guard('public.get_payslip_book(date)', 'c875e08e6c8e5cb5a36d4f1cc3c329b3', 'second_proof');

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payslips ADD COLUMN IF NOT EXISTS proof_path_2 text NULL;
ALTER TABLE public.payslip_cash_advances ADD COLUMN IF NOT EXISTS proof_path_2 text NULL;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslips'::regclass AND conname = 'payslips_proof_path_2') THEN
    ALTER TABLE public.payslips ADD CONSTRAINT payslips_proof_path_2
      CHECK (proof_path_2 IS NULL
             OR (proof_path IS NOT NULL AND proof_path_2 <> proof_path AND proof_path_2 LIKE id::text || '/%'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.payslip_cash_advances'::regclass
                  AND conname = 'payslip_cash_advances_proof_path_2') THEN
    ALTER TABLE public.payslip_cash_advances ADD CONSTRAINT payslip_cash_advances_proof_path_2
      CHECK (proof_path_2 IS NULL
             OR (proof_path IS NOT NULL AND proof_path_2 <> proof_path AND proof_path_2 LIKE 'advances/' || id::text || '/%'));
  END IF;
END
$c$;

-- ---------------------------------------------------------------------------
-- 2. Freeze triggers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payslips_before_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_pay    text[] := ARRAY['status', 'jpy_sent', 'php_received', 'php_per_jpy', 'paid_on', 'proof_path', 'proof_path_2',
                           'paid_by', 'paid_at'];
  v_void   text[] := ARRAY['status', 'voided_by', 'voided_at', 'void_reason'];
  v_gen    text[] := ARRAY['net_pay_php', 'amount_due_php'];
  v_proof2 text[] := ARRAY['proof_path_2'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payslips are never deleted; void the payslip instead' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'finalized' OR NEW.paid_at IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.proof_path_2 IS NOT NULL THEN
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

  IF OLD.status = 'paid' AND NEW.status = 'paid' THEN
    IF OLD.proof_path_2 IS NULL AND NEW.proof_path_2 IS NOT NULL
       AND (to_jsonb(NEW) - v_proof2 - v_gen) = (to_jsonb(OLD) - v_proof2 - v_gen) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'a paid payslip can only get its second proof of payment' USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status IN ('finalized', 'paid') AND NEW.status = 'void' THEN
    IF (to_jsonb(NEW) - v_void - v_gen) IS DISTINCT FROM (to_jsonb(OLD) - v_void - v_gen) THEN
      RAISE EXCEPTION 'voiding a payslip changes the void fields only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'a payslip is locked: it can only be marked paid (from finalized), get a second proof (paid) or be voided'
    USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslips_before_write() IS
  'BEFORE INSERT/UPDATE/DELETE on payslips. Insert must be finalized with no payment/void fields. Update allowed only finalized -> paid (payment fields only, proof_path_2 included), paid -> paid (proof_path_2 null -> set, nothing else: the 2nd proof added later) and finalized|paid -> void (void fields only); snapshot, figure, advance and cash-bond columns never change (the generated net_pay_php / amount_due_php are left out of the comparison: they read NULL in a BEFORE trigger and derive only from frozen columns). DELETE always refused.';
REVOKE ALL ON FUNCTION public.payslips_before_write() FROM PUBLIC, anon, authenticated;

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

  RAISE EXCEPTION 'a cash advance is locked: up to two proofs can be attached once each, it can be voided, or linked to its payslip'
    USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.payslip_cash_advances_before_write() IS
  'BEFORE INSERT/UPDATE/DELETE on payslip_cash_advances. Insert must be active with no payslip. Update allowed only on an active advance and only: proof_path null -> set (nothing else), proof_path_2 null -> set once proof_path is set (nothing else), active -> void (void fields only), payslip_id set to a new payslip (nothing else). DELETE always refused.';
REVOKE ALL ON FUNCTION public.payslip_cash_advances_before_write() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Recording the payment with one or two proof files.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_payslip_payment(p_id uuid, p_jpy_sent integer, p_php_received numeric,
                                                         p_paid_on date, p_proof_path text, p_proof_path_2 text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_path  text := btrim(coalesce(p_proof_path, ''));
  v_path2 text := btrim(coalesce(p_proof_path_2, ''));
  v_old   public.payslips%ROWTYPE;
  v_new   public.payslips%ROWTYPE;
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
  IF v_path2 <> '' THEN
    IF v_path2 NOT LIKE p_id::text || '/%' OR length(split_part(v_path2, '/', 2)) = 0
       OR v_path2 LIKE '%..%' OR length(v_path2) > 300 OR v_path2 = v_path THEN
      RETURN jsonb_build_object('error', 'invalid_proof_path');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payslip-proofs' AND o.name = v_path2) THEN
      RETURN jsonb_build_object('error', 'proof_missing');
    END IF;
  END IF;

  UPDATE public.payslips
     SET status = 'paid', jpy_sent = p_jpy_sent, php_received = p_php_received,
         php_per_jpy = round(p_php_received / p_jpy_sent, 6), paid_on = p_paid_on, proof_path = v_path,
         proof_path_2 = nullif(v_path2, ''), paid_by = v_uid, paid_at = now()
   WHERE id = p_id
  RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip', p_id, 'record_payslip_payment',
          jsonb_build_object('status', v_old.status),
          jsonb_build_object('status', v_new.status, 'paid_on', v_new.paid_on, 'proof_path', v_new.proof_path,
                             'proof_path_2', v_new.proof_path_2),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'payslip', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text, text) TO authenticated;
COMMENT ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text, text) IS
  'Records the remittance on a FINALIZED payslip: whole yen sent > 0, pesos received > 0 (2 decimals), paid on pay_month .. today Japan time, proof <payslip_id>/<file> already uploaded to payslip-proofs, and optionally a 2nd proof file (same rules, different from the first; null or empty = none). Stores php_per_jpy = round(php_received / jpy_sent, 6) (the actual rate) and sets status paid. Needs the payslip gate; one audit_logs row (no figures).';

CREATE OR REPLACE FUNCTION public.record_payslip_payment(p_id uuid, p_jpy_sent integer, p_php_received numeric,
                                                         p_paid_on date, p_proof_path text)
RETURNS jsonb
LANGUAGE sql SET search_path TO 'public'
AS $fn$
  SELECT public.record_payslip_payment(p_id, p_jpy_sent, p_php_received, p_paid_on, p_proof_path, NULL::text)
$fn$;
REVOKE ALL ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text) TO authenticated;
COMMENT ON FUNCTION public.record_payslip_payment(uuid, integer, numeric, date, text) IS
  'Thin wrapper: record_payslip_payment(..., p_proof_path, NULL) — one proof file. Same rules and refusals as the 6-argument version.';

CREATE OR REPLACE FUNCTION public.attach_payslip_proof(p_id uuid, p_path text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_path text := btrim(coalesce(p_path, ''));
  v_old  public.payslips%ROWTYPE;
  v_new  public.payslips%ROWTYPE;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_old FROM public.payslips WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status <> 'paid' THEN RETURN jsonb_build_object('error', 'not_paid', 'status', v_old.status); END IF;
  IF v_old.proof_path_2 IS NOT NULL THEN RETURN jsonb_build_object('error', 'second_proof_attached'); END IF;
  IF v_path = '' THEN RETURN jsonb_build_object('error', 'proof_required'); END IF;
  IF v_path NOT LIKE p_id::text || '/%' OR length(split_part(v_path, '/', 2)) = 0
     OR v_path LIKE '%..%' OR length(v_path) > 300 OR v_path = v_old.proof_path THEN
    RETURN jsonb_build_object('error', 'invalid_proof_path');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payslip-proofs' AND o.name = v_path) THEN
    RETURN jsonb_build_object('error', 'proof_missing');
  END IF;

  UPDATE public.payslips SET proof_path_2 = v_path WHERE id = p_id RETURNING * INTO v_new;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip', p_id, 'attach_payslip_proof',
          jsonb_build_object('user_id', v_old.user_id, 'pay_month', v_old.pay_month, 'proof_path_2', v_path),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'payslip', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.attach_payslip_proof(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_payslip_proof(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.attach_payslip_proof(uuid, text) IS
  'Adds the 2nd proof-of-payment file <payslip_id>/<file> (already uploaded to payslip-proofs) to a PAID payslip that has none yet; nothing else changes. Refuses permission_denied, not_found, not_paid, second_proof_attached, proof_required, invalid_proof_path (wrong shape, or the same file as the first proof), proof_missing. One audit_logs row.';

-- ---------------------------------------------------------------------------
-- 4. Cash advance proofs: slot 1, then slot 2.
-- ---------------------------------------------------------------------------
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
  IF v_old.proof_path IS NOT NULL AND v_old.proof_path_2 IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'proof_already_attached');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payslips p
              WHERE p.user_id = v_old.user_id AND p.pay_month = v_old.pay_month AND p.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'month_finalized');
  END IF;
  IF v_path = '' THEN RETURN jsonb_build_object('error', 'proof_required'); END IF;
  IF v_path NOT LIKE 'advances/' || p_id::text || '/%' OR length(split_part(v_path, '/', 3)) = 0
     OR split_part(v_path, '/', 4) <> '' OR v_path LIKE '%..%' OR length(v_path) > 300
     OR v_path = v_old.proof_path THEN
    RETURN jsonb_build_object('error', 'invalid_proof_path');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'payslip-proofs' AND o.name = v_path) THEN
    RETURN jsonb_build_object('error', 'proof_missing');
  END IF;

  IF v_old.proof_path IS NULL THEN
    UPDATE public.payslip_cash_advances SET proof_path = v_path WHERE id = p_id RETURNING * INTO v_new;
  ELSE
    UPDATE public.payslip_cash_advances SET proof_path_2 = v_path WHERE id = p_id RETURNING * INTO v_new;
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip_cash_advance', p_id, 'attach_cash_advance_proof',
          jsonb_build_object('user_id', v_old.user_id, 'pay_month', v_old.pay_month, 'proof_attached', true,
                             'slot', CASE WHEN v_old.proof_path IS NULL THEN 1 ELSE 2 END),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'advance', to_jsonb(v_new));
END
$fn$;
REVOKE ALL ON FUNCTION public.attach_cash_advance_proof(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_cash_advance_proof(uuid, text) TO authenticated;
COMMENT ON FUNCTION public.attach_cash_advance_proof(uuid, text) IS
  'Attaches the proof advances/<p_id>/<file> (already uploaded to payslip-proofs) to an ACTIVE advance whose month has no non-void payslip: the 1st slot (proof_path) when empty, else the 2nd (proof_path_2). Refuses permission_denied, not_found, advance_void, proof_already_attached (both slots used), month_finalized, proof_required, invalid_proof_path (wrong shape, or the same file as the first proof), proof_missing. One audit_logs row.';

-- ---------------------------------------------------------------------------
-- 5. finalize_payslip: the advance snapshot carries proof_path_2 (only change).
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
  'Freezes a staff member''s payslip for p_pay_month (first of month, 2026-04 .. this month Japan time; the profile may be inactive). Name, job title, template, address, date of birth, employee ID and hire date are copied server-side; breakdowns rebuilt from known keys; a CSR''s basic_salary / monthly_allowance must equal the pay settings in force (else profile). The month''s ACTIVE cash advances are copied into cash_advances (with both proof paths) and deducted (cash_advance_php) and linked to the payslip. Cash bond: the hire month holds floor(net/2) to the centavo unless p_is_final_pay; otherwise a pending bond is released on its month + 1 or on a final-pay payslip. Refuses permission_denied, invalid_month, staff_not_found, already_issued, name_missing, details_missing (address, date of birth or employee ID), cash_bond_order (the first-month payslip is not issued yet), invalid_figures, invalid_totals, pay_settings_mismatch, advance_exceeds_pay. No default on p_is_final_pay (it would make 3-argument calls ambiguous). One audit_logs row (no figures).';

-- ---------------------------------------------------------------------------
-- 6. get_payslip_book: features.second_proof (only change).
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
                                   'pay_history', true, 'from_april', true, 'second_proof', true),
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
  'Timesheet -> Payslips: every payslip of the month (all statuses, each with cash_bond_source_month); the payroll details (address, date of birth, employee ID, hire date, first_month_issued, cash_bond_pending) of every active timesheet profile and of every inactive one with entries in the month''s 31-row window; the month''s cash advances (all statuses, newest first); those staff members'' pay settings; the one peso rate; can_manage; features (second_proof once migration 20270205100000 is applied). Needs the payslip gate.';

-- ---------------------------------------------------------------------------
-- 7. Storage upload policies (replaced: the 2nd file).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Payslip managers can upload payslip proofs" ON storage.objects;
CREATE POLICY "Payslip managers can upload payslip proofs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payslip-proofs'
              AND (SELECT public.can_manage_payslips((SELECT auth.uid())))
              AND EXISTS (SELECT 1 FROM public.payslips p
                           WHERE p.id::text = split_part(name, '/', 1)
                             AND (p.status = 'finalized' OR (p.status = 'paid' AND p.proof_path_2 IS NULL)))
              AND name NOT LIKE '%..%'
              AND length(split_part(name, '/', 2)) > 0);

DROP POLICY IF EXISTS "Payslip managers can upload cash advance proofs" ON storage.objects;
CREATE POLICY "Payslip managers can upload cash advance proofs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'payslip-proofs'
              AND (SELECT public.can_manage_payslips((SELECT auth.uid())))
              AND split_part(name, '/', 1) = 'advances'
              AND EXISTS (SELECT 1 FROM public.payslip_cash_advances a
                           WHERE a.id::text = split_part(name, '/', 2)
                             AND a.status = 'active'
                             AND (a.proof_path IS NULL OR a.proof_path_2 IS NULL)
                             AND NOT EXISTS (SELECT 1 FROM public.payslips p
                                              WHERE p.user_id = a.user_id AND p.pay_month = a.pay_month
                                                AND p.status <> 'void'))
              AND length(split_part(name, '/', 3)) > 0
              AND split_part(name, '/', 4) = ''
              AND name NOT LIKE '%..%');

COMMIT;
