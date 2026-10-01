-- ============================================================================
-- Cart reminders (stages A/B) — LOCAL test stub (2026-10-01).
-- NEVER RUN THIS ON LIVE: it DROPS schema public.
--
-- Builds, in an EMPTY throwaway Postgres, only what migration
-- 20261021100000_cart_reminders.sql reads: customers, the website catalogue
-- (products / variants / media), cash_orders, layaway_accounts,
-- checkout_quotes, suppressed_emails, system_settings; is_staff; auth.uid()
-- from a GUC; stand-ins for pg_cron, pg_net and Supabase Vault.
--
--   initdb -D /tmp/cartrem --locale=C -E UTF8 -U postgres
--   pg_ctl -D /tmp/cartrem -o "-p 55462 -k /tmp" start
--   export PGOPTIONS='-c cartrem.local_stub=yes'
--   P="psql -h /tmp -p 55462 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20261021_cart_reminders_local_stub.sql
--   $P supabase/migrations/20261021100000_cart_reminders.sql
--   $P supabase/migrations/20261021100000_cart_reminders.sql   # re-run is safe
--   $P docs/sql/20261021_cart_reminders_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('cartrem.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c cartrem.local_stub=yes'' — this file drops schema public';
  END IF;
  IF to_regclass('public.payments') IS NOT NULL OR to_regclass('public.layaway_schedule') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
END
$guard$;

DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE;
DROP SCHEMA IF EXISTS cron CASCADE; DROP SCHEMA IF EXISTS net CASCADE; DROP SCHEMA IF EXISTS vault CASCADE;
CREATE SCHEMA public; CREATE SCHEMA auth;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

CREATE TYPE public.app_role AS ENUM ('admin','staff','finance','csr','live_agent');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.is_staff(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('admin','staff','finance','csr')) $$;

-- Live column names (information_schema on live, 2026-10-01).
CREATE TABLE public.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_code text, full_name text, email text,
  location text, is_test boolean NOT NULL DEFAULT false);
CREATE TABLE public.website_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text, slug text NOT NULL, name text NOT NULL,
  name_ja text, status text NOT NULL DEFAULT 'draft');
CREATE TABLE public.website_product_variants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.website_products(id) ON DELETE CASCADE,
  size text, stone text, price_jpy integer NOT NULL, stock_qty integer NOT NULL DEFAULT 0, sort integer DEFAULT 0);
CREATE TABLE public.website_product_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.website_product_variants(id) ON DELETE CASCADE,
  url text NOT NULL, alt text, sort integer NOT NULL DEFAULT 0);
CREATE TABLE public.cash_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES public.customers(id),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.layaway_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES public.customers(id),
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.checkout_quotes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid NOT NULL REFERENCES public.customers(id),
  mode text NOT NULL DEFAULT 'full', term_months integer, settlement_currency text NOT NULL DEFAULT 'JPY',
  consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.suppressed_emails (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL, reason text,
  metadata jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.system_settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, value jsonb,
  description text, updated_by_user_id uuid, updated_at timestamptz NOT NULL DEFAULT now());

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
-- Supabase also grants browser roles on tables created LATER (default privileges); RLS decides.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- pg_cron / pg_net / Vault stand-ins (same as the stage D stub).
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL,
  command text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT EXISTS (SELECT 1 FROM d) $$;
CREATE SCHEMA net;
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE SCHEMA vault;
CREATE TABLE vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, secret text);
INSERT INTO vault.secrets (name, secret) VALUES ('email_queue_service_role_key', 'local-dummy-not-a-key');
CREATE VIEW vault.decrypted_secrets AS SELECT id, name, secret AS decrypted_secret FROM vault.secrets;
