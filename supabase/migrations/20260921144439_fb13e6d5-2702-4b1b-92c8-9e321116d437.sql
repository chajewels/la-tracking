-- Extend notify_website_revalidate() with tag-based revalidation, and fire it
-- on public.website_settings edits so storefront content changes reach the
-- storefront immediately instead of waiting out the 60s window.
--
-- The body below is the LIVE body captured 2026-09-17 / re-verified
-- 2026-09-21 (md5 c163d58c9df7af3c416d06a016cfbaab, length 1898) with ONLY the
-- tag branch added — per CLAUDE.md, function changes start from live, never
-- from the repo.
--
-- Tag path: website_settings, and (for later PRs) any website_* table that is
-- not one of the product / collection / category tables the slug path already
-- handles. Those tables have no slug of their own, so a page-level tag is the
-- only thing the storefront can act on.

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
  v_tag text;
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
      body := jsonb_strip_nulls(jsonb_build_object('productSlug', v_product_slug, 'collectionSlug', v_collection_slug, 'tag', v_tag))
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$function$;

DROP TRIGGER IF EXISTS trg_website_settings_revalidate ON public.website_settings;
CREATE TRIGGER trg_website_settings_revalidate
AFTER INSERT OR UPDATE OR DELETE ON public.website_settings
FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();