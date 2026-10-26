-- Timesheet -> Consolidation corrections (owner-confirmed 2026-10-26 21:13; docs/TIMESHEET-SPEC.md
-- "Corrections (Admin + Brenda)").
--
--   * Who corrects: admin, or a timesheet user flagged can_view_all (today only Brenda) - the
--     Cost Master / Payslips gate. public.can_correct_timesheet(uid) answers it, for the caller
--     only (uid must be auth.uid()).
--   * How: correct_timesheet_day writes the four punches of one staff member's day (upsert on
--     timesheet_entries, punches only - the legacy note column is never touched), with a REQUIRED
--     comment (3-500 characters, trimmed), and appends one row to timesheet_corrections: who,
--     when, old -> new punches, comment. That history is append-only: UPDATE, DELETE and TRUNCATE
--     are refused by triggers, whoever runs them.
--   * Staff read their own corrections (marker + latest comment on My Timesheet).
--   * A corrected day is LOCKED for the staff member: trg_timesheet_entries_lock_corrected refuses
--     INSERT/UPDATE on (user_id, work_date) with 'day_locked' when a correction exists and the
--     caller is not admin / can_view_all. Service paths (auth.uid() IS NULL) are unaffected, and
--     days without a correction behave exactly as before.
--   * One audit_logs row per correction (entity_type timesheet_correction, entity_id = the
--     correction id) carrying user_id and work_date only - never the punch values.
--   * Midnight: the Hub stores a midnight PM out as 00:00 ON the work date and the engine reads
--     it as 24:00 (docs/TIMESHEET-SPEC.md "Midnight rule"); the order check treats it the same
--     way. A PM out on the next day between 00:00 and 06:00 is also accepted.
--
--   New objects only; the only existing table touched is timesheet_entries (one new trigger).
--   Re-runnable. No comment lines inside any function body (Lovable strips them).

SET lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. The gate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_correct_timesheet(p_uid uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT p_uid IS NOT NULL
     AND p_uid = auth.uid()
     AND (public.has_role(p_uid, 'admin'::app_role) OR public.timesheet_can_view_all(p_uid))
$fn$;
REVOKE ALL ON FUNCTION public.can_correct_timesheet(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_correct_timesheet(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.can_correct_timesheet(uuid) IS
  'Timesheet corrections gate: true when p_uid is the caller (auth.uid()) and has role admin or timesheet_profiles.can_view_all. Same people as the Cost Master / Payslips gate.';

-- ---------------------------------------------------------------------------
-- 2. The append-only history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.timesheet_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  work_date     date NOT NULL,
  old_punches   jsonb NOT NULL CHECK (jsonb_typeof(old_punches) = 'object'),
  new_punches   jsonb NOT NULL CHECK (jsonb_typeof(new_punches) = 'object'),
  comment       text NOT NULL CHECK (length(comment) BETWEEN 3 AND 500 AND comment = btrim(comment)),
  corrected_by  uuid NOT NULL,
  corrected_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS timesheet_corrections_day_idx
  ON public.timesheet_corrections (user_id, work_date, corrected_at DESC);
ALTER TABLE public.timesheet_corrections ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.timesheet_corrections IS
  'Append-only history of Consolidation corrections (owner 2026-10-26): who, when, old -> new punches (keys am_in, am_out, pm_in, pm_out), required comment. Written only by correct_timesheet_day; UPDATE/DELETE/TRUNCATE refused. Read by the corrections gate, and by the staff member for their own days.';

DROP POLICY IF EXISTS timesheet_corrections_read ON public.timesheet_corrections;
CREATE POLICY timesheet_corrections_read ON public.timesheet_corrections
  FOR SELECT TO authenticated
  USING ((SELECT public.can_correct_timesheet((SELECT auth.uid()))) OR user_id = (SELECT auth.uid()));

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.timesheet_corrections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.timesheet_corrections FROM anon;
GRANT SELECT ON public.timesheet_corrections TO authenticated;
GRANT ALL ON public.timesheet_corrections TO service_role;

CREATE OR REPLACE FUNCTION public.timesheet_corrections_refuse_change()
RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'public'
AS $fn$
BEGIN
  RAISE EXCEPTION 'timesheet corrections are permanent history (% refused)', TG_OP USING ERRCODE = 'check_violation';
END
$fn$;
COMMENT ON FUNCTION public.timesheet_corrections_refuse_change() IS
  'BEFORE UPDATE/DELETE (row) and BEFORE TRUNCATE (statement) on timesheet_corrections: always refused.';
REVOKE ALL ON FUNCTION public.timesheet_corrections_refuse_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS timesheet_corrections_refuse_change ON public.timesheet_corrections;
CREATE TRIGGER timesheet_corrections_refuse_change
  BEFORE UPDATE OR DELETE ON public.timesheet_corrections
  FOR EACH ROW EXECUTE FUNCTION public.timesheet_corrections_refuse_change();
DROP TRIGGER IF EXISTS timesheet_corrections_refuse_truncate ON public.timesheet_corrections;
CREATE TRIGGER timesheet_corrections_refuse_truncate
  BEFORE TRUNCATE ON public.timesheet_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION public.timesheet_corrections_refuse_change();

-- ---------------------------------------------------------------------------
-- 3. The day lock on timesheet_entries.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.timesheet_entries_lock_corrected()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.timesheet_corrections c
                  WHERE c.user_id = NEW.user_id AND c.work_date = NEW.work_date)
     AND (TG_OP = 'INSERT' OR NOT EXISTS (SELECT 1 FROM public.timesheet_corrections c
                  WHERE c.user_id = OLD.user_id AND c.work_date = OLD.work_date)) THEN
    RETURN NEW;
  END IF;
  IF public.can_correct_timesheet(v_uid) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'day_locked' USING ERRCODE = 'check_violation',
    DETAIL = 'This day was corrected by Admin or Brenda and can only be changed by them.';
END
$fn$;
COMMENT ON FUNCTION public.timesheet_entries_lock_corrected() IS
  'BEFORE INSERT/UPDATE on timesheet_entries: a day with a timesheet_corrections row is locked (day_locked) unless the caller passes can_correct_timesheet. auth.uid() IS NULL (service paths) is always allowed; days without a correction are untouched.';
REVOKE ALL ON FUNCTION public.timesheet_entries_lock_corrected() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_timesheet_entries_lock_corrected ON public.timesheet_entries;
CREATE TRIGGER trg_timesheet_entries_lock_corrected
  BEFORE INSERT OR UPDATE ON public.timesheet_entries
  FOR EACH ROW EXECUTE FUNCTION public.timesheet_entries_lock_corrected();

-- ---------------------------------------------------------------------------
-- 4. RPCs. jsonb {ok: true, ...} or {error: <code>}; raw database errors never reach the caller.
-- ---------------------------------------------------------------------------

-- correct_timesheet_day: rewrite one staff member's four punches for one day, with a comment.
CREATE OR REPLACE FUNCTION public.correct_timesheet_day(
  p_user_id uuid, p_work_date date,
  p_am_in timestamptz, p_am_out timestamptz, p_pm_in timestamptz, p_pm_out timestamptz,
  p_comment text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_comment  text := btrim(coalesce(p_comment, ''));
  v_tz       text;
  v_old      jsonb;
  v_new      jsonb;
  v_punch    timestamptz;
  v_local    timestamp;
  v_prev     timestamptz;
  v_eff      timestamptz;
  v_key      text;
  v_corr     public.timesheet_corrections%ROWTYPE;
  v_entry    jsonb;
BEGIN
  IF NOT public.can_correct_timesheet(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  SELECT coalesce(nullif(btrim(tp.timezone), ''), 'Asia/Manila') INTO v_tz
    FROM public.timesheet_profiles tp WHERE tp.user_id = p_user_id;
  IF p_user_id IS NULL OR NOT FOUND THEN RETURN jsonb_build_object('error', 'staff_not_found'); END IF;
  IF length(v_comment) < 3 OR length(v_comment) > 500 THEN RETURN jsonb_build_object('error', 'comment_required'); END IF;
  IF p_work_date IS NULL OR p_work_date < DATE '2026-06-01'
     OR p_work_date > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('error', 'invalid_date');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_tz) THEN v_tz := 'Asia/Manila'; END IF;

  v_new := jsonb_build_object('am_in', p_am_in, 'am_out', p_am_out, 'pm_in', p_pm_in, 'pm_out', p_pm_out);
  v_prev := NULL;
  FOREACH v_key IN ARRAY ARRAY['am_in', 'am_out', 'pm_in', 'pm_out'] LOOP
    v_punch := (v_new ->> v_key)::timestamptz;
    CONTINUE WHEN v_punch IS NULL;
    v_local := v_punch AT TIME ZONE v_tz;
    v_eff := v_punch;
    IF v_local::date = p_work_date THEN
      IF v_key = 'pm_out' AND v_local::time = TIME '00:00' THEN
        v_eff := v_punch + interval '1 day';
      END IF;
    ELSIF NOT (v_key = 'pm_out' AND v_local::date = p_work_date + 1 AND v_local::time <= TIME '06:00') THEN
      RETURN jsonb_build_object('error', 'invalid_punch', 'field', v_key);
    END IF;
    IF v_prev IS NOT NULL AND v_eff < v_prev THEN
      RETURN jsonb_build_object('error', 'invalid_order', 'field', v_key);
    END IF;
    v_prev := v_eff;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('timesheet:' || p_user_id::text || ':' || p_work_date::text, 0));

  SELECT jsonb_build_object('am_in', e.am_in, 'am_out', e.am_out, 'pm_in', e.pm_in, 'pm_out', e.pm_out)
    INTO v_old FROM public.timesheet_entries e WHERE e.user_id = p_user_id AND e.work_date = p_work_date;
  v_old := coalesce(v_old, jsonb_build_object('am_in', NULL, 'am_out', NULL, 'pm_in', NULL, 'pm_out', NULL));

  BEGIN
    INSERT INTO public.timesheet_entries (user_id, work_date, am_in, am_out, pm_in, pm_out)
    VALUES (p_user_id, p_work_date, p_am_in, p_am_out, p_pm_in, p_pm_out)
    ON CONFLICT (user_id, work_date) DO UPDATE
       SET am_in = EXCLUDED.am_in, am_out = EXCLUDED.am_out, pm_in = EXCLUDED.pm_in, pm_out = EXCLUDED.pm_out;

    INSERT INTO public.timesheet_corrections (user_id, work_date, old_punches, new_punches, comment, corrected_by, corrected_at)
    VALUES (p_user_id, p_work_date, v_old, v_new, v_comment, v_uid, clock_timestamp())
    RETURNING * INTO v_corr;

    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id, created_at)
    VALUES ('timesheet_correction', v_corr.id, 'correct_timesheet_day',
            jsonb_build_object('user_id', p_user_id, 'work_date', p_work_date), v_uid, now());
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('error', 'save_failed');
  END;

  SELECT jsonb_build_object('user_id', e.user_id, 'work_date', e.work_date, 'am_in', e.am_in, 'am_out', e.am_out,
                            'pm_in', e.pm_in, 'pm_out', e.pm_out)
    INTO v_entry FROM public.timesheet_entries e WHERE e.user_id = p_user_id AND e.work_date = p_work_date;

  RETURN jsonb_build_object('ok', true, 'correction', to_jsonb(v_corr), 'entry', v_entry);
END
$fn$;
REVOKE ALL ON FUNCTION public.correct_timesheet_day(uuid, date, timestamptz, timestamptz, timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_timesheet_day(uuid, date, timestamptz, timestamptz, timestamptz, timestamptz, text) TO authenticated;
COMMENT ON FUNCTION public.correct_timesheet_day(uuid, date, timestamptz, timestamptz, timestamptz, timestamptz, text) IS
  'Consolidation correction: sets the four punches of (p_user_id, p_work_date) (upsert, note untouched), appends a timesheet_corrections row (old -> new, comment) and one audit_logs row (user_id + work_date only). Needs the corrections gate. Refuses permission_denied, staff_not_found, comment_required (3-500), invalid_date (2026-06-01 .. today Manila), invalid_punch (not on the work date in the profile timezone; pm_out may be next day 00:00-06:00), invalid_order (am_in <= am_out <= pm_in <= pm_out; a 00:00 pm_out on the work date is midnight), save_failed.';

-- get_timesheet_corrections(p_month): the corrections in the page's 31-row window.
CREATE OR REPLACE FUNCTION public.get_timesheet_corrections(p_month date)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_all  boolean;
  v_from date;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;
  IF p_month IS NULL THEN RETURN jsonb_build_object('error', 'invalid_month'); END IF;
  v_all := public.can_correct_timesheet(v_uid);
  v_from := date_trunc('month', p_month)::date;

  RETURN jsonb_build_object(
    'ok', true,
    'can_correct', v_all,
    'from', v_from,
    'to', v_from + 30,
    'corrections', coalesce((
      SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('corrected_by_name', pr.full_name)
                       ORDER BY c.work_date, c.corrected_at DESC)
        FROM public.timesheet_corrections c
        LEFT JOIN LATERAL (SELECT p.full_name FROM public.profiles p WHERE p.user_id = c.corrected_by LIMIT 1) pr ON true
       WHERE c.work_date BETWEEN v_from AND v_from + 30
         AND (v_all OR c.user_id = v_uid)), '[]'::jsonb));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_timesheet_corrections(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_timesheet_corrections(date) TO authenticated;
COMMENT ON FUNCTION public.get_timesheet_corrections(date) IS
  'Timesheet corrections dated from the 1st of p_month to the 1st + 30 days (the 31-row sheet), newest first per day, with the corrector''s name. The corrections gate sees everyone''s; anyone else sees only their own.';
