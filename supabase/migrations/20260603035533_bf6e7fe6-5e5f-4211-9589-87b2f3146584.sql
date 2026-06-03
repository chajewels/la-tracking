-- 1. Enable RLS on plan_configurations (was missing — public read of pricing tiers is fine, but writes must be admin-only)
ALTER TABLE public.plan_configurations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read plan configurations"
ON public.plan_configurations
FOR SELECT TO authenticated
USING (true);

CREATE POLICY "Admins can manage plan configurations"
ON public.plan_configurations
FOR ALL TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role))
WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

-- 2. customer_portal_sessions: add explicit service-role-only policies so the
-- table has at least one policy (and is unreachable by anon/authenticated via PostgREST).
CREATE POLICY "Service role manages portal sessions"
ON public.customer_portal_sessions
FOR ALL TO service_role
USING (true)
WITH CHECK (true);

-- 3. Lock search_path on all 51 public functions (prevents schema-hijack via mutable search_path)
ALTER FUNCTION public.auto_backup_payment() SET search_path = public;
ALTER FUNCTION public.check_allocation_ceiling() SET search_path = public;
ALTER FUNCTION public.check_duplicate_payment(p_account_id uuid, p_amount numeric, p_date date) SET search_path = public;
ALTER FUNCTION public.deactivate_expired_promotions() SET search_path = public;
ALTER FUNCTION public.delete_email(queue_name text, message_id bigint) SET search_path = public;
ALTER FUNCTION public.derive_order_loyalty_jpy(p_account_id uuid) SET search_path = public;
ALTER FUNCTION public.enforce_plan_minimum_amount() SET search_path = public;
ALTER FUNCTION public.enqueue_email(queue_name text, payload jsonb) SET search_path = public;
ALTER FUNCTION public.fc_at_risk_accounts() SET search_path = public;
ALTER FUNCTION public.fc_at_risk_detail() SET search_path = public;
ALTER FUNCTION public.fc_cfo_insights() SET search_path = public;
ALTER FUNCTION public.fc_cohort_timeline() SET search_path = public;
ALTER FUNCTION public.fc_coverage_ratio() SET search_path = public;
ALTER FUNCTION public.fc_evaluate_alerts() SET search_path = public;
ALTER FUNCTION public.fc_gross_profit() SET search_path = public;
ALTER FUNCTION public.fc_monthly_inflow(target_month date) SET search_path = public;
ALTER FUNCTION public.fc_net_exposure_risk(resale_pct numeric) SET search_path = public;
ALTER FUNCTION public.fc_penalty_driven_accounts() SET search_path = public;
ALTER FUNCTION public.fc_penalty_revenue() SET search_path = public;
ALTER FUNCTION public.fc_plan_performance() SET search_path = public;
ALTER FUNCTION public.fc_portfolio_value() SET search_path = public;
ALTER FUNCTION public.generate_customer_code() SET search_path = public;
ALTER FUNCTION public.get_collection_analytics(currency_mode text, months_back integer) SET search_path = public;
ALTER FUNCTION public.get_forecast_6m() SET search_path = public;
ALTER FUNCTION public.get_forecast_drilldown(p_month text) SET search_path = public;
ALTER FUNCTION public.get_monthly_analytics() SET search_path = public;
ALTER FUNCTION public.get_monthly_tracking_export(p_year integer, p_month integer) SET search_path = public;
ALTER FUNCTION public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer) SET search_path = public;
ALTER FUNCTION public.get_top_outstanding_customers() SET search_path = public;
ALTER FUNCTION public.get_tracking_for_invoices(p_invoices text[]) SET search_path = public;
ALTER FUNCTION public.get_trade_kpis() SET search_path = public;
ALTER FUNCTION public.get_trade_monthly_trends(p_months_back integer) SET search_path = public;
ALTER FUNCTION public.log_admin_table_change() SET search_path = public;
ALTER FUNCTION public.loyalty_lots_set_updated_at() SET search_path = public;
ALTER FUNCTION public.loyalty_members_set_updated_at() SET search_path = public;
ALTER FUNCTION public.loyalty_transactions_no_update() SET search_path = public;
ALTER FUNCTION public.move_to_dlq(source_queue text, dlq_name text, message_id bigint, payload jsonb) SET search_path = public;
ALTER FUNCTION public.prevent_base_amount_change() SET search_path = public;
ALTER FUNCTION public.prevent_birthday_change() SET search_path = public;
ALTER FUNCTION public.prevent_customer_code_change() SET search_path = public;
ALTER FUNCTION public.prevent_paid_row_modification() SET search_path = public;
ALTER FUNCTION public.prevent_payment_backup_modification() SET search_path = public;
ALTER FUNCTION public.prevent_schedule_deletion() SET search_path = public;
ALTER FUNCTION public.prevent_total_amount_change() SET search_path = public;
ALTER FUNCTION public.read_email_batch(queue_name text, batch_size integer, vt integer) SET search_path = public;
ALTER FUNCTION public.revalidate_account_from_vault(p_invoice_number text) SET search_path = public;
ALTER FUNCTION public.set_completed_at() SET search_path = public;
ALTER FUNCTION public.update_cash_orders_updated_at() SET search_path = public;
ALTER FUNCTION public.update_loyalty_members_updated_at() SET search_path = public;
ALTER FUNCTION public.update_loyalty_promos_updated_at() SET search_path = public;
ALTER FUNCTION public.update_updated_at() SET search_path = public;
ALTER FUNCTION public.validate_bulk_import(p_rows jsonb) SET search_path = public;