-- Bilingual catalog: staff write English once, the Hub generates Japanese, the
-- site shows Japanese by default and English on toggle.
--
-- website_collections gains name_ja / description_ja; website_products gains
-- name_ja (description_ja already existed). The seven seeded jewelry types get
-- their Japanese names and descriptions here so the site is bilingual the
-- moment this applies — every later edit is translated by the Hub on save.
--
-- Idempotent: columns are IF NOT EXISTS, seeds only fill NULLs.

ALTER TABLE public.website_collections
  ADD COLUMN IF NOT EXISTS name_ja text,
  ADD COLUMN IF NOT EXISTS description_ja text;

ALTER TABLE public.website_products
  ADD COLUMN IF NOT EXISTS name_ja text;

-- Japanese names for the seven starting types (owner-approved list).
UPDATE public.website_collections AS c
   SET name_ja = s.name_ja
  FROM (VALUES
    ('anklets',   'アンクレット'),
    ('bracelets', 'ブレスレット'),
    ('earrings',  'ピアス・イヤリング'),
    ('necklaces', 'ネックレス'),
    ('pendants',  'ペンダント'),
    ('rings',     'リング'),
    ('sets',      'セット')
  ) AS s(slug, name_ja)
 WHERE c.slug = s.slug
   AND c.name_ja IS NULL;

-- Japanese descriptions, translated from the seeded English one-liners.
UPDATE public.website_collections AS c
   SET description_ja = s.description_ja
  FROM (VALUES
    ('anklets',   '足首を飾る華奢なチェーン。さまざまな足首に合う長さでご用意しています。'),
    ('bracelets', 'バングルとチェーンブレスレット。デザインにより長さの調整も承ります。'),
    ('earrings',  'スタッド、フープ、ドロップタイプ。確かな作りのポストとキャッチで仕上げています。'),
    ('necklaces', 'K18とプラチナのチェーン・ネックレス。毎日身につけやすい長さでご用意しています。'),
    ('pendants',  'ペンダントトップとチャーム。単品でも、チェーンとの組み合わせでもお求めいただけます。'),
    ('rings',     'バンドリング、ソリティア、重ね付けリング。ご希望によりサイズ直しを承ります。'),
    ('sets',      'セット価格でお求めいただける、お揃いのジュエリーです。')
  ) AS s(slug, description_ja)
 WHERE c.slug = s.slug
   AND c.description_ja IS NULL;

-- The terminology guard now also reads the generated Japanese name. Same
-- regex, same message; only the input widens.
CREATE OR REPLACE FUNCTION public.reject_forbidden_gold_terms()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(NEW.name,'') || ' ' || coalesce(NEW.name_ja,'') || ' ' || coalesce(NEW.description_en,'') || ' ' || coalesce(NEW.description_ja,'')
     ~* '\m(japan(ese)?|saudi|italian|dubai|hk|chinese) gold\M' THEN
    RAISE EXCEPTION 'Forbidden gold terminology. Describe purity as "K18 gold"; origin is set in the product''s Origin field, not in the description.';
  END IF;
  RETURN NEW;
END $function$;
