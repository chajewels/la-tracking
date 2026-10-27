-- Reviews land on every product of the order (owner 2026-10-27).
--
-- Owner rule: "whatever customer stories will review and approve, it should be
-- in the product too … they are all the same and must land for every product
-- on that link where the customer gave reviews." No staff field decides it.
--
-- Before: a review reached a product page only through ONE optional
-- website_product_id chosen by staff in the Review link box ("Website piece
-- (optional)"). It was empty on every approved review, so all five showed in
-- Customer stories only.
--
-- Now: product_review_products holds every product a review belongs to.
-- link_review_products(review) fills it from the review's ORDER (the invite's
-- cash order or layaway plan): each item line's website_product_id, else its
-- variant's product, else the website product whose code (sku) equals the
-- line's code; plus any website_product_id already on the review or invite.
-- It runs when a review becomes approved (insert or status change), and once
-- below for the reviews already approved. An order with no product lines has
-- nothing to link: its review shows in Customer stories only.
--
-- GET /reviews?product=<slug> (website edge function) reads this table.
-- Written only by link_review_products (SECURITY DEFINER, not callable by
-- clients) and the service role; staff may read it.

CREATE TABLE IF NOT EXISTS public.product_review_products (
  review_id          uuid NOT NULL REFERENCES public.product_reviews(id) ON DELETE CASCADE,
  website_product_id uuid NOT NULL REFERENCES public.website_products(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, website_product_id)
);
CREATE INDEX IF NOT EXISTS product_review_products_product_idx
  ON public.product_review_products (website_product_id);

ALTER TABLE public.product_review_products ENABLE ROW LEVEL SECURITY;

DO $p$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'product_review_products'
      AND policyname = 'Staff can view review products'
  ) THEN
    CREATE POLICY "Staff can view review products" ON public.product_review_products
      FOR SELECT TO authenticated
      USING ((SELECT public.is_staff((SELECT auth.uid()))));
  END IF;
END
$p$;

CREATE OR REPLACE FUNCTION public.link_review_products(p_review_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  WITH r AS (
    SELECT pr.id, pr.website_product_id AS review_product,
           i.website_product_id AS invite_product, i.cash_order_id, i.layaway_account_id
      FROM product_reviews pr
      JOIN review_invites i ON i.id = pr.invite_id
     WHERE pr.id = p_review_id
  ), lines AS (
    SELECT ci.website_product_id, ci.variant_id, ci.sku
      FROM r JOIN cash_order_items ci ON ci.cash_order_id = r.cash_order_id
    UNION ALL
    SELECT li.website_product_id, li.variant_id, li.sku
      FROM r JOIN layaway_account_items li ON li.account_id = r.layaway_account_id
  ), products AS (
    SELECT review_product AS pid FROM r
    UNION SELECT invite_product FROM r
    UNION SELECT COALESCE(l.website_product_id, v.product_id, wp.id)
      FROM lines l
      LEFT JOIN website_product_variants v ON v.id = l.variant_id
      LEFT JOIN website_products wp
             ON l.sku IS NOT NULL AND btrim(l.sku) <> ''
            AND upper(btrim(wp.sku)) = upper(btrim(l.sku))
  ), ins AS (
    INSERT INTO product_review_products (review_id, website_product_id)
    SELECT p_review_id, p.pid FROM products p
     WHERE p.pid IS NOT NULL
       AND EXISTS (SELECT 1 FROM website_products w WHERE w.id = p.pid)
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM ins;
  RETURN v_count;
END
$function$;

REVOKE ALL ON FUNCTION public.link_review_products(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_review_products(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.trg_link_review_products()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.link_review_products(NEW.id);
  RETURN NEW;
END
$function$;

REVOKE ALL ON FUNCTION public.trg_link_review_products() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_product_reviews_link_products ON public.product_reviews;
CREATE TRIGGER trg_product_reviews_link_products
  AFTER INSERT OR UPDATE OF status ON public.product_reviews
  FOR EACH ROW WHEN (NEW.status = 'approved')
  EXECUTE FUNCTION public.trg_link_review_products();

-- The reviews approved before this change.
SELECT public.link_review_products(id) FROM public.product_reviews WHERE status = 'approved';
