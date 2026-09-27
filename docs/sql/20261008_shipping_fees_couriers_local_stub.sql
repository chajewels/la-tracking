-- ============================================================================
-- Shipping fees card + couriers (website-orders PR 2) — LOCAL test stub
-- (2026-09-27). NEVER RUN THIS ON LIVE: it DROPS schema public.
--
-- Builds, in an EMPTY throwaway Postgres, only what migration
-- 20261008100000_shipping_fees_couriers.sql reads: shipping_rates exactly as
-- 20260911120000_phase2_step2_checkout.sql creates and SEEDS it (so the
-- rebuild path is exercised: JP 50000 → 0 is present), shipping_methods with
-- the five seeded couriers of 20260830000000_shipment_tracking.sql, minimal
-- cash_orders / layaway_accounts, audit_logs, user_roles + has_role, and
-- auth.uid() from a GUC.
--
--   initdb -D /tmp/shipfees --locale=C -E UTF8 -U postgres
--   pg_ctl -D /tmp/shipfees -o "-p 55462 -k /tmp" start
--   export PGOPTIONS='-c shipfees.local_stub=yes'
--   P="psql -h /tmp -p 55462 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20261008_shipping_fees_couriers_local_stub.sql
--   $P supabase/migrations/20261008100000_shipping_fees_couriers.sql
--   $P supabase/migrations/20261008100000_shipping_fees_couriers.sql   # re-run is safe
--   $P docs/sql/20261008_shipping_fees_couriers_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('shipfees.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c shipfees.local_stub=yes'' — this file drops schema public';
  END IF;
  IF to_regclass('public.payments') IS NOT NULL OR to_regclass('public.layaway_schedule') IS NOT NULL THEN
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
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

CREATE TYPE public.app_role AS ENUM ('admin','staff','finance','csr','live_agent');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- audit_logs, live shape (baseline 20260705230000:221-230).
CREATE TABLE public.audit_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL,
  old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid,
  created_at timestamptz DEFAULT now() NOT NULL);

-- shipping_rates, verbatim from 20260911120000_phase2_step2_checkout.sql §5,
-- including the seed — the state a rebuild from the repo reaches.
CREATE TABLE public.shipping_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country text NOT NULL,
  min_subtotal_jpy integer NOT NULL DEFAULT 0 CHECK (min_subtotal_jpy >= 0),
  fee_jpy integer NOT NULL CHECK (fee_jpy >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, min_subtotal_jpy));
CREATE TRIGGER trg_shipping_rates_updated_at BEFORE UPDATE ON public.shipping_rates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
GRANT ALL ON public.shipping_rates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.shipping_rates TO authenticated;
INSERT INTO public.shipping_rates (country, min_subtotal_jpy, fee_jpy)
VALUES ('JP', 0, 800), ('JP', 50000, 0), ('PH', 0, 3500), ('PH', 100000, 0)
ON CONFLICT (country, min_subtotal_jpy) DO NOTHING;

-- shipping_methods, shape and seed from 20260830000000_shipment_tracking.sql.
CREATE TABLE public.shipping_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_name text NOT NULL, title text NOT NULL, tracking_url_template text NOT NULL,
  supports_deeplink boolean GENERATED ALWAYS AS (tracking_url_template LIKE '%{tracking_code}%') STORED,
  is_active boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0, notes text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipping_methods_provider_title_key UNIQUE (provider_name, title));
INSERT INTO public.shipping_methods (provider_name, title, tracking_url_template, sort_order) VALUES
  ('Japan Post', 'Japan Post — EMS (International)', 'https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1={tracking_code}&searchKind=S004&locale=en', 1),
  ('LBC', 'LBC Express (PH Domestic)', 'https://www.lbcexpress.com/ph/track/{tracking_code}', 2),
  ('Japan Post', 'Japan Post — Yu-Pack (Domestic JP)', 'https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1={tracking_code}&searchKind=S002&locale=en', 3),
  ('DHL', 'DHL Express', 'https://www.dhl.com/jp-en/home/tracking.html', 4),
  ('Yamato', 'Yamato Transport (Domestic JP)', 'https://track.kuronekoyamato.co.jp/english/tracking', 5);

CREATE TABLE public.cash_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text,
  shipping_method_id uuid REFERENCES public.shipping_methods(id));
CREATE TABLE public.layaway_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text,
  shipping_method_id uuid REFERENCES public.shipping_methods(id));
INSERT INTO public.cash_orders (invoice_number) VALUES ('900001');
INSERT INTO public.layaway_accounts (invoice_number) VALUES ('19001');

-- PGOPTIONS='-c shipfees.local_stub=yes -c shipfees.as_live=yes' replays the
-- owner's 2026-09 SQL Editor fix, so the migration runs against LIVE's card
-- (JP 8000 → 0 already, no 50000 row) instead of a fresh rebuild.
DO $live$ BEGIN
  IF coalesce(current_setting('shipfees.as_live', true), '') = 'yes' THEN
    UPDATE public.shipping_rates SET min_subtotal_jpy = 8000
     WHERE country = 'JP' AND min_subtotal_jpy = 50000 AND fee_jpy = 0;
  END IF;
END $live$;
