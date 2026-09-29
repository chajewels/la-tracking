-- ============================================================================
-- Website orders PR 3 (web order drafts) — LOCAL test stub (2026-09-29).
-- NEVER RUN THIS ON LIVE: it DROPS schema public.
--
-- Builds, in an EMPTY throwaway Postgres, the tables migration
-- 20261018100000_web_order_drafts.sql touches, with the LIVE column lists
-- (read from information_schema 2026-09-29), and the live bodies of the
-- functions it reads or replaces (so its md5 guards pass exactly as on live).
--
--   initdb -D /tmp/webdrafts --locale=C -E UTF8 -U postgres
--   pg_ctl -D /tmp/webdrafts -o "-p 55463 -k /tmp" start
--   export PGOPTIONS='-c webdrafts.local_stub=yes'
--   P="psql -h /tmp -p 55463 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20261018_web_order_drafts_local_stub.sql
--   $P supabase/migrations/20261018100000_web_order_drafts.sql
--   $P supabase/migrations/20261018100000_web_order_drafts.sql   # re-run is safe
--   $P docs/sql/20261018_web_order_drafts_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('webdrafts.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c webdrafts.local_stub=yes'' — this file drops schema public';
  END IF;
  -- The stub never creates loyalty_tiers or layaway_schedule's live data; a Hub has them.
  IF to_regclass('public.loyalty_tiers') IS NOT NULL OR to_regclass('public.penalty_waiver_requests_archive') IS NOT NULL
     OR to_regclass('public.payment_allocations') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
END
$guard$;

DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA public; CREATE SCHEMA auth;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

CREATE TYPE public.account_currency AS ENUM ('PHP','JPY');
CREATE TYPE public.account_status AS ENUM ('active','completed','cancelled','overdue','forfeited','final_settlement','reactivated','extension_active','final_forfeited');
CREATE TYPE public.app_role AS ENUM ('admin','staff','finance','csr','customer','live_agent');
CREATE TYPE public.cash_order_status AS ENUM ('pending','completed','cancelled','expired');
CREATE TYPE public.schedule_status AS ENUM ('pending','partially_paid','paid','overdue','cancelled');
CREATE TYPE public.user_status AS ENUM ('active','inactive','suspended');

-- Live column lists (2026-09-29). website_products' enum columns are text here.
CREATE TABLE public.audit_logs (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL, old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.customers (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, customer_code text, full_name text NOT NULL, mobile_number text, email text, facebook_name text, messenger_link text, preferred_contact_method text DEFAULT 'messenger'::text, notes text, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now(), location text, auth_user_id uuid, setup_link_sent_at timestamp with time zone, address_line1 text, city text, postal_code text, country text, birthday date, birthday_locked_at timestamp with time zone, birthday_admin_edits_used smallint DEFAULT 0, last_birthday_award_year smallint, is_test boolean NOT NULL DEFAULT false, needs_review boolean NOT NULL DEFAULT false, source text, shopify_customer_id text, pancake_fb_id text, portal_last_seen_at timestamp with time zone, portal_password_at timestamp with time zone);
CREATE TABLE public.customer_addresses (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, customer_id uuid NOT NULL REFERENCES public.customers(id), label text, recipient_name text, line1 text NOT NULL, line2 text, city text, region text, postal_code text, country text NOT NULL DEFAULT 'JP'::text, phone text, is_default boolean NOT NULL DEFAULT false, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.checkout_quotes (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE, items jsonb NOT NULL, mode text NOT NULL DEFAULT 'full'::text, term_months integer, order_type text NOT NULL DEFAULT 'SELF'::text, ship_to_address_id uuid REFERENCES public.customer_addresses(id) ON DELETE SET NULL, recipient_name text, recipient_phone text, gift_note text, subtotal_jpy integer NOT NULL, shipping_jpy integer, total_jpy integer NOT NULL, deposit_jpy integer, schedule jsonb, expires_at timestamp with time zone NOT NULL DEFAULT (now() + '00:30:00'::interval), consumed_at timestamp with time zone, created_at timestamp with time zone NOT NULL DEFAULT now(), settlement_currency text NOT NULL DEFAULT 'JPY'::text, fx_rate numeric(12,6), fx_rate_date date, reserved_invoice_seq bigint);
CREATE TABLE public.website_products (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, sku text NOT NULL, slug text NOT NULL, name text NOT NULL, karat text, weight_g numeric(8,2), description_en text, description_ja text, status text NOT NULL DEFAULT 'draft', created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now(), condition text NOT NULL DEFAULT 'New'::text, origin text NOT NULL DEFAULT 'UNKNOWN'::text, brand text, name_ja text, metals text[] NOT NULL DEFAULT '{}'::text[], page365_sync_disabled boolean NOT NULL DEFAULT false, page365_product_id bigint, page365_variant_id bigint, page365_category text, item_kind text NOT NULL DEFAULT 'jewelry'::text, video_url text, video_poster_url text);
CREATE TABLE public.website_product_variants (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, product_id uuid NOT NULL REFERENCES public.website_products(id), size text, stone text, price_jpy integer NOT NULL, cost_basis integer, stock_qty integer NOT NULL DEFAULT 0, sort integer NOT NULL DEFAULT 0, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.shipping_methods (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, provider_name text NOT NULL, title text NOT NULL, tracking_url_template text NOT NULL, supports_deeplink boolean, is_active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0, notes text, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.shipping_rates (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, country text NOT NULL, min_subtotal_jpy integer NOT NULL DEFAULT 0, fee_jpy integer NOT NULL, is_active boolean NOT NULL DEFAULT true, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.cash_orders (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, invoice_number text NOT NULL UNIQUE, customer_id uuid NOT NULL REFERENCES public.customers(id), currency account_currency NOT NULL DEFAULT 'JPY'::account_currency, total_amount numeric(12,2) NOT NULL, total_paid numeric(12,2) NOT NULL DEFAULT 0, remaining_balance numeric(12,2) NOT NULL, status cash_order_status NOT NULL DEFAULT 'pending'::cash_order_status, item_description text, loyalty_jpy_amount numeric(12,2), order_date date NOT NULL DEFAULT CURRENT_DATE, notes text, agreement_version text, agreement_acceptance_datetime timestamp with time zone, accepted_by_user_id uuid, completed_at timestamp with time zone, created_by_user_id uuid, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now(), cancellation_reason text, cancelled_at timestamp with time zone, cancelled_by_user_id uuid, expires_at timestamp with time zone, expired_at timestamp with time zone, cash_receipt_sheet_id text, is_trade boolean NOT NULL DEFAULT false, is_test boolean NOT NULL DEFAULT false, source_channel text NOT NULL DEFAULT 'hub_manual'::text, discount_amount numeric(12,2) NOT NULL DEFAULT 0, discount_type text, discount_value numeric(12,2), shipping_fee numeric(12,2) NOT NULL DEFAULT 0, shopify_order_id text, pancake_order_id text, shipping_method_id uuid, tracking_number text, shipped_at timestamp with time zone, tracking_set_by uuid, tracking_updated_at timestamp with time zone, order_type text, payment_method text, payment_status text, ship_to_address_id uuid, recipient_name text, recipient_phone text, gift_note text, quote_id uuid, web_reference text, transfer_due_at timestamp with time zone, customer_lang text, refund_status text, refund_note text, refund_decided_at timestamp with time zone, refund_decided_by_user_id uuid, ship_to_snapshot jsonb, page365_no bigint, page365_slug text, ready_confirmed_at timestamp with time zone, ready_confirmed_by uuid, reservation_reminded_at timestamp with time zone, fx_rate_used numeric(12,6), fx_rate_date date, planned_shipping_method_id uuid REFERENCES public.shipping_methods(id));
CREATE TABLE public.cash_order_items (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, cash_order_id uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE CASCADE, product_id uuid, shopify_line_item_id text, title text NOT NULL, sku text, quantity integer NOT NULL DEFAULT 1, unit_price_jpy numeric(12,2) NOT NULL, line_total_jpy numeric(12,2) NOT NULL, created_at timestamp with time zone NOT NULL DEFAULT now(), image_url text, variant_id uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL, website_product_id uuid REFERENCES public.website_products(id) ON DELETE SET NULL);
CREATE TABLE public.cash_payments (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, cash_order_id uuid NOT NULL REFERENCES public.cash_orders(id), amount_paid numeric(12,2) NOT NULL, currency account_currency NOT NULL, date_paid date NOT NULL, payment_method text, reference_number text, remarks text, entered_by_user_id uuid, submitted_by_type text, submitted_by_name text, voided_at timestamp with time zone, voided_by_user_id uuid, void_reason text, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.layaway_accounts (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, customer_id uuid NOT NULL REFERENCES public.customers(id), invoice_number text NOT NULL UNIQUE, currency account_currency NOT NULL, total_amount numeric(15,2) NOT NULL, payment_plan_months integer NOT NULL, order_date date NOT NULL, end_date date, status account_status NOT NULL DEFAULT 'active'::account_status, total_paid numeric(15,2) NOT NULL DEFAULT 0, remaining_balance numeric(15,2) NOT NULL, agreement_version text, agreement_acceptance_date timestamp with time zone, accepted_by_user_id uuid, notes text, created_by_user_id uuid, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now(), downpayment_amount numeric NOT NULL DEFAULT 0, is_reactivated boolean NOT NULL DEFAULT false, reactivated_at timestamp with time zone, reactivated_by_user_id uuid, extension_end_date date, penalty_count_at_reactivation integer DEFAULT 0, completed_at timestamp with time zone, forfeited_at timestamp with time zone, loyalty_jpy_amount numeric, cash_receipt_sheet_id text, is_trade boolean NOT NULL DEFAULT false, is_test boolean NOT NULL DEFAULT false, discount_amount numeric(15,2) NOT NULL DEFAULT 0, discount_type text, discount_value numeric(15,2), shipping_fee numeric(15,2) NOT NULL DEFAULT 0, pancake_order_id text, shipping_method_id uuid, tracking_number text, shipped_at timestamp with time zone, tracking_set_by uuid, tracking_updated_at timestamp with time zone, source_channel text NOT NULL DEFAULT 'hub_manual'::text, web_reference text, quote_id uuid REFERENCES public.checkout_quotes(id), transfer_due_at timestamp with time zone, customer_lang text, expired_at timestamp with time zone, fx_rate_used numeric(12,6), fx_rate_date date, ship_to_snapshot jsonb, page365_no bigint, page365_slug text, stock_released_at timestamp with time zone, ready_confirmed_at timestamp with time zone, ready_confirmed_by uuid, reservation_reminded_at timestamp with time zone, planned_shipping_method_id uuid REFERENCES public.shipping_methods(id));
CREATE TABLE public.layaway_schedule (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, account_id uuid NOT NULL REFERENCES public.layaway_accounts(id), installment_number integer NOT NULL, due_date date NOT NULL, base_installment_amount numeric(15,2) NOT NULL, penalty_amount numeric(15,2) NOT NULL DEFAULT 0, total_due_amount numeric(15,2) NOT NULL, paid_amount numeric(15,2) NOT NULL DEFAULT 0, currency account_currency NOT NULL, status schedule_status NOT NULL DEFAULT 'pending'::schedule_status, generated_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now(), carried_amount numeric(12,2) DEFAULT 0, carried_from_schedule_id uuid, carried_by_payment_id uuid);
CREATE TABLE public.layaway_account_items (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, account_id uuid NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE, product_id uuid, shopify_line_item_id text, title text NOT NULL, sku text, quantity integer NOT NULL DEFAULT 1, unit_price_jpy numeric(12,2) NOT NULL, line_total_jpy numeric(12,2) NOT NULL, image_url text, created_at timestamp with time zone NOT NULL DEFAULT now(), website_product_id uuid REFERENCES public.website_products(id) ON DELETE SET NULL, variant_id uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL);
CREATE TABLE public.payments (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, account_id uuid NOT NULL REFERENCES public.layaway_accounts(id), amount_paid numeric(15,2) NOT NULL, currency account_currency NOT NULL, date_paid date NOT NULL DEFAULT CURRENT_DATE, payment_method text DEFAULT 'cash'::text, reference_number text, remarks text, entered_by_user_id uuid, created_at timestamp with time zone NOT NULL DEFAULT now(), voided_at timestamp with time zone, voided_by_user_id uuid, void_reason text, submitted_by_type text, submitted_by_name text);
CREATE TABLE public.plan_configurations (plan_months integer NOT NULL, min_amount_jpy numeric NOT NULL DEFAULT 0, min_amount_php numeric NOT NULL DEFAULT 0, dp_percentage numeric NOT NULL DEFAULT 0.30, is_active boolean NOT NULL DEFAULT true, display_label text NOT NULL, risk_tier text NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.profiles (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, full_name text NOT NULL, email text, status user_status NOT NULL DEFAULT 'active'::user_status, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.role_permissions (id uuid NOT NULL DEFAULT gen_random_uuid(), role app_role NOT NULL, permission_key text NOT NULL, is_allowed boolean NOT NULL DEFAULT false, updated_at timestamp with time zone NOT NULL DEFAULT now(), updated_by_user_id uuid);
CREATE TABLE public.service_jobs (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY);
CREATE TABLE public.service_requests (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE, cash_order_id uuid REFERENCES public.cash_orders(id) ON DELETE SET NULL, layaway_account_id uuid REFERENCES public.layaway_accounts(id) ON DELETE SET NULL, item_title text, kind text NOT NULL, details text NOT NULL, ring_size text, status text NOT NULL DEFAULT 'requested'::text, staff_note text, customer_note text, created_at timestamp with time zone NOT NULL DEFAULT now(), updated_at timestamp with time zone NOT NULL DEFAULT now(), service_job_id uuid REFERENCES public.service_jobs(id) ON DELETE SET NULL,
  CONSTRAINT service_requests_check CHECK (((cash_order_id IS NOT NULL) OR (layaway_account_id IS NOT NULL))));
CREATE TABLE public.staff_notifications (id uuid NOT NULL DEFAULT gen_random_uuid(), type text NOT NULL, title text NOT NULL, body text, account_id uuid, customer_id uuid, invoice_number text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.system_settings (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, key text NOT NULL UNIQUE, value jsonb NOT NULL, description text, updated_by_user_id uuid, updated_at timestamp with time zone NOT NULL DEFAULT now());
CREATE TABLE public.user_permission_overrides (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, permission_key text NOT NULL, granted boolean NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.user_roles (id uuid NOT NULL DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role app_role NOT NULL);

-- Only what email_delivery_report reads from them.
CREATE TABLE public.reminder_logs (id uuid DEFAULT gen_random_uuid(), customer_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.payment_submissions (id uuid DEFAULT gen_random_uuid(), customer_id uuid, account_id uuid, status text, portal_token text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.penalty_fees (id uuid DEFAULT gen_random_uuid(), account_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.penalty_waiver_requests (id uuid DEFAULT gen_random_uuid(), account_id uuid, approved_at timestamptz);
CREATE TABLE public.loyalty_members (id uuid DEFAULT gen_random_uuid(), customer_id uuid, pre_expiry_warned_at timestamptz);
CREATE TABLE public.loyalty_transactions (id uuid DEFAULT gen_random_uuid(), member_id uuid, transaction_type text, created_at timestamptz DEFAULT now());
CREATE TABLE public.email_send_log (id uuid DEFAULT gen_random_uuid(), status text, channel text, error_message text, request_id text, created_at timestamptz DEFAULT now());

CREATE SEQUENCE public.web_order_number_seq START 900051;

INSERT INTO public.plan_configurations (plan_months, min_amount_jpy, min_amount_php, dp_percentage, is_active, display_label, risk_tier) VALUES
  (3, 0, 0, 0.30, true, '3 Months', 'LOW'), (6, 25000, 10500, 0.30, true, '6 Months', 'LOW'),
  (8, 300000, 126000, 0.30, true, '8 Months', 'MODERATE'), (10, 600000, 252000, 0.30, true, '10 Months', 'HIGH'),
  (12, 1000000, 420000, 0.30, true, '12 Months', 'CRITICAL');
INSERT INTO public.shipping_rates (country, min_subtotal_jpy, fee_jpy, is_active) VALUES
  ('JP', 0, 800, true), ('JP', 8000, 0, true), ('PH', 0, 3500, false), ('PH', 100000, 0, false);
INSERT INTO public.shipping_methods (provider_name, title, tracking_url_template) VALUES
  ('Pabitbit', 'Pabitbit Service', 'https://www.lbcexpress.com/track/?tracking_no={tracking_code}');
INSERT INTO public.role_permissions (role, permission_key, is_allowed) VALUES
  ('staff', 'confirm_web_order_ready', true), ('staff', 'create_cash_order', true), ('staff', 'create_account', true),
  ('csr', 'confirm_web_order_ready', true), ('csr', 'create_cash_order', true), ('csr', 'create_account', false),
  ('finance', 'confirm_web_order_ready', false);

-- Live bodies, verbatim from the newest repo copy (drift audit 2026-09-29: 0 differences).
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _user_id IS NULL THEN false
    WHEN public.has_role(_user_id, 'admin'::public.app_role) THEN true
    ELSE COALESCE(
      (SELECT o.granted
         FROM public.user_permission_overrides o
        WHERE o.user_id = _user_id
          AND o.permission_key = _permission_key
        LIMIT 1),
      (SELECT bool_or(rp.is_allowed)
         FROM public.role_permissions rp
         JOIN public.user_roles ur ON ur.role = rp.role
        WHERE ur.user_id = _user_id
          AND rp.permission_key = _permission_key),
      false)
  END
$$;

CREATE OR REPLACE FUNCTION public.address_snapshot(p_address_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SET search_path TO 'public' AS $function$
  SELECT jsonb_build_object(
    'address_id',     a.id,
    'label',          a.label,
    'recipient_name', a.recipient_name,
    'line1',          a.line1,
    'line2',          a.line2,
    'city',           a.city,
    'region',         a.region,
    'postal_code',    a.postal_code,
    'country',        a.country,
    'phone',          a.phone,
    'captured_at',    now()
  )
  FROM public.customer_addresses a
  WHERE a.id = p_address_id;
$function$;

CREATE OR REPLACE FUNCTION public.staff_notify(p_type text, p_title text, p_body text, p_account_id uuid, p_customer_id uuid, p_invoice text, p_meta jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  INSERT INTO public.staff_notifications (type, title, body, account_id, customer_id, invoice_number, metadata)
  VALUES (p_type, p_title, p_body, p_account_id, p_customer_id, p_invoice, p_meta)
$function$;

CREATE OR REPLACE FUNCTION public.staff_display_name(p_user_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE((SELECT full_name FROM public.profiles WHERE user_id = p_user_id), 'Unknown')
$function$;

CREATE OR REPLACE FUNCTION public.notify_money_label(p_amount numeric, p_currency text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE WHEN upper(coalesce(p_currency,'JPY')) = 'PHP' THEN '₱' ELSE '¥' END
      || to_char(round(coalesce(p_amount,0)), 'FM999,999,999,999');
$$;

CREATE OR REPLACE FUNCTION public.notify_deadline_label(p_at timestamptz)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT CASE
    WHEN p_at IS NULL THEN 'no deposit deadline set'
    ELSE 'deposit by ' || to_char(p_at AT TIME ZONE 'Asia/Manila', 'Mon FMDD HH24:MI') || ' PHT'
  END;
$$;

CREATE FUNCTION public.layaway_quote(
  p_price        integer,
  p_term_months  integer,
  p_currency     text,
  p_order_date   date    DEFAULT CURRENT_DATE,
  p_shipping     integer DEFAULT 0,
  p_services     integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_currency text := upper(coalesce(p_currency, 'JPY'));
  v_price    integer := coalesce(p_price, 0);
  v_shipping integer := greatest(coalesce(p_shipping, 0), 0);
  v_services integer := greatest(coalesce(p_services, 0), 0);
  v_total    integer;
  v_terms    jsonb;
  v_term     integer;
  v_label    text;
  v_dp_pct   numeric;
  v_deposit  integer;
  v_base     integer;
  v_rem      integer;
  v_schedule jsonb := '[]'::jsonb;
  v_max      integer;
  n          integer;
BEGIN
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION 'invalid price';
  END IF;
  IF v_currency NOT IN ('JPY', 'PHP') THEN
    RAISE EXCEPTION 'invalid currency';
  END IF;

  v_total := v_price + v_shipping + v_services;

  -- Every configured term, with the minimum that applies to THIS currency and
  -- whether this order clears it. The storefront renders exactly this list, so
  -- it can no longer offer a term the DB trigger would refuse.
  SELECT jsonb_agg(
           jsonb_build_object(
             'months',        pc.plan_months,
             'label',         pc.display_label,
             'min_amount',    CASE WHEN v_currency = 'JPY' THEN pc.min_amount_jpy ELSE pc.min_amount_php END,
             'dp_percentage', pc.dp_percentage,
             'eligible',      v_total >= CASE WHEN v_currency = 'JPY' THEN pc.min_amount_jpy ELSE pc.min_amount_php END
           ) ORDER BY pc.plan_months
         )
    INTO v_terms
    FROM plan_configurations pc
   WHERE pc.is_active;
  v_terms := coalesce(v_terms, '[]'::jsonb);

  -- The requested term if it is configured AND this order clears its minimum;
  -- otherwise the longest term the order does clear (3M has no minimum, so in
  -- practice there is always one).
  SELECT pc.plan_months, pc.display_label, pc.dp_percentage
    INTO v_term, v_label, v_dp_pct
    FROM plan_configurations pc
   WHERE pc.is_active
     AND pc.plan_months = p_term_months
     AND v_total >= CASE WHEN v_currency = 'JPY' THEN pc.min_amount_jpy ELSE pc.min_amount_php END;

  IF v_term IS NULL THEN
    SELECT pc.plan_months, pc.display_label, pc.dp_percentage
      INTO v_term, v_label, v_dp_pct
      FROM plan_configurations pc
     WHERE pc.is_active
       AND v_total >= CASE WHEN v_currency = 'JPY' THEN pc.min_amount_jpy ELSE pc.min_amount_php END
     ORDER BY pc.plan_months DESC
     LIMIT 1;
  END IF;

  SELECT max((t->>'months')::integer) INTO v_max
    FROM jsonb_array_elements(v_terms) t
   WHERE (t->>'eligible')::boolean;

  IF v_term IS NULL THEN
    -- Nothing is sellable at this amount. Say so plainly instead of quoting.
    RETURN jsonb_build_object(
      'currency', v_currency, 'price', v_price, 'shipping', v_shipping, 'services', v_services,
      'total', v_total, 'deposit', 0, 'down_payment', 0, 'term_months', NULL, 'monthly', 0,
      'max_term_months', v_max, 'allowed_terms', v_terms, 'schedule', '[]'::jsonb,
      'requested_term_months', p_term_months, 'term_downgraded', true,
      'order_date', p_order_date, 'eligible', false
    );
  END IF;

  -- DEPOSIT = dp_percentage of the TOTAL (product + shipping + services).
  -- Owner decision 2026-09-13. The loyalty base is a DIFFERENT figure — the
  -- product amount only, in yen — and is set by the caller, never here.
  v_deposit := round(v_total * v_dp_pct);

  -- Hub rounding: floor, remainder on the LAST row
  -- (create-layaway-account/index.ts:190-191). Never round() per row.
  v_base := floor((v_total - v_deposit)::numeric / v_term);
  v_rem  := (v_total - v_deposit) - (v_base * v_term);

  FOR n IN 1..v_term LOOP
    v_schedule := v_schedule || jsonb_build_object(
      'installment_number', n,
      -- n months from the ORIGINAL order date; Postgres clamps month-end.
      'due_date', (p_order_date + make_interval(months => n))::date,
      'amount', v_base + CASE WHEN n = v_term THEN v_rem ELSE 0 END
    );
  END LOOP;

  RETURN jsonb_build_object(
    'currency',        v_currency,
    'price',           v_price,
    'shipping',        v_shipping,
    'services',        v_services,
    'total',           v_total,
    'deposit',         v_deposit,
    'down_payment',    v_deposit,   -- legacy key: the live calculator reads this
    'term_months',     v_term,
    'term_label',      v_label,
    -- What the caller ASKED for, and whether this quote is that term. A
    -- browsing calculator may happily show the shorter plan the basket can
    -- actually have; a WRITE path must refuse rather than create a plan the
    -- customer never agreed to. create_web_layaway_atomic checks this.
    'requested_term_months', p_term_months,
    'term_downgraded',       (v_term IS DISTINCT FROM p_term_months),
    'monthly',         v_base,      -- legacy key: base instalment, not the last row
    'last_month',      v_base + v_rem,
    'max_term_months', v_max,
    'allowed_terms',   v_terms,
    'schedule',        v_schedule,
    'order_date',      p_order_date,
    'eligible',        true
  );
END $$;

CREATE OR REPLACE FUNCTION public.enforce_plan_minimum_amount()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_min_jpy     numeric;
  v_min_php     numeric;
  v_label       text;
BEGIN
  IF NEW.payment_plan_months IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT min_amount_jpy, min_amount_php, display_label
  INTO v_min_jpy, v_min_php, v_label
  FROM plan_configurations
  WHERE plan_months = NEW.payment_plan_months;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Plan duration % months is not configured. Add it to plan_configurations first.',
      NEW.payment_plan_months;
  END IF;

  -- 3M and 6M have min = 0, trigger passes through immediately
  IF NEW.currency = 'JPY' AND v_min_jpy > 0 THEN
    IF NEW.total_amount < v_min_jpy THEN
      RAISE EXCEPTION
        '% plan requires a minimum order of ¥%. Submitted amount is ¥%.',
        v_label,
        TO_CHAR(v_min_jpy,     'FM999,999,999'),
        TO_CHAR(NEW.total_amount, 'FM999,999,999');
    END IF;
  END IF;

  IF NEW.currency = 'PHP' AND v_min_php > 0 THEN
    IF NEW.total_amount < v_min_php THEN
      RAISE EXCEPTION
        '% plan requires a minimum order of ₱%. Submitted amount is ₱%.',
        v_label,
        TO_CHAR(v_min_php,      'FM999,999,999'),
        TO_CHAR(NEW.total_amount, 'FM999,999,999');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_web_order_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.source_channel = 'web' THEN
    RAISE EXCEPTION 'web_order_delete_forbidden: % is a web order — cancel it, never delete it (order history, stock hold and points reversal depend on the row)',
      COALESCE(OLD.web_reference, OLD.invoice_number)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_web_layaway_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.source_channel = 'web' THEN
    RAISE EXCEPTION 'web_layaway_delete_forbidden: % is a web layaway — it expires or runs its lifecycle, it is never deleted',
      COALESCE(OLD.web_reference, OLD.invoice_number)
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION public.notify_cash_order_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_who text;
BEGIN
  BEGIN
    IF NEW.source_channel = 'web' AND NEW.ready_confirmed_at IS NULL THEN
      -- RESERVE-FIRST (A2): see notify_account_created.
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'New reservation — confirm the piece',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' paid in full · no payment deadline until confirmed · auto-cancels after 72 hours',
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'cash_order_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'reservation', true)
      );
    ELSIF NEW.source_channel = 'web' THEN
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'Website order placed',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' paid in full · ' || public.notify_deadline_label(NEW.transfer_due_at),
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'cash_order_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'transfer_due_at', NEW.transfer_due_at)
      );
    ELSE
      -- Unchanged.
      PERFORM public.staff_notify(
        'account_created', 'Cash order created',
        'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
        NULL, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object('cash_order_id', NEW.id)
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.notify_account_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_who text;
BEGIN
  BEGIN
    IF NEW.source_channel = 'web' AND NEW.ready_confirmed_at IS NULL THEN
      -- RESERVE-FIRST (A2): no deadline exists yet, so none is named. The
      -- title is the instruction: nothing happens for the customer until a
      -- member of staff confirms the piece.
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'New reservation — confirm the piece',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · layaway ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' over ' || COALESCE(NEW.payment_plan_months::text, '?') || ' months'
          || ' · no payment deadline until confirmed · auto-cancels after 72 hours',
        NEW.id, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'layaway_account_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'downpayment_amount', NEW.downpayment_amount,
          'reservation', true)
      );
    ELSIF NEW.source_channel = 'web' THEN
      v_who := COALESCE(
        (SELECT NULLIF(btrim(c.full_name), '') FROM public.customers c WHERE c.id = NEW.customer_id),
        'a website customer');
      PERFORM public.staff_notify(
        'account_created', 'Website layaway placed',
        COALESCE(NEW.web_reference, NEW.invoice_number, '?') || ' · ' || v_who
          || ' · ' || public.notify_money_label(NEW.total_amount, NEW.currency::text)
          || ' over ' || COALESCE(NEW.payment_plan_months::text, '?') || ' months · '
          || public.notify_deadline_label(NEW.transfer_due_at),
        NEW.id, NEW.customer_id, NEW.invoice_number,
        jsonb_build_object(
          'layaway_account_id', NEW.id,
          'source_channel', 'web',
          'web_reference', NEW.web_reference,
          'currency', NEW.currency::text,
          'total_amount', NEW.total_amount,
          'downpayment_amount', NEW.downpayment_amount,
          'transfer_due_at', NEW.transfer_due_at)
      );
    ELSE
      -- Unchanged from the baseline.
      PERFORM public.staff_notify(
        'account_created', 'Account created',
        'Inv #' || COALESCE(NEW.invoice_number,'?') || ' created by ' || public.staff_display_name(NEW.created_by_user_id),
        NEW.id, NEW.customer_id, NEW.invoice_number, '{}'::jsonb
      );
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.page365_web_holds(p_variant_id uuid)
RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT (
    coalesce((SELECT sum(i.quantity) FROM public.cash_order_items i
                JOIN public.cash_orders o ON o.id = i.cash_order_id
               WHERE i.variant_id = p_variant_id AND o.source_channel = 'web' AND o.status = 'pending'), 0)
  + coalesce((SELECT sum(i.quantity) FROM public.layaway_account_items i
                JOIN public.layaway_accounts a ON a.id = i.account_id
               WHERE i.variant_id = p_variant_id AND a.source_channel = 'web' AND a.stock_released_at IS NULL
                 AND a.status IN ('active','overdue') AND coalesce(a.total_paid, 0) = 0), 0)
  )::integer
$fn$;

CREATE OR REPLACE FUNCTION public.email_delivery_report(p_hours integer DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(hours => GREATEST(1, COALESCE(p_hours, 24)));
  v_expected jsonb;
  v_expected_total integer;
  v_sent integer; v_failed integer; v_suppressed integer;
  v_last_sent timestamptz; v_first_fail timestamptz; v_last_fail timestamptz;
  v_streak_start timestamptz; v_newest_error text; v_newest_request_id text;
  v_sf_sent integer; v_sf_failed integer;
BEGIN
  -- Staff only. Customers hold authenticated sessions too, so the role check
  -- lives inside the function, not in the grant.
  IF auth.uid() IS NOT NULL AND NOT (
       public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'finance')
    OR public.has_role(auth.uid(), 'staff') OR public.has_role(auth.uid(), 'csr')) THEN
    RAISE EXCEPTION 'staff role required' USING ERRCODE = '42501';
  END IF;

  -- Events that each produce one customer email. Test customers excluded.
  SELECT jsonb_build_object(
    'payment_reminders', (SELECT count(*) FROM reminder_logs rl JOIN customers c ON c.id = rl.customer_id
                            WHERE rl.created_at >= v_since AND NOT c.is_test),
    'layaway_payment_confirmations', (SELECT count(*) FROM payments p JOIN layaway_accounts la ON la.id = p.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE p.created_at >= v_since AND p.voided_at IS NULL AND NOT c.is_test AND la.invoice_number ~ '^[0-9]+$'),
    'cash_payment_confirmations', (SELECT count(*) FROM cash_payments cp JOIN cash_orders co ON co.id = cp.cash_order_id JOIN customers c ON c.id = co.customer_id
                            WHERE cp.created_at >= v_since AND cp.voided_at IS NULL AND NOT c.is_test),
    'portal_submission_acknowledgements', (SELECT count(*) FROM payment_submissions ps JOIN customers c ON c.id = ps.customer_id
                            WHERE ps.created_at >= v_since AND ps.portal_token IS NOT NULL AND NOT c.is_test),
    'payment_rejections', (SELECT count(*) FROM payment_submissions ps JOIN customers c ON c.id = ps.customer_id
                            WHERE ps.status = 'rejected' AND ps.updated_at >= v_since AND NOT c.is_test),
    'penalties_applied', (SELECT count(*) FROM penalty_fees f JOIN layaway_accounts la ON la.id = f.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE f.created_at >= v_since AND NOT c.is_test),
    'waivers_approved', (SELECT count(*) FROM penalty_waiver_requests w JOIN layaway_accounts la ON la.id = w.account_id JOIN customers c ON c.id = la.customer_id
                            WHERE w.approved_at >= v_since AND NOT c.is_test),
    'accounts_forfeited', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.forfeited_at >= v_since AND NOT c.is_test),
    'loyalty_events', (SELECT count(*) FROM loyalty_transactions x JOIN loyalty_members m ON m.id = x.member_id JOIN customers c ON c.id = m.customer_id
                            WHERE x.created_at >= v_since AND NOT c.is_test AND x.transaction_type IN ('earned','expired','redeemed','tier_changed','bonus','birthday_bonus')),
    'loyalty_pre_expiry_warnings', (SELECT count(*) FROM loyalty_members m JOIN customers c ON c.id = m.customer_id
                            WHERE m.pre_expiry_warned_at >= v_since AND NOT c.is_test),
    'web_orders_placed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.created_at >= v_since AND co.source_channel = 'web' AND NOT c.is_test),
    'web_orders_closed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.source_channel = 'web' AND NOT c.is_test
                              AND (co.cancelled_at >= v_since OR co.expired_at >= v_since)),
    -- RESERVE-FIRST (A2), 2026-09-24.
    'web_layaways_placed', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.created_at >= v_since AND la.source_channel = 'web' AND NOT c.is_test),
    'web_reservations_confirmed', (SELECT count(*) FROM cash_orders co JOIN customers c ON c.id = co.customer_id
                            WHERE co.source_channel = 'web' AND co.ready_confirmed_by IS NOT NULL
                              AND co.ready_confirmed_at >= v_since AND NOT c.is_test)
                          + (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.source_channel = 'web' AND la.ready_confirmed_by IS NOT NULL
                              AND la.ready_confirmed_at >= v_since AND NOT c.is_test),
    'web_layaways_closed', (SELECT count(*) FROM layaway_accounts la JOIN customers c ON c.id = la.customer_id
                            WHERE la.source_channel = 'web' AND NOT c.is_test
                              AND (la.expired_at >= v_since
                                   OR EXISTS (SELECT 1 FROM audit_logs al
                                               WHERE al.entity_type = 'layaway_account' AND al.entity_id = la.id
                                                 AND al.action IN ('web_layaway_reservation_declined', 'web_layaway_reservation_expired')
                                                 AND al.created_at >= v_since)))
  ) INTO v_expected;

  SELECT COALESCE(sum((value)::integer), 0) INTO v_expected_total FROM jsonb_each_text(v_expected);

  SELECT count(*) FILTER (WHERE status = 'sent'),
         count(*) FILTER (WHERE status IN ('failed','dlq')),
         count(*) FILTER (WHERE status = 'suppressed'),
         max(created_at) FILTER (WHERE status = 'sent'),
         min(created_at) FILTER (WHERE status IN ('failed','dlq')),
         max(created_at) FILTER (WHERE status IN ('failed','dlq')),
         count(*) FILTER (WHERE status = 'sent' AND channel = 'storefront'),
         count(*) FILTER (WHERE status IN ('failed','dlq') AND channel = 'storefront')
    INTO v_sent, v_failed, v_suppressed, v_last_sent, v_first_fail, v_last_fail, v_sf_sent, v_sf_failed
    FROM email_send_log WHERE created_at >= v_since;

  -- Current refusal streak: first failure after the newest accepted send,
  -- across the whole log (not just the window), so a nine-day outage shows
  -- its true start date.
  SELECT min(created_at) INTO v_streak_start FROM email_send_log
   WHERE status IN ('failed','dlq')
     AND created_at > COALESCE((SELECT max(created_at) FROM email_send_log WHERE status = 'sent'), '-infinity'::timestamptz);

  SELECT left(error_message, 400), request_id INTO v_newest_error, v_newest_request_id
    FROM email_send_log WHERE status IN ('failed','dlq') ORDER BY created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'window_hours', GREATEST(1, COALESCE(p_hours, 24)),
    'since', v_since,
    'generated_at', now(),
    'expected', v_expected,
    'expected_total', v_expected_total,
    'sent', v_sent,
    'failed', v_failed,
    'suppressed', v_suppressed,
    'storefront', jsonb_build_object('sent', v_sf_sent, 'failed', v_sf_failed),
    'last_sent_at', (SELECT max(created_at) FROM email_send_log WHERE status = 'sent'),
    'last_sent_in_window_at', v_last_sent,
    'first_failure_in_window_at', v_first_fail,
    'last_failure_at', v_last_fail,
    'refusal_streak_started_at', v_streak_start,
    'newest_error', v_newest_error,
    'newest_request_id', v_newest_request_id,
    -- verdict: refused = attempts refused and nothing accepted; silent = events
    -- happened but no attempt was even logged (a sender is bypassing the log);
    -- degraded = some refused, some accepted; ok otherwise.
    'status', CASE
      WHEN v_failed > 0 AND v_sent = 0 THEN 'refused'
      WHEN v_expected_total > 0 AND v_sent = 0 AND v_failed = 0 THEN 'silent'
      WHEN v_failed > 0 THEN 'degraded'
      ELSE 'ok' END
  );
END;
$$;

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

CREATE TRIGGER trg_enforce_plan_minimum BEFORE INSERT OR UPDATE OF payment_plan_months, total_amount, currency ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_minimum_amount();
CREATE TRIGGER trg_prevent_web_order_delete BEFORE DELETE ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION public.prevent_web_order_delete();
CREATE TRIGGER trg_prevent_web_layaway_delete BEFORE DELETE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION public.prevent_web_layaway_delete();
CREATE TRIGGER trg_notify_cash_order_created AFTER INSERT ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION public.notify_cash_order_created();
CREATE TRIGGER trg_notify_account_created AFTER INSERT ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION public.notify_account_created();

-- The stub's own proof that these ARE the live bodies (md5 of prosrc, 2026-09-29).
DO $live$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.page365_web_holds(uuid)'::regprocedure)) <> '6417708e3c92f960abb519fca2daea5b'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.email_delivery_report(integer)'::regprocedure)) <> 'c5e8e93e89c8edc2cdcfc9383880360a'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.web_reservation_expiring_bells()'::regprocedure)) <> '0909b5efefdac33ea37d9d0078e7850c'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.layaway_quote(integer,integer,text,date,integer,integer)'::regprocedure)) <> 'ad4606c0da7511e7070138520d8d7907'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.address_snapshot(uuid)'::regprocedure)) <> '5ddd1e6506b205f92ac133c31f824a07'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.has_permission(uuid,text)'::regprocedure)) <> '24c4d3a5df13957837f8158ac6ce2d84' THEN
    RAISE EXCEPTION 'stub: a copied body is not the live body';
  END IF;
END
$live$;

