-- ===========================================================================
-- Page365 prefill from name -- fixes after the independent review (2026-10-30).
-- Follows 20270222100000_page365_prefill_from_name.sql (applied live 2026-10-30).
--
--   Brand      a look-alike is never branded: inspired / inspiration / style /
--              type / motif / design / like / "-like" / replica / copy / homage.
--              Brand list = brands saved with origin Branded (>= 3 letters) plus a
--              fixed list of well-known houses (Mikimoto, Tasaki, Piaget, Rolex,
--              Chopard, Dior ...), so a foreign brand not yet in the Catalog with a
--              K18 / PT stamp is never called Made in Japan.
--   Size       "2.5x1.5cm" is read whole (was "5cm"); a ring size range never
--              swallows the weight ("Sz# 13 - 2.0g" -> 13); only "Sz#" counts.
--   Stone      "Diamond Cut" / "Emerald Cut" / "Turquoise Blue Enamel" are not
--              stones; B.T -> Blue Topaz; an unknown short form before a carat
--              weight ("T 0.22ct") leaves the stone blank instead of a partial
--              list. Pearls product type now follows the stone reader
--              ("Pearl-like" no longer adds Pearls).
--   Condition  "Never Used" stays New.
--
-- Same safety as before: blank fields only, never-published drafts only, no
-- stock / price / status change. No product is touched by this file (no
-- one-time pass). ASCII only.
-- ===========================================================================

SET LOCAL lock_timeout = '60s';
SET LOCAL statement_timeout = '300s';

DO $pre$
DECLARE
  v_bad text := '';
  v_got text;
  r     record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('page365_prefill_secondhand(text)', '560fc3a0a14d6f5b5e4a1ec33e9255b7', 'aa022b90b37a0e945919af8482f4c705'),
      ('page365_prefill_ring_size(text)', '08dbda7b55de024f16fb0afac374cf95', '75e80cfcaddb4e769c0e3039d0dae89e'),
      ('page365_prefill_length(text)', '40d89d5443206feb78acf0d6434fbf47', 'b244de33230399617b6b3e6e847fc092'),
      ('page365_prefill_mm(text)', '165c674fd637fca0a5bd6cd0671b8541', '05b9caefeb5e30b754542a6e41d000bc'),
      ('page365_prefill_stones(text)', 'c93d4fb79251787345188c8270bdef86', '3cbba9825ceda4e5a9266cbf914230a9'),
      ('page365_prefill_brand(text)', '2df8d1b4aa89195fa76f90da2c51848f', '8c454d0fdf7364dc0c7df42cf87b4c10'),
      ('page365_prefill_from_name(uuid)', '39467889c73fcd0a6eb41dd37921d65e', '63bd2f5b9bbc9374baa76eb14b176213')
    ) AS t(fn, want, or_new)
  LOOP
    SELECT md5(p.prosrc) INTO v_got FROM pg_proc p WHERE p.oid = to_regprocedure('public.' || r.fn);
    IF v_got IS DISTINCT FROM r.want AND v_got IS DISTINCT FROM r.or_new THEN
      v_bad := v_bad || format(E'\n  %s: live body md5 %s, expected %s', r.fn, coalesce(v_got, 'missing'), r.want);
    END IF;
  END LOOP;
  IF v_bad <> '' THEN
    RAISE EXCEPTION 'page365_prefill_fixes: live is not what this was written against -- nothing changed:%', v_bad;
  END IF;
  PERFORM set_config('page365.prefill_fix_before',
    (SELECT count(*)::text FROM public.website_products) || '|'
    || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text || ':' || wp.condition || ':' || wp.origin || ':'
                 || coalesce(wp.brand, '') || ':' || coalesce(wp.weight_g::text, ''), ',' ORDER BY wp.id), '')) FROM public.website_products wp)
    || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1) || ':'
                 || coalesce(v.size, '') || ':' || coalesce(v.stone, ''), ',' ORDER BY v.id), '')) FROM public.website_product_variants v),
    false);
END
$pre$;

-- Any wording that makes the piece secondhand ("Never Used" does not count).
CREATE OR REPLACE FUNCTION public.page365_prefill_secondhand(p_name text)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT public.page365_prefill_rest(p_name) ~* '(pre-?\s?loved|prelvoed|pre-?\s?owned|\mused\M|second-?\s?hand)'
     AND NOT (regexp_replace(public.page365_prefill_rest(p_name), '\mnever\s+used\M', '', 'gi')
              !~* '(pre-?\s?loved|prelvoed|pre-?\s?owned|\mused\M|second-?\s?hand)')
$fn$;

-- Ring size: the number (or range "12-14") after "Sz#" only.
CREATE OR REPLACE FUNCTION public.page365_prefill_ring_size(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT regexp_replace((regexp_match(public.page365_prefill_rest(p_name),
           'sz\s*#\s*(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?(?![0-9A-Za-z.]))?)(?![0-9A-Za-z.])', 'i'))[1], '\s', '', 'g')
$fn$;

-- Length in cm, as written without spaces: "45cm", "15+3cm", "13-16cm", "2.5x1.5cm".
CREATE OR REPLACE FUNCTION public.page365_prefill_length(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT regexp_replace(m, '\s', '', 'g') || 'cm'
    FROM (SELECT (regexp_match(public.page365_prefill_rest(p_name),
                  '(?:^|[^0-9A-Za-z.])(\d+(?:\.\d+)?(?:\s*[-+~x]\s*\d+(?:\.\d+)?)*)\s?cm\M', 'i'))[1] AS m) x
   WHERE m IS NOT NULL
$fn$;

-- Size in mm (earrings and pendants with no cm): "10.0mm", "4x13mm".
CREATE OR REPLACE FUNCTION public.page365_prefill_mm(p_name text)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path TO 'public'
AS $fn$
  SELECT regexp_replace(m, '\s', '', 'g') || 'mm'
    FROM (SELECT (regexp_match(public.page365_prefill_rest(p_name),
                  '(?:^|[^0-9A-Za-z.])(\d+(?:\.\d+)?(?:\s*[-x]\s*\d+(?:\.\d+)?)*)\s?mm\M', 'i'))[1] AS m) x
   WHERE m IS NOT NULL
$fn$;

-- Stones named in the name, in name order, comma separated, with the words
-- staff keep in front of a stone ("Akoya Pearl", "Blue Topaz", "Star
-- Sapphire", "White Coral"). Short forms: Dia / D0.11ct -> Diamond, R0.12ct
-- -> Ruby, Sapp / S..ct -> Sapphire, Eme / E..ct -> Emerald, SSP -> South Sea
-- Pearl, B.T -> Blue Topaz, Bl -> Blue. "Diamond Cut" / "Emerald Cut" and colour words
-- ("Turquoise Blue Enamel") are not stones; an unknown short form before a
-- carat weight leaves the stone blank (a partial list is worse than none). Plain "Quartz" is a watch movement, not a stone (only
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
  nx    text;
BEGIN
  w := regexp_split_to_array(btrim(regexp_replace(
         regexp_replace(public.page365_prefill_rest(p_name), 'mother\s+of\s+pearls?', 'Mother-of-Pearl', 'gi'),
         '[,;()\[\]/]+', ' ', 'g')), '\s+');
  n := coalesce(array_length(w, 1), 0);
  i := 1;
  WHILE i <= n LOOP
    lw := lower(w[i]);
    nx := lower(coalesce(w[i + 1], ''));
    -- An unknown short form in front of a carat weight ("T 0.22ct", "X0.5ct"):
    -- the list would be incomplete, so the stone is left blank.
    IF (lw ~ '^[a-z]\d+(\.\d+)?ct$' AND lw !~ '^[drse]')
       OR (lw ~ '^[a-z][a-z.]{0,3}$' AND lw NOT IN ('b.t', 'dia', 'sapp', 'eme', 'ssp', 'jade', 'opal', 'onyx', 'ruby')
           AND nx ~ '^\d+(\.\d+)?ct$') THEN
      RETURN NULL;
    END IF;
    base := CASE
      WHEN lw ~ '^(diamonds?|dia)$' OR lw ~ '^d\d+(\.\d+)?ct$' THEN 'Diamond'
      WHEN lw ~ '^(ruby|rubies)$' OR lw ~ '^r\d+(\.\d+)?ct$' THEN 'Ruby'
      WHEN lw ~ '^(sapphires?|sapp)$' OR lw ~ '^s\d+(\.\d+)?ct$' THEN 'Sapphire'
      WHEN lw ~ '^(emeralds?|eme)$' OR lw ~ '^e\d+(\.\d+)?ct$' THEN 'Emerald'
      WHEN lw = 'mother-of-pearl' THEN 'Mother of Pearl'
      WHEN lw ~ '^pearls?$' THEN 'Pearl'
      WHEN lw = 'ssp' THEN 'South Sea Pearl'
      WHEN lw = 'b.t' THEN 'Blue Topaz'
      WHEN lw = 'quartz' AND i > 1 AND lower(w[i - 1]) IN ('smoky', 'strawberry', 'rose', 'white', 'rutilated') THEN 'Quartz'
      WHEN lw IN ('lapis', 'lapiz') AND i < n AND lower(w[i + 1]) = 'lazuli' THEN initcap(lw) || ' Lazuli'
      WHEN regexp_replace(lw, 's$', '') IN ('tanzanite', 'opal', 'amethyst', 'garnet', 'aquamarine', 'peridot', 'tourmaline',
                                              'coral', 'spinel', 'morganite', 'citrine', 'alexandrite', 'moonstone',
                                              'tsavorite', 'kunzite', 'moissanite', 'rutile', 'apatite', 'carnelian',
                                              'labradorite', 'rubellite', 'andalusite', 'iolite', 'agate', 'malachite',
                                              'chrysoprase', 'shell', 'jadeite', 'zirconia', 'amazonite',
                                              'aventurine', 'prehnite', 'fluorite', 'rhodolite', 'hematite', 'sodalite')
        THEN initcap(regexp_replace(lw, 's$', ''))
      WHEN lw IN ('topaz', 'onyx', 'jade', 'turquoise', 'sango') THEN initcap(lw)
    END;
    -- A cut or a colour, not a stone: "Diamond Cut", "Emerald Cut", "Turquoise Blue", "Pearl White Finish".
    IF base IS NOT NULL AND (nx IN ('cut', 'cuts', 'cutting', 'color', 'colour', 'colored', 'coloured', 'tone', 'finish', 'enamel')
                             OR (nx IN ('blue', 'pink', 'green', 'white', 'black', 'red', 'yellow', 'gold', 'silver')
                                 AND lower(coalesce(w[i + 2], '')) IN ('enamel', 'finish', 'tone', 'color', 'colour', 'dial', 'plated'))) THEN
      base := NULL;
    END IF;
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

-- A brand in the name: a brand saved as Branded in the Catalog, a fixed list of
-- well-known houses, or a Page365 spelling of one. Words that mark a
-- look-alike (inspired / inspiration / style / type / motif / design / like /
-- replica) mean no brand.
CREATE OR REPLACE FUNCTION public.page365_prefill_brand(p_name text)
RETURNS text
LANGUAGE sql STABLE SET search_path TO 'public'
AS $fn$
  WITH t AS (SELECT lower(public.page365_prefill_rest(p_name)) AS s),
  known AS (
    SELECT DISTINCT btrim(wp.brand) AS canon FROM public.website_products wp
     WHERE wp.origin = 'BRAND' AND length(btrim(coalesce(wp.brand, ''))) >= 3 AND wp.brand ~ '[A-Za-z]'
    UNION
    SELECT f.canon FROM (VALUES ('Tiffany & Co.'), ('Cartier'), ('Bvlgari'), ('Van Cleef & Arpels'), ('Herm' || chr(232) || 's'),
                                ('Chanel'), ('Gucci'), ('Louis Vuitton'), ('Christian Dior'), ('Celine'), ('Fendi'), ('Prada'),
                                ('Loewe'), ('Burberry'), ('Bottega Veneta'), ('Saint Laurent'), ('Valentino'), ('Miu Miu'),
                                ('Tory Burch'), ('Montblanc'), ('TAG Heuer'), ('Tissot'), ('Hamilton'), ('Citizen'), ('Seiko'),
                                ('Rolex'), ('Piaget'), ('Chopard'), ('Boucheron'), ('Chaumet'), ('Harry Winston'), ('Graff'),
                                ('Damiani'), ('Pomellato'), ('Mikimoto'), ('Tasaki'), ('Star Jewelry'), ('Vendome Aoyama'),
                                ('Agete'), ('Ponte Vecchio'), ('Unoaerre'), ('Mauboussin'), ('Scavia'), ('GSTV'),
                                ('Casio G-SHOCK')) f(canon)
  ), cand AS (
    SELECT k.canon, lower(k.canon) AS pat FROM known k
    UNION
    SELECT a.canon, a.pat
      FROM (VALUES ('Tiffany & Co.', 'tiffany & co'), ('Tiffany & Co.', 'tiffany&co'), ('Tiffany & Co.', 'tiffany'),
                   ('Herm' || chr(232) || 's', 'hermes'), ('Saint Laurent', 'ysl'), ('Saint Laurent', 'yves saint laurent'),
                   ('Bvlgari', 'bulgari'), ('Van Cleef & Arpels', 'van cleef'), ('Christian Dior', 'dior'),
                   ('Casio G-SHOCK', 'g-shock'), ('Star Jewelry', 'star jewellery')) a(canon, pat)
     WHERE EXISTS (SELECT 1 FROM known k WHERE k.canon = a.canon)
  ), hits AS (
    SELECT c.canon,
           regexp_instr(t.s, '(^|[^a-z0-9])' || regexp_replace(c.pat, '([.^$*+?()\[\]{}|\\-])', '\\\1', 'g')
                             || '($|[^a-z0-9])') AS pos,
           length(c.pat) AS len
      FROM cand c, t
  )
  SELECT h.canon FROM hits h, t
   WHERE h.pos > 0
     AND t.s !~ '(\m(inspir\w*|style|type|motif|design|like|replica|copy|homage)\M|\w-like\M)'
   ORDER BY h.pos, h.len DESC, h.canon
   LIMIT 1
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
            AND EXISTS (SELECT 1 FROM unnest(string_to_array(public.page365_prefill_stones(v_p.name), ', ')) st(x)
                         WHERE st.x ~ 'Pearl$' AND st.x <> 'Mother of Pearl'));
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

DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['page365_prefill_secondhand(text)', 'page365_prefill_ring_size(text)', 'page365_prefill_length(text)',
                           'page365_prefill_mm(text)', 'page365_prefill_stones(text)', 'page365_prefill_brand(text)',
                           'page365_prefill_from_name(uuid)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END
$grants$;

DO $chk$
BEGIN
  IF current_setting('page365.prefill_fix_before', true) IS DISTINCT FROM
     (SELECT count(*)::text FROM public.website_products) || '|'
     || (SELECT md5(coalesce(string_agg(wp.id::text || ':' || wp.status::text || ':' || wp.condition || ':' || wp.origin || ':'
                  || coalesce(wp.brand, '') || ':' || coalesce(wp.weight_g::text, ''), ',' ORDER BY wp.id), '')) FROM public.website_products wp)
     || (SELECT md5(coalesce(string_agg(v.id::text || ':' || v.stock_qty || ':' || coalesce(v.price_jpy, -1) || ':'
                  || coalesce(v.size, '') || ':' || coalesce(v.stone, ''), ',' ORDER BY v.id), '')) FROM public.website_product_variants v) THEN
    RAISE EXCEPTION 'page365_prefill_fixes self-check: a product or variant changed';
  END IF;
  IF public.page365_prefill_brand('P1 Pendant K18 Cartier Inspiration Love Top') IS NOT NULL
     OR public.page365_prefill_brand('R1 Ring K18 Van Cleef Type Clover') IS NOT NULL
     OR public.page365_prefill_brand('N1 Necklace K18 Cartier-like') IS NOT NULL
     OR public.page365_prefill_brand('N1049 Necklace Mikimoto K18 Akoya Pearl 45cm') IS DISTINCT FROM 'Mikimoto'
     OR public.page365_prefill_brand('N3045 Necklace Tiffany & Co. 750PG 3.0g Heart Tag 45cm') IS DISTINCT FROM 'Tiffany & Co.'
     OR public.page365_prefill_length('P1 Pendant K18 Top 2.5x1.5cm') IS DISTINCT FROM '2.5x1.5cm'
     OR public.page365_prefill_length('N8550 Necklace K18 11.95g Oval Snake Chain 50cm') IS DISTINCT FROM '50cm'
     OR public.page365_prefill_ring_size('R1 Ring K18 Sz# 13 - 2.0g') IS DISTINCT FROM '13'
     OR public.page365_prefill_ring_size('R3M55 Ring K18 2.55g Teardrop and Open Sz# 12-14') IS DISTINCT FROM '12-14'
     OR public.page365_prefill_ring_size('R3604 Ring PT900 9.20g Diamond 1.0ct Pear Shaped Sz# 13.5') IS DISTINCT FROM '13.5'
     OR public.page365_prefill_stones('N1 Necklace K18 5.0g Diamond Cut Chain 45cm') IS NOT NULL
     OR public.page365_prefill_stones('R1 Ring PT900 Diamond 1.0ct Emerald Cut Sz# 12') IS DISTINCT FROM 'Diamond'
     OR public.page365_prefill_stones('E5432 Earrings K18 5.40g B.T 0.86ct T 0.22ct Dia 0.32ct') IS NOT NULL
     OR public.page365_prefill_stones('R8505 Ring PM900 8.50g Ruby 0.61, 1.05ct Dia 0.25ct  Cocktail Sz# 12') IS DISTINCT FROM 'Ruby, Diamond'
     OR public.page365_prefill_secondhand('N1 Necklace K18 5.0g [Never Used]')
     OR NOT public.page365_prefill_secondhand('N2916 Necklace Tiffany & Co. SV925 By the Yard Necklace 40cm [Used]') THEN
    RAISE EXCEPTION 'page365_prefill_fixes self-check: a name reader misbehaves';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname LIKE 'page365_prefill%'
              AND p.pronamespace = 'public'::regnamespace
              AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
    RAISE EXCEPTION 'page365_prefill_fixes self-check: a function is callable by anon / authenticated';
  END IF;
END
$chk$;
