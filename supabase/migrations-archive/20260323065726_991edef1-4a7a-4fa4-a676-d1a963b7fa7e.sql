
-- Role permissions table: stores per-role per-permission toggles
CREATE TABLE public.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role public.app_role NOT NULL,
  permission_key text NOT NULL,
  is_allowed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid,
  UNIQUE(role, permission_key)
);

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage role_permissions" ON public.role_permissions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can view role_permissions" ON public.role_permissions
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

-- Feature toggles table: global on/off for system features
CREATE TABLE public.feature_toggles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key text NOT NULL UNIQUE,
  is_enabled boolean NOT NULL DEFAULT true,
  label text NOT NULL,
  description text,
  module text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid
);

ALTER TABLE public.feature_toggles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage feature_toggles" ON public.feature_toggles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Staff can view feature_toggles" ON public.feature_toggles
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

-- Trigger for updated_at
CREATE TRIGGER update_role_permissions_updated_at BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_feature_toggles_updated_at BEFORE UPDATE ON public.feature_toggles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Seed default role permissions matching current hardcoded values
INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
  -- Dashboard
  ('admin', 'view_dashboard', true), ('staff', 'view_dashboard', true), ('finance', 'view_dashboard', true), ('csr', 'view_dashboard', true),
  ('admin', 'view_kpis', true), ('staff', 'view_kpis', true), ('finance', 'view_kpis', true), ('csr', 'view_kpis', false),
  ('admin', 'view_system_health', true), ('staff', 'view_system_health', false), ('finance', 'view_system_health', false), ('csr', 'view_system_health', false),
  ('admin', 'view_operations_panel', true), ('staff', 'view_operations_panel', true), ('finance', 'view_operations_panel', false), ('csr', 'view_operations_panel', false),
  ('admin', 'view_ai_risk', true), ('staff', 'view_ai_risk', false), ('finance', 'view_ai_risk', true), ('csr', 'view_ai_risk', false),
  ('admin', 'view_live_collection', true), ('staff', 'view_live_collection', true), ('finance', 'view_live_collection', true), ('csr', 'view_live_collection', false),
  ('admin', 'view_overdue_alerts', true), ('staff', 'view_overdue_alerts', true), ('finance', 'view_overdue_alerts', false), ('csr', 'view_overdue_alerts', true),
  ('admin', 'view_geo_breakdown', true), ('staff', 'view_geo_breakdown', false), ('finance', 'view_geo_breakdown', true), ('csr', 'view_geo_breakdown', false),
  ('admin', 'view_aging_buckets', true), ('staff', 'view_aging_buckets', false), ('finance', 'view_aging_buckets', true), ('csr', 'view_aging_buckets', false),
  -- Layaway Accounts
  ('admin', 'view_accounts', true), ('staff', 'view_accounts', true), ('finance', 'view_accounts', true), ('csr', 'view_accounts', false),
  ('admin', 'create_account', true), ('staff', 'create_account', true), ('finance', 'create_account', false), ('csr', 'create_account', false),
  ('admin', 'edit_account', true), ('staff', 'edit_account', false), ('finance', 'edit_account', false), ('csr', 'edit_account', false),
  ('admin', 'delete_account', true), ('staff', 'delete_account', false), ('finance', 'delete_account', false), ('csr', 'delete_account', false),
  ('admin', 'edit_schedule', true), ('staff', 'edit_schedule', false), ('finance', 'edit_schedule', false), ('csr', 'edit_schedule', false),
  ('admin', 'edit_invoice', true), ('staff', 'edit_invoice', false), ('finance', 'edit_invoice', false), ('csr', 'edit_invoice', false),
  ('admin', 'forfeit_account', true), ('staff', 'forfeit_account', false), ('finance', 'forfeit_account', false), ('csr', 'forfeit_account', false),
  ('admin', 'reactivate_account', true), ('staff', 'reactivate_account', false), ('finance', 'reactivate_account', false), ('csr', 'reactivate_account', false),
  ('admin', 'reassign_owner', true), ('staff', 'reassign_owner', false), ('finance', 'reassign_owner', false), ('csr', 'reassign_owner', false),
  -- Payments
  ('admin', 'record_payment', true), ('staff', 'record_payment', true), ('finance', 'record_payment', true), ('csr', 'record_payment', false),
  ('admin', 'confirm_payment', true), ('staff', 'confirm_payment', false), ('finance', 'confirm_payment', true), ('csr', 'confirm_payment', false),
  ('admin', 'void_payment', true), ('staff', 'void_payment', false), ('finance', 'void_payment', false), ('csr', 'void_payment', false),
  ('admin', 'restore_payment', true), ('staff', 'restore_payment', false), ('finance', 'restore_payment', false), ('csr', 'restore_payment', false),
  -- Collections
  ('admin', 'view_collections', true), ('staff', 'view_collections', false), ('finance', 'view_collections', true), ('csr', 'view_collections', false),
  -- Finance
  ('admin', 'view_finance', true), ('staff', 'view_finance', false), ('finance', 'view_finance', true), ('csr', 'view_finance', false),
  ('admin', 'run_reconciliation', true), ('staff', 'run_reconciliation', false), ('finance', 'run_reconciliation', false), ('csr', 'run_reconciliation', false),
  ('admin', 'recalculate_balance', true), ('staff', 'recalculate_balance', false), ('finance', 'recalculate_balance', false), ('csr', 'recalculate_balance', false),
  -- Payment Submissions
  ('admin', 'view_submissions', true), ('staff', 'view_submissions', true), ('finance', 'view_submissions', true), ('csr', 'view_submissions', true),
  ('admin', 'review_submission', true), ('staff', 'review_submission', false), ('finance', 'review_submission', true), ('csr', 'review_submission', false),
  ('admin', 'reject_submission', true), ('staff', 'reject_submission', false), ('finance', 'reject_submission', true), ('csr', 'reject_submission', false),
  -- CSR Monitoring
  ('admin', 'view_monitoring', true), ('staff', 'view_monitoring', true), ('finance', 'view_monitoring', false), ('csr', 'view_monitoring', true),
  ('admin', 'send_reminder', true), ('staff', 'send_reminder', true), ('finance', 'send_reminder', false), ('csr', 'send_reminder', true),
  -- Customers
  ('admin', 'view_customers', true), ('staff', 'view_customers', true), ('finance', 'view_customers', false), ('csr', 'view_customers', true),
  ('admin', 'edit_customer', true), ('staff', 'edit_customer', true), ('finance', 'edit_customer', false), ('csr', 'edit_customer', true),
  ('admin', 'delete_customer', true), ('staff', 'delete_customer', false), ('finance', 'delete_customer', false), ('csr', 'delete_customer', false),
  -- Penalties
  ('admin', 'add_penalty', true), ('staff', 'add_penalty', true), ('finance', 'add_penalty', false), ('csr', 'add_penalty', false),
  ('admin', 'waive_penalty', true), ('staff', 'waive_penalty', false), ('finance', 'waive_penalty', true), ('csr', 'waive_penalty', false),
  ('admin', 'apply_cap_fix', true), ('staff', 'apply_cap_fix', false), ('finance', 'apply_cap_fix', false), ('csr', 'apply_cap_fix', false),
  -- Services
  ('admin', 'add_service', true), ('staff', 'add_service', true), ('finance', 'add_service', false), ('csr', 'add_service', false),
  -- Waivers page
  ('admin', 'view_waivers', true), ('staff', 'view_waivers', false), ('finance', 'view_waivers', true), ('csr', 'view_waivers', false),
  -- Analytics
  ('admin', 'view_analytics', true), ('staff', 'view_analytics', false), ('finance', 'view_analytics', true), ('csr', 'view_analytics', false),
  -- Reminders page
  ('admin', 'view_reminders', true), ('staff', 'view_reminders', true), ('finance', 'view_reminders', false), ('csr', 'view_reminders', true),
  -- Audit & Admin
  ('admin', 'view_audit_logs', true), ('staff', 'view_audit_logs', false), ('finance', 'view_audit_logs', false), ('csr', 'view_audit_logs', false),
  ('admin', 'system_health', true), ('staff', 'system_health', false), ('finance', 'system_health', false), ('csr', 'system_health', false),
  ('admin', 'admin_settings', true), ('staff', 'admin_settings', false), ('finance', 'admin_settings', false), ('csr', 'admin_settings', false),
  ('admin', 'manage_team', true), ('staff', 'manage_team', false), ('finance', 'manage_team', false), ('csr', 'manage_team', false),
  -- Portal tokens
  ('admin', 'revoke_token', true), ('staff', 'revoke_token', false), ('finance', 'revoke_token', false), ('csr', 'revoke_token', false),
  ('admin', 'regenerate_token', true), ('staff', 'regenerate_token', true), ('finance', 'regenerate_token', false), ('csr', 'regenerate_token', false);

-- Seed feature toggles
INSERT INTO public.feature_toggles (feature_key, label, description, module, sort_order, is_enabled) VALUES
  ('penalty_system', 'Penalty System', 'Automatic penalty fees for overdue payments', 'Penalties', 1, true),
  ('reminder_system', 'Reminder System', 'Automated and manual customer reminders', 'Reminders', 2, true),
  ('payment_submissions', 'Payment Submissions', 'Customer self-service payment proof uploads', 'Payments', 3, true),
  ('add_services', 'Additional Services', 'Add extra services (engraving, resizing) to accounts', 'Services', 4, true),
  ('portal_access', 'Customer Portal', 'Public customer portal for account viewing and payments', 'Portal', 5, true),
  ('analytics_module', 'Analytics & Reports', 'Advanced analytics, forecasts, and data exports', 'Analytics', 6, true),
  ('waiver_system', 'Penalty Waivers', 'Request and approve penalty waiver workflow', 'Waivers', 7, true),
  ('collections_module', 'Collections Tracking', 'Payment collection monitoring and tracking', 'Collections', 8, true),
  ('audit_logs', 'Audit Logging', 'Track all system actions and changes', 'Audit', 9, true),
  ('csr_monitoring', 'CSR Monitoring', 'Customer service representative monitoring dashboard', 'Monitoring', 10, true);
