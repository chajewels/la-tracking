-- ===========================================================================
-- Cart reminders (stages A/B of docs/CART-REMINDERS.md; plan: the owner's
-- ~/Code/reference/abandoned-cart-investigation.md revision 2, owner approval
-- 2026-10-01 "approved all recommendation").
--
-- DRAFT — NOT APPLIED BY THIS REPO. The owner runs it in the SQL Editor after
-- the Hub release is on main AND website / cart-reminder-sweep /
-- handle-email-events are deployed. One transaction. Sends nothing:
-- cart_reminders_mode is seeded 'off' and the self-check aborts otherwise.
-- Redefines no existing function (drift audit: all three buckets stay 0).
-- ===========================================================================
BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.customers') IS NULL
     OR to_regclass('public.website_products') IS NULL
     OR to_regclass('public.website_product_variants') IS NULL
     OR to_regclass('public.website_product_media') IS NULL
     OR to_regclass('public.cash_orders') IS NULL
     OR to_regclass('public.layaway_accounts') IS NULL
     OR to_regclass('public.suppressed_emails') IS NULL
     OR to_regclass('public.system_settings') IS NULL
     OR to_regclass('public.checkout_quotes') IS NULL THEN
    RAISE EXCEPTION 'cart_reminders: a required table is missing';
  END IF;
  -- Stage B reads the customer's latest quote for the cart cycle (6 columns).
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'checkout_quotes'
         AND column_name IN ('mode','settlement_currency','term_months','consumed_at','created_at','customer_id')) <> 6 THEN
    RAISE EXCEPTION 'cart_reminders: checkout_quotes is missing a column stage B reads';
  END IF;
  IF to_regprocedure('public.is_staff(uuid)') IS NULL THEN
    RAISE EXCEPTION 'cart_reminders: public.is_staff(uuid) missing';
  END IF;
  IF to_regprocedure('cron.schedule(text,text,text)') IS NULL OR to_regprocedure('cron.unschedule(text)') IS NULL THEN
    RAISE EXCEPTION 'cart_reminders: pg_cron missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'net' AND p.proname = 'http_post') THEN
    RAISE EXCEPTION 'cart_reminders: net.http_post (pg_net) missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'email_queue_service_role_key') THEN
    RAISE EXCEPTION 'cart_reminders: Vault secret email_queue_service_role_key missing — do not create a second key';
  END IF;
  -- Live check that customers carries no consent/lang column this would shadow.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='customers'
                AND column_name IN ('cart_reminders','marketing_consent','preferred_lang')) THEN
    RAISE EXCEPTION 'cart_reminders: customers already has a consent/lang column — stop and re-plan';
  END IF;
END

$pre$;

-- 1. Saved carts ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.customer_carts (
  customer_id      uuid PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  lang             text NOT NULL DEFAULT 'ja' CHECK (lang IN ('ja','en')),
  cycle_id         uuid NOT NULL DEFAULT gen_random_uuid(),
  cycle_started_at timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  client_as_of     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.customer_carts IS
  'Server copy of a signed-in customer''s storefront cart (the browser cookie cj-cart stays authoritative in the browser). Written only by website_set_cart via the website edge function. updated_at moves only when the lines change. cycle_id starts when an empty cart gets its first line; at most one cart reminder per cycle.';

CREATE TABLE IF NOT EXISTS public.customer_cart_lines (
  customer_id uuid NOT NULL REFERENCES public.customer_carts(customer_id) ON DELETE CASCADE,
  variant_id  uuid NOT NULL REFERENCES public.website_product_variants(id) ON DELETE CASCADE,
  qty         integer NOT NULL CHECK (qty BETWEEN 1 AND 20),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, variant_id)
);

-- 2. Consent (current state + append-only legal record) ---------------------
CREATE TABLE IF NOT EXISTS public.customer_email_consents (
  customer_id       uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('cart_reminder')),
  opted_in          boolean NOT NULL DEFAULT false,
  consented_at      timestamptz,
  withdrawn_at      timestamptz,
  source            text NOT NULL,
  lang              text CHECK (lang IS NULL OR lang IN ('ja','en')),
  text_version      text,
  unsubscribe_token uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, kind)
);

CREATE TABLE IF NOT EXISTS public.customer_email_consent_events (
  id           bigserial PRIMARY KEY,
  customer_id  uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  email        text,
  kind         text NOT NULL CHECK (kind IN ('cart_reminder')),
  action       text NOT NULL CHECK (action IN ('opt_in','opt_out')),
  source       text NOT NULL CHECK (source IN ('account','complete_profile','checkout','email_link','lovable_unsubscribe','staff')),
  lang         text,
  text_version text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb
);
COMMENT ON TABLE public.customer_email_consent_events IS
  'Append-only record of every marketing-email consent change (Japan 特定電子メール法 / 特商法 consent records; PH DPA evidence). Never deleted; customer_id goes NULL if the customer is deleted, the email snapshot stays.';

CREATE OR REPLACE FUNCTION public.guard_consent_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'customer_email_consent_events is append-only';
  END IF;
  -- The only permitted update is the FK's ON DELETE SET NULL.
  IF NEW.customer_id IS NULL AND OLD.customer_id IS NOT NULL
     AND (NEW.id, NEW.email, NEW.kind, NEW.action, NEW.source, NEW.lang, NEW.text_version, NEW.occurred_at, NEW.metadata)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.email, OLD.kind, OLD.action, OLD.source, OLD.lang, OLD.text_version, OLD.occurred_at, OLD.metadata) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'customer_email_consent_events is append-only';
END $$;
DROP TRIGGER IF EXISTS trg_consent_events_append_only ON public.customer_email_consent_events;
CREATE TRIGGER trg_consent_events_append_only
  BEFORE UPDATE OR DELETE ON public.customer_email_consent_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_consent_events_append_only();

-- 3. Reminder sends (the once-per-cycle claim) ------------------------------
CREATE TABLE IF NOT EXISTS public.cart_reminder_sends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  cycle_id    uuid NOT NULL UNIQUE,
  email       text NOT NULL,
  lang        text NOT NULL CHECK (lang IN ('ja','en')),
  items       jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','sent','skipped','failed','suppressed')),
  detail      text,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS cart_reminder_sends_customer_claimed_idx
  ON public.cart_reminder_sends (customer_id, claimed_at DESC);

-- 4. RLS: staff may read; nothing but the service role writes ----------------
ALTER TABLE public.customer_carts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_cart_lines           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_email_consents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_email_consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cart_reminder_sends           ENABLE ROW LEVEL SECURITY;
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customer_carts','customer_cart_lines','customer_email_consents','customer_email_consent_events','cart_reminder_sends'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_staff_select', t);
    -- Scalar sub-selects: a bare is_staff(auth.uid()) runs once per row (CLAUDE.md, PR #265).
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT public.is_staff((SELECT auth.uid()))))', t || '_staff_select', t);
  END LOOP;
END
$rls$;

-- 5. Writers (service role only) ------------------------------------------
CREATE OR REPLACE FUNCTION public.website_set_cart(
  p_customer_id uuid, p_lines jsonb, p_lang text, p_as_of timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_cart   public.customer_carts;
  v_old    jsonb;
  v_new    jsonb;
  v_lang   text := CASE WHEN p_lang = 'en' THEN 'en' ELSE 'ja' END;
BEGIN
  IF p_customer_id IS NULL OR NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id) THEN
    RETURN jsonb_build_object('error','not_linked');
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) > 20 THEN
    RETURN jsonb_build_object('error','bad_lines');
  END IF;

  INSERT INTO customer_carts (customer_id, lang, client_as_of)
  VALUES (p_customer_id, v_lang, p_as_of)
  ON CONFLICT (customer_id) DO NOTHING;
  SELECT * INTO v_cart FROM customer_carts WHERE customer_id = p_customer_id FOR UPDATE;

  -- Last write wins by the storefront's own clock; an older write is ignored.
  IF p_as_of IS NOT NULL AND v_cart.client_as_of IS NOT NULL AND p_as_of < v_cart.client_as_of THEN
    RETURN jsonb_build_object('ok', true, 'stale', true);
  END IF;

  -- Keep only known variants, qty clamped 1..20, one row per variant.
  SELECT coalesce(jsonb_agg(jsonb_build_object('v', v, 'q', q) ORDER BY v), '[]'::jsonb) INTO v_new
  FROM (
    SELECT (l->>'variant_id')::uuid AS v, max(least(greatest((l->>'qty')::int, 1), 20)) AS q
    FROM jsonb_array_elements(p_lines) l
    WHERE (l->>'variant_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND (l->>'qty') ~ '^[0-9]+$'
      AND EXISTS (SELECT 1 FROM website_product_variants wv WHERE wv.id = (l->>'variant_id')::uuid)
    GROUP BY 1
  ) s;

  SELECT coalesce(jsonb_agg(jsonb_build_object('v', variant_id, 'q', qty) ORDER BY variant_id), '[]'::jsonb) INTO v_old
  FROM customer_cart_lines WHERE customer_id = p_customer_id;

  IF v_new = v_old THEN
    UPDATE customer_carts SET client_as_of = coalesce(p_as_of, client_as_of), lang = v_lang
     WHERE customer_id = p_customer_id;
    RETURN jsonb_build_object('ok', true, 'changed', false, 'lines', jsonb_array_length(v_new));
  END IF;

  DELETE FROM customer_cart_lines WHERE customer_id = p_customer_id;
  INSERT INTO customer_cart_lines (customer_id, variant_id, qty)
  SELECT p_customer_id, (e->>'v')::uuid, (e->>'q')::int FROM jsonb_array_elements(v_new) e;

  UPDATE customer_carts SET
    lang = v_lang,
    client_as_of = coalesce(p_as_of, client_as_of),
    updated_at = now(),
    -- A new cycle begins when an empty cart gets its first line.
    cycle_id = CASE WHEN jsonb_array_length(v_old) = 0 AND jsonb_array_length(v_new) > 0 THEN gen_random_uuid() ELSE cycle_id END,
    cycle_started_at = CASE WHEN jsonb_array_length(v_old) = 0 AND jsonb_array_length(v_new) > 0 THEN now() ELSE cycle_started_at END
  WHERE customer_id = p_customer_id;

  RETURN jsonb_build_object('ok', true, 'changed', true, 'lines', jsonb_array_length(v_new));
END $$;

CREATE OR REPLACE FUNCTION public.set_cart_reminder_consent(
  p_customer_id uuid, p_opt_in boolean, p_source text, p_lang text, p_text_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text;
  v_lang  text := CASE WHEN p_lang IN ('ja','en') THEN p_lang ELSE NULL END;
BEGIN
  IF p_opt_in IS NULL THEN RETURN jsonb_build_object('error','opt_in_required'); END IF;
  IF p_source NOT IN ('account','complete_profile','checkout','staff') THEN
    RETURN jsonb_build_object('error','bad_source');
  END IF;
  IF p_opt_in AND coalesce(btrim(p_text_version), '') = '' THEN
    RETURN jsonb_build_object('error','text_version_required');
  END IF;
  SELECT email INTO v_email FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','not_linked'); END IF;

  INSERT INTO customer_email_consents AS c
    (customer_id, kind, opted_in, consented_at, withdrawn_at, source, lang, text_version, updated_at)
  VALUES (p_customer_id, 'cart_reminder', p_opt_in,
          CASE WHEN p_opt_in THEN now() END, CASE WHEN NOT p_opt_in THEN now() END,
          p_source, v_lang, CASE WHEN p_opt_in THEN p_text_version END, now())
  ON CONFLICT (customer_id, kind) DO UPDATE SET
    opted_in     = EXCLUDED.opted_in,
    consented_at = CASE WHEN EXCLUDED.opted_in THEN now() ELSE c.consented_at END,
    withdrawn_at = CASE WHEN EXCLUDED.opted_in THEN NULL ELSE now() END,
    source       = EXCLUDED.source,
    lang         = coalesce(EXCLUDED.lang, c.lang),
    text_version = CASE WHEN EXCLUDED.opted_in THEN EXCLUDED.text_version ELSE c.text_version END,
    updated_at   = now();

  INSERT INTO customer_email_consent_events (customer_id, email, kind, action, source, lang, text_version)
  VALUES (p_customer_id, v_email, 'cart_reminder', CASE WHEN p_opt_in THEN 'opt_in' ELSE 'opt_out' END,
          p_source, v_lang, CASE WHEN p_opt_in THEN p_text_version END);

  RETURN jsonb_build_object('ok', true, 'opted_in', p_opt_in);
END $$;

-- The email link. ALWAYS answers the same thing, whatever the token.
CREATE OR REPLACE FUNCTION public.withdraw_cart_reminder_by_token(p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT c.customer_id, c.opted_in, cu.email INTO r
    FROM customer_email_consents c JOIN customers cu ON cu.id = c.customer_id
   WHERE c.unsubscribe_token = p_token AND c.kind = 'cart_reminder'
   FOR UPDATE OF c;
  IF FOUND AND r.opted_in THEN
    UPDATE customer_email_consents SET opted_in = false, withdrawn_at = now(), source = 'email_link', updated_at = now()
     WHERE customer_id = r.customer_id AND kind = 'cart_reminder';
    INSERT INTO customer_email_consent_events (customer_id, email, kind, action, source)
    VALUES (r.customer_id, r.email, 'cart_reminder', 'opt_out', 'email_link');
  END IF;
  RETURN jsonb_build_object('status','unsubscribed');
END $$;

-- Lovable's own unsubscribe webhook: stop ours too, for every customer on that address.
CREATE OR REPLACE FUNCTION public.withdraw_cart_reminder_by_email(p_email text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer := 0; r record;
BEGIN
  FOR r IN
    SELECT c.customer_id, cu.email FROM customer_email_consents c JOIN customers cu ON cu.id = c.customer_id
     WHERE c.kind = 'cart_reminder' AND c.opted_in
       AND lower(btrim(cu.email)) = lower(btrim(p_email))
     FOR UPDATE OF c
  LOOP
    UPDATE customer_email_consents SET opted_in = false, withdrawn_at = now(), source = 'lovable_unsubscribe', updated_at = now()
     WHERE customer_id = r.customer_id AND kind = 'cart_reminder';
    INSERT INTO customer_email_consent_events (customer_id, email, kind, action, source)
    VALUES (r.customer_id, r.email, 'cart_reminder', 'opt_out', 'lovable_unsubscribe');
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- 6. The sweep's reads and claims (service role only) ------------------------
CREATE OR REPLACE FUNCTION public.cart_reminder_candidates(p_limit integer DEFAULT 50)
RETURNS TABLE (customer_id uuid, email text, lang text, cycle_id uuid, unsubscribe_token uuid, items jsonb,
               quote_mode text, quote_currency text, quote_term integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_mode text := coalesce((SELECT value #>> '{}' FROM system_settings WHERE key = 'cart_reminders_mode'), 'off');
  v_raw  text := (SELECT value #>> '{}' FROM system_settings WHERE key = 'cart_reminder_idle_minutes');
  v_idle interval := make_interval(mins => greatest(5, CASE WHEN v_raw ~ '^[0-9]{1,6}$' THEN v_raw::int ELSE 1440 END));
BEGIN
  IF v_mode NOT IN ('owner_only','on') THEN RETURN; END IF;
  RETURN QUERY
  WITH base AS (
    SELECT k.customer_id, btrim(cu.email) AS email, k.lang, k.cycle_id, k.cycle_started_at, k.updated_at, c.unsubscribe_token,
           CASE WHEN cu.location ILIKE '%philippines%' THEN 'Asia/Manila' ELSE 'Asia/Tokyo' END AS tz,
           (lower(btrim(cu.email)) = 'chajewelsjapan@gmail.com' OR lower(btrim(cu.email)) LIKE '%@chajewelsjp.com') AS owner_addr,
           cu.is_test
      FROM customer_carts k
      JOIN customers cu ON cu.id = k.customer_id
      JOIN customer_email_consents c ON c.customer_id = k.customer_id AND c.kind = 'cart_reminder' AND c.opted_in
     WHERE cu.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       AND k.updated_at <= now() - v_idle
       AND k.updated_at >= now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM suppressed_emails s WHERE lower(s.email) = lower(btrim(cu.email)))
       AND NOT EXISTS (SELECT 1 FROM cart_reminder_sends s WHERE s.cycle_id = k.cycle_id)
       AND NOT EXISTS (SELECT 1 FROM cart_reminder_sends s WHERE s.customer_id = k.customer_id AND s.claimed_at > now() - interval '7 days')
       AND NOT EXISTS (SELECT 1 FROM cash_orders o WHERE o.customer_id = k.customer_id AND o.created_at >= k.updated_at)
       AND NOT EXISTS (SELECT 1 FROM layaway_accounts a WHERE a.customer_id = k.customer_id AND a.created_at >= k.updated_at)
  ), eligible AS (
    SELECT * FROM base b
     WHERE (CASE WHEN v_mode = 'owner_only' THEN b.owner_addr ELSE (NOT b.is_test OR b.owner_addr) END)
       AND extract(hour FROM now() AT TIME ZONE b.tz) BETWEEN 9 AND 19
  )
  SELECT e.customer_id, e.email, e.lang, e.cycle_id, e.unsubscribe_token, it.items,
         q.mode, q.settlement_currency, q.term_months
    FROM eligible e
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'variant_id', v.id, 'product_id', p.id, 'slug', p.slug,
               'name', p.name, 'name_ja', nullif(btrim(p.name_ja), ''),
               'size', v.size, 'stone', v.stone,
               'qty', least(l.qty, v.stock_qty), 'price_jpy', v.price_jpy,
               'image_url', (SELECT m.url FROM website_product_media m WHERE m.variant_id = v.id ORDER BY m.sort LIMIT 1)
             ) ORDER BY l.added_at) AS items
        FROM customer_cart_lines l
        JOIN website_product_variants v ON v.id = l.variant_id
        JOIN website_products p ON p.id = v.product_id
       WHERE l.customer_id = e.customer_id AND p.status = 'active' AND v.stock_qty >= 1
    ) it
    -- Stage B: her latest checkout for THIS cart cycle, even if the quote has
    -- expired (her choices stand). NULLs = stage A. A consumed quote means an
    -- order exists, which the base filter has already excluded.
    LEFT JOIN LATERAL (
      SELECT cq.mode, cq.settlement_currency, cq.term_months
        FROM checkout_quotes cq
       WHERE cq.customer_id = e.customer_id
         AND cq.created_at >= e.cycle_started_at
         AND cq.consumed_at IS NULL
       ORDER BY cq.created_at DESC
       LIMIT 1
    ) q ON true
   WHERE it.items IS NOT NULL
   ORDER BY e.updated_at
   LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END $$;

-- Claim before sending: one row per cycle, and consent re-checked under lock
-- so an opt-out that lands between candidate and send still wins.
CREATE OR REPLACE FUNCTION public.claim_cart_reminder(
  p_customer_id uuid, p_cycle_id uuid, p_email text, p_lang text, p_items jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM 1 FROM customer_email_consents
   WHERE customer_id = p_customer_id AND kind = 'cart_reminder' AND opted_in FOR SHARE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_carts WHERE customer_id = p_customer_id AND cycle_id = p_cycle_id) THEN
    RETURN NULL;  -- the cart moved on since the candidate read
  END IF;
  INSERT INTO cart_reminder_sends (customer_id, cycle_id, email, lang, items)
  VALUES (p_customer_id, p_cycle_id, p_email, CASE WHEN p_lang = 'en' THEN 'en' ELSE 'ja' END, p_items)
  ON CONFLICT (cycle_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.finish_cart_reminder(p_id uuid, p_status text, p_detail text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('sent','skipped','failed','suppressed') THEN
    RAISE EXCEPTION 'finish_cart_reminder: bad status %', p_status;
  END IF;
  UPDATE cart_reminder_sends SET status = p_status, detail = left(p_detail, 500), finished_at = now()
   WHERE id = p_id AND status = 'claimed';
END $$;

-- 90-day retention for saved lines (DPA proportionality); consents/events kept.
CREATE OR REPLACE FUNCTION public.purge_stale_customer_carts()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  DELETE FROM customer_cart_lines l USING customer_carts k
   WHERE k.customer_id = l.customer_id AND k.updated_at < now() - interval '90 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- 7. Grants: service role only (the default ACL grants PUBLIC; CLAUDE.md 2026-09-24)
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.website_set_cart(uuid,jsonb,text,timestamptz)',
    'public.set_cart_reminder_consent(uuid,boolean,text,text,text)',
    'public.withdraw_cart_reminder_by_token(uuid)',
    'public.withdraw_cart_reminder_by_email(text)',
    'public.cart_reminder_candidates(integer)',
    'public.claim_cart_reminder(uuid,uuid,text,text,jsonb)',
    'public.finish_cart_reminder(uuid,text,text)',
    'public.purge_stale_customer_carts()',
    'public.guard_consent_events_append_only()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$grants$;

-- 8. Settings: OFF, 24 h. Changed only by the owner in SQL.
INSERT INTO public.system_settings (key, value, description)
VALUES ('cart_reminders_mode', '"off"'::jsonb,
        'Cart reminder emails: off | owner_only (only chajewelsjapan@gmail.com and @chajewelsjp.com addresses) | on. Anything else = off. Owner changes it in SQL. See docs/CART-REMINDERS.md.')
ON CONFLICT (key) DO NOTHING;
INSERT INTO public.system_settings (key, value, description)
VALUES ('cart_reminder_idle_minutes', '"1440"'::jsonb,
        'Minutes a saved cart must be untouched before a reminder (min 5). 1440 = 24 h. Lowered only for the owner acceptance test.')
ON CONFLICT (key) DO NOTHING;

-- 9. Schedule: hourly at :31 (free minute), Vault key per the CRON AUTH RULE.
SELECT cron.unschedule('cart-reminder-sweep')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cart-reminder-sweep');
SELECT cron.schedule('cart-reminder-sweep', '31 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/cart-reminder-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key')
    ),
    body := '{"action":"sweep"}'::jsonb
  );
$cron$);

-- 10. Self-check — any failure aborts the whole file.
DO $self$
BEGIN
  IF (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'cart_reminders_mode') IS DISTINCT FROM 'off' THEN
    RAISE EXCEPTION 'cart_reminders: mode is not off — this file never turns reminders on';
  END IF;
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
       AND table_name IN ('customer_carts','customer_cart_lines','customer_email_consents','customer_email_consent_events','cart_reminder_sends')) <> 5 THEN
    RAISE EXCEPTION 'cart_reminders: tables missing';
  END IF;
  IF has_function_privilege('anon', 'public.cart_reminder_candidates(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.website_set_cart(uuid,jsonb,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cart_reminders: grants leaked to anon/authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cart-reminder-sweep' AND schedule = '31 * * * *') THEN
    RAISE EXCEPTION 'cart_reminders: cron job missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cart_reminder_candidates(5)) THEN
    RAISE EXCEPTION 'cart_reminders: candidates returned rows while off';
  END IF;
END
$self$;

COMMIT;
