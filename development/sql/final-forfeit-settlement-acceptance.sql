-- Acceptance for 20261226100000_final_forfeit_same_day_settlement.sql (R7).
-- Runs on the local stub (development/sql/final-forfeit-settlement.sh): the
-- stub, then the migration, then this file. Every line prints PASS or FAIL;
-- the runner fails on any FAIL. Everything is rolled back.
BEGIN;

CREATE TEMP TABLE results (n serial, line text);
CREATE FUNCTION pg_temp.t(label text, ok boolean, detail text DEFAULT '') RETURNS void
LANGUAGE sql AS $$ INSERT INTO results (line) VALUES (CASE WHEN ok THEN 'PASS ' ELSE 'FAIL ' END || label || CASE WHEN ok THEN '' ELSE ' — ' || coalesce(detail, '') END) $$;

-- A final_forfeited plan: 6 months of `inst`, `paid` received, final forfeiture
-- `ff_days_ago` days ago, optionally a web plan whose one piece was released.
CREATE FUNCTION pg_temp.mk(cur text, inst numeric, paid numeric, ff_days_ago int, web boolean DEFAULT false, stock int DEFAULT 1)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE a uuid := gen_random_uuid(); v uuid; i int;
BEGIN
  INSERT INTO layaway_accounts (id, customer_id, invoice_number, status, currency, total_amount, remaining_balance,
                                source_channel, stock_released_at, web_reference)
  VALUES (a, gen_random_uuid(), 'T' || substr(a::text, 1, 6), 'final_forfeited', cur::account_currency, inst * 6,
          inst * 6 - paid, CASE WHEN web THEN 'web' END, CASE WHEN web THEN now() END, CASE WHEN web THEN 'CJ-W-T' END);
  FOR i IN 1..6 LOOP
    INSERT INTO layaway_schedule (account_id, installment_number, due_date, base_installment_amount, total_due_amount,
                                  currency, status)
    VALUES (a, i, current_date - (7 - i) * 30, inst, inst, cur::account_currency,
            CASE WHEN i <= 2 THEN 'paid'::schedule_status ELSE 'overdue'::schedule_status END);
  END LOOP;
  IF paid > 0 THEN INSERT INTO payments (account_id, amount_paid) VALUES (a, paid); END IF;
  INSERT INTO audit_logs (entity_type, entity_id, action, created_at)
  VALUES ('layaway_account', a, 'final_forfeited', now() - make_interval(days => ff_days_ago));
  IF web THEN
    INSERT INTO website_product_variants (stock_qty) VALUES (stock) RETURNING id INTO v;
    INSERT INTO layaway_account_items (account_id, title, quantity, variant_id) VALUES (a, 'Ring', 1, v);
  END IF;
  RETURN a;
END $$;

CREATE FUNCTION pg_temp.row6(a uuid) RETURNS uuid LANGUAGE sql AS
$$ SELECT id FROM layaway_schedule WHERE account_id = a AND installment_number = 6 $$;
CREATE FUNCTION pg_temp.pen(a uuid, amt numeric, stage text DEFAULT 'week1', cyc int DEFAULT 2) RETURNS jsonb LANGUAGE sql AS
$$ SELECT jsonb_build_array(jsonb_build_object('schedule_id', pg_temp.row6(a), 'stage', stage, 'cycle', cyc,
        'amount', amt, 'penalty_date', (now() AT TIME ZONE 'Asia/Manila')::date)) $$;
CREATE FUNCTION pg_temp.go(a uuid, amt numeric, pens jsonb, preview boolean DEFAULT false,
                           proof text DEFAULT 'https://x/payment-proofs/p.jpg',
                           usr uuid DEFAULT 'aaaaaaaa-0000-0000-0000-000000000001') RETURNS jsonb LANGUAGE sql AS
$$ SELECT public.settle_final_forfeited_same_day_atomic(a, usr, amt, NULL, 'bank_transfer', 'REF', 'Ana', NULL, proof, pens, preview) $$;

DO $$
DECLARE a uuid; b uuid; r jsonb; s uuid; v uuid; due numeric;
BEGIN
  -- 1. PHP, submitted ON the day, with that day's penalty: preview writes nothing.
  a := pg_temp.mk('PHP', 4000, 8000, 0);           -- remaining 16000, +500 penalty
  r := pg_temp.go(a, 16500, pg_temp.pen(a, 500), true);
  PERFORM pg_temp.t('1 preview on the day: ok, amount 16500', (r ->> 'ok')::boolean AND (r ->> 'amount')::numeric = 16500, r::text);
  PERFORM pg_temp.t('1b preview wrote nothing', NOT EXISTS (SELECT 1 FROM payment_submissions WHERE account_id = a)
                     AND NOT EXISTS (SELECT 1 FROM penalty_fees WHERE account_id = a));

  -- 2. Submit for real: submission + penalty that SURVIVES trg_auto_waive_same_day.
  r := pg_temp.go(a, 16500, pg_temp.pen(a, 500));
  s := (r ->> 'submission_id')::uuid;
  PERFORM pg_temp.t('2 submit on the day: ok', (r ->> 'ok')::boolean, r::text);
  PERFORM pg_temp.t('2b submission is the settlement type, submitted, full amount',
    EXISTS (SELECT 1 FROM payment_submissions WHERE id = s AND submission_type = 'final_forfeit_settlement'
            AND status = 'submitted' AND submitted_amount = 16500));
  PERFORM pg_temp.t('2c that day''s penalty charged and still unpaid (not auto-waived)',
    (SELECT count(*) FROM penalty_fees WHERE account_id = a AND status = 'unpaid' AND penalty_amount = 500
       AND penalty_stage = 'week1' AND penalty_cycle = 2) = 1);
  PERFORM pg_temp.t('2d schedule cache = base + penalty',
    EXISTS (SELECT 1 FROM layaway_schedule WHERE id = pg_temp.row6(a) AND penalty_amount = 500 AND total_due_amount = 4500));
  PERFORM pg_temp.t('2e remaining_balance = settlement amount',
    (SELECT remaining_balance FROM layaway_accounts WHERE id = a) = 16500);
  PERFORM pg_temp.t('2f audit row', EXISTS (SELECT 1 FROM audit_logs WHERE entity_id = a AND action = 'final_forfeit_settlement_submitted'));

  -- 3. Confirmed LATER completes: the allocate_payment_atomic formula reaches 0
  --    when exactly the settlement amount is received (no date in that formula).
  INSERT INTO payments (account_id, amount_paid) VALUES (a, 16500);
  SELECT greatest(0, la.total_amount
           + (SELECT coalesce(sum(penalty_amount), 0) FROM penalty_fees WHERE account_id = a AND status <> 'waived')
           - (SELECT coalesce(sum(amount_paid), 0) FROM payments WHERE account_id = a AND voided_at IS NULL))
    INTO due FROM layaway_accounts la WHERE la.id = a;
  PERFORM pg_temp.t('3 confirming the full amount leaves 0 (status completed in allocate)', due = 0, due::text);
  DELETE FROM payments WHERE account_id = a AND amount_paid = 16500;

  -- 4. Frozen-submission rule: the settlement itself is pending → a second try refused.
  r := pg_temp.go(a, 16500, '[]'::jsonb);
  PERFORM pg_temp.t('4 second attempt while the first is pending: submission_pending', r ->> 'error' = 'submission_pending', r::text);
  -- 5. One per account: after a CONFIRMED settlement → already_settled.
  UPDATE payment_submissions SET status = 'confirmed' WHERE id = s;
  r := pg_temp.go(a, 16500, '[]'::jsonb);
  PERFORM pg_temp.t('5 second attempt after a confirmed settlement: already_settled', r ->> 'error' = 'already_settled', r::text);

  -- 6. The NEXT day: refused, nothing written.
  b := pg_temp.mk('PHP', 4000, 8000, 1);
  r := pg_temp.go(b, 16500, pg_temp.pen(b, 500));
  PERFORM pg_temp.t('6 submitted the day after: settlement_day_passed', r ->> 'error' = 'settlement_day_passed', r::text);
  PERFORM pg_temp.t('6b nothing written', NOT EXISTS (SELECT 1 FROM payment_submissions WHERE account_id = b));

  -- 7. JPY at cap: no penalty that day → the amount is the remaining balance only.
  b := pg_temp.mk('JPY', 20000, 40000, 0);
  r := pg_temp.go(b, 80000, '[]'::jsonb);
  PERFORM pg_temp.t('7 JPY at cap: no penalty, amount = remaining 80000', (r ->> 'ok')::boolean AND (r ->> 'penalty_total')::numeric = 0, r::text);
  PERFORM pg_temp.t('7b no penalty row written', NOT EXISTS (SELECT 1 FROM penalty_fees WHERE account_id = b));
  -- 7c JPY penalty charged: 1000 accepted, 1001 refused (above the engine's per-event amount).
  b := pg_temp.mk('JPY', 20000, 40000, 0);
  r := pg_temp.go(b, 81001, pg_temp.pen(b, 1001), true);
  PERFORM pg_temp.t('7c JPY penalty above the engine amount: penalties_invalid', r ->> 'error' = 'penalties_invalid', r::text);
  r := pg_temp.go(b, 81000, pg_temp.pen(b, 1000));
  PERFORM pg_temp.t('7d JPY penalty 1000 charged', (r ->> 'ok')::boolean AND
    EXISTS (SELECT 1 FROM penalty_fees WHERE account_id = b AND penalty_amount = 1000 AND status = 'unpaid'), r::text);

  -- 8. The engine already charged today's slot before the final forfeiture:
  --    nothing new, and the trigger's auto-waive of it is undone.
  b := pg_temp.mk('PHP', 4000, 8000, 0);
  INSERT INTO penalty_fees (account_id, schedule_id, currency, penalty_amount, penalty_stage, penalty_cycle, penalty_date)
  VALUES (b, pg_temp.row6(b), 'PHP', 500, 'week1', 2, (now() AT TIME ZONE 'Asia/Tokyo')::date);
  r := pg_temp.go(b, 16500, pg_temp.pen(b, 500));
  PERFORM pg_temp.t('8 slot already taken: penalty_slot_taken', r ->> 'error' = 'penalty_slot_taken', r::text);
  r := pg_temp.go(b, 16500, '[]'::jsonb);
  PERFORM pg_temp.t('8b same-day engine penalty is part of the amount', (r ->> 'ok')::boolean, r::text);
  PERFORM pg_temp.t('8c ...and stays unpaid after the submission insert',
    (SELECT status FROM penalty_fees WHERE account_id = b) = 'unpaid');
  PERFORM pg_temp.t('8d the auto-waive request is marked rejected and audited',
    EXISTS (SELECT 1 FROM penalty_waiver_requests WHERE account_id = b AND status = 'rejected')
    AND EXISTS (SELECT 1 FROM audit_logs WHERE entity_id = b AND action = 'auto_waiver_reverted'));
  PERFORM pg_temp.t('8e schedule cache keeps the penalty',
    EXISTS (SELECT 1 FROM layaway_schedule WHERE id = pg_temp.row6(b) AND penalty_amount = 500 AND total_due_amount = 4500));

  -- 9. Web plan: piece in stock is re-held; rejecting the settlement releases it again.
  b := pg_temp.mk('PHP', 4000, 8000, 0, true, 1);
  v := (SELECT variant_id FROM layaway_account_items WHERE account_id = b);
  r := pg_temp.go(b, 16000, '[]'::jsonb);
  s := (r ->> 'submission_id')::uuid;
  PERFORM pg_temp.t('9 web: re-held', (r ->> 'rehold')::boolean
    AND (SELECT stock_qty FROM website_product_variants WHERE id = v) = 0
    AND (SELECT stock_released_at FROM layaway_accounts WHERE id = b) IS NULL, r::text);
  UPDATE payment_submissions SET status = 'rejected' WHERE id = s;
  r := public.release_final_forfeit_settlement_hold(s);
  PERFORM pg_temp.t('9b rejected: piece back on sale', (r ->> 'ok')::boolean
    AND (SELECT stock_qty FROM website_product_variants WHERE id = v) = 1
    AND (SELECT stock_released_at FROM layaway_accounts WHERE id = b) IS NOT NULL, r::text);
  r := public.release_final_forfeit_settlement_hold(s);
  PERFORM pg_temp.t('9c release is idempotent', r ->> 'skipped' = 'nothing_held'
    AND (SELECT stock_qty FROM website_product_variants WHERE id = v) = 1, r::text);
  -- 9d A rejected settlement frees the one slot (still the same day only).
  r := pg_temp.go(b, 16000, '[]'::jsonb);
  PERFORM pg_temp.t('9d retry after a REJECTED settlement: ok', (r ->> 'ok')::boolean, r::text);

  -- 10. Web out_of_stock: refused BEFORE anything is written.
  b := pg_temp.mk('PHP', 4000, 8000, 0, true, 0);
  r := pg_temp.go(b, 16500, pg_temp.pen(b, 500));
  PERFORM pg_temp.t('10 web piece sold: out_of_stock', r ->> 'error' = 'out_of_stock', r::text);
  PERFORM pg_temp.t('10b nothing written', NOT EXISTS (SELECT 1 FROM payment_submissions WHERE account_id = b)
    AND NOT EXISTS (SELECT 1 FROM penalty_fees WHERE account_id = b)
    AND (SELECT stock_released_at FROM layaway_accounts WHERE id = b) IS NOT NULL);

  -- 11. Full amount only; proof; permission; status.
  b := pg_temp.mk('PHP', 4000, 8000, 0);
  r := pg_temp.go(b, 16000, pg_temp.pen(b, 500));
  PERFORM pg_temp.t('11 partial amount: amount_mismatch', r ->> 'error' = 'amount_mismatch' AND (r ->> 'expected')::numeric = 16500, r::text);
  r := pg_temp.go(b, 16500, pg_temp.pen(b, 500), false, NULL);
  PERFORM pg_temp.t('11b no proof: proof_required', r ->> 'error' = 'proof_required', r::text);
  r := pg_temp.go(b, 16500, pg_temp.pen(b, 500), false, 'https://x/p.jpg', gen_random_uuid());
  PERFORM pg_temp.t('11c no record_payment: permission_denied', r ->> 'error' = 'permission_denied', r::text);
  r := pg_temp.go(b, 16500, pg_temp.pen(b, 500, 'week1', 2) || jsonb_build_array(jsonb_build_object(
         'schedule_id', pg_temp.row6(b), 'stage', 'week2', 'cycle', 2, 'amount', 500, 'penalty_date', current_date - 3)));
  PERFORM pg_temp.t('11d a penalty not dated the forfeiture day: penalties_invalid', r ->> 'error' = 'penalties_invalid', r::text);
  UPDATE layaway_accounts SET status = 'completed' WHERE id = b;
  r := pg_temp.go(b, 16500, pg_temp.pen(b, 500));
  PERFORM pg_temp.t('11e not final_forfeited: refused', r ->> 'error' = 'not_final_forfeited', r::text);
  PERFORM pg_temp.t('11f none of the refusals wrote anything', NOT EXISTS (SELECT 1 FROM payment_submissions WHERE account_id = b)
    AND NOT EXISTS (SELECT 1 FROM penalty_fees WHERE account_id = b));

  -- 12. A pending NON-settlement submission freezes it too (INVARIANT 12).
  b := pg_temp.mk('PHP', 4000, 8000, 0);
  INSERT INTO payment_submissions (customer_id, account_id, submitted_amount, payment_date, payment_method, status)
  VALUES (gen_random_uuid(), b, 4000, current_date, 'gcash', 'under_review');
  r := pg_temp.go(b, 16500, pg_temp.pen(b, 500));
  PERFORM pg_temp.t('12 other pending submission: submission_pending', r ->> 'error' = 'submission_pending', r::text);

  -- 13. Grants: service_role only.
  PERFORM pg_temp.t('13 not executable by authenticated',
    NOT has_function_privilege('authenticated', 'public.settle_final_forfeited_same_day_atomic(uuid,uuid,numeric,date,text,text,text,text,text,jsonb,boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.release_final_forfeit_settlement_hold(uuid)', 'EXECUTE')
    AND has_function_privilege('service_role', 'public.settle_final_forfeited_same_day_atomic(uuid,uuid,numeric,date,text,text,text,text,text,jsonb,boolean)', 'EXECUTE'));
END $$;

SELECT line FROM results ORDER BY n;
ROLLBACK;
