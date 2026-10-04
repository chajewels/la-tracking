-- Minimal live-shaped tables for 20261105100000 (columns the patched code reads).
CREATE SEQUENCE public.web_order_number_seq START 900055;
CREATE TABLE public.invoice_numbers (
  invoice_number text PRIMARY KEY,
  source text NOT NULL CHECK (source = ANY (ARRAY['cash_order','layaway_account'])),
  order_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.checkout_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mode text NOT NULL,
  reserved_invoice_seq bigint, consumed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 day');
CREATE UNIQUE INDEX uq_checkout_quotes_reserved_invoice_seq ON public.checkout_quotes (reserved_invoice_seq) WHERE reserved_invoice_seq IS NOT NULL;
CREATE TABLE public.web_order_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_seq bigint NOT NULL UNIQUE,
  web_reference text NOT NULL UNIQUE, status text NOT NULL DEFAULT 'to_confirm');
CREATE TABLE public.cash_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text NOT NULL,
  web_reference text, quote_id uuid);
CREATE TABLE public.layaway_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text NOT NULL,
  web_reference text, quote_id uuid);
