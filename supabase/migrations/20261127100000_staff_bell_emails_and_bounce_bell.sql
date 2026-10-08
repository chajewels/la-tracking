-- =============================================================================
-- STAFF BELL EMAILS (V11b) + EMAIL BOUNCE BELL (V13) — owner decisions 2026-10-08
-- =============================================================================
-- V11 (owner 18:21 JST): refund / dispute bells stay in the Hub for every
-- member; in addition an EMAIL goes to Brenda and every admin-role user for
-- the bell types listed in system_settings.staff_bell_email_types.
-- V13 (owner 18:19 JST, "refund received by whom? how do we know?"): the Hub
-- only knows that the provider accepted a send. A provider bounce / complaint
-- is already written to email_send_log by handle-email-suppression (status
-- 'bounced' / 'complained', template 'system') but nobody saw it. Now every
-- such row, and a 'suppressed' refund email, rings bell 'email_bounced', which
-- is itself on the email list, so Brenda learns the customer did NOT get it.
--
-- Mechanics
--   staff_bell_emails(bell_id, recipient)  one row per bell × recipient, written
--     by trg_staff_bell_email_fanout (AFTER INSERT on staff_notifications) when
--     the type is listed. Recipients are frozen at bell time (auditable).
--   staff_bell_email_recipients()  the configured addresses + the profile email
--     of every ACTIVE user holding a configured role (default: admin).
--   claim_staff_bell_emails / finish_staff_bell_email  the sender's two RPCs;
--     the edge function staff-bell-emails sends one internal email per row with
--     idempotency key staff-bell-<bell_id>-<recipient> (never twice).
--   Wake: the fan-out trigger POSTs to the edge function (Vault key, same as
--     email_queue_wake); the hourly cron 'staff-bell-emails-sweep' (:16) is the
--     fallback. 3 attempts, then status 'failed' (visible in Settings → Email
--     delivery via email_send_log as every other send).
--   set_staff_bell_emails(p_types, p_addresses, p_roles)  admin only, audited,
--     guard trigger refuses SQL edits of the two settings.
-- Nothing here emails a customer. All copy is English (internal).
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '3s';

-- 0. Preconditions (read-only; abort with nothing changed) ---------------------
DO $pre$
DECLARE v_missing text[] := ARRAY[]::text[];
BEGIN
  IF to_regclass('public.staff_notifications') IS NULL THEN v_missing := v_missing || 'staff_notifications'; END IF;
  IF to_regclass('public.email_send_log')      IS NULL THEN v_missing := v_missing || 'email_send_log'; END IF;
  IF to_regclass('public.system_settings')     IS NULL THEN v_missing := v_missing || 'system_settings'; END IF;
  IF to_regclass('public.profiles')            IS NULL THEN v_missing := v_missing || 'profiles'; END IF;
  IF to_regclass('public.user_roles')          IS NULL THEN v_missing := v_missing || 'user_roles'; END IF;
  IF to_regclass('public.audit_logs')          IS NULL THEN v_missing := v_missing || 'audit_logs'; END IF;
  IF to_regclass('cron.job')                   IS NULL THEN v_missing := v_missing || 'cron.job'; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'staff_bell_emails: missing %', array_to_string(v_missing, ', ');
  END IF;
END $pre$;

-- 1. Settings (seeded once; never overwritten by a re-run) --------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('staff_bell_email_types',
        '["card_refund_pending","card_dispute_deadline","card_refund_after_credit","refund_email_failed","email_bounced"]'::jsonb,
        'Bell types that are ALSO emailed to the staff bell email recipients. Changed only via set_staff_bell_emails (admin, audited).')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('staff_bell_email_recipients',
        '{"addresses":["bumagatbrenda@gmail.com"],"roles":["admin"]}'::jsonb,
        'Who receives staff bell emails: fixed addresses + the profile email of every active user holding one of the roles. Changed only via set_staff_bell_emails (admin, audited).')
ON CONFLICT (key) DO NOTHING;

-- 2. Guard: the two settings change only through the setter --------------------
CREATE OR REPLACE FUNCTION public.guard_staff_bell_emails()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key IN ('staff_bell_email_types','staff_bell_email_recipients')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('staff_bell_email_types','staff_bell_email_recipients')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_staff_bell_emails_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Staff bell emails are changed only from the Hub (set_staff_bell_emails).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_staff_bell_emails() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_staff_bell_emails ON public.system_settings;
CREATE TRIGGER trg_guard_staff_bell_emails
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_staff_bell_emails();

-- 3. Readers -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_bell_email_types()
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT coalesce(
    (SELECT array_agg(DISTINCT lower(btrim(x)))
       FROM public.system_settings s, jsonb_array_elements_text(s.value) AS t(x)
      WHERE s.key = 'staff_bell_email_types' AND jsonb_typeof(s.value) = 'array' AND btrim(x) <> ''),
    ARRAY[]::text[]);
$fn$;
REVOKE ALL ON FUNCTION public.staff_bell_email_types() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_bell_email_types() TO authenticated, service_role;

-- Recipients: configured addresses + active profiles holding a configured role.
-- Lower-cased, de-duplicated, never empty strings; at most 50.
CREATE OR REPLACE FUNCTION public.staff_bell_email_recipients()
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_cfg   jsonb;
  v_roles text[];
  v_out   text[];
BEGIN
  SELECT value INTO v_cfg FROM public.system_settings WHERE key = 'staff_bell_email_recipients';
  IF v_cfg IS NULL OR jsonb_typeof(v_cfg) <> 'object' THEN RETURN ARRAY[]::text[]; END IF;

  SELECT coalesce(array_agg(DISTINCT lower(btrim(x))) FILTER (WHERE btrim(x) <> ''), ARRAY[]::text[])
    INTO v_roles
    FROM jsonb_array_elements_text(coalesce(v_cfg->'roles', '[]'::jsonb)) AS t(x)
   WHERE jsonb_typeof(coalesce(v_cfg->'roles', '[]'::jsonb)) = 'array';

  SELECT coalesce(array_agg(DISTINCT e ORDER BY e), ARRAY[]::text[]) INTO v_out
    FROM (
      SELECT lower(btrim(x)) AS e
        FROM jsonb_array_elements_text(coalesce(v_cfg->'addresses', '[]'::jsonb)) AS t(x)
       WHERE jsonb_typeof(coalesce(v_cfg->'addresses', '[]'::jsonb)) = 'array'
      UNION
      SELECT lower(btrim(p.email))
        FROM public.profiles p
        JOIN public.user_roles ur ON ur.user_id = p.user_id
       WHERE p.status = 'active' AND p.email IS NOT NULL
         AND ur.role::text = ANY (v_roles)
    ) u
   WHERE e ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  RETURN v_out[1:50];
END
$fn$;
REVOKE ALL ON FUNCTION public.staff_bell_email_recipients() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_bell_email_recipients() TO authenticated, service_role;

-- 4. Setter: admin only, audited ----------------------------------------------
CREATE OR REPLACE FUNCTION public.set_staff_bell_emails(
  p_types jsonb DEFAULT NULL, p_addresses jsonb DEFAULT NULL, p_roles jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_types_row public.system_settings%ROWTYPE;
  v_rcpt_row  public.system_settings%ROWTYPE;
  v_new_types jsonb;
  v_new_rcpt  jsonb;
  v_entry text;
  v_clean text[] := ARRAY[]::text[];
  v_addr  text[] := ARRAY[]::text[];
  v_roles text[] := ARRAY[]::text[];
  v_now timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_types_row FROM public.system_settings WHERE key = 'staff_bell_email_types' FOR UPDATE;
  SELECT * INTO v_rcpt_row  FROM public.system_settings WHERE key = 'staff_bell_email_recipients' FOR UPDATE;
  IF v_types_row.id IS NULL OR v_rcpt_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;

  IF p_types IS NULL THEN
    v_new_types := v_types_row.value;
  ELSE
    IF jsonb_typeof(p_types) <> 'array' THEN RETURN jsonb_build_object('error', 'invalid_types'); END IF;
    FOR v_entry IN SELECT lower(btrim(x)) FROM jsonb_array_elements_text(p_types) AS t(x) LOOP
      CONTINUE WHEN v_entry = '';
      IF v_entry !~ '^[a-z0-9_]{1,64}$' THEN RETURN jsonb_build_object('error', 'invalid_type', 'entry', v_entry); END IF;
      IF NOT v_entry = ANY (v_clean) THEN v_clean := v_clean || v_entry; END IF;
    END LOOP;
    IF array_length(v_clean, 1) > 50 THEN RETURN jsonb_build_object('error', 'too_many_types'); END IF;
    v_new_types := to_jsonb(v_clean);
  END IF;

  IF p_addresses IS NULL AND p_roles IS NULL THEN
    v_new_rcpt := v_rcpt_row.value;
  ELSE
    IF p_addresses IS NULL THEN
      SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_addr
        FROM jsonb_array_elements_text(coalesce(v_rcpt_row.value->'addresses', '[]'::jsonb)) AS t(x);
    ELSE
      IF jsonb_typeof(p_addresses) <> 'array' THEN RETURN jsonb_build_object('error', 'invalid_addresses'); END IF;
      FOR v_entry IN SELECT lower(btrim(x)) FROM jsonb_array_elements_text(p_addresses) AS t(x) LOOP
        CONTINUE WHEN v_entry = '';
        IF v_entry !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
          RETURN jsonb_build_object('error', 'invalid_address', 'entry', v_entry);
        END IF;
        IF NOT v_entry = ANY (v_addr) THEN v_addr := v_addr || v_entry; END IF;
      END LOOP;
      IF array_length(v_addr, 1) > 20 THEN RETURN jsonb_build_object('error', 'too_many_addresses'); END IF;
    END IF;
    IF p_roles IS NULL THEN
      SELECT coalesce(array_agg(x), ARRAY[]::text[]) INTO v_roles
        FROM jsonb_array_elements_text(coalesce(v_rcpt_row.value->'roles', '[]'::jsonb)) AS t(x);
    ELSE
      IF jsonb_typeof(p_roles) <> 'array' THEN RETURN jsonb_build_object('error', 'invalid_roles'); END IF;
      FOR v_entry IN SELECT lower(btrim(x)) FROM jsonb_array_elements_text(p_roles) AS t(x) LOOP
        CONTINUE WHEN v_entry = '';
        IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
                        WHERE t.typname = 'app_role' AND e.enumlabel = v_entry) THEN
          RETURN jsonb_build_object('error', 'invalid_role', 'entry', v_entry);
        END IF;
        IF NOT v_entry = ANY (v_roles) THEN v_roles := v_roles || v_entry; END IF;
      END LOOP;
    END IF;
    v_new_rcpt := jsonb_build_object('addresses', to_jsonb(v_addr), 'roles', to_jsonb(v_roles));
  END IF;

  IF v_types_row.value IS NOT DISTINCT FROM v_new_types AND v_rcpt_row.value IS NOT DISTINCT FROM v_new_rcpt THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'types', v_new_types, 'recipients', v_new_rcpt);
  END IF;

  PERFORM set_config('app.allow_staff_bell_emails_change', 'on', true);
  UPDATE public.system_settings SET value = v_new_types, updated_at = v_now, updated_by_user_id = v_uid
   WHERE id = v_types_row.id AND value IS DISTINCT FROM v_new_types;
  UPDATE public.system_settings SET value = v_new_rcpt, updated_at = v_now, updated_by_user_id = v_uid
   WHERE id = v_rcpt_row.id AND value IS DISTINCT FROM v_new_rcpt;
  PERFORM set_config('app.allow_staff_bell_emails_change', 'off', true);

  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_types_row.id, 'set_staff_bell_emails',
          jsonb_build_object('types', v_types_row.value, 'recipients', v_rcpt_row.value),
          jsonb_build_object('types', v_new_types, 'recipients', v_new_rcpt),
          v_uid, v_now);
  RETURN jsonb_build_object('ok', true, 'changed', true, 'types', v_new_types, 'recipients', v_new_rcpt,
                            'resolved_recipients', to_jsonb(public.staff_bell_email_recipients()));
END
$fn$;
REVOKE ALL ON FUNCTION public.set_staff_bell_emails(jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_staff_bell_emails(jsonb, jsonb, jsonb) TO authenticated;

-- 5. The ledger ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_bell_emails (
  bell_id     uuid NOT NULL REFERENCES public.staff_notifications(id) ON DELETE CASCADE,
  recipient   text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped')),
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  PRIMARY KEY (bell_id, recipient)
);
CREATE INDEX IF NOT EXISTS idx_staff_bell_emails_pending ON public.staff_bell_emails (created_at) WHERE status IN ('pending','sending');
ALTER TABLE public.staff_bell_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_bell_emails_admin_read ON public.staff_bell_emails;
CREATE POLICY staff_bell_emails_admin_read ON public.staff_bell_emails
  FOR SELECT TO authenticated USING ((SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)));
REVOKE ALL ON public.staff_bell_emails FROM PUBLIC, anon;
GRANT SELECT ON public.staff_bell_emails TO authenticated;
GRANT ALL ON public.staff_bell_emails TO service_role;


-- 5b. Reader for the Hub card (any signed-in staff may look; only the setter writes)
CREATE OR REPLACE FUNCTION public.get_staff_bell_emails()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_types public.system_settings%ROWTYPE;
  v_rcpt  public.system_settings%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  SELECT * INTO v_types FROM public.system_settings WHERE key = 'staff_bell_email_types';
  SELECT * INTO v_rcpt  FROM public.system_settings WHERE key = 'staff_bell_email_recipients';
  IF v_types.id IS NULL OR v_rcpt.id IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN jsonb_build_object(
    'found', true,
    'types', to_jsonb(public.staff_bell_email_types()),
    'addresses', coalesce(v_rcpt.value->'addresses', '[]'::jsonb),
    'roles', coalesce(v_rcpt.value->'roles', '[]'::jsonb),
    'resolved_recipients', to_jsonb(public.staff_bell_email_recipients()),
    'can_change', public.has_role(v_uid, 'admin'::public.app_role),
    'updated_at', greatest(v_types.updated_at, v_rcpt.updated_at),
    'updated_by_name', (SELECT p.full_name FROM public.profiles p
                         WHERE p.user_id = CASE WHEN v_types.updated_at >= v_rcpt.updated_at THEN v_types.updated_by_user_id ELSE v_rcpt.updated_by_user_id END
                         LIMIT 1),
    'sent_7d', (SELECT count(*) FROM public.staff_bell_emails e WHERE e.status = 'sent' AND e.sent_at > now() - interval '7 days'),
    'pending', (SELECT count(*) FROM public.staff_bell_emails e WHERE e.status IN ('pending','sending')),
    'failed_7d', (SELECT count(*) FROM public.staff_bell_emails e WHERE e.status = 'failed' AND e.created_at > now() - interval '7 days'));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_staff_bell_emails() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_bell_emails() TO authenticated;

-- 6. Wake the sender (never fails the caller) ---------------------------------
CREATE OR REPLACE FUNCTION public.staff_bell_emails_wake()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $fn$
BEGIN
  BEGIN
    PERFORM net.http_post(
      url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/staff-bell-emails',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')),
      body := '{"action":"send"}'::jsonb);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'staff_bell_emails_wake: %', SQLERRM;
  END;
END
$fn$;
REVOKE ALL ON FUNCTION public.staff_bell_emails_wake() FROM PUBLIC, anon, authenticated;

-- 7. Fan-out trigger on staff_notifications -----------------------------------
CREATE OR REPLACE FUNCTION public.staff_bell_email_fanout()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_rcpt text[];
  v_n int := 0;
BEGIN
  BEGIN
    IF NEW.type IS NULL OR NOT (lower(NEW.type) = ANY (public.staff_bell_email_types())) THEN
      RETURN NEW;
    END IF;
    v_rcpt := public.staff_bell_email_recipients();
    IF v_rcpt IS NULL OR array_length(v_rcpt, 1) IS NULL THEN RETURN NEW; END IF;
    INSERT INTO public.staff_bell_emails (bell_id, recipient)
    SELECT NEW.id, r FROM unnest(v_rcpt) AS r
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN PERFORM public.staff_bell_emails_wake(); END IF;
  EXCEPTION WHEN OTHERS THEN
    -- A bell must never fail because its email fan-out did.
    RAISE WARNING 'staff_bell_email_fanout: %', SQLERRM;
  END;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.staff_bell_email_fanout() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_staff_bell_email_fanout ON public.staff_notifications;
CREATE TRIGGER trg_staff_bell_email_fanout
AFTER INSERT ON public.staff_notifications
FOR EACH ROW EXECUTE FUNCTION public.staff_bell_email_fanout();

-- 8. Sender RPCs (service role) -------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_staff_bell_emails(p_limit integer DEFAULT 20)
RETURNS TABLE (bell_id uuid, recipient text, attempts integer, bell_type text, title text, body text,
               invoice_number text, customer_id uuid, bell_created_at timestamptz, metadata jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN QUERY
  WITH c AS (
    SELECT e.bell_id, e.recipient
      FROM public.staff_bell_emails e
     WHERE (e.status = 'pending' OR (e.status = 'sending' AND e.claimed_at < now() - interval '10 minutes'))
       AND e.attempts < 3
     ORDER BY e.created_at
     LIMIT greatest(1, least(coalesce(p_limit, 20), 100))
     FOR UPDATE SKIP LOCKED
  ), u AS (
    UPDATE public.staff_bell_emails e
       SET status = 'sending', claimed_at = now(), attempts = e.attempts + 1
      FROM c WHERE e.bell_id = c.bell_id AND e.recipient = c.recipient
    RETURNING e.bell_id, e.recipient, e.attempts
  )
  SELECT u.bell_id, u.recipient, u.attempts, n.type, n.title, n.body, n.invoice_number, n.customer_id, n.created_at, n.metadata
    FROM u JOIN public.staff_notifications n ON n.id = u.bell_id;
END
$fn$;
REVOKE ALL ON FUNCTION public.claim_staff_bell_emails(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_staff_bell_emails(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_staff_bell_email(p_bell_id uuid, p_recipient text, p_outcome text, p_error text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_n int;
BEGIN
  IF p_outcome NOT IN ('sent','skipped','retry','failed') THEN RAISE EXCEPTION 'invalid outcome %', p_outcome; END IF;
  UPDATE public.staff_bell_emails e
     SET status = CASE p_outcome WHEN 'sent' THEN 'sent' WHEN 'skipped' THEN 'skipped'
                                 WHEN 'failed' THEN 'failed'
                                 ELSE CASE WHEN e.attempts >= 3 THEN 'failed' ELSE 'pending' END END,
         sent_at = CASE WHEN p_outcome = 'sent' THEN now() ELSE e.sent_at END,
         last_error = left(p_error, 500)
   WHERE e.bell_id = p_bell_id AND e.recipient = p_recipient AND e.status = 'sending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$fn$;
REVOKE ALL ON FUNCTION public.finish_staff_bell_email(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_staff_bell_email(uuid, text, text, text) TO service_role;

-- 9. V13: provider bounce / complaint → bell 'email_bounced' -----------------------
-- handle-email-suppression inserts the bounce row (template 'system', status
-- 'bounced' / 'complained', recipient = the address). Storefront senders do not
-- store the provider message id, so the bell lists the emails sent to that
-- address in the last 7 days (template + order reference) instead. A
-- 'suppressed' refund email (order-update-refund%) rings too: the customer will
-- not receive it. At most one bell per address per hour.
CREATE OR REPLACE FUNCTION public.email_bounce_bell()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_addr text;
  v_recent text;
  v_ref text;
  v_cust uuid;
  v_inv text;
  v_kind text;
BEGIN
  BEGIN
    IF NOT (NEW.status IN ('bounced','complained')
            OR (NEW.status = 'suppressed' AND NEW.template_name LIKE 'order-update-refund%')) THEN
      RETURN NEW;
    END IF;
    v_addr := lower(btrim(coalesce(NEW.recipient_email, '')));
    IF v_addr = '' THEN RETURN NEW; END IF;
    IF EXISTS (SELECT 1 FROM public.staff_notifications n
                WHERE n.type = 'email_bounced' AND n.created_at > now() - interval '1 hour'
                  AND lower(coalesce(n.metadata->>'recipient','')) = v_addr) THEN
      RETURN NEW;
    END IF;
    v_kind := CASE NEW.status WHEN 'bounced' THEN 'bounced' WHEN 'complained' THEN 'was reported as spam'
                              ELSE 'was not sent (address suppressed)' END;
    SELECT string_agg(l.template_name || coalesce(' ' || (l.metadata->>'reference'), '') ||
                      ' (' || to_char(l.created_at AT TIME ZONE 'Asia/Tokyo', 'MM-DD HH24:MI') || ' JST)', ', ' ORDER BY l.created_at DESC),
           max(l.metadata->>'reference')
      INTO v_recent, v_ref
      FROM (SELECT * FROM public.email_send_log l2
             WHERE lower(l2.recipient_email) = v_addr AND l2.status = 'sent'
               AND l2.created_at > now() - interval '7 days'
             ORDER BY l2.created_at DESC LIMIT 3) l;
    IF NEW.status = 'suppressed' THEN v_ref := coalesce(NEW.metadata->>'reference', v_ref); END IF;
    SELECT c.id INTO v_cust FROM public.customers c WHERE lower(c.email) = v_addr ORDER BY c.created_at LIMIT 1;
    IF v_ref IS NOT NULL THEN
      SELECT co.invoice_number INTO v_inv FROM public.cash_orders co WHERE co.web_reference = v_ref LIMIT 1;
      IF v_inv IS NULL THEN
        SELECT la.invoice_number INTO v_inv FROM public.layaway_accounts la WHERE la.web_reference = v_ref LIMIT 1;
      END IF;
    END IF;
    INSERT INTO public.staff_notifications (type, title, body, customer_id, invoice_number, metadata)
    VALUES ('email_bounced',
            'Customer email ' || v_kind,
            'An email to ' || v_addr || ' ' || v_kind || '. The customer did NOT receive it'
              || CASE WHEN NEW.status = 'suppressed' THEN ' (' || NEW.template_name || coalesce(' ' || v_ref, '') || ')' ELSE '' END
              || '. Recent emails to this address: ' || coalesce(v_recent, 'none in 7 days')
              || '. Contact the customer another way and check the address on the customer record.',
            v_cust, v_inv,
            jsonb_build_object('recipient', v_addr, 'status', NEW.status, 'template', NEW.template_name,
                               'reference', v_ref, 'send_log_id', NEW.id, 'provider_message_id', NEW.message_id));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'email_bounce_bell: %', SQLERRM;
  END;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION public.email_bounce_bell() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_email_bounce_bell ON public.email_send_log;
CREATE TRIGGER trg_email_bounce_bell
AFTER INSERT ON public.email_send_log
FOR EACH ROW EXECUTE FUNCTION public.email_bounce_bell();

-- 10. Hourly fallback sweep at :16 (free minute; Vault key at fire time) ------
SELECT cron.unschedule('staff-bell-emails-sweep')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'staff-bell-emails-sweep');
SELECT cron.schedule('staff-bell-emails-sweep', '16 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/staff-bell-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{"action":"send"}'::jsonb
  );
$cron$);

-- 11. Self-check --------------------------------------------------------------
DO $self$
BEGIN
  IF to_regclass('public.staff_bell_emails') IS NULL THEN RAISE EXCEPTION 'ledger missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_staff_bell_email_fanout') THEN RAISE EXCEPTION 'fanout trigger missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_email_bounce_bell') THEN RAISE EXCEPTION 'bounce trigger missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'staff-bell-emails-sweep') THEN RAISE EXCEPTION 'cron missing'; END IF;
  IF NOT ('card_refund_after_credit' = ANY (public.staff_bell_email_types())) THEN RAISE EXCEPTION 'types not seeded'; END IF;
END $self$;

COMMIT;
