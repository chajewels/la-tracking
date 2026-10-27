import { chunk } from "./chunk.ts";

/**
 * collection_slugs on every product the `website` function returns (owner
 * 2026-10-27): the slugs of the collections (jewelry types — Rings, Necklaces,
 * Pendants …) the product belongs to, so the storefront can offer a "Kind"
 * filter on category and collection pages. Same shape and batching as
 * attachCategorySlugs in website/index.ts.
 *
 * PUBLISHED RULE: website_collections has no `published` column (live types,
 * 2026-10-27) and GET /catalog/collections and /catalog/collections/:slug
 * already serve every row, so every collection is public and every one counts.
 * If a published flag is ever added, filter on it here too.
 *
 * ORDER: website_collections has no sort_order either, so the slugs come in
 * collection-name order — the order GET /catalog/collections lists them in.
 *
 * NEVER THROWS: a failed read is logged and every product gets
 * collection_slugs: [] — an enrichment must not fail the response.
 * Kept free of Deno APIs so src/test/collection-slugs.test.ts can import it.
 */
type AnyRec = Record<string, unknown>;

const CHUNK = 150;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function attachCollectionSlugs(supabase: any, products: AnyRec[]): Promise<AnyRec[]> {
  if (!products.length) return products;
  const empty = () => products.map((p) => ({ ...p, collection_slugs: [] as string[] }));
  const ids = [...new Set(products.map((p) => String(p.id ?? "")).filter(Boolean))];
  if (!ids.length) return empty();
  try {
    // One .in() per 150 ids: a single .in() over every id overflows the 16 KB URL limit.
    const parts = await Promise.all(
      chunk(ids, CHUNK).map((slice) =>
        supabase
          .from("website_collection_products")
          .select("product_id, collection:website_collections!website_collection_products_collection_id_fkey(slug, name)")
          .in("product_id", slice)),
    );
    for (const r of parts) if (r.error) throw r.error;
    const rows = parts.flatMap((r: AnyRec) => (r.data as AnyRec[] | null) ?? []);
    const byProduct = collectionSlugsByProduct(rows);
    return products.map((p) => ({ ...p, collection_slugs: byProduct.get(String(p.id)) ?? [] }));
  } catch (e) {
    console.error("[website] attachCollectionSlugs failed; collection_slugs empty", (e as Error)?.message ?? e);
    return empty();
  }
}

/** Groups link rows into product id → collection slugs, name order, no duplicates. */
export function collectionSlugsByProduct(rows: AnyRec[]): Map<string, string[]> {
  const grouped = new Map<string, { slug: string; name: string }[]>();
  for (const row of rows) {
    const col = row.collection as AnyRec | null;
    const slug = typeof col?.slug === "string" ? col.slug.trim() : "";
    if (!slug) continue;
    const pid = String(row.product_id);
    const list = grouped.get(pid) ?? [];
    if (!list.some((c) => c.slug === slug)) list.push({ slug, name: String(col?.name ?? "") });
    grouped.set(pid, list);
  }
  const out = new Map<string, string[]>();
  for (const [pid, list] of grouped) {
    list.sort((a, b) => a.name.localeCompare(b.name, "en") || a.slug.localeCompare(b.slug, "en"));
    out.set(pid, list.map((c) => c.slug));
  }
  return out;
}
