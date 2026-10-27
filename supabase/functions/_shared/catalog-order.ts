/**
 * "Newest" means newest (owner 2026-10-27): the product order of
 * GET /catalog/collections/:slug and GET /catalog/categories/:slug.
 *
 * ORDER: website_products.created_at descending — the moment the piece was
 * added to the Hub's website catalog (column default now(); no writer sets it)
 * — ties by id ascending, the Hub catalog list's own order (ProductsCard).
 * The order is total, so the storefront's "Oldest" (this list reversed) is
 * deterministic too. Replaces the link tables' sort / sort_order, which were
 * only each product's position in its OWN list of types / categories, never a
 * staff-curated order of pieces.
 *
 * Instants are compared, not strings. A product without a readable created_at
 * sorts after every readable one, still by id. Returns a new array; the input
 * is untouched. Kept free of Deno APIs so src/test/website-newest-order.test.ts
 * can import it.
 */
type Ordered = { id?: unknown; created_at?: unknown };

function addedAt(p: Ordered): number {
  const t = typeof p.created_at === "string" ? Date.parse(p.created_at) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}

export function newestFirst<T extends Ordered>(products: T[]): T[] {
  return [...products].sort((a, b) => {
    const ta = addedAt(a);
    const tb = addedAt(b);
    if (ta !== tb) return tb > ta ? 1 : -1;
    const ia = String(a.id ?? "");
    const ib = String(b.id ?? "");
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}
