-- LIVE SNAPSHOT — captured read-only, NOT a migration. Do not apply this file.
--
--   function  : public.notify_website_revalidate()
--   captured  : 2026-09-17 05:50:22.096422+00 (SELECT pg_get_functiondef(oid))
--   md5       : c163d58c9df7af3c416d06a016cfbaab
--   length    : 1898 bytes
--
-- The md5 and length above are of the text BELOW this header, which is the
-- pg_get_functiondef output byte for byte — header excluded. To re-verify:
--
--   SELECT md5(pg_get_functiondef(p.oid)), length(pg_get_functiondef(p.oid))
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public' AND p.proname = 'notify_website_revalidate';
--
-- Captured for the live-vs-repo diff pass (DIFF-FINDINGS.md beside this file).
-- The repo is NOT evidence about live — see CLAUDE.md, "A SQL EDITOR CHANGE
-- THAT IS NEVER COMMITTED IS INVISIBLE TO EVERY LATER REBUILD".

CREATE OR REPLACE FUNCTION public.notify_website_revalidate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ DECLARE v_product_id uuid; v_collection_id uuid; v_product_slug text; v_collection_slug text; v_key text; BEGIN IF TG_TABLE_NAME = 'website_products' THEN v_product_id := COALESCE(NEW.id, OLD.id); v_product_slug := COALESCE(NEW.slug, OLD.slug); ELSIF TG_TABLE_NAME = 'website_collections' THEN v_collection_id := COALESCE(NEW.id, OLD.id); v_collection_slug := COALESCE(NEW.slug, OLD.slug); ELSIF TG_TABLE_NAME = 'website_product_variants' THEN v_product_id := COALESCE(NEW.product_id, OLD.product_id); ELSIF TG_TABLE_NAME = 'website_product_media' THEN SELECT product_id INTO v_product_id FROM website_product_variants WHERE id = COALESCE(NEW.variant_id, OLD.variant_id); ELSIF TG_TABLE_NAME = 'website_collection_products' THEN v_product_id := COALESCE(NEW.product_id, OLD.product_id); v_collection_id := COALESCE(NEW.collection_id, OLD.collection_id); END IF; IF v_product_id IS NOT NULL AND v_product_slug IS NULL THEN SELECT slug INTO v_product_slug FROM website_products WHERE id = v_product_id; END IF; IF v_collection_id IS NOT NULL AND v_collection_slug IS NULL THEN SELECT slug INTO v_collection_slug FROM website_collections WHERE id = v_collection_id; END IF; SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key'; IF v_key IS NOT NULL AND (v_product_slug IS NOT NULL OR v_collection_slug IS NOT NULL) THEN PERFORM net.http_post(url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key), body := jsonb_strip_nulls(jsonb_build_object('productSlug', v_product_slug, 'collectionSlug', v_collection_slug))); END IF; RETURN COALESCE(NEW, OLD); END $function$
