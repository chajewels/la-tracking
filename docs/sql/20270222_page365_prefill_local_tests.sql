-- ============================================================================
-- Page365 prefill from name (2026-10-30) -- LOCAL behaviour tests. Local
-- Postgres only; sequence in docs/sql/20270222_page365_prefill_local_stub.sql.
-- Every check RAISEs on failure; the last line prints
-- ALL PAGE365-PREFILL CHECKS PASSED.
-- Each case lands like page365_inventory_land_run does: product (draft), its
-- one variant, then the page365_landings row (the trigger fires there).
-- ============================================================================
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.eq(label text, got anyelement, want anyelement) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL %: got %, want %', label, got, want; END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.land(p_name text, p_metals text[], p_kind text DEFAULT 'jewelry',
                                       p_cond text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_pid uuid; v_code text := split_part(p_name, ' ', 1);
BEGIN
  INSERT INTO public.website_products (sku, name, status, origin, condition, metals, item_kind)
  VALUES (v_code, p_name, 'draft', 'UNKNOWN',
          coalesce(p_cond, CASE WHEN p_name ~* '\[\s*pre-?loved\s*\]' THEN 'Preloved' ELSE 'New' END), p_metals, p_kind)
  RETURNING id INTO v_pid;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty) VALUES (v_pid, 50000, 1);
  INSERT INTO public.page365_landings (product_id, code, name) VALUES (v_pid, v_code, p_name);
  RETURN v_pid;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.types(p uuid) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(c.slug, ',' ORDER BY c.slug), '') FROM public.website_collection_products x
    JOIN public.website_collections c ON c.id = x.collection_id WHERE x.product_id = p $$;
CREATE OR REPLACE FUNCTION pg_temp.cats(p uuid) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce(string_agg(c.slug, ',' ORDER BY c.slug), '') FROM public.website_category_products x
    JOIN public.website_categories c ON c.id = x.category_id WHERE x.product_id = p $$;
CREATE OR REPLACE FUNCTION pg_temp.row(p uuid) RETURNS text LANGUAGE sql AS $$
  SELECT wp.condition || '|' || wp.origin || '|' || coalesce(wp.brand, '-') || '|' || coalesce(wp.weight_g::text, '-')
         || '|' || coalesce(v.size, '-') || '|' || coalesce(v.stone, '-') || '|' || v.stock_qty || '|' || v.price_jpy
         || '|' || wp.status::text
    FROM public.website_products wp JOIN public.website_product_variants v ON v.product_id = wp.id WHERE wp.id = p $$;

DO $t$
DECLARE p uuid;
BEGIN
  -- 1. Preloved, no brand, PT900 ring.
  p := pg_temp.land('Z1508 Ring PT900 11.50g Diamond 1.0ct Sz# 20 [Preloved]', ARRAY['PT900']);
  PERFORM pg_temp.eq('1 row', pg_temp.row(p), 'Preloved|JAPAN|-|11.50|20|Diamond|1|50000|draft');
  PERFORM pg_temp.eq('1 types', pg_temp.types(p), 'rings');
  PERFORM pg_temp.eq('1 cats', pg_temp.cats(p), 'preloved-jewelry');

  -- 2. New, no brand -> Fine Jewelry, condition New.
  p := pg_temp.land('Z8550 Necklace K18 11.95g Oval Snake Chain 50cm', ARRAY['K18']);
  PERFORM pg_temp.eq('2 row', pg_temp.row(p), 'New|JAPAN|-|11.95|50cm|-|1|50000|draft');
  PERFORM pg_temp.eq('2 types', pg_temp.types(p), 'necklaces');
  PERFORM pg_temp.eq('2 cats', pg_temp.cats(p), 'fine-jewelry');

  -- 3. Brand (Page365 spelling "Tiffany & Co." with the dot), 750PG.
  p := pg_temp.land('Z3045 Necklace Tiffany & Co. 750PG 3.0g Heart Tag 45cm [Preloved]', ARRAY['750']);
  PERFORM pg_temp.eq('3 row', pg_temp.row(p), 'Preloved|BRAND|Tiffany & Co.|3.00|45cm|-|1|50000|draft');
  PERFORM pg_temp.eq('3 cats', pg_temp.cats(p), 'preloved-branded-jewelry');

  -- 3b. Brand spellings: "Tiffany & Co" (no dot), "Hermes", "YSL", "Bulgari".
  PERFORM pg_temp.eq('3b tiffany', public.page365_prefill_brand('N2854 Necklace Tiffany & Co SV925 1837 Lock Charm 41cm'), 'Tiffany & Co.');
  PERFORM pg_temp.eq('3b tiffany alone', public.page365_prefill_brand('C0813 Watch Tiffany Atlas Dome Quartz'), 'Tiffany & Co.');
  PERFORM pg_temp.eq('3b hermes', public.page365_prefill_brand('WH902 Watch Hermes Clipper Quartz'), 'Herm' || chr(232) || 's');
  PERFORM pg_temp.eq('3b ysl', public.page365_prefill_brand('N9 Necklace YSL K18 3.0g'), 'Saint Laurent');
  PERFORM pg_temp.eq('3b bulgari', public.page365_prefill_brand('R9 Ring Bulgari 750 3.0g'), 'Bvlgari');
  PERFORM pg_temp.eq('3b van cleef', public.page365_prefill_brand('C0983 Watch Van Cleef & Arpels La Collection'), 'Van Cleef & Arpels');
  PERFORM pg_temp.eq('3b casio', public.page365_prefill_brand('C1395 Watch Casio G-SHOCK Full Metal'), 'Casio G-SHOCK');
  PERFORM pg_temp.eq('3b none', public.page365_prefill_brand('R1508 Ring PT900 11.50g Diamond 1.0ct'), NULL::text);
  PERFORM pg_temp.eq('3b code is not a brand', public.page365_prefill_brand('GUCCI1 Ring K18 2.0g'), NULL::text);

  -- 4. 18K, no brand -> Other.  5. AU750 written in the name -> Other.
  p := pg_temp.land('Z6613 Ring 18K 6.60g Diamond 1.0ct Interlock C Buckle Sz# 13.5 [Preloved]', ARRAY['18K']);
  PERFORM pg_temp.eq('4 row', pg_temp.row(p), 'Preloved|OTHER|-|6.60|13.5|Diamond|1|50000|draft');
  p := pg_temp.land('Z7501 Bracelet AU750 4.0g Chain 18cm', ARRAY[]::text[]);
  PERFORM pg_temp.eq('5 row', pg_temp.row(p), 'New|OTHER|-|4.00|18cm|-|1|50000|draft');
  PERFORM pg_temp.eq('5 cats', pg_temp.cats(p), 'fine-jewelry');

  -- 6. Watch with brand, no type word: Luxury Watches; size in cm; no stone (Quartz is not a stone).
  p := pg_temp.land('Z1244 Hermes Arceau Quartz Stainless Steel/GP/Leather White 13-16cm [Preloved]', ARRAY[]::text[], 'watch');
  PERFORM pg_temp.eq('6 row', pg_temp.row(p), 'Preloved|BRAND|Herm' || chr(232) || 's|-|13-16cm|-|1|50000|draft');
  PERFORM pg_temp.eq('6 types', pg_temp.types(p), 'luxury-watches');
  PERFORM pg_temp.eq('6 cats', pg_temp.cats(p), 'preloved-watches');

  -- 7. Accessory: key case -> Luxury Wallet; no size, no stone.
  p := pg_temp.land('Z2410 Key Case Gucci 6 Key [Preloved]', ARRAY[]::text[], 'accessory');
  PERFORM pg_temp.eq('7 row', pg_temp.row(p), 'Preloved|BRAND|Gucci|-|-|-|1|50000|draft');
  PERFORM pg_temp.eq('7 types', pg_temp.types(p), 'luxury-wallet');
  PERFORM pg_temp.eq('7 cats', pg_temp.cats(p), 'preloved-designer-accessories');
  p := pg_temp.land('Z2200 Bag Burberry Leather Clutch Second Bag [Preloved]', ARRAY[]::text[], 'accessory');
  PERFORM pg_temp.eq('7b types', pg_temp.types(p), 'luxury-bags');
  p := pg_temp.land('Z2948 Belt Louis Vuitton Belt - LV Dimension Reversible 85/34 [Preloved]', ARRAY[]::text[], 'accessory');
  PERFORM pg_temp.eq('7c types', pg_temp.types(p), 'other-accessories');

  -- 8. Pearl: Necklaces + Pearls, stone Pearl; "10mm" is not a size.
  p := pg_temp.land('Z1045 Necklace K18 2.15g Black SSP Tahiti 10mm Pearl 45cm Pinslide', ARRAY['K18']);
  PERFORM pg_temp.eq('8 row', pg_temp.row(p), 'New|JAPAN|-|2.15|45cm|Black South Sea Pearl|1|50000|draft');
  PERFORM pg_temp.eq('8 types', pg_temp.types(p), 'necklaces,pearls');
  -- Mother of pearl is not a pearl type.
  p := pg_temp.land('Z1046 Pendant K18 2.0g Mother of Pearl Diamond 0.05ct', ARRAY['K18']);
  PERFORM pg_temp.eq('8b row', pg_temp.row(p), 'New|JAPAN|-|2.00|-|Mother of Pearl, Diamond|1|50000|draft');
  PERFORM pg_temp.eq('8b types', pg_temp.types(p), 'pendants');

  -- 9. "Inspired" never gets a brand.
  p := pg_temp.land('Z3M44 Bracelet K18 1.80g Cartier Love Inspired 15+3cm', ARRAY['K18']);
  PERFORM pg_temp.eq('9 row', pg_temp.row(p), 'New|JAPAN|-|1.80|15+3cm|-|1|50000|draft');

  -- 10. Stones: abbreviations, order, Sapp, S/E ..ct.
  PERFORM pg_temp.eq('10a', public.page365_prefill_stones('N7514 Necklace Ponte Vecchio 750 1.40g R0.12ct D0.11ct Flower 40cm'), 'Ruby, Diamond');
  PERFORM pg_temp.eq('10b', public.page365_prefill_stones('R1111 Ring PT900 10.0g Sapp 2.44ct'), 'Sapphire');
  PERFORM pg_temp.eq('10c', public.page365_prefill_stones('R2 Ring K18 S1.20ct E0.50ct D0.30ct'), 'Sapphire, Emerald, Diamond');
  PERFORM pg_temp.eq('10d', public.page365_prefill_stones('N1243 Necklace Bvlgari 750PG 12.10g Bvlgari Diamond Onyx 43cm'), 'Diamond, Onyx');
  PERFORM pg_temp.eq('10e', public.page365_prefill_stones('P7350 Pendant K18 7.35g Shell Diamond 0.18ct Turtle Buddha'), 'Shell, Diamond');
  PERFORM pg_temp.eq('10f', public.page365_prefill_stones('R3432 Ring PT900 5.40g Emerald 1.51ct Diamond 0.13ct Sz# 13.5'), 'Emerald, Diamond');
  PERFORM pg_temp.eq('10h akoya', public.page365_prefill_stones('N2157 Necklace SV925 Akoya Pearl 7.4-7.8mm 44cm'), 'Akoya Pearl');
  PERFORM pg_temp.eq('10i qualifiers', public.page365_prefill_stones('NLTSQ Necklace K18 Labradorite Smoky Quartz White Topaz 3 Layers'), 'Labradorite, Smoky Quartz, White Topaz');
  PERFORM pg_temp.eq('10j short forms', public.page365_prefill_stones('R1381 Ring K18 9.40g Eme Sapp Ruby Diamond Sz# 16'), 'Emerald, Sapphire, Ruby, Diamond');
  PERFORM pg_temp.eq('10k Bl Topaz', public.page365_prefill_stones('R3040 Ring K18 13.90g Bl Topaz 9.78ct Dia 0.45ct'), 'Blue Topaz, Diamond');
  -- 2026-10-30 review fixes (migration 20270223100000).
  PERFORM pg_temp.eq('21a unknown before ct -> blank', public.page365_prefill_stones('R3039 18KWG 13.90g Mix Gems 12.89ct Bl Topaz 9.78ct Dia 0.45ct'), NULL::text);
  PERFORM pg_temp.eq('21b B.T + unknown T', public.page365_prefill_stones('E5432 Earrings K18 5.40g B.T 0.86ct T 0.22ct Dia 0.32ct'), NULL::text);
  PERFORM pg_temp.eq('21c B.T', public.page365_prefill_stones('E1 Earrings K18 B.T 0.86ct Dia 0.32ct'), 'Blue Topaz, Diamond');
  PERFORM pg_temp.eq('21d diamond cut', public.page365_prefill_stones('N1 Necklace K18 5.0g Diamond Cut Chain 45cm'), NULL::text);
  PERFORM pg_temp.eq('21e emerald cut', public.page365_prefill_stones('R1 Ring PT900 Diamond 1.0ct Emerald Cut Sz# 12'), 'Diamond');
  PERFORM pg_temp.eq('21f colour enamel', public.page365_prefill_stones('P1 Pendant K18 Turquoise Blue Enamel Top'), NULL::text);
  PERFORM pg_temp.eq('21g inspiration', public.page365_prefill_brand('P1 Pendant K18 Cartier Inspiration Love Top'), NULL::text);
  PERFORM pg_temp.eq('21h type', public.page365_prefill_brand('R1 Ring K18 Van Cleef Type Clover'), NULL::text);
  PERFORM pg_temp.eq('21i -like', public.page365_prefill_brand('N1 Necklace K18 Cartier-like'), NULL::text);
  PERFORM pg_temp.eq('21j fixed list', public.page365_prefill_brand('N1049 Necklace Mikimoto K18 Akoya Pearl 45cm'), 'Mikimoto');
  PERFORM pg_temp.eq('21k AxB cm', public.page365_prefill_length('P1 Pendant K18 Top 2.5x1.5cm'), '2.5x1.5cm');
  PERFORM pg_temp.eq('21l ring range vs weight', public.page365_prefill_ring_size('R1 Ring K18 Sz# 13 - 2.0g'), '13');
  PERFORM pg_temp.eq('21m ring range vs weight 2', public.page365_prefill_ring_size('R1 Ring K18 Sz# 11-1.50g'), '11');
  PERFORM pg_temp.eq('21n Sz without #', public.page365_prefill_ring_size('R1 Ring K18 Sz 12'), NULL::text);
  PERFORM pg_temp.eq('21o never used', public.page365_prefill_secondhand('N1 Necklace K18 5.0g [Never Used]'), false);
  p := pg_temp.land('Z1049 Necklace Mikimoto K18 3.0g Akoya Pearl 45cm [Preloved]', ARRAY['K18']);
  PERFORM pg_temp.eq('21p Mikimoto lands Branded', pg_temp.row(p), 'Preloved|BRAND|Mikimoto|3.00|45cm|Akoya Pearl|1|50000|draft');
  PERFORM pg_temp.eq('21p cats', pg_temp.cats(p), 'preloved-branded-jewelry');
  PERFORM pg_temp.eq('21p types', pg_temp.types(p), 'necklaces,pearls');
  p := pg_temp.land('Z1050 Necklace K18 2.0g Pearl-like Shell 45cm', ARRAY['K18']);
  PERFORM pg_temp.eq('21q pearl-like no Pearls type', pg_temp.types(p), 'necklaces');
  PERFORM pg_temp.eq('10l star sapp', public.page365_prefill_stones('R1312 Ring PT900 12.80g Star Sapp 4.93ct Dia 0.95ct'), 'Star Sapphire, Diamond');
  PERFORM pg_temp.eq('10m plain quartz', public.page365_prefill_stones('P1991 Pendant K18 6.0g Ruby 0.11ct Diamond 0.12ct Quartz'), 'Ruby, Diamond');
  PERFORM pg_temp.eq('10n south sea', public.page365_prefill_stones('ESH9 Earrings PT900 Natural White South Sea Pearl 9.0mm Hook'), 'Natural White South Sea Pearl');
  PERFORM pg_temp.eq('10o coral pair', public.page365_prefill_stones('NLWCL Necklace K18 White Coral Lapiz Lazuli 3 Layers'), 'White Coral, Lapiz Lazuli');
  PERFORM pg_temp.eq('10p sango', public.page365_prefill_stones('R5180 Ring PT900 5.0g Sango Diamond 0.13ct Sz# 17'), 'Sango, Diamond');
  PERFORM pg_temp.eq('10q tahiti only before pearl', public.page365_prefill_stones('N2676 Necklace SV 46.80g SSP Tahiti Labradorite Mixed 46cm'), 'South Sea Pearl, Labradorite');
  PERFORM pg_temp.eq('10r rose only before quartz', public.page365_prefill_stones('N1131 Necklace Piaget 750 4.10g Rose Diamond 40cm'), 'Diamond');
  PERFORM pg_temp.eq('20 PT850 Japan', public.page365_prefill_origin('N9838 Necklace PT850 9.80g Emerald', ARRAY['PT850']), 'JAPAN');
  PERFORM pg_temp.eq('20 silver stays blank', public.page365_prefill_origin('N2157 Necklace SV925 Akoya Pearl', ARRAY['SILVER925']), NULL::text);
  PERFORM pg_temp.eq('10g code', public.page365_prefill_stones('D0123 Ring K18 2.0g'), NULL::text);

  -- 11. Sizes and weights.
  PERFORM pg_temp.eq('11a #57 only', public.page365_prefill_ring_size('RC457 Ring Cartier 750 5.10g 3 Tone Gold Wedding Ring #57'), NULL::text);
  PERFORM pg_temp.eq('11b Sz# over #', public.page365_prefill_ring_size('R3694 Ring Gucci Blind For Love Ring #18 Sz# 17 [Used]'), '17');
  PERFORM pg_temp.eq('11c K18g', public.page365_prefill_weight('N5245 Necklace K18g 5.28g Diamond'), 5.28);
  PERFORM pg_temp.eq('11d none', public.page365_prefill_weight('R3694 Ring Gucci Blind For Love Ring #18 Sz# 17'), NULL::numeric);
  PERFORM pg_temp.eq('11e 15-17.5cm', public.page365_prefill_length('W1282 Watch Montblanc Quartz GP White 15-17.5cm'), '15-17.5cm');
  PERFORM pg_temp.eq('11i ring range', public.page365_prefill_ring_size('R3M55 Ring K18 2.55g Teardrop and Open Sz# 12-14'), '12-14');
  PERFORM pg_temp.eq('11j glued Sz#', public.page365_prefill_ring_size('R8595 Ring K18 PT900 8.45g Diamond 0.50ct Tri-ColorSz# 9.5'), '9.5');
  PERFORM pg_temp.eq('11k mm', public.page365_prefill_mm('P1982 Pendant K18 1.50g Heart Shaped 4x13mm Reversible'), '4x13mm');
  p := pg_temp.land('Z1010 Earrings PT900 1.0g Diamond 0.10ct 5.0mm Stud [Preloved]', ARRAY['PT900']);
  PERFORM pg_temp.eq('11l earrings mm', pg_temp.row(p), 'Preloved|JAPAN|-|1.00|5.0mm|Diamond|1|50000|draft');
  p := pg_temp.land('Z2456 Bracelet Louis Vuitton Brasserie Historique Mini 16cm [Preloved]', ARRAY[]::text[], 'accessory');
  PERFORM pg_temp.eq('11m accessory bracelet cm', pg_temp.row(p), 'Preloved|BRAND|Louis Vuitton|-|16cm|-|1|50000|draft');
  PERFORM pg_temp.eq('11g range', public.page365_prefill_weight('UL416 Pendant K18 0.6-0.7g Inspiration Top'), NULL::numeric);
  PERFORM pg_temp.eq('11h 0.90g', public.page365_prefill_weight('P1421 Pendant K18 0.90g Ruby 0.43ct'), 0.90);
  PERFORM pg_temp.eq('12g typo', public.page365_prefill_secondhand('SB094 Bag Gucci Soho Shoulder Bag [Prelvoed]'), true);
  PERFORM pg_temp.eq('11f full-width space', public.page365_prefill_weight('N1' || chr(12288) || 'Necklace K18 3.0g'), 3.00);

  -- 12. Condition words.
  PERFORM pg_temp.eq('12a used', public.page365_prefill_secondhand('W1465 Watch Bvlgari Collection Quartz SS Black 13cm [Used]'), true);
  PERFORM pg_temp.eq('12b pre-owned', public.page365_prefill_secondhand('R1 Ring K18 Pre-owned'), true);
  PERFORM pg_temp.eq('12c second hand', public.page365_prefill_secondhand('R1 Ring K18 second hand'), true);
  PERFORM pg_temp.eq('12d unused', public.page365_prefill_secondhand('R1 Ring K18 Unused'), false);
  p := pg_temp.land('Z1112 Watch Hermes Loquet Quartz GP Champagne 15.5cm [Used]', ARRAY[]::text[], 'watch');
  PERFORM pg_temp.eq('12e used lands Preloved', pg_temp.row(p), 'Preloved|BRAND|Herm' || chr(232) || 's|-|15.5cm|-|1|50000|draft');
  -- A Preloved (from the Page365 category) is never turned back to New.
  p := pg_temp.land('Z1113 Ring K18 2.0g Sz# 10', ARRAY['K18'], 'jewelry', 'Preloved');
  PERFORM pg_temp.eq('12f stays Preloved', pg_temp.row(p), 'Preloved|JAPAN|-|2.00|10|-|1|50000|draft');
  PERFORM pg_temp.eq('12f cats', pg_temp.cats(p), 'preloved-jewelry');

  -- 13. New + brand: category left blank.
  p := pg_temp.land('Z4034 Necklace Saint Laurent K18 3.40g Logo YSL 40cm', ARRAY['K18']);
  PERFORM pg_temp.eq('13 row', pg_temp.row(p), 'New|BRAND|Saint Laurent|3.40|40cm|-|1|50000|draft');
  PERFORM pg_temp.eq('13 cats', pg_temp.cats(p), '');

  -- 14. No evidence: everything stays blank.
  p := pg_temp.land('Z0001 Charm Lucky', ARRAY[]::text[]);
  PERFORM pg_temp.eq('14 row', pg_temp.row(p), 'New|UNKNOWN|-|-|-|-|1|50000|draft');
  PERFORM pg_temp.eq('14 types', pg_temp.types(p), '');
  PERFORM pg_temp.eq('14 cats', pg_temp.cats(p), 'fine-jewelry');

  -- 15. Filled fields are never overwritten (staff set them before the prefill ran).
  INSERT INTO public.website_products (sku, name, status, origin, brand, condition, metals, weight_g)
  VALUES ('Z9000', 'Z9000 Ring Cartier K18 9.99g Ruby Sz# 11 [Preloved]', 'draft', 'JAPAN', 'Staff Brand', 'Preloved', ARRAY['K18'], 1.23)
  RETURNING id INTO p;
  INSERT INTO public.website_product_variants (product_id, size, stone, price_jpy, stock_qty) VALUES (p, '7', 'Garnet', 1, 0);
  INSERT INTO public.website_collection_products (collection_id, product_id) SELECT id, p FROM public.website_collections WHERE slug = 'pendants';
  INSERT INTO public.website_category_products (category_id, product_id) SELECT id, p FROM public.website_categories WHERE slug = 'fine-jewelry';
  INSERT INTO public.page365_landings (product_id, code, name) VALUES (p, 'Z9000', 'x');
  PERFORM pg_temp.eq('15 row', pg_temp.row(p), 'Preloved|JAPAN|Staff Brand|1.23|7|Garnet|0|1|draft');
  PERFORM pg_temp.eq('15 types', pg_temp.types(p), 'pendants');
  PERFORM pg_temp.eq('15 cats', pg_temp.cats(p), 'fine-jewelry');

  -- 16. A product that was ever public is never touched.
  INSERT INTO public.website_products (sku, name, status, first_published_at, metals)
  VALUES ('Z9001', 'Z9001 Ring K18 2.0g Diamond Sz# 9 [Used]', 'draft', now(), ARRAY['K18']) RETURNING id INTO p;
  INSERT INTO public.website_product_variants (product_id, price_jpy, stock_qty) VALUES (p, 1, 1);
  INSERT INTO public.page365_landings (product_id, code, name) VALUES (p, 'Z9001', 'x');
  PERFORM pg_temp.eq('16 row', pg_temp.row(p), 'New|UNKNOWN|-|-|-|-|1|1|draft');
  PERFORM pg_temp.eq('16 types', pg_temp.types(p), '');

  -- 17. One-time pass: the two live drafts.
  PERFORM pg_temp.eq('17 N2916', pg_temp.row('f17e0f39-616f-4cf2-b77a-9ee06de5644b'), 'Preloved|BRAND|Tiffany & Co.|-|40cm|-|1|10000|draft');
  PERFORM pg_temp.eq('17 N2916 types', pg_temp.types('f17e0f39-616f-4cf2-b77a-9ee06de5644b'), 'necklaces');
  PERFORM pg_temp.eq('17 N2916 cats', pg_temp.cats('f17e0f39-616f-4cf2-b77a-9ee06de5644b'), 'preloved-branded-jewelry');
  PERFORM pg_temp.eq('17 R3694', pg_temp.row('cb07c59a-4849-49fa-828e-2f868bff853f'), 'Preloved|BRAND|Gucci|-|17|-|1|10000|draft');
  PERFORM pg_temp.eq('17 R3694 types', pg_temp.types('cb07c59a-4849-49fa-828e-2f868bff853f'), 'rings');
  PERFORM pg_temp.eq('17 R3694 cats', pg_temp.cats('cb07c59a-4849-49fa-828e-2f868bff853f'), 'preloved-branded-jewelry');
  -- The staff draft R3701 is not part of the one-time pass.
  PERFORM pg_temp.eq('17 R3701 untouched', (SELECT origin || '|' || coalesce(brand, '-') FROM public.website_products WHERE sku = 'R3701'), 'UNKNOWN|-');

  -- 18. Audit row says what was filled.
  PERFORM pg_temp.eq('18 audit', (SELECT a.new_value_json->'filled' FROM public.audit_logs a
                                   WHERE a.entity_id = 'cb07c59a-4849-49fa-828e-2f868bff853f' AND a.action = 'page365_prefilled_from_name'
                                   ORDER BY a.id LIMIT 1),
                     '["condition", "brand", "origin", "product_types", "categories", "size"]'::jsonb);

  -- 19. A prefill error never blocks the landing.
  ALTER TABLE public.website_product_variants ADD CONSTRAINT t19 CHECK (size IS DISTINCT FROM '99') NOT VALID;
  p := pg_temp.land('Z9002 Ring K18 2.0g Sz# 99', ARRAY['K18']);
  PERFORM pg_temp.eq('19 landed', (SELECT count(*)::int FROM public.page365_landings WHERE product_id = p), 1);
  PERFORM pg_temp.eq('19 rolled back whole prefill', pg_temp.row(p), 'New|UNKNOWN|-|-|-|-|1|50000|draft');
  ALTER TABLE public.website_product_variants DROP CONSTRAINT t19;
END
$t$;

\echo ALL PAGE365-PREFILL CHECKS PASSED
