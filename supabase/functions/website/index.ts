import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { pickLang, sendStorefrontEmail, storefrontLayawayUrl, storefrontOrderUrl } from "../_shared/storefront-email.ts";
import { OrderConfirmationEmail, orderConfirmationSubject } from "../_shared/email-templates/order-confirmation.tsx";
import { LayawayPlanCreatedEmail, layawayPlanCreatedSubject } from "../_shared/email-templates/layaway-plan-created.tsx";
import type { OrderEmailMethod } from "../_shared/email-templates/order-shared.tsx";
import * as React from "npm:react@18.3.1";
import { resolveItemImages } from "../_shared/item-images.ts";

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
const CUSTOMER_FIELDS = "id, customer_code, full_name, email, mobile_number, auth_user_id, is_test";

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
    .select("remaining_points, cumulative_spend_jpy, current_tier_id, is_downgraded, downgrade_spend_baseline, loyalty_tiers:current_tier_id(name, points_multiplier), earned:earned_tier_id(name, requalify_spend_jpy)")
    .eq("customer_id", customerId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { enrolled: false, points: 0, tier: null, multiplier: null, reduced: false, earned_tier: null, regain_jpy: null };
  const row = data as AnyRec;
  const tier = row.loyalty_tiers as AnyRec | null;
  const earned = row.earned as AnyRec | null;
  // Step-down state (2026-09-13): the level is temporarily reduced after 180
  // days of inactivity; regain_jpy = the earned level's requalify_spend minus
  // spend since the step-down, floored at 0. Only meaningful when reduced.
  const reduced = row.is_downgraded === true;
  let regain: number | null = null;
  if (reduced && earned?.requalify_spend_jpy != null) {
    const baseline = row.downgrade_spend_baseline == null ? null : Number(row.downgrade_spend_baseline);
    const since = baseline == null ? 0 : Math.max(0, Number(row.cumulative_spend_jpy ?? 0) - baseline);
    regain = Math.max(0, Number(earned.requalify_spend_jpy) - since);
  }
  return {
    enrolled: true,
    points: Number(row.remaining_points ?? 0),
    tier: tier?.name ?? null,
    multiplier: tier?.points_multiplier === undefined || tier?.points_multiplier === null
      ? null
      : Number(tier.points_multiplier),
    reduced,
    earned_tier: reduced ? (earned?.name ?? null) : null,
    regain_jpy: regain,
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

const CATEGORY_FIELDS =
  "id, slug, name, name_ja, description, description_ja, hero_media, cta_label, cta_label_ja, sort_order";

/**
 * Attaches category_slugs to each product: the slugs of the PUBLISHED
 * categories the product belongs to (unpublished categories are not a public
 * surface, so their slugs must not leak). Empty array when uncategorised.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function attachCategorySlugs(supabase: any, products: AnyRec[]): Promise<AnyRec[]> {
  const ids = products.map((p) => String(p.id ?? "")).filter(Boolean);
  if (!ids.length) return products.map((p) => ({ ...p, category_slugs: [] as string[] }));
  const { data, error } = await supabase
    .from("website_category_products")
    .select("product_id, category:website_categories!website_category_products_category_id_fkey(slug, published)")
    .in("product_id", ids);
  if (error) throw error;
  const byProduct = new Map<string, string[]>();
  for (const row of (data ?? []) as AnyRec[]) {
    const cat = row.category as AnyRec | null;
    if (!cat || cat.published !== true) continue;
    const slug = nonEmpty(cat.slug);
    if (!slug) continue;
    const pid = String(row.product_id);
    byProduct.set(pid, [...(byProduct.get(pid) ?? []), slug]);
  }
  return products.map((p) => ({ ...p, category_slugs: byProduct.get(String(p.id)) ?? [] }));
}

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
  "tracking_number, shipped_at, " +
  // Cancelled orders stay in the customer's history with the reason and the
  // refund decision; a lapse carries expired_at.
  "cancellation_reason, refund_status, refund_note, expired_at, source_channel";

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
  // Layaway (step 4)
  not_a_layaway_quote: 400,
  full_not_layaway: 400,
  below_plan_minimum: 409,
  fx_rate_missing: 503,
};

/** What a customer may see of their own layaway plan. */
/**
 * The delivery address an order page should show.
 *
 * `ship_to_snapshot` is AUTHORITATIVE. It is the address as it stood when the
 * order was written, so nothing the customer later does to their address book
 * can move where a past order went. The embedded FK row is only a fallback,
 * for an order written before 20260915160000 whose snapshot the backfill could
 * not reach — and it legitimately reads NULL, because
 * cash_orders.ship_to_address_id is ON DELETE SET NULL.
 *
 * Both are normalised to one shape so the storefront sees no difference.
 */
function shipToAddress(snapshot: unknown, embedded: unknown): AnyRec | null {
  const s = snapshot as AnyRec | null;
  if (s && typeof s === "object") {
    return {
      id: s.address_id ?? null,
      label: s.label ?? null,
      recipient_name: s.recipient_name ?? null,
      line1: s.line1 ?? null,
      line2: s.line2 ?? null,
      city: s.city ?? null,
      region: s.region ?? null,
      postal_code: s.postal_code ?? null,
      country: s.country ?? null,
      phone: s.phone ?? null,
    };
  }
  return (embedded as AnyRec | null) ?? null;
}

const LAYAWAY_FIELDS =
  "id, web_reference, invoice_number, status, currency, total_amount, total_paid, " +
  "remaining_balance, downpayment_amount, payment_plan_months, shipping_fee, " +
  "order_date, end_date, transfer_due_at, expired_at, " +
  "created_at, completed_at, tracking_number, shipped_at, source_channel";

/**
 * Today in PHT (CLAUDE.md TIMEZONE STANDARD). The schedule is anchored to it at
 * quote time and the SAME date is handed to the create RPC, so a checkout that
 * straddles UTC midnight cannot quote one set of due dates and write another.
 */
function phtToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

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
 * Which set of accounts a currency is paid into. This is what `transfer_region`
 * on the wire has always meant — "which accounts is this paid into" — so it is
 * derived from the currency, exactly like the methods sent beside it. Deriving
 * it from the shipping address instead is what let a response carry a yen-only
 * Rakuten account under a peso plan (fixed 2026-09-15).
 *
 * There is deliberately no regionForCountry() companion any more. Every call
 * site the old one had was either the bank lookup or this label that describes
 * it; shipping goes through shippingFor(), which reads shipping_rates by
 * country directly and never consulted a region. Keeping a country->region
 * helper alive would only invite the two questions to be confused again.
 */
function regionForCurrency(currency: string): "JP" | "OVERSEAS" {
  return String(currency ?? "").trim().toUpperCase() === "PHP" ? "OVERSEAS" : "JP";
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
 * Active, complete transfer methods for a SETTLEMENT CURRENCY, in the admin's
 * order, read at request time — a correction made in the Hub is live on the
 * next page load with no deploy.
 *
 * Keyed on currency, not on the shipping country (changed 2026-09-15). The
 * account a customer pays into has to be able to RECEIVE what they chose to pay
 * in: Rakuten takes yen, Metrobank takes pesos, and a Japan-resident customer
 * settling a plan in pesos must be shown the peso account. Selecting by
 * destination showed them Rakuten and left the plan unpayable.
 *
 * Returns [] when no active, complete method accepts that currency. That empty
 * array is what makes checkout refuse the currency rather than print an account
 * the money cannot reach: the old free-text design could not tell a real
 * account from a placeholder paragraph, so it had no way to know.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function transferMethods(supabase: any, currency: string): Promise<AnyRec[]> {
  const cur = String(currency ?? "").trim().toUpperCase() === "PHP" ? "PHP" : "JPY";
  const { data, error } = await supabase
    .from("transfer_payment_methods")
    .select(METHOD_FIELDS)
    .eq("currency", cur)
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
async function transferAvailable(supabase: any, currency: string): Promise<boolean> {
  return (await transferMethods(supabase, currency)).length > 0;
}

function notFound() {
  return jsonResponse({ error: "not_found" }, 404);
}

// Every response carries x-request-id and every error body carries request_id,
// so a failure the shopper sees ("Ref: …") can be matched to the one log line
// that names its cause. The storefront may pass its own id through.
Deno.serve(async (req) => {
  const requestId = req.headers.get("x-request-id")?.trim() || crypto.randomUUID();
  const res = await handle(req, requestId);
  try { res.headers.set("x-request-id", requestId); } catch { /* immutable headers: body still carries it */ }
  return res;
});

async function handle(req: Request, requestId: string): Promise<Response> {
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
      // A storefront enrollment FAILED — raise it in the staff bell so staff
      // enroll the customer by hand. Never fail the request over this.
      try {
        let matchedCustomerId: string | null = null;
        const { data: matches } = await supabase
          .from("customers").select("id").ilike("email", contact).limit(2);
        if (matches && matches.length === 1) matchedCustomerId = matches[0].id;
        await supabase.rpc("staff_notify", {
          p_type: "loyalty_join_failed",
          p_title: "Storefront loyalty enrollment failed",
          p_body: `${name} (${contact}) asked to join the loyalty program on the website, `
            + "but the enrollment did not complete. Enroll this customer manually.",
          p_account_id: null,
          p_customer_id: matchedCustomerId,
          p_invoice: null,
          p_meta: { source: "website_loyalty_join", contact, region, lang },
        });
      } catch { /* never fail the signup record over a notification */ }
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
      // ORDERED, deliberately (2026-09-15). Eight addresses in live data are
      // shared by sixteen customer rows, so this lookup can return more than
      // one and `.find()` below would otherwise pick whatever Postgres happened
      // to return first — a different row on different days for the same
      // person. created_at ASC then id makes the choice total and repeatable:
      // the OLDEST matching row wins, which is the one the customer's history
      // was built against.
      const { data: byEmail, error: lookupErr } = await supabase
        .from("customers").select(CUSTOMER_FIELDS).ilike("email", who.email)
        .order("created_at", { ascending: true }).order("id", { ascending: true });
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

      const [
        { data: addresses, error: addrErr },
        loyalty,
        { count: layawayCount },
        { count: orderCount },
        { count: sameEmailRows },
        portalUrl,
      ] = await Promise.all([
        supabase.from("customer_addresses")
          .select("id, label, recipient_name, line1, line2, city, region, postal_code, country, phone, is_default")
          .eq("customer_id", customer.id)
          .order("is_default", { ascending: false }).order("created_at", { ascending: true }),
        loyaltySnapshot(supabase, String(customer.id)),
        // Counts, not rows: the account page needs to tell "you have nothing
        // with us" apart from "this sign-in reached the wrong record", and it
        // must be able to do that without fetching two more lists.
        supabase.from("layaway_accounts")
          .select("id", { count: "exact", head: true }).eq("customer_id", customer.id),
        supabase.from("cash_orders")
          .select("id", { count: "exact", head: true }).eq("customer_id", customer.id),
        // Does another customer row carry this same email? See the blank-record
        // branch below for why that question is worth asking.
        customer.email
          ? supabase.from("customers")
              .select("id", { count: "exact", head: true })
              .ilike("email", String(customer.email)).neq("id", customer.id)
          : Promise.resolve({ count: 0 }),
        // The Hub's own builder — bare URL for a linked customer, their token
        // for a legacy one, and the bare URL when no valid token remains. It is
        // the single source of portal links; this route does not build its own.
        buildPortalLinkForCustomerId(supabase, String(customer.id), "portal"),
      ]);
      if (addrErr) throw addrErr;

      const records = { layaway: layawayCount ?? 0, orders: orderCount ?? 0 };
      const sharesEmail = (sameEmailRows ?? 0) > 0;

      // A SIGN-IN THAT REACHES A RECORD WITH NOTHING ON IT IS REPORTED, NOT
      // RENDERED BLANK (2026-09-15). Six known customers have a duplicate row
      // whose twin holds their plan; the auth user is linked to the empty one,
      // so `/auth/customer` returns it with no error and the account page used
      // to render as if they had never bought anything. Staff can fix the data;
      // the customer cannot, so the bell is where this goes. The customer is
      // told something truthful and non-technical instead (storefront copy).
      // Deduped to one bell per customer per day, the same way
      // recordEmailAttempt throttles its refusal alert.
      if (records.layaway === 0 && records.orders === 0 && sharesEmail) {
        try {
          const { count: recent } = await supabase
            .from("staff_notifications")
            .select("id", { count: "exact", head: true })
            .eq("type", "portal_blank_account")
            .eq("customer_id", customer.id)
            .gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
          if (!recent) {
            await supabase.rpc("staff_notify", {
              p_type: "portal_blank_account",
              p_title: "Website sign-in reached an empty customer record",
              p_body: `${customer.full_name ?? "A customer"} (${customer.customer_code ?? "no code"}) `
                + `signed in at ${customer.email} and has no orders and no plans on this record, `
                + "while another customer row carries the same email. Their history is most likely on the other row.",
              p_account_id: null,
              p_customer_id: customer.id,
              p_invoice: null,
              p_meta: { source: "website_me", email: customer.email, same_email_rows: sameEmailRows ?? 0 },
            });
          }
        } catch { /* never fail a profile read over a notification */ }
      }

      return jsonResponse(scrub({
        customer,
        addresses: addresses ?? [],
        loyalty,
        // How much history this record actually holds. The storefront reads it
        // to choose between "nothing yet" and "we cannot see your records".
        records,
        // True when another customer row shares this email. Surfaced to the
        // storefront so it can soften its wording, NOT shown to the customer as
        // a fact about another record.
        shares_email: sharesEmail,
        // Where every action still lives.
        portal_url: portalUrl,
        // customer_cards arrives in step 3 (Square). Reported as false rather
        // than omitted so the storefront can render the account shell now.
        saved_card: false,
      }));
    }

    // PUT /me/addresses — save the customer's list, atomically and WITHOUT
    // deleting. Entries carrying an id update that row in place; entries
    // without one are new; a row the payload does not mention is left alone.
    // It used to replace the list by DELETE-then-INSERT, which minted fresh
    // uuids and, through two ON DELETE SET NULL foreign keys, blanked the
    // shipping address on every past order and quote — on every checkout that
    // sent an address. See 20260915160000.
    if (req.method === "PUT" && segments[0] === "me" && segments[1] === "addresses" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = await req.json().catch(() => ({}));
      const list = (body as AnyRec)?.addresses;
      if (!Array.isArray(list)) return jsonResponse({ error: "addresses_must_be_array" }, 400);

      const { data, error } = await supabase.rpc("upsert_customer_addresses", {
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
      if (mode !== "full" && mode !== "layaway") return jsonResponse({ error: "bad_mode" }, 400);

      // Settlement currency (owner decision 2026-09-13): the customer chooses
      // yen or pesos and the Hub account follows. Full-payment orders stay in
      // yen for now — create_web_order_atomic writes 'JPY' — so the choice is
      // offered on layaway only.
      const settlement = String(body.settlement_currency ?? "JPY").toUpperCase();
      if (!["JPY", "PHP"].includes(settlement)) return jsonResponse({ error: "bad_currency" }, 400);
      if (mode === "full" && settlement !== "JPY") return jsonResponse({ error: "currency_not_supported_for_full" }, 400);

      const termMonths = Math.floor(Number(body.term_months ?? 0));
      if (mode === "layaway" && (!Number.isFinite(termMonths) || termMonths < 1)) {
        return jsonResponse({ error: "term_required" }, 400);
      }

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

      // The rate the customer is shown is the rate they are charged: it is
      // captured on the quote, and the quote's 30-minute life is the only window
      // it can drift in.
      let fxRate: number | null = null;
      let fxDate: string | null = null;
      if (settlement === "PHP") {
        const fx = await latestFx(supabase);
        if (!fx) return jsonResponse({ error: "fx_unavailable" }, 503);
        fxRate = fx.jpy_php;
        fxDate = fx.as_of;
      }
      // Shipping is converted and the subtotal is the remainder, so the parts
      // always sum to the total exactly — converting each and adding can differ
      // by one peso.
      const toSettle = (jpy: number) => (fxRate === null ? jpy : Math.round(jpy * fxRate));
      const totalSettle = toSettle(total);
      const shippingSettle = shipping === null ? null : toSettle(shipping);
      const subtotalSettle = totalSettle - (shippingSettle ?? 0);

      // Layaway terms, deposit and dated schedule come from the Hub's own
      // function, per settlement currency — so the site can only ever offer a
      // term plan_configurations allows and this order's amount clears.
      const orderDate = phtToday();
      let layaway: AnyRec | null = null;
      if (mode === "layaway") {
        if (shipping === null) return jsonResponse({ error: "shipping_quote_required" }, 400);
        const { data: lq, error: lqErr } = await supabase.rpc("layaway_quote", {
          p_price: subtotalSettle,
          p_term_months: termMonths,
          p_currency: settlement,
          p_order_date: orderDate,
          p_shipping: shippingSettle ?? 0,
          p_services: 0,
        });
        if (lqErr) throw lqErr;
        layaway = (lq ?? {}) as AnyRec;
        // Two refusals, one answer. Either nothing is sellable at this amount,
        // or the term asked for is not reachable and the SQL fell back to a
        // shorter one. A shorter term means bigger monthly payments, so the
        // customer is never quoted a plan they did not choose — the site shows
        // allowed_terms and asks them to pick again. create_web_layaway_atomic
        // makes the same check at pay time, so the two can never disagree.
        if (!layaway.eligible || layaway.term_downgraded) {
          return jsonResponse({
            error: "below_plan_minimum",
            total: totalSettle,
            currency: settlement,
            requested_term_months: termMonths,
            max_term_months: layaway.max_term_months ?? null,
            allowed_terms: layaway.allowed_terms ?? [],
          }, 409);
        }
      }

      const { data: quote, error: quoteErr } = await supabase
        .from("checkout_quotes")
        .insert({
          customer_id: customer.id,
          items,
          mode,
          term_months: mode === "layaway" ? Number(layaway?.term_months ?? termMonths) : null,
          // Yen figures stay yen: they are the catalog truth and the loyalty
          // basis. The settlement currency and its rate travel beside them.
          // JPY = PHP / rate (CLAUDE.md CURRENCY CONVERSION STANDARD — divide to
          // go peso to yen). For a yen plan the deposit is already yen.
          deposit_jpy: mode !== "layaway"
            ? null
            : fxRate === null
              ? Number(layaway?.deposit ?? 0)
              : Math.round(Number(layaway?.deposit ?? 0) / fxRate),
          // The schedule as the customer saw it, in the settlement currency.
          schedule: mode === "layaway" ? (layaway?.schedule ?? null) : null,
          settlement_currency: settlement,
          fx_rate: fxRate,
          fx_rate_date: fxDate,
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
        .select("id, expires_at, reserved_invoice_seq")
        .maybeSingle();
      if (quoteErr) throw quoteErr;

      // Keyed on the settlement currency the customer chose, not on where the
      // parcel goes: the account has to be able to receive what they pay in.
      const quoteMethods = await transferMethods(supabase, settlement);

      // The same function the creation RPCs default from. null when it cannot
      // be read — the storefront then omits the number instead of guessing.
      let depositDeadlineHours: number | null = null;
      {
        const { data: hrs, error: hrsErr } = await supabase
          .rpc("web_deposit_deadline_hours", { p_customer_id: customer.id });
        if (hrsErr) {
          console.warn("[website] web_deposit_deadline_hours failed:", hrsErr.message);
        } else if (typeof hrs === "number" && Number.isFinite(hrs)) {
          depositDeadlineHours = hrs;
        }
      }

      return jsonResponse(scrub({
        quote_id: quote?.id,
        // THE INVOICE NUMBER, ALREADY. A layaway quote draws its number from
        // web_order_number_seq at insert (trigger trg_checkout_quotes_reserve_
        // invoice), and create_web_layaway_atomic uses that same number, so the
        // agreement can be signed against the plan's real invoice before the
        // plan exists. Both null for a full-payment quote. The reference is
        // built here exactly as the SQL builds it: 'CJ-W-' || lpad(seq, 6, '0').
        invoice_number: quote?.reserved_invoice_seq == null ? null : String(quote.reserved_invoice_seq),
        web_reference: quote?.reserved_invoice_seq == null ? null : "CJ-W-" + String(quote.reserved_invoice_seq).padStart(6, "0"),
        items,
        subtotal_jpy: subtotal,
        shipping_jpy: shipping,
        total_jpy: total,
        // What the customer pays in, and what the plan looks like in it.
        mode,
        settlement_currency: settlement,
        fx_rate: fxRate,
        fx_rate_date: fxDate,
        subtotal_settlement: subtotalSettle,
        shipping_settlement: shippingSettle,
        total_settlement: totalSettle,
        layaway: layaway
          ? {
              term_months: layaway.term_months,
              deposit: layaway.deposit,
              monthly: layaway.monthly,
              last_month: layaway.last_month,
              schedule: layaway.schedule,
              allowed_terms: layaway.allowed_terms,
            }
          : null,
        // null shipping means we do not ship there at a published rate — the
        // storefront must stop and ask, never assume free.
        requires_manual_quote: shipping === null,
        // Lets the payment step render the real methods, and hide transfer
        // entirely rather than offering one that /checkout/pay would refuse.
        // Methods are region-scoped here, not filtered in the browser: the
        // other region's account details never reach the page at all.
        transfer_region: regionForCurrency(settlement),
        transfer_methods: quoteMethods,
        transfer_available: quoteMethods.length > 0,
        order_type: orderType,
        expires_at: quote?.expires_at,
        // HOW LONG THEY WILL HAVE TO SEND THE DEPOSIT — 24 hours on a first
        // order, 72 when they have ordered before. The checkout copy has to
        // state the number BEFORE the order exists, and the number the
        // creation RPC will actually store is decided by the same SQL
        // function, so the two cannot disagree. Read here rather than
        // recomputed: one rule, in one place.
        //
        // Deliberately not defaulted on failure. A storefront that receives
        // nothing says the deadline without a number rather than inventing
        // one, which is the whole defect this replaces.
        deposit_deadline_hours: depositDeadlineHours,
      }));
    }

    // GET /checkout/quote/:id — read back a quote this customer already took.
    //
    // WHY THIS EXISTS. The layaway agreement is signed on another site, so the
    // customer leaves the checkout and comes back. `checkout_quotes.id` is the
    // handle the signature is keyed on, so it — not a fresh quote — is what
    // must still be paid against when they return: re-quoting would mint a new
    // id and orphan the signature they just gave. The storefront holds its
    // checkout state in React only, so on a same-tab return it has the id from
    // the URL and nothing else. This is how it gets the figures back.
    //
    // READ-ONLY, AND SCOPED TO THE CALLER. The customer_id filter is what makes
    // another customer's quote a 404 rather than a disclosure — the same rule
    // create_web_layaway_atomic applies when it answers quote_not_found.
    //
    // Derived, not cached: the layaway block comes from layaway_quote and the
    // methods from transfer_methods, exactly as POST /checkout/quote builds
    // them, so a re-read cannot disagree with the original answer. The stored
    // yen figures and the stored rate are the only inputs.
    if (req.method === "GET" && segments[0] === "checkout" && segments[1] === "quote" && segments[2] && !segments[3]) {
      // WHO IS ASKING. `customer` is bound per route handler in this file, never
      // at file scope, so every authed route opens with these four lines — and
      // this one shipped without them. They are not ceremony: without
      // customerForAuthUser there is no customer_id to scope the read by, and
      // the "another customer's quote is a 404, not a disclosure" guarantee
      // below would have been a comment describing nothing.
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const quoteId = decodeURIComponent(segments[2]).trim();
      if (!quoteId) return jsonResponse({ error: "quote_id_required" }, 400);

      const { data: q, error: qErr } = await supabase
        .from("checkout_quotes")
        .select("id, items, mode, term_months, order_type, recipient_name, recipient_phone, gift_note, subtotal_jpy, shipping_jpy, total_jpy, settlement_currency, fx_rate, fx_rate_date, expires_at, consumed_at, ship_to_address_id, reserved_invoice_seq")
        .eq("id", quoteId)
        .eq("customer_id", customer.id)
        .maybeSingle();
      if (qErr) throw qErr;
      if (!q) return notFound();

      const row = q as AnyRec;
      // A spent quote is gone for good — consumed_at is set inside the writer's
      // transaction. Saying so plainly lets the storefront re-price instead of
      // showing figures it can no longer act on.
      if (row.consumed_at) return jsonResponse({ error: "quote_already_used" }, 409);
      if (row.expires_at && new Date(String(row.expires_at)) <= new Date()) {
        return jsonResponse({ error: "quote_expired" }, 409);
      }

      const settlement = String(row.settlement_currency ?? "JPY");
      const fxRate = row.fx_rate === null || row.fx_rate === undefined ? null : Number(row.fx_rate);
      const subtotalJpy = Number(row.subtotal_jpy ?? 0);
      const shippingJpy = row.shipping_jpy === null || row.shipping_jpy === undefined ? null : Number(row.shipping_jpy);
      const totalJpy = Number(row.total_jpy ?? 0);

      // Same arithmetic as the POST: shipping is converted and the subtotal is
      // the remainder, so the parts sum to the total exactly.
      const toSettle = (jpy: number) => (fxRate === null ? jpy : Math.round(jpy * fxRate));
      const totalSettle = toSettle(totalJpy);
      const shippingSettle = shippingJpy === null ? null : toSettle(shippingJpy);
      const subtotalSettle = totalSettle - (shippingSettle ?? 0);

      let layawayOut: AnyRec | null = null;
      if (String(row.mode ?? "full") === "layaway") {
        const { data: lq, error: lqErr } = await supabase.rpc("layaway_quote", {
          p_price: subtotalSettle,
          p_term_months: Number(row.term_months ?? 3),
          p_currency: settlement,
          p_order_date: phtToday(),
          p_shipping: shippingSettle ?? 0,
          p_services: 0,
        });
        if (lqErr) throw lqErr;
        const lay = (lq ?? {}) as AnyRec;
        layawayOut = {
          term_months: lay.term_months,
          deposit: lay.deposit,
          monthly: lay.monthly,
          last_month: lay.last_month,
          schedule: lay.schedule,
          allowed_terms: lay.allowed_terms,
        };
      }

      const methods = await transferMethods(supabase, settlement);

      let depositDeadlineHours: number | null = null;
      {
        const { data: hrs, error: hrsErr } = await supabase
          .rpc("web_deposit_deadline_hours", { p_customer_id: customer.id });
        if (hrsErr) {
          console.warn("[website] web_deposit_deadline_hours failed:", hrsErr.message);
        } else if (typeof hrs === "number" && Number.isFinite(hrs)) {
          depositDeadlineHours = hrs;
        }
      }

      // The same shape POST /checkout/quote answers with, so the storefront has
      // one type for a quote however it was obtained.
      return jsonResponse(scrub({
        quote_id: row.id,
        // Same two keys, same construction as POST /checkout/quote.
        invoice_number: row.reserved_invoice_seq == null ? null : String(row.reserved_invoice_seq),
        web_reference: row.reserved_invoice_seq == null ? null : "CJ-W-" + String(row.reserved_invoice_seq).padStart(6, "0"),
        items: row.items ?? [],
        subtotal_jpy: subtotalJpy,
        shipping_jpy: shippingJpy,
        total_jpy: totalJpy,
        mode: row.mode ?? "full",
        settlement_currency: settlement,
        fx_rate: fxRate,
        fx_rate_date: row.fx_rate_date ?? null,
        subtotal_settlement: subtotalSettle,
        shipping_settlement: shippingSettle,
        total_settlement: totalSettle,
        layaway: layawayOut,
        requires_manual_quote: shippingJpy === null,
        transfer_region: regionForCurrency(settlement),
        transfer_methods: methods,
        transfer_available: methods.length > 0,
        order_type: row.order_type ?? "SELF",
        expires_at: row.expires_at,
        deposit_deadline_hours: depositDeadlineHours,
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
      // The language the storefront was in. Stored on the order so every
      // later email about it (payment received, expired) reads the same.
      const lang = pickLang(body.lang);

      // Everything that matters — re-price, stock decrement, order, items,
      // quote consumption — happens inside this one transaction.
      // Refuse BEFORE the order exists when nothing can take the money.
      // Server-side, not just a disabled button: an order created with nowhere
      // to send the money is worse than no order.
      const { data: quoteRow } = await supabase
        .from("checkout_quotes")
        .select("mode, settlement_currency")
        .eq("id", quoteId).eq("customer_id", customer.id).maybeSingle();
      // Refuse BEFORE the order exists when nothing can receive the currency the
      // quote was taken in. Currency-scoped on purpose: the other currency stays
      // available, so the customer's escape is the toggle they already have
      // rather than a dead checkout.
      const quoteSettlement = String((quoteRow as AnyRec | null)?.settlement_currency ?? "JPY");
      if (!(await transferAvailable(supabase, quoteSettlement))) {
        return jsonResponse({
          error: "transfer_unavailable",
          currency: quoteSettlement,
          region: regionForCurrency(quoteSettlement),
        }, 409);
      }

      // ── Layaway: a reservation, not a purchase ────────────────────────────
      // The piece is held and the deposit has a deadline. Everything that
      // matters — re-pricing, the schedule, the stock hold, consuming the quote
      // — happens inside create_web_layaway_atomic.
      if (String((quoteRow as AnyRec | null)?.mode ?? "full") === "layaway") {
        // THE SIGNED AGREEMENT, AS THE STOREFRONT VERIFIED IT.
        // The storefront checks the signing record (a Google Sheet row, read
        // through the Apps Script that owns it) server-side before it calls
        // this, and fails closed when it cannot. It passes what the customer
        // actually signed; the plan records that and nothing invented.
        // Never a literal: the Hub's own NewCashOrder.tsx hardcodes 'v1' and
        // has been wrong against the live agreement ever since.
        // Absent stays absent — a caller that sends neither writes two NULLs,
        // exactly as before this field existed.
        const agreementVersion = String(body.agreement_version ?? "").trim() || null;
        const agreementSignedAtRaw = String(body.agreement_signed_at ?? "").trim();
        const agreementSignedAt = agreementSignedAtRaw && !Number.isNaN(Date.parse(agreementSignedAtRaw))
          ? new Date(agreementSignedAtRaw).toISOString()
          : null;

        const { data: lay, error: layErr } = await supabase.rpc("create_web_layaway_atomic", {
          p_customer_id: customer.id,
          p_quote_id: quoteId,
          p_lang: lang,
          p_transfer_due_at: null,     // default 72 hours; staff may move it later
          p_order_date: phtToday(),
          p_agreement_version: agreementVersion,
          p_agreement_signed_at: agreementSignedAt,
        });
        if (layErr) throw layErr;
        const plan = (lay ?? {}) as AnyRec;
        if (plan.error) {
          const status = CHECKOUT_ERROR_STATUS[String(plan.error)] ?? 400;
          console.warn("website layaway refused", requestId, String(plan.error));
          return jsonResponse({ ...plan, request_id: requestId }, status);
        }

        const currency = String(plan.currency ?? "JPY") as "JPY" | "PHP";
        // The plan's own currency, as the RPC just wrote it — the authority on
        // what the customer will be paying, and so on which account to print.
        const region = regionForCurrency(currency);
        const methods = await transferMethods(supabase, currency);

        // Plan-created email: the deposit, where to send it, the deadline and
        // the whole schedule. Fire-and-forget — the plan exists either way.
        try {
          await sendStorefrontEmail({
            to: { email: String(customer.email ?? ""), is_test: customer.is_test === true },
            subject: layawayPlanCreatedSubject(String(plan.web_reference)),
            label: "layaway-plan-created",
            reference: String(plan.web_reference),
            idempotencyKey: `layaway-plan-created-${plan.account_id}`,
            element: React.createElement(LayawayPlanCreatedEmail, {
              lang,
              reference: String(plan.web_reference),
              currency,
              totalAmount: Number(plan.total ?? 0),
              deposit: Number(plan.deposit ?? 0),
              termMonths: Number(plan.term_months ?? 0),
              schedule: (plan.schedule ?? []) as AnyRec[] as never,
              methods: methods as unknown as OrderEmailMethod[],
              transferDueAt: String(plan.transfer_due_at),
              region,
              planUrl: storefrontLayawayUrl(String(plan.account_id)),
            }),
          });
        } catch (mailErr) {
          console.error("website layaway-plan-created email failed", requestId, (mailErr as Error)?.message ?? mailErr);
        }

        return jsonResponse(scrub({
          mode: "layaway",
          account_id: plan.account_id,
          web_reference: plan.web_reference,
          currency,
          total: plan.total,
          deposit: plan.deposit,
          term_months: plan.term_months,
          schedule: plan.schedule,
          transfer_due_at: plan.transfer_due_at,
          transfer_region: region,
          transfer_methods: methods,
        }));
      }

      const { data, error } = await supabase.rpc("create_web_order_atomic", {
        p_customer_id: customer.id,
        p_quote_id: quoteId,
        p_method: "transfer",
        p_lang: lang,
      });
      if (error) throw error;
      const result = (data ?? {}) as AnyRec;
      if (result.error) {
        const status = CHECKOUT_ERROR_STATUS[String(result.error)] ?? 400;
        console.warn("website checkout refused", requestId, String(result.error));
        return jsonResponse({ ...result, request_id: requestId }, status);
      }

      // Currency comes from the order that was just written, not from the
      // request body — the account shown must be one that can take the money
      // actually owed on it.
      const { data: placed } = await supabase
        .from("cash_orders")
        .select("currency")
        .eq("id", String(result.order_id)).maybeSingle();
      const orderCurrency = String((placed as AnyRec | null)?.currency ?? "JPY");

      // Read from the order rather than assumed: cash web orders are yen-only
      // today (create_web_order_atomic hard-codes JPY), and this stays correct
      // if that ever changes.
      const region = regionForCurrency(orderCurrency);
      const methods = await transferMethods(supabase, orderCurrency);

      // Order confirmation email — the same items, total, transfer methods,
      // notice and deadline the payment screen showed. Fire-and-forget: the
      // order exists whether or not the mail goes out; the helper logs one line.
      try {
        const { data: lines } = await supabase
          .from("cash_order_items")
          .select("id, website_product_id, title, quantity, line_total_jpy")
          .eq("cash_order_id", String(result.order_id))
          .order("created_at");
        const withJa = await withJapaneseTitles(
          supabase,
          ((lines ?? []) as AnyRec[]).map((l) => ({ ...l, product_id: l.website_product_id ?? null })),
        );
        const { data: placedOrder } = await supabase
          .from("cash_orders").select("shipping_fee").eq("id", String(result.order_id)).maybeSingle();
        await sendStorefrontEmail({
          to: { email: String(customer.email ?? ""), is_test: customer.is_test === true },
          subject: orderConfirmationSubject(String(result.web_reference)),
          label: "order-confirmation",
          reference: String(result.web_reference),
          idempotencyKey: `order-confirmation-${result.order_id}`,
          element: React.createElement(OrderConfirmationEmail, {
            lang,
            reference: String(result.web_reference),
            items: withJa.map((l) => ({ title: String(l.title ?? ""), title_ja: (l.title_ja as string | null) ?? null, qty: Number(l.quantity ?? 1), line_total_jpy: Number(l.line_total_jpy ?? 0) })),
            shippingJpy: placedOrder ? Number((placedOrder as AnyRec).shipping_fee ?? 0) : null,
            totalJpy: Number(result.total_jpy ?? 0),
            methods: methods as unknown as OrderEmailMethod[],
            transferDueAt: String(result.transfer_due_at),
            region,
            orderUrl: storefrontOrderUrl(String(result.order_id)),
          }),
        });
      } catch (mailErr) {
        console.error("website order-confirmation email failed", requestId, (mailErr as Error)?.message ?? mailErr);
      }

      return jsonResponse(scrub({
        order_id: result.order_id,
        web_reference: result.web_reference,
        total_jpy: result.total_jpy,
        transfer_due_at: result.transfer_due_at,
        transfer_region: region,
        transfer_methods: methods,
      }));
    }

    /**
     * ============================================== reading a customer's own history
     * THE FOUR READS BELOW ARE NOT CHANNEL-FILTERED (changed 2026-09-15).
     *
     * They used to carry `.eq("source_channel","web")`, which meant the
     * storefront could only ever show orders and plans the storefront itself
     * had created. Every live layaway plan is `hub_manual` — 1,448 of them
     * against 0 web — so all 290 plan-holders signed in and saw an empty
     * account. The portal stays the primary customer surface and keeps every
     * action; this is a second window onto the same records, viewing only.
     *
     * WHAT ENFORCES ISOLATION is `.eq("customer_id", customer.id)`, present on
     * all four, where `customer` comes from `customerForAuthUser` — a lookup by
     * the JWT's own `auth_user_id`, never by anything the caller supplies. The
     * channel filter never contributed to isolation; it only narrowed which of
     * the customer's OWN rows they could see.
     *
     * The pay handler (POST /layaway/:id/pay) KEEPS its filter deliberately.
     * Payment submission stays in the portal for now, so a Hub-created plan
     * must not accept one here; the storefront reads `source_channel` off the
     * plan and points the customer at the portal instead of rendering a form
     * that would 404.
     */

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
        // ship_to_snapshot first, the FK embed only as the fallback — see
        // shipToAddress().
        .select(`${ORDER_FIELDS}, ship_to_snapshot, ship_to_address:customer_addresses(id, recipient_name, line1, line2, city, region, postal_code, country, phone)`)
        .eq("id", segments[1])
        .eq("customer_id", customer.id)
        .maybeSingle();
      if (error) throw error;
      if (!order) return notFound();

      const { data: items, error: itemErr } = await supabase
        .from("cash_order_items")
        .select("id, variant_id, product_id, website_product_id, title, sku, quantity, unit_price_jpy, line_total_jpy, image_url")
        .eq("cash_order_id", order.id)
        .order("created_at");
      if (itemErr) throw itemErr;
      // A website line stores its catalog reference in website_product_id
      // (product_id is the Shopify FK). The storefront sees one field.
      // image_url is NULL on every web line — create_web_order_atomic never
      // writes it — so resolve the photo from website_product_media by variant
      // before answering, or the storefront is handed null for an image it
      // already has. Bug #275.
      const lines = await withJapaneseTitles(
        supabase,
        await resolveItemImages(
          supabase,
          ((items ?? []) as AnyRec[]).map(({ website_product_id, ...l }) => ({ ...l, product_id: l.product_id ?? website_product_id ?? null })),
        ),
      );

      return jsonResponse(scrub({
        order: {
          ...(order as AnyRec),
          ship_to_snapshot: undefined,
          ship_to_address: shipToAddress(
            (order as AnyRec).ship_to_snapshot,
            (order as AnyRec).ship_to_address,
          ),
        },
        items: lines,
        transfer_region: regionForCurrency(String((order as AnyRec).currency ?? "JPY")),
        // Methods are only actionable while the transfer is outstanding.
        transfer_methods: (order as AnyRec).payment_status === "pending_transfer"
          ? await transferMethods(supabase, String((order as AnyRec).currency ?? "JPY"))
          : [],
      }));
    }

    // GET /layaway — this customer's plans, newest first.
    if (req.method === "GET" && segments[0] === "layaway" && !segments[1]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const { data, error } = await supabase
        .from("layaway_accounts")
        .select(LAYAWAY_FIELDS)
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return jsonResponse(scrub(data ?? []));
    }

    // GET /layaway/:id — one plan, with its schedule, lines and payments.
    if (req.method === "GET" && segments[0] === "layaway" && segments[1] && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      // Scoped by customer_id as well as id: a plan id alone must never be
      // enough to read someone else's plan.
      const { data: plan, error } = await supabase
        .from("layaway_accounts")
        // A web plan carries its address ONLY as ship_to_snapshot:
        // layaway_accounts has no ship_to_address_id. The quote embed is the
        // fallback for plans written before 20260915160000.
        .select(`${LAYAWAY_FIELDS}, ship_to_snapshot, quote:checkout_quotes(ship_to_address:customer_addresses(id, recipient_name, line1, line2, city, region, postal_code, country, phone))`)
        .eq("id", segments[1])
        .eq("customer_id", customer.id)
        .maybeSingle();
      if (error) throw error;
      if (!plan) return notFound();

      // DISPLAY RULES: per-row remaining and status come from
      // schedule_with_actuals, never from the write-only caches.
      const [{ data: rows }, { data: items }, { data: paid }, { data: pending }] = await Promise.all([
        supabase.from("schedule_with_actuals")
          .select("id, installment_number, due_date, base_installment_amount, penalty_amount, carried_amount, total_due_amount, allocated, actual_remaining, computed_status")
          .eq("account_id", plan.id).order("installment_number"),
        supabase.from("layaway_account_items")
          .select("id, website_product_id, variant_id, title, sku, quantity, unit_price_jpy, line_total_jpy, image_url")
          .eq("account_id", plan.id).order("created_at"),
        supabase.from("payments")
          .select("id, amount_paid, currency, date_paid, payment_method, reference_number, created_at")
          .eq("account_id", plan.id).is("voided_at", null).order("date_paid", { ascending: false }),
        supabase.from("payment_submissions")
          .select("id, submitted_amount, payment_date, payment_method, status, created_at")
          .eq("account_id", plan.id).in("status", ["submitted", "under_review"]).order("created_at", { ascending: false }),
      ]);

      // Same as the order branch: a web plan line stores no image_url, so the
      // photo is resolved from website_product_media by variant. Bug #275.
      const lines = await withJapaneseTitles(
        supabase,
        await resolveItemImages(
          supabase,
          ((items ?? []) as AnyRec[]).map(({ website_product_id, ...l }) => ({ ...l, product_id: website_product_id ?? null })),
        ),
      );

      const depositPaid = Number(plan.total_paid ?? 0) > 0;

      return jsonResponse(scrub({
        plan: {
          ...(plan as AnyRec),
          quote: undefined,
          ship_to_snapshot: undefined,
          ship_to_address: shipToAddress(
            (plan as AnyRec).ship_to_snapshot,
            ((plan as AnyRec).quote as AnyRec | null)?.ship_to_address,
          ),
        },
        // Where this plan is paid. Carried on the plan itself so the page can
        // name the portal without a second round trip, and built by the Hub's
        // own builder so a legacy customer still gets their token link.
        portal_url: await buildPortalLinkForCustomerId(supabase, String(customer.id), "portal"),
        schedule: rows ?? [],
        items: lines,
        payments: paid ?? [],
        pending_submissions: pending ?? [],
        deposit_paid: depositPaid,
        transfer_region: regionForCurrency(String((plan as AnyRec).currency ?? "JPY")),
        // Methods stay actionable for the life of the plan: every instalment is
        // paid the same way the deposit was — and in the plan's currency, which
        // is fixed at creation and never changes.
        transfer_methods: await transferMethods(supabase, String((plan as AnyRec).currency ?? "JPY")),
      }));
    }

    // POST /layaway/:id/pay — the customer reports a transfer for the deposit
    // or an instalment. It creates a SUBMISSION, never a payment: the money is
    // not on the books until a CSR confirms it in the Hub, exactly as the portal
    // and every staff path work (CLAUDE.md PAYMENT SUBMISSION FLOW).
    if (req.method === "POST" && segments[0] === "layaway" && segments[1] && segments[2] === "pay") {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = (await req.json().catch(() => ({}))) as AnyRec;

      // Proof is required on EVERY submit path, with no exception for the web.
      const proofUrl = String(body.proof_url ?? "").trim();
      if (!proofUrl) return jsonResponse({ error: "proof_required" }, 400);

      const amount = Math.round(Number(body.amount ?? 0));
      if (!Number.isFinite(amount) || amount <= 0) return jsonResponse({ error: "bad_amount" }, 400);
      const paymentDate = String(body.payment_date ?? "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return jsonResponse({ error: "bad_payment_date" }, 400);
      const method = String(body.payment_method ?? "").trim();
      if (!method) return jsonResponse({ error: "payment_method_required" }, 400);

      const { data: plan } = await supabase
        .from("layaway_accounts")
        .select("id, status, invoice_number, web_reference, total_paid, remaining_balance")
        .eq("id", segments[1]).eq("customer_id", customer.id)
        .eq("source_channel", "web").maybeSingle();
      if (!plan) return notFound();
      if (!["active", "overdue", "extension_active", "reactivated"].includes(String(plan.status))) {
        return jsonResponse({ error: "plan_not_live", status: plan.status }, 409);
      }
      // INVARIANT 4: never accept more than the account still owes.
      if (amount > Number(plan.remaining_balance ?? 0)) {
        return jsonResponse({ error: "exceeds_balance", remaining: plan.remaining_balance }, 400);
      }

      // Same rolling cap the portal uses: 3 per account per 24 hours,
      // rejections excluded.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count } = await supabase
        .from("payment_submissions")
        .select("id", { count: "exact", head: true })
        .eq("account_id", plan.id)
        .neq("status", "rejected")
        .gte("created_at", since);
      if ((count ?? 0) >= 3) {
        return jsonResponse({ error: "too_many_submissions" }, 429);
      }

      // The first payment on a plan is its deposit. review-payment-submission
      // keys the loyalty award off submission_type = 'downpayment'.
      const isDeposit = Number(plan.total_paid ?? 0) <= 0;

      const { data: created, error: subErr } = await supabase
        .from("payment_submissions")
        .insert({
          customer_id: customer.id,
          account_id: plan.id,
          submitted_amount: amount,
          payment_date: paymentDate,
          payment_method: method,
          reference_number: String(body.reference_number ?? "").trim() || null,
          sender_name: customer.full_name ?? null,
          notes: isDeposit
            ? `Downpayment submitted from the website (${plan.web_reference ?? plan.invoice_number})`
            : `Payment submitted from the website (${plan.web_reference ?? plan.invoice_number})`,
          proof_url: proofUrl,
          status: "submitted",
          submission_type: isDeposit ? "downpayment" : "single",
        })
        .select("id, status, submitted_amount, payment_date")
        .maybeSingle();
      if (subErr) throw subErr;

      return jsonResponse(scrub({ ok: true, submission: created, is_deposit: isDeposit }));
    }

    return notFound();
  } catch (err) {
    // The one line that explains a "Ref: …" on the storefront. Postgres errors
    // carry code/details/hint; keep them — a bare message hides the FK name.
    const e = err as { message?: string; code?: string; details?: string; hint?: string };
    console.error("website api error", requestId, req.method, path, e?.code ?? "", e?.message ?? err, e?.details ?? "", e?.hint ?? "");
    return jsonResponse({ error: "server_error", request_id: requestId }, 500);
  }
}
