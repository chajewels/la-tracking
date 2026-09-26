-- ============================================================================
-- Media cut-outs (background removal, PR 1) — LOCAL test stub (2026-10-05).
-- NEVER RUN THIS ON LIVE: it DROPS schema public.
--
-- Builds, in an EMPTY throwaway Postgres, only what migration
-- 20261006100000_media_cutouts.sql reads: the website product / variant /
-- media / category tables with the live column names, settings, bell, audit
-- and profile tables; is_staff / has_permission; auth.uid() from a GUC;
-- stand-ins for pg_cron, pg_net (it RECORDS each call) and Supabase Vault.
--
--   initdb -D /tmp/cutouts --locale=C -E UTF8 -U postgres
--   pg_ctl -D /tmp/cutouts -o "-p 55471 -k /tmp" start
--   export PGOPTIONS='-c cutout.local_stub=yes'
--   P="psql -h /tmp -p 55471 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20261005_media_cutouts_local_stub.sql
--   $P supabase/migrations/20261006100000_media_cutouts.sql
--   $P supabase/migrations/20261006100000_media_cutouts.sql   # re-run is safe
--   $P docs/sql/20261005_media_cutouts_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('cutout.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c cutout.local_stub=yes'' — this file drops schema public';
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
CREATE TYPE public.website_product_status AS ENUM ('draft','active','archived');

CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE public.perm (user_id uuid, key text);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE FUNCTION public.is_staff(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('admin','staff','finance','csr')) $$;
CREATE FUNCTION public.has_permission(_user_id uuid, _permission_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT public.has_role(_user_id, 'admin') OR EXISTS (SELECT 1 FROM public.perm WHERE user_id = _user_id AND key = _permission_key) $$;

-- Website catalogue, live column names (20260908030829 + Page365 PR 1).
CREATE TABLE public.website_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text UNIQUE NOT NULL,
  slug text UNIQUE NOT NULL, name text NOT NULL, status public.website_product_status NOT NULL DEFAULT 'draft');
CREATE TABLE public.website_product_variants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.website_products(id) ON DELETE CASCADE, sort integer NOT NULL DEFAULT 0);
CREATE TABLE public.website_product_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.website_product_variants(id) ON DELETE CASCADE,
  url text NOT NULL, alt text, sort integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  page365_photo_id bigint, page365_photo_version text);
CREATE TABLE public.website_categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, name text NOT NULL);
CREATE TABLE public.website_category_products (category_id uuid NOT NULL REFERENCES public.website_categories(id),
  product_id uuid NOT NULL REFERENCES public.website_products(id), sort_order integer NOT NULL DEFAULT 0);

CREATE TABLE public.system_settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, value jsonb,
  description text, updated_by_user_id uuid, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.staff_notifications (id uuid DEFAULT gen_random_uuid(), type text NOT NULL, title text NOT NULL, body text,
  account_id uuid, customer_id uuid, invoice_number text, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE public.audit_logs (id uuid DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL,
  old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.profiles (user_id uuid, full_name text);

-- Supabase's default grants: browser roles get table privileges; RLS decides.
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;

-- pg_cron / pg_net / Vault stand-ins. net.http_post RECORDS each call so the
-- revalidation trigger can be asserted.
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL,
  command text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $$;
CREATE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT EXISTS (SELECT 1 FROM d) $$;
CREATE SCHEMA net;
CREATE TABLE net.calls (id bigserial PRIMARY KEY, url text, body jsonb, at timestamptz DEFAULT now());
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net.calls (url, body) VALUES (url, body) RETURNING id $$;
CREATE SCHEMA vault;
CREATE TABLE vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, secret text);
INSERT INTO vault.secrets (name, secret) VALUES ('email_queue_service_role_key', 'local-dummy-not-a-key');
CREATE VIEW vault.decrypted_secrets AS SELECT id, name, secret AS decrypted_secret FROM vault.secrets;
