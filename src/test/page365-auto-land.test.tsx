import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KIND_LABEL, incompleteText, photoText, type LandedProduct } from "@/lib/page365-drafts";
import {
  ITEM_KINDS, ITEM_KIND_LABEL, PRODUCT_METAL_VALUES, itemKindFrom, metalLabel, metalsLabel,
} from "@/components/website/product-form";
import { METAL_VALUES } from "@/lib/website-catalog-import";

/**
 * New Page365 products land in the Catalog by themselves (owner decisions
 * 2026-09-26, replaces "Create drafts"). The rules run against a real Postgres
 * in docs/sql/20261005_page365_auto_land_local_tests.sql; this file pins the
 * migration's load-bearing clauses, the edge wiring and what TypeScript owns.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const MIGRATION = src("supabase/migrations/20261005100000_page365_auto_land.sql");
const body = (name: string) => {
  const m = MIGRATION.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`));
  expect(m, `${name} is defined`).not.toBeNull();
  return m![1];
};
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const code = (s: string) => s.split("\n").filter(l => !/^\s*(--|\/\/|\*|\/\*)/.test(l)).join("\n");
const prev = (file: string, name: string) =>
  src(`supabase/migrations/${file}`).match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$fn\\$([\\s\\S]*?)\\$fn\\$`))![1];

describe("migration 20261005100000_page365_auto_land — guards", () => {
  it("guards each replaced function on its LIVE body and pins the new one (Bug #280)", () => {
    for (const [fn, sig, file] of [
      ["page365_inventory_finish", "page365_inventory_finish(uuid)", "20261002100000_page365_quick_fetch.sql"],
      ["page365_inventory_plan_quick", "page365_inventory_plan_quick(uuid)", "20261002100000_page365_quick_fetch.sql"],
      ["page365_metals_from_text", "page365_metals_from_text(text)", "20260929100000_page365_inventory_drafts.sql"],
    ]) {
      const before = md5(prev(file, fn));
      expect(MIGRATION).toMatch(new RegExp(`\\('${sig.replace(/[()[\]]/g, "\\$&")}',\\s+'${before}', '${md5(body(fn))}'\\)`));
    }
    expect(MIGRATION).toContain(`('page365_item_kind_for(text,text)', '${md5(body("page365_item_kind_for"))}')`);
    expect(MIGRATION).toContain(`('page365_inventory_land_run(uuid)', '${md5(body("page365_inventory_land_run"))}')`);
    // The dropped functions must still be the known bodies (or gone).
    expect(MIGRATION).toContain(`'${md5(prev("20261002100000_page365_quick_fetch.sql", "page365_inventory_create_drafts"))}'`);
    expect(MIGRATION).toContain(`'${md5(prev("20261002100000_page365_quick_fetch.sql", "page365_inventory_refresh_product"))}'`);
    expect(MIGRATION).not.toMatch(/@@|TODO|<[A-Z_]+>/);
    expect(code(MIGRATION).match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code(MIGRATION).match(/^COMMIT;$/gm)).toHaveLength(1);
  });
  it("the replaced bodies differ from PR 3c only by their edits", () => {
    const f = body("page365_inventory_finish");
    const old = prev("20261002100000_page365_quick_fetch.sql", "page365_inventory_finish");
    expect(f.replace(/\n {2}-- 2026-09-26: new, in-stock codes[^\n]*\n {2}v_landed {3}jsonb;/, "")
      .replace(/\n {2}-- \(g\) 2026-09-26[\s\S]*?END IF;\n/, "\n")
      .replace(",\n                            'landed', v_landed);", ");")).toBe(old);
    const q = body("page365_inventory_plan_quick");
    expect(q).toContain("AND EXISTS (SELECT 1 FROM public.page365_inventory_products o\n"
      + "                  WHERE o.page365_product_id = p.page365_product_id AND o.run_id <> p_run_id AND o.status = 'fetched');");
  });
  it("the self-check proves no product created, no status or stock moved", () => {
    expect(MIGRATION).toContain("'page365_auto_land self-check: a product was created, or a status or stock changed, during this file'");
    expect(MIGRATION).toContain("(SELECT count(*)::text FROM public.website_products) || '|'");
  });
});

describe("landing rules (page365_inventory_land_run)", () => {
  const L = code(body("page365_inventory_land_run"));
  it("only a complete read; only new, unmatched rows under review", () => {
    expect(L).toContain("IF v_run.status <> 'ready' THEN RETURN jsonb_build_object('ok', false, 'reason', 'run_not_ready'); END IF;");
    expect(L).toContain("WHERE i.run_id = p_run_id AND i.kind = 'page365' AND i.category = 'new'");
    expect(L).toContain("AND i.match_result = 'unmatched' AND i.status = 'review'");
  });
  it("sold out never lands; Don't sync is read live; never a second product", () => {
    expect(L).toContain("ELSIF coalesce(v_it.page365_available, 0) <= 0 THEN");
    expect(L).toContain("v_note := 'sold_out';");
    expect(L).toMatch(/WHERE wp\.page365_sync_disabled\s+AND \(public\.page365_first_word\(wp\.sku\) = v_it\.code/);
    expect(L).toContain("v_note := 'code_exists';");
  });
  it("ALWAYS a draft — never published — and origin never guessed", () => {
    expect(L).toContain("VALUES (v_it.code, v_slug, v_name, 'draft', 'UNKNOWN', v_cond, v_metals, v_kind, v_desc,");
    expect(L).not.toMatch(/'active'/);
  });
  it("incomplete still lands: no metal refusal, no price refusal", () => {
    expect(L).not.toMatch(/no_metal|no_price/);
    expect(L).toContain("v_price := greatest(0, coalesce(v_it.page365_price_jpy, v_prod.price_jpy, 0));");
  });
  it("every row not landed keeps its reason; an error never undoes the others", () => {
    expect(L).toContain("UPDATE public.page365_inventory_items SET result_note = v_note WHERE id = v_it.id;");
    expect(L).toContain("UPDATE public.page365_inventory_items SET result_note = left(SQLERRM, 300) WHERE id = v_it.id;");
  });
  it("finish lands only a ready read, and a landing failure never fails the read", () => {
    const f = code(body("page365_inventory_finish"));
    expect(f).toMatch(/IF v_status = 'ready' THEN\s+BEGIN\s+v_landed := public\.page365_inventory_land_run\(p_run_id\);\s+EXCEPTION WHEN OTHERS THEN/);
  });
  it("the metal rule moves to publish; three item types; SILVER added", () => {
    const c = code(MIGRATION);
    expect(c).toContain("CHECK (status <> 'active' OR item_kind <> 'jewelry' OR cardinality(metals) >= 1);");
    expect(c).toContain("CHECK (item_kind IN ('jewelry', 'watch', 'accessory'));");
    expect(c).toContain("UPDATE public.website_products SET item_kind = 'accessory' WHERE item_kind = 'other';");
    expect(c).toContain("ALTER TYPE public.website_product_karat ADD VALUE IF NOT EXISTS 'SILVER';");
    expect(c).toContain("'PM900','SILVER925','SILVER']::text[]");
    expect(c).toContain("DROP FUNCTION IF EXISTS public.page365_inventory_create_drafts(uuid, uuid[]);");
  });
  it("item kind: watch wins, then accessory words, whole words only", () => {
    const k = body("page365_item_kind_for");
    expect(k.indexOf("THEN 'watch'")).toBeLessThan(k.indexOf("THEN 'accessory'"));
    for (const w of ["wallets?", "bags?", "belts?", "(coin|key|pass)\\s+cases?", "card\\s+(holder|case)s?", "scarf|scarves"]) {
      expect(k).toContain(w);
    }
  });
  it("stamps: colour codes, SV925 = SILVER925, SV = SILVER", () => {
    const m = body("page365_metals_from_text");
    expect(m).toContain("'^(K24|K18|750|18K|K14|K10|PT1000|PT950|PT900|PT850|PM900|PM|SILVER925)(WG|YG|PG|RG|CG|G)?$'");
    expect(m).toContain("WHEN upper(x.tok) = 'SV925' THEN 'SILVER925'");
    expect(m).toContain("WHEN upper(x.tok) = 'SV'    THEN 'SILVER'");
  });
});

describe("edge functions", () => {
  const F = code(src("supabase/functions/page365-inventory-fetch/index.ts"));
  const P = code(src("supabase/functions/page365-inventory-photos/index.ts"));
  it("the scheduled tick copies landed photos only when it is not reading", () => {
    const tick = F.slice(F.indexOf("async function scheduleTick"));
    expect(tick.indexOf('if (decision.act === "skip")')).toBeLessThan(tick.indexOf("copyLandedPhotos"));
    expect(tick).toContain('const photos = step?.run?.status && step.run.status !== "fetching"');
    expect(F).toContain('.from("page365_landings")');
    expect(F).toContain('.is("photos_done_at", null)');
    expect(F).toContain("const limit = createRateLimiter(4, 3);");
  });
  it("both functions copy through the one shared copier", () => {
    expect(F).toContain('import { copyItemPhotos } from "../_shared/page365-photo-copy.ts";');
    expect(P).toContain('import { copyItemPhotos } from "../_shared/page365-photo-copy.ts";');
    expect(P).toContain('requirePermission(ctx, "manage_website_catalog")');
    expect(P).toContain("runId, skip, actor: userId, maxPhotos: PHOTOS_PER_CALL, limit: createRateLimiter(4, 3),");
  });
});

describe("item types and metals in the Hub", () => {
  it("exactly three types; a stored 'other' reads as accessory", () => {
    expect([...ITEM_KINDS]).toEqual(["jewelry", "watch", "accessory"]);
    expect(ITEM_KIND_LABEL.accessory).toBe("Accessory");
    expect(itemKindFrom("other")).toBe("accessory");
    expect(KIND_LABEL.accessory).toBe("Accessory");
  });
  it("SILVER is a product metal (not an upload-template value), shown as Silver", () => {
    expect(PRODUCT_METAL_VALUES).toContain("SILVER");
    expect(METAL_VALUES as readonly string[]).not.toContain("SILVER");
    expect(metalLabel("SILVER")).toBe("Silver");
    expect(metalLabel("SILVER925")).toBe("Silver 925");
    expect(metalsLabel(["PT900", "K18"])).toBe("PT900 / K18");
  });
});

const landed = (over: Partial<LandedProduct> & { p?: Partial<NonNullable<LandedProduct["website_products"]>> }): LandedProduct => ({
  product_id: "p1", code: "W3356", name: "W3356 Wallet Gucci GG Marmont Long Wallet [Preloved]", item_kind: "accessory",
  landed_at: "2026-09-26T00:36:00Z", photos_total: 3, photos_done_at: "2026-09-26T00:40:00Z", photo_failures: 0,
  ...over,
  website_products: {
    id: "p1", sku: "W3356", name: "W3356 Wallet Gucci GG Marmont Long Wallet [Preloved]", status: "draft", origin: "UNKNOWN",
    brand: null, metals: [], item_kind: "accessory", website_category_products: [], website_product_variants: [{ price_jpy: 42000 }],
    ...(over.p ?? {}),
  },
});

describe("Landed in Catalog wording", () => {
  it("an accessory needs origin and category, never a stamp", () => {
    expect(incompleteText(landed({}))).toBe("incomplete — needs origin, needs category");
  });
  it("jewelry with no stamp shows needs metal stamp", () => {
    expect(incompleteText(landed({ p: { item_kind: "jewelry", origin: "JAPAN", website_category_products: [{}] } })))
      .toBe("incomplete — needs metal stamp");
  });
  it("complete or published: no flag", () => {
    expect(incompleteText(landed({ p: { origin: "BRAND", brand: "Gucci", website_category_products: [{}] } }))).toBe("");
    expect(incompleteText(landed({ p: { status: "active" } }))).toBe("");
  });
  it("photos", () => {
    expect(photoText(landed({ photos_done_at: null }))).toBe("copying 3 photo(s)…");
    expect(photoText(landed({ photo_failures: 1 }))).toBe("photos copied, 1 could not be copied");
    expect(photoText(landed({ photos_total: 0 }))).toBe("no photos on Page365");
  });
});

const listLandings = vi.fn(async (): Promise<LandedProduct[] | null> => [
  landed({}),
  landed({ product_id: "p2", code: "NS100", name: "NS100 Necklace Spinel", item_kind: "jewelry",
           p: { id: "p2", sku: "NS100", name: "NS100 Necklace Spinel", item_kind: "jewelry", origin: "JAPAN",
                website_category_products: [{}] } }),
]);
vi.mock("@/lib/page365-drafts-api", () => ({
  listLandings: () => listLandings(),
  publishProducts: vi.fn(),
}));

describe("Page365LandedPanel", () => {
  it("lists landed products read-only, linked to Catalog, with kind and incomplete flags", async () => {
    const { Page365LandedPanel } = await import("@/components/website/Page365LandedPanel");
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Page365LandedPanel />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const rows = await screen.findAllByTestId("p365-landed-row");
    expect(rows).toHaveLength(2);
    expect(screen.getByRole("link", { name: "W3356" }).getAttribute("href")).toBe("/website?tab=catalog&product=p1");
    expect(rows[0].textContent).toMatch(/Accessory/);
    expect(rows[0].textContent).toMatch(/incomplete — needs origin, needs category/);
    expect(rows[1].textContent).toMatch(/incomplete — needs metal stamp/);
    // Read-only: no tick boxes, no create button.
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Create drafts/ })).toBeNull();
  });
});
