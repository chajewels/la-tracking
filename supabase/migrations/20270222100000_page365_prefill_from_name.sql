-- ===========================================================================
-- Page365 landing: prefill the Edit product fields from the product NAME
-- (owner request 2026-10-30).
--
-- When a new Page365 product lands in the Catalog (page365_inventory_land_run
-- inserts its page365_landings row), the fields staff used to fill by hand are
-- read from the name. ONLY blank fields are filled; nothing staff typed is
-- ever overwritten; no stock, price, photo, status or setting changes; the
-- product stays a draft.
--
--   Product types  the type word in the name: Ring -> Rings, Necklace ->
--                  Necklaces, Pendant -> Pendants, Bracelet / Bangle ->
--                  Bracelets, Earrings / Pierce -> Earrings, Anklet -> Anklets;
--                  a watch -> Luxury Watches; Bag / Clutch / Tote ... ->
--                  Luxury Bags; Wallet / Key / Coin / Card / Pass case ->
--                  Luxury Wallet; Belt -> Other Accessories. "Pearl" in a
--                  jewelry name (or SSP / Akoya) also adds Pearls.
--   Condition      Preloved / Pre-loved / Pre-owned / Used / Second-hand (and the
--                  typo Prelvoed) in the
--                  name -> Preloved (a New never stays New on that evidence;
--                  a Preloved is never turned back to New).
--   Categories     jewelry: Preloved + brand -> Preloved Branded Jewelry,
--                  Preloved no brand -> Preloved Jewelry, New no brand -> Fine
--                  Jewelry (New + brand: left blank). Watch + Preloved ->
--                  Preloved Branded Watches. Accessory + Preloved -> Preloved
--                  Designer Accessories.
--   Weight         the first "<number>g" ("11.50g" -> 11.50); a range like
--                  "0.6-0.7g" is left blank.
--   Origin, Brand  a brand in the name -> Branded + the brand. Brands = every
--                  brand already saved in the Catalog, plus the spellings
--                  Page365 names use (Tiffany / Tiffany & Co -> Tiffany & Co.,
--                  Hermes -> Hermes with the accent, YSL -> Saint Laurent,
--                  Bulgari -> Bvlgari, Van Cleef -> Van Cleef & Arpels). A name
--                  saying "inspired" or "style" never gets a brand. No brand:
--                  750 / 18K / AU750 -> Other; K24 K18 K14 K10 PT1000 PT950
--                  PT900 PT850 PM PM900 -> Made in Japan; silver and anything
--                  else stays Unknown (silver is set by hand, owner
--                  2026-10-30).
--   Size           ring: the number after "Sz#" ("13.5", "12-14"; a bare "#57"
--                  is left blank); earrings / pendants: the length in cm, else
--                  the size in mm ("10.0mm"); necklaces, bracelets, anklets,
--                  watches: the length in cm ("45cm", "15+3cm", "13-16cm").
--   Stone          jewelry only: every stone named, in name order, with the
--                  words in front of it ("Ruby 0.61ct Dia 0.25ct" -> "Ruby,
--                  Diamond"; "Akoya Pearl", "Blue Topaz", "Star Sapphire";
--                  D0.11ct -> Diamond, R0.12ct -> Ruby, Sapp -> Sapphire,
--                  SSP -> South Sea Pearl).
--   No evidence in the name -> the field stays blank.
--
-- Wiring: an AFTER INSERT trigger on page365_landings. land_run is NOT edited
-- (live md5 pinned below); the trigger swallows its own errors, so a prefill
-- problem can never undo a landing.
-- One-time: the two drafts that landed before this and were never completed
-- (N2916, R3694 -- owner 2026-10-30: fill what the name proves, else blank).
--
-- The whole file is ASCII on purpose (the Lovable DB connection rewrites
-- non-ASCII characters inside function bodies -- 2026-10-27 lesson); the
-- accented Hermes is built with chr(232).
-- ===========================================================================

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '300s';

-- ---------------------------------------------------------------------------
-- 0. Pre-flight. Nothing below runs unless every check passes.
-- ---------------------------------------------------------------------------
DO $pre$
DECLARE
  v_got text;
BEGIN
  IF to_regclass('public.page365_landings') IS NULL OR to_regclass('public.website_products') IS NULL
     OR to_regclass('public.website_product_variants') IS NULL OR to_regclass('public.website_collections') IS NULL
     OR to_regclass('public.website_collection_products') IS NULL OR to_regclass('public.website_categories') IS NULL
     OR to_regclass('public.website_category_products') IS NULL OR to_regclass('public.audit_logs') IS NULL THEN
    RAISE EXCEPTION 'page365_prefill_from_name: a required table is missing';
  END IF;
  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.page365_inventory_land_run(uuid)');
  IF v_got IS DISTINCT FROM '7f27675ecd45453b1577fa5f6e6ba738' THEN
    RAISE EXCEPTION 'page365_prefill_from_name: live land_run md5 % (expected 7f27675ecd45453b1577fa5f6e6ba738) -- nothing changed',
      coalesce(v_got, 'missing');
  END IF;
  IF (SELECT count(*) FROM public.website_collections
       WHERE slug IN ('rings','necklaces','pendants','bracelets','earrings','anklets','pearls',
                      'luxury-watches','luxury-bags','luxury-wallet','other-accessories')) <> 11
     OR (SELECT count(*) FROM public.website_categories
          WHERE slug IN ('fine-jewelry','preloved-jewelry','preloved-branded-jewelry','preloved-watches',
                         'preloved-designer-accessories')) <> 5 THEN
    RAISE EXCEPTION 'page365_prefill_from_name: a product type or category slug is missing';
  END IF;

  -- For the self-check: no product count, status, stock or price moves.
  PERFORM set_config('page365.prefill_before',
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1), ',' ORDER BY v.id), ''))
          FROM public.website_product_variants v),
    false);
  -- Every product other than the two one-time drafts must come out untouched.
  PERFORM set_config('page365.prefill_others',
    (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.condition || ':' || wp.origin || ':' || coalesce(wp.brand, '') || ':'
                 || coalesce(wp.weight_g::text, ''), ',' ORDER BY wp.id), ''))
       FROM public.website_products wp
      WHERE wp.id NOT IN ('f17e0f39-616f-4cf2-b77a-9ee06de5644b', 'cb07c59a-4849-49fa-828e-2f868bff853f')),
    false);
END
$pre$;

-- ---------------------------------------------------------------------------
-- 1. Readers (pure, except brand / collection / category lookups).
-- ---------------------------------------------------------------------------

-- The name without its code (the first word), full-width / no-break spaces as spaces.
CREATE OR REPLACE FUNCTION public.page365_prefill_rest(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT btrim(regexp_replace(translate(coalesce(p_name, ''), chr(12288) || chr(160), '  '), '^\s*\S+\s*', ''))
$fn$;

-- Any wording that makes the piece secondhand.
CREATE OR REPLACE FUNCTION public.page365_prefill_secondhand(p_name text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT public.page365_prefill_rest(p_name) ~* '(pre-?\s?loved|prelvoed|pre-?\s?owned|\mused\M|second-?\s?hand)'
$fn$;

-- The first "<number>g" (lower-case g, its own word: "K18g" is not a weight;
-- a range such as "0.6-0.7g" is not one weight, so it is left blank).
CREATE OR REPLACE FUNCTION public.page365_prefill_weight(p_name text)
RETURNS numeric
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN m IS NOT NULL AND m::numeric > 0 AND m::numeric < 100000 THEN round(m::numeric, 2) END
    FROM (SELECT (regexp_match(public.page365_prefill_rest(p_name), '(?:^|[^0-9A-Za-z.~-])(\d+(?:\.\d+)?)\s?g\M'))[1] AS m) x
   WHERE public.page365_prefill_rest(p_name) !~ '\d\s*[-~]\s*\d+(\.\d+)?\s?g\M'
$fn$;

-- Ring size: the number (or range "12-14") after "Sz#" only.
CREATE OR REPLACE FUNCTION public.page365_prefill_ring_size(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT regexp_replace((regexp_match(public.page365_prefill_rest(p_name),
           '(?:sz\s*#|\msz)\s*(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)', 'i'))[1], '\s', '', 'g')
$fn$;

-- Length in cm, as written without spaces: "45cm", "15+3cm", "13-16cm".
CREATE OR REPLACE FUNCTION public.page365_prefill_length(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT regexp_replace(m, '\s', '', 'g') || 'cm'
    FROM (SELECT (regexp_match(public.page365_prefill_rest(p_name),
                  '\m(\d+(?:\.\d+)?(?:\s*[-+~]\s*\d+(?:\.\d+)?)?)\s?cm\M', 'i'))[1] AS m) x
   WHERE m IS NOT NULL
$fn$;

-- Size in mm (earrings and pendants with no cm): "10.0mm", "4x13mm".
CREATE OR REPLACE FUNCTION public.page365_prefill_mm(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT regexp_replace(m, '\s', '', 'g') || 'mm'
    FROM (SELECT (regexp_match(public.page365_prefill_rest(p_name),
                  '\m(\d+(?:\.\d+)?(?:\s*[-x]\s*\d+(?:\.\d+)?)?)\s?mm\M', 'i'))[1] AS m) x
   WHERE m IS NOT NULL
$fn$;

-- Stones named in the name, in name order, comma separated, with the words
-- staff keep in front of a stone ("Akoya Pearl", "Blue Topaz", "Star
-- Sapphire", "White Coral"). Short forms: Dia / D0.11ct -> Diamond, R0.12ct
-- -> Ruby, Sapp / S..ct -> Sapphire, Eme / E..ct -> Emerald, SSP -> South Sea
-- Pearl, Bl -> Blue. Plain "Quartz" is a watch movement, not a stone (only
-- Smoky / Strawberry / Rose / White / Rutilated Quartz count). Null = none.
CREATE OR REPLACE FUNCTION public.page365_prefill_stones(p_name text)
RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path TO 'public'
AS $fn$
DECLARE
  w     text[];
  n     integer;
  i     integer;
  j     integer;
  lw    text;
  base  text;
  quals text;
  lbl   text;
  outs  text[] := ARRAY[]::text[];
  keep  text[] := ARRAY[]::text[];
  x     text;
BEGIN
  w := regexp_split_to_array(btrim(regexp_replace(
         regexp_replace(public.page365_prefill_rest(p_name), 'mother\s+of\s+pearls?', 'Mother-of-Pearl', 'gi'),
         '[,;()\[\]/]+', ' ', 'g')), '\s+');
  n := coalesce(array_length(w, 1), 0);
  i := 1;
  WHILE i <= n LOOP
    lw := lower(w[i]);
    base := CASE
      WHEN lw ~ '^(diamonds?|dia)$' OR lw ~ '^d\d+(\.\d+)?ct$' THEN 'Diamond'
      WHEN lw ~ '^(ruby|rubies)$' OR lw ~ '^r\d+(\.\d+)?ct$' THEN 'Ruby'
      WHEN lw ~ '^(sapphires?|sapp)$' OR lw ~ '^s\d+(\.\d+)?ct$' THEN 'Sapphire'
      WHEN lw ~ '^(emeralds?|eme)$' OR lw ~ '^e\d+(\.\d+)?ct$' THEN 'Emerald'
      WHEN lw = 'mother-of-pearl' THEN 'Mother of Pearl'
      WHEN lw ~ '^pearls?$' THEN 'Pearl'
      WHEN lw = 'ssp' THEN 'South Sea Pearl'
      WHEN lw = 'quartz' AND i > 1 AND lower(w[i - 1]) IN ('smoky', 'strawberry', 'rose', 'white', 'rutilated') THEN 'Quartz'
      WHEN lw IN ('lapis', 'lapiz') AND i < n AND lower(w[i + 1]) = 'lazuli' THEN initcap(lw) || ' Lazuli'
      WHEN regexp_replace(lw, 's$', '') IN ('tanzanite', 'opal', 'amethyst', 'garnet', 'aquamarine', 'peridot', 'tourmaline',
                                              'coral', 'spinel', 'morganite', 'citrine', 'alexandrite', 'moonstone',
                                              'tsavorite', 'kunzite', 'moissanite', 'rutile', 'apatite', 'carnelian',
                                              'labradorite', 'rubellite', 'andalusite', 'iolite', 'agate', 'malachite',
                                              'chrysoprase', 'shell', 'jadeite', 'zirconia')
        THEN initcap(regexp_replace(lw, 's$', ''))
      WHEN lw IN ('topaz', 'onyx', 'jade', 'turquoise', 'sango') THEN initcap(lw)
    END;
    IF base IS NOT NULL THEN
      quals := '';
      j := i - 1;
      -- Pearl words only before a pearl; Rose only before Quartz.
      WHILE j >= 1 AND i - j <= 4
            AND (lower(w[j]) IN ('natural', 'white', 'black', 'blue', 'bl', 'pink', 'star', 'fire', 'green', 'smoky',
                                 'strawberry', 'rutilated', 'london', 'paraiba', 'yellow', 'cabochon')
                 OR (base LIKE '%Pearl' AND lower(w[j]) IN ('akoya', 'fresh', 'water', 'freshwater', 'south', 'sea', 'golden',
                                                            'mabe', 'tahiti', 'tahitian'))
                 OR (base = 'Quartz' AND lower(w[j]) = 'rose'))
      LOOP
        quals := CASE WHEN lower(w[j]) = 'bl' THEN 'Blue' ELSE initcap(w[j]) END || ' ' || quals;
        j := j - 1;
      END LOOP;
      lbl := quals || base;
      IF NOT lbl = ANY (outs) THEN outs := outs || lbl; END IF;
      IF lw IN ('lapis', 'lapiz') THEN i := i + 1; END IF;
    END IF;
    i := i + 1;
  END LOOP;
  -- "Pearl" next to "Akoya Pearl" says nothing more: keep the longer one.
  FOREACH x IN ARRAY outs LOOP
    IF NOT EXISTS (SELECT 1 FROM unnest(outs) o WHERE o <> x AND o LIKE '% ' || x) THEN keep := keep || x; END IF;
  END LOOP;
  RETURN nullif(array_to_string(keep, ', '), '');
END
$fn$;

-- A brand in the name: a brand already saved in the Catalog, or a Page365 spelling of one.
CREATE OR REPLACE FUNCTION public.page365_prefill_brand(p_name text)
RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  WITH t AS (SELECT lower(public.page365_prefill_rest(p_name)) AS s),
  known AS (
    SELECT DISTINCT btrim(wp.brand) AS canon FROM public.website_products wp WHERE btrim(coalesce(wp.brand, '')) <> ''
  ), cand AS (
    SELECT k.canon, lower(k.canon) AS pat FROM known k
    UNION
    SELECT a.canon, a.pat
      FROM (VALUES ('Tiffany & Co.', 'tiffany & co'), ('Tiffany & Co.', 'tiffany&co'), ('Tiffany & Co.', 'tiffany'),
                   ('Herm' || chr(232) || 's', 'hermes'), ('Saint Laurent', 'ysl'), ('Saint Laurent', 'yves saint laurent'),
                   ('Bvlgari', 'bulgari'), ('Van Cleef & Arpels', 'van cleef')) a(canon, pat)
     WHERE EXISTS (SELECT 1 FROM known k WHERE k.canon = a.canon)
  ), hits AS (
    SELECT c.canon,
           regexp_instr(t.s, '(^|[^a-z0-9])' || regexp_replace(c.pat, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')
                             || '($|[^a-z0-9])') AS pos,
           length(c.pat) AS len
      FROM cand c, t
  )
  SELECT h.canon FROM hits h, t
   WHERE h.pos > 0 AND t.s !~ '\m(inspired|style)\M'
   ORDER BY h.pos, h.len DESC, h.canon
   LIMIT 1
$fn$;

-- Origin with no brand, from the stamps (and AU750 written in the name).
CREATE OR REPLACE FUNCTION public.page365_prefill_origin(p_name text, p_metals text[])
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE
    WHEN coalesce(p_metals, '{}') && ARRAY['750', '18K'] OR public.page365_prefill_rest(p_name) ~* '\mau\s?750' THEN 'OTHER'
    WHEN coalesce(p_metals, '{}') && ARRAY['K24', 'K18', 'K14', 'K10', 'PT1000', 'PT950', 'PT900', 'PT850', 'PM', 'PM900'] THEN 'JAPAN'
  END
$fn$;

-- The product-type slug from the first type word of the name.
CREATE OR REPLACE FUNCTION public.page365_prefill_type_slug(p_name text, p_kind text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT CASE WHEN p_kind = 'watch' THEN 'luxury-watches' ELSE (
    SELECT s.slug FROM (
      SELECT x.ord,
             CASE
               WHEN w IN ('ring', 'rings') THEN 'rings'
               WHEN w IN ('necklace', 'necklaces', 'neckalce') THEN 'necklaces'
               WHEN w IN ('pendant', 'pendants') THEN 'pendants'
               WHEN w IN ('bracelet', 'bracelets', 'bangle', 'bangles') THEN 'bracelets'
               WHEN w IN ('earring', 'earrings', 'pierce', 'pierces', 'pierced') THEN 'earrings'
               WHEN w IN ('anklet', 'anklets') THEN 'anklets'
               WHEN p_kind = 'accessory' AND w IN ('bag', 'bags', 'handbag', 'handbags', 'clutch', 'tote', 'totes',
                                                   'purse', 'pouch', 'backpack') THEN 'luxury-bags'
               WHEN p_kind = 'accessory' AND w IN ('wallet', 'wallets', 'key', 'coin', 'card', 'cardholder', 'pass',
                                                   'passport', 'case') THEN 'luxury-wallet'
               WHEN p_kind = 'accessory' AND w IN ('belt', 'belts') THEN 'other-accessories'
             END AS slug
        FROM regexp_split_to_table(lower(public.page365_prefill_rest(p_name)), '[\s/,()\[\]]+') WITH ORDINALITY AS x(w, ord)
    ) s WHERE s.slug IS NOT NULL ORDER BY s.ord LIMIT 1) END
$fn$;

-- ---------------------------------------------------------------------------
-- 2. The prefill. Blank fields only; drafts that were never public only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.page365_prefill_from_name(p_product_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
  v_p      public.website_products%ROWTYPE;
  v_vid    uuid;
  v_vsize  text;
  v_vstone text;
  v_nvar   integer;
  v_kind   text;
  v_cond   text;
  v_brand  text;
  v_origin text;
  v_weight numeric;
  v_type   text;
  v_cat    text;
  v_size   text;
  v_stone  text;
  v_filled text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_p FROM public.website_products WHERE id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_p.status::text <> 'draft' OR v_p.first_published_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_new_draft');
  END IF;
  v_kind := v_p.item_kind;

  -- Condition: New -> Preloved only on wording that makes it secondhand.
  v_cond := CASE WHEN v_p.condition = 'New' AND public.page365_prefill_secondhand(v_p.name) THEN 'Preloved'
                 ELSE v_p.condition END;
  IF v_cond IS DISTINCT FROM v_p.condition THEN v_filled := array_append(v_filled, 'condition'); END IF;

  v_brand := nullif(btrim(coalesce(v_p.brand, '')), '');
  IF v_brand IS NULL THEN
    v_brand := public.page365_prefill_brand(v_p.name);
    IF v_brand IS NOT NULL THEN v_filled := array_append(v_filled, 'brand'); END IF;
  END IF;

  v_origin := v_p.origin;
  IF v_origin = 'UNKNOWN' THEN
    v_origin := coalesce(CASE WHEN v_brand IS NOT NULL THEN 'BRAND' ELSE public.page365_prefill_origin(v_p.name, v_p.metals) END,
                         'UNKNOWN');
    IF v_origin <> 'UNKNOWN' THEN v_filled := array_append(v_filled, 'origin'); END IF;
  END IF;

  v_weight := v_p.weight_g;
  IF v_weight IS NULL THEN
    v_weight := public.page365_prefill_weight(v_p.name);
    IF v_weight IS NOT NULL THEN v_filled := array_append(v_filled, 'weight_g'); END IF;
  END IF;

  IF v_cond IS DISTINCT FROM v_p.condition OR v_brand IS DISTINCT FROM v_p.brand
     OR v_origin IS DISTINCT FROM v_p.origin OR v_weight IS DISTINCT FROM v_p.weight_g THEN
    UPDATE public.website_products
       SET condition = v_cond, brand = v_brand, origin = v_origin, weight_g = v_weight
     WHERE id = p_product_id;
  END IF;

  -- Product types: only when the product has none.
  v_type := public.page365_prefill_type_slug(v_p.name, v_kind);
  IF NOT EXISTS (SELECT 1 FROM public.website_collection_products WHERE product_id = p_product_id) THEN
    INSERT INTO public.website_collection_products (collection_id, product_id, sort)
    SELECT c.id, p_product_id, 0 FROM public.website_collections c
     WHERE c.slug = v_type
        OR (c.slug = 'pearls' AND v_kind = 'jewelry'
            AND regexp_replace(lower(public.page365_prefill_rest(v_p.name)), 'mother\s+of\s+pearls?', '', 'g') ~ '\m(pearls?|ssp|akoya)\M');
    IF FOUND THEN v_filled := array_append(v_filled, 'product_types'); END IF;
  END IF;

  -- Categories: only when the product has none.
  v_cat := CASE
    WHEN v_kind = 'jewelry' AND v_cond = 'Preloved' AND v_brand IS NOT NULL THEN 'preloved-branded-jewelry'
    WHEN v_kind = 'jewelry' AND v_cond = 'Preloved' THEN 'preloved-jewelry'
    WHEN v_kind = 'jewelry' AND v_brand IS NULL THEN 'fine-jewelry'
    WHEN v_kind = 'watch' AND v_cond = 'Preloved' THEN 'preloved-watches'
    WHEN v_kind = 'accessory' AND v_cond = 'Preloved' THEN 'preloved-designer-accessories'
  END;
  IF v_cat IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.website_category_products WHERE product_id = p_product_id) THEN
    INSERT INTO public.website_category_products (category_id, product_id, sort_order)
    SELECT c.id, p_product_id, 0 FROM public.website_categories c WHERE c.slug = v_cat;
    IF FOUND THEN v_filled := array_append(v_filled, 'categories'); END IF;
  END IF;

  -- Size and stone: the single variant a landing creates, blank fields only.
  SELECT count(*) INTO v_nvar FROM public.website_product_variants WHERE product_id = p_product_id;
  IF v_nvar = 1 THEN
    SELECT id, size, stone INTO v_vid, v_vsize, v_vstone FROM public.website_product_variants WHERE product_id = p_product_id;
    v_size := nullif(btrim(coalesce(v_vsize, '')), '');
    IF v_size IS NULL THEN
      v_size := CASE
        WHEN v_type = 'rings' THEN public.page365_prefill_ring_size(v_p.name)
        WHEN v_type IN ('earrings', 'pendants') THEN coalesce(public.page365_prefill_length(v_p.name),
                                                              public.page365_prefill_mm(v_p.name))
        WHEN v_kind IN ('jewelry', 'watch') OR v_type IN ('necklaces', 'bracelets', 'anklets')
          THEN public.page365_prefill_length(v_p.name) END;
      IF v_size IS NOT NULL THEN v_filled := array_append(v_filled, 'size'); END IF;
    END IF;
    v_stone := nullif(btrim(coalesce(v_vstone, '')), '');
    IF v_stone IS NULL AND v_kind = 'jewelry' THEN
      v_stone := public.page365_prefill_stones(v_p.name);
      IF v_stone IS NOT NULL THEN v_filled := array_append(v_filled, 'stone'); END IF;
    END IF;
    v_size  := coalesce(v_size, v_vsize);
    v_stone := coalesce(v_stone, v_vstone);
    IF v_size IS DISTINCT FROM v_vsize OR v_stone IS DISTINCT FROM v_vstone THEN
      UPDATE public.website_product_variants SET size = v_size, stone = v_stone WHERE id = v_vid;
    END IF;
  END IF;

  IF cardinality(v_filled) > 0 THEN
    INSERT INTO public.audit_logs (entity_type, entity_id, action, new_value_json, performed_by_user_id)
    VALUES ('website_product', p_product_id, 'page365_prefilled_from_name',
            jsonb_build_object('name', v_p.name, 'filled', to_jsonb(v_filled), 'condition', v_cond, 'brand', v_brand,
                               'origin', v_origin, 'weight_g', v_weight, 'product_type', v_type, 'category', v_cat,
                               'size', v_size, 'stone', v_stone),
            NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'filled', to_jsonb(v_filled));
END
$fn$;

-- After every landing. Never lets a prefill problem undo the landing.
CREATE OR REPLACE FUNCTION public.page365_landings_prefill_trg()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  BEGIN
    PERFORM public.page365_prefill_from_name(NEW.product_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'page365_prefill_from_name(%) failed: %', NEW.product_id, SQLERRM;
  END;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_page365_landings_prefill ON public.page365_landings;
CREATE TRIGGER trg_page365_landings_prefill
  AFTER INSERT ON public.page365_landings
  FOR EACH ROW EXECUTE FUNCTION public.page365_landings_prefill_trg();

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'page365_prefill_rest(text)', 'page365_prefill_secondhand(text)', 'page365_prefill_weight(text)',
    'page365_prefill_ring_size(text)', 'page365_prefill_length(text)', 'page365_prefill_mm(text)', 'page365_prefill_stones(text)',
    'page365_prefill_brand(text)', 'page365_prefill_origin(text,text[])', 'page365_prefill_type_slug(text,text)',
    'page365_prefill_from_name(uuid)', 'page365_landings_prefill_trg()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END
$grants$;

-- ---------------------------------------------------------------------------
-- 3. One-time: the two never-completed drafts (owner 2026-10-30).
-- ---------------------------------------------------------------------------
DO $once$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT wp.id FROM public.website_products wp
     WHERE wp.id IN ('f17e0f39-616f-4cf2-b77a-9ee06de5644b', 'cb07c59a-4849-49fa-828e-2f868bff853f')
       AND wp.sku IN ('N2916', 'R3694')
       AND EXISTS (SELECT 1 FROM public.page365_landings l WHERE l.product_id = wp.id)
  LOOP
    PERFORM public.page365_prefill_from_name(r.id);
  END LOOP;
END
$once$;

-- ---------------------------------------------------------------------------
-- 4. Self-check. Any failure rolls this statement back and says why.
-- ---------------------------------------------------------------------------
DO $chk$
DECLARE v_got text;
BEGIN
  IF current_setting('page365.prefill_before', true) IS DISTINCT FROM
     (SELECT count(*)::text FROM public.website_products) || '|'
     || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text, ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1), ',' ORDER BY v.id), ''))
           FROM public.website_product_variants v) THEN
    RAISE EXCEPTION 'page365_prefill_from_name self-check: a product count, status, stock or price moved';
  END IF;
  IF current_setting('page365.prefill_others', true) IS DISTINCT FROM
     (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.condition || ':' || wp.origin || ':' || coalesce(wp.brand, '') || ':'
                  || coalesce(wp.weight_g::text, ''), ',' ORDER BY wp.id), ''))
        FROM public.website_products wp
       WHERE wp.id NOT IN ('f17e0f39-616f-4cf2-b77a-9ee06de5644b', 'cb07c59a-4849-49fa-828e-2f868bff853f')) THEN
    RAISE EXCEPTION 'page365_prefill_from_name self-check: a product other than N2916 / R3694 changed';
  END IF;
  SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.page365_inventory_land_run(uuid)');
  IF v_got IS DISTINCT FROM '7f27675ecd45453b1577fa5f6e6ba738' THEN
    RAISE EXCEPTION 'page365_prefill_from_name self-check: land_run changed (%)', v_got;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_page365_landings_prefill'
                  AND tgrelid = 'public.page365_landings'::regclass) THEN
    RAISE EXCEPTION 'page365_prefill_from_name self-check: trigger missing';
  END IF;
  -- The readers on the owner's own names.
  IF public.page365_prefill_weight('R1508 Ring PT900 11.50g Diamond 1.0ct Sz# 20 [Preloved]') IS DISTINCT FROM 11.50
     OR public.page365_prefill_weight('N5245 Necklace K18g 5.28g Diamond') IS DISTINCT FROM 5.28
     OR public.page365_prefill_ring_size('R3604 Ring PT900 9.20g Diamond 1.0ct Pear Shaped Sz# 13.5 [Preloved]') IS DISTINCT FROM '13.5'
     OR public.page365_prefill_ring_size('RC457 Ring Cartier 750 5.10g 3 Tone Gold Wedding Ring #57 [Preloved]') IS NOT NULL
     OR public.page365_prefill_length('B3M44 Bracelet K18 1.80g Loving Heart Inspired 15+3cm') IS DISTINCT FROM '15+3cm'
     OR public.page365_prefill_length('N8550 Necklace K18 11.95g Oval Snake Chain 50cm') IS DISTINCT FROM '50cm'
     OR public.page365_prefill_stones('R8505 Ring PM900 8.50g Ruby 0.61, 1.05ct Dia 0.25ct  Cocktail Sz# 12 [Preloved]')
          IS DISTINCT FROM 'Ruby, Diamond'
     OR public.page365_prefill_stones('N7514 Necklace Ponte Vecchio 750 1.40g R0.12ct D0.11ct Flower 40cm [Preloved]')
          IS DISTINCT FROM 'Ruby, Diamond'
     OR public.page365_prefill_stones('N8550 Necklace K18 11.95g Oval Snake Chain 50cm') IS NOT NULL
     OR NOT public.page365_prefill_secondhand('N2916 Necklace Tiffany & Co. SV925 By the Yard Necklace 40cm [Used]')
     OR public.page365_prefill_secondhand('N8550 Necklace K18 11.95g Oval Snake Chain 50cm')
     OR public.page365_prefill_origin('R6613 Ring 18K 6.60g', ARRAY['18K']) IS DISTINCT FROM 'OTHER'
     OR public.page365_prefill_origin('R1508 Ring PT900 11.50g', ARRAY['PT900']) IS DISTINCT FROM 'JAPAN'
     OR public.page365_prefill_origin('X1 Ring SV925', ARRAY['SILVER925']) IS NOT NULL
     OR public.page365_prefill_origin('N9838 Necklace PT850 9.80g', ARRAY['PT850']) IS DISTINCT FROM 'JAPAN'
     OR public.page365_prefill_type_slug('P1421 Pendant K18 0.90g Ruby', 'jewelry') IS DISTINCT FROM 'pendants'
     OR public.page365_prefill_type_slug('W2410 Key Case Gucci 6 Key [Preloved]', 'accessory') IS DISTINCT FROM 'luxury-wallet'
     OR public.page365_prefill_type_slug('C1244 Hermes Arceau Quartz', 'watch') IS DISTINCT FROM 'luxury-watches' THEN
    RAISE EXCEPTION 'page365_prefill_from_name self-check: a name reader misbehaves';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname LIKE 'page365_prefill%'
              AND p.pronamespace = 'public'::regnamespace
              AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'page365_prefill_from_name self-check: a new function is callable by anon / authenticated';
  END IF;
END
$chk$;
