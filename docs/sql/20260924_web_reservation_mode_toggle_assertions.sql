-- ============================================================================
-- Reserve-first switch from the Hub — SQL assertions for migration
-- 20260924120000_web_reservation_mode_toggle. 2026-09-24. Run in the Supabase
-- SQL Editor AFTER the migration is applied.
--
-- WHAT IT PROVES.
--   A  only an admin can write: no identity -> user_identity_required, a
--      non-admin -> permission_denied (skipped with a NOTICE if live has no
--      non-admin staff user), null -> enabled_required.
--   B  an admin write stores JSON true / false (jsonb_typeof boolean — the form
--      the website's readReservationMode treats as on), stamps updated_by/at,
--      and writes exactly ONE audit_logs row with old -> new, user and time.
--   C  writing the state it already has changes nothing and audits nothing.
--   D  p_expected that no longer holds returns 'stale' and writes nothing.
--   E  the read agrees with the website reader: JSON true and "true" are On,
--      JSON false, "false", "yes" and 1 are Off.
--   F  a direct UPDATE or DELETE of the row — PostgREST or SQL Editor — is
--      refused. Another system_settings key can still be updated.
--   G  the read refuses a caller with neither admin nor manage_website_content.
--
-- WRITES NOTHING THAT SURVIVES. One transaction ending in ROLLBACK; no fixtures
-- are inserted. The switch is flipped INSIDE the transaction only — the website
-- reads committed data, so a live checkout during the run still sees the real
-- value. The row is locked for the few milliseconds the script runs.
--
-- The script acts as users by setting request.jwt.claims (what auth.uid()
-- reads), local to the transaction.
--
-- Reading the result: NOTICE 'ALL RESERVATION-MODE TOGGLE ASSERTIONS PASSED'.
-- Any failure RAISEs 'ASSERTION FAILED — …' and the ROLLBACK still runs.
-- ============================================================================

BEGIN;

DO $t$
DECLARE
  v_admin   uuid;
  v_staff   uuid;
  v_nobody  uuid;
  v_id      uuid;
  v_orig    jsonb;
  v_start   boolean;
  v_r       jsonb;
  v_n0      int;
  v_n1      int;
  v_val     jsonb;
  v_by      uuid;
  v_audit   record;
  v_raw     jsonb;
  v_ok      boolean;
BEGIN
  SELECT id, value INTO v_id, v_orig FROM public.system_settings WHERE key = 'web_reservation_mode';
  IF v_id IS NULL THEN RAISE EXCEPTION 'ASSERTION FAILED — setup: web_reservation_mode row missing (A1 seeds it)'; END IF;

  SELECT ur.user_id INTO v_admin FROM public.user_roles ur WHERE ur.role = 'admin' LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'ASSERTION FAILED — setup: no admin user'; END IF;
  SELECT ur.user_id INTO v_staff FROM public.user_roles ur
   WHERE ur.role IN ('staff', 'csr', 'finance')
     AND NOT EXISTS (SELECT 1 FROM public.user_roles a WHERE a.user_id = ur.user_id AND a.role = 'admin')
   LIMIT 1;
  v_nobody := gen_random_uuid();   -- a uid with no role at all

  -- ---------------------------------------------------------------- A
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  v_r := public.set_web_reservation_mode(true);
  IF v_r->>'error' IS DISTINCT FROM 'user_identity_required' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A: no identity returned %', v_r; END IF;

  IF v_staff IS NOT NULL THEN
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    v_r := public.set_web_reservation_mode(true);
    IF v_r->>'error' IS DISTINCT FROM 'permission_denied' THEN
      RAISE EXCEPTION 'ASSERTION FAILED — A: non-admin returned %', v_r; END IF;
  ELSE
    RAISE NOTICE 'A: no non-admin staff user on live — the non-admin write check was skipped';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_r := public.set_web_reservation_mode(NULL);
  IF v_r->>'error' IS DISTINCT FROM 'enabled_required' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A: null returned %', v_r; END IF;

  IF (SELECT value FROM public.system_settings WHERE id = v_id) IS DISTINCT FROM v_orig THEN
    RAISE EXCEPTION 'ASSERTION FAILED — A: a refused call changed the value'; END IF;

  -- ---------------------------------------------------------------- B
  v_start := (public.get_web_reservation_mode()->>'enabled')::boolean;
  SELECT count(*) INTO v_n0 FROM public.audit_logs WHERE entity_id = v_id AND action = 'set_web_reservation_mode';

  v_r := public.set_web_reservation_mode(NOT v_start, v_start);
  IF NOT COALESCE((v_r->>'changed')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B: flip returned %', v_r; END IF;
  SELECT value, updated_by_user_id INTO v_val, v_by FROM public.system_settings WHERE id = v_id;
  IF jsonb_typeof(v_val) <> 'boolean' OR v_val <> to_jsonb(NOT v_start) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B: stored % (want JSON boolean %)', v_val, NOT v_start; END IF;
  IF v_by IS DISTINCT FROM v_admin THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B: updated_by_user_id is %', v_by; END IF;
  SELECT count(*) INTO v_n1 FROM public.audit_logs WHERE entity_id = v_id AND action = 'set_web_reservation_mode';
  IF v_n1 <> v_n0 + 1 THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B: % audit rows written (want 1)', v_n1 - v_n0; END IF;
  SELECT * INTO v_audit FROM public.audit_logs WHERE entity_id = v_id AND action = 'set_web_reservation_mode'
   ORDER BY created_at DESC LIMIT 1;
  IF v_audit.entity_type <> 'system_setting'
     OR (v_audit.old_value_json->>'enabled')::boolean IS DISTINCT FROM v_start
     OR (v_audit.new_value_json->>'enabled')::boolean IS DISTINCT FROM (NOT v_start)
     OR v_audit.performed_by_user_id IS DISTINCT FROM v_admin
     OR v_audit.created_at IS NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B: audit row %', row_to_json(v_audit); END IF;

  -- and back, so the rest runs from a known state
  v_r := public.set_web_reservation_mode(v_start, NOT v_start);
  IF NOT COALESCE((v_r->>'changed')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — B: flip back returned %', v_r; END IF;

  -- ---------------------------------------------------------------- C
  SELECT count(*) INTO v_n0 FROM public.audit_logs WHERE entity_id = v_id AND action = 'set_web_reservation_mode';
  v_r := public.set_web_reservation_mode(v_start);
  IF COALESCE((v_r->>'changed')::boolean, true) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — C: same-state write returned %', v_r; END IF;
  SELECT count(*) INTO v_n1 FROM public.audit_logs WHERE entity_id = v_id AND action = 'set_web_reservation_mode';
  IF v_n1 <> v_n0 THEN RAISE EXCEPTION 'ASSERTION FAILED — C: same-state write audited'; END IF;

  -- ---------------------------------------------------------------- D
  v_r := public.set_web_reservation_mode(NOT v_start, NOT v_start);
  IF v_r->>'error' IS DISTINCT FROM 'stale' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D: stale expectation returned %', v_r; END IF;
  IF (public.get_web_reservation_mode()->>'enabled')::boolean IS DISTINCT FROM v_start THEN
    RAISE EXCEPTION 'ASSERTION FAILED — D: stale call changed the value'; END IF;

  -- ---------------------------------------------------------------- E
  PERFORM set_config('app.allow_web_reservation_mode_change', 'on', true);
  FOREACH v_raw IN ARRAY ARRAY['true'::jsonb, '"true"'::jsonb, 'false'::jsonb, '"false"'::jsonb, '"yes"'::jsonb, '1'::jsonb, 'null'::jsonb] LOOP
    UPDATE public.system_settings SET value = v_raw WHERE id = v_id;
    v_ok := (public.get_web_reservation_mode()->>'enabled')::boolean;
    IF v_ok IS DISTINCT FROM (v_raw IN ('true'::jsonb, '"true"'::jsonb)) THEN
      RAISE EXCEPTION 'ASSERTION FAILED — E: stored % read as enabled=%', v_raw, v_ok; END IF;
  END LOOP;
  UPDATE public.system_settings SET value = v_orig WHERE id = v_id;
  PERFORM set_config('app.allow_web_reservation_mode_change', '', true);

  -- ---------------------------------------------------------------- F
  BEGIN
    UPDATE public.system_settings SET value = 'true'::jsonb WHERE id = v_id;
    RAISE EXCEPTION 'ASSERTION FAILED — F: direct UPDATE was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'ASSERTION FAILED%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.system_settings WHERE id = v_id;
    RAISE EXCEPTION 'ASSERTION FAILED — F: direct DELETE was allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'ASSERTION FAILED%' THEN RAISE; END IF;
  END;
  UPDATE public.system_settings SET value = value WHERE key = 'php_jpy_rate';   -- other keys unaffected
  UPDATE public.system_settings SET updated_at = updated_at WHERE id = v_id;    -- value unchanged: allowed

  -- ---------------------------------------------------------------- G
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_nobody, 'role', 'authenticated')::text, true);
  v_r := public.get_web_reservation_mode();
  IF v_r->>'error' IS DISTINCT FROM 'permission_denied' THEN
    RAISE EXCEPTION 'ASSERTION FAILED — G: read by a roleless uid returned %', v_r; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  v_r := public.get_web_reservation_mode();
  IF NOT (v_r ? 'awaiting_total') OR NOT COALESCE((v_r->>'can_change')::boolean, false) THEN
    RAISE EXCEPTION 'ASSERTION FAILED — G: admin read returned %', v_r; END IF;

  IF (SELECT value FROM public.system_settings WHERE id = v_id) IS DISTINCT FROM v_orig THEN
    RAISE EXCEPTION 'ASSERTION FAILED — end state differs from start'; END IF;

  RAISE NOTICE 'ALL RESERVATION-MODE TOGGLE ASSERTIONS PASSED (switch is %, % reservations awaiting)',
    CASE WHEN v_start THEN 'ON' ELSE 'OFF' END, v_r->>'awaiting_total';
END
$t$;

ROLLBACK;
