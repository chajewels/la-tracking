-- Website catalog: metal options, FX rates, jewelry-type collections.
--
-- 1. website_product_karat gains K14, K10, PT1000, SILVER925 (K18 stays the
--    single value for Au750 / 18K — never 750, Au750 or 18K as separate options).
-- 2. The terminology guard stops reading description_tl (that column and
--    price_php are dropped in the follow-up migration, after the deploy).
-- 3. fx_rates holds one JPY->PHP row per day, written by the fetch-fx-rate cron.
-- 4. Collections become jewelry types.
-- 5. notify_website_revalidate() now fires on website_collections too.

-- ---------------------------------------------------------------- metals
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'K14' AFTER 'K18';
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'K10' AFTER 'K14';
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'PT1000' AFTER 'K10';
ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'SILVER925';

-- ------------------------------------------- drop Tagalog / stored peso price
-- Replace the terminology guard first: it reads description_tl.
CREATE OR REPLACE FUNCTION public.reject_forbidden_gold_terms()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF coalesce(NEW.name,'') || ' ' || coalesce(NEW.description_en,'') || ' ' || coalesce(NEW.description_ja,'')
     ~* '\m(japan(ese)?|saudi|italian|dubai|hk|chinese) gold\M' THEN
    RAISE EXCEPTION 'Forbidden gold terminology. Use "K18 gold, Made in Japan".';
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.reject_forbidden_gold_terms() FROM anon, authenticated, PUBLIC;

-- The columns themselves are dropped in 20260908121000, which must run only
-- AFTER the new `website` edge function is deployed — the currently deployed
-- build still SELECTs description_tl and price_php and would 500 without them.

-- ------------------------------------------------------------- fx_rates
CREATE TABLE IF NOT EXISTS public.fx_rates (
  date date PRIMARY KEY,
  jpy_php numeric(12,6) NOT NULL CHECK (jpy_php > 0),
  source text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.fx_rates IS
  'One JPY->PHP rate per day. jpy_php = PHP per 1 JPY (same direction as system_settings.php_jpy_rate). Written daily by the fetch-fx-rate edge function.';

GRANT SELECT ON public.fx_rates TO authenticated;
GRANT ALL ON public.fx_rates TO service_role;
ALTER TABLE public.fx_rates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can view fx rates" ON public.fx_rates;
CREATE POLICY "Staff can view fx rates" ON public.fx_rates
  FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP TRIGGER IF EXISTS trg_fx_rates_updated_at ON public.fx_rates;
CREATE TRIGGER trg_fx_rates_updated_at BEFORE UPDATE ON public.fx_rates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Bootstrap row so GET /fx answers before the first cron tick. The cron
-- overwrites today's row with the live market rate on its next run.
INSERT INTO public.fx_rates (date, jpy_php, source)
SELECT (now() AT TIME ZONE 'Asia/Manila')::date,
       (value #>> '{}')::numeric,
       'bootstrap:system_settings.php_jpy_rate'
FROM public.system_settings
WHERE key = 'php_jpy_rate'
ON CONFLICT (date) DO NOTHING;

-- -------------------------------------------------- revalidate on collections
CREATE OR REPLACE FUNCTION public.notify_website_revalidate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_product_id uuid;
  v_collection_id uuid;
  v_product_slug text;
  v_collection_slug text;
  v_key text;
BEGIN
  IF TG_TABLE_NAME = 'website_products' THEN
    v_product_id := COALESCE(NEW.id, OLD.id);
    -- On DELETE the row is already gone, so take the slug from the tuple.
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
  END IF;

  IF v_product_id IS NOT NULL AND v_product_slug IS NULL THEN
    SELECT slug INTO v_product_slug FROM website_products WHERE id = v_product_id;
  END IF;
  IF v_collection_id IS NOT NULL AND v_collection_slug IS NULL THEN
    SELECT slug INTO v_collection_slug FROM website_collections WHERE id = v_collection_id;
  END IF;

  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';

  IF v_key IS NOT NULL AND (v_product_slug IS NOT NULL OR v_collection_slug IS NOT NULL) THEN
    PERFORM net.http_post(
      url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_strip_nulls(jsonb_build_object('productSlug', v_product_slug, 'collectionSlug', v_collection_slug))
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;
REVOKE EXECUTE ON FUNCTION public.notify_website_revalidate() FROM anon, authenticated, PUBLIC;

DROP TRIGGER IF EXISTS trg_website_collections_revalidate ON public.website_collections;
CREATE TRIGGER trg_website_collections_revalidate
  AFTER INSERT OR UPDATE OR DELETE ON public.website_collections
  FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();

-- ------------------------------------------------- collections = jewelry types
-- The four theme collections are replaced by jewelry types. Staff can add more
-- types from Website Catalog in the Hub.
DELETE FROM public.website_collections
WHERE slug IN ('k18-gold','diamonds','pearls','preloved-luxury');

INSERT INTO public.website_collections (slug, name, description) VALUES
  ('necklaces', 'Necklaces', 'Chains and necklaces in K18 and platinum, sized for everyday wear.'),
  ('pendants',  'Pendants',  'Pendant tops and charms, sold on their own or paired with a chain.'),
  ('earrings',  'Earrings',  'Studs, hoops and drops, finished with secure posts and backs.'),
  ('bracelets', 'Bracelets', 'Bangles and chain bracelets, adjustable where the design allows.'),
  ('rings',     'Rings',     'Bands, solitaires and stacking rings, resizable on request.'),
  ('anklets',   'Anklets',   'Fine chains for the ankle, in lengths that suit both ankles.'),
  ('sets',      'Sets',      'Matched pieces sold together at a set price.')
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name,
      description = COALESCE(public.website_collections.description, EXCLUDED.description);

-- Re-attach the existing catalogue to its jewelry type.
INSERT INTO public.website_collection_products (collection_id, product_id, sort)
SELECT c.id, p.id, 0
FROM public.website_products p
JOIN public.website_collections c ON c.slug = 'necklaces'
WHERE p.slug = 'n4020-necklace-tiffany-co-750-2-0g-open-teardrop-40cm-preloved'
ON CONFLICT (collection_id, product_id) DO NOTHING;
