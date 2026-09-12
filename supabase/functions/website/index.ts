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
  "id, sku, slug, name, name_ja, karat, metals, weight_g, description_en, description_ja, status, condition, origin, brand, updated_at";
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
const nonEmpty = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
};

const COLLECTION_FIELDS = "id, slug, name, name_ja, hero_media, description, description_ja";

/**
 * Bilingual contract for jewelry types: name_en / name_ja / description_en /
 * description_ja. `name` and `description` stay as English aliases so a
 * storefront built before this change keeps rendering during the deploy gap.
 */
function shapeCollection(c: AnyRec): AnyRec {
  return {
    ...c,
    name_en: c.name ?? null,
    name_ja: nonEmpty(c.name_ja),
    description_en: nonEmpty(c.description),
    description_ja: nonEmpty(c.description_ja),
  };
}

function shapeProduct(product: AnyRec | null, fx: FxRate | null): AnyRec | null {
  if (!product) return product;
  // Bilingual contract: name_en / name_ja / description_en / description_ja
  // on every product. `name` stays as the English alias for older readers.
  product.name_en = product.name ?? null;
  product.name_ja = nonEmpty(product.name_ja);
  // Metal stamps in staff order, at least one. karat is the one-release
  // bridge (= metals[1]) and stays on the payload until the cleanup drops it.
  product.metals = Array.isArray(product.metals) && product.metals.length
    ? product.metals
    : product.karat ? [product.karat] : [];
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

/**
 * Order lines store the English title at order time (create_web_order_atomic).
 * The Japanese title is derived at read time from the product's current
 * name_ja, so a translation generated after the order still shows. A line
 * whose product is gone, or whose title no longer starts with the English
 * name (renamed since), gets title_ja = null and the site falls back to title.
 */
async function withJapaneseTitles(supabase: any, items: AnyRec[]): Promise<AnyRec[]> {
  const ids = [...new Set(items.map((i) => i.product_id).filter((id): id is string => typeof id === "string"))];
  if (!ids.length) return items.map((i) => ({ ...i, title_ja: null }));
  const { data, error } = await supabase
    .from("website_products")
    .select("id, name, name_ja")
    .in("id", ids);
  if (error) throw error;
  const byId = new Map<string, AnyRec>((data ?? []).map((p: AnyRec) => [String(p.id), p]));
  return items.map((i) => {
    const p = i.product_id ? byId.get(String(i.product_id)) : undefined;
    const en = nonEmpty(p?.name);
    const ja = nonEmpty(p?.name_ja);
    const title = String(i.title ?? "");
    const title_ja = en && ja && title.startsWith(en) ? ja + title.slice(en.length) : null;
    return { ...i, title_ja };
  });
}

/** Cart size ceiling. Generous for a jeweller, small enough to bound the loop. */
const MAX_CART_LINES = 20;

const ORDER_FIELDS =
  "id, web_reference, invoice_number, status, payment_status, payment_method, order_type, " +
  "currency, total_amount, total_paid, remaining_balance, shipping_fee, transfer_due_at, " +
  "recipient_name, gift_note, order_date, created_at, completed_at, cancelled_at, " +
  "tracking_number, shipped_at";

/**
 * create_web_order_atomic reports failures in its payload rather than throwing,
 * so the HTTP status is chosen here. 409 for "the world moved" (someone bought
 * it, the quote aged out), 404 for "not yours or not there", 501 for layaway.
 */
const CHECKOUT_ERROR_STATUS: Record<string, number> = {
  quote_not_found: 404,
  quote_expired: 409,
  quote_already_used: 409,
  out_of_stock: 409,
  variant_missing: 409,
  layaway_not_yet: 501,
  shipping_quote_required: 400,
  unsupported_method: 400,
  empty_quote: 400,
  transfer_unavailable: 409,
};

/**
 * Shipping fee for a country at a given subtotal: the active rate row with the
 * HIGHEST min_subtotal_jpy the subtotal clears. Returns null when the country
 * has no published rate — the caller must then ask for a manual quote rather
 * than shipping for free.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function shippingFor(supabase: any, country: string, subtotalJpy: number): Promise<number | null> {
  const code = (country || "").trim().toUpperCase();
  if (!code) return null;
  const { data, error } = await supabase
    .from("shipping_rates")
    .select("fee_jpy, min_subtotal_jpy")
    .eq("country", code)
    .eq("is_active", true)
    .lte("min_subtotal_jpy", subtotalJpy)
    .order("min_subtotal_jpy", { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as AnyRec | undefined;
  return row ? Number(row.fee_jpy) : null;
}

const METHOD_FIELDS =
  "id, region, method_type, label_ja, label_en, bank_name, bank_branch, account_type, " +
  "account_number, account_holder, wallet_number, wallet_name, note_ja, note_en, sort_order";

const txt = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

/**
 * Two transfer setups exist, not one per country: the yen accounts used when an
 * order ships inside Japan, and the accounts/wallets used for everywhere else.
 * Anything that is not Japan is OVERSEAS — a customer in a country nobody
 * thought to add still gets the overseas methods rather than an empty page.
 */
function regionForCountry(country: string): "JP" | "OVERSEAS" {
  const code = (country || "").trim().toUpperCase();
  return code === "JP" || code === "JPN" || code === "JAPAN" ? "JP" : "OVERSEAS";
}

/**
 * Is this row actually usable by a customer? Completeness is per method type,
 * because a half-filled method is worse than none — it looks like an account
 * and the money goes nowhere:
 *   bank         — bank name + account number + holder (branch/type are extra)
 *   gcash, maya  — wallet number + wallet name
 *   other        — a label, plus at least one detail to act on
 * This rule is mirrored in the Hub editor's status badge. If the two ever
 * disagree, an admin sees "live" while checkout hides the method, so they must
 * be changed together.
 */
function methodIsComplete(row: AnyRec): boolean {
  switch (String(row.method_type)) {
    case "bank":
      return !!(txt(row.bank_name) && txt(row.account_number) && txt(row.account_holder));
    case "gcash":
    case "maya":
      return !!(txt(row.wallet_number) && txt(row.wallet_name));
    case "other":
      return !!(
        (txt(row.label_ja) || txt(row.label_en)) &&
        (txt(row.note_ja) || txt(row.note_en) || txt(row.account_number) || txt(row.wallet_number))
      );
    default:
      return false;
  }
}

const DEFAULT_LABELS: Record<string, { ja: string; en: string }> = {
  bank: { ja: "銀行振込", en: "Bank transfer" },
  gcash: { ja: "GCash", en: "GCash" },
  maya: { ja: "Maya", en: "Maya" },
  other: { ja: "お支払い方法", en: "Payment method" },
};

/**
 * Active, complete transfer methods for a region, in the admin's order, read at
 * request time — a correction made in the Hub is live on the next page load
 * with no deploy.
 *
 * Returns [] when the region has nothing usable. That empty array is what makes
 * checkout hide transfer entirely: the old free-text design could not tell a
 * real account from a placeholder paragraph, so it had no way to know.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function transferMethods(supabase: any, country: string): Promise<AnyRec[]> {
  const region = regionForCountry(country);
  const { data, error } = await supabase
    .from("transfer_payment_methods")
    .select(METHOD_FIELDS)
    .eq("region", region)
    .eq("is_active", true)
    // created_at breaks sort_order ties so the order never shuffles between reads.
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw error;

  return ((data ?? []) as AnyRec[]).filter(methodIsComplete).map((row) => {
    const type = String(row.method_type);
    const fallback = DEFAULT_LABELS[type] ?? DEFAULT_LABELS.other;
    const bankName = txt(row.bank_name);
    const wallet = txt(row.wallet_number);
    return {
      id: row.id,
      method_type: type,
      label_ja: txt(row.label_ja) ?? fallback.ja,
      label_en: txt(row.label_en) ?? fallback.en,
      // Only the block this method actually uses is sent; the storefront renders
      // whichever is present rather than guessing from the type.
      bank: bankName
        ? {
          name: bankName,
          branch: txt(row.bank_branch),
          account_type: txt(row.account_type),
          account_number: txt(row.account_number),
          account_holder: txt(row.account_holder),
        }
        : null,
      wallet: wallet ? { number: wallet, name: txt(row.wallet_name) } : null,
      note_ja: txt(row.note_ja),
      note_en: txt(row.note_en),
    };
  });
}

/** Cheap yes/no for the checkout gate — same completeness rule, no details returned. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function transferAvailable(supabase: any, country: string): Promise<boolean> {
  return (await transferMethods(supabase, country)).length > 0;
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
        .select(COLLECTION_FIELDS)
        .order("name");
      if (error) throw error;
      return jsonResponse(scrub((data ?? []).map((c) => shapeCollection(c as AnyRec))));
    }

    // GET /catalog/collections/:slug
    if (req.method === "GET" && segments[0] === "catalog" && segments[1] === "collections" && segments[2]) {
      const slug = decodeURIComponent(segments[2]);
      const { data: collection, error } = await supabase
        .from("website_collections")
        .select(COLLECTION_FIELDS)
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

      return jsonResponse(scrub({ ...shapeCollection(collection as AnyRec), products }));
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

    // ======================================================= checkout (step 2)
    // POST /checkout/quote — price a basket. Does NOT reserve stock; the
    // decrement happens at /checkout/pay so an abandoned checkout never holds
    // a one-of-a-kind piece.
    if (req.method === "POST" && segments[0] === "checkout" && segments[1] === "quote" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = (await req.json().catch(() => ({}))) as AnyRec;
      const mode = String(body.mode ?? "full");
      if (mode === "layaway") {
        // Layaway checkout is step 4. Answered explicitly so the storefront can
        // show "coming soon" rather than a generic failure.
        return jsonResponse({ error: "not_yet" }, 501);
      }
      if (mode !== "full") return jsonResponse({ error: "bad_mode" }, 400);

      const rawItems = Array.isArray(body.items) ? (body.items as AnyRec[]) : [];
      if (rawItems.length === 0) return jsonResponse({ error: "empty_cart" }, 400);
      if (rawItems.length > MAX_CART_LINES) return jsonResponse({ error: "too_many_items" }, 400);

      const orderType = String(body.order_type ?? "SELF").toUpperCase();
      if (!["SELF", "GIFT", "PROXY"].includes(orderType)) {
        return jsonResponse({ error: "bad_order_type" }, 400);
      }

      // Shipping address must be one of THIS customer's, not any id the caller
      // knows — otherwise a quote could be priced against a stranger's country.
      const addressId = String(body.ship_to_address_id ?? "").trim();
      if (!addressId) return jsonResponse({ error: "address_required" }, 400);
      const { data: address, error: addrErr } = await supabase
        .from("customer_addresses")
        .select("id, country, recipient_name, phone")
        .eq("id", addressId).eq("customer_id", customer.id).maybeSingle();
      if (addrErr) throw addrErr;
      if (!address) return jsonResponse({ error: "address_not_found" }, 404);

      // Collapse duplicate lines before pricing so two entries for the same
      // variant are checked against stock as one quantity.
      const wanted = new Map<string, number>();
      for (const raw of rawItems) {
        const id = String(raw?.variant_id ?? "").trim();
        if (!id) return jsonResponse({ error: "variant_id_required" }, 400);
        const qty = Math.floor(Number(raw?.qty ?? 1));
        if (!Number.isFinite(qty) || qty < 1) return jsonResponse({ error: "bad_quantity" }, 400);
        wanted.set(id, (wanted.get(id) ?? 0) + qty);
      }

      const { data: variants, error: varErr } = await supabase
        .from("website_product_variants")
        .select("id, product_id, size, stone, price_jpy, stock_qty, product:website_products(id, sku, name, slug, status)")
        .in("id", [...wanted.keys()]);
      if (varErr) throw varErr;

      const found = new Map((variants ?? []).map((v: AnyRec) => [String(v.id), v]));
      const items: AnyRec[] = [];
      let subtotal = 0;
      for (const [variantId, qty] of wanted) {
        const variant = found.get(variantId) as AnyRec | undefined;
        if (!variant) return jsonResponse({ error: "variant_not_found", variant_id: variantId }, 404);
        const product = (variant.product ?? {}) as AnyRec;
        if (product.status !== "active") {
          return jsonResponse({ error: "product_unavailable", variant_id: variantId }, 409);
        }
        if (Number(variant.stock_qty ?? 0) < qty) {
          return jsonResponse({
            error: "out_of_stock",
            variant_id: variantId,
            available: Number(variant.stock_qty ?? 0),
          }, 409);
        }
        const unit = Number(variant.price_jpy ?? 0);
        subtotal += unit * qty;
        items.push({
          variant_id: variantId,
          product_id: product.id ?? variant.product_id,
          sku: product.sku ?? null,
          slug: product.slug ?? null,
          name: [product.name, variant.size, variant.stone].filter(Boolean).join(" / "),
          name_en: [product.name, variant.size, variant.stone].filter(Boolean).join(" / "),
          name_ja: nonEmpty(product.name_ja)
            ? [product.name_ja, variant.size, variant.stone].filter(Boolean).join(" / ")
            : null,
          qty,
          unit_price_jpy: unit,
          line_total_jpy: unit * qty,
        });
      }

      const shipping = await shippingFor(supabase, String(address.country ?? ""), subtotal);
      const total = subtotal + (shipping ?? 0);

      const { data: quote, error: quoteErr } = await supabase
        .from("checkout_quotes")
        .insert({
          customer_id: customer.id,
          items,
          mode: "full",
          order_type: orderType,
          ship_to_address_id: address.id,
          // Recipient details only mean something for a gift or proxy order.
          recipient_name: orderType === "SELF" ? null : (String(body.recipient_name ?? "").trim() || null),
          recipient_phone: orderType === "SELF" ? null : (String(body.recipient_phone ?? "").trim() || null),
          gift_note: orderType === "GIFT" ? (String(body.gift_note ?? "").trim() || null) : null,
          subtotal_jpy: subtotal,
          shipping_jpy: shipping,
          total_jpy: total,
        })
        .select("id, expires_at")
        .maybeSingle();
      if (quoteErr) throw quoteErr;

      const quoteMethods = await transferMethods(supabase, String(address.country ?? ""));

      return jsonResponse(scrub({
        quote_id: quote?.id,
        items,
        subtotal_jpy: subtotal,
        shipping_jpy: shipping,
        total_jpy: total,
        // null shipping means we do not ship there at a published rate — the
        // storefront must stop and ask, never assume free.
        requires_manual_quote: shipping === null,
        // Lets the payment step render the real methods, and hide transfer
        // entirely rather than offering one that /checkout/pay would refuse.
        // Methods are region-scoped here, not filtered in the browser: the
        // other region's account details never reach the page at all.
        transfer_region: regionForCountry(String(address.country ?? "")),
        transfer_methods: quoteMethods,
        transfer_available: quoteMethods.length > 0,
        order_type: orderType,
        expires_at: quote?.expires_at,
      }));
    }

    // POST /checkout/pay — turn a quote into a real order.
    if (req.method === "POST" && segments[0] === "checkout" && segments[1] === "pay" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = (await req.json().catch(() => ({}))) as AnyRec;
      const method = String(body.method ?? "transfer");
      if (method === "square") return jsonResponse({ error: "not_yet" }, 501);
      if (method !== "transfer") return jsonResponse({ error: "bad_method" }, 400);
      const quoteId = String(body.quote_id ?? "").trim();
      if (!quoteId) return jsonResponse({ error: "quote_id_required" }, 400);

      // Everything that matters — re-price, stock decrement, order, items,
      // quote consumption — happens inside this one transaction.
      // Refuse BEFORE the order exists when the destination has no usable
      // transfer details. Server-side, not just a disabled button: an order
      // created with nowhere to send the money is worse than no order.
      const { data: quoteRow } = await supabase
        .from("checkout_quotes")
        .select("ship_to_address:customer_addresses(country)")
        .eq("id", quoteId).eq("customer_id", customer.id).maybeSingle();
      const quoteCountry = String(
        ((quoteRow as AnyRec | null)?.ship_to_address as AnyRec | undefined)?.country ?? "JP",
      );
      if (!(await transferAvailable(supabase, quoteCountry))) {
        return jsonResponse({
          error: "transfer_unavailable",
          region: regionForCountry(quoteCountry),
        }, 409);
      }

      const { data, error } = await supabase.rpc("create_web_order_atomic", {
        p_customer_id: customer.id,
        p_quote_id: quoteId,
        p_method: "transfer",
      });
      if (error) throw error;
      const result = (data ?? {}) as AnyRec;
      if (result.error) {
        const status = CHECKOUT_ERROR_STATUS[String(result.error)] ?? 400;
        return jsonResponse(result, status);
      }

      // Country comes from the order that was just written, not from the
      // request body — the instructions shown must match where it ships.
      const { data: placed } = await supabase
        .from("cash_orders")
        .select("ship_to_address:customer_addresses(country)")
        .eq("id", String(result.order_id)).maybeSingle();
      const country = String(
        ((placed as AnyRec | null)?.ship_to_address as AnyRec | undefined)?.country ?? "JP",
      );

      return jsonResponse(scrub({
        order_id: result.order_id,
        web_reference: result.web_reference,
        total_jpy: result.total_jpy,
        transfer_due_at: result.transfer_due_at,
        transfer_region: regionForCountry(country),
        transfer_methods: await transferMethods(supabase, country),
      }));
    }

    // GET /orders — this customer's orders, newest first.
    if (req.method === "GET" && segments[0] === "orders" && !segments[1]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const { data, error } = await supabase
        .from("cash_orders")
        .select(ORDER_FIELDS)
        .eq("customer_id", customer.id)
        .eq("source_channel", "web")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return jsonResponse(scrub(data ?? []));
    }

    // GET /orders/:id — one of this customer's orders, with its lines.
    if (req.method === "GET" && segments[0] === "orders" && segments[1] && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      // Scoped by customer_id as well as id: an order id alone must never be
      // enough to read someone else's order.
      const { data: order, error } = await supabase
        .from("cash_orders")
        .select(`${ORDER_FIELDS}, ship_to_address:customer_addresses(id, recipient_name, line1, line2, city, region, postal_code, country, phone)`)
        .eq("id", segments[1])
        .eq("customer_id", customer.id)
        .eq("source_channel", "web")
        .maybeSingle();
      if (error) throw error;
      if (!order) return notFound();

      const { data: items, error: itemErr } = await supabase
        .from("cash_order_items")
        .select("id, variant_id, product_id, title, sku, quantity, unit_price_jpy, line_total_jpy, image_url")
        .eq("cash_order_id", order.id)
        .order("created_at");
      if (itemErr) throw itemErr;
      const lines = await withJapaneseTitles(supabase, (items ?? []) as AnyRec[]);

      const country = String((order as AnyRec).ship_to_address
        ? ((order as AnyRec).ship_to_address as AnyRec).country ?? "JP"
        : "JP");

      return jsonResponse(scrub({
        order,
        items: lines,
        transfer_region: regionForCountry(country),
        // Methods are only actionable while the transfer is outstanding.
        transfer_methods: (order as AnyRec).payment_status === "pending_transfer"
          ? await transferMethods(supabase, country)
          : [],
      }));
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
