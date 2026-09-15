import { supabase } from '@/integrations/supabase/client';

/**
 * Fill in the thumbnail for order or plan lines that stored none.
 *
 * `cash_order_items.image_url` and `layaway_account_items.image_url` both
 * exist, and neither `create_web_order_atomic` nor `create_web_layaway_atomic`
 * writes them — so every web line stored NULL and the Hub showed an empty grey
 * square for a piece the storefront pictures fine (R3341 on CJ-W-900011,
 * 2026-09-14; N4020 on CJ-W-900012 and CJ-W-900013, 2026-09-15).
 *
 * The photo is not missing. It lives in `website_product_media`, keyed by the
 * VARIANT the line already carries, and resolving it at READ time also repairs
 * the orders and plans already on the books — which backfilling the column
 * would not. Shopify-sourced lines keep whatever `image_url` the webhook wrote;
 * they have no variant and are left untouched.
 *
 * Extracted from CashOrderDetail so the layaway side cannot drift into a
 * second, differently-keyed mechanism. Mutates and returns the rows.
 */
export async function resolveItemImages<
  T extends { image_url: string | null; variant_id?: string | null },
>(rows: T[]): Promise<T[]> {
  const needing = rows.filter((r) => !r.image_url && r.variant_id);
  if (needing.length === 0) return rows;

  const variantIds = [...new Set(needing.map((r) => r.variant_id as string))];
  const { data: media } = await supabase
    .from('website_product_media' as never)
    .select('variant_id, url, sort')
    .in('variant_id', variantIds)
    .order('sort', { ascending: true });

  // First by sort order is the storefront's primary image.
  const firstByVariant = new Map<string, string>();
  for (const m of (media || []) as unknown as { variant_id: string; url: string }[]) {
    if (!firstByVariant.has(m.variant_id)) firstByVariant.set(m.variant_id, m.url);
  }
  for (const r of rows) {
    if (!r.image_url && r.variant_id) r.image_url = firstByVariant.get(r.variant_id) ?? null;
  }
  return rows;
}
