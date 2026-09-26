import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseListExtras } from "../../supabase/functions/_shared/page365-inventory.ts";
import { publishMissing } from "@/lib/page365-drafts";
import { emptyProduct, itemKindFrom, metalRequired } from "@/components/website/product-form";

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
  it("a watch or accessory with no stamp needs nothing", () => {
    expect(publishMissing({ ...base, item_kind: "watch", metals: [] })).toEqual([]);
    expect(publishMissing({ ...base, item_kind: "accessory", metals: [] })).toEqual([]);
  });
  it("jewelry with no stamp still needs one (a missing kind is jewelry)", () => {
    expect(publishMissing({ ...base, item_kind: "jewelry", metals: [] })).toEqual(["metal"]);
    expect(publishMissing({ ...base, metals: [] })).toEqual(["metal"]);
  });
  it("form: jewelry by default; only jewelry requires a stamp; unknown kinds read as jewelry", () => {
    expect(emptyProduct().itemKind).toBe("jewelry");
    expect(metalRequired("jewelry")).toBe(true);
    expect(metalRequired("watch")).toBe(false);
    expect(metalRequired("accessory")).toBe(false);
    expect(itemKindFrom("watch")).toBe("watch");
    expect(itemKindFrom("other")).toBe("accessory"); // renamed 2026-09-26
    expect(itemKindFrom(undefined)).toBe("jewelry");
    expect(itemKindFrom("bag")).toBe("jewelry");
  });
  it("Catalog save: the stamp check is jewelry-only, only to publish (2026-09-26), and the kind is written", () => {
    const pc = code(src("src/components/website/ProductsCard.tsx"));
    expect(pc).toContain('if (f.status === "active" && metalRequired(f.itemKind) && !f.metals.length) {');
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
