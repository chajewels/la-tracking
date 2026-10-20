-- ============================================================================
-- SAME-DAY FINAL-FORFEIT SETTLEMENT (owner rule R7, approved 2026-10-20)
-- docs/PENALTY-AND-FORFEITURE.md "Same-day settlement after final forfeiture".
--
-- Two NEW functions, both SECURITY DEFINER and service_role only. Nothing else
-- is redefined; no table or column changes. Applied by the owner (no db push).
--
-- 1. settle_final_forfeited_same_day_atomic — called only by the
--    settle-final-forfeited edge function (staff need record_payment). One
--    transaction:
--      * the account is final_forfeited and TODAY (PHT) is the PHT day of its
--        final_forfeited audit row (the settlement is SUBMITTED that day);
--      * no pending submission (INVARIANT 12) and no earlier settlement that
--        was not rejected (one settlement per account);
--      * proof attached;
--      * the penalties passed in (that day's engine slot, computed by
--        _shared/final-forfeit-settlement.ts) are re-checked: the account's
--        own open row, penalty_date = that day, amount > 0 and no more than
--        the engine's configured per-event amount, slot still free;
--      * the amount must be EXACTLY total_amount + non-waived penalties
--        (including the new ones) − non-voided payments — the
--        allocate_payment_atomic formula, so Confirm completes the account;
--      * a web plan whose pieces were released gets them back or the call
--        refuses out_of_stock BEFORE anything is written;
--    then writes: re-hold (web), the submission (submission_type
--    'final_forfeit_settlement'), the penalty rows, the schedule cache and the
--    remaining balance, one audit row.
--    The submission is inserted BEFORE the penalty rows on purpose: the live
--    trigger trg_auto_waive_same_day (auto_waive_same_day_penalties) waives
--    every unpaid penalty dated the submission's day when a submission is
--    inserted; inserting the penalty afterwards keeps the owner's R7 charge,
--    and any auto-waive that trigger did for THIS submission (a penalty the
--    engine charged earlier the same day) is undone in the same transaction.
--
-- 2. release_final_forfeit_settlement_hold — called by review-payment-submission
--    when a settlement submission is REJECTED: a web plan's re-held pieces go
--    back on sale (the account is still final_forfeited). Idempotent.
--
-- p_preview = true computes and checks everything and writes NOTHING.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.settle_final_forfeited_same_day_atomic(
  p_account_id       uuid,
  p_user_id          uuid,
  p_amount           numeric,
  p_payment_date     date,
  p_payment_method   text,
  p_reference_number text,
  p_sender_name      text,
  p_notes            text,
  p_proof_url        text,
  p_penalties        jsonb,
  p_preview          boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_acc      public.layaway_accounts%ROWTYPE;
  v_ff_at    timestamptz;
  v_ff_day   date;
  v_today    date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_pen      jsonb;
  v_row      public.layaway_schedule%ROWTYPE;
  v_stage    text;
  v_cycle    integer;
  v_amt      numeric;
  v_max      numeric;
  v_new_pen  numeric := 0;
  v_pen_sum  numeric;
  v_paid     numeric;
  v_amount   numeric;
  v_short    jsonb;
  v_lines    integer := 0;
  v_taken    integer := 0;
  v_rehold   boolean := false;
  v_sub_id   uuid;
  v_sched_id uuid;
  v_sched    numeric;
  v_waiver   record;
  v_unwaived uuid[] := '{}';
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT public.has_permission(p_user_id, 'record_payment') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_acc FROM public.layaway_accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_acc.status::text <> 'final_forfeited' THEN
    RETURN jsonb_build_object('error', 'not_final_forfeited', 'status', v_acc.status);
  END IF;

  SELECT max(created_at) INTO v_ff_at
    FROM public.audit_logs
   WHERE entity_type = 'layaway_account' AND entity_id = p_account_id AND action = 'final_forfeited';
  IF v_ff_at IS NULL THEN
    RETURN jsonb_build_object('error', 'final_forfeit_date_unknown');
  END IF;
  v_ff_day := (v_ff_at AT TIME ZONE 'Asia/Manila')::date;
  IF v_ff_day <> v_today THEN
    RETURN jsonb_build_object('error', 'settlement_day_passed', 'final_forfeit_day', v_ff_day, 'today', v_today);
  END IF;

  IF EXISTS (SELECT 1 FROM public.payment_submissions
              WHERE account_id = p_account_id AND status::text IN ('submitted', 'under_review')) THEN
    RETURN jsonb_build_object('error', 'submission_pending');
  END IF;
  IF EXISTS (SELECT 1 FROM public.payment_submissions
              WHERE account_id = p_account_id AND submission_type = 'final_forfeit_settlement'
                AND status::text <> 'rejected') THEN
    RETURN jsonb_build_object('error', 'already_settled');
  END IF;
  IF NOT p_preview AND nullif(btrim(coalesce(p_proof_url, '')), '') IS NULL THEN
    RETURN jsonb_build_object('error', 'proof_required');
  END IF;
  IF jsonb_typeof(coalesce(p_penalties, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('error', 'penalties_invalid');
  END IF;

  -- That day's engine slot(s), re-checked here.
  FOR v_pen IN SELECT * FROM jsonb_array_elements(coalesce(p_penalties, '[]'::jsonb)) LOOP
    v_stage := v_pen ->> 'stage';
    v_cycle := (v_pen ->> 'cycle')::integer;
    v_amt   := round((v_pen ->> 'amount')::numeric, 2);
    SELECT * INTO v_row FROM public.layaway_schedule WHERE id = (v_pen ->> 'schedule_id')::uuid;
    IF NOT FOUND OR v_row.account_id <> p_account_id
       OR v_row.status::text NOT IN ('pending', 'overdue', 'partially_paid') THEN
      RETURN jsonb_build_object('error', 'penalties_invalid', 'reason', 'schedule_row');
    END IF;
    IF v_stage NOT IN ('week1', 'week2') OR v_cycle IS NULL OR v_cycle < 1 OR v_cycle > 13
       OR (v_pen ->> 'penalty_date')::date IS DISTINCT FROM v_ff_day THEN
      RETURN jsonb_build_object('error', 'penalties_invalid', 'reason', 'slot');
    END IF;
    v_max := coalesce(
      (SELECT (value #>> '{}')::numeric FROM public.system_settings
        WHERE key = 'penalty_' || lower(v_acc.currency::text) || '_' || v_stage),
      CASE WHEN v_acc.currency::text = 'PHP' THEN 500 ELSE 1000 END);
    IF v_amt IS NULL OR v_amt <= 0 OR v_amt > v_max THEN
      RETURN jsonb_build_object('error', 'penalties_invalid', 'reason', 'amount');
    END IF;
    IF EXISTS (SELECT 1 FROM public.penalty_fees
                WHERE schedule_id = v_row.id AND penalty_stage::text = v_stage AND penalty_cycle = v_cycle) THEN
      RETURN jsonb_build_object('error', 'penalty_slot_taken', 'stage', v_stage, 'cycle', v_cycle);
    END IF;
    v_new_pen := v_new_pen + v_amt;
  END LOOP;

  SELECT coalesce(sum(penalty_amount), 0) INTO v_pen_sum
    FROM public.penalty_fees WHERE account_id = p_account_id AND status::text <> 'waived';
  SELECT coalesce(sum(amount_paid), 0) INTO v_paid
    FROM public.payments WHERE account_id = p_account_id AND voided_at IS NULL;
  v_amount := greatest(0, round(v_acc.total_amount + v_pen_sum + v_new_pen - v_paid, 2));
  IF v_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'nothing_to_pay');
  END IF;
  IF round(coalesce(p_amount, -1), 2) <> v_amount THEN
    RETURN jsonb_build_object('error', 'amount_mismatch', 'expected', v_amount);
  END IF;

  -- A web plan's pieces released at forfeiture: re-hold all, or refuse first.
  IF v_acc.source_channel = 'web' AND v_acc.stock_released_at IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object(
             'variant_id', i.variant_id, 'title', i.title, 'sku', i.sku,
             'wanted', i.quantity, 'available', coalesce(v.stock_qty, 0)))
      INTO v_short
      FROM public.layaway_account_items i
      LEFT JOIN public.website_product_variants v ON v.id = i.variant_id
     WHERE i.account_id = p_account_id
       AND (v.id IS NULL OR v.stock_qty < i.quantity);
    IF v_short IS NOT NULL THEN
      RETURN jsonb_build_object('error', 'out_of_stock', 'lines', v_short);
    END IF;
    v_rehold := true;
  END IF;

  IF p_preview THEN
    RETURN jsonb_build_object('ok', true, 'preview', true, 'amount', v_amount,
                              'penalties', coalesce(p_penalties, '[]'::jsonb),
                              'penalty_total', v_new_pen, 'rehold', v_rehold,
                              'final_forfeit_day', v_ff_day);
  END IF;

  -- ── Writes: all commit or roll back together ──
  IF v_rehold THEN
    SELECT count(*) INTO v_lines FROM public.layaway_account_items WHERE account_id = p_account_id;
    WITH taken AS (
      UPDATE public.website_product_variants v
         SET stock_qty = v.stock_qty - i.quantity, updated_at = now()
        FROM public.layaway_account_items i
       WHERE i.account_id = p_account_id AND v.id = i.variant_id
         AND v.stock_qty >= i.quantity
       RETURNING v.id
    )
    SELECT count(*) INTO v_taken FROM taken;
    IF v_taken <> v_lines THEN
      RAISE EXCEPTION 'web_layaway_stock_unavailable: % — took % of % lines; nothing applied',
        coalesce(v_acc.web_reference, v_acc.invoice_number), v_taken, v_lines USING ERRCODE = 'P0001';
    END IF;
    UPDATE public.layaway_accounts SET stock_released_at = NULL WHERE id = p_account_id;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
    VALUES ('layaway_account', p_account_id, 'web_layaway_stock_reheld', p_user_id,
            jsonb_build_object('status', v_acc.status, 'invoice_number', v_acc.invoice_number,
                               'web_reference', v_acc.web_reference, 'stock_lines_taken', v_taken,
                               'reason', 'final_forfeit_same_day_settlement'));
  END IF;

  -- The submission FIRST (see header: trg_auto_waive_same_day).
  INSERT INTO public.payment_submissions (
    customer_id, account_id, submitted_amount, payment_date, payment_method,
    reference_number, sender_name, notes, proof_url, status, submission_type
  ) VALUES (
    v_acc.customer_id, p_account_id, v_amount, coalesce(p_payment_date, v_today), p_payment_method,
    nullif(btrim(coalesce(p_reference_number, '')), ''), nullif(btrim(coalesce(p_sender_name, '')), ''),
    'Same-day settlement after final forfeiture' || coalesce(E'\n' || nullif(btrim(coalesce(p_notes, '')), ''), ''),
    p_proof_url, 'submitted', 'final_forfeit_settlement'
  ) RETURNING id INTO v_sub_id;

  -- trg_auto_waive_same_day has just waived any unpaid penalty dated the
  -- submission's JST day (one the engine charged earlier today, or one left by
  -- a rejected first attempt). Those are part of the amount above and of the
  -- owner's R7 charge, so this settlement's auto-waives are undone here, in the
  -- same transaction, exactly as revert_auto_waive_on_rejection undoes them.
  FOR v_waiver IN SELECT * FROM public.penalty_waiver_requests
                   WHERE source_submission_id = v_sub_id AND is_auto = true AND status = 'approved' LOOP
    UPDATE public.penalty_fees SET status = 'unpaid', waived_at = NULL WHERE id = v_waiver.penalty_fee_id;
    UPDATE public.penalty_waiver_requests
       SET status = 'rejected', rejected_at = now(), approved_at = NULL WHERE id = v_waiver.id;
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
    VALUES ('penalty_waiver', p_account_id, 'auto_waiver_reverted',
            jsonb_build_object('penalty_fee_id', v_waiver.penalty_fee_id, 'waiver_id', v_waiver.id,
                               'submission_id', v_sub_id,
                               'note', 'Same-day settlement after final forfeiture: that day''s penalty stands (R7).'));
    v_unwaived := array_append(v_unwaived, v_waiver.schedule_id);
  END LOOP;

  FOR v_pen IN SELECT * FROM jsonb_array_elements(coalesce(p_penalties, '[]'::jsonb)) LOOP
    INSERT INTO public.penalty_fees (account_id, schedule_id, currency, penalty_amount,
                                     penalty_stage, penalty_cycle, penalty_date)
    VALUES (p_account_id, (v_pen ->> 'schedule_id')::uuid, v_acc.currency,
            round((v_pen ->> 'amount')::numeric, 2), (v_pen ->> 'stage')::penalty_stage,
            (v_pen ->> 'cycle')::integer, v_ff_day);
  END LOOP;

  -- Schedule cache: base + non-waived penalties + carried (CARRIED_AMOUNT PRESERVATION).
  FOR v_sched_id IN SELECT DISTINCT x FROM (
                      SELECT (e ->> 'schedule_id')::uuid AS x
                        FROM jsonb_array_elements(coalesce(p_penalties, '[]'::jsonb)) e
                      UNION SELECT unnest(v_unwaived)) s WHERE x IS NOT NULL LOOP
    SELECT coalesce(sum(penalty_amount), 0) INTO v_sched
      FROM public.penalty_fees WHERE schedule_id = v_sched_id AND status::text <> 'waived';
    UPDATE public.layaway_schedule
       SET penalty_amount = v_sched,
           total_due_amount = base_installment_amount + v_sched + coalesce(carried_amount, 0)
     WHERE id = v_sched_id;
  END LOOP;

  UPDATE public.layaway_accounts SET remaining_balance = v_amount WHERE id = p_account_id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id, new_value_json)
  VALUES ('layaway_account', p_account_id, 'final_forfeit_settlement_submitted', p_user_id,
          jsonb_build_object('invoice_number', v_acc.invoice_number, 'submission_id', v_sub_id,
                             'amount', v_amount, 'penalties', coalesce(p_penalties, '[]'::jsonb),
                             'penalty_total', v_new_pen, 'rehold', v_rehold,
                             'final_forfeit_day', v_ff_day));

  RETURN jsonb_build_object('ok', true, 'submission_id', v_sub_id, 'amount', v_amount,
                            'penalties', coalesce(p_penalties, '[]'::jsonb),
                            'penalty_total', v_new_pen, 'rehold', v_rehold,
                            'final_forfeit_day', v_ff_day);
END $function$;

COMMENT ON FUNCTION public.settle_final_forfeited_same_day_atomic(uuid, uuid, numeric, date, text, text, text, text, text, jsonb, boolean) IS
  'R7 (owner 2026-10-20): one full same-day settlement for a final_forfeited layaway, submitted on the PHT day of the final forfeiture. Re-holds a web plan''s pieces or refuses out_of_stock first; inserts the submission, then that day''s engine penalty slot. Called only by settle-final-forfeited.';

REVOKE ALL ON FUNCTION public.settle_final_forfeited_same_day_atomic(uuid, uuid, numeric, date, text, text, text, text, text, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_final_forfeited_same_day_atomic(uuid, uuid, numeric, date, text, text, text, text, text, jsonb, boolean) TO service_role;


CREATE OR REPLACE FUNCTION public.release_final_forfeit_settlement_hold(p_submission_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sub      public.payment_submissions%ROWTYPE;
  v_acc      public.layaway_accounts%ROWTYPE;
  v_restored integer := 0;
BEGIN
  SELECT * INTO v_sub FROM public.payment_submissions WHERE id = p_submission_id;
  IF NOT FOUND OR v_sub.submission_type IS DISTINCT FROM 'final_forfeit_settlement' THEN
    RETURN jsonb_build_object('skipped', 'not_a_settlement');
  END IF;
  IF v_sub.status::text <> 'rejected' THEN
    RETURN jsonb_build_object('skipped', 'not_rejected');
  END IF;

  SELECT * INTO v_acc FROM public.layaway_accounts WHERE id = v_sub.account_id FOR UPDATE;
  IF NOT FOUND OR v_acc.status::text <> 'final_forfeited'
     OR v_acc.source_channel IS DISTINCT FROM 'web' OR v_acc.stock_released_at IS NOT NULL THEN
    RETURN jsonb_build_object('skipped', 'nothing_held');
  END IF;
  -- Only a hold this settlement took.
  IF NOT EXISTS (SELECT 1 FROM public.audit_logs
                  WHERE entity_type = 'layaway_account' AND entity_id = v_acc.id
                    AND action = 'final_forfeit_settlement_submitted'
                    AND new_value_json ->> 'submission_id' = p_submission_id::text
                    AND (new_value_json ->> 'rehold')::boolean) THEN
    RETURN jsonb_build_object('skipped', 'not_held_by_settlement');
  END IF;

  UPDATE public.website_product_variants v
     SET stock_qty = v.stock_qty + i.quantity, updated_at = now()
    FROM public.layaway_account_items i
   WHERE i.account_id = v_acc.id AND i.variant_id = v.id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  UPDATE public.layaway_accounts SET stock_released_at = now() WHERE id = v_acc.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json)
  VALUES ('layaway_account', v_acc.id, 'web_layaway_stock_released',
          jsonb_build_object('status', v_acc.status, 'invoice_number', v_acc.invoice_number,
                             'web_reference', v_acc.web_reference, 'stock_lines_restored', v_restored,
                             'reason', 'final_forfeit_settlement_rejected', 'submission_id', p_submission_id));

  RETURN jsonb_build_object('ok', true, 'stock_lines_restored', v_restored);
END $function$;

COMMENT ON FUNCTION public.release_final_forfeit_settlement_hold(uuid) IS
  'R7: a rejected same-day settlement puts a web plan''s re-held pieces back on sale. Idempotent. Called only by review-payment-submission.';

REVOKE ALL ON FUNCTION public.release_final_forfeit_settlement_hold(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_final_forfeit_settlement_hold(uuid) TO service_role;

-- ============================================================================
-- VERIFY (read-only). Expect two rows, each with prosecdef = true and
-- service_role the only grantee besides the owner.
--
-- SELECT p.proname, p.prosecdef, p.proacl
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('settle_final_forfeited_same_day_atomic', 'release_final_forfeit_settlement_hold');
-- ============================================================================
