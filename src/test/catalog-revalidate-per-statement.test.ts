import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Catalog revalidation once per statement (docs/WEBSITE-VERCEL.md §2). The
 * five catalog tables move from the row-level notify_website_revalidate() to
 * notify_website_catalog_revalidate() FOR EACH STATEMENT, with transition
 * tables. Source-anchored: pins the migration's shape, not live behaviour.
 */

const src = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const MIGRATION = "supabase/migrations/20261230100000_catalog_revalidate_per_statement.sql";
const sql = src(MIGRATION);
const code = sql.split("\n").filter((l) => !l.startsWith("--")).join("\n");

const TRIGGERS: Array<[string, string]> = [
  ["trg_website_products_revalidate", "website_products"],
  ["trg_website_variants_revalidate", "website_product_variants"],
  ["trg_website_media_revalidate", "website_product_media"],
  ["trg_website_collection_products_revalidate", "website_collection_products"],
  ["trg_website_collections_revalidate", "website_collections"],
];

const EXEC = "FOR EACH STATEMENT EXECUTE FUNCTION public.notify_website_catalog_revalidate();";

const body = (() => {
  const m = sql.match(/AS \$function\$([\s\S]*?)\$function\$;/);
  if (!m) throw new Error("function body not found");
  return m[1];
})();

describe("catalog revalidation per statement — migration", () => {
  it("sets lock_timeout before anything else", () => {
    const first = sql.split("\n").find((l) => l.trim() !== "" && !l.startsWith("--"));
    expect(first).toBe("SET LOCAL lock_timeout = '15s';");
  });

  it("drops each of the five row-level triggers", () => {
    for (const [name, table] of TRIGGERS) {
      expect(sql).toContain(`DROP TRIGGER IF EXISTS ${name} ON public.${table};`);
    }
    expect(sql.match(/^DROP TRIGGER /gm)).toHaveLength(5);
  });

  it("creates 15 statement-level triggers with the right transition tables per event", () => {
    for (const [name, table] of TRIGGERS) {
      expect(sql).toContain(
        `CREATE TRIGGER ${name}_ins AFTER INSERT ON public.${table} REFERENCING NEW TABLE AS new_rows ${EXEC}`,
      );
      expect(sql).toContain(
        `CREATE TRIGGER ${name}_upd AFTER UPDATE ON public.${table} REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows ${EXEC}`,
      );
      expect(sql).toContain(
        `CREATE TRIGGER ${name}_del AFTER DELETE ON public.${table} REFERENCING OLD TABLE AS old_rows ${EXEC}`,
      );
    }
    const creates = sql.match(/^CREATE TRIGGER .*$/gm) ?? [];
    expect(creates).toHaveLength(15);
    for (const line of creates) expect(line).toContain(EXEC);
    expect(code).not.toMatch(/FOR EACH ROW/);
  });

  it("revokes EXECUTE from PUBLIC, anon and authenticated", () => {
    expect(sql).toContain(
      "REVOKE EXECUTE ON FUNCTION public.notify_website_catalog_revalidate() FROM PUBLIC, anon, authenticated;",
    );
  });

  it("is SECURITY DEFINER with a pinned search_path and the same endpoint, key and payload", () => {
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION public\.notify_website_catalog_revalidate\(\)\s+RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path TO 'public'/,
    );
    expect(body).toContain("WHERE name = 'email_queue_service_role_key'");
    expect(body).toMatch(/IF v_key IS NULL THEN\s+RETURN NULL;\s+END IF;/);
    expect(body).toContain("'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/notify_website'");
    expect(body).toContain("'Authorization', 'Bearer ' || v_key");
    expect(body).toContain("jsonb_strip_nulls(jsonb_build_object('productSlug', v_pair->>'p', 'collectionSlug', v_pair->>'c'))");
    expect(body).toMatch(/RETURN NULL;\s+END\s*$/);
  });

  it("posts once per DISTINCT pair and skips pairs with no slug", () => {
    expect(body.match(/jsonb_agg\(DISTINCT /g)).toHaveLength(10);
    expect(body.match(/net\.http_post\(/g)).toHaveLength(1);
    expect(body).toContain("FOR v_pair IN SELECT value FROM jsonb_array_elements(v_pairs) LOOP");
    expect(body).toContain("WHERE p.slug IS NOT NULL OR c.slug IS NOT NULL;");
  });

  it("reads new_rows only in the INSERT/UPDATE branch and old_rows only in the DELETE branch", () => {
    const ins = body.indexOf("IF TG_OP IN ('INSERT', 'UPDATE') THEN");
    const del = body.indexOf("ELSIF TG_OP = 'DELETE' THEN");
    const loop = body.indexOf("FOR v_pair IN");
    expect(ins).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(ins);
    expect(loop).toBeGreaterThan(del);
    const insertBranch = body.slice(ins, del);
    const deleteBranch = body.slice(del, loop);
    expect(insertBranch).not.toMatch(/old_rows/);
    expect(insertBranch.match(/FROM new_rows n/g)).toHaveLength(5);
    expect(deleteBranch).not.toMatch(/new_rows/);
    expect(deleteBranch.match(/FROM old_rows o/g)).toHaveLength(5);
  });

  it("resolves slugs per table like the row-level function", () => {
    expect(body).toContain("JOIN website_products p ON p.id = n.product_id");
    expect(body).toContain("JOIN website_product_variants v ON v.id = n.variant_id");
    expect(body).toContain("JOIN website_product_variants v ON v.id = o.variant_id");
    expect(body).toContain("LEFT JOIN website_collections c ON c.id = n.collection_id");
    expect(body).toContain("LEFT JOIN website_collections c ON c.id = o.collection_id");
  });

  it("keeps comments outside the function body (Lovable strips them on apply)", () => {
    expect(body).not.toMatch(/^\s*--/m);
  });

  it("does not redefine notify_website_revalidate or touch its other triggers", () => {
    expect(sql).not.toMatch(/FUNCTION public\.notify_website_revalidate\b/);
    expect(sql).not.toMatch(/EXECUTE FUNCTION public\.notify_website_revalidate\(/);
    for (const t of ["website_settings", "website_posts", "website_faq_sections", "website_faq_items", "website_post_comments", "product_reviews", "loyalty_tiers"]) {
      expect(sql).not.toMatch(new RegExp(`ON public\\.${t}\\b`));
    }
  });
});
