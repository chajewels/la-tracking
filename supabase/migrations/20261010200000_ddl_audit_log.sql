-- ═══════════════════════════════════════════════════════════════════════════
-- PROPOSED — NOT APPLIED. Owner decision required before this goes anywhere.
-- DDL audit log: every CREATE / ALTER / DROP of a function or procedure (plus
-- triggers and GRANT / REVOKE) on live is written to an admin-only table, with
-- who ran it and the statement text.
--
-- WHY. Bug #280 and the 2026-09-28 drift census (20261009500000) share one root
-- cause: the SQL Editor and Lovable can change a function body on live and leave
-- no trace anywhere. force_layaway_english_only was never in git at all;
-- sync_service_request_from_job was "recorded" from a reconstruction, not from
-- live. The drift audit finds such changes after the fact; this log says when,
-- by whom and with what statement, the moment it happens.
--
-- CAN WE? Yes, as the role the SQL Editor uses. Evidence:
--   * fetch-live output 2026-09-28: the SQL Editor runs as current_user =
--     session_user = postgres, rolsuper = false; supautils is loaded
--     (supautils.privileged_role = supabase_privileged_role, supautils.superuser =
--     supabase_admin); Supabase's own event triggers exist (pgrst_ddl_watch etc.,
--     owned by supabase_admin), so the mechanism is live on this project.
--   * Supabase docs, Database > Event Triggers: "Only the postgres user has the
--     necessary permissions to create these objects." supautils intercepts
--     CREATE EVENT TRIGGER from the privileged role, creates it as superuser and
--     hands ownership to postgres (Supabase blog, "Event triggers without
--     superuser", 2025-05-08).
--
-- WHAT IT CANNOT SEE — know this before trusting a quiet log:
--   * supautils SKIPS user event triggers when the acting role is a superuser or
--     a reserved role (supabase_admin, supabase_auth_admin, …). Supabase's own
--     platform migrations are therefore not logged. Everything run as postgres —
--     the SQL Editor, and Lovable if it runs as postgres (all 8 functions in the
--     2026-09-28 capture are owned by postgres, which suggests it does) — IS
--     logged. Verification step V4 below confirms Lovable's role on its next
--     apply; if Lovable turns out to be supabase_admin, this log misses it and
--     the drift audit stays the only net for those changes.
--   * An event trigger never sees DML, so data fixes are out of scope by design.
--
-- IT MUST NEVER BLOCK DDL. Both functions trap every error, RAISE WARNING and
-- return: a broken logger costs a log row, never a migration. Kill switch:
--   ALTER EVENT TRIGGER admin_audit_ddl_end  DISABLE;
--   ALTER EVENT TRIGGER admin_audit_sql_drop DISABLE;
--
-- NO BROWSER ACCESS. Its own schema (admin_audit), not exposed through the API
-- (Settings → API → Exposed schemas lists public and graphql_public only; do not
-- add admin_audit there). USAGE revoked from PUBLIC, anon, authenticated; RLS on
-- with no policies as a second lock; no grant to anyone. The owner reads it in
-- the SQL Editor as postgres.
--
-- Idempotent: re-running it changes nothing and loses no rows.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS admin_audit;
REVOKE ALL ON SCHEMA admin_audit FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA admin_audit FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA admin_audit FROM authenticated';
  END IF;
END
$$;
COMMENT ON SCHEMA admin_audit IS
  'Owner-only audit data. Never add to the API''s exposed schemas. Added 2026-09-28 (proposed).';

CREATE TABLE IF NOT EXISTS admin_audit.ddl_log (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  event            text        NOT NULL,          -- ddl_command_end | sql_drop
  command_tag      text        NOT NULL,          -- CREATE FUNCTION, ALTER FUNCTION, DROP FUNCTION, GRANT, …
  object_type      text,                          -- function, procedure, trigger, …
  schema_name      text,
  object_identity  text,                          -- e.g. public.set_updated_at()
  body_md5         text,                          -- md5(prosrc) after the command (functions only)
  audit_md5        text,                          -- same 12-char hash scripts/function-drift-audit prints
  session_user_name text       NOT NULL,
  current_user_name text       NOT NULL,
  application_name text,
  client_addr      inet,
  backend_xid      xid8,
  query            text                           -- current_query(): the whole statement / script sent
);
CREATE INDEX IF NOT EXISTS ddl_log_occurred_at_idx ON admin_audit.ddl_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS ddl_log_object_idx      ON admin_audit.ddl_log (object_identity, occurred_at DESC);
ALTER TABLE admin_audit.ddl_log ENABLE ROW LEVEL SECURITY;   -- no policies: nobody but the owner role
REVOKE ALL ON admin_audit.ddl_log FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON admin_audit.ddl_log FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON admin_audit.ddl_log FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL ON admin_audit.ddl_log FROM service_role';
  END IF;
END
$$;
COMMENT ON TABLE admin_audit.ddl_log IS
  'One row per function/procedure/trigger DDL and GRANT/REVOKE run on this database by a non-superuser role (supautils skips superusers). Written only by admin_audit.log_ddl_end / log_sql_drop. Never updated or deleted by the app.';

-- ddl_command_end: CREATE / ALTER / GRANT / REVOKE and friends.
CREATE OR REPLACE FUNCTION admin_audit.log_ddl_end()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  r      record;
  v_src  text;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    BEGIN
      v_src := NULL;
      IF r.classid = 'pg_proc'::regclass THEN
        SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = r.objid;
      END IF;
      INSERT INTO admin_audit.ddl_log
        (event, command_tag, object_type, schema_name, object_identity, body_md5, audit_md5,
         session_user_name, current_user_name, application_name, client_addr, backend_xid, query)
      VALUES
        (tg_event, r.command_tag, r.object_type, r.schema_name, r.object_identity,
         md5(v_src),
         substr(md5(btrim(regexp_replace(v_src, '\s+', ' ', 'g'))), 1, 12),
         session_user, current_user, current_setting('application_name', true),
         inet_client_addr(), pg_current_xact_id_if_assigned(), current_query());
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'admin_audit.log_ddl_end could not log % %: % (the DDL itself was not affected)',
        r.command_tag, r.object_identity, SQLERRM;
    END;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_audit.log_ddl_end failed: % (the DDL itself was not affected)', SQLERRM;
END
$fn$;

-- sql_drop: DROP FUNCTION / PROCEDURE / TRIGGER (ddl_command_end does not list dropped objects).
CREATE OR REPLACE FUNCTION admin_audit.log_sql_drop()
RETURNS event_trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $fn$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_dropped_objects() WHERE original LOOP
    BEGIN
      INSERT INTO admin_audit.ddl_log
        (event, command_tag, object_type, schema_name, object_identity,
         session_user_name, current_user_name, application_name, client_addr, backend_xid, query)
      VALUES
        (tg_event, tg_tag, r.object_type, r.schema_name, r.object_identity,
         session_user, current_user, current_setting('application_name', true),
         inet_client_addr(), pg_current_xact_id_if_assigned(), current_query());
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'admin_audit.log_sql_drop could not log %: % (the DROP itself was not affected)',
        r.object_identity, SQLERRM;
    END;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'admin_audit.log_sql_drop failed: % (the DROP itself was not affected)', SQLERRM;
END
$fn$;

REVOKE ALL ON FUNCTION admin_audit.log_ddl_end()  FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_audit.log_sql_drop() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS admin_audit_ddl_end;
CREATE EVENT TRIGGER admin_audit_ddl_end ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION', 'ALTER FUNCTION',
               'CREATE PROCEDURE', 'ALTER PROCEDURE',
               'CREATE TRIGGER', 'ALTER TRIGGER',
               'GRANT', 'REVOKE')
  EXECUTE FUNCTION admin_audit.log_ddl_end();

DROP EVENT TRIGGER IF EXISTS admin_audit_sql_drop;
CREATE EVENT TRIGGER admin_audit_sql_drop ON sql_drop
  WHEN TAG IN ('DROP FUNCTION', 'DROP PROCEDURE', 'DROP TRIGGER')
  EXECUTE FUNCTION admin_audit.log_sql_drop();

-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICATION (run in the SQL Editor after applying; expected results inline)
--
-- V1  Both event triggers exist, are enabled and belong to postgres.
--       SELECT evtname, evtevent, evtenabled, pg_get_userbyid(evtowner), evtfoid::regproc
--         FROM pg_event_trigger WHERE evtname LIKE 'admin_audit%' ORDER BY 1;
--     → 2 rows: admin_audit_ddl_end | ddl_command_end | O | postgres | admin_audit.log_ddl_end
--               admin_audit_sql_drop | sql_drop       | O | postgres | admin_audit.log_sql_drop
--
-- V2  A probe is logged end to end (run as one script; it leaves nothing behind but log rows).
--       CREATE FUNCTION public.zz_ddl_audit_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';
--       ALTER FUNCTION public.zz_ddl_audit_probe() STABLE;
--       REVOKE ALL ON FUNCTION public.zz_ddl_audit_probe() FROM PUBLIC;
--       DROP FUNCTION public.zz_ddl_audit_probe();
--       SELECT event, command_tag, object_type, object_identity, audit_md5, session_user_name
--         FROM admin_audit.ddl_log
--        WHERE object_identity LIKE '%zz_ddl_audit_probe%'
--           OR (command_tag IN ('GRANT', 'REVOKE') AND query LIKE '%zz_ddl_audit_probe%')
--        ORDER BY id;
--     → 4 rows, in order (verified on a local Postgres 16, 2026-09-28):
--         ddl_command_end | CREATE FUNCTION | function | public.zz_ddl_audit_probe() | b1698e52a0f1 | postgres
--         ddl_command_end | ALTER FUNCTION  | function | public.zz_ddl_audit_probe() | b1698e52a0f1 | postgres
--         ddl_command_end | REVOKE          | FUNCTION | (null)                      | (null)       | postgres
--         sql_drop        | DROP FUNCTION   | function | public.zz_ddl_audit_probe() | (null)       | postgres
--       GRANT / REVOKE carry no object identity (Postgres does not report one); the statement
--       is in query. b1698e52a0f1 is the drift audit's hash of 'SELECT 1', so a logged body can
--       be matched straight against an audit row.
--
-- V2b A broken logger never blocks DDL (verified locally): with the table renamed away, the
--     same CREATE / DROP succeed and only a WARNING "… (the DDL itself was not affected)" shows.
--
-- V3  No browser path. Each must fail with "permission denied for schema admin_audit":
--       SET ROLE authenticated; SELECT count(*) FROM admin_audit.ddl_log; RESET ROLE;
--       SET ROLE anon;          SELECT count(*) FROM admin_audit.ddl_log; RESET ROLE;
--     And Settings → API → Exposed schemas must NOT list admin_audit.
--
-- V4  Lovable's role (after its next migration apply):
--       SELECT occurred_at, session_user_name, application_name, command_tag, object_identity
--         FROM admin_audit.ddl_log ORDER BY id DESC LIMIT 20;
--     → rows for the functions that apply created, session_user_name = postgres. If an apply
--       that certainly changed a function leaves NO row, Lovable runs as a superuser/reserved
--       role and supautils skipped the trigger: this log does not cover Lovable.
-- ───────────────────────────────────────────────────────────────────────────
