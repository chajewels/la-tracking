import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Page365 landing prefills the Edit product fields from the product name
 * (owner request 2026-10-30). The behaviour runs against a real Postgres in
 * docs/sql/20270222_page365_prefill_local_tests.sql; this file pins the
 * migration's load-bearing clauses.
 */
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const M = src("supabase/migrations/20270222100000_page365_prefill_from_name.sql");
const LAND = src("supabase/migrations/20261005100000_page365_auto_land.sql")
  .match(/CREATE OR REPLACE FUNCTION public\.page365_inventory_land_run\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$/)![1];
const body = (name: string) => M.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`))![1];

describe("migration 20270222100000_page365_prefill_from_name", () => {
  it("is pure ASCII (the Lovable DB connection rewrites non-ASCII in function bodies)", () => {
    expect(/[^\x00-\x7F]/.test(M)).toBe(false);
  });
  it("does not edit land_run and pins its live body", () => {
    expect(createHash("md5").update(LAND, "utf8").digest("hex")).toBe("7f27675ecd45453b1577fa5f6e6ba738");
    expect(M).not.toMatch(/FUNCTION public\.page365_inventory_land_run/);
    expect(M.match(/7f27675ecd45453b1577fa5f6e6ba738/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("runs from an AFTER INSERT trigger on page365_landings that never undoes a landing", () => {
    expect(M).toContain("AFTER INSERT ON public.page365_landings");
    const trg = body("page365_landings_prefill_trg");
    expect(trg).toContain("EXCEPTION WHEN OTHERS THEN");
    expect(trg).toContain("RETURN NULL;");
  });
  it("only touches never-public drafts and only blank fields", () => {
    const f = body("page365_prefill_from_name");
    expect(f).toContain("IF v_p.status::text <> 'draft' OR v_p.first_published_at IS NOT NULL THEN");
    expect(f).toContain("IF v_origin = 'UNKNOWN' THEN");
    expect(f).toContain("IF v_weight IS NULL THEN");
    expect(f).toContain("v_brand := nullif(btrim(coalesce(v_p.brand, '')), '');");
    expect(f).toContain("IF NOT EXISTS (SELECT 1 FROM public.website_collection_products WHERE product_id = p_product_id) THEN");
    expect(f).toContain("NOT EXISTS (SELECT 1 FROM public.website_category_products WHERE product_id = p_product_id)");
    expect(f).toContain("CASE WHEN v_p.condition = 'New' AND public.page365_prefill_secondhand(v_p.name) THEN 'Preloved'");
    expect(f).not.toMatch(/stock_qty|price_jpy|SET status/);
  });
  it("categories follow the owner's rules", () => {
    const f = body("page365_prefill_from_name");
    expect(f).toContain("WHEN v_kind = 'jewelry' AND v_cond = 'Preloved' AND v_brand IS NOT NULL THEN 'preloved-branded-jewelry'");
    expect(f).toContain("WHEN v_kind = 'jewelry' AND v_cond = 'Preloved' THEN 'preloved-jewelry'");
    expect(f).toContain("WHEN v_kind = 'jewelry' AND v_brand IS NULL THEN 'fine-jewelry'");
  });
  it("origin: 750 / 18K / AU750 -> Other; the owner's Japan stamps -> Made in Japan", () => {
    const o = body("page365_prefill_origin");
    expect(o).toContain("ARRAY['750', '18K']");
    expect(o).toContain("'\\mau\\s?750'");
    expect(o).toContain("ARRAY['K24', 'K18', 'K14', 'K10', 'PT1000', 'PT950', 'PT900', 'PT850', 'PM', 'PM900']");
  });
  it("the one-time pass is exactly the two never-completed drafts", () => {
    expect(M).toContain("WHERE wp.id IN ('f17e0f39-616f-4cf2-b77a-9ee06de5644b', 'cb07c59a-4849-49fa-828e-2f868bff853f')");
    expect(M).toContain("'page365_prefill_from_name self-check: a product other than N2916 / R3694 changed'");
  });
  it("no new function is callable by anon / authenticated", () => {
    expect(M).toContain("EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);");
  });
});

describe("migration 20270223100000_page365_prefill_from_name_fixes (independent review 2026-10-30)", () => {
  const F = src("supabase/migrations/20270223100000_page365_prefill_from_name_fixes.sql");
  it("is pure ASCII and touches no product", () => {
    expect(/[^\x00-\x7F]/.test(F)).toBe(false);
    expect(F).not.toMatch(/PERFORM public\.page365_prefill_from_name\(/);
    expect(F).toContain("'page365_prefill_fixes self-check: a product or variant changed'");
  });
  it("guards every replaced function on its live (20270222100000) body", () => {
    for (const [fn, live] of [
      ["page365_prefill_brand(text)", "2df8d1b4aa89195fa76f90da2c51848f"],
      ["page365_prefill_stones(text)", "c93d4fb79251787345188c8270bdef86"],
      ["page365_prefill_from_name(uuid)", "39467889c73fcd0a6eb41dd37921d65e"],
      ["page365_prefill_length(text)", "40d89d5443206feb78acf0d6434fbf47"],
      ["page365_prefill_ring_size(text)", "08dbda7b55de024f16fb0afac374cf95"],
      ["page365_prefill_secondhand(text)", "560fc3a0a14d6f5b5e4a1ec33e9255b7"],
      ["page365_prefill_mm(text)", "165c674fd637fca0a5bd6cd0671b8541"],
    ]) expect(F).toContain(`('${fn}', '${live}', '`);
  });
  it("a look-alike is never branded; brand list = Branded rows + fixed houses", () => {
    expect(F).toContain("inspir\\w*|style|type|motif|design|like|replica|copy|homage");
    expect(F).toContain("WHERE wp.origin = 'BRAND' AND length(btrim(coalesce(wp.brand, ''))) >= 3");
    expect(F).toContain("('Mikimoto')");
  });
});
