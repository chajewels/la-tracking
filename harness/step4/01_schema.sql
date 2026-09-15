-- ===========================================================================
-- Cha Jewels step-4 harness — schema
-- Every CREATE TABLE / CREATE TYPE below was generated FROM THE LIVE DATABASE
-- on 2026-09-15 via pg_attribute/pg_attrdef and pg_enum (see harness/README).
-- ===========================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS net;
CREATE SCHEMA IF NOT EXISTS vault;

-- auth.uid(): the live function reads the request JWT. Locally it reads a GUC
-- so a test can act as a specific staff user, and returns NULL otherwise
-- (which is exactly what a service-role RPC call sees in production).
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('harness.uid', true), '')::uuid
$$;

-- net.http_post / vault.decrypted_secrets: stand-ins so notify_website_revalidate
-- runs to completion instead of erroring. It finds no secret and posts nothing,
-- which is the same no-op the trigger performs when the Vault key is absent.
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
                              headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);

-- --------------------------------------------------------------- enums (live)
CREATE TYPE public.account_currency AS ENUM ('PHP','JPY');
CREATE TYPE public.account_status AS ENUM ('active','completed','cancelled','overdue','forfeited','final_settlement','reactivated','extension_active','final_forfeited');
CREATE TYPE public.cash_order_status AS ENUM ('pending','completed','cancelled','expired');
CREATE TYPE public.schedule_status AS ENUM ('pending','partially_paid','paid','overdue','cancelled');
CREATE TYPE public.submission_status AS ENUM ('submitted','under_review','confirmed','rejected','needs_clarification','cancelled');
CREATE TYPE public.website_product_karat AS ENUM ('K18','K14','K10','PT1000','PT900','PT950','SILVER925','K24','750','18K','PT850','PM','PM900');
CREATE TYPE public.website_product_status AS ENUM ('draft','active','archived');
CREATE TYPE public.app_role AS ENUM ('admin','staff','finance','csr','customer','live_agent');
CREATE TYPE public.penalty_fee_status AS ENUM ('unpaid','paid','waived');
CREATE TYPE public.penalty_stage AS ENUM ('week1','week2');
CREATE TYPE public.user_status AS ENUM ('active','inactive','suspended');
CREATE TYPE public.waiver_status AS ENUM ('pending','approved','rejected','auto_unwaived');

-- ------------------------------------------------- tables (verbatim from live)
CREATE TABLE public.checkout_quotes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  items jsonb NOT NULL,
  mode text NOT NULL DEFAULT 'full'::text,
  term_months integer,
  order_type text NOT NULL DEFAULT 'SELF'::text,
  ship_to_address_id uuid,
  recipient_name text,
  recipient_phone text,
  gift_note text,
  subtotal_jpy integer NOT NULL,
  shipping_jpy integer,
  total_jpy integer NOT NULL,
  deposit_jpy integer,
  schedule jsonb,
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '00:30:00'::interval),
  consumed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  settlement_currency text NOT NULL DEFAULT 'JPY'::text,
  fx_rate numeric(12,6),
  fx_rate_date date
);
CREATE TABLE public.layaway_account_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  product_id uuid,
  shopify_line_item_id text,
  title text NOT NULL,
  sku text,
  quantity integer NOT NULL DEFAULT 1,
  unit_price_jpy numeric(12,2) NOT NULL,
  line_total_jpy numeric(12,2) NOT NULL,
  image_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  website_product_id uuid,
  variant_id uuid
);
CREATE TABLE public.layaway_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  invoice_number text NOT NULL,
  currency account_currency NOT NULL,
  total_amount numeric(15,2) NOT NULL,
  payment_plan_months integer NOT NULL,
  order_date date NOT NULL,
  end_date date,
  status account_status NOT NULL DEFAULT 'active'::account_status,
  total_paid numeric(15,2) NOT NULL DEFAULT 0,
  remaining_balance numeric(15,2) NOT NULL,
  agreement_version text,
  agreement_acceptance_date timestamp with time zone,
  accepted_by_user_id uuid,
  notes text,
  created_by_user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  downpayment_amount numeric NOT NULL DEFAULT 0,
  is_reactivated boolean NOT NULL DEFAULT false,
  reactivated_at timestamp with time zone,
  reactivated_by_user_id uuid,
  extension_end_date date,
  penalty_count_at_reactivation integer DEFAULT 0,
  completed_at timestamp with time zone,
  forfeited_at timestamp with time zone,
  loyalty_jpy_amount numeric,
  cash_receipt_sheet_id text,
  is_trade boolean NOT NULL DEFAULT false,
  is_test boolean NOT NULL DEFAULT false,
  discount_amount numeric(15,2) NOT NULL DEFAULT 0,
  discount_type text,
  discount_value numeric(15,2),
  shipping_fee numeric(15,2) NOT NULL DEFAULT 0,
  pancake_order_id text,
  shipping_method_id uuid,
  tracking_number text,
  shipped_at timestamp with time zone,
  tracking_set_by uuid,
  tracking_updated_at timestamp with time zone,
  source_channel text NOT NULL DEFAULT 'hub_manual'::text,
  web_reference text,
  quote_id uuid,
  transfer_due_at timestamp with time zone,
  customer_lang text,
  expired_at timestamp with time zone,
  fx_rate_used numeric(12,6),
  fx_rate_date date
);
CREATE TABLE public.layaway_schedule (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  installment_number integer NOT NULL,
  due_date date NOT NULL,
  base_installment_amount numeric(15,2) NOT NULL,
  penalty_amount numeric(15,2) NOT NULL DEFAULT 0,
  total_due_amount numeric(15,2) NOT NULL,
  paid_amount numeric(15,2) NOT NULL DEFAULT 0,
  currency account_currency NOT NULL,
  status schedule_status NOT NULL DEFAULT 'pending'::schedule_status,
  generated_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  carried_amount numeric(12,2) DEFAULT 0,
  carried_from_schedule_id uuid,
  carried_by_payment_id uuid
);
CREATE TABLE public.audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  old_value_json jsonb,
  new_value_json jsonb,
  performed_by_user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.payment_submissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  account_id uuid,
  submitted_amount numeric(15,2) NOT NULL,
  payment_date date NOT NULL,
  payment_method text NOT NULL,
  reference_number text,
  sender_name text,
  notes text,
  proof_url text,
  status submission_status NOT NULL DEFAULT 'submitted'::submission_status,
  reviewer_user_id uuid,
  reviewer_notes text,
  confirmed_payment_id uuid,
  portal_token text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  submission_type text NOT NULL DEFAULT 'single'::text,
  customer_edited_at timestamp with time zone,
  installment_number integer,
  cash_order_id uuid
);
CREATE TABLE public.payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  amount_paid numeric(15,2) NOT NULL,
  currency account_currency NOT NULL,
  date_paid date NOT NULL DEFAULT CURRENT_DATE,
  payment_method text DEFAULT 'cash'::text,
  reference_number text,
  remarks text,
  entered_by_user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  voided_at timestamp with time zone,
  voided_by_user_id uuid,
  void_reason text,
  submitted_by_type text,
  submitted_by_name text
);
CREATE TABLE public.plan_configurations (
  plan_months integer NOT NULL,
  min_amount_jpy numeric NOT NULL DEFAULT 0,
  min_amount_php numeric NOT NULL DEFAULT 0,
  dp_percentage numeric NOT NULL DEFAULT 0.30,
  is_active boolean NOT NULL DEFAULT true,
  display_label text NOT NULL,
  risk_tier text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.website_product_variants (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  size text,
  stone text,
  price_jpy integer NOT NULL,
  cost_basis integer,
  stock_qty integer NOT NULL DEFAULT 0,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.website_products (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sku text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  karat website_product_karat,
  weight_g numeric(8,2),
  description_en text,
  description_ja text,
  status website_product_status NOT NULL DEFAULT 'draft'::website_product_status,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  condition text NOT NULL DEFAULT 'New'::text,
  origin text NOT NULL DEFAULT 'UNKNOWN'::text,
  brand text,
  name_ja text,
  metals text[] NOT NULL DEFAULT '{}'::text[]
);
CREATE TABLE public.website_collections (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  slug text NOT NULL, name text NOT NULL, hero_media text, description text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  name_ja text, description_ja text
);
CREATE TABLE public.cash_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  invoice_number text NOT NULL,
  customer_id uuid NOT NULL,
  currency account_currency NOT NULL DEFAULT 'JPY'::account_currency,
  total_amount numeric(12,2) NOT NULL,
  total_paid numeric(12,2) NOT NULL DEFAULT 0,
  remaining_balance numeric(12,2) NOT NULL,
  status cash_order_status NOT NULL DEFAULT 'pending'::cash_order_status,
  item_description text,
  loyalty_jpy_amount numeric(12,2),
  order_date date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  agreement_version text,
  agreement_acceptance_datetime timestamp with time zone,
  accepted_by_user_id uuid,
  completed_at timestamp with time zone,
  created_by_user_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  cancellation_reason text,
  cancelled_at timestamp with time zone,
  cancelled_by_user_id uuid,
  expires_at timestamp with time zone,
  expired_at timestamp with time zone,
  cash_receipt_sheet_id text,
  is_trade boolean NOT NULL DEFAULT false,
  is_test boolean NOT NULL DEFAULT false,
  source_channel text NOT NULL DEFAULT 'hub_manual'::text,
  discount_amount numeric(12,2) NOT NULL DEFAULT 0,
  discount_type text,
  discount_value numeric(12,2),
  shipping_fee numeric(12,2) NOT NULL DEFAULT 0,
  shopify_order_id text,
  pancake_order_id text,
  shipping_method_id uuid,
  tracking_number text,
  shipped_at timestamp with time zone,
  tracking_set_by uuid,
  tracking_updated_at timestamp with time zone,
  order_type text,
  payment_method text,
  payment_status text,
  ship_to_address_id uuid,
  recipient_name text,
  recipient_phone text,
  gift_note text,
  quote_id uuid,
  web_reference text,
  transfer_due_at timestamp with time zone,
  customer_lang text,
  refund_status text,
  refund_note text,
  refund_decided_at timestamp with time zone,
  refund_decided_by_user_id uuid
);
CREATE TABLE public.customers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_code text,
  full_name text NOT NULL,
  mobile_number text, email text, facebook_name text, messenger_link text,
  preferred_contact_method text DEFAULT 'messenger'::text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  location text, auth_user_id uuid, setup_link_sent_at timestamp with time zone,
  address_line1 text, city text, postal_code text, country text,
  birthday date, birthday_locked_at timestamp with time zone,
  birthday_admin_edits_used smallint DEFAULT 0,
  last_birthday_award_year smallint,
  is_test boolean NOT NULL DEFAULT false,
  needs_review boolean NOT NULL DEFAULT false,
  source text, shopify_customer_id text, pancake_fb_id text,
  portal_last_seen_at timestamp with time zone
);
CREATE TABLE public.account_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid,
  note_text text NOT NULL, created_by_user_id uuid, created_by_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(), cash_order_id uuid
);
CREATE TABLE public.account_services (
  id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
  service_type text NOT NULL, description text, amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'PHP'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by_user_id uuid, updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.cash_payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(), cash_order_id uuid NOT NULL,
  amount_paid numeric(12,2) NOT NULL, currency account_currency NOT NULL,
  date_paid date NOT NULL, payment_method text, reference_number text, remarks text,
  entered_by_user_id uuid, submitted_by_type text, submitted_by_name text,
  voided_at timestamp with time zone, voided_by_user_id uuid, void_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.commission_agents (
  id uuid NOT NULL DEFAULT gen_random_uuid(), name text NOT NULL,
  color text NOT NULL DEFAULT '#1756A8'::text, active boolean NOT NULL DEFAULT true,
  start_month date NOT NULL DEFAULT '2026-01-01'::date, sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(), user_id uuid
);
CREATE TABLE public.payment_history_backup (
  id uuid NOT NULL DEFAULT gen_random_uuid(), payment_id uuid NOT NULL,
  account_id uuid NOT NULL, invoice_number text NOT NULL, customer_name text,
  amount numeric(12,2) NOT NULL, currency text NOT NULL, payment_date date NOT NULL,
  payment_method text, submission_type text, notes text, status text NOT NULL,
  approved_by uuid, approved_by_name text, approved_at timestamp with time zone,
  voided_by uuid, voided_by_name text, voided_at timestamp with time zone,
  void_reason text, backed_up_at timestamp with time zone NOT NULL DEFAULT now(),
  event_type text NOT NULL
);
CREATE TABLE public.penalty_fees (
  id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
  schedule_id uuid NOT NULL, currency account_currency NOT NULL,
  penalty_amount numeric(15,2) NOT NULL, penalty_stage penalty_stage NOT NULL,
  penalty_cycle integer NOT NULL DEFAULT 1, penalty_date date NOT NULL DEFAULT CURRENT_DATE,
  status penalty_fee_status NOT NULL DEFAULT 'unpaid'::penalty_fee_status,
  waived_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.penalty_waiver_requests (
  id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
  schedule_id uuid NOT NULL, penalty_fee_id uuid NOT NULL,
  penalty_amount numeric(15,2) NOT NULL, requested_by_user_id uuid, reason text NOT NULL,
  status waiver_status NOT NULL DEFAULT 'pending'::waiver_status,
  approved_by_user_id uuid, approved_at timestamp with time zone,
  rejected_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  auto_unwaived_at timestamp with time zone, is_auto boolean NOT NULL DEFAULT false,
  source_submission_id uuid
);
CREATE TABLE public.profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  full_name text NOT NULL, email text,
  status user_status NOT NULL DEFAULT 'active'::user_status,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.sales_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(), sale_date date NOT NULL, item_code text,
  item_amount numeric, client_name text, closer text, processor text, coordinator text,
  support text, verifier text, status text NOT NULL DEFAULT 'Paid'::text,
  channel text, source text, opened_in_chat boolean NOT NULL DEFAULT true,
  closed_in_chat boolean NOT NULL DEFAULT true, eligible boolean NOT NULL DEFAULT true,
  notes text, created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(), invoice_number text
);
CREATE TABLE public.schedule_audit_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(), account_id uuid NOT NULL,
  schedule_id uuid NOT NULL, admin_user_id uuid, action text NOT NULL,
  field_changed text, old_value text, new_value text, reason text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.staff_notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(), type text NOT NULL, title text NOT NULL,
  body text, account_id uuid, customer_id uuid, invoice_number text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.system_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(), key text NOT NULL, value jsonb NOT NULL,
  description text, updated_by_user_id uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE public.user_roles (
  id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role app_role NOT NULL
);

-- Primary keys the RPCs rely on (FOR UPDATE, RETURNING, joins).
ALTER TABLE public.layaway_accounts        ADD PRIMARY KEY (id);
ALTER TABLE public.layaway_schedule        ADD PRIMARY KEY (id);
ALTER TABLE public.layaway_account_items   ADD PRIMARY KEY (id);
ALTER TABLE public.checkout_quotes         ADD PRIMARY KEY (id);
ALTER TABLE public.website_product_variants ADD PRIMARY KEY (id);
ALTER TABLE public.website_products        ADD PRIMARY KEY (id);
ALTER TABLE public.cash_orders             ADD PRIMARY KEY (id);
ALTER TABLE public.customers               ADD PRIMARY KEY (id);
ALTER TABLE public.payments                ADD PRIMARY KEY (id);
ALTER TABLE public.payment_submissions     ADD PRIMARY KEY (id);
ALTER TABLE public.plan_configurations     ADD PRIMARY KEY (plan_months);
ALTER TABLE public.audit_logs              ADD PRIMARY KEY (id);
ALTER TABLE public.penalty_fees            ADD PRIMARY KEY (id);

CREATE SEQUENCE public.web_order_number_seq START WITH 900014;
