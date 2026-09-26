import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { pickLang, sendStorefrontEmail, storefrontLayawayUrl, storefrontOrderUrl } from "../_shared/storefront-email.ts";
import { OrderConfirmationEmail, orderConfirmationSubject } from "../_shared/email-templates/order-confirmation.tsx";
import { LayawayPlanCreatedEmail, layawayPlanCreatedSubject } from "../_shared/email-templates/layaway-plan-created.tsx";
import type { OrderEmailMethod } from "../_shared/email-templates/order-shared.tsx";
import * as React from "npm:react@18.3.1";
import { resolveItemImages } from "../_shared/item-images.ts";
import { regionForCurrency, transferMethods } from "../_shared/transfer-methods.ts";
import { jpyToPhpHalfUp, settleFullPaymentInPhp } from "../_shared/settlement.ts";
import { attachDownPayments, planLayawayQuote, variantPricePhp } from "../_shared/website-down-payments.ts";
import { sendLayawayReservedEmail, sendOrderReservedEmail } from "../_shared/reservation-emails.ts";
import {
  NOT_READY_FOR_PAYMENT, isUnconfirmedReservation, readReservationMode, reservationFlags,
  type ReservationKind,
} from "../_shared/web-reservation-rules.ts";

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
  if (!products.length) return products;
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
    // Exact half-up (H-DP): the conversion a peso checkout stores, to the
    // peso. Down payments are added per request by attachDownPayments.
    v.price_php = variantPricePhp(v.price_jpy ?? 0, fx);
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
  "cancellation_reason, refund_status, refund_note, expired_at, source_channel, " +
  // Read for the reservation flags only — withReservationFlags strips it.
  "ready_confirmed_at";

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
  "created_at, completed_at, tracking_number, shipped_at, source_channel, " +
  // Read for the reservation flags only — withReservationFlags strips it.
  "ready_confirmed_at";

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

/** Cheap yes/no for the checkout gate — same completeness rule, no details returned. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function transferAvailable(supabase: any, currency: string): Promise<boolean> {
  return (await transferMethods(supabase, currency)).length > 0;
}

/**
 * RESERVE-FIRST (A2). Is checkout creating reservations? Read per request from
 * system_settings.web_reservation_mode, FAIL-CLOSED to today's flow: a read
 * error, a missing row or any value but true means off (readReservationMode).
 * With it off, nothing below changes: p_reserve is not even sent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function reservationModeOn(supabase: any): Promise<boolean> {
  const { data, error } = await supabase
    .from("system_settings").select("value").eq("key", "web_reservation_mode").maybeSingle();
  if (error) {
    console.warn("[website] web_reservation_mode read failed — treating as off:", error.message ?? error);
    return false;
  }
  return readReservationMode((data as AnyRec | null)?.value);
}

/**
 * The two reservation flags on an order or plan the customer reads, and
 * ready_confirmed_at itself taken back out: the storefront needs the answer,
 * not the column.
 */
function withReservationFlags(row: AnyRec, kind: ReservationKind): AnyRec {
  const { ready_confirmed_at: _ready, ...rest } = row;
  return { ...rest, ...reservationFlags(row, kind) };
}

// The client type every helper in this file already takes (supabase: any) —
// named once here so the two helpers below stay consistent with it.
type WebsiteClient = Parameters<typeof customerForAuthUser>[0];

// POST /newsletter and POST /contact rate limiters: timestamps per IP,
// in-memory per isolate. Separate maps so the two limits are independent.
const newsletterHits = new Map<string, number[]>();
const contactHits = new Map<string, number[]>();

// Returns true when the IP is over 5 posts in 10 minutes (and records the hit
// when it is not). Per-isolate, so a dampener against bursts, not a hard
// guarantee.
function rateLimited(map: Map<string, number[]>, ip: string): boolean {
  const now = Date.now();
  const hits = (map.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  if (hits.length >= 5) return true;
  hits.push(now);
  map.set(ip, hits);
  return false;
}

// Optional customer session: the same resolution the order routes use, but any
// failure is silently treated as anonymous — public routes must work for
// visitors too.
async function optionalCustomerId(
  req: Request,
  supabase: WebsiteClient,
): Promise<string | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;
  try {
    const { data: userData } = await supabase.auth.getUser(authHeader.slice(7));
    if (!userData?.user) return null;
    const customer = await customerForAuthUser(supabase, userData.user.id);
    return customer ? String(customer.id) : null;
  } catch {
    return null; // anonymous is fine
  }
}

// THE newsletter upsert — POST /newsletter and POST /contact (newsletter:true)
// both call this; the logic must never be duplicated. New address → insert
// with consent now; previously unsubscribed → re-consent; active → untouched.
// A staff bell fires on NEW subscriptions only. Never reveals existence beyond
// the subscribed / already_subscribed distinction.
async function upsertNewsletterSubscriber(
  supabase: WebsiteClient,
  input: { email: string; lang: string; source: string | null; customerId: string | null },
): Promise<"subscribed" | "already_subscribed"> {
  const { email, lang, source, customerId } = input;
  const emailNorm = email.toLowerCase();
  const nowIso = new Date().toISOString();

  const { data: existing, error: lookupErr } = await supabase
    .from("newsletter_subscribers")
    .select("id, unsubscribed_at")
    .eq("email_norm", emailNorm)
    .maybeSingle();
  if (lookupErr) throw lookupErr;

  if (!existing) {
    const { data: inserted, error: insErr } = await supabase
      .from("newsletter_subscribers")
      // email_norm is a GENERATED column (lower(btrim(email))) — Postgres
      // refuses 428C9 if it appears in the payload. It is read-only: the
      // lookup above matches on it, the insert must never send it.
      .insert({ email, lang, source, customer_id: customerId, consented_at: nowIso })
      .select("id")
      .single();
    if (insErr) throw insErr;
    // Staff bell on NEW subscriptions only, non-blocking.
    try {
      await supabase.from("staff_notifications").insert({
        type: "newsletter_subscribed",
        title: "New newsletter subscriber",
        body: `${emailNorm} · lang ${lang} · source ${source ?? "none"}`,
        metadata: { id: (inserted as AnyRec).id, lang, source },
      });
    } catch (notifyErr) {
      console.warn("[website] newsletter_subscribed notification failed (non-blocking):", notifyErr);
    }
    return "subscribed";
  }

  if ((existing as AnyRec).unsubscribed_at) {
    // Re-consent: clear the unsubscribe and stamp a fresh consent.
    const { error: upErr } = await supabase
      .from("newsletter_subscribers")
      .update({ unsubscribed_at: null, consented_at: nowIso, lang, ...(customerId ? { customer_id: customerId } : {}) })
      .eq("id", (existing as AnyRec).id);
    if (upErr) throw upErr;
    return "subscribed";
  }

  // Active row: no change.
  return "already_subscribed";
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
      const shaped = (links ?? [])
        .map((l: AnyRec) => l.product as AnyRec | null)
        .filter((p): p is AnyRec => !!p && p.status === "active")
        .map((p) => shapeProduct(p, fx))
        .filter((p): p is AnyRec => p !== null);
      await attachDownPayments(supabase, shaped, fx);
      const products = await attachCategorySlugs(supabase, shaped);

      return jsonResponse(scrub({ ...shapeCollection(collection as AnyRec), products }));
    }

    // GET /catalog/categories — published only, in display order
    if (req.method === "GET" && segments[0] === "catalog" && segments[1] === "categories" && !segments[2]) {
      const { data, error } = await supabase
        .from("website_categories")
        .select(CATEGORY_FIELDS)
        .eq("published", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return jsonResponse(scrub(data ?? []));
    }

    // GET /catalog/categories/:slug — the category plus its products, shaped
    // exactly as /catalog/collections/:slug shapes products. 404 when the
    // category is missing or unpublished.
    if (req.method === "GET" && segments[0] === "catalog" && segments[1] === "categories" && segments[2]) {
      const slug = decodeURIComponent(segments[2]);
      const { data: category, error } = await supabase
        .from("website_categories")
        .select(CATEGORY_FIELDS)
        .eq("slug", slug)
        .eq("published", true)
        .maybeSingle();
      if (error) throw error;
      if (!category) return notFound();

      const { data: links, error: linkError } = await supabase
        .from("website_category_products")
        .select(`sort_order, product:website_products(${PRODUCT_SELECT})`)
        .eq("category_id", (category as AnyRec).id)
        .order("sort_order", { ascending: true });
      if (linkError) throw linkError;

      // Order: website_category_products.sort_order, then product name.
      const rows = (links ?? [])
        .map((l: AnyRec) => ({ sort: Number(l.sort_order ?? 0), product: l.product as AnyRec | null }))
        .filter((r): r is { sort: number; product: AnyRec } => !!r.product && r.product.status === "active");
      rows.sort((a, b) =>
        a.sort - b.sort || String(a.product.name ?? "").localeCompare(String(b.product.name ?? "")));

      const fx = await latestFx(supabase);
      const shaped = rows
        .map((r) => shapeProduct(r.product, fx))
        .filter((p): p is AnyRec => p !== null);
      await attachDownPayments(supabase, shaped, fx);
      const products = await attachCategorySlugs(supabase, shaped);

      return jsonResponse(scrub({ ...(category as AnyRec), products }));
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
      const product = shapeProduct(data as AnyRec, fx);
      await attachDownPayments(supabase, [product], fx);
      return jsonResponse(scrub(product));
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
      const shaped = (data ?? [])
        .map((p) => shapeProduct(p as AnyRec, fx))
        .filter((p): p is AnyRec => p !== null);
      await attachDownPayments(supabase, shaped, fx);
      const products = await attachCategorySlugs(supabase, shaped);
      return jsonResponse(scrub(products));
    }

    // GET /testimonials — published only. An empty table is a valid state and
    // returns [], never an error.
    if (req.method === "GET" && segments[0] === "testimonials" && !segments[1]) {
      const { data, error } = await supabase
        .from("website_testimonials")
        .select("id, customer_name, location, quote_en, quote_ja, item, rating, testimonial_date")
        .eq("published", true)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: false });
      if (error) throw error;
      return jsonResponse(scrub(data ?? []));
    }

    // GET /content/settings — public rows only, flattened to { key: value }.
    // Same x-api-key rule and the same (default) cache treatment as
    // /catalog/collections; freshness comes from the website_settings
    // revalidate trigger, not from a shorter cache window.
    // web_reservation_mode is NOT a website_settings row: it is derived at
    // request time from system_settings via the same reader the checkout gate
    // uses (reservationModeOn → readReservationMode), so there is exactly one
    // switch and the storefront can show "awaiting confirmation" copy without
    // guessing.
    if (req.method === "GET" && segments[0] === "content" && segments[1] === "settings" && !segments[2]) {
      const { data, error } = await supabase
        .from("website_settings")
        .select("key, value")
        .eq("public", true)
        .order("key", { ascending: true });
      if (error) throw error;
      const settings: Record<string, unknown> = {};
      for (const row of (data ?? []) as AnyRec[]) settings[String(row.key)] = row.value;
      settings["web_reservation_mode"] = await reservationModeOn(supabase);
      return jsonResponse(scrub(settings));
    }

    // Posts list fields — the body is deliberately absent from the list
    // response; it is only served by /content/posts/:slug.
    const POST_LIST_FIELDS =
      "id, slug, type, title_en, title_ja, excerpt_en, excerpt_ja, cover_media, published_at, layaway_only";

    // "Today" is PHT (Asia/Manila) — the canonical day boundary. A post dated
    // tomorrow is not published yet, whatever the server's own clock says.
    const phtToday = () =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

    // GET /content/posts?type=article|news — published, not future-dated.
    // Same x-api-key rule and cache treatment as /catalog/collections;
    // freshness comes from the website_posts revalidate trigger.
    if (req.method === "GET" && segments[0] === "content" && segments[1] === "posts" && !segments[2]) {
      const type = url.searchParams.get("type");
      let q = supabase
        .from("website_posts")
        .select(POST_LIST_FIELDS)
        .eq("published", true)
        .lte("published_at", phtToday())
        .order("published_at", { ascending: false });
      if (type) q = q.eq("type", type);
      const { data, error } = await q;
      if (error) throw error;
      return jsonResponse(scrub(data ?? []));
    }

    // GET /content/posts/:slug — the full row, body included. Unpublished,
    // future-dated and unknown slugs are all 404 (existence is not leaked).
    if (req.method === "GET" && segments[0] === "content" && segments[1] === "posts" && segments[2]) {
      const { data, error } = await supabase
        .from("website_posts")
        .select(
          "id, slug, type, title_en, title_ja, excerpt_en, excerpt_ja, body_en, body_ja, cover_media, published_at, layaway_only",
        )
        .eq("slug", segments[2])
        .eq("published", true)
        .lte("published_at", phtToday())
        .maybeSingle();
      if (error) throw error;
      if (!data) return jsonResponse({ error: "not_found" }, 404);
      return jsonResponse(scrub(data));
    }

    // GET /content/faq — published sections (sort_order), each with its
    // published items (sort_order). Empty array when none. Same x-api-key
    // rule and cache treatment as /catalog/collections; freshness comes
    // from the website_faq_* revalidate triggers.
    if (req.method === "GET" && segments[0] === "content" && segments[1] === "faq" && !segments[2]) {
      const { data: sections, error: sErr } = await supabase
        .from("website_faq_sections")
        .select("id, slug, title_en, title_ja, sort_order")
        .eq("published", true)
        .order("sort_order", { ascending: true });
      if (sErr) throw sErr;
      const sectionIds = ((sections ?? []) as AnyRec[]).map((s) => s.id);
      const { data: items, error: iErr } = sectionIds.length
        ? await supabase
          .from("website_faq_items")
          .select("id, section_id, question_en, question_ja, answer_en, answer_ja, layaway_only, sort_order")
          .eq("published", true)
          .in("section_id", sectionIds)
          .order("sort_order", { ascending: true })
        : { data: [], error: null };
      if (iErr) throw iErr;
      const itemsBySection = new Map<string, AnyRec[]>();
      for (const item of (items ?? []) as AnyRec[]) {
        const list = itemsBySection.get(String(item.section_id)) ?? [];
        list.push(item);
        itemsBySection.set(String(item.section_id), list);
      }
      const faq = ((sections ?? []) as AnyRec[]).map((s) => ({
        slug: s.slug,
        title_en: s.title_en,
        title_ja: s.title_ja,
        items: (itemsBySection.get(String(s.id)) ?? []).map((i) => ({
          id: i.id,
          question_en: i.question_en,
          question_ja: i.question_ja,
          answer_en: i.answer_en,
          answer_ja: i.answer_ja,
          layaway_only: i.layaway_only,
        })),
      }));
      return jsonResponse(scrub(faq));
    }





    // POST /layaway/quote
    if (req.method === "POST" && segments[0] === "layaway" && segments[1] === "quote") {
      // { price_jpy, term_months, currency } (H-DP): a YEN price quoted in
      // either currency — the Hub converts, the storefront never does. The
      // legacy { price, currency } shape is unchanged. See planLayawayQuote.
      const body = await req.json().catch(() => ({}));
      const plan = await planLayawayQuote(body, () => latestFx(supabase));
      if ("error" in plan) return jsonResponse({ error: plan.error }, plan.status);
      const { data, error } = await supabase.rpc("layaway_quote", plan.args);
      if (error) throw error;
      return jsonResponse(scrub(plan.extra ? { ...(data as AnyRec), ...plan.extra } : data));
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
      // The profile (2026-09-24): full_name and location are REQUIRED to create
      // a customer; facebook_name, messenger_link and mobile_number are
      // optional. Trimmed; empty → null.
      const optStr = (v: unknown): string | null => {
        const t = typeof v === "string" ? v.trim() : "";
        return t ? t : null;
      };
      const givenName = optStr((body as AnyRec)?.full_name);
      const facebookName = optStr((body as AnyRec)?.facebook_name);
      const messengerLink = optStr((body as AnyRec)?.messenger_link);
      const mobileNumber = optStr((body as AnyRec)?.mobile_number);
      // Stored exactly like the Hub (src/lib/countries.ts toLocationString):
      // 'Japan', 'Philippines', or the country name.
      const rawLocation = optStr((body as AnyRec)?.location);
      const location = rawLocation === null ? null
        : rawLocation.toLowerCase() === "japan" ? "Japan"
        : rawLocation.toLowerCase() === "philippines" ? "Philippines"
        : rawLocation;
      // NO PROFILE, NO CUSTOMER (owner-approved 2026-09-24, step 4b). No
      // customer holds this email (the link branches above did not return),
      // and without a name and a location there is nothing to create one
      // from. The storefront (cha-jewels-web #135) answers this by sending her
      // to /account/complete-profile, which posts again WITH the profile.
      // Nothing is created and nobody is notified. The email-prefix name that
      // used to be invented here is gone: a customer is always named by what
      // she typed.
      if (!givenName || !location) {
        return jsonResponse({ error: "profile_required" }, 422);
      }

      // Duplicate-customer prevention (owner rules 2026-09-23). This branch
      // would CREATE a customer (no email match above), so a match on full
      // name, Facebook name, mobile or email blocks it. A failed check never
      // inserts.
      const { data: dupMatches, error: dupErr } = await supabase.rpc("find_customer_matches", {
        p_full_name: givenName,
        p_facebook_name: facebookName,
        p_mobile: mobileNumber,
        p_email: who.email,
      });
      if (dupErr) {
        console.error("[website] /auth/customer duplicate check failed:", dupErr);
        return jsonResponse({ error: "duplicate_check_failed" }, 500);
      }
      const dups = (dupMatches ?? []) as Array<{ customer_id: string; customer_code: string | null; matched_on: string[] }>;
      if (dups.length > 0) {
        try {
          const { error: notifyErr } = await supabase.from("staff_notifications").insert({
            type: "duplicate_signup_blocked",
            title: "Signup blocked — existing customer",
            body: `Website signup blocked: ${givenName ?? "(no name given)"} <${who.email}>`
              + `, Facebook: ${facebookName ?? "—"}, mobile: ${mobileNumber ?? "—"}`
              + `, location: ${location ?? "—"}, auth user ${who.id}. Matches: `
              + dups.map((d) => `${d.customer_code ?? "no code"} (${d.matched_on.join(", ")})`).join("; "),
            customer_id: dups[0].customer_id,
            metadata: {
              source: "website_auth_customer",
              auth_user_id: who.id,
              email: who.email,
              full_name: givenName,
              facebook_name: facebookName,
              mobile_number: mobileNumber,
              location,
              matches: dups.map((d) => ({
                customer_id: d.customer_id,
                customer_code: d.customer_code,
                matched_on: d.matched_on,
              })),
            },
          });
          if (notifyErr) console.warn("[website] duplicate_signup_blocked notification failed (non-blocking):", notifyErr);
        } catch (notifyBlockErr) {
          console.warn("[website] duplicate_signup_blocked notification failed (non-blocking):", notifyBlockErr);
        }
        return jsonResponse({
          error: "already_registered",
          message: "You are already registered. Please contact Cha Jewels for your account details.",
        }, 409);
      }

      // customer_code comes from the existing BEFORE INSERT trigger.
      // NOTE: unlike setup-customer-account, this does NOT auto-enrol in
      // loyalty — enrolment stays with join-loyalty-program so the
      // loyalty_enabled gate is honoured in one place.
      const { data: created, error: insErr } = await supabase
        .from("customers").insert({
          full_name: givenName, email: who.email, auth_user_id: who.id,
          facebook_name: facebookName, messenger_link: messengerLink,
          mobile_number: mobileNumber, location,
        })
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

      // Settlement currency: the customer chooses yen or pesos and the Hub
      // record follows — for a full payment (owner decision 2026-09-25) exactly
      // as for a layaway (2026-09-13). Yen stays the price of record; the
      // default is yen. The old full-payment currency refusal is retired.
      const settlement = String(body.settlement_currency ?? "JPY").toUpperCase();
      if (!["JPY", "PHP"].includes(settlement)) return jsonResponse({ error: "bad_currency" }, 400);

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
      // it can drift in. No usable fx_rates row → 503 fx_unavailable, for either
      // mode: a peso figure is never guessed. Yen quotes never read the rate.
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
      // Exact half-up (H3, 2026-09-25): the peso layaway quote now uses the
      // same integer arithmetic as create_web_layaway_atomic's
      // round(total_jpy * fx_rate), so it cannot land ₱1 low on an exact .5.
      const toSettle = (jpy: number) => (fxRate === null ? jpy : jpyToPhpHalfUp(jpy, fxRate));
      let totalSettle: number;
      let shippingSettle: number | null;
      let subtotalSettle: number;
      if (mode === "full" && fxRate !== null) {
        // A peso FULL payment is stored by create_web_order_atomic as
        // round(total_jpy * fx_rate) in Postgres — half-up on an exact product.
        // Integer maths here, so the quoted peso total IS the stored one, to
        // the peso (a float Math.round can land ₱1 low on an exact .5).
        ({ total: totalSettle, shipping: shippingSettle, subtotal: subtotalSettle } =
          settleFullPaymentInPhp(total, shipping, fxRate));
      } else {
        // Layaway (either currency; pesos exact half-up since H3) and yen full payment.
        totalSettle = toSettle(total);
        shippingSettle = shipping === null ? null : toSettle(shipping);
        subtotalSettle = totalSettle - (shippingSettle ?? 0);
      }

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
      // RESERVE-FIRST (A2): no bank details before staff confirm the piece
      // (owner decision 2026-09-23). transfer_available still reports whether
      // the currency CAN be paid, so checkout is not refused for nothing.
      const reserveQuote = await reservationModeOn(supabase);

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
        transfer_methods: reserveQuote ? [] : quoteMethods,
        transfer_available: quoteMethods.length > 0,
        ...(reserveQuote ? { reservation_mode: true } : {}),
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
      // the remainder, so the parts sum to the total exactly. A peso FULL
      // payment uses the integer half-up the order will be stored with, and
      // since H3 (2026-09-25) so does a peso layaway — the same arithmetic as
      // create_web_layaway_atomic's round(total_jpy * fx_rate). Yen unchanged.
      const toSettle = (jpy: number) => (fxRate === null ? jpy : jpyToPhpHalfUp(jpy, fxRate));
      let totalSettle: number;
      let shippingSettle: number | null;
      let subtotalSettle: number;
      if (String(row.mode ?? "full") === "full" && fxRate !== null) {
        ({ total: totalSettle, shipping: shippingSettle, subtotal: subtotalSettle } =
          settleFullPaymentInPhp(totalJpy, shippingJpy, fxRate));
      } else {
        totalSettle = toSettle(totalJpy);
        shippingSettle = shippingJpy === null ? null : toSettle(shippingJpy);
        subtotalSettle = totalSettle - (shippingSettle ?? 0);
      }

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
      // RESERVE-FIRST (A2): as POST /checkout/quote — no bank details yet.
      const reserveQuote = await reservationModeOn(supabase);

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
        transfer_methods: reserveQuote ? [] : methods,
        transfer_available: methods.length > 0,
        ...(reserveQuote ? { reservation_mode: true } : {}),
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
      // RESERVE-FIRST (A2): read once, used for both kinds. Off (the default,
      // and on any read failure) is today's flow exactly — p_reserve is not
      // sent, and the same emails and response go out as before.
      const reserve = await reservationModeOn(supabase);

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
          ...(reserve ? { p_reserve: true } : {}),
        });
        if (layErr) throw layErr;
        const plan = (lay ?? {}) as AnyRec;
        if (plan.error) {
          const status = CHECKOUT_ERROR_STATUS[String(plan.error)] ?? 400;
          console.warn("website layaway refused", requestId, String(plan.error));
          return jsonResponse({ ...plan, request_id: requestId }, status);
        }

        // RESERVE-FIRST (A2). The piece is held; staff have not confirmed it.
        // "We have your layaway request" — English only, no bank details, no
        // deadline, no schedule (it is re-dated to the confirmation day). The
        // deposit email with the payment details is sent by
        // confirm-web-order-ready.
        if (reserve) {
          await sendLayawayReservedEmail(supabase, String(plan.account_id));
          const currency = String(plan.currency ?? "JPY") as "JPY" | "PHP";
          return jsonResponse(scrub({
            mode: "layaway",
            reservation_mode: true,
            awaiting_confirmation: true,
            account_id: plan.account_id,
            web_reference: plan.web_reference,
            currency,
            total: plan.total,
            deposit: plan.deposit,
            term_months: plan.term_months,
            schedule: [],
            transfer_due_at: null,
            transfer_region: regionForCurrency(currency),
            transfer_methods: [],
          }));
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
        ...(reserve ? { p_reserve: true } : {}),
      });
      if (error) throw error;
      const result = (data ?? {}) as AnyRec;
      if (result.error) {
        const status = CHECKOUT_ERROR_STATUS[String(result.error)] ?? 400;
        console.warn("website checkout refused", requestId, String(result.error));
        return jsonResponse({ ...result, request_id: requestId }, status);
      }

      // RESERVE-FIRST (A2). "We have your order" in the customer's language —
      // no bank details, no deadline. The payment email is sent by
      // confirm-web-order-ready once staff confirm the piece.
      // The order's settlement currency and total come back from
      // create_web_order_atomic (peso full payment, 2026-09-25). An RPC that
      // predates that migration returns neither and only ever wrote yen, so the
      // fallback is exactly what that order is. total_jpy stays in every
      // response for storefront builds that read it.
      const placedCurrency = String(result.currency ?? "JPY") === "PHP" ? "PHP" : "JPY";
      const placedTotal = Number(result.total ?? result.total_jpy ?? 0);
      if (reserve) {
        await sendOrderReservedEmail(supabase, String(result.order_id));
        return jsonResponse(scrub({
          reservation_mode: true,
          awaiting_confirmation: true,
          order_id: result.order_id,
          web_reference: result.web_reference,
          currency: placedCurrency,
          total: placedTotal,
          total_jpy: result.total_jpy,
          transfer_due_at: null,
          transfer_region: regionForCurrency(placedCurrency),
          transfer_methods: [],
        }));
      }

      // Currency comes from the order that was just written, not from the
      // request body — the account shown must be one that can take the money
      // actually owed on it.
      const { data: placed } = await supabase
        .from("cash_orders")
        .select("currency, total_amount, shipping_fee")
        .eq("id", String(result.order_id)).maybeSingle();
      const orderCurrency = String((placed as AnyRec | null)?.currency ?? placedCurrency);
      // total_amount is in the order's own currency (pesos on a peso order).
      const orderTotal = placed ? Number((placed as AnyRec).total_amount ?? placedTotal) : placedTotal;

      // Read from the order rather than assumed: a web order settles in the
      // currency the customer chose at checkout (yen or pesos, 2026-09-25).
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
            // Shipping and total in the order's currency; lines stay yen and
            // are shown without a price on a peso order (owner decision D1).
            shippingJpy: placed ? Number((placed as AnyRec).shipping_fee ?? 0) : null,
            totalJpy: orderTotal,
            currency: orderCurrency === "PHP" ? "PHP" : "JPY",
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
        currency: orderCurrency,
        total: orderTotal,
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
      return jsonResponse(scrub(((data ?? []) as unknown as AnyRec[]).map((o) => withReservationFlags(o, "cash_order"))));
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
          // awaiting_confirmation / ready_for_payment (reserve-first A2).
          ...withReservationFlags(order as AnyRec, "cash_order"),
          ship_to_snapshot: undefined,
          ship_to_address: shipToAddress(
            (order as AnyRec).ship_to_snapshot,
            (order as AnyRec).ship_to_address,
          ),
        },
        items: lines,
        transfer_region: regionForCurrency(String((order as AnyRec).currency ?? "JPY")),
        // Methods are only actionable while the transfer is outstanding — and
        // never before staff confirm the piece (reserve-first A2; a reservation
        // reads payment_status awaiting_confirmation, so this is belt and braces).
        transfer_methods: (order as AnyRec).payment_status === "pending_transfer" && !isUnconfirmedReservation(order as AnyRec)
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
      return jsonResponse(scrub(((data ?? []) as unknown as AnyRec[]).map((a) => withReservationFlags(a, "layaway"))));
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
          // awaiting_confirmation / ready_for_payment (reserve-first A2).
          ...withReservationFlags(plan as AnyRec, "layaway"),
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
        // is fixed at creation and never changes. EXCEPT before staff confirm a
        // web reservation (reserve-first A2): no bank details until then.
        transfer_methods: isUnconfirmedReservation(plan as AnyRec)
          ? []
          : await transferMethods(supabase, String((plan as AnyRec).currency ?? "JPY")),
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
        .select("id, status, invoice_number, web_reference, total_paid, remaining_balance, source_channel, ready_confirmed_at")
        .eq("id", segments[1]).eq("customer_id", customer.id)
        .eq("source_channel", "web").maybeSingle();
      if (!plan) return notFound();
      if (!["active", "overdue", "extension_active", "reactivated"].includes(String(plan.status))) {
        return jsonResponse({ error: "plan_not_live", status: plan.status }, 409);
      }
      // RESERVE-FIRST (A2): no money against a piece staff have not confirmed.
      // The customer has not been shown where to pay, so a submission here is
      // a mistake or a guess — refuse it rather than book it.
      if (isUnconfirmedReservation(plan as AnyRec)) {
        return jsonResponse({ error: NOT_READY_FOR_PAYMENT }, 409);
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

    // ======================================== service requests (customer)
    // The DB column is layaway_account_id; the API calls it layaway_plan_id,
    // matching the plan terminology the storefront uses everywhere else.
    // staff_note is NEVER selected — it is internal-only.

    // GET /me/service-requests — this customer's requests, newest first.
    if (req.method === "GET" && segments[0] === "me" && segments[1] === "service-requests" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const { data, error } = await supabase
        .from("service_requests")
        .select("id, kind, status, item_title, details, ring_size, cash_order_id, layaway_account_id, customer_note, created_at, updated_at")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;

      return jsonResponse(((data ?? []) as AnyRec[]).map((row) => {
        const { layaway_account_id, ...rest } = row;
        return { ...rest, layaway_plan_id: layaway_account_id ?? null };
      }));
    }

    // POST /me/service-requests — request service on one owned order/plan.
    if (req.method === "POST" && segments[0] === "me" && segments[1] === "service-requests" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = (await req.json().catch(() => ({}))) as AnyRec;

      const ALLOWED_KINDS = ["resize", "cleaning", "repair", "appraisal", "other"];
      const kind = String(body.kind ?? "").trim();
      if (!ALLOWED_KINDS.includes(kind)) return jsonResponse({ error: "bad_kind" }, 400);

      const details = String(body.details ?? "").trim();
      if (details.length < 1 || details.length > 1000) {
        return jsonResponse({ error: "bad_details" }, 400);
      }

      const ringSize = body.ring_size == null ? null : String(body.ring_size).trim() || null;
      const itemTitle = body.item_title == null ? null : String(body.item_title).trim() || null;

      // Exactly one target, and it must be this customer's.
      const cashOrderId = String(body.cash_order_id ?? "").trim();
      const layawayPlanId = String(body.layaway_plan_id ?? "").trim();
      if ((cashOrderId ? 1 : 0) + (layawayPlanId ? 1 : 0) !== 1) {
        return jsonResponse({ error: "exactly_one_target_required" }, 400);
      }
      let targetInvoiceNumber: string | null = null;
      if (cashOrderId) {
        const { data: order, error: oErr } = await supabase
          .from("cash_orders").select("id, invoice_number")
          .eq("id", cashOrderId).eq("customer_id", customer.id).maybeSingle();
        if (oErr) throw oErr;
        if (!order) return notFound();
        targetInvoiceNumber = String((order as AnyRec).invoice_number ?? "") || null;
      } else {
        const { data: plan, error: pErr } = await supabase
          .from("layaway_accounts").select("id, invoice_number")
          .eq("id", layawayPlanId).eq("customer_id", customer.id).maybeSingle();
        if (pErr) throw pErr;
        if (!plan) return notFound();
        targetInvoiceNumber = String((plan as AnyRec).invoice_number ?? "") || null;
      }

      // More than five open ('requested') requests and the customer must wait
      // for staff to move one along first.
      const { count, error: cErr } = await supabase
        .from("service_requests")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", customer.id)
        .eq("status", "requested");
      if (cErr) throw cErr;
      if ((count ?? 0) > 5) {
        return jsonResponse({ error: "too_many_open_requests" }, 429);
      }

      const { data: created, error: iErr } = await supabase
        .from("service_requests")
        .insert({
          customer_id: customer.id,
          kind,
          details,
          ring_size: ringSize,
          item_title: itemTitle,
          cash_order_id: cashOrderId || null,
          layaway_account_id: layawayPlanId || null,
          status: "requested",
        })
        .select("id, kind, status, item_title, details, ring_size, cash_order_id, layaway_account_id, customer_note, created_at, updated_at")
        .single();
      if (iErr) throw iErr;

      // Staff bell, non-blocking — a notification failure must never fail the
      // request that was just created successfully.
      try {
        const customerName = String(customer.full_name ?? customer.customer_code ?? "Customer");
        const itemLabel = itemTitle ?? "no item";
        const detailsSnippet = details.length > 120 ? details.slice(0, 120) : details;
        await supabase.from("staff_notifications").insert({
          type: "service_request_created",
          title: `Service request: ${kind}`,
          body: `${customerName} — ${targetInvoiceNumber ?? "no invoice"} · ${itemLabel} · ${detailsSnippet}`,
          customer_id: customer.id,
          invoice_number: targetInvoiceNumber,
          metadata: {
            service_request_id: (created as AnyRec).id,
            kind,
            cash_order_id: cashOrderId || null,
            layaway_account_id: layawayPlanId || null,
          },
        });
      } catch (notifyErr) {
        console.warn("[website] service_request_created notification failed (non-blocking):", notifyErr);
      }

      const { layaway_account_id, ...rest } = created as AnyRec;
      return jsonResponse({ ...rest, layaway_plan_id: layaway_account_id ?? null });
    }

    // POST /newsletter — public subscribe. x-api-key only; a customer session
    // is optional and, when present and resolvable, links customer_id.
    if (req.method === "POST" && segments[0] === "newsletter" && !segments[1]) {
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
      if (rateLimited(newsletterHits, ip)) return jsonResponse({ error: "rate_limited" }, 429);

      const body = await req.json().catch(() => ({}));
      const email = String(body?.email ?? "").trim();
      const lang = String(body?.lang ?? "en").trim().toLowerCase();
      const sourceRaw = body?.source === undefined || body?.source === null ? null : String(body.source).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
        return jsonResponse({ error: "invalid_email" }, 400);
      }
      if (!["en", "ja"].includes(lang)) return jsonResponse({ error: "invalid_lang" }, 400);
      if (sourceRaw !== null && sourceRaw.length > 64) return jsonResponse({ error: "invalid_source" }, 400);

      const status = await upsertNewsletterSubscriber(supabase, {
        email,
        lang,
        source: sourceRaw || null,
        customerId: await optionalCustomerId(req, supabase),
      });
      return jsonResponse({ status });
    }

    // POST /contact — public contact form. x-api-key only; a customer session
    // is optional and, when present and resolvable, links customer_id.
    if (req.method === "POST" && segments[0] === "contact" && !segments[1]) {
      const body = await req.json().catch(() => ({}));

      // Honeypot: a real visitor never fills `company`. Answer as if accepted
      // and write nothing — a bot must not learn it was filtered.
      if (String(body?.company ?? "").trim() !== "") {
        return jsonResponse({ status: "received" });
      }

      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
      if (rateLimited(contactHits, ip)) return jsonResponse({ error: "rate_limited" }, 429);

      const fullName = String(body?.full_name ?? "").trim();
      const email = String(body?.email ?? "").trim();
      const phoneRaw = body?.phone === undefined || body?.phone === null ? null : String(body.phone).trim();
      const message = String(body?.message ?? "").trim();
      const lang = String(body?.lang ?? "en").trim().toLowerCase();
      const pageRaw = body?.page === undefined || body?.page === null ? null : String(body.page).trim();
      const wantsNewsletter = body?.newsletter === true;

      if (fullName.length < 1 || fullName.length > 120) return jsonResponse({ error: "invalid_full_name" }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
        return jsonResponse({ error: "invalid_email" }, 400);
      }
      if (phoneRaw !== null && phoneRaw.length > 40) return jsonResponse({ error: "invalid_phone" }, 400);
      if (message.length < 10 || message.length > 2000) return jsonResponse({ error: "invalid_message" }, 400);
      if (!["en", "ja"].includes(lang)) return jsonResponse({ error: "invalid_lang" }, 400);
      if (pageRaw !== null && pageRaw.length > 200) return jsonResponse({ error: "invalid_page" }, 400);

      const customerId = await optionalCustomerId(req, supabase);

      // id / created_at / updated_at / status are defaulted columns — never
      // sent in the payload (status defaults to 'new').
      const { data: inserted, error: insErr } = await supabase
        .from("contact_inquiries")
        .insert({
          full_name: fullName,
          email,
          phone: phoneRaw || null,
          message,
          lang,
          page: pageRaw || null,
          customer_id: customerId,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;

      if (wantsNewsletter) {
        await upsertNewsletterSubscriber(supabase, { email, lang, source: "contact", customerId });
      }

      // Staff bell, non-blocking.
      try {
        await supabase.from("staff_notifications").insert({
          type: "contact_inquiry",
          title: "New contact message",
          body: `${fullName} <${email}> — ${message.slice(0, 120)}`,
          customer_id: customerId,
          metadata: { id: (inserted as AnyRec).id, lang, page: pageRaw || null },
        });
      } catch (notifyErr) {
        console.warn("[website] contact_inquiry notification failed (non-blocking):", notifyErr);
      }

      return jsonResponse({ status: "received" });
    }

    // GET /newsletter/unsubscribe?token=<uuid> — always 200 whether or not
    // the token matched, so existence is never leaked.
    if (req.method === "GET" && segments[0] === "newsletter" && segments[1] === "unsubscribe") {
      const token = (url.searchParams.get("token") ?? "").trim();
      if (/^[0-9a-fA-F-]{36}$/.test(token)) {
        const { error: upErr } = await supabase
          .from("newsletter_subscribers")
          .update({ unsubscribed_at: new Date().toISOString() })
          .eq("unsubscribe_token", token)
          .is("unsubscribed_at", null);
        if (upErr) throw upErr;
      }
      return jsonResponse({ status: "unsubscribed" });
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
