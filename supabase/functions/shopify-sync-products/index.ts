import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";

// ─────────────────────────────────────────────────────────────
// shopify-sync-products
// Pulls the Shopify product catalog (Admin GraphQL API 2026-07) and
// upserts it into public.products. Product-grain, single-variant
// assumption (first variant's sku/price/inventory/barcode).
//
// Delta vs full backfill is driven by
// system_settings.shopify_products_last_synced_at:
//   missing → full backfill (no updated_at filter)
//   present → delta (query: "updated_at:>'<stored ISO>'")
// The cursor advances to the run's START timestamp ONLY on full success,
// so a mid-run failure never skips products on the next run.
//
// Auth to Shopify is the client-credentials grant (Dev-Dashboard app) —
// no stored shpat_ token; a short-lived token is minted each run.
// ─────────────────────────────────────────────────────────────

const SHOPIFY_API_VERSION = "2026-07";
const PAGE_SIZE = 100;

const PRODUCTS_QUERY = `
query SyncProducts($cursor: String, $q: String) {
  products(first: ${PAGE_SIZE}, after: $cursor, query: $q) {
    nodes {
      id
      title
      status
      vendor
      handle
      productType
      tags
      description
      updatedAt
      featuredImage { url }
      variants(first: 1) { nodes { sku price inventoryQuantity barcode } }
      collections(first: 10) { nodes { title } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Mint a short-lived Admin API token via the client-credentials grant.
// Content-Type MUST be x-www-form-urlencoded — JSON is rejected by Shopify.
async function mintAccessToken(
  storeDomain: string,
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const res = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: apiKey,
      client_secret: apiSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    // Log the Shopify error body verbatim (esp. shop_not_permitted).
    console.error(
      `[shopify-sync-products] token grant failed (${res.status}): ${body}`,
    );
    throw new Error(`Shopify token grant failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  if (!json?.access_token) {
    console.error(
      `[shopify-sync-products] token grant returned no access_token: ${JSON.stringify(json)}`,
    );
    throw new Error("Shopify token grant returned no access_token");
  }
  return json.access_token as string;
}

Deno.serve(async (req) => {
  const preflight = corsPreflight(req);
  if (preflight) return preflight;

  try {
    const SHOPIFY_API_KEY = Deno.env.get("SHOPIFY_API_KEY");
    const SHOPIFY_API_SECRET = Deno.env.get("SHOPIFY_API_SECRET");
    const SHOPIFY_STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN");
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || !SHOPIFY_STORE_DOMAIN) {
      return jsonResponse(
        { error: "Missing SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_STORE_DOMAIN" },
        500,
      );
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Capture the run start BEFORE any fetching — this is the value the
    // cursor advances to, so nothing updated during the run is missed next time.
    const runStartTs = new Date().toISOString();

    // ── Cursor: full backfill vs delta ──
    const { data: curRow, error: curErr } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "shopify_products_last_synced_at")
      .maybeSingle();
    if (curErr) {
      return jsonResponse({ error: `Failed to read cursor: ${curErr.message}` }, 500);
    }
    const storedTs = curRow?.value != null ? String(curRow.value) : null;
    const mode: "full" | "delta" = storedTs ? "delta" : "full";
    const q = storedTs ? `updated_at:>'${storedTs}'` : null;

    // ── Mint token (fresh each run; tokens last 24h, never cached) ──
    const accessToken = await mintAccessToken(
      SHOPIFY_STORE_DOMAIN,
      SHOPIFY_API_KEY,
      SHOPIFY_API_SECRET,
    );
    const gqlUrl = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

    let cursor: string | null = null;
    let hasNextPage = true;
    let pages = 0;
    let upserted = 0;

    // ── Paginate all products, upsert per page ──
    while (hasNextPage) {
      const gqlRes = await fetch(gqlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query: PRODUCTS_QUERY, variables: { cursor, q } }),
      });
      if (!gqlRes.ok) {
        const body = await gqlRes.text();
        // Do NOT advance the cursor — surface the failure so the next run
        // re-scans from the same point.
        return jsonResponse(
          { error: `Shopify GraphQL HTTP ${gqlRes.status}: ${body}`, mode, pages, upserted },
          500,
        );
      }
      const gql = await gqlRes.json();
      if (gql.errors) {
        return jsonResponse(
          { error: `Shopify GraphQL errors: ${JSON.stringify(gql.errors)}`, mode, pages, upserted },
          500,
        );
      }

      const conn = gql?.data?.products;
      const nodes: any[] = conn?.nodes ?? [];
      pages += 1;

      const rows = nodes.map((n) => {
        const v = n.variants?.nodes?.[0] ?? {};
        return {
          shopify_product_id: n.id, // full gid string
          title: n.title,
          sku: v.sku ?? null, // may be null/empty — code lives in title
          price_jpy: v.price != null ? parseFloat(v.price) : null,
          inventory_quantity: v.inventoryQuantity ?? null,
          barcode: v.barcode ?? null,
          // Key off the literal status field, lowercased to our enum values
          // (active | draft | unlisted | archived). API 2026-07 reports
          // unlisted correctly (pre-2025-10 mis-reports it as active).
          status: (n.status ?? "").toLowerCase(),
          vendor: n.vendor ?? null,
          handle: n.handle ?? null,
          product_type: n.productType ?? null,
          description: n.description ?? null,
          tags: n.tags ?? [], // already an array of strings
          collection_titles: (n.collections?.nodes ?? []).map((c: any) => c.title),
          image_url: n.featuredImage?.url ?? null,
          shopify_updated_at: n.updatedAt,
          synced_at: new Date().toISOString(),
        };
      });

      if (rows.length > 0) {
        const { error: upErr } = await supabase
          .from("products")
          .upsert(rows, { onConflict: "shopify_product_id" });
        if (upErr) {
          // Page write failed — do NOT advance the cursor.
          return jsonResponse(
            { error: `products upsert failed on page ${pages}: ${upErr.message}`, mode, pages, upserted },
            500,
          );
        }
        upserted += rows.length;
      }

      console.log(
        `[shopify-sync-products] page ${pages}: ${rows.length} products (upserted total ${upserted})`,
      );

      hasNextPage = !!conn?.pageInfo?.hasNextPage;
      cursor = conn?.pageInfo?.endCursor ?? null;
    }

    // ── Full success — advance the cursor to the run start timestamp ──
    const { error: cursorErr } = await supabase
      .from("system_settings")
      .upsert(
        { key: "shopify_products_last_synced_at", value: runStartTs },
        { onConflict: "key" },
      );
    if (cursorErr) {
      return jsonResponse(
        { error: `Sync succeeded but cursor advance failed: ${cursorErr.message}`, mode, pages, upserted },
        500,
      );
    }

    return jsonResponse({
      ok: true,
      mode,
      pages,
      upserted,
      cursor_advanced_to: runStartTs,
    });
  } catch (err) {
    console.error("[shopify-sync-products] unexpected error:", err);
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});
