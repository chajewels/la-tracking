-- ============================================================================
-- Baseline migration: live public-schema DDL
-- Generated from live catalogs on 2026-07-05
--
-- The live database already contains everything herein. NEVER apply this
-- migration against the live project (`supabase db push`, `supabase migration
-- up`, or equivalent) — migration-history mismatch is expected and irrelevant.
--
-- Purpose: faithful fresh rebuilds (local dev, staging bootstrap) and an
-- in-repo source of truth for the public schema, since prior migration files
-- had drifted from the live catalogs (see CLAUDE.md § "Migrations baseline").
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgmq WITH SCHEMA pgmq;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------
CREATE TYPE public.account_currency AS ENUM (
  'PHP',
  'JPY'
);

CREATE TYPE public.account_status AS ENUM (
  'active',
  'completed',
  'cancelled',
  'overdue',
  'forfeited',
  'final_settlement',
  'reactivated',
  'extension_active',
  'final_forfeited'
);

CREATE TYPE public.allocation_type AS ENUM (
  'penalty',
  'installment'
);

CREATE TYPE public.app_role AS ENUM (
  'admin',
  'staff',
  'finance',
  'csr',
  'customer',
  'live_agent'
);

CREATE TYPE public.cash_order_status AS ENUM (
  'pending',
  'completed',
  'cancelled',
  'expired'
);

CREATE TYPE public.clv_tier AS ENUM (
  'bronze',
  'silver',
  'gold',
  'vip'
);

CREATE TYPE public.loyalty_lot_source_type AS ENUM (
  'order_earn',
  'birthday_bonus',
  'promo_bonus',
  'admin_adjust',
  'refund_restoration'
);

CREATE TYPE public.loyalty_redemption_status AS ENUM (
  'pending',
  'confirmed',
  'cancelled'
);

CREATE TYPE public.loyalty_redemption_type AS ENUM (
  'new_order_discount',
  'shipping_fee',
  'service_fee',
  'catalog_reward'
);

CREATE TYPE public.loyalty_transaction_type AS ENUM (
  'earned',
  'bonus',
  'redeemed',
  'expired',
  'adjusted',
  'refunded',
  'revoked',
  'enrolled',
  'tier_changed',
  'status_changed',
  'admin_edited',
  'birthday_bonus'
);

CREATE TYPE public.penalty_fee_status AS ENUM (
  'unpaid',
  'paid',
  'waived'
);

CREATE TYPE public.penalty_stage AS ENUM (
  'week1',
  'week2'
);

CREATE TYPE public.resale_status AS ENUM (
  'In stock',
  'Sold'
);

CREATE TYPE public.risk_level AS ENUM (
  'low',
  'medium',
  'high'
);

CREATE TYPE public.schedule_status AS ENUM (
  'pending',
  'partially_paid',
  'paid',
  'overdue',
  'cancelled'
);

CREATE TYPE public.service_status AS ENUM (
  'Logged',
  'Process',
  'On-going',
  'Pending',
  'Cancelled',
  'Completed'
);

CREATE TYPE public.service_type AS ENUM (
  'Ring Resize',
  'Certificate',
  'Repair',
  'Bracelet Resize',
  'Polishing',
  'Watch Polishing',
  'Color Change'
);

CREATE TYPE public.submission_status AS ENUM (
  'submitted',
  'under_review',
  'confirmed',
  'rejected',
  'needs_clarification',
  'cancelled'
);

CREATE TYPE public.user_status AS ENUM (
  'active',
  'inactive',
  'suspended'
);

CREATE TYPE public.waiver_status AS ENUM (
  'pending',
  'approved',
  'rejected'
);

-- ---------------------------------------------------------------------------
-- Sequences (standalone; identity/serial-owned sequences are handled inline)
-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Tables (columns only; constraints emitted later)
-- ---------------------------------------------------------------------------
CREATE TABLE public.account_notes (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid,
  note_text text NOT NULL,
  created_by_user_id uuid,
  created_by_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  cash_order_id uuid
);

CREATE TABLE public.account_services (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  service_type text NOT NULL,
  description text,
  amount numeric DEFAULT 0 NOT NULL,
  currency text DEFAULT 'PHP'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by_user_id uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.announcements (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  image_url text,
  link_url text,
  link_label text,
  is_active boolean DEFAULT true,
  show_once boolean DEFAULT true,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.audit_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  old_value_json jsonb,
  new_value_json jsonb,
  performed_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.cash_orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  invoice_number text NOT NULL,
  customer_id uuid NOT NULL,
  currency account_currency DEFAULT 'JPY'::account_currency NOT NULL,
  total_amount numeric(12,2) NOT NULL,
  total_paid numeric(12,2) DEFAULT 0 NOT NULL,
  remaining_balance numeric(12,2) NOT NULL,
  status cash_order_status DEFAULT 'pending'::cash_order_status NOT NULL,
  item_description text,
  loyalty_jpy_amount numeric(12,2),
  order_date date DEFAULT CURRENT_DATE NOT NULL,
  notes text,
  agreement_version text,
  agreement_acceptance_datetime timestamp with time zone,
  accepted_by_user_id uuid,
  completed_at timestamp with time zone,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  cancellation_reason text,
  cancelled_at timestamp with time zone,
  cancelled_by_user_id uuid,
  expires_at timestamp with time zone,
  expired_at timestamp with time zone,
  cash_receipt_sheet_id text,
  is_trade boolean DEFAULT false NOT NULL,
  is_test boolean DEFAULT false NOT NULL
);

CREATE TABLE public.cash_payments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  cash_order_id uuid NOT NULL,
  amount_paid numeric(12,2) NOT NULL,
  currency account_currency NOT NULL,
  date_paid date NOT NULL,
  payment_method text,
  reference_number text,
  remarks text,
  entered_by_user_id uuid,
  submitted_by_type text,
  submitted_by_name text,
  voided_at timestamp with time zone,
  voided_by_user_id uuid,
  void_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.commission_agents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  color text DEFAULT '#1756A8'::text NOT NULL,
  active boolean DEFAULT true NOT NULL,
  start_month date DEFAULT '2026-01-01'::date NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  user_id uuid
);

CREATE TABLE public.commission_splits (
  month date NOT NULL,
  closer_pct numeric DEFAULT 0 NOT NULL,
  processor_pct numeric DEFAULT 0 NOT NULL,
  coordinator_pct numeric DEFAULT 0 NOT NULL,
  support_pct numeric DEFAULT 0 NOT NULL,
  verifier_pct numeric DEFAULT 0 NOT NULL,
  top_sales_pct numeric DEFAULT 0 NOT NULL,
  pool_per_item_php numeric DEFAULT 200 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  merge_groups jsonb DEFAULT '[]'::jsonb NOT NULL
);

CREATE TABLE public.csr_notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  invoice_number text NOT NULL,
  due_date date NOT NULL,
  reminder_stage text NOT NULL,
  notified boolean DEFAULT true NOT NULL,
  notified_by_user_id uuid NOT NULL,
  notified_by_name text NOT NULL,
  notified_at timestamp with time zone DEFAULT now() NOT NULL,
  contact_method text DEFAULT 'messenger'::text,
  remarks text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.customer_analytics (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  lifetime_value_amount numeric(15,2) DEFAULT 0,
  lifetime_value_tier clv_tier DEFAULT 'bronze'::clv_tier,
  payment_reliability_score numeric(5,2) DEFAULT 0,
  completion_probability_score numeric(5,2) DEFAULT 0,
  late_payment_risk_score numeric(5,2) DEFAULT 0,
  late_payment_risk_level risk_level DEFAULT 'low'::risk_level,
  last_calculated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.customer_pins (
  customer_id uuid NOT NULL,
  pin_hash text,
  pin_attempts integer DEFAULT 0 NOT NULL,
  pin_locked_until timestamp with time zone
);

CREATE TABLE public.customer_portal_sessions (
  session_id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  source_token_id uuid NOT NULL,
  expires_at timestamp with time zone DEFAULT (now() + '180 days'::interval) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  last_used_at timestamp with time zone DEFAULT now() NOT NULL,
  user_agent text,
  ip_address inet
);

CREATE TABLE public.customer_portal_tokens (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex'::text) NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  expires_at timestamp with time zone DEFAULT (now() + '180 days'::interval),
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.customers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_code text,
  full_name text NOT NULL,
  mobile_number text,
  email text,
  facebook_name text,
  messenger_link text,
  preferred_contact_method text DEFAULT 'messenger'::text,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  location text,
  auth_user_id uuid,
  setup_link_sent_at timestamp with time zone,
  address_line1 text,
  city text,
  postal_code text,
  country text,
  birthday date,
  birthday_locked_at timestamp with time zone,
  birthday_admin_edits_used smallint DEFAULT 0,
  last_birthday_award_year smallint,
  is_test boolean DEFAULT false NOT NULL
);

CREATE TABLE public.email_send_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  message_id text,
  template_name text NOT NULL,
  recipient_email text NOT NULL,
  status text NOT NULL,
  error_message text,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  idempotency_key text
);

CREATE TABLE public.email_send_state (
  id integer DEFAULT 1 NOT NULL,
  retry_after_until timestamp with time zone,
  batch_size integer DEFAULT 10 NOT NULL,
  send_delay_ms integer DEFAULT 200 NOT NULL,
  auth_email_ttl_minutes integer DEFAULT 15 NOT NULL,
  transactional_email_ttl_minutes integer DEFAULT 60 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.email_unsubscribe_tokens (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  token text NOT NULL,
  email text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  used_at timestamp with time zone
);

CREATE TABLE public.extension_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid,
  customer_id uuid,
  portal_token text,
  reason text,
  status text DEFAULT 'pending'::text,
  requested_at timestamp with time zone DEFAULT now(),
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  reviewer_notes text,
  extension_expiry_date date
);

CREATE TABLE public.feature_toggles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  feature_key text NOT NULL,
  is_enabled boolean DEFAULT true NOT NULL,
  label text NOT NULL,
  description text,
  module text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by_user_id uuid
);

CREATE TABLE public.final_settlement_records (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  last_paid_month_date date,
  penalty_occurrence_count integer DEFAULT 0 NOT NULL,
  penalty_total_from_last_paid numeric(15,2) DEFAULT 0 NOT NULL,
  remaining_principal numeric(15,2) DEFAULT 0 NOT NULL,
  final_settlement_amount numeric(15,2) DEFAULT 0 NOT NULL,
  calculation_json jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.financial_alerts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  alert_type text NOT NULL,
  severity text NOT NULL,
  plan_months integer,
  message text NOT NULL,
  threshold_value numeric,
  current_value numeric,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.forecast_snapshots (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  forecast_type text NOT NULL,
  currency_mode text DEFAULT 'ALL'::text NOT NULL,
  forecast_period_start date NOT NULL,
  forecast_period_end date NOT NULL,
  forecast_value numeric(15,2) NOT NULL,
  metadata_json jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.generated_invoices (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid,
  cash_order_id uuid,
  parent_invoice_number text NOT NULL,
  sheet_id text NOT NULL,
  sheet_url text NOT NULL,
  drive_folder_path text NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL,
  generated_by_user_id uuid,
  generated_by_name text,
  ship_to jsonb NOT NULL,
  bill_to jsonb NOT NULL,
  items jsonb NOT NULL,
  discount_jpy numeric(12,0) DEFAULT 0 NOT NULL,
  shipping_fee_jpy numeric(12,0) DEFAULT 0 NOT NULL,
  subtotal_pretax_jpy numeric(12,0) NOT NULL,
  tax_jpy numeric(12,0) NOT NULL,
  total_jpy numeric(12,0) NOT NULL
);

CREATE TABLE public.inquiry_dropdown_options (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  dropdown_type text NOT NULL,
  value text NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.keep_fix_audit (
  invoice_number text,
  currency account_currency,
  remaining_balance numeric(15,2),
  schedule_id uuid,
  installment_number integer,
  status schedule_status,
  base_installment_amount numeric(15,2),
  penalty_amount numeric(15,2),
  carried_amount numeric(12,2),
  total_due_amount numeric(15,2),
  paid_amount numeric(15,2),
  snapshot_at timestamp with time zone
);

CREATE TABLE public.layaway_accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  invoice_number text NOT NULL,
  currency account_currency NOT NULL,
  total_amount numeric(15,2) NOT NULL,
  payment_plan_months integer NOT NULL,
  order_date date NOT NULL,
  end_date date,
  status account_status DEFAULT 'active'::account_status NOT NULL,
  total_paid numeric(15,2) DEFAULT 0 NOT NULL,
  remaining_balance numeric(15,2) NOT NULL,
  agreement_version text,
  agreement_acceptance_date timestamp with time zone,
  accepted_by_user_id uuid,
  notes text,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  downpayment_amount numeric DEFAULT 0 NOT NULL,
  is_reactivated boolean DEFAULT false NOT NULL,
  reactivated_at timestamp with time zone,
  reactivated_by_user_id uuid,
  extension_end_date date,
  penalty_count_at_reactivation integer DEFAULT 0,
  completed_at timestamp with time zone,
  forfeited_at timestamp with time zone,
  loyalty_jpy_amount numeric,
  cash_receipt_sheet_id text,
  is_trade boolean DEFAULT false NOT NULL,
  is_test boolean DEFAULT false NOT NULL
);

CREATE TABLE public.layaway_schedule (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  installment_number integer NOT NULL,
  due_date date NOT NULL,
  base_installment_amount numeric(15,2) NOT NULL,
  penalty_amount numeric(15,2) DEFAULT 0 NOT NULL,
  total_due_amount numeric(15,2) NOT NULL,
  paid_amount numeric(15,2) DEFAULT 0 NOT NULL,
  currency account_currency NOT NULL,
  status schedule_status DEFAULT 'pending'::schedule_status NOT NULL,
  generated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  carried_amount numeric(12,2) DEFAULT 0,
  carried_from_schedule_id uuid,
  carried_by_payment_id uuid
);

CREATE TABLE public.loyalty_award_19015_audit_20260520 (
  id uuid,
  customer_id uuid,
  cumulative_spend_jpy numeric,
  earned_tier_id uuid,
  current_tier_id uuid,
  is_downgraded boolean,
  last_purchase_at timestamp with time zone,
  prev_purchase_at timestamp with time zone,
  total_points_earned numeric,
  total_points_redeemed numeric,
  total_points_expired numeric,
  remaining_points numeric,
  pre_expiry_warned_at timestamp with time zone,
  enrolled_at timestamp with time zone,
  updated_at timestamp with time zone
);

CREATE TABLE public.loyalty_banners (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  banner_type text NOT NULL,
  title text NOT NULL,
  subtitle text,
  description text,
  image_url text,
  emoji text,
  link_target text,
  applicable_tiers text[],
  is_active boolean DEFAULT true NOT NULL,
  display_priority integer DEFAULT 0 NOT NULL,
  start_at timestamp with time zone,
  end_at timestamp with time zone,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.loyalty_beta_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  added_by_user_id uuid,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.loyalty_expiry_restore_audit_20260520 (
  captured_at timestamp with time zone,
  id uuid,
  customer_id uuid,
  cumulative_spend_jpy numeric,
  earned_tier_id uuid,
  current_tier_id uuid,
  is_downgraded boolean,
  last_purchase_at timestamp with time zone,
  prev_purchase_at timestamp with time zone,
  total_points_earned numeric,
  total_points_redeemed numeric,
  total_points_expired numeric,
  remaining_points numeric,
  pre_expiry_warned_at timestamp with time zone,
  enrolled_at timestamp with time zone,
  updated_at timestamp with time zone
);

CREATE TABLE public.loyalty_last_purchase_backfill_audit_20260520 (
  member_id uuid,
  customer_id uuid,
  last_purchase_at timestamp with time zone,
  updated_at timestamp with time zone
);

CREATE TABLE public.loyalty_lot_consumption (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  redemption_id uuid NOT NULL,
  lot_id uuid NOT NULL,
  amount integer NOT NULL,
  consumed_at timestamp with time zone DEFAULT now() NOT NULL,
  restored_at timestamp with time zone,
  restored_amount integer
);

CREATE TABLE public.loyalty_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  cumulative_spend_jpy numeric DEFAULT 0 NOT NULL,
  earned_tier_id uuid NOT NULL,
  current_tier_id uuid NOT NULL,
  is_downgraded boolean DEFAULT false NOT NULL,
  last_purchase_at timestamp with time zone,
  prev_purchase_at timestamp with time zone,
  total_points_earned numeric DEFAULT 0 NOT NULL,
  total_points_redeemed numeric DEFAULT 0 NOT NULL,
  total_points_expired numeric DEFAULT 0 NOT NULL,
  remaining_points numeric DEFAULT 0 NOT NULL,
  pre_expiry_warned_at timestamp with time zone,
  enrolled_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  downgrade_spend_baseline numeric
);

CREATE TABLE public.loyalty_members_backup_pre_migration (
  id uuid,
  customer_id uuid,
  cumulative_spend_jpy numeric,
  earned_tier_id uuid,
  current_tier_id uuid,
  is_downgraded boolean,
  last_purchase_at timestamp with time zone,
  prev_purchase_at timestamp with time zone,
  total_points_earned numeric,
  total_points_redeemed numeric,
  total_points_expired numeric,
  remaining_points numeric,
  pre_expiry_warned_at timestamp with time zone,
  enrolled_at timestamp with time zone,
  updated_at timestamp with time zone
);

CREATE TABLE public.loyalty_notification_recipients (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  notification_id uuid NOT NULL,
  member_id uuid NOT NULL,
  is_read boolean DEFAULT false NOT NULL,
  read_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.loyalty_notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  category text NOT NULL,
  audience_type text NOT NULL,
  audience_tiers text[],
  audience_member_ids uuid[],
  link_target text,
  status text DEFAULT 'draft'::text NOT NULL,
  scheduled_for timestamp with time zone,
  sent_at timestamp with time zone,
  expires_at timestamp with time zone,
  send_email boolean DEFAULT false NOT NULL,
  email_sent boolean DEFAULT false NOT NULL,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.loyalty_point_lots (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  member_id uuid NOT NULL,
  source_type loyalty_lot_source_type NOT NULL,
  source_reference text,
  original_amount integer NOT NULL,
  remaining_amount integer NOT NULL,
  earned_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone,
  consumed_at timestamp with time zone,
  expired_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  revoked_at timestamp with time zone,
  revoked_by_transaction_id uuid,
  spend_basis_jpy numeric(12,2)
);

CREATE TABLE public.loyalty_point_lots_backup_pre_migration (
  id uuid,
  member_id uuid,
  source_type loyalty_lot_source_type,
  source_reference text,
  original_amount integer,
  remaining_amount integer,
  earned_at timestamp with time zone,
  expires_at timestamp with time zone,
  consumed_at timestamp with time zone,
  expired_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  revoked_at timestamp with time zone,
  revoked_by_transaction_id uuid,
  spend_basis_jpy numeric(12,2)
);

CREATE TABLE public.loyalty_promos (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  description text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  bonus_points numeric DEFAULT 0 NOT NULL,
  applicable_tiers text[],
  max_per_customer integer,
  applies_per_purchase boolean DEFAULT true NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  image_url text,
  display_priority integer DEFAULT 0 NOT NULL,
  bonus_multiplier numeric(5,2) DEFAULT 1.00 NOT NULL
);

CREATE TABLE public.loyalty_redemptions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  member_id uuid NOT NULL,
  transaction_id uuid,
  redemption_type loyalty_redemption_type NOT NULL,
  points_redeemed numeric NOT NULL,
  value_applied_jpy numeric NOT NULL,
  value_applied_php numeric,
  rate_snapshot numeric,
  invoice_number text,
  account_id uuid,
  cash_order_id uuid,
  status loyalty_redemption_status DEFAULT 'pending'::loyalty_redemption_status NOT NULL,
  processed_by_user_id uuid,
  processed_at timestamp with time zone,
  cancelled_by_user_id uuid,
  cancelled_at timestamp with time zone,
  cancellation_reason text,
  notes text,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  reward_id uuid
);

CREATE TABLE public.loyalty_rewards (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  description text,
  image_url text,
  category text NOT NULL,
  tier_visibility text DEFAULT 'All'::text NOT NULL,
  points_cost integer DEFAULT 0 NOT NULL,
  stock_limit integer,
  current_stock integer,
  is_limited boolean DEFAULT false NOT NULL,
  is_vip_only boolean DEFAULT false NOT NULL,
  is_vault boolean DEFAULT false NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  display_priority integer DEFAULT 0 NOT NULL,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.loyalty_tiers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  min_spend_jpy numeric NOT NULL,
  points_multiplier numeric NOT NULL,
  free_shipping_min_items integer,
  mystery_gift boolean DEFAULT false NOT NULL,
  color_hex text,
  display_order smallint NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  birthday_bonus_points integer DEFAULT 0 NOT NULL,
  benefits jsonb DEFAULT '[]'::jsonb NOT NULL,
  requalify_spend_jpy numeric
);

CREATE TABLE public.loyalty_transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  member_id uuid NOT NULL,
  account_id uuid,
  cash_order_id uuid,
  payment_id uuid,
  promo_id uuid,
  transaction_type loyalty_transaction_type NOT NULL,
  points_amount numeric NOT NULL,
  spend_amount_jpy numeric,
  rate_snapshot numeric,
  invoice_number text,
  tier_at_time text,
  notes text,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  synced_to_sheet_at timestamp with time zone
);

CREATE TABLE public.loyalty_transactions_backup_pre_migration (
  id uuid,
  member_id uuid,
  account_id uuid,
  cash_order_id uuid,
  payment_id uuid,
  promo_id uuid,
  transaction_type loyalty_transaction_type,
  points_amount numeric,
  spend_amount_jpy numeric,
  rate_snapshot numeric,
  invoice_number text,
  tier_at_time text,
  notes text,
  created_by_user_id uuid,
  created_at timestamp with time zone
);

CREATE TABLE public.notify_loyalty_launch (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid,
  email text NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  notified_at timestamp with time zone
);

CREATE TABLE public.payment_allocations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  payment_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  allocation_type allocation_type NOT NULL,
  allocated_amount numeric(15,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.payment_history_backup (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  payment_id uuid NOT NULL,
  account_id uuid NOT NULL,
  invoice_number text NOT NULL,
  customer_name text,
  amount numeric(12,2) NOT NULL,
  currency text NOT NULL,
  payment_date date NOT NULL,
  payment_method text,
  submission_type text,
  notes text,
  status text NOT NULL,
  approved_by uuid,
  approved_by_name text,
  approved_at timestamp with time zone,
  voided_by uuid,
  voided_by_name text,
  voided_at timestamp with time zone,
  void_reason text,
  backed_up_at timestamp with time zone DEFAULT now() NOT NULL,
  event_type text NOT NULL
);

CREATE TABLE public.payment_methods (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  method_name text NOT NULL,
  bank_name text,
  account_name text,
  account_number text,
  instructions text,
  qr_image_url text,
  sort_order integer DEFAULT 0 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.payment_proofs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid,
  payment_id uuid,
  installment_number integer,
  submission_date date,
  file_url text NOT NULL,
  file_name text,
  uploaded_by_user_id uuid,
  uploaded_by_name text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  cash_order_id uuid,
  cash_payment_id uuid
);

CREATE TABLE public.payment_submission_allocations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  submission_id uuid NOT NULL,
  account_id uuid NOT NULL,
  invoice_number text NOT NULL,
  allocated_amount numeric(15,2) NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.payment_submissions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  customer_id uuid NOT NULL,
  account_id uuid,
  submitted_amount numeric(15,2) NOT NULL,
  payment_date date NOT NULL,
  payment_method text NOT NULL,
  reference_number text,
  sender_name text,
  notes text,
  proof_url text,
  status submission_status DEFAULT 'submitted'::submission_status NOT NULL,
  reviewer_user_id uuid,
  reviewer_notes text,
  confirmed_payment_id uuid,
  portal_token text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  submission_type text DEFAULT 'single'::text NOT NULL,
  customer_edited_at timestamp with time zone,
  installment_number integer,
  cash_order_id uuid
);

CREATE TABLE public.payments (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  amount_paid numeric(15,2) NOT NULL,
  currency account_currency NOT NULL,
  date_paid date DEFAULT CURRENT_DATE NOT NULL,
  payment_method text DEFAULT 'cash'::text,
  reference_number text,
  remarks text,
  entered_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  voided_at timestamp with time zone,
  voided_by_user_id uuid,
  void_reason text,
  submitted_by_type text,
  submitted_by_name text
);

CREATE TABLE public.penalty_cap_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  currency text NOT NULL,
  penalty_cap_amount numeric NOT NULL,
  penalty_cap_scope text DEFAULT 'Due months 1-5 only'::text NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  applied_by_user_id uuid,
  applied_at timestamp with time zone DEFAULT now() NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.penalty_fees (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  currency account_currency NOT NULL,
  penalty_amount numeric(15,2) NOT NULL,
  penalty_stage penalty_stage NOT NULL,
  penalty_cycle integer DEFAULT 1 NOT NULL,
  penalty_date date DEFAULT CURRENT_DATE NOT NULL,
  status penalty_fee_status DEFAULT 'unpaid'::penalty_fee_status NOT NULL,
  waived_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.penalty_waiver_requests (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  penalty_fee_id uuid NOT NULL,
  penalty_amount numeric(15,2) NOT NULL,
  requested_by_user_id uuid NOT NULL,
  reason text NOT NULL,
  status waiver_status DEFAULT 'pending'::waiver_status NOT NULL,
  approved_by_user_id uuid,
  approved_at timestamp with time zone,
  rejected_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.plan_configurations (
  plan_months integer NOT NULL,
  min_amount_jpy numeric DEFAULT 0 NOT NULL,
  min_amount_php numeric DEFAULT 0 NOT NULL,
  dp_percentage numeric DEFAULT 0.30 NOT NULL,
  is_active boolean DEFAULT true NOT NULL,
  display_label text NOT NULL,
  risk_tier text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.product_inquiries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  item_code text,
  product_name text,
  category text DEFAULT 'Jewelry'::text NOT NULL,
  inquiry_count integer DEFAULT 1 NOT NULL,
  last_inquired_date date,
  popular_inquiries_notes text,
  source text,
  action_needed text,
  order_placed text DEFAULT 'No'::text,
  inquirer_name text,
  entered_by text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  full_name text NOT NULL,
  email text,
  status user_status DEFAULT 'active'::user_status NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.promo_categories (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  display_order integer DEFAULT 0,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.promo_category_assignments (
  promo_id uuid NOT NULL,
  category_id uuid NOT NULL
);

CREATE TABLE public.promo_views (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  promo_id uuid NOT NULL,
  category_id uuid,
  customer_id uuid NOT NULL,
  invoice_number text NOT NULL,
  viewed_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.promotions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  title text NOT NULL,
  description text,
  media_url text,
  media_type text,
  link_url text,
  is_active boolean DEFAULT true,
  display_order integer DEFAULT 0,
  created_by uuid,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  expires_at timestamp with time zone,
  price numeric(12,2) DEFAULT NULL::numeric,
  currency text
);

CREATE TABLE public.reconciliation_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid,
  invoice_number text,
  checked_at timestamp with time zone DEFAULT now(),
  drift_detected boolean DEFAULT false,
  drift_count integer DEFAULT 0,
  drift jsonb DEFAULT '[]'::jsonb
);

CREATE TABLE public.reminder_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  schedule_id uuid,
  customer_id uuid NOT NULL,
  channel text DEFAULT 'messenger'::text NOT NULL,
  recipient text,
  template_type text,
  message_body text,
  sent_at timestamp with time zone DEFAULT now(),
  delivery_status text DEFAULT 'sent'::text,
  provider_name text,
  provider_message_id text,
  error_message text,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.role_permissions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  role app_role NOT NULL,
  permission_key text NOT NULL,
  is_allowed boolean DEFAULT false NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by_user_id uuid
);

CREATE TABLE public.sales_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  sale_date date NOT NULL,
  item_code text,
  item_amount numeric,
  client_name text,
  closer text,
  processor text,
  coordinator text,
  support text,
  verifier text,
  status text DEFAULT 'Paid'::text NOT NULL,
  channel text,
  source text,
  opened_in_chat boolean DEFAULT true NOT NULL,
  closed_in_chat boolean DEFAULT true NOT NULL,
  eligible boolean DEFAULT true NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  invoice_number text
);

CREATE TABLE public.sales_log_backup_20260616 (
  id uuid,
  sale_date date,
  item_code text,
  item_amount numeric,
  client_name text,
  closer text,
  processor text,
  coordinator text,
  support text,
  verifier text,
  status text,
  channel text,
  source text,
  opened_in_chat boolean,
  closed_in_chat boolean,
  eligible boolean,
  notes text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);

CREATE TABLE public.schedule_audit_log (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  account_id uuid NOT NULL,
  schedule_id uuid NOT NULL,
  admin_user_id uuid,
  action text NOT NULL,
  field_changed text,
  old_value text,
  new_value text,
  reason text NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.service_jobs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  date_received date DEFAULT CURRENT_DATE NOT NULL,
  invoice_number text,
  account_type text NOT NULL,
  customer_id uuid NOT NULL,
  service_description text NOT NULL,
  service_fee numeric(12,2) DEFAULT 0 NOT NULL,
  service_type service_type NOT NULL,
  service_status service_status DEFAULT 'Process'::service_status NOT NULL,
  notes text,
  estimated_completion date,
  date_completed date,
  updated_by text,
  created_by_user_id uuid,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.staff_notification_reads (
  notification_id uuid NOT NULL,
  user_id uuid NOT NULL,
  read_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.staff_notifications (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  account_id uuid,
  customer_id uuid,
  invoice_number text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.suppressed_emails (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  email text NOT NULL,
  reason text NOT NULL,
  metadata jsonb,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.system_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  description text,
  updated_by_user_id uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.timesheet_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  work_date date NOT NULL,
  am_in timestamp with time zone,
  am_out timestamp with time zone,
  pm_in timestamp with time zone,
  pm_out timestamp with time zone,
  note text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.timesheet_monthly_history (
  month_key text NOT NULL,
  csr_net numeric DEFAULT 0 NOT NULL,
  liveadmin_net numeric DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.timesheet_profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  template_type text NOT NULL,
  job_title text,
  timezone text DEFAULT 'Asia/Manila'::text NOT NULL,
  work_days smallint[] DEFAULT '{1,2,3,4,5,6}'::smallint[] NOT NULL,
  shift_start time without time zone,
  shift_end time without time zone,
  basic_salary numeric,
  allowance numeric,
  half_day_rate numeric,
  full_day_rate numeric,
  full_day_threshold_hours numeric,
  dayoff_divisor integer DEFAULT 4 NOT NULL,
  active boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  can_view_all boolean DEFAULT false NOT NULL
);

CREATE TABLE public.trade_ins (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  date_trade date DEFAULT CURRENT_DATE NOT NULL,
  customer_id uuid NOT NULL,
  old_invoice_number text NOT NULL,
  new_invoice_number text,
  item_code text NOT NULL,
  item_description text NOT NULL,
  trade_amount numeric(12,2) DEFAULT 0 NOT NULL,
  resale_amount numeric(12,2),
  resale_status resale_status DEFAULT 'In stock'::resale_status NOT NULL,
  notes text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_permission_overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  permission_key text NOT NULL,
  granted boolean NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.user_roles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  role app_role NOT NULL
);

-- ---------------------------------------------------------------------------
-- Constraints: primary keys, unique, check (FKs emitted after all tables)
-- ---------------------------------------------------------------------------
ALTER TABLE public.account_notes ADD CONSTRAINT account_notes_note_text_check CHECK (char_length(note_text) <= 1000);
ALTER TABLE public.account_notes ADD CONSTRAINT account_notes_pkey PRIMARY KEY (id);
ALTER TABLE public.account_services ADD CONSTRAINT account_services_pkey PRIMARY KEY (id);
ALTER TABLE public.announcements ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_total_amount_check CHECK (total_amount > 0::numeric);
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_total_paid_check CHECK (total_paid >= 0::numeric);
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_pkey PRIMARY KEY (id);
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_invoice_number_key UNIQUE (invoice_number);
ALTER TABLE public.cash_payments ADD CONSTRAINT cash_payments_amount_paid_check CHECK (amount_paid > 0::numeric);
ALTER TABLE public.cash_payments ADD CONSTRAINT cash_payments_pkey PRIMARY KEY (id);
ALTER TABLE public.commission_agents ADD CONSTRAINT commission_agents_pkey PRIMARY KEY (id);
ALTER TABLE public.commission_agents ADD CONSTRAINT commission_agents_name_key UNIQUE (name);
ALTER TABLE public.commission_splits ADD CONSTRAINT commission_splits_pkey PRIMARY KEY (month);
ALTER TABLE public.csr_notifications ADD CONSTRAINT csr_notifications_reminder_stage_check CHECK (reminder_stage = ANY (ARRAY['7_DAYS'::text, '3_DAYS'::text, 'DUE_TODAY'::text, 'GRACE_PERIOD'::text, 'OVERDUE'::text, 'P1'::text, 'P2'::text, 'P3'::text, 'P4'::text, 'P5'::text, 'P6'::text, 'P7'::text, 'P8'::text]));
ALTER TABLE public.csr_notifications ADD CONSTRAINT csr_notifications_pkey PRIMARY KEY (id);
ALTER TABLE public.csr_notifications ADD CONSTRAINT csr_notifications_schedule_id_reminder_stage_key UNIQUE (schedule_id, reminder_stage);
ALTER TABLE public.customer_analytics ADD CONSTRAINT customer_analytics_pkey PRIMARY KEY (id);
ALTER TABLE public.customer_analytics ADD CONSTRAINT customer_analytics_customer_id_key UNIQUE (customer_id);
ALTER TABLE public.customer_pins ADD CONSTRAINT customer_pins_pkey PRIMARY KEY (customer_id);
ALTER TABLE public.customer_portal_sessions ADD CONSTRAINT customer_portal_sessions_pkey PRIMARY KEY (session_id);
ALTER TABLE public.customer_portal_tokens ADD CONSTRAINT customer_portal_tokens_pkey PRIMARY KEY (id);
ALTER TABLE public.customer_portal_tokens ADD CONSTRAINT customer_portal_tokens_token_key UNIQUE (token);
ALTER TABLE public.customers ADD CONSTRAINT customers_pkey PRIMARY KEY (id);
ALTER TABLE public.customers ADD CONSTRAINT customers_customer_code_key UNIQUE (customer_code);
ALTER TABLE public.email_send_log ADD CONSTRAINT email_send_log_status_check CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'suppressed'::text, 'failed'::text, 'bounced'::text, 'complained'::text, 'dlq'::text]));
ALTER TABLE public.email_send_log ADD CONSTRAINT email_send_log_pkey PRIMARY KEY (id);
ALTER TABLE public.email_send_state ADD CONSTRAINT email_send_state_id_check CHECK (id = 1);
ALTER TABLE public.email_send_state ADD CONSTRAINT email_send_state_pkey PRIMARY KEY (id);
ALTER TABLE public.email_unsubscribe_tokens ADD CONSTRAINT email_unsubscribe_tokens_pkey PRIMARY KEY (id);
ALTER TABLE public.email_unsubscribe_tokens ADD CONSTRAINT email_unsubscribe_tokens_email_key UNIQUE (email);
ALTER TABLE public.email_unsubscribe_tokens ADD CONSTRAINT email_unsubscribe_tokens_token_key UNIQUE (token);
ALTER TABLE public.extension_requests ADD CONSTRAINT extension_requests_status_check CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'denied'::text]));
ALTER TABLE public.extension_requests ADD CONSTRAINT extension_requests_pkey PRIMARY KEY (id);
ALTER TABLE public.feature_toggles ADD CONSTRAINT feature_toggles_pkey PRIMARY KEY (id);
ALTER TABLE public.feature_toggles ADD CONSTRAINT feature_toggles_feature_key_key UNIQUE (feature_key);
ALTER TABLE public.final_settlement_records ADD CONSTRAINT final_settlement_records_pkey PRIMARY KEY (id);
ALTER TABLE public.final_settlement_records ADD CONSTRAINT final_settlement_records_account_id_key UNIQUE (account_id);
ALTER TABLE public.financial_alerts ADD CONSTRAINT financial_alerts_severity_check CHECK (severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]));
ALTER TABLE public.financial_alerts ADD CONSTRAINT financial_alerts_pkey PRIMARY KEY (id);
ALTER TABLE public.forecast_snapshots ADD CONSTRAINT forecast_snapshots_pkey PRIMARY KEY (id);
ALTER TABLE public.generated_invoices ADD CONSTRAINT exactly_one_parent CHECK (account_id IS NOT NULL AND cash_order_id IS NULL OR account_id IS NULL AND cash_order_id IS NOT NULL);
ALTER TABLE public.generated_invoices ADD CONSTRAINT generated_invoices_pkey PRIMARY KEY (id);
ALTER TABLE public.inquiry_dropdown_options ADD CONSTRAINT inquiry_dropdown_options_pkey PRIMARY KEY (id);
ALTER TABLE public.inquiry_dropdown_options ADD CONSTRAINT inquiry_dropdown_options_dropdown_type_value_key UNIQUE (dropdown_type, value);
ALTER TABLE public.layaway_accounts ADD CONSTRAINT layaway_accounts_payment_plan_months_check CHECK (payment_plan_months = ANY (ARRAY[3, 6, 8, 10, 12]));
ALTER TABLE public.layaway_accounts ADD CONSTRAINT layaway_accounts_total_amount_check CHECK (total_amount > 0::numeric);
ALTER TABLE public.layaway_accounts ADD CONSTRAINT layaway_accounts_total_paid_check CHECK (total_paid >= 0::numeric);
ALTER TABLE public.layaway_accounts ADD CONSTRAINT layaway_accounts_pkey PRIMARY KEY (id);
ALTER TABLE public.layaway_accounts ADD CONSTRAINT layaway_accounts_invoice_number_key UNIQUE (invoice_number);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT base_amount_positive CHECK (base_installment_amount >= 0::numeric);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT carried_amount_non_negative CHECK (carried_amount >= 0::numeric);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_base_installment_amount_check CHECK (base_installment_amount >= 0::numeric);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_installment_number_check CHECK (installment_number > 0);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_paid_amount_check CHECK (paid_amount >= 0::numeric);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_penalty_amount_check CHECK (penalty_amount >= 0::numeric);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_total_due_amount_check CHECK (total_due_amount >= 0::numeric);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT penalty_non_negative CHECK (penalty_amount >= 0::numeric);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_pkey PRIMARY KEY (id);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_account_id_installment_number_key UNIQUE (account_id, installment_number);
ALTER TABLE public.loyalty_banners ADD CONSTRAINT loyalty_banners_banner_type_check CHECK (banner_type = ANY (ARRAY['featured'::text, 'promo'::text]));
ALTER TABLE public.loyalty_banners ADD CONSTRAINT loyalty_banners_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_beta_members ADD CONSTRAINT loyalty_beta_members_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_beta_members ADD CONSTRAINT loyalty_beta_members_customer_id_key UNIQUE (customer_id);
ALTER TABLE public.loyalty_lot_consumption ADD CONSTRAINT consumption_restored_le_amount CHECK (restored_amount IS NULL OR restored_amount <= amount);
ALTER TABLE public.loyalty_lot_consumption ADD CONSTRAINT loyalty_lot_consumption_amount_check CHECK (amount > 0);
ALTER TABLE public.loyalty_lot_consumption ADD CONSTRAINT loyalty_lot_consumption_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_members ADD CONSTRAINT loyalty_members_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_members ADD CONSTRAINT loyalty_members_customer_id_key UNIQUE (customer_id);
ALTER TABLE public.loyalty_notification_recipients ADD CONSTRAINT loyalty_notification_recipients_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_notification_recipients ADD CONSTRAINT loyalty_notification_recipients_notification_id_member_id_key UNIQUE (notification_id, member_id);
ALTER TABLE public.loyalty_notifications ADD CONSTRAINT loyalty_notifications_audience_type_check CHECK (audience_type = ANY (ARRAY['all'::text, 'tier'::text, 'specific'::text]));
ALTER TABLE public.loyalty_notifications ADD CONSTRAINT loyalty_notifications_body_check CHECK (length(body) > 0 AND length(body) <= 500);
ALTER TABLE public.loyalty_notifications ADD CONSTRAINT loyalty_notifications_category_check CHECK (category = ANY (ARRAY['info'::text, 'promo'::text, 'tier'::text, 'system'::text, 'reward'::text, 'birthday'::text, 'points'::text, 'redemption'::text, 'order'::text, 'expiry'::text, 'milestone'::text]));
ALTER TABLE public.loyalty_notifications ADD CONSTRAINT loyalty_notifications_status_check CHECK (status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'cancelled'::text, 'failed'::text]));
ALTER TABLE public.loyalty_notifications ADD CONSTRAINT loyalty_notifications_title_check CHECK (length(title) > 0 AND length(title) <= 100);
ALTER TABLE public.loyalty_notifications ADD CONSTRAINT loyalty_notifications_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_point_lots ADD CONSTRAINT lot_remaining_le_original CHECK (remaining_amount <= original_amount);
ALTER TABLE public.loyalty_point_lots ADD CONSTRAINT loyalty_point_lots_original_amount_check CHECK (original_amount > 0);
ALTER TABLE public.loyalty_point_lots ADD CONSTRAINT loyalty_point_lots_remaining_amount_check CHECK (remaining_amount >= 0);
ALTER TABLE public.loyalty_point_lots ADD CONSTRAINT loyalty_point_lots_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_promos ADD CONSTRAINT chk_promo_dates CHECK (end_date >= start_date);
ALTER TABLE public.loyalty_promos ADD CONSTRAINT loyalty_promos_bonus_multiplier_check CHECK (bonus_multiplier >= 1.00);
ALTER TABLE public.loyalty_promos ADD CONSTRAINT loyalty_promos_bonus_value_check CHECK (bonus_points > 0::numeric OR bonus_multiplier > 1.00);
ALTER TABLE public.loyalty_promos ADD CONSTRAINT loyalty_promos_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_redemptions ADD CONSTRAINT loyalty_redemptions_points_redeemed_check CHECK (points_redeemed > 0::numeric);
ALTER TABLE public.loyalty_redemptions ADD CONSTRAINT loyalty_redemptions_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_rewards ADD CONSTRAINT loyalty_rewards_category_check CHECK (category = ANY (ARRAY['Redeem with Points'::text, 'Tier Exclusive'::text, 'Shipping Rewards'::text, 'Member-Only Offers'::text, 'VIP Vault'::text]));
ALTER TABLE public.loyalty_rewards ADD CONSTRAINT loyalty_rewards_tier_visibility_check CHECK (tier_visibility = ANY (ARRAY['Glimmer'::text, 'Radiant'::text, 'Elite'::text, 'Crown VIP'::text, 'All'::text]));
ALTER TABLE public.loyalty_rewards ADD CONSTRAINT loyalty_rewards_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_tiers ADD CONSTRAINT loyalty_tiers_pkey PRIMARY KEY (id);
ALTER TABLE public.loyalty_tiers ADD CONSTRAINT loyalty_tiers_name_key UNIQUE (name);
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_pkey PRIMARY KEY (id);
ALTER TABLE public.notify_loyalty_launch ADD CONSTRAINT notify_loyalty_launch_pkey PRIMARY KEY (id);
ALTER TABLE public.notify_loyalty_launch ADD CONSTRAINT notify_loyalty_launch_email_customer_id_key UNIQUE (email, customer_id);
ALTER TABLE public.payment_allocations ADD CONSTRAINT allocation_positive CHECK (allocated_amount > 0::numeric);
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_allocated_amount_check CHECK (allocated_amount > 0::numeric);
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_pkey PRIMARY KEY (id);
ALTER TABLE public.payment_allocations ADD CONSTRAINT uq_payment_allocations_schedule_payment_type UNIQUE (schedule_id, payment_id, allocation_type);
ALTER TABLE public.payment_history_backup ADD CONSTRAINT payment_history_backup_event_type_check CHECK (event_type = ANY (ARRAY['approved'::text, 'voided'::text]));
ALTER TABLE public.payment_history_backup ADD CONSTRAINT payment_history_backup_pkey PRIMARY KEY (id);
ALTER TABLE public.payment_methods ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);
ALTER TABLE public.payment_proofs ADD CONSTRAINT payment_proofs_pkey PRIMARY KEY (id);
ALTER TABLE public.payment_submission_allocations ADD CONSTRAINT payment_submission_allocations_pkey PRIMARY KEY (id);
ALTER TABLE public.payment_submissions ADD CONSTRAINT payment_submissions_pkey PRIMARY KEY (id);
ALTER TABLE public.payments ADD CONSTRAINT payment_positive CHECK (amount_paid > 0::numeric);
ALTER TABLE public.payments ADD CONSTRAINT payments_amount_paid_check CHECK (amount_paid > 0::numeric);
ALTER TABLE public.payments ADD CONSTRAINT payments_submitted_by_type_check CHECK (submitted_by_type = ANY (ARRAY['customer'::text, 'staff'::text]));
ALTER TABLE public.payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);
ALTER TABLE public.penalty_cap_overrides ADD CONSTRAINT penalty_cap_overrides_pkey PRIMARY KEY (id);
ALTER TABLE public.penalty_cap_overrides ADD CONSTRAINT penalty_cap_overrides_account_id_key UNIQUE (account_id);
ALTER TABLE public.penalty_fees ADD CONSTRAINT penalty_fees_penalty_amount_check CHECK (penalty_amount > 0::numeric);
ALTER TABLE public.penalty_fees ADD CONSTRAINT penalty_fees_pkey PRIMARY KEY (id);
ALTER TABLE public.penalty_fees ADD CONSTRAINT penalty_fees_schedule_id_penalty_stage_penalty_cycle_key UNIQUE (schedule_id, penalty_stage, penalty_cycle);
ALTER TABLE public.penalty_waiver_requests ADD CONSTRAINT penalty_waiver_requests_pkey PRIMARY KEY (id);
ALTER TABLE public.plan_configurations ADD CONSTRAINT plan_configurations_risk_tier_check CHECK (risk_tier = ANY (ARRAY['LOW'::text, 'MODERATE'::text, 'HIGH'::text, 'CRITICAL'::text]));
ALTER TABLE public.plan_configurations ADD CONSTRAINT plan_configurations_pkey PRIMARY KEY (plan_months);
ALTER TABLE public.product_inquiries ADD CONSTRAINT product_inquiries_pkey PRIMARY KEY (id);
ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE public.profiles ADD CONSTRAINT profiles_user_id_key UNIQUE (user_id);
ALTER TABLE public.promo_categories ADD CONSTRAINT promo_categories_pkey PRIMARY KEY (id);
ALTER TABLE public.promo_categories ADD CONSTRAINT promo_categories_name_key UNIQUE (name);
ALTER TABLE public.promo_category_assignments ADD CONSTRAINT promo_category_assignments_pkey PRIMARY KEY (promo_id, category_id);
ALTER TABLE public.promo_views ADD CONSTRAINT promo_views_pkey PRIMARY KEY (id);
ALTER TABLE public.promotions ADD CONSTRAINT promotions_currency_check CHECK (currency = ANY (ARRAY['PHP'::text, 'JPY'::text]));
ALTER TABLE public.promotions ADD CONSTRAINT promotions_media_type_check CHECK (media_type = ANY (ARRAY['image'::text, 'video'::text]));
ALTER TABLE public.promotions ADD CONSTRAINT promotions_pkey PRIMARY KEY (id);
ALTER TABLE public.reconciliation_log ADD CONSTRAINT reconciliation_log_pkey PRIMARY KEY (id);
ALTER TABLE public.reminder_logs ADD CONSTRAINT reminder_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_role_permission_key_key UNIQUE (role, permission_key);
ALTER TABLE public.sales_log ADD CONSTRAINT sales_log_pkey PRIMARY KEY (id);
ALTER TABLE public.schedule_audit_log ADD CONSTRAINT schedule_audit_log_pkey PRIMARY KEY (id);
ALTER TABLE public.service_jobs ADD CONSTRAINT service_jobs_account_type_check CHECK (account_type = ANY (ARRAY['layaway'::text, 'cash_order'::text]));
ALTER TABLE public.service_jobs ADD CONSTRAINT service_jobs_pkey PRIMARY KEY (id);
ALTER TABLE public.staff_notification_reads ADD CONSTRAINT staff_notification_reads_pkey PRIMARY KEY (notification_id, user_id);
ALTER TABLE public.staff_notifications ADD CONSTRAINT staff_notifications_pkey PRIMARY KEY (id);
ALTER TABLE public.suppressed_emails ADD CONSTRAINT suppressed_emails_reason_check CHECK (reason = ANY (ARRAY['unsubscribe'::text, 'bounce'::text, 'complaint'::text]));
ALTER TABLE public.suppressed_emails ADD CONSTRAINT suppressed_emails_pkey PRIMARY KEY (id);
ALTER TABLE public.suppressed_emails ADD CONSTRAINT suppressed_emails_email_key UNIQUE (email);
ALTER TABLE public.system_settings ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);
ALTER TABLE public.system_settings ADD CONSTRAINT system_settings_key_key UNIQUE (key);
ALTER TABLE public.timesheet_entries ADD CONSTRAINT timesheet_entries_pkey PRIMARY KEY (id);
ALTER TABLE public.timesheet_entries ADD CONSTRAINT timesheet_entries_user_id_work_date_key UNIQUE (user_id, work_date);
ALTER TABLE public.timesheet_monthly_history ADD CONSTRAINT timesheet_monthly_history_pkey PRIMARY KEY (month_key);
ALTER TABLE public.timesheet_profiles ADD CONSTRAINT timesheet_profiles_template_type_check CHECK (template_type = ANY (ARRAY['live_admin'::text, 'csr'::text]));
ALTER TABLE public.timesheet_profiles ADD CONSTRAINT timesheet_profiles_pkey PRIMARY KEY (id);
ALTER TABLE public.timesheet_profiles ADD CONSTRAINT timesheet_profiles_user_id_key UNIQUE (user_id);
ALTER TABLE public.trade_ins ADD CONSTRAINT trade_ins_pkey PRIMARY KEY (id);
ALTER TABLE public.user_permission_overrides ADD CONSTRAINT user_permission_overrides_pkey PRIMARY KEY (id);
ALTER TABLE public.user_permission_overrides ADD CONSTRAINT user_permission_overrides_user_id_permission_key_key UNIQUE (user_id, permission_key);
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role);

-- ---------------------------------------------------------------------------
-- Functions (RPCs + trigger functions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._award_birthday_reward(p_customer_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year      smallint := EXTRACT(YEAR  FROM (now() AT TIME ZONE 'Asia/Manila'))::smallint;
  v_month     int      := EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Manila'))::int;
  v_member_id uuid;
  v_tier_id   uuid;
  v_tier_name text;
  v_bonus     integer;
  v_guarded   int;
BEGIN
  -- Atomic guard: stamp the year ONLY if it's the birth month and not already claimed this year.
  UPDATE public.customers c
  SET last_birthday_award_year = v_year
  WHERE c.id = p_customer_id
    AND c.birthday IS NOT NULL
    AND EXTRACT(MONTH FROM c.birthday) = v_month
    AND c.last_birthday_award_year IS DISTINCT FROM v_year;
  GET DIAGNOSTICS v_guarded = ROW_COUNT;

  IF v_guarded = 0 THEN
    RAISE EXCEPTION 'Birthday reward not available: no birthday set, not your birthday month, or already claimed this year';
  END IF;

  SELECT lm.id, lm.current_tier_id INTO v_member_id, v_tier_id
  FROM public.loyalty_members lm WHERE lm.customer_id = p_customer_id;

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'No loyalty member record for this customer';
  END IF;

  SELECT lt.birthday_bonus_points, lt.name INTO v_bonus, v_tier_name
  FROM public.loyalty_tiers lt WHERE lt.id = v_tier_id;

  IF v_bonus IS NULL OR v_bonus <= 0 THEN
    RAISE EXCEPTION 'No birthday bonus configured for this tier';
  END IF;

  UPDATE public.loyalty_members lm
  SET remaining_points    = lm.remaining_points    + v_bonus,
      total_points_earned = lm.total_points_earned + v_bonus
  WHERE lm.id = v_member_id;

  INSERT INTO public.loyalty_transactions
    (member_id, transaction_type, points_amount, tier_at_time, notes)
  VALUES
    (v_member_id, 'birthday_bonus'::loyalty_transaction_type, v_bonus, v_tier_name,
     'Birthday bonus ' || v_year::text);

  RETURN jsonb_build_object('success', true, 'points_awarded', v_bonus, 'tier', v_tier_name, 'year', v_year);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_correct_birthday(p_customer_id uuid, p_birthday date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_used smallint;
  v_locked timestamptz;
BEGIN
  IF NOT (has_role(auth.uid(), 'admin') OR has_role(auth.uid(), 'staff')) THEN
    RAISE EXCEPTION 'Not authorized to correct birthdays';
  END IF;
  IF p_birthday IS NULL THEN
    RAISE EXCEPTION 'Birthday is required';
  END IF;

  SELECT c.birthday_locked_at, COALESCE(c.birthday_admin_edits_used, 0)
    INTO v_locked, v_used
  FROM customers c WHERE c.id = p_customer_id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found'; END IF;
  IF v_locked IS NULL THEN RAISE EXCEPTION 'Birthday is not set yet — nothing to correct'; END IF;
  IF v_used >= 1 THEN RAISE EXCEPTION 'Birthday correction limit (1) reached'; END IF;

  UPDATE customers
     SET birthday = p_birthday, birthday_admin_edits_used = v_used + 1
   WHERE id = p_customer_id;

  RETURN jsonb_build_object('success', true, 'birthday', p_birthday, 'edits_used', v_used + 1);
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_keep_allocation_override(p_allocation_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.bypass_allocation_ceiling', 'on', true);
  UPDATE payment_allocations
  SET allocated_amount = p_amount
  WHERE id = p_allocation_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_renumber_installment(p_schedule_id uuid, p_new_number integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.bypass_immutable_schedule_cols', 'on', true);
  UPDATE layaway_schedule
  SET installment_number = p_new_number
  WHERE id = p_schedule_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_schedule_base(p_schedule_id uuid, p_new_base numeric, p_new_total_due numeric, p_is_paid boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM set_config('app.bypass_immutable_schedule_cols', 'on', true);
  UPDATE layaway_schedule
  SET
    base_installment_amount = p_new_base,
    total_due_amount        = p_new_total_due,
    paid_amount             = CASE WHEN p_is_paid THEN p_new_total_due
                                   ELSE paid_amount END
  WHERE id = p_schedule_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.allocate_payment_atomic(p_account_id uuid, p_amount_paid numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_remarks text, p_user_id uuid, p_currency text, p_is_downpayment boolean DEFAULT false, p_submitted_by_type text DEFAULT 'staff'::text, p_submitted_by_name text DEFAULT NULL::text, p_preview boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Verbatim translation of review-payment-submission allocatePaymentToAccount
-- (the SINGLE live payment-write path per CLAUDE.md §1299 / Bug #219).
-- Row-scoped waterfall (STEP A–D), carry-over guard, Keep-credit ceiling,
-- INVARIANTS 1–4, 8, 11. All writes in ONE transaction (LOCKED RULE §1729).
DECLARE
  v_remaining     numeric := round(p_amount_paid, 2);
  v_allocations   jsonb := '[]'::jsonb;
  v_pen_updates   jsonb := '[]'::jsonb;
  v_sched_updates jsonb := '[]'::jsonb;
  rec             record;
  pen             record;
  v_next_carried  numeric;
  v_row_pen       numeric;
  v_to_pay        numeric;
  v_already       numeric;
  v_natural       numeric;
  v_ceiling       numeric;
  v_due           numeric;
  v_apply         numeric;
  v_new_paid      numeric;
  v_fully         boolean;
  v_paid_amt      numeric;
  v_row_status    text;
  v_payment_id    uuid := NULL;
  v_total_paid    numeric;
  v_pen_active    numeric;
  v_total_amount  numeric;
  v_cur_status    text;
  v_new_remaining numeric;
  v_new_status    text;
  v_has_overdue   boolean;
  elem            jsonb;
  merged          record;
BEGIN
  IF p_account_id IS NULL OR p_amount_paid IS NULL OR p_amount_paid <= 0 THEN
    RAISE EXCEPTION 'invalid_input: account_id and positive amount required';
  END IF;

  -- ── Waterfall (skipped entirely for DP per INVARIANT 11) ──
  IF NOT p_is_downpayment THEN
    FOR rec IN
      SELECT * FROM layaway_schedule
      WHERE account_id = p_account_id
        AND status NOT IN ('paid','cancelled')
      ORDER BY installment_number ASC
    LOOP
      EXIT WHEN v_remaining <= 0;

      -- Carry-over guard: if NEXT row already holds carried_amount, this row
      -- was administratively closed via carry-over — skip it.
      SELECT carried_amount INTO v_next_carried
      FROM layaway_schedule
      WHERE account_id = p_account_id
        AND installment_number = rec.installment_number + 1;
      IF coalesce(v_next_carried, 0) > 0.005 THEN
        CONTINUE;
      END IF;

      -- STEP A — this row's unpaid penalties only (penalty_date ASC)
      v_row_pen := 0;
      FOR pen IN
        SELECT id, penalty_amount FROM penalty_fees
        WHERE account_id = p_account_id
          AND status = 'unpaid'
          AND schedule_id = rec.id
        ORDER BY penalty_date ASC
      LOOP
        EXIT WHEN v_remaining <= 0;
        v_to_pay    := round(least(v_remaining, pen.penalty_amount), 2);
        v_remaining := v_remaining - v_to_pay;
        v_row_pen   := v_row_pen + v_to_pay;
        v_allocations := v_allocations || jsonb_build_object(
          'schedule_id', rec.id, 'allocation_type', 'penalty',
          'allocated_amount', v_to_pay);
        v_pen_updates := v_pen_updates || jsonb_build_object(
          'id', pen.id,
          'status', CASE WHEN v_to_pay >= pen.penalty_amount THEN 'paid' ELSE 'unpaid' END);
      END LOOP;

      EXIT WHEN v_remaining <= 0;

      -- STEP B — this row's base installment.
      -- alreadyAllocated = ALL non-voided allocations against this row
      -- (both types — matches review implementation verbatim; INVARIANT 2).
      SELECT coalesce(sum(pa.allocated_amount), 0) INTO v_already
      FROM payment_allocations pa
      JOIN payments p ON p.id = pa.payment_id
      WHERE pa.schedule_id = rec.id AND p.voided_at IS NULL;

      v_natural := rec.base_installment_amount
                 + coalesce(rec.penalty_amount, 0)
                 + coalesce(rec.carried_amount, 0);
      -- Keep-credit ceiling: JS falsy check `item.total_due_amount ?`
      v_ceiling := CASE WHEN rec.total_due_amount IS NOT NULL AND rec.total_due_amount <> 0
                        THEN least(v_natural, rec.total_due_amount)
                        ELSE v_natural END;
      v_due := greatest(0, v_ceiling - v_already - v_row_pen);
      IF v_due <= 0 THEN CONTINUE; END IF;

      v_apply    := round(least(v_remaining, v_due), 2);
      v_new_paid := v_already + v_apply;
      v_fully    := (v_new_paid + v_row_pen >= v_ceiling - 0.005);

      -- STEP C — INVARIANT 7/8 respected: never touches paid rows, never
      -- writes base_installment_amount, never inflates total_due_amount.
      IF v_fully AND rec.status = 'partially_paid' THEN
        v_paid_amt := v_ceiling; v_row_status := 'paid';       -- top-up capped at ceiling
      ELSIF v_fully THEN
        v_paid_amt := v_new_paid; v_row_status := 'paid';
      ELSE
        v_paid_amt := v_new_paid; v_row_status := 'partially_paid';
      END IF;
      v_allocations := v_allocations || jsonb_build_object(
        'schedule_id', rec.id, 'allocation_type', 'installment',
        'allocated_amount', v_apply);
      v_sched_updates := v_sched_updates || jsonb_build_object(
        'id', rec.id, 'paid_amount', v_paid_amt, 'status', v_row_status);

      v_remaining := v_remaining - v_apply;
      EXIT WHEN v_remaining <= 0;   -- STEP D
    END LOOP;
  END IF;

  -- ── Merge penalty allocations per schedule_id (unique-constraint safety) ──
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_allocations
  FROM (
    SELECT jsonb_build_object(
             'schedule_id', a->>'schedule_id',
             'allocation_type', 'penalty',
             'allocated_amount', sum((a->>'allocated_amount')::numeric)) AS x
    FROM jsonb_array_elements(v_allocations) a
    WHERE a->>'allocation_type' = 'penalty'
    GROUP BY a->>'schedule_id'
    UNION ALL
    SELECT a FROM jsonb_array_elements(v_allocations) a
    WHERE a->>'allocation_type' = 'installment'
  ) m;

  -- ── Derived totals (INVARIANT 1: SUM of non-voided payments) ──
  SELECT coalesce(sum(amount_paid), 0) INTO v_total_paid
  FROM payments WHERE account_id = p_account_id AND voided_at IS NULL;
  SELECT coalesce(sum(penalty_amount), 0) INTO v_pen_active
  FROM penalty_fees WHERE account_id = p_account_id AND status <> 'waived';
  SELECT total_amount, status::text INTO v_total_amount, v_cur_status
  FROM layaway_accounts WHERE id = p_account_id;
  IF v_total_amount IS NULL THEN
    RAISE EXCEPTION 'account_not_found: %', p_account_id;
  END IF;

  -- ── PREVIEW MODE: return the plan, write NOTHING ──
  IF p_preview THEN
    v_total_paid    := v_total_paid + round(p_amount_paid, 2);
    v_new_remaining := greatest(0, round(v_total_amount + v_pen_active - v_total_paid, 2));
    -- Verbatim record-payment preview semantics: completed-or-current-status.
    v_new_status := CASE WHEN v_new_remaining <= 0 THEN 'completed' ELSE v_cur_status END;
    RETURN jsonb_build_object(
      'preview', true, 'payment_id', NULL,
      'allocations', v_allocations,
      'penalty_updates', v_pen_updates,
      'schedule_updates', v_sched_updates,
      'new_total_paid', v_total_paid,
      'new_remaining_balance', v_new_remaining,
      'new_status', v_new_status);
  END IF;

  -- ── WRITE MODE: all writes below commit or roll back together ──
  INSERT INTO payments (
    account_id, amount_paid, currency, date_paid, payment_method,
    reference_number, remarks, entered_by_user_id,
    submitted_by_type, submitted_by_name
  ) VALUES (
    p_account_id, p_amount_paid, p_currency::account_currency, p_payment_date,
    p_payment_method, p_reference_number, p_remarks, p_user_id,
    p_submitted_by_type, p_submitted_by_name
  ) RETURNING id INTO v_payment_id;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_allocations) LOOP
    INSERT INTO payment_allocations (payment_id, schedule_id, allocation_type, allocated_amount)
    VALUES (v_payment_id, (elem->>'schedule_id')::uuid,
            (elem->>'allocation_type')::allocation_type,
            (elem->>'allocated_amount')::numeric);
  END LOOP;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_pen_updates) LOOP
    UPDATE penalty_fees
    SET status = (elem->>'status')::penalty_fee_status
    WHERE id = (elem->>'id')::uuid;
  END LOOP;

  FOR elem IN SELECT * FROM jsonb_array_elements(v_sched_updates) LOOP
    UPDATE layaway_schedule
    SET paid_amount = (elem->>'paid_amount')::numeric,
        status      = (elem->>'status')::schedule_status
    WHERE id = (elem->>'id')::uuid;
  END LOOP;

  -- Account totals — recompute post-write (new payment row is visible in-txn)
  SELECT coalesce(sum(amount_paid), 0) INTO v_total_paid
  FROM payments WHERE account_id = p_account_id AND voided_at IS NULL;
  SELECT coalesce(sum(penalty_amount), 0) INTO v_pen_active
  FROM penalty_fees WHERE account_id = p_account_id AND status <> 'waived';
  v_new_remaining := greatest(0, round(v_total_amount + v_pen_active - v_total_paid, 2));

  v_new_status := NULL;
  IF v_new_remaining <= 0 THEN
    v_new_status := 'completed';
  ELSIF v_cur_status IN ('active','overdue') THEN
    SELECT EXISTS (
      SELECT 1 FROM layaway_schedule
      WHERE account_id = p_account_id
        AND status NOT IN ('paid','cancelled')
        AND due_date < CURRENT_DATE
    ) INTO v_has_overdue;
    v_new_status := CASE WHEN v_has_overdue THEN 'overdue' ELSE 'active' END;
  END IF;

  IF v_new_status IS NOT NULL THEN
    UPDATE layaway_accounts
    SET total_paid = v_total_paid, remaining_balance = v_new_remaining,
        status = v_new_status::account_status
    WHERE id = p_account_id;
  ELSE
    UPDATE layaway_accounts
    SET total_paid = v_total_paid, remaining_balance = v_new_remaining
    WHERE id = p_account_id;
  END IF;

  RETURN jsonb_build_object(
    'preview', false, 'payment_id', v_payment_id,
    'allocations', v_allocations,
    'penalty_updates', v_pen_updates,
    'schedule_updates', v_sched_updates,
    'new_total_paid', v_total_paid,
    'new_remaining_balance', v_new_remaining,
    'new_status', coalesce(v_new_status, v_cur_status));
END;
$function$;

CREATE OR REPLACE FUNCTION public.approve_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  m record;
  v_tier_name text;
  v_tx_id uuid;
  v_payment_id uuid;
  v_pts numeric;
  v_payment_amount numeric;
  v_currency text;
  v_total_amount numeric;
  v_new_total_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_reduce_jpy numeric;
  v_stock int;
  v_rows int;
  v_today date := CURRENT_DATE;
  v_ref text;
  v_remarks text;
  v_note text;
BEGIN
  -- 1. Lock redemption; must be pending (closes double-approve race)
  SELECT * INTO r FROM public.loyalty_redemptions WHERE id = p_redemption_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'redemption_not_found'; END IF;
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'redemption_not_pending:%', r.status; END IF;
  v_pts := r.points_redeemed;

  -- 2. Lock member; validate balance
  SELECT id, customer_id, remaining_points, total_points_redeemed, current_tier_id
    INTO m FROM public.loyalty_members WHERE id = r.member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'member_not_found'; END IF;
  IF v_pts > COALESCE(m.remaining_points, 0) THEN RAISE EXCEPTION 'insufficient_points'; END IF;
  SELECT name INTO v_tier_name FROM public.loyalty_tiers WHERE id = m.current_tier_id;

  -- 3. Redemption transaction
  INSERT INTO public.loyalty_transactions
    (member_id, transaction_type, points_amount, account_id, cash_order_id, invoice_number, tier_at_time, notes)
  VALUES
    (m.id, 'redeemed', -v_pts, r.account_id, r.cash_order_id, r.invoice_number, v_tier_name,
     'Redemption: ' || r.redemption_type)
  RETURNING id INTO v_tx_id;

  -- 4. Flip redemption
  UPDATE public.loyalty_redemptions
     SET status = 'confirmed', transaction_id = v_tx_id,
         processed_by_user_id = p_user_id, processed_at = now()
   WHERE id = r.id;

  -- 5. Debit member (relative arithmetic — closes lost-update race)
  UPDATE public.loyalty_members
     SET remaining_points = remaining_points - v_pts,
         total_points_redeemed = COALESCE(total_points_redeemed, 0) + v_pts
   WHERE id = m.id;

  -- 6. Catalog stock — depletion aborts the entire approve
  IF r.redemption_type = 'catalog_reward' AND r.reward_id IS NOT NULL THEN
    SELECT current_stock INTO v_stock FROM public.loyalty_rewards WHERE id = r.reward_id FOR UPDATE;
    IF FOUND AND v_stock IS NOT NULL THEN
      UPDATE public.loyalty_rewards SET current_stock = current_stock - 1
       WHERE id = r.reward_id AND current_stock > 0;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows = 0 THEN RAISE EXCEPTION 'reward_out_of_stock'; END IF;
    END IF;
  END IF;

  -- 7. new_order_discount: net-spend reduce + synthetic payment + totals
  IF r.redemption_type = 'new_order_discount' AND (r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL) THEN
    v_ref := 'LOYALTY-' || r.id;
    v_reduce_jpy := COALESCE(r.value_applied_jpy, 0);

    IF r.account_id IS NOT NULL THEN
      IF v_reduce_jpy > 0 THEN
        UPDATE public.layaway_accounts
           SET loyalty_jpy_amount = GREATEST(0, COALESCE(loyalty_jpy_amount, 0) - v_reduce_jpy)
         WHERE id = r.account_id;
      END IF;
      SELECT currency::text INTO v_currency FROM public.layaway_accounts WHERE id = r.account_id FOR UPDATE;
      v_payment_amount := CASE WHEN v_currency = 'PHP' THEN COALESCE(r.value_applied_php, 0)
                               ELSE COALESCE(r.value_applied_jpy, 0) END;
      IF v_payment_amount > 0 AND v_currency IS NOT NULL THEN
        v_remarks := 'Loyalty redemption: ' || v_pts || ' pts (' || r.redemption_type || ') (applied to downpayment)';
        INSERT INTO public.payments
          (account_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks,
           entered_by_user_id, submitted_by_type, submitted_by_name)
        VALUES
          (r.account_id, v_payment_amount, v_currency::account_currency, v_today, 'loyalty_redemption', v_ref, v_remarks,
           p_user_id, 'staff', COALESCE(p_user_email, 'Admin'))
        RETURNING id INTO v_payment_id;

        SELECT total_paid, remaining_balance, status::text
          INTO v_new_total_paid, v_new_remaining, v_new_status
          FROM public.layaway_accounts WHERE id = r.account_id;
        v_new_total_paid := COALESCE(v_new_total_paid, 0) + v_payment_amount;
        v_new_remaining := COALESCE(v_new_remaining, 0) - v_payment_amount;
        IF v_new_remaining <= 0.01 THEN
          v_new_status := 'completed';
        ELSIF v_new_status = 'overdue' AND NOT EXISTS (
          SELECT 1 FROM public.layaway_schedule
           WHERE account_id = r.account_id AND status = 'overdue'::schedule_status
        ) THEN
          v_new_status := 'active';
        END IF;
        UPDATE public.layaway_accounts
           SET total_paid = v_new_total_paid,
               remaining_balance = v_new_remaining,
               status = v_new_status::account_status
         WHERE id = r.account_id;
      END IF;

    ELSE
      IF v_reduce_jpy > 0 THEN
        UPDATE public.cash_orders
           SET loyalty_jpy_amount = GREATEST(0, COALESCE(loyalty_jpy_amount, 0) - v_reduce_jpy)
         WHERE id = r.cash_order_id;
      END IF;
      SELECT currency::text, total_amount INTO v_currency, v_total_amount
        FROM public.cash_orders WHERE id = r.cash_order_id FOR UPDATE;
      v_payment_amount := CASE WHEN v_currency = 'PHP' THEN COALESCE(r.value_applied_php, 0)
                               ELSE COALESCE(r.value_applied_jpy, 0) END;
      IF v_payment_amount > 0 AND v_currency IS NOT NULL THEN
        v_remarks := 'Loyalty redemption: ' || v_pts || ' pts (' || r.redemption_type || ')';
        INSERT INTO public.cash_payments
          (cash_order_id, amount_paid, currency, date_paid, payment_method, reference_number, remarks,
           entered_by_user_id, submitted_by_type, submitted_by_name)
        VALUES
          (r.cash_order_id, v_payment_amount, v_currency::account_currency, v_today, 'loyalty_redemption', v_ref, v_remarks,
           p_user_id, 'staff', COALESCE(p_user_email, 'Admin'));

        SELECT COALESCE(SUM(amount_paid), 0) INTO v_new_total_paid
          FROM public.cash_payments
         WHERE cash_order_id = r.cash_order_id AND voided_at IS NULL;
        v_new_remaining := COALESCE(v_total_amount, 0) - v_new_total_paid;
        UPDATE public.cash_orders
           SET total_paid = v_new_total_paid,
               remaining_balance = v_new_remaining,
               updated_at = now(),
               status = CASE WHEN v_new_remaining <= 0 THEN 'completed' ELSE status END,
               completed_at = CASE WHEN v_new_remaining <= 0 THEN now() ELSE completed_at END
         WHERE id = r.cash_order_id;
      END IF;
    END IF;
  END IF;

  -- 7b. Loyalty trail — account note (only when linked to an account or cash order)
  IF r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL THEN
    v_note := 'Loyalty: ' || v_pts || ' pts redeemed (' || r.redemption_type || ')';
    IF v_payment_amount IS NOT NULL AND v_payment_amount > 0 THEN
      v_note := v_note || ' — ' || CASE WHEN v_currency = 'PHP' THEN '₱' ELSE '¥' END
                || v_payment_amount || ' applied to balance';
    END IF;
    INSERT INTO public.account_notes
      (account_id, cash_order_id, note_text, created_by_user_id, created_by_name)
    VALUES
      (r.account_id, r.cash_order_id, v_note, p_user_id, 'System (Loyalty)');
  END IF;

  -- 8. Audit log
  INSERT INTO public.audit_logs
    (entity_type, entity_id, action, performed_by_user_id, old_value_json, new_value_json)
  VALUES
    ('loyalty_redemption', r.id, 'redemption_approved', p_user_id,
     jsonb_build_object('status', 'pending'),
     jsonb_build_object('status', 'confirmed', 'transaction_id', v_tx_id,
                        'points_redeemed', v_pts, 'redemption_type', r.redemption_type,
                        'invoice_number', r.invoice_number));

  RETURN jsonb_build_object(
    'transaction_id', v_tx_id,
    'payment_id', v_payment_id,
    'new_remaining_points', COALESCE(m.remaining_points, 0) - v_pts,
    'tier_name', v_tier_name,
    'account_status', v_new_status,
    'payment_amount', v_payment_amount,
    'currency', v_currency
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.audit_account(p_invoice_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account layaway_accounts%ROWTYPE;
  v_total_paid numeric;
  v_active_penalties numeric;
  v_services numeric;
  v_canonical_remaining numeric;
  v_sum_bases numeric;
  v_sum_pending numeric;
  v_dp_paid numeric;
  v_unpaid_dp numeric;
  v_sum_schedule_paid numeric;
  v_paid_penalties numeric;
  v_waterfall_absorbed numeric;
  v_effective_unpaid_dp numeric;
  v_dp_overpaid numeric;
  v_checks jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_account FROM layaway_accounts WHERE invoice_number = p_invoice_number;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Account not found');
  END IF;

  -- DP paid so far (detection: reference_number 'DP-%' or remarks ILIKE '%down%')
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_dp_paid
  FROM payments
  WHERE account_id = v_account.id AND voided_at IS NULL
    AND (reference_number LIKE 'DP-%' OR remarks ILIKE '%down%');

  -- CHANGED 2026-06-19: skip accounts with no downpayment payment yet (still onboarding)
  IF v_dp_paid = 0 THEN
    RETURN jsonb_build_object('invoice_number', p_invoice_number, 'status', v_account.status, 'all_pass', NULL, 'audit_skipped', true, 'skip_reason', 'No downpayment payment yet', 'checks', '[]'::jsonb);
  END IF;

  -- CHECK 1
  SELECT COALESCE(SUM(amount_paid), 0) INTO v_total_paid FROM payments WHERE account_id = v_account.id AND voided_at IS NULL;
  v_checks := v_checks || jsonb_build_object('label', 'total_paid matches payments table', 'expected', v_total_paid, 'stored', v_account.total_paid, 'pass', ABS(v_total_paid - v_account.total_paid) < 1);

  -- CHECK 2
  SELECT COALESCE(SUM(pf.penalty_amount), 0) INTO v_active_penalties FROM penalty_fees pf WHERE pf.account_id = v_account.id AND pf.status != 'waived';
  SELECT COALESCE(SUM(amount), 0) INTO v_services FROM account_services WHERE account_id = v_account.id;
  v_canonical_remaining := v_account.total_amount + v_active_penalties - v_total_paid;
  v_checks := v_checks || jsonb_build_object('label', 'remaining_balance matches canonical formula', 'expected', v_canonical_remaining, 'stored', v_account.remaining_balance, 'pass', ABS(v_canonical_remaining - v_account.remaining_balance) < 1);

  -- CHECK 3
  SELECT COALESCE(SUM(ls.base_installment_amount), 0) INTO v_sum_bases FROM layaway_schedule ls WHERE ls.account_id = v_account.id AND ls.status != 'cancelled';
  v_checks := v_checks || jsonb_build_object('label', 'total_amount matches DP + sum of bases + services', 'expected', v_account.downpayment_amount + v_sum_bases + v_services, 'stored', v_account.total_amount, 'pass', ABS(v_account.total_amount - (v_account.downpayment_amount + v_sum_bases + v_services)) < 2);

  -- CHECK 4
  v_checks := v_checks || jsonb_build_object('label', 'no duplicate allocations', 'pass', NOT EXISTS (
    SELECT 1 FROM payments p JOIN payment_allocations pa ON pa.payment_id = p.id
    WHERE p.account_id = v_account.id AND p.voided_at IS NULL
    GROUP BY p.id, p.amount_paid HAVING COUNT(pa.id) > 1 AND SUM(pa.allocated_amount) > p.amount_paid + 1));

  -- CHECK 5
  v_checks := v_checks || jsonb_build_object('label', 'no orphaned allocations from voided payments', 'pass', NOT EXISTS (
    SELECT 1 FROM payment_allocations pa
    JOIN payments p ON p.id = pa.payment_id
    JOIN layaway_schedule ls ON ls.id = pa.schedule_id
    WHERE ls.account_id = v_account.id AND p.voided_at IS NOT NULL));

  -- CHECK 6
  v_checks := v_checks || jsonb_build_object('label', 'no schedule rows with paid_amount but no allocations', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = v_account.id AND ls.status != 'cancelled' AND ls.paid_amount > 0
    AND NOT EXISTS (SELECT 1 FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.schedule_id = ls.id AND p.voided_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM layaway_schedule dest WHERE dest.carried_from_schedule_id = ls.id AND dest.carried_amount > 0)));

  -- CHECK 7
  v_checks := v_checks || jsonb_build_object('label', 'schedule status consistent with allocations', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    LEFT JOIN (
      SELECT pa.schedule_id, SUM(pa.allocated_amount) AS total_allocated
      FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
      WHERE p.voided_at IS NULL GROUP BY pa.schedule_id
    ) alloc ON alloc.schedule_id = ls.id
    WHERE ls.account_id = v_account.id AND ls.status != 'cancelled'
    AND (
      (ls.status = 'paid' AND COALESCE(alloc.total_allocated,0) < (ls.total_due_amount - 1) AND NOT EXISTS (SELECT 1 FROM layaway_schedule dest WHERE dest.carried_from_schedule_id = ls.id AND dest.carried_amount > 0))
      OR (ls.status != 'paid' AND COALESCE(alloc.total_allocated,0) >= (ls.total_due_amount - 0.01) AND NOT (ls.total_due_amount = 0 AND COALESCE(ls.base_installment_amount,0) = 0 AND ls.installment_number > v_account.payment_plan_months))
    )));

  -- CHECK 8
  v_checks := v_checks || jsonb_build_object('label', 'schedule penalty_amount matches penalty_fees sum', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = v_account.id AND ls.status != 'cancelled'
    AND ABS(COALESCE(ls.penalty_amount,0) - COALESCE((SELECT SUM(pf.penalty_amount) FROM penalty_fees pf WHERE pf.schedule_id = ls.id AND pf.status != 'waived'),0)) > 0.01));

  -- CHECK 9
  v_checks := v_checks || jsonb_build_object('label', 'carried_amount consistent with source row shortfall', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    JOIN layaway_schedule src ON src.id = ls.carried_from_schedule_id
    WHERE ls.account_id = v_account.id AND ls.carried_amount > 0
    AND ABS(ls.carried_amount - (src.base_installment_amount + COALESCE(src.penalty_amount,0) + COALESCE(src.carried_amount,0) - src.paid_amount)) > 0.01));

  -- CHECK 10
  v_checks := v_checks || jsonb_build_object('label', 'no carry-over from unpaid source row', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    JOIN layaway_schedule src ON src.id = ls.carried_from_schedule_id
    WHERE ls.account_id = v_account.id AND ls.carried_amount > 0 AND src.paid_amount = 0));

  -- CHECK 11
  v_checks := v_checks || jsonb_build_object('label', 'no orphaned carried_amount without source reference', 'pass', NOT EXISTS (
    SELECT 1 FROM layaway_schedule ls
    WHERE ls.account_id = v_account.id AND ls.carried_amount > 0 AND ls.carried_from_schedule_id IS NULL AND ls.status != 'cancelled'));

  -- CHECK 12 (v2 — 2026-05-29): handles unpaid DP, partial overdue rows, and waterfall absorption
  SELECT COALESCE(SUM(
    CASE WHEN ls.status = 'partially_paid' THEN
      ls.total_due_amount - COALESCE((SELECT SUM(pa.allocated_amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.schedule_id = ls.id AND p.voided_at IS NULL), 0)
    ELSE
      GREATEST(0, ls.total_due_amount - COALESCE((SELECT SUM(pa.allocated_amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.schedule_id = ls.id AND p.voided_at IS NULL), 0))
    END
  ), 0) INTO v_sum_pending
  FROM layaway_schedule ls
  WHERE ls.account_id = v_account.id AND ls.status IN ('pending','overdue','partially_paid');

  v_unpaid_dp := GREATEST(0, v_account.downpayment_amount - v_dp_paid);
  SELECT COALESCE(SUM(paid_amount), 0) INTO v_sum_schedule_paid FROM layaway_schedule WHERE account_id = v_account.id AND status != 'cancelled';
  SELECT COALESCE(SUM(penalty_amount), 0) INTO v_paid_penalties FROM penalty_fees WHERE account_id = v_account.id AND status = 'paid';
  v_waterfall_absorbed := GREATEST(0, v_total_paid - v_dp_paid - v_sum_schedule_paid - v_paid_penalties);
  v_effective_unpaid_dp := GREATEST(0, v_unpaid_dp - v_waterfall_absorbed);
  v_sum_pending := v_sum_pending + v_effective_unpaid_dp;

  -- DP overage (2026-06-19): mirror of unpaid-DP for the overpaid direction.
  v_dp_overpaid := GREATEST(0, v_dp_paid - v_account.downpayment_amount);
  v_sum_pending := v_sum_pending - v_dp_overpaid;

  v_checks := v_checks || jsonb_build_object('label', 'sum of pending months matches remaining balance', 'expected', v_canonical_remaining, 'stored', v_sum_pending, 'pass', ABS(v_sum_pending - v_canonical_remaining) < 2);

  RETURN jsonb_build_object('invoice_number', p_invoice_number, 'status', v_account.status, 'all_pass', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_checks) c WHERE (c->>'pass')::boolean = false), 'audit_skipped', false, 'checks', v_checks);
END;
$function$;

CREATE OR REPLACE FUNCTION public.audit_all_accounts()
 RETURNS TABLE(invoice_number text, status text, all_pass boolean, failed_checks text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account RECORD;
  v_result JSONB;
  v_failed_checks text[];
  v_all_pass boolean;
  v_audit_skipped boolean;
BEGIN
  FOR v_account IN
    SELECT la.invoice_number
    FROM layaway_accounts la
    WHERE la.status NOT IN ('forfeited', 'final_forfeited', 'cancelled', 'completed')
    ORDER BY la.invoice_number
  LOOP
    SELECT audit_account(v_account.invoice_number) INTO v_result;

    v_audit_skipped := COALESCE((v_result->>'audit_skipped')::boolean, false);

    -- Skip rows where audit was not applicable
    IF v_audit_skipped THEN
      CONTINUE;
    END IF;

    v_all_pass := (v_result->>'all_pass')::boolean;

    SELECT ARRAY_AGG(c->>'label')
    INTO v_failed_checks
    FROM jsonb_array_elements(v_result->'checks') c
    WHERE (c->>'pass')::boolean = false;

    RETURN QUERY SELECT
      v_result->>'invoice_number',
      v_result->>'status',
      v_all_pass,
      COALESCE(v_failed_checks, ARRAY[]::text[]);
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.audit_delete_cleanup_invariants()
 RETURNS TABLE(delete_function text, parent_table text, child_table text, fk_name text, on_delete text, in_allowlist boolean, finding_type text, severity text, message text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH allowlist (delete_function, parent_table, child_table, defensive, pre_check_protected) AS (
    VALUES
      ('delete-account', 'layaway_accounts', 'payment_submission_allocations', false, false),
      ('delete-account', 'layaway_accounts', 'payment_submissions', false, false),
      ('delete-account', 'layaway_accounts', 'penalty_waiver_requests', true, false),
      ('delete-account', 'layaway_accounts', 'penalty_fees', true, false),
      ('delete-account', 'layaway_accounts', 'csr_notifications', true, false),
      ('delete-account', 'layaway_accounts', 'extension_requests', false, false),
      ('delete-account', 'layaway_accounts', 'reminder_logs', true, false),
      ('delete-account', 'layaway_accounts', 'reconciliation_log', false, false),
      ('delete-account', 'layaway_accounts', 'account_services', true, false),
      ('delete-account', 'layaway_accounts', 'final_settlement_records', false, false),
      ('delete-account', 'layaway_accounts', 'penalty_cap_overrides', true, false),
      ('delete-account', 'layaway_accounts', 'payments', false, false),
      ('delete-account', 'layaway_accounts', 'layaway_schedule', true, false),
      ('delete-account', 'layaway_accounts', 'generated_invoices', true, false),
      ('delete-customer', 'customers', 'customer_analytics', true, false),
      ('delete-customer', 'customers', 'layaway_accounts', false, true),
      ('delete-customer', 'customers', 'cash_orders', false, true),
      ('delete-customer', 'customers', 'extension_requests', false, false),
      ('delete-customer', 'customers', 'payment_submissions', false, false),
      ('delete-customer', 'customers', 'service_jobs', false, false),
      ('delete-customer', 'customers', 'trade_ins', false, false),
      ('(none - soft-cancel only)', 'cash_orders', 'cash_payments', false, false),
      ('(none - soft-cancel only)', 'cash_orders', 'generated_invoices', false, false),
      ('(none - soft-cancel only)', 'cash_orders', 'payment_proofs', false, false)
  ),
  parents (parent_table, delete_function) AS (
    VALUES
      ('layaway_accounts', 'delete-account'),
      ('customers', 'delete-customer'),
      ('cash_orders', '(none - soft-cancel only)')
  ),
  fks AS (
    SELECT p.parent_table, p.delete_function,
      regexp_replace(c.conrelid::regclass::text, '^public\.', '') AS child_table,
      c.conname AS fk_name,
      CASE c.confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' END AS on_delete
    FROM pg_constraint c
    JOIN parents p ON c.confrelid = ('public.' || p.parent_table)::regclass
    WHERE c.contype = 'f' AND c.confdeltype IN ('a','r')
  ),
  missing AS (
    SELECT f.delete_function, f.parent_table, f.child_table, f.fk_name, f.on_delete,
      false AS in_allowlist,
      CASE WHEN f.parent_table = 'cash_orders' THEN 'preventive_no_delete_fn' ELSE 'missing_cleanup' END AS finding_type,
      CASE WHEN f.parent_table = 'cash_orders' THEN 'info' ELSE 'critical' END AS severity,
      format('%s blocks DELETE on %s but is not in the %s cleanup list. Add an explicit DELETE in the edge function.',
        f.fk_name, f.parent_table, f.delete_function) AS message
    FROM fks f
    WHERE NOT EXISTS (
      SELECT 1 FROM allowlist a
      WHERE a.parent_table = f.parent_table AND a.child_table = f.child_table
    )
  ),
  stale AS (
    SELECT a.delete_function, a.parent_table, a.child_table,
      NULL::text AS fk_name, NULL::text AS on_delete,
      true AS in_allowlist,
      'stale_allowlist_entry' AS finding_type,
      'warning' AS severity,
      format('Allowlist tracks %s.%s for %s but no NO ACTION/RESTRICT FK to %s exists. The FK may have been changed to CASCADE/SET NULL, or the table was dropped.',
        a.parent_table, a.child_table, a.delete_function, a.parent_table) AS message
    FROM allowlist a
    WHERE a.defensive = false AND a.pre_check_protected = false
      AND NOT EXISTS (
        SELECT 1 FROM fks f
        WHERE f.parent_table = a.parent_table AND f.child_table = a.child_table
      )
  )
  SELECT * FROM missing
  UNION ALL
  SELECT * FROM stale
  ORDER BY severity DESC, parent_table, child_table;
$function$;

CREATE OR REPLACE FUNCTION public.auto_backup_payment()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice_number text;
  v_customer_name  text;
BEGIN
  SELECT
    la.invoice_number,
    c.full_name
  INTO v_invoice_number, v_customer_name
  FROM layaway_accounts la
  LEFT JOIN customers c ON c.id = la.customer_id
  WHERE la.id = NEW.account_id;

  IF TG_OP = 'INSERT' THEN
    INSERT INTO payment_history_backup (
      payment_id, account_id, invoice_number, customer_name,
      amount, currency, payment_date, payment_method,
      submission_type, notes, status, approved_by,
      approved_at, event_type
    ) VALUES (
      NEW.id, NEW.account_id, v_invoice_number, v_customer_name,
      NEW.amount_paid, NEW.currency::text, NEW.date_paid, NEW.payment_method,
      NEW.submitted_by_type, NEW.remarks, 'confirmed', NEW.entered_by_user_id,
      NEW.created_at, 'approved'
    );
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL THEN
    INSERT INTO payment_history_backup (
      payment_id, account_id, invoice_number, customer_name,
      amount, currency, payment_date, payment_method,
      submission_type, notes, status, voided_by,
      voided_at, void_reason, event_type
    ) VALUES (
      NEW.id, NEW.account_id, v_invoice_number, v_customer_name,
      NEW.amount_paid, NEW.currency::text, NEW.date_paid, NEW.payment_method,
      NEW.submitted_by_type, NEW.remarks, 'voided', NEW.voided_by_user_id,
      NEW.voided_at, NEW.void_reason, 'voided'
    );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.autocheck_sales_log_eligible()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status = 'Paid'
     AND NEW.channel != 'Live'
     AND NEW.source NOT IN ('Live Post', 'Online Store', 'Other')
  THEN
    IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'Paid' THEN
      -- non-Paid → Paid: requalify, overriding the false the UI stamped while pending
      NEW.eligible := true;
    ELSIF TG_OP = 'INSERT' AND NEW.eligible IS DISTINCT FROM false THEN
      -- creation: honor an explicit opt-out, else default true
      NEW.eligible := true;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.autofill_sales_log_support_verifier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.sales_log sl
  SET
    support  = COALESCE(sl.support,  ca.name),
    verifier = COALESCE(sl.verifier, ca.name)
  FROM public.commission_agents ca
  WHERE sl.invoice_number = NEW.invoice_number
    AND ca.user_id        = NEW.created_by_user_id
    AND ca.active         = true;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_allocation_ceiling()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_base numeric;
  v_penalty numeric;
  v_carried numeric;
  v_total_due numeric;
  v_ceiling numeric;
  v_total numeric;
BEGIN
  IF current_setting('app.bypass_allocation_ceiling', true) = 'on' THEN
    RETURN NEW;
  END IF;

  SELECT 
    COALESCE(base_installment_amount, 0),
    COALESCE(penalty_amount, 0),
    COALESCE(carried_amount, 0),
    COALESCE(total_due_amount, base_installment_amount)
  INTO v_base, v_penalty, v_carried, v_total_due
  FROM layaway_schedule
  WHERE id = NEW.schedule_id;

  -- Use LEAST so Keep credit is respected
  v_ceiling := LEAST(
    v_base + v_penalty + v_carried,
    v_total_due
  );

  SELECT COALESCE(SUM(allocated_amount), 0)
  INTO v_total
  FROM payment_allocations
  WHERE schedule_id = NEW.schedule_id
    AND id != NEW.id;

  v_total := v_total + NEW.allocated_amount;

  IF v_total > v_ceiling THEN
    RAISE EXCEPTION 'Allocation of % exceeds row ceiling of % for schedule %',
      v_total, v_ceiling, NEW.schedule_id;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_customer_email_conflict(p_customer_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_customer_email text;
  v_customer_auth_user_id uuid;
  v_conflicting_user_id uuid;
  v_conflict_role text;
BEGIN
  -- Permission check: when called from authenticated session, must be admin or finance.
  -- When auth.uid() is NULL (SQL Editor or service_role context), allow through.
  IF auth.uid() IS NOT NULL AND NOT (
    has_role(auth.uid(), 'admin'::app_role) 
    OR has_role(auth.uid(), 'finance'::app_role)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  -- Get customer's email and current auth_user_id
  SELECT email, auth_user_id 
  INTO v_customer_email, v_customer_auth_user_id
  FROM customers
  WHERE id = p_customer_id;

  IF v_customer_email IS NULL THEN
    RETURN NULL;
  END IF;

  -- Find auth.users with same email that's NOT this customer's auth_user_id
  SELECT id INTO v_conflicting_user_id
  FROM auth.users
  WHERE email ILIKE v_customer_email
    AND (v_customer_auth_user_id IS NULL OR id != v_customer_auth_user_id)
  LIMIT 1;

  IF v_conflicting_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Check if conflicting user has any non-customer role
  SELECT role::text INTO v_conflict_role
  FROM user_roles
  WHERE user_id = v_conflicting_user_id
    AND role::text != 'customer'
  LIMIT 1;

  IF v_conflict_role IS NOT NULL THEN
    RETURN 'staff_conflict';
  END IF;

  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = v_conflicting_user_id) THEN
    RETURN NULL;
  END IF;

  RETURN 'orphan_auth';
END;
$function$;

CREATE OR REPLACE FUNCTION public.check_duplicate_payment(p_account_id uuid, p_amount numeric, p_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_same_amount_7days INT;
  v_same_amount_30days INT;
  v_pending_submission INT;
  v_current_month_paid BOOLEAN;
BEGIN
  -- Check 1: Same amount within 7 days
  SELECT COUNT(*) INTO v_same_amount_7days
  FROM payments
  WHERE account_id = p_account_id
  AND amount_paid = p_amount
  AND date_paid >= p_date - 7
  AND voided_at IS NULL;

  -- Check 2: Same amount within 30 days
  SELECT COUNT(*) INTO v_same_amount_30days
  FROM payments
  WHERE account_id = p_account_id
  AND amount_paid = p_amount
  AND date_paid >= p_date - 30
  AND voided_at IS NULL;

  -- Check 3: Pending submission exists
  SELECT COUNT(*) INTO v_pending_submission
  FROM payment_submissions
  WHERE account_id = p_account_id
  AND status IN ('submitted', 'under_review');

  -- Check 4: Current month installment already paid
  SELECT EXISTS (
    SELECT 1 FROM layaway_schedule
    WHERE account_id = p_account_id
    AND DATE_TRUNC('month', due_date) = DATE_TRUNC('month', p_date)
    AND status = 'paid'
  ) INTO v_current_month_paid;

  RETURN jsonb_build_object(
    'same_amount_7days', v_same_amount_7days > 0,
    'same_amount_30days', v_same_amount_30days > 0,
    'pending_submission', v_pending_submission > 0,
    'current_month_paid', v_current_month_paid,
    'is_duplicate', (v_same_amount_7days > 0 OR v_pending_submission > 0),
    'is_warning', (v_same_amount_30days > 0 OR v_current_month_paid)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.clear_cash_order_expiry_on_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.expires_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.consume_lots_fifo(p_member_id uuid, p_redemption_id uuid, p_amount integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_remaining_to_consume integer := p_amount;
  v_lot record;
  v_consume_amount integer;
  v_total_consumed integer := 0;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'consume amount must be positive: %', p_amount;
  END IF;

  FOR v_lot IN
    SELECT lots.id, lots.remaining_amount
      FROM public.loyalty_point_lots AS lots
     WHERE lots.member_id        = p_member_id
       AND lots.remaining_amount > 0
       AND lots.expired_at IS NULL
     ORDER BY lots.expires_at ASC NULLS LAST, lots.earned_at ASC
     FOR UPDATE
  LOOP
    EXIT WHEN v_remaining_to_consume = 0;

    v_consume_amount := LEAST(v_lot.remaining_amount, v_remaining_to_consume);

    UPDATE public.loyalty_point_lots AS lots
       SET remaining_amount = lots.remaining_amount - v_consume_amount,
           consumed_at = CASE
             WHEN lots.remaining_amount - v_consume_amount = 0 THEN now()
             ELSE lots.consumed_at
           END,
           updated_at = now()
     WHERE lots.id = v_lot.id;

    INSERT INTO public.loyalty_lot_consumption (
      redemption_id, lot_id, amount
    ) VALUES (
      p_redemption_id, v_lot.id, v_consume_amount
    );

    v_remaining_to_consume := v_remaining_to_consume - v_consume_amount;
    v_total_consumed       := v_total_consumed       + v_consume_amount;
  END LOOP;

  IF v_remaining_to_consume > 0 THEN
    RAISE EXCEPTION 'insufficient lot balance: requested %, consumed %',
      p_amount, v_total_consumed;
  END IF;

  RETURN v_total_consumed;
END;
$function$;

CREATE OR REPLACE FUNCTION public.deactivate_expired_promotions()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE promotions
  SET is_active = false
  WHERE expires_at IS NOT NULL
    AND expires_at < NOW()
    AND is_active = true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_account_atomic(p_account_id uuid, p_performed_by_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$ DECLARE v_invoice_number text; v_caller_uuid uuid; v_audit_user_id uuid; BEGIN v_caller_uuid := auth.uid(); IF v_caller_uuid IS NOT NULL AND NOT public.has_role(v_caller_uuid, 'admin') THEN RAISE EXCEPTION 'admin role required for delete_account_atomic' USING ERRCODE = '42501', HINT = 'Only admin role can delete accounts. See role_permissions table.'; END IF; v_audit_user_id := COALESCE(p_performed_by_user_id, v_caller_uuid); IF v_audit_user_id IS NULL THEN RAISE EXCEPTION 'caller identity required (auth.uid() or p_performed_by_user_id)'; END IF; SELECT invoice_number INTO v_invoice_number FROM public.layaway_accounts WHERE id = p_account_id; IF v_invoice_number IS NULL THEN RETURN jsonb_build_object('error', 'Account not found'); END IF; PERFORM set_config('app.allow_schedule_delete', 'on', true); DELETE FROM public.payment_submission_allocations WHERE account_id = p_account_id; DELETE FROM public.payment_submissions WHERE account_id = p_account_id; DELETE FROM public.payment_allocations WHERE payment_id IN (SELECT id FROM public.payments WHERE account_id = p_account_id); DELETE FROM public.penalty_waiver_requests WHERE account_id = p_account_id; DELETE FROM public.penalty_fees WHERE account_id = p_account_id; DELETE FROM public.csr_notifications WHERE account_id = p_account_id; DELETE FROM public.extension_requests WHERE account_id = p_account_id; DELETE FROM public.reminder_logs WHERE account_id = p_account_id; DELETE FROM public.reconciliation_log WHERE account_id = p_account_id; DELETE FROM public.account_services WHERE account_id = p_account_id; DELETE FROM public.final_settlement_records WHERE account_id = p_account_id; DELETE FROM public.penalty_cap_overrides WHERE account_id = p_account_id; DELETE FROM public.payments WHERE account_id = p_account_id; DELETE FROM public.layaway_schedule WHERE account_id = p_account_id; DELETE FROM public.layaway_accounts WHERE id = p_account_id; INSERT INTO public.audit_logs ( entity_type, entity_id, action, old_value_json, performed_by_user_id ) VALUES ( 'layaway_account', p_account_id, 'delete', jsonb_build_object('invoice_number', v_invoice_number), v_audit_user_id ); RETURN jsonb_build_object('success', true); END; $function$;

CREATE OR REPLACE FUNCTION public.delete_email(queue_name text, message_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN pgmq.delete(queue_name, message_id);
EXCEPTION WHEN undefined_table THEN
  RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.delete_schedule_row_atomic(p_schedule_row_id uuid, p_account_id uuid, p_admin_user_id uuid, p_old_base_amount numeric, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_caller_uuid uuid;
BEGIN
  v_caller_uuid := auth.uid();

  -- Admin role required (mirrors delete_account_atomic pattern)
  IF v_caller_uuid IS NOT NULL AND NOT public.has_role(v_caller_uuid, 'admin') THEN
    RAISE EXCEPTION 'admin role required for delete_schedule_row_atomic'
      USING ERRCODE = '42501',
            HINT = 'Only admin role can delete schedule rows.';
  END IF;

  -- Bug #6 Stage 2 bypass — same transaction as DELETE (Bug #39 mitigation)
  PERFORM set_config('app.allow_schedule_delete', 'on', true);

  -- Audit log (atomic with DELETE — rolls back together if either fails)
  INSERT INTO public.schedule_audit_log (
    account_id, schedule_id, admin_user_id,
    action, field_changed, old_value, new_value, reason
  ) VALUES (
    p_account_id, p_schedule_row_id, p_admin_user_id,
    'delete_installment', 'base_installment_amount',
    p_old_base_amount::text, '0', p_reason
  );

  -- Delete (Stage 1 forensic_delete trigger fires automatically AFTER DELETE)
  DELETE FROM public.layaway_schedule WHERE id = p_schedule_row_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Schedule row not found: %', p_schedule_row_id
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.derive_order_loyalty_jpy(p_account_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE v_rate numeric; v_result numeric;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_rate FROM system_settings WHERE key = 'php_jpy_rate';
  UPDATE layaway_accounts la
  SET loyalty_jpy_amount = CASE WHEN la.currency::text = 'JPY' THEN la.total_amount
                                ELSE round(la.total_amount / v_rate) END,
      updated_at = now()
  WHERE la.id = p_account_id AND la.loyalty_jpy_amount IS NULL
  RETURNING la.loyalty_jpy_amount INTO v_result;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.email_queue_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pgmq.q_auth_emails)
     AND NOT EXISTS (SELECT 1 FROM pgmq.q_transactional_emails) THEN
    BEGIN
      -- Serialize disarm against email_queue_wake on a shared advisory lock, then
      -- re-read under it: an enqueue racing the unschedule either committed (we
      -- see its row and leave the cron) or waits and re-arms after we commit.
      PERFORM pg_catalog.pg_advisory_xact_lock(7700000000000001);
      IF EXISTS (SELECT 1 FROM pgmq.q_auth_emails)
         OR EXISTS (SELECT 1 FROM pgmq.q_transactional_emails) THEN
        RETURN;
      END IF;
      PERFORM cron.unschedule('process-email-queue');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'email_queue_dispatch: cron unschedule failed: %', SQLERRM;
    END;
    RETURN;
  END IF;

  IF (SELECT retry_after_until FROM public.email_send_state WHERE id = 1) > now() THEN
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/process-email-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Lovable-Context', 'cron',
      'Authorization', 'Bearer ' || (
        SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'
      )
    ),
    body := '{}'::jsonb
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.email_queue_wake()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Runs inside the enqueue transaction; the outer handler guarantees nothing
  -- below can roll back the customer's email. Shared advisory lock serializes
  -- arming against email_queue_dispatch's disarm.
  PERFORM pg_catalog.pg_advisory_xact_lock(7700000000000001);
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue') THEN
    BEGIN
      PERFORM cron.schedule('process-email-queue', '5 seconds', $cron$ SELECT public.email_queue_dispatch(); $cron$);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'email_queue_wake: cron schedule failed: %', SQLERRM;
    END;
  END IF;

  BEGIN
    PERFORM net.http_post(
      url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/process-email-queue',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Lovable-Context', 'cron',
        'Authorization', 'Bearer ' || (
          SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'
        )
      ),
      body := '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'email_queue_wake failed (enqueue preserved): %', SQLERRM;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_plan_minimum_amount()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_min_jpy     numeric;
  v_min_php     numeric;
  v_label       text;
BEGIN
  IF NEW.payment_plan_months IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT min_amount_jpy, min_amount_php, display_label
  INTO v_min_jpy, v_min_php, v_label
  FROM plan_configurations
  WHERE plan_months = NEW.payment_plan_months;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Plan duration % months is not configured. Add it to plan_configurations first.',
      NEW.payment_plan_months;
  END IF;

  -- 3M and 6M have min = 0, trigger passes through immediately
  IF NEW.currency = 'JPY' AND v_min_jpy > 0 THEN
    IF NEW.total_amount < v_min_jpy THEN
      RAISE EXCEPTION
        '% plan requires a minimum order of ¥%. Submitted amount is ¥%.',
        v_label,
        TO_CHAR(v_min_jpy,     'FM999,999,999'),
        TO_CHAR(NEW.total_amount, 'FM999,999,999');
    END IF;
  END IF;

  IF NEW.currency = 'PHP' AND v_min_php > 0 THEN
    IF NEW.total_amount < v_min_php THEN
      RAISE EXCEPTION
        '% plan requires a minimum order of ₱%. Submitted amount is ₱%.',
        v_label,
        TO_CHAR(v_min_php,      'FM999,999,999'),
        TO_CHAR(NEW.total_amount, 'FM999,999,999');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_test_invoice_prefix()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_customer_is_test boolean;
BEGIN
  SELECT c.is_test INTO v_customer_is_test
  FROM customers c WHERE c.id = NEW.customer_id;

  IF v_customer_is_test THEN
    NEW.is_test := true;
    IF NEW.invoice_number ~ '^[0-9]+$' THEN
      NEW.invoice_number := 'TEST-' || NEW.invoice_number;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_email(queue_name text, payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN pgmq.send(queue_name, payload);
EXCEPTION WHEN undefined_table THEN
  PERFORM pgmq.create(queue_name);
  RETURN pgmq.send(queue_name, payload);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fc_at_risk_accounts()
 RETURNS TABLE(total_at_risk integer, critical_count integer, active_total integer, at_risk_pct numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH overdue AS (
    SELECT ls.account_id, MAX(EXTRACT(DAY FROM now() - ls.due_date))::integer AS overdue_days
    FROM layaway_schedule ls
    JOIN layaway_accounts la ON la.id = ls.account_id
    WHERE la.status = 'active'::account_status
      AND ls.status IN ('overdue','partially_paid')
      AND ls.due_date < CURRENT_DATE
    GROUP BY ls.account_id
  ),
  penalty_counts AS (
    SELECT pf.account_id, COUNT(*) AS active_penalties
    FROM penalty_fees pf
    WHERE pf.status != 'waived'
    GROUP BY pf.account_id
  ),
  classified AS (
    SELECT la.id,
           CASE WHEN COALESCE(od.overdue_days, 0) > 30 OR COALESCE(pc.active_penalties, 0) >= 4 THEN 'CRITICAL'
                WHEN COALESCE(od.overdue_days, 0) > 14 OR COALESCE(pc.active_penalties, 0) >= 2 THEN 'AT_RISK'
                ELSE 'HEALTHY' END AS risk_level
    FROM layaway_accounts la
    LEFT JOIN overdue od ON od.account_id = la.id
    LEFT JOIN penalty_counts pc ON pc.account_id = la.id
    WHERE la.status = 'active'::account_status
      AND la.is_test = false
  )
  SELECT COUNT(*) FILTER (WHERE risk_level IN ('AT_RISK','CRITICAL'))::integer,
         COUNT(*) FILTER (WHERE risk_level = 'CRITICAL')::integer,
         COUNT(*)::integer,
         ROUND(COUNT(*) FILTER (WHERE risk_level IN ('AT_RISK','CRITICAL'))::numeric / NULLIF(COUNT(*), 0) * 100, 1)
  FROM classified;
$function$;

CREATE OR REPLACE FUNCTION public.fc_at_risk_detail()
 RETURNS TABLE(invoice_number text, plan_months integer, overdue_days integer, penalty_count bigint, outstanding_jpy numeric, risk_level text, risk_type text, risk_score integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  overdue AS (
    SELECT ls.account_id, MAX(EXTRACT(DAY FROM now() - ls.due_date))::integer AS overdue_days
    FROM layaway_schedule ls
    JOIN layaway_accounts la ON la.id = ls.account_id
    WHERE la.status = 'active'::account_status
      AND ls.status IN ('overdue','partially_paid')
      AND ls.due_date < CURRENT_DATE
    GROUP BY ls.account_id
  ),
  penalty_counts AS (
    SELECT pf.account_id, COUNT(*) AS active_penalties
    FROM penalty_fees pf
    WHERE pf.status != 'waived'
    GROUP BY pf.account_id
  ),
  classified AS (
    SELECT la.id, la.invoice_number, la.payment_plan_months, la.remaining_balance, la.currency,
           COALESCE(od.overdue_days, 0) AS overdue_days,
           COALESCE(pc.active_penalties, 0) AS active_penalties,
           CASE WHEN COALESCE(od.overdue_days, 0) > 30 OR COALESCE(pc.active_penalties, 0) >= 4 THEN 'CRITICAL'
                WHEN COALESCE(od.overdue_days, 0) > 14 OR COALESCE(pc.active_penalties, 0) >= 2 THEN 'AT_RISK'
                ELSE 'HEALTHY' END AS risk_level,
           CASE WHEN COALESCE(od.overdue_days, 0) > 14 AND COALESCE(pc.active_penalties, 0) >= 2 THEN 'COMBINED'
                WHEN COALESCE(od.overdue_days, 0) > 14 AND COALESCE(pc.active_penalties, 0) < 2 THEN 'CREDIT'
                WHEN COALESCE(od.overdue_days, 0) <= 14 AND COALESCE(pc.active_penalties, 0) >= 2 THEN 'BEHAVIORAL'
                ELSE 'NONE' END AS risk_type,
           LEAST(100, ROUND(
             LEAST(COALESCE(od.overdue_days, 0)::numeric / 90 * 50, 50)
             + LEAST(COALESCE(pc.active_penalties, 0)::numeric / 5 * 30, 30)
             + LEAST(COALESCE(pc.active_penalties, 0)::numeric * 4, 20)
           ))::integer AS risk_score
    FROM layaway_accounts la
    LEFT JOIN overdue od ON od.account_id = la.id
    LEFT JOIN penalty_counts pc ON pc.account_id = la.id
    WHERE la.status = 'active'::account_status
      AND la.is_test = false
  )
  SELECT c.invoice_number, c.payment_plan_months, c.overdue_days, c.active_penalties,
         ROUND(CASE c.currency WHEN 'JPY' THEN c.remaining_balance WHEN 'PHP' THEN c.remaining_balance / rate.r END, 0) AS outstanding_jpy,
         c.risk_level, c.risk_type, c.risk_score
  FROM classified c CROSS JOIN rate
  WHERE c.risk_level IN ('AT_RISK','CRITICAL')
  ORDER BY CASE c.risk_level WHEN 'CRITICAL' THEN 1 ELSE 2 END, c.risk_score DESC, c.overdue_days DESC;
$function$;

CREATE OR REPLACE FUNCTION public.fc_cfo_insights()
 RETURNS TABLE(priority integer, category text, observation text, implication text, action text, impact_magnitude numeric, primary_driver text, req_accounts_8m integer, req_accounts_10m integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cov         numeric;
  v_pd          numeric;
  v_pd_contrib  numeric;
  v_conc_excess numeric;
  v_best_var    numeric;
  v_best_imp    numeric;
  v_driver      text;
  v_req_shift   numeric;
  v_avg_8m      numeric;
  v_avg_10m     numeric;
  v_req_8m      integer;
  v_req_10m     integer;
  v_pref_path   text;
  v_deficit_pct numeric;
  r             record;
BEGIN
  SELECT coverage_ratio INTO v_cov FROM fc_coverage_ratio();
  SELECT pct_of_active, penalty_revenue_contribution
    INTO v_pd, v_pd_contrib
    FROM fc_penalty_driven_accounts();

  SELECT COALESCE(MAX(excess_pct), 0) INTO v_conc_excess
  FROM fc_plan_performance()
  WHERE excess_pct > 0 AND monthly_inflow > 0;

  SELECT COALESCE(MAX(variance_pct), 0),
         COALESCE(MAX(directional_impact), 0)
  INTO v_best_var, v_best_imp
  FROM fc_cohort_timeline()
  WHERE variance_pct > 50 AND account_count > 100;

  v_driver := CASE
    WHEN v_cov < 1.00        THEN 'Liquidity'
    WHEN v_conc_excess > 20  THEN 'Concentration'
    WHEN v_best_var > 50
     AND v_best_imp > 10000  THEN 'Growth'
    ELSE                          'Risk'
  END;

  v_deficit_pct := ROUND((1.00 - v_cov) * 100, 1);

  -- avg tickets with fallback
  SELECT COALESCE(
    NULLIF(AVG(CASE la.currency
      WHEN 'JPY' THEN la.total_amount
      WHEN 'PHP' THEN la.total_amount /
        (SELECT (value #>> '{}')::numeric
         FROM system_settings WHERE key = 'php_jpy_rate')
    END), 0),
    (SELECT min_amount_jpy FROM plan_configurations WHERE plan_months = 8)
  ) INTO v_avg_8m
  FROM layaway_accounts la
  WHERE la.status = 'active'::account_status
    AND la.payment_plan_months = 8 AND la.is_test = false;

  SELECT COALESCE(
    NULLIF(AVG(CASE la.currency
      WHEN 'JPY' THEN la.total_amount
      WHEN 'PHP' THEN la.total_amount /
        (SELECT (value #>> '{}')::numeric
         FROM system_settings WHERE key = 'php_jpy_rate')
    END), 0),
    (SELECT min_amount_jpy FROM plan_configurations WHERE plan_months = 10)
  ) INTO v_avg_10m
  FROM layaway_accounts la
  WHERE la.status = 'active'::account_status
    AND la.payment_plan_months = 10 AND la.is_test = false;

  SELECT COALESCE(MAX(required_shift), 0) INTO v_req_shift
  FROM fc_plan_performance()
  WHERE excess_pct > 0 AND monthly_inflow > 0;

  v_req_8m  := CEIL(v_req_shift / NULLIF(v_avg_8m, 0));
  v_req_10m := CEIL(v_req_shift / NULLIF(v_avg_10m, 0));

  -- Preferred path: fewer accounts = better
  v_pref_path := CASE
    WHEN v_avg_10m > v_avg_8m THEN '10M'
    ELSE '8M'
  END;

  -- Rule 1: Liquidity risk
  IF v_cov < 1.00 THEN
    priority := 1; category := 'Liquidity Risk';
    observation :=
      'Coverage at '||ROUND(v_cov,2)||'x — below 1.00 breakeven. '||
      'Every '||chr(165)||'1 of inventory is backed by only '||
      chr(165)||ROUND(v_cov,2)||' of inflow — a '||
      v_deficit_pct||'% liquidity deficit.';
    implication :=
      'Inflow insufficient to cover inventory cost base. '||
      'Sustained below 1.0x risks operational cash shortfall.';
    action :=
      'Accelerate 6M enrollments for DP inflow. '||
      'Review overdue collection cadence.';
    impact_magnitude := v_deficit_pct;
    primary_driver   := v_driver;
    req_accounts_8m  := NULL;
    req_accounts_10m := NULL;
    RETURN NEXT;
  END IF;

  -- Rule 2: Concentration
  SELECT * INTO r FROM fc_plan_performance()
  WHERE excess_pct > 0 AND monthly_inflow > 0
  ORDER BY excess_pct DESC LIMIT 1;
  IF r.plan_months IS NOT NULL AND r.required_shift > 1000 THEN
    priority := 2; category := 'Concentration Risk';
    observation :=
      r.display_label||' at '||ROUND(r.contribution_pct,1)||
      '% vs '||r.target_mix_pct||'% target.';
    implication :=
      'Single-plan dependency creates cash flow fragility if enrollments slow.';
    action :=
      'Shift approx '||chr(165)||TO_CHAR(r.required_shift,'FM999,999,999')||
      ' — approx '||v_req_8m||' accounts (8M) or '||v_req_10m||' accounts (10M). '||
      'Preferred shift path: '||v_pref_path||
      ' — fewer accounts required for faster rebalancing.';
    impact_magnitude := r.contribution_pct - r.target_mix_pct;
    primary_driver   := v_driver;
    req_accounts_8m  := v_req_8m;
    req_accounts_10m := v_req_10m;
    RETURN NEXT;
  END IF;

  -- Rule 3: Strong cohort
  SELECT * INTO r FROM fc_cohort_timeline()
  WHERE variance_pct > 50 AND account_count > 100
    AND directional_impact > 1000
  ORDER BY directional_impact DESC LIMIT 1;
  IF r.cohort_month IS NOT NULL THEN
    priority := 3; category := 'Strong Cohort';
    observation :=
      TO_CHAR(r.cohort_month,'Mon YYYY')||' '||r.plan_months||
      'M ('||r.account_count||' accts) '||r.variance_pct||
      '% ahead of schedule.';
    implication :=
      'Primary positive cash driver. Quality-adjusted collection: '||
      r.quality_adjusted_collection||'%.';
    action := 'Use as enrollment quality benchmark for new cohorts.';
    impact_magnitude := r.directional_impact;
    primary_driver   := v_driver;
    req_accounts_8m  := NULL;
    req_accounts_10m := NULL;
    RETURN NEXT;
  END IF;

  -- Rule 4: Behavioral risk cohort
  SELECT * INTO r FROM fc_cohort_timeline()
  WHERE (penalty_rate > 15 OR at_risk_rate > 10)
    AND ABS(directional_impact) > 1000
  ORDER BY (penalty_rate+at_risk_rate) DESC LIMIT 1;
  IF r.cohort_month IS NOT NULL THEN
    priority := 2; category := 'Behavioral Risk';
    observation :=
      TO_CHAR(r.cohort_month,'Mon YYYY')||' '||r.plan_months||
      'M — penalty rate '||r.penalty_rate||'%, at-risk '||r.at_risk_rate||'%.';
    implication :=
      'Quality-adjusted '||r.quality_adjusted_collection||
      '% vs reported '||r.collection_rate||
      '%. Penalty rate masks true performance — '||
      'reported figure overstates collection quality by '||
      ROUND(r.collection_rate - r.quality_adjusted_collection,1)||'pp.';
    action :=
      'Proactive outreach. Review penalty triggers and reminder cadence.';
    impact_magnitude := ABS(r.directional_impact);
    primary_driver   := v_driver;
    req_accounts_8m  := NULL;
    req_accounts_10m := NULL;
    RETURN NEXT;
  END IF;

  -- Rule 5: Underperformance
  SELECT * INTO r FROM fc_cohort_timeline()
  WHERE variance_pct < -20
    AND ABS(directional_impact) > 1000
  ORDER BY directional_impact ASC LIMIT 1;
  IF r.cohort_month IS NOT NULL THEN
    priority := 2; category := 'Underperformance';
    observation :=
      TO_CHAR(r.cohort_month,'Mon YYYY')||' '||r.plan_months||
      'M ('||r.account_count||' accts) '||
      ABS(r.variance_pct)||'% behind schedule.';
    implication :=
      r.delinquent_count||
      ' delinquent accounts creating negative cash drag. '||
      'Cohort is '||ABS(r.variance_pct)||
      'pp behind expected progress — this gap compounds monthly.';
    action :=
      'Escalate overdue follow-up. '||
      'Consider restructuring before default conversion.';
    impact_magnitude := ABS(r.directional_impact);
    primary_driver   := v_driver;
    req_accounts_8m  := NULL;
    req_accounts_10m := NULL;
    RETURN NEXT;
  END IF;

  -- Rule 6: Behavioral monetization signal
  IF COALESCE(v_pd,0) > 2 THEN
    priority := 3; category := 'Behavioral Monetization Signal';
    observation :=
      ROUND(v_pd,1)||'% of accounts generating '||
      ROUND(COALESCE(v_pd_contrib,0),1)||
      '% of cumulative penalty revenue.';
    implication :=
      'Penalty income may be compensating behavioral risk '||
      'rather than reducing exposure. '||
      'Revenue from this segment is not a sign of improved compliance.';
    action :=
      'Evaluate whether penalty structure is sustainable '||
      'or masking repayment instability. '||
      'Flag penalty-driven accounts for behavioral review.';
    impact_magnitude := v_pd * 10;
    primary_driver   := v_driver;
    req_accounts_8m  := NULL;
    req_accounts_10m := NULL;
    RETURN NEXT;
  END IF;

END;
$function$;

CREATE OR REPLACE FUNCTION public.fc_cohort_timeline()
 RETURNS TABLE(cohort_month date, plan_months integer, account_count integer, total_value_jpy numeric, expected_collected numeric, actual_collected numeric, collection_rate numeric, delinquent_count integer, collection_rate_delta numeric, cohort_age_days integer, expected_progress_pct numeric, variance_pct numeric, average_ticket numeric, penalty_rate numeric, at_risk_rate numeric, impact_score numeric, quality_adjusted_collection numeric, directional_impact numeric, penalty_rate_trend numeric, at_risk_rate_trend numeric, reliability_score numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  overdue AS (
    SELECT ls.account_id, MAX(EXTRACT(DAY FROM now() - ls.due_date))::integer AS overdue_days
    FROM layaway_schedule ls
    JOIN layaway_accounts la ON la.id = ls.account_id
    WHERE la.status = 'active'::account_status
      AND ls.status IN ('overdue','partially_paid')
      AND ls.due_date < CURRENT_DATE
    GROUP BY ls.account_id
  ),
  penalty_counts AS (
    SELECT pf.account_id, COUNT(*) AS active_penalties
    FROM penalty_fees pf
    WHERE pf.status != 'waived'
    GROUP BY pf.account_id
  ),
  account_risk AS (
    SELECT la.id, la.created_at, la.payment_plan_months,
           CASE WHEN COALESCE(od.overdue_days,0) > 30 OR COALESCE(pc.active_penalties,0) >= 4 THEN 'CRITICAL'
                WHEN COALESCE(od.overdue_days,0) > 14 OR COALESCE(pc.active_penalties,0) >= 2 THEN 'AT_RISK'
                ELSE 'HEALTHY' END AS risk_level,
           CASE WHEN COALESCE(pc.active_penalties,0) >= 1 THEN 1 ELSE 0 END AS has_penalty
    FROM layaway_accounts la
    LEFT JOIN overdue od ON od.account_id = la.id
    LEFT JOIN penalty_counts pc ON pc.account_id = la.id
    WHERE la.is_test = false
  ),
  cohort_base AS (
    SELECT date_trunc('month', la.created_at)::date AS cohort_month,
           la.payment_plan_months,
           COUNT(la.id)::integer AS account_count,
           ROUND(SUM(CASE la.currency WHEN 'JPY' THEN la.total_amount WHEN 'PHP' THEN la.total_amount / rate.r END), 0) AS total_value_jpy,
           ROUND(SUM(CASE la.currency WHEN 'JPY' THEN la.total_amount - la.downpayment_amount WHEN 'PHP' THEN (la.total_amount - la.downpayment_amount) / rate.r END), 0) AS expected_collected,
           ROUND(SUM(CASE la.currency WHEN 'JPY' THEN la.total_paid WHEN 'PHP' THEN la.total_paid / rate.r END), 0) AS actual_collected,
           ROUND(SUM(CASE la.currency WHEN 'JPY' THEN la.total_paid WHEN 'PHP' THEN la.total_paid / rate.r END)
                 / NULLIF(SUM(CASE la.currency WHEN 'JPY' THEN la.total_amount - la.downpayment_amount WHEN 'PHP' THEN (la.total_amount - la.downpayment_amount) / rate.r END), 0) * 100, 1) AS collection_rate,
           COUNT(la.id) FILTER (WHERE la.status IN ('forfeited'::account_status, 'extension_active'::account_status))::integer AS delinquent_count
    FROM layaway_accounts la
    CROSS JOIN rate
    WHERE la.is_test = false
    GROUP BY date_trunc('month', la.created_at), la.payment_plan_months
  ),
  cohort_quality AS (
    SELECT date_trunc('month', ar.created_at)::date AS cohort_month,
           ar.payment_plan_months,
           ROUND(COUNT(*) FILTER (WHERE ar.has_penalty = 1)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS penalty_rate,
           ROUND(COUNT(*) FILTER (WHERE ar.risk_level IN ('AT_RISK','CRITICAL'))::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS at_risk_rate
    FROM account_risk ar
    GROUP BY date_trunc('month', ar.created_at), ar.payment_plan_months
  ),
  cohort_with_age AS (
    SELECT c.*,
           EXTRACT(DAY FROM now() - c.cohort_month::timestamptz)::integer AS cohort_age_days,
           ROUND(LEAST(EXTRACT(DAY FROM now() - c.cohort_month::timestamptz) / NULLIF(c.payment_plan_months * 30, 0) * 100, 100), 1) AS expected_progress_pct,
           ROUND(c.total_value_jpy / NULLIF(c.account_count, 0), 0) AS average_ticket
    FROM cohort_base c
  )
  SELECT c.cohort_month, c.payment_plan_months, c.account_count, c.total_value_jpy,
         c.expected_collected, c.actual_collected, c.collection_rate, c.delinquent_count,
         ROUND(c.collection_rate - COALESCE(prev.collection_rate, c.collection_rate), 1) AS collection_rate_delta,
         c.cohort_age_days, c.expected_progress_pct,
         ROUND(c.collection_rate - c.expected_progress_pct, 1) AS variance_pct,
         c.average_ticket,
         COALESCE(cq.penalty_rate, 0) AS penalty_rate,
         COALESCE(cq.at_risk_rate, 0) AS at_risk_rate,
         ROUND(ABS(c.collection_rate - c.expected_progress_pct) * c.account_count, 0) AS impact_score,
         ROUND(c.collection_rate * (1 - COALESCE(cq.penalty_rate, 0) / 100) * (1 - COALESCE(cq.at_risk_rate, 0) / 100), 1) AS quality_adjusted_collection,
         CASE WHEN ROUND(c.collection_rate - c.expected_progress_pct, 1) >= 0
              THEN ROUND(ABS(c.collection_rate - c.expected_progress_pct) * c.account_count, 0)
              ELSE -ROUND(ABS(c.collection_rate - c.expected_progress_pct) * c.account_count, 0) END AS directional_impact,
         ROUND(COALESCE(cq.penalty_rate, 0) - COALESCE(prev_cq.penalty_rate, cq.penalty_rate, 0), 1) AS penalty_rate_trend,
         ROUND(COALESCE(cq.at_risk_rate, 0) - COALESCE(prev_cq.at_risk_rate, cq.at_risk_rate, 0), 1) AS at_risk_rate_trend,
         ROUND(ROUND(c.collection_rate * (1 - COALESCE(cq.penalty_rate, 0) / 100) * (1 - COALESCE(cq.at_risk_rate, 0) / 100), 1) * (1 - COALESCE(cq.at_risk_rate, 0) / 100), 1) AS reliability_score
  FROM cohort_with_age c
  LEFT JOIN cohort_base prev ON prev.cohort_month = (date_trunc('month', c.cohort_month) - interval '1 month')::date AND prev.payment_plan_months = c.payment_plan_months
  LEFT JOIN cohort_quality cq ON cq.cohort_month = c.cohort_month AND cq.payment_plan_months = c.payment_plan_months
  LEFT JOIN cohort_quality prev_cq ON prev_cq.cohort_month = (date_trunc('month', c.cohort_month) - interval '1 month')::date AND prev_cq.payment_plan_months = c.payment_plan_months
  ORDER BY impact_score DESC, c.cohort_month DESC;
$function$;

CREATE OR REPLACE FUNCTION public.fc_coverage_ratio()
 RETURNS TABLE(cash_in numeric, inventory_cost numeric, coverage_ratio numeric, status_label text, funding_gap numeric, days_covered numeric, projected_inflow_30d numeric, projected_coverage_30d numeric, projected_funding_gap numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH inflow AS (
    SELECT total_inflow FROM fc_monthly_inflow()
  ),
  portfolio AS (
    SELECT fc_portfolio_value() AS pv
  ),
  rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  inflow_30d AS (
    SELECT ROUND(SUM(CASE la.currency WHEN 'JPY' THEN p.amount_paid WHEN 'PHP' THEN p.amount_paid / rate.r END), 0) AS total
    FROM payments p
    JOIN layaway_accounts la ON la.id = p.account_id
    CROSS JOIN rate
    WHERE p.voided_at IS NULL
      AND p.date_paid >= CURRENT_DATE - interval '30 days'
      AND la.is_test = false
  )
  SELECT i.total_inflow AS cash_in,
         ROUND(p.pv * 0.85, 0) AS inventory_cost,
         ROUND(i.total_inflow / NULLIF(p.pv * 0.85, 0), 4) AS coverage_ratio,
         CASE WHEN i.total_inflow / NULLIF(p.pv * 0.85, 0) > 1.20 THEN 'HEALTHY'
              WHEN i.total_inflow / NULLIF(p.pv * 0.85, 0) >= 1.00 THEN 'WATCH'
              ELSE 'CRITICAL' END AS status_label,
         ROUND(i.total_inflow - (p.pv * 0.85), 0) AS funding_gap,
         ROUND(i.total_inflow / NULLIF(p.pv * 0.85 / 30, 0), 1) AS days_covered,
         COALESCE(i30.total, 0) AS projected_inflow_30d,
         ROUND(COALESCE(i30.total, 0) / NULLIF(p.pv * 0.85, 0), 4) AS projected_coverage_30d,
         ROUND((p.pv * 0.85) - COALESCE(i30.total, 0), 0) AS projected_funding_gap
  FROM inflow i, portfolio p, inflow_30d i30;
$function$;

CREATE OR REPLACE FUNCTION public.fc_evaluate_alerts()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_coverage       numeric;
  v_at_risk_pct    numeric;
  v_atrisk_count   integer;
  v_12m_port       numeric;
  v_total_port     numeric;
  v_12m_pct        numeric;
  v_pen_curr       numeric;
  v_pen_prev       numeric;
  v_pen_pct        numeric;
  v_atrisk_prev    numeric;
  v_conc_plan      text;
  v_conc_pct       numeric;
  v_conc_target    numeric;
  v_conc_excess    numeric;
  v_6m_pct         numeric;
  v_pen_driven_pct numeric;
  r                record;
BEGIN
  SELECT coverage_ratio INTO v_coverage FROM fc_coverage_ratio();
  SELECT at_risk_pct, total_at_risk INTO v_at_risk_pct, v_atrisk_count
    FROM fc_at_risk_accounts();
  SELECT fc_portfolio_value() INTO v_total_port;
  SELECT portfolio_jpy INTO v_12m_port
    FROM fc_plan_performance() WHERE plan_months = 12;
  SELECT current_month_jpy, penalty_pct_of_inflow
    INTO v_pen_curr, v_pen_pct
    FROM fc_penalty_revenue();
  SELECT pct_of_active INTO v_pen_driven_pct
    FROM fc_penalty_driven_accounts();

  SELECT ROUND(SUM(CASE la.currency
      WHEN 'JPY' THEN pf.penalty_amount
      WHEN 'PHP' THEN pf.penalty_amount /
        (SELECT (value #>> '{}')::numeric
         FROM system_settings WHERE key = 'php_jpy_rate')
      END), 0)
  INTO v_pen_prev
  FROM penalty_fees pf
  JOIN layaway_accounts la ON la.id = pf.account_id
  WHERE pf.status = 'paid'
    AND date_trunc('month', pf.penalty_date) =
        date_trunc('month', now() - interval '1 month') AND la.is_test = false;

  v_atrisk_prev := v_at_risk_pct * 0.95;
  v_12m_pct := ROUND(
    COALESCE(v_12m_port,0) / NULLIF(v_total_port,0) * 100, 1
  );

  SELECT SUM(CASE WHEN pp.plan_months <= 6
    THEN COALESCE(pp.contribution_pct,0) ELSE 0 END)
  INTO v_6m_pct FROM fc_plan_performance() pp;

  SELECT pp.display_label, pp.contribution_pct,
         pp.target_mix_pct, pp.excess_pct
  INTO v_conc_plan, v_conc_pct, v_conc_target, v_conc_excess
  FROM fc_plan_performance() pp
  WHERE pp.contribution_pct IS NOT NULL AND pp.monthly_inflow > 0
  ORDER BY pp.contribution_pct DESC LIMIT 1;

  -- 12M overexposure
  IF v_12m_pct >= 20 THEN
    INSERT INTO financial_alerts
      (alert_type,severity,plan_months,message,threshold_value,current_value)
    VALUES('exposure_12m','critical',12,
      '12M exposure at '||v_12m_pct||'% — exceeds 20% policy limit',
      20,v_12m_pct) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='exposure_12m' AND resolved_at IS NULL;
  END IF;

  -- Coverage critical
  IF v_coverage < 1.00 THEN
    INSERT INTO financial_alerts
      (alert_type,severity,plan_months,message,threshold_value,current_value)
    VALUES('coverage_critical','critical',NULL,
      'Cash flow coverage at '||ROUND(v_coverage,2)||
      'x — below 1.00 critical threshold',
      1.00,v_coverage) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='coverage_critical' AND resolved_at IS NULL;
  END IF;

  -- Coverage watch
  IF v_coverage >= 1.00 AND v_coverage < 1.20 THEN
    INSERT INTO financial_alerts
      (alert_type,severity,plan_months,message,threshold_value,current_value)
    VALUES('coverage_watch','warning',NULL,
      'Cash flow coverage at '||ROUND(v_coverage,2)||
      'x — below 1.20 watch threshold',
      1.20,v_coverage) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='coverage_watch' AND resolved_at IS NULL;
  END IF;

  -- At-risk spike
  IF v_at_risk_pct > 15 THEN
    INSERT INTO financial_alerts
      (alert_type,severity,plan_months,message,threshold_value,current_value)
    VALUES('atrisk_spike','critical',NULL,
      'At-risk accounts at '||v_at_risk_pct||
      '% of active portfolio — '||v_atrisk_count||' accounts flagged',
      15,v_at_risk_pct) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='atrisk_spike' AND resolved_at IS NULL;
  END IF;

  -- Delinquency + penalty spike
  IF v_pen_curr > COALESCE(v_pen_prev,0)
    AND v_at_risk_pct > COALESCE(v_atrisk_prev,0) THEN
    INSERT INTO financial_alerts
      (alert_type,severity,plan_months,message,threshold_value,current_value)
    VALUES('delinquency_penalty_spike','warning',NULL,
      'Delinquency increasing — penalty revenue at '||ROUND(v_pen_pct,1)||
      '% of inflow reflects rising payment failures',
      0,v_pen_pct) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='delinquency_penalty_spike' AND resolved_at IS NULL;
  END IF;

  -- 6M concentration
  IF v_6m_pct > 70 THEN
    INSERT INTO financial_alerts
      (alert_type,severity,plan_months,message,threshold_value,current_value)
    VALUES('concentration_6m','warning',6,
      '6M plan at '||ROUND(v_6m_pct,1)||
      '% of inflow — target max 70%. Enroll higher-tier accounts to rebalance.',
      70,v_6m_pct) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='concentration_6m' AND resolved_at IS NULL;
  END IF;

  -- Highest plan concentration
  IF v_conc_pct IS NOT NULL AND v_conc_excess > 0 THEN
    INSERT INTO financial_alerts
      (alert_type,severity,plan_months,message,threshold_value,current_value)
    VALUES('concentration_risk','warning',NULL,
      'Portfolio concentration risk — '||v_conc_plan||' at '||
      ROUND(v_conc_pct,1)||'% vs '||v_conc_target||
      '% target ('||ROUND(v_conc_excess,1)||'% over)',
      v_conc_target,v_conc_pct) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='concentration_risk' AND resolved_at IS NULL;
  END IF;

  -- Penalty-driven behavioral
  IF COALESCE(v_pen_driven_pct,0) > 3 THEN
    INSERT INTO financial_alerts
      (alert_type,severity,plan_months,message,threshold_value,current_value)
    VALUES('behavioral_revenue_dependence','warning',NULL,
      'Behavioral revenue dependence rising — '||
      ROUND(v_pen_driven_pct,1)||
      '% of active accounts penalty-driven',
      3,v_pen_driven_pct) ON CONFLICT DO NOTHING;
  ELSE
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='behavioral_revenue_dependence' AND resolved_at IS NULL;
  END IF;

  -- Quality gap alert — elevated to critical if gap > 25pp
  FOR r IN
    SELECT
      cohort_month, plan_months,
      collection_rate, quality_adjusted_collection,
      ROUND(collection_rate - quality_adjusted_collection, 1) AS gap
    FROM fc_cohort_timeline()
    WHERE (collection_rate - quality_adjusted_collection) > 15
    ORDER BY (collection_rate - quality_adjusted_collection) DESC
    LIMIT 1
  LOOP
    IF r.gap > 25 THEN
      -- Critical + Hidden Risk label
      INSERT INTO financial_alerts
        (alert_type,severity,plan_months,message,threshold_value,current_value)
      VALUES('quality_degradation','critical',r.plan_months,
        '[Hidden Risk] Collection quality degradation — '||
        TO_CHAR(r.cohort_month,'Mon YYYY')||' '||r.plan_months||
        'M cohort gap '||r.gap||'pp (reported '||r.collection_rate||
        '% vs quality-adjusted '||r.quality_adjusted_collection||'%)',
        25, r.gap) ON CONFLICT DO NOTHING;
    ELSE
      INSERT INTO financial_alerts
        (alert_type,severity,plan_months,message,threshold_value,current_value)
      VALUES('quality_degradation','warning',r.plan_months,
        'Collection quality degradation — '||
        TO_CHAR(r.cohort_month,'Mon YYYY')||' '||r.plan_months||
        'M cohort gap '||r.gap||'pp (reported '||r.collection_rate||
        '% vs quality-adjusted '||r.quality_adjusted_collection||'%)',
        15, r.gap) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;

  -- Resolve quality gap if no longer applies
  IF NOT EXISTS (
    SELECT 1 FROM fc_cohort_timeline()
    WHERE (collection_rate - quality_adjusted_collection) > 15
  ) THEN
    UPDATE financial_alerts SET resolved_at=now()
    WHERE alert_type='quality_degradation' AND resolved_at IS NULL;
  END IF;

END;
$function$;

CREATE OR REPLACE FUNCTION public.fc_gross_profit()
 RETURNS TABLE(active_gross_profit numeric, lifetime_gross_profit numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  active AS (
    SELECT SUM(CASE la.currency WHEN 'JPY' THEN la.remaining_balance WHEN 'PHP' THEN la.remaining_balance / r.r END) AS portfolio_value
    FROM layaway_accounts la, rate r
    WHERE la.status = 'active'::account_status
      AND la.is_test = false
  ),
  lifetime AS (
    SELECT SUM(CASE la.currency WHEN 'JPY' THEN la.total_amount WHEN 'PHP' THEN la.total_amount / r.r END) AS total_sales
    FROM layaway_accounts la, rate r
    WHERE la.is_test = false
  )
  SELECT ROUND(active.portfolio_value * 0.15, 0) AS active_gross_profit,
         ROUND(lifetime.total_sales * 0.15, 0) AS lifetime_gross_profit
  FROM active, lifetime;
$function$;

CREATE OR REPLACE FUNCTION public.fc_monthly_inflow(target_month date DEFAULT (date_trunc('month'::text, now()))::date)
 RETURNS TABLE(installment_inflow numeric, penalty_inflow numeric, total_inflow numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  alloc_inflow AS (
    SELECT pa.allocation_type,
           SUM(CASE p.currency WHEN 'JPY' THEN pa.allocated_amount WHEN 'PHP' THEN pa.allocated_amount / rate.r END) AS amount_jpy
    FROM payments p
    JOIN payment_allocations pa ON pa.payment_id = p.id
    JOIN layaway_accounts la ON la.id = p.account_id
    CROSS JOIN rate
    WHERE p.voided_at IS NULL
      AND date_trunc('month', p.date_paid::timestamptz) = date_trunc('month', target_month::timestamptz)
      AND la.is_test = false
    GROUP BY pa.allocation_type
  )
  SELECT ROUND(COALESCE(SUM(CASE WHEN allocation_type = 'installment' THEN amount_jpy END), 0), 0),
         ROUND(COALESCE(SUM(CASE WHEN allocation_type = 'penalty' THEN amount_jpy END), 0), 0),
         ROUND(COALESCE(SUM(amount_jpy), 0), 0)
  FROM alloc_inflow;
$function$;

CREATE OR REPLACE FUNCTION public.fc_net_exposure_risk(resale_pct numeric DEFAULT 0.25)
 RETURNS TABLE(gross_exposure numeric, dp_retained numeric, penalties_collected numeric, estimated_resale numeric, net_exposure numeric, prior_month_exposure numeric, exposure_change numeric, healthy_exposure numeric, at_risk_exposure numeric, critical_exposure numeric, delta_healthy numeric, delta_at_risk numeric, delta_critical numeric, delta_pct numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  overdue AS (
    SELECT ls.account_id, MAX(EXTRACT(DAY FROM now() - ls.due_date))::integer AS overdue_days
    FROM layaway_schedule ls
    JOIN layaway_accounts la ON la.id = ls.account_id
    WHERE la.status = 'active'::account_status
      AND ls.status IN ('overdue','partially_paid')
      AND ls.due_date < CURRENT_DATE
    GROUP BY ls.account_id
  ),
  penalty_counts AS (
    SELECT pf.account_id, COUNT(*) AS active_penalties
    FROM penalty_fees pf
    WHERE pf.status != 'waived'
    GROUP BY pf.account_id
  ),
  classified AS (
    SELECT la.id, la.status, la.total_amount, la.remaining_balance, la.downpayment_amount, la.currency,
           COALESCE(od.overdue_days, 0) AS overdue_days,
           COALESCE(pc.active_penalties, 0) AS active_penalties,
           CASE WHEN COALESCE(od.overdue_days, 0) > 30 OR COALESCE(pc.active_penalties, 0) >= 4 THEN 'CRITICAL'
                WHEN COALESCE(od.overdue_days, 0) > 14 OR COALESCE(pc.active_penalties, 0) >= 2 THEN 'AT_RISK'
                ELSE 'HEALTHY' END AS risk_level
    FROM layaway_accounts la
    LEFT JOIN overdue od ON od.account_id = la.id
    LEFT JOIN penalty_counts pc ON pc.account_id = la.id
    WHERE la.status IN ('active'::account_status, 'forfeited'::account_status, 'extension_active'::account_status, 'final_settlement'::account_status)
      AND la.is_test = false
  ),
  exposure_base AS (
    SELECT SUM(CASE c.currency WHEN 'JPY' THEN c.remaining_balance WHEN 'PHP' THEN c.remaining_balance / rate.r END) AS gross_exp,
           SUM(CASE WHEN c.status = 'forfeited'::account_status THEN CASE c.currency WHEN 'JPY' THEN c.downpayment_amount WHEN 'PHP' THEN c.downpayment_amount / rate.r END ELSE 0 END) AS dp_ret,
           SUM(CASE WHEN c.status = 'forfeited'::account_status THEN CASE c.currency WHEN 'JPY' THEN c.total_amount * resale_pct WHEN 'PHP' THEN (c.total_amount / rate.r) * resale_pct END ELSE 0 END) AS resale_est,
           SUM(CASE WHEN c.risk_level = 'HEALTHY' THEN CASE c.currency WHEN 'JPY' THEN c.remaining_balance WHEN 'PHP' THEN c.remaining_balance / rate.r END ELSE 0 END) AS healthy_exp,
           SUM(CASE WHEN c.risk_level = 'AT_RISK' THEN CASE c.currency WHEN 'JPY' THEN c.remaining_balance WHEN 'PHP' THEN c.remaining_balance / rate.r END ELSE 0 END) AS at_risk_exp,
           SUM(CASE WHEN c.risk_level = 'CRITICAL' THEN CASE c.currency WHEN 'JPY' THEN c.remaining_balance WHEN 'PHP' THEN c.remaining_balance / rate.r END ELSE 0 END) AS critical_exp
    FROM classified c CROSS JOIN rate
  ),
  penalties AS (
    SELECT SUM(CASE la.currency WHEN 'JPY' THEN pf.penalty_amount WHEN 'PHP' THEN pf.penalty_amount / rate.r END) AS pen_collected
    FROM penalty_fees pf
    JOIN layaway_accounts la ON la.id = pf.account_id
    CROSS JOIN rate
    WHERE pf.status = 'paid'
      AND la.is_test = false
  ),
  prior AS (
    SELECT SUM(CASE la.currency WHEN 'JPY' THEN p.amount_paid WHEN 'PHP' THEN p.amount_paid / rate.r END) AS prior_inflow
    FROM payments p
    JOIN layaway_accounts la ON la.id = p.account_id
    CROSS JOIN rate
    WHERE p.voided_at IS NULL
      AND date_trunc('month', p.date_paid::timestamptz) = date_trunc('month', now() - interval '1 month')
      AND la.is_test = false
  ),
  prior_by_risk AS (
    SELECT SUM(CASE WHEN c.risk_level = 'HEALTHY' THEN CASE p.currency WHEN 'JPY' THEN p.amount_paid WHEN 'PHP' THEN p.amount_paid / rate.r END ELSE 0 END) AS healthy_prior,
           SUM(CASE WHEN c.risk_level = 'AT_RISK' THEN CASE p.currency WHEN 'JPY' THEN p.amount_paid WHEN 'PHP' THEN p.amount_paid / rate.r END ELSE 0 END) AS at_risk_prior,
           SUM(CASE WHEN c.risk_level = 'CRITICAL' THEN CASE p.currency WHEN 'JPY' THEN p.amount_paid WHEN 'PHP' THEN p.amount_paid / rate.r END ELSE 0 END) AS critical_prior
    FROM payments p
    JOIN classified c ON c.id = p.account_id
    CROSS JOIN rate
    WHERE p.voided_at IS NULL
      AND date_trunc('month', p.date_paid::timestamptz) = date_trunc('month', now() - interval '1 month')
  ),
  net_calc AS (
    SELECT e.gross_exp, e.dp_ret, e.resale_est, e.healthy_exp, e.at_risk_exp, e.critical_exp,
           COALESCE(pen.pen_collected, 0) AS pen_collected,
           COALESCE(pr.prior_inflow, 0) AS prior_inflow,
           COALESCE(pbr.healthy_prior, 0) AS healthy_prior,
           COALESCE(pbr.at_risk_prior, 0) AS at_risk_prior,
           COALESCE(pbr.critical_prior,0) AS critical_prior,
           ROUND(e.gross_exp - e.dp_ret - COALESCE(pen.pen_collected, 0) - e.resale_est, 0) AS net_exp,
           ROUND(e.gross_exp - e.dp_ret - COALESCE(pen.pen_collected, 0) - e.resale_est - COALESCE(pr.prior_inflow, 0), 0) AS prior_net_exp
    FROM exposure_base e, penalties pen, prior pr, prior_by_risk pbr
  )
  SELECT ROUND(nc.gross_exp, 0) AS gross_exposure,
         ROUND(nc.dp_ret, 0) AS dp_retained,
         ROUND(nc.pen_collected, 0) AS penalties_collected,
         ROUND(nc.resale_est, 0) AS estimated_resale,
         nc.net_exp AS net_exposure,
         nc.prior_net_exp AS prior_month_exposure,
         ROUND(nc.prior_inflow, 0) AS exposure_change,
         ROUND(nc.healthy_exp, 0) AS healthy_exposure,
         ROUND(nc.at_risk_exp, 0) AS at_risk_exposure,
         ROUND(nc.critical_exp, 0) AS critical_exposure,
         ROUND(-nc.healthy_prior, 0) AS delta_healthy,
         ROUND(-nc.at_risk_prior, 0) AS delta_at_risk,
         ROUND(-nc.critical_prior, 0) AS delta_critical,
         ROUND(-nc.prior_inflow / NULLIF(nc.gross_exp + nc.prior_inflow, 0) * 100, 1) AS delta_pct
  FROM net_calc nc;
$function$;

CREATE OR REPLACE FUNCTION public.fc_penalty_driven_accounts()
 RETURNS TABLE(penalty_driven_count integer, pct_of_active numeric, penalty_revenue_contribution numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  overdue AS (
    SELECT ls.account_id, MAX(EXTRACT(DAY FROM now() - ls.due_date))::integer AS overdue_days
    FROM layaway_schedule ls
    JOIN layaway_accounts la ON la.id = ls.account_id
    WHERE la.status = 'active'::account_status
      AND ls.status IN ('overdue','partially_paid')
      AND ls.due_date < CURRENT_DATE
    GROUP BY ls.account_id
  ),
  penalty_counts AS (
    SELECT pf.account_id, COUNT(*) AS active_penalties
    FROM penalty_fees pf
    WHERE pf.status != 'waived'
    GROUP BY pf.account_id
  ),
  active_total AS (
    SELECT COUNT(*) AS total FROM layaway_accounts
    WHERE status = 'active'::account_status
      AND is_test = false
  ),
  penalty_driven AS (
    SELECT la.id
    FROM layaway_accounts la
    LEFT JOIN overdue od ON od.account_id = la.id
    LEFT JOIN penalty_counts pc ON pc.account_id = la.id
    WHERE la.status = 'active'::account_status
      AND COALESCE(pc.active_penalties, 0) >= 4
      AND COALESCE(od.overdue_days, 0) <= 14
      AND la.is_test = false
  ),
  driven_penalty_revenue AS (
    SELECT SUM(CASE la.currency WHEN 'JPY' THEN pf.penalty_amount WHEN 'PHP' THEN pf.penalty_amount / rate.r END) AS driven_total
    FROM penalty_fees pf
    JOIN layaway_accounts la ON la.id = pf.account_id
    CROSS JOIN rate
    WHERE pf.status = 'paid'
      AND pf.account_id IN (SELECT id FROM penalty_driven)
      AND la.is_test = false
  ),
  cumulative_penalty AS (
    SELECT SUM(CASE la.currency WHEN 'JPY' THEN pf.penalty_amount WHEN 'PHP' THEN pf.penalty_amount / rate.r END) AS cumulative_total
    FROM penalty_fees pf
    JOIN layaway_accounts la ON la.id = pf.account_id
    CROSS JOIN rate
    WHERE pf.status = 'paid'
      AND la.is_test = false
  )
  SELECT COUNT(pd.id)::integer AS penalty_driven_count,
         ROUND(COUNT(pd.id)::numeric / NULLIF(at.total, 0) * 100, 1) AS pct_of_active,
         ROUND(COALESCE(dr.driven_total, 0) / NULLIF(cp.cumulative_total, 0) * 100, 1) AS penalty_revenue_contribution
  FROM penalty_driven pd
  CROSS JOIN active_total at
  CROSS JOIN driven_penalty_revenue dr
  CROSS JOIN cumulative_penalty cp
  GROUP BY at.total, dr.driven_total, cp.cumulative_total;
$function$;

CREATE OR REPLACE FUNCTION public.fc_penalty_revenue()
 RETURNS TABLE(current_month_jpy numeric, cumulative_jpy numeric, penalty_pct_of_inflow numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  penalty_data AS (
    SELECT ROUND(SUM(
             CASE WHEN date_trunc('month', pf.penalty_date) = date_trunc('month', now())
                  THEN CASE la.currency WHEN 'JPY' THEN pf.penalty_amount WHEN 'PHP' THEN pf.penalty_amount / rate.r END
                  ELSE 0 END
           ), 0) AS current_month_jpy,
           ROUND(SUM(
             CASE la.currency WHEN 'JPY' THEN pf.penalty_amount WHEN 'PHP' THEN pf.penalty_amount / rate.r END
           ), 0) AS cumulative_jpy
    FROM penalty_fees pf
    JOIN layaway_accounts la ON la.id = pf.account_id
    CROSS JOIN rate
    WHERE pf.status = 'paid'
      AND la.is_test = false
  ),
  inflow_data AS (
    SELECT total_inflow FROM fc_monthly_inflow()
  )
  SELECT pd.current_month_jpy, pd.cumulative_jpy,
         ROUND(pd.current_month_jpy / NULLIF(id.total_inflow, 0) * 100, 2) AS penalty_pct_of_inflow
  FROM penalty_data pd, inflow_data id;
$function$;

CREATE OR REPLACE FUNCTION public.fc_plan_performance()
 RETURNS TABLE(plan_months integer, display_label text, risk_tier text, min_amount_jpy numeric, account_count integer, portfolio_jpy numeric, avg_ticket_jpy numeric, monthly_inflow numeric, gross_profit numeric, default_rate numeric, contribution_pct numeric, risk_adjusted_profit numeric, target_mix_pct numeric, excess_pct numeric, plan_penalty_rate numeric, plan_at_risk_rate numeric, plan_quality_score numeric, required_shift numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  overdue AS (
    SELECT ls.account_id, MAX(EXTRACT(DAY FROM now() - ls.due_date))::integer AS overdue_days
    FROM layaway_schedule ls
    JOIN layaway_accounts la ON la.id = ls.account_id
    WHERE la.status = 'active'::account_status
      AND ls.status IN ('overdue','partially_paid')
      AND ls.due_date < CURRENT_DATE
    GROUP BY ls.account_id
  ),
  penalty_counts AS (
    SELECT pf.account_id, COUNT(*) AS active_penalties
    FROM penalty_fees pf
    WHERE pf.status != 'waived'
    GROUP BY pf.account_id
  ),
  account_risk AS (
    SELECT la.id, la.payment_plan_months,
           CASE WHEN COALESCE(od.overdue_days,0) > 30 OR COALESCE(pc.active_penalties,0) >= 4 THEN 'CRITICAL'
                WHEN COALESCE(od.overdue_days,0) > 14 OR COALESCE(pc.active_penalties,0) >= 2 THEN 'AT_RISK'
                ELSE 'HEALTHY' END AS risk_level,
           CASE WHEN COALESCE(pc.active_penalties,0) >= 1 THEN 1 ELSE 0 END AS has_penalty
    FROM layaway_accounts la
    LEFT JOIN overdue od ON od.account_id = la.id
    LEFT JOIN penalty_counts pc ON pc.account_id = la.id
    WHERE la.status = 'active'::account_status
      AND la.is_test = false
  ),
  plan_quality AS (
    SELECT ar.payment_plan_months,
           ROUND(COUNT(*) FILTER (WHERE ar.has_penalty = 1)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS plan_penalty_rate,
           ROUND(COUNT(*) FILTER (WHERE ar.risk_level IN ('AT_RISK','CRITICAL'))::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS plan_at_risk_rate
    FROM account_risk ar
    GROUP BY ar.payment_plan_months
  ),
  active_accounts AS (
    SELECT la.payment_plan_months,
           CASE la.currency WHEN 'JPY' THEN la.remaining_balance WHEN 'PHP' THEN la.remaining_balance / rate.r END AS remaining_jpy,
           CASE la.currency WHEN 'JPY' THEN la.total_amount WHEN 'PHP' THEN la.total_amount / rate.r END AS total_jpy
    FROM layaway_accounts la
    CROSS JOIN rate
    WHERE la.status = 'active'::account_status
      AND la.is_test = false
  ),
  month_payments AS (
    SELECT la.payment_plan_months,
           SUM(CASE p.currency WHEN 'JPY' THEN p.amount_paid WHEN 'PHP' THEN p.amount_paid / rate.r END) AS paid_jpy
    FROM payments p
    JOIN layaway_accounts la ON la.id = p.account_id
    CROSS JOIN rate
    WHERE p.voided_at IS NULL
      AND date_trunc('month', p.date_paid::timestamptz) = date_trunc('month', now())
      AND la.is_test = false
    GROUP BY la.payment_plan_months
  ),
  total_inflow AS (
    SELECT NULLIF(SUM(paid_jpy), 0) AS total FROM month_payments
  ),
  default_rates AS (
    SELECT payment_plan_months,
           ROUND(COUNT(*) FILTER (WHERE status = 'forfeited'::account_status)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS default_rate
    FROM layaway_accounts
    WHERE is_test = false
    GROUP BY payment_plan_months
  ),
  plan_agg AS (
    SELECT aa.payment_plan_months,
           COUNT(*)::integer AS account_count,
           ROUND(SUM(aa.remaining_jpy), 0) AS portfolio_jpy,
           ROUND(AVG(aa.total_jpy), 0) AS avg_ticket_jpy,
           ROUND(SUM(aa.total_jpy) * 0.15, 0) AS gross_profit
    FROM active_accounts aa
    GROUP BY aa.payment_plan_months
  ),
  target_bounds AS (
    SELECT plan_months,
           CASE WHEN plan_months <= 6 THEN 70.0 WHEN plan_months >= 8 THEN 40.0 ELSE 100.0 END AS target_upper
    FROM plan_configurations
    WHERE is_active = true
  )
  SELECT pc.plan_months, pc.display_label, pc.risk_tier, pc.min_amount_jpy,
         COALESCE(pa.account_count, 0),
         COALESCE(pa.portfolio_jpy, 0),
         COALESCE(pa.avg_ticket_jpy, 0),
         COALESCE(ROUND(mp.paid_jpy, 0), 0) AS monthly_inflow,
         COALESCE(pa.gross_profit, 0),
         COALESCE(dr.default_rate, 0),
         ROUND(COALESCE(mp.paid_jpy, 0) / NULLIF(ti.total, 0) * 100, 1) AS contribution_pct,
         ROUND(COALESCE(pa.gross_profit, 0) * (1 - COALESCE(dr.default_rate, 0) / 100), 0) AS risk_adjusted_profit,
         tb.target_upper AS target_mix_pct,
         ROUND(COALESCE(mp.paid_jpy, 0) / NULLIF(ti.total, 0) * 100 - tb.target_upper, 1) AS excess_pct,
         COALESCE(pq.plan_penalty_rate, 0) AS plan_penalty_rate,
         COALESCE(pq.plan_at_risk_rate, 0) AS plan_at_risk_rate,
         ROUND(100 - (COALESCE(pq.plan_penalty_rate, 0) + COALESCE(pq.plan_at_risk_rate, 0)) / 2, 1) AS plan_quality_score,
         ROUND(GREATEST(COALESCE(mp.paid_jpy, 0) / NULLIF(ti.total, 0) * 100 - tb.target_upper, 0) / 100 * COALESCE(ti.total, 0), 0) AS required_shift
  FROM plan_configurations pc
  LEFT JOIN plan_agg pa ON pa.payment_plan_months = pc.plan_months
  LEFT JOIN month_payments mp ON mp.payment_plan_months = pc.plan_months
  LEFT JOIN default_rates dr ON dr.payment_plan_months = pc.plan_months
  LEFT JOIN target_bounds tb ON tb.plan_months = pc.plan_months
  LEFT JOIN plan_quality pq ON pq.payment_plan_months = pc.plan_months
  CROSS JOIN total_inflow ti
  WHERE pc.is_active = true
  ORDER BY pc.plan_months;
$function$;

CREATE OR REPLACE FUNCTION public.fc_portfolio_value()
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT ROUND(SUM(
    CASE la.currency
      WHEN 'JPY' THEN la.remaining_balance
      WHEN 'PHP' THEN la.remaining_balance / (SELECT (value #>> '{}')::numeric FROM system_settings WHERE key = 'php_jpy_rate')
    END
  ), 0)
  FROM layaway_accounts la
  WHERE la.status = 'active'::account_status
    AND la.is_test = false;
$function$;

CREATE OR REPLACE FUNCTION public.generate_customer_code()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_year TEXT;
  v_next_num INT;
  v_last_num INT;
BEGIN
  IF NEW.customer_code IS NULL THEN
    v_year := EXTRACT(YEAR FROM NOW())::TEXT;
    
    SELECT COALESCE(MAX(
      NULLIF(regexp_replace(customer_code, 'CJ-' || v_year || '-', ''), '')::INT
    ), 0)
    INTO v_last_num
    FROM customers
    WHERE customer_code LIKE 'CJ-' || v_year || '-%';
    
    v_next_num := v_last_num + 8;
    
    NEW.customer_code := 'CJ-' || v_year || '-' || LPAD(v_next_num::TEXT, 5, '0');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_aging_buckets(p_scope text DEFAULT 'all_collectible'::text)
 RETURNS TABLE(bucket text, currency text, account_count bigint, amount numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH valid_statuses AS (
    SELECT CASE
      WHEN p_scope = 'active_flow'
        THEN ARRAY['active', 'overdue']
      ELSE ARRAY['active', 'overdue', 'extension_active', 'final_settlement']
    END AS statuses
  ),
  rows AS (
    SELECT
      a.id AS account_id,
      a.currency::text AS currency,
      GREATEST(
        0,
        (CURRENT_DATE AT TIME ZONE 'Asia/Manila')::date
        - (sw.due_date AT TIME ZONE 'Asia/Manila')::date
      ) AS days_overdue,
      sw.actual_remaining
    FROM schedule_with_actuals sw
    JOIN layaway_accounts a ON a.id = sw.account_id
    CROSS JOIN valid_statuses vs
    WHERE sw.computed_status IN ('pending', 'overdue', 'partially_paid')
      AND sw.actual_remaining > 0
      AND a.status::text = ANY(vs.statuses)
      AND a.is_test = false
  ),
  bucketed AS (
    SELECT
      CASE
        WHEN days_overdue <= 0  THEN 'current'
        WHEN days_overdue <= 7  THEN 'd1_7'
        WHEN days_overdue <= 30 THEN 'd8_30'
        ELSE 'd31_plus'
      END AS bucket,
      currency,
      account_id,
      actual_remaining
    FROM rows
  )
  SELECT
    bucket,
    currency,
    COUNT(DISTINCT account_id) AS account_count,
    SUM(actual_remaining) AS amount
  FROM bucketed
  GROUP BY bucket, currency
  ORDER BY
    CASE bucket
      WHEN 'current'  THEN 1
      WHEN 'd1_7'     THEN 2
      WHEN 'd8_30'    THEN 3
      WHEN 'd31_plus' THEN 4
    END,
    currency;
$function$;

CREATE OR REPLACE FUNCTION public.get_audit_filter_options()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  SELECT jsonb_build_object(
    'entity_types', (
      SELECT COALESCE(jsonb_agg(et ORDER BY et), '[]'::jsonb)
      FROM (SELECT DISTINCT entity_type AS et FROM public.audit_logs WHERE entity_type IS NOT NULL) e
    ),
    'actions', (
      SELECT COALESCE(jsonb_agg(ac ORDER BY ac), '[]'::jsonb)
      FROM (SELECT DISTINCT action AS ac FROM public.audit_logs WHERE action IS NOT NULL) a
    ),
    'actors', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', u.uid, 'full_name', p.full_name) ORDER BY p.full_name NULLS LAST), '[]'::jsonb)
      FROM (SELECT DISTINCT performed_by_user_id AS uid FROM public.audit_logs WHERE performed_by_user_id IS NOT NULL) u
      LEFT JOIN public.profiles p ON p.user_id = u.uid
    )
  ) INTO result;

  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_bulk_setup_invite_candidates(p_test_codes text[] DEFAULT NULL::text[], p_limit integer DEFAULT 50, p_count_only boolean DEFAULT false)
 RETURNS TABLE(id uuid, customer_code text, full_name text, email text, total_eligible bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total bigint;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin only: get_bulk_setup_invite_candidates is restricted';
  END IF;

  WITH staff_emails AS (
    SELECT LOWER(u.email) AS email_lc
    FROM auth.users u
    WHERE u.email IS NOT NULL
  ),
  shared_emails AS (
    SELECT LOWER(c.email) AS email_lc
    FROM public.customers c
    WHERE c.email IS NOT NULL AND c.auth_user_id IS NULL
    GROUP BY LOWER(c.email)
    HAVING COUNT(*) > 1
  )
  SELECT COUNT(*)::bigint INTO v_total
  FROM public.customers c
  WHERE c.email IS NOT NULL
    AND c.auth_user_id IS NULL
    AND c.setup_link_sent_at IS NULL
    AND LOWER(c.email) NOT IN (SELECT se.email_lc FROM staff_emails se)
    AND LOWER(c.email) NOT IN (SELECT sh.email_lc FROM shared_emails sh)
    AND (p_test_codes IS NULL OR c.customer_code = ANY(p_test_codes));

  IF p_count_only THEN
    RETURN QUERY
    SELECT
      NULL::uuid AS id,
      NULL::text AS customer_code,
      NULL::text AS full_name,
      NULL::text AS email,
      v_total AS total_eligible;
    RETURN;
  END IF;

  RETURN QUERY
  WITH staff_emails AS (
    SELECT LOWER(u.email) AS email_lc
    FROM auth.users u
    WHERE u.email IS NOT NULL
  ),
  shared_emails AS (
    SELECT LOWER(c.email) AS email_lc
    FROM public.customers c
    WHERE c.email IS NOT NULL AND c.auth_user_id IS NULL
    GROUP BY LOWER(c.email)
    HAVING COUNT(*) > 1
  ),
  eligible AS (
    SELECT c.id, c.customer_code, c.full_name, c.email
    FROM public.customers c
    WHERE c.email IS NOT NULL
      AND c.auth_user_id IS NULL
      AND c.setup_link_sent_at IS NULL
      AND LOWER(c.email) NOT IN (SELECT se.email_lc FROM staff_emails se)
      AND LOWER(c.email) NOT IN (SELECT sh.email_lc FROM shared_emails sh)
      AND (p_test_codes IS NULL OR c.customer_code = ANY(p_test_codes))
  )
  SELECT
    e.id,
    e.customer_code,
    e.full_name,
    e.email,
    v_total AS total_eligible
  FROM eligible e
  ORDER BY e.customer_code ASC
  LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_cash_orders_monthly()
 RETURNS TABLE(month date, cash_jpy numeric, order_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  )
  SELECT
    date_trunc('month', co.order_date)::date AS month,
    SUM(CASE WHEN co.currency = 'JPY' THEN co.total_amount
             WHEN co.currency = 'PHP' THEN co.total_amount / (SELECT r FROM rate)
             ELSE co.total_amount END) AS cash_jpy,
    COUNT(*)::bigint AS order_count
  FROM cash_orders co
  WHERE co.cancelled_at IS NULL
    AND co.is_test = false
    AND co.order_date >= DATE '2020-01-01'
  GROUP BY 1
  ORDER BY 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_collection_analytics(currency_mode text DEFAULT 'ALL'::text, months_back integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result        JSONB := '[]'::JSONB;
  v_month         DATE;
  v_collected     NUMERIC;   -- cash received this month (payment date) -> Collections vs Sales
  v_collected_due NUMERIC;   -- collected toward this due-month's installments -> drives the rate
  v_expected      NUMERIC;   -- scheduled due for this due-month
  v_forfeited     INT;
  v_penalties     NUMERIC;
  v_rate          NUMERIC;
  v_scale         INT;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_rate FROM system_settings WHERE key = 'php_jpy_rate';
  v_scale := CASE WHEN currency_mode = 'PHP' THEN 2 ELSE 0 END;

  FOR i IN 0..months_back-1 LOOP
    v_month := DATE_TRUNC('month', CURRENT_DATE - (i || ' months')::INTERVAL);

    SELECT COALESCE(SUM(
      CASE WHEN currency_mode != 'ALL' THEN p.amount_paid
           WHEN la.currency = 'JPY' THEN p.amount_paid
           WHEN la.currency = 'PHP' THEN p.amount_paid / v_rate
           ELSE p.amount_paid END
    ), 0) INTO v_collected
    FROM payments p
    JOIN layaway_accounts la ON la.id = p.account_id
    WHERE DATE_TRUNC('month', p.date_paid::DATE) = v_month
      AND p.voided_at IS NULL
      AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
      AND la.is_test = false;

    SELECT
      COALESCE(SUM(
        CASE WHEN currency_mode != 'ALL' THEN (sw.allocated + sw.actual_remaining)
             WHEN la.currency = 'JPY' THEN (sw.allocated + sw.actual_remaining)
             WHEN la.currency = 'PHP' THEN (sw.allocated + sw.actual_remaining) / v_rate
             ELSE (sw.allocated + sw.actual_remaining) END
      ), 0),
      COALESCE(SUM(
        CASE WHEN currency_mode != 'ALL' THEN sw.allocated
             WHEN la.currency = 'JPY' THEN sw.allocated
             WHEN la.currency = 'PHP' THEN sw.allocated / v_rate
             ELSE sw.allocated END
      ), 0)
    INTO v_expected, v_collected_due
    FROM schedule_with_actuals sw
    JOIN layaway_accounts la ON la.id = sw.account_id
    WHERE DATE_TRUNC('month', sw.due_date::DATE) = v_month
      AND sw.computed_status != 'cancelled'
      AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
      AND la.is_test = false;

    SELECT COUNT(*) INTO v_forfeited
    FROM layaway_accounts la
    WHERE DATE_TRUNC('month', la.updated_at) = v_month
      AND la.status IN ('forfeited', 'final_forfeited')
      AND la.is_test = false;

    SELECT COALESCE(SUM(
      CASE WHEN currency_mode != 'ALL' THEN pf.penalty_amount
           WHEN la.currency = 'JPY' THEN pf.penalty_amount
           WHEN la.currency = 'PHP' THEN pf.penalty_amount / v_rate
           ELSE pf.penalty_amount END
    ), 0) INTO v_penalties
    FROM penalty_fees pf
    JOIN layaway_schedule ls ON ls.id = pf.schedule_id
    JOIN layaway_accounts la ON la.id = ls.account_id
    WHERE DATE_TRUNC('month', pf.created_at) = v_month
      AND pf.status = 'paid'
      AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
      AND la.is_test = false;

    v_result := jsonb_build_array(jsonb_build_object(
      'month', TO_CHAR(v_month, 'Mon YY'),
      'collected', ROUND(v_collected, v_scale),
      'collected_due', ROUND(v_collected_due, v_scale),
      'expected', ROUND(v_expected, v_scale),
      'collection_rate', CASE WHEN v_expected > 0 THEN ROUND((v_collected_due / v_expected * 100)::NUMERIC, 1) ELSE 0 END,
      'forfeited', v_forfeited,
      'penalties_collected', ROUND(v_penalties, v_scale)
    )) || v_result;
  END LOOP;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_daily_new_layaway_sales(currency_mode text DEFAULT 'ALL'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.day ASC)
    FROM (
      SELECT
        TO_CHAR(la.order_date::DATE, 'YYYY-MM-DD') AS day,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN currency_mode <> 'ALL' THEN la.total_amount
                 WHEN la.currency = 'JPY' THEN la.total_amount
                 WHEN la.currency = 'PHP' THEN la.total_amount / r.rate
                 ELSE la.total_amount END) AS total_sales_value
      FROM layaway_accounts la
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE la.is_test = false
        AND la.status <> 'cancelled'::account_status
        AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
        AND EXISTS (SELECT 1 FROM payments p WHERE p.account_id = la.id AND p.voided_at IS NULL)
        AND DATE_TRUNC('month', la.order_date::DATE) = DATE_TRUNC('month', CURRENT_DATE)
      GROUP BY la.order_date::DATE
      ORDER BY la.order_date::DATE ASC
    ) t
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_daily_new_layaway_sales_last_month(currency_mode text DEFAULT 'ALL'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.day ASC)
    FROM (
      SELECT
        TO_CHAR(la.order_date::DATE, 'YYYY-MM-DD') AS day,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN currency_mode <> 'ALL' THEN la.total_amount
                 WHEN la.currency = 'JPY' THEN la.total_amount
                 WHEN la.currency = 'PHP' THEN la.total_amount / r.rate
                 ELSE la.total_amount END) AS total_sales_value
      FROM layaway_accounts la
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE la.is_test = false
        AND la.status <> 'cancelled'::account_status
        AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
        AND EXISTS (SELECT 1 FROM payments p WHERE p.account_id = la.id AND p.voided_at IS NULL)
        AND DATE_TRUNC('month', la.order_date::DATE) = DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
      GROUP BY la.order_date::DATE
      ORDER BY la.order_date::DATE ASC
    ) t
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_forecast_6m()
 RETURNS TABLE(month date, currency text, installments bigint, remaining numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT date_trunc('month', s.due_date)::date, a.currency::text, COUNT(*), SUM(s.actual_remaining)
  FROM schedule_with_actuals s
  JOIN layaway_accounts a ON a.id = s.account_id
  WHERE s.due_date < date_trunc('month', now()) + INTERVAL '7 months'
    AND s.computed_status IN ('pending', 'partially_paid', 'overdue')
    AND a.status IN ('active', 'overdue', 'final_settlement', 'extension_active')
    AND a.is_test = false
  GROUP BY 1, 2
  ORDER BY 1, 2;
$function$;

CREATE OR REPLACE FUNCTION public.get_forecast_drilldown(p_month text)
 RETURNS TABLE(schedule_id uuid, due_date date, computed_status text, actual_remaining numeric, account_id uuid, invoice_number text, account_status text, currency text, customer_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH parsed AS (
    SELECT (p_month LIKE 'AGED:%') AS include_older,
           CASE WHEN p_month LIKE 'AGED:%' THEN substring(p_month FROM 6) ELSE p_month END AS ym
  ),
  bounds AS (
    SELECT (ym || '-01')::date AS month_start,
           ((ym || '-01')::date + INTERVAL '1 month' - INTERVAL '1 day')::date AS month_end,
           include_older
    FROM parsed
  )
  SELECT swa.id, swa.due_date, swa.computed_status::text, swa.actual_remaining,
         a.id, a.invoice_number, a.status::text, a.currency::text, c.full_name
  FROM schedule_with_actuals swa
  JOIN layaway_accounts a ON a.id = swa.account_id
  LEFT JOIN customers c ON c.id = a.customer_id
  CROSS JOIN bounds b
  WHERE swa.due_date <= b.month_end
    AND (b.include_older OR swa.due_date >= b.month_start)
    AND swa.computed_status IN ('pending', 'partially_paid', 'overdue')
    AND a.status IN ('active', 'overdue', 'final_settlement', 'extension_active')
    AND a.is_test = false
    AND swa.actual_remaining > 0
  ORDER BY swa.due_date ASC;
$function$;

CREATE OR REPLACE FUNCTION public.get_monthly_analytics()
 RETURNS TABLE(month date, collected_jpy numeric, forfeited_jpy numeric, penalties_jpy numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r
    FROM system_settings
    WHERE key = 'php_jpy_rate'
  ),
  collected AS (
    SELECT
      date_trunc('month', p.date_paid)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN p.amount_paid
               WHEN a.currency = 'PHP' THEN p.amount_paid / (SELECT r FROM rate)
               ELSE p.amount_paid END) AS jpy
    FROM payments p
    JOIN layaway_accounts a ON a.id = p.account_id
    WHERE p.voided_at IS NULL
      AND a.is_test = false
    GROUP BY 1
  ),
  forfeited AS (
    SELECT
      date_trunc('month', a.updated_at)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN a.remaining_balance
               WHEN a.currency = 'PHP' THEN a.remaining_balance / (SELECT r FROM rate)
               ELSE a.remaining_balance END) AS jpy
    FROM layaway_accounts a
    WHERE a.status IN ('forfeited', 'final_forfeited')
      AND a.is_test = false
    GROUP BY 1
  ),
  penalties AS (
    SELECT
      date_trunc('month', pf.penalty_date)::date AS month,
      SUM(CASE WHEN a.currency = 'JPY' THEN pf.penalty_amount
               WHEN a.currency = 'PHP' THEN pf.penalty_amount / (SELECT r FROM rate)
               ELSE pf.penalty_amount END) AS jpy
    FROM penalty_fees pf
    JOIN layaway_accounts a ON a.id = pf.account_id
    WHERE pf.status = 'paid'
      AND a.is_test = false
    GROUP BY 1
  ),
  all_months AS (
    SELECT month FROM collected
    UNION SELECT month FROM forfeited
    UNION SELECT month FROM penalties
  )
  SELECT
    m.month,
    COALESCE(c.jpy,   0) AS collected_jpy,
    COALESCE(f.jpy,   0) AS forfeited_jpy,
    COALESCE(pen.jpy, 0) AS penalties_jpy
  FROM all_months m
  LEFT JOIN collected  c   ON c.month = m.month
  LEFT JOIN forfeited  f   ON f.month = m.month
  LEFT JOIN penalties  pen ON pen.month = m.month
  ORDER BY 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_monthly_sales(currency_mode text DEFAULT 'ALL'::text, months_back integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.month ASC)
    FROM (
      SELECT
        TO_CHAR(DATE_TRUNC('month', la.order_date::DATE), 'Mon YYYY') AS month,
        COUNT(*) AS new_sales_count,
        SUM(CASE WHEN currency_mode <> 'ALL' THEN la.total_amount
                 WHEN la.currency = 'JPY' THEN la.total_amount
                 WHEN la.currency = 'PHP' THEN la.total_amount / r.rate
                 ELSE la.total_amount END) AS total_sales_value
      FROM layaway_accounts la
      CROSS JOIN (SELECT (value #>> '{}')::numeric AS rate FROM system_settings WHERE key = 'php_jpy_rate') r
      WHERE la.is_test = false
        AND la.status <> 'cancelled'::account_status
        AND (currency_mode = 'ALL' OR la.currency = currency_mode::account_currency)
        AND EXISTS (SELECT 1 FROM payments p WHERE p.account_id = la.id AND p.voided_at IS NULL)
        AND DATE_TRUNC('month', la.order_date::DATE) >= DATE_TRUNC('month', CURRENT_DATE - (months_back || ' months')::INTERVAL)
      GROUP BY DATE_TRUNC('month', la.order_date::DATE)
      ORDER BY DATE_TRUNC('month', la.order_date::DATE) ASC
    ) t
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_monthly_tracking_export(p_year integer, p_month integer)
 RETURNS TABLE(invoice_number text, customer_name text, currency text, order_date date, payment_plan_months integer, total_jpy numeric, month_paid_jpy jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT COALESCE(
             (SELECT (value #>> '{}')::numeric FROM system_settings WHERE key = 'php_jpy_rate'),
             0.42
           ) AS r
  ),
  cohort AS (
    SELECT la.id, la.invoice_number, la.customer_id, la.currency,
           la.order_date, la.payment_plan_months, la.total_amount
    FROM layaway_accounts la
    WHERE EXTRACT(YEAR  FROM la.order_date) = p_year
      AND EXTRACT(MONTH FROM la.order_date) = p_month
  ),
  p_bucket AS (
    SELECT p.account_id,
           p.amount_paid
             - COALESCE((SELECT SUM(pa2.allocated_amount) FROM payment_allocations pa2
                         WHERE pa2.payment_id = p.id AND pa2.allocation_type = 'penalty'), 0) AS principal_native,
           COALESCE(
             (SELECT to_char(MIN(s.due_date), 'YYYY-MM')
              FROM payment_allocations pa
              JOIN layaway_schedule s ON s.id = pa.schedule_id
              WHERE pa.payment_id = p.id AND pa.allocation_type = 'installment'),
             to_char(p.date_paid, 'YYYY-MM')
           ) AS ym
    FROM payments p
    WHERE p.voided_at IS NULL
      AND p.account_id IN (SELECT id FROM cohort)
  ),
  m AS (
    SELECT pb.account_id, pb.ym, SUM(pb.principal_native) AS principal_native
    FROM p_bucket pb
    GROUP BY pb.account_id, pb.ym
  )
  SELECT c.invoice_number,
         cust.full_name,
         c.currency::text,
         c.order_date,
         c.payment_plan_months,
         CASE WHEN c.currency = 'JPY' THEN ROUND(c.total_amount)
              ELSE ROUND(c.total_amount / r.r) END,
         COALESCE(
           jsonb_object_agg(m.ym,
             CASE WHEN c.currency = 'JPY' THEN ROUND(m.principal_native)
                  ELSE ROUND(m.principal_native / r.r) END
           ) FILTER (WHERE m.ym IS NOT NULL),
           '{}'::jsonb
         )
  FROM cohort c
  JOIN customers cust ON cust.id = c.customer_id
  CROSS JOIN rate r
  LEFT JOIN m ON m.account_id = c.id
  GROUP BY c.invoice_number, cust.full_name, c.currency, c.order_date,
           c.payment_plan_months, c.total_amount, r.r;
$function$;

CREATE OR REPLACE FUNCTION public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer DEFAULT 3)
 RETURNS TABLE(source_kind text, account_id uuid, cash_order_id uuid, invoice_number text, loyalty_jpy_amount numeric, total_amount numeric, currency text, confirmed_at timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT q.source_kind, q.account_id, q.cash_order_id, q.invoice_number,
         q.loyalty_jpy_amount, q.total_amount, q.currency, q.confirmed_at
  FROM (
    SELECT 'layaway'::text AS source_kind, la.id AS account_id, NULL::uuid AS cash_order_id,
           la.invoice_number, la.loyalty_jpy_amount, la.total_amount, la.currency::text AS currency,
           ps.updated_at AS confirmed_at
    FROM layaway_accounts la
    JOIN payment_submissions ps
      ON ps.account_id = la.id AND ps.status::text = 'confirmed'
     AND ( ps.submission_type::text = 'downpayment'
        OR ps.reference_number ILIKE 'DP-%'
        OR ps.notes ~* '\y(down(payment)?|dp)\y' )
    WHERE la.customer_id = p_customer_id
      AND (la.loyalty_jpy_amount >= 10000 OR la.loyalty_jpy_amount IS NULL)
      AND la.status::text NOT IN ('cancelled','forfeited','final_forfeited')
      AND ps.updated_at >= now() - make_interval(days => p_lookback_days)
    UNION ALL
    SELECT 'cash'::text, NULL::uuid, co.id, co.invoice_number, co.loyalty_jpy_amount, co.total_amount,
           co.currency::text, co.completed_at
    FROM cash_orders co
    WHERE co.customer_id = p_customer_id
      AND co.loyalty_jpy_amount >= 10000
      AND co.status::text = 'completed'
      AND co.completed_at IS NOT NULL
      AND co.completed_at >= now() - make_interval(days => p_lookback_days)
  ) q
  ORDER BY q.confirmed_at DESC
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_staff_performance(months_back integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_agg(row_to_json(t))
    FROM (
      SELECT 
        u.email AS staff_email,
        COUNT(ps.id) AS payments_confirmed,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (ps.updated_at - ps.created_at))/3600
        )::NUMERIC, 1) AS avg_confirmation_hours
      FROM payment_submissions ps
      JOIN auth.users u ON u.id = ps.reviewer_user_id
      WHERE ps.status = 'confirmed'
      AND ps.updated_at >= CURRENT_DATE - (months_back * 30 || ' days')::INTERVAL
      GROUP BY u.email
      ORDER BY payments_confirmed DESC
    ) t
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_top_outstanding_customers()
 RETURNS TABLE(customer_id uuid, full_name text, account_count integer, total_paid_jpy numeric, early_payment_rate numeric, penalty_count integer, score numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH rate AS (
    SELECT (value #>> '{}')::numeric AS r FROM system_settings WHERE key = 'php_jpy_rate'
  ),
  customer_accounts AS (
    SELECT c.id AS customer_id, c.full_name, la.id AS account_id, la.currency, la.total_paid, la.status
    FROM customers c
    JOIN layaway_accounts la ON la.customer_id = c.id
    WHERE la.status IN ('active'::account_status, 'overdue'::account_status, 'completed'::account_status, 'reactivated'::account_status, 'final_settlement'::account_status)
      AND la.is_test = false
  ),
  customer_counts AS (
    SELECT customer_id, full_name, COUNT(*) AS account_count,
           ROUND(SUM(CASE currency WHEN 'JPY' THEN total_paid WHEN 'PHP' THEN total_paid / (SELECT r FROM rate) END), 0) AS total_paid_jpy
    FROM customer_accounts
    GROUP BY customer_id, full_name
    HAVING COUNT(*) > 1
  ),
  penalty_counts AS (
    SELECT la.customer_id, COUNT(pf.id) AS penalty_count
    FROM penalty_fees pf
    JOIN layaway_accounts la ON la.id = pf.account_id
    WHERE pf.status IN ('unpaid','paid')
      AND la.is_test = false
    GROUP BY la.customer_id
  ),
  early_payments AS (
    SELECT la.customer_id, COUNT(*) AS total_payments,
           COUNT(*) FILTER (WHERE p.date_paid <= ls.due_date) AS early_count
    FROM payments p
    JOIN layaway_accounts la ON la.id = p.account_id
    JOIN payment_allocations pa ON pa.payment_id = p.id
    JOIN layaway_schedule ls ON ls.id = pa.schedule_id
    WHERE p.voided_at IS NULL
      AND la.status IN ('active'::account_status, 'overdue'::account_status, 'completed'::account_status, 'reactivated'::account_status, 'final_settlement'::account_status)
      AND la.is_test = false
    GROUP BY la.customer_id
  )
  SELECT cc.customer_id, cc.full_name, cc.account_count::integer, cc.total_paid_jpy,
         ROUND(COALESCE(ep.early_count, 0)::numeric / NULLIF(ep.total_payments, 0) * 100, 1) AS early_payment_rate,
         COALESCE(pc.penalty_count, 0)::integer AS penalty_count,
         ROUND((cc.account_count * 30) + (COALESCE(ep.early_count, 0)::numeric / NULLIF(ep.total_payments, 0) * 40) + GREATEST(0, 30 - COALESCE(pc.penalty_count, 0) * 5), 1) AS score
  FROM customer_counts cc
  LEFT JOIN penalty_counts pc ON pc.customer_id = cc.customer_id
  LEFT JOIN early_payments ep ON ep.customer_id = cc.customer_id
  WHERE NOT EXISTS (
    SELECT 1 FROM layaway_accounts la2
    WHERE la2.customer_id = cc.customer_id
      AND la2.status IN ('forfeited'::account_status, 'final_forfeited'::account_status, 'extension_active'::account_status)
  )
  ORDER BY early_payment_rate DESC NULLS LAST, account_count DESC LIMIT 10;
$function$;

CREATE OR REPLACE FUNCTION public.get_tracking_for_invoices(p_invoices text[])
 RETURNS TABLE(invoice_number text, full_name text, currency text, order_date date, status text, country text, month_paid_jpy jsonb)
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
WITH rate AS (
  SELECT COALESCE(
    (SELECT (value #>> '{}')::numeric FROM system_settings WHERE key = 'php_jpy_rate'),
    0.42
  ) AS r
),
la AS (
  SELECT id, invoice_number, customer_id, currency::text AS cur, order_date, status::text AS status
  FROM layaway_accounts
  WHERE invoice_number = ANY(p_invoices)
),
co AS (
  SELECT id, invoice_number, customer_id, currency::text AS cur, order_date, status::text AS status
  FROM cash_orders
  WHERE invoice_number = ANY(p_invoices)
),
la_pay AS (
  SELECT p.account_id AS oid, p.amount_paid - COALESCE(
    (SELECT SUM(pa.allocated_amount) FROM payment_allocations pa WHERE pa.payment_id = p.id AND pa.allocation_type = 'penalty'),
    0
  ) AS principal_native, to_char(p.date_paid, 'YYYY-MM') AS ym, la.cur AS cur
  FROM payments p
  JOIN la ON la.id = p.account_id
  WHERE p.voided_at IS NULL
),
co_pay AS (
  SELECT cp.cash_order_id AS oid, cp.amount_paid AS principal_native, to_char(cp.date_paid, 'YYYY-MM') AS ym, co.cur AS cur
  FROM cash_payments cp
  JOIN co ON co.id = cp.cash_order_id
  WHERE cp.voided_at IS NULL
),
all_orders AS (
  SELECT id, invoice_number, customer_id, cur, order_date, status FROM la
  UNION ALL
  SELECT id, invoice_number, customer_id, cur, order_date, status FROM co
),
all_pay AS (
  SELECT oid, principal_native, ym, cur FROM la_pay
  UNION ALL
  SELECT oid, principal_native, ym, cur FROM co_pay
),
m AS (
  SELECT oid, ym, cur, SUM(principal_native) AS principal_native
  FROM all_pay
  WHERE ym IS NOT NULL
  GROUP BY oid, ym, cur
)
SELECT 
  o.invoice_number, 
  cust.full_name, 
  o.cur,
  o.order_date, 
  o.status,
  cust.country,
  COALESCE(
    jsonb_object_agg(
      m.ym,
      CASE WHEN m.cur = 'JPY' THEN ROUND(m.principal_native)
           ELSE ROUND(m.principal_native / r.r)
      END
    ) FILTER (WHERE m.ym IS NOT NULL),
    '{}'::jsonb
  )
FROM all_orders o
LEFT JOIN customers cust ON cust.id = o.customer_id
CROSS JOIN rate r
LEFT JOIN m ON m.oid = o.id
GROUP BY o.invoice_number, cust.full_name, o.cur, o.order_date, o.status, cust.country;
$function$;

CREATE OR REPLACE FUNCTION public.get_trade_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric;
  v_active_count int;
  v_total_count int;
  v_completed_count int;
  v_total_value_jpy numeric;
  v_all_accounts_count int;
  v_share_percent numeric;
BEGIN
  -- Canonical PHP→JPY rate (¥1 = ₱[rate]; divide PHP by rate to get JPY)
  -- Use #>> '{}' to handle both JSON string and JSON number storage
  SELECT (value #>> '{}')::numeric INTO v_rate
  FROM public.system_settings
  WHERE key = 'php_jpy_rate';
  v_rate := COALESCE(v_rate, 0.42);

  SELECT COUNT(*) INTO v_active_count
  FROM public.layaway_accounts
  WHERE is_trade = true
    AND status IN ('active','overdue','extension_active','reactivated');

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts
     WHERE is_trade = true AND status::text != 'cancelled')
    + (SELECT COUNT(*) FROM public.cash_orders
       WHERE is_trade = true AND status::text != 'cancelled')
  INTO v_total_count;

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts
     WHERE is_trade = true AND status = 'completed')
    + (SELECT COUNT(*) FROM public.cash_orders
       WHERE is_trade = true AND status = 'completed')
  INTO v_completed_count;

  SELECT
    COALESCE((
      SELECT SUM(
        CASE
          WHEN currency = 'JPY' THEN total_amount
          WHEN currency = 'PHP' THEN total_amount / v_rate
          ELSE total_amount
        END
      )
      FROM public.layaway_accounts
      WHERE is_trade = true AND status::text != 'cancelled'
    ), 0)
    + COALESCE((
      SELECT SUM(
        CASE
          WHEN currency = 'JPY' THEN total_amount
          WHEN currency = 'PHP' THEN total_amount / v_rate
          ELSE total_amount
        END
      )
      FROM public.cash_orders
      WHERE is_trade = true AND status::text != 'cancelled'
    ), 0)
  INTO v_total_value_jpy;

  SELECT
    (SELECT COUNT(*) FROM public.layaway_accounts WHERE status::text != 'cancelled')
    + (SELECT COUNT(*) FROM public.cash_orders WHERE status::text != 'cancelled')
  INTO v_all_accounts_count;

  v_share_percent := CASE
    WHEN v_all_accounts_count = 0 THEN 0
    ELSE (v_total_count::numeric / v_all_accounts_count::numeric) * 100
  END;

  RETURN jsonb_build_object(
    'active_count', v_active_count,
    'total_count', v_total_count,
    'completed_count', v_completed_count,
    'total_value_jpy', ROUND(v_total_value_jpy),
    'share_percent', ROUND(v_share_percent, 2),
    'all_accounts_count', v_all_accounts_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_trade_monthly_trends(p_months_back integer DEFAULT 12)
 RETURNS TABLE(month text, trade_count integer, trade_value_jpy numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric; v_start_date date; v_end_date date;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_rate FROM public.system_settings WHERE key = 'php_jpy_rate';
  v_rate := COALESCE(v_rate, 0.42);
  v_start_date := date_trunc('month', (now() AT TIME ZONE 'Asia/Manila') - ((p_months_back - 1) || ' months')::interval)::date;
  v_end_date := (now() AT TIME ZONE 'Asia/Manila')::date;
  RETURN QUERY
  WITH all_months AS (
    SELECT to_char(generate_series(v_start_date, v_end_date, '1 month'::interval), 'YYYY-MM') AS month_key
  ),
  layaway_trades AS (
    SELECT to_char(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month_key,
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN currency = 'JPY' THEN total_amount
                    WHEN currency = 'PHP' THEN total_amount / v_rate
                    ELSE total_amount END) AS val_jpy
    FROM public.layaway_accounts
    WHERE is_trade = true
      AND is_test = false
      AND status::text != 'cancelled'
      AND EXISTS (SELECT 1 FROM public.payments p WHERE p.account_id = layaway_accounts.id AND p.voided_at IS NULL)
      AND COALESCE(order_date, created_at::date) >= v_start_date
      AND COALESCE(order_date, created_at::date) <= v_end_date
    GROUP BY month_key
  ),
  cash_trades AS (
    SELECT to_char(COALESCE(order_date, created_at::date), 'YYYY-MM') AS month_key,
           COUNT(*)::int AS cnt,
           SUM(CASE WHEN currency = 'JPY' THEN total_amount
                    WHEN currency = 'PHP' THEN total_amount / v_rate
                    ELSE total_amount END) AS val_jpy
    FROM public.cash_orders
    WHERE is_trade = true
      AND is_test = false
      AND status::text != 'cancelled'
      AND EXISTS (SELECT 1 FROM public.cash_payments cp WHERE cp.cash_order_id = cash_orders.id AND cp.voided_at IS NULL)
      AND COALESCE(order_date, created_at::date) >= v_start_date
      AND COALESCE(order_date, created_at::date) <= v_end_date
    GROUP BY month_key
  )
  SELECT am.month_key AS month,
         (COALESCE(lt.cnt, 0) + COALESCE(ct.cnt, 0))::int AS trade_count,
         ROUND(COALESCE(lt.val_jpy, 0) + COALESCE(ct.val_jpy, 0))::numeric AS trade_value_jpy
  FROM all_months am
  LEFT JOIN layaway_trades lt ON lt.month_key = am.month_key
  LEFT JOIN cash_trades ct ON ct.month_key = am.month_key
  ORDER BY am.month_key;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_unpaid_schedule(p_account_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_agg(row_to_json(t) ORDER BY t.installment_number ASC)
    FROM (
      SELECT 
        ls.id,
        ls.installment_number,
        ls.due_date,
        ls.base_installment_amount,
        ls.penalty_amount,
        ls.carried_amount,
        ls.total_due_amount,
        ls.paid_amount,
        ls.status,
        COALESCE((
          SELECT SUM(pa.allocated_amount)
          FROM payment_allocations pa
          JOIN payments p ON p.id = pa.payment_id
          WHERE pa.schedule_id = ls.id
          AND p.voided_at IS NULL
        ), 0) AS total_allocated,
        -- Check if pending submission exists for this month
        EXISTS (
          SELECT 1 FROM payment_submissions ps
          WHERE ps.account_id = ls.account_id
          AND ps.status IN ('submitted', 'under_review')
        ) AS has_pending_submission
      FROM layaway_schedule ls
      WHERE ls.account_id = p_account_id
      AND ls.status NOT IN ('paid', 'cancelled')
      ORDER BY ls.installment_number ASC
    ) t
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.raw_user_meta_data->>'is_team_member', 'false') = 'true' THEN
    INSERT INTO public.profiles (user_id, full_name, email)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email), NEW.email);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE OR REPLACE FUNCTION public.insert_lot_and_extend(p_member_id uuid, p_source_type loyalty_lot_source_type, p_source_reference text, p_amount integer, p_earned_at timestamp with time zone DEFAULT now(), p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notes text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lot_id uuid;
  v_computed_expires_at timestamptz;
BEGIN
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'lot amount must be positive: %', p_amount;
  END IF;

  v_computed_expires_at := COALESCE(p_expires_at,
    CASE p_source_type
      WHEN 'order_earn' THEN p_earned_at + INTERVAL '12 months'
      ELSE NULL  -- birthday/promo/admin_adjust set explicit expires_at
    END);

  INSERT INTO public.loyalty_point_lots (
    member_id, source_type, source_reference,
    original_amount, remaining_amount,
    earned_at, expires_at, notes
  ) VALUES (
    p_member_id, p_source_type, p_source_reference,
    p_amount, p_amount,
    p_earned_at, v_computed_expires_at, p_notes
  )
  RETURNING id INTO v_lot_id;

  -- Rolling extension on order_earn purchases ONLY
  IF p_source_type = 'order_earn' THEN
    UPDATE public.loyalty_point_lots AS lots
       SET expires_at = p_earned_at + INTERVAL '12 months',
           updated_at = now()
     WHERE lots.member_id   = p_member_id
       AND lots.source_type = 'order_earn'
       AND lots.remaining_amount > 0
       AND lots.expired_at IS NULL
       AND lots.id <> v_lot_id;
  END IF;

  RETURN v_lot_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.insert_payment_submission_guarded(p_account_id uuid, p_customer_id uuid, p_submitted_amount numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_notes text, p_submission_type text, p_sender_name text, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dup record;
  v_id uuid;
  v_minutes int;
BEGIN
  -- Serialize all submission inserts per account: a concurrent caller
  -- blocks here until the first transaction commits, so its dup check
  -- below always sees the committed row. Lock auto-releases at tx end.
  PERFORM pg_advisory_xact_lock(hashtext('payment_submission:' || p_account_id::text));

  IF NOT p_force THEN
    SELECT id, created_at, sender_name
      INTO v_dup
      FROM payment_submissions
     WHERE account_id = p_account_id
       AND status IN ('submitted', 'under_review')
       AND created_at >= now() - interval '30 minutes'
       AND abs(submitted_amount - p_submitted_amount) < 1
     ORDER BY created_at DESC
     LIMIT 1;

    IF FOUND THEN
      v_minutes := greatest(1, round(extract(epoch FROM (now() - v_dup.created_at)) / 60)::int);
      RETURN jsonb_build_object(
        'duplicate', true,
        'minutes_ago', v_minutes,
        'sender_name', v_dup.sender_name
      );
    END IF;
  END IF;

  INSERT INTO payment_submissions (
    account_id, customer_id, submitted_amount, payment_date, payment_method,
    reference_number, notes, status, submission_type, sender_name
  ) VALUES (
    p_account_id, p_customer_id, p_submitted_amount, p_payment_date,
    coalesce(p_payment_method, 'cash'), p_reference_number, p_notes,
    'submitted', coalesce(p_submission_type, 'single'), p_sender_name
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('duplicate', false, 'submission_id', v_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('admin','staff','finance','csr')
  )
$function$;

CREATE OR REPLACE FUNCTION public.log_admin_table_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO audit_logs (
    entity_type,
    entity_id,
    action,
    old_value_json,
    new_value_json,
    performed_by_user_id
  ) VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    TG_OP,
    CASE WHEN TG_OP = 'DELETE' OR TG_OP = 'UPDATE' 
         THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP = 'INSERT' OR TG_OP = 'UPDATE' 
         THEN to_jsonb(NEW) ELSE NULL END,
    auth.uid()
  );
  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_schedule_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_admin_id uuid;
  v_jwt jsonb;
  v_old_row_json text;
BEGIN
  BEGIN
    v_jwt := current_setting('request.jwt.claims', true)::jsonb;
    v_admin_id := (v_jwt->>'sub')::uuid;
  EXCEPTION WHEN OTHERS THEN
    v_admin_id := NULL;
  END;

  v_old_row_json := json_build_object(
    'installment_number', OLD.installment_number,
    'due_date', OLD.due_date,
    'base_installment_amount', OLD.base_installment_amount,
    'penalty_amount', OLD.penalty_amount,
    'total_due_amount', OLD.total_due_amount,
    'paid_amount', OLD.paid_amount,
    'currency', OLD.currency,
    'status', OLD.status,
    'carried_amount', OLD.carried_amount,
    'carried_from_schedule_id', OLD.carried_from_schedule_id,
    'carried_by_payment_id', OLD.carried_by_payment_id,
    'generated_at', OLD.generated_at,
    'updated_at', OLD.updated_at,
    'session_user', session_user,
    'current_user', current_user
  )::text;

  INSERT INTO public.schedule_audit_log (
    account_id,
    schedule_id,
    admin_user_id,
    action,
    field_changed,
    old_value,
    new_value,
    reason
  ) VALUES (
    OLD.account_id,
    OLD.id,
    v_admin_id,
    'forensic_delete',
    'row_deleted',
    v_old_row_json,
    NULL,
    CASE 
      WHEN v_admin_id IS NULL 
        THEN 'Cascade or direct SQL delete (no JWT context)'
      ELSE 'Delete via authenticated context'
    END
  );

  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.loyalty_lots_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.loyalty_members_set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.loyalty_transactions_no_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'loyalty_transactions rows are immutable';
END;
$function$;

CREATE OR REPLACE FUNCTION public.monthly_inflow_by_plan_6m()
 RETURNS TABLE(month text, payment_plan_months integer, jpy_total numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rate numeric;
  v_start_date date;
  v_end_date date;
BEGIN
  SELECT (value #>> '{}')::numeric INTO v_rate FROM system_settings WHERE key = 'php_jpy_rate';
  IF v_rate IS NULL OR v_rate <= 0 THEN v_rate := 0.42; END IF;
  v_start_date := date_trunc('month', (now() AT TIME ZONE 'Asia/Manila')::date - interval '5 months')::date;
  v_end_date := (now() AT TIME ZONE 'Asia/Manila')::date;
  RETURN QUERY
  SELECT to_char(p.date_paid, 'YYYY-MM') AS month,
         la.payment_plan_months,
         SUM(CASE WHEN p.currency = 'JPY' THEN p.amount_paid ELSE ROUND(p.amount_paid / v_rate) END)::numeric AS jpy_total
  FROM payments p
  JOIN layaway_accounts la ON la.id = p.account_id
  WHERE p.voided_at IS NULL
    AND p.date_paid >= v_start_date
    AND p.date_paid <= v_end_date
    AND la.is_test = false
  GROUP BY 1, 2
  ORDER BY 1, 2;
END;
$function$;

CREATE OR REPLACE FUNCTION public.move_to_dlq(source_queue text, dlq_name text, message_id bigint, payload jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE new_id BIGINT;
BEGIN
  SELECT pgmq.send(dlq_name, payload) INTO new_id;
  PERFORM pgmq.delete(source_queue, message_id);
  RETURN new_id;
EXCEPTION WHEN undefined_table THEN
  BEGIN
    PERFORM pgmq.create(dlq_name);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  SELECT pgmq.send(dlq_name, payload) INTO new_id;
  BEGIN
    PERFORM pgmq.delete(source_queue, message_id);
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;
  RETURN new_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.notify_account_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.staff_notify(
      'account_created', 'Account created',
      'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
      NEW.id, NEW.customer_id, NEW.invoice_number, '{}'::jsonb
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notify_cash_order_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.staff_notify(
      'account_created', 'Cash order created',
      'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
      NULL, NEW.customer_id, NEW.invoice_number,
      jsonb_build_object('cash_order_id', NEW.id)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notify_customer_notified()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    IF NEW.notified = true AND (TG_OP = 'INSERT' OR COALESCE(OLD.notified, false) = false) THEN
      PERFORM public.staff_notify(
        'customer_notified', 'Customer notified',
        'Inv #' || COALESCE(NEW.invoice_number,'?') || ' — notified by ' || COALESCE(NEW.notified_by_name,'Unknown')
          || COALESCE(' via ' || NEW.contact_method, ''),
        NEW.account_id, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object('reminder_stage', NEW.reminder_stage)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notify_extension_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice text;
  v_customer_name text;
  v_customer_email text;
  v_auth_user_id uuid;
  v_token text;
  v_portal_url text;
  v_currency text;
  v_remaining numeric;
  v_amount_str text;
BEGIN
  BEGIN
    SELECT invoice_number INTO v_invoice FROM public.layaway_accounts WHERE id = NEW.account_id;
    IF TG_OP = 'INSERT' THEN
      PERFORM public.staff_notify(
        'extension_requested',
        'Extension requested',
        'Inv #' || COALESCE(v_invoice,'?') || COALESCE(' — ' || NEW.reason, ''),
        NEW.account_id, NEW.customer_id, v_invoice, '{}'::jsonb
      );
      BEGIN
        SELECT c.full_name, c.email, c.auth_user_id
        INTO v_customer_name, v_customer_email, v_auth_user_id
        FROM public.customers c WHERE c.id = NEW.customer_id;

        IF v_customer_email IS NOT NULL AND btrim(v_customer_email) <> '' THEN
          IF v_auth_user_id IS NOT NULL THEN
            v_portal_url := 'https://portal.chajewelsjp.com/portal';
          ELSE
            v_token := NEW.portal_token;
            IF v_token IS NULL THEN
              SELECT t.token INTO v_token
              FROM public.customer_portal_tokens t
              WHERE t.customer_id = NEW.customer_id
                AND t.is_active = true
                AND (t.expires_at IS NULL OR t.expires_at > now())
              ORDER BY t.expires_at DESC NULLS FIRST
              LIMIT 1;
            END IF;
            v_portal_url := CASE
              WHEN v_token IS NOT NULL
                THEN 'https://portal.chajewelsjp.com/portal?token=' || v_token
              ELSE 'https://portal.chajewelsjp.com/portal'
            END;
          END IF;

          SELECT la.currency, la.remaining_balance INTO v_currency, v_remaining
          FROM public.layaway_accounts la WHERE la.id = NEW.account_id;

          v_amount_str :=
            CASE
              WHEN v_remaining IS NULL THEN ''
              WHEN upper(COALESCE(v_currency,'PHP')) = 'JPY'
                THEN '¥' || to_char(round(v_remaining), 'FM999,999,999,990')
              WHEN v_remaining = trunc(v_remaining)
                THEN '₱' || to_char(v_remaining, 'FM999,999,999,990')
              ELSE '₱' || to_char(v_remaining, 'FM999,999,999,990.00')
            END;

          PERFORM net.http_post(
            url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/send-transactional-email',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
            ),
            body := jsonb_build_object(
              'template_name', 'extension-requested',
              'recipient_email', v_customer_email,
              'templateData', jsonb_build_object(
                'customerName', COALESCE(v_customer_name, 'Valued customer'),
                'invoiceNumber', COALESCE(v_invoice, '?'),
                'reason', COALESCE(NULLIF(btrim(NEW.reason), ''), 'No reason provided'),
                'currency', COALESCE(v_currency, ''),
                'remainingBalance', v_amount_str,
                'portalUrl', v_portal_url
              )
            )
          );
        END IF;
      EXCEPTION WHEN OTHERS THEN NULL;
      END;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.staff_notify(
        'extension_' || NEW.status::text,
        'Extension ' || NEW.status::text,
        'Inv #' || COALESCE(v_invoice,'?') || ' — ' || NEW.status::text || ' by ' || public.staff_display_name(NEW.reviewed_by),
        NEW.account_id, NEW.customer_id, v_invoice, '{}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.notify_loyalty_enrolled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text;
BEGIN
  BEGIN
    SELECT full_name INTO v_name FROM public.customers WHERE id = NEW.customer_id;
    PERFORM public.staff_notify(
      'loyalty_enrolled', 'New loyalty member',
      COALESCE(v_name, 'Unknown customer') || ' enrolled in the loyalty program',
      NULL, NEW.customer_id, NULL,
      jsonb_build_object('member_id', NEW.id)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notify_submission_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_invoice text;
BEGIN
  BEGIN
    SELECT invoice_number INTO v_invoice
      FROM public.layaway_accounts WHERE id = NEW.account_id;
    IF v_invoice IS NULL AND NEW.cash_order_id IS NOT NULL THEN
      SELECT invoice_number INTO v_invoice
        FROM public.cash_orders WHERE id = NEW.cash_order_id;
    END IF;
    PERFORM public.staff_notify(
      'submission_created',
      'New payment submission',
      COALESCE(
        NEW.sender_name,
        (SELECT full_name FROM public.customers WHERE id = NEW.customer_id),
        'Unknown sender'
      )
      || ' submitted ' || COALESCE(NEW.submitted_amount::text, '?')
      || COALESCE(' · Inv #' || v_invoice, ''),
      NEW.account_id,
      NEW.customer_id,
      v_invoice,
      jsonb_build_object('submission_id', NEW.id, 'method', NEW.payment_method)
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.notify_submission_reviewed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_invoice text;
BEGIN
  BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status::text IN ('confirmed','rejected') THEN
      SELECT invoice_number INTO v_invoice FROM public.layaway_accounts WHERE id = NEW.account_id;
      IF v_invoice IS NULL AND NEW.cash_order_id IS NOT NULL THEN
        SELECT invoice_number INTO v_invoice FROM public.cash_orders WHERE id = NEW.cash_order_id;
      END IF;
      PERFORM public.staff_notify(
        'submission_' || NEW.status::text, 'Payment ' || NEW.status::text,
        COALESCE(NEW.submitted_amount::text,'?') || ' from ' || COALESCE(NEW.sender_name,'Unknown')
          || ' ' || NEW.status::text || ' by ' || public.staff_display_name(NEW.reviewer_user_id)
          || COALESCE(' · Inv #' || v_invoice, ''),
        NEW.account_id, NEW.customer_id, v_invoice,
        jsonb_build_object('submission_id', NEW.id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notify_tier_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_name text; v_old text; v_new text;
BEGIN
  BEGIN
    IF NEW.current_tier_id IS DISTINCT FROM OLD.current_tier_id THEN
      SELECT full_name INTO v_name FROM public.customers WHERE id = NEW.customer_id;
      SELECT name INTO v_old FROM public.loyalty_tiers WHERE id = OLD.current_tier_id;
      SELECT name INTO v_new FROM public.loyalty_tiers WHERE id = NEW.current_tier_id;
      PERFORM public.staff_notify(
        'tier_changed', 'Loyalty tier changed',
        COALESCE(v_name, 'Unknown customer') || ': ' || COALESCE(v_old, '?') || ' → ' || COALESCE(v_new, '?'),
        NULL, NEW.customer_id, NULL,
        jsonb_build_object('member_id', NEW.id, 'old_tier_id', OLD.current_tier_id, 'new_tier_id', NEW.current_tier_id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notify_waiver_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_invoice text;
BEGIN
  BEGIN
    SELECT invoice_number INTO v_invoice FROM public.layaway_accounts WHERE id = NEW.account_id;
    IF TG_OP = 'INSERT' THEN
      PERFORM public.staff_notify(
        'waiver_requested', 'Waiver requested',
        'Inv #' || COALESCE(v_invoice,'?') || ' — ' || COALESCE(NEW.penalty_amount::text,'?')
          || ' requested by ' || public.staff_display_name(NEW.requested_by_user_id),
        NEW.account_id, NULL, v_invoice, jsonb_build_object('penalty_fee_id', NEW.penalty_fee_id)
      );
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      PERFORM public.staff_notify(
        'waiver_' || NEW.status::text, 'Waiver ' || NEW.status::text,
        'Inv #' || COALESCE(v_invoice,'?') || ' — ' || COALESCE(NEW.penalty_amount::text,'?')
          || ' ' || NEW.status::text || ' by ' || public.staff_display_name(NEW.approved_by_user_id),
        NEW.account_id, NULL, v_invoice, jsonb_build_object('penalty_fee_id', NEW.penalty_fee_id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.prevent_base_amount_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Allow admin bypass for installment_number renumbering
  IF current_setting('app.bypass_immutable_schedule_cols', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.base_installment_amount IS DISTINCT FROM OLD.base_installment_amount THEN
    RAISE EXCEPTION
      'base_installment_amount is immutable after creation. Attempted change from % to % on schedule %',
      OLD.base_installment_amount, NEW.base_installment_amount, OLD.id;
  END IF;
  IF NEW.installment_number IS DISTINCT FROM OLD.installment_number THEN
    RAISE EXCEPTION
      'installment_number is immutable after creation on schedule %', OLD.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_birthday_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.birthday_locked_at IS NOT NULL THEN
    IF NEW.birthday_locked_at IS NULL THEN
      RAISE EXCEPTION 'Birthday lock cannot be removed';
    END IF;
    IF NEW.birthday IS DISTINCT FROM OLD.birthday THEN
      IF NEW.birthday_admin_edits_used IS DISTINCT FROM COALESCE(OLD.birthday_admin_edits_used, 0) + 1 THEN
        RAISE EXCEPTION 'Birthday is locked and cannot be changed';
      END IF;
      IF COALESCE(OLD.birthday_admin_edits_used, 0) >= 1 THEN
        RAISE EXCEPTION 'Birthday admin-correction limit (1) reached';
      END IF;
    ELSE
      IF NEW.birthday_admin_edits_used IS DISTINCT FROM OLD.birthday_admin_edits_used THEN
        RAISE EXCEPTION 'birthday_admin_edits_used may only change with a birthday correction';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_customer_code_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.customer_code IS DISTINCT FROM OLD.customer_code THEN
    IF current_setting('app.allow_customer_code_change', true) = 'on' THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'customer_code is immutable post-creation. For forensic repair: SET LOCAL app.allow_customer_code_change = ''on''; before UPDATE. See CLAUDE.md "CUSTOMER CODE STANDARD" → Forensic repair.'
      USING HINT = 'Frontend EditCustomerDialog excludes customer_code. To repair, use SQL Editor with the GUC bypass and add a manual audit_logs entry.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_paid_row_modification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF OLD.status = 'paid' THEN
    -- Rule 1: bypass flag allows all changes (test resets, manual admin)
    IF current_setting('app.allow_paid_row_edit', true) = 'true' THEN
      RETURN NEW;
    END IF;

    -- Rule 2: paid_amount decreasing → allow (void-payment reverting)
    IF NEW.paid_amount <= OLD.paid_amount THEN
      RETURN NEW;
    END IF;

    -- Rule 3: paid_amount increasing within ceiling → allow (restore-payment)
    IF NEW.paid_amount > OLD.paid_amount
      AND NEW.paid_amount <=
        OLD.base_installment_amount
        + COALESCE(OLD.penalty_amount, 0)
        + COALESCE(OLD.carried_amount, 0) THEN
      RETURN NEW;
    END IF;

    -- Rule 4: paid_amount increasing beyond ceiling → BLOCK
    RAISE EXCEPTION
      'Schedule row % is paid and frozen. '
      'Cannot increase paid_amount beyond ceiling on a paid row.',
      OLD.id;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_payment_backup_modification()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'payment_history_backup is immutable — records cannot be updated or deleted. This is the source of truth.';
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_schedule_deletion()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('app.allow_schedule_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Direct deletion of layaway_schedule rows blocked. Bug #6 Stage 2 enforcement (2026-05-17). Use delete-installment edge function or delete_account_atomic RPC.'
    USING HINT = 'If a legitimate operation requires direct deletion, prefix with: SET LOCAL app.allow_schedule_delete = ''on'';',
          ERRCODE = '42501';
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_total_amount_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_admin boolean;
BEGIN
  -- Allow if total_amount unchanged
  IF NEW.total_amount = OLD.total_amount THEN
    RETURN NEW;
  END IF;

  -- Allow bypass flag (for edge functions)
  IF current_setting('app.allow_total_amount_edit', true) = 'true' THEN
    RETURN NEW;
  END IF;

  -- Check if current user is admin
  SELECT has_role(auth.uid(), 'admin') INTO v_is_admin;

  IF NOT v_is_admin THEN
    RAISE EXCEPTION
      'total_amount can only be modified by admin. Use add-installment or add-service edge functions.';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.read_email_batch(queue_name text, batch_size integer, vt integer)
 RETURNS TABLE(msg_id bigint, read_ct integer, message jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY SELECT r.msg_id, r.read_ct, r.message FROM pgmq.read(queue_name, vt, batch_size) r;
EXCEPTION WHEN undefined_table THEN
  PERFORM pgmq.create(queue_name);
  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_failing_accounts()
 RETURNS TABLE(invoice_number text, old_remaining numeric, new_remaining numeric, old_total_paid numeric, new_total_paid numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row record;
  v_account_id uuid;
  v_total_amount numeric;
  v_total_paid numeric;
  v_active_penalties numeric;
  v_new_remaining numeric;
  v_old_remaining numeric;
  v_old_total_paid numeric;
BEGIN
  FOR v_row IN
    SELECT a.invoice_number 
    FROM audit_all_accounts() a 
    WHERE a.all_pass = false
  LOOP
    SELECT la.id, la.total_amount, la.remaining_balance, la.total_paid
    INTO v_account_id, v_total_amount, v_old_remaining, v_old_total_paid
    FROM layaway_accounts la
    WHERE la.invoice_number = v_row.invoice_number;

    SELECT COALESCE(SUM(p.amount_paid), 0)
    INTO v_total_paid
    FROM payments p
    WHERE p.account_id = v_account_id 
      AND p.voided_at IS NULL;

    SELECT COALESCE(SUM(pf.penalty_amount), 0)
    INTO v_active_penalties
    FROM penalty_fees pf
    WHERE pf.account_id = v_account_id 
      AND pf.status != 'waived';

    v_new_remaining := GREATEST(0, v_total_amount + v_active_penalties - v_total_paid);

    UPDATE layaway_accounts la
    SET 
      total_paid = v_total_paid,
      remaining_balance = v_new_remaining
    WHERE la.id = v_account_id;

    invoice_number := v_row.invoice_number;
    old_remaining := v_old_remaining;
    new_remaining := v_new_remaining;
    old_total_paid := v_old_total_paid;
    new_total_paid := v_total_paid;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.restore_lots_for_redemption(p_redemption_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_consumption record;
  v_total_restored integer := 0;
BEGIN
  FOR v_consumption IN
    SELECT cons.id, cons.lot_id, cons.amount
      FROM public.loyalty_lot_consumption AS cons
     WHERE cons.redemption_id = p_redemption_id
       AND cons.restored_at IS NULL
     FOR UPDATE
  LOOP
    UPDATE public.loyalty_point_lots AS lots
       SET remaining_amount = lots.remaining_amount + v_consumption.amount,
           consumed_at      = NULL,
           updated_at       = now()
     WHERE lots.id = v_consumption.lot_id;

    UPDATE public.loyalty_lot_consumption AS cons
       SET restored_at     = now(),
           restored_amount = v_consumption.amount
     WHERE cons.id = v_consumption.id;

    v_total_restored := v_total_restored + v_consumption.amount;
  END LOOP;

  RETURN v_total_restored;
END;
$function$;

CREATE OR REPLACE FUNCTION public.restore_loyalty_points(p_revoke_transaction_id uuid, p_created_by_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_revoke RECORD;
  v_old_lot RECORD;
  v_new_tx_id UUID;
  v_total_restored_remaining NUMERIC := 0;
  v_total_restored_original NUMERIC := 0;
  v_member RECORD;
  v_current_tier_name TEXT;
  v_new_cumulative NUMERIC;
  v_new_tier_id UUID;
BEGIN
  -- Load original revoke transaction
  SELECT * INTO v_revoke FROM loyalty_transactions
   WHERE id = p_revoke_transaction_id AND transaction_type = 'revoked';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore: revoke transaction % not found', p_revoke_transaction_id;
  END IF;

  -- Idempotency check
  SELECT id INTO v_new_tx_id FROM loyalty_transactions
   WHERE member_id = v_revoke.member_id
     AND transaction_type = 'earned'
     AND notes LIKE '%Restored from revoke ' || p_revoke_transaction_id::text || '%'
   LIMIT 1;
  IF FOUND THEN
    RAISE NOTICE 'restore: already done as transaction %', v_new_tx_id;
    RETURN v_new_tx_id;
  END IF;

  -- Load member + current tier
  SELECT m.*, t.name AS tier_name
    INTO v_member
    FROM loyalty_members m
    LEFT JOIN loyalty_tiers t ON t.id = m.current_tier_id
   WHERE m.id = v_revoke.member_id;
  v_current_tier_name := v_member.tier_name;

  -- Insert restore transaction
  INSERT INTO loyalty_transactions (
    member_id, account_id, cash_order_id, payment_id, transaction_type,
    points_amount, spend_amount_jpy, invoice_number, tier_at_time, notes,
    created_by_user_id
  ) VALUES (
    v_revoke.member_id, v_revoke.account_id, v_revoke.cash_order_id, v_revoke.payment_id, 'earned',
    v_revoke.points_amount, v_revoke.spend_amount_jpy, v_revoke.invoice_number, v_current_tier_name,
    'Restored from revoke ' || p_revoke_transaction_id::text,
    p_created_by_user_id
  ) RETURNING id INTO v_new_tx_id;

  -- Create new lot for each previously revoked lot, inheriting expires_at AND spend_basis_jpy
  FOR v_old_lot IN
    SELECT * FROM loyalty_point_lots WHERE revoked_by_transaction_id = p_revoke_transaction_id
  LOOP
    INSERT INTO loyalty_point_lots (
      member_id, source_type, source_reference,
      original_amount, remaining_amount, spend_basis_jpy,
      earned_at, expires_at, expired_at, notes
    ) VALUES (
      v_old_lot.member_id,
      v_old_lot.source_type,
      v_old_lot.source_reference,
      v_old_lot.original_amount,
      CASE WHEN v_old_lot.expires_at <= NOW() THEN 0
           ELSE v_old_lot.remaining_amount
      END,
      v_old_lot.spend_basis_jpy,
      NOW(),
      v_old_lot.expires_at,
      CASE WHEN v_old_lot.expires_at <= NOW() THEN NOW()
           ELSE NULL
      END,
      'Restored from revoke ' || p_revoke_transaction_id::text
    );
    v_total_restored_original := v_total_restored_original + v_old_lot.original_amount;
    IF v_old_lot.expires_at IS NULL OR v_old_lot.expires_at > NOW() THEN  -- ← FIX: treat NULL expiry as not-expired
      v_total_restored_remaining := v_total_restored_remaining + v_old_lot.remaining_amount;
    END IF;
  END LOOP;

  -- Restore counters
  UPDATE loyalty_members
     SET remaining_points = remaining_points + v_total_restored_remaining,
         total_points_earned = total_points_earned + v_total_restored_original,
         cumulative_spend_jpy = cumulative_spend_jpy + v_revoke.spend_amount_jpy,
         updated_at = NOW()
   WHERE id = v_revoke.member_id
   RETURNING cumulative_spend_jpy INTO v_new_cumulative;

  -- Tier re-eval
  SELECT id INTO v_new_tier_id
    FROM loyalty_tiers
   WHERE min_spend_jpy <= v_new_cumulative
   ORDER BY min_spend_jpy DESC
   LIMIT 1;

  IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN
    UPDATE loyalty_members
       SET current_tier_id = v_new_tier_id,
           is_downgraded = (v_new_tier_id IS DISTINCT FROM v_member.earned_tier_id),
           updated_at = NOW()
     WHERE id = v_revoke.member_id;
    RAISE NOTICE 'restore: tier change for member %, new tier %', v_revoke.member_id, v_new_tier_id;
  END IF;

  RETURN v_new_tx_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revalidate_account_from_vault(p_invoice_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id        uuid;
  v_vault_total       numeric;
  v_live_total        numeric;
  v_vault_voided      numeric;
  v_remaining         numeric;
  v_total_amount      numeric;
  v_active_penalties  numeric;
  v_services          numeric;
BEGIN
  SELECT id, total_amount, remaining_balance
  INTO v_account_id, v_total_amount, v_remaining
  FROM layaway_accounts
  WHERE invoice_number = p_invoice_number;

  IF v_account_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Account not found');
  END IF;

  SELECT COALESCE(SUM(amount), 0)
  INTO v_vault_total
  FROM payment_history_backup
  WHERE account_id = v_account_id
    AND event_type = 'approved';

  SELECT COUNT(*)
  INTO v_vault_voided
  FROM payment_history_backup
  WHERE account_id = v_account_id
    AND event_type = 'voided';

  SELECT COALESCE(SUM(amount_paid), 0)
  INTO v_live_total
  FROM payments
  WHERE account_id = v_account_id
    AND voided_at IS NULL;

  SELECT COALESCE(SUM(penalty_amount), 0)
  INTO v_active_penalties
  FROM penalty_fees
  WHERE account_id = v_account_id
    AND status != 'waived';

  SELECT COALESCE(SUM(amount), 0)
  INTO v_services
  FROM account_services
  WHERE account_id = v_account_id;

  RETURN jsonb_build_object(
    'invoice_number',       p_invoice_number,
    'vault_total_paid',     v_vault_total,
    'live_total_paid',      v_live_total,
    'totals_match',         (v_vault_total = v_live_total),
    'drift_amount',         (v_live_total - v_vault_total),
    'vault_voided_count',   v_vault_voided,
    'remaining_balance',    v_remaining,
    'expected_remaining',   (v_total_amount + v_active_penalties + v_services - v_vault_total),
    'remaining_match',      (v_remaining = (v_total_amount + v_active_penalties + v_services - v_vault_total)),
    'checks', jsonb_build_object(
      'vault_matches_live',         (v_vault_total = v_live_total),
      'remaining_balance_correct',  (v_remaining = (v_total_amount + v_active_penalties + v_services - v_vault_total)),
      'has_voided_payments',        (v_vault_voided > 0)
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_loyalty_points(p_member_id uuid, p_source_reference text, p_spend_jpy numeric, p_account_id uuid DEFAULT NULL::uuid, p_cash_order_id uuid DEFAULT NULL::uuid, p_payment_id uuid DEFAULT NULL::uuid, p_invoice_number text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_created_by_user_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id UUID;
  v_existing_tx UUID;
  v_total_remaining NUMERIC := 0;
  v_total_original NUMERIC := 0;
  v_total_spend_basis NUMERIC := 0;
  v_lot_count INTEGER := 0;
  v_member RECORD;
  v_current_tier_name TEXT;
  v_new_cumulative NUMERIC;
  v_new_tier_id UUID;
BEGIN
  -- Idempotency: payment_id — only block if NO active lots exist (truly idempotent state)
  IF p_payment_id IS NOT NULL THEN
    SELECT id INTO v_existing_tx
    FROM loyalty_transactions
    WHERE payment_id = p_payment_id AND transaction_type = 'revoked'
    ORDER BY created_at DESC LIMIT 1;
    IF v_existing_tx IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM loyalty_point_lots
      WHERE member_id = p_member_id
      AND source_reference = p_source_reference
      AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL
    ) THEN
      RAISE NOTICE 'revoke: already revoked for payment %, returning existing tx', p_payment_id;
      RETURN v_existing_tx;
    END IF;
  END IF;

  -- Idempotency: cash_order_id — same active-lots-aware logic
  IF p_cash_order_id IS NOT NULL THEN
    SELECT id INTO v_existing_tx
    FROM loyalty_transactions
    WHERE cash_order_id = p_cash_order_id AND transaction_type = 'revoked'
    ORDER BY created_at DESC LIMIT 1;
    IF v_existing_tx IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM loyalty_point_lots
      WHERE member_id = p_member_id
      AND source_reference = p_source_reference
      AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL
    ) THEN
      RAISE NOTICE 'revoke: already revoked for cash order %, returning existing tx', p_cash_order_id;
      RETURN v_existing_tx;
    END IF;
  END IF;

  -- Load member
  SELECT m.*, t.name AS tier_name INTO v_member
  FROM loyalty_members m
  LEFT JOIN loyalty_tiers t ON t.id = m.current_tier_id
  WHERE m.id = p_member_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'revoke: member % not found', p_member_id;
  END IF;
  v_current_tier_name := v_member.tier_name;

  SELECT COALESCE(SUM(remaining_amount), 0),
    COALESCE(SUM(original_amount), 0),
    COALESCE(SUM(spend_basis_jpy), 0),
    COUNT(*)
  INTO v_total_remaining, v_total_original, v_total_spend_basis, v_lot_count
  FROM loyalty_point_lots
  WHERE member_id = p_member_id
    AND source_reference = p_source_reference
    AND revoked_at IS NULL
    AND consumed_at IS NULL
    AND expired_at IS NULL;

  IF v_lot_count = 0 THEN
    RAISE NOTICE 'revoke: no active lots for source %, no-op', p_source_reference;
    RETURN NULL;
  END IF;

  INSERT INTO loyalty_transactions (
    member_id, account_id, cash_order_id, payment_id,
    transaction_type, points_amount, spend_amount_jpy,
    invoice_number, tier_at_time, notes, created_by_user_id
  ) VALUES (
    p_member_id, p_account_id, p_cash_order_id, p_payment_id,
    'revoked', -v_total_original, v_total_spend_basis,
    p_invoice_number, v_current_tier_name,
    COALESCE(p_notes, 'Revoked: ' || p_source_reference), p_created_by_user_id
  ) RETURNING id INTO v_transaction_id;

  UPDATE loyalty_point_lots
  SET revoked_at = NOW(), revoked_by_transaction_id = v_transaction_id, updated_at = NOW()
  WHERE member_id = p_member_id AND source_reference = p_source_reference
  AND revoked_at IS NULL AND consumed_at IS NULL AND expired_at IS NULL;

  UPDATE loyalty_members
  SET remaining_points = GREATEST(0, remaining_points - v_total_remaining),
  total_points_earned = GREATEST(0, total_points_earned - v_total_original),
  cumulative_spend_jpy = GREATEST(0, cumulative_spend_jpy - v_total_spend_basis),
  updated_at = NOW()
  WHERE id = p_member_id
  RETURNING cumulative_spend_jpy INTO v_new_cumulative;

  SELECT id INTO v_new_tier_id
  FROM loyalty_tiers
  WHERE min_spend_jpy <= v_new_cumulative
  ORDER BY min_spend_jpy DESC LIMIT 1;

  IF v_new_tier_id IS DISTINCT FROM v_member.current_tier_id THEN
    UPDATE loyalty_members
    SET current_tier_id = v_new_tier_id,
    is_downgraded = (v_new_tier_id IS DISTINCT FROM v_member.earned_tier_id),
    updated_at = NOW()
    WHERE id = p_member_id;
    RAISE NOTICE 'revoke: tier change for member %, new tier %', p_member_id, v_new_tier_id;
  END IF;

  RETURN v_transaction_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_completed_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'completed' AND OLD.status != 'completed' THEN
    NEW.completed_at = now();
  END IF;
  IF NEW.status != 'completed' AND OLD.status = 'completed' THEN
    NEW.completed_at = NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_timesheet_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.staff_display_name(p_user_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT full_name FROM public.profiles WHERE user_id = p_user_id), 'Unknown')
$function$;

CREATE OR REPLACE FUNCTION public.staff_notify(p_type text, p_title text, p_body text, p_account_id uuid, p_customer_id uuid, p_invoice text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
  VALUES (p_type, p_title, p_body, p_account_id, p_customer_id, p_invoice, p_meta)
$function$;

CREATE OR REPLACE FUNCTION public.sync_auth_email_to_customer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.customers
    SET email = NEW.email, updated_at = now()
    WHERE auth_user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.timesheet_can_view_all(uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.timesheet_profiles
    WHERE user_id = uid AND can_view_all
  );
$function$;

CREATE OR REPLACE FUNCTION public.unwaive_penalty_atomic(p_waiver_id uuid, p_user_id uuid, p_user_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_waiver RECORD;
  v_penalty RECORD;
  v_account RECORD;
  v_total_active_penalty_sched numeric;
  v_total_active_penalty_acct numeric;
  v_base numeric;
  v_carried numeric;
  v_services_sum numeric;
  v_payments_sum numeric;
  v_new_remaining numeric;
  v_new_account_status text;
  v_any_overdue boolean;
BEGIN
  SELECT * INTO v_waiver
  FROM public.penalty_waiver_requests
  WHERE id = p_waiver_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error_code', 'waiver_not_found'); END IF;
  IF v_waiver.status::text != 'approved' THEN RETURN jsonb_build_object('error_code', 'waiver_not_approved'); END IF;

  SELECT * INTO v_penalty
  FROM public.penalty_fees
  WHERE id = v_waiver.penalty_fee_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error_code', 'penalty_not_found'); END IF;

  SELECT * INTO v_account
  FROM public.layaway_accounts
  WHERE id = v_waiver.account_id
  FOR UPDATE;
  IF v_account.status::text IN ('forfeited', 'final_forfeited') THEN
    RETURN jsonb_build_object('error_code', 'account_terminal_state');
  END IF;

  UPDATE public.penalty_waiver_requests
  SET status = 'pending',
      approved_at = NULL,
      approved_by_user_id = NULL,
      rejected_at = NULL
  WHERE id = p_waiver_id;

  UPDATE public.penalty_fees
  SET status = 'unpaid',
      waived_at = NULL
  WHERE id = v_waiver.penalty_fee_id;

  SELECT COALESCE(SUM(penalty_amount), 0) INTO v_total_active_penalty_sched
  FROM public.penalty_fees
  WHERE schedule_id = v_waiver.schedule_id AND status::text != 'waived';

  SELECT base_installment_amount, COALESCE(carried_amount, 0)
  INTO v_base, v_carried
  FROM public.layaway_schedule
  WHERE id = v_waiver.schedule_id;

  UPDATE public.layaway_schedule
  SET penalty_amount = v_total_active_penalty_sched,
      total_due_amount = v_base + v_total_active_penalty_sched + v_carried
  WHERE id = v_waiver.schedule_id;

  SELECT COALESCE(SUM(penalty_amount), 0) INTO v_total_active_penalty_acct
  FROM public.penalty_fees
  WHERE account_id = v_waiver.account_id AND status::text != 'waived';

  SELECT COALESCE(SUM(amount), 0) INTO v_services_sum
  FROM public.account_services
  WHERE account_id = v_waiver.account_id;

  SELECT COALESCE(SUM(amount_paid), 0) INTO v_payments_sum
  FROM public.payments
  WHERE account_id = v_waiver.account_id AND voided_at IS NULL;

  v_new_remaining := GREATEST(0, v_account.total_amount + v_total_active_penalty_acct + v_services_sum - v_payments_sum);

  v_new_account_status := v_account.status::text;
  IF v_account.status::text = 'completed' AND v_new_remaining > 0.01 THEN
    SELECT EXISTS(
      SELECT 1 FROM public.layaway_schedule
      WHERE account_id = v_waiver.account_id AND status::text = 'overdue'
    ) INTO v_any_overdue;
    v_new_account_status := CASE WHEN v_any_overdue THEN 'overdue' ELSE 'active' END;
  END IF;

  UPDATE public.layaway_accounts
  SET remaining_balance = v_new_remaining,
      status = v_new_account_status::account_status
  WHERE id = v_waiver.account_id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, action, performed_by_user_id, new_value_json
  ) VALUES (
    'penalty_waiver',
    v_waiver.account_id,
    'waiver_unwaived',
    p_user_id,
    jsonb_build_object(
      'waiver_id', p_waiver_id,
      'penalty_fee_id', v_waiver.penalty_fee_id,
      'penalty_amount', v_penalty.penalty_amount,
      'penalty_status_before', v_penalty.status,
      'new_remaining_balance', v_new_remaining,
      'account_status_before', v_account.status,
      'account_status_after', v_new_account_status,
      'user_email', p_user_email
    )
  );

  RETURN jsonb_build_object(
    'unwaived', true,
    'waiver_id', p_waiver_id,
    'penalty_fee_id', v_waiver.penalty_fee_id,
    'penalty_amount', v_penalty.penalty_amount,
    'new_remaining_balance', v_new_remaining,
    'account_status', v_new_account_status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_cash_orders_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_loyalty_members_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_loyalty_promos_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$function$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_bulk_import(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_result JSONB := '[]'::JSONB;
  v_row JSONB;
  v_account RECORD;
  v_duplicate RECORD;
  v_errors JSONB;
BEGIN
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_errors := '[]'::JSONB;
    
    -- Check 1: Account exists
    SELECT id, invoice_number, status, remaining_balance, currency
    INTO v_account
    FROM layaway_accounts
    WHERE invoice_number = (v_row->>'invoice_number');
    
    IF NOT FOUND THEN
      v_errors := v_errors || '["Invalid account number"]'::JSONB;
    ELSE
      -- Check 2: Amount exceeds remaining balance
      IF (v_row->>'amount_paid')::numeric > v_account.remaining_balance THEN
        v_errors := v_errors || 
          format('["Amount ₱%s exceeds remaining balance ₱%s"]',
            v_row->>'amount_paid', 
            v_account.remaining_balance)::JSONB;
      END IF;
      
      -- Check 3: Duplicate payment
      SELECT id INTO v_duplicate
      FROM payments
      WHERE account_id = v_account.id
        AND amount_paid = (v_row->>'amount_paid')::numeric
        AND date_paid = (v_row->>'date_paid')::date
        AND voided_at IS NULL;
      
      IF FOUND THEN
        v_errors := v_errors || '["Duplicate payment detected"]'::JSONB;
      END IF;
      
      -- Check 4: Account status
      IF v_account.status IN ('completed', 'forfeited', 
                               'final_forfeited', 'cancelled') THEN
        v_errors := v_errors || 
          format('["Account is %s — cannot accept payments"]',
            v_account.status)::JSONB;
      END IF;
    END IF;
    
    v_result := v_result || jsonb_build_object(
      'invoice_number', v_row->>'invoice_number',
      'amount_paid', v_row->>'amount_paid',
      'date_paid', v_row->>'date_paid',
      'payment_method', v_row->>'payment_method',
      'remarks', v_row->>'remarks',
      'valid', jsonb_array_length(v_errors) = 0,
      'errors', v_errors
    );
  END LOOP;
  
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_schedule_chronology()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  prev_due date;
BEGIN
  -- Only validate if installment_number > 1
  IF NEW.installment_number > 1 THEN
    SELECT due_date INTO prev_due
    FROM public.layaway_schedule
    WHERE account_id = NEW.account_id
      AND installment_number = NEW.installment_number - 1
      AND status != 'cancelled';
    
    IF prev_due IS NOT NULL AND NEW.due_date <= prev_due THEN
      RAISE EXCEPTION 'Schedule chronology violation: installment % due_date (%) must be after installment % due_date (%)',
        NEW.installment_number, NEW.due_date, NEW.installment_number - 1, prev_due;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_schedule_start_year()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  m integer;
  y integer;
BEGIN
  IF NEW.installment_number = 1 THEN
    m := EXTRACT(MONTH FROM NEW.due_date);
    y := EXTRACT(YEAR FROM NEW.due_date);
    IF m BETWEEN 9 AND 12 AND y != 2025 THEN
      RAISE EXCEPTION 'Start year rule violation: installment 1 in month % must be year 2025, got %', m, y;
    END IF;
    IF m BETWEEN 1 AND 8 AND y != 2026 THEN
      RAISE EXCEPTION 'Start year rule violation: installment 1 in month % must be year 2026, got %', m, y;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  m record;
  v_pts integer;
  v_before_balance integer;
  v_new_remaining integer;
  v_tier_name text;
  v_refund_tx_id uuid;
  v_updated_count integer;
  v_stock_re_incremented boolean := false;
  v_reward record;
  v_jpy_to_restore numeric := 0;
  v_currency text;
  v_synth_payment record;
  v_alloc record;
  v_sched record;
  v_new_paid numeric;
  v_new_status text;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_acct record;
  v_refund_amount numeric := 0;
  v_new_total_paid numeric;
  v_new_remaining_balance numeric;
  v_any_overdue boolean;
  v_new_account_status text;
  v_cash_synth record;
  v_cash_new_total numeric;
  v_cash_order record;
  v_cash_new_remaining numeric;
  v_truncated_reason text;
  v_void_notes text;
  v_ref_ref text;
  v_note text;
  v_order_side_done boolean := false;
BEGIN
  v_truncated_reason := substring(coalesce(p_void_reason, ''), 1, 250);
  
  -- ---------------------------------------------------------------------
  -- Step 1: Lock redemption row, validate status
  -- ---------------------------------------------------------------------
  SELECT id, status, member_id, reward_id, redemption_type, points_redeemed,
         transaction_id, account_id, cash_order_id, invoice_number, value_applied_jpy
  INTO r
  FROM public.loyalty_redemptions
  WHERE id = p_redemption_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'redemption_not_found' USING ERRCODE = 'P0001';
  END IF;
  
  IF r.status <> 'confirmed' THEN
    RAISE EXCEPTION 'redemption_not_confirmed: %', r.status USING ERRCODE = 'P0001';
  END IF;
  
  v_pts := r.points_redeemed;
  v_ref_ref := 'LOYALTY-' || r.id::text;
  v_void_notes := 'Loyalty redemption voided: ' || v_truncated_reason;
  
  -- ---------------------------------------------------------------------
  -- Step 2: Lock member row, fetch tier name
  -- ---------------------------------------------------------------------
  SELECT id, remaining_points, total_points_redeemed, current_tier_id
  INTO m
  FROM public.loyalty_members
  WHERE id = r.member_id
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'P0001';
  END IF;
  
  v_before_balance := COALESCE(m.remaining_points, 0);
  v_new_remaining := v_before_balance + v_pts;
  
  SELECT name INTO v_tier_name
  FROM public.loyalty_tiers
  WHERE id = m.current_tier_id;
  
  -- ---------------------------------------------------------------------
  -- Step 3: Insert refund loyalty_transactions row
  -- ---------------------------------------------------------------------
  INSERT INTO public.loyalty_transactions (
    member_id, transaction_type, points_amount,
    account_id, cash_order_id, invoice_number,
    tier_at_time, notes
  )
  VALUES (
    m.id, 'refunded', v_pts,
    r.account_id, r.cash_order_id, NULL,
    v_tier_name,
    CASE WHEN r.transaction_id IS NOT NULL
      THEN 'Refund of voided redemption #' || substring(r.id::text, 1, 8) || ' — original tx: ' || r.transaction_id::text
      ELSE 'Refund of voided redemption #' || substring(r.id::text, 1, 8)
    END
  )
  RETURNING id INTO v_refund_tx_id;
  
  -- ---------------------------------------------------------------------
  -- Step 4: Mark redemption cancelled (defensive race guard)
  -- ---------------------------------------------------------------------
  UPDATE public.loyalty_redemptions
  SET status = 'cancelled',
      cancelled_by_user_id = p_user_id,
      cancelled_at = now(),
      cancellation_reason = v_truncated_reason
  WHERE id = r.id
    AND status = 'confirmed';
  
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  
  IF v_updated_count = 0 THEN
    RAISE EXCEPTION 'redemption_void_race' USING ERRCODE = 'P0001';
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 5: Restore member balance (relative arithmetic, race-safe)
  -- ---------------------------------------------------------------------
  UPDATE public.loyalty_members
  SET remaining_points = COALESCE(remaining_points, 0) + v_pts,
      total_points_redeemed = GREATEST(0, COALESCE(total_points_redeemed, 0) - v_pts)
  WHERE id = m.id;
  
  -- ---------------------------------------------------------------------
  -- Step 6: Order-side reversal (only for new_order_discount with FK)
  -- ---------------------------------------------------------------------
  IF r.redemption_type = 'new_order_discount' 
     AND (r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL) THEN
    
    -- Step 6a: Restore loyalty_jpy_amount on the order
    v_jpy_to_restore := COALESCE(r.value_applied_jpy, 0);
    
    IF v_jpy_to_restore > 0 THEN
      IF r.account_id IS NOT NULL THEN
        UPDATE public.layaway_accounts
        SET loyalty_jpy_amount = COALESCE(loyalty_jpy_amount, 0) + v_jpy_to_restore
        WHERE id = r.account_id;
      ELSE
        UPDATE public.cash_orders
        SET loyalty_jpy_amount = COALESCE(loyalty_jpy_amount, 0) + v_jpy_to_restore
        WHERE id = r.cash_order_id;
      END IF;
    END IF;
    
    -- Step 6b: Layaway branch
    IF r.account_id IS NOT NULL THEN
      SELECT id, voided_at, amount_paid
      INTO v_synth_payment
      FROM public.payments
      WHERE reference_number = v_ref_ref
      LIMIT 1;
      
      IF v_synth_payment.id IS NOT NULL AND v_synth_payment.voided_at IS NULL THEN
        
        -- Void the synthetic payment
        UPDATE public.payments
        SET voided_at = now(),
            voided_by_user_id = p_user_id,
            void_reason = v_void_notes
        WHERE id = v_synth_payment.id;
        
        -- Revert each allocation: schedule row revert + allocation delete
        FOR v_alloc IN
          SELECT id, schedule_id, allocated_amount, allocation_type
          FROM public.payment_allocations
          WHERE payment_id = v_synth_payment.id
        LOOP
          SELECT id, total_due_amount, paid_amount, status, due_date
          INTO v_sched
          FROM public.layaway_schedule
          WHERE id = v_alloc.schedule_id;
          
          IF NOT FOUND THEN
            RAISE EXCEPTION 'schedule_row_not_found: %', v_alloc.schedule_id 
              USING ERRCODE = 'P0001';
          END IF;
          
          v_new_paid := GREATEST(0, COALESCE(v_sched.paid_amount, 0) - COALESCE(v_alloc.allocated_amount, 0));
          
          -- Status reversal (faithful port of TS L1008-1028)
          IF v_new_paid >= v_sched.total_due_amount THEN
            v_new_status := 'paid';
          ELSIF v_new_paid = 0 THEN
            v_new_status := CASE WHEN v_sched.due_date < v_today THEN 'overdue' ELSE 'pending' END;
          ELSIF v_sched.status = 'paid' THEN
            v_new_status := CASE WHEN v_sched.due_date < v_today THEN 'overdue' ELSE 'partially_paid' END;
          ELSE
            v_new_status := v_sched.status;
          END IF;
          
          UPDATE public.layaway_schedule
          SET paid_amount = v_new_paid,
              status = v_new_status::schedule_status
          WHERE id = v_sched.id;
          
          DELETE FROM public.payment_allocations
          WHERE id = v_alloc.id;
        END LOOP;
        
        -- Revert account totals + status
        SELECT total_paid, remaining_balance, status, currency
        INTO v_acct
        FROM public.layaway_accounts
        WHERE id = r.account_id;
        
        v_refund_amount := COALESCE(v_synth_payment.amount_paid, 0);
        v_new_total_paid := GREATEST(0, COALESCE(v_acct.total_paid, 0) - v_refund_amount);
        v_new_remaining_balance := COALESCE(v_acct.remaining_balance, 0) + v_refund_amount;
        
        v_new_account_status := v_acct.status;
        IF v_acct.status = 'completed' AND v_new_remaining_balance > 0.01 THEN
          SELECT EXISTS(
            SELECT 1 FROM public.layaway_schedule
            WHERE account_id = r.account_id AND status = 'overdue'
          ) INTO v_any_overdue;
          v_new_account_status := CASE WHEN v_any_overdue THEN 'overdue' ELSE 'active' END;
        END IF;
        
        UPDATE public.layaway_accounts
        SET total_paid = v_new_total_paid,
            remaining_balance = v_new_remaining_balance,
            status = v_new_account_status::account_status
        WHERE id = r.account_id;
        
        v_currency := v_acct.currency;
        v_order_side_done := true;
      END IF;
    END IF;
    
    -- Step 6c: Cash order branch
    IF r.cash_order_id IS NOT NULL THEN
      SELECT id, voided_at, amount_paid
      INTO v_cash_synth
      FROM public.cash_payments
      WHERE reference_number = v_ref_ref
      LIMIT 1;
      
      IF v_cash_synth.id IS NOT NULL AND v_cash_synth.voided_at IS NULL THEN
        
        -- Void the synthetic cash_payment
        UPDATE public.cash_payments
        SET voided_at = now(),
            voided_by_user_id = p_user_id,
            void_reason = v_void_notes
        WHERE id = v_cash_synth.id;
        
        -- Recompute total_paid from all non-voided cash_payments
        SELECT COALESCE(SUM(amount_paid), 0)
        INTO v_cash_new_total
        FROM public.cash_payments
        WHERE cash_order_id = r.cash_order_id
          AND voided_at IS NULL;
        
        SELECT total_amount, status, currency
        INTO v_cash_order
        FROM public.cash_orders
        WHERE id = r.cash_order_id;
        
        v_cash_new_remaining := COALESCE(v_cash_order.total_amount, 0) - v_cash_new_total;
        
        IF v_cash_order.status = 'completed' AND v_cash_new_remaining > 0 THEN
          UPDATE public.cash_orders
          SET total_paid = v_cash_new_total,
              remaining_balance = v_cash_new_remaining,
              status = 'pending'::cash_order_status,
              completed_at = NULL,
              updated_at = now()
          WHERE id = r.cash_order_id;
        ELSE
          UPDATE public.cash_orders
          SET total_paid = v_cash_new_total,
              remaining_balance = v_cash_new_remaining,
              updated_at = now()
          WHERE id = r.cash_order_id;
        END IF;
        
        v_refund_amount := COALESCE(v_cash_synth.amount_paid, 0);
        v_currency := v_cash_order.currency;
        v_order_side_done := true;
      END IF;
    END IF;
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 7: Re-increment catalog stock (when reward exists with finite stock)
  -- ---------------------------------------------------------------------
  IF r.reward_id IS NOT NULL THEN
    SELECT id, current_stock
    INTO v_reward
    FROM public.loyalty_rewards
    WHERE id = r.reward_id
    FOR UPDATE;
    
    IF v_reward.id IS NOT NULL AND v_reward.current_stock IS NOT NULL THEN
      UPDATE public.loyalty_rewards
      SET current_stock = COALESCE(current_stock, 0) + 1
      WHERE id = r.reward_id;
      v_stock_re_incremented := true;
    END IF;
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Step 8: Audit log
  -- ---------------------------------------------------------------------
  INSERT INTO public.audit_logs (
    entity_type, entity_id, action, performed_by_user_id,
    old_value_json, new_value_json
  )
  VALUES (
    'loyalty_redemption', r.id, 'redemption_voided', p_user_id,
    jsonb_build_object(
      'status', 'confirmed',
      'member_remaining_points', v_before_balance
    ),
    jsonb_build_object(
      'status', 'cancelled',
      'cancellation_reason', v_truncated_reason,
      'member_remaining_points', v_new_remaining,
      'refund_transaction_id', v_refund_tx_id,
      'stock_re_incremented', v_stock_re_incremented
    )
  );
  
  -- ---------------------------------------------------------------------
  -- Step 9: Account note (atomic, symmetric format with approve)
  -- ---------------------------------------------------------------------
  IF r.account_id IS NOT NULL OR r.cash_order_id IS NOT NULL THEN
    v_note := 'Loyalty: redemption voided — ' || v_pts::text || ' pts refunded (' || r.redemption_type::text || ')';
    
    IF v_refund_amount > 0 AND v_currency IS NOT NULL THEN
      v_note := v_note || ' — ' ||
                CASE WHEN v_currency = 'PHP' THEN '₱' ELSE '¥' END ||
                v_refund_amount::text ||
                ' removed from balance';
    END IF;
    
    INSERT INTO public.account_notes (
      account_id, cash_order_id, note_text,
      created_by_user_id, created_by_name
    )
    VALUES (
      r.account_id, r.cash_order_id, v_note,
      p_user_id, 'System (Loyalty)'
    );
  END IF;
  
  -- ---------------------------------------------------------------------
  -- Return payload
  -- ---------------------------------------------------------------------
  RETURN jsonb_build_object(
    'redemption_id', r.id,
    'refund_transaction_id', v_refund_tx_id,
    'points_refunded', v_pts,
    'new_remaining_points', v_new_remaining,
    'stock_re_incremented', v_stock_re_incremented,
    'jpy_restored', v_jpy_to_restore,
    'order_side_reverted', v_order_side_done,
    'refund_amount', v_refund_amount,
    'currency', v_currency
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.schedule_with_actuals AS
 SELECT ls.id,
    ls.account_id,
    ls.installment_number,
    ls.due_date,
    ls.base_installment_amount,
    ls.penalty_amount,
    ls.carried_amount,
    ls.carried_from_schedule_id,
    ls.carried_by_payment_id,
    ls.currency,
    ls.status AS db_status,
    ls.generated_at,
    ls.updated_at,
    ls.total_due_amount,
    COALESCE(pa.allocated, 0::numeric) AS allocated,
    GREATEST(0::numeric, LEAST(ls.base_installment_amount + COALESCE(ls.penalty_amount, 0::numeric) + COALESCE(ls.carried_amount, 0::numeric), ls.total_due_amount) - COALESCE(pa.allocated, 0::numeric)) AS actual_remaining,
        CASE
            WHEN ls.status = 'paid'::schedule_status THEN 'paid'::schedule_status
            WHEN COALESCE(pa.allocated, 0::numeric) >= (LEAST(ls.base_installment_amount + COALESCE(ls.penalty_amount, 0::numeric) + COALESCE(ls.carried_amount, 0::numeric), ls.total_due_amount) - 0.005) THEN 'paid'::schedule_status
            WHEN COALESCE(pa.allocated, 0::numeric) > 0::numeric THEN 'partially_paid'::schedule_status
            ELSE ls.status
        END AS computed_status
   FROM layaway_schedule ls
     LEFT JOIN ( SELECT pa_1.schedule_id,
            COALESCE(sum(pa_1.allocated_amount), 0::numeric) AS allocated
           FROM payment_allocations pa_1
             JOIN payments p ON p.id = pa_1.payment_id
          WHERE p.voided_at IS NULL
          GROUP BY pa_1.schedule_id) pa ON pa.schedule_id = ls.id;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE TRIGGER cash_orders_autofill_support_verifier AFTER INSERT ON cash_orders FOR EACH ROW EXECUTE FUNCTION autofill_sales_log_support_verifier();
CREATE TRIGGER cash_orders_updated_at BEFORE UPDATE ON cash_orders FOR EACH ROW EXECUTE FUNCTION update_cash_orders_updated_at();
CREATE TRIGGER trg_clear_cash_order_expiry BEFORE UPDATE ON cash_orders FOR EACH ROW EXECUTE FUNCTION clear_cash_order_expiry_on_complete();
CREATE TRIGGER trg_notify_cash_order_created AFTER INSERT ON cash_orders FOR EACH ROW EXECUTE FUNCTION notify_cash_order_created();
CREATE TRIGGER trg_test_invoice_prefix_cash BEFORE INSERT OR UPDATE OF invoice_number, customer_id ON cash_orders FOR EACH ROW EXECUTE FUNCTION enforce_test_invoice_prefix();
CREATE TRIGGER trg_notify_customer_notified AFTER INSERT OR UPDATE ON csr_notifications FOR EACH ROW EXECUTE FUNCTION notify_customer_notified();
CREATE TRIGGER auto_generate_customer_code BEFORE INSERT ON customers FOR EACH ROW EXECUTE FUNCTION generate_customer_code();
CREATE TRIGGER prevent_customer_code_change BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION prevent_customer_code_change();
CREATE TRIGGER trg_prevent_birthday_change BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION prevent_birthday_change();
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_notify_extension_event AFTER INSERT OR UPDATE ON extension_requests FOR EACH ROW EXECUTE FUNCTION notify_extension_event();
CREATE TRIGGER update_feature_toggles_updated_at BEFORE UPDATE ON feature_toggles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER enforce_total_amount_admin_only BEFORE UPDATE ON layaway_accounts FOR EACH ROW EXECUTE FUNCTION prevent_total_amount_change();
CREATE TRIGGER layaway_accounts_autofill_support_verifier AFTER INSERT ON layaway_accounts FOR EACH ROW EXECUTE FUNCTION autofill_sales_log_support_verifier();
CREATE TRIGGER trg_audit_layaway_accounts AFTER INSERT OR DELETE OR UPDATE ON layaway_accounts FOR EACH ROW EXECUTE FUNCTION log_admin_table_change();
CREATE TRIGGER trg_enforce_plan_minimum BEFORE INSERT OR UPDATE OF payment_plan_months, total_amount, currency ON layaway_accounts FOR EACH ROW EXECUTE FUNCTION enforce_plan_minimum_amount();
CREATE TRIGGER trg_notify_account_created AFTER INSERT ON layaway_accounts FOR EACH ROW EXECUTE FUNCTION notify_account_created();
CREATE TRIGGER trg_test_invoice_prefix_layaway BEFORE INSERT OR UPDATE OF invoice_number, customer_id ON layaway_accounts FOR EACH ROW EXECUTE FUNCTION enforce_test_invoice_prefix();
CREATE TRIGGER trigger_set_completed_at BEFORE UPDATE ON layaway_accounts FOR EACH ROW WHEN (old.status IS DISTINCT FROM new.status) EXECUTE FUNCTION set_completed_at();
CREATE TRIGGER update_layaway_accounts_updated_at BEFORE UPDATE ON layaway_accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER enforce_immutable_base BEFORE UPDATE ON layaway_schedule FOR EACH ROW EXECUTE FUNCTION prevent_base_amount_change();
CREATE TRIGGER enforce_paid_row_freeze BEFORE UPDATE ON layaway_schedule FOR EACH ROW EXECUTE FUNCTION prevent_paid_row_modification();
CREATE TRIGGER log_schedule_deletion_trigger AFTER DELETE ON layaway_schedule FOR EACH ROW EXECUTE FUNCTION log_schedule_deletion();
CREATE TRIGGER prevent_schedule_deletion_trigger BEFORE DELETE ON layaway_schedule FOR EACH ROW EXECUTE FUNCTION prevent_schedule_deletion();
CREATE TRIGGER trg_validate_schedule_chronology BEFORE INSERT OR UPDATE OF due_date ON layaway_schedule FOR EACH ROW EXECUTE FUNCTION validate_schedule_chronology();
CREATE TRIGGER trg_validate_schedule_start_year BEFORE INSERT ON layaway_schedule FOR EACH ROW EXECUTE FUNCTION validate_schedule_start_year();
CREATE TRIGGER update_layaway_schedule_updated_at BEFORE UPDATE ON layaway_schedule FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER loyalty_members_updated_at BEFORE UPDATE ON loyalty_members FOR EACH ROW EXECUTE FUNCTION update_loyalty_members_updated_at();
CREATE TRIGGER trg_notify_loyalty_enrolled AFTER INSERT ON loyalty_members FOR EACH ROW EXECUTE FUNCTION notify_loyalty_enrolled();
CREATE TRIGGER trg_notify_tier_changed AFTER UPDATE ON loyalty_members FOR EACH ROW EXECUTE FUNCTION notify_tier_changed();
CREATE TRIGGER update_loyalty_notifications_updated_at BEFORE UPDATE ON loyalty_notifications FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_lots_updated_at BEFORE UPDATE ON loyalty_point_lots FOR EACH ROW EXECUTE FUNCTION loyalty_lots_set_updated_at();
CREATE TRIGGER loyalty_promos_updated_at BEFORE UPDATE ON loyalty_promos FOR EACH ROW EXECUTE FUNCTION update_loyalty_promos_updated_at();
CREATE TRIGGER enforce_allocation_ceiling AFTER INSERT OR UPDATE ON payment_allocations FOR EACH ROW EXECUTE FUNCTION check_allocation_ceiling();
CREATE TRIGGER payment_backup_no_delete BEFORE DELETE ON payment_history_backup FOR EACH ROW EXECUTE FUNCTION prevent_payment_backup_modification();
CREATE TRIGGER payment_backup_no_update BEFORE UPDATE ON payment_history_backup FOR EACH ROW EXECUTE FUNCTION prevent_payment_backup_modification();
CREATE TRIGGER trg_notify_submission_created AFTER INSERT ON payment_submissions FOR EACH ROW EXECUTE FUNCTION notify_submission_created();
CREATE TRIGGER trg_notify_submission_reviewed AFTER UPDATE ON payment_submissions FOR EACH ROW EXECUTE FUNCTION notify_submission_reviewed();
CREATE TRIGGER trg_audit_payments AFTER INSERT OR DELETE OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION log_admin_table_change();
CREATE TRIGGER trigger_auto_backup_payment AFTER INSERT OR UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION auto_backup_payment();
CREATE TRIGGER update_penalty_fees_updated_at BEFORE UPDATE ON penalty_fees FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER trg_notify_waiver_event AFTER INSERT OR UPDATE ON penalty_waiver_requests FOR EACH ROW EXECUTE FUNCTION notify_waiver_event();
CREATE TRIGGER update_penalty_waiver_requests_updated_at BEFORE UPDATE ON penalty_waiver_requests FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER product_inquiries_updated_at BEFORE UPDATE ON product_inquiries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_role_permissions_updated_at BEFORE UPDATE ON role_permissions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER sales_log_autocheck_eligible BEFORE INSERT OR UPDATE ON sales_log FOR EACH ROW EXECUTE FUNCTION autocheck_sales_log_eligible();
CREATE TRIGGER trg_timesheet_entries_updated BEFORE UPDATE ON timesheet_entries FOR EACH ROW EXECUTE FUNCTION set_timesheet_updated_at();
CREATE TRIGGER trg_timesheet_profiles_updated BEFORE UPDATE ON timesheet_profiles FOR EACH ROW EXECUTE FUNCTION set_timesheet_updated_at();
CREATE TRIGGER user_permission_overrides_updated_at BEFORE UPDATE ON user_permission_overrides FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes (non-constraint)
-- ---------------------------------------------------------------------------
CREATE INDEX idx_account_notes_account ON public.account_notes USING btree (account_id);
CREATE INDEX idx_account_notes_cash_order_id ON public.account_notes USING btree (cash_order_id) WHERE (cash_order_id IS NOT NULL);
CREATE INDEX idx_account_notes_created ON public.account_notes USING btree (created_at DESC);
CREATE INDEX idx_audit_action ON public.audit_logs USING btree (action);
CREATE INDEX idx_audit_created ON public.audit_logs USING btree (created_at);
CREATE INDEX idx_audit_entity ON public.audit_logs USING btree (entity_type, entity_id);
CREATE INDEX idx_cash_orders_customer_id ON public.cash_orders USING btree (customer_id);
CREATE INDEX idx_cash_orders_invoice ON public.cash_orders USING btree (invoice_number);
CREATE INDEX idx_cash_orders_is_trade ON public.cash_orders USING btree (is_trade) WHERE (is_trade = true);
CREATE INDEX idx_cash_orders_status ON public.cash_orders USING btree (status);
CREATE INDEX idx_cash_payments_date_paid ON public.cash_payments USING btree (date_paid);
CREATE INDEX idx_cash_payments_order_id ON public.cash_payments USING btree (cash_order_id);
CREATE UNIQUE INDEX commission_agents_user_id_key ON public.commission_agents USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX idx_analytics_customer ON public.customer_analytics USING btree (customer_id);
CREATE INDEX idx_portal_sessions_customer_id ON public.customer_portal_sessions USING btree (customer_id);
CREATE INDEX idx_portal_sessions_expires_at ON public.customer_portal_sessions USING btree (expires_at);
CREATE INDEX idx_portal_sessions_source_token ON public.customer_portal_sessions USING btree (source_token_id);
CREATE UNIQUE INDEX customers_email_unique_when_authed ON public.customers USING btree (lower(email)) WHERE (auth_user_id IS NOT NULL);
CREATE INDEX idx_customers_auth_user_id ON public.customers USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);
CREATE INDEX idx_customers_code ON public.customers USING btree (customer_code);
CREATE INDEX idx_customers_name ON public.customers USING btree (full_name);
CREATE INDEX idx_email_send_log_created ON public.email_send_log USING btree (created_at DESC);
CREATE UNIQUE INDEX idx_email_send_log_idempotency_active ON public.email_send_log USING btree (idempotency_key) WHERE ((idempotency_key IS NOT NULL) AND (status = ANY (ARRAY['pending'::text, 'sent'::text])));
CREATE INDEX idx_email_send_log_message ON public.email_send_log USING btree (message_id);
CREATE UNIQUE INDEX idx_email_send_log_message_sent_unique ON public.email_send_log USING btree (message_id) WHERE (status = 'sent'::text);
CREATE INDEX idx_email_send_log_recipient ON public.email_send_log USING btree (recipient_email);
CREATE INDEX idx_unsubscribe_tokens_token ON public.email_unsubscribe_tokens USING btree (token);
CREATE UNIQUE INDEX uq_financial_alerts_active_type ON public.financial_alerts USING btree (alert_type, COALESCE((plan_months)::text, 'null'::text)) WHERE (resolved_at IS NULL);
CREATE INDEX idx_forecast_type ON public.forecast_snapshots USING btree (forecast_type);
CREATE INDEX idx_gen_inv_account ON public.generated_invoices USING btree (account_id) WHERE (account_id IS NOT NULL);
CREATE INDEX idx_gen_inv_cash_order ON public.generated_invoices USING btree (cash_order_id) WHERE (cash_order_id IS NOT NULL);
CREATE INDEX idx_gen_inv_generated_at ON public.generated_invoices USING btree (generated_at DESC);
CREATE INDEX idx_gen_inv_invoice_number ON public.generated_invoices USING btree (parent_invoice_number);
CREATE INDEX idx_layaway_accounts_is_trade ON public.layaway_accounts USING btree (is_trade) WHERE (is_trade = true);
CREATE INDEX idx_layaway_currency ON public.layaway_accounts USING btree (currency);
CREATE INDEX idx_layaway_customer ON public.layaway_accounts USING btree (customer_id);
CREATE INDEX idx_layaway_invoice ON public.layaway_accounts USING btree (invoice_number);
CREATE INDEX idx_layaway_status ON public.layaway_accounts USING btree (status);
CREATE INDEX idx_schedule_account ON public.layaway_schedule USING btree (account_id);
CREATE INDEX idx_schedule_due_date ON public.layaway_schedule USING btree (due_date);
CREATE INDEX idx_schedule_status ON public.layaway_schedule USING btree (status);
CREATE INDEX idx_loyalty_banners_active_type_priority ON public.loyalty_banners USING btree (banner_type, is_active, display_priority DESC);
CREATE INDEX idx_loyalty_beta_customer ON public.loyalty_beta_members USING btree (customer_id);
CREATE INDEX idx_consumption_lot ON public.loyalty_lot_consumption USING btree (lot_id);
CREATE INDEX idx_consumption_redemption ON public.loyalty_lot_consumption USING btree (redemption_id);
CREATE INDEX idx_loyalty_members_current_tier ON public.loyalty_members USING btree (current_tier_id);
CREATE INDEX idx_loyalty_members_customer ON public.loyalty_members USING btree (customer_id);
CREATE INDEX idx_loyalty_members_last_purchase ON public.loyalty_members USING btree (last_purchase_at);
CREATE INDEX idx_loyalty_notification_recipients_member_created ON public.loyalty_notification_recipients USING btree (member_id, created_at DESC);
CREATE INDEX idx_loyalty_notification_recipients_member_unread ON public.loyalty_notification_recipients USING btree (member_id) WHERE (is_read = false);
CREATE INDEX idx_loyalty_notifications_status_created ON public.loyalty_notifications USING btree (status, created_at DESC);
CREATE INDEX idx_loyalty_notifications_status_scheduled ON public.loyalty_notifications USING btree (status, scheduled_for) WHERE (status = 'scheduled'::text);
CREATE INDEX idx_lots_expiry_due ON public.loyalty_point_lots USING btree (expires_at) WHERE ((remaining_amount > 0) AND (expired_at IS NULL) AND (expires_at IS NOT NULL));
CREATE INDEX idx_lots_member ON public.loyalty_point_lots USING btree (member_id);
CREATE INDEX idx_lots_member_active ON public.loyalty_point_lots USING btree (member_id, expires_at, earned_at) WHERE ((remaining_amount > 0) AND (expired_at IS NULL));
CREATE INDEX idx_loyalty_point_lots_active_by_source ON public.loyalty_point_lots USING btree (source_reference, earned_at) WHERE ((revoked_at IS NULL) AND (consumed_at IS NULL) AND (expired_at IS NULL));
CREATE UNIQUE INDEX uq_lots_active_order_earn_source ON public.loyalty_point_lots USING btree (source_reference) WHERE ((revoked_at IS NULL) AND (source_type = 'order_earn'::loyalty_lot_source_type));
CREATE INDEX idx_loyalty_promos_active ON public.loyalty_promos USING btree (is_active) WHERE (is_active = true);
CREATE INDEX idx_loyalty_promos_active_priority ON public.loyalty_promos USING btree (is_active, display_priority DESC, start_date);
CREATE INDEX idx_loyalty_promos_dates ON public.loyalty_promos USING btree (start_date, end_date);
CREATE INDEX idx_loyalty_redeem_account ON public.loyalty_redemptions USING btree (account_id) WHERE (account_id IS NOT NULL);
CREATE INDEX idx_loyalty_redeem_cash_order ON public.loyalty_redemptions USING btree (cash_order_id) WHERE (cash_order_id IS NOT NULL);
CREATE INDEX idx_loyalty_redeem_invoice ON public.loyalty_redemptions USING btree (invoice_number);
CREATE INDEX idx_loyalty_redeem_member ON public.loyalty_redemptions USING btree (member_id);
CREATE INDEX idx_loyalty_redeem_status ON public.loyalty_redemptions USING btree (status);
CREATE INDEX idx_loyalty_redemptions_reward_id ON public.loyalty_redemptions USING btree (reward_id);
CREATE UNIQUE INDEX uq_active_new_order_discount ON public.loyalty_redemptions USING btree (member_id, invoice_number, points_redeemed) WHERE ((status = ANY (ARRAY['pending'::loyalty_redemption_status, 'confirmed'::loyalty_redemption_status])) AND (redemption_type = 'new_order_discount'::loyalty_redemption_type));
CREATE INDEX idx_loyalty_rewards_active_priority ON public.loyalty_rewards USING btree (is_active, display_priority DESC, category);
CREATE INDEX idx_loyalty_tiers_min_spend ON public.loyalty_tiers USING btree (min_spend_jpy);
CREATE INDEX idx_loyalty_transactions_unsynced ON public.loyalty_transactions USING btree (created_at) WHERE (synced_to_sheet_at IS NULL);
CREATE INDEX idx_loyalty_tx_account ON public.loyalty_transactions USING btree (account_id) WHERE (account_id IS NOT NULL);
CREATE INDEX idx_loyalty_tx_cash_order ON public.loyalty_transactions USING btree (cash_order_id) WHERE (cash_order_id IS NOT NULL);
CREATE INDEX idx_loyalty_tx_created ON public.loyalty_transactions USING btree (created_at);
CREATE INDEX idx_loyalty_tx_member ON public.loyalty_transactions USING btree (member_id);
CREATE INDEX idx_loyalty_tx_promo ON public.loyalty_transactions USING btree (promo_id) WHERE (promo_id IS NOT NULL);
CREATE INDEX idx_loyalty_tx_type ON public.loyalty_transactions USING btree (transaction_type);
CREATE INDEX idx_notify_loyalty_customer ON public.notify_loyalty_launch USING btree (customer_id) WHERE (customer_id IS NOT NULL);
CREATE INDEX idx_notify_loyalty_email ON public.notify_loyalty_launch USING btree (email);
CREATE INDEX idx_allocations_payment ON public.payment_allocations USING btree (payment_id);
CREATE INDEX idx_allocations_schedule ON public.payment_allocations USING btree (schedule_id);
CREATE INDEX idx_payment_proofs_account ON public.payment_proofs USING btree (account_id);
CREATE INDEX idx_submission_allocations_account_id ON public.payment_submission_allocations USING btree (account_id);
CREATE INDEX idx_submission_allocations_submission_id ON public.payment_submission_allocations USING btree (submission_id);
CREATE INDEX idx_payment_submissions_cash_order_id ON public.payment_submissions USING btree (cash_order_id) WHERE (cash_order_id IS NOT NULL);
CREATE INDEX idx_payment_submissions_cash_order_status ON public.payment_submissions USING btree (cash_order_id, status, submitted_amount, payment_method) WHERE ((cash_order_id IS NOT NULL) AND (status = ANY (ARRAY['submitted'::submission_status, 'under_review'::submission_status])));
CREATE INDEX idx_payments_account ON public.payments USING btree (account_id);
CREATE INDEX idx_payments_date ON public.payments USING btree (date_paid);
CREATE INDEX idx_penalty_account ON public.penalty_fees USING btree (account_id);
CREATE INDEX idx_penalty_schedule ON public.penalty_fees USING btree (schedule_id);
CREATE INDEX idx_penalty_status ON public.penalty_fees USING btree (status);
CREATE UNIQUE INDEX uq_penalty_schedule_stage_cycle ON public.penalty_fees USING btree (schedule_id, penalty_stage, penalty_cycle);
CREATE INDEX idx_waiver_account ON public.penalty_waiver_requests USING btree (account_id);
CREATE INDEX idx_waiver_status ON public.penalty_waiver_requests USING btree (status);
CREATE INDEX idx_product_inquiries_category ON public.product_inquiries USING btree (category);
CREATE INDEX idx_product_inquiries_date ON public.product_inquiries USING btree (last_inquired_date);
CREATE INDEX idx_product_inquiries_item_code ON public.product_inquiries USING btree (item_code);
CREATE INDEX idx_promo_views_category_id ON public.promo_views USING btree (category_id);
CREATE INDEX idx_promo_views_customer_id ON public.promo_views USING btree (customer_id);
CREATE INDEX idx_promo_views_promo_id ON public.promo_views USING btree (promo_id);
CREATE INDEX idx_reconciliation_log_account_id ON public.reconciliation_log USING btree (account_id);
CREATE INDEX idx_reconciliation_log_checked_at ON public.reconciliation_log USING btree (checked_at DESC);
CREATE INDEX idx_reconciliation_log_drift ON public.reconciliation_log USING btree (drift_detected) WHERE (drift_detected = true);
CREATE INDEX idx_reminder_account ON public.reminder_logs USING btree (account_id);
CREATE INDEX idx_reminder_customer ON public.reminder_logs USING btree (customer_id);
CREATE INDEX idx_sales_log_date ON public.sales_log USING btree (sale_date);
CREATE INDEX idx_sales_log_eligible ON public.sales_log USING btree (eligible);
CREATE INDEX sales_log_invoice_number_idx ON public.sales_log USING btree (invoice_number) WHERE (invoice_number IS NOT NULL);
CREATE INDEX idx_service_jobs_customer ON public.service_jobs USING btree (customer_id);
CREATE INDEX idx_service_jobs_invoice ON public.service_jobs USING btree (invoice_number);
CREATE INDEX idx_service_jobs_status ON public.service_jobs USING btree (service_status);
CREATE INDEX idx_staff_notifications_created ON public.staff_notifications USING btree (created_at DESC);
CREATE INDEX idx_suppressed_emails_email ON public.suppressed_emails USING btree (email);
CREATE INDEX idx_timesheet_entries_user_date ON public.timesheet_entries USING btree (user_id, work_date);
CREATE INDEX idx_timesheet_entries_work_date ON public.timesheet_entries USING btree (work_date);
CREATE INDEX idx_trade_ins_customer ON public.trade_ins USING btree (customer_id);
CREATE INDEX idx_trade_ins_new_invoice ON public.trade_ins USING btree (new_invoice_number);
CREATE INDEX idx_trade_ins_old_invoice ON public.trade_ins USING btree (old_invoice_number);

-- ---------------------------------------------------------------------------
-- Foreign key constraints
-- ---------------------------------------------------------------------------
ALTER TABLE public.account_notes ADD CONSTRAINT account_notes_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.account_notes ADD CONSTRAINT account_notes_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE CASCADE;
ALTER TABLE public.account_notes ADD CONSTRAINT account_notes_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.account_services ADD CONSTRAINT account_services_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.announcements ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_performed_by_user_id_fkey FOREIGN KEY (performed_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.cash_orders ADD CONSTRAINT cash_orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE public.cash_payments ADD CONSTRAINT cash_payments_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE RESTRICT;
ALTER TABLE public.commission_agents ADD CONSTRAINT commission_agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE public.csr_notifications ADD CONSTRAINT csr_notifications_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.csr_notifications ADD CONSTRAINT csr_notifications_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.csr_notifications ADD CONSTRAINT csr_notifications_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES layaway_schedule(id) ON DELETE CASCADE;
ALTER TABLE public.customer_analytics ADD CONSTRAINT customer_analytics_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.customer_pins ADD CONSTRAINT customer_pins_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.customer_portal_sessions ADD CONSTRAINT customer_portal_sessions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.customer_portal_sessions ADD CONSTRAINT customer_portal_sessions_source_token_id_fkey FOREIGN KEY (source_token_id) REFERENCES customer_portal_tokens(id) ON DELETE CASCADE;
ALTER TABLE public.customer_portal_tokens ADD CONSTRAINT customer_portal_tokens_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.customers ADD CONSTRAINT customers_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.extension_requests ADD CONSTRAINT extension_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id);
ALTER TABLE public.extension_requests ADD CONSTRAINT extension_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE public.extension_requests ADD CONSTRAINT extension_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);
ALTER TABLE public.final_settlement_records ADD CONSTRAINT final_settlement_records_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id);
ALTER TABLE public.financial_alerts ADD CONSTRAINT financial_alerts_plan_months_fkey FOREIGN KEY (plan_months) REFERENCES plan_configurations(plan_months);
ALTER TABLE public.generated_invoices ADD CONSTRAINT generated_invoices_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE RESTRICT;
ALTER TABLE public.generated_invoices ADD CONSTRAINT generated_invoices_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE RESTRICT;
ALTER TABLE public.generated_invoices ADD CONSTRAINT generated_invoices_generated_by_user_id_fkey FOREIGN KEY (generated_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.layaway_accounts ADD CONSTRAINT layaway_accounts_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.layaway_accounts ADD CONSTRAINT layaway_accounts_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.layaway_accounts ADD CONSTRAINT layaway_accounts_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT;
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_carried_by_payment_id_fkey FOREIGN KEY (carried_by_payment_id) REFERENCES payments(id);
ALTER TABLE public.layaway_schedule ADD CONSTRAINT layaway_schedule_carried_from_schedule_id_fkey FOREIGN KEY (carried_from_schedule_id) REFERENCES layaway_schedule(id);
ALTER TABLE public.loyalty_banners ADD CONSTRAINT loyalty_banners_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.loyalty_beta_members ADD CONSTRAINT loyalty_beta_members_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.loyalty_lot_consumption ADD CONSTRAINT loyalty_lot_consumption_lot_id_fkey FOREIGN KEY (lot_id) REFERENCES loyalty_point_lots(id) ON DELETE RESTRICT;
ALTER TABLE public.loyalty_lot_consumption ADD CONSTRAINT loyalty_lot_consumption_redemption_id_fkey FOREIGN KEY (redemption_id) REFERENCES loyalty_redemptions(id) ON DELETE RESTRICT;
ALTER TABLE public.loyalty_members ADD CONSTRAINT loyalty_members_current_tier_id_fkey FOREIGN KEY (current_tier_id) REFERENCES loyalty_tiers(id);
ALTER TABLE public.loyalty_members ADD CONSTRAINT loyalty_members_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.loyalty_members ADD CONSTRAINT loyalty_members_earned_tier_id_fkey FOREIGN KEY (earned_tier_id) REFERENCES loyalty_tiers(id);
ALTER TABLE public.loyalty_notification_recipients ADD CONSTRAINT loyalty_notification_recipients_member_id_fkey FOREIGN KEY (member_id) REFERENCES loyalty_members(id) ON DELETE CASCADE;
ALTER TABLE public.loyalty_notification_recipients ADD CONSTRAINT loyalty_notification_recipients_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES loyalty_notifications(id) ON DELETE CASCADE;
ALTER TABLE public.loyalty_notifications ADD CONSTRAINT loyalty_notifications_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.loyalty_point_lots ADD CONSTRAINT loyalty_point_lots_member_id_fkey FOREIGN KEY (member_id) REFERENCES loyalty_members(id) ON DELETE RESTRICT;
ALTER TABLE public.loyalty_point_lots ADD CONSTRAINT loyalty_point_lots_revoked_by_transaction_id_fkey FOREIGN KEY (revoked_by_transaction_id) REFERENCES loyalty_transactions(id);
ALTER TABLE public.loyalty_redemptions ADD CONSTRAINT loyalty_redemptions_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE SET NULL;
ALTER TABLE public.loyalty_redemptions ADD CONSTRAINT loyalty_redemptions_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE SET NULL;
ALTER TABLE public.loyalty_redemptions ADD CONSTRAINT loyalty_redemptions_member_id_fkey FOREIGN KEY (member_id) REFERENCES loyalty_members(id) ON DELETE CASCADE;
ALTER TABLE public.loyalty_redemptions ADD CONSTRAINT loyalty_redemptions_reward_id_fkey FOREIGN KEY (reward_id) REFERENCES loyalty_rewards(id) ON DELETE SET NULL;
ALTER TABLE public.loyalty_redemptions ADD CONSTRAINT loyalty_redemptions_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES loyalty_transactions(id) ON DELETE SET NULL;
ALTER TABLE public.loyalty_rewards ADD CONSTRAINT loyalty_rewards_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT fk_loyalty_tx_promo FOREIGN KEY (promo_id) REFERENCES loyalty_promos(id) ON DELETE SET NULL;
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE SET NULL;
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE SET NULL;
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_member_id_fkey FOREIGN KEY (member_id) REFERENCES loyalty_members(id) ON DELETE CASCADE;
ALTER TABLE public.loyalty_transactions ADD CONSTRAINT loyalty_transactions_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
ALTER TABLE public.notify_loyalty_launch ADD CONSTRAINT notify_loyalty_launch_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE;
ALTER TABLE public.payment_allocations ADD CONSTRAINT payment_allocations_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES layaway_schedule(id) ON DELETE CASCADE;
ALTER TABLE public.payment_proofs ADD CONSTRAINT payment_proofs_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.payment_proofs ADD CONSTRAINT payment_proofs_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id);
ALTER TABLE public.payment_proofs ADD CONSTRAINT payment_proofs_cash_payment_id_fkey FOREIGN KEY (cash_payment_id) REFERENCES cash_payments(id) ON DELETE SET NULL;
ALTER TABLE public.payment_proofs ADD CONSTRAINT payment_proofs_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL;
ALTER TABLE public.payment_proofs ADD CONSTRAINT payment_proofs_uploaded_by_user_id_fkey FOREIGN KEY (uploaded_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.payment_submission_allocations ADD CONSTRAINT payment_submission_allocations_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id);
ALTER TABLE public.payment_submission_allocations ADD CONSTRAINT payment_submission_allocations_submission_id_fkey FOREIGN KEY (submission_id) REFERENCES payment_submissions(id) ON DELETE CASCADE;
ALTER TABLE public.payment_submissions ADD CONSTRAINT payment_submissions_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id);
ALTER TABLE public.payment_submissions ADD CONSTRAINT payment_submissions_cash_order_id_fkey FOREIGN KEY (cash_order_id) REFERENCES cash_orders(id) ON DELETE SET NULL;
ALTER TABLE public.payment_submissions ADD CONSTRAINT payment_submissions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE public.payments ADD CONSTRAINT payments_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE RESTRICT;
ALTER TABLE public.payments ADD CONSTRAINT payments_entered_by_user_id_fkey FOREIGN KEY (entered_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.penalty_cap_overrides ADD CONSTRAINT penalty_cap_overrides_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.penalty_fees ADD CONSTRAINT penalty_fees_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.penalty_fees ADD CONSTRAINT penalty_fees_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES layaway_schedule(id) ON DELETE CASCADE;
ALTER TABLE public.penalty_waiver_requests ADD CONSTRAINT penalty_waiver_requests_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.penalty_waiver_requests ADD CONSTRAINT penalty_waiver_requests_approved_by_user_id_fkey FOREIGN KEY (approved_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.penalty_waiver_requests ADD CONSTRAINT penalty_waiver_requests_penalty_fee_id_fkey FOREIGN KEY (penalty_fee_id) REFERENCES penalty_fees(id) ON DELETE CASCADE;
ALTER TABLE public.penalty_waiver_requests ADD CONSTRAINT penalty_waiver_requests_requested_by_user_id_fkey FOREIGN KEY (requested_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.penalty_waiver_requests ADD CONSTRAINT penalty_waiver_requests_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES layaway_schedule(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.promo_categories ADD CONSTRAINT promo_categories_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.promo_category_assignments ADD CONSTRAINT promo_category_assignments_category_id_fkey FOREIGN KEY (category_id) REFERENCES promo_categories(id) ON DELETE CASCADE;
ALTER TABLE public.promo_category_assignments ADD CONSTRAINT promo_category_assignments_promo_id_fkey FOREIGN KEY (promo_id) REFERENCES promotions(id) ON DELETE CASCADE;
ALTER TABLE public.promo_views ADD CONSTRAINT promo_views_category_id_fkey FOREIGN KEY (category_id) REFERENCES promo_categories(id) ON DELETE SET NULL;
ALTER TABLE public.promo_views ADD CONSTRAINT promo_views_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.promo_views ADD CONSTRAINT promo_views_promo_id_fkey FOREIGN KEY (promo_id) REFERENCES promotions(id) ON DELETE CASCADE;
ALTER TABLE public.promotions ADD CONSTRAINT promotions_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.reconciliation_log ADD CONSTRAINT reconciliation_log_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id);
ALTER TABLE public.reminder_logs ADD CONSTRAINT reminder_logs_account_id_fkey FOREIGN KEY (account_id) REFERENCES layaway_accounts(id) ON DELETE CASCADE;
ALTER TABLE public.reminder_logs ADD CONSTRAINT reminder_logs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE public.reminder_logs ADD CONSTRAINT reminder_logs_schedule_id_fkey FOREIGN KEY (schedule_id) REFERENCES layaway_schedule(id) ON DELETE SET NULL;
ALTER TABLE public.service_jobs ADD CONSTRAINT service_jobs_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.service_jobs ADD CONSTRAINT service_jobs_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE public.staff_notification_reads ADD CONSTRAINT staff_notification_reads_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES staff_notifications(id) ON DELETE CASCADE;
ALTER TABLE public.system_settings ADD CONSTRAINT system_settings_updated_by_user_id_fkey FOREIGN KEY (updated_by_user_id) REFERENCES auth.users(id);
ALTER TABLE public.trade_ins ADD CONSTRAINT trade_ins_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id);
ALTER TABLE public.user_permission_overrides ADD CONSTRAINT user_permission_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE public.account_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.csr_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_portal_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_send_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_send_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extension_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_toggles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.final_settlement_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forecast_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generated_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inquiry_dropdown_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keep_fix_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layaway_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.layaway_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_award_19015_audit_20260520 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_banners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_beta_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_expiry_restore_audit_20260520 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_last_purchase_backfill_audit_20260520 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_lot_consumption ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_members_backup_pre_migration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_notification_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_point_lots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_point_lots_backup_pre_migration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_promos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_transactions_backup_pre_migration ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notify_loyalty_launch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_history_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_proofs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submission_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.penalty_cap_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.penalty_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.penalty_waiver_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plan_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_category_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedule_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppressed_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_monthly_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timesheet_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trade_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can insert account notes" ON public.account_notes
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can read account notes" ON public.account_notes
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admins can delete services" ON public.account_services
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Staff can create services" ON public.account_services
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update services" ON public.account_services
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view services" ON public.account_services
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admin and staff can manage announcements" ON public.announcements
  AS PERMISSIVE
  FOR ALL
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Public can read active announcements" ON public.announcements
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((is_active = true));

CREATE POLICY "Admin Finance can view audit logs" ON public.audit_logs
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Staff can create audit logs" ON public.audit_logs
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Customers can view own cash orders" ON public.cash_orders
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid()))));

CREATE POLICY "admin_all_cash_orders" ON public.cash_orders
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "staff_admin_insert_cash_orders" ON public.cash_orders
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "staff_admin_update_cash_orders" ON public.cash_orders
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "staff_finance_read_cash_orders" ON public.cash_orders
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "admin_all_cash_payments" ON public.cash_payments
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "staff_admin_insert_cash_payments" ON public.cash_payments
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "staff_finance_read_cash_payments" ON public.cash_payments
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "commission_agents_auth_all" ON public.commission_agents
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "commission_splits_auth_all" ON public.commission_splits
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Staff can create notifications" ON public.csr_notifications
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can view notifications" ON public.csr_notifications
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can insert analytics" ON public.customer_analytics
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update analytics" ON public.customer_analytics
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view analytics" ON public.customer_analytics
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Service role manages portal sessions" ON public.customer_portal_sessions
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Staff can create portal tokens" ON public.customer_portal_tokens
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update portal tokens" ON public.customer_portal_tokens
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view portal tokens" ON public.customer_portal_tokens
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admins can delete customers" ON public.customers
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Customers can view own customer record" ON public.customers
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((auth_user_id = auth.uid()));

CREATE POLICY "Service role can select customers" ON public.customers
  AS PERMISSIVE
  FOR SELECT
  TO service_role
  USING (true);

CREATE POLICY "Service role can update customers" ON public.customers
  AS PERMISSIVE
  FOR UPDATE
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Staff can create customers" ON public.customers
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update customers" ON public.customers
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view all customers" ON public.customers
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Service role can insert send log" ON public.email_send_log
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((auth.role() = 'service_role'::text));

CREATE POLICY "Service role can read send log" ON public.email_send_log
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((auth.role() = 'service_role'::text));

CREATE POLICY "Service role can update send log" ON public.email_send_log
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

CREATE POLICY "Service role can manage send state" ON public.email_send_state
  AS PERMISSIVE
  FOR ALL
  TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

CREATE POLICY "Service role can insert tokens" ON public.email_unsubscribe_tokens
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((auth.role() = 'service_role'::text));

CREATE POLICY "Service role can mark tokens as used" ON public.email_unsubscribe_tokens
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((auth.role() = 'service_role'::text))
  WITH CHECK ((auth.role() = 'service_role'::text));

CREATE POLICY "Service role can read tokens" ON public.email_unsubscribe_tokens
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((auth.role() = 'service_role'::text));

CREATE POLICY "Customers can insert own extension_requests" ON public.extension_requests
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid()))));

CREATE POLICY "Customers can view own extension_requests" ON public.extension_requests
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid()))));

CREATE POLICY "Staff full access to extension_requests" ON public.extension_requests
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (is_staff(auth.uid()))
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Token customers can insert own extension_requests" ON public.extension_requests
  AS PERMISSIVE
  FOR INSERT
  TO anon
  WITH CHECK (((portal_token IS NOT NULL) AND (length(portal_token) >= 16) AND (EXISTS ( SELECT 1
   FROM customer_portal_tokens t
  WHERE ((t.token = extension_requests.portal_token) AND (t.is_active = true) AND ((t.expires_at IS NULL) OR (t.expires_at > now())) AND (t.customer_id = extension_requests.customer_id))))));

CREATE POLICY "Token customers can view own extension_requests" ON public.extension_requests
  AS PERMISSIVE
  FOR SELECT
  TO anon
  USING (((portal_token IS NOT NULL) AND (portal_token = ((current_setting('request.headers'::text, true))::json ->> 'x-portal-token'::text)) AND (EXISTS ( SELECT 1
   FROM customer_portal_tokens t
  WHERE ((t.token = extension_requests.portal_token) AND (t.is_active = true) AND ((t.expires_at IS NULL) OR (t.expires_at > now())))))));

CREATE POLICY "Admins can manage feature_toggles" ON public.feature_toggles
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Staff can view feature_toggles" ON public.feature_toggles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can insert final settlements" ON public.final_settlement_records
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update final settlements" ON public.final_settlement_records
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view final settlements" ON public.final_settlement_records
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admins can read financial_alerts" ON public.financial_alerts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Staff can insert forecasts" ON public.forecast_snapshots
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can view forecasts" ON public.forecast_snapshots
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admins can delete invoices" ON public.generated_invoices
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Customers can view own invoices" ON public.generated_invoices
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((((account_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (layaway_accounts la
     JOIN customers c ON ((c.id = la.customer_id)))
  WHERE ((la.id = generated_invoices.account_id) AND (c.auth_user_id = auth.uid()))))) OR ((cash_order_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (cash_orders co
     JOIN customers c ON ((c.id = co.customer_id)))
  WHERE ((co.id = generated_invoices.cash_order_id) AND (c.auth_user_id = auth.uid())))))));

CREATE POLICY "Service role full access" ON public.generated_invoices
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Staff can insert invoices" ON public.generated_invoices
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can view all invoices" ON public.generated_invoices
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "authenticated_read_dropdown" ON public.inquiry_dropdown_options
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_write_dropdown" ON public.inquiry_dropdown_options
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Admins can read keep_fix_audit" ON public.keep_fix_audit
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Customers can view own layaway accounts" ON public.layaway_accounts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid()))));

CREATE POLICY "Staff can create accounts" ON public.layaway_accounts
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update accounts" ON public.layaway_accounts
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view all accounts" ON public.layaway_accounts
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Customers can view own schedules" ON public.layaway_schedule
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((account_id IN ( SELECT la.id
   FROM (layaway_accounts la
     JOIN customers c ON ((c.id = la.customer_id)))
  WHERE (c.auth_user_id = auth.uid()))));

CREATE POLICY "Staff can insert schedules" ON public.layaway_schedule
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update schedules" ON public.layaway_schedule
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view schedules" ON public.layaway_schedule
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admins can read loyalty_award_19015_audit_20260520" ON public.loyalty_award_19015_audit_20260520
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin can delete loyalty_banners" ON public.loyalty_banners
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admin/finance can insert loyalty_banners" ON public.loyalty_banners
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin/finance can update loyalty_banners" ON public.loyalty_banners
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin/finance/staff can read loyalty_banners" ON public.loyalty_banners
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR has_role(auth.uid(), 'staff'::app_role)));

CREATE POLICY "Anon can read active banners" ON public.loyalty_banners
  AS PERMISSIVE
  FOR SELECT
  TO anon
  USING ((is_active = true));

CREATE POLICY "Authenticated customers can read active banners" ON public.loyalty_banners
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (((auth.role() = 'authenticated'::text) AND (is_active = true)));

CREATE POLICY "admin_all_loyalty_beta" ON public.loyalty_beta_members
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "staff_finance_read_loyalty_beta" ON public.loyalty_beta_members
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admins can read loyalty_expiry_restore_audit_20260520" ON public.loyalty_expiry_restore_audit_20260520
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admins can read loyalty_last_purchase_backfill_audit_20260520" ON public.loyalty_last_purchase_backfill_audit_20260520
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "consumption_admin_finance_staff_read" ON public.loyalty_lot_consumption
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR has_role(auth.uid(), 'staff'::app_role)));

CREATE POLICY "admin_all_members" ON public.loyalty_members
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "staff_finance_insert_members" ON public.loyalty_members
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "staff_finance_read_members" ON public.loyalty_members
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "staff_finance_update_members" ON public.loyalty_members
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admins can read loyalty_members_backup_pre_migration" ON public.loyalty_members_backup_pre_migration
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin and finance read loyalty notification recipients" ON public.loyalty_notification_recipients
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin and finance manage loyalty notifications" ON public.loyalty_notifications
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)))
  WITH CHECK ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin and finance read loyalty notifications" ON public.loyalty_notifications
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "lots_admin_finance_staff_read" ON public.loyalty_point_lots
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR has_role(auth.uid(), 'staff'::app_role)));

CREATE POLICY "Admins can read loyalty_point_lots_backup_pre_migration" ON public.loyalty_point_lots_backup_pre_migration
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "admin_all_loyalty_promos" ON public.loyalty_promos
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "staff_finance_read_loyalty_promos" ON public.loyalty_promos
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "admin_all_loyalty_redeem" ON public.loyalty_redemptions
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "staff_finance_insert_loyalty_redeem" ON public.loyalty_redemptions
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "staff_finance_read_loyalty_redeem" ON public.loyalty_redemptions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "staff_finance_update_loyalty_redeem" ON public.loyalty_redemptions
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "Admin can delete loyalty_rewards" ON public.loyalty_rewards
  AS PERMISSIVE
  FOR DELETE
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admin/finance can insert loyalty_rewards" ON public.loyalty_rewards
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin/finance can update loyalty_rewards" ON public.loyalty_rewards
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin/finance/staff can read loyalty_rewards" ON public.loyalty_rewards
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR has_role(auth.uid(), 'staff'::app_role)));

CREATE POLICY "Anon can read active rewards" ON public.loyalty_rewards
  AS PERMISSIVE
  FOR SELECT
  TO anon
  USING ((is_active = true));

CREATE POLICY "Authenticated customers can read active rewards" ON public.loyalty_rewards
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (((auth.role() = 'authenticated'::text) AND (is_active = true)));

CREATE POLICY "admin_all_tiers" ON public.loyalty_tiers
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "all_authenticated_read_tiers" ON public.loyalty_tiers
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "anon_read_tiers" ON public.loyalty_tiers
  AS PERMISSIVE
  FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "admin_all_loyalty_tx" ON public.loyalty_transactions
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "staff_finance_insert_loyalty_tx" ON public.loyalty_transactions
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR has_role(auth.uid(), 'admin'::app_role)));

CREATE POLICY "staff_finance_read_loyalty_tx" ON public.loyalty_transactions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admins can read loyalty_transactions_backup_pre_migration" ON public.loyalty_transactions_backup_pre_migration
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "admin_all_notify" ON public.notify_loyalty_launch
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "anon_insert_notify" ON public.notify_loyalty_launch
  AS PERMISSIVE
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (((email IS NOT NULL) AND ((length(email) >= 5) AND (length(email) <= 254)) AND (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'::text)));

CREATE POLICY "staff_finance_read_notify" ON public.notify_loyalty_launch
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((has_role(auth.uid(), 'staff'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Staff can create allocations" ON public.payment_allocations
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can delete allocations" ON public.payment_allocations
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can update allocations" ON public.payment_allocations
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()))
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can view allocations" ON public.payment_allocations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admins can read payment_history_backup" ON public.payment_history_backup
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Admin can manage payment methods" ON public.payment_methods
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Anyone can view active payment methods" ON public.payment_methods
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING ((is_active = true));

CREATE POLICY "Authenticated users can insert proofs" ON public.payment_proofs
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((is_staff(auth.uid()) OR (EXISTS ( SELECT 1
   FROM (layaway_accounts la
     JOIN customers c ON ((c.id = la.customer_id)))
  WHERE ((la.id = payment_proofs.account_id) AND (c.auth_user_id = auth.uid()))))));

CREATE POLICY "Staff or owning customer can read proofs" ON public.payment_proofs
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((is_staff(auth.uid()) OR (EXISTS ( SELECT 1
   FROM (layaway_accounts la
     JOIN customers c ON ((c.id = la.customer_id)))
  WHERE ((la.id = payment_proofs.account_id) AND (c.auth_user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM (cash_orders co
     JOIN customers c ON ((c.id = co.customer_id)))
  WHERE ((co.id = payment_proofs.account_id) AND (c.auth_user_id = auth.uid()))))));

CREATE POLICY "Staff can insert allocations" ON public.payment_submission_allocations
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update allocations" ON public.payment_submission_allocations
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view allocations" ON public.payment_submission_allocations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Anon can cancel cash order submissions" ON public.payment_submissions
  AS PERMISSIVE
  FOR UPDATE
  TO anon, authenticated
  USING (((cash_order_id IS NOT NULL) AND (status = 'submitted'::submission_status) AND (portal_token IS NOT NULL) AND (portal_token = ((current_setting('request.headers'::text, true))::json ->> 'x-portal-token'::text)) AND (EXISTS ( SELECT 1
   FROM customer_portal_tokens t
  WHERE ((t.token = payment_submissions.portal_token) AND (t.is_active = true) AND ((t.expires_at IS NULL) OR (t.expires_at > now())))))))
  WITH CHECK (((status = 'cancelled'::submission_status) AND (portal_token IS NOT NULL) AND (portal_token = ((current_setting('request.headers'::text, true))::json ->> 'x-portal-token'::text)) AND (EXISTS ( SELECT 1
   FROM customer_portal_tokens t
  WHERE ((t.token = payment_submissions.portal_token) AND (t.is_active = true) AND ((t.expires_at IS NULL) OR (t.expires_at > now())))))));

CREATE POLICY "Anon can insert submissions with token" ON public.payment_submissions
  AS PERMISSIVE
  FOR INSERT
  TO anon
  WITH CHECK (((portal_token IS NOT NULL) AND (length(portal_token) >= 16) AND (EXISTS ( SELECT 1
   FROM customer_portal_tokens t
  WHERE ((t.token = payment_submissions.portal_token) AND (t.is_active = true) AND ((t.expires_at IS NULL) OR (t.expires_at > now())) AND (t.customer_id = payment_submissions.customer_id))))));

CREATE POLICY "Anon can view own submissions by token" ON public.payment_submissions
  AS PERMISSIVE
  FOR SELECT
  TO anon
  USING (((portal_token IS NOT NULL) AND (length(portal_token) >= 16) AND (portal_token = ((current_setting('request.headers'::text, true))::json ->> 'x-portal-token'::text)) AND (EXISTS ( SELECT 1
   FROM customer_portal_tokens t
  WHERE ((t.token = payment_submissions.portal_token) AND (t.is_active = true))))));

CREATE POLICY "Authenticated users can insert submissions" ON public.payment_submissions
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((is_staff(auth.uid()) OR (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid())))));

CREATE POLICY "Customers can view own payment_submissions" ON public.payment_submissions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid()))));

CREATE POLICY "Session customers can cancel own cash order submissions" ON public.payment_submissions
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (((cash_order_id IS NOT NULL) AND (status = 'submitted'::submission_status) AND (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid())))))
  WITH CHECK (((status = 'cancelled'::submission_status) AND (customer_id IN ( SELECT customers.id
   FROM customers
  WHERE (customers.auth_user_id = auth.uid())))));

CREATE POLICY "Staff can insert submissions" ON public.payment_submissions
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update submissions" ON public.payment_submissions
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view submissions" ON public.payment_submissions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can create payments" ON public.payments
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update payments" ON public.payments
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view payments" ON public.payments
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admin can insert overrides" ON public.penalty_cap_overrides
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admin can update overrides" ON public.penalty_cap_overrides
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Staff can view overrides" ON public.penalty_cap_overrides
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can insert penalties" ON public.penalty_fees
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can update penalties" ON public.penalty_fees
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Staff can view penalties" ON public.penalty_fees
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admin Finance can update waivers" ON public.penalty_waiver_requests
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "CSR can create waivers" ON public.penalty_waiver_requests
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can view waivers" ON public.penalty_waiver_requests
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admins can manage plan configurations" ON public.plan_configurations
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Authenticated can read plan configurations" ON public.plan_configurations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_read_inquiries" ON public.product_inquiries
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "authenticated_write_inquiries" ON public.product_inquiries
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Staff can view all profiles" ON public.profiles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "System can insert profiles" ON public.profiles
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((user_id = auth.uid()));

CREATE POLICY "Users can update own profile" ON public.profiles
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((user_id = auth.uid()));

CREATE POLICY "Users can view own profile" ON public.profiles
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((user_id = auth.uid()));

CREATE POLICY "Admin and staff can manage categories" ON public.promo_categories
  AS PERMISSIVE
  FOR ALL
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Public can read categories" ON public.promo_categories
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Admin and staff can manage category assignments" ON public.promo_category_assignments
  AS PERMISSIVE
  FOR ALL
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Public can read category assignments" ON public.promo_category_assignments
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING (true);

CREATE POLICY "Admin and staff can read views" ON public.promo_views
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Authenticated customers can insert own promo views" ON public.promo_views
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((is_staff(auth.uid()) OR (EXISTS ( SELECT 1
   FROM customers c
  WHERE ((c.id = promo_views.customer_id) AND (c.auth_user_id = auth.uid()))))));

CREATE POLICY "Active promos visible to all" ON public.promotions
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((is_active = true));

CREATE POLICY "Admin and staff can manage promos" ON public.promotions
  AS PERMISSIVE
  FOR ALL
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "admin_finance_read_reconciliation_log" ON public.reconciliation_log
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Staff can create reminders" ON public.reminder_logs
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (is_staff(auth.uid()));

CREATE POLICY "Staff can view reminders" ON public.reminder_logs
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admins can manage role_permissions" ON public.role_permissions
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Staff can view role_permissions" ON public.role_permissions
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "sales_log_auth_all" ON public.sales_log
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Admins can read schedule_audit_log" ON public.schedule_audit_log
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role)));

CREATE POLICY "Staff and admin can insert service jobs" ON public.service_jobs
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Staff and admin can update service jobs" ON public.service_jobs
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Staff and admin can view service jobs" ON public.service_jobs
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Staff insert own reads" ON public.staff_notification_reads
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (((user_id = auth.uid()) AND is_staff(auth.uid())));

CREATE POLICY "Users view own reads" ON public.staff_notification_reads
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));

CREATE POLICY "Staff can view notifications" ON public.staff_notifications
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Service role can insert suppressed emails" ON public.suppressed_emails
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((auth.role() = 'service_role'::text));

CREATE POLICY "Service role can read suppressed emails" ON public.suppressed_emails
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((auth.role() = 'service_role'::text));

CREATE POLICY "Admins can insert settings" ON public.system_settings
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Admins can update settings" ON public.system_settings
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Staff can view settings" ON public.system_settings
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (is_staff(auth.uid()));

CREATE POLICY "Admin Finance can view all timesheet entries" ON public.timesheet_entries
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR timesheet_can_view_all(auth.uid())));

CREATE POLICY "Admins manage timesheet entries" ON public.timesheet_entries
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Users can insert own timesheet entries" ON public.timesheet_entries
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((user_id = auth.uid()));

CREATE POLICY "Users can update own timesheet entries" ON public.timesheet_entries
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING ((user_id = auth.uid()))
  WITH CHECK ((user_id = auth.uid()));

CREATE POLICY "Users can view own timesheet entries" ON public.timesheet_entries
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));

CREATE POLICY "ts_history_admin_read" ON public.timesheet_monthly_history
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND ((ur.role)::text = 'admin'::text)))));

CREATE POLICY "ts_history_admin_write" ON public.timesheet_monthly_history
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND ((ur.role)::text = 'admin'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND ((ur.role)::text = 'admin'::text)))));

CREATE POLICY "Admin Finance can view all timesheet profiles" ON public.timesheet_profiles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR timesheet_can_view_all(auth.uid())));

CREATE POLICY "Admins manage timesheet profiles" ON public.timesheet_profiles
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Users can view own timesheet profile" ON public.timesheet_profiles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));

CREATE POLICY "Staff and admin can insert trade ins" ON public.trade_ins
  AS PERMISSIVE
  FOR INSERT
  TO public
  WITH CHECK ((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Staff and admin can update trade ins" ON public.trade_ins
  AS PERMISSIVE
  FOR UPDATE
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Staff and admin can view trade ins" ON public.trade_ins
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((EXISTS ( SELECT 1
   FROM user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::app_role, 'staff'::app_role]))))));

CREATE POLICY "Admins manage overrides" ON public.user_permission_overrides
  AS PERMISSIVE
  FOR ALL
  TO public
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Users can read own overrides" ON public.user_permission_overrides
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((auth.uid() = user_id));

CREATE POLICY "Admins can manage all roles" ON public.user_roles
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Users can view own roles" ON public.user_roles
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- Function EXECUTE privileges (reproduced from live)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public._award_birthday_reward(p_customer_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._award_birthday_reward(p_customer_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.admin_correct_birthday(p_customer_id uuid, p_birthday date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_correct_birthday(p_customer_id uuid, p_birthday date) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.admin_keep_allocation_override(p_allocation_id uuid, p_amount numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_keep_allocation_override(p_allocation_id uuid, p_amount numeric) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.admin_renumber_installment(p_schedule_id uuid, p_new_number integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_renumber_installment(p_schedule_id uuid, p_new_number integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.admin_update_schedule_base(p_schedule_id uuid, p_new_base numeric, p_new_total_due numeric, p_is_paid boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_schedule_base(p_schedule_id uuid, p_new_base numeric, p_new_total_due numeric, p_is_paid boolean) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.allocate_payment_atomic(p_account_id uuid, p_amount_paid numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_remarks text, p_user_id uuid, p_currency text, p_is_downpayment boolean, p_submitted_by_type text, p_submitted_by_name text, p_preview boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_payment_atomic(p_account_id uuid, p_amount_paid numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_remarks text, p_user_id uuid, p_currency text, p_is_downpayment boolean, p_submitted_by_type text, p_submitted_by_name text, p_preview boolean) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.approve_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.audit_account(p_invoice_number text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_account(p_invoice_number text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.audit_all_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_all_accounts() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.audit_delete_cleanup_invariants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_delete_cleanup_invariants() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.auto_backup_payment() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_backup_payment() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.auto_backup_payment() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.autocheck_sales_log_eligible() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.autocheck_sales_log_eligible() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.autocheck_sales_log_eligible() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.autofill_sales_log_support_verifier() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.autofill_sales_log_support_verifier() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.autofill_sales_log_support_verifier() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.check_allocation_ceiling() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_allocation_ceiling() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_allocation_ceiling() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.check_customer_email_conflict(p_customer_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_customer_email_conflict(p_customer_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.check_duplicate_payment(p_account_id uuid, p_amount numeric, p_date date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_duplicate_payment(p_account_id uuid, p_amount numeric, p_date date) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_duplicate_payment(p_account_id uuid, p_amount numeric, p_date date) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.clear_cash_order_expiry_on_complete() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_cash_order_expiry_on_complete() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.clear_cash_order_expiry_on_complete() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.consume_lots_fifo(p_member_id uuid, p_redemption_id uuid, p_amount integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_lots_fifo(p_member_id uuid, p_redemption_id uuid, p_amount integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.deactivate_expired_promotions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_expired_promotions() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.deactivate_expired_promotions() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.delete_account_atomic(p_account_id uuid, p_performed_by_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_account_atomic(p_account_id uuid, p_performed_by_user_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.delete_email(queue_name text, message_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_email(queue_name text, message_id bigint) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.delete_schedule_row_atomic(p_schedule_row_id uuid, p_account_id uuid, p_admin_user_id uuid, p_old_base_amount numeric, p_reason text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_schedule_row_atomic(p_schedule_row_id uuid, p_account_id uuid, p_admin_user_id uuid, p_old_base_amount numeric, p_reason text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.derive_order_loyalty_jpy(p_account_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.derive_order_loyalty_jpy(p_account_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.derive_order_loyalty_jpy(p_account_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.email_queue_dispatch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_queue_dispatch() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.email_queue_wake() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.email_queue_wake() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.enforce_plan_minimum_amount() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_plan_minimum_amount() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_plan_minimum_amount() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.enforce_test_invoice_prefix() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_test_invoice_prefix() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_test_invoice_prefix() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.enqueue_email(queue_name text, payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_email(queue_name text, payload jsonb) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_at_risk_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_at_risk_accounts() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_at_risk_accounts() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_at_risk_detail() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_at_risk_detail() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_at_risk_detail() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_cfo_insights() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_cfo_insights() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_cfo_insights() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_cohort_timeline() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_cohort_timeline() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_cohort_timeline() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_coverage_ratio() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_coverage_ratio() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_coverage_ratio() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_evaluate_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_evaluate_alerts() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_evaluate_alerts() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_gross_profit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_gross_profit() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_gross_profit() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_monthly_inflow(target_month date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_monthly_inflow(target_month date) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_monthly_inflow(target_month date) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_net_exposure_risk(resale_pct numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_net_exposure_risk(resale_pct numeric) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_net_exposure_risk(resale_pct numeric) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_penalty_driven_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_penalty_driven_accounts() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_penalty_driven_accounts() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_penalty_revenue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_penalty_revenue() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_penalty_revenue() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_plan_performance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_plan_performance() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_plan_performance() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.fc_portfolio_value() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fc_portfolio_value() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fc_portfolio_value() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.generate_customer_code() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_customer_code() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_customer_code() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_aging_buckets(p_scope text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_aging_buckets(p_scope text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_audit_filter_options() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_audit_filter_options() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_bulk_setup_invite_candidates(p_test_codes text[], p_limit integer, p_count_only boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bulk_setup_invite_candidates(p_test_codes text[], p_limit integer, p_count_only boolean) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_cash_orders_monthly() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_cash_orders_monthly() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_collection_analytics(currency_mode text, months_back integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_collection_analytics(currency_mode text, months_back integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_collection_analytics(currency_mode text, months_back integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_daily_new_layaway_sales(currency_mode text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_new_layaway_sales(currency_mode text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_new_layaway_sales(currency_mode text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_daily_new_layaway_sales_last_month(currency_mode text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_daily_new_layaway_sales_last_month(currency_mode text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_daily_new_layaway_sales_last_month(currency_mode text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_forecast_6m() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_forecast_6m() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_forecast_drilldown(p_month text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_forecast_drilldown(p_month text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_monthly_analytics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_monthly_analytics() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_monthly_sales(currency_mode text, months_back integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_monthly_sales(currency_mode text, months_back integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_monthly_tracking_export(p_year integer, p_month integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_monthly_tracking_export(p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monthly_tracking_export(p_year integer, p_month integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_recent_qualifying_order(p_customer_id uuid, p_lookback_days integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_staff_performance(months_back integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_staff_performance(months_back integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_top_outstanding_customers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_top_outstanding_customers() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_top_outstanding_customers() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_tracking_for_invoices(p_invoices text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_tracking_for_invoices(p_invoices text[]) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_tracking_for_invoices(p_invoices text[]) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_trade_kpis() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_trade_kpis() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_trade_monthly_trends(p_months_back integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_trade_monthly_trends(p_months_back integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.get_unpaid_schedule(p_account_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_unpaid_schedule(p_account_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.has_role(_user_id uuid, _role app_role) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(_user_id uuid, _role app_role) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(_user_id uuid, _role app_role) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.insert_lot_and_extend(p_member_id uuid, p_source_type loyalty_lot_source_type, p_source_reference text, p_amount integer, p_earned_at timestamp with time zone, p_expires_at timestamp with time zone, p_notes text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_lot_and_extend(p_member_id uuid, p_source_type loyalty_lot_source_type, p_source_reference text, p_amount integer, p_earned_at timestamp with time zone, p_expires_at timestamp with time zone, p_notes text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.insert_payment_submission_guarded(p_account_id uuid, p_customer_id uuid, p_submitted_amount numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_notes text, p_submission_type text, p_sender_name text, p_force boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_payment_submission_guarded(p_account_id uuid, p_customer_id uuid, p_submitted_amount numeric, p_payment_date date, p_payment_method text, p_reference_number text, p_notes text, p_submission_type text, p_sender_name text, p_force boolean) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.is_staff(_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff(_user_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_staff(_user_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.log_admin_table_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_admin_table_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_admin_table_change() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.log_schedule_deletion() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_schedule_deletion() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_schedule_deletion() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.loyalty_lots_set_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_lots_set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.loyalty_lots_set_updated_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.loyalty_members_set_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_members_set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.loyalty_members_set_updated_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.loyalty_transactions_no_update() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loyalty_transactions_no_update() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.loyalty_transactions_no_update() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.monthly_inflow_by_plan_6m() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.monthly_inflow_by_plan_6m() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.move_to_dlq(source_queue text, dlq_name text, message_id bigint, payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_to_dlq(source_queue text, dlq_name text, message_id bigint, payload jsonb) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_account_created() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_account_created() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_account_created() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_cash_order_created() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_cash_order_created() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_cash_order_created() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_customer_notified() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_customer_notified() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_customer_notified() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_extension_event() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_extension_event() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_extension_event() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_loyalty_enrolled() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_loyalty_enrolled() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_loyalty_enrolled() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_submission_created() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_submission_created() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_submission_created() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_submission_reviewed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_submission_reviewed() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_submission_reviewed() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_tier_changed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_tier_changed() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_tier_changed() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.notify_waiver_event() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_waiver_event() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_waiver_event() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.prevent_base_amount_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_base_amount_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_base_amount_change() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.prevent_birthday_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_birthday_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_birthday_change() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.prevent_customer_code_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_customer_code_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_customer_code_change() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.prevent_paid_row_modification() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_paid_row_modification() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_paid_row_modification() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.prevent_payment_backup_modification() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_payment_backup_modification() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_payment_backup_modification() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.prevent_schedule_deletion() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_schedule_deletion() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_schedule_deletion() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.prevent_total_amount_change() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_total_amount_change() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_total_amount_change() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.read_email_batch(queue_name text, batch_size integer, vt integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_email_batch(queue_name text, batch_size integer, vt integer) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.reconcile_failing_accounts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_failing_accounts() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.restore_lots_for_redemption(p_redemption_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_lots_for_redemption(p_redemption_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.restore_loyalty_points(p_revoke_transaction_id uuid, p_created_by_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restore_loyalty_points(p_revoke_transaction_id uuid, p_created_by_user_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.revalidate_account_from_vault(p_invoice_number text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revalidate_account_from_vault(p_invoice_number text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.revalidate_account_from_vault(p_invoice_number text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.revoke_loyalty_points(p_member_id uuid, p_source_reference text, p_spend_jpy numeric, p_account_id uuid, p_cash_order_id uuid, p_payment_id uuid, p_invoice_number text, p_notes text, p_created_by_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_loyalty_points(p_member_id uuid, p_source_reference text, p_spend_jpy numeric, p_account_id uuid, p_cash_order_id uuid, p_payment_id uuid, p_invoice_number text, p_notes text, p_created_by_user_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.set_completed_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_completed_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_completed_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.set_timesheet_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_timesheet_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_timesheet_updated_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_updated_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.staff_display_name(p_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_display_name(p_user_id uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.staff_notify(p_type text, p_title text, p_body text, p_account_id uuid, p_customer_id uuid, p_invoice text, p_meta jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_notify(p_type text, p_title text, p_body text, p_account_id uuid, p_customer_id uuid, p_invoice text, p_meta jsonb) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.sync_auth_email_to_customer() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_auth_email_to_customer() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_auth_email_to_customer() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.timesheet_can_view_all(uid uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.timesheet_can_view_all(uid uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.timesheet_can_view_all(uid uuid) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.unwaive_penalty_atomic(p_waiver_id uuid, p_user_id uuid, p_user_email text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unwaive_penalty_atomic(p_waiver_id uuid, p_user_id uuid, p_user_email text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.unwaive_penalty_atomic(p_waiver_id uuid, p_user_id uuid, p_user_email text) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.update_cash_orders_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_cash_orders_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_cash_orders_updated_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.update_loyalty_members_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_loyalty_members_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_loyalty_members_updated_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.update_loyalty_promos_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_loyalty_promos_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_loyalty_promos_updated_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.update_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_updated_at() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.validate_bulk_import(p_rows jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_bulk_import(p_rows jsonb) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_bulk_import(p_rows jsonb) TO sandbox_exec;
REVOKE ALL ON FUNCTION public.validate_schedule_chronology() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_schedule_chronology() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_schedule_chronology() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.validate_schedule_start_year() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_schedule_start_year() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_schedule_start_year() TO sandbox_exec;
REVOKE ALL ON FUNCTION public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.void_redemption_atomic(p_redemption_id uuid, p_user_id uuid, p_user_email text, p_void_reason text) TO sandbox_exec;

-- ---------------------------------------------------------------------------
-- Realtime publication
-- ---------------------------------------------------------------------------
ALTER PUBLICATION supabase_realtime ADD TABLE public.account_services;
ALTER PUBLICATION supabase_realtime ADD TABLE public.cash_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.financial_alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.layaway_accounts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.layaway_schedule;
ALTER PUBLICATION supabase_realtime ADD TABLE public.payment_allocations;
ALTER PUBLICATION supabase_realtime ADD TABLE public.payment_submissions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.payments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.penalty_fees;

-- ---------------------------------------------------------------------------
-- Cron jobs
-- ---------------------------------------------------------------------------
-- CRON JOBS: NOT CAPTURED (cron.job unreadable from this environment)
-- error: Command '['psql', '-A', '-t', '-c', "\n    SELECT COALESCE(jsonb_agg(jsonb_build_object(\n      'jobname', jobname,\n      'schedule', schedule,\n      'command', command\n    ) ORDER BY jobname), '[]'::jsonb)::text\n    FROM cron.job;\n    "]' returned non-zero exit status 1.
