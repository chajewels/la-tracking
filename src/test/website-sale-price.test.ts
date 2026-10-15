import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { effectivePriceJpy } from "../../supabase/functions/_shared/website-down-payments.ts";
import { saleError } from "@/components/website/product-form";
import { validateRow, type ImportRowInput } from "@/lib/website-catalog-import";

/**
 * Website sale price (owner 2026-10-15). One rule in three places, which must
 * agree: the SQL website_variant_price_jpy() (migration 20261216100000), its
 * TS mirror effectivePriceJpy(), and the Hub editor / importer validation that
 * mirrors the CHECK website_variants_sale_below_price.
 */
describe("effectivePriceJpy (mirror of website_variant_price_jpy)", () => {
  it("is the full price when there is no sale", () => {
    expect(effectivePriceJpy({ price_jpy: 50000 })).toBe(50000);
    expect(effectivePriceJpy({ price_jpy: 50000, sale_price_jpy: null })).toBe(50000);
  });
  it("is the sale price while it is set and below the full price", () => {
    expect(effectivePriceJpy({ price_jpy: 50000, sale_price_jpy: 42000 })).toBe(42000);
  });
  it("never charges a sale at or above the full price, or a non-positive one", () => {
    expect(effectivePriceJpy({ price_jpy: 50000, sale_price_jpy: 50000 })).toBe(50000);
    expect(effectivePriceJpy({ price_jpy: 50000, sale_price_jpy: 60000 })).toBe(50000);
    expect(effectivePriceJpy({ price_jpy: 50000, sale_price_jpy: 0 })).toBe(50000);
  });
});

describe("the SQL function and the TS mirror state the same rule", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(
    path.resolve(here, "../../supabase/migrations/20261216100000_website_sale_price.sql"), "utf8")
    // Code only: the header comments name the old expressions they replace.
    .split("\n").filter((line) => !/^\s*--/.test(line)).join("\n");
  it("defines the CHECK and the function the mirror copies", () => {
    expect(sql).toMatch(/CHECK \(sale_price_jpy IS NULL OR \(sale_price_jpy > 0 AND sale_price_jpy < price_jpy\)\)/);
    expect(sql).toMatch(/WHEN v\.sale_price_jpy IS NOT NULL AND v\.sale_price_jpy < v\.price_jpy\s+THEN v\.sale_price_jpy ELSE v\.price_jpy END/);
  });
  it("prices the draft fallback and the cart reminder through the function", () => {
    expect(sql.match(/public\.website_variant_price_jpy\(v_variant\)/g)?.length).toBe(2);
    expect(sql).toContain("'price_jpy', public.website_variant_price_jpy(v),");
    expect(sql).not.toMatch(/v_variant\.price_jpy/);
  });
});

describe("saleError (Edit product)", () => {
  it("accepts a blank sale", () => {
    expect(saleError({ price_jpy: 50000, sale_price_jpy: null })).toBeNull();
  });
  it("accepts a whole-yen sale below the full price", () => {
    expect(saleError({ price_jpy: 50000, sale_price_jpy: 42000 })).toBeNull();
  });
  it("refuses a sale at or above the full price", () => {
    expect(saleError({ price_jpy: 50000, sale_price_jpy: 50000 })).toMatch(/below the full price/);
    expect(saleError({ price_jpy: 50000, sale_price_jpy: 51000 })).toMatch(/below the full price/);
  });
  it("refuses zero, negative and fractional amounts", () => {
    expect(saleError({ price_jpy: 50000, sale_price_jpy: 0 })).toMatch(/above 0/);
    expect(saleError({ price_jpy: 50000, sale_price_jpy: -1 })).toMatch(/above 0/);
    expect(saleError({ price_jpy: 50000, sale_price_jpy: 100.5 })).toMatch(/above 0/);
  });
});

describe("importer hub_sale_price", () => {
  const ctx = {
    collections: [{ id: "c-rings", name: "Rings", slug: "rings" }],
    categories: [],
    isAdmin: true,
    existingSkus: new Set<string>(),
  };
  const row: ImportRowInput = {
    sheetRow: 5, buy_code: "R3341",
    product_name: "R3341 Ring K18 16.20g Diamond 3.82ct, 0.80ct Dome Sz# 13 [Preloved]",
    product_description: "K18WG dome ring, 16.20g. Preloved, authenticated in Japan.",
    price: "628980", cost: "", stock_amount: "1", hub_jewelry_type: "Ring", hub_metal: "K18",
    hub_weight_g: "16.2", hub_stone: "", hub_size: "13", hub_condition: "Preloved",
    hub_status: "Draft", hub_origin: "", hub_brand: "", collection_slugs: "", category_slugs: "",
    hub_sale_price: "", images: [],
  };

  it("reads a blank cell as keep-the-existing-sale (null)", () => {
    const r = validateRow(row, ctx);
    expect(r.errors).toEqual([]);
    expect(r.value?.sale_price_jpy).toBeNull();
  });
  it("carries a valid sale price", () => {
    const r = validateRow({ ...row, hub_sale_price: "550000" }, ctx);
    expect(r.errors).toEqual([]);
    expect(r.value?.sale_price_jpy).toBe(550000);
  });
  it("refuses a sale at or above price", () => {
    expect(validateRow({ ...row, hub_sale_price: "628980" }, ctx).errors).toContain("hub_sale_price must be below price");
    expect(validateRow({ ...row, hub_sale_price: "700000" }, ctx).errors).toContain("hub_sale_price must be below price");
  });
  it("refuses a non-whole or non-positive sale", () => {
    for (const bad of ["0", "-5", "100.5", "abc"]) {
      expect(validateRow({ ...row, hub_sale_price: bad }, ctx).errors)
        .toContain("hub_sale_price must be a whole number of yen above 0");
    }
  });
});
