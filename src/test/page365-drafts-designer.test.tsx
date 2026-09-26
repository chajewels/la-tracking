import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createOutcomeText, DRAFT_REASON, KIND_LABEL, reasonText, type NewRow } from "@/lib/page365-drafts";
import type { InventoryItem, InventoryRun } from "@/lib/page365-inventory";

/**
 * "Create drafts" for designer pieces (fix, 2026-09-26). Wallets and other
 * non-jewelry listings were drafted as jewelry and refused 'no_metal'; most
 * printed stamps (750WG, K18YG/WG, SV925) were never read; and a skipped or
 * failed row kept result_note NULL. The rules run against a real Postgres in
 * docs/sql/20261005_page365_drafts_designer_local_tests.sql; this file pins the
 * migration's load-bearing clauses and covers what TypeScript owns.
 */

const MIGRATION = readFileSync(
  resolve(__dirname, "../../supabase/migrations/20261005100000_page365_drafts_designer.sql"), "utf8");
const body = (name: string) => {
  const m = MIGRATION.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`));
  expect(m, `${name} is defined`).not.toBeNull();
  return m![1];
};
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const code = (s: string) => s.split("\n").filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");

describe("migration 20261005100000_page365_drafts_designer", () => {
  it("guards on the live bodies and self-checks the new ones", () => {
    expect(MIGRATION).toContain("('page365_inventory_create_drafts(uuid,uuid[])', '9ae1eb47496736b925db9625b1e2d373', '"
      + md5(body("page365_inventory_create_drafts")) + "')");
    expect(MIGRATION).toContain("('page365_metals_from_text(text)',               '3164641c287f98c715ef0785281f2b62', '"
      + md5(body("page365_metals_from_text")) + "')");
    expect(MIGRATION).toContain(`('page365_item_kind_for(text,text)',             '${md5(body("page365_item_kind_for"))}')`);
    expect(MIGRATION).not.toMatch(/@@|TODO|<[A-Z_]+>/);
    expect(code(MIGRATION).match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code(MIGRATION).match(/^COMMIT;$/gm)).toHaveLength(1);
  });
  it("the drafts body is the PR 3c body with only the three edits", () => {
    const prev = readFileSync(resolve(__dirname, "../../supabase/migrations/20261002100000_page365_quick_fetch.sql"), "utf8")
      .match(/CREATE OR REPLACE FUNCTION public\.page365_inventory_create_drafts\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$/)![1];
    const now = body("page365_inventory_create_drafts");
    expect(md5(prev)).toBe("9ae1eb47496736b925db9625b1e2d373");
    expect(now).toContain("v_kind  := public.page365_item_kind_for(v_name || ' ' || coalesce(v_it.page365_name, ''), v_prod.list_category);");
    expect(now).not.toContain("THEN 'watch' ELSE 'jewelry' END;");
    expect(now).toContain("'item_kind', v_kind,");
    // Every not-drafted review row keeps its reason; a drafted row is never overwritten.
    expect(now).toMatch(/SET result_note = x\.reason[\s\S]*jsonb_array_elements\(v_skipped \|\| v_failed\)[\s\S]*i\.status = 'review'\s+AND i\.result_note IS DISTINCT FROM 'draft_created';/);
    // Jewelry without a printed stamp is still refused (the CHECK is untouched).
    expect(now).toContain("IF cardinality(v_metals) = 0 AND v_kind = 'jewelry' THEN");
    expect(code(MIGRATION)).not.toMatch(/website_products_metals_jewelry\s+CHECK|DROP CONSTRAINT/);
  });
  it("item kind: watch wins, then non-jewelry words, whole words only", () => {
    const k = body("page365_item_kind_for");
    expect(k.indexOf("'\\mwatch(es)?\\M' THEN 'watch'")).toBeGreaterThan(-1);
    expect(k.indexOf("THEN 'watch'")).toBeLessThan(k.indexOf("THEN 'other'"));
    for (const w of ["wallets?", "bags?", "belts?", "(coin|key|pass)\\s+cases?", "card\\s+(holder|case)s?", "purses?"]) {
      expect(k).toContain(w);
    }
    expect(k).toContain("ELSE 'jewelry'");
  });
  it("stamps: a colour code after a stamp is read, SV925 is SILVER925, whole tokens only", () => {
    const m = body("page365_metals_from_text");
    expect(m).toContain("'^(K24|K18|750|18K|K14|K10|PT1000|PT950|PT900|PT850|PM900|PM|SILVER925)(WG|YG|PG|RG|CG|G)?$'");
    expect(m).toContain("WHEN upper(x.tok) = 'SV925' THEN 'SILVER925'");
  });
  it("helpers are never callable from the browser", () => {
    expect(MIGRATION).toContain("REVOKE ALL ON FUNCTION public.page365_item_kind_for(text, text) FROM PUBLIC, anon, authenticated;");
    expect(MIGRATION).toContain("GRANT EXECUTE ON FUNCTION public.page365_inventory_create_drafts(uuid, uuid[]) TO authenticated;");
  });
});

describe("outcome wording — never a bare \"0 drafts\"", () => {
  it("0 created with failures is a warning naming them", () => {
    const o = createOutcomeText({ ok: true, created: 0, skipped: 1, failed: 10 });
    expect(o.tone).toBe("warning");
    expect(o.text).toBe("0 draft(s) created · 1 skipped · 10 could not be created — each one is listed below with the reason.");
  });
  it("all created is a success", () => {
    const o = createOutcomeText({ ok: true, created: 3, skipped: 0, failed: 0 });
    expect(o).toEqual({ tone: "success", text: "3 draft(s) created. None is on the website until you publish it." });
  });
  it("reasons read as plain words", () => {
    expect(reasonText("no_metal")).toMatch(/^jewelry with no metal stamp printed on Page365/);
    expect(reasonText("not_fresh")).toBe(DRAFT_REASON.not_fresh);
    expect(reasonText("some database error")).toBe("some database error");
    expect(KIND_LABEL.other).toBe("not jewelry");
    expect(KIND_LABEL.jewelry).toBeUndefined();
  });
});

const createDrafts = vi.fn(async () => ({
  ok: true, created: 1, skipped: 1, failed: 1,
  created_items: [{ item_id: "w", code: "W3356", product_id: "pw", needs: ["origin", "category"], photos: 0, item_kind: "other" }],
  skipped_items: [{ item_id: "f", code: "NF001", reason: "not_fresh" }],
  failed_items: [{ item_id: "s", code: "N3178", reason: "no_metal" }],
}));
vi.mock("@/lib/page365-drafts-api", () => ({
  createDrafts: (...a: unknown[]) => (createDrafts as unknown as (...x: unknown[]) => unknown)(...a),
  listCategories: async () => new Map([["ip-w", "SUPPLIER LISTINGS - BRANDS"]]),
  publishProducts: vi.fn(),
}));
vi.mock("@/lib/page365-inventory-api", () => ({
  copyPhotos: vi.fn(),
  refreshForDrafts: async () => ({ busy: false, refreshed: 3, gone: 0, failed: [], remaining: 0 }),
}));
const toastWarning = vi.fn();
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { warning: (m: string) => toastWarning(m), success: (m: string) => toastSuccess(m), error: vi.fn() } }));

const row = (over: Partial<NewRow>): InventoryItem => ({
  id: "x", run_id: "run1", kind: "page365", page365_product_id: 1, page365_variant_id: 1,
  page365_name: "", variant_name: null, code: "", page365_price_jpy: 50000, page365_full_price_jpy: null,
  page365_available: 1, match_result: "unmatched", website_product_id: null, variant_id: null, hub_sku: null,
  hub_price_jpy: null, seen_stock: null, web_holds: null, invoice_holds: null, proposed_stock: null, category: "new",
  price_differs: false, photos_total: 0, photos_to_copy: 0, photos_removed: 0, missing_runs: null, status: "review",
  result_note: null, inventory_product_id: "ip-w", ...over,
} as InventoryItem);

describe("Page365NewProductsPanel — wallets and blocked rows", () => {
  const run: InventoryRun = { id: "run1", status: "ready", page365_count: 3, products_total: 3, error: null,
    created_at: "2026-09-26T08:36:00Z", finished_at: "2026-09-26T08:40:00Z" };

  it("lists each not-created row with its reason, labels a wallet 'not jewelry', and warns", async () => {
    const items = [
      row({ id: "w", code: "W3356", page365_name: "W3356 Wallet Gucci GG Marmont Long Wallet [Preloved]" }),
      row({ id: "f", code: "NF001", page365_name: "NF001 Necklace K18 45cm" }),
      row({ id: "s", code: "N3178", page365_name: "N3178 Necklace SV 8.50g Emerald 48cm [Preloved]" }),
    ];
    const { Page365NewProductsPanel } = await import("@/components/website/Page365NewProductsPanel");
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Page365NewProductsPanel run={run} items={items} canCreate onChanged={() => undefined} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Select all shown \(3\)/ }));
    fireEvent.click(screen.getByRole("button", { name: /Create drafts \(3\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Create drafts" }));
    await waitFor(() => expect(createDrafts).toHaveBeenCalledWith("run1", ["w", "f", "s"]));

    const list = await screen.findByTestId("new-not-created");
    expect(list.textContent).toMatch(/Skipped NF001: could not be read fresh from Page365/);
    expect(list.textContent).toMatch(/Failed N3178: jewelry with no metal stamp printed on Page365/);
    expect(screen.getByRole("link", { name: "W3356" }).parentElement?.textContent).toMatch(/not jewelry/);
    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
      "1 draft(s) created · 1 skipped · 1 could not be created — each one is listed below with the reason."));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("after a reload, a row's stored reason shows in its own line", async () => {
    const { Page365NewProductsPanel } = await import("@/components/website/Page365NewProductsPanel");
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Page365NewProductsPanel run={run} canCreate onChanged={() => undefined}
            items={[row({ id: "s", code: "N3178", page365_name: "N3178 Necklace SV", result_note: "no_metal" })]} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("new-row").textContent).toMatch(/jewelry with no metal stamp printed on Page365/);
  });
});
