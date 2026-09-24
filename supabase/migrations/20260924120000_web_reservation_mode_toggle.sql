-- ============================================================================
-- Reserve-first switch, controlled from the Hub (owner request 2026-09-24).
--
-- system_settings.web_reservation_mode decides whether web checkout creates
-- reservations (docs/RESERVE-FIRST.md). Until now the only way to change it was
-- SQL. From here on it is changed ONLY from Website → Settings → "Reserve-first
-- checkout", through ONE function that checks admin, writes the value in the
-- form the website reader expects, and leaves an audit row.
--
--   get_web_reservation_mode()        read: state, last change, waiting count
--   set_web_reservation_mode(bool, bool)  write: admin only, audited
--   trg_guard_web_reservation_mode    refuses any other UPDATE/DELETE of the row
--
-- THE VALUE WRITTEN IS JSON true / false. The website reads it through
-- readReservationMode (_shared/web-reservation-rules.ts): only JSON true or the
-- string "true" is on, anything else is off. The read RPC applies the same test,
-- so the Hub never shows "On" for a value the website treats as off.
--
-- RLS IS NOT WIDENED. system_settings keeps its three baseline policies (admins
-- insert/update, staff select). Both functions are SECURITY DEFINER and make
-- their own checks. The guard trigger goes further than RLS: an admin's direct
-- PostgREST update, and a SQL Editor UPDATE, are refused for THIS key unless
-- they come through set_web_reservation_mode — the owner asked that the switch
-- never be changed by SQL, and a change made that way would have no audit row.
-- Every other system_settings key is untouched by the trigger.
--
-- No edge function changes. The website reads the switch per request already.
-- ============================================================================

-- ------------------------------------------------------------ 1. guard
CREATE OR REPLACE FUNCTION public.guard_web_reservation_mode()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (OLD.key = 'web_reservation_mode'
      AND (TG_OP = 'DELETE'
           OR NEW.key IS DISTINCT FROM OLD.key
           OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key = 'web_reservation_mode' AND OLD.key <> 'web_reservation_mode')
  THEN
    IF COALESCE(current_setting('app.allow_web_reservation_mode_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'web_reservation_mode is changed only from the Hub: Website → Settings → Reserve-first checkout (set_web_reservation_mode).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

REVOKE ALL ON FUNCTION public.guard_web_reservation_mode() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_web_reservation_mode ON public.system_settings;
CREATE TRIGGER trg_guard_web_reservation_mode
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_web_reservation_mode();

-- ------------------------------------------------------------ 2. read
CREATE OR REPLACE FUNCTION public.get_web_reservation_mode()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_row     public.system_settings%ROWTYPE;
  v_by_name text;
  v_cash    int;
  v_layaway int;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role)
          OR public.has_permission(v_uid, 'manage_website_content')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_row FROM public.system_settings WHERE key = 'web_reservation_mode';

  IF v_row.updated_by_user_id IS NOT NULL THEN
    SELECT full_name INTO v_by_name FROM public.profiles WHERE user_id = v_row.updated_by_user_id LIMIT 1;
  END IF;

  -- Reservations still waiting: the same predicate as the Hub queue
  -- (useWebReservations) — web, unconfirmed, still live.
  SELECT count(*) INTO v_cash FROM public.cash_orders
   WHERE source_channel = 'web' AND ready_confirmed_at IS NULL AND status::text = 'pending';
  SELECT count(*) INTO v_layaway FROM public.layaway_accounts
   WHERE source_channel = 'web' AND ready_confirmed_at IS NULL AND status::text = 'active';

  RETURN jsonb_build_object(
    'found',              v_row.id IS NOT NULL,
    'enabled',            COALESCE(v_row.value = 'true'::jsonb OR v_row.value = '"true"'::jsonb, false),
    'raw_value',          v_row.value,
    'updated_at',         v_row.updated_at,
    'updated_by_user_id', v_row.updated_by_user_id,
    'updated_by_name',    v_by_name,
    'can_change',         public.has_role(v_uid, 'admin'::public.app_role),
    'awaiting_cash',      v_cash,
    'awaiting_layaway',   v_layaway,
    'awaiting_total',     v_cash + v_layaway
  );
END
$$;

REVOKE ALL ON FUNCTION public.get_web_reservation_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_web_reservation_mode() TO authenticated, service_role;

COMMENT ON FUNCTION public.get_web_reservation_mode() IS
  'Reserve-first switch for the Hub card (Website → Settings). Admin or manage_website_content. Returns enabled (JSON true or "true" only — the website reader''s rule), last change (updated_at, updated_by_name), can_change (admin) and the count of web reservations still awaiting confirmation.';

-- ------------------------------------------------------------ 3. write
CREATE OR REPLACE FUNCTION public.set_web_reservation_mode(p_enabled boolean, p_expected boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_row      public.system_settings%ROWTYPE;
  v_old      boolean;
  v_cash     int;
  v_layaway  int;
  v_now      timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'user_identity_required');
  END IF;
  -- ADMIN ONLY — by role, not by permission key, so no override can grant it.
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  IF p_enabled IS NULL THEN
    RETURN jsonb_build_object('error', 'enabled_required');
  END IF;

  SELECT * INTO v_row FROM public.system_settings WHERE key = 'web_reservation_mode' FOR UPDATE;
  IF v_row.id IS NULL THEN
    -- A1 seeds this row. Missing means something removed it; refuse rather
    -- than invent one with no description.
    RETURN jsonb_build_object('error', 'setting_missing');
  END IF;

  v_old := (v_row.value = 'true'::jsonb OR v_row.value = '"true"'::jsonb);

  -- Two admins on the same screen: the second one's click was made against a
  -- state that no longer holds. Tell them rather than silently re-applying.
  IF p_expected IS NOT NULL AND p_expected IS DISTINCT FROM v_old THEN
    RETURN jsonb_build_object('error', 'stale', 'enabled', v_old);
  END IF;

  SELECT count(*) INTO v_cash FROM public.cash_orders
   WHERE source_channel = 'web' AND ready_confirmed_at IS NULL AND status::text = 'pending';
  SELECT count(*) INTO v_layaway FROM public.layaway_accounts
   WHERE source_channel = 'web' AND ready_confirmed_at IS NULL AND status::text = 'active';

  -- Already in the requested state AND stored canonically: nothing to do.
  IF v_old = p_enabled AND v_row.value = to_jsonb(p_enabled) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'enabled', v_old,
                              'awaiting_total', v_cash + v_layaway);
  END IF;

  PERFORM set_config('app.allow_web_reservation_mode_change', 'on', true);

  UPDATE public.system_settings
     SET value = to_jsonb(p_enabled),
         updated_by_user_id = v_uid,
         updated_at = v_now
   WHERE id = v_row.id;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_row.id, 'set_web_reservation_mode',
          jsonb_build_object('key', 'web_reservation_mode', 'value', v_row.value, 'enabled', v_old,
                             'updated_at', v_row.updated_at, 'updated_by_user_id', v_row.updated_by_user_id),
          jsonb_build_object('key', 'web_reservation_mode', 'value', to_jsonb(p_enabled), 'enabled', p_enabled,
                             'awaiting_cash', v_cash, 'awaiting_layaway', v_layaway),
          v_uid, v_now);

  PERFORM set_config('app.allow_web_reservation_mode_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'enabled', p_enabled, 'old_enabled', v_old,
                            'updated_at', v_now, 'awaiting_total', v_cash + v_layaway);
END
$$;

REVOKE ALL ON FUNCTION public.set_web_reservation_mode(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_web_reservation_mode(boolean, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_web_reservation_mode(boolean, boolean) IS
  'The ONLY writer of system_settings.web_reservation_mode (trg_guard_web_reservation_mode refuses every other write). Admin role only. Writes JSON true/false, stamps updated_by/at, one audit_logs row (entity_type system_setting, action set_web_reservation_mode, old -> new, user, time). p_expected = the state the caller saw; a mismatch returns {error:"stale"}. Unchanged -> {changed:false}, no write.';
