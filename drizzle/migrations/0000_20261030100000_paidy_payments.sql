-- ===========================================================================
-- Paidy 『あと払い（ペイディ）』 on a confirmed web order (2026-10-03).
-- docs/PAIDY.md. Owner decisions PD1–PD4 (claude/paidy-build-plan-2026-10-03).
--
-- What this adds:
--   1. paidy_payments — one row per Paidy authorisation taken on a cash order
--      (authorised on the order page, captured on reviewer Confirm, closed on
--      Reject). Written by the service role only (website / review-payment-
--      submission / paidy-webhook edge functions); staff read it.
--   2. payment_submissions.paidy_payment_id — the submission a Paidy
--      authorisation backs. At most one LIVE submission per authorisation.
--   3. The switch: system_settings.paidy_mode ("off" | "test" | "on", fail-
--      closed) and paidy_public_key (the PUBLIC key only; the secret key is an
--      edge-function secret and never in the database). Both move ONLY through
--      set_paidy_settings (admin role, audited); a guard trigger refuses every
--      other write, like web_payment_reminders.
--
-- No existing function body is touched. Idempotent: safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. paidy_payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.paidy_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id     uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  customer_id       uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  paidy_payment_id  text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'authorized'
                    CHECK (status IN ('authorized','captured','closed','rejected','expired')),
  test              boolean NOT NULL DEFAULT false,
  amount_jpy        numeric(12,2) NOT NULL CHECK (amount_jpy > 0),
  authorized_at     timestamptz NOT NULL DEFAULT now(),
  captured_at       timestamptz,
  capture_id        text,
  closed_at         timestamptz,
  closed_reason     text,
  refund_jpy        numeric(12,2) NOT NULL DEFAULT 0,
  last_webhook_at   timestamptz,
  last_payload      jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_paidy_payments_order ON public.paidy_payments (cash_order_id, status);
COMMENT ON TABLE public.paidy_payments IS
  'One row per Paidy authorisation on a cash order (docs/PAIDY.md). authorized (customer finished Paidy''s window; money reserved for 30 days) → captured (reviewer Confirm; money taken) | closed (reviewer Reject, or a mismatch; nothing charged) | rejected (Paidy declined) | expired (capture attempted after the 30 days). Written by the service role only; never by SQL, never refunded by SQL.';

ALTER TABLE public.paidy_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paidy_payments_staff_select ON public.paidy_payments;
CREATE POLICY paidy_payments_staff_select ON public.paidy_payments
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.paidy_payments FROM anon;
GRANT SELECT ON public.paidy_payments TO authenticated;
GRANT ALL ON public.paidy_payments TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The submission a Paidy authorisation backs.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_submissions
  ADD COLUMN IF NOT EXISTS paidy_payment_id uuid REFERENCES public.paidy_payments(id) ON DELETE SET NULL;
-- One live submission per authorisation: a second submit while the first is
-- still being reviewed is refused by the index, not by a race.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_submissions_paidy_live
  ON public.payment_submissions (paidy_payment_id)
  WHERE paidy_payment_id IS NOT NULL AND status IN ('submitted','under_review','confirmed');
COMMENT ON COLUMN public.payment_submissions.paidy_payment_id IS
  'Set when the submission is a Paidy authorisation (payment_method ''paidy''). Such a submission carries no proof file (owner decision PD1, 2026-10-03): its proof is the authorisation the Hub read back from Paidy with the secret key. Confirm captures it; Reject closes it.';

-- ---------------------------------------------------------------------------
-- 3. The switch rows. Inserted only when absent; an existing value is NEVER
--    written here.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('paidy_mode', '"off"'::jsonb,
        'Paidy on the website''s confirmed order page: "off" | "test" (only customers flagged is_test see it; Paidy test keys) | "on" (every customer with a Japanese delivery address; live keys). Anything else reads as off. Changed only from Website → Settings → Paidy (set_paidy_settings; admin; audited). docs/PAIDY.md.')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('paidy_public_key', '""'::jsonb,
        'Paidy PUBLIC key (pk_test_… / pk_live_…) handed to the website for Paidy Checkout. The SECRET key is never stored here — it is the PAIDY_SECRET_KEY edge-function secret. Changed only from Website → Settings → Paidy (set_paidy_settings; admin; audited).')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Guard: both values move only through set_paidy_settings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_paidy_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key IN ('paidy_mode','paidy_public_key')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('paidy_mode','paidy_public_key')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_paidy_settings_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Paidy settings are changed only from the Hub: Website → Settings → Paidy (set_paidy_settings).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_paidy_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_paidy_settings ON public.system_settings;
CREATE TRIGGER trg_guard_paidy_settings
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_paidy_settings();

-- ---------------------------------------------------------------------------
-- 5. Fail-closed reader. Anything but the two exact strings is 'off'.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.paidy_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN v IN ('test','on') THEN v ELSE 'off' END
    FROM (SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'paidy_mode') AS v) s
$fn$;
REVOKE ALL ON FUNCTION public.paidy_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.paidy_mode() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Read and write the switch. Read: admin or admin_settings. Write: ADMIN
--    ROLE only — no override can grant it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_paidy_settings()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_mode public.system_settings%ROWTYPE;
  v_key  public.system_settings%ROWTYPE;
  v_name text;
  v_by   uuid;
  v_at   timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role) OR public.has_permission(v_uid, 'admin_settings')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_mode FROM public.system_settings WHERE key = 'paidy_mode';
  SELECT * INTO v_key  FROM public.system_settings WHERE key = 'paidy_public_key';
  IF v_key.updated_at IS NOT NULL AND (v_mode.updated_at IS NULL OR v_key.updated_at > v_mode.updated_at)
     AND v_key.updated_by_user_id IS NOT NULL THEN
    v_by := v_key.updated_by_user_id; v_at := v_key.updated_at;
  ELSE
    v_by := v_mode.updated_by_user_id; v_at := v_mode.updated_at;
  END IF;
  IF v_by IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found',              v_mode.id IS NOT NULL AND v_key.id IS NOT NULL,
    'mode',               public.paidy_mode(),
    'raw_mode',           v_mode.value,
    'public_key',         coalesce(v_key.value #>> '{}', ''),
    'updated_at',         v_at,
    'updated_by_user_id', v_by,
    'updated_by_name',    v_name,
    'can_change',         public.has_role(v_uid, 'admin'::public.app_role),
    'authorized_now',     (SELECT count(*) FROM public.paidy_payments WHERE status = 'authorized'),
    'captured_30d',       (SELECT count(*) FROM public.paidy_payments
                            WHERE status = 'captured' AND captured_at >= now() - interval '30 days'));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_paidy_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_paidy_settings() TO authenticated, service_role;
COMMENT ON FUNCTION public.get_paidy_settings() IS
  'Paidy card (Website → Settings → Paidy). Admin or admin_settings. mode (fail-closed), public_key, last change, can_change (admin), authorized_now, captured_30d.';

CREATE OR REPLACE FUNCTION public.set_paidy_settings(
  p_mode text, p_public_key text DEFAULT NULL, p_expected_mode text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_mode_row public.system_settings%ROWTYPE;
  v_key_row  public.system_settings%ROWTYPE;
  v_old_mode text;
  v_new_mode text;
  v_new_key  text;
  v_mode_changed boolean;
  v_key_changed  boolean;
  v_now      timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_mode_row FROM public.system_settings WHERE key = 'paidy_mode' FOR UPDATE;
  SELECT * INTO v_key_row  FROM public.system_settings WHERE key = 'paidy_public_key' FOR UPDATE;
  IF v_mode_row.id IS NULL OR v_key_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;

  v_old_mode := public.paidy_mode();
  v_new_mode := coalesce(btrim(p_mode), v_old_mode);
  IF v_new_mode NOT IN ('off','test','on') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;
  IF p_expected_mode IS NOT NULL AND p_expected_mode IS DISTINCT FROM v_old_mode THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old_mode);
  END IF;

  v_new_key := CASE WHEN p_public_key IS NULL THEN coalesce(v_key_row.value #>> '{}', '') ELSE btrim(p_public_key) END;
  -- Only a PUBLIC key is ever stored. A secret key pasted here by mistake is
  -- refused, not saved.
  IF v_new_key <> '' AND v_new_key !~ '^pk_(test|live)_[A-Za-z0-9]{8,}$' THEN
    RETURN jsonb_build_object('error', 'invalid_public_key');
  END IF;
  -- The key family must match the mode: test mode with a live key would charge
  -- real money on a "test"; live mode with a test key would charge nobody.
  IF v_new_mode = 'test' AND v_new_key !~ '^pk_test_' THEN RETURN jsonb_build_object('error', 'test_key_required'); END IF;
  IF v_new_mode = 'on'   AND v_new_key !~ '^pk_live_' THEN RETURN jsonb_build_object('error', 'live_key_required'); END IF;

  v_mode_changed := v_mode_row.value IS DISTINCT FROM to_jsonb(v_new_mode);
  v_key_changed  := coalesce(v_key_row.value #>> '{}', '') IS DISTINCT FROM v_new_key;
  IF NOT v_mode_changed AND NOT v_key_changed THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old_mode, 'public_key', v_new_key);
  END IF;

  PERFORM set_config('app.allow_paidy_settings_change', 'on', true);
  IF v_mode_changed THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_mode), updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_mode_row.id;
  END IF;
  IF v_key_changed THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_key), updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_key_row.id;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_mode_row.id, 'set_paidy_settings',
          jsonb_build_object('mode', v_old_mode, 'raw_mode', v_mode_row.value, 'public_key', v_key_row.value,
                             'updated_at', v_mode_row.updated_at, 'updated_by_user_id', v_mode_row.updated_by_user_id),
          jsonb_build_object('mode', v_new_mode, 'public_key', v_new_key,
                             'mode_changed', v_mode_changed, 'public_key_changed', v_key_changed),
          v_uid, v_now);
  PERFORM set_config('app.allow_paidy_settings_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', v_new_mode, 'old_mode', v_old_mode,
                            'public_key', v_new_key, 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_paidy_settings(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_paidy_settings(text, text, text) TO authenticated;
COMMENT ON FUNCTION public.set_paidy_settings(text, text, text) IS
  'The ONLY writer of system_settings.paidy_mode and paidy_public_key (trg_guard_paidy_settings refuses every other write). Admin role only. Mode off|test|on; the key must be a pk_test_ key for test and a pk_live_ key for on; a secret key is refused. One audit_logs row (system_setting / set_paidy_settings, old -> new). p_expected_mode = the mode the caller saw; a mismatch returns {error:"stale"}.';

-- ---------------------------------------------------------------------------
-- 7. Self-checks.
-- ---------------------------------------------------------------------------
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_paidy_settings') THEN
    RAISE EXCEPTION 'paidy: guard trigger missing';
  END IF;
  IF public.paidy_mode() NOT IN ('off','test','on') THEN
    RAISE EXCEPTION 'paidy: mode reader is not fail-closed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'payment_submissions' AND column_name = 'paidy_payment_id') THEN
    RAISE EXCEPTION 'paidy: payment_submissions.paidy_payment_id missing';
  END IF;
  IF has_function_privilege('anon', 'public.set_paidy_settings(text, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'paidy: anon can execute set_paidy_settings';
  END IF;
END
$chk$;