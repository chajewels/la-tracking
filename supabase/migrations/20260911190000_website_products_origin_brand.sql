-- Website catalog: origin and brand become DATA, never an assumption.
--
-- WHY
-- The storefront has been printing "Made in Japan" on every piece with a metal,
-- straight from a hardcoded badge, with nothing in the catalog behind it. That
-- is a country-of-origin claim on branded items (Tiffany & Co., Cartier …) and
-- on preloved pieces of unknown manufacture, made by code rather than by anyone
-- who has seen the piece. Two columns fix it:
--
--   origin  JAPAN   -> the site may say 日本製 / Made in Japan for THIS piece
--           BRAND   -> the site shows the brand name and makes NO origin claim
--           OTHER   -> nothing is claimed
--           UNKNOWN -> nothing is claimed (the default for every existing row)
--   brand   free text, shown only when origin = 'BRAND'
--
-- Existing rows all land on UNKNOWN. That is deliberate: the site stops
-- claiming an origin it never had data for, and each piece regains the claim
-- only when Cynthia sets it in the Hub (edit modal or the upload template).
-- Nothing here guesses an origin from the metal, the name, or the description.

ALTER TABLE public.website_products
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS brand  text;

DO $$ BEGIN
  ALTER TABLE public.website_products
    ADD CONSTRAINT website_products_origin_check
    CHECK (origin IN ('JAPAN', 'BRAND', 'OTHER', 'UNKNOWN'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.website_products.origin IS
  'JAPAN | BRAND | OTHER | UNKNOWN (default). The ONLY source of any origin claim on chajewelsjp.com: JAPAN renders 日本製 / Made in Japan, BRAND renders the brand name with no origin claim, OTHER and UNKNOWN render nothing. Set from the Hub edit modal or the upload template (hub_origin). Never derived from metal, name or description.';
COMMENT ON COLUMN public.website_products.brand IS
  'Brand name shown on the site when origin = BRAND (e.g. Tiffany & Co.). Stored as typed; used for resale categorisation only — no logos or trademarked marks are ever rendered from it.';

-- ============================================================ VERIFICATION
--   SELECT column_name, data_type, column_default, is_nullable
--     FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='website_products'
--      AND column_name IN ('origin','brand');
--   -- every existing row is UNKNOWN, none carries a brand
--   SELECT origin, count(*) FROM public.website_products GROUP BY origin;
--   SELECT count(*) FROM public.website_products WHERE brand IS NOT NULL;

-- ================================================ trigger message follows
-- reject_forbidden_gold_terms() still told staff to write "K18 gold, Made in
-- Japan" whenever it rejected a country-branded gold term — the very habit this
-- migration ends. Same regex, same behaviour, new message. Origin now has a
-- column; the description is not where it goes.
CREATE OR REPLACE FUNCTION public.reject_forbidden_gold_terms()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF coalesce(NEW.name,'') || ' ' || coalesce(NEW.description_en,'') || ' ' || coalesce(NEW.description_ja,'')
     ~* '\m(japan(ese)?|saudi|italian|dubai|hk|chinese) gold\M' THEN
    RAISE EXCEPTION 'Forbidden gold terminology. Describe purity as "K18 gold"; origin is set in the product''s Origin field, not in the description.';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.reject_forbidden_gold_terms() FROM anon, authenticated, PUBLIC;
