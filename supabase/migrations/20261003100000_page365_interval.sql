-- ===========================================================================
-- page365_interval — SELECTABLE SCHEDULE INTERVAL (5 / 10 / 20 / 30 minutes)
-- and a TIME-SAFE HIDE RULE (PR 3d). Owner decisions, final, 2026-09-26.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, after the release PR is on main
-- and BEFORE page365-inventory-fetch is redeployed. One transaction. When it
-- runs it changes NO website stock, publishes/unpublishes nothing, leaves the
-- automatic switch exactly as it is and changes NO other system_settings row
-- (value, description, updated_at, updated_by) — the self-check proves all of it.
--
-- 1. INTERVAL. system_settings.page365_inventory_interval_minutes, a JSON
--    number, ONLY 5, 10, 20 or 30 (CHECK on system_settings). Seeded 30 =
--    today's behaviour. Changed ONLY by set_page365_inventory_interval
--    (manage_website_catalog; audited: who, from, to, when); a guard trigger
--    refuses every other UPDATE/DELETE. The cron job is NOT changed: it still
--    wakes every 5 minutes (2-59/5). page365-inventory-fetch starts a new
--    scheduled read once (interval − 2.5 min) has passed since the last
--    scheduled START — i.e. at the first 5-minute tick at or after the interval,
--    never earlier (the 2.5 min absorbs cron jitter, half a tick).
--    page365_inventory_interval_minutes() is what the edge function reads;
--    get_page365_inventory_interval() is what the Hub card reads (with "next
--    check around"). Unchanged: nightly full read (page365_inventory_next_kind),
--    skip while a staff fetch reads, one reader, <= 4 requests/s, and every
--    auto-apply rule — including its 30-minute window (a run that FINISHES more
--    than 30 min after it began applies nothing): that is a freshness bound on
--    the data, not the start cadence, and stays 30 at every interval.
-- 2. NO OVERLAP. Unchanged and relied on: a scheduled read still in progress
--    when the next is due is RESUMED, never joined by a second (the edge
--    function; and page365_inventory_runs allows one 'fetching' run).
-- 3. HIDE, TIME-SAFE. page365_inventory_follow (d): a synced product is
--    proposed for hiding only when missing from 2 complete reads in a row AND
--    last seen at least 30 minutes before this read began. Every other
--    hide-follow rule is unchanged. At 30 minutes this is what already held
--    (two missing reads are >= 60 min); at 5 minutes it waits for the read that
--    starts >= 30 min after the product was last seen.
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). md5(pg_proc.prosrc):
--   replaced   page365_inventory_follow          9c99a035f3812fb39522d087618e461d -> 6e26568441fc308c42426de238fb165f   (PR 3b body; (d) + 30 min)
--   relied on, proved unchanged after:
--              page365_inventory_auto_apply_run  d9d251fb68aac0acf9a5360b22fddc07   (PR 3c)
--              page365_inventory_finish          6bf16430aedfd4068b45024b8d860e95   (PR 3c)
--              page365_inventory_next_kind       6d79e693a71a97f2afc12f429dc61e41   (PR 3c)
--              page365_inventory_hide_item       3a0a932b88cdd1534a9c0285f8ea392b   (PR 3b)
--   The replaced body below is the repo text of 20261001100000 with the PR 3d
--   edit applied; its "before" md5 is the body verification (2) of
--   20261002100000 expects on live after PR 3c (follow was relied on, not
--   replaced, by PR 3c).
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if live is not what this was written against. Re-running
-- the file is a no-op (the replaced body is recognised as already new; the
-- seed is ON CONFLICT DO NOTHING).
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
  v_val     jsonb;
  r         record;
BEGIN
  IF to_regclass('public.page365_inventory_runs')   IS NULL THEN v_missing := v_missing || 'page365_inventory_runs (PR 1)'::text; END IF;
  IF to_regclass('public.page365_inventory_items')  IS NULL THEN v_missing := v_missing || 'page365_inventory_items (PR 1)'::text; END IF;
  IF to_regclass('public.page365_product_presence') IS NULL THEN v_missing := v_missing || 'page365_product_presence (PR 3b)'::text; END IF;
  IF to_regclass('public.page365_inventory_reader') IS NULL THEN v_missing := v_missing || 'page365_inventory_reader (PR 3c)'::text; END IF;
  IF to_regclass('public.website_products')         IS NULL THEN v_missing := v_missing || 'website_products'::text; END IF;
  IF to_regclass('public.website_product_variants') IS NULL THEN v_missing := v_missing || 'website_product_variants'::text; END IF;
  IF to_regclass('public.system_settings')          IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF to_regclass('public.audit_logs')               IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.profiles')                 IS NULL THEN v_missing := v_missing || 'profiles'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'page365_interval: missing: %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('system_settings','id'), ('system_settings','key'), ('system_settings','value'), ('system_settings','description'),
      ('system_settings','updated_at'), ('system_settings','updated_by_user_id'),
      ('page365_inventory_runs','source'), ('page365_inventory_runs','status'), ('page365_inventory_runs','created_at'),
      ('page365_inventory_runs','kind'),
      ('page365_product_presence','last_seen_at'),
      ('audit_logs','entity_type'), ('audit_logs','entity_id'), ('audit_logs','action'), ('audit_logs','old_value_json'),
      ('audit_logs','new_value_json'), ('audit_logs','performed_by_user_id'), ('audit_logs','created_at'),
      ('profiles','user_id'), ('profiles','full_name')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'page365_interval: missing column(s): %', array_to_string(v_cols, ', ');
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'page365_interval: public.has_permission(uuid,text) missing';
  END IF;
  IF to_regprocedure('public.page365_first_word(text)') IS NULL THEN
    RAISE EXCEPTION 'page365_interval: public.page365_first_word(text) missing (#195)';
  END IF;

  -- The live bodies. follow may already be new (a re-run).
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_follow(uuid)',                   '9c99a035f3812fb39522d087618e461d', '6e26568441fc308c42426de238fb165f'),
      ('page365_inventory_auto_apply_run(uuid)',           'd9d251fb68aac0acf9a5360b22fddc07', NULL),
      ('page365_inventory_finish(uuid)',                   '6bf16430aedfd4068b45024b8d860e95', NULL),
      ('page365_inventory_next_kind()',                    '6d79e693a71a97f2afc12f429dc61e41', NULL),
      ('page365_inventory_hide_item(uuid,uuid,uuid,text)', '3a0a932b88cdd1534a9c0285f8ea392b', NULL)
    ) AS t(fn, want, or_new)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want AND v_got IS DISTINCT FROM r.or_new THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'STOP — page365_interval: live is not what this file was written against. Nothing was modified.%', v_bad;
  END IF;

  -- Name collisions: new objects must not exist in another shape.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'page365_inventory_interval_minutes' AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'get_page365_inventory_interval'     AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'set_page365_inventory_interval'     AND pg_get_function_identity_arguments(p.oid) <> 'p_minutes integer, p_expected integer')
       OR (p.proname = 'guard_page365_inventory_interval'   AND pg_get_function_identity_arguments(p.oid) <> ''));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'page365_interval: function(s) already exist with another signature: %', v_got;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.system_settings'::regclass AND conname = 'system_settings_page365_interval_check'
                AND pg_get_constraintdef(oid) NOT LIKE '%page365_inventory_interval_minutes%') THEN
    RAISE EXCEPTION 'page365_interval: a different system_settings_page365_interval_check already exists';
  END IF;

  -- A row someone added by hand must already be an allowed value (re-run: 5/10/20/30).
  SELECT value INTO v_val FROM public.system_settings WHERE key = 'page365_inventory_interval_minutes';
  IF FOUND AND (v_val IS NULL OR v_val NOT IN ('5'::jsonb, '10'::jsonb, '20'::jsonb, '30'::jsonb)) THEN
    RAISE EXCEPTION 'page365_interval: system_settings.page365_inventory_interval_minutes exists with %, expected 5, 10, 20 or 30', v_val;
  END IF;

  -- Remember what must not move: every OTHER setting, and every product's status/stock.
  PERFORM set_config('page365.interval_settings_before',
                     (SELECT md5(coalesce(string_agg(s.key || '=' || coalesce(s.value::text, '∅') || '|' || coalesce(s.description, '∅')
                                                     || '|' || coalesce(s.updated_at::text, '∅') || '|' || coalesce(s.updated_by_user_id::text, '∅'),
                                                     E'\n' ORDER BY s.key), ''))
                        FROM public.system_settings s WHERE s.key <> 'page365_inventory_interval_minutes'), true);
  PERFORM set_config('page365.interval_catalog_before',
                     (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), ''))
                        FROM public.website_products wp)
                     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), ''))
                           FROM public.website_product_variants v), true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The setting. Seeded 30 (today's behaviour) only if absent; a JSON number.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('page365_inventory_interval_minutes', '30'::jsonb,
        'Page365 inventory (PR 3d): minutes between SCHEDULED reads — 5, 10, 20 or 30 only (CHECK). The cron job wakes every 5 minutes and starts a new quick read once this interval has passed since the last scheduled start; a read still running is never overlapped. Changed only from Hub -> Website -> Page365 stock (set_page365_inventory_interval; manage_website_catalog; audited).')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.system_settings DROP CONSTRAINT IF EXISTS system_settings_page365_interval_check;
ALTER TABLE public.system_settings ADD CONSTRAINT system_settings_page365_interval_check
  CHECK (key <> 'page365_inventory_interval_minutes' OR value IN ('5'::jsonb, '10'::jsonb, '20'::jsonb, '30'::jsonb));

-- ---------------------------------------------------------------------------
-- 2. Guard: the value moves only through set_page365_inventory_interval.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_page365_inventory_interval()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key = 'page365_inventory_interval_minutes'
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key = 'page365_inventory_interval_minutes' AND OLD.key <> 'page365_inventory_interval_minutes')
  THEN
    IF coalesce(current_setting('app.allow_page365_interval_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'page365_inventory_interval_minutes is changed only from the Hub: Website → Page365 stock → Check Page365 every (set_page365_inventory_interval).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_page365_inventory_interval() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_page365_inventory_interval ON public.system_settings;
CREATE TRIGGER trg_guard_page365_inventory_interval
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_page365_inventory_interval();

-- ---------------------------------------------------------------------------
-- 3. Read the interval. The edge function (service role) and the Hub card.
--    Anything but 5/10/20/30 (the CHECK makes that impossible; a missing row
--    is possible) reads as 30.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_interval_minutes()
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT coalesce((SELECT CASE WHEN s.value IN ('5'::jsonb, '10'::jsonb, '20'::jsonb, '30'::jsonb)
                               THEN (s.value #>> '{}')::integer END
                     FROM public.system_settings s WHERE s.key = 'page365_inventory_interval_minutes'), 30)
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_interval_minutes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_interval_minutes() TO service_role;
COMMENT ON FUNCTION public.page365_inventory_interval_minutes() IS
  'Page365 inventory (PR 3d): minutes between scheduled reads (5, 10, 20 or 30; 30 if the setting is missing). Service role — page365-inventory-fetch starts a scheduled read once (this − 2.5) minutes have passed since the last scheduled start.';

-- The Hub card: the interval, who last changed it, and when the next check is
-- expected. The rule mirrors the edge function: due at last scheduled start +
-- interval − 150 s; the cron wakes at minute 2, 7, 12 … 57 (2-59/5), so the next
-- check is the first such tick at or after max(due, now). "Around": the tick
-- itself takes a few seconds to begin reading.
CREATE OR REPLACE FUNCTION public.get_page365_inventory_interval()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid     uuid := auth.uid();
  v_row     public.system_settings%ROWTYPE;
  v_name    text;
  v_minutes integer := public.page365_inventory_interval_minutes();
  v_last    timestamptz;
  v_open    text;
  v_from    timestamptz;
  v_tick    timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_row FROM public.system_settings WHERE key = 'page365_inventory_interval_minutes';
  IF v_row.updated_by_user_id IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_row.updated_by_user_id LIMIT 1;
  END IF;
  SELECT max(r.created_at) INTO v_last FROM public.page365_inventory_runs r WHERE r.source = 'schedule';
  SELECT r.source INTO v_open FROM public.page365_inventory_runs r WHERE r.status = 'fetching'
   ORDER BY r.created_at DESC LIMIT 1;

  v_from := greatest(now(), coalesce(v_last + make_interval(secs => v_minutes * 60 - 150), now()));
  v_tick := date_trunc('minute', v_from)
            + CASE WHEN v_from > date_trunc('minute', v_from) THEN interval '1 minute' ELSE interval '0' END;
  v_tick := v_tick + make_interval(mins => ((2 - extract(minute FROM v_tick)::integer) % 5 + 5) % 5);

  RETURN jsonb_build_object(
    'found',              v_row.id IS NOT NULL,
    'minutes',            v_minutes,
    'allowed',            jsonb_build_array(5, 10, 20, 30),
    'updated_at',         v_row.updated_at,
    'updated_by_user_id', v_row.updated_by_user_id,
    'updated_by_name',    v_name,
    'last_scheduled_at',  v_last,
    'reading',            v_open,          -- 'schedule' | 'manual' | null
    'next_check_at',      v_tick,
    'can_change',         true);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_page365_inventory_interval() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_page365_inventory_interval() TO authenticated, service_role;
COMMENT ON FUNCTION public.get_page365_inventory_interval() IS
  'Page365 inventory (PR 3d), Hub card: the scheduled-read interval, who last changed it, the last scheduled start, what is reading now, and next_check_at (the first 2-59/5 cron tick at or after last start + interval − 150 s). manage_website_catalog.';

-- ---------------------------------------------------------------------------
-- 4. Change the interval. manage_website_catalog (admin passes has_permission).
--    Audited: who (performed_by_user_id), from, to, when.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_page365_inventory_interval(p_minutes integer, p_expected integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.system_settings%ROWTYPE;
  v_old integer;
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_permission(v_uid, 'manage_website_catalog') THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_minutes IS NULL OR p_minutes NOT IN (5, 10, 20, 30) THEN
    RETURN jsonb_build_object('error', 'invalid_interval');
  END IF;

  SELECT * INTO v_row FROM public.system_settings WHERE key = 'page365_inventory_interval_minutes' FOR UPDATE;
  IF v_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;
  v_old := (v_row.value #>> '{}')::integer;

  -- Two people on the same screen: the second choice was made against a value
  -- that no longer holds.
  IF p_expected IS NOT NULL AND p_expected IS DISTINCT FROM v_old THEN
    RETURN jsonb_build_object('error', 'stale', 'minutes', v_old);
  END IF;
  IF v_old = p_minutes THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'minutes', v_old);
  END IF;

  PERFORM set_config('app.allow_page365_interval_change', 'on', true);
  UPDATE public.system_settings
     SET value = to_jsonb(p_minutes), updated_by_user_id = v_uid, updated_at = v_now
   WHERE id = v_row.id;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_row.id, 'set_page365_inventory_interval',
          jsonb_build_object('key', 'page365_inventory_interval_minutes', 'minutes', v_old,
                             'updated_at', v_row.updated_at, 'updated_by_user_id', v_row.updated_by_user_id),
          jsonb_build_object('key', 'page365_inventory_interval_minutes', 'minutes', p_minutes),
          v_uid, v_now);
  PERFORM set_config('app.allow_page365_interval_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'minutes', p_minutes, 'old_minutes', v_old, 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_page365_inventory_interval(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_page365_inventory_interval(integer, integer) TO authenticated;
COMMENT ON FUNCTION public.set_page365_inventory_interval(integer, integer) IS
  'Page365 inventory (PR 3d): the ONLY writer of system_settings.page365_inventory_interval_minutes. manage_website_catalog. 5, 10, 20 or 30 only (invalid_interval). p_expected guards a stale screen. One audit_logs row per change (set_page365_inventory_interval: from, to, who, when).';

-- ---------------------------------------------------------------------------
-- 5. The time-safe hide rule: page365_inventory_follow (d) (PR 3b body + one
--    condition). Every other line is the live body unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_inventory_follow(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_back     integer := 0;
  v_cleared  integer := 0;
  v_seen     integer := 0;
  v_hide     integer := 0;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id;
  IF NOT FOUND OR v_run.status <> 'ready' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_ready');
  END IF;

  -- (a) Back in Page365: matched again, the Hub hid it, still a draft. Flag
  --     only — never re-published here.
  UPDATE public.page365_inventory_items i
     SET back_in_page365 = true
    FROM public.page365_product_presence pr, public.website_products wp
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
     AND i.category <> 'not_synced'
     AND pr.website_product_id = i.website_product_id AND pr.hidden_at IS NOT NULL
     AND wp.id = i.website_product_id AND wp.status::text = 'draft';
  GET DIAGNOSTICS v_back = ROW_COUNT;

  -- (b) Seen again and no longer a draft (staff re-published or archived it):
  --     the hide mark no longer describes it.
  UPDATE public.page365_product_presence pr
     SET hidden_at = NULL, hidden_run_id = NULL, hidden_by = NULL, hidden_source = NULL, updated_at = now()
    FROM public.page365_inventory_items i, public.website_products wp
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
     AND pr.website_product_id = i.website_product_id AND pr.hidden_at IS NOT NULL
     AND wp.id = i.website_product_id AND wp.status::text <> 'draft';
  GET DIAGNOSTICS v_cleared = ROW_COUNT;

  -- (c) Seen: every product matched on its code in this complete read.
  INSERT INTO public.page365_product_presence
    (website_product_id, code, first_seen_at, first_seen_run_id, last_seen_at, last_seen_run_id)
  SELECT DISTINCT ON (i.website_product_id) i.website_product_id, i.code, v_run.created_at, p_run_id, v_run.created_at, p_run_id
    FROM public.page365_inventory_items i
   WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.match_result = 'matched'
     AND i.website_product_id IS NOT NULL AND i.code IS NOT NULL
   ORDER BY i.website_product_id, i.id
  ON CONFLICT (website_product_id) DO UPDATE
     SET code = EXCLUDED.code, last_seen_at = EXCLUDED.last_seen_at, last_seen_run_id = EXCLUDED.last_seen_run_id,
         updated_at = now()
   WHERE page365_product_presence.last_seen_at <= EXCLUDED.last_seen_at;
  GET DIAGNOSTICS v_seen = ROW_COUNT;

  -- (d) The proposal. A Hub-only row (the code is absent from this complete
  --     read) becomes 'hide' only when ALL hold: missing from 2 complete reads
  --     in a row (finish's missing_runs, which chains over ready runs only);
  --     seen earlier on this very code; still published; not switched off;
  --     and (PR 3d) last seen at least 30 minutes before this read began —
  --     at a 5-minute interval, two missing reads alone are only 10 minutes.
  UPDATE public.page365_inventory_items i
     SET category = 'hide', proposed_stock = 0, seen_stock = s.total, hide_snapshot = s.snap
    FROM public.website_products wp
    JOIN public.page365_product_presence pr ON pr.website_product_id = wp.id
    CROSS JOIN LATERAL (
      SELECT coalesce(jsonb_object_agg(v.id::text, v.stock_qty), '{}'::jsonb) AS snap,
             coalesce(sum(v.stock_qty), 0)::integer AS total
        FROM public.website_product_variants v WHERE v.product_id = wp.id) s
   WHERE i.run_id = p_run_id AND i.kind = 'hub_only' AND i.category = 'hub_only'
     AND coalesce(i.missing_runs, 0) >= 2
     AND wp.id = i.website_product_id
     AND wp.status::text = 'active' AND NOT coalesce(wp.page365_sync_disabled, false)
     AND pr.last_seen_at < v_run.created_at
     AND pr.last_seen_at <= v_run.created_at - interval '30 minutes'
     AND pr.code = public.page365_first_word(wp.sku);
  GET DIAGNOSTICS v_hide = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'seen', v_seen, 'hide_proposed', v_hide,
                            'back_in_page365', v_back, 'hide_marks_cleared', v_cleared);
END
$fn$;
REVOKE ALL ON FUNCTION public.page365_inventory_follow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.page365_inventory_follow(uuid) TO service_role;
COMMENT ON FUNCTION public.page365_inventory_follow(uuid) IS
  'Page365 hide-follow (PR 3b; PR 3d time-safe). For a READY run: records products seen (page365_product_presence), flags hidden products back in Page365 (back_in_page365), and turns Hub-only rows missing from 2 complete reads in a row — seen before on the same code, last seen at least 30 minutes before this read began, still published, not switched off — into category hide. Never writes stock or product status. Called by trg_page365_inventory_follow.';

-- ---------------------------------------------------------------------------
-- 6. Self-check. Any failure rolls the whole file back.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_got text;
  v_fn  text;
  r     record;
BEGIN
  IF (SELECT md5(coalesce(string_agg(s.key || '=' || coalesce(s.value::text, '∅') || '|' || coalesce(s.description, '∅')
                                     || '|' || coalesce(s.updated_at::text, '∅') || '|' || coalesce(s.updated_by_user_id::text, '∅'),
                                     E'\n' ORDER BY s.key), ''))
        FROM public.system_settings s WHERE s.key <> 'page365_inventory_interval_minutes')
     IS DISTINCT FROM current_setting('page365.interval_settings_before', true) THEN
    RAISE EXCEPTION 'page365_interval self-check: another system_settings row changed';
  END IF;
  IF (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty, ',' ORDER BY v.id), '')) FROM public.website_product_variants v)
     IS DISTINCT FROM current_setting('page365.interval_catalog_before', true) THEN
    RAISE EXCEPTION 'page365_interval self-check: website stock or product status changed';
  END IF;
  IF (SELECT value FROM public.system_settings WHERE key = 'page365_inventory_interval_minutes')
     NOT IN ('5'::jsonb, '10'::jsonb, '20'::jsonb, '30'::jsonb) THEN
    RAISE EXCEPTION 'page365_interval self-check: the interval setting is missing or invalid';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('page365_inventory_follow(uuid)',                   '6e26568441fc308c42426de238fb165f'),
      ('page365_inventory_auto_apply_run(uuid)',           'd9d251fb68aac0acf9a5360b22fddc07'),
      ('page365_inventory_finish(uuid)',                   '6bf16430aedfd4068b45024b8d860e95'),
      ('page365_inventory_next_kind()',                    '6d79e693a71a97f2afc12f429dc61e41'),
      ('page365_inventory_hide_item(uuid,uuid,uuid,text)', '3a0a932b88cdd1534a9c0285f8ea392b')
    ) AS t(fn, want)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want THEN
      RAISE EXCEPTION 'page365_interval self-check: % body md5 %, expected %', r.fn, v_got, r.want;
    END IF;
  END LOOP;

  -- Service-role only: the interval reader and follow. Staff: get and set.
  FOREACH v_fn IN ARRAY ARRAY['public.page365_inventory_interval_minutes()', 'public.page365_inventory_follow(uuid)'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_interval self-check: % is callable by a browser role', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_interval self-check: service_role cannot run %', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.get_page365_inventory_interval()', 'public.set_page365_inventory_interval(integer,integer)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'page365_interval self-check: % grants are wrong', v_fn;
    END IF;
  END LOOP;

  -- The CHECK and the guard are in force.
  BEGIN
    UPDATE public.system_settings SET value = '15'::jsonb WHERE key = 'page365_inventory_interval_minutes';
    RAISE EXCEPTION 'page365_interval self-check: a plain UPDATE of the interval was not refused';
  EXCEPTION WHEN raise_exception OR check_violation THEN
    IF SQLERRM LIKE 'page365_interval self-check:%' THEN RAISE; END IF;
  END;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_page365_inventory_interval'
                    AND tgrelid = 'public.system_settings'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'page365_interval self-check: trg_guard_page365_inventory_interval missing';
  END IF;
  IF public.page365_inventory_interval_minutes() NOT IN (5, 10, 20, 30) THEN
    RAISE EXCEPTION 'page365_interval self-check: page365_inventory_interval_minutes() is broken';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) The setting and the switch; expect: 30 | true | t | t | t
--     (30 = seeded; the switch stays whatever it was — the owner turned it ON)
-- SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_interval_minutes') AS interval_minutes,
--        (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'page365_inventory_auto_apply')        AS auto_apply,
--        to_regprocedure('public.set_page365_inventory_interval(integer,integer)') IS NOT NULL               AS set_fn,
--        EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_settings_page365_interval_check')        AS check_on,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_page365_inventory_interval')             AS guard_on;
--
-- (2) Bodies; expect exactly:
--     page365_inventory_auto_apply_run d9d251fb68aac0acf9a5360b22fddc07 ·
--     page365_inventory_finish 6bf16430aedfd4068b45024b8d860e95 ·
--     page365_inventory_follow 6e26568441fc308c42426de238fb165f ·
--     page365_inventory_hide_item 3a0a932b88cdd1534a9c0285f8ea392b ·
--     page365_inventory_next_kind 6d79e693a71a97f2afc12f429dc61e41
-- SELECT proname, md5(prosrc) FROM pg_proc
--  WHERE proname IN ('page365_inventory_auto_apply_run','page365_inventory_finish','page365_inventory_follow',
--                    'page365_inventory_hide_item','page365_inventory_next_kind')
--  ORDER BY 1;
--
-- (3) Browser roles; expect: f | t | t | f
-- SELECT has_function_privilege('authenticated','public.page365_inventory_interval_minutes()','EXECUTE')             AS auth_reader,
--        has_function_privilege('authenticated','public.get_page365_inventory_interval()','EXECUTE')                 AS auth_get,
--        has_function_privilege('authenticated','public.set_page365_inventory_interval(integer,integer)','EXECUTE')  AS auth_set,
--        has_function_privilege('anon','public.set_page365_inventory_interval(integer,integer)','EXECUTE')           AS anon_set;
--
-- (4) The cron job is unchanged; expect one row: page365-inventory-schedule | 2-59/5 * * * * | t
-- SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'page365-inventory-schedule';
--
-- (5) Nothing audited yet; expect 0 (one row per change from the Hub afterwards)
-- SELECT count(*) FROM public.audit_logs WHERE action = 'set_page365_inventory_interval';
--
-- (6) After the edge redeploy, with the Hub set to 5 minutes, over ~20 minutes: scheduled starts
--     ~5 minutes apart (never less than 4.5), one reading at a time; expect gap_min ≈ 5.0.
-- SELECT created_at, kind, status, round(extract(epoch FROM created_at - lag(created_at) OVER (ORDER BY created_at)) / 60, 1) AS gap_min,
--        round(extract(epoch FROM finished_at - created_at)) AS seconds, auto_apply_state
--   FROM public.page365_inventory_runs WHERE source = 'schedule' ORDER BY created_at DESC LIMIT 8;
-- ===========================================================================
