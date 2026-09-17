-- 2026-09-17: pending payment submissions no longer block a plan change; preview/result/audit carry pending_submissions. Applied live via SQL Editor.

CREATE OR REPLACE FUNCTION public.change_payment_plan_atomic(
  p_account_id uuid, p_new_months integer, p_user_id uuid, p_reason text, p_apply boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_acc public.layaway_accounts%ROWTYPE;
  v_row public.layaway_schedule%ROWTYPE;
  v_min numeric; v_live_count int; v_live_max int;
  v_k int; v_k_max int; v_fixed_base numeric; v_fixed_due date;
  v_pool numeric; v_cnt int; v_per numeric; v_amt numeric; v_due date; v_end date;
  v_n int; v_new_id uuid; v_csr_lost int; v_pending int;
  v_new_rows jsonb := '[]'::jsonb; v_removed jsonb; v_old_rows jsonb;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RETURN jsonb_build_object('error', 'A reason is required.');
  END IF;
  SELECT * INTO v_acc FROM public.layaway_accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Account not found.'); END IF;
  IF v_acc.status::text NOT IN ('active', 'overdue') THEN
    RETURN jsonb_build_object('error', format('The plan can only be changed on active or overdue accounts (this one is %s).', v_acc.status));
  END IF;
  IF p_new_months IS NULL OR NOT (p_new_months = ANY (ARRAY[3, 6, 8])) THEN
    RETURN jsonb_build_object('error', 'The plan can only be changed to 3, 6 or 8 months.');
  END IF;
  IF p_new_months = v_acc.payment_plan_months THEN
    RETURN jsonb_build_object('error', format('The account is already on a %s-month plan.', p_new_months));
  END IF;
  SELECT CASE WHEN v_acc.currency::text = 'JPY' THEN min_amount_jpy ELSE min_amount_php END INTO v_min
    FROM public.plan_configurations WHERE plan_months = p_new_months AND is_active;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', format('%s-month plans are not active.', p_new_months));
  END IF;
  IF COALESCE(v_min, 0) > 0 AND v_acc.total_amount < v_min THEN
    RETURN jsonb_build_object('error', format('A %s-month plan needs a total of at least %s %s; this account is %s.',
      p_new_months, v_min, v_acc.currency, v_acc.total_amount));
  END IF;
  -- Pending submissions do NOT block (owner rule 2026-09-17): allocation happens
  -- at confirmation against the schedule as it is then, so they land on the new plan.
  SELECT count(*) INTO v_pending FROM public.payment_submissions ps
   WHERE ps.account_id = p_account_id
     AND ps.status::text IN ('submitted', 'under_review', 'needs_clarification');

  SELECT count(*), COALESCE(max(installment_number), 0) INTO v_live_count, v_live_max
    FROM public.layaway_schedule WHERE account_id = p_account_id AND status <> 'cancelled';
  IF v_live_count = 0 THEN
    RETURN jsonb_build_object('error', 'This account has no installments to re-plan.');
  END IF;
  IF v_live_count <> v_live_max THEN
    RETURN jsonb_build_object('error', 'The installments are not numbered 1 to N without gaps. Change this plan by hand.');
  END IF;

  SELECT count(*), COALESCE(max(s.installment_number), 0), COALESCE(sum(s.base_installment_amount), 0), max(s.due_date)
    INTO v_k, v_k_max, v_fixed_base, v_fixed_due
    FROM public.layaway_schedule s
   WHERE s.account_id = p_account_id AND s.status <> 'cancelled'
     AND (s.paid_amount > 0 OR s.status IN ('paid', 'partially_paid')
          OR COALESCE(s.penalty_amount, 0) > 0 OR COALESCE(s.carried_amount, 0) > 0
          OR s.carried_from_schedule_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM public.layaway_schedule c WHERE c.carried_from_schedule_id = s.id)
          OR EXISTS (SELECT 1 FROM public.payment_allocations pa WHERE pa.schedule_id = s.id)
          OR EXISTS (SELECT 1 FROM public.penalty_fees pf WHERE pf.schedule_id = s.id)
          OR EXISTS (SELECT 1 FROM public.penalty_waiver_requests w WHERE w.schedule_id = s.id));
  IF v_k <> v_k_max THEN
    RETURN jsonb_build_object('error', 'Installments with payments or penalties are not all at the start of the schedule. Change this plan by hand.');
  END IF;
  IF p_new_months <= v_k THEN
    RETURN jsonb_build_object('error', format('%s installments already carry payments or penalties, so the new plan must be longer than %s months.', v_k, v_k));
  END IF;
  IF EXISTS (SELECT 1 FROM public.layaway_schedule WHERE account_id = p_account_id AND status = 'cancelled'
             AND installment_number BETWEEN v_k + 1 AND p_new_months) THEN
    RETURN jsonb_build_object('error', 'A cancelled installment is in the way of the new numbering. Change this plan by hand.');
  END IF;

  v_pool := v_acc.total_amount - COALESCE(v_acc.downpayment_amount, 0) - v_fixed_base;
  v_cnt  := p_new_months - v_k;
  IF v_pool <= 0 THEN
    RETURN jsonb_build_object('error', 'Nothing is left to schedule after the downpayment and the installments already paid.');
  END IF;
  v_per := floor(v_pool / v_cnt);
  IF v_per < 1 THEN
    RETURN jsonb_build_object('error', 'The amount left is too small to spread over that many months.');
  END IF;
  IF v_k > 0 AND (v_acc.order_date + make_interval(months => v_k + 1))::date <= v_fixed_due THEN
    RETURN jsonb_build_object('error', format('Installment %s is due %s, on or after the standard date for installment %s. Change this plan by hand.',
      v_k, v_fixed_due, v_k + 1));
  END IF;

  FOR v_n IN (v_k + 1)..p_new_months LOOP
    v_due := (v_acc.order_date + make_interval(months => v_n))::date;
    v_amt := CASE WHEN v_n = p_new_months THEN v_pool - v_per * (v_cnt - 1) ELSE v_per END;
    v_new_rows := v_new_rows || jsonb_build_object('installment_number', v_n, 'due_date', v_due, 'amount', v_amt,
                    'action', CASE WHEN v_n <= v_live_max THEN 'update' ELSE 'add' END);
  END LOOP;
  v_end := (v_acc.order_date + make_interval(months => p_new_months))::date;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('installment_number', installment_number, 'due_date', due_date,
           'amount', base_installment_amount) ORDER BY installment_number), '[]'::jsonb)
    INTO v_removed FROM public.layaway_schedule
   WHERE account_id = p_account_id AND status <> 'cancelled' AND installment_number > p_new_months;
  SELECT count(*) INTO v_csr_lost FROM public.csr_notifications cn
    JOIN public.layaway_schedule s ON s.id = cn.schedule_id
   WHERE s.account_id = p_account_id AND s.status <> 'cancelled' AND s.installment_number > p_new_months;

  IF NOT p_apply THEN
    RETURN jsonb_build_object('preview', true, 'current_months', v_acc.payment_plan_months, 'new_months', p_new_months,
      'kept_installments', v_k, 'amount_to_spread', v_pool, 'new_rows', v_new_rows, 'removed_rows', v_removed,
      'csr_notifications_removed', v_csr_lost, 'pending_submissions', v_pending,
      'new_end_date', v_end, 'currency', v_acc.currency);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('installment_number', installment_number, 'due_date', due_date,
           'amount', base_installment_amount, 'status', status) ORDER BY installment_number), '[]'::jsonb)
    INTO v_old_rows FROM public.layaway_schedule WHERE account_id = p_account_id AND status <> 'cancelled';
  PERFORM set_config('app.bypass_immutable_schedule_cols', 'on', true);
  PERFORM set_config('app.allow_schedule_delete', 'on', true);

  FOR v_row IN SELECT * FROM public.layaway_schedule
                WHERE account_id = p_account_id AND status <> 'cancelled' AND installment_number > p_new_months
                ORDER BY installment_number DESC LOOP
    INSERT INTO public.schedule_audit_log (account_id, schedule_id, admin_user_id, action, field_changed, old_value, new_value, reason)
    VALUES (p_account_id, v_row.id, p_user_id, 'change_payment_plan_remove', 'installment',
            format('#%s %s %s', v_row.installment_number, v_row.due_date, v_row.base_installment_amount), NULL, p_reason);
    DELETE FROM public.layaway_schedule WHERE id = v_row.id;
  END LOOP;

  FOR v_n IN (v_k + 1)..p_new_months LOOP
    v_due := (v_acc.order_date + make_interval(months => v_n))::date;
    v_amt := CASE WHEN v_n = p_new_months THEN v_pool - v_per * (v_cnt - 1) ELSE v_per END;
    SELECT * INTO v_row FROM public.layaway_schedule
     WHERE account_id = p_account_id AND installment_number = v_n AND status <> 'cancelled';
    IF FOUND THEN
      INSERT INTO public.schedule_audit_log (account_id, schedule_id, admin_user_id, action, field_changed, old_value, new_value, reason)
      VALUES (p_account_id, v_row.id, p_user_id, 'change_payment_plan_update', 'due_date+base_installment_amount',
              format('%s %s', v_row.due_date, v_row.base_installment_amount), format('%s %s', v_due, v_amt), p_reason);
      UPDATE public.layaway_schedule
         SET base_installment_amount = v_amt, total_due_amount = v_amt, due_date = v_due, status = 'pending'
       WHERE id = v_row.id;
    ELSE
      INSERT INTO public.layaway_schedule (account_id, installment_number, due_date, base_installment_amount,
                                           penalty_amount, total_due_amount, paid_amount, currency, status)
      VALUES (p_account_id, v_n, v_due, v_amt, 0, v_amt, 0, v_acc.currency, 'pending')
      RETURNING id INTO v_new_id;
      INSERT INTO public.schedule_audit_log (account_id, schedule_id, admin_user_id, action, field_changed, old_value, new_value, reason)
      VALUES (p_account_id, v_new_id, p_user_id, 'change_payment_plan_add', 'installment', NULL,
              format('#%s %s %s', v_n, v_due, v_amt), p_reason);
    END IF;
  END LOOP;

  UPDATE public.layaway_accounts SET payment_plan_months = p_new_months, end_date = v_end WHERE id = p_account_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
  VALUES ('layaway_account', p_account_id, 'change_payment_plan',
          jsonb_build_object('payment_plan_months', v_acc.payment_plan_months, 'end_date', v_acc.end_date, 'rows', v_old_rows),
          jsonb_build_object('payment_plan_months', p_new_months, 'end_date', v_end, 'rows', v_new_rows,
                             'removed_rows', v_removed, 'pending_submissions', v_pending, 'reason', p_reason),
          p_user_id);

  RETURN jsonb_build_object('success', true, 'current_months', v_acc.payment_plan_months, 'new_months', p_new_months,
    'kept_installments', v_k, 'new_rows', v_new_rows, 'removed_rows', v_removed,
    'pending_submissions', v_pending, 'new_end_date', v_end);
END;
$function$;

REVOKE ALL ON FUNCTION public.change_payment_plan_atomic(uuid, integer, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.change_payment_plan_atomic(uuid, integer, uuid, text, boolean) TO service_role;
