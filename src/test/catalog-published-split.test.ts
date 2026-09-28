import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS, NO_PRODUCT_TYPE, type ScopedProduct, filterProducts, filtersFromParams, groupByType, isPublished,
  scopeToView, statusesForTab, tabCounts, tabOf, tabOfProduct, viewFromParams, withFilters, withView,
} from "@/lib/catalog-search";

/**
 * Website → Catalog, Published / Unpublished tabs grouped by product type
 * (owner request 2026-09-28). "Published" = status "active" — the definition
 * the website API and the cut-out publish gate use.
 */

const p = (id: string, name: string, status: string, types: string[] = [], extra: Partial<ScopedProduct> = {}): ScopedProduct => ({
  id, name, sku: name.split(" ")[0], status, stock: 1, name_ja: null,
  website_collection_products: types.map((collection_id) => ({ collection_id })),
  website_category_products: [], ...extra,
});

// Newest first, as the Catalog lists them.
const ROWS = [
  p("1", "R100 Diamond ring", "active", ["rings"]),
  p("2", "P200 Pearl pendant", "active", ["pendants", "necklaces"]),     // two types
  p("3", "W300 Wallet", "active", []),                                    // no type
  p("4", "R400 Gold ring", "draft", ["rings"]),
  p("5", "N500 Chain", "archived", ["necklaces"]),
  p("6", "R600 Page365 ring", "draft", ["rings"], { page365_product_id: 9876 }),
  p("7", "E700 Studs", "draft", ["gone-type"]),                           // links a type the Hub no longer has
];
// website_collections as the Hub loads them (.order("name")).
const TYPES = [
  { id: "necklaces", name: "Necklaces" }, { id: "pendants", name: "Pendants" }, { id: "rings", name: "Rings" },
];
const ids = (rows: ScopedProduct[]) => rows.map((r) => r.id);

describe("published / unpublished split", () => {
  it("published is status active; draft and archived are unpublished", () => {
    expect(isPublished({ status: "active" })).toBe(true);
    expect(isPublished({ status: "draft" })).toBe(false);
    expect(isPublished({ status: "archived" })).toBe(false);
    expect(ids(scopeToView(ROWS, "published"))).toEqual(["1", "2", "3"]);
    expect(ids(scopeToView(ROWS, "unpublished"))).toEqual(["4", "5", "6", "7"]);
  });

  it("the Page365 drafts view is part of Unpublished: only unpublished Page365 drafts", () => {
    expect(ids(scopeToView(ROWS, "page365-drafts"))).toEqual(["6"]);
    expect(tabOf("page365-drafts")).toBe("unpublished");
    for (const r of scopeToView(ROWS, "page365-drafts")) expect(tabOfProduct(r)).toBe("unpublished");
  });

  it("every product is in exactly one tab", () => {
    const pub = new Set(ids(scopeToView(ROWS, "published")));
    const unpub = new Set(ids(scopeToView(ROWS, "unpublished")));
    expect(pub.size + unpub.size).toBe(ROWS.length);
    for (const id of pub) expect(unpub.has(id)).toBe(false);
  });

  it("tab counts follow the search and filters but never the status filter", () => {
    expect(tabCounts(ROWS, EMPTY_FILTERS)).toEqual({ published: 3, unpublished: 4 });
    expect(tabCounts(ROWS, { ...EMPTY_FILTERS, q: "ring" })).toEqual({ published: 1, unpublished: 2 });
    expect(tabCounts(ROWS, { ...EMPTY_FILTERS, type: "rings" })).toEqual({ published: 1, unpublished: 2 });
    expect(tabCounts(ROWS, { ...EMPTY_FILTERS, status: "draft" })).toEqual({ published: 3, unpublished: 4 });
  });

  it("search and filters work within the open tab", () => {
    const pub = scopeToView(ROWS, "published");
    expect(ids(filterProducts(pub, { ...EMPTY_FILTERS, q: "R400" }))).toEqual([]);          // a draft is not in Published
    expect(ids(filterProducts(scopeToView(ROWS, "unpublished"), { ...EMPTY_FILTERS, q: "R400" }))).toEqual(["4"]);
    expect(ids(filterProducts(scopeToView(ROWS, "unpublished"), { ...EMPTY_FILTERS, status: "archived" }))).toEqual(["5"]);
  });

  it("the Status filter offers only the tab's own statuses", () => {
    expect(statusesForTab("published", ["active", "draft"])).toEqual([]);
    expect(statusesForTab("unpublished", ["active", "draft"])).toEqual(["draft", "archived"]);
  });
});

describe("grouped by product type", () => {
  it("groups in website_collections order, then No product type; a product in two types is under each", () => {
    const g = groupByType(scopeToView(ROWS, "published"), TYPES);
    expect(g.map((x) => [x.name, ids(x.rows)])).toEqual([
      ["Necklaces", ["2"]], ["Pendants", ["2"]], ["Rings", ["1"]], ["No product type", ["3"]],
    ]);
    expect(g.at(-1)!.id).toBe(NO_PRODUCT_TYPE);
  });

  it("returns empty groups (the card decides how to show them) and puts a link to a missing type under No product type", () => {
    const g = groupByType(scopeToView(ROWS, "unpublished"), TYPES);
    expect(g.map((x) => [x.id, ids(x.rows)])).toEqual([
      ["necklaces", ["5"]], ["pendants", []], ["rings", ["4", "6"]], [NO_PRODUCT_TYPE, ["7"]],
    ]);
  });

  it("group counts follow the search; exact code matches stay first inside a group", () => {
    const hit = filterProducts(scopeToView(ROWS, "unpublished"), { ...EMPTY_FILTERS, q: "R600" });
    expect(groupByType(hit, TYPES).map((x) => x.rows.length)).toEqual([0, 0, 1, 0]);
    const all = filterProducts(ROWS, { ...EMPTY_FILTERS, q: "ring" });
    expect(groupByType(all, TYPES).find((x) => x.id === "rings")!.rows.length).toBe(3);
  });

  it("an empty list gives every group empty", () => {
    expect(groupByType([], TYPES).every((x) => x.rows.length === 0)).toBe(true);
  });
});

describe("URL", () => {
  it("?view= round-trips; missing or unknown reads Published", () => {
    expect(viewFromParams(new URLSearchParams(""))).toBe("published");
    expect(viewFromParams(new URLSearchParams("view=nonsense"))).toBe("published");
    expect(viewFromParams(new URLSearchParams("view=unpublished"))).toBe("unpublished");
    expect(viewFromParams(new URLSearchParams("view=page365-drafts"))).toBe("page365-drafts");
    for (const v of ["published", "unpublished", "page365-drafts"] as const) {
      expect(viewFromParams(withView(new URLSearchParams(""), v))).toBe(v);
    }
  });

  it("switching tab keeps search, type, category, stock, tab and product; drops the status filter", () => {
    const sp = new URLSearchParams("tab=catalog&view=page365-drafts&q=ring&type=rings&category=c1&status=draft&stock=in&product=abc");
    const n = withView(sp, "published");
    expect(n.get("view")).toBe("published");
    expect(n.get("status")).toBeNull();
    for (const k of ["tab", "q", "type", "category", "stock", "product"]) expect(n.get(k)).toBe(sp.get(k));
    expect(filtersFromParams(n)).toEqual({ q: "ring", type: "rings", category: "c1", status: "", stock: "in" });
  });

  it("writing filters never touches ?view= (the existing drafts and product links keep working)", () => {
    const sp = new URLSearchParams("view=page365-drafts&product=abc");
    const n = withFilters(sp, { q: "x", status: "" });
    expect(n.get("view")).toBe("page365-drafts");
    expect(n.get("product")).toBe("abc");
  });
});
