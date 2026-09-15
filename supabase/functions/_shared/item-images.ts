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

/**
 * A line this helper can fill in. It is a TYPE with an index signature, not an
 * interface, and that is load-bearing (Bug #276, 2026-09-15).
 *
 * Both callers pass loose DB rows typed `Record<string, unknown>`, and an
 * `interface` gets no implicit index signature. That broke the Deno gate in two
 * directions at once on `website/index.ts`:
 *
 *   out — `ImageableLine[]` is not assignable to `AnyRec[]`, so the result
 *         could not be handed on to withJapaneseTitles();
 *   in  — the call site's `.map(({ website_product_id, ...l }) => …)` literal
 *         infers as `{ product_id: {} | null }`, which "has no properties in
 *         common with" the interface.
 *
 * A type alias with an index signature satisfies both. customer-portal already
 * wrote `ImageableLine & Record<string, any>` by hand to get past the same gap;
 * that intersection is now redundant.
 */
export type ImageableLine = {
  image_url?: string | null;
  variant_id?: string | null;
  // deno-lint-ignore no-explicit-any
  [key: string]: any;
};

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
