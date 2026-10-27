-- Restore the product foreign key on product_review_products (2026-10-27).
--
-- 20270217100000 created product_review_products with a foreign key to
-- website_products. With BOTH foreign keys, PostgREST sees the table as a
-- junction: product_reviews → website_products then has two routes (its own
-- website_product_id, and through this table), and every unhinted embed
-- `product:website_products(...)` from product_reviews failed with PGRST201.
-- GET /reviews and Hub → Website → Reviews both broke. The owner dropped this
-- constraint in the SQL Editor at 2026-10-27 23:50 JST to restore the site.
--
-- The website function and ReviewsCard now name the foreign key in every such
-- embed (!product_reviews_website_product_id_fkey). APPLY ONLY AFTER the
-- `website` edge function carrying that hint is deployed; applying it before
-- brings the PGRST201 outage back.

DO $g$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'product_review_products_website_product_id_fkey'
  ) THEN
    ALTER TABLE public.product_review_products
      ADD CONSTRAINT product_review_products_website_product_id_fkey
      FOREIGN KEY (website_product_id) REFERENCES public.website_products(id) ON DELETE CASCADE;
  END IF;
END
$g$;
