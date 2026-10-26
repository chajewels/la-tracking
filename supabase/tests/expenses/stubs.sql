-- Minimal stand-ins for the live Hub objects the expenses migration depends on.
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
CREATE TABLE public.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), role public.app_role NOT NULL,
  permission_key text NOT NULL, is_allowed boolean NOT NULL DEFAULT false,
  UNIQUE (role, permission_key));
CREATE TABLE public.user_permission_overrides (user_id uuid, permission_key text, granted boolean);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

-- Copied verbatim from 20260909055336_98ecb36a-8403-408e-951c-768e8cac6b6d.sql
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN _user_id IS NULL THEN false
    WHEN public.has_role(_user_id, 'admin'::public.app_role) THEN true
    ELSE COALESCE(
      (SELECT o.granted FROM public.user_permission_overrides o
        WHERE o.user_id = _user_id AND o.permission_key = _permission_key LIMIT 1),
      (SELECT bool_or(rp.is_allowed) FROM public.role_permissions rp
         JOIN public.user_roles ur ON ur.role = rp.role
        WHERE ur.user_id = _user_id AND rp.permission_key = _permission_key),
      false)
  END
$$;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated, service_role;

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

-- People: admin A, finance F (no expense rights), staff S granted manage only by override.
INSERT INTO public.user_roles VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000f', 'finance'),
  ('00000000-0000-0000-0000-000000000005', 'staff');
INSERT INTO public.user_permission_overrides VALUES
  ('00000000-0000-0000-0000-000000000005', 'manage_expenses', true);
GRANT SELECT ON public.audit_logs TO authenticated; -- test-only, so assertions can count audit rows
