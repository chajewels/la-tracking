/**
 * Reviews land on every product of the order (owner 2026-10-27): "whatever
 * customer stories will review and approve, it should be in the product too …
 * and must land for every product on that link where the customer gave
 * reviews." No staff field decides it.
 *
 * Source guards (the SQL itself is exercised on Postgres when the migration is
 * reviewed; see docs/SCHEMA-FACTS.md "Product reviews").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
// Code only: drop comment lines so a guard never passes on prose.
const code = (p: string) => read(p).split("\n")
  .filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join("\n");

const DIALOG = "src/components/reviews/ReviewLinkDialog.tsx";
const WEBSITE = "supabase/functions/website/index.ts";
const MIGRATION = "supabase/migrations/20270217100000_review_products_auto_link.sql";

describe("review → product links", () => {
  it("the Review link box has no product picker", () => {
    const src = code(DIALOG);
    expect(src).not.toContain("Website piece");
    expect(src).not.toContain('htmlFor="review-product"');
    expect(src).not.toContain('from("website_products")');
  });

  it("a product page's reviews come from product_review_products", () => {
    const src = code(WEBSITE);
    const route = src.slice(src.indexOf('segments[0] === "reviews" && !segments[1]'));
    expect(route).toContain('.from("product_review_products").select("review_id").eq("website_product_id", productId)');
    expect(route.slice(0, 3000)).not.toContain('listQ.eq("website_product_id", productId)');
  });

  it("approval links every product of the order, and the past approvals are linked once", () => {
    const sql = code(MIGRATION);
    expect(sql).toMatch(/CREATE TRIGGER trg_product_reviews_link_products\s+AFTER INSERT OR UPDATE OF status ON public\.product_reviews/);
    expect(sql).toContain("WHEN (NEW.status = 'approved')");
    expect(sql).toContain("JOIN cash_order_items ci ON ci.cash_order_id = r.cash_order_id");
    expect(sql).toContain("JOIN layaway_account_items li ON li.account_id = r.layaway_account_id");
    expect(sql).toContain("upper(btrim(wp.sku)) = upper(btrim(l.sku))");
    expect(sql).toContain("SELECT public.link_review_products(id) FROM public.product_reviews WHERE status = 'approved'");
  });

  it("every reviews → products embed names its foreign key (PGRST201, 2026-10-27)", () => {
    const web = code(WEBSITE);
    expect(web).toContain("product:website_products!product_reviews_website_product_id_fkey(slug, name, status)");
    expect(web).not.toContain("reviewed_at, product:website_products(");
    const card = code("src/components/website/ReviewsCard.tsx");
    expect(card).toContain("product:website_products!product_reviews_website_product_id_fkey(slug, name)");
    expect(card).toContain("links:product_review_products(product:website_products!product_review_products_website_product_id_fkey(slug, name))");
    expect(card).not.toMatch(/product:website_products\(/);
  });

  it("the linking function is not callable by staff or customers", () => {
    expect(code(MIGRATION)).toContain(
      "REVOKE ALL ON FUNCTION public.link_review_products(uuid) FROM PUBLIC, anon, authenticated;",
    );
  });
});
