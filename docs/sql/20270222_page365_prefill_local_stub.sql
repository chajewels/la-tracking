-- ============================================================================
-- Page365 prefill from name (2026-10-30) -- LOCAL stub + seed. Local Postgres
-- ONLY, never live. Just the tables migration 20270222100000 reads, the five
-- categories and eleven product types, the brands already in the Catalog,
-- and page365_inventory_land_run with its exact live text (md5 7f27675e...,
-- body copied from 20261005100000; check_function_bodies off so its missing
-- tables do not matter -- it is never called here).
--
--   initdb -D /tmp/p365prefill --locale=C -E UTF8 -U postgres && pg_ctl -D /tmp/p365prefill -o "-p 55478 -k /tmp" start
--   export PGOPTIONS='-c page365.local_stub=yes'
--   P() { psql -q -h /tmp -p 55478 -U postgres -v ON_ERROR_STOP=1 -f "$1"; }
--   P docs/sql/20270222_page365_prefill_local_stub.sql
--   P supabase/migrations/20270222100000_page365_prefill_from_name.sql
--   P supabase/migrations/20270222100000_page365_prefill_from_name.sql   # re-run is safe
--   P docs/sql/20270222_page365_prefill_local_tests.sql
-- ============================================================================
\set ON_ERROR_STOP 1
DO $$ BEGIN
  IF current_setting('page365.local_stub', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'local stub: refusing to run (set PGOPTIONS=-c page365.local_stub=yes)';
  END IF;
END $$;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.website_product_status AS ENUM ('draft','active','archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.website_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sku text, slug text, name text NOT NULL,
  status public.website_product_status NOT NULL DEFAULT 'draft',
  origin text NOT NULL DEFAULT 'UNKNOWN' CHECK (origin = ANY (ARRAY['JAPAN','BRAND','OTHER','UNKNOWN'])),
  brand text, condition text NOT NULL DEFAULT 'New' CHECK (condition = ANY (ARRAY['New','Preloved'])),
  metals text[] NOT NULL DEFAULT '{}', item_kind text NOT NULL DEFAULT 'jewelry', weight_g numeric,
  first_published_at timestamptz);
CREATE TABLE IF NOT EXISTS public.website_product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL REFERENCES public.website_products(id),
  size text, stone text, price_jpy integer, stock_qty integer NOT NULL DEFAULT 0, sort integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.website_collections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE, name text);
CREATE TABLE IF NOT EXISTS public.website_categories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE, name text);
CREATE TABLE IF NOT EXISTS public.website_collection_products (collection_id uuid NOT NULL REFERENCES public.website_collections(id),
  product_id uuid NOT NULL REFERENCES public.website_products(id), sort integer NOT NULL DEFAULT 0, PRIMARY KEY (collection_id, product_id));
CREATE TABLE IF NOT EXISTS public.website_category_products (category_id uuid NOT NULL REFERENCES public.website_categories(id),
  product_id uuid NOT NULL REFERENCES public.website_products(id), sort_order integer NOT NULL DEFAULT 100, PRIMARY KEY (category_id, product_id));
CREATE TABLE IF NOT EXISTS public.page365_landings (product_id uuid NOT NULL REFERENCES public.website_products(id),
  variant_id uuid, item_id uuid, run_id uuid, code text NOT NULL, name text, item_kind text,
  landed_at timestamptz NOT NULL DEFAULT now(), photos_total integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.audit_logs (id bigserial PRIMARY KEY, entity_type text, entity_id uuid, action text,
  old_value_json jsonb, new_value_json jsonb, performed_by_user_id uuid, created_at timestamptz DEFAULT now());

INSERT INTO public.website_collections (slug, name) VALUES
  ('rings','Rings'),('necklaces','Necklaces'),('pendants','Pendants'),('bracelets','Bracelets'),('earrings','Earrings'),
  ('anklets','Anklets'),('pearls','Pearls'),('luxury-watches','Luxury Watches'),('luxury-bags','Luxury Bags'),
  ('luxury-wallet','Luxury Wallet'),('other-accessories','Other Accessories') ON CONFLICT DO NOTHING;
INSERT INTO public.website_categories (slug, name) VALUES
  ('fine-jewelry','Fine Jewelry'),('preloved-jewelry','Preloved Jewelry'),('preloved-branded-jewelry','Preloved Branded Jewelry'),
  ('preloved-watches','Preloved Branded Watches'),('preloved-designer-accessories','Preloved Designer Accessories') ON CONFLICT DO NOTHING;

-- Published products carrying the live brand spellings (the brand list).
INSERT INTO public.website_products (sku, name, status, origin, brand, condition, first_published_at)
SELECT 'BR' || n, 'BR' || n || ' Brand row', 'active', 'BRAND', b, 'Preloved', now()
  FROM unnest(ARRAY['Tiffany & Co.','Louis Vuitton','Gucci','Herm' || chr(232) || 's','Bvlgari','Chanel','Cartier',
                    'Saint Laurent','Burberry','Prada','Ponte Vecchio','Van Cleef & Arpels','Unoaerre','Casio G-SHOCK'])
       WITH ORDINALITY AS u(b, n)
 WHERE NOT EXISTS (SELECT 1 FROM public.website_products WHERE sku LIKE 'BR%');

-- The two live never-completed drafts, with their live ids and state.
INSERT INTO public.website_products (id, sku, name, status, origin, condition, metals, item_kind)
VALUES ('f17e0f39-616f-4cf2-b77a-9ee06de5644b', 'N2916', 'N2916 Necklace Tiffany & Co. SV925 By the Yard Necklace 40cm [Used]',
        'draft', 'UNKNOWN', 'New', ARRAY['SILVER925'], 'jewelry'),
       ('cb07c59a-4849-49fa-828e-2f868bff853f', 'R3694', 'R3694 Ring Gucci Blind For Love Ring #18 Sz# 17 [Used]',
        'draft', 'UNKNOWN', 'New', ARRAY[]::text[], 'jewelry')
ON CONFLICT DO NOTHING;
INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty)
SELECT id, 10000, 1 FROM public.website_products wp WHERE sku IN ('N2916','R3694')
   AND NOT EXISTS (SELECT 1 FROM public.website_product_variants v WHERE v.product_id = wp.id);
INSERT INTO public.page365_landings (product_id, code, name)
SELECT id, sku, name FROM public.website_products wp WHERE sku IN ('N2916','R3694')
   AND NOT EXISTS (SELECT 1 FROM public.page365_landings l WHERE l.product_id = wp.id);
-- A staff-completed draft that must stay exactly as it is.
INSERT INTO public.website_products (sku, name, status, origin, condition, metals)
SELECT 'R3701', 'R3701 Ring Bvlgari 750PG 3.70g Bzero1 Essential Band Sz# 13 [Preloved]', 'draft', 'UNKNOWN', 'New', ARRAY['750']
 WHERE NOT EXISTS (SELECT 1 FROM public.website_products WHERE sku = 'R3701');

SET check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.page365_inventory_land_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_run      public.page365_inventory_runs%ROWTYPE;
  v_it       public.page365_inventory_items%ROWTYPE;
  v_prod     public.page365_inventory_products%ROWTYPE;
  v_multi    boolean;
  v_n        integer;
  v_name     text;
  v_price    integer;
  v_stock    integer;
  v_metals   text[];
  v_desc     text;
  v_cond     text;
  v_cat      uuid;
  v_slug     text;
  v_kind     text;
  v_pid      uuid;
  v_vid      uuid;
  v_existing uuid;
  v_note     text;
  v_landed   integer := 0;
  v_notes    jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO v_run FROM public.page365_inventory_runs WHERE id = p_run_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_found'); END IF;
  -- Only a COMPLETE read lands anything (a partial or failed one never does).
  IF v_run.status <> 'ready' THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_ready'); END IF;

  FOR v_it IN
    SELECT * FROM public.page365_inventory_items i
     WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.category = 'new'
       AND i.match_result = 'unmatched' AND i.status = 'review'
     ORDER BY i.code NULLS LAST, i.id
     FOR UPDATE
  LOOP
    v_note := NULL;
    -- "Don't sync with Page365" (PR 2), read live: never landed.
    SELECT wp.id INTO v_existing FROM public.website_products wp
     WHERE wp.page365_sync_disabled
       AND (public.page365_first_word(wp.sku) = v_it.code
         OR (wp.page365_product_id = v_it.page365_product_id AND wp.page365_variant_id = v_it.page365_variant_id))
     LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_note := 'sync_disabled';
    ELSIF v_it.code IS NULL THEN
      v_note := 'no_code';
    ELSIF coalesce(v_it.page365_available, 0) <= 0 THEN
      -- Sold out on Page365: never lands; a later read lands it when back in stock.
      v_note := 'sold_out';
    ELSIF EXISTS (SELECT 1 FROM public.website_products wp WHERE public.page365_first_word(wp.sku) = v_it.code) THEN
      v_note := 'code_exists';
    ELSIF EXISTS (SELECT 1 FROM public.website_products wp
                   WHERE wp.page365_product_id = v_it.page365_product_id AND wp.page365_variant_id = v_it.page365_variant_id) THEN
      v_note := 'already_landed';
    ELSIF regexp_replace(regexp_replace(lower(v_it.code), 'es$', ''), 's$', '')
            IN ('ring','necklace','pendant','bracelet','earring','bangle','anklet',
                'brooch','charm','chain','pearl','set','new','preloved','watch','wallet','bag','belt')
          OR upper(v_it.code) = ANY (ARRAY['K24','K18','750','18K','K14','K10','PT1000','PT950','PT900','PT850','PM','PM900',
                                           'SILVER925','SV','SV925']) THEN
      -- The Page365 name starts with a word, not a code: there is no code to
      -- sync stock on. Fix the name on Page365; the next read lands it.
      v_note := 'code_is_a_word';
    END IF;
    IF v_note IS NOT NULL THEN
      UPDATE public.page365_inventory_items SET result_note = v_note WHERE id = v_it.id;
      v_notes := jsonb_set(v_notes, ARRAY[v_note], to_jsonb(coalesce((v_notes->>v_note)::integer, 0) + 1));
      CONTINUE;
    END IF;

    SELECT * INTO v_prod FROM public.page365_inventory_products WHERE id = v_it.inventory_product_id;
    SELECT count(*) INTO v_n FROM public.page365_inventory_items j WHERE j.inventory_product_id = v_it.inventory_product_id;
    v_multi := v_n > 1;
    -- A listing carrying several codes: each product is named by its variant.
    v_name  := btrim(CASE WHEN v_multi AND btrim(coalesce(v_it.variant_name, '')) ~ '\S\s+\S' THEN v_it.variant_name
                          ELSE coalesce(v_it.page365_name, v_prod.name, v_prod.list_name) END);
    -- No price on Page365: lands at 0 and is "incomplete — needs price".
    v_price := greatest(0, coalesce(v_it.page365_price_jpy, v_prod.price_jpy, 0));
    v_stock := greatest(0, v_it.page365_available);
    v_metals := public.page365_metals_from_text(v_name || ' ' || coalesce(v_it.page365_name, '') || ' '
                                                || coalesce(v_prod.list_description, ''));
    v_desc  := public.page365_clean_description(v_prod.list_description);
    v_cond  := CASE WHEN v_name ~* '\[\s*pre-?loved\s*\]' OR coalesce(v_prod.list_category, '') ~* 'pre-?loved'
                    THEN 'Preloved' ELSE 'New' END;
    v_cat   := public.page365_category_for(v_prod.list_category);
    v_kind  := public.page365_item_kind_for(v_name || ' ' || coalesce(v_it.page365_name, ''), v_prod.list_category);

    v_slug := left(btrim(regexp_replace(lower(v_it.code || '-' || regexp_replace(v_name, '^\S+\s*', '')),
                                        '[^a-z0-9]+', '-', 'g'), '-'), 90);
    IF v_slug = '' THEN v_slug := lower(v_it.code); END IF;
    IF EXISTS (SELECT 1 FROM public.website_products WHERE slug = v_slug) THEN
      v_slug := v_slug || '-' || v_it.page365_variant_id;
    END IF;

    BEGIN
      -- ALWAYS a draft: nothing lands on the website until a person publishes it.
      INSERT INTO public.website_products (sku, slug, name, status, origin, condition, metals, item_kind, description_en,
                                           page365_product_id, page365_variant_id, page365_category)
      VALUES (v_it.code, v_slug, v_name, 'draft', 'UNKNOWN', v_cond, v_metals, v_kind, v_desc,
              v_it.page365_product_id, v_it.page365_variant_id, v_prod.list_category)
      RETURNING id INTO v_pid;

      INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty, sort)
      VALUES (v_pid, v_price, v_stock, 0)
      RETURNING id INTO v_vid;

      IF v_cat IS NOT NULL THEN
        INSERT INTO public.website_category_products (category_id, product_id, sort_order) VALUES (v_cat, v_pid, 0);
      END IF;

      -- Matched to the new variant: its photos are copied by the scheduled
      -- page365-inventory-fetch (page365_landings), and the next read sees it
      -- as an ordinary matched piece whose stock follows Page365.
      UPDATE public.page365_inventory_items
         SET match_result = 'matched', website_product_id = v_pid, variant_id = v_vid, hub_sku = v_it.code,
             hub_price_jpy = v_price, seen_stock = v_stock, web_holds = 0, invoice_holds = 0, proposed_stock = v_stock,
             photos_total = jsonb_array_length(v_prod.photos), photos_to_copy = jsonb_array_length(v_prod.photos),
             photos_removed = 0, price_differs = false,
             status = 'applied', applied_at = now(), applied_by = NULL, result_note = 'landed'
       WHERE id = v_it.id;

      INSERT INTO public.page365_landings (product_id, variant_id, item_id, run_id, code, name, item_kind, photos_total,
                                           photos_done_at)
      VALUES (v_pid, v_vid, v_it.id, p_run_id, v_it.code, v_name, v_kind, jsonb_array_length(v_prod.photos),
              CASE WHEN jsonb_array_length(v_prod.photos) = 0 THEN now() END);

      INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
      VALUES ('website_product', v_pid, 'page365_product_landed',
              jsonb_build_object('run_id', p_run_id, 'run_kind', v_run.kind, 'item_id', v_it.id, 'sku', v_it.code,
                                 'name', v_name, 'price_jpy', v_price, 'stock_qty', v_stock, 'metals', to_jsonb(v_metals),
                                 'item_kind', v_kind, 'condition', v_cond, 'category_id', v_cat,
                                 'page365_category', v_prod.list_category, 'description_copied', v_desc IS NOT NULL,
                                 'photos', jsonb_array_length(v_prod.photos),
                                 'page365_product_id', v_it.page365_product_id, 'page365_variant_id', v_it.page365_variant_id,
                                 'missing', to_jsonb(public.website_product_publish_missing(v_pid))),
              NULL);
      v_landed := v_landed + 1;
    EXCEPTION WHEN OTHERS THEN
      -- One bad row never undoes the others; the reason stays on the row.
      UPDATE public.page365_inventory_items SET result_note = left(SQLERRM, 300) WHERE id = v_it.id;
      v_notes := jsonb_set(v_notes, ARRAY['error'], to_jsonb(coalesce((v_notes->>'error')::integer, 0) + 1));
    END;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'landed', v_landed, 'not_landed', v_notes);
END
$fn$;
RESET check_function_bodies;
