-- Drop the Tagalog description and the stored peso price.
--
-- ORDERING: apply this ONLY after the new `website` edge function is deployed.
-- The previous build SELECTs description_tl and price_php by name, so dropping
-- them first makes every /catalog/products response 500 until the deploy lands.
--
-- price_php is now derived per request as round(price_jpy * fx_rates.jpy_php)
-- and is never stored. The Website Catalog admin form no longer collects
-- either field.
ALTER TABLE public.website_products DROP COLUMN IF EXISTS description_tl;
ALTER TABLE public.website_product_variants DROP COLUMN IF EXISTS price_php;
