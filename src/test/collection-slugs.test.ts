import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachCollectionSlugs, collectionSlugsByProduct } from "../../supabase/functions/_shared/collection-slugs.ts";

/**
 * collection_slugs on every product the `website` function returns (owner
 * 2026-10-27, storefront "Kind" filter). Contract: supabase/contracts/api.md.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const INDEX = "supabase/functions/website/index.ts";

type Result = { data: unknown; error: unknown };
function client(answer: (ids: string[]) => Result) {
  const calls: { table: string; select: string; ids: string[] }[] = [];
  return {
    calls,
    from(table: string) {
      return {
        select(select: string) {
          return {
            in(_col: string, ids: string[]) {
              calls.push({ table, select, ids });
              return Promise.resolve(answer(ids));
            },
          };
        },
      };
    },
  };
}

const link = (product_id: string, slug: string, name: string) => ({ product_id, collection: { slug, name } });

afterEach(() => vi.restoreAllMocks());

describe("collectionSlugsByProduct", () => {
  it("groups by product in collection-name order, without duplicates", () => {
    const m = collectionSlugsByProduct([
      link("p1", "pendants", "Pendants"),
      link("p1", "necklaces", "Necklaces"),
      link("p1", "necklaces", "Necklaces"),
      link("p2", "rings", "Rings"),
    ]);
    expect(m.get("p1")).toEqual(["necklaces", "pendants"]);
    expect(m.get("p2")).toEqual(["rings"]);
  });

  it("skips links whose collection is missing or has a blank slug", () => {
    const m = collectionSlugsByProduct([
      { product_id: "p1", collection: null },
      link("p1", "  ", "Blank"),
      link("p1", "rings", "Rings"),
    ]);
    expect(m.get("p1")).toEqual(["rings"]);
  });
});

describe("attachCollectionSlugs", () => {
  it("attaches slugs in one batched read, [] for a product in no collection", async () => {
    const c = client(() => ({ data: [link("p1", "rings", "Rings")], error: null }));
    const out = await attachCollectionSlugs(c, [{ id: "p1", name: "A" }, { id: "p2", name: "B" }]);
    expect(out).toEqual([
      { id: "p1", name: "A", collection_slugs: ["rings"] },
      { id: "p2", name: "B", collection_slugs: [] },
    ]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0].table).toBe("website_collection_products");
    expect(c.calls[0].select).toContain("website_collections!website_collection_products_collection_id_fkey(slug, name)");
    expect(c.calls[0].ids).toEqual(["p1", "p2"]);
  });

  it("chunks the id list at 150 (16 KB URL limit), never one read per product", async () => {
    const c = client(() => ({ data: [], error: null }));
    const products = Array.from({ length: 320 }, (_, i) => ({ id: `p${i}` }));
    await attachCollectionSlugs(c, products);
    expect(c.calls.map((x) => x.ids.length)).toEqual([150, 150, 20]);
  });

  it("on a read error logs and sends collection_slugs: [] — never throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = client(() => ({ data: null, error: new Error("boom") }));
    const out = await attachCollectionSlugs(c, [{ id: "p1" }]);
    expect(out).toEqual([{ id: "p1", collection_slugs: [] }]);
    expect(log).toHaveBeenCalled();
  });

  it("returns an empty list untouched without reading", async () => {
    const c = client(() => ({ data: [], error: null }));
    expect(await attachCollectionSlugs(c, [])).toEqual([]);
    expect(c.calls).toHaveLength(0);
  });
});

describe("website function wiring", () => {
  const body = src(INDEX);
  it("every product-returning catalog route attaches collection_slugs", () => {
    expect(body).toMatch(/^import \{ attachCollectionSlugs \} from "\.\.\/_shared\/collection-slugs\.ts";$/m);
    // collections/:slug and categories/:slug
    expect(body.match(/const products = await attachCollectionSlugs\(supabase, await attachCategorySlugs\(supabase, shaped\)\);/g)).toHaveLength(2);
    // products/:slug
    expect(body).toMatch(/const \[withCollections\] = await attachCollectionSlugs\(supabase, \[product as AnyRec\]\);/);
    // /catalog/products list
    expect(body).toMatch(/products = await attachCollectionSlugs\(supabase, products\);/);
  });
});
