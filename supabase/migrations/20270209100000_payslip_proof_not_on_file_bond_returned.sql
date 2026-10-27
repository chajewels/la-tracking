-- Payslips: "PROOF NOT ON FILE" for April-May 2026 and the CASH BOND RETURNED on Final pay
-- (owner 2026-10-28 00:22-00:27, docs/PAYSLIPS.md "Proof not on file and the returned cash bond").
--
--   * payslips.proof_not_on_file: a payslip of a month BEFORE June 2026 may be Paid without a proof file
--     ("Paid outside the Hub - proof not on file"). The owner could not locate the April-May proofs. From
--     June 2026 a proof is still required (CHECK). record_payslip_payment is unchanged (always a proof);
--     the April-May payslips are marked by a one-time owner-approved data step, not by a client RPC.
--   * Cash bond RETURNED: on a payslip ticked Final pay, Edit figures may carry cash_bond_returned_php with
--     the correction reason - a bond held BEFORE the Hub, added to the amount due. Refused while a Hub-held
--     bond is waiting (bond_pending_in_hub). The released-bond CHECK accepts released > 0 without a source
--     payslip only on such a payslip (final pay + correction reason).
--   * payslips_before_write: the new column is a payment field (finalized -> paid) and must start false.
--   * correct_payslip copies proof_not_on_file with the payment. get_payslip_book: two feature flags.
--
-- Guarded: each replaced function must still be the version on live (prosrc md5s read 2026-10-28) or
-- already this migration's version; otherwise it stops and nothing changes.

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

SELECT pg_temp.cj_guard('public.payslips_before_write()', 'c04525d926b4988f81fa840af55b0d01', '''proof_not_on_file''');
SELECT pg_temp.cj_guard('public.payslip_issue(uuid,date,jsonb,boolean,text,uuid)', '4356ec3593c01fdaffd3907b23830a97',
                        'cash_bond_returned_php');
SELECT pg_temp.cj_guard('public.correct_payslip(uuid,jsonb,boolean,text)', '58f14c84951c843b94d7239689557352',
                        'proof_not_on_file = v_old.proof_not_on_file');
SELECT pg_temp.cj_guard('public.get_payslip_book(date)', '6744850162578ff9e407b91b3616dbfd', '''bond_returned'', true');

-- ---------------------------------------------------------------------------
-- 1. The column and the CHECKs.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payslips ADD COLUMN IF NOT EXISTS proof_not_on_file boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.payslips.proof_not_on_file IS
  'Paid outside the Hub - proof not on file (owner 2026-10-28). Only on a pay month before June 2026; then proof_path is null.';

ALTER TABLE public.payslips DROP CONSTRAINT IF EXISTS payslips_paid_fields;
ALTER TABLE public.payslips ADD CONSTRAINT payslips_paid_fields CHECK (
  (jpy_sent IS NULL AND php_received IS NULL AND php_per_jpy IS NULL AND paid_on IS NULL AND proof_path IS NULL
   AND paid_by IS NULL AND paid_at IS NULL AND NOT proof_not_on_file)
  OR (jpy_sent IS NOT NULL AND php_received IS NOT NULL AND php_per_jpy IS NOT NULL AND paid_on IS NOT NULL
      AND paid_by IS NOT NULL AND paid_at IS NOT NULL AND ((proof_path IS NOT NULL) <> proof_not_on_file)));

ALTER TABLE public.payslips DROP CONSTRAINT IF EXISTS payslips_proof_not_on_file;
ALTER TABLE public.payslips ADD CONSTRAINT payslips_proof_not_on_file
  CHECK (NOT proof_not_on_file OR pay_month < DATE '2026-06-01');

ALTER TABLE public.payslips DROP CONSTRAINT IF EXISTS payslips_cash_bond_released;
ALTER TABLE public.payslips ADD CONSTRAINT payslips_cash_bond_released CHECK (
  cash_bond_released_php >= 0
  AND (cash_bond_source_payslip_id IS NULL OR cash_bond_released_php > 0)
  AND (cash_bond_released_php = 0 OR cash_bond_source_payslip_id IS NOT NULL
       OR (is_final_pay AND correction_reason IS NOT NULL)));

-- ---------------------------------------------------------------------------
-- 2. payslips_before_write: proof_not_on_file is a payment field; a payslip starts with it false.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payslips_before_write()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
DECLARE
  v_pay    text[] := ARRAY['status', 'jpy_sent', 'php_received', 'php_per_jpy', 'paid_on', 'proof_path', 'proof_path_2',
                           'paid_by', 'paid_at', 'proof_not_on_file'];
  v_void   text[] := ARRAY['status', 'voided_by', 'voided_at', 'void_reason'];
  v_gen    text[] := ARRAY['net_pay_php', 'amount_due_php'];
  v_proof2 text[] := ARRAY['proof_path_2'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payslips are never deleted; void the payslip instead' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'finalized' OR NEW.paid_at IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.proof_path_2 IS NOT NULL
       OR NEW.proof_not_on_file THEN
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

REVOKE ALL ON FUNCTION public.payslips_before_write() FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. payslip_issue: the returned cash bond (Final pay + reason, no Hub bond waiting).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payslip_issue(p_user_id uuid, p_pay_month date, p_payload jsonb, p_is_final_pay boolean,
                                                p_correction_reason text, p_corrected_from uuid)
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
  v_reason   text := nullif(btrim(coalesce(p_correction_reason, '')), '');
  v_bond_in  numeric;
  v_return_in numeric;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF v_reason IS NOT NULL AND (length(v_reason) < 3 OR length(v_reason) > 500) THEN
    RETURN jsonb_build_object('error', 'reason_required');
  END IF;
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
    -- Manual correction (owner 2026-10-27): with a reason the typed basic / allowance stand as entered.
    IF v_reason IS NULL AND ((v_ts ->> 'basic_salary')::numeric <> v_basic OR (v_ts ->> 'monthly_allowance')::numeric <> v_allow) THEN
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

  -- Cash bond (owner 2026-10-27 15:31): half of the SALARY = timesheet net only (commission and bonuses
  -- excluded, advances not taken off first). With a correction reason the bond may be typed
  -- (payload cash_bond_held_php), on any payslip that is not final pay.
  IF p_payload ? 'cash_bond_held_php' AND jsonb_typeof(p_payload -> 'cash_bond_held_php') <> 'null' THEN
    IF v_reason IS NULL OR v_final THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', 'cash_bond_held_php'); END IF;
    v_bond_in := public.payslip_figure(p_payload -> 'cash_bond_held_php', false);
    IF v_bond_in IS NULL THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', 'cash_bond_held_php'); END IF;
  END IF;

  -- Cash bond RETURNED (owner 2026-10-28): a bond held before the Hub, typed on the staff member's LAST
  -- payslip (Final pay) with a correction reason; refused while a Hub-held bond is waiting (that one is
  -- released by itself on Final pay).
  IF p_payload ? 'cash_bond_returned_php' AND jsonb_typeof(p_payload -> 'cash_bond_returned_php') <> 'null' THEN
    IF v_reason IS NULL OR NOT v_final THEN RETURN jsonb_build_object('error', 'invalid_figures', 'field', 'cash_bond_returned_php'); END IF;
    v_return_in := nullif(public.payslip_figure(p_payload -> 'cash_bond_returned_php', false), 0);
    IF public.payslip_figure(p_payload -> 'cash_bond_returned_php', false) IS NULL THEN
      RETURN jsonb_build_object('error', 'invalid_figures', 'field', 'cash_bond_returned_php');
    END IF;
  END IF;

  IF v_bond_in IS NOT NULL THEN
    v_held := v_bond_in;
  ELSIF v_first IS NOT NULL AND v_first = p_pay_month AND NOT v_final THEN
    v_held := floor(v_ts_net * 50) / 100;
  END IF;
  IF v_held > v_earn - v_adv_sum THEN
    RETURN jsonb_build_object('error', 'bond_exceeds_pay', 'max', v_earn - v_adv_sum);
  END IF;

  IF NOT (v_first IS NOT NULL AND v_first = p_pay_month AND NOT v_final) THEN
    SELECT s.* INTO v_pending
      FROM public.payslips s
     WHERE s.user_id = p_user_id AND s.status <> 'void' AND s.cash_bond_held_php > 0 AND s.pay_month < p_pay_month
       AND NOT EXISTS (SELECT 1 FROM public.payslips r
                        WHERE r.cash_bond_source_payslip_id = s.id AND r.status <> 'void')
     ORDER BY s.pay_month DESC LIMIT 1;
    -- Bond release (owner 2026-10-27 17:54): ONLY on a payslip ticked "Final pay" (staff leaving); never
    -- automatically in the month after the hire month.
    IF FOUND AND v_final THEN
      v_released := v_pending.cash_bond_held_php;
      v_source := v_pending.id;
    END IF;
    IF v_return_in IS NOT NULL THEN
      IF v_source IS NOT NULL THEN RETURN jsonb_build_object('error', 'bond_pending_in_hub'); END IF;
      v_released := v_return_in;
    END IF;
  END IF;

  INSERT INTO public.payslips (user_id, pay_month, status, staff_name, address, date_of_birth, job_title, template_type,
                               timesheet, commission, timesheet_net_php, commission_php, total_php, finalized_by, finalized_at,
                               employee_id, hire_date, cash_advances, cash_advance_php, is_final_pay,
                               cash_bond_held_php, cash_bond_released_php, cash_bond_source_payslip_id, bonuses, bonus_php,
                               correction_reason, corrected_from_payslip_id)
  VALUES (p_user_id, p_pay_month, 'finalized', v_name, v_details.address, v_details.date_of_birth,
          nullif(btrim(coalesce(v_profile.job_title, '')), ''), v_profile.template_type,
          v_ts, v_cm, v_ts_net, v_cm_total, v_earn, v_uid, now(),
          v_details.employee_id, v_details.hire_date, v_adv, v_adv_sum, v_final,
          v_held, v_released, v_source, v_bonus, v_bonus_sum,
          v_reason, p_corrected_from)
  RETURNING * INTO v_new;

  UPDATE public.payslip_cash_advances SET payslip_id = v_new.id
   WHERE user_id = p_user_id AND pay_month = p_pay_month AND status = 'active';
  UPDATE public.payslip_bonuses SET payslip_id = v_new.id
   WHERE user_id = p_user_id AND pay_month = p_pay_month AND status = 'active';

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
  VALUES ('payslip', v_new.id, CASE WHEN p_corrected_from IS NULL THEN 'finalize_payslip' ELSE 'correct_payslip' END,
          jsonb_build_object('user_id', p_user_id, 'pay_month', p_pay_month, 'status', 'finalized',
                             'is_final_pay', v_final, 'advances', jsonb_array_length(v_adv), 'bonuses', jsonb_array_length(v_bonus),
                             'manual', v_reason IS NOT NULL, 'corrected_from', p_corrected_from,
                             'cash_bond', CASE WHEN v_held > 0 THEN 'held' WHEN v_source IS NOT NULL THEN 'released' WHEN v_released > 0 THEN 'returned' ELSE 'none' END),
          v_uid, now());

  RETURN jsonb_build_object('ok', true, 'payslip', to_jsonb(v_new));
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'already_issued');
END
$fn$;

REVOKE ALL ON FUNCTION public.payslip_issue(uuid, date, jsonb, boolean, text, uuid) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.payslip_issue(uuid, date, jsonb, boolean, text, uuid) IS
  'Internal: issues a payslip (see finalize_payslip / correct_payslip). With p_correction_reason (3-500 characters) the CSR basic / allowance need not match the pay settings and the payload may carry cash_bond_held_php (not on final pay) or, on final pay, cash_bond_returned_php (a bond held before the Hub, added to the amount due; refused bond_pending_in_hub while a Hub bond waits); the reason is stored. Cash bond: the hire month holds floor(timesheet net / 2) to the centavo unless final pay (commission and bonuses excluded); refused bond_exceeds_pay when it is above earnings - advances. A Hub-held bond is released ONLY on a payslip with p_is_final_pay. Not executable by clients.';

-- ---------------------------------------------------------------------------
-- 4. correct_payslip: a Paid payslip's "proof not on file" is copied with its payment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.correct_payslip(p_id uuid, p_payload jsonb, p_is_final_pay boolean, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_old    public.payslips%ROWTYPE;
  v_new    public.payslips%ROWTYPE;
  v_res    jsonb;
BEGIN
  IF NOT public.can_manage_payslips(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF length(v_reason) < 3 OR length(v_reason) > 500 THEN RETURN jsonb_build_object('error', 'reason_required'); END IF;
  IF p_id IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  SELECT * INTO v_old FROM public.payslips WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF v_old.status = 'void' THEN RETURN jsonb_build_object('error', 'already_void'); END IF;
  IF v_old.cash_bond_held_php > 0 AND EXISTS (SELECT 1 FROM public.payslips r
                                               WHERE r.cash_bond_source_payslip_id = v_old.id AND r.status <> 'void') THEN
    RETURN jsonb_build_object('error', 'bond_already_released');
  END IF;

  BEGIN
    UPDATE public.payslips
       SET status = 'void', voided_by = v_uid, voided_at = now(), void_reason = left('Corrected: ' || v_reason, 500)
     WHERE id = p_id;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
    VALUES ('payslip', p_id, 'void_payslip', jsonb_build_object('status', v_old.status),
            jsonb_build_object('status', 'void', 'void_reason', left('Corrected: ' || v_reason, 500)), v_uid, now());

    v_res := public.payslip_issue(v_old.user_id, v_old.pay_month, p_payload, p_is_final_pay, v_reason, v_old.id);
    IF v_res ? 'error' THEN
      RAISE EXCEPTION 'cj_correct_refused' USING DETAIL = v_res::text;
    END IF;

    IF v_old.status = 'paid' THEN
      UPDATE public.payslips
         SET status = 'paid', jpy_sent = v_old.jpy_sent, php_received = v_old.php_received, php_per_jpy = v_old.php_per_jpy,
             paid_on = v_old.paid_on, proof_path = v_old.proof_path, proof_path_2 = v_old.proof_path_2,
             proof_not_on_file = v_old.proof_not_on_file,
             paid_by = v_old.paid_by, paid_at = v_old.paid_at
       WHERE id = (v_res -> 'payslip' ->> 'id')::uuid;
    END IF;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM = 'cj_correct_refused' THEN
      GET STACKED DIAGNOSTICS v_reason = PG_EXCEPTION_DETAIL;
      RETURN v_reason::jsonb;
    END IF;
    RAISE;
  END;

  SELECT * INTO v_new FROM public.payslips WHERE id = (v_res -> 'payslip' ->> 'id')::uuid;
  RETURN jsonb_build_object('ok', true, 'payslip', to_jsonb(v_new), 'voided_id', p_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.correct_payslip(uuid, jsonb, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_payslip(uuid, jsonb, boolean, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. get_payslip_book: features.proof_not_on_file and features.bond_returned (only change).
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
                                   'pay_history', true, 'from_april', true, 'second_proof', true, 'bonuses', true,
                                   'edit_figures', true, 'proof_not_on_file', true, 'bond_returned', true),
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

COMMIT;
