-- Stand-ins for the live money tables the ledger reads (baseline columns only).
CREATE TYPE public.account_currency AS ENUM ('PHP','JPY');
CREATE TYPE public.account_status AS ENUM ('active','completed','cancelled','overdue','forfeited','final_settlement','reactivated','extension_active','final_forfeited');
CREATE TYPE public.cash_order_status AS ENUM ('pending','completed','cancelled','expired');
CREATE TYPE public.allocation_type AS ENUM ('penalty','installment');
CREATE TYPE public.store_credit_lot_status AS ENUM ('active','consumed','expired','voided');
CREATE TYPE public.store_credit_txn_type AS ENUM ('issued','redeemed','expired','voided','adjusted');
CREATE TABLE public.layaway_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL DEFAULT gen_random_uuid(), invoice_number text NOT NULL,
  currency account_currency NOT NULL, total_amount numeric(15,2) NOT NULL, total_paid numeric(15,2) NOT NULL DEFAULT 0,
  remaining_balance numeric(15,2) NOT NULL, status account_status NOT NULL DEFAULT 'active', order_date date NOT NULL DEFAULT current_date,
  shipping_fee numeric DEFAULT 0, forfeited_at timestamptz, cancelled_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  is_test boolean NOT NULL DEFAULT false, is_trade boolean NOT NULL DEFAULT false);
CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, amount_paid numeric(15,2) NOT NULL, currency account_currency NOT NULL,
  date_paid date NOT NULL DEFAULT current_date, payment_method text DEFAULT 'cash', reference_number text, voided_at timestamptz);
CREATE TABLE public.payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), payment_id uuid NOT NULL, schedule_id uuid NOT NULL DEFAULT gen_random_uuid(),
  allocation_type allocation_type NOT NULL, allocated_amount numeric(15,2) NOT NULL);
CREATE TABLE public.cash_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL DEFAULT gen_random_uuid(), invoice_number text NOT NULL,
  currency account_currency NOT NULL DEFAULT 'JPY', total_amount numeric(12,2) NOT NULL, total_paid numeric(12,2) NOT NULL DEFAULT 0,
  remaining_balance numeric(12,2) NOT NULL, status cash_order_status NOT NULL DEFAULT 'pending', order_date date NOT NULL DEFAULT current_date,
  shipping_fee numeric DEFAULT 0, cod_fee numeric DEFAULT 0, cancelled_at timestamptz, expired_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  payment_method text, refund_status text, refund_note text, refund_decided_at timestamptz, is_test boolean NOT NULL DEFAULT false,
  is_trade boolean NOT NULL DEFAULT false, item_description text);
CREATE TABLE public.cash_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cash_order_id uuid NOT NULL, amount_paid numeric(12,2) NOT NULL, currency account_currency NOT NULL,
  date_paid date NOT NULL DEFAULT current_date, payment_method text, reference_number text, voided_at timestamptz);
CREATE TABLE public.store_credit_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL DEFAULT gen_random_uuid(), currency account_currency NOT NULL,
  original_amount numeric(12,2) NOT NULL, remaining_amount numeric(12,2) NOT NULL, status store_credit_lot_status NOT NULL DEFAULT 'active',
  source_type text NOT NULL, source_account_id uuid, source_cash_order_id uuid, notes text, issued_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.store_credit_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL DEFAULT gen_random_uuid(), lot_id uuid, txn_type store_credit_txn_type NOT NULL,
  amount numeric(12,2) NOT NULL, currency account_currency NOT NULL, account_id uuid, cash_order_id uuid, notes text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.square_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), environment text, test boolean DEFAULT false);
CREATE TABLE public.square_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), square_refund_id text, square_payment_row uuid, cash_order_id uuid, amount_jpy bigint, status text,
  reason text, provider_created_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.paidy_payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), test boolean DEFAULT false);
CREATE TABLE public.paidy_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), paidy_payment_row uuid, cash_order_id uuid, refund_id text, amount_jpy numeric,
  refunded_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.timesheet_monthly_history (
  month_key text NOT NULL PRIMARY KEY, csr_net numeric DEFAULT 0 NOT NULL, liveadmin_net numeric DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL);
CREATE TYPE public.resale_status AS ENUM ('In stock','Sold');
CREATE TABLE public.website_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL DEFAULT gen_random_uuid(), price_jpy integer NOT NULL DEFAULT 0,
  cost_basis integer, stock_qty integer NOT NULL DEFAULT 0 CHECK (stock_qty >= 0));
CREATE TABLE public.layaway_account_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, product_id uuid, website_product_id uuid, variant_id uuid,
  title text NOT NULL DEFAULT 'Piece', sku text, quantity integer NOT NULL DEFAULT 1, unit_price_jpy numeric, line_total_jpy numeric,
  image_url text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.cash_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cash_order_id uuid NOT NULL, product_id uuid, website_product_id uuid, variant_id uuid,
  title text NOT NULL DEFAULT 'Piece', sku text, quantity integer NOT NULL DEFAULT 1, unit_price_jpy numeric, line_total_jpy numeric,
  image_url text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.trade_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date_trade date NOT NULL DEFAULT current_date, customer_id uuid NOT NULL DEFAULT gen_random_uuid(),
  old_invoice_number text NOT NULL DEFAULT '0', new_invoice_number text, item_code text NOT NULL DEFAULT 'X', item_description text NOT NULL DEFAULT 'piece',
  trade_amount numeric(12,2) NOT NULL DEFAULT 0, resale_amount numeric(12,2), resale_status resale_status NOT NULL DEFAULT 'In stock',
  notes text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
