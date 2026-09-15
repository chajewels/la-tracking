ALTER TABLE public.layaway_account_items
  ADD COLUMN IF NOT EXISTS website_product_id uuid
    REFERENCES public.website_products(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS variant_id uuid
    REFERENCES public.website_product_variants(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.layaway_account_items.website_product_id IS
  'Storefront catalog product (public.website_products) for a web layaway line. NULL for Hub-picker lines, which carry product_id against public.products instead. Mirrors cash_order_items.website_product_id.';

COMMENT ON COLUMN public.layaway_account_items.variant_id IS
  'Storefront variant (public.website_product_variants) this line holds stock against. expire_web_layaway_atomic returns stock through this column, so a NULL here means a web line whose stock cannot be released. Mirrors cash_order_items.variant_id.';

CREATE INDEX IF NOT EXISTS idx_layaway_account_items_variant
  ON public.layaway_account_items (variant_id) WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_layaway_account_items_website_product
  ON public.layaway_account_items (website_product_id);