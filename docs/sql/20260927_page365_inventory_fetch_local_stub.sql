-- ============================================================================
-- Page365 inventory fetch — LOCAL test stub (2026-09-27). NEVER RUN THIS ON LIVE.
--
-- Runs AFTER the #195 stub and migration, and adds only what migration
-- 20260927100000_page365_inventory_fetch.sql reads on top of them: product
-- name, variant price, website_product_media, the order item tables, the
-- web-hold columns and system_settings. Same opt-in guard as the #195 stub.
--
--   initdb -D /tmp/p365inv && pg_ctl -D /tmp/p365inv -o "-p 55433" start
--   export PGOPTIONS='-c page365.local_stub=yes'
--   P="psql -p 55433 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20260926_page365_stock_sync_local_stub.sql
--   $P supabase/migrations/20260926120000_page365_stock_sync.sql
--   $P docs/sql/20260927_page365_inventory_fetch_local_stub.sql
--   $P supabase/migrations/20260927100000_page365_inventory_fetch.sql
--   $P supabase/migrations/20260927100000_page365_inventory_fetch.sql   # re-run is safe
--   $P docs/sql/20260927_page365_inventory_fetch_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('page365.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c page365.local_stub=yes''';
  END IF;
  IF to_regclass('public.customers') IS NOT NULL OR to_regclass('public.payments') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
  IF to_regclass('public.page365_stock_lines') IS NULL THEN
    RAISE EXCEPTION 'Run the #195 stub and migration first';
  END IF;
END
$guard$;

ALTER TABLE public.website_products ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE public.website_product_variants ADD COLUMN IF NOT EXISTS price_jpy integer;
ALTER TABLE public.layaway_accounts ADD COLUMN IF NOT EXISTS stock_released_at timestamptz;

CREATE TABLE IF NOT EXISTS public.website_product_media (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.website_product_variants(id) ON DELETE CASCADE,
  url text NOT NULL, alt text, sort integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
DROP TRIGGER IF EXISTS trg_website_media_revalidate ON public.website_product_media;
CREATE TRIGGER trg_website_media_revalidate AFTER INSERT OR UPDATE OR DELETE ON public.website_product_media
  FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();

CREATE TABLE IF NOT EXISTS public.cash_order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_order_id uuid NOT NULL REFERENCES public.cash_orders(id) ON DELETE CASCADE, variant_id uuid, quantity integer NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS public.layaway_account_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.layaway_accounts(id) ON DELETE CASCADE, variant_id uuid, quantity integer NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS public.system_settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, value jsonb);

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
