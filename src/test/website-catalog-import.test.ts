import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import {
  CollectionOption, DATA_START_ROW, ImportRowInput, SHEET_NAME,
  hasForbiddenGoldTerm, isBlankRow, parseOrigin, resolveCollection, validateRow,
} from "@/lib/website-catalog-import";

/**
 * Guards the spreadsheet importer against the two things that silently break it:
 * the template's SINGULAR jewelry types vs the Hub's PLURAL collections, and
 * the guidance rows (2-4) leaking in as data.
 */

// The live set, as seeded by 20260908120000_website_catalog_metals_fx_collections.
const COLLECTIONS: CollectionOption[] = [
  { id: "c-anklets", name: "Anklets", slug: "anklets" },
  { id: "c-bracelets", name: "Bracelets", slug: "bracelets" },
  { id: "c-earrings", name: "Earrings", slug: "earrings" },
  { id: "c-necklaces", name: "Necklaces", slug: "necklaces" },
  { id: "c-pendants", name: "Pendants", slug: "pendants" },
  { id: "c-rings", name: "Rings", slug: "rings" },
  { id: "c-sets", name: "Sets", slug: "sets" },
];

const ctx = { collections: COLLECTIONS, isAdmin: true, existingSkus: new Set<string>() };

const blank: ImportRowInput = {
  sheetRow: 5, buy_code: "", product_name: "", product_description: "", price: "",
  cost: "", stock_amount: "", hub_jewelry_type: "", hub_metal: "", hub_weight_g: "",
  hub_stone: "", hub_size: "", hub_condition: "", hub_status: "",
  hub_origin: "", hub_brand: "", images: [],
};

const good: ImportRowInput = {
  ...blank,
  buy_code: "R3341",
  product_name: "R3341 Ring K18 16.20g Diamond 3.82ct, 0.80ct Dome Sz# 13 [Preloved]",
  product_description: "K18WG dome ring, 16.20g, set with 3.82ct and 0.80ct diamonds. Size 13. Preloved, authenticated in Japan.",
  price: "628980", stock_amount: "1", hub_jewelry_type: "Ring", hub_metal: "K18",
  hub_weight_g: "16.2", hub_stone: "Diamond 3.82ct, 0.80ct", hub_size: "13",
  hub_condition: "Preloved", hub_status: "Draft",
};

describe("resolveCollection", () => {
  it("maps the template's singular types onto the Hub's plural collections", () => {
    // The template dropdown is singular; the collections are plural. Every one
    // of these must resolve or the whole sheet errors out.
    const cases: [string, string][] = [
      ["Ring", "c-rings"], ["Necklace", "c-necklaces"], ["Pendant", "c-pendants"],
      ["Bracelet", "c-bracelets"], ["Earrings", "c-earrings"], ["Anklet", "c-anklets"],
      ["Set", "c-sets"],
    ];
    for (const [input, id] of cases) {
      expect(resolveCollection(input, COLLECTIONS)?.id, input).toBe(id);
    }
  });

  it("is case-insensitive and accepts the plural or the slug", () => {
    expect(resolveCollection("  rInG ", COLLECTIONS)?.id).toBe("c-rings");
    expect(resolveCollection("Rings", COLLECTIONS)?.id).toBe("c-rings");
    expect(resolveCollection("necklaces", COLLECTIONS)?.id).toBe("c-necklaces");
  });

  it("returns null for an unknown type rather than guessing", () => {
    expect(resolveCollection("Brooch", COLLECTIONS)).toBeNull();
    expect(resolveCollection("", COLLECTIONS)).toBeNull();
  });
});

describe("hasForbiddenGoldTerm", () => {
  it("mirrors the DB terminology trigger", () => {
    expect(hasForbiddenGoldTerm("Japan gold chain")).toBe(true);
    expect(hasForbiddenGoldTerm("Japanese Gold")).toBe(true);
    expect(hasForbiddenGoldTerm("saudi  gold")).toBe(true);
    expect(hasForbiddenGoldTerm("Italian gold")).toBe(true);
  });

  it("leaves the approved phrasing alone", () => {
    expect(hasForbiddenGoldTerm("K18 gold, hallmark checked in Japan")).toBe(false);
    expect(hasForbiddenGoldTerm("Preloved, authenticated in Japan.")).toBe(false);
    expect(hasForbiddenGoldTerm("750 yellow and white gold layered wave ring")).toBe(false);
  });
});

describe("validateRow", () => {
  it("accepts the template's example row", () => {
    const row = validateRow(good, ctx);
    expect(row.errors).toEqual([]);
    expect(row.value).toMatchObject({
      sku: "R3341", collectionId: "c-rings", karat: "K18", weight_g: 16.2,
      condition: "Preloved", status: "draft", size: "13", price_jpy: 628980, stock_qty: 1,
    });
  });

  it("uppercases the SKU and defaults stock to 1", () => {
    const row = validateRow({ ...good, buy_code: " r3341 ", stock_amount: "" }, ctx);
    expect(row.value?.sku).toBe("R3341");
    expect(row.value?.stock_qty).toBe(1);
  });

  it("defaults a blank origin to UNKNOWN with no brand — never guesses", () => {
    const row = validateRow(good, ctx);
    expect(row.value?.origin).toBe("UNKNOWN");
    expect(row.value?.brand).toBeNull();
  });

  it("accepts the template's origin labels and the enum values, case-insensitively", () => {
    const cases: [string, string][] = [
      ["Made in Japan", "JAPAN"], ["japan", "JAPAN"], ["JAPAN", "JAPAN"],
      ["Branded", "BRAND"], ["brand", "BRAND"], ["Other", "OTHER"], ["unknown", "UNKNOWN"],
    ];
    for (const [input, origin] of cases) {
      const row = validateRow({ ...good, hub_origin: input, hub_brand: origin === "BRAND" ? "Tiffany & Co." : "" }, ctx);
      expect(row.errors, input).toEqual([]);
      expect(row.value?.origin, input).toBe(origin);
    }
    expect(parseOrigin("  made   in  japan ")).toBe("JAPAN");
  });

  it("rejects an origin outside the four values instead of landing on Unknown", () => {
    const row = validateRow({ ...good, hub_origin: "Italy" }, ctx);
    expect(row.value).toBeUndefined();
    expect(row.errors.join(" ")).toContain("hub_origin");
  });

  it("requires a brand name for a Branded piece", () => {
    const missing = validateRow({ ...good, hub_origin: "Branded" }, ctx);
    expect(missing.errors.join(" ")).toContain("hub_brand is required");
    const present = validateRow({ ...good, hub_origin: "Branded", hub_brand: " Tiffany & Co. " }, ctx);
    expect(present.errors).toEqual([]);
    expect(present.value?.brand).toBe("Tiffany & Co.");
  });

  it("rejects a metal outside the enum", () => {
    const row = validateRow({ ...good, hub_metal: "PT850" }, ctx);
    expect(row.value).toBeUndefined();
    expect(row.errors.join(" ")).toContain("PT850");
  });

  it("rejects forbidden gold terminology before it reaches the DB", () => {
    const row = validateRow({ ...good, product_description: "Japan gold ring, 16.2g." }, ctx);
    expect(row.errors.join(" ")).toContain("Forbidden gold terminology");
  });

  it("explains an empty formula-driven product_name", () => {
    const row = validateRow({ ...good, product_name: "" }, ctx);
    expect(row.errors.join(" ")).toContain("formula calculates");
  });

  it("rejects a name over 80 characters", () => {
    const row = validateRow({ ...good, product_name: "x".repeat(81) }, ctx);
    expect(row.errors.join(" ")).toContain("max 80");
  });

  it("drops the cost column for non-admins without erroring", () => {
    const asAdmin = validateRow({ ...good, cost: "410000" }, ctx);
    expect(asAdmin.value?.cost_basis).toBe(410000);
    const asStaff = validateRow({ ...good, cost: "410000" }, { ...ctx, isAdmin: false });
    expect(asStaff.errors).toEqual([]);
    expect(asStaff.value?.cost_basis).toBeNull();
  });

  it("rejects non-http image cells", () => {
    const row = validateRow({ ...good, images: ["ftp://x/a.jpg"] }, ctx);
    expect(row.errors.join(" ")).toContain("image_1");
  });

  it("keeps only the populated image URLs, in order", () => {
    const row = validateRow(
      { ...good, images: ["https://x/1.jpg", "", "https://x/3.jpg"] }, ctx,
    );
    expect(row.value?.images).toEqual(["https://x/1.jpg", "https://x/3.jpg"]);
  });
});

describe("the shipped template", () => {
  // ESM: __dirname is not defined under Vitest.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "../../public/templates/cha-jewels-product-upload-template.xlsx");
  const wb = XLSX.read(readFileSync(file), { type: "buffer" });
  const sheet = wb.Sheets[SHEET_NAME];
  const grid = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1, raw: false, defval: "", blankrows: true,
  });
  const header = (grid[0] ?? []).map((h) => String(h ?? "").trim());
  const cell = (r: string[], name: string) => {
    const i = header.indexOf(name);
    return i < 0 ? "" : String(r[i] ?? "").trim();
  };
  const toInput = (r: string[], sheetRow: number): ImportRowInput => ({
    sheetRow,
    buy_code: cell(r, "buy_code"),
    product_name: cell(r, "product_name"),
    product_description: cell(r, "product_description"),
    price: cell(r, "price"),
    cost: cell(r, "cost"),
    stock_amount: cell(r, "stock_amount"),
    hub_jewelry_type: cell(r, "hub_jewelry_type"),
    hub_metal: cell(r, "hub_metal"),
    hub_weight_g: cell(r, "hub_weight_g"),
    hub_stone: cell(r, "hub_stone"),
    hub_size: cell(r, "hub_size"),
    hub_condition: cell(r, "hub_condition"),
    hub_status: cell(r, "hub_status"),
    hub_origin: cell(r, "hub_origin"),
    hub_brand: cell(r, "hub_brand"),
    images: Array.from({ length: 10 }, (_, i) => cell(r, `image_${i + 1}`)),
  });

  it("carries the header the importer keys off", () => {
    expect(header).toContain("buy_code");
    expect(header).toContain("hub_condition");
    expect(header).toContain("hub_origin");
    expect(header).toContain("hub_brand");
    expect(header).toContain("image_10");
  });

  it("yields exactly the two example rows once guidance rows are skipped", () => {
    const rows = grid
      .slice(DATA_START_ROW - 1)
      .map((r, i) => toInput(r ?? [], DATA_START_ROW + i))
      .filter((r) => !isBlankRow(r));
    expect(rows.map((r) => r.buy_code)).toEqual(["R3341", "R7828"]);
  });

  it("imports both example rows as Draft Preloved rings with no errors", () => {
    const rows = grid
      .slice(DATA_START_ROW - 1)
      .map((r, i) => toInput(r ?? [], DATA_START_ROW + i))
      .filter((r) => !isBlankRow(r))
      .map((r) => validateRow(r, ctx));

    expect(rows.flatMap((r) => r.errors)).toEqual([]);
    for (const r of rows) {
      expect(r.value?.collectionId).toBe("c-rings");
      expect(r.value?.condition).toBe("Preloved");
      expect(r.value?.status).toBe("draft");
      expect(r.value?.karat).toBe("K18");
      // The example rows state no origin: the site must claim nothing for them.
      expect(r.value?.origin).toBe("UNKNOWN");
      expect(r.value?.brand).toBeNull();
    }
    expect(rows.map((r) => r.value?.weight_g)).toEqual([16.2, 19]);
    expect(rows.map((r) => r.value?.price_jpy)).toEqual([628980, 679980]);
    expect(rows.map((r) => r.value?.size)).toEqual(["13", "18"]);
  });
});
