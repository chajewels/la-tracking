-- ============================================================================
-- Page365 follow + Catalog delete (2026-10-29) — LOCAL stub. Local Postgres
-- ONLY, never live. Adds what the earlier Page365 stubs do not have and the
-- migration touches: the live-claim / review / cart / draft-line tables, the
-- website_product_id columns on the order item tables, and a no-op
-- assert_staff_caller. Run after the stubs and every earlier Page365 migration
-- (through 20270215100000), BEFORE the seed and the migration:
--
--   initdb -D /tmp/p365follow --locale=C -E UTF8 -U postgres && pg_ctl -D /tmp/p365follow -o "-p 55477 -k /tmp" start
--   export PGOPTIONS='-c page365.local_stub=yes'
--   P() { psql -q -h /tmp -p 55477 -U postgres -v ON_ERROR_STOP=1 -f "$1"; }
--   (the stubs + migrations of docs/sql/20261001_page365_hide_follow_local_stub.sql, then
--    20261002100000, 20261003100000, 20261005100000, 20270215100000)
--   P docs/sql/20270220_page365_follow_local_stub.sql
--   P docs/sql/20270220_page365_follow_local_seed.sql
--   P supabase/migrations/20270220100000_page365_follow_and_catalog_delete.sql
--   P supabase/migrations/20270220100000_page365_follow_and_catalog_delete.sql   # re-run is safe
--   P supabase/migrations/20270221100000_page365_follow_recode_name.sql          # 2026-10-29 fix: code + name changed in one edit
--   P supabase/migrations/20270221100000_page365_follow_recode_name.sql          # re-run is safe
--   P docs/sql/20270220_page365_follow_local_tests.sql
-- ============================================================================
\set ON_ERROR_STOP 1
DO $$ BEGIN
  IF current_setting('page365.local_stub', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'local stub: refusing to run (set PGOPTIONS=-c page365.local_stub=yes)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.assert_staff_caller(p_permission text DEFAULT NULL) RETURNS void
LANGUAGE sql STABLE AS $$ SELECT $$;

DO $$ BEGIN CREATE TYPE public.website_claim_status AS ENUM ('held','paid','layaway','expired','released');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.website_live_claims (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text,
  product_variant_id uuid NOT NULL REFERENCES public.website_product_variants(id),
  customer_id uuid, csr_id uuid, price_locked integer, status public.website_claim_status NOT NULL DEFAULT 'held',
  expires_at timestamptz);

CREATE TABLE IF NOT EXISTS public.product_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_product_id uuid REFERENCES public.website_products(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'approved', body_original text, rating integer);
CREATE TABLE IF NOT EXISTS public.product_review_products (
  review_id uuid NOT NULL REFERENCES public.product_reviews(id) ON DELETE CASCADE,
  website_product_id uuid NOT NULL REFERENCES public.website_products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (review_id, website_product_id));
CREATE TABLE IF NOT EXISTS public.customer_cart_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.website_product_variants(id) ON DELETE CASCADE, quantity integer DEFAULT 1);
CREATE TABLE IF NOT EXISTS public.web_order_draft_lines (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid REFERENCES public.website_product_variants(id) ON DELETE SET NULL,
  website_product_id uuid REFERENCES public.website_products(id) ON DELETE SET NULL,
  code text, name text, unit_price integer);

-- Live: the order item tables carry website_product_id (SET NULL) and a saved code / name / price.
ALTER TABLE public.cash_order_items ADD COLUMN IF NOT EXISTS website_product_id uuid REFERENCES public.website_products(id) ON DELETE SET NULL;
ALTER TABLE public.cash_order_items ADD COLUMN IF NOT EXISTS code text, ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS unit_price integer;
ALTER TABLE public.layaway_account_items ADD COLUMN IF NOT EXISTS website_product_id uuid REFERENCES public.website_products(id) ON DELETE SET NULL;
ALTER TABLE public.layaway_account_items ADD COLUMN IF NOT EXISTS code text, ADD COLUMN IF NOT EXISTS name text, ADD COLUMN IF NOT EXISTS unit_price integer;
DO $$ BEGIN
  -- the stub FKs on variant_id are plain; make them the live SET NULL
  ALTER TABLE public.cash_order_items DROP CONSTRAINT IF EXISTS cash_order_items_variant_id_fkey;
  ALTER TABLE public.layaway_account_items DROP CONSTRAINT IF EXISTS layaway_account_items_variant_id_fkey;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
