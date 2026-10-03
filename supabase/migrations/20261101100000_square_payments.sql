-- ===========================================================================
-- Square card payments on a confirmed web order (S1, 2026-10-04).
-- docs/SQUARE.md. Owner decisions D0–D12 (claude/square-build-plan-v2-2026-10-03):
-- card only on a CONFIRMED yen cash order, authorise on pay → capture on
-- reviewer Confirm → void on Reject; 3-D Secure always; EVERY card payment
-- needs the recorded terms tick AND the e-signed Card Purchase Agreement (D9);
-- never on layaway; the Square fee is absorbed (no price factor) at launch.
--
-- This is the Paidy pattern (20261030100000_paidy_payments.sql) with a card
-- form instead of a Paidy window. What this adds:
--   1. square_payments — one row per Square authorisation on a cash order,
--      with the dispute evidence the Hub keeps (card brand / last 4 / 3DS /
--      terms tick / agreement version). Written by the service role only.
--   2. payment_submissions.square_payment_id — the submission an authorisation
--      backs; at most one LIVE submission per authorisation.
--   3. square_webhook_events — every webhook Square delivers, once (event id).
--   4. The switch rows: square_mode (off|test|on, fail-closed), square_app_id
--      and square_location_id (PUBLIC ids the website hands to the Web
--      Payments SDK; the ACCESS TOKEN and the webhook SIGNATURE KEY are edge
--      secrets and never in the database), card_agreement_min_jpy (0 = every
--      card payment needs the signed agreement; owner D9). All move ONLY
--      through set_square_settings (admin role, audited); a guard trigger
--      refuses every other write.
--
-- No existing function body is touched. Idempotent: safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. square_payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.square_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id        uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE RESTRICT,
  customer_id          uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  square_payment_id    text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'authorized'
                       CHECK (status IN ('authorized','captured','voided','rejected','expired','failed')),
  test                 boolean NOT NULL DEFAULT false,
  amount_jpy           numeric(12,2) NOT NULL CHECK (amount_jpy > 0),
  card_brand           text,
  card_last4           text CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
  three_ds_status      text,
  receipt_url          text,
  -- Dispute evidence (owner D9, 2026-10-03 23:59): the terms tick and the
  -- signed Card Purchase Agreement, as they were at the moment of payment.
  terms_accepted_at    timestamptz,
  terms_version        text,
  terms_ip             text,
  terms_user_agent     text,
  agreement_version    text,
  agreement_signed_at  timestamptz,
  authorized_at        timestamptz NOT NULL DEFAULT now(),
  capture_by           timestamptz,
  captured_at          timestamptz,
  voided_at            timestamptz,
  voided_reason        text,
  refund_jpy           numeric(12,2) NOT NULL DEFAULT 0,
  disputed_at          timestamptz,
  dispute_id           text,
  last_webhook_at      timestamptz,
  last_payload         jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_square_payments_order ON public.square_payments (cash_order_id, status);
COMMENT ON TABLE public.square_payments IS
  'One row per Square card authorisation on a cash order (docs/SQUARE.md). authorized (CreatePayment autocomplete:false; money held) → captured (reviewer Confirm → CompletePayment) | voided (reviewer Reject → CancelPayment; nothing charged) | rejected (Square declined) | expired (capture attempted after capture_by) | failed. Carries the dispute evidence (brand, last 4, 3DS, terms tick, agreement). Written by the service role only; never by SQL; refunds never by SQL.';

ALTER TABLE public.square_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS square_payments_staff_select ON public.square_payments;
CREATE POLICY square_payments_staff_select ON public.square_payments
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.square_payments FROM anon;
GRANT SELECT ON public.square_payments TO authenticated;
GRANT ALL ON public.square_payments TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The submission an authorisation backs.
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_submissions
  ADD COLUMN IF NOT EXISTS square_payment_id uuid REFERENCES public.square_payments(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_submissions_square_live
  ON public.payment_submissions (square_payment_id)
  WHERE square_payment_id IS NOT NULL AND status IN ('submitted','under_review','confirmed');
COMMENT ON COLUMN public.payment_submissions.square_payment_id IS
  'Set when the submission is a Square card authorisation (payment_method ''square''). Such a submission carries no proof file (same exception as Paidy, PD1): its proof is the payment the Hub read back from Square with the access token. Confirm captures it; Reject voids it.';

-- ---------------------------------------------------------------------------
-- 3. Webhook log — one row per Square event id, so a redelivery is a no-op.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.square_webhook_events (
  event_id      text PRIMARY KEY,
  event_type    text NOT NULL,
  payment_id    text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  outcome       text NOT NULL DEFAULT 'received',
  error         text,
  payload       jsonb
);
ALTER TABLE public.square_webhook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS square_webhook_events_staff_select ON public.square_webhook_events;
CREATE POLICY square_webhook_events_staff_select ON public.square_webhook_events
  FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))));
REVOKE ALL ON public.square_webhook_events FROM anon;
GRANT SELECT ON public.square_webhook_events TO authenticated;
GRANT ALL ON public.square_webhook_events TO service_role;
COMMENT ON TABLE public.square_webhook_events IS
  'Every webhook Square delivered (payment.updated, refund.*, dispute.*), keyed by Square''s event id. Written by square-webhook only. The Hub never trusts the body: it re-reads the payment from Square.';

-- ---------------------------------------------------------------------------
-- 4. The switch rows. Inserted only when absent; an existing value is NEVER
--    written here.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description) VALUES
 ('square_mode', '"off"'::jsonb,
  'Card payments (Square) on the website''s confirmed order page: "off" | "test" (only customers flagged is_test see it; Square SANDBOX ids and token) | "on" (every customer; production ids and token). Anything else reads as off. Changed only from Website → Settings → Card payments (set_square_settings; admin; audited). docs/SQUARE.md.'),
 ('square_app_id', '""'::jsonb,
  'Square Application ID (sandbox-sq0idb-… / sq0idp-…) the website hands to the Web Payments SDK. PUBLIC. The ACCESS TOKEN is never stored here — it is the SQUARE_ACCESS_TOKEN edge-function secret. Changed only via set_square_settings.'),
 ('square_location_id', '""'::jsonb,
  'Square Location ID of the Cha Jewels (Japan, JPY) location the website charges. PUBLIC. Changed only via set_square_settings.'),
 ('card_agreement_min_jpy', '0'::jsonb,
  'Card payments at or above this yen amount require the e-signed Card Purchase Agreement before the card form. 0 = EVERY card payment (owner decision 2026-10-03 23:59: "this is the document we need fighting disputes"). The recorded terms tick is required on every card payment regardless. Changed only via set_square_settings.')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Guard: the four values move only through set_square_settings.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_square_settings()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_square_settings_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Card payment (Square) settings are changed only from the Hub: Website → Settings → Card payments (set_square_settings).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_square_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_square_settings ON public.system_settings;
CREATE TRIGGER trg_guard_square_settings
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_square_settings();

-- ---------------------------------------------------------------------------
-- 6. Fail-closed reader.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.square_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN v IN ('test','on') THEN v ELSE 'off' END
    FROM (SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_mode') AS v) s
$fn$;
REVOKE ALL ON FUNCTION public.square_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.square_mode() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Read and write. Read: admin or admin_settings. Write: ADMIN ROLE only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_square_settings()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_name text;
  v_by   uuid;
  v_at   timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role) OR public.has_permission(v_uid, 'admin_settings')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  -- The most recent change among the four rows names the last editor.
  SELECT updated_by_user_id, updated_at INTO v_by, v_at
    FROM public.system_settings
   WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')
     AND updated_by_user_id IS NOT NULL
   ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  IF v_by IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found', (SELECT count(*) FROM public.system_settings
               WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')) = 4,
    'mode',                  public.square_mode(),
    'raw_mode',              (SELECT value FROM public.system_settings WHERE key = 'square_mode'),
    'app_id',                coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_app_id'), ''),
    'location_id',           coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'square_location_id'), ''),
    'agreement_min_jpy',     coalesce(((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'card_agreement_min_jpy'))::numeric, 0),
    'updated_at',            v_at,
    'updated_by_user_id',    v_by,
    'updated_by_name',       v_name,
    'can_change',            public.has_role(v_uid, 'admin'::public.app_role),
    'authorized_now',        (SELECT count(*) FROM public.square_payments WHERE status = 'authorized'),
    'captured_30d',          (SELECT count(*) FROM public.square_payments
                               WHERE status = 'captured' AND captured_at >= now() - interval '30 days'),
    'disputes_open',         (SELECT count(*) FROM public.square_payments WHERE disputed_at IS NOT NULL AND status = 'captured'));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_square_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_square_settings() TO authenticated, service_role;
COMMENT ON FUNCTION public.get_square_settings() IS
  'Card payments card (Website → Settings → Card payments). Admin or admin_settings. mode (fail-closed), app_id, location_id, agreement_min_jpy, last change, can_change (admin), authorized_now, captured_30d, disputes_open.';

CREATE OR REPLACE FUNCTION public.set_square_settings(
  p_mode text,
  p_app_id text DEFAULT NULL,
  p_location_id text DEFAULT NULL,
  p_agreement_min_jpy numeric DEFAULT NULL,
  p_expected_mode text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_mode_row  public.system_settings%ROWTYPE;
  v_app_row   public.system_settings%ROWTYPE;
  v_loc_row   public.system_settings%ROWTYPE;
  v_min_row   public.system_settings%ROWTYPE;
  v_old_mode  text;
  v_new_mode  text;
  v_new_app   text;
  v_new_loc   text;
  v_new_min   numeric;
  v_changed   boolean := false;
  v_now       timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_mode_row FROM public.system_settings WHERE key = 'square_mode' FOR UPDATE;
  SELECT * INTO v_app_row  FROM public.system_settings WHERE key = 'square_app_id' FOR UPDATE;
  SELECT * INTO v_loc_row  FROM public.system_settings WHERE key = 'square_location_id' FOR UPDATE;
  SELECT * INTO v_min_row  FROM public.system_settings WHERE key = 'card_agreement_min_jpy' FOR UPDATE;
  IF v_mode_row.id IS NULL OR v_app_row.id IS NULL OR v_loc_row.id IS NULL OR v_min_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'setting_missing');
  END IF;

  v_old_mode := public.square_mode();
  v_new_mode := coalesce(btrim(p_mode), v_old_mode);
  IF v_new_mode NOT IN ('off','test','on') THEN RETURN jsonb_build_object('error', 'invalid_mode'); END IF;
  IF p_expected_mode IS NOT NULL AND p_expected_mode IS DISTINCT FROM v_old_mode THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old_mode);
  END IF;

  v_new_app := CASE WHEN p_app_id IS NULL THEN coalesce(v_app_row.value #>> '{}', '') ELSE btrim(p_app_id) END;
  v_new_loc := CASE WHEN p_location_id IS NULL THEN coalesce(v_loc_row.value #>> '{}', '') ELSE btrim(p_location_id) END;
  v_new_min := coalesce(p_agreement_min_jpy, coalesce((v_min_row.value #>> '{}')::numeric, 0));

  -- Only PUBLIC ids are ever stored. An access token (EAAA…) or anything that
  -- is not an Application ID is refused, not saved.
  IF v_new_app <> '' AND v_new_app !~ '^(sandbox-sq0idb-|sq0idp-)[A-Za-z0-9_-]{6,}$' THEN
    RETURN jsonb_build_object('error', 'invalid_app_id');
  END IF;
  IF v_new_loc <> '' AND v_new_loc !~ '^[A-Z0-9]{8,}$' THEN
    RETURN jsonb_build_object('error', 'invalid_location_id');
  END IF;
  IF v_new_min < 0 OR v_new_min <> trunc(v_new_min) THEN
    RETURN jsonb_build_object('error', 'invalid_agreement_min');
  END IF;
  -- The id family must match the mode: test with a production id would take
  -- real money on a "test"; on with a sandbox id would charge nobody.
  IF v_new_mode = 'test' AND v_new_app !~ '^sandbox-sq0idb-' THEN RETURN jsonb_build_object('error', 'sandbox_app_id_required'); END IF;
  IF v_new_mode = 'on'   AND v_new_app !~ '^sq0idp-'         THEN RETURN jsonb_build_object('error', 'production_app_id_required'); END IF;
  IF v_new_mode <> 'off' AND v_new_loc = ''                   THEN RETURN jsonb_build_object('error', 'location_id_required'); END IF;

  PERFORM set_config('app.allow_square_settings_change', 'on', true);
  IF v_mode_row.value IS DISTINCT FROM to_jsonb(v_new_mode) THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_mode), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_mode_row.id;
    v_changed := true;
  END IF;
  IF coalesce(v_app_row.value #>> '{}', '') IS DISTINCT FROM v_new_app THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_app), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_app_row.id;
    v_changed := true;
  END IF;
  IF coalesce(v_loc_row.value #>> '{}', '') IS DISTINCT FROM v_new_loc THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_loc), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_loc_row.id;
    v_changed := true;
  END IF;
  IF coalesce((v_min_row.value #>> '{}')::numeric, 0) IS DISTINCT FROM v_new_min THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_min), updated_by_user_id = v_uid, updated_at = v_now WHERE id = v_min_row.id;
    v_changed := true;
  END IF;
  PERFORM set_config('app.allow_square_settings_change', '', true);

  IF NOT v_changed THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old_mode, 'app_id', v_new_app,
                              'location_id', v_new_loc, 'agreement_min_jpy', v_new_min);
  END IF;

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_mode_row.id, 'set_square_settings',
          jsonb_build_object('mode', v_old_mode, 'raw_mode', v_mode_row.value, 'app_id', v_app_row.value,
                             'location_id', v_loc_row.value, 'agreement_min_jpy', v_min_row.value,
                             'updated_at', v_mode_row.updated_at, 'updated_by_user_id', v_mode_row.updated_by_user_id),
          jsonb_build_object('mode', v_new_mode, 'app_id', v_new_app, 'location_id', v_new_loc,
                             'agreement_min_jpy', v_new_min),
          v_uid, v_now);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', v_new_mode, 'old_mode', v_old_mode,
                            'app_id', v_new_app, 'location_id', v_new_loc, 'agreement_min_jpy', v_new_min,
                            'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_square_settings(text, text, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_square_settings(text, text, text, numeric, text) TO authenticated;
COMMENT ON FUNCTION public.set_square_settings(text, text, text, numeric, text) IS
  'The ONLY writer of square_mode, square_app_id, square_location_id and card_agreement_min_jpy (trg_guard_square_settings refuses every other write). Admin role only. Mode off|test|on; test needs a sandbox-sq0idb- app id, on needs a sq0idp- app id, both need a location id; an access token is refused. One audit_logs row (system_setting / set_square_settings). p_expected_mode = the mode the caller saw; a mismatch returns {error:"stale"}.';

-- ---------------------------------------------------------------------------
-- 8. Self-checks.
-- ---------------------------------------------------------------------------
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_square_settings') THEN
    RAISE EXCEPTION 'square: guard trigger missing';
  END IF;
  IF public.square_mode() NOT IN ('off','test','on') THEN
    RAISE EXCEPTION 'square: mode reader is not fail-closed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'payment_submissions' AND column_name = 'square_payment_id') THEN
    RAISE EXCEPTION 'square: payment_submissions.square_payment_id missing';
  END IF;
  IF has_function_privilege('anon', 'public.set_square_settings(text, text, text, numeric, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'square: anon can execute set_square_settings';
  END IF;
  IF (SELECT count(*) FROM public.system_settings
       WHERE key IN ('square_mode','square_app_id','square_location_id','card_agreement_min_jpy')) <> 4 THEN
    RAISE EXCEPTION 'square: settings rows missing';
  END IF;
END
$chk$;
