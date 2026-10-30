-- ============================================================================
-- Page365 prefill after a name follow (2026-10-30) -- LOCAL tests.
--   P docs/sql/20270222_page365_prefill_local_stub.sql
--   P supabase/migrations/20270222100000_page365_prefill_from_name.sql
--   P supabase/migrations/20270223100000_page365_prefill_from_name_fixes.sql
--   P docs/sql/20270224_page365_prefill_follow_local_stub.sql
--   P supabase/migrations/20270224100000_page365_prefill_on_name_follow.sql
--   P docs/sql/20270224_page365_prefill_follow_local_tests.sql
-- Prints ALL PREFILL-FOLLOW CHECKS PASSED.
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got %, want %', label, got, want; END IF;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.v(p_sku text) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(wp.weight_g::text, '-') || '|' || coalesce(v.size, '-') || '|' || coalesce(v.stone, '-') || '|' || wp.condition
         || '|' || wp.origin || '|' || coalesce(wp.brand, '-') || '|' || v.stock_qty || '|' || v.price_jpy || '|' || wp.status::text
         || '|' || (SELECT count(*) FROM public.website_category_products x WHERE x.product_id = wp.id)
    FROM public.website_products wp JOIN public.website_product_variants v ON v.product_id = wp.id WHERE wp.sku = p_sku $$;

DO $t$
DECLARE p uuid;
BEGIN
  -- One-time pass: weight / size / stone only.
  PERFORM pg_temp.eq('N5140', pg_temp.v('N5140'), '-|40cm|Akoya Pearl|Preloved|JAPAN|-|1|9999|active|1');
  PERFORM pg_temp.eq('R8913', pg_temp.v('R8913'), '8.90|13|Sapphire, Diamond|Preloved|JAPAN|-|1|9999|active|1');
  PERFORM pg_temp.eq('R3435', pg_temp.v('R3435'), '3.40|13.5|Diamond|Preloved|BRAND|Tiffany & Co.|1|9999|active|1');
  PERFORM pg_temp.eq('N2010', pg_temp.v('N2010'), '-|47cm|Rose Quartz, Fresh Water Pearl|Preloved|JAPAN|-|1|9999|active|1');
  PERFORM pg_temp.eq('N4032', pg_temp.v('N4032'), '3.20|40cm|Ruby, Diamond|Preloved|BRAND|Saint Laurent|1|9999|draft|1');
  PERFORM pg_temp.eq('N2583', pg_temp.v('N2583'), '25.70|40cm|-|Preloved|BRAND|Tiffany & Co.|1|9999|active|1');
  -- NLWTP has no category: the one-time pass does NOT add one.
  PERFORM pg_temp.eq('NLWTP no category added', pg_temp.v('NLWTP'), '-|43-45cm|White Topaz, Peridot|New|JAPAN|-|1|9999|active|0');
  -- Not in the list: untouched.
  PERFORM pg_temp.eq('Y0001 untouched', pg_temp.v('Y0001'), '-|staff|Garnet|New|JAPAN|-|1|9999|active|0');

  -- Name follow on a published product: blank fields (and lists) only; staff values kept.
  UPDATE public.website_products SET name = 'Y0001 Necklace K18 3.0g Ruby 45cm Sapphire' WHERE sku = 'Y0001';
  INSERT INTO public.audit_logs (entity_type, entity_id, action) SELECT 'website_product', id, 'page365_name_followed'
    FROM public.website_products WHERE sku = 'Y0001';
  PERFORM pg_temp.eq('follow published', pg_temp.v('Y0001'), '3.00|staff|Garnet|New|JAPAN|-|1|9999|active|1');
  PERFORM pg_temp.eq('follow published cat', (SELECT c.slug FROM public.website_category_products x JOIN public.website_categories c ON c.id = x.category_id
                                               JOIN public.website_products wp ON wp.id = x.product_id WHERE wp.sku = 'Y0001'), 'fine-jewelry');
  -- Condition / origin / brand never change on a published product, even with evidence.
  INSERT INTO public.website_products (sku, name, status, origin, condition, metals, first_published_at, page365_product_id)
  VALUES ('Y0002', 'Y0002 Ring Cartier K18 2.0g Sz# 10 [Used]', 'active', 'UNKNOWN', 'New', ARRAY['K18'], now(), 9) RETURNING id INTO p;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty) VALUES (p, 100, 2);
  INSERT INTO public.audit_logs (entity_type, entity_id, action) VALUES ('website_product', p, 'page365_name_followed');
  PERFORM pg_temp.eq('follow published keeps cond/origin/brand', pg_temp.v('Y0002'), '2.00|10|-|New|UNKNOWN|-|2|100|active|1');

  -- Name follow on a never-published draft: the full landing prefill.
  INSERT INTO public.website_products (sku, name, status, origin, condition, metals, page365_product_id)
  VALUES ('Y0003', 'Y0003 Ring Cartier K18 2.0g Sz# 10 [Used]', 'draft', 'UNKNOWN', 'New', ARRAY['K18'], 10) RETURNING id INTO p;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty) VALUES (p, 100, 2);
  INSERT INTO public.audit_logs (entity_type, entity_id, action) VALUES ('website_product', p, 'page365_name_followed');
  PERFORM pg_temp.eq('follow draft full', pg_temp.v('Y0003'), '2.00|10|-|Preloved|BRAND|Cartier|2|100|draft|1');

  -- Don't sync with Page365: untouched.
  INSERT INTO public.website_products (sku, name, status, origin, condition, metals, first_published_at, page365_product_id, page365_sync_disabled)
  VALUES ('Y0004', 'Y0004 Necklace K18 3.0g 45cm', 'active', 'JAPAN', 'New', ARRAY['K18'], now(), 11, true) RETURNING id INTO p;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty) VALUES (p, 100, 2);
  INSERT INTO public.audit_logs (entity_type, entity_id, action) VALUES ('website_product', p, 'page365_name_followed');
  PERFORM pg_temp.eq('sync off untouched', pg_temp.v('Y0004'), '-|-|-|New|JAPAN|-|2|100|active|0');

  INSERT INTO public.website_products (sku, name, status, origin, condition, metals, page365_product_id, page365_sync_disabled)
  VALUES ('Y0006', 'Y0006 Ring Cartier K18 2.0g Sz# 10 [Used]', 'draft', 'UNKNOWN', 'New', ARRAY['K18'], 13, true) RETURNING id INTO p;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty) VALUES (p, 100, 2);
  INSERT INTO public.audit_logs (entity_type, entity_id, action) VALUES ('website_product', p, 'page365_name_followed');
  PERFORM pg_temp.eq('sync off draft untouched', pg_temp.v('Y0006'), '-|-|-|New|UNKNOWN|-|2|100|draft|0');

  -- Other audit actions do nothing.
  INSERT INTO public.audit_logs (entity_type, entity_id, action) VALUES ('website_product', p, 'website_product_published');

  -- A prefill error never blocks the audit row (the name follow).
  ALTER TABLE public.website_product_variants ADD CONSTRAINT t9 CHECK (size IS DISTINCT FROM '77cm') NOT VALID;
  INSERT INTO public.website_products (sku, name, status, origin, condition, metals, first_published_at, page365_product_id)
  VALUES ('Y0005', 'Y0005 Necklace K18 3.0g 77cm', 'active', 'JAPAN', 'New', ARRAY['K18'], now(), 12) RETURNING id INTO p;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty) VALUES (p, 100, 2);
  INSERT INTO public.audit_logs (entity_type, entity_id, action) VALUES ('website_product', p, 'page365_name_followed');
  PERFORM pg_temp.eq('error: follow row kept', (SELECT count(*)::int FROM public.audit_logs WHERE entity_id = p AND action = 'page365_name_followed'), 1);
  PERFORM pg_temp.eq('error: prefill rolled back whole', pg_temp.v('Y0005'), '-|-|-|New|JAPAN|-|2|100|active|0');
  ALTER TABLE public.website_product_variants DROP CONSTRAINT t9;
END
$t$;
\echo ALL PREFILL-FOLLOW CHECKS PASSED
