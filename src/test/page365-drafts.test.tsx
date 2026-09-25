import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseListExtras } from "../../supabase/functions/_shared/page365-inventory.ts";
import {
  countNewRows, defaultNewFilters, draftable, DRAFT_REASON, filterNewRows, NO_CATEGORY, parseYen, pruneTicks, publishMissing,
  selectAllShown, type NewRow,
} from "@/lib/page365-drafts";
import { emptyProduct, itemKindFrom, metalRequired } from "@/components/website/product-form";
import type { InventoryItem, InventoryRun } from "@/lib/page365-inventory";

/**
 * Page365 "Create drafts" + Catalog bulk publish (PR 4, 2026-09-28). The RULES
 * live in SQL — migration 20260929100000_page365_inventory_drafts.sql — and
 * run against a real Postgres in docs/sql/20260928_page365_inventory_drafts_local_tests.sql
 * (drafts only, idempotency, category/metal/description rules, reviews never
 * stored, photo order + dedupe, publish blocks). This file covers what
 * TypeScript owns and pins the SQL's load-bearing clauses.
 */

const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20260929100000_page365_inventory_drafts.sql"), "utf8");
const fn = (name: string) => {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return MIGRATION.slice(start, MIGRATION.indexOf("$fn$;", start));
};
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
/** The stored body (prosrc) of a function: the text between its dollar quotes. */
const body = (sql: string, name: string, tag: string) => {
  const m = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  expect(m, `${name} is defined`).not.toBeNull();
  return m![1];
};
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

describe("a metal stamp is required ONLY for jewelry (owner decision 2026-09-28)", () => {
  const base = { origin: "JAPAN", brand: null, website_category_products: [{}], website_product_variants: [{ price_jpy: 1 }] };
  it("a watch or other item with no stamp needs nothing", () => {
    expect(publishMissing({ ...base, item_kind: "watch", metals: [] })).toEqual([]);
    expect(publishMissing({ ...base, item_kind: "other", metals: [] })).toEqual([]);
  });
  it("jewelry with no stamp still needs one (a missing kind is jewelry)", () => {
    expect(publishMissing({ ...base, item_kind: "jewelry", metals: [] })).toEqual(["metal"]);
    expect(publishMissing({ ...base, metals: [] })).toEqual(["metal"]);
  });
  it("form: jewelry by default; only jewelry requires a stamp; unknown kinds read as jewelry", () => {
    expect(emptyProduct().itemKind).toBe("jewelry");
    expect(metalRequired("jewelry")).toBe(true);
    expect(metalRequired("watch")).toBe(false);
    expect(metalRequired("other")).toBe(false);
    expect(itemKindFrom("watch")).toBe("watch");
    expect(itemKindFrom(undefined)).toBe("jewelry");
    expect(itemKindFrom("bag")).toBe("jewelry");
  });
  it("Catalog save: the stamp check is jewelry-only and the kind is written", () => {
    const pc = code(src("src/components/website/ProductsCard.tsx"));
    expect(pc).toContain("if (metalRequired(f.itemKind) && !f.metals.length) throw new Error(");
    expect(pc).toContain("item_kind: f.itemKind,");
    expect(pc).not.toMatch(/if \(!f\.metals\.length\) throw/);
  });
  it("SQL: the old every-product CHECK is replaced by a jewelry-only one", () => {
    const c = code(MIGRATION);
    expect(c).toContain("DROP CONSTRAINT IF EXISTS website_products_metals_nonempty;");
    expect(c).toContain("ADD CONSTRAINT website_products_metals_jewelry CHECK (item_kind <> 'jewelry' OR cardinality(metals) >= 1);");
    expect(c).toContain("CHECK (item_kind IN ('jewelry', 'watch', 'other'))");
    expect(c).toContain("ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'jewelry';");
  });
  it("SQL: publish check and draft guard ask for a stamp only on jewelry", () => {
    expect(fn("website_product_publish_missing")).toContain("CASE WHEN wp.item_kind = 'jewelry' AND cardinality(wp.metals) = 0 THEN 'metal' END");
    expect(fn("page365_draft_publish_guard")).toContain("CASE WHEN NEW.item_kind = 'jewelry' AND cardinality(NEW.metals) = 0 THEN 'metal' END");
  });
  it("SQL: the karat bridge never refills a watch and clears karat with no stamp", () => {
    const s = body(MIGRATION, "sync_website_product_metals", "function");
    expect(s).toContain("AND coalesce(NEW.item_kind, 'jewelry') = 'jewelry' THEN");
    expect(s).toMatch(/ELSE\s+NEW\.karat := NULL;/);
  });
  it("Create drafts: a Page365 watch needs no stamp; jewelry still fails no_metal; 'Watch' is never a sku", () => {
    const d = fn("page365_inventory_create_drafts");
    expect(d).toContain("~* '\\mwatch(es)?\\M' THEN 'watch' ELSE 'jewelry' END;");
    expect(d).toContain("IF cardinality(v_metals) = 0 AND v_kind = 'jewelry' THEN");
    expect(d).toContain("'brooch','charm','chain','pearl','set','new','preloved','watch')");
    expect(DRAFT_REASON.no_metal).toMatch(/^jewelry/);
  });
});

describe("\"Don't sync with Page365\" — a switched-off code is never created", () => {
  it("create_drafts refuses it BEFORE any insert, reading the switch live", () => {
    const d = fn("page365_inventory_create_drafts");
    const refuse = d.indexOf("'reason', 'sync_disabled'");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(d.indexOf("INSERT INTO public.website_products"));
    expect(d).toMatch(/WHERE wp\.page365_sync_disabled\s+AND \(public\.page365_first_word\(wp\.sku\) = v_it\.code/);
    expect(d).toContain("IF v_it.category = 'not_synced' OR v_existing IS NOT NULL THEN");
    expect(DRAFT_REASON.sync_disabled).toMatch(/Don’t sync with Page365/);
  });
  it("the migration refuses to run before PR 2 (the switch must exist)", () => {
    expect(MIGRATION).toContain("website_products.page365_sync_disabled missing (run PR 2, 20260928100000, first)");
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
  it("md5 guards are the live (post-PR 2) bodies — no longer provisional", () => {
    expect(MIGRATION).not.toMatch(/PROVISIONAL/);
    const PR2 = src("supabase/migrations/20260928100000_page365_inventory_pr2.sql");
    for (const [sig, name] of [
      ["page365_inventory_finish(uuid)", "page365_inventory_finish"],
      ["page365_inventory_apply(uuid,uuid[],uuid[])", "page365_inventory_apply"],
      ["page365_inventory_record_photo(uuid,bigint,text,text,text,integer,uuid)", "page365_inventory_record_photo"],
    ]) {
      const esc = sig.replace(/[()[\]]/g, "\\$&");
      const m = MIGRATION.match(new RegExp(`'${esc}',\\s+'([0-9a-f]{32})'`));
      expect(m, sig).not.toBeNull();
      expect(m![1]).toBe(md5(body(PR2, name, "fn")));
    }
  });
  it("the karat bridge starts from its live body and is proven after", () => {
    const live = src("supabase/migrations/20260912142545_73c6d611-0a6a-4432-88c3-eb4314243789.sql");
    const before = md5(body(live, "sync_website_product_metals", "function"));
    const after = md5(body(MIGRATION, "sync_website_product_metals", "function"));
    expect(before).toBe("dad410b20a7e5b352627f219f5351550");
    expect(MIGRATION).toContain(`IS DISTINCT FROM '${before}' AND v_got IS DISTINCT FROM '${after}'`);
    expect(MIGRATION).toMatch(new RegExp(`IS DISTINCT FROM '${after}' THEN\\s+RAISE EXCEPTION 'page365_inventory_drafts: sync_website_product_metals did not land`));
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
    expect(pc).toMatch(/page365_photo_id: m\.page365_photo_id \?\? null,/);
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
// PR 3c: every ticked listing is read fresh before the drafts are created.
const refreshForDrafts = vi.fn(async () => ({ busy: false, refreshed: 2, gone: 0, failed: [], remaining: 0 }));
vi.mock("@/lib/page365-inventory-api", () => ({
  copyPhotos: vi.fn(),
  refreshForDrafts: (...a: unknown[]) => (refreshForDrafts as unknown as (...x: unknown[]) => unknown)(...a),
}));

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
    expect(refreshForDrafts).toHaveBeenCalledWith("run1", ["a", "c"], []);
    expect(refreshForDrafts.mock.invocationCallOrder[0]).toBeLessThan(createDrafts.mock.invocationCallOrder[0]);
    expect(screen.getByTestId("new-fresh").textContent).toMatch(/Read fresh from Page365: 2/);
    expect(screen.getByTestId("new-as-of").textContent).toMatch(/Quantities as of the full fetch of 2026-09-28/);
    expect(await screen.findByText(/Skipped E7003: code already in the Hub/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "R7001" }).getAttribute("href")).toBe("/website?tab=catalog&product=p1");

    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByText("N7002")).toBeTruthy();
  });
});
