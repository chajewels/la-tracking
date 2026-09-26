import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import {
  SKIP_REASON, autoApplyText, defaultSelection, groupItems, hiddenByPage365Note, hideTickable, hubOnlyReason,
  republishProductIds, type InventoryItem, type InventoryRun,
} from "@/lib/page365-inventory";

/**
 * Page365 hide-follow, PR 3b (2026-10-01): a synced product missing from 2
 * COMPLETE Page365 reads in a row — and seen on Page365 before — gets website
 * stock 0 and is unpublished; never re-published automatically.
 * The SQL behaviour (95 checks: not after 1 missing read, after 2; never a
 * never-seen or re-coded product; never a switched-off or unpublished one;
 * nothing from a partial read; automatic only with the switch on;
 * compare-and-set; one bell per run; back in Page365 flagged, never
 * re-published) runs against a real Postgres in
 * docs/sql/20261001_page365_hide_follow_local_tests.sql. This file pins what
 * TypeScript owns and the SQL's load-bearing clauses.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const PR3B = src("supabase/migrations/20261001100000_page365_hide_follow.sql");
const PR3 = src("supabase/migrations/20260930100000_page365_inventory_schedule.sql");
const PR2 = src("supabase/migrations/20260928100000_page365_inventory_pr2.sql");
const PR4 = src("supabase/migrations/20260929100000_page365_inventory_drafts.sql");
/** SQL with -- comments removed, so a pin cannot be satisfied by prose. */
const code = (sql: string) => sql.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
const body = (sql: string, name: string) => {
  const all = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`, "g"))];
  expect(all.length, `${name} is defined`).toBeGreaterThan(0);
  return all[all.length - 1][1];
};
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

const item = (over: Partial<InventoryItem>): InventoryItem => ({
  id: "x", run_id: "run1", kind: "page365", page365_product_id: 1, page365_variant_id: 10, page365_name: "X Ring",
  variant_name: null, code: "X", page365_price_jpy: 10000, page365_full_price_jpy: null, page365_available: 1,
  match_result: "matched", website_product_id: "p-x", variant_id: "v-x", hub_sku: "X", hub_price_jpy: 10000,
  seen_stock: 1, web_holds: 0, invoice_holds: 0, proposed_stock: 1, category: "no_change", price_differs: false,
  photos_total: 0, photos_to_copy: 0, photos_removed: 0, missing_runs: null, status: "review", result_note: null,
  back_in_page365: false, ...over,
});
const hub = (over: Partial<InventoryItem>) => item({
  kind: "hub_only", page365_product_id: null, page365_variant_id: null, page365_name: null, code: null,
  match_result: "hub_only", variant_id: null, category: "hub_only", ...over,
});

describe("review-screen logic (PR 3b)", () => {
  const rows = [
    hub({ id: "h1", hub_sku: "ZH1", website_product_id: "p1", category: "hide", missing_runs: 2, seen_stock: 1, proposed_stock: 0 }),
    hub({ id: "h2", hub_sku: "ZH2", website_product_id: "p2", category: "hide", missing_runs: 3, status: "applied", result_note: "auto_hidden" }),
    hub({ id: "h3", hub_sku: "ZH3", website_product_id: "p3", category: "hub_only", missing_runs: 5 }),
    item({ id: "b1", code: "ZB1", website_product_id: "pb", category: "increase", seen_stock: 0, proposed_stock: 1, back_in_page365: true }),
    item({ id: "d1", code: "ZD1", category: "decrease", seen_stock: 2, proposed_stock: 1 }),
  ];

  it("hide rows get their own group; a product back in Page365 keeps its stock row too", () => {
    const g = groupItems(rows);
    expect(g.hides.map(i => i.id)).toEqual(["h1", "h2"]);
    expect(g.backIn.map(i => i.id)).toEqual(["b1"]);
    expect(g.increases.map(i => i.id)).toEqual(["b1"]);
    expect(g.flagged.map(i => i.id)).toEqual(["h3"]);
  });

  it("hides start ticked (only while under review); re-publish is never in the default selection", () => {
    const d = defaultSelection(rows);
    expect([...d.hides]).toEqual(["h1"]);
    expect(d.stock.has("d1")).toBe(true);
    // PR 3c: the increase of a product back in Page365 starts ticked too;
    // re-publishing it never does.
    expect(d.stock.has("b1")).toBe(true);
    expect(hideTickable(rows[0])).toBe(true);
    expect(hideTickable(rows[1])).toBe(false);
    expect(hideTickable(rows[2])).toBe(false);
  });

  it("re-publish sends product ids, once each, and only for ticked back-in rows", () => {
    const twice = [...rows, item({ id: "b2", code: "ZB1b", website_product_id: "pb", back_in_page365: true })];
    expect(republishProductIds(twice, new Set(["b1", "b2", "d1"]))).toEqual(["pb"]);
    expect(republishProductIds(twice, new Set())).toEqual([]);
  });

  it("explains a Hub-only row that is not hidden", () => {
    expect(hubOnlyReason({ missing_runs: 1 })).toMatch(/Hidden after 2 complete fetches in a row if it was on Page365 before/);
    expect(hubOnlyReason({ missing_runs: 4 })).toMatch(/Not hidden: never seen on Page365 under this code, or not published/);
  });

  it("says how many were hidden on a scheduled run", () => {
    const run = (over: Partial<InventoryRun>) =>
      ({ source: "schedule", status: "ready", auto_apply_state: "applied", auto_applied: 0, ...over }) as InventoryRun;
    expect(autoApplyText(run({ hidden_count: 2 }))).toBe("No stock changes to apply · 2 products hidden on the website");
    expect(autoApplyText(run({ auto_applied: 1, hidden_count: 1 }))).toBe("1 decrease applied automatically · 1 product hidden on the website");
    expect(autoApplyText(run({ hidden_count: 0 }))).toBe("No stock changes to apply");
    expect(SKIP_REASON.auto_hidden).toMatch(/automatically/);
    expect(SKIP_REASON.never_seen).toBeTruthy();
  });

  it("Catalog note: only on a draft the Hub hid, dated in PHT", () => {
    // 2026-10-01 20:30 UTC is already 2 October in Manila.
    expect(hiddenByPage365Note("draft", "2026-10-01T20:30:00Z")).toBe("Hidden — no longer on Page365 (2026-10-02)");
    expect(hiddenByPage365Note("active", "2026-10-01T20:30:00Z")).toBeNull();
    expect(hiddenByPage365Note("draft", null)).toBeNull();
  });
});

describe("migration 20261001100000 — load-bearing clauses", () => {
  const C = code(PR3B);
  const pinRows = (sig: string) =>
    [...C.matchAll(new RegExp(`\\('${sig.replace(/[()[\]]/g, "\\$&")}',\\s*'([0-9a-f]{32})'`, "g"))].map(m => m[1]);

  it("pins the live bodies it relies on (Bug #280) and redefines none of them", () => {
    const pins: [string, string, string][] = [
      ["page365_inventory_finish", "page365_inventory_finish(uuid)", PR2],
      ["page365_inventory_apply", "page365_inventory_apply(uuid,uuid[],uuid[])", PR2],
      ["page365_inventory_retention", "page365_inventory_retention(integer)", PR3],
      ["website_publish_products", "website_publish_products(uuid[])", PR4],
    ];
    for (const [name, sig, file] of pins) {
      const rows = pinRows(sig);
      expect(rows.length, `${name} pinned before and after`).toBe(2);
      for (const r of rows) expect(r, name).toBe(md5(body(file, name)));
      expect(C).not.toMatch(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(`));
    }
  });

  it("replaces auto_apply_run from the PR 3 body, and pins the new body", () => {
    const rows = pinRows("page365_inventory_auto_apply_run(uuid)");
    expect(rows[0]).toBe(md5(body(PR3, "page365_inventory_auto_apply_run")));
    expect(rows[1]).toBe(md5(body(PR3B, "page365_inventory_auto_apply_run")));
    // Every PR 3 decrease clause survives unchanged.
    const f = code(body(PR3B, "page365_inventory_auto_apply_run"));
    for (const clause of [
      "WHERE s.key = 'page365_inventory_auto_apply'), 'false') = 'true'",
      "AND i.category = 'decrease' AND i.status = 'review'",
      "WHERE id = v_it.variant_id AND stock_qty = v_it.seen_stock AND stock_qty > v_it.proposed_stock",
      "now() > v_run.created_at + interval '30 minutes'",
      "IF v_run.auto_apply_at IS NOT NULL THEN",
    ]) expect(f).toContain(clause);
    expect(f).not.toMatch(/category\s*(=|IN)\s*\(?'increase'/);
  });

  it("automatic hides only inside the 'applied' gate (switch on, ready, in window, not superseded)", () => {
    const f = code(body(PR3B, "page365_inventory_auto_apply_run"));
    const gate = f.indexOf("IF v_state = 'applied' THEN");
    const hides = f.indexOf("page365_inventory_hide_item(v_hid_id, p_run_id, NULL, 'schedule')");
    const gateEnd = f.indexOf("END IF;\n\n", hides);
    expect(gate).toBeGreaterThan(0);
    expect(hides).toBeGreaterThan(gate);
    expect(gateEnd).toBeGreaterThan(hides);
    // At most one bell per run: still one INSERT per branch, one branch taken.
    expect([...f.matchAll(/INSERT INTO public\.staff_notifications/g)].length).toBe(3);
    expect(f).toMatch(/WHEN v_hidden > 0\s+THEN 'page365_inventory_hidden'/);
  });

  it("the proposal: 2 complete reads in a row, seen on the same code, published, not switched off", () => {
    const f = code(body(PR3B, "page365_inventory_follow"));
    expect(f).toContain("IF NOT FOUND OR v_run.status <> 'ready' THEN");
    expect(f).toContain("AND coalesce(i.missing_runs, 0) >= 2");
    expect(f).toContain("AND pr.code = public.page365_first_word(wp.sku)");
    expect(f).toContain("AND wp.status::text = 'active' AND NOT coalesce(wp.page365_sync_disabled, false)");
    expect(f).toContain("i.kind = 'hub_only' AND i.category = 'hub_only'");
    // It proposes; it never writes stock or product status.
    expect(f).not.toMatch(/UPDATE public\.website_product/);
    expect(C).toMatch(/AFTER UPDATE OF status ON public\.page365_inventory_runs\s+FOR EACH ROW WHEN \(OLD\.status = 'fetching' AND NEW\.status = 'ready'\)/);
  });

  it("the hide writer: live switch, seen check, compare-and-set, stock 0 + draft, audited", () => {
    const f = code(body(PR3B, "page365_inventory_hide_item"));
    expect(f).toContain("WHEN coalesce(v_p.page365_sync_disabled, false)               THEN 'sync_disabled'");
    expect(f).toContain("OR v_pr.code IS DISTINCT FROM public.page365_first_word(v_p.sku) THEN 'never_seen'");
    expect(f).toContain("IF v_p.status::text <> 'active' OR v_snap IS DISTINCT FROM v_it.hide_snapshot THEN");
    expect(f).toContain("SET stock_qty = 0, updated_at = now()");
    expect(f).toContain("UPDATE public.website_products SET status = 'draft' WHERE id = v_p.id;");
    expect(f).toContain("'page365_inventory_hidden'");
  });

  it("never re-publishes, never touches orders", () => {
    expect(C).not.toMatch(/status\s*=\s*'active'\s*(WHERE|,)/);
    expect(C).not.toMatch(/public\.website_publish_products\(/); // pinned, never called
    expect(C).not.toMatch(/cash_orders|layaway_accounts|payment_submissions|checkout_quotes/);
  });

  it("grants: only page365_inventory_hide reaches the browser, behind manage_website_catalog", () => {
    for (const fn of ["page365_inventory_follow(uuid)", "page365_inventory_hide_item(uuid, uuid, uuid, text)"]) {
      expect(C).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated;`);
      expect(C).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role;`);
    }
    expect(C).toContain("REVOKE ALL ON FUNCTION public.page365_inventory_hide(uuid, uuid[]) FROM PUBLIC, anon;");
    expect(code(body(PR3B, "page365_inventory_hide"))).toContain("public.has_permission(v_uid, 'manage_website_catalog')");
  });
});

// ── The review screen ───────────────────────────────────────────────────────
const hideOnWebsite = vi.fn(async (_run: string, ids: string[]) => ({ ok: true, hidden: ids.length, changed_since_fetch: 0, skipped: 0, failed: 0 }));
const applyInventory = vi.fn(async () => ({ ok: true, applied: 1 }));
const publishProducts = vi.fn(async (ids: string[]) => ({ ok: true, published: ids.length, blocked: 0, skipped: 0 }));
vi.mock("@/lib/page365-drafts-api", () => ({
  publishProducts: (ids: string[]) => publishProducts(ids),
  listLandings: vi.fn(async () => []),
}));
vi.mock("@/lib/page365-inventory-api", () => {
  const run = { id: "run1", source: "manual", status: "ready", page365_count: 572, products_total: 572, error: null,
    created_at: "2026-10-01T01:00:00Z", finished_at: "2026-10-01T01:03:00Z" };
  const rows = [
    { id: "h1", kind: "hub_only", code: null, hub_sku: "ZH1", website_product_id: "p1", category: "hide", match_result: "hub_only",
      missing_runs: 2, seen_stock: 1, proposed_stock: 0 },
    { id: "b1", code: "ZB1", website_product_id: "pb", category: "increase", page365_name: "ZB1 Ring", page365_available: 1,
      seen_stock: 0, proposed_stock: 1, back_in_page365: true },
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
    applyInventory: (...a: unknown[]) => applyInventory(...(a as [])),
    hideOnWebsite: (run: string, ids: string[]) => hideOnWebsite(run, ids),
    startFetch: vi.fn(), continueFetch: vi.fn(), copyPhotos: vi.fn(),
  };
});

describe("Page365InventoryCard — Hide on website / Back in Page365", () => {
  it("pre-ticks the hide, leaves re-publish unticked, and applies only what is ticked", async () => {
    const { Page365InventoryCard } = await import("@/components/website/Page365InventoryCard");
    render(
      <MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Page365InventoryCard />
      </QueryClientProvider></MemoryRouter>,
    );
    const hideRow = await screen.findByTestId("p365-inv-hide-row");
    expect(within(hideRow).getByText("ZH1")).toBeTruthy();
    expect(within(hideRow).getByRole("checkbox").getAttribute("data-state")).toBe("checked");
    const backRow = screen.getByTestId("p365-inv-back-row");
    const back = within(backRow).getByRole("checkbox");
    expect(back.getAttribute("data-state")).toBe("unchecked");
    expect(screen.getByText(/Back in Page365 — re-publish\?/)).toBeTruthy();

    // Apply as it stands: the hide only — nothing re-published.
    fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(hideOnWebsite).toHaveBeenCalledWith("run1", ["h1"]));
    expect(publishProducts).not.toHaveBeenCalled();
    expect(await screen.findByText(/Hidden on the website:/)).toBeTruthy();
  });

  it("re-publishes only after a staff tick, as the product id", async () => {
    const { Page365InventoryCard } = await import("@/components/website/Page365InventoryCard");
    render(
      <MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Page365InventoryCard />
      </QueryClientProvider></MemoryRouter>,
    );
    const backRow = await screen.findByTestId("p365-inv-back-row");
    fireEvent.click(within(backRow).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Apply selected" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await vi.waitFor(() => expect(publishProducts).toHaveBeenCalledWith(["pb"]));
  });
});
