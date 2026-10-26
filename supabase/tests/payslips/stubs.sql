-- Minimal stand-ins for the live Hub objects the payslips migration depends on.
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;

CREATE TYPE public.app_role AS ENUM ('admin', 'staff', 'finance', 'csr', 'customer', 'live_agent');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);

-- Copied verbatim from the baseline (20260705230000_baseline_live_schema.sql).
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE TABLE public.profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL, full_name text NOT NULL, email text);

CREATE TABLE public.timesheet_profiles (
  id uuid DEFAULT gen_random_uuid() NOT NULL, user_id uuid NOT NULL UNIQUE, template_type text NOT NULL,
  job_title text, timezone text DEFAULT 'Asia/Manila'::text NOT NULL, basic_salary numeric, allowance numeric,
  active boolean DEFAULT true NOT NULL, can_view_all boolean DEFAULT false NOT NULL);

-- Copied verbatim from the baseline.
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
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.timesheet_can_view_all(uuid) TO authenticated;

CREATE TABLE public.system_settings (key text PRIMARY KEY, value jsonb);
INSERT INTO public.system_settings VALUES ('php_jpy_rate', '"0.42"'::jsonb);

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL,
  action text NOT NULL, old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false,
  file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT ON storage.objects TO authenticated;

-- People: admin A; Brenda B (staff + finance, can_view_all); CSR C; Live Admin L; finance-only F; staff S.
INSERT INTO public.user_roles VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'staff'),
  ('00000000-0000-0000-0000-00000000000b', 'finance'),
  ('00000000-0000-0000-0000-00000000000c', 'csr'),
  ('00000000-0000-0000-0000-0000000000a1', 'live_agent'),
  ('00000000-0000-0000-0000-00000000000f', 'finance'),
  ('00000000-0000-0000-0000-000000000005', 'staff');
INSERT INTO public.profiles (user_id, full_name) VALUES
  ('00000000-0000-0000-0000-00000000000b', 'Brendalyn Bumagat'),
  ('00000000-0000-0000-0000-00000000000c', 'Kaila Cruz'),
  ('00000000-0000-0000-0000-0000000000a1', 'Jose Reyes');
INSERT INTO public.timesheet_profiles (user_id, template_type, job_title, basic_salary, allowance, can_view_all) VALUES
  ('00000000-0000-0000-0000-00000000000b', 'csr', 'CSR Lead', 15000, 2000, true),
  ('00000000-0000-0000-0000-00000000000c', 'csr', 'CSR', 12000, 2000, false),
  ('00000000-0000-0000-0000-0000000000a1', 'live_admin', 'Live Admin', NULL, NULL, false),
  ('00000000-0000-0000-0000-000000000005', 'csr', NULL, 12000, 0, false);
GRANT SELECT ON public.audit_logs TO authenticated; -- test-only, so assertions can count audit rows
