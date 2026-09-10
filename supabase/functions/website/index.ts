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
  "id, sku, slug, name, karat, weight_g, description_en, description_ja, status, condition, updated_at";
const VARIANT_SELECT =
  "product_variants:website_product_variants(id, size, stone, price_jpy, stock_qty, sort, product_media:website_product_media(url, alt, sort))";
const PRODUCT_SELECT = `${PRODUCT_FIELDS}, ${VARIANT_SELECT}`;

type AnyRec = Record<string, unknown>;

/**
 * Customer-scoped routes (Phase 2 step 1) require BOTH credentials:
 *   x-api-key        already checked for every route below — proves the caller
 *                    is the storefront's own server, not a browser.
 *   Authorization    a Supabase Auth customer JWT — proves WHICH customer.
 * Defence in depth: a leaked customer token cannot reach the Hub without the
 * server-side key, and the key alone cannot read anyone's profile.
 *
 * Linking is by VERIFIED EMAIL only, matching the live rule in
 * setup-customer-account. A JWT with no email (phone OTP) is refused rather
 * than linked by phone: see the phone-OTP note in migration
 * 20260910140000_phase2_step1_customer_auth_addresses.sql.
 */
const CUSTOMER_FIELDS = "id, customer_code, full_name, email, mobile_number, auth_user_id";

interface CustomerUser { id: string; email: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function requireCustomerUser(req: Request, supabase: any): Promise<CustomerUser | Response> {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return jsonResponse({ error: "customer_auth_required" }, 401);
  }
  const { data, error } = await supabase.auth.getUser(header.slice(7));
  if (error || !data?.user) {
    return jsonResponse({ error: "customer_auth_required" }, 401);
  }
  const email = (data.user.email ?? "").trim();
  if (!email) {
    // Phone-OTP session. Cannot be linked safely yet — 863 customers have a
    // phone but only 77 are clean E.164 and 10 groups collide on digits, so a
    // phone match could attach this signup to the wrong customer.
    return jsonResponse({ error: "email_required_for_account" }, 422);
  }
  // An unverified email would let anyone claim a customer row by signing up
  // with that address.
  if (!data.user.email_confirmed_at && !data.user.confirmed_at) {
    return jsonResponse({ error: "email_unverified" }, 403);
  }
  return { id: data.user.id, email };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function customerForAuthUser(supabase: any, authUserId: string): Promise<AnyRec | null> {
  const { data, error } = await supabase
    .from("customers").select(CUSTOMER_FIELDS).eq("auth_user_id", authUserId).maybeSingle();
  if (error) throw error;
  return (data as AnyRec | null) ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loyaltySnapshot(supabase: any, customerId: string) {
  const { data, error } = await supabase
    .from("loyalty_members")
    .select("remaining_points, cumulative_spend_jpy, current_tier_id, loyalty_tiers:current_tier_id(name, points_multiplier)")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { enrolled: false, points: 0, tier: null, multiplier: null };
  const tier = (data as AnyRec).loyalty_tiers as AnyRec | null;
  return {
    enrolled: true,
    points: Number((data as AnyRec).remaining_points ?? 0),
    tier: tier?.name ?? null,
    multiplier: tier?.points_multiplier === undefined || tier?.points_multiplier === null
      ? null
      : Number(tier.points_multiplier),
  };
}


/** Latest JPY->PHP rate. price_php is derived per request, never stored. */
interface FxRate { jpy_php: number; as_of: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function latestFx(supabase: any): Promise<FxRate | null> {
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

    // GET /loyalty/tiers
    if (req.method === "GET" && segments[0] === "loyalty" && segments[1] === "tiers" && !segments[2]) {
      const { data, error } = await supabase
        .from("loyalty_tiers")
        .select(
          "name, min_spend_jpy, requalify_spend_jpy, points_multiplier, hold_minutes, benefits, benefits_ja, display_order",
        )
        .order("display_order", { ascending: true });
      if (error) throw error;
      const tiers = (data ?? []).map((t: AnyRec) => {
        const toList = (v: unknown): string[] =>
          Array.isArray(v) ? v.map((b) => String(b)) : [];
        const raw = t.benefits;
        // `benefits` is an untagged English array today. The { en, ja } object
        // shape is still honoured in case it is ever converted.
        const obj = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as AnyRec;
        const en = Array.isArray(raw) ? toList(raw) : toList(obj.en);
        // Precedence: the benefits_ja column, then a ja key inside benefits,
        // then English — so a tier with no Japanese copy degrades to English
        // rather than rendering an empty list.
        const jaCol = toList(t.benefits_ja);
        const jaEmbedded = toList(obj.ja);
        const ja = jaCol.length ? jaCol : jaEmbedded.length ? jaEmbedded : en;
        return {
          slug: String(t.name ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          name: t.name,
          threshold_jpy: Number(t.min_spend_jpy ?? 0),
          requalify_spend: t.requalify_spend_jpy === null || t.requalify_spend_jpy === undefined
            ? null
            : Number(t.requalify_spend_jpy),
          multiplier: Number(t.points_multiplier ?? 1),
          hold_minutes: t.hold_minutes === null || t.hold_minutes === undefined
            ? null
            : Number(t.hold_minutes),
          benefits_ja: ja.length ? ja : en,
          benefits_en: en.length ? en : ja,
        };
      });
      return jsonResponse(scrub(tiers));
    }

    // POST /wholesale/inquiry
    if (req.method === "POST" && segments[0] === "wholesale" && segments[1] === "inquiry") {
      const body = await req.json().catch(() => ({}));
      const name = String(body?.name ?? "").trim();
      const business = String(body?.business ?? "").trim();
      const email = String(body?.email ?? "").trim();
      const phone = String(body?.phone ?? "").trim();
      const notes = String(body?.notes ?? "").trim();
      const market = String(body?.market ?? "").trim().toUpperCase();
      const volume = String(body?.volume ?? "").trim().toUpperCase();
      const lang = String(body?.lang ?? "").trim().toLowerCase();
      const tooLong = (v: string) => v.length > 200;
      if (!name || !business || !email || tooLong(name) || tooLong(business) || tooLong(email)) {
        return jsonResponse({ error: "invalid_body" }, 400);
      }
      if (!["JP", "PH", "BOTH", "OTHER"].includes(market)) {
        return jsonResponse({ error: "invalid_body" }, 400);
      }
      if (!["TEST", "20_50", "50_200", "200_PLUS"].includes(volume)) {
        return jsonResponse({ error: "invalid_body" }, 400);
      }
      if (!["ja", "en"].includes(lang)) {
        return jsonResponse({ error: "invalid_body" }, 400);
      }
      const { error } = await supabase.from("wholesale_inquiries").insert({
        name,
        business,
        email,
        phone: phone || null,
        market,
        volume,
        notes: notes || null,
        lang,
      });
      if (error) throw error;
      return jsonResponse({ ok: true });
    }


    // ================================================ customer account routes
    // POST /auth/customer — link or create the customers row for this JWT.
    if (req.method === "POST" && segments[0] === "auth" && segments[1] === "customer" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;

      const existing = await customerForAuthUser(supabase, who.id);
      if (existing) return jsonResponse(scrub({ customer: existing, created: false }));

      // Match an existing customer by verified email, same as
      // setup-customer-account. ilike is safe here: an email cannot contain
      // the _ or % wildcards.
      const { data: byEmail, error: lookupErr } = await supabase
        .from("customers").select(CUSTOMER_FIELDS).ilike("email", who.email);
      if (lookupErr) throw lookupErr;

      const candidates = (byEmail ?? []) as AnyRec[];
      const claimed = candidates.find((c) => c.auth_user_id && c.auth_user_id !== who.id);
      if (claimed) {
        // Someone else's auth user already owns this email's customer row.
        return jsonResponse({ error: "email_already_linked" }, 409);
      }
      const unlinked = candidates.find((c) => !c.auth_user_id);
      if (unlinked) {
        const { data: linked, error: linkErr } = await supabase
          .from("customers").update({ auth_user_id: who.id })
          .eq("id", unlinked.id).is("auth_user_id", null)
          .select(CUSTOMER_FIELDS).maybeSingle();
        if (linkErr) throw linkErr;
        // A concurrent request may have taken it between the read and the
        // write; the .is() guard makes that a no-op rather than a takeover.
        if (!linked) return jsonResponse({ error: "email_already_linked" }, 409);
        return jsonResponse(scrub({ customer: linked, created: false }));
      }

      const body = await req.json().catch(() => ({}));
      const fullName = String((body as AnyRec)?.full_name ?? "").trim() || who.email.split("@")[0];
      // customer_code comes from the existing BEFORE INSERT trigger.
      // NOTE: unlike setup-customer-account, this does NOT auto-enrol in
      // loyalty — enrolment stays with join-loyalty-program so the
      // loyalty_enabled gate is honoured in one place.
      const { data: created, error: insErr } = await supabase
        .from("customers").insert({ full_name: fullName, email: who.email, auth_user_id: who.id })
        .select(CUSTOMER_FIELDS).maybeSingle();
      if (insErr) throw insErr;
      return jsonResponse(scrub({ customer: created, created: true }));
    }

    // GET /me — profile, addresses, loyalty snapshot, saved-card status.
    if (req.method === "GET" && segments[0] === "me" && !segments[1]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const [{ data: addresses, error: addrErr }, loyalty] = await Promise.all([
        supabase.from("customer_addresses")
          .select("id, label, recipient_name, line1, line2, city, region, postal_code, country, phone, is_default")
          .eq("customer_id", customer.id)
          .order("is_default", { ascending: false }).order("created_at", { ascending: true }),
        loyaltySnapshot(supabase, String(customer.id)),
      ]);
      if (addrErr) throw addrErr;

      return jsonResponse(scrub({
        customer,
        addresses: addresses ?? [],
        loyalty,
        // customer_cards arrives in step 3 (Square). Reported as false rather
        // than omitted so the storefront can render the account shell now.
        saved_card: false,
      }));
    }

    // PUT /me/addresses — replace the whole list, atomically.
    if (req.method === "PUT" && segments[0] === "me" && segments[1] === "addresses" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = await req.json().catch(() => ({}));
      const list = (body as AnyRec)?.addresses;
      if (!Array.isArray(list)) return jsonResponse({ error: "addresses_must_be_array" }, 400);

      const { data, error } = await supabase.rpc("replace_customer_addresses", {
        p_customer_id: customer.id,
        p_addresses: list,
      });
      if (error) throw error;
      const result = (data ?? {}) as AnyRec;
      // The RPC reports validation failures in its payload, not by throwing.
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(scrub(result));
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
