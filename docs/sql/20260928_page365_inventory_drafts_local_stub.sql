-- ============================================================================
-- Page365 inventory drafts — LOCAL test stub (2026-09-28). NEVER RUN THIS ON LIVE.
--
-- Runs AFTER the #195 and PR 1 stubs + migrations, and adds only what
-- migration 20260929100000_page365_inventory_drafts.sql reads on top of them:
-- the product columns a draft writes (slug, origin, brand, condition, metals,
-- descriptions) with the live CHECKs and the live gold-terminology trigger,
-- and the website category tables. Same opt-in guard as the other stubs.
--
--   export PGOPTIONS='-c page365.local_stub=yes'
--   P="psql -p 55434 -U postgres -v ON_ERROR_STOP=1 -f"
--   $P docs/sql/20260926_page365_stock_sync_local_stub.sql
--   $P supabase/migrations/20260926120000_page365_stock_sync.sql
--   $P docs/sql/20260927_page365_inventory_fetch_local_stub.sql
--   $P supabase/migrations/20260927100000_page365_inventory_fetch.sql
--   $P docs/sql/20260928_page365_inventory_pr2_local_stub.sql
--   $P supabase/migrations/20260928100000_page365_inventory_pr2.sql
--   $P docs/sql/20260928_page365_inventory_drafts_local_stub.sql
--   $P supabase/migrations/20260929100000_page365_inventory_drafts.sql
--   $P supabase/migrations/20260929100000_page365_inventory_drafts.sql   # re-run is safe
--   $P docs/sql/20260928_page365_inventory_drafts_local_tests.sql
-- ============================================================================
DO $guard$
BEGIN
  IF coalesce(current_setting('page365.local_stub', true), '') <> 'yes' THEN
    RAISE EXCEPTION 'Refusing: set PGOPTIONS=''-c page365.local_stub=yes''';
  END IF;
  IF to_regclass('public.customers') IS NOT NULL OR to_regclass('public.payments') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing: this database has Hub tables. Local throwaway Postgres only.';
  END IF;
  IF to_regclass('public.page365_inventory_items') IS NULL THEN
    RAISE EXCEPTION 'Run the PR 1 stub and migration first';
  END IF;
END
$guard$;

ALTER TABLE public.website_products
  ADD COLUMN IF NOT EXISTS slug text DEFAULT gen_random_uuid()::text,
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS condition text NOT NULL DEFAULT 'New',
  -- live default is '{}'; the stub defaults to {K18} so the PR 1 tests' bare
  -- inserts still pass the nonempty CHECK when re-run after this migration.
  ADD COLUMN IF NOT EXISTS metals text[] NOT NULL DEFAULT '{K18}',
  ADD COLUMN IF NOT EXISTS description_en text,
  ADD COLUMN IF NOT EXISTS description_ja text,
  ADD COLUMN IF NOT EXISTS name_ja text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.website_product_variants ADD COLUMN IF NOT EXISTS sort integer NOT NULL DEFAULT 0;
-- Stub rows made by the earlier stubs have no slug/metals yet.
UPDATE public.website_products SET slug = lower(sku) WHERE slug IS NULL;
UPDATE public.website_products SET metals = ARRAY['K18'] WHERE cardinality(metals) = 0;
ALTER TABLE public.website_products ALTER COLUMN slug SET NOT NULL;
DO $$ BEGIN
  ALTER TABLE public.website_products ADD CONSTRAINT website_products_slug_key UNIQUE (slug);
  ALTER TABLE public.website_products ADD CONSTRAINT website_products_origin_check CHECK (origin IN ('JAPAN','BRAND','OTHER','UNKNOWN'));
  ALTER TABLE public.website_products ADD CONSTRAINT website_products_condition_check CHECK (condition IN ('New','Preloved'));
  ALTER TABLE public.website_products ADD CONSTRAINT website_products_metals_nonempty CHECK (cardinality(metals) >= 1);
  ALTER TABLE public.website_products ADD CONSTRAINT website_products_metals_values CHECK (
    metals <@ ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900','SILVER925']::text[]);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

-- The live karat bridge, verbatim (20260912142545): the enum, the column and
-- sync_website_product_metals() as live has them, so the migration's md5
-- guard and its redefinition run against the real body.
DO $$ BEGIN
  CREATE TYPE public.website_product_karat AS ENUM
    ('K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900','SILVER925');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE public.website_products ADD COLUMN IF NOT EXISTS karat public.website_product_karat;
DO $$ BEGIN
  IF to_regprocedure('public.sync_website_product_metals()') IS NULL THEN
    EXECUTE $def$
CREATE FUNCTION public.sync_website_product_metals()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.metals IS NULL OR cardinality(NEW.metals) = 0 THEN
    IF NEW.karat IS NOT NULL THEN
      NEW.metals := ARRAY[NEW.karat::text];
    END IF;
  END IF;
  IF cardinality(NEW.metals) >= 1 THEN
    NEW.karat := NEW.metals[1]::public.website_product_karat;
  END IF;
  RETURN NEW;
END $function$;
$def$;
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_website_products_metals ON public.website_products;
CREATE TRIGGER trg_website_products_metals
  BEFORE INSERT OR UPDATE ON public.website_products
  FOR EACH ROW EXECUTE FUNCTION public.sync_website_product_metals();

-- The live terminology trigger, verbatim (20260911190000).
CREATE OR REPLACE FUNCTION public.reject_forbidden_gold_terms()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF coalesce(NEW.name,'') || ' ' || coalesce(NEW.description_en,'') || ' ' || coalesce(NEW.description_ja,'')
     ~* '\m(japan(ese)?|saudi|italian|dubai|hk|chinese) gold\M' THEN
    RAISE EXCEPTION 'Forbidden gold terminology. Describe purity as "K18 gold"; origin is set in the product''s Origin field, not in the description.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_website_products_terminology ON public.website_products;
CREATE TRIGGER trg_website_products_terminology BEFORE INSERT OR UPDATE ON public.website_products
  FOR EACH ROW EXECUTE FUNCTION public.reject_forbidden_gold_terms();

CREATE TABLE IF NOT EXISTS public.website_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE NOT NULL, name text NOT NULL,
  published boolean NOT NULL DEFAULT true, sort_order integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.website_category_products (
  category_id uuid NOT NULL REFERENCES public.website_categories(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.website_products(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0, PRIMARY KEY (category_id, product_id));

GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
