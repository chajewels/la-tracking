-- Minimal stand-ins for the live Hub objects the timesheet-corrections migration depends on.
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

-- timesheet_entries as on the baseline: columns, unique key, updated_at trigger and the five RLS policies.
CREATE TABLE public.timesheet_entries (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY, user_id uuid NOT NULL, work_date date NOT NULL,
  am_in timestamptz, am_out timestamptz, pm_in timestamptz, pm_out timestamptz, note text,
  created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT timesheet_entries_user_id_work_date_key UNIQUE (user_id, work_date));
CREATE FUNCTION public.set_timesheet_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
CREATE TRIGGER trg_timesheet_entries_updated BEFORE UPDATE ON public.timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_timesheet_updated_at();
ALTER TABLE public.timesheet_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admin Finance can view all timesheet entries" ON public.timesheet_entries FOR SELECT TO authenticated
  USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'finance'::app_role) OR timesheet_can_view_all(auth.uid())));
CREATE POLICY "Admins manage timesheet entries" ON public.timesheet_entries FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role)) WITH CHECK (has_role(auth.uid(), 'admin'::app_role));
CREATE POLICY "Users can insert own timesheet entries" ON public.timesheet_entries FOR INSERT TO authenticated
  WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can update own timesheet entries" ON public.timesheet_entries FOR UPDATE TO authenticated
  USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can view own timesheet entries" ON public.timesheet_entries FOR SELECT TO authenticated
  USING ((user_id = auth.uid()));
GRANT SELECT, INSERT, UPDATE ON public.timesheet_entries TO authenticated;
GRANT ALL ON public.timesheet_entries TO service_role;

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL,
  action text NOT NULL, old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now());

-- People: admin A; Brenda B (staff + finance, can_view_all); CSR C (Kaila); Live Admin L (Jose); finance-only F.
INSERT INTO public.user_roles VALUES
  ('00000000-0000-0000-0000-00000000000a', 'admin'),
  ('00000000-0000-0000-0000-00000000000b', 'staff'),
  ('00000000-0000-0000-0000-00000000000b', 'finance'),
  ('00000000-0000-0000-0000-00000000000c', 'csr'),
  ('00000000-0000-0000-0000-0000000000a1', 'live_agent'),
  ('00000000-0000-0000-0000-00000000000f', 'finance');
INSERT INTO public.profiles (user_id, full_name) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'Cynthia Largo'),
  ('00000000-0000-0000-0000-00000000000b', 'Brendalyn Bumagat'),
  ('00000000-0000-0000-0000-00000000000c', 'Kaila Cruz'),
  ('00000000-0000-0000-0000-0000000000a1', 'Jose Reyes');
INSERT INTO public.timesheet_profiles (user_id, template_type, basic_salary, allowance, can_view_all, timezone) VALUES
  ('00000000-0000-0000-0000-00000000000b', 'csr', 15000, 2000, true, 'Asia/Manila'),
  ('00000000-0000-0000-0000-00000000000c', 'csr', 12000, 2000, false, 'Asia/Manila'),
  ('00000000-0000-0000-0000-0000000000a1', 'live_admin', NULL, NULL, false, 'Asia/Tokyo');
GRANT SELECT ON public.audit_logs TO authenticated; -- test-only, so assertions can count audit rows
