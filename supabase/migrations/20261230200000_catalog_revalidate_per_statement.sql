-- ===========================================================================
-- Website catalog revalidation: one refresh per statement instead of one per row.
--
-- Before: public.notify_website_revalidate() ran FOR EACH ROW on the five
-- catalog tables, so a Catalog save that rewrites 14 photos posted ~30 pg_net
-- calls for one product. After: those five tables use
-- public.notify_website_catalog_revalidate() FOR EACH STATEMENT, which posts
-- ONCE per DISTINCT (productSlug, collectionSlug) pair the statement touched.
--
-- Same payload, endpoint and Vault key as notify_website_revalidate(). Rows:
-- INSERT / UPDATE read the transition table new_rows, DELETE reads old_rows —
-- the rows the row-level COALESCE(NEW, OLD) used, so the same pages refresh.
-- Each transition table is referenced only inside its own branch (an INSERT
-- trigger has no old_rows). Pairs with both slugs NULL are skipped; a
-- statement touching zero rows posts nothing.
--
-- PostgreSQL allows only one event on a trigger with transition tables, so
-- each old trigger becomes three: <old name>_ins / _upd / _del.
--
-- Unchanged: notify_website_revalidate() itself and its other 9 triggers
-- (website_settings, website_posts, website_faq_sections, website_faq_items,
-- website_post_comments, product_reviews x3, loyalty_tiers), and every other
-- trigger on the five catalog tables (cut-out, updated_at, terminology,
-- metals, Page365 guards).
--
-- lock_timeout: Lovable's schema dump holds locks (docs/MIGRATIONS.md); a busy
-- table fails the whole migration fast and clean — re-run it.
-- ===========================================================================

SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.notify_website_catalog_revalidate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key   text;
  v_pairs jsonb := '[]'::jsonb;
  v_pair  jsonb;
BEGIN
  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'email_queue_service_role_key';

  IF v_key IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF TG_TABLE_NAME = 'website_products' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', n.slug, 'c', NULL)), '[]'::jsonb)
      INTO v_pairs
      FROM new_rows n
      WHERE n.slug IS NOT NULL;
    ELSIF TG_TABLE_NAME = 'website_collections' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', NULL, 'c', n.slug)), '[]'::jsonb)
      INTO v_pairs
      FROM new_rows n
      WHERE n.slug IS NOT NULL;
    ELSIF TG_TABLE_NAME = 'website_product_variants' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', p.slug, 'c', NULL)), '[]'::jsonb)
      INTO v_pairs
      FROM new_rows n
      JOIN website_products p ON p.id = n.product_id
      WHERE p.slug IS NOT NULL;
    ELSIF TG_TABLE_NAME = 'website_product_media' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', p.slug, 'c', NULL)), '[]'::jsonb)
      INTO v_pairs
      FROM new_rows n
      JOIN website_product_variants v ON v.id = n.variant_id
      JOIN website_products p ON p.id = v.product_id
      WHERE p.slug IS NOT NULL;
    ELSIF TG_TABLE_NAME = 'website_collection_products' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', p.slug, 'c', c.slug)), '[]'::jsonb)
      INTO v_pairs
      FROM new_rows n
      LEFT JOIN website_products p ON p.id = n.product_id
      LEFT JOIN website_collections c ON c.id = n.collection_id
      WHERE p.slug IS NOT NULL OR c.slug IS NOT NULL;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'website_products' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', o.slug, 'c', NULL)), '[]'::jsonb)
      INTO v_pairs
      FROM old_rows o
      WHERE o.slug IS NOT NULL;
    ELSIF TG_TABLE_NAME = 'website_collections' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', NULL, 'c', o.slug)), '[]'::jsonb)
      INTO v_pairs
      FROM old_rows o
      WHERE o.slug IS NOT NULL;
    ELSIF TG_TABLE_NAME = 'website_product_variants' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', p.slug, 'c', NULL)), '[]'::jsonb)
      INTO v_pairs
      FROM old_rows o
      JOIN website_products p ON p.id = o.product_id
      WHERE p.slug IS NOT NULL;
    ELSIF TG_TABLE_NAME = 'website_product_media' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', p.slug, 'c', NULL)), '[]'::jsonb)
      INTO v_pairs
      FROM old_rows o
      JOIN website_product_variants v ON v.id = o.variant_id
      JOIN website_products p ON p.id = v.product_id
      WHERE p.slug IS NOT NULL;
    ELSIF TG_TABLE_NAME = 'website_collection_products' THEN
      SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object('p', p.slug, 'c', c.slug)), '[]'::jsonb)
      INTO v_pairs
      FROM old_rows o
      LEFT JOIN website_products p ON p.id = o.product_id
      LEFT JOIN website_collections c ON c.id = o.collection_id
      WHERE p.slug IS NOT NULL OR c.slug IS NOT NULL;
    END IF;
  END IF;

  FOR v_pair IN SELECT value FROM jsonb_array_elements(v_pairs) LOOP
    PERFORM net.http_post(
      url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website',
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
      body := jsonb_strip_nulls(jsonb_build_object('productSlug', v_pair->>'p', 'collectionSlug', v_pair->>'c'))
    );
  END LOOP;

  RETURN NULL;
END
$function$;

REVOKE EXECUTE ON FUNCTION public.notify_website_catalog_revalidate() FROM PUBLIC, anon, authenticated;

-- website_products
DROP TRIGGER IF EXISTS trg_website_products_revalidate ON public.website_products;
CREATE TRIGGER trg_website_products_revalidate_ins AFTER INSERT ON public.website_products REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_products_revalidate_upd AFTER UPDATE ON public.website_products REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_products_revalidate_del AFTER DELETE ON public.website_products REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();

-- website_product_variants
DROP TRIGGER IF EXISTS trg_website_variants_revalidate ON public.website_product_variants;
CREATE TRIGGER trg_website_variants_revalidate_ins AFTER INSERT ON public.website_product_variants REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_variants_revalidate_upd AFTER UPDATE ON public.website_product_variants REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_variants_revalidate_del AFTER DELETE ON public.website_product_variants REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();

-- website_product_media
DROP TRIGGER IF EXISTS trg_website_media_revalidate ON public.website_product_media;
CREATE TRIGGER trg_website_media_revalidate_ins AFTER INSERT ON public.website_product_media REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_media_revalidate_upd AFTER UPDATE ON public.website_product_media REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_media_revalidate_del AFTER DELETE ON public.website_product_media REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();

-- website_collection_products
DROP TRIGGER IF EXISTS trg_website_collection_products_revalidate ON public.website_collection_products;
CREATE TRIGGER trg_website_collection_products_revalidate_ins AFTER INSERT ON public.website_collection_products REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_collection_products_revalidate_upd AFTER UPDATE ON public.website_collection_products REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_collection_products_revalidate_del AFTER DELETE ON public.website_collection_products REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();

-- website_collections
DROP TRIGGER IF EXISTS trg_website_collections_revalidate ON public.website_collections;
CREATE TRIGGER trg_website_collections_revalidate_ins AFTER INSERT ON public.website_collections REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_collections_revalidate_upd AFTER UPDATE ON public.website_collections REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
CREATE TRIGGER trg_website_collections_revalidate_del AFTER DELETE ON public.website_collections REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();
