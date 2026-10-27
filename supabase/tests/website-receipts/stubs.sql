-- Stand-ins for the live objects 20270216100000_website_receipts.sql touches.
-- Column names and types follow the live definitions (baseline + later
-- migrations); only the columns the receipt code reads are present.
DO $r$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END
$r$;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'finance', 'csr', 'customer');
CREATE TYPE public.account_currency AS ENUM ('PHP', 'JPY');
CREATE TYPE public.cash_order_status AS ENUM ('pending', 'completed', 'cancelled', 'expired');
CREATE TYPE public.account_status AS ENUM ('active', 'overdue', 'completed', 'cancelled', 'forfeited',
  'final_forfeited', 'extension_active', 'reactivated', 'final_settlement');
CREATE TYPE public.penalty_fee_status AS ENUM ('unpaid', 'paid', 'waived');

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE FUNCTION public.is_staff(_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role <> 'customer') $$;

CREATE TABLE public.system_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  key text NOT NULL UNIQUE,
  value jsonb NOT NULL,
  description text,
  updated_by_user_id uuid,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE public.audit_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL,
  old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE public.customers (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name text, email text, is_test boolean DEFAULT false NOT NULL
);

CREATE TABLE public.cash_orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  invoice_number text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  currency public.account_currency DEFAULT 'JPY' NOT NULL,
  total_amount numeric(12,2) NOT NULL,
  total_paid numeric(12,2) DEFAULT 0 NOT NULL,
  remaining_balance numeric(12,2) NOT NULL,
  status public.cash_order_status DEFAULT 'pending' NOT NULL,
  completed_at timestamptz,
  is_test boolean DEFAULT false NOT NULL,
  source_channel text DEFAULT 'hub_manual' NOT NULL,
  shipping_fee numeric(12,2) DEFAULT 0 NOT NULL,
  discount_amount numeric(12,2) DEFAULT 0 NOT NULL,
  cod_fee numeric(12,2) DEFAULT 0 NOT NULL,
  coupon_code text,
  fx_rate_used numeric(12,6),
  web_reference text,
  payment_method text,
  refund_status text,
  customer_lang text,
  ship_to_snapshot jsonb
);
CREATE TABLE public.layaway_accounts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES public.customers(id),
  invoice_number text NOT NULL,
  currency public.account_currency NOT NULL,
  total_amount numeric(15,2) NOT NULL,
  status public.account_status DEFAULT 'active' NOT NULL,
  total_paid numeric(15,2) DEFAULT 0 NOT NULL,
  remaining_balance numeric(15,2) NOT NULL,
  completed_at timestamptz,
  is_test boolean DEFAULT false NOT NULL,
  source_channel text DEFAULT 'hub_manual' NOT NULL,
  shipping_fee numeric(15,2) DEFAULT 0 NOT NULL,
  discount_amount numeric(15,2) DEFAULT 0 NOT NULL,
  coupon_code text,
  fx_rate_used numeric(12,6),
  web_reference text
);
CREATE TABLE public.cash_order_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  cash_order_id uuid NOT NULL, title text NOT NULL, sku text,
  quantity integer DEFAULT 1 NOT NULL, unit_price_jpy numeric(12,2) NOT NULL,
  line_total_jpy numeric(12,2) NOT NULL, created_at timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE public.layaway_account_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id uuid NOT NULL, title text NOT NULL, sku text,
  quantity integer DEFAULT 1 NOT NULL, unit_price_jpy numeric NOT NULL,
  line_total_jpy numeric NOT NULL, created_at timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE public.cash_payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  cash_order_id uuid NOT NULL, amount_paid numeric(12,2) NOT NULL,
  currency public.account_currency NOT NULL, payment_method text, reference_number text,
  voided_at timestamptz, created_at timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE public.payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id uuid NOT NULL, amount_paid numeric(15,2) NOT NULL,
  currency public.account_currency NOT NULL, payment_method text DEFAULT 'cash', reference_number text,
  voided_at timestamptz, created_at timestamptz DEFAULT now() NOT NULL
);
CREATE TABLE public.penalty_fees (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  account_id uuid NOT NULL, currency public.account_currency NOT NULL,
  penalty_amount numeric(15,2) NOT NULL,
  status public.penalty_fee_status DEFAULT 'unpaid' NOT NULL,
  waived_at timestamptz
);
CREATE TABLE public.square_payments (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, cash_order_id uuid NOT NULL);
CREATE TABLE public.square_refunds (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  square_payment_row uuid, cash_order_id uuid NOT NULL REFERENCES public.cash_orders(id),
  amount_jpy bigint NOT NULL, status text NOT NULL
);
CREATE TABLE public.square_disputes (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  square_payment_row uuid, cash_order_id uuid NOT NULL REFERENCES public.cash_orders(id),
  amount_jpy bigint, state text NOT NULL
);
CREATE TABLE public.paidy_refunds (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  cash_order_id uuid NOT NULL REFERENCES public.cash_orders(id),
  refund_id text NOT NULL UNIQUE, amount_jpy numeric(12,2) NOT NULL
);

CREATE SCHEMA storage;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[]
);
