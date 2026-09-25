-- ============================================================================
-- Page365 inventory PR 3 (schedule) — LOCAL test stub (2026-09-30). NEVER RUN
-- THIS ON LIVE.
--
-- Runs AFTER the #195, PR 1, PR 2 and PR 4 stubs + migrations, and adds only
-- what migration 20260930100000_page365_inventory_schedule.sql reads on top of
-- them: stand-ins for pg_cron (cron.job / schedule / unschedule), pg_net
-- (net.http_post — never called here) and Supabase Vault (vault.secrets with a
-- dummy value), plus profiles and the system_settings audit columns live has.
-- Same opt-in guard as the other stubs.
--
--   initdb -D /tmp/p365pr3 --locale=C -E UTF8 && pg_ctl -D /tmp/p365pr3 -o "-p 55441" start
--   export PGOPTIONS='-c page365.local_stub=yes'
--   P="psql -p 55441 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20260926_page365_stock_sync_local_stub.sql
--   $P supabase/migrations/20260926120000_page365_stock_sync.sql
--   $P docs/sql/20260927_page365_inventory_fetch_local_stub.sql
--   $P supabase/migrations/20260927100000_page365_inventory_fetch.sql
--   $P docs/sql/20260928_page365_inventory_pr2_local_stub.sql
--   $P supabase/migrations/20260928100000_page365_inventory_pr2.sql
--   $P docs/sql/20260928_page365_inventory_drafts_local_stub.sql
--   $P supabase/migrations/20260929100000_page365_inventory_drafts.sql
--   $P docs/sql/20260930_page365_inventory_schedule_local_stub.sql
--   $P supabase/migrations/20260930100000_page365_inventory_schedule.sql
--   $P supabase/migrations/20260930100000_page365_inventory_schedule.sql   # re-run is safe
--   $P docs/sql/20260930_page365_inventory_schedule_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('page365.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c page365.local_stub=yes''';
  END IF;
  IF to_regclass('public.customers') IS NOT NULL OR to_regclass('public.payments') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
  IF to_regclass('public.page365_inventory_items') IS NULL THEN
    RAISE EXCEPTION 'Run the #195, PR 1, PR 2 and PR 4 stubs and migrations first';
  END IF;
END
$guard$;

ALTER TABLE public.system_settings
  ADD COLUMN IF NOT EXISTS updated_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS public.profiles (user_id uuid, full_name text);

-- Rebuilt from scratch every time (the #195 stub drops only public/auth).
DROP SCHEMA IF EXISTS cron CASCADE; DROP SCHEMA IF EXISTS net CASCADE; DROP SCHEMA IF EXISTS vault CASCADE;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL,
  command text NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE sql AS $$
  WITH d AS (DELETE FROM cron.job WHERE jobname = job_name RETURNING 1) SELECT EXISTS (SELECT 1 FROM d) $$;

CREATE SCHEMA IF NOT EXISTS net;
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;

CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, secret text);
INSERT INTO vault.secrets (name, secret) VALUES ('email_queue_service_role_key', 'local-dummy-not-a-key') ON CONFLICT (name) DO NOTHING;
CREATE OR REPLACE VIEW vault.decrypted_secrets AS SELECT id, name, secret AS decrypted_secret FROM vault.secrets;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
