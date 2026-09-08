-- Enums
DO $$ BEGIN CREATE TYPE public.website_product_karat AS ENUM ('K18','PT900','PT950'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.website_product_status AS ENUM ('draft','active','archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.website_claim_status AS ENUM ('held','paid','layaway','expired','released'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Products
CREATE TABLE public.website_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text UNIQUE NOT NULL,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  karat public.website_product_karat,
  weight_g numeric(8,2),
  description_en text,
  description_ja text,
  description_tl text,
  status public.website_product_status NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.website_products TO authenticated;
GRANT ALL ON public.website_products TO service_role;
ALTER TABLE public.website_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view website products" ON public.website_products FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can manage website products" ON public.website_products FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Variants
CREATE TABLE public.website_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.website_products(id) ON DELETE CASCADE,
  size text,
  stone text,
  price_jpy integer NOT NULL CHECK (price_jpy >= 0),
  price_php integer CHECK (price_php >= 0),
  cost_basis integer,
  stock_qty integer NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.website_product_variants TO authenticated;
GRANT ALL ON public.website_product_variants TO service_role;
ALTER TABLE public.website_product_variants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view website variants" ON public.website_product_variants FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can manage website variants" ON public.website_product_variants FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
CREATE INDEX idx_website_variants_product ON public.website_product_variants(product_id);

-- Media
CREATE TABLE public.website_product_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES public.website_product_variants(id) ON DELETE CASCADE,
  url text NOT NULL,
  alt text,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.website_product_media TO authenticated;
GRANT ALL ON public.website_product_media TO service_role;
ALTER TABLE public.website_product_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view website media" ON public.website_product_media FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can manage website media" ON public.website_product_media FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
CREATE INDEX idx_website_media_variant ON public.website_product_media(variant_id);

-- Collections
CREATE TABLE public.website_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  hero_media text,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.website_collections TO authenticated;
GRANT ALL ON public.website_collections TO service_role;
ALTER TABLE public.website_collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view website collections" ON public.website_collections FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can manage website collections" ON public.website_collections FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

CREATE TABLE public.website_collection_products (
  collection_id uuid NOT NULL REFERENCES public.website_collections(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.website_products(id) ON DELETE CASCADE,
  sort integer NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, product_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.website_collection_products TO authenticated;
GRANT ALL ON public.website_collection_products TO service_role;
ALTER TABLE public.website_collection_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view website collection products" ON public.website_collection_products FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can manage website collection products" ON public.website_collection_products FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Live claims
CREATE TABLE public.website_live_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  product_variant_id uuid NOT NULL REFERENCES public.website_product_variants(id),
  customer_id uuid REFERENCES public.customers(id),
  csr_id uuid,
  price_locked integer NOT NULL,
  status public.website_claim_status NOT NULL DEFAULT 'held',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.website_live_claims TO authenticated;
GRANT ALL ON public.website_live_claims TO service_role;
ALTER TABLE public.website_live_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view live claims" ON public.website_live_claims FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can manage live claims" ON public.website_live_claims FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));
CREATE INDEX idx_website_live_claims_status ON public.website_live_claims(status, expires_at);

-- Loyalty signups from the website form
CREATE TABLE public.loyalty_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  contact text NOT NULL,
  region text NOT NULL CHECK (region IN ('JP','PH','OTHER')),
  lang text NOT NULL CHECK (lang IN ('ja','en')),
  converted_customer_id uuid REFERENCES public.customers(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.loyalty_signups TO authenticated;
GRANT ALL ON public.loyalty_signups TO service_role;
ALTER TABLE public.loyalty_signups ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view loyalty signups" ON public.loyalty_signups FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE POLICY "Staff can manage loyalty signups" ON public.loyalty_signups FOR ALL TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

-- Existing loyalty tiers gain the live-hold duration
ALTER TABLE public.loyalty_tiers ADD COLUMN IF NOT EXISTS hold_minutes integer NOT NULL DEFAULT 60;

-- updated_at triggers
CREATE TRIGGER trg_website_products_updated_at BEFORE UPDATE ON public.website_products FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_website_variants_updated_at BEFORE UPDATE ON public.website_product_variants FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_website_collections_updated_at BEFORE UPDATE ON public.website_collections FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_website_live_claims_updated_at BEFORE UPDATE ON public.website_live_claims FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Terminology guard
CREATE OR REPLACE FUNCTION public.reject_forbidden_gold_terms()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF coalesce(NEW.name,'') || ' ' || coalesce(NEW.description_en,'') || ' ' || coalesce(NEW.description_tl,'')
     ~* '\m(japan(ese)?|saudi|italian|dubai|hk|chinese) gold\M' THEN
    RAISE EXCEPTION 'Forbidden gold terminology. Use "K18 gold, Made in Japan".';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_website_products_terminology BEFORE INSERT OR UPDATE ON public.website_products FOR EACH ROW EXECUTE FUNCTION public.reject_forbidden_gold_terms();

-- Shared layaway math (single source for site + Hub)
CREATE OR REPLACE FUNCTION public.layaway_quote(p_price integer, p_term_months integer, p_currency text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE
  v_currency text := upper(coalesce(p_currency,'JPY'));
  v_rate numeric;
  v_threshold numeric := 300000;
  v_max int;
  v_term int;
  v_down int;
  v_monthly int;
BEGIN
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION 'invalid price';
  END IF;
  IF v_currency NOT IN ('JPY','PHP') THEN
    RAISE EXCEPTION 'invalid currency';
  END IF;
  IF v_currency = 'PHP' THEN
    SELECT (value #>> '{}')::numeric INTO v_rate FROM system_settings WHERE key = 'php_jpy_rate';
    v_threshold := 300000 * coalesce(v_rate, 0.42);
  END IF;

  v_max := CASE WHEN p_price >= v_threshold THEN 8 ELSE 6 END;
  v_term := least(greatest(coalesce(p_term_months, 3), 3), v_max);
  v_down := round(p_price * 0.30);
  v_monthly := round((p_price - v_down)::numeric / v_term);

  RETURN jsonb_build_object(
    'down_payment', v_down,
    'monthly', v_monthly,
    'term_months', v_term,
    'total', p_price,
    'max_term_months', v_max,
    'currency', v_currency
  );
END $$;
GRANT EXECUTE ON FUNCTION public.layaway_quote(integer, integer, text) TO authenticated, service_role;

-- Notify the website to refresh affected pages on any catalog change
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
  ELSIF TG_TABLE_NAME = 'website_product_variants' THEN
    v_product_id := COALESCE(NEW.product_id, OLD.product_id);
  ELSIF TG_TABLE_NAME = 'website_product_media' THEN
    SELECT product_id INTO v_product_id FROM website_product_variants
      WHERE id = COALESCE(NEW.variant_id, OLD.variant_id);
  ELSIF TG_TABLE_NAME = 'website_collection_products' THEN
    v_product_id := COALESCE(NEW.product_id, OLD.product_id);
    v_collection_id := COALESCE(NEW.collection_id, OLD.collection_id);
  END IF;

  IF v_product_id IS NOT NULL THEN
    SELECT slug INTO v_product_slug FROM website_products WHERE id = v_product_id;
  END IF;
  IF v_collection_id IS NOT NULL THEN
    SELECT slug INTO v_collection_slug FROM website_collections WHERE id = v_collection_id;
  END IF;

  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'email_queue_service_role_key';

  IF v_key IS NOT NULL THEN
    PERFORM net.http_post(
      url := 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || v_key),
      body := jsonb_strip_nulls(jsonb_build_object('productSlug', v_product_slug, 'collectionSlug', v_collection_slug))
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_website_products_revalidate AFTER INSERT OR UPDATE OR DELETE ON public.website_products FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();
CREATE TRIGGER trg_website_variants_revalidate AFTER INSERT OR UPDATE OR DELETE ON public.website_product_variants FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();
CREATE TRIGGER trg_website_media_revalidate AFTER INSERT OR UPDATE OR DELETE ON public.website_product_media FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();
CREATE TRIGGER trg_website_collection_products_revalidate AFTER INSERT OR UPDATE OR DELETE ON public.website_collection_products FOR EACH ROW EXECUTE FUNCTION public.notify_website_revalidate();