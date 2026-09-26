import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  findListing, mainGalleryPhoto, readCatalogueList, type GetJson,
} from "../../supabase/functions/_shared/page365-inventory.ts";
import { previewPage365Stock, stockModeFrom as edgeStockModeFrom } from "../../supabase/functions/_shared/page365-stock.ts";
import {
  flaggedTitle, importSummary, ledgerChip, previewChip, stockModeFrom,
} from "@/lib/page365-stock";
import {
  defaultSelection, groupItems, SKIP_REASON, stockTickable, type InventoryItem,
} from "@/lib/page365-inventory";

/**
 * Page365 inventory PR 2 (2026-09-28): Page365 is the stock master.
 *   A. the "Don't sync with Page365" switch;
 *   B. a Page365 invoice import records its lines and never moves stock; held
 *      #195 lines become 'absorbed' and give nothing back;
 *   C. the fetch no longer excludes invoice holds (outside 'invoice' mode);
 *   D. unpaid imported invoices are held off the website until confirmed;
 *   F1/F2. the invoice fetch reads the cumulative catalogue list in two
 *      requests and matches codes by first word.
 * The SQL behaviour runs against a real Postgres in
 * docs/sql/20260928_page365_inventory_pr2_local_tests.sql (66 checks); this
 * file pins what TypeScript owns and the SQL's load-bearing clauses.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const PR2 = src("supabase/migrations/20260928100000_page365_inventory_pr2.sql");
const P195 = src("supabase/migrations/20260926120000_page365_stock_sync.sql");
const PR1 = src("supabase/migrations/20260927100000_page365_inventory_fetch.sql");

/** The stored body of a function as Postgres keeps it (prosrc): the text
 *  between the $fn$ delimiters, verbatim. */
const body = (sql: string, name: string) => {
  const m = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`));
  expect(m, `${name} is defined`).not.toBeNull();
  return m![1];
};
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

describe("function changes start from live (Bug #280)", () => {
  const cases = [
    ["page365_apply_stock", P195],
    ["page365_inventory_finish", PR1],
    ["page365_inventory_apply", PR1],
    ["page365_inventory_record_photo", PR1],
  ] as const;
  for (const [name, before] of cases) {
    it(`${name}: the guard's "before" md5 is the body #195/PR 1 wrote, and "after" is this file's body`, () => {
      const guard = PR2.match(new RegExp(`\\('${name}',\\s+'[^']*',\\s+'([0-9a-f]{32})', '([0-9a-f]{32})'\\)`));
      expect(guard, `${name} guard row`).not.toBeNull();
      expect(guard![1]).toBe(md5(body(before, name)));
      expect(guard![2]).toBe(md5(body(PR2, name)));
      // The proof block asserts the same "after" value.
      expect(PR2).toMatch(new RegExp(`\\('${name}',\\s+'${guard![2]}'\\)`));
    });
  }
  it("the #195 follow trigger is asserted UNCHANGED — absorbed lines rely on its body", () => {
    const followMd5 = md5(body(P195, "page365_stock_follow_order"));
    expect(PR2).toContain(`'dfd6d211808c5e6a7758b3d0fd7dafd9', 'dfd6d211808c5e6a7758b3d0fd7dafd9'`);
    expect(followMd5).toBe("dfd6d211808c5e6a7758b3d0fd7dafd9");
    expect(PR2).not.toMatch(/CREATE OR REPLACE FUNCTION public\.page365_stock_follow_order/);
  });
});

describe("B. invoice import is record-only; absorbed lines never restore", () => {
  const apply = body(PR2, "page365_apply_stock");
  it("the record-only branch returns BEFORE the #195 decrement", () => {
    const recordOnly = apply.indexOf("IF v_mode = 'inventory_sync' OR coalesce(v_sync_off, false) THEN");
    const decrement = apply.indexOf("SET stock_qty = wv.stock_qty - v_qty");
    expect(recordOnly).toBeGreaterThan(-1);
    expect(decrement).toBeGreaterThan(recordOnly);
    const cont = apply.indexOf("CONTINUE;", recordOnly);
    expect(cont).toBeGreaterThan(recordOnly);
    expect(cont).toBeLessThan(decrement);
    const branch = apply.slice(recordOnly, cont);
    expect(branch).not.toMatch(/website_product_variants/);
  });
  it("only an explicit 'invoice' brings the decrement back", () => {
    expect(apply).toMatch(/= 'invoice'\s+THEN 'invoice' ELSE 'inventory_sync' END/);
    expect(stockModeFrom("invoice")).toBe("invoice");
    for (const v of [undefined, null, "inventory_sync", "INVOICE", ""]) expect(stockModeFrom(v)).toBe("inventory_sync");
    expect(edgeStockModeFrom("invoice")).toBe("invoice");
    expect(edgeStockModeFrom(undefined)).toBe("inventory_sync");
  });
  it("flags are still raised for lines that match nothing", () => {
    expect(apply).toContain("flag = v_m.o_match_result");
  });
  it("the cut-over turns held into absorbed, audited, only in inventory_sync", () => {
    expect(PR2).toMatch(/SET stock_state = 'absorbed', updated_at = now\(\)\s+WHERE l\.stock_state = 'held'/);
    expect(PR2).toContain("'page365_stock_absorbed'");
    expect(PR2).toMatch(/IS DISTINCT FROM 'inventory_sync' THEN\s+RAISE NOTICE[^;]+;\s+RETURN;/);
  });
  it("the follow trigger only ever releases 'held' and re-takes 'released' — so absorbed / page365_master return nothing", () => {
    const follow = body(P195, "page365_stock_follow_order");
    expect(follow).toContain("WHERE l.page365_no = v_no AND l.stock_state = 'held'");
    expect(follow).toContain("WHERE l.page365_no = v_no AND l.stock_state = 'released'");
    expect(follow).not.toMatch(/absorbed|page365_master/);
  });
  it("the ledger CHECK accepts the two new states", () => {
    expect(PR2).toContain("CHECK (stock_state IN ('none','held','released','page365_master','absorbed'))");
  });
});

describe("A. the switch is enforced on the server", () => {
  it("apply refuses a switched-off product, reading the switch live (flipped after the fetch)", () => {
    const a = body(PR2, "page365_inventory_apply");
    expect(a).toMatch(/WHEN v_it\.category = 'not_synced'\s+OR EXISTS \(SELECT 1 FROM public\.website_product_variants wv\s+JOIN public\.website_products wp ON wp\.id = wv\.product_id\s+WHERE wv\.id = v_it\.variant_id AND wp\.page365_sync_disabled\) THEN 'sync_disabled'/);
    // …and before the stock write.
    expect(a.indexOf("'sync_disabled'")).toBeLessThan(a.indexOf("SET stock_qty = v_it.proposed_stock"));
  });
  it("photos are refused too", () => {
    const r = body(PR2, "page365_inventory_record_photo");
    expect(r.indexOf("RETURN 'sync_disabled'")).toBeGreaterThan(-1);
    expect(r.indexOf("RETURN 'sync_disabled'")).toBeLessThan(r.indexOf("INSERT INTO public.website_product_media"));
  });
  it("finish never proposes a switched-off product and gives it no photos", () => {
    const f = body(PR2, "page365_inventory_finish");
    expect(f).toContain("category = CASE WHEN v_off THEN 'not_synced'");
    expect(f.match(/AND i\.category <> 'not_synced'/g)?.length).toBe(3); // proposal, direction, photos
    expect(f).toContain("CASE WHEN wp.page365_sync_disabled THEN 'not_synced' ELSE 'hub_only' END");
  });
  it("an invoice import never moves a switched-off product's stock, in either mode", () => {
    expect(body(PR2, "page365_apply_stock")).toContain("stock_state = CASE WHEN coalesce(v_sync_off, false) THEN 'none' ELSE 'page365_master' END");
  });
  it("only manage_website_catalog may flip it; each flip is audited; default off; nothing switched on here", () => {
    expect(PR2).toContain("ADD COLUMN IF NOT EXISTS page365_sync_disabled boolean NOT NULL DEFAULT false");
    const guard = body(PR2, "page365_sync_switch_guard");
    expect(guard).toContain("NOT public.has_permission(v_uid, 'manage_website_catalog')");
    expect(guard).toContain("'page365_sync_switched'");
    expect(PR2).not.toMatch(/UPDATE public\.website_products\s+SET page365_sync_disabled/);
    expect(PR2).not.toMatch(/sku\s*(=|IN)\s*\(?'N4020'/);
  });
  it("the photo copier skips a switched-off product before any download", () => {
    // 2026-09-26: the copy lives in the shared copier (staff photos + landed backlog).
    const s = src("supabase/functions/_shared/page365-photo-copy.ts");
    expect(s).toContain('.select("id, page365_sync_disabled").in("id", productIds)');
    expect(s).toContain("if (!it.variant_id || notSynced(it)) continue;");
  });
});

describe("C/D. the fetch in inventory_sync", () => {
  const f = body(PR2, "page365_inventory_finish");
  it("excludes #195 invoice holds only in 'invoice' mode", () => {
    expect(f).toContain("WHEN v_mode = 'invoice' AND i.invoice_holds > 0 THEN 'excluded'");
    expect(body(PR2, "page365_inventory_apply")).toContain("WHEN v_mode = 'invoice' AND EXISTS (SELECT 1 FROM public.page365_stock_lines l");
  });
  it("subtracts unpaid imported invoices while page365_hold_unpaid_invoices is not false", () => {
    expect(f).toContain("- CASE WHEN v_mode = 'inventory_sync' AND v_hold_unpaid");
    expect(f).toMatch(/'page365_hold_unpaid_invoices'\), 'true'\) <> 'false'/);
    const holds = PR2.slice(PR2.indexOf("FUNCTION public.page365_invoice_holds"), PR2.indexOf("REVOKE ALL ON FUNCTION public.page365_invoice_holds"));
    expect(holds).toContain("l.stock_state IN ('page365_master', 'absorbed')");
    expect(holds).toContain("o.status = 'pending'");
    expect(holds).toContain("a.status IN ('active','overdue') AND coalesce(a.total_paid, 0) = 0");
  });
  it("settings are seeded only when absent (a re-run never undoes the owner)", () => {
    expect(PR2.match(/ON CONFLICT \(key\) DO NOTHING/g)?.length).toBe(2);
  });
});

describe("review screen — not synced", () => {
  const it0 = (over: Partial<InventoryItem>): InventoryItem => ({
    id: "x", run_id: "r", kind: "page365", page365_product_id: 1, page365_variant_id: 10, page365_name: "N4020 Necklace",
    variant_name: null, code: "N4020", page365_price_jpy: 1, page365_full_price_jpy: null, page365_available: 0,
    match_result: "matched", website_product_id: "p", variant_id: "v", hub_sku: "N4020", hub_price_jpy: 2,
    seen_stock: 1, web_holds: 0, invoice_holds: 0, proposed_stock: null, category: "not_synced", price_differs: true,
    photos_total: 3, photos_to_copy: 3, photos_removed: 0, missing_runs: null, status: "review", result_note: null, ...over,
  });
  it("has its own group and is never ticked, never a price difference, never a photo copy", () => {
    const rows = [it0({}), it0({ id: "h", kind: "hub_only", page365_product_id: null, code: null })];
    const g = groupItems(rows);
    expect(g.notSynced.map(r => r.id)).toEqual(["x", "h"]);
    expect(g.priceDiffs).toHaveLength(0);
    expect(g.photos).toHaveLength(0);
    expect(g.flagged).toHaveLength(0);
    const d = defaultSelection(rows);
    expect(d.stock.size + d.photos.size).toBe(0);
    expect(stockTickable(rows[0])).toBe(false);
    expect(SKIP_REASON.sync_disabled).toMatch(/Don’t sync with Page365/);
  });
});

describe("import review chips (inventory_sync)", () => {
  const m = (over = {}) => ({ first_word: "R13R6", result: "matched", stock_qty: 1, ...over }) as Parameters<typeof previewChip>[0];
  it("a matched line says stock follows the inventory fetch, never 'will take'", () => {
    const c = previewChip(m(), 1, "product", "inventory_sync");
    expect(c.tone).toBe("record");
    expect(c.label).toMatch(/stock follows the Page365 inventory fetch/);
    expect(previewChip(m(), 1, "product").tone).toBe("record"); // default = the live mode
  });
  it("a switched-off product says so, in either mode", () => {
    for (const mode of ["inventory_sync", "invoice"] as const) {
      expect(previewChip(m({ sync_disabled: true }), 1, "product", mode).label).toMatch(/Not synced with Page365/);
    }
  });
  it("ledger chips for the new states; toasts", () => {
    const l = { match_result: "matched", flag: null, resolved_at: null };
    expect(ledgerChip({ ...l, stock_state: "page365_master" }).label).toBe("Matched — stock follows Page365");
    expect(ledgerChip({ ...l, stock_state: "absorbed" }).label).toBe("Stock taken — now in Page365’s count");
    expect(importSummary({ held: 0, recorded: 2, sync_off: 1, flagged: 1, mode: "inventory_sync" }))
      .toBe("2 lines matched — stock follows the Page365 inventory fetch · 1 line not synced with Page365 · 1 flagged for staff");
    expect(flaggedTitle("inventory_sync")).toBe("Some lines did not match one website product");
    expect(flaggedTitle("invoice")).toBe("Some lines did not reduce website stock");
  });
  it("preview carries the variant and the switch (read in one query)", async () => {
    const calls: string[] = [];
    const sb = {
      rpc: async () => ({ data: [{ o_first_word: "R13R6", o_match_result: "matched", o_stock_qty: 1, o_product_id: "p1", o_variant_id: "v1" }], error: null }),
      from: (t: string) => ({ select: () => ({ in: async () => { calls.push(t); return { data: [{ id: "p1", page365_sync_disabled: true }], error: null }; } }) }),
    };
    const out = await previewPage365Stock(sb, [{ kind: "product", name: "R13R6 Ring" }, { kind: "product", name: "R13R6 again" }]);
    expect(out[0]).toMatchObject({ variant_id: "v1", sync_disabled: true });
    expect(calls).toEqual(["website_products"]);
  });
});

describe("F1 — the invoice fetch reads the cumulative catalogue in two requests", () => {
  // Page365's list is "load more": page N holds the first 16*N and never runs out.
  const catalogue = Array.from({ length: 572 }, (_, i) => ({ id: 1000 + i, name: `C${i} Ring` }))
    .concat([]).map((x, i) => (i === 7 ? { id: 7, name: "R13R6 Ring K18" } : i === 8 ? { id: 8, name: "E8JS Earrings" } : i === 9 ? { id: 9, name: "12M17 Pendant" } : x));
  const fakeGet = () => {
    const urls: string[] = [];
    const get: GetJson = async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page"));
      return { ok: true, json: { items: catalogue.slice(0, Math.min(572, 16 * page)), count: 572 } };
    };
    return { urls, get };
  };
  it("page 1 for the count, then page ceil(572/16) = 36 — never a walk", async () => {
    const { urls, get } = fakeGet();
    const r = await readCatalogueList(get);
    expect(r.ok && r.items.length).toBe(572);
    expect(urls.map(u => new URL(u).searchParams.get("page"))).toEqual(["1", "36"]);
  });
  it("an incomplete list is an error, not a partial search", async () => {
    const r = await readCatalogueList(async () => ({ ok: true, json: { items: catalogue.slice(0, 16), count: 572 } }));
    expect(r.ok).toBe(false);
  });
  it("the old page walk is gone from page365-fetch-order", () => {
    const s = src("supabase/functions/page365-fetch-order/index.ts");
    expect(s).not.toMatch(/PHOTO_SCAN_MAX_PAGES|pageCache|catalogue ends at page/);
    expect(s).toContain("catalogue ??= readCatalogueList(getCatalogue);");
  });
});

describe("F2 — codes are the first word, exactly", () => {
  const items = [
    { id: 1, name: "R13R6 Ring K18" }, { id: 2, name: "E8JS Earrings" }, { id: 3, name: "12M17 Pendant" },
    { id: 4, name: "R13 Ring" }, { id: 5, name: "N70R3 a" }, { id: 6, name: "N70R3 b" },
  ];
  it("finds real codes the old regex missed", () => {
    expect(findListing(items, "R13R6")).toEqual({ id: 1 });
    expect(findListing(items, "e8js")).toEqual({ id: 2 });
    expect(findListing(items, "12M17")).toEqual({ id: 3 });
  });
  it("never a prefix match, never a guess between two", () => {
    expect(findListing(items, "R13")).toEqual({ id: 4 });
    expect(findListing(items, "R1")).toHaveProperty("why");
    expect(findListing(items, "N70R3")).toHaveProperty("why", expect.stringMatching(/2 webstore listings/));
  });
  it("page365-fetch-order uses the first-word rule, not the code-shaped regex", () => {
    const s = src("supabase/functions/page365-fetch-order/index.ts");
    expect(s).toContain("const naturalSku = (name: string): string | null => firstWord(name);");
    expect(s).not.toContain("[A-Z]{1,4}-?\\d{1,6}[A-Z]?");
  });
});

describe("photos — an invoice line keeps ONE main photo; no duplicate files or rows", () => {
  it("the main photo is the first in Page365's display order", () => {
    const photo = (id: number, position: number) => ({ id, position, normal: `https://assets.page365.net/photos/original/${id}.jpeg?1` });
    expect(mainGalleryPhoto({ photos: [photo(2, 1), photo(1, 0)] })).toBe("https://assets.page365.net/photos/original/1.jpeg?1");
    expect(mainGalleryPhoto({ product: { photos: [] } })).toBeNull();
  });
  it("a matched line reuses the catalogue's stored copy and uploads nothing", () => {
    const s = src("supabase/functions/page365-fetch-order/index.ts");
    expect(s).toContain('.not("page365_photo_id", "is", null).order("sort", { ascending: true })');
    expect(s).toContain("if (!src || items[n].photo_url) continue;");
    expect(s).toContain("if (items[n].photo_url || items[n].source_photo_url || items[n].kind !== \"product\") continue;");
  });
  it("saving a product in Catalog keeps each copied photo's Page365 identity (else the next fetch would copy it again)", () => {
    const s = src("src/components/website/ProductsCard.tsx");
    expect(s).toContain("website_product_media(id, url, alt, sort, page365_photo_id, page365_photo_version)");
    expect(s).toContain("page365_photo_id: m.page365_photo_id ?? null,");
  });
});

// ── The review card ────────────────────────────────────────────────────────
vi.mock("@/lib/page365-inventory-api", () => {
  const run = { id: "run1", status: "ready", page365_count: 572, products_total: 572, error: null,
    created_at: "2026-09-28T01:00:00Z", finished_at: "2026-09-28T01:03:00Z" };
  const rows = [
    { id: "a", code: "R7828", category: "decrease", page365_name: "R7828 Ring", page365_available: 0, seen_stock: 1, proposed_stock: 0, invoice_holds: 1 },
    { id: "b", code: "N4020", category: "not_synced", page365_name: "N4020 Necklace Tiffany", page365_available: 0, seen_stock: 1, proposed_stock: null, photos_to_copy: 0 },
  ];
  const q = (data: unknown) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "order", "eq"]) chain[m] = () => chain;
    chain.limit = async () => ({ data, error: null });
    chain.range = async () => ({ data, error: null });
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

describe("Page365InventoryCard — Not synced group", () => {
  it("lists the switched-off piece in its own group, without a tick box", async () => {
    const { Page365InventoryCard } = await import("@/components/website/Page365InventoryCard");
    render(
      <MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Page365InventoryCard />
      </QueryClientProvider></MemoryRouter>,
    );
    const heading = await screen.findByText("Not synced");
    const section = heading.closest("section")!;
    expect(within(section).getByText("N4020")).toBeTruthy();
    expect(within(section).queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "Select N4020" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Select R7828" }).getAttribute("data-state")).toBe("checked");
    expect(screen.getByText(/Importing a Page365\s+invoice no longer changes website stock/)).toBeTruthy();
  });
});
