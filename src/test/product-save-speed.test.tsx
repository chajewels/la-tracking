import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type LoadedVariant, emptyProduct, sameIds, sameMedia, sameVariantRow,
} from "@/components/website/product-form";

/**
 * Website → Catalog → Edit product → Save, made faster (2026-10-24): no second
 * AI translation after Regenerate, the translation runs alongside the writes,
 * unchanged rows are not rewritten, and only the saved product is re-read.
 * Source-anchored like page365-drafts.test.tsx.
 */

const ROOT = resolve(__dirname, "../..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const code = (s: string) => s.split("\n").filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");
const card = code(src("src/components/website/ProductsCard.tsx"));
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  expect(a, from).toBeGreaterThan(-1);
  const b = s.indexOf(to, a + from.length);
  expect(b, to).toBeGreaterThan(a);
  return s.slice(a, b);
};
const saveFn = between(card, "const save = useMutation({", "const remove = useMutation({");

describe("save: translation alongside the writes", () => {
  it("never awaits translateJa before the first website_products write", () => {
    expect(saveFn).not.toMatch(/await\s+translateJa/);
    const start = saveFn.indexOf("translateJa(");
    const firstWrite = saveFn.indexOf(".update(productPayload)");
    expect(start).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(start);
    // The result is awaited only after the link tables.
    expect(saveFn.indexOf("await translation")).toBeGreaterThan(saveFn.lastIndexOf('from("website_category_products")'));
  });
  it("translates the name only when it is missing, the description only for a new product", () => {
    expect(saveFn).toContain("const needName = needsNameTranslation(f);");
    expect(saveFn).toContain("const needDesc = needsDescriptionTranslation(f);");
  });
  it("keeps the failure toast and the not-published message", () => {
    expect(saveFn).toContain('title: "Japanese not generated"');
    expect(saveFn).toContain("the Japanese was left as it was.");
    expect(saveFn).toContain("`Saved as a draft, not published: ${error.message}`");
  });
  it("the final status update is still after website_category_products", () => {
    const lastCat = card.lastIndexOf('from("website_category_products")');
    const live = card.indexOf('.update({ status: "active" }');
    expect(lastCat).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(lastCat);
    const links = saveFn.indexOf("await Promise.all([writeCollections(), writeCategories()]);");
    expect(links).toBeGreaterThan(-1);
    expect(saveFn.indexOf('.update({ status: "active" }')).toBeGreaterThan(links);
  });
});

describe("Translate description → Save does not translate twice", () => {
  it("translateDescription writes the Japanese description and nothing else", () => {
    const fn = between(card, "async function translateDescription()", "async function regenerateJapaneseName()");
    expect(fn).toContain("translateJa({ description: en })");
    expect(fn).not.toMatch(/name_ja/);
  });
  it("no savedName / savedEn remains anywhere in src/", () => {
    const self = resolve(__dirname, "product-save-speed.test.tsx");
    const old = new RegExp(["saved" + "Name", "saved" + "En"].join("|"));
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && p !== self ? [p] : [];
    });
    const hits = walk(resolve(ROOT, "src")).filter((p) => old.test(readFileSync(p, "utf8")));
    expect(hits).toEqual([]);
  });
  it("a new product starts with no snapshot and empty sources", () => {
    const f = emptyProduct();
    expect(f.loaded).toBeNull();
    expect(f.jaSourceEn).toBe("");
  });
});

describe("changed-only writes", () => {
  const was: LoadedVariant = {
    id: "v1", size: "12", stone: null, price_jpy: 50000, sale_price_jpy: null, cost_basis: 30000, stock_qty: 1, sort: 0,
    media: [
      { url: "a.jpg", alt: "Ring", sort: 0, page365_photo_id: 7, page365_photo_version: "x" },
      { url: "b.jpg", alt: null, sort: 1, page365_photo_id: null, page365_photo_version: null },
    ],
  };
  const row = { size: "12", stone: null, price_jpy: 50000, sale_price_jpy: null, cost_basis: 30000, stock_qty: 1, sort: 0 };
  it("an unchanged variant row is skipped; any field change is written", () => {
    expect(sameVariantRow(row, was)).toBe(true);
    expect(sameVariantRow({ ...row, stock_qty: 0 }, was)).toBe(false);
    expect(sameVariantRow({ ...row, sale_price_jpy: 45000 }, was)).toBe(false);
    expect(sameVariantRow({ ...row, sort: 1 }, was)).toBe(false);
  });
  it("photos: same url, alt, order and Page365 ids skip; a reorder or new alt rewrites", () => {
    const same = was.media.map((m) => ({ ...m }));
    expect(sameMedia(same, was.media)).toBe(true);
    expect(sameMedia([same[1], same[0]].map((m, i) => ({ ...m, sort: i })), was.media)).toBe(false);
    expect(sameMedia([{ ...same[0], alt: "Ring 2" }, same[1]], was.media)).toBe(false);
    expect(sameMedia([{ ...same[0], page365_photo_id: null }, same[1]], was.media)).toBe(false);
    expect(sameMedia([same[0]], was.media)).toBe(false);
  });
  it("link tables: same ids in the same order skip", () => {
    expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIds(["b", "a"], ["a", "b"])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
  it("the save consults the snapshot for variants, photos and both link tables", () => {
    expect(saveFn).toContain("if (!before || !sameVariantRow(payload, before)) {");
    expect(saveFn).toContain("if (before && sameMedia(mediaRows, before.media)) continue;");
    expect(saveFn).toContain("if (f.loaded && sameIds(f.collectionIds, f.loaded.collectionIds)) return;");
    expect(saveFn).toContain("if (f.loaded && sameIds(f.categoryIds, f.loaded.categoryIds)) return;");
    expect(saveFn).toContain("page365_photo_id: m.page365_photo_id ?? null,");
  });
});

describe("refresh only the saved product", () => {
  it("onSuccess re-reads one product into the cache and falls back to a full reload", () => {
    const onSuccess = between(saveFn, "onSuccess: (productId) => {", "onError:");
    expect(onSuccess).toContain("void refreshProduct(productId);");
    expect(onSuccess).not.toContain("invalidateQueries");
    const fn = between(card, "async function refreshProduct(productId: string) {", "const save = useMutation({");
    expect(fn).toContain('.select(PRODUCT_SELECT).eq("id", productId).maybeSingle();');
    expect(fn).toContain('qc.setQueryData<CatalogProductRead[]>(["website-products"]');
    expect(fn).toContain("if (i === -1) return [row, ...old];");
    expect(fn).toContain('qc.invalidateQueries({ queryKey: ["website-products"] });');
  });
  it("the list and the refresh read the same select", () => {
    expect(card).toContain(".select(PRODUCT_SELECT)\n          .order(\"created_at\", { ascending: false })");
    expect(card).toContain("website_product_media(id, url, alt, sort, page365_photo_id, page365_photo_version)");
  });
});
