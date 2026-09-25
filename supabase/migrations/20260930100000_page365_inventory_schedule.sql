-- ===========================================================================
-- page365_inventory_schedule — automatic fetch every 30 minutes, DECREASES
-- ONLY (PR 3 of 4). Plan: ~/Code/reference/page365-inventory-fetch-investigation.md
-- §3e / §5.1 PR 3 (owner-approved), with the owner's final rules of 2026-09-26.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main
-- AND the page365-inventory-fetch edge function from the same release is
-- deployed (the cron job below calls it; before the deploy every tick is
-- answered 400 "action must be start or continue" and nothing happens).
-- One transaction. Nothing below changes website stock.
--
-- What it does:
--
--   A. THE SWITCH. system_settings.page365_inventory_auto_apply (seeded 'false'
--      by PR 1, 20260927100000) becomes a guarded, audited switch, exactly the
--      way web_reservation_mode is (20260924073201):
--        get_page365_inventory_auto_apply()          read (catalogue staff)
--        set_page365_inventory_auto_apply(bool,bool) write: manage_website_catalog
--                                                    only, one audit_logs row
--        trg_guard_page365_inventory_auto_apply      refuses every other change
--                                                    of the value (PostgREST,
--                                                    SQL Editor) and any delete
--      THIS FILE NEVER TURNS IT ON. The value is left exactly as it is (false
--      since PR 1); the self-check aborts the whole file if it moved.
--      The owner turns it on from Hub -> Website -> Page365 stock.
--
--   B. THE SCHEDULE. pg_cron job 'page365-inventory-schedule', every 5 minutes
--      (at :02, :07, :12 ... — off the :00/:05 minutes of the morning chain,
--      which it does not touch anyway). Vault-backed service key per the CRON
--      AUTH RULE, copied from web-reservation-sweep. Each tick POSTs
--      {action:"schedule"} to page365-inventory-fetch, which:
--        * skips entirely while a MANUAL fetch is reading (never overlaps it);
--        * otherwise resumes the scheduled run in progress, or starts a new one
--          when the last scheduled run began >= 27 minutes ago — so a scheduled
--          read begins every 30 minutes and the ticks in between only finish it
--          (a read of ~570 products at <= 4 requests/s spans two ticks);
--        * reads under a per-run LEASE (page365_inventory_lease): a staff
--          "Fetch" that joins a scheduled read waits its turn, so manual +
--          scheduled together still make one reader at <= 4 requests/s;
--        * when the run ends, calls page365_inventory_auto_apply_run.
--
--   C. AUTO-APPLY, DECREASES ONLY. page365_inventory_auto_apply_run(run) —
--      service role only; the ONLY automatic stock writer. It applies nothing
--      unless ALL hold: the switch is strictly true (read live, fail-closed);
--      the run is a SCHEDULED run whose read was clean ('ready' — a partial or
--      failed read applies NOTHING); it is still inside its 30-minute window;
--      no newer ready run exists (superseded). Then, per row: category
--      'decrease', still under review, proposed < seen, the product NOT
--      switched to "Don't sync with Page365" (read live), no #195 hold in
--      'invoice' mode — and the write is compare-and-set
--      (stock_qty = seen_stock), so a website sale in between is skipped, never
--      overwritten. Stock never goes below zero (CHECK + proposal floor).
--      Increases, new products (drafts), prices and photos are NEVER touched —
--      they wait on the review screen. One audit_logs row per applied row
--      (page365_inventory_auto_applied) and one per run
--      (page365_inventory_auto_apply). Idempotent: a run is closed once.
--      One staff bell per run at most: 'page365_inventory_run_failed' (partial
--      or failed scheduled read) or 'page365_inventory_auto_applied'
--      (decreases applied).
--
--   D. RETENTION. page365_inventory_retention(14): runs older than 14 days
--      (never a fetching run, never the latest ready run) lose their read
--      data. A run where nothing was applied is deleted with its rows. A run
--      where anything was applied (a stock row, or a draft) KEEPS the run row,
--      every applied item and the product rows those items point at; only the
--      unapplied rows and the chunk log go. audit_logs is never touched — the
--      audit trail of every applied change stays whole. Called by the
--      scheduled tick before each new run.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). This file redefines
-- NO existing function. It relies on four live bodies and pins them (md5 of
-- pg_proc.prosrc, as scripts/function-drift-audit compares):
--   page365_inventory_claim          fa8a56b999761aa0fab8172ac78f2ed0  (PR 1, 20260927100000)
--   page365_inventory_store_product  6ae646ee897b92ca7aa5002f8c416743  (PR 1, 20260927100000)
--   page365_inventory_finish         9d0be9494288800686e2d6a90edb3304  (PR 2, 20260928100000)
--   page365_inventory_apply          e65757c2f32b597b2a55047d77783df3  (PR 2, 20260928100000)
-- and the self-check proves they are unchanged after.
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if live is not what this was written against. Re-running
-- the file is safe (IF NOT EXISTS / CREATE OR REPLACE / the cron job is
-- replaced by name; the switch is never written).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_cols    text[];
  v_bad     text := '';
  v_got     text;
  r         record;
BEGIN
  IF to_regclass('public.page365_inventory_runs')     IS NULL THEN v_missing := v_missing || 'page365_inventory_runs (PR 1)'::text; END IF;
  IF to_regclass('public.page365_inventory_items')    IS NULL THEN v_missing := v_missing || 'page365_inventory_items (PR 1)'::text; END IF;
  IF to_regclass('public.page365_inventory_products') IS NULL THEN v_missing := v_missing || 'page365_inventory_products (PR 1)'::text; END IF;
  IF to_regclass('public.page365_inventory_chunks')   IS NULL THEN v_missing := v_missing || 'page365_inventory_chunks (PR 1)'::text; END IF;
  IF to_regclass('public.page365_stock_lines')        IS NULL THEN v_missing := v_missing || 'page365_stock_lines (#195)'::text; END IF;
  IF to_regclass('public.website_products')           IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants')   IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.system_settings')            IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF to_regclass('public.audit_logs')                 IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.staff_notifications')        IS NULL THEN v_missing := v_missing || 'staff_notifications'::text; END IF;
  IF to_regclass('public.profiles')                   IS NULL THEN v_missing := v_missing || 'profiles'::text; END IF;
  IF to_regclass('cron.job')                          IS NULL THEN v_missing := v_missing || 'cron.job (pg_cron)'::text; END IF;
  IF to_regclass('vault.secrets')                     IS NULL THEN v_missing := v_missing || 'vault.secrets (Supabase Vault)'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_schedule: missing: %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('page365_inventory_runs','id'), ('page365_inventory_runs','source'), ('page365_inventory_runs','status'),
      ('page365_inventory_runs','created_at'), ('page365_inventory_runs','finished_at'), ('page365_inventory_runs','updated_at'),
      ('page365_inventory_runs','error'), ('page365_inventory_runs','page365_count'),
      ('page365_inventory_items','run_id'), ('page365_inventory_items','kind'), ('page365_inventory_items','category'),
      ('page365_inventory_items','match_result'), ('page365_inventory_items','status'), ('page365_inventory_items','variant_id'),
      ('page365_inventory_items','seen_stock'), ('page365_inventory_items','proposed_stock'), ('page365_inventory_items','code'),
      ('page365_inventory_items','page365_available'), ('page365_inventory_items','web_holds'), ('page365_inventory_items','invoice_holds'),
      ('page365_inventory_items','applied_at'), ('page365_inventory_items','applied_by'), ('page365_inventory_items','result_note'),
      ('page365_inventory_items','inventory_product_id'),
      ('website_products','page365_sync_disabled'), ('website_product_variants','stock_qty'), ('website_product_variants','product_id'),
      ('system_settings','key'), ('system_settings','value'), ('system_settings','description'),
      ('system_settings','updated_by_user_id'), ('system_settings','updated_at'),
      ('profiles','user_id'), ('profiles','full_name')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_schedule: missing column(s): %', array_to_string(v_cols, ', ');
  END IF;

  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'page365_inventory_schedule: public.has_permission(uuid,text) missing';
  END IF;
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL OR to_regprocedure('cron.unschedule(text)') IS NULL THEN
    RAISE EXCEPTION 'page365_inventory_schedule: cron.schedule(text,text,text) / cron.unschedule(text) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'net' AND p.proname = 'http_post') THEN
    RAISE EXCEPTION 'page365_inventory_schedule: net.http_post (pg_net) missing';
  END IF;
  -- The Vault key every Vault-backed cron uses (CRON AUTH RULE). Only its
  -- presence is checked; its value is never read here.
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
    RAISE EXCEPTION 'page365_inventory_schedule: Vault secret email_queue_service_role_key missing — the other Vault-backed crons use it; do not create a second key';
  END IF;

  -- The live bodies this relies on (Bug #280). None is redefined here.
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_claim(uuid,integer)',        'fa8a56b999761aa0fab8172ac78f2ed0'),
      ('page365_inventory_store_product(uuid,jsonb,text)', '6ae646ee897b92ca7aa5002f8c416743'),
      ('page365_inventory_finish(uuid)',               '9d0be9494288800686e2d6a90edb3304'),
      ('page365_inventory_apply(uuid,uuid[],uuid[])',  'e65757c2f32b597b2a55047d77783df3')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'STOP — page365_inventory_schedule: live is not what this file was written against. Nothing was modified.%', v_bad;
  END IF;

  -- The run source CHECK must already allow 'schedule' (PR 1 wrote it so).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint k
                  WHERE k.conrelid = 'public.page365_inventory_runs'::regclass AND k.contype = 'c'
                    AND pg_get_constraintdef(k.oid) ILIKE '%source%' AND pg_get_constraintdef(k.oid) ILIKE '%schedule%') THEN
    RAISE EXCEPTION 'page365_inventory_schedule: page365_inventory_runs.source CHECK does not allow ''schedule''';
  END IF;

  -- The switch, if present, must be a plain true/false (PR 1 seeded false).
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'
                AND (value #>> '{}') NOT IN ('true', 'false')) THEN
    RAISE EXCEPTION 'page365_inventory_schedule: system_settings.page365_inventory_auto_apply is not true/false';
  END IF;

  -- Name collisions: new functions must not exist with another signature.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'page365_inventory_lease'           AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid, p_holder text, p_seconds integer')
       OR (p.proname = 'page365_inventory_release'         AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid, p_holder text')
       OR (p.proname = 'page365_inventory_auto_apply_run'  AND pg_get_function_identity_arguments(p.oid) <> 'p_run_id uuid')
       OR (p.proname = 'page365_inventory_retention'       AND pg_get_function_identity_arguments(p.oid) <> 'p_keep_days integer')
       OR (p.proname = 'get_page365_inventory_auto_apply'  AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'set_page365_inventory_auto_apply'  AND pg_get_function_identity_arguments(p.oid) <> 'p_enabled boolean, p_expected boolean')
       OR (p.proname = 'guard_page365_inventory_auto_apply' AND pg_get_function_identity_arguments(p.oid) <> ''));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'page365_inventory_schedule: function(s) already exist with another signature: %', v_got;
  END IF;

  -- Remember the switch as found; the self-check proves this file left it alone.
  PERFORM set_config('page365.schedule_switch_before',
                     coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'absent'),
                     true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Run columns: the reader's lease, the auto-apply outcome, the one bell,
--    and retention's mark. Read by catalogue staff (table SELECT grant from
--    PR 1 covers new columns); written only by the functions below.
-- ---------------------------------------------------------------------------
ALTER TABLE public.page365_inventory_runs
  ADD COLUMN IF NOT EXISTS lease_holder        text,
  ADD COLUMN IF NOT EXISTS lease_until         timestamptz,
  ADD COLUMN IF NOT EXISTS auto_apply_state    text,
  ADD COLUMN IF NOT EXISTS auto_applied        integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_apply_changed  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_apply_skipped  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS auto_apply_at       timestamptz,
  ADD COLUMN IF NOT EXISTS notified_at         timestamptz,
  ADD COLUMN IF NOT EXISTS pruned_at           timestamptz;
ALTER TABLE public.page365_inventory_runs DROP CONSTRAINT IF EXISTS page365_inventory_runs_auto_apply_state_check;
ALTER TABLE public.page365_inventory_runs ADD CONSTRAINT page365_inventory_runs_auto_apply_state_check
  CHECK (auto_apply_state IS NULL OR auto_apply_state IN ('applied','off','not_ready','window_passed','superseded'));
COMMENT ON COLUMN public.page365_inventory_runs.auto_apply_state IS
  'Scheduled runs only (NULL on manual runs and before the run ends). applied = the switch was on and every eligible decrease was attempted (see auto_applied); off = the switch was off, nothing applied; not_ready = the read was partial or failed, nothing applied; window_passed = the run ended more than 30 minutes after it began, nothing applied; superseded = a newer ready run existed, nothing applied. Written once, by page365_inventory_auto_apply_run.';
COMMENT ON COLUMN public.page365_inventory_runs.lease_holder IS
  'Who is reading this run right now (page365_inventory_lease). Manual and scheduled readers take it per chunk, so there is only ever one reader at <= 4 requests/s.';
CREATE INDEX IF NOT EXISTS idx_page365_inventory_runs_source_created
  ON public.page365_inventory_runs (source, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. The switch row. Present since PR 1 (false); inserted false only if it was
--    removed. The value of an existing row is NEVER written here.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('page365_inventory_auto_apply', 'false'::jsonb,
        'Page365 inventory: when true, the 30-minute scheduled fetch applies DECREASES only to website stock. Increases, new products, prices and photos always wait for staff. Changed only from Hub -> Website -> Page365 stock (set_page365_inventory_auto_apply; manage_website_catalog; audited).')
ON CONFLICT (key) DO NOTHING;
UPDATE public.system_settings
   SET description = 'Page365 inventory: when true, the 30-minute scheduled fetch applies DECREASES only to website stock. Increases, new products, prices and photos always wait for staff. Changed only from Hub -> Website -> Page365 stock (set_page365_inventory_auto_apply; manage_website_catalog; audited).'
 WHERE key = 'page365_inventory_auto_apply' AND description IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Guard: the value moves only through set_page365_inventory_auto_apply.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_page365_inventory_auto_apply()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key = 'page365_inventory_auto_apply'
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key = 'page365_inventory_auto_apply' AND OLD.key <> 'page365_inventory_auto_apply')
  THEN
    IF coalesce(current_setting('app.allow_page365_auto_apply_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'page365_inventory_auto_apply is changed only from the Hub: Website → Page365 stock → Automatic decreases (set_page365_inventory_auto_apply).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_page365_inventory_auto_apply() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_page365_inventory_auto_apply ON public.system_settings;
CREATE TRIGGER trg_guard_page365_inventory_auto_apply
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_page365_inventory_auto_apply();

-- ---------------------------------------------------------------------------
-- 4. Read and write the switch. manage_website_catalog (admin passes
--    has_permission). JSON true/false only; anything else reads as OFF.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_page365_inventory_auto_apply()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_row  public.system_settings%ROWTYPE;
  v_name text;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_row FROM public.system_settings WHERE key = 'page365_inventory_auto_apply';
  IF v_row.updated_by_user_id IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_row.updated_by_user_id LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found',              v_row.id IS NOT NULL,
    'enabled',            coalesce(v_row.value #>> '{}', 'false') = 'true',
    'updated_at',         v_row.updated_at,
    'updated_by_user_id', v_row.updated_by_user_id,
    'updated_by_name',    v_name,
    'can_change',         true);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_page365_inventory_auto_apply() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_page365_inventory_auto_apply() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.set_page365_inventory_auto_apply(p_enabled boolean, p_expected boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.system_settings%ROWTYPE;
  v_old boolean;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_enabled IS NULL THEN RETURN jsonb_build_object('error', 'enabled_required'); END IF;

  SELECT * INTO v_row FROM public.system_settings WHERE key = 'page365_inventory_auto_apply' FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;
  v_old := coalesce(v_row.value #>> '{}', 'false') = 'true';

  -- Two people on the same screen: the second click was made against a state
  -- that no longer holds.
  IF p_expected IS NOT NULL AND p_expected IS DISTINCT FROM v_old THEN
    RETURN jsonb_build_object('error', 'stale', 'enabled', v_old);
  END IF;
  IF v_old = p_enabled AND v_row.value = to_jsonb(p_enabled) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'enabled', v_old);
  END IF;

  PERFORM set_config('app.allow_page365_auto_apply_change', 'on', true);
  UPDATE public.system_settings
     SET value = to_jsonb(p_enabled), updated_by_user_id = v_uid, updated_at = v_now
   WHERE id = v_row.id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_row.id, 'set_page365_inventory_auto_apply',
          jsonb_build_object('key', 'page365_inventory_auto_apply', 'value', v_row.value, 'enabled', v_old,
                             'updated_at', v_row.updated_at, 'updated_by_user_id', v_row.updated_by_user_id),
          jsonb_build_object('key', 'page365_inventory_auto_apply', 'value', to_jsonb(p_enabled), 'enabled', p_enabled),
          v_uid, v_now);
  PERFORM set_config('app.allow_page365_auto_apply_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'enabled', p_enabled, 'old_enabled', v_old, 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_page365_inventory_auto_apply(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_page365_inventory_auto_apply(boolean, boolean) TO authenticated;
COMMENT ON FUNCTION public.set_page365_inventory_auto_apply(boolean, boolean) IS
  'The ONLY writer of system_settings.page365_inventory_auto_apply (trg_guard_page365_inventory_auto_apply refuses every other write). manage_website_catalog. Writes JSON true/false, stamps updated_by/at, one audit_logs row (system_setting / set_page365_inventory_auto_apply, old -> new). p_expected = the state the caller saw; a mismatch returns {error:"stale"}.';

-- ---------------------------------------------------------------------------
-- 5. The reader's lease. One reader per run at a time — manual or scheduled.
--    Service role only (the edge function). A lease a crashed call left behind
--    lapses by itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_lease(p_run_id uuid, p_holder text, p_seconds integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF p_holder IS NULL OR p_holder = '' THEN RETURN false; END IF;
  UPDATE public.page365_inventory_runs
     SET lease_holder = p_holder,
         lease_until  = now() + make_interval(secs => least(greatest(coalesce(p_seconds, 120), 10), 300)),
         updated_at   = now()
   WHERE id = p_run_id AND status = 'fetching'
     AND (lease_until IS NULL OR lease_until < now() OR lease_holder = p_holder);
  RETURN FOUND;
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_lease(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_lease(uuid, text, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.page365_inventory_release(p_run_id uuid, p_holder text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  UPDATE public.page365_inventory_runs SET lease_holder = NULL, lease_until = NULL
   WHERE id = p_run_id AND lease_holder = p_holder;
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_release(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_release(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Close a scheduled run: auto-apply DECREASES ONLY when every condition
--    holds, record the outcome once, raise at most one bell. Service role only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_auto_apply_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run     public.page365_inventory_runs%ROWTYPE;
  -- Fail-closed: only JSON true / "true" is on.
  v_on      boolean := coalesce((SELECT s.value #>> '{}' FROM public.system_settings s
                                  WHERE s.key = 'page365_inventory_auto_apply'), 'false') = 'true';
  v_mode    text := CASE WHEN (SELECT s.value #>> '{}' FROM public.system_settings s
                                WHERE s.key = 'page365_stock_mode') = 'invoice'
                         THEN 'invoice' ELSE 'inventory_sync' END;
  v_state   text;
  v_it      public.page365_inventory_items%ROWTYPE;
  v_note    text;
  v_applied integer := 0;
  v_changed integer := 0;
  v_skipped integer := 0;
  v_failed  integer := 0;
  v_codes   text[] := ARRAY[]::text[];
  v_type    text;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  IF v_run.source <> 'schedule' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_scheduled'); END IF;
  IF v_run.status = 'fetching' THEN RETURN jsonb_build_object('ok', false, 'reason', 'still_fetching'); END IF;
  IF v_run.auto_apply_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'state', v_run.auto_apply_state, 'applied', v_run.auto_applied);
  END IF;

  v_state := CASE
    WHEN v_run.status <> 'ready'                                THEN 'not_ready'
    WHEN NOT v_on                                               THEN 'off'
    WHEN now() > v_run.created_at + interval '30 minutes'       THEN 'window_passed'
    WHEN EXISTS (SELECT 1 FROM public.page365_inventory_runs r
                  WHERE r.id <> v_run.id AND r.status = 'ready' AND r.created_at > v_run.created_at) THEN 'superseded'
    ELSE 'applied' END;

  IF v_state = 'applied' THEN
    FOR v_it IN
      SELECT i.* FROM public.page365_inventory_items i
       WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
         AND i.category = 'decrease' AND i.status = 'review'
       ORDER BY i.id
       FOR UPDATE
    LOOP
      v_note := CASE
        WHEN v_it.variant_id IS NULL OR v_it.seen_stock IS NULL OR v_it.proposed_stock IS NULL THEN 'not_a_stock_change'
        WHEN EXISTS (SELECT 1 FROM public.website_product_variants wv
                       JOIN public.website_products wp ON wp.id = wv.product_id
                      WHERE wv.id = v_it.variant_id AND wp.page365_sync_disabled)             THEN 'sync_disabled'
        WHEN v_it.proposed_stock < 0 OR v_it.proposed_stock >= v_it.seen_stock                 THEN 'not_a_decrease'
        WHEN v_mode = 'invoice' AND EXISTS (SELECT 1 FROM public.page365_stock_lines l
                                             WHERE l.variant_id = v_it.variant_id AND l.stock_state = 'held') THEN 'invoice_hold'
        ELSE NULL END;
      IF v_note IS NOT NULL THEN
        -- The row stays under review for staff; only the note says why.
        UPDATE public.page365_inventory_items SET result_note = v_note WHERE id = v_it.id;
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      BEGIN
        -- Compare-and-set, and a decrease only: a website sale since the fetch
        -- (stock moved) is skipped, never overwritten.
        UPDATE public.website_product_variants
           SET stock_qty = v_it.proposed_stock, updated_at = now()
         WHERE id = v_it.variant_id AND stock_qty = v_it.seen_stock AND stock_qty > v_it.proposed_stock;
        IF FOUND THEN
          UPDATE public.page365_inventory_items
             SET status = 'applied', applied_at = now(), applied_by = NULL, result_note = 'auto_applied'
           WHERE id = v_it.id;
          INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id)
          VALUES ('website_product_variant', v_it.variant_id, 'page365_inventory_auto_applied',
                  jsonb_build_object('stock_qty', v_it.seen_stock),
                  jsonb_build_object('stock_qty', v_it.proposed_stock, 'run_id', p_run_id, 'item_id', v_it.id,
                                     'code', v_it.code, 'direction', 'decrease', 'source', 'schedule',
                                     'page365_available', v_it.page365_available, 'web_holds', v_it.web_holds,
                                     'invoice_holds', v_it.invoice_holds, 'mode', v_mode),
                  NULL);
          v_applied := v_applied + 1;
          v_codes := v_codes || coalesce(v_it.code, '?');
        ELSE
          UPDATE public.page365_inventory_items
             SET status = 'changed_since_fetch', result_note = 'stock changed after the fetch; the next fetch re-checks it'
           WHERE id = v_it.id;
          v_changed := v_changed + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        UPDATE public.page365_inventory_items SET status = 'failed', result_note = left(SQLERRM, 300) WHERE id = v_it.id;
        v_failed := v_failed + 1;
      END;
    END LOOP;
  END IF;

  -- One audit row per run whenever the switch was on (what was attempted and
  -- why not, if nothing was).
  IF v_on THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('page365_inventory_run', p_run_id, 'page365_inventory_auto_apply',
            jsonb_build_object('state', v_state, 'run_status', v_run.status, 'applied', v_applied,
                               'changed_since_fetch', v_changed, 'skipped', v_skipped, 'failed', v_failed,
                               'mode', v_mode, 'source', 'schedule'),
            NULL);
  END IF;

  v_type := CASE WHEN v_run.status IN ('partial', 'failed') THEN 'page365_inventory_run_failed'
                 WHEN v_applied > 0                         THEN 'page365_inventory_auto_applied' END;

  UPDATE public.page365_inventory_runs
     SET auto_apply_state = v_state, auto_applied = v_applied, auto_apply_changed = v_changed,
         auto_apply_skipped = v_skipped + v_failed, auto_apply_at = now(),
         notified_at = CASE WHEN v_type IS NOT NULL THEN now() ELSE notified_at END
   WHERE id = p_run_id;

  -- At most one bell per run (auto_apply_at makes this block run once).
  IF v_type = 'page365_inventory_run_failed' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES (v_type, 'Scheduled Page365 fetch did not complete',
            'The ' || to_char(v_run.created_at AT TIME ZONE 'Asia/Manila', 'HH24:MI') || ' PHT scheduled read was '
              || v_run.status || coalesce(' (' || v_run.error || ')', '') || '. Nothing was applied; the next scheduled fetch tries again.',
            jsonb_build_object('run_id', p_run_id, 'status', v_run.status, 'error', v_run.error));
  ELSIF v_type = 'page365_inventory_auto_applied' THEN
    INSERT INTO public.staff_notifications (type, title, body, metadata)
    VALUES (v_type, 'Page365 decreases applied automatically',
            v_applied || ' website stock decrease(s) applied from the ' || to_char(v_run.created_at AT TIME ZONE 'Asia/Manila', 'HH24:MI')
              || ' PHT scheduled Page365 fetch: ' || array_to_string(v_codes[1:10], ', ')
              || CASE WHEN cardinality(v_codes) > 10 THEN ' …' ELSE '' END || '.',
            jsonb_build_object('run_id', p_run_id, 'applied', v_applied, 'codes', to_jsonb(v_codes[1:50])));
  END IF;

  RETURN jsonb_build_object('ok', true, 'state', v_state, 'applied', v_applied, 'changed_since_fetch', v_changed,
                            'skipped', v_skipped, 'failed', v_failed, 'notified', v_type);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_auto_apply_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_auto_apply_run(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_auto_apply_run(uuid) IS
  'The ONLY automatic Page365 stock writer (PR 3). Service role. Closes a SCHEDULED run once: applies its decrease rows (compare-and-set, never an increase, never a switched-off product) only when system_settings.page365_inventory_auto_apply is true, the read was ready, the run is inside its 30-minute window and not superseded. Audits per row and per run; at most one staff bell per run.';

-- ---------------------------------------------------------------------------
-- 7. Retention. Service role only. Never touches audit_logs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_retention(p_keep_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_keep        integer := greatest(coalesce(p_keep_days, 14), 7);
  v_cut         timestamptz := now() - make_interval(days => greatest(coalesce(p_keep_days, 14), 7));
  v_latest      uuid;
  v_deleted     integer := 0;
  v_pruned      integer := 0;
  v_items_gone  integer := 0;
  v_n           integer;
BEGIN
  SELECT r.id INTO v_latest FROM public.page365_inventory_runs r
   WHERE r.status = 'ready' ORDER BY r.created_at DESC LIMIT 1;

  -- (a) Old runs where nothing was ever applied: gone, with their rows.
  WITH gone AS (
    DELETE FROM public.page365_inventory_runs r
     WHERE r.created_at < v_cut AND r.status <> 'fetching' AND r.id IS DISTINCT FROM v_latest
       AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i
                        WHERE i.run_id = r.id AND (i.status = 'applied' OR i.applied_at IS NOT NULL))
    RETURNING 1)
  SELECT count(*) INTO v_deleted FROM gone;

  -- (b) Old runs where something was applied: keep the run, the applied items
  --     and the product rows they point at; drop the rest once.
  WITH old AS (
    SELECT r.id FROM public.page365_inventory_runs r
     WHERE r.created_at < v_cut AND r.status <> 'fetching' AND r.id IS DISTINCT FROM v_latest AND r.pruned_at IS NULL),
  it AS (
    DELETE FROM public.page365_inventory_items i USING old
     WHERE i.run_id = old.id AND i.status <> 'applied' AND i.applied_at IS NULL
    RETURNING 1)
  SELECT count(*) INTO v_items_gone FROM it;
  DELETE FROM public.page365_inventory_chunks c
   USING public.page365_inventory_runs r
   WHERE c.run_id = r.id AND r.created_at < v_cut AND r.status <> 'fetching'
     AND r.id IS DISTINCT FROM v_latest AND r.pruned_at IS NULL;
  DELETE FROM public.page365_inventory_products p
   USING public.page365_inventory_runs r
   WHERE p.run_id = r.id AND r.created_at < v_cut AND r.status <> 'fetching'
     AND r.id IS DISTINCT FROM v_latest AND r.pruned_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.page365_inventory_items i WHERE i.inventory_product_id = p.id);
  UPDATE public.page365_inventory_runs r SET pruned_at = now()
   WHERE r.created_at < v_cut AND r.status <> 'fetching' AND r.id IS DISTINCT FROM v_latest AND r.pruned_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_pruned := v_n;

  RETURN jsonb_build_object('ok', true, 'keep_days', v_keep, 'runs_deleted', v_deleted,
                            'runs_pruned', v_pruned, 'items_deleted', v_items_gone);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_retention(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_retention(integer) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_retention(integer) IS
  'Page365 inventory run data retention (PR 3), default 14 days, never fewer than 7. Deletes old runs where nothing was applied; for old runs where something was applied keeps the run, its applied items and their product rows. Never a fetching run, never the latest ready run, never audit_logs.';

-- ---------------------------------------------------------------------------
-- 8. The schedule. Vault-backed service key (CRON AUTH RULE), resolved at
--    fire time; pattern copied from web-reservation-sweep (20260924100000).
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('page365-inventory-schedule')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'page365-inventory-schedule');

SELECT cron.schedule('page365-inventory-schedule', '2-59/5 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/page365-inventory-fetch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{"action":"schedule"}'::jsonb
  );
$cron$);

-- ---------------------------------------------------------------------------
-- 9. Self-check, still inside the transaction. Pure reads; any failure aborts
--    the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn  text;
  v_got text;
  r     record;
BEGIN
  -- The switch is exactly as this file found it (never turned on here).
  IF coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply'), 'absent')
     IS DISTINCT FROM (CASE WHEN current_setting('page365.schedule_switch_before', true) = 'absent'
                            THEN 'false' ELSE current_setting('page365.schedule_switch_before', true) END) THEN
    RAISE EXCEPTION 'page365_inventory_schedule self-check: the auto-apply switch changed during this file';
  END IF;

  -- Pinned bodies unchanged.
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_claim(uuid,integer)',        'fa8a56b999761aa0fab8172ac78f2ed0'),
      ('page365_inventory_store_product(uuid,jsonb,text)', '6ae646ee897b92ca7aa5002f8c416743'),
      ('page365_inventory_finish(uuid)',               '9d0be9494288800686e2d6a90edb3304'),
      ('page365_inventory_apply(uuid,uuid[],uuid[])',  'e65757c2f32b597b2a55047d77783df3')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'page365_inventory_schedule self-check: % body changed (md5 %)', r.fn, v_got;
    END IF;
  END LOOP;

  -- Browser roles reach only the two switch RPCs.
  FOREACH v_fn IN ARRAY ARRAY[
    'public.page365_inventory_lease(uuid,text,integer)', 'public.page365_inventory_release(uuid,text)',
    'public.page365_inventory_auto_apply_run(uuid)', 'public.page365_inventory_retention(integer)',
    'public.guard_page365_inventory_auto_apply()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_inventory_schedule self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.page365_inventory_auto_apply_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_inventory_schedule self-check: service_role cannot run page365_inventory_auto_apply_run';
  END IF;
  IF has_function_privilege('anon', 'public.set_page365_inventory_auto_apply(boolean,boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_page365_inventory_auto_apply(boolean,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_page365_inventory_auto_apply()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_page365_inventory_auto_apply()', 'EXECUTE') THEN
    RAISE EXCEPTION 'page365_inventory_schedule self-check: switch RPC grants are wrong';
  END IF;
  IF has_table_privilege('authenticated', 'public.page365_inventory_runs', 'UPDATE') THEN
    RAISE EXCEPTION 'page365_inventory_schedule self-check: a browser role can write page365_inventory_runs';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_guard_page365_inventory_auto_apply'
                    AND t.tgrelid = 'public.system_settings'::regclass) THEN
    RAISE EXCEPTION 'page365_inventory_schedule self-check: guard trigger missing';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'page365-inventory-schedule') <> 1
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'page365-inventory-schedule' AND schedule = '2-59/5 * * * *'
                       AND command ILIKE '%vault.decrypted_secrets%' AND command ILIKE '%page365-inventory-fetch%'
                       AND command ILIKE '%"action":"schedule"%') THEN
    RAISE EXCEPTION 'page365_inventory_schedule self-check: cron job not registered as written';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) The switch is still OFF and guarded; expect: false | t | t | t
-- SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply') AS auto_apply,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_page365_inventory_auto_apply')      AS guarded,
--        to_regprocedure('public.set_page365_inventory_auto_apply(boolean,boolean)') IS NOT NULL         AS set_rpc,
--        to_regprocedure('public.page365_inventory_auto_apply_run(uuid)') IS NOT NULL                    AS auto_apply_fn;
--
-- (2) The cron job; expect one row: page365-inventory-schedule | 2-59/5 * * * * | t
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'page365-inventory-schedule';
--
-- (3) Browser roles; expect: f | f | t | t
-- SELECT has_function_privilege('authenticated','public.page365_inventory_auto_apply_run(uuid)','EXECUTE')          AS auth_auto_apply,
--        has_function_privilege('authenticated','public.page365_inventory_retention(integer)','EXECUTE')            AS auth_retention,
--        has_function_privilege('authenticated','public.set_page365_inventory_auto_apply(boolean,boolean)','EXECUTE') AS auth_set,
--        has_function_privilege('authenticated','public.get_page365_inventory_auto_apply()','EXECUTE')              AS auth_get;
--
-- (4) The four pinned bodies are unchanged; expect exactly:
--     page365_inventory_apply e65757c2f32b597b2a55047d77783df3 · page365_inventory_claim fa8a56b999761aa0fab8172ac78f2ed0 ·
--     page365_inventory_finish 9d0be9494288800686e2d6a90edb3304 · page365_inventory_store_product 6ae646ee897b92ca7aa5002f8c416743
-- SELECT proname, md5(prosrc) FROM pg_proc
--  WHERE proname IN ('page365_inventory_apply','page365_inventory_claim','page365_inventory_finish','page365_inventory_store_product')
--  ORDER BY 1;
--
-- (5) A direct write of the switch is refused (run it; expect ERROR "page365_inventory_auto_apply is changed only from the Hub…",
--     and the value still false afterwards):
-- UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = 'page365_inventory_auto_apply';
--
-- (6) Within ~35 minutes of the edge deploy: scheduled runs appear, nothing is
--     applied while the switch is off; expect rows with source 'schedule',
--     auto_apply_state 'off' (or 'not_ready' for a partial/failed read), auto_applied 0.
-- SELECT created_at, source, status, auto_apply_state, auto_applied, error
--   FROM public.page365_inventory_runs ORDER BY created_at DESC LIMIT 5;
--
-- (7) The cron calls land (pg_net keeps ~6 h of responses); expect status_code 200.
-- SELECT created, status_code, left(content::text, 200) FROM net._http_response ORDER BY created DESC LIMIT 5;
-- ===========================================================================
