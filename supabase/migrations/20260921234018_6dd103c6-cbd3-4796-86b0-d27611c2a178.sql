-- website_faq_* revalidation.
--
-- Extends public.notify_website_revalidate() (live body = the one the
-- website_posts migration 20260921150921 left behind) with an explicit FAQ
-- branch: sections and items have no slug of their own, so the storefront
-- gets the content tag plus a path -- { "tag": "content", "path": "/faq" }.
-- The FAQ branch is matched before the generic `LIKE 'website\_%'` branch so
-- the path is not lost to it.
--
-- Also adds AFTER INSERT OR UPDATE OR DELETE triggers on both FAQ tables.

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

DROP TRIGGER IF EXISTS trg_website_faq_sections_revalidate ON public.website_faq_sections;
CREATE TRIGGER trg_website_faq_sections_revalidate
AFTER INSERT OR UPDATE OR DELETE ON public.website_faq_sections
FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();

DROP TRIGGER IF EXISTS trg_website_faq_items_revalidate ON public.website_faq_items;
CREATE TRIGGER trg_website_faq_items_revalidate
AFTER INSERT OR UPDATE OR DELETE ON public.website_faq_items
FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();