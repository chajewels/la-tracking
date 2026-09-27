import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS, NO_PRODUCT_TYPE, type SearchableProduct, filterProducts, filtersFromParams, hasActiveFilters,
  matchRank, normalizeSearch, productCode, productTypeCounts, withFilters,
} from "@/lib/catalog-search";

const p = (
  id: string, name: string, extra: Partial<SearchableProduct> & { types?: string[]; cats?: string[] } = {},
): SearchableProduct => ({
  id, name, sku: extra.sku ?? productCode(name), name_ja: extra.name_ja ?? null,
  status: extra.status ?? "active", stock: extra.stock ?? 1,
  website_collection_products: (extra.types ?? []).map((collection_id) => ({ collection_id })),
  website_category_products: (extra.cats ?? []).map((category_id) => ({ category_id })),
});

// Newest first, as the Catalog lists them.
const ROWS = [
  p("1", "AL1234 Diamond ring", { types: ["rings"], name_ja: "ダイヤモンド リング", stock: 0 }),
  p("2", "R7828-B Pearl pendant", { types: ["pendants", "necklaces"], name_ja: "パール ペンダント", cats: ["cat-pearl"] }),
  p("3", "AL123 Gold ring", { types: ["rings"], name_ja: "ゴールド リング", status: "draft" }),
  p("4", "N4020 Chain", { name_ja: "チェーン ネックレス", status: "archived" }),
  p("5", "WX-9 Wallet", { sku: "WX9", types: [] }),
];
const ids = (rows: SearchableProduct[]) => rows.map((r) => r.id);
const search = (q: string) => ids(filterProducts(ROWS, { ...EMPTY_FILTERS, q }));

describe("catalog search — matching", () => {
  it("normalises case, NFKC width, spaces and dashes (not ー)", () => {
    expect(normalizeSearch(" R7828-B ")).toBe("r7828b");
    expect(normalizeSearch("ＡＬ１２３")).toBe("al123");
    expect(normalizeSearch("A　L – 1")).toBe("al1");
    expect(normalizeSearch("チェーン")).toBe("チェーン");
  });

  it("the product code is the first word of the name, upper-cased", () => {
    expect(productCode("  al123 Gold ring")).toBe("AL123");
    expect(productCode("")).toBeNull();
  });

  it("finds by code, ignoring case, spaces and dashes", () => {
    expect(search("r7828b")).toEqual(["2"]);
    expect(search("R 7828 - B")).toEqual(["2"]);
    expect(search("ＡＬ１２３")).toEqual(["3", "1"]);
  });

  it("finds by SKU", () => {
    expect(search("wx9")).toEqual(["5"]);
    expect(search("WX-9")).toEqual(["5"]);
  });

  it("finds by an English word and a Japanese word", () => {
    expect(search("pearl")).toEqual(["2"]);
    expect(search("RING")).toEqual(["1", "3"]);
    expect(search("リング")).toEqual(["1", "3"]);
    expect(search("ネックレス")).toEqual(["4"]);
  });

  it("lists an exact code match first, the rest in list order", () => {
    // AL123 is an exact code; AL1234 only contains it and is newer.
    expect(search("AL123")).toEqual(["3", "1"]);
    expect(matchRank(ROWS[2], "al-123")).toBe(0);
    expect(matchRank(ROWS[0], "al123")).toBe(1);
    expect(matchRank(ROWS[0], "zzz")).toBeNull();
  });

  it("an empty search keeps everything in order", () => {
    expect(search("  ")).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("catalog search — filters", () => {
  const f = (patch: Partial<typeof EMPTY_FILTERS>) => ids(filterProducts(ROWS, { ...EMPTY_FILTERS, ...patch }));
  it("filters by product type, including 'No product type', and a product in several types shows under each", () => {
    expect(f({ type: "rings" })).toEqual(["1", "3"]);
    expect(f({ type: "pendants" })).toEqual(["2"]);
    expect(f({ type: "necklaces" })).toEqual(["2"]);
    expect(f({ type: NO_PRODUCT_TYPE })).toEqual(["4", "5"]);
  });
  it("filters by category, status and stock, and combines with the search", () => {
    expect(f({ category: "cat-pearl" })).toEqual(["2"]);
    expect(f({ status: "draft" })).toEqual(["3"]);
    expect(f({ stock: "out" })).toEqual(["1"]);
    expect(f({ stock: "in", type: "rings" })).toEqual(["3"]);
    expect(f({ q: "ring", status: "active" })).toEqual(["1"]);
  });
});

describe("catalog search — product-type counts", () => {
  it("counts every type, 'No product type' and All; a product in two types counts under each", () => {
    const c = productTypeCounts(ROWS, EMPTY_FILTERS);
    expect(c.all).toBe(5);
    expect(c.none).toBe(2);
    expect(Object.fromEntries(c.byType)).toEqual({ rings: 2, pendants: 1, necklaces: 1 });
  });
  it("follows the search and the other filters, but not the selected type", () => {
    const c = productTypeCounts(ROWS, { ...EMPTY_FILTERS, q: "ring", type: "pendants" });
    expect(c.all).toBe(2);
    expect(c.byType.get("rings")).toBe(2);
    expect(c.byType.get("pendants")).toBeUndefined();
    const s = productTypeCounts(ROWS, { ...EMPTY_FILTERS, stock: "in" });
    expect(s.all).toBe(4);
    expect(s.byType.get("rings")).toBe(1);
  });
});

describe("catalog search — URL", () => {
  it("reads and writes filters without touching view, product or tab", () => {
    const sp = new URLSearchParams("tab=catalog&view=page365-drafts&product=abc&q=AL123&type=rings&stock=bogus");
    const f = filtersFromParams(sp);
    expect(f).toEqual({ q: "AL123", type: "rings", category: "", status: "", stock: "" });
    const next = withFilters(sp, { q: "", status: "draft" });
    expect(next.get("q")).toBeNull();
    expect(next.get("status")).toBe("draft");
    expect(next.get("view")).toBe("page365-drafts");
    expect(next.get("product")).toBe("abc");
    expect(next.get("tab")).toBe("catalog");
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, stock: "in" })).toBe(true);
  });
});
