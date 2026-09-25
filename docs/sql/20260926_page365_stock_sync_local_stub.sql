-- ============================================================================
-- Page365 stock sync — LOCAL test stub (2026-09-26). NEVER RUN THIS ON LIVE.
--
-- It DROPS SCHEMA public and rebuilds a minimal stand-in for the tables
-- migration 20260926120000_page365_stock_sync.sql touches, so the migration and
-- docs/sql/20260926_page365_stock_sync_local_tests.sql can run on a throwaway
-- Postgres 16. It refuses to run unless you opt in AND the database looks empty
-- of Hub tables:
--
--   initdb -D /tmp/p365 && pg_ctl -D /tmp/p365 -o "-p 55432" start
--   export PGOPTIONS='-c page365.local_stub=yes'
--   psql -p 55432 -U postgres -v ON_ERROR_STOP=1 -f docs/sql/20260926_page365_stock_sync_local_stub.sql
--   psql -p 55432 -U postgres -v ON_ERROR_STOP=1 -f supabase/migrations/20260926120000_page365_stock_sync.sql
--   psql -p 55432 -U postgres -v ON_ERROR_STOP=1 -f docs/sql/20260926_page365_stock_sync_local_tests.sql
--
-- Last run by Claude Code on 2026-09-25 (PG 16.14): migration applied twice
-- cleanly, 80/80 checks passed, plus a two-session concurrency check (stock
-- 5 -> 3 once; the second caller saw already_claimed = 1).
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('page365.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c page365.local_stub=yes'' — this file drops schema public';
  END IF;
  IF to_regclass('public.customers') IS NOT NULL OR to_regclass('public.layaway_schedule') IS NOT NULL
     OR to_regclass('public.payments') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
END
$guard$;
DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA public; CREATE SCHEMA auth;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;

CREATE TYPE public.cash_order_status AS ENUM ('pending','completed','cancelled','expired');
CREATE TYPE public.account_status AS ENUM ('active','overdue','completed','cancelled','forfeited','final_forfeited','extension_active','reactivated','final_settlement');

CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.perm (user_id uuid, key text);
CREATE FUNCTION public.is_staff(_user_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role IN ('admin','staff','finance','csr')) $$;
CREATE FUNCTION public.has_permission(_user_id uuid, _permission_key text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public
AS $$ SELECT EXISTS (SELECT 1 FROM public.perm WHERE user_id=_user_id AND key=_permission_key) $$;

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TABLE public.revalidations (at timestamptz DEFAULT clock_timestamp(), tbl text);
CREATE FUNCTION public.notify_website_revalidate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.revalidations(tbl) VALUES (TG_TABLE_NAME); RETURN NULL; END $$;

CREATE TABLE public.website_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text UNIQUE NOT NULL, status text NOT NULL DEFAULT 'draft',
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.website_product_variants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.website_products(id) ON DELETE CASCADE,
  stock_qty integer NOT NULL DEFAULT 0 CHECK (stock_qty >= 0), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER trg_website_variants_updated_at BEFORE UPDATE ON public.website_product_variants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_website_variants_revalidate AFTER INSERT OR UPDATE OR DELETE ON public.website_product_variants FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();

CREATE TABLE public.cash_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text NOT NULL, customer_id uuid NOT NULL,
  status public.cash_order_status NOT NULL DEFAULT 'pending', page365_no bigint, source_channel text NOT NULL DEFAULT 'hub', total_paid numeric DEFAULT 0);
CREATE UNIQUE INDEX uq_cash_orders_page365_no ON public.cash_orders(page365_no) WHERE page365_no IS NOT NULL;
CREATE TABLE public.layaway_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), invoice_number text NOT NULL, customer_id uuid NOT NULL,
  status public.account_status NOT NULL DEFAULT 'active', page365_no bigint, source_channel text NOT NULL DEFAULT 'hub', total_paid numeric DEFAULT 0);
CREATE UNIQUE INDEX uq_layaway_accounts_page365_no ON public.layaway_accounts(page365_no) WHERE page365_no IS NOT NULL;
-- the live paid-order delete guard, so a refused delete must not move stock
CREATE FUNCTION public.prevent_paid_order_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF OLD.total_paid > 0 THEN RAISE EXCEPTION 'paid_order_delete_forbidden'; END IF; RETURN OLD; END $$;
CREATE TRIGGER trg_prevent_paid_cash_order_delete BEFORE DELETE ON public.cash_orders FOR EACH ROW EXECUTE FUNCTION public.prevent_paid_order_delete();
CREATE TRIGGER trg_prevent_paid_layaway_delete BEFORE DELETE ON public.layaway_accounts FOR EACH ROW EXECUTE FUNCTION public.prevent_paid_order_delete();

CREATE TABLE public.page365_drafts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), page365_no bigint NOT NULL, payload jsonb NOT NULL);
CREATE TABLE public.staff_notifications (id uuid DEFAULT gen_random_uuid(), type text NOT NULL, title text NOT NULL, body text,
  account_id uuid, customer_id uuid, invoice_number text, metadata jsonb DEFAULT '{}'::jsonb NOT NULL, created_at timestamptz DEFAULT now());
CREATE TABLE public.audit_logs (id uuid DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL, action text NOT NULL,
  old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid, created_at timestamptz DEFAULT now());
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
