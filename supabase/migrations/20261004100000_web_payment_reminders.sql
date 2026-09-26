-- ===========================================================================
-- web_payment_reminders — ONE transactional reminder before a confirmed web
-- order's / web layaway's payment deadline (stage D), plus a staff "last day"
-- bell for web reservations still unconfirmed after 48 hours (stage C).
--
-- Plan: ~/Code/reference/abandoned-cart-investigation.md revision 2, §2j/§2k/
-- §3b′ (owner-approved D12–D18). Rules: docs/WEB-PAYMENT-REMINDERS.md.
--
-- OWNER RUNS THIS in the SQL Editor, as-is, AFTER the release PR is on main
-- AND web-payment-reminder-sweep is deployed (the cron job below calls it;
-- before the deploy every tick is answered 404 and nothing happens). One
-- transaction. SENDS NOTHING: the switch is seeded 'off' and the self-check
-- aborts the whole file if it is anything else.
--
-- What it does:
--
--   A. THE LEDGER. web_payment_reminders — one row per reminder, CLAIMED
--      before the send (UNIQUE entity + deadline), never retried. Staff read
--      it; only the service-role functions below write it.
--
--   B. THE SWITCH, two system_settings rows, guarded and audited exactly the
--      way web_reservation_mode is (20260924120000):
--        web_payment_reminders_mode             "off" | "owner_only" | "on"
--                                               (anything else reads OFF)
--        web_payment_reminders_owner_addresses  JSON array; an entry is a full
--                                               address or "@domain"
--      get_web_payment_reminders()          read  (admin or admin_settings)
--      set_web_payment_reminders(...)       write (ADMIN ROLE only), one
--                                           audit_logs row per change
--      trg_guard_web_payment_reminders      refuses every other write
--      Seeded "off" and [chajewelsjapan@gmail.com, @chajewelsjp.com] — the
--      same owner-readable addresses sendStorefrontEmail's test gate allows.
--      An existing row is NEVER written here.
--
--   C. ELIGIBILITY, one SQL function shared by the candidate read and the
--      claim's re-check under a row lock, so the two can never disagree:
--        web orders only (source_channel = 'web'), staff-confirmed
--        (ready_confirmed_at set), deadline set, not paid:
--          cash    status pending, payment_status pending_transfer,
--                  remaining_balance > 0          → amount = remaining_balance
--          layaway status active, total_paid = 0  → amount = downpayment_amount
--        NO payment submission 'submitted'/'under_review' (INVARIANT 12's
--        predicate; for a layaway also through payment_submission_allocations)
--        deadline more than 1 hour away and inside its window:
--          deadline − ready_confirmed_at ≤ 30h (the 24h first-order kind)
--            → when ≤ 6h remain; otherwise (72h, or a moved deadline)
--            → when ≤ 24h remain
--        not already reminded for THIS deadline; fewer than 2 reminders for
--        the order in total
--        a test customer only at an owner-readable address (the storefront
--        test gate, repeated here so a test order never takes a claim)
--      It reads NO consent, newsletter, cart-reminder or suppression row: it
--      is the customer's own order (transactional).
--      No quiet hours: a deadline is the customer's, and the reminder is sent
--      the first hourly run inside the window.
--
--   D. THE SCHEDULE. Two pg_cron jobs at :13 (free — CLAUDE.md cron table):
--        web-payment-reminder-sweep       POSTs to the edge function
--                                         (Vault-backed key, CRON AUTH RULE)
--        web-reservation-expiring-bell    pure SQL: web_reservation_expiring_
--                                         bells() — one bell per reservation
--                                         unconfirmed 48–72h, WHATEVER the
--                                         switch says (staff-only, no email)
--
--   E. EMAIL HISTORY. get_order_email_history(type, id) — every storefront
--      email logged for the order's reference plus its reminder rows, for the
--      Hub's order pages (staff only). Adds an expression index on
--      email_send_log (metadata->>'reference').
--
-- FUNCTION CHANGES START FROM LIVE (CLAUDE.md, Bug #280). This file redefines
-- NO existing function: every function below is new, and the pre-flight
-- aborts if any of those names already exists with another signature. It
-- CALLS three live helpers, checked by signature: is_staff(uuid),
-- has_role(uuid, app_role), has_permission(uuid, text).
--
-- Guards: every dependency is checked first; the whole transaction aborts with
-- NOTHING changed if live is not what this was written against. Re-running
-- the file is safe (IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT DO NOTHING;
-- cron jobs are replaced by name; the switch values are never written).
-- ===========================================================================
BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_missing text[] := ARRAY[]::text[];
  v_cols    text[];
  v_got     text;
BEGIN
  IF to_regclass('public.cash_orders')                     IS NULL THEN v_missing := v_missing || 'cash_orders'::text; END IF;
  IF to_regclass('public.layaway_accounts')                IS NULL THEN v_missing := v_missing || 'layaway_accounts'::text; END IF;
  IF to_regclass('public.customers')                       IS NULL THEN v_missing := v_missing || 'customers'::text; END IF;
  IF to_regclass('public.payment_submissions')             IS NULL THEN v_missing := v_missing || 'payment_submissions'::text; END IF;
  IF to_regclass('public.payment_submission_allocations')  IS NULL THEN v_missing := v_missing || 'payment_submission_allocations'::text; END IF;
  IF to_regclass('public.system_settings')                 IS NULL THEN v_missing := v_missing || 'system_settings'::text; END IF;
  IF to_regclass('public.staff_notifications')             IS NULL THEN v_missing := v_missing || 'staff_notifications'::text; END IF;
  IF to_regclass('public.audit_logs')                      IS NULL THEN v_missing := v_missing || 'audit_logs'::text; END IF;
  IF to_regclass('public.profiles')                        IS NULL THEN v_missing := v_missing || 'profiles'::text; END IF;
  IF to_regclass('public.email_send_log')                  IS NULL THEN v_missing := v_missing || 'email_send_log'::text; END IF;
  IF to_regclass('cron.job')                               IS NULL THEN v_missing := v_missing || 'cron.job (pg_cron)'::text; END IF;
  IF to_regclass('vault.secrets')                          IS NULL THEN v_missing := v_missing || 'vault.secrets (Supabase Vault)'::text; END IF;
  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'web_payment_reminders: missing: %', array_to_string(v_missing, ', ');
  END IF;

  SELECT array_agg(c.table_name || '.' || c.column_name) INTO v_cols
    FROM (VALUES
      ('cash_orders','id'), ('cash_orders','customer_id'), ('cash_orders','source_channel'), ('cash_orders','status'),
      ('cash_orders','payment_status'), ('cash_orders','ready_confirmed_at'), ('cash_orders','transfer_due_at'),
      ('cash_orders','remaining_balance'), ('cash_orders','customer_lang'), ('cash_orders','currency'),
      ('cash_orders','web_reference'), ('cash_orders','invoice_number'), ('cash_orders','created_at'),
      ('layaway_accounts','id'), ('layaway_accounts','customer_id'), ('layaway_accounts','source_channel'),
      ('layaway_accounts','status'), ('layaway_accounts','ready_confirmed_at'), ('layaway_accounts','transfer_due_at'),
      ('layaway_accounts','total_paid'), ('layaway_accounts','downpayment_amount'), ('layaway_accounts','currency'),
      ('layaway_accounts','web_reference'), ('layaway_accounts','invoice_number'), ('layaway_accounts','created_at'),
      ('customers','id'), ('customers','email'), ('customers','is_test'),
      ('payment_submissions','id'), ('payment_submissions','account_id'), ('payment_submissions','cash_order_id'),
      ('payment_submissions','status'),
      ('payment_submission_allocations','submission_id'), ('payment_submission_allocations','account_id'),
      ('system_settings','id'), ('system_settings','key'), ('system_settings','value'), ('system_settings','description'),
      ('system_settings','updated_by_user_id'), ('system_settings','updated_at'),
      ('staff_notifications','type'), ('staff_notifications','title'), ('staff_notifications','body'),
      ('staff_notifications','account_id'), ('staff_notifications','customer_id'), ('staff_notifications','invoice_number'),
      ('staff_notifications','metadata'),
      ('audit_logs','entity_type'), ('audit_logs','entity_id'), ('audit_logs','action'), ('audit_logs','old_value_json'),
      ('audit_logs','new_value_json'), ('audit_logs','performed_by_user_id'),
      ('profiles','user_id'), ('profiles','full_name'),
      ('email_send_log','created_at'), ('email_send_log','template_name'), ('email_send_log','recipient_email'),
      ('email_send_log','status'), ('email_send_log','channel'), ('email_send_log','metadata'),
      ('email_send_log','error_message')
    ) AS c(table_name, column_name)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_schema = 'public' AND ic.table_name = c.table_name AND ic.column_name = c.column_name);
  IF v_cols IS NOT NULL THEN
    RAISE EXCEPTION 'web_payment_reminders: missing column(s) — reserve-first A1 must be live: %', array_to_string(v_cols, ', ');
  END IF;

  IF to_regprocedure('public.is_staff(uuid)') IS NULL THEN
    RAISE EXCEPTION 'web_payment_reminders: public.is_staff(uuid) missing';
  END IF;
  IF to_regprocedure('public.has_role(uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'web_payment_reminders: public.has_role(uuid, app_role) missing';
  END IF;
  IF to_regprocedure('public.has_permission(uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'web_payment_reminders: public.has_permission(uuid,text) missing';
  END IF;
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL OR to_regprocedure('cron.unschedule(text)') IS NULL THEN
    RAISE EXCEPTION 'web_payment_reminders: pg_cron (cron.schedule / cron.unschedule) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'net' AND p.proname = 'http_post') THEN
    RAISE EXCEPTION 'web_payment_reminders: net.http_post (pg_net) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
    RAISE EXCEPTION 'web_payment_reminders: Vault secret email_queue_service_role_key missing — do not create a second key';
  END IF;

  -- An existing switch must already hold a value this file understands; the
  -- file never rewrites it, so a bad value would survive and read as OFF.
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'web_payment_reminders_mode'
               AND coalesce(value #>> '{}', '') NOT IN ('off','owner_only','on')) THEN
    RAISE EXCEPTION 'web_payment_reminders: system_settings.web_payment_reminders_mode exists but is not off/owner_only/on';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'web_payment_reminders_owner_addresses'
               AND jsonb_typeof(value) <> 'array') THEN
    RAISE EXCEPTION 'web_payment_reminders: system_settings.web_payment_reminders_owner_addresses exists but is not a JSON array';
  END IF;

  -- Name collisions: the new functions must not exist with another signature.
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ') INTO v_got
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND ((p.proname = 'web_payment_reminder_mode'            AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'web_payment_reminder_address_allowed' AND pg_get_function_identity_arguments(p.oid) <> 'p_email text')
       OR (p.proname = 'web_payment_reminder_eligible'        AND pg_get_function_identity_arguments(p.oid) <> 'p_entity_type text, p_entity_id uuid')
       OR (p.proname = 'web_payment_reminder_candidates'      AND pg_get_function_identity_arguments(p.oid) <> 'p_limit integer')
       OR (p.proname = 'claim_web_payment_reminder'           AND pg_get_function_identity_arguments(p.oid) <> 'p_entity_type text, p_entity_id uuid, p_deadline timestamp with time zone')
       OR (p.proname = 'finish_web_payment_reminder'          AND pg_get_function_identity_arguments(p.oid) <> 'p_id uuid, p_status text, p_detail text')
       OR (p.proname = 'web_reservation_expiring_bells'       AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'get_web_payment_reminders'            AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'set_web_payment_reminders'            AND pg_get_function_identity_arguments(p.oid) <> 'p_mode text, p_owner_addresses jsonb, p_expected_mode text')
       OR (p.proname = 'guard_web_payment_reminders'          AND pg_get_function_identity_arguments(p.oid) <> '')
       OR (p.proname = 'get_order_email_history'              AND pg_get_function_identity_arguments(p.oid) <> 'p_entity_type text, p_entity_id uuid'));
  IF v_got IS NOT NULL THEN
    RAISE EXCEPTION 'web_payment_reminders: function(s) already exist with another signature: %', v_got;
  END IF;

  -- Remember the switch as found; the self-check proves this file left it alone.
  PERFORM set_config('payrem.mode_before',
                     coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'web_payment_reminders_mode'), 'absent'),
                     true);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. The ledger. One row per reminder, claimed before the send.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.web_payment_reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('cash_order','layaway')),
  entity_id   uuid NOT NULL,
  deadline    timestamptz NOT NULL,
  reference   text,
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  email       text NOT NULL,
  lang        text NOT NULL CHECK (lang IN ('ja','en')),
  currency    text NOT NULL CHECK (currency IN ('JPY','PHP')),
  amount      numeric(12,2) NOT NULL,
  status      text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','sent','skipped','failed','suppressed')),
  detail      text,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT web_payment_reminders_once_per_deadline UNIQUE (entity_type, entity_id, deadline)
);
CREATE INDEX IF NOT EXISTS idx_web_payment_reminders_entity ON public.web_payment_reminders (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_web_payment_reminders_claimed ON public.web_payment_reminders (claimed_at DESC);
COMMENT ON TABLE public.web_payment_reminders IS
  'Stage D payment reminders (docs/WEB-PAYMENT-REMINDERS.md): one row per reminder sent before a confirmed web order''s / web layaway''s transfer deadline. Claimed before the send (UNIQUE entity + deadline); at most 2 rows per order; never retried. Transactional — reads no marketing consent. Written only by claim_/finish_web_payment_reminder (service role).';
COMMENT ON COLUMN public.web_payment_reminders.lang IS 'Language the email went out in: a cash order''s customer_lang (ja → Japanese then English; en → English); a layaway is always en.';
COMMENT ON COLUMN public.web_payment_reminders.amount IS 'What the email asked for, in currency: a cash order''s remaining_balance, or a layaway''s downpayment_amount. Captured under the claim''s row lock.';

ALTER TABLE public.web_payment_reminders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_payment_reminders FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.web_payment_reminders TO authenticated;
GRANT ALL ON public.web_payment_reminders TO service_role;
DROP POLICY IF EXISTS web_payment_reminders_staff_select ON public.web_payment_reminders;
CREATE POLICY web_payment_reminders_staff_select ON public.web_payment_reminders
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

-- The order pages read every storefront email for a reference.
CREATE INDEX IF NOT EXISTS idx_email_send_log_reference ON public.email_send_log ((metadata ->> 'reference'));

-- ---------------------------------------------------------------------------
-- 2. The switch rows. Inserted only when absent; an existing value is NEVER
--    written here.
-- ---------------------------------------------------------------------------
INSERT INTO public.system_settings (key, value, description)
VALUES ('web_payment_reminders_mode', '"off"'::jsonb,
        'Stage D payment reminder before a confirmed web order''s deadline: "off" | "owner_only" (only the addresses in web_payment_reminders_owner_addresses) | "on" (every customer). Anything else reads as off. Changed only from Hub → Settings → General → Payment reminders (set_web_payment_reminders; admin; audited). docs/WEB-PAYMENT-REMINDERS.md.')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('web_payment_reminders_owner_addresses', '["chajewelsjapan@gmail.com", "@chajewelsjp.com"]'::jsonb,
        'Who may receive a payment reminder while web_payment_reminders_mode is "owner_only": full addresses, or "@domain" for a whole domain. Changed only from Hub → Settings → General → Payment reminders (set_web_payment_reminders; admin; audited).')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Guard: both values move only through set_web_payment_reminders.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_web_payment_reminders()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF (OLD.key IN ('web_payment_reminders_mode','web_payment_reminders_owner_addresses')
      AND (TG_OP = 'DELETE' OR NEW.key IS DISTINCT FROM OLD.key OR NEW.value IS DISTINCT FROM OLD.value))
     OR (TG_OP = 'UPDATE' AND NEW.key IN ('web_payment_reminders_mode','web_payment_reminders_owner_addresses')
         AND OLD.key IS DISTINCT FROM NEW.key)
  THEN
    IF coalesce(current_setting('app.allow_web_payment_reminders_change', true), '') <> 'on' THEN
      RAISE EXCEPTION 'Payment reminders are changed only from the Hub: Settings → General → Payment reminders (set_web_payment_reminders).'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;
REVOKE ALL ON FUNCTION public.guard_web_payment_reminders() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_web_payment_reminders ON public.system_settings;
CREATE TRIGGER trg_guard_web_payment_reminders
BEFORE UPDATE OR DELETE ON public.system_settings
FOR EACH ROW EXECUTE FUNCTION public.guard_web_payment_reminders();

-- ---------------------------------------------------------------------------
-- 4. Mode and recipient rule. Fail-closed: anything but the two exact strings
--    is 'off'. An owner entry is a full address or "@domain".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.web_payment_reminder_mode()
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN v IN ('owner_only','on') THEN v ELSE 'off' END
    FROM (SELECT (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'web_payment_reminders_mode') AS v) s
$fn$;

CREATE OR REPLACE FUNCTION public.web_payment_reminder_address_allowed(p_email text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT CASE public.web_payment_reminder_mode()
    WHEN 'on' THEN true
    WHEN 'owner_only' THEN EXISTS (
      SELECT 1
        FROM public.system_settings s,
             LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) AS e(entry)
       WHERE s.key = 'web_payment_reminders_owner_addresses'
         AND btrim(e.entry) <> ''
         AND CASE WHEN left(btrim(e.entry), 1) = '@'
                  THEN lower(btrim(p_email)) LIKE '%' || lower(btrim(e.entry))
                  ELSE lower(btrim(p_email)) = lower(btrim(e.entry)) END)
    ELSE false
  END
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Eligibility — ONE definition, read by the candidate list and re-read by
--    the claim under a row lock. SQL, so there are no plpgsql OUT-parameter
--    name clashes; every column is table-qualified anyway.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.web_payment_reminder_eligible(p_entity_type text, p_entity_id uuid)
RETURNS TABLE (entity_type text, entity_id uuid, deadline timestamptz, reference text, customer_id uuid,
               email text, is_test boolean, lang text, currency text, amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  WITH e AS (
    SELECT 'cash_order'::text AS entity_type, o.id AS entity_id, o.transfer_due_at AS deadline,
           o.ready_confirmed_at, coalesce(o.web_reference, o.invoice_number::text) AS reference,
           o.customer_id, btrim(cu.email) AS email, coalesce(cu.is_test, false) AS is_test,
           CASE WHEN o.customer_lang = 'en' THEN 'en' ELSE 'ja' END AS lang,   -- pickLang: anything but 'en' is 'ja'
           o.currency::text AS currency, o.remaining_balance AS amount
      FROM public.cash_orders o
      JOIN public.customers cu ON cu.id = o.customer_id
     WHERE (p_entity_type IS NULL OR p_entity_type = 'cash_order')
       AND (p_entity_id IS NULL OR o.id = p_entity_id)
       AND o.source_channel = 'web'
       AND o.status::text = 'pending'
       AND o.payment_status = 'pending_transfer'
       AND o.ready_confirmed_at IS NOT NULL
       AND o.transfer_due_at IS NOT NULL
       AND o.remaining_balance > 0
       AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                        WHERE s.cash_order_id = o.id AND s.status::text IN ('submitted','under_review'))
    UNION ALL
    SELECT 'layaway'::text, a.id, a.transfer_due_at,
           a.ready_confirmed_at, coalesce(a.web_reference, a.invoice_number::text),
           a.customer_id, btrim(cu.email), coalesce(cu.is_test, false),
           'en'::text,                                   -- layaway emails are English only, always
           a.currency::text, a.downpayment_amount
      FROM public.layaway_accounts a
      JOIN public.customers cu ON cu.id = a.customer_id
     WHERE (p_entity_type IS NULL OR p_entity_type = 'layaway')
       AND (p_entity_id IS NULL OR a.id = p_entity_id)
       AND a.source_channel = 'web'
       AND a.status::text = 'active'
       AND a.ready_confirmed_at IS NOT NULL
       AND a.transfer_due_at IS NOT NULL
       AND coalesce(a.total_paid, 0) = 0
       AND a.downpayment_amount > 0
       AND NOT EXISTS (SELECT 1 FROM public.payment_submissions s
                        WHERE s.account_id = a.id AND s.status::text IN ('submitted','under_review'))
       AND NOT EXISTS (SELECT 1 FROM public.payment_submission_allocations psa
                         JOIN public.payment_submissions s ON s.id = psa.submission_id
                        WHERE psa.account_id = a.id AND s.status::text IN ('submitted','under_review'))
  )
  SELECT e.entity_type, e.entity_id, e.deadline, e.reference, e.customer_id, e.email, e.is_test,
         e.lang, e.currency, e.amount
    FROM e
   WHERE e.email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     -- the storefront test gate: a test customer only at an owner-readable address
     AND (NOT e.is_test OR lower(e.email) = 'chajewelsjapan@gmail.com' OR lower(e.email) LIKE '%@chajewelsjp.com')
     AND e.currency IN ('JPY','PHP')
     AND e.deadline > now() + interval '1 hour'
     AND e.deadline - now() <= CASE WHEN e.deadline - e.ready_confirmed_at <= interval '30 hours'
                                    THEN interval '6 hours' ELSE interval '24 hours' END
     AND NOT EXISTS (SELECT 1 FROM public.web_payment_reminders r
                      WHERE r.entity_type = e.entity_type AND r.entity_id = e.entity_id AND r.deadline = e.deadline)
     AND (SELECT count(*) FROM public.web_payment_reminders r
           WHERE r.entity_type = e.entity_type AND r.entity_id = e.entity_id) < 2
$fn$;
COMMENT ON FUNCTION public.web_payment_reminder_eligible(text, uuid) IS
  'Stage D eligibility (docs/WEB-PAYMENT-REMINDERS.md), whatever the switch says — the switch is applied by web_payment_reminder_candidates and claim_web_payment_reminder. Read-only preview for the owner: SELECT * FROM web_payment_reminder_eligible(NULL, NULL).';

CREATE OR REPLACE FUNCTION public.web_payment_reminder_candidates(p_limit integer DEFAULT 50)
RETURNS TABLE (entity_type text, entity_id uuid, deadline timestamptz, reference text, customer_id uuid,
               email text, is_test boolean, lang text, currency text, amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
#variable_conflict use_column
BEGIN
  IF public.web_payment_reminder_mode() = 'off' THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT x.entity_type, x.entity_id, x.deadline, x.reference, x.customer_id, x.email, x.is_test,
           x.lang, x.currency, x.amount
      FROM public.web_payment_reminder_eligible(NULL, NULL) x
     WHERE public.web_payment_reminder_address_allowed(x.email)
     ORDER BY x.deadline, x.entity_id
     LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END
$fn$;

-- Claim under the same eligibility AND the same switch, re-read now under the
-- order's row lock: a proof uploaded, a payment confirmed, a deadline moved or
-- the switch turned off between the read and the send wins.
CREATE OR REPLACE FUNCTION public.claim_web_payment_reminder(p_entity_type text, p_entity_id uuid, p_deadline timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
#variable_conflict use_column
DECLARE
  r    record;
  v_id uuid;
BEGIN
  IF p_entity_type = 'cash_order' THEN
    PERFORM 1 FROM public.cash_orders WHERE id = p_entity_id FOR UPDATE;
  ELSIF p_entity_type = 'layaway' THEN
    PERFORM 1 FROM public.layaway_accounts WHERE id = p_entity_id FOR UPDATE;
  ELSE
    RETURN NULL;
  END IF;

  SELECT x.* INTO r FROM public.web_payment_reminder_eligible(p_entity_type, p_entity_id) x LIMIT 1;
  IF NOT FOUND OR r.deadline IS DISTINCT FROM p_deadline THEN
    RETURN NULL;
  END IF;
  IF NOT public.web_payment_reminder_address_allowed(r.email) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.web_payment_reminders
    (entity_type, entity_id, deadline, reference, customer_id, email, lang, currency, amount)
  VALUES (r.entity_type, r.entity_id, r.deadline, r.reference, r.customer_id, r.email, r.lang, r.currency, r.amount)
  ON CONFLICT ON CONSTRAINT web_payment_reminders_once_per_deadline DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END
$fn$;

CREATE OR REPLACE FUNCTION public.finish_web_payment_reminder(p_id uuid, p_status text, p_detail text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  IF p_status NOT IN ('sent','skipped','failed','suppressed') THEN
    RAISE EXCEPTION 'finish_web_payment_reminder: bad status %', p_status;
  END IF;
  UPDATE public.web_payment_reminders
     SET status = p_status, detail = left(p_detail, 500), finished_at = now()
   WHERE id = p_id AND status = 'claimed';
END
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Stage C: one "last day" bell per web reservation unconfirmed for 48h,
--    before the 72h auto-cancel (web-reservation-sweep). Same "live
--    reservation" predicate as the Hub queue and the sweep. Staff-only — runs
--    whatever the payment-reminder switch says.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.web_reservation_expiring_bells()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_n integer := 0;
  v_k integer;
BEGIN
  WITH due AS (
    SELECT 'cash_order'::text AS entity_type, o.id, o.customer_id, o.invoice_number::text AS invoice_number,
           coalesce(o.web_reference, o.invoice_number::text) AS ref, o.created_at
      FROM public.cash_orders o
     WHERE o.source_channel = 'web' AND o.ready_confirmed_at IS NULL AND o.status::text = 'pending'
       AND o.created_at <= now() - interval '48 hours' AND o.created_at > now() - interval '72 hours'
    UNION ALL
    SELECT 'layaway'::text, a.id, a.customer_id, a.invoice_number::text,
           coalesce(a.web_reference, a.invoice_number::text), a.created_at
      FROM public.layaway_accounts a
     WHERE a.source_channel = 'web' AND a.ready_confirmed_at IS NULL AND a.status::text = 'active'
       AND a.created_at <= now() - interval '48 hours' AND a.created_at > now() - interval '72 hours'
  ), ins AS (
    INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
    SELECT 'web_reservation_expiring',
           'Last day — ' || d.ref || ' auto-cancels at '
             || to_char((d.created_at + interval '72 hours') AT TIME ZONE 'Asia/Manila', 'Mon FMDD HH24:MI') || ' PHT',
           d.ref || ' has waited 48 hours for staff to confirm the piece. Confirm or decline it before '
             || to_char((d.created_at + interval '72 hours') AT TIME ZONE 'Asia/Manila', 'Mon FMDD HH24:MI')
             || ' PHT, or it is cancelled automatically and the stock goes back on sale.',
           CASE WHEN d.entity_type = 'layaway' THEN d.id END,
           d.customer_id,
           d.invoice_number,
           CASE WHEN d.entity_type = 'cash_order'
                THEN jsonb_build_object('entity_type', d.entity_type, 'entity_id', d.id, 'cash_order_id', d.id,
                                        'web_reference', d.ref, 'source_channel', 'web')
                ELSE jsonb_build_object('entity_type', d.entity_type, 'entity_id', d.id, 'layaway_account_id', d.id,
                                        'web_reference', d.ref, 'source_channel', 'web') END
      FROM due d
     WHERE NOT EXISTS (SELECT 1 FROM public.staff_notifications n
                        WHERE n.type = 'web_reservation_expiring'
                          AND n.metadata ->> 'entity_id' = d.id::text)
    RETURNING 1
  )
  SELECT count(*) INTO v_k FROM ins;
  v_n := v_n + coalesce(v_k, 0);
  RETURN v_n;
END
$fn$;
COMMENT ON FUNCTION public.web_reservation_expiring_bells() IS
  'Stage C (docs/WEB-PAYMENT-REMINDERS.md): one staff bell (type web_reservation_expiring) per web reservation still unconfirmed 48–72h after creation, deduped on metadata.entity_id. pg_cron web-reservation-expiring-bell, hourly at :13. No email.';

-- ---------------------------------------------------------------------------
-- 7. Read and write the switch. Read: admin or admin_settings (the Settings
--    page's own key). Write: ADMIN ROLE only — no override can grant it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_web_payment_reminders()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   uuid := auth.uid();
  v_mode  public.system_settings%ROWTYPE;
  v_list  public.system_settings%ROWTYPE;
  v_name  text;
  v_by    uuid;
  v_at    timestamptz;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT (public.has_role(v_uid, 'admin'::public.app_role) OR public.has_permission(v_uid, 'admin_settings')) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;
  SELECT * INTO v_mode FROM public.system_settings WHERE key = 'web_payment_reminders_mode';
  SELECT * INTO v_list FROM public.system_settings WHERE key = 'web_payment_reminders_owner_addresses';
  -- The later of the two rows is "last changed".
  IF v_list.updated_at IS NOT NULL AND (v_mode.updated_at IS NULL OR v_list.updated_at > v_mode.updated_at)
     AND v_list.updated_by_user_id IS NOT NULL THEN
    v_by := v_list.updated_by_user_id; v_at := v_list.updated_at;
  ELSE
    v_by := v_mode.updated_by_user_id; v_at := v_mode.updated_at;
  END IF;
  IF v_by IS NOT NULL THEN
    SELECT full_name INTO v_name FROM public.profiles WHERE user_id = v_by LIMIT 1;
  END IF;
  RETURN jsonb_build_object(
    'found',              v_mode.id IS NOT NULL AND v_list.id IS NOT NULL,
    'mode',               public.web_payment_reminder_mode(),
    'raw_mode',           v_mode.value,
    'owner_addresses',    CASE WHEN jsonb_typeof(v_list.value) = 'array' THEN v_list.value ELSE '[]'::jsonb END,
    'updated_at',         v_at,
    'updated_by_user_id', v_by,
    'updated_by_name',    v_name,
    'can_change',         public.has_role(v_uid, 'admin'::public.app_role),
    'due_now',            (SELECT count(*) FROM public.web_payment_reminder_eligible(NULL, NULL)),
    'sent_7d',            (SELECT count(*) FROM public.web_payment_reminders
                            WHERE status = 'sent' AND claimed_at >= now() - interval '7 days'));
END
$fn$;
REVOKE ALL ON FUNCTION public.get_web_payment_reminders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_web_payment_reminders() TO authenticated, service_role;
COMMENT ON FUNCTION public.get_web_payment_reminders() IS
  'Payment reminders card (Hub → Settings → General). Admin or admin_settings. mode (fail-closed), owner_addresses, last change, can_change (admin), due_now (eligible right now, whatever the switch), sent_7d.';

CREATE OR REPLACE FUNCTION public.set_web_payment_reminders(
  p_mode text, p_owner_addresses jsonb DEFAULT NULL, p_expected_mode text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid      uuid := auth.uid();
  v_mode_row public.system_settings%ROWTYPE;
  v_list_row public.system_settings%ROWTYPE;
  v_old_mode text;
  v_new_mode text;
  v_new_list jsonb;
  v_entry    text;
  v_clean    text[] := ARRAY[]::text[];
  v_mode_changed boolean;
  v_list_changed boolean;
  v_now      timestamptz := now();
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  -- ADMIN ONLY — by role, not by permission key, so no override can grant it.
  IF NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RETURN jsonb_build_object('error', 'permission_denied');
  END IF;

  SELECT * INTO v_mode_row FROM public.system_settings WHERE key = 'web_payment_reminders_mode' FOR UPDATE;
  SELECT * INTO v_list_row FROM public.system_settings WHERE key = 'web_payment_reminders_owner_addresses' FOR UPDATE;
  IF v_mode_row.id IS NULL OR v_list_row.id IS NULL THEN RETURN jsonb_build_object('error', 'setting_missing'); END IF;

  v_old_mode := public.web_payment_reminder_mode();
  v_new_mode := coalesce(btrim(p_mode), v_old_mode);
  IF v_new_mode NOT IN ('off','owner_only','on') THEN
    RETURN jsonb_build_object('error', 'invalid_mode');
  END IF;

  -- Two admins on the same screen: the second click was made against a state
  -- that no longer holds.
  IF p_expected_mode IS NOT NULL AND p_expected_mode IS DISTINCT FROM v_old_mode THEN
    RETURN jsonb_build_object('error', 'stale', 'mode', v_old_mode);
  END IF;

  IF p_owner_addresses IS NULL THEN
    v_new_list := v_list_row.value;
  ELSE
    IF jsonb_typeof(p_owner_addresses) <> 'array' THEN
      RETURN jsonb_build_object('error', 'invalid_owner_addresses');
    END IF;
    FOR v_entry IN SELECT lower(btrim(x)) FROM jsonb_array_elements_text(p_owner_addresses) AS t(x) LOOP
      CONTINUE WHEN v_entry = '';
      IF NOT (v_entry ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
              OR v_entry ~ '^@[^@[:space:]]+\.[^@[:space:]]+$') THEN
        RETURN jsonb_build_object('error', 'invalid_owner_address', 'entry', v_entry);
      END IF;
      IF NOT v_entry = ANY (v_clean) THEN v_clean := v_clean || v_entry; END IF;
    END LOOP;
    IF array_length(v_clean, 1) > 20 THEN
      RETURN jsonb_build_object('error', 'too_many_owner_addresses');
    END IF;
    v_new_list := to_jsonb(v_clean);
  END IF;

  -- owner_only with nobody on the list would send to no one and look on.
  IF jsonb_typeof(v_new_list) IS DISTINCT FROM 'array' THEN v_new_list := '[]'::jsonb; END IF;
  IF v_new_mode = 'owner_only' AND jsonb_array_length(v_new_list) = 0 THEN
    RETURN jsonb_build_object('error', 'owner_addresses_required');
  END IF;

  v_mode_changed := v_mode_row.value IS DISTINCT FROM to_jsonb(v_new_mode);
  v_list_changed := v_list_row.value IS DISTINCT FROM v_new_list;
  IF NOT v_mode_changed AND NOT v_list_changed THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'mode', v_old_mode, 'owner_addresses', v_new_list);
  END IF;

  PERFORM set_config('app.allow_web_payment_reminders_change', 'on', true);
  IF v_mode_changed THEN
    UPDATE public.system_settings SET value = to_jsonb(v_new_mode), updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_mode_row.id;
  END IF;
  IF v_list_changed THEN
    UPDATE public.system_settings SET value = v_new_list, updated_by_user_id = v_uid, updated_at = v_now
     WHERE id = v_list_row.id;
  END IF;
  INSERT INTO public.audit_logs (entity_type, entity_id, action, old_value_json, new_value_json, performed_by_user_id, created_at)
  VALUES ('system_setting', v_mode_row.id, 'set_web_payment_reminders',
          jsonb_build_object('mode', v_old_mode, 'raw_mode', v_mode_row.value, 'owner_addresses', v_list_row.value,
                             'updated_at', v_mode_row.updated_at, 'updated_by_user_id', v_mode_row.updated_by_user_id),
          jsonb_build_object('mode', v_new_mode, 'owner_addresses', v_new_list,
                             'mode_changed', v_mode_changed, 'owner_addresses_changed', v_list_changed),
          v_uid, v_now);
  PERFORM set_config('app.allow_web_payment_reminders_change', '', true);

  RETURN jsonb_build_object('ok', true, 'changed', true, 'mode', v_new_mode, 'old_mode', v_old_mode,
                            'owner_addresses', v_new_list, 'updated_at', v_now);
END
$fn$;
REVOKE ALL ON FUNCTION public.set_web_payment_reminders(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_web_payment_reminders(text, jsonb, text) TO authenticated;
COMMENT ON FUNCTION public.set_web_payment_reminders(text, jsonb, text) IS
  'The ONLY writer of system_settings.web_payment_reminders_mode and web_payment_reminders_owner_addresses (trg_guard_web_payment_reminders refuses every other write). Admin role only. Mode off|owner_only|on; owner list of addresses or @domains (<= 20, lower-cased, de-duplicated; owner_only needs >= 1). One audit_logs row (system_setting / set_web_payment_reminders, old -> new). p_expected_mode = the mode the caller saw; a mismatch returns {error:"stale"}.';

-- ---------------------------------------------------------------------------
-- 8. Email history for an order page. Staff only. Every storefront email
--    logged under the order's reference, plus its reminder rows (a claim that
--    never reached the sender still shows).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_order_email_history(p_entity_type text, p_entity_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid  uuid := auth.uid();
  v_refs text[];
  v_log  jsonb;
  v_rem  jsonb;
BEGIN
  IF v_uid IS NULL THEN RETURN jsonb_build_object('error', 'user_identity_required'); END IF;
  IF NOT public.is_staff(v_uid) THEN RETURN jsonb_build_object('error', 'permission_denied'); END IF;

  IF p_entity_type = 'cash_order' THEN
    SELECT array_remove(ARRAY[o.web_reference, o.invoice_number::text], NULL) INTO v_refs
      FROM public.cash_orders o WHERE o.id = p_entity_id;
  ELSIF p_entity_type = 'layaway' THEN
    SELECT array_remove(ARRAY[a.web_reference, a.invoice_number::text], NULL) INTO v_refs
      FROM public.layaway_accounts a WHERE a.id = p_entity_id;
  ELSE
    RETURN jsonb_build_object('error', 'invalid_entity_type');
  END IF;
  IF v_refs IS NULL THEN RETURN jsonb_build_object('error', 'not_found'); END IF;

  SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'created_at') DESC), '[]'::jsonb) INTO v_log
    FROM (
      SELECT jsonb_build_object('created_at', l.created_at, 'template', l.template_name, 'status', l.status,
                                'recipient', l.recipient_email, 'error', l.error_message,
                                'skip_reason', l.metadata ->> 'skip_reason') AS x
        FROM public.email_send_log l
       WHERE (l.metadata ->> 'reference') = ANY (v_refs)
         AND coalesce(l.channel, 'storefront') = 'storefront'
       ORDER BY l.created_at DESC
       LIMIT 100
    ) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'claimed_at', r.claimed_at, 'finished_at', r.finished_at, 'deadline', r.deadline, 'status', r.status,
           'detail', r.detail, 'lang', r.lang, 'currency', r.currency, 'amount', r.amount, 'email', r.email)
           ORDER BY r.claimed_at DESC), '[]'::jsonb) INTO v_rem
    FROM public.web_payment_reminders r
   WHERE r.entity_type = p_entity_type AND r.entity_id = p_entity_id;

  RETURN jsonb_build_object('references', to_jsonb(v_refs), 'emails', v_log, 'payment_reminders', v_rem);
END
$fn$;
REVOKE ALL ON FUNCTION public.get_order_email_history(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_order_email_history(text, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.get_order_email_history(text, uuid) IS
  'Customer emails for one order (Hub order pages): email_send_log storefront rows whose metadata.reference is the order''s web_reference or invoice_number (newest 100), and its web_payment_reminders rows. Staff only (is_staff).';

-- ---------------------------------------------------------------------------
-- 9. Service-role functions: no browser role may call them.
-- ---------------------------------------------------------------------------
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.web_payment_reminder_mode()',
    'public.web_payment_reminder_address_allowed(text)',
    'public.web_payment_reminder_eligible(text,uuid)',
    'public.web_payment_reminder_candidates(integer)',
    'public.claim_web_payment_reminder(text,uuid,timestamptz)',
    'public.finish_web_payment_reminder(uuid,text,text)',
    'public.web_reservation_expiring_bells()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 10. The schedule, hourly at :13 (free: page365 2-59/5 never lands on :13;
--     the reservation sweep is :23, cash expiry :40). Vault-backed service key
--     resolved at fire time (CRON AUTH RULE), pattern from web-reservation-sweep.
-- ---------------------------------------------------------------------------
SELECT cron.unschedule('web-payment-reminder-sweep')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'web-payment-reminder-sweep');
SELECT cron.schedule('web-payment-reminder-sweep', '13 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/web-payment-reminder-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{"action":"sweep"}'::jsonb
  );
$cron$);

SELECT cron.unschedule('web-reservation-expiring-bell')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'web-reservation-expiring-bell');
SELECT cron.schedule('web-reservation-expiring-bell', '13 * * * *',
  $cron$SELECT public.web_reservation_expiring_bells();$cron$);

-- ---------------------------------------------------------------------------
-- 11. Self-check, still inside the transaction. Pure reads; any failure aborts
--     the whole file with nothing changed.
-- ---------------------------------------------------------------------------
DO $self$
DECLARE
  v_fn text;
BEGIN
  -- The switch is exactly as this file found it, and OFF on a first run.
  IF coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'web_payment_reminders_mode'), 'absent')
     IS DISTINCT FROM (CASE WHEN current_setting('payrem.mode_before', true) = 'absent'
                            THEN 'off' ELSE current_setting('payrem.mode_before', true) END) THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: the switch changed during this file';
  END IF;
  IF current_setting('payrem.mode_before', true) = 'absent' AND public.web_payment_reminder_mode() <> 'off' THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: a first run must leave reminders off';
  END IF;
  IF (SELECT jsonb_typeof(value) FROM public.system_settings WHERE key = 'web_payment_reminders_owner_addresses') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: owner address list missing';
  END IF;
  IF to_regclass('public.web_payment_reminders') IS NULL THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: table missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.web_payment_reminders'::regclass) THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: RLS is off on web_payment_reminders';
  END IF;
  IF has_table_privilege('authenticated', 'public.web_payment_reminders', 'INSERT')
     OR has_table_privilege('authenticated', 'public.web_payment_reminders', 'UPDATE')
     OR has_table_privilege('anon', 'public.web_payment_reminders', 'SELECT') THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: a browser role can write or anon can read the ledger';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.web_payment_reminder_mode()', 'public.web_payment_reminder_address_allowed(text)',
    'public.web_payment_reminder_eligible(text,uuid)', 'public.web_payment_reminder_candidates(integer)',
    'public.claim_web_payment_reminder(text,uuid,timestamptz)', 'public.finish_web_payment_reminder(uuid,text,text)',
    'public.web_reservation_expiring_bells()', 'public.guard_web_payment_reminders()'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'web_payment_reminders self-check: % is callable by a browser role', v_fn;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.claim_web_payment_reminder(text,uuid,timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.web_payment_reminder_candidates(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: service_role cannot run the sweep functions';
  END IF;
  IF has_function_privilege('anon', 'public.set_web_payment_reminders(text,jsonb,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.set_web_payment_reminders(text,jsonb,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_web_payment_reminders()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_web_payment_reminders()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_order_email_history(text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_order_email_history(text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: Hub RPC grants are wrong';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = 'trg_guard_web_payment_reminders'
                    AND t.tgrelid = 'public.system_settings'::regclass) THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: guard trigger missing';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'web-payment-reminder-sweep') <> 1
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'web-payment-reminder-sweep' AND schedule = '13 * * * *'
                       AND command ILIKE '%vault.decrypted_secrets%' AND command ILIKE '%/functions/v1/web-payment-reminder-sweep%') THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: sweep cron job not registered as written';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'web-reservation-expiring-bell') <> 1
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'web-reservation-expiring-bell' AND schedule = '13 * * * *'
                       AND command ILIKE '%web_reservation_expiring_bells()%') THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: bell cron job not registered as written';
  END IF;
  IF public.web_payment_reminder_mode() = 'off' AND EXISTS (SELECT 1 FROM public.web_payment_reminder_candidates(5)) THEN
    RAISE EXCEPTION 'web_payment_reminders self-check: candidates returned rows while off';
  END IF;
END
$self$;

COMMIT;

-- ===========================================================================
-- Verification (read-only). Run after COMMIT.
--
-- (1) The switch is OFF, the owner list is seeded, and the value is guarded.
--     Expect one row:  off | ["chajewelsjapan@gmail.com", "@chajewelsjp.com"] | t
-- SELECT public.web_payment_reminder_mode()                                                  AS mode,
--        (SELECT value FROM public.system_settings WHERE key = 'web_payment_reminders_owner_addresses') AS owner_addresses,
--        EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_web_payment_reminders')   AS guarded;
--
-- (2) The two cron jobs. Expect two rows, both '13 * * * *' and active = t:
--     web-payment-reminder-sweep | 13 * * * * | t
--     web-reservation-expiring-bell | 13 * * * * | t
-- SELECT jobname, schedule, active FROM cron.job
--  WHERE jobname IN ('web-payment-reminder-sweep','web-reservation-expiring-bell') ORDER BY jobname DESC;
--
-- (3) Browser roles. Expect: f | f | t | t | t
-- SELECT has_function_privilege('authenticated','public.claim_web_payment_reminder(text,uuid,timestamptz)','EXECUTE') AS auth_claim,
--        has_function_privilege('authenticated','public.web_payment_reminder_candidates(integer)','EXECUTE')          AS auth_candidates,
--        has_function_privilege('authenticated','public.set_web_payment_reminders(text,jsonb,text)','EXECUTE')        AS auth_set,
--        has_function_privilege('authenticated','public.get_web_payment_reminders()','EXECUTE')                       AS auth_get,
--        has_function_privilege('authenticated','public.get_order_email_history(text,uuid)','EXECUTE')                AS auth_history;
--
-- (4) Nothing sent, nothing claimed. Expect: 0
-- SELECT count(*) FROM public.web_payment_reminders;
--
-- (5) Read-only preview of who WOULD be reminded right now if the switch were
--     on (any number of rows, including none — informational):
-- SELECT entity_type, reference, email, deadline, currency, amount, lang
--   FROM public.web_payment_reminder_eligible(NULL, NULL) ORDER BY deadline;
-- ===========================================================================
