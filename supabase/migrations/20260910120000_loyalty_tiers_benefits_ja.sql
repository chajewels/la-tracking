-- loyalty_tiers.benefits_ja — Japanese benefit copy for the storefront.
--
-- Why: `benefits` holds a single untagged English array, and GET /loyalty/tiers
-- returned it in BOTH benefits_en and benefits_ja. The Japanese storefront was
-- therefore rendering English benefit copy on /loyalty. This adds a real
-- Japanese column and seeds it by translating the CURRENT English benefits —
-- same order, same length, ¥ amounts and item counts unchanged.
--
-- NULLABLE BY DESIGN. The route falls back to `benefits` when benefits_ja is
-- null or empty, so a tier added later without Japanese copy degrades to
-- English rather than rendering an empty list. Do not add a NOT NULL default.
--
-- The UPDATEs are keyed on `name` (UNIQUE: loyalty_tiers_name_key) and guarded
-- with `benefits_ja IS NULL`, so this migration is idempotent and will never
-- clobber copy edited later by hand or through the Hub UI.

ALTER TABLE public.loyalty_tiers
  ADD COLUMN IF NOT EXISTS benefits_ja jsonb;

COMMENT ON COLUMN public.loyalty_tiers.benefits_ja IS
  'Japanese translation of benefits — same order and length. NULL or empty = GET /loyalty/tiers falls back to benefits (English).';

UPDATE public.loyalty_tiers SET benefits_ja = jsonb_build_array(
  '通常ポイント付与',
  'ロイヤルティ特典のご利用',
  '会員限定プロモーションのご案内'
) WHERE name = 'Glimmer' AND benefits_ja IS NULL;

UPDATE public.loyalty_tiers SET benefits_ja = jsonb_build_array(
  '全商品ポイント2倍',
  '会員限定プロモーションの優先ご案内',
  'フラッシュセールへの優先ご参加'
) WHERE name = 'Radiant' AND benefits_ja IS NULL;

UPDATE public.loyalty_tiers SET benefits_ja = jsonb_build_array(
  '全商品ポイント2倍',
  '4点ご購入ごとに送料無料（1点あたり¥8,000以上）',
  '1回のご注文¥50,000ごとに2%割引',
  'Elite限定特典のご利用'
) WHERE name = 'Elite' AND benefits_ja IS NULL;

UPDATE public.loyalty_tiers SET benefits_ja = jsonb_build_array(
  '全商品ポイント3倍',
  '3点ご購入ごとに送料無料（1点あたり¥8,000以上）',
  '1回のご注文¥50,000ごとに3%割引',
  'ご発送ごとにミステリーギフトを同封',
  'Crown VIP限定特典のご利用'
) WHERE name = 'Crown VIP' AND benefits_ja IS NULL;

-- Verification: every tier should report matched = true.
--   SELECT name,
--          jsonb_array_length(benefits)    AS en_count,
--          jsonb_array_length(benefits_ja) AS ja_count,
--          jsonb_array_length(benefits) = jsonb_array_length(benefits_ja) AS matched
--   FROM public.loyalty_tiers ORDER BY display_order;
