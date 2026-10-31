import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Page365 name follow — Japanese names (owner 2026-10-31, after N5140).
 * The SQL behaviour is proved on a local Postgres by
 * docs/sql/20270226_page365_ja_names_local_test.sql (20 checks, stubs
 * byte-identical to live). These pins keep the wiring and the rules in place.
 */
const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
/** Source with comment lines stripped, so a guard matches CODE, not prose. */
const code = (s: string) => s.split("\n").filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");
const MIG = code(src("supabase/migrations/20270226100000_page365_ja_names_keep_existing.sql"));

describe("translate-product-description accepts the scheduled service-role caller", () => {
  it("requireAuth opts in to the service role", () => {
    const fn = code(src("supabase/functions/translate-product-description/index.ts"));
    expect(fn).toContain("requireAuth(req, { allowServiceRole: true })");
    expect(fn).not.toMatch(/requireAuth\(req\)\s*;/);
  });
  it("staff still need manage_website_catalog (the permission gate is unchanged)", () => {
    const fn = code(src("supabase/functions/translate-product-description/index.ts"));
    expect(fn).toContain('requirePermission(ctx, "manage_website_catalog")');
  });
  it("the service role is detected by the shared helper, never by comparing keys here", () => {
    const fn = code(src("supabase/functions/translate-product-description/index.ts"));
    expect(fn).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});

describe("page365-inventory-fetch calls the translator as the service role (live 401, 2026-10-31)", () => {
  const fetchFn = () => code(src("supabase/functions/page365-inventory-fetch/index.ts"));
  it("no longer uses supabase.functions.invoke for the translation (refused 401 on live)", () => {
    expect(fetchFn()).not.toMatch(/functions\.invoke\(\s*"translate-product-description"/);
  });
  it("posts to translate-product-description with Bearer SUPABASE_SERVICE_ROLE_KEY, like the working internal calls", () => {
    const helper = fetchFn().slice(fetchFn().indexOf("export async function translateNameAsService"), fetchFn().indexOf("export async function translatePendingNames"));
    expect(helper).toContain('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');
    expect(helper).toContain("/functions/v1/translate-product-description");
    expect(helper).toContain("Authorization: `Bearer ${key}`");
    expect(helper).toContain('method: "POST"');
    expect(helper).toContain("JSON.stringify({ name })");
    expect(helper).toMatch(/if \(!res\.ok\) throw/);
    expect(helper).toMatch(/if \(!ja\) throw new Error\("empty translation"\)/);
  });
  it("the pending loop uses the helper and still writes only through page365_set_name_ja", () => {
    const loop = fetchFn().slice(fetchFn().indexOf("export async function translatePendingNames"), fetchFn().indexOf("async function followBacklogs"));
    expect(loop).toContain("await translateNameAsService(name)");
    expect(loop).toContain('supabase.rpc("page365_set_name_ja"');
    expect(loop).not.toMatch(/\.from\("website_products"\)/);
  });
});

describe("migration 20270226100000: an existing Japanese name is never replaced", () => {
  it("is pinned to the live bodies it was written against", () => {
    expect(MIG).toContain("'a23ec50466ad2c9e3a74585904afd2c8'");
    expect(MIG).toContain("'659b1c93cb8bf738cdd4e224f1a2518e'");
  });
  it("the pending list returns only products whose Japanese name is missing", () => {
    const pending = MIG.slice(MIG.indexOf("FUNCTION public.page365_pending_ja_names"), MIG.indexOf("FUNCTION public.page365_set_name_ja"));
    expect(pending).toContain("AND btrim(coalesce(wp.name_ja, '')) = ''");
  });
  it("set_name_ja writes only while the Japanese name is missing and the English is unchanged", () => {
    const setFn = MIG.slice(MIG.indexOf("FUNCTION public.page365_set_name_ja"));
    expect(setFn).toMatch(/AND btrim\(name\) = btrim\(coalesce\(p_expected_name, ''\)\)\s+AND btrim\(coalesce\(name_ja, ''\)\) = '';/);
  });
  it("the one-time step only clears ja_pending and never writes a product", () => {
    const oneTime = MIG.slice(MIG.lastIndexOf("UPDATE public.page365_listing_names n SET ja_pending = false"));
    expect(oneTime).not.toMatch(/UPDATE public\.website_products/);
  });
  it("refuses (rolls back) if any product name or Japanese name changed", () => {
    expect(MIG).toContain("a product name or Japanese name changed -- rolled back");
  });
  it("is ASCII only", () => {
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(src("supabase/migrations/20270226100000_page365_ja_names_keep_existing.sql"))).toBe(true);
  });
});
