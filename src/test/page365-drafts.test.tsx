import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseListExtras } from "../../supabase/functions/_shared/page365-inventory.ts";
import {
  countNewRows, defaultNewFilters, draftable, filterNewRows, NO_CATEGORY, parseYen, pruneTicks, publishMissing,
  selectAllShown, type NewRow,
} from "@/lib/page365-drafts";
import type { InventoryItem, InventoryRun } from "@/lib/page365-inventory";

/**
 * Page365 "Create drafts" + Catalog bulk publish (PR 4, 2026-09-28). The RULES
 * live in SQL — migration 20260928100000_page365_inventory_drafts.sql — and
 * run against a real Postgres in docs/sql/20260928_page365_inventory_drafts_local_tests.sql
 * (drafts only, idempotency, category/metal/description rules, reviews never
 * stored, photo order + dedupe, publish blocks). This file covers what
 * TypeScript owns and pins the SQL's load-bearing clauses.
 */

const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20260928100000_page365_inventory_drafts.sql"), "utf8");
const fn = (name: string) => {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return MIGRATION.slice(start, MIGRATION.indexOf("$fn$;", start));
};
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const code = (s: string) => s.split("\n").filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");

const item = (over: Partial<NewRow>): NewRow => ({
  id: "x", run_id: "run1", kind: "page365", page365_product_id: 1, page365_variant_id: 1,
  page365_name: "R1 Ring K18", variant_name: null, code: "R1", page365_price_jpy: 50000, page365_full_price_jpy: null,
  page365_available: 1, match_result: "unmatched", website_product_id: null, variant_id: null, hub_sku: null,
  hub_price_jpy: null, seen_stock: null, web_holds: null, invoice_holds: null, proposed_stock: null, category: "new",
  price_differs: false, photos_total: 2, photos_to_copy: 0, photos_removed: 0, missing_runs: null, status: "review",
  result_note: null, page365_category: "Rings MIJ", ...over,
});

const ROWS: NewRow[] = [
  item({ id: "a", code: "R7001", page365_name: "R7001 Ring K18", page365_available: 2, page365_price_jpy: 50000 }),
  item({ id: "b", code: "N7002", page365_name: "N7002 Necklace PT900", page365_available: 0, page365_price_jpy: 30000,
         page365_category: "SUPPLIER LISTINGS - PEARLS" }),
  item({ id: "c", code: "E7003", page365_name: "E7003 Earrings K18", page365_available: 1, page365_price_jpy: 120000,
         page365_category: null }),
  item({ id: "d", code: "R7009", page365_name: "R7009 Ring K18", page365_available: 1, page365_price_jpy: 60000,
         status: "applied", result_note: "draft_created", match_result: "matched", website_product_id: "p9" }),
];

describe("filters", () => {
  it("In stock only is ON by default and hides sold pieces", () => {
    const f = defaultNewFilters();
    expect(f.inStockOnly).toBe(true);
    expect(filterNewRows(ROWS, f).map(r => r.code)).toEqual(["R7001", "E7003", "R7009"]);
    expect(filterNewRows(ROWS, { ...f, inStockOnly: false }).map(r => r.code)).toContain("N7002");
  });
  it("search matches code or name, case-insensitive", () => {
    const f = { ...defaultNewFilters(), inStockOnly: false };
    expect(filterNewRows(ROWS, { ...f, search: "necklace" }).map(r => r.code)).toEqual(["N7002"]);
    expect(filterNewRows(ROWS, { ...f, search: "e7003" }).map(r => r.code)).toEqual(["E7003"]);
  });
  it("category and no-category", () => {
    const f = { ...defaultNewFilters(), inStockOnly: false };
    expect(filterNewRows(ROWS, { ...f, category: "Rings MIJ" }).map(r => r.code)).toEqual(["R7001", "R7009"]);
    expect(filterNewRows(ROWS, { ...f, category: NO_CATEGORY }).map(r => r.code)).toEqual(["E7003"]);
  });
  it("price range is inclusive yen", () => {
    const f = { ...defaultNewFilters(), inStockOnly: false, priceMin: 50000, priceMax: 60000 };
    expect(filterNewRows(ROWS, f).map(r => r.code)).toEqual(["R7001", "R7009"]);
  });
  it("parses typed yen bounds", () => {
    expect(parseYen("¥50,000")).toBe(50000);
    expect(parseYen("")).toBeNull();
    expect(parseYen("abc")).toBeNull();
    expect(parseYen("-5")).toBeNull();
  });
  it("counts: new · in stock · sold out · drafted", () => {
    expect(countNewRows(ROWS)).toEqual({ total: 4, inStock: 3, soldOut: 1, drafted: 1 });
  });
});

describe("selection", () => {
  it("Select all shown ticks only shown, draftable rows", () => {
    const shown = filterNewRows(ROWS, defaultNewFilters());
    expect([...selectAllShown(shown)].sort()).toEqual(["a", "c"]); // R7009 already drafted, N7002 hidden
    expect(draftable(ROWS[3])).toBe(false);
  });
  it("a filter change drops ticks on rows no longer shown", () => {
    const ticks = new Set(["a", "b", "c"]);
    const shown = filterNewRows(ROWS, { ...defaultNewFilters(), search: "R7001" });
    expect([...pruneTicks(ticks, shown)]).toEqual(["a"]);
  });
});

describe("publish readiness (display twin of website_product_publish_missing)", () => {
  const base = { origin: "JAPAN", brand: null, metals: ["K18"], website_category_products: [{}], website_product_variants: [{ price_jpy: 1 }] };
  it("complete draft needs nothing", () => expect(publishMissing(base)).toEqual([]));
  it("origin UNKNOWN and no category are named", () =>
    expect(publishMissing({ ...base, origin: "UNKNOWN", website_category_products: [] })).toEqual(["origin", "category"]));
  it("Branded needs a brand name", () => expect(publishMissing({ ...base, origin: "BRAND", brand: " " })).toEqual(["brand"]));
  it("a zero price blocks", () => expect(publishMissing({ ...base, website_product_variants: [{ price_jpy: 0 }] })).toEqual(["price"]));
  it("matches the SQL list of reasons", () => {
    const sql = fn("website_product_publish_missing");
    for (const k of ["'origin'", "'brand'", "'category'", "'metal'", "'price'"]) expect(sql).toContain(k);
  });
});

describe("list extras (category + description) never carry reviews", () => {
  it("keeps category and description only", () => {
    const m = parseListExtras({ count: 2, items: [
      { id: 1, name: "R1 Ring", description: "K18\n2.1g", category: { id: 7, name: " Rings MIJ " },
        review: { customer_name: "Jane Buyer" }, photo: { small: "x" } },
      { id: 2, name: "X", category: null },
    ] });
    expect(m.get(1)).toEqual({ category_id: 7, category: "Rings MIJ", description: "K18\n2.1g" });
    expect(m.get(2)).toEqual({ category_id: null, category: null, description: null });
    expect(JSON.stringify([...m.values()])).not.toMatch(/Jane/);
  });
  it("is lenient: a bad envelope is an empty map, never a throw", () => {
    expect(parseListExtras(null).size).toBe(0);
    expect(parseListExtras({ items: "no" }).size).toBe(0);
  });
});

describe("SQL rules are pinned", () => {
  const create = code(fn("page365_inventory_create_drafts"));
  it("drafts only, origin never guessed", () => {
    expect(create).toMatch(/VALUES \(v_it\.code, v_slug, v_name, 'draft', 'UNKNOWN',/);
    expect(create).not.toMatch(/'active'/);
  });
  it("idempotent: code already in the Hub, listing already drafted, sku race", () => {
    expect(create).toMatch(/page365_first_word\(wp\.sku\) = v_it\.code/);
    expect(create).toContain("'already_created'");
    expect(create).toMatch(/WHEN unique_violation THEN/);
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS uq_website_products_page365_source/);
  });
  it("only a ready, current, fresh run; only 'new' review rows", () => {
    expect(create).toContain("'run_not_ready'");
    expect(create).toContain("'superseded'");
    expect(create).toContain("'run_stale'");
    expect(create).toMatch(/v_it\.category <> 'new' OR v_it\.match_result <> 'unmatched' OR v_it\.status <> 'review'/);
  });
  it("permission is checked inside, same key as apply", () => {
    expect(create).toMatch(/has_permission\(v_uid, 'manage_website_catalog'\)/);
    expect(code(fn("website_publish_products"))).toMatch(/has_permission\(v_uid, 'manage_website_catalog'\)/);
  });
  it("the item is matched to the new variant so the PR 1 copier takes the photos", () => {
    expect(create).toMatch(/SET match_result = 'matched', website_product_id = v_pid, variant_id = v_vid/);
  });
  it("description only through the cleaner; reviews never read", () => {
    expect(create).toMatch(/page365_clean_description\(v_prod\.list_description\)/);
    // Nothing but the item status 'review' and documentation strings mention reviews.
    const body = code(MIGRATION).replace(/'review'/g, "").replace(/COMMENT ON[\s\S]*?';/g, "");
    expect(body).not.toMatch(/review/i);
  });
  it("publish writes 'active' only when nothing is missing, audited", () => {
    const pub = code(fn("website_publish_products"));
    expect(pub).toMatch(/IF cardinality\(v_missing\) > 0 THEN[\s\S]*?CONTINUE;[\s\S]*?SET status = 'active'/);
    expect(pub).toContain("'website_product_published'");
  });
  it("guard trigger covers Page365 drafts only", () => {
    const g = code(fn("page365_draft_publish_guard"));
    expect(g).toMatch(/NEW\.page365_product_id IS NULL OR NEW\.status::text <> 'active' THEN RETURN NEW/);
    expect(MIGRATION).toMatch(/BEFORE INSERT OR UPDATE OF status ON public\.website_products/);
  });
  it("md5 guards are marked PROVISIONAL until PR 2 is merged", () => {
    expect(MIGRATION).toMatch(/PROVISIONAL/);
    expect(MIGRATION).toMatch(/'page365_inventory_apply\(uuid,uuid\[\],uuid\[\]\)',\s+'[0-9a-f]{32}'/);
  });
});

describe("edge + catalog wiring", () => {
  it("fetch start stores the list category and description, and survives a pre-migration schema", () => {
    const f = code(src("supabase/functions/page365-inventory-fetch/index.ts"));
    expect(f).toMatch(/const extras = parseListExtras\(listJson\);/);
    expect(f).toMatch(/list_category: x\?\.category \?\? null/);
    expect(f).toMatch(/if \(qErr && \/list_\(category\|description\)\/\.test\(qErr\.message\)\)/);
  });
  it("the product dialog keeps a copied photo's Page365 identity on save", () => {
    const pc = code(src("src/components/website/ProductsCard.tsx"));
    expect(pc).toMatch(/website_product_media\(id, url, alt, sort, page365_photo_id, page365_photo_version\)/);
    expect(pc).toMatch(/page365_photo_id: m\.page365_photo_id, page365_photo_version:/);
  });
  it("the product dialog writes 'active' after categories", () => {
    const pc = code(src("src/components/website/ProductsCard.tsx"));
    const cat = pc.indexOf('from("website_category_products" as any)');
    const live = pc.indexOf('.update({ status: "active" }');
    expect(cat).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(cat);
  });
});

// --- Panel -------------------------------------------------------------------
const createDrafts = vi.fn(async () => ({
  ok: true, created: 1, skipped: 1, failed: 0,
  created_items: [{ item_id: "a", code: "R7001", product_id: "p1", needs: ["origin"], photos: 0 }],
  skipped_items: [{ item_id: "c", code: "E7003", reason: "code_exists", product_id: "p0" }],
  failed_items: [],
}));
vi.mock("@/lib/page365-drafts-api", () => ({
  createDrafts: (...a: unknown[]) => (createDrafts as unknown as (...x: unknown[]) => unknown)(...a),
  listCategories: async () => new Map([["ip-a", "Rings MIJ"], ["ip-b", "SUPPLIER LISTINGS - PEARLS"]]),
  publishProducts: vi.fn(),
}));
vi.mock("@/lib/page365-inventory-api", () => ({ copyPhotos: vi.fn() }));

describe("Page365NewProductsPanel", () => {
  const run: InventoryRun = { id: "run1", status: "ready", page365_count: 3, products_total: 3, error: null,
    created_at: "2026-09-28T01:00:00Z", finished_at: "2026-09-28T01:03:00Z" };
  const items = ROWS.slice(0, 3).map((r, i) => ({ ...r, inventory_product_id: `ip-${"abc"[i]}` })) as InventoryItem[];

  it("shows counts, hides sold pieces by default, creates drafts for the shown rows only", async () => {
    const { Page365NewProductsPanel } = await import("@/components/website/Page365NewProductsPanel");
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Page365NewProductsPanel run={run} items={items} canCreate onChanged={() => undefined} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("new-counts").textContent).toMatch(/3 new · 2 in stock · 1 sold out/);
    expect(screen.queryByText("N7002")).toBeNull();
    expect(await screen.findByText("Rings MIJ")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Select all shown \(2\)/ }));
    expect(screen.getByRole("checkbox", { name: "Select R7001" }).getAttribute("data-state")).toBe("checked");
    fireEvent.click(screen.getByRole("button", { name: /Create drafts \(2\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Create drafts" }));
    await waitFor(() => expect(createDrafts).toHaveBeenCalledWith("run1", ["a", "c"]));
    expect(await screen.findByText(/Skipped E7003: code already in the Hub/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "R7001" }).getAttribute("href")).toBe("/website?tab=catalog&product=p1");

    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText("N7002")).toBeTruthy();
  });
});
