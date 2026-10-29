import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalName, swapCode } from "../../supabase/functions/_shared/page365-inventory.ts";
import { SKIP_REASON } from "@/lib/page365-inventory";
import { deleteConfirmText, deleteSummary } from "@/lib/catalog-delete";

/**
 * Page365 follow (code / name / photos) + Catalog delete (owner 2026-10-29).
 * The SQL is proved by docs/sql/20270220_page365_follow_local_tests.sql on a
 * local Postgres; these tests lock the TS twins, the wiring and the words.
 */
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
/** Source with comment lines stripped, so a guard matches CODE, not prose. */
const code = (s: string) => s.split("\n").filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");
const IDEOGRAPHIC = String.fromCharCode(0x3000); // U+3000
const NBSP = String.fromCharCode(0xa0);
const MIG = src("supabase/migrations/20270220100000_page365_follow_and_catalog_delete.sql");

describe("normalName / swapCode — twins of the SQL helpers", () => {
  it("normalName: lower-case, every whitespace run (incl. U+3000, NBSP) one space, trimmed", () => {
    expect(normalName(" A" + IDEOGRAPHIC + "b" + NBSP + " C ")).toBe("a b c");
    expect(normalName(null)).toBe("");
  });
  it("swapCode replaces only the first word and keeps the rest as written", () => {
    expect(swapCode("N1073 Necklace  Tiffany", "N9140")).toBe("N9140 Necklace  Tiffany");
    expect(swapCode("N1073", "N9140")).toBe("N9140");
    expect(swapCode("  ", "N9140")).toBe("  ");
    expect(swapCode(null, "N9140")).toBe("");
  });
});

describe("Catalog delete words", () => {
  it("tells a Page365-linked piece it can come back, and everyone that orders keep their copy", () => {
    const linked = deleteConfirmText("N1073 Necklace", true);
    expect(linked).toContain("Orders and drafts keep their own copy of the code, name and price.");
    expect(linked).toContain("come back as a new unpublished draft");
    expect(deleteConfirmText("8C100 sample", false)).not.toContain("Page365");
  });
  it("summarises only what happened", () => {
    expect(deleteSummary({ order_lines_unlinked: 0, reviews_detached: 0 })).toBeUndefined();
    expect(deleteSummary({ order_lines_unlinked: 1, reviews_detached: 2 }))
      .toBe("1 order or draft line kept their own copy; 2 reviews will return if the piece lands again.");
  });
  it("review-card labels exist for the new notes", () => {
    expect(SKIP_REASON.code_followed).toMatch(/renamed/);
    expect(SKIP_REASON.code_exists_other_piece).toMatch(/another Hub product/);
  });
});

describe("wiring", () => {
  it("the Products card deletes through the RPC, never a bare .delete()", () => {
    const c = code(src("src/components/website/ProductsCard.tsx"));
    expect(c).toContain("deleteWebsiteProduct(id)");
    expect(c).not.toMatch(/from\("website_products"\)\s*\.delete\(\)/);
    expect(c).toContain("deleteConfirmText(p.name, p.page365_product_id != null)");
    expect(code(src("src/lib/catalog-delete.ts"))).toContain("'delete_website_product_atomic'");
  });
  it("the bell knows the three new types and sends them to Page365 stock", () => {
    const b = src("src/components/notifications/StaffNotificationBell.tsx");
    for (const t of ["page365_name_changed", "page365_recode_blocked", "page365_names_followed_summary"]) {
      expect(b.match(new RegExp(`'${t}'`, "g"))?.length).toBeGreaterThanOrEqual(2);
    }
  });
  it("the migration has NO foreign-key change and no BEGIN/COMMIT", () => {
    const c = code(MIG);
    expect(c).not.toMatch(/ALTER TABLE[^;]*(DROP|ADD)\s+CONSTRAINT/i);
    expect(c).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
  });
  it("the migration builds the delete index, plain (CONCURRENTLY cannot run in a migration)", () => {
    const c = code(MIG);
    expect(c).toContain("CREATE INDEX IF NOT EXISTS idx_page365_inventory_items_product");
    expect(c).toContain("WHERE website_product_id IS NOT NULL");
    expect(c).not.toMatch(/CREATE INDEX CONCURRENTLY/i);
  });
  it("no literal U+3000 / NBSP in the migration SQL (chr() only)", () => {
    expect(MIG.includes(IDEOGRAPHIC) || MIG.includes(NBSP)).toBe(false);
    expect(MIG).toContain("chr(12288)");
    expect(MIG).toContain("chr(160)");
  });
  it("the delete refuses only held / paid / layaway claims and clears expired / released", () => {
    const c = code(MIG);
    expect(c).toContain("c.status::text IN ('held', 'paid', 'layaway')");
    expect(c).toContain("c.status::text IN ('expired', 'released')");
    expect(c).toContain("This piece has an active live-selling claim.");
    expect(c).toContain("DELETE FROM public.page365_inventory_items WHERE kind = 'hub_only' AND website_product_id = p_product_id");
  });
  it("finish gets (a3) before matching and (h) after landing; land_run is not edited", () => {
    const c = code(MIG);
    expect(c.indexOf("page365_inventory_follow_code(p_run_id)")).toBeLessThan(c.indexOf("SELECT * INTO v_m FROM public.page365_match_line(v_it.code)"));
    expect(c.indexOf("v_landed := public.page365_inventory_land_run(p_run_id)")).toBeLessThan(c.indexOf("v_followed := public.page365_inventory_follow_listing(p_run_id)"));
    expect(c).not.toContain("CREATE OR REPLACE FUNCTION public.page365_inventory_land_run");
    expect(c).toContain("7f27675ecd45453b1577fa5f6e6ba738");
  });
  it("the name follow compares Page365-now with Page365-last-seen, never the Hub name, and never writes price", () => {
    const c = code(MIG);
    expect(c).toContain("IS DISTINCT FROM public.page365_norm_name(v_ln.last_p365_name)");
    expect(c).not.toMatch(/UPDATE public\.website_product_variants\s+SET\s+price/i);
  });
  it("the backfill refuses unless the candidates are within N1616, R7828, R3341", () => {
    const c = code(MIG);
    expect(c).toContain("'N1616,R7828,R3341'");
    expect(c).toMatch(/RAISE EXCEPTION 'page365 link backfill: candidates/);
  });
  it("the edge fetch copies followed photos and translates pending names", () => {
    const e = code(src("supabase/functions/page365-inventory-fetch/index.ts"));
    expect(e).toContain("export async function copyFollowedPhotos");
    expect(e).toContain("export async function translatePendingNames");
    expect(e).toContain("followBacklogs(supabase, t0 + SCHEDULE_BUDGET_MS - CHUNK_RESERVE_MS)");
    // The fetch reads / writes the Catalog only through service-role RPCs.
    expect(e).toContain('supabase.rpc("page365_pending_ja_names"');
    expect(e).toContain('supabase.rpc("page365_set_name_ja"');
    expect(e).not.toContain('.from("website_products")');
    expect(e).toContain('.eq("website_products.page365_sync_disabled", false)');
  });
});
