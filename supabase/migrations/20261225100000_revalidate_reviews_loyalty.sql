-- Website refresh for approved reviews and loyalty tiers (2026-10-18).
--
-- WHY: approving, unapproving or deleting a review, or editing a loyalty tier,
-- did not tell the storefront. product_reviews had only its updated_at trigger
-- and loyalty_tiers had none, so the site showed the old review list until its
-- cache aged out (reviews ~60 s, tiers 300 s).
--
-- WHAT: notify_website_revalidate() gains two branches; nothing else in it
-- changes (drift audit 2026-10-18: live body == 20260921234018, byte for byte
-- apart from these two branches).
--   product_reviews → tag 'reviews' + the product's slug (via website_product_id;
--                     a review with no linked product still sends the tag, which
--                     refreshes the home page stories)
--   loyalty_tiers   → tag 'loyalty' (/loyalty, /account)
-- The notify_website edge function already forwards `tag` unchanged; the
-- storefront accepts both names from cha-jewels-web PR #375. No edge change.
--
-- WHEN: only rows the website can see. A review is public only while
-- status = 'approved', so a pending → rejected move (never shown) sends nothing.

CREATE OR REPLACE FUNCTION public.notify_website_revalidate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_product_id uuid;
  v_collection_id uuid;
  v_product_slug text;
  v_collection_slug text;
  v_post_slug text;
  v_tag text;
  v_path text;
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'website_products' THEN
    v_product_id := COALESCE(NEW.id, OLD.id);
    v_product_slug := COALESCE(NEW.slug, OLD.slug);
  ELSIF TG_TABLE_NAME = 'website_collections' THEN
    v_collection_id := COALESCE(NEW.id, OLD.id);
    v_collection_slug := COALESCE(NEW.slug, OLD.slug);
  ELSIF TG_TABLE_NAME = 'website_product_variants' THEN
    v_product_id := COALESCE(NEW.product_id, OLD.product_id);
  ELSIF TG_TABLE_NAME = 'website_product_media' THEN
    SELECT product_id INTO v_product_id FROM website_product_variants
     WHERE id = COALESCE(NEW.variant_id, OLD.variant_id);
  ELSIF TG_TABLE_NAME = 'website_collection_products' THEN
    v_product_id := COALESCE(NEW.product_id, OLD.product_id);
    v_collection_id := COALESCE(NEW.collection_id, OLD.collection_id);
  ELSIF TG_TABLE_NAME = 'website_posts' THEN
    -- On DELETE the row is already gone, so take the slug from the tuple.
    v_post_slug := COALESCE(NEW.slug, OLD.slug);
    v_tag := 'content';
  ELSIF TG_TABLE_NAME IN ('website_faq_sections', 'website_faq_items') THEN
    -- FAQ rows carry no slug; the storefront refreshes the FAQ page itself.
    v_tag := 'content';
    v_path := '/faq';
  ELSIF TG_TABLE_NAME = 'product_reviews' THEN
    -- Approved reviews: the product page list and the home page stories.
    v_product_id := COALESCE(NEW.website_product_id, OLD.website_product_id);
    v_tag := 'reviews';
  ELSIF TG_TABLE_NAME = 'loyalty_tiers' THEN
    -- The tier ladder: /loyalty and the member card on /account.
    v_tag := 'loyalty';
  ELSIF TG_TABLE_NAME LIKE 'website\_%' THEN
    -- Content tables with no slug of their own (website_settings today).
    v_tag := 'content';
  END IF;

  IF v_product_id IS NOT NULL AND v_product_slug IS NULL THEN
    SELECT slug INTO v_product_slug FROM website_products WHERE id = v_product_id;
  END IF;
  IF v_collection_id IS NOT NULL AND v_collection_slug IS NULL THEN
    SELECT slug INTO v_collection_slug FROM website_collections WHERE id = v_collection_id;
  END IF;

  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets
   WHERE name = 'email_queue_service_role_key';

  IF v_key IS NOT NULL AND (v_product_slug IS NOT NULL OR v_collection_slug IS NOT NULL OR v_tag IS NOT NULL) THEN
    PERFORM net.http_post(
      url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_strip_nulls(jsonb_build_object('productSlug', v_product_slug, 'collectionSlug', v_collection_slug, 'postSlug', v_post_slug, 'tag', v_tag, 'path', v_path))
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$function$;

-- Reviews: three triggers so each WHEN can name only the tuple that exists.
DROP TRIGGER IF EXISTS trg_product_reviews_revalidate_ins ON public.product_reviews;
CREATE TRIGGER trg_product_reviews_revalidate_ins
AFTER INSERT ON public.product_reviews
FOR EACH ROW WHEN (NEW.status = 'approved')
EXECUTE FUNCTION public.notify_website_revalidate();

DROP TRIGGER IF EXISTS trg_product_reviews_revalidate_upd ON public.product_reviews;
CREATE TRIGGER trg_product_reviews_revalidate_upd
AFTER UPDATE ON public.product_reviews
FOR EACH ROW WHEN (OLD.status = 'approved' OR NEW.status = 'approved')
EXECUTE FUNCTION public.notify_website_revalidate();

DROP TRIGGER IF EXISTS trg_product_reviews_revalidate_del ON public.product_reviews;
CREATE TRIGGER trg_product_reviews_revalidate_del
AFTER DELETE ON public.product_reviews
FOR EACH ROW WHEN (OLD.status = 'approved')
EXECUTE FUNCTION public.notify_website_revalidate();

-- Tiers: four rows today; any change is visible on /loyalty.
DROP TRIGGER IF EXISTS trg_loyalty_tiers_revalidate ON public.loyalty_tiers;
CREATE TRIGGER trg_loyalty_tiers_revalidate
AFTER INSERT OR UPDATE OR DELETE ON public.loyalty_tiers
FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();
