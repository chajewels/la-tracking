-- ============================================================================
-- Payment reminders (stage D) + 48h reservation bell — LOCAL test stub
-- (2026-10-04). NEVER RUN THIS ON LIVE: it DROPS schema public.
--
-- Builds, in an EMPTY throwaway Postgres, only what migration
-- 20261004100000_web_payment_reminders.sql reads: the order, customer,
-- submission, settings, bell, audit, profile and email-log tables with the
-- live column names and enum types; is_staff / has_role / has_permission;
-- auth.uid() from a GUC; stand-ins for pg_cron, pg_net and Supabase Vault.
--
--   initdb -D /tmp/payrem --locale=C -E UTF8 -U postgres
--   pg_ctl -D /tmp/payrem -o "-p 55461 -k /tmp" start
--   export PGOPTIONS='-c payrem.local_stub=yes'
--   P="psql -h /tmp -p 55461 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20261004_web_payment_reminders_local_stub.sql
--   $P supabase/migrations/20261004100000_web_payment_reminders.sql
--   $P supabase/migrations/20261004100000_web_payment_reminders.sql   # re-run is safe
--   $P docs/sql/20261004_web_payment_reminders_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('payrem.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c payrem.local_stub=yes'' — this file drops schema public';
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

-- Live enum types (baseline 20260705230000).
CREATE TYPE public.cash_order_status AS ENUM ('pending','completed','cancelled','expired');
CREATE TYPE public.account_status AS ENUM ('active','overdue','completed','cancelled','forfeited','final_forfeited','extension_active','reactivated','final_settlement');
CREATE TYPE public.account_currency AS ENUM ('PHP','JPY');
CREATE TYPE public.submission_status AS ENUM ('submitted','under_review','confirmed','rejected');
CREATE TYPE public.app_role AS ENUM ('admin','staff','finance','csr','live_agent');

CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE public.perm (user_id uuid, key text);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE FUNCTION public.is_staff(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('admin','staff','finance','csr')) $$;
CREATE FUNCTION public.has_permission(_user_id uuid, _permission_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT public.has_role(_user_id, 'admin') OR EXISTS (SELECT 1 FROM public.perm WHERE user_id = _user_id AND key = _permission_key) $$;

CREATE TABLE public.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), full_name text, email text,
  is_test boolean NOT NULL DEFAULT false);
CREATE TABLE public.cash_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id), status public.cash_order_status NOT NULL DEFAULT 'pending',
  source_channel text NOT NULL DEFAULT 'hub_manual', payment_status text, ready_confirmed_at timestamptz,
  transfer_due_at timestamptz, expires_at timestamptz, remaining_balance numeric(12,2) NOT NULL DEFAULT 0,
  total_amount numeric(12,2) NOT NULL DEFAULT 0, customer_lang text, currency public.account_currency NOT NULL DEFAULT 'JPY',
  web_reference text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.layaway_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text NOT NULL,
  customer_id uuid NOT NULL REFERENCES public.customers(id), status public.account_status NOT NULL DEFAULT 'active',
  source_channel text NOT NULL DEFAULT 'hub_manual', ready_confirmed_at timestamptz, transfer_due_at timestamptz,
  total_paid numeric(12,2) NOT NULL DEFAULT 0, downpayment_amount numeric(12,2) NOT NULL DEFAULT 0,
  total_amount numeric(12,2) NOT NULL DEFAULT 0, customer_lang text, currency public.account_currency NOT NULL DEFAULT 'JPY',
  web_reference text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.payment_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_id uuid,
  account_id uuid, cash_order_id uuid, status public.submission_status NOT NULL DEFAULT 'submitted');
CREATE TABLE public.payment_submission_allocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL, account_id uuid NOT NULL, invoice_number text NOT NULL DEFAULT '', allocated_amount numeric(15,2) NOT NULL DEFAULT 0);
CREATE TABLE public.system_settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, value jsonb,
  description text, updated_by_user_id uuid, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.staff_notifications (id uuid DEFAULT gen_random_uuid(), type text NOT NULL, title text NOT NULL, body text,
  account_id uuid, customer_id uuid, invoice_number text, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE public.audit_logs (id uuid DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL,
  old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.profiles (user_id uuid, full_name text);
CREATE TABLE public.email_send_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id text, template_name text NOT NULL,
  recipient_email text NOT NULL, status text NOT NULL, error_message text, metadata jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text, channel text, request_id text);

-- Supabase's default grants: browser roles get table privileges; RLS decides.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;

-- pg_cron / pg_net / Vault stand-ins (same as the Page365 schedule stub).
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
