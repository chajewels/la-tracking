/**
 * Fill in the thumbnail for order or plan lines that stored none — the
 * server-side twin of src/lib/resolve-item-images.ts.
 *
 * `cash_order_items.image_url` and `layaway_account_items.image_url` both
 * exist, and neither `create_web_order_atomic` nor `create_web_layaway_atomic`
 * writes them, so every web line stores NULL. The photo is not missing: it
 * lives in `website_product_media`, keyed by the VARIANT the line already
 * carries. Resolving at READ time also repairs the orders and plans already on
 * the books, which backfilling the column would not.
 *
 * Shopify-sourced lines carry no variant and keep whatever `image_url` the
 * webhook wrote — they are left untouched.
 *
 * Any surface that shows a line thumbnail MUST call this. Four did not when
 * this was written (the Hub plan card, the portal's cash lines, and the
 * storefront's order and plan lines); see docs/FIXED-BUGS.md Bug #275.
 */
// deno-lint-ignore no-explicit-any
type AnySupabase = any;

export interface ImageableLine {
  image_url?: string | null;
  variant_id?: string | null;
}

export async function resolveItemImages<T extends ImageableLine>(
  supabase: AnySupabase,
  rows: T[],
): Promise<T[]> {
  const needing = rows.filter((r) => !r.image_url && r.variant_id);
  if (needing.length === 0) return rows;

  const variantIds = [...new Set(needing.map((r) => r.variant_id as string))];
  const { data: media } = await supabase
    .from("website_product_media")
    .select("variant_id, url, sort")
    .in("variant_id", variantIds)
    .order("sort", { ascending: true });

  // First by sort order is the storefront's primary image.
  const firstByVariant = new Map<string, string>();
  for (const m of (media ?? []) as { variant_id: string; url: string }[]) {
    if (!firstByVariant.has(m.variant_id)) firstByVariant.set(m.variant_id, m.url);
  }
  for (const r of rows) {
    if (!r.image_url && r.variant_id) r.image_url = firstByVariant.get(r.variant_id) ?? null;
  }
  return rows;
}
