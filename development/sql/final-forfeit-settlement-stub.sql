-- Minimal stand-in of the live tables the R7 migration touches, for a throwaway
-- local Postgres (development/sql/final-forfeit-settlement.sh). Column names and
-- enum labels read from live 2026-10-20; the three triggers below are copied
-- verbatim from live pg_get_functiondef (auto-waive, revert-on-reject, release
-- on forfeit) so their interaction with the new functions is tested for real.
-- NOT a migration. Never run against live.

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TYPE account_currency AS ENUM ('PHP','JPY');
CREATE TYPE account_status AS ENUM ('active','completed','cancelled','overdue','forfeited','final_settlement','reactivated','extension_active','final_forfeited');
CREATE TYPE penalty_fee_status AS ENUM ('unpaid','paid','waived');
CREATE TYPE penalty_stage AS ENUM ('week1','week2');
CREATE TYPE schedule_status AS ENUM ('pending','partially_paid','paid','overdue','cancelled');
CREATE TYPE submission_status AS ENUM ('submitted','under_review','confirmed','rejected','needs_clarification','cancelled');
CREATE TYPE waiver_status AS ENUM ('pending','approved','rejected','auto_unwaived');

CREATE TABLE layaway_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, invoice_number text NOT NULL,
  status account_status NOT NULL, currency account_currency NOT NULL, total_amount numeric NOT NULL,
  remaining_balance numeric, source_channel text, stock_released_at timestamptz, web_reference text);
CREATE TABLE layaway_schedule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, installment_number integer NOT NULL,
  due_date date NOT NULL, base_installment_amount numeric NOT NULL, penalty_amount numeric DEFAULT 0,
  total_due_amount numeric NOT NULL, paid_amount numeric DEFAULT 0, currency account_currency NOT NULL,
  status schedule_status DEFAULT 'pending', carried_amount numeric DEFAULT 0);
CREATE TABLE penalty_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, schedule_id uuid NOT NULL,
  currency account_currency NOT NULL, penalty_amount numeric NOT NULL, penalty_stage penalty_stage NOT NULL,
  penalty_cycle integer, penalty_date date, status penalty_fee_status DEFAULT 'unpaid', waived_at timestamptz,
  created_at timestamptz DEFAULT now(), UNIQUE (schedule_id, penalty_stage, penalty_cycle));
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, amount_paid numeric NOT NULL, voided_at timestamptz);
CREATE TABLE account_services (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, amount numeric);
CREATE TABLE payment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL, account_id uuid,
  submitted_amount numeric NOT NULL, payment_date date NOT NULL, payment_method text NOT NULL,
  reference_number text, sender_name text, notes text, proof_url text, status submission_status DEFAULT 'submitted',
  created_at timestamptz DEFAULT now(), submission_type text, cash_order_id uuid);
CREATE TABLE penalty_waiver_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, schedule_id uuid NOT NULL,
  penalty_fee_id uuid NOT NULL, penalty_amount numeric NOT NULL, requested_by_user_id uuid, reason text NOT NULL,
  status waiver_status DEFAULT 'pending', approved_at timestamptz, rejected_at timestamptz,
  is_auto boolean DEFAULT false, source_submission_id uuid);
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL,
  action text NOT NULL, old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid,
  created_at timestamptz DEFAULT now());
CREATE TABLE system_settings (key text PRIMARY KEY, value jsonb);
CREATE TABLE layaway_account_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, title text NOT NULL, sku text,
  quantity integer DEFAULT 1, variant_id uuid);
CREATE TABLE website_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stock_qty integer, updated_at timestamptz);

-- Stand-in: the test user 'aaaaaaaa-…-0001' holds record_payment; nobody else does.
CREATE FUNCTION has_permission(_user_id uuid, _permission_key text) RETURNS boolean
LANGUAGE sql AS $$ SELECT _user_id = 'aaaaaaaa-0000-0000-0000-000000000001'::uuid AND _permission_key = 'record_payment' $$;
CREATE FUNCTION auth_uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;

-- ── Copied verbatim from live (2026-10-20) ──
CREATE OR REPLACE FUNCTION public.auto_waive_same_day_penalties()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_date date; v_pen RECORD; v_sched numeric; v_base numeric;
        v_carried numeric; v_pen_acct numeric; v_svc numeric; v_paid numeric;
BEGIN
  IF NEW.account_id IS NULL THEN RETURN NEW; END IF;
  BEGIN
    v_date := (NEW.created_at AT TIME ZONE 'Asia/Tokyo')::date;

    FOR v_pen IN
      SELECT * FROM penalty_fees
      WHERE account_id = NEW.account_id AND status = 'unpaid' AND penalty_date = v_date
    LOOP
      INSERT INTO penalty_waiver_requests (
        account_id, schedule_id, penalty_fee_id, penalty_amount,
        requested_by_user_id, reason, status, approved_at, is_auto, source_submission_id)
      VALUES (v_pen.account_id, v_pen.schedule_id, v_pen.id, v_pen.penalty_amount,
        NULL, 'Auto-waived: payment submitted on the same date the penalty was applied.',
        'approved', now(), true, NEW.id);

      UPDATE penalty_fees SET status = 'waived', waived_at = now() WHERE id = v_pen.id;

      SELECT COALESCE(SUM(penalty_amount),0) INTO v_sched FROM penalty_fees
        WHERE schedule_id = v_pen.schedule_id AND status::text <> 'waived';
      SELECT base_installment_amount, COALESCE(carried_amount,0) INTO v_base, v_carried
        FROM layaway_schedule WHERE id = v_pen.schedule_id;
      UPDATE layaway_schedule
        SET penalty_amount = v_sched, total_due_amount = v_base + v_sched + v_carried
        WHERE id = v_pen.schedule_id;

      SELECT COALESCE(SUM(penalty_amount),0) INTO v_pen_acct FROM penalty_fees
        WHERE account_id = v_pen.account_id AND status::text <> 'waived';
      SELECT COALESCE(SUM(amount),0) INTO v_svc FROM account_services
        WHERE account_id = v_pen.account_id;
      SELECT COALESCE(SUM(amount_paid),0) INTO v_paid FROM payments
        WHERE account_id = v_pen.account_id AND voided_at IS NULL;
      UPDATE layaway_accounts
        SET remaining_balance = GREATEST(0, total_amount + v_pen_acct + v_svc - v_paid)
        WHERE id = v_pen.account_id;

      INSERT INTO audit_logs (entity_type, entity_id, action, new_value_json)
      VALUES ('penalty_waiver', v_pen.account_id, 'auto_waiver_approved',
        jsonb_build_object('penalty_fee_id', v_pen.id, 'schedule_id', v_pen.schedule_id,
          'penalty_amount', v_pen.penalty_amount, 'penalty_date', v_pen.penalty_date,
          'submission_id', NEW.id, 'submission_date_jst', v_date));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $function$;
CREATE TRIGGER trg_auto_waive_same_day AFTER INSERT ON public.payment_submissions FOR EACH ROW EXECUTE FUNCTION auto_waive_same_day_penalties();

CREATE OR REPLACE FUNCTION public.revert_auto_waive_on_rejection()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_w RECORD; v_sched numeric; v_base numeric; v_carried numeric;
        v_pen_acct numeric; v_svc numeric; v_paid numeric;
BEGIN
  IF NEW.status::text <> 'rejected' OR OLD.status::text = 'rejected' THEN RETURN NEW; END IF;
  BEGIN
    FOR v_w IN
      SELECT * FROM penalty_waiver_requests
      WHERE source_submission_id = NEW.id AND is_auto = true AND status = 'approved'
    LOOP
      UPDATE penalty_fees SET status = 'unpaid', waived_at = NULL WHERE id = v_w.penalty_fee_id;
      UPDATE penalty_waiver_requests
        SET status = 'rejected', rejected_at = now(), approved_at = NULL WHERE id = v_w.id;

      SELECT COALESCE(SUM(penalty_amount),0) INTO v_sched FROM penalty_fees
        WHERE schedule_id = v_w.schedule_id AND status::text <> 'waived';
      SELECT base_installment_amount, COALESCE(carried_amount,0) INTO v_base, v_carried
        FROM layaway_schedule WHERE id = v_w.schedule_id;
      UPDATE layaway_schedule
        SET penalty_amount = v_sched, total_due_amount = v_base + v_sched + v_carried
        WHERE id = v_w.schedule_id;

      SELECT COALESCE(SUM(penalty_amount),0) INTO v_pen_acct FROM penalty_fees
        WHERE account_id = v_w.account_id AND status::text <> 'waived';
      SELECT COALESCE(SUM(amount),0) INTO v_svc FROM account_services
        WHERE account_id = v_w.account_id;
      SELECT COALESCE(SUM(amount_paid),0) INTO v_paid FROM payments
        WHERE account_id = v_w.account_id AND voided_at IS NULL;
      UPDATE layaway_accounts
        SET remaining_balance = GREATEST(0, total_amount + v_pen_acct + v_svc - v_paid)
        WHERE id = v_w.account_id;

      INSERT INTO audit_logs (entity_type, entity_id, action, new_value_json)
      VALUES ('penalty_waiver', v_w.account_id, 'auto_waiver_reverted',
        jsonb_build_object('penalty_fee_id', v_w.penalty_fee_id, 'waiver_id', v_w.id,
          'submission_id', NEW.id, 'note', 'Payment submission rejected — auto-waive reversed.'));
    END LOOP;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END; $function$;
CREATE TRIGGER trg_revert_auto_waive AFTER UPDATE ON public.payment_submissions FOR EACH ROW EXECUTE FUNCTION revert_auto_waive_on_rejection();

CREATE OR REPLACE FUNCTION public.release_forfeited_web_layaway_stock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_restored integer := 0;
  v_now      timestamptz := now();
BEGIN
  IF NEW.source_channel IS DISTINCT FROM 'web'
     OR NEW.status IS NOT DISTINCT FROM OLD.status
     OR NEW.status::text NOT IN ('forfeited', 'final_forfeited')
     OR NEW.stock_released_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.website_product_variants v
     SET stock_qty = v.stock_qty + i.quantity, updated_at = v_now
    FROM public.layaway_account_items i
   WHERE i.account_id = NEW.id AND i.variant_id = v.id;
  GET DIAGNOSTICS v_restored = ROW_COUNT;

  NEW.stock_released_at := v_now;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, performed_by_user_id,
                                 old_value_json, new_value_json)
  VALUES ('layaway_account', NEW.id, 'web_layaway_stock_released', auth.uid(),
          jsonb_build_object('status', OLD.status),
          jsonb_build_object('status', NEW.status, 'invoice_number', NEW.invoice_number,
                             'web_reference', NEW.web_reference,
                             'stock_lines_restored', v_restored,
                             'released_by', 'forfeit status change'));

  RETURN NEW;
END $function$;
CREATE TRIGGER trg_release_forfeited_web_layaway_stock BEFORE UPDATE OF status ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION release_forfeited_web_layaway_stock();

INSERT INTO system_settings (key, value) VALUES
  ('penalty_php_week1', '"500"'), ('penalty_php_week2', '"500"'),
  ('penalty_jpy_week1', '1000'), ('penalty_jpy_week2', '1000');
