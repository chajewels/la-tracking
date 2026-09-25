import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  checkCompleteList, createRateLimiter, firstWord, isPhotoUrl, lastListPage, orderPhotos,
  parseListEnvelope, parseProductDetail, photoStoragePath, photoVersion, variantCode,
} from "../../supabase/functions/_shared/page365-inventory.ts";
import {
  defaultSelection, groupItems, splitStockSelection, stockTickable, type InventoryItem,
} from "@/lib/page365-inventory";

/**
 * Page365 inventory fetch (2026-09-27). The stock RULES live in SQL —
 * migration 20260927100000_page365_inventory_fetch.sql — and are exercised
 * against a real Postgres by docs/sql/20260927_page365_inventory_fetch_local_tests.sql
 * (formula incl. website holds, compare-and-set, excluded invoice holds,
 * partial runs, photo order and dedupe). This file covers what TypeScript
 * owns and pins the SQL's load-bearing clauses so an edit that drops one fails
 * here, in CI.
 */

const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20260927100000_page365_inventory_fetch.sql"), "utf8");
const fn = (name: string) => {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  return MIGRATION.slice(start, MIGRATION.indexOf("$fn$;", start));
};
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");

const photo = (id: number, position: number, v = "1789114828") => ({
  id, position, normal: `https://assets.page365.net/photos/original/${id}.jpeg?${v}`, thumb_url: "x", name: "p", album_id: 1,
});
const detail = (over: Record<string, unknown> = {}) => ({
  id: 101, name: "R1155 Ring PT900 11.60g Diamond", price: 420980, full_price: null,
  photos: [photo(9, 0)],
  variants: [{ id: 5001, name: null, price: 420980, full_price: null, in_stock: true, available: 1 }],
  review: { reviews: [{ customer_name: "Jane Buyer", body: "Lovely ring" }] },
  description: "long text",
  ...over,
});

describe("list read", () => {
  it("one request for page ceil(count/16) holds the whole cumulative list", () => {
    expect(lastListPage(572)).toBe(36);
    expect(lastListPage(16)).toBe(1);
    expect(lastListPage(0)).toBe(1);
  });
  it("parses the envelope strictly and demands a complete, duplicate-free list", () => {
    const env = parseListEnvelope({ count: 2, items: [{ id: 1, name: "A1 x" }, { id: 2, name: "B2 y" }] });
    expect(checkCompleteList(env).map(i => i.id)).toEqual([1, 2]);
    expect(() => checkCompleteList(parseListEnvelope({ count: 3, items: [{ id: 1, name: "a" }] }))).toThrow(/1 items for a count of 3/);
    expect(() => checkCompleteList(parseListEnvelope({ count: 2, items: [{ id: 1, name: "a" }, { id: 1, name: "a" }] }))).toThrow(/twice/);
    expect(() => parseListEnvelope({ items: [] })).toThrow(/count/);
    expect(() => parseListEnvelope("<html>")).toThrow();
  });
});

describe("per-variant product codes", () => {
  it("single variant: first word of the product name", () => {
    expect(parseProductDetail(detail(), 101).variants[0].code).toBe("R1155");
    expect(firstWord("　n4020 Necklace")).toBe("N4020");
  });
  it("multi-variant: each variant's own code (E1053 / E2057 under one listing)", () => {
    const d = parseProductDetail(detail({
      name: "E1053 Earrings K18",
      variants: [
        { id: 1, name: "E1053 2.0g", price: 74980, available: 0 },
        { id: 2, name: "E2057 1.90g", price: 81980, available: 1 },
      ],
    }), 101);
    expect(d.variants.map(v => [v.code, v.available, v.price_jpy])).toEqual([["E1053", 0, 74980], ["E2057", 1, 81980]]);
  });
  it("multi-variant listing whose product name has no code uses the variant names", () => {
    const d = parseProductDetail(detail({
      name: "Necklace K18 SSP White Pearl 45cm Pinslide",
      variants: [
        { id: 1, name: "N1445 14.0mm", price: 39980, available: 0 },
        { id: 2, name: "N1345 13.0mm", price: 39980, available: 0 },
        { id: 3, name: null, price: 39980, available: 0 },
      ],
    }), 101);
    expect(d.variants.map(v => v.code)).toEqual(["N1445", "N1345", null]);
    expect(variantCode("Necklace x", null, 1)).toBe("NECKLACE"); // single-variant: product name, matched exactly or not at all
  });
});

describe("detail parse is strict and never keeps reviews", () => {
  it("returns whitelisted fields only", () => {
    const d = parseProductDetail(detail(), 101);
    expect(Object.keys(d).sort()).toEqual(["full_price_jpy", "name", "photos", "price_jpy", "variants"]);
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/Jane Buyer|Lovely ring|review|long text/);
  });
  it("a missing or non-integer available is an error, never 0", () => {
    expect(() => parseProductDetail(detail({ variants: [{ id: 1, name: null, price: 1 }] }), 101)).toThrow(/available/);
    expect(() => parseProductDetail(detail({ variants: [{ id: 1, name: null, price: 1, available: "1" }] }), 101)).toThrow(/available/);
    expect(() => parseProductDetail(detail({ variants: [{ id: 1, name: null, price: 1, available: -1 }] }), 101)).toThrow(/available/);
    expect(() => parseProductDetail(detail({ variants: [] }), 101)).toThrow(/no variants/);
    expect(() => parseProductDetail(detail({ id: 999 }), 101)).toThrow(/asked for 101/);
  });
  it("accepts the {product:{...}} envelope too", () => {
    expect(parseProductDetail({ product: detail() }, 101).name).toMatch(/^R1155/);
  });
});

describe("photos", () => {
  it("orders by position, then list order (tied positions: R0458 [0,2,3,3], R7430 [0,0,1,3])", () => {
    expect(orderPhotos([photo(1, 0), photo(2, 2), photo(3, 3), photo(4, 3)]).map(p => p.id)).toEqual([1, 2, 3, 4]);
    expect(orderPhotos([photo(10, 3), photo(11, 0), photo(12, 0), photo(13, 1)]).map(p => p.id)).toEqual([11, 12, 13, 10]);
  });
  it("drops a repeated photo id and refuses non-Page365 hosts", () => {
    expect(orderPhotos([photo(1, 0), photo(1, 1)]).length).toBe(1);
    expect(() => orderPhotos([{ id: 1, position: 0, normal: "https://evil.example/1.jpeg" }])).toThrow(/usable/);
    expect(isPhotoUrl("http://assets.page365.net/a.jpg")).toBe(false);
    expect(isPhotoUrl("https://assets.page365.net/a.jpg")).toBe(true);
  });
  it("versions and storage paths are deterministic, so a re-fetch copies no duplicate", () => {
    const p = orderPhotos([photo(77, 0, "1789114828")])[0];
    expect(p.version).toBe("1789114828");
    expect(photoVersion("https://assets.page365.net/x.jpeg")).toBe("0");
    expect(photoStoragePath(101, p)).toBe("website/page365/101/77-1789114828.jpeg");
    expect(photoStoragePath(101, p)).toBe(photoStoragePath(101, { ...p }));
    expect(photoStoragePath(101, { ...p, version: "999" })).not.toBe(photoStoragePath(101, p));
    expect(photoStoragePath(101, p, "image/png")).toBe("website/page365/101/77-1789114828.png");
  });
});

describe("politeness: <= 4 requests per second", () => {
  it("spaces request starts 250 ms apart", async () => {
    let clock = 0;
    const starts: number[] = [];
    const limit = createRateLimiter(4, 4, () => clock, async ms => { clock += ms; });
    await Promise.all(Array.from({ length: 9 }, () => limit(async () => { starts.push(clock); })));
    for (let i = 4; i < starts.length; i++) expect(starts[i] - starts[i - 4]).toBeGreaterThanOrEqual(1000);
    expect(starts[8]).toBe(2000);
  });
});

const item = (over: Partial<InventoryItem>): InventoryItem => ({
  id: "x", run_id: "r", kind: "page365", page365_product_id: 1, page365_variant_id: 1, page365_name: "n", variant_name: null,
  code: "C", page365_price_jpy: 1, page365_full_price_jpy: null, page365_available: 0, match_result: "matched",
  website_product_id: "w", variant_id: "v", hub_sku: "C", hub_price_jpy: 1, seen_stock: 1, web_holds: 0, invoice_holds: 0,
  proposed_stock: 0, category: "decrease", price_differs: false, photos_total: 0, photos_to_copy: 0, photos_removed: 0,
  missing_runs: null, status: "review", result_note: null, ...over,
});

describe("review selection", () => {
  const rows = [
    item({ id: "dec", code: "N4020", category: "decrease", photos_to_copy: 3, photos_total: 3 }),
    item({ id: "inc", code: "R7828", category: "increase", seen_stock: 0, proposed_stock: 1 }),
    item({ id: "held", code: "ZI9104", category: "excluded", invoice_holds: 1 }),
    item({ id: "dup", code: "E1", category: "flagged", match_result: "duplicate_in_page365" }),
    item({ id: "new", code: "Z9", category: "new", match_result: "unmatched" }),
    item({ id: "price", code: "P1", category: "no_change", price_differs: true }),
    item({ id: "hub", kind: "hub_only", code: null, hub_sku: "H1", category: "hub_only", match_result: "hub_only" }),
  ];
  it("groups every population", () => {
    const g = groupItems(rows);
    expect(g.decreases.map(i => i.id)).toEqual(["dec"]);
    expect(g.increases.map(i => i.id)).toEqual(["inc"]);
    expect(g.excluded.map(i => i.id)).toEqual(["held"]);
    expect(g.flagged.map(i => i.id).sort()).toEqual(["dup", "hub"]);
    expect(g.newInPage365.map(i => i.id)).toEqual(["new"]);
    expect(g.priceDiffs.map(i => i.id)).toEqual(["price"]);
    expect(g.photos.map(i => i.id)).toEqual(["dec"]);
    expect(g.noChange).toBe(1);
  });
  it("decreases and (PR 3c) increases are pre-ticked", () => {
    const d = defaultSelection(rows);
    expect([...d.stock]).toEqual(["dec", "inc"]);
    expect([...d.photos]).toEqual(["dec"]);
  });
  it("an increase is sent only as an increase; excluded and flagged are never sent", () => {
    const s = splitStockSelection(rows, new Set(["dec", "inc", "held", "dup", "new"]));
    expect(s).toEqual({ decreaseIds: ["dec"], increaseIds: ["inc"] });
    expect(stockTickable(rows[2])).toBe(false);
    expect(stockTickable(item({ status: "applied" }))).toBe(false);
  });
});

describe("SQL rules are pinned", () => {
  it("target = max(0, Page365 available - website holds)", () => {
    expect(fn("page365_inventory_finish")).toContain("greatest(0, i.page365_available - coalesce(i.web_holds, 0))");
  });
  it("website holds = pending web cash + live unpaid web layaways", () => {
    const f = fn("page365_web_holds");
    expect(f).toContain("o.source_channel = 'web' AND o.status = 'pending'");
    expect(f).toContain("a.stock_released_at IS NULL");
    expect(f).toContain("coalesce(a.total_paid, 0) = 0");
  });
  it("apply is compare-and-set, per direction, and skips invoice holds", () => {
    const f = fn("page365_inventory_apply");
    expect(f).toContain("WHERE id = v_it.variant_id AND stock_qty = v_it.seen_stock");
    expect(f).toContain("'direction_mismatch'");
    expect(f).toContain("l.stock_state = 'held'");
    expect(f).toContain("IF v_run.status <> 'ready'");
    expect(f).toContain("has_permission(v_uid, 'manage_website_catalog')");
  });
  it("held #195 lines make a variant excluded", () => {
    expect(fn("page365_inventory_finish")).toContain("WHEN i.invoice_holds > 0                THEN 'excluded'");
  });
  it("a partial read never lists Hub-only products and a count drop is partial", () => {
    const f = fn("page365_inventory_finish");
    expect(f).toContain("IF v_errors = 0 THEN");
    expect(f).toContain("v_run.page365_count < v_prev_count * 0.8");
  });
  it("store_product keeps whitelisted keys only", () => {
    const f = fn("page365_inventory_store_product");
    expect(f).not.toMatch(/review/i);
    expect(f).toContain("'id', (ph->>'id')::bigint, 'version', ph->>'version', 'url', ph->>'url'");
  });
  it("photos are unique per variant + Page365 photo id", () => {
    expect(MIGRATION).toContain("ON public.website_product_media (variant_id, page365_photo_id) WHERE page365_photo_id IS NOT NULL");
  });
});

describe("edge functions", () => {
  const fetchFn = src("supabase/functions/page365-inventory-fetch/index.ts");
  const photosFn = src("supabase/functions/page365-inventory-photos/index.ts");
  it("the fetch writes only its own run tables — an outage changes nothing on the website", () => {
    const tables = [...fetchFn.matchAll(/\.from\("([a-z0-9_]+)"\)/g)].map(m => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(t).toMatch(/^page365_inventory_/);
    const code = fetchFn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/storage\.from|website_product_variants|page365_inventory_apply/);
  });
  it("both are behind manage_website_catalog", () => {
    expect(fetchFn).toContain('requirePermission(ctx, "manage_website_catalog")');
    expect(photosFn).toContain('requirePermission(ctx, "manage_website_catalog")');
  });
  it("photos never overwrite a stored file and only copy from a ready run", () => {
    expect(photosFn).toContain("upsert: false");
    expect(photosFn).toContain('run.status !== "ready"');
  });
});

// ── The review screen ───────────────────────────────────────────────────────
vi.mock("@/lib/page365-inventory-api", () => {
  const run = { id: "run1", status: "ready", page365_count: 572, products_total: 572, error: null,
    created_at: "2026-09-27T01:00:00Z", finished_at: "2026-09-27T01:03:00Z" };
  const rows = [
    { id: "a", code: "N4020", category: "decrease", page365_name: "N4020 Necklace Tiffany", page365_available: 0, seen_stock: 1, proposed_stock: 0 },
    { id: "b", code: "R7828", category: "increase", page365_name: "R7828 Ring", page365_available: 1, seen_stock: 0, proposed_stock: 1 },
    { id: "c", code: "ZI9104", category: "excluded", page365_name: "ZI9104 Ring", page365_available: 0, seen_stock: 1, proposed_stock: 0, invoice_holds: 1 },
  ];
  // .eq filters rows that carry the column (PR 3c: New in Page365 asks for
  // category 'new' of the full run; a run without a kind predates PR 3c).
  const q = (data: Record<string, unknown>[]) => {
    const filters: [string, unknown][] = [];
    const out = () => ({ data: data.filter(r => filters.every(([k, v]) => !(k in r) || r[k] === v)), error: null });
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "order"]) chain[m] = () => chain;
    chain.eq = (k: string, v: unknown) => { filters.push([k, v]); return chain; };
    chain.limit = async () => out();
    chain.range = async () => out();
    return chain;
  };
  return {
    runsTable: () => q([run]),
    itemsTable: () => q(rows.map(r => ({
      run_id: "run1", kind: "page365", match_result: "matched", status: "review", price_differs: false,
      photos_total: 0, photos_to_copy: 0, photos_removed: 0, web_holds: 0, invoice_holds: 0, ...r,
    }))),
    applyInventory: vi.fn(), startFetch: vi.fn(), continueFetch: vi.fn(), copyPhotos: vi.fn(),
  };
});

describe("Page365InventoryCard", () => {
  it("pre-ticks decreases and (PR 3c) increases, shows excluded rows without a box", async () => {
    const { Page365InventoryCard } = await import("@/components/website/Page365InventoryCard");
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Page365InventoryCard />
      </QueryClientProvider>,
    );
    const dec = await screen.findByRole("checkbox", { name: "Select N4020" });
    expect(dec.getAttribute("data-state")).toBe("checked");
    const inc = screen.getByRole("checkbox", { name: "Select R7828" });
    expect(inc.getAttribute("data-state")).toBe("checked");
    const excludedHeading = screen.getByText(/Excluded — Page365 invoice hold/);
    const section = excludedHeading.closest("section")!;
    expect(within(section).getByText("ZI9104")).toBeTruthy();
    expect(within(section).queryByRole("checkbox")).toBeNull();
    expect(screen.getByText(/1 decrease\(s\), 1 increase\(s\)/)).toBeTruthy();
  });
});
