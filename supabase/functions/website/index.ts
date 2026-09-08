import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, corsPreflight, jsonResponse } from "../_shared/cors.ts";

/**
 * Public website API (server-to-server).
 * Single function, routes on path. Contract: supabase/contracts/api.md
 *
 * Auth: header `x-api-key` must equal secret WEBSITE_API_KEY. 401 otherwise.
 * cost_basis / margin / commission are NEVER selected or returned.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const PRODUCT_FIELDS =
  "id, sku, slug, name, karat, weight_g, description_en, description_ja, status, updated_at";
const VARIANT_SELECT =
  "product_variants:website_product_variants(id, size, stone, price_jpy, stock_qty, sort, product_media:website_product_media(url, alt, sort))";
const PRODUCT_SELECT = `${PRODUCT_FIELDS}, ${VARIANT_SELECT}`;

type AnyRec = Record<string, unknown>;

/** Latest JPY->PHP rate. price_php is derived per request, never stored. */
interface FxRate { jpy_php: number; as_of: string }

async function latestFx(supabase: ReturnType<typeof createClient>): Promise<FxRate | null> {
  const { data, error } = await supabase
    .from("fx_rates")
    .select("date, jpy_php")
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const rate = Number((data as AnyRec).jpy_php);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return { jpy_php: rate, as_of: String((data as AnyRec).date) };
}

/** Defence in depth: strip internal keys from any shape before it leaves the function. */
const FORBIDDEN = new Set(["cost_basis", "margin", "commission", "commission_rate", "commission_amount"]);
function scrub<T>(value: T): T {
  if (Array.isArray(value)) return value.map(scrub) as unknown as T;
  if (value && typeof value === "object") {
    const out: AnyRec = {};
    for (const [k, v] of Object.entries(value as AnyRec)) {
      if (FORBIDDEN.has(k)) continue;
      out[k] = scrub(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Sorts variants and media, and derives price_php from the day's rate.
 * CLAUDE.md currency direction: PHP = JPY x rate. Null when no rate is on file.
 */
function shapeProduct(product: AnyRec | null, fx: FxRate | null): AnyRec | null {
  if (!product) return product;
  const variants = (product.product_variants as AnyRec[] | undefined) ?? [];
  variants.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
  for (const v of variants) {
    const media = (v.product_media as AnyRec[] | undefined) ?? [];
    media.sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
    delete v.sort;
    const jpy = Number(v.price_jpy ?? 0);
    v.price_php = fx && Number.isFinite(jpy) ? Math.round(jpy * fx.jpy_php) : null;
  }
  return product;
}

function notFound() {
  return jsonResponse({ error: "not_found" }, 404);
}

Deno.serve(async (req) => {
  const pre = corsPreflight(req);
  if (pre) return pre;

  const apiKey = req.headers.get("x-api-key") ?? "";
  const expected = Deno.env.get("WEBSITE_API_KEY") ?? "";
  if (!expected || apiKey !== expected) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const url = new URL(req.url);
  // Strip the function prefix so both /website/x and /functions/v1/website/x work.
  const path = url.pathname.replace(/^\/functions\/v1/, "").replace(/^\/website/, "").replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean);

  try {
    // GET /fx
    if (req.method === "GET" && segments[0] === "fx" && !segments[1]) {
      const fx = await latestFx(supabase);
      if (!fx) return notFound();
      return jsonResponse({ jpy_php: fx.jpy_php, as_of: fx.as_of });
    }

    // GET /catalog/collections
    if (req.method === "GET" && segments[0] === "catalog" && segments[1] === "collections" && !segments[2]) {
      const { data, error } = await supabase
        .from("website_collections")
        .select("id, slug, name, hero_media, description")
        .order("name");
      if (error) throw error;
      return jsonResponse(scrub(data ?? []));
    }

    // GET /catalog/collections/:slug
    if (req.method === "GET" && segments[0] === "catalog" && segments[1] === "collections" && segments[2]) {
      const slug = decodeURIComponent(segments[2]);
      const { data: collection, error } = await supabase
        .from("website_collections")
        .select("id, slug, name, hero_media, description")
        .eq("slug", slug)
        .maybeSingle();
      if (error) throw error;
      if (!collection) return notFound();

      const { data: links, error: linkError } = await supabase
        .from("website_collection_products")
        .select(`sort, product:website_products(${PRODUCT_SELECT})`)
        .eq("collection_id", collection.id)
        .order("sort");
      if (linkError) throw linkError;

      const fx = await latestFx(supabase);
      const products = (links ?? [])
        .map((l: AnyRec) => l.product as AnyRec | null)
        .filter((p): p is AnyRec => !!p && p.status === "active")
        .map((p) => shapeProduct(p, fx));

      return jsonResponse(scrub({ ...collection, products }));
    }

    // GET /catalog/products/:slug
    if (req.method === "GET" && segments[0] === "catalog" && segments[1] === "products" && segments[2]) {
      const slug = decodeURIComponent(segments[2]);
      const { data, error } = await supabase
        .from("website_products")
        .select(PRODUCT_SELECT)
        .eq("slug", slug)
        .eq("status", "active")
        .maybeSingle();
      if (error) throw error;
      if (!data) return notFound();
      const fx = await latestFx(supabase);
      return jsonResponse(scrub(shapeProduct(data as AnyRec, fx)));
    }

    // GET /catalog/products?featured=1&limit=8 | ?fields=slug,updated_at&limit=5000
    if (req.method === "GET" && segments[0] === "catalog" && segments[1] === "products") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 8) || 8, 1), 5000);
      const fields = url.searchParams.get("fields");

      if (fields) {
        const allowed = new Set(["slug", "updated_at", "sku", "name", "status"]);
        const requested = fields.split(",").map((f) => f.trim()).filter((f) => allowed.has(f));
        const select = requested.length ? requested.join(", ") : "slug, updated_at";
        const { data, error } = await supabase
          .from("website_products")
          .select(select)
          .eq("status", "active")
          .order("updated_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        return jsonResponse(scrub(data ?? []));
      }

      const { data, error } = await supabase
        .from("website_products")
        .select(PRODUCT_SELECT)
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      const fx = await latestFx(supabase);
      const products = (data ?? []).map((p) => shapeProduct(p as AnyRec, fx));
      return jsonResponse(scrub(products));
    }

    // POST /layaway/quote
    if (req.method === "POST" && segments[0] === "layaway" && segments[1] === "quote") {
      const body = await req.json().catch(() => ({}));
      const price = Number(body?.price);
      const term = Number(body?.term_months);
      const currency = String(body?.currency ?? "JPY").toUpperCase();
      if (!Number.isFinite(price) || price < 0) {
        return jsonResponse({ error: "invalid_price" }, 400);
      }
      if (!["JPY", "PHP"].includes(currency)) {
        return jsonResponse({ error: "invalid_currency" }, 400);
      }
      const { data, error } = await supabase.rpc("layaway_quote", {
        p_price: Math.round(price),
        p_term_months: Number.isFinite(term) ? Math.round(term) : 3,
        p_currency: currency,
      });
      if (error) throw error;
      return jsonResponse(scrub(data));
    }

    // GET /claims/:code
    if (req.method === "GET" && segments[0] === "claims" && segments[1] && !segments[2]) {
      const code = decodeURIComponent(segments[1]).toUpperCase();
      const { data, error } = await supabase
        .from("website_live_claims")
        .select("id, code, price_locked, status, expires_at, product_variant_id")
        .eq("code", code)
        .maybeSingle();
      if (error) throw error;
      if (!data) return notFound();
      return jsonResponse(scrub(data));
    }

    // POST /claims/:code/checkout — Phase 2
    if (req.method === "POST" && segments[0] === "claims" && segments[2] === "checkout") {
      return jsonResponse({ error: "not_implemented" }, 501);
    }

    // POST /loyalty/join
    if (req.method === "POST" && segments[0] === "loyalty" && segments[1] === "join") {
      const body = await req.json().catch(() => ({}));
      const name = String(body?.name ?? "").trim();
      const contact = String(body?.contact ?? "").trim();
      const region = String(body?.region ?? "").trim().toUpperCase();
      const lang = String(body?.lang ?? "").trim().toLowerCase();
      if (!name || name.length > 200 || !contact || contact.length > 200) {
        return jsonResponse({ error: "invalid_body" }, 400);
      }
      if (!["JP", "PH", "OTHER"].includes(region) || !["ja", "en"].includes(lang)) {
        return jsonResponse({ error: "invalid_body" }, 400);
      }
      const { error } = await supabase
        .from("loyalty_signups")
        .insert({ name, contact, region, lang });
      if (error) throw error;
      return jsonResponse({ ok: true });
    }

    return notFound();
  } catch (err) {
    console.error("website api error", (err as Error)?.message ?? err);
    return new Response(JSON.stringify({ error: "server_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
