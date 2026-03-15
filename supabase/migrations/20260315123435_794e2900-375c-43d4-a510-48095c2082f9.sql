
-- =============================================
-- CHA JEWELS LAYAWAY PAYMENT MANAGEMENT SYSTEM
-- Production Database Schema
-- =============================================

-- ENUMS
CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'finance', 'csr');
CREATE TYPE public.account_status AS ENUM ('active', 'completed', 'cancelled', 'overdue');
CREATE TYPE public.schedule_status AS ENUM ('pending', 'partially_paid', 'paid', 'overdue', 'cancelled');
CREATE TYPE public.penalty_stage AS ENUM ('week1', 'week2');
CREATE TYPE public.penalty_fee_status AS ENUM ('unpaid', 'paid', 'waived');
CREATE TYPE public.waiver_status AS ENUM ('pending', 'approved', 'rejected');
CREATE TYPE public.allocation_type AS ENUM ('penalty', 'installment');
CREATE TYPE public.account_currency AS ENUM ('PHP', 'JPY');
CREATE TYPE public.clv_tier AS ENUM ('bronze', 'silver', 'gold', 'vip');
CREATE TYPE public.risk_level AS ENUM ('low', 'medium', 'high');
CREATE TYPE public.user_status AS ENUM ('active', 'inactive', 'suspended');

-- Utility function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- 1. CUSTOMERS
CREATE TABLE public.customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  mobile_number TEXT,
  email TEXT,
  facebook_name TEXT,
  messenger_link TEXT,
  preferred_contact_method TEXT DEFAULT 'messenger',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_customers_code ON public.customers(customer_code);
CREATE INDEX idx_customers_name ON public.customers(full_name);
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. USER ROLES
CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  UNIQUE(user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

CREATE OR REPLACE FUNCTION public.is_staff(_user_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id) $$;

-- 3. PROFILES
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT,
  status public.user_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (user_id, full_name, email)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), NEW.email);
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 4. LAYAWAY ACCOUNTS
CREATE TABLE public.layaway_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE RESTRICT,
  invoice_number TEXT NOT NULL UNIQUE,
  currency public.account_currency NOT NULL,
  total_amount NUMERIC(15,2) NOT NULL CHECK (total_amount > 0),
  payment_plan_months INTEGER NOT NULL CHECK (payment_plan_months IN (3, 6)),
  order_date DATE NOT NULL,
  end_date DATE,
  status public.account_status NOT NULL DEFAULT 'active',
  total_paid NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (total_paid >= 0),
  remaining_balance NUMERIC(15,2) NOT NULL,
  agreement_version TEXT,
  agreement_acceptance_date TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES auth.users(id),
  notes TEXT,
  created_by_user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.layaway_accounts ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_layaway_customer ON public.layaway_accounts(customer_id);
CREATE INDEX idx_layaway_status ON public.layaway_accounts(status);
CREATE INDEX idx_layaway_currency ON public.layaway_accounts(currency);
CREATE INDEX idx_layaway_invoice ON public.layaway_accounts(invoice_number);
CREATE TRIGGER update_layaway_accounts_updated_at BEFORE UPDATE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. LAYAWAY SCHEDULE
CREATE TABLE public.layaway_schedule (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL CHECK (installment_number > 0),
  due_date DATE NOT NULL,
  base_installment_amount NUMERIC(15,2) NOT NULL CHECK (base_installment_amount >= 0),
  penalty_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (penalty_amount >= 0),
  total_due_amount NUMERIC(15,2) NOT NULL CHECK (total_due_amount >= 0),
  paid_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  currency public.account_currency NOT NULL,
  status public.schedule_status NOT NULL DEFAULT 'pending',
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, installment_number)
);
ALTER TABLE public.layaway_schedule ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_schedule_account ON public.layaway_schedule(account_id);
CREATE INDEX idx_schedule_due_date ON public.layaway_schedule(due_date);
CREATE INDEX idx_schedule_status ON public.layaway_schedule(status);
CREATE TRIGGER update_layaway_schedule_updated_at BEFORE UPDATE ON public.layaway_schedule FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6. PAYMENTS
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE RESTRICT,
  amount_paid NUMERIC(15,2) NOT NULL CHECK (amount_paid > 0),
  currency public.account_currency NOT NULL,
  date_paid DATE NOT NULL DEFAULT CURRENT_DATE,
  payment_method TEXT DEFAULT 'cash',
  reference_number TEXT,
  remarks TEXT,
  entered_by_user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_payments_account ON public.payments(account_id);
CREATE INDEX idx_payments_date ON public.payments(date_paid);

-- 7. PAYMENT ALLOCATIONS
CREATE TABLE public.payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES public.payments(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES public.layaway_schedule(id) ON DELETE CASCADE,
  allocation_type public.allocation_type NOT NULL,
  allocated_amount NUMERIC(15,2) NOT NULL CHECK (allocated_amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_allocations_payment ON public.payment_allocations(payment_id);
CREATE INDEX idx_allocations_schedule ON public.payment_allocations(schedule_id);

-- 8. PENALTY FEES
CREATE TABLE public.penalty_fees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES public.layaway_schedule(id) ON DELETE CASCADE,
  currency public.account_currency NOT NULL,
  penalty_amount NUMERIC(15,2) NOT NULL CHECK (penalty_amount > 0),
  penalty_stage public.penalty_stage NOT NULL,
  penalty_cycle INTEGER NOT NULL DEFAULT 1,
  penalty_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status public.penalty_fee_status NOT NULL DEFAULT 'unpaid',
  waived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(schedule_id, penalty_stage, penalty_cycle)
);
ALTER TABLE public.penalty_fees ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_penalty_account ON public.penalty_fees(account_id);
CREATE INDEX idx_penalty_schedule ON public.penalty_fees(schedule_id);
CREATE INDEX idx_penalty_status ON public.penalty_fees(status);
CREATE TRIGGER update_penalty_fees_updated_at BEFORE UPDATE ON public.penalty_fees FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 9. PENALTY WAIVER REQUESTS
CREATE TABLE public.penalty_waiver_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES public.layaway_schedule(id) ON DELETE CASCADE,
  penalty_fee_id UUID NOT NULL REFERENCES public.penalty_fees(id) ON DELETE CASCADE,
  penalty_amount NUMERIC(15,2) NOT NULL,
  requested_by_user_id UUID NOT NULL REFERENCES auth.users(id),
  reason TEXT NOT NULL,
  status public.waiver_status NOT NULL DEFAULT 'pending',
  approved_by_user_id UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.penalty_waiver_requests ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_waiver_status ON public.penalty_waiver_requests(status);
CREATE INDEX idx_waiver_account ON public.penalty_waiver_requests(account_id);
CREATE TRIGGER update_penalty_waiver_requests_updated_at BEFORE UPDATE ON public.penalty_waiver_requests FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 10. REMINDER LOGS
CREATE TABLE public.reminder_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE,
  schedule_id UUID REFERENCES public.layaway_schedule(id) ON DELETE SET NULL,
  customer_id UUID NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'messenger',
  recipient TEXT,
  template_type TEXT,
  message_body TEXT,
  sent_at TIMESTAMPTZ DEFAULT now(),
  delivery_status TEXT DEFAULT 'sent',
  provider_name TEXT,
  provider_message_id TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.reminder_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_reminder_account ON public.reminder_logs(account_id);
CREATE INDEX idx_reminder_customer ON public.reminder_logs(customer_id);

-- 11. AUDIT LOGS
CREATE TABLE public.audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  old_value_json JSONB,
  new_value_json JSONB,
  performed_by_user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_audit_entity ON public.audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_action ON public.audit_logs(action);
CREATE INDEX idx_audit_created ON public.audit_logs(created_at);

-- 12. CUSTOMER ANALYTICS
CREATE TABLE public.customer_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL UNIQUE REFERENCES public.customers(id) ON DELETE CASCADE,
  lifetime_value_amount NUMERIC(15,2) DEFAULT 0,
  lifetime_value_tier public.clv_tier DEFAULT 'bronze',
  payment_reliability_score NUMERIC(5,2) DEFAULT 0,
  completion_probability_score NUMERIC(5,2) DEFAULT 0,
  late_payment_risk_score NUMERIC(5,2) DEFAULT 0,
  late_payment_risk_level public.risk_level DEFAULT 'low',
  last_calculated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.customer_analytics ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_analytics_customer ON public.customer_analytics(customer_id);

-- 13. FORECAST SNAPSHOTS
CREATE TABLE public.forecast_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  forecast_type TEXT NOT NULL,
  currency_mode TEXT NOT NULL DEFAULT 'ALL',
  forecast_period_start DATE NOT NULL,
  forecast_period_end DATE NOT NULL,
  forecast_value NUMERIC(15,2) NOT NULL,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.forecast_snapshots ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_forecast_type ON public.forecast_snapshots(forecast_type);

-- 14. SYSTEM SETTINGS
CREATE TABLE public.system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  value JSONB NOT NULL,
  description TEXT,
  updated_by_user_id UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.system_settings (key, value, description) VALUES
  ('php_jpy_rate', '"0.42"', 'PHP to JPY conversion rate'),
  ('penalty_php_week1', '"500"', 'PHP Week 1 penalty amount'),
  ('penalty_php_week2', '"1000"', 'PHP Week 2 penalty amount'),
  ('penalty_jpy_week1', '"1000"', 'JPY Week 1 penalty amount'),
  ('penalty_jpy_week2', '"2000"', 'JPY Week 2 penalty amount');

-- RLS POLICIES

-- Customers
CREATE POLICY "Staff can view all customers" ON public.customers FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can create customers" ON public.customers FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Staff can update customers" ON public.customers FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));

-- User roles
CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE POLICY "Admins can manage all roles" ON public.user_roles FOR ALL TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- Profiles
CREATE POLICY "Staff can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (user_id = auth.uid());
CREATE POLICY "System can insert profiles" ON public.profiles FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- Layaway accounts
CREATE POLICY "Staff can view all accounts" ON public.layaway_accounts FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can create accounts" ON public.layaway_accounts FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Staff can update accounts" ON public.layaway_accounts FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));

-- Schedule
CREATE POLICY "Staff can view schedules" ON public.layaway_schedule FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can insert schedules" ON public.layaway_schedule FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Staff can update schedules" ON public.layaway_schedule FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));

-- Payments
CREATE POLICY "Staff can view payments" ON public.payments FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can create payments" ON public.payments FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

-- Payment allocations
CREATE POLICY "Staff can view allocations" ON public.payment_allocations FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can create allocations" ON public.payment_allocations FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

-- Penalty fees
CREATE POLICY "Staff can view penalties" ON public.penalty_fees FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can insert penalties" ON public.penalty_fees FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Staff can update penalties" ON public.penalty_fees FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));

-- Penalty waiver requests
CREATE POLICY "Staff can view waivers" ON public.penalty_waiver_requests FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "CSR can create waivers" ON public.penalty_waiver_requests FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Admin Finance can update waivers" ON public.penalty_waiver_requests FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance'));

-- Reminder logs
CREATE POLICY "Staff can view reminders" ON public.reminder_logs FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can create reminders" ON public.reminder_logs FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

-- Audit logs
CREATE POLICY "Admin Finance can view audit logs" ON public.audit_logs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance'));
CREATE POLICY "Staff can create audit logs" ON public.audit_logs FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

-- Customer analytics
CREATE POLICY "Staff can view analytics" ON public.customer_analytics FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can insert analytics" ON public.customer_analytics FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));
CREATE POLICY "Staff can update analytics" ON public.customer_analytics FOR UPDATE TO authenticated USING (public.is_staff(auth.uid()));

-- Forecast snapshots
CREATE POLICY "Staff can view forecasts" ON public.forecast_snapshots FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can insert forecasts" ON public.forecast_snapshots FOR INSERT TO authenticated WITH CHECK (public.is_staff(auth.uid()));

-- System settings
CREATE POLICY "Staff can view settings" ON public.system_settings FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Admins can update settings" ON public.system_settings FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'));
