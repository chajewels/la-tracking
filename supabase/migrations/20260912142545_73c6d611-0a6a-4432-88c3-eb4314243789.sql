-- Product metals: a piece can carry more than one stamp (PT900/K18), and the
-- stamp list grows to what the pieces actually say.
--
-- website_products.metals text[] replaces the single karat column as the
-- source of truth. Values are the stamps themselves, in the order staff enter
-- them, at least one. karat is KEPT for one release, synced to metals[1] by a
-- BEFORE trigger, so a reader built before this change keeps working; a later
-- cleanup migration drops it.
--
-- Idempotent: enum values IF NOT EXISTS, column IF NOT EXISTS, backfill fills
-- only empty arrays, constraints and trigger are create-or-replace.

-- 1. The stamp list. New enum values so karat can mirror any metals[1].
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'K24';
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS '750';
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS '18K';
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'PT850';
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'PM';
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'PM900';

-- 2. The array column, backfilled from karat.
ALTER TABLE public.website_products
  ADD COLUMN IF NOT EXISTS metals text[] NOT NULL DEFAULT '{}';

UPDATE public.website_products
   SET metals = ARRAY[karat::text]
 WHERE cardinality(metals) = 0
   AND karat IS NOT NULL;

COMMENT ON COLUMN public.website_products.metals IS
  'Metal stamps on the piece, in the order staff entered them, at least one. Values: K24, K18, 750, 18K, K14, K10, PT1000, PT950, PT900, PT850, PM, PM900, SILVER925 — displayed exactly as the stamp, never merged (750 and 18K are NOT folded into K18). karat mirrors metals[1] for one release and is then dropped.';

-- 3. Constraints: at least one stamp, every stamp from the list.
ALTER TABLE public.website_products
  DROP CONSTRAINT IF EXISTS website_products_metals_nonempty,
  DROP CONSTRAINT IF EXISTS website_products_metals_values;
ALTER TABLE public.website_products
  ADD CONSTRAINT website_products_metals_nonempty CHECK (cardinality(metals) >= 1),
  ADD CONSTRAINT website_products_metals_values CHECK (
    metals <@ ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900','SILVER925']::text[]
  );

-- 4. One-release bridge: karat := metals[1]; an older writer that still sends
--    only karat gets metals := ARRAY[karat]. BEFORE triggers run before the
--    CHECK constraints, so a legacy karat-only insert still passes them.
CREATE OR REPLACE FUNCTION public.sync_website_product_metals()
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

DROP TRIGGER IF EXISTS trg_website_products_metals ON public.website_products;
CREATE TRIGGER trg_website_products_metals
  BEFORE INSERT OR UPDATE ON public.website_products
  FOR EACH ROW EXECUTE FUNCTION public.sync_website_product_metals();