-- Scratch-only stand-ins for Supabase platform pieces (V02/V03 harness). Never for live.
DO $$ BEGIN
  PERFORM 1 FROM pg_roles WHERE rolname='anon'; IF NOT FOUND THEN CREATE ROLE anon NOLOGIN; END IF;
  PERFORM 1 FROM pg_roles WHERE rolname='authenticated'; IF NOT FOUND THEN CREATE ROLE authenticated NOLOGIN; END IF;
  PERFORM 1 FROM pg_roles WHERE rolname='service_role'; IF NOT FOUND THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  PERFORM 1 FROM pg_roles WHERE rolname='supabase_admin'; IF NOT FOUND THEN CREATE ROLE supabase_admin NOLOGIN; END IF;
  PERFORM 1 FROM pg_roles WHERE rolname='authenticator'; IF NOT FOUND THEN CREATE ROLE authenticator NOLOGIN; END IF;
  PERFORM 1 FROM pg_roles WHERE rolname='supabase_auth_admin'; IF NOT FOUND THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
  PERFORM 1 FROM pg_roles WHERE rolname='supabase_storage_admin'; IF NOT FOUND THEN CREATE ROLE supabase_storage_admin NOLOGIN; END IF;
  PERFORM 1 FROM pg_roles WHERE rolname='sandbox_exec'; IF NOT FOUND THEN CREATE ROLE sandbox_exec NOLOGIN; END IF;
  PERFORM 1 FROM pg_roles WHERE rolname='dashboard_user'; IF NOT FOUND THEN CREATE ROLE dashboard_user NOLOGIN; END IF;
END $$;
GRANT anon, authenticated, service_role TO postgres;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE SCHEMA IF NOT EXISTS net;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS pgmq;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
ALTER DATABASE postgres SET search_path TO public, extensions;
SET search_path TO public, extensions;

-- auth: uid()/role() read request.jwt.claims like Supabase does.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text, phone text,
  raw_user_meta_data jsonb DEFAULT '{}'::jsonb, raw_app_meta_data jsonb DEFAULT '{}'::jsonb,
  email_confirmed_at timestamptz, last_sign_in_at timestamptz, banned_until timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz,
  is_anonymous boolean DEFAULT false, encrypted_password text, confirmed_at timestamptz);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(coalesce(current_setting('request.jwt.claim.sub', true), (nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'sub')),'')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('request.jwt.claim.role', true), (nullif(current_setting('request.jwt.claims', true),'')::jsonb ->> 'role')) $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb, '{}'::jsonb) $$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ SELECT auth.jwt() ->> 'email' $$;

-- pg_cron stand-in (records jobs, runs nothing).
CREATE TABLE IF NOT EXISTS cron.job (jobid bigserial PRIMARY KEY, schedule text, command text, nodename text DEFAULT 'localhost',
  nodeport int DEFAULT 5432, database text DEFAULT 'postgres', username text DEFAULT 'postgres', active boolean DEFAULT true, jobname text UNIQUE);
CREATE TABLE IF NOT EXISTS cron.job_run_details (jobid bigint, runid bigserial PRIMARY KEY, job_pid int, database text, username text,
  command text, status text, return_message text, start_time timestamptz, end_time timestamptz);
CREATE SEQUENCE IF NOT EXISTS cron.runid_seq;
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint; BEGIN
  INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid INTO v; RETURN v; END $$;
CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text) RETURNS bigint LANGUAGE sql AS
$$ INSERT INTO cron.job(schedule, command) VALUES (schedule, command) RETURNING jobid $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN DELETE FROM cron.job WHERE jobname = job_name; RETURN FOUND; END $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN DELETE FROM cron.job WHERE jobid = job_id; RETURN FOUND; END $$;
CREATE OR REPLACE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL, database text DEFAULT NULL,
  username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS
$$ UPDATE cron.job SET schedule = coalesce($2, schedule), command = coalesce($3, command), active = coalesce($6, active) WHERE jobid = $1 $$;

-- pg_net stand-in: records the request, sends nothing.
CREATE TABLE IF NOT EXISTS net.http_request_queue (id bigserial PRIMARY KEY, url text, body jsonb, headers jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE IF NOT EXISTS net._http_response (id bigint, status_code int, content text, created timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS
$$ INSERT INTO net.http_request_queue(url, body, headers) VALUES (url, body, headers) RETURNING id $$;
CREATE OR REPLACE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds int DEFAULT 5000) RETURNS bigint LANGUAGE sql AS
$$ INSERT INTO net.http_request_queue(url, headers) VALUES (url, headers) RETURNING id $$;

-- vault stand-in.
CREATE TABLE IF NOT EXISTS vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, secret text, description text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE OR REPLACE VIEW vault.decrypted_secrets AS SELECT id, name, secret, secret AS decrypted_secret, description, created_at, updated_at FROM vault.secrets;
CREATE OR REPLACE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '') RETURNS uuid
LANGUAGE sql AS $$ INSERT INTO vault.secrets(name, secret, description) VALUES (new_name, new_secret, new_description) RETURNING id $$;
CREATE OR REPLACE FUNCTION vault.update_secret(secret_id uuid, new_secret text DEFAULT NULL, new_name text DEFAULT NULL, new_description text DEFAULT NULL)
RETURNS void LANGUAGE sql AS $$ UPDATE vault.secrets SET secret = coalesce(new_secret, secret), name = coalesce(new_name, name) WHERE id = secret_id $$;

-- pgmq stand-in (enough for the email queue helpers to compile and run).
CREATE TABLE IF NOT EXISTS pgmq.q_auth_emails (msg_id bigserial PRIMARY KEY, read_ct int DEFAULT 0, enqueued_at timestamptz DEFAULT now(), vt timestamptz DEFAULT now(), message jsonb);
CREATE TABLE IF NOT EXISTS pgmq.q_transactional_emails (msg_id bigserial PRIMARY KEY, read_ct int DEFAULT 0, enqueued_at timestamptz DEFAULT now(), vt timestamptz DEFAULT now(), message jsonb);
CREATE TABLE IF NOT EXISTS pgmq.messages (queue text, msg_id bigserial PRIMARY KEY, read_ct int DEFAULT 0, vt timestamptz DEFAULT now(), message jsonb);
CREATE OR REPLACE FUNCTION pgmq.create(queue_name text) RETURNS void LANGUAGE sql AS $$ SELECT $$;
CREATE OR REPLACE FUNCTION pgmq.send(queue_name text, msg jsonb, delay int DEFAULT 0) RETURNS SETOF bigint LANGUAGE sql AS
$$ INSERT INTO pgmq.messages(queue, message) VALUES (queue_name, msg) RETURNING msg_id $$;
CREATE OR REPLACE FUNCTION pgmq.delete(queue_name text, msg_id bigint) RETURNS boolean LANGUAGE plpgsql AS
$$ BEGIN DELETE FROM pgmq.messages m WHERE m.queue = queue_name AND m.msg_id = delete.msg_id; RETURN FOUND; END $$;
CREATE OR REPLACE FUNCTION pgmq.read(queue_name text, vt int, qty int) RETURNS TABLE (msg_id bigint, read_ct int, enqueued_at timestamptz, vt timestamptz, message jsonb)
LANGUAGE sql AS $$ SELECT m.msg_id, m.read_ct, now(), m.vt, m.message FROM pgmq.messages m WHERE m.queue = queue_name LIMIT qty $$;

-- storage stand-in.
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, owner uuid, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;

DO $$ BEGIN PERFORM 1 FROM pg_publication WHERE pubname='supabase_realtime'; IF NOT FOUND THEN CREATE PUBLICATION supabase_realtime; END IF; END $$;
GRANT USAGE ON SCHEMA public, extensions, auth TO anon, authenticated, service_role;
-- Supabase's default privileges for objects postgres creates in public (as on every Supabase project).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
