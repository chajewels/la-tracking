-- Lovable scan 2026-09-29, finding L3: staff screens time out.
--
-- `authenticated` runs with statement_timeout = 8s. The RLS policies on the
-- busiest tables call is_staff(auth.uid()) / has_role(auth.uid(), …) bare, so
-- Postgres evaluates them once PER ROW (plan: "Filter: is_staff(COALESCE(
-- current_setting('request.jwt.claim.sub') …))" on every scanned row), and a
-- SECURITY INVOKER report function pays that on every table it reads.
-- Measured on live 2026-09-29: fc_cfo_insights() 113 ms as postgres vs
-- 2,682 ms as an admin user; pg_stat_statements shows the fc_* RPCs,
-- get_top_outstanding_customers, get_monthly_sales and schedule/account list
-- reads with max_exec_time ≈ 7,99x ms, i.e. cancelled at the 8s ceiling.
--
-- Fix (Supabase's documented pattern): wrap the call in a scalar sub-select —
--   (SELECT is_staff((SELECT auth.uid())))
-- so the planner runs it ONCE per statement as an InitPlan. The result is
-- identical (auth.uid() and the user's roles do not change inside a
-- statement); only the number of evaluations changes.
--
-- Scope: the 43 policies that reference auth.uid() on the 11 tables the
-- account / schedule / payment / penalty / submission screens read:
-- account_services, cash_orders, customers, layaway_accounts,
-- layaway_schedule, payment_allocations, payment_submission_allocations,
-- payment_submissions, payments, penalty_fees, reminder_logs.
-- ALTER POLICY keeps each policy's name, command, roles and permissive flag;
-- only the expressions below change, each copied from LIVE pg_policies
-- (2026-09-29 09:xx JST) with the calls wrapped. Service-role and anon
-- portal-token policies do not use auth.uid() and are untouched.
-- Idempotent (re-running sets the same expressions).

BEGIN;

ALTER POLICY "Admins can delete services" ON public.account_services
  USING ((SELECT has_role((SELECT auth.uid() AS uid), 'admin'::app_role) AS has_role));

ALTER POLICY "Staff can create services" ON public.account_services
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update services" ON public.account_services
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view services" ON public.account_services
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Customers can view own cash orders" ON public.cash_orders
  USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = (SELECT auth.uid() AS uid)))));

ALTER POLICY "admin_all_cash_orders" ON public.cash_orders
  USING ((SELECT has_role((SELECT auth.uid() AS uid), 'admin'::app_role) AS has_role));

ALTER POLICY "staff_admin_insert_cash_orders" ON public.cash_orders
  WITH CHECK (((SELECT has_role((SELECT auth.uid() AS uid), 'staff'::app_role) AS has_role) OR (SELECT has_role((SELECT auth.uid() AS uid), 'admin'::app_role) AS has_role)));

ALTER POLICY "staff_admin_update_cash_orders" ON public.cash_orders
  USING (((SELECT has_role((SELECT auth.uid() AS uid), 'staff'::app_role) AS has_role) OR (SELECT has_role((SELECT auth.uid() AS uid), 'admin'::app_role) AS has_role)));

ALTER POLICY "staff_finance_read_cash_orders" ON public.cash_orders
  USING (((SELECT has_role((SELECT auth.uid() AS uid), 'staff'::app_role) AS has_role) OR (SELECT has_role((SELECT auth.uid() AS uid), 'finance'::app_role) AS has_role)));

ALTER POLICY "Admins can delete customers" ON public.customers
  USING ((SELECT has_role((SELECT auth.uid() AS uid), 'admin'::app_role) AS has_role));

ALTER POLICY "Customers can view own customer record" ON public.customers
  USING ((auth_user_id = (SELECT auth.uid() AS uid)));

ALTER POLICY "Staff can create customers" ON public.customers
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update customers" ON public.customers
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view all customers" ON public.customers
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Customers can view own layaway accounts" ON public.layaway_accounts
  USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = (SELECT auth.uid() AS uid)))));

ALTER POLICY "Staff can create accounts" ON public.layaway_accounts
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update accounts" ON public.layaway_accounts
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view all accounts" ON public.layaway_accounts
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Customers can view own schedules" ON public.layaway_schedule
  USING ((account_id IN ( SELECT la.id
   FROM (layaway_accounts la
     JOIN customers c ON ((c.id = la.customer_id)))
  WHERE (c.auth_user_id = (SELECT auth.uid() AS uid)))));

ALTER POLICY "Staff can insert schedules" ON public.layaway_schedule
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update schedules" ON public.layaway_schedule
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view schedules" ON public.layaway_schedule
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can create allocations" ON public.payment_allocations
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can delete allocations" ON public.payment_allocations
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update allocations" ON public.payment_allocations
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff))
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view allocations" ON public.payment_allocations
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can insert allocations" ON public.payment_submission_allocations
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update allocations" ON public.payment_submission_allocations
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view allocations" ON public.payment_submission_allocations
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Authenticated users can insert submissions" ON public.payment_submissions
  WITH CHECK (((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff) OR (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = (SELECT auth.uid() AS uid))))));

ALTER POLICY "Customers can view own payment_submissions" ON public.payment_submissions
  USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = (SELECT auth.uid() AS uid)))));

ALTER POLICY "Session customers can cancel own cash order submissions" ON public.payment_submissions
  USING (((cash_order_id IS NOT NULL) AND (status = 'submitted'::submission_status) AND (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = (SELECT auth.uid() AS uid))))))
  WITH CHECK (((status = 'cancelled'::submission_status) AND (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = (SELECT auth.uid() AS uid))))));

ALTER POLICY "Staff can insert submissions" ON public.payment_submissions
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update submissions" ON public.payment_submissions
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view submissions" ON public.payment_submissions
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can create payments" ON public.payments
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update payments" ON public.payments
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view payments" ON public.payments
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can insert penalties" ON public.penalty_fees
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can update penalties" ON public.penalty_fees
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view penalties" ON public.penalty_fees
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can create reminders" ON public.reminder_logs
  WITH CHECK ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

ALTER POLICY "Staff can view reminders" ON public.reminder_logs
  USING ((SELECT is_staff((SELECT auth.uid() AS uid)) AS is_staff));

-- Proof: on these 11 tables, every auth.uid() is now inside a sub-select, and
-- no policy was added or removed.
DO $proof$
DECLARE v_bad int; v_total int; v_wrapped int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('account_services','cash_orders','customers','layaway_accounts','layaway_schedule',
                       'payment_allocations','payment_submission_allocations','payment_submissions',
                       'payments','penalty_fees','reminder_logs')
     AND replace(coalesce(qual,'') || ' ' || coalesce(with_check,''), 'SELECT auth.uid() AS uid', '') LIKE '%auth.uid()%';
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'rls_staff_check_once: % policies still call auth.uid() per row', v_bad;
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE coalesce(qual,'') || coalesce(with_check,'') LIKE '%SELECT auth.uid() AS uid%')
    INTO v_total, v_wrapped
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('account_services','cash_orders','customers','layaway_accounts','layaway_schedule',
                       'payment_allocations','payment_submission_allocations','payment_submissions',
                       'payments','penalty_fees','reminder_logs');
  IF v_wrapped <> 43 THEN
    RAISE EXCEPTION 'rls_staff_check_once: expected 43 wrapped policies, found %', v_wrapped;
  END IF;
  RAISE NOTICE 'rls_staff_check_once: % policies on the 11 tables, % wrapped', v_total, v_wrapped;
END $proof$;

COMMIT;
