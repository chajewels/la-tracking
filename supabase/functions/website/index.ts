import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { pickLang } from "../_shared/storefront-email.ts";
import { resolveItemImages } from "../_shared/item-images.ts";
import { regionForCurrency, transferMethods } from "../_shared/transfer-methods.ts";
import { jpyToPhpHalfUp, settleFullPaymentInPhp } from "../_shared/settlement.ts";
import { attachDownPayments, planLayawayQuote, variantPricePhp } from "../_shared/website-down-payments.ts";
import { sendDraftReservedEmail, sendOrderReadyEmail } from "../_shared/reservation-emails.ts";
import { DECISION_FIELDS, DECIDED_STATUSES, latestDecision, newestDecided, switchedSinceDecision, type DecisionRow } from "../_shared/latest-decision.ts";
import { type CustomerMethod, type SwitchInput, canCustomerSwitch, customerSwitchEmailKey, switchTargets } from "../_shared/method-switch-rules.ts";
import {
  loyaltyEnabledFrom, previewEarn, previewEarnAsNewMember,
  type EarnMember, type EarnPromo, type EarnTier,
} from "../_shared/loyalty-earn.ts";
import {
  NOT_READY_FOR_PAYMENT, isUnconfirmedReservation, reservationFlags,
  type ReservationKind,
} from "../_shared/web-reservation-rules.ts";
import {
  isPaidyPublicKey, paidyAddressLines, paidyBillingChoice, paidyBuyerHistory, paidyCheckoutBreakdown,
  paidyCheckoutPayload, paidyCustomerRecordAddress, paidyDob, paidyHistoryFromLayaway, paidyJapaneseMobile,
  paidyBuyerName, paidyModeFrom, paidyNameField, paidyNoteDecision, paidyNotOfferedReason, paidyPointsBeforeOrder, paidyRequirements,
} from "../_shared/paidy-rules.ts";
import { PaidyError, isPaidyPaymentId, paidy, paidySecretIsTest, type PaidyPayment } from "../_shared/paidy.ts";
import { type SquareEnvironment, agreementBindingProblem, agreementRequired, canonicalYen, cardIdempotencyKey, cardNotOfferedReason, cardVerificationEvidence, newAttemptReference, squareAudienceFrom, squareCardAllowed, squareCardCustomerIds, squareModeFrom, termsTimeProblem } from "../_shared/card-rules.ts";
import { SquareError, buyerEmailOf, paymentFacts, square, type SquarePayment } from "../_shared/square.ts";
import { fileForAttempt, fraudCancel, handleFilingException, recoverAttempt, resolveAttempt, rpc } from "../_shared/square-sync.ts";
import { customerReference } from "../_shared/order-reference.ts";
import { adoptOrphanAuthorization, filePaidyAuthorization } from "../_shared/paidy-filing.ts";
import { PENDING_SUBMISSION_OR } from "../_shared/web-order-rules.ts";
import { hubFxRate, type FxRate as HubFxRate } from "../_shared/php-jpy-rate.ts";
import {
  CHECKOUT_METHODS, type CheckoutMethod, checkoutMethodOptions, maxUsablePoints, pointsChoiceProblem, pointsUnavailableReason,
  pointsValue, publicMethod, storedMethod,
} from "../_shared/checkout-choice.ts";
import { attachHeroCutouts, attachHeroPlaces, handleHeroCutouts } from "../_shared/hero-cutouts.ts";
import { webLayawaySubmissionIsDeposit, type DepositPaymentRow, type PendingSubmissionRow } from "../_shared/layaway-deposit-rules.ts";
import { INVALID_PROOF_URL, isOwnProofUrl } from "../_shared/proof-url.ts";
import { customerCancellationReason } from "../_shared/customer-reasons.ts";
import { codFeeJpy, codFeeTable, codModeFrom, codNotOfferedReason } from "../_shared/cod-fee.ts";
import { sendOrderUpdateEmail } from "../_shared/order-update-email.ts";

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
  "id, sku, slug, name, name_ja, karat, metals, weight_g, description_en, description_ja, status, condition, origin, brand, item_kind, video_url, video_poster_url, updated_at";

/** website_products.item_kind → the contract's Product.item_type (D2-1). */
const ITEM_TYPE_OF: Record<string, "Jewelry" | "Watch" | "Accessory"> = {
  jewelry: "Jewelry",
  watch: "Watch",
  accessory: "Accessory",
};
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
  if (!data) return { enrolled: false, points: 0, tier: null, multiplier: null, reduced: false, earned_tier: null, regain_jpy: null, lifetime_jpy: 0, next_tier: null, next_threshold_jpy: null, to_next_jpy: null };
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
  // Storefront step 4 (2026-09-30): lifetime spend and the next level up.
  // While the level is reduced the regain figure covers that state, so the
  // next_* fields stay null; on the top level there is no higher tier.
  const lifetimeJpy = Number(row.cumulative_spend_jpy ?? 0);
  let nextTier: string | null = null;
  let nextThreshold: number | null = null;
  if (!reduced) {
    const { data: next, error: nextErr } = await supabase
      .from("loyalty_tiers")
      .select("name, min_spend_jpy")
      .gt("min_spend_jpy", lifetimeJpy)
      .order("min_spend_jpy", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (nextErr) throw nextErr;
    if (next) {
      nextTier = String((next as AnyRec).name ?? "") || null;
      nextThreshold = Number((next as AnyRec).min_spend_jpy);
    }
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
    lifetime_jpy: lifetimeJpy,
    next_tier: nextTier,
    next_threshold_jpy: nextThreshold,
    to_next_jpy: nextThreshold == null ? null : Math.max(0, Math.round(nextThreshold - lifetimeJpy)),
  };
}


/**
 * The peso rate for every ₱ figure this function produces: the Hub's
 * system_settings.php_jpy_rate (ONE PESO RATE, owner decision 2026-10-03;
 * _shared/php-jpy-rate.ts). price_php is derived per request, never stored.
 */
type FxRate = HubFxRate;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function latestFx(supabase: any): Promise<FxRate | null> {
  return await hubFxRate(supabase);
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
  // D2-1: the piece's type as the contract names it (null when unknown), and
  // its video. The storefront shows the Type filter and the video slot only
  // when these are present; it never infers either.
  product.item_type = ITEM_TYPE_OF[String(product.item_kind ?? "")] ?? null;
  delete product.item_kind;
  product.video_url = nonEmpty(product.video_url);
  product.video_poster_url = product.video_url ? nonEmpty(product.video_poster_url) : null;
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
  "currency, total_amount, total_paid, remaining_balance, shipping_fee, cod_fee, transfer_due_at, " +
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
  product_unavailable: 409, // QC 2026-10-06: unpublished after the quote
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
  // Website orders PR 6 (draft mode): create_web_draft_atomic's refusals.
  agreement_missing: 400,
  unsupported_mode: 400,
  checkout_mode_not_draft: 409,
  // Checkout payment choice + points (2026-10-05): create_web_draft_atomic's
  // re-checks of what /checkout/quote/:id/choice already validated.
  bad_method: 400,
  method_full_payment_only: 409,
  method_requires_yen: 409,
  method_unavailable: 409,
  bad_points: 400,
  points_unavailable: 409,
  points_not_enrolled: 409,
  points_insufficient: 409,
  points_exceed_subtotal: 409,
  points_exceed_deposit: 409,
  // Cash on delivery (owner plan 2026-10-10).
  over_cod_limit: 409,
  cod_nothing_to_collect: 409,
};

/**
 * WEBSITE ORDERS PR 6: what a customer may see of their own draft. Money is in
 * the settlement currency and PROVISIONAL (shipping may be added — shipping
 * null — and staff may add a service or discount when they confirm).
 * decline_reason is the reason the customer is told; staff notes never leave.
 */
const DRAFT_FIELDS =
  "id, web_reference, status, mode, term_months, settlement_currency, subtotal, shipping, total, deposit, schedule, decline_reason, created_at, decided_at, cash_order_id, layaway_account_id, payment_method, points, points_value, cod_fee";

function shapeDraft(d: AnyRec): AnyRec {
  return {
    id: d.id,
    kind: "draft",
    web_reference: d.web_reference,
    status: d.status,
    mode: d.mode,
    term_months: d.term_months ?? null,
    currency: String(d.settlement_currency ?? "JPY") === "PHP" ? "PHP" : "JPY",
    subtotal: d.subtotal,
    shipping: d.shipping ?? null,
    shipping_pending: d.shipping === null || d.shipping === undefined,
    total: d.total,
    deposit: d.deposit ?? null,
    schedule: d.schedule ?? null,
    provisional: d.status === "to_confirm",
    decline_reason: d.status === "declined" ? (d.decline_reason ?? null) : null,
    created_at: d.created_at,
    decided_at: d.decided_at ?? null,
    // Set once staff confirm: the storefront redirects to the real order.
    order_id: d.cash_order_id ?? null,
    account_id: d.layaway_account_id ?? null,
    // C1–C5 (2026-10-05): the method she chose (locked for her) and the points
    // she used — held now, taken when staff confirm, given back if declined.
    payment_method: publicMethod(d.payment_method),
    points: Number(d.points ?? 0),
    points_value: Number(d.points_value ?? 0),
    // Cash on delivery (2026-10-10): the 代引手数料, its own line, already in
    // `total`. 0 for every other method.
    cod_fee: Number(d.cod_fee ?? 0),
    // Payment lifecycle H6 (2026-10-05): what is left to pay once the points
    // are taken off — the Hub's figure, the storefront computes nothing. On a
    // layaway draft the points pay the DEPOSIT (the deposit already shows
    // that), so the total is unchanged.
    total_after_points: draftTotalAfterPoints(d),
  };
}

/** max(0, total − points_value) on a full-payment draft; the total itself on a layaway draft. */
function draftTotalAfterPoints(d: AnyRec): number {
  const total = Number(d.total ?? 0);
  if (!Number.isFinite(total)) return 0;
  if (d.mode === "layaway") return total;
  const pv = Number(d.points_value ?? 0);
  return Math.max(0, total - (Number.isFinite(pv) ? pv : 0));
}

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

/**
 * cash_order_payment_lock() for an order: why it cannot take another payment
 * right now (a Paidy window open, a Paidy payment waiting / taken but not yet
 * recorded, or any other payment waiting for review), or null. Owner rule
 * 2026-10-04: while Paidy is processing, the customer sees no other way to pay.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function paymentLock(supabase: any, orderId: string, opts: { ignorePaidyRow?: string | null; ignoreAttempts?: boolean } = {}): Promise<string | null> {
  const { data, error } = await supabase.rpc("cash_order_payment_lock", {
    p_cash_order_id: orderId, p_ignore_paidy_row: opts.ignorePaidyRow ?? null, p_ignore_attempts: opts.ignoreAttempts === true,
  });
  if (error) throw error;
  return typeof data === "string" && data ? data : null;
}

/**
 * Yen/peso applied to a cash order by points chosen at checkout (the LOYALTY-
 * discount lines, public.cash_order_points_paid). A discount, never money.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function orderPointsApplied(supabase: any, orderId: string): Promise<number> {
  const { data, error } = await supabase.rpc("cash_order_points_paid", { p_cash_order_id: orderId });
  if (error) throw error;
  const n = Number(data ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * PAIDY ato-barai ON A CONFIRMED ORDER (2026-10-03; follow-up 2026-10-04,
 * docs/PAIDY.md).
 *
 * Whether 『あと払い（ペイディ）』 is offered on this order, and — when it is —
 * the complete Paidy Checkout payload the storefront passes to
 * `Paidy.launch()` untouched. Every figure in it is the Hub's:
 *   - offered only while NOTHING is paid on the order (owner D2), so the
 *     amount is the whole order and the items + shipping − discount add up to
 *     it exactly (R10; paidyCheckoutBreakdown, else not offered);
 *   - the buyer is the CUSTOMER — never the delivery recipient (R11); her
 *     billing address from her own default address-book entry when it is a
 *     complete Japanese address, else her own customer record when that is
 *     (H9, paidyBillingChoice — PA15B: or the entry she chose); her phone only when it is a Japanese mobile
 *     (R13); dob from customers.birthday; points held before this order;
 *   - history = her completed yen cash orders not paid with Paidy and not
 *     refunded, plus her completed yen layaway plans (H9), by order value,
 *     last order in days (R12); registration date only from her customer
 *     record.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * P06 (2026-10-08): every row of a query, 500 at a time, no cap — Paidy's
 * buyer history (order_count, ltv, last order) must cover ALL her orders, not
 * the newest 200. Throws on a read error; the caller then withholds Paidy
 * rather than send Paidy incomplete figures.
 *
 * PA11 (2026-10-09): KEYSET paging on the primary key — `id > last id`,
 * ordered by id — never an offset over a non-unique sort (completed_at ties
 * and NULLs could skip or repeat rows between pages). The query handed in
 * must select `id` and must NOT order itself.
 */
// deno-lint-ignore no-explicit-any
async function allRows(build: () => any): Promise<AnyRec[]> {
  const PAGE = 500;
  const out: AnyRec[] = [];
  let after: string | null = null;
  for (;;) {
    let q = build();
    if (after !== null) q = q.gt("id", after);
    const { data, error } = await q.order("id", { ascending: true }).limit(PAGE);
    if (error) throw error;
    const rows = (data ?? []) as AnyRec[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
    after = String(rows[rows.length - 1].id);
  }
}

/**
 * PA11 (2026-10-09): `.in()` over many ids in ONE request can exceed the URL
 * limit for a long-standing customer and turn into a read error (Paidy then
 * withheld for the wrong reason). The ids go in chunks of 100; every chunk is
 * read in full (allRows) and the rows are concatenated.
 */
const IN_CHUNK = 100;
// deno-lint-ignore no-explicit-any
async function allRowsIn(ids: string[], build: (chunk: string[]) => any): Promise<AnyRec[]> {
  const out: AnyRec[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    out.push(...await allRows(() => build(chunk)));
  }
  return out;
}

// PA15B (2026-10-09): billingAddressId = the address-book entry SHE chose for
// Paidy's billing (POST /orders/:id/paidy/start); null = preselect (default first).
async function paidyOffer(supabase: any, customer: AnyRec, order: AnyRec, address: AnyRec | null, items: AnyRec[], pendingCount: number, lock: string | null, billingAddressId: string | null = null) {
  const [{ data: modeRow }, { data: keyRow }] = await Promise.all([
    supabase.from("system_settings").select("value").eq("key", "paidy_mode").maybeSingle(),
    supabase.from("system_settings").select("value").eq("key", "paidy_public_key").maybeSingle(),
  ]);
  const mode = paidyModeFrom((modeRow as AnyRec | null)?.value);
  const rawKey = (keyRow as AnyRec | null)?.value;
  const publicKey = typeof rawKey === "string" ? rawKey : (rawKey == null ? "" : String(rawKey));

  const orderRef = customerReference(order as never);
  const [{ data: money, error: moneyErr }, { data: cust, error: custErr }, pointsApplied, { data: billing, error: billErr }] = await Promise.all([
    supabase.from("cash_orders").select("discount_amount, shipping_fee, total_amount").eq("id", order.id).maybeSingle(),
    supabase.from("customers").select("created_at, mobile_number, full_name, family_name, given_name, birthday, address_line1, city, postal_code, country").eq("id", customer.id).maybeSingle(),
    orderPointsApplied(supabase, String(order.id)),
    supabase.from("customer_addresses").select("id, is_default, line1, line2, city, region, postal_code, country")
      .eq("customer_id", customer.id).order("created_at"),
  ]);
  if (moneyErr) throw moneyErr;
  if (custErr) throw custErr;
  if (billErr) throw billErr;
  // Points used at checkout (2026-10-05) are a discount already applied: the
  // breakdown carries a negative "Points" line and they are not "paid".
  const breakdown = paidyCheckoutBreakdown({ ...(order as AnyRec), ...((money ?? {}) as AnyRec), points_applied: pointsApplied }, items, orderRef);
  // P05 (owner 2026-10-08): the buyer's name is her two name fields, never a
  // guess from full_name; her billing address and mobile must be Japanese.
  const c = (cust ?? {}) as AnyRec;
  const buyerName = paidyBuyerName(c.family_name, c.given_name);
  const bill = paidyBillingChoice((billing ?? []) as AnyRec[], paidyCustomerRecordAddress(c), billingAddressId);
  const requirements = paidyRequirements({ family_name: c.family_name, given_name: c.given_name, mobile_number: c.mobile_number, billingAddressFound: !!bill.address });
  // PA15A (2026-10-09): what is already on file, so the order page can prefill
  // the name fields instead of starting empty (her own data, her own session).
  const onFile = {
    mobile_number: typeof c.mobile_number === "string" ? c.mobile_number : null,
    names: { family_name: typeof c.family_name === "string" ? c.family_name : null, given_name: typeof c.given_name === "string" ? c.given_name : null },
  };
  if (bill.reason === "billing_address_invalid") return { offered: false as const, reason: "billing_address_invalid", requirements, ...onFile };

  const reason = paidyNotOfferedReason({
    mode, publicKey, customerIsTest: customer.is_test === true, order, address, pendingSubmissions: pendingCount,
    totalPaid: Number(order.total_paid ?? 0) - pointsApplied, paymentLock: lock, buyerName, breakdownOk: breakdown != null,
    // C1: a website order takes Paidy only when the customer chose Paidy.
    paymentMethod: (order.payment_method ?? null) as string | null,
    requirements,
  });
  if (reason || !breakdown) return { offered: false as const, reason: reason ?? "breakdown_mismatch", requirements, ...onFile };

  // R12 / P06: her own completed yen orders (this one excluded) — ALL of them
  // — classified by how they were paid and whether anything was refunded. A
  // read that fails withholds Paidy; incomplete figures are never sent.
  let history: ReturnType<typeof paidyBuyerHistory>;
  let plans: AnyRec[] = [];
  try {
    const past = await allRows(() => supabase.from("cash_orders")
      .select("id, status, currency, total_amount, completed_at, order_date")
      .eq("customer_id", customer.id).eq("status", "completed").eq("currency", "JPY").neq("id", order.id)
      .filter("invoice_number", "match", "^[0-9]+$"));
    const pastIds = past.map((o) => String(o.id));
    // PA11: "refunded" = a verified Paidy refund OR a Square refund that did
    // not fail (owner decision 2026-10-09) — any money given back takes the
    // order out of her clean history.
    const [paidyPaid, paidyRefunded, squareRefunded] = await Promise.all([
      allRowsIn(pastIds, (chunk) => supabase.from("cash_payments").select("id, cash_order_id").in("cash_order_id", chunk).eq("payment_method", "paidy").is("voided_at", null)),
      allRowsIn(pastIds, (chunk) => supabase.from("paidy_refunds").select("id, cash_order_id").in("cash_order_id", chunk)),
      allRowsIn(pastIds, (chunk) => supabase.from("square_refunds").select("id, cash_order_id").in("cash_order_id", chunk).not("status", "in", "(FAILED,REJECTED)")),
    ]);
    // H9: her completed yen layaway plans count as orders too (Paidy: ltv /
    // order_count cover every order at the store). Paidy never pays a plan.
    plans = await allRows(() => supabase.from("layaway_accounts")
      .select("id, status, currency, total_amount, completed_at, order_date")
      .eq("customer_id", customer.id).eq("status", "completed").eq("currency", "JPY")
      .filter("invoice_number", "match", "^[0-9]+$"));
    const byPaidy = new Set(paidyPaid.map((r) => String(r.cash_order_id)));
    const byRefund = new Set([...paidyRefunded, ...squareRefunded].map((r) => String(r.cash_order_id)));
    history = paidyBuyerHistory([
      ...past.map((o) => ({ ...o, paid_by_paidy: byPaidy.has(String(o.id)), refunded: byRefund.has(String(o.id)) })),
      ...paidyHistoryFromLayaway(plans),
    ]);
  } catch (e) {
    console.error("[paidy] buyer history unavailable — Paidy withheld:", e);
    return { offered: false as const, reason: "history_unavailable", requirements, ...onFile };
  }
  const { data: member, error: memberErr } = await supabase.from("loyalty_members").select("remaining_points").eq("customer_id", customer.id).maybeSingle();
  if (memberErr) throw memberErr;
  const registered = String(c.created_at ?? "").slice(0, 10);
  const phone = paidyJapaneseMobile(c.mobile_number);
  // No address text, no email — only why Paidy gets no billing address.
  if (!bill.address) console.log(`[paidy] billing_address omitted: ${bill.reason}`);

  return {
    offered: true as const,
    public_key: publicKey,
    test: mode === "test",
    requirements,
    ...onFile,
    // PA15B: where Paidy may bill her (her complete Japanese entries, default
    // first) and the one this payload uses; the delivery address stays the
    // order's own (shipping_address below).
    billing_choices: bill.choices,
    billing_address_id: bill.id,
    checkout: paidyCheckoutPayload({
      amount: breakdown.amount,
      orderRef,
      cashOrderId: String(order.id),
      customerId: String(customer.id),
      userId: String(customer.customer_code ?? customer.id),
      email: customer.email ? String(customer.email) : undefined,
      name1: buyerName,
      phone: phone ?? undefined,
      dob: paidyDob(c.birthday),
      history,
      registered: registered || undefined,
      billing: bill.address,
      // Points held before this order: Confirm already took this order's.
      numberOfPoints: paidyPointsBeforeOrder(member as AnyRec | null, pointsApplied),
      items: breakdown.items,
      shipping: breakdown.shipping,
      shippingAddress: paidyAddressLines(address as AnyRec),
    }),
  };
}

/** F-11 / D-QC4: card is not offered for a reason of SET-UP (not of the order) → show transfer instead. */
const CARD_SETUP_REASONS = new Set([
  "mode_off", "test_mode_real_customer", "not_on_card_list", "no_app_id", "app_id_mode_mismatch", "no_location_id",
]);

/**
 * Card payment (Square) on a confirmed order — S2, 2026-10-04, docs/SQUARE.md.
 * Twin of paidyOffer: the switch + PUBLIC ids come from system_settings, the
 * rule from _shared/card-rules.ts (yen, confirmed, money due, no pending
 * submission; ANY country — owner D4). The storefront gets the ids it needs
 * for the Web Payments SDK and the Hub's amount; it computes nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cardOffer(supabase: any, customer: AnyRec, order: AnyRec, pendingCount: number, cardUnresolved: boolean) {
  const rows = await supabase.from("system_settings").select("key, value")
    .in("key", ["square_mode", "square_app_id", "square_location_id", "card_agreement_min_jpy", "square_audience", "square_card_customer_ids"]);
  if (rows.error) throw rows.error;
  const setting = (k: string) => ((rows.data ?? []) as AnyRec[]).find((r) => r.key === k)?.value;
  const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  const mode = squareModeFrom(setting("square_mode"));
  const appId = str(setting("square_app_id"));
  const locationId = str(setting("square_location_id"));
  const minRaw = setting("card_agreement_min_jpy");
  const agreementMin = Number(typeof minRaw === "string" ? minRaw.replace(/"/g, "") : minRaw ?? 0);
  // D-G04 (owner 2026-10-09): while on, only the listed customers unless the audience is everyone.
  const cardAllowed = squareCardAllowed({
    mode, audience: squareAudienceFrom(setting("square_audience")), listed: squareCardCustomerIds(setting("square_card_customer_ids")),
    customerId: customer.id == null ? null : String(customer.id), customerIsTest: customer.is_test === true,
  });
  const reason = cardNotOfferedReason({
    mode, appId, locationId, customerIsTest: customer.is_test === true, order, pendingSubmissions: pendingCount, cardUnresolved, cardAllowed,
    // C1: a website order takes a card only when the customer chose card.
    paymentMethod: (order.payment_method ?? null) as string | null,
  });
  if (reason) return { offered: false as const, reason };
  // Exact integer yen (SQ12): cardNotOfferedReason refused anything else.
  const amountJpy = Number(order.remaining_balance);
  return {
    offered: true as const,
    app_id: appId,
    location_id: locationId,
    test: mode === "test",
    amount_jpy: amountJpy,
    // Owner 4A / 5A (2026-10-04): the cardholder-name default (her own name,
    // never a gift recipient's) and the customer the Card Purchase Agreement
    // must be signed for (her own id — the storefront signs the agreement link
    // with it and checks the lookup's answer against it).
    customer_id: String(customer.id),
    cardholder_name: typeof customer.full_name === "string" ? customer.full_name : null,
    // WEB-4 (2026-10-05): her own email on the Hub record, passed through for
    // Square's buyer verification (3-D Secure: "as much buyer information as
    // possible"). Absent or not an address → null. No phone: Square's expected
    // phone format is not documented for Japan, and a bad one could fail the token.
    buyer_email: buyerEmailOf(customer.email),
    // D9: the signed Card Purchase Agreement, required at or above the
    // threshold (0 = every card payment). The storefront gates on it BEFORE
    // the card form; the Hub refuses the payment without it (agreement_missing).
    agreement_required: agreementRequired(amountJpy, agreementMin),
    agreement_min_jpy: Number.isFinite(agreementMin) ? agreementMin : 0,
  };
}

/**
 * The customer-facing state of an unresolved card payment on an order (owner
 * 3A, SQ11/SQ22), or null when nothing is unresolved. Mirrors
 * public.square_order_unresolved.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cardPaymentState(supabase: any, orderId: string): Promise<AnyRec | null> {
  const { data: att, error: aErr } = await supabase.from("square_card_attempts")
    .select("reference, status, created_at").eq("cash_order_id", orderId)
    .in("status", ["reserved", "unknown", "cancelling"]).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (aErr) throw aErr;
  if (att) return { state: "processing", reference: att.reference, since: att.created_at };
  const { data: hold, error: hErr } = await supabase.from("square_payments")
    .select("status, action, cash_payment_id, exception_resolved_at, authorized_at, capture_by, card_brand, card_last4, reference")
    .eq("cash_order_id", orderId)
    .or("status.eq.authorized,and(status.eq.captured,cash_payment_id.is.null,exception_resolved_at.is.null)")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (hErr) throw hErr;
  if (!hold) return null;
  const state = hold.status === "captured" ? "recording" : hold.action === "capture" ? "capturing" : "held";
  return { state, reference: hold.reference ?? null, since: hold.authorized_at, capture_by: hold.capture_by, brand: hold.card_brand, last4: hold.card_last4 };
}

/**
 * PAYMENT LIFECYCLE H6 (2026-10-05): the decided submissions (rejected /
 * needs_clarification / confirmed) on one order or plan, newest first in the
 * SQL writer's own order. A SEPARATE read from pending_submissions, which
 * keeps its exact shape. Feeds latestDecision / newestDecided.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function decidedSubmissions(supabase: any, column: "cash_order_id" | "account_id", id: string): Promise<DecisionRow[]> {
  const { data, error } = await supabase.from("payment_submissions")
    .select(DECISION_FIELDS)
    .eq(column, id).in("status", [...DECIDED_STATUSES])
    .order("updated_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []) as DecisionRow[];
}

/** The newest decided status, typed for canCustomerSwitch (confirmed included). */
function newestDecisionStatus(rows: DecisionRow[]): SwitchInput["latestDecision"] {
  const s = newestDecided(rows)?.status;
  return s === "rejected" || s === "needs_clarification" || s === "confirmed" ? s : null;
}

/**
 * One customer switch per rejection (H6 fix round 1): when her newest
 * decision is a rejection, has she already switched since it? One read of the
 * newest customer-actor payment_method_changed audit row — the same fact the
 * SQL writer checks (already_switched). No read when the newest decision is
 * not a rejection (canCustomerSwitch refuses not_rejected first anyway).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function customerSwitchedSinceDecision(supabase: any, orderId: string, decided: DecisionRow[]): Promise<boolean> {
  const newest = newestDecided(decided);
  if (!newest || newest.status !== "rejected") return false;
  const { data, error } = await supabase.from("audit_logs")
    .select("created_at")
    .eq("entity_type", "cash_order").eq("entity_id", orderId)
    .eq("action", "payment_method_changed").eq("new_value_json->>actor", "customer")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  const at = (data as AnyRec | null)?.created_at;
  return switchedSinceDecision(newest, typeof at === "string" ? at : null);
}

/** canCustomerSwitch's inputs for an order (everything except the target). */
function switchBase(order: AnyRec, lock: string | null, decided: DecisionRow[], switchedSince: boolean): Omit<SwitchInput, "to"> {
  return {
    status: String(order.status ?? ""),
    paymentStatus: (order.payment_status ?? null) as string | null,
    sourceChannel: (order.source_channel ?? null) as string | null,
    lock,
    latestDecision: newestDecisionStatus(decided),
    switchedSinceDecision: switchedSince,
    currency: String(order.currency ?? ""),
    from: (order.payment_method ?? null) as string | null,
  };
}

/**
 * D1: is this target method OFFERED on the order right now, as if she had
 * chosen it? Transfer always; Paidy and card through the same offer rules
 * the order page uses (paidyOffer / cardOffer), with the order read as
 * carrying the target method (C1's method_not_chosen otherwise refuses).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function switchTargetOffered(supabase: any, customer: AnyRec, order: AnyRec, shipTo: AnyRec | null, items: AnyRec[], pendingCount: number, lock: string | null, cardUnresolved: boolean, to: CustomerMethod): Promise<boolean> {
  if (to === "transfer") return true;
  if (to === "cod") return (await codOffer(supabase, order, shipTo)).offered;
  const as = { ...order, payment_method: to };
  if (to === "paidy") {
    const o = await paidyOffer(supabase, customer, as, shipTo, items, pendingCount, lock);
    // QA 2026-10-08 (#4): a Paidy that only waits for HER details (names,
    // Japanese mobile, Japanese billing address) is still switchable — the
    // order page then collects them. Any other refusal keeps it off the list.
    return o.offered || PAIDY_DETAIL_REASONS.has(String(o.reason ?? ""));
  }
  if (cardUnresolved) return false;
  return (await cardOffer(supabase, customer, as, pendingCount, false)).offered;
}

/**
 * Cash on delivery on a confirmed web order (switch target): the same rule as
 * checkout (codNotOfferedReason) on what the courier would collect now —
 * remaining_balance without any COD fee already on it. The SQL writer
 * re-brackets and refuses the same way.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function codOffer(supabase: any, order: AnyRec, shipTo: AnyRec | null): Promise<{ offered: boolean; reason: string | null; fee_jpy: number | null }> {
  const { data, error } = await supabase.from("system_settings").select("key, value").in("key", ["cod_mode", "cod_fee_table"]);
  if (error) throw error;
  const setting = (k: string) => ((data ?? []) as AnyRec[]).find((r) => r.key === k)?.value;
  const table = codFeeTable(setting("cod_fee_table"));
  const collected = Number(order.remaining_balance ?? 0) - Number(order.cod_fee ?? 0);
  const reason = codNotOfferedReason({
    mode: "full", currency: String(order.currency ?? ""), country: (shipTo as AnyRec | null)?.country as string | null,
    codMode: codModeFrom(setting("cod_mode")), collectedJpy: collected, table,
  });
  return { offered: reason === null, reason, fee_jpy: reason === null ? codFeeJpy(collected, table) : null };
}

/** Paidy refusals the customer can fix herself on the order page (P05). */
const PAIDY_DETAIL_REASONS = new Set(["no_buyer_name", "no_jp_mobile", "no_jp_billing_address"]);

/** D1: the methods (public names) she may switch to now — allowed by the rules AND offered. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function customerSwitchMethods(supabase: any, customer: AnyRec, order: AnyRec, shipTo: AnyRec | null, items: AnyRec[], pendingCount: number, lock: string | null, cardUnresolved: boolean, decided: DecisionRow[]): Promise<CheckoutMethod[]> {
  const out: CheckoutMethod[] = [];
  const switchedSince = await customerSwitchedSinceDecision(supabase, String(order.id), decided);
  for (const to of switchTargets(switchBase(order, lock, decided, switchedSince))) {
    if (await switchTargetOffered(supabase, customer, order, shipTo, items, pendingCount, lock, cardUnresolved, to)) out.push(publicMethod(to));
  }
  return out;
}

/** POST /orders/:id/payment-method — HTTP status per refusal code. */
const SWITCH_ERROR_STATUS: Record<string, number> = {
  not_found: 404,
  not_web_order: 409,
  not_payable: 409,
  payment_in_progress: 409,
  not_rejected: 409,
  already_switched: 409,
  unchanged: 409,
  method_not_offered: 409,
  bad_method: 400,
  method_requires_yen: 400,
  // Cash on delivery (2026-10-10).
  method_unavailable: 409,
  over_cod_limit: 409,
  cod_nothing_to_collect: 409,
};

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
 * CHECKOUT PAYMENT CHOICE + POINTS (owner C1–C7, 2026-10-05). What the payment
 * step offers for a quote, and every figure the "Use points" panel shows. All
 * money is the Hub's: the storefront renders these numbers and computes none.
 *
 *   payment_options  transfer | paidy | card → { available, reason } (C2/C6:
 *                    greyed with a reason, never hidden)
 *   payment_method   the method stored on the quote (null until chosen)
 *   points           balance / held / spendable now, the most this checkout
 *                    can take (pieces subtotal; deposit on a layaway — owner:
 *                    the whole deposit is allowed), what is chosen, and why
 *                    points cannot be used when they cannot (C7)
 *   totals           the total and the amount due now after the chosen points
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function checkoutChoiceBlock(supabase: any, customer: AnyRec, q: {
  mode: "full" | "layaway"; currency: "JPY" | "PHP"; fxRate: number | null; country: string | null;
  subtotalJpy: number; subtotalSettle: number; totalSettle: number; deposit: number | null;
  paymentMethod: unknown; points: unknown;
}) {
  const { data: settings, error: setErr } = await supabase.from("system_settings").select("key, value")
    .in("key", ["paidy_mode", "square_mode", "loyalty_enabled", "square_audience", "square_card_customer_ids", "cod_mode", "cod_fee_table"]);
  if (setErr) throw setErr;
  const setting = (k: string) => ((settings ?? []) as AnyRec[]).find((r) => r.key === k)?.value;
  const loyaltyRaw = setting("loyalty_enabled");
  const loyaltyEnabled = loyaltyRaw === true || loyaltyRaw === "true";

  const { data: member, error: memErr } = await supabase.from("loyalty_members")
    .select("id, remaining_points").eq("customer_id", customer.id).maybeSingle();
  if (memErr) throw memErr;
  let held = 0;
  if (member) {
    const { data: pend, error: pendErr } = await supabase.from("loyalty_redemptions")
      .select("points_redeemed").eq("member_id", (member as AnyRec).id).eq("status", "pending");
    if (pendErr) throw pendErr;
    held = ((pend ?? []) as AnyRec[]).reduce((s, r) => s + Number(r.points_redeemed ?? 0), 0);
  }
  const balance = Math.max(0, Math.floor(Number((member as AnyRec | null)?.remaining_points ?? 0)));
  const reason = pointsUnavailableReason({ loyaltyEnabled, enrolled: !!member, remainingPoints: balance, heldPoints: held });
  const available = reason ? 0 : Math.max(0, balance - held);
  const limit = q.mode === "layaway" ? Number(q.deposit ?? 0) : q.subtotalSettle;
  const max = reason ? 0 : maxUsablePoints({ available, subtotalJpy: q.subtotalJpy, limitSettle: limit, currency: q.currency, rate: q.fxRate });
  const chosenRaw = Math.floor(Number(q.points ?? 0));
  const chosen = Number.isSafeInteger(chosenRaw) && chosenRaw > 0 && chosenRaw <= max ? chosenRaw : 0;
  const chosenValue = pointsValue(chosen, q.currency, q.fxRate);
  const method = q.paymentMethod == null || q.paymentMethod === "" ? null : publicMethod(q.paymentMethod);
  // Cash on delivery (owner plan 2026-10-10): the courier collects the pieces
  // after points + shipping (yen, full payment only); the fee is bracketed on
  // that amount and is never paid by points.
  const codTable = codFeeTable(setting("cod_fee_table"));
  const codCollected = q.mode === "full" && q.currency === "JPY" ? q.totalSettle - chosenValue : 0;
  const options = checkoutMethodOptions({
    mode: q.mode, currency: q.currency, country: q.country,
    paidyMode: paidyModeFrom(setting("paidy_mode")), squareMode: squareModeFrom(setting("square_mode")),
    customerIsTest: customer.is_test === true,
    squareAllowed: squareCardAllowed({
      mode: squareModeFrom(setting("square_mode")), audience: squareAudienceFrom(setting("square_audience")),
      listed: squareCardCustomerIds(setting("square_card_customer_ids")),
      customerId: customer.id == null ? null : String(customer.id), customerIsTest: customer.is_test === true,
    }),
    transferAvailable: await transferAvailable(supabase, q.currency),
    codMode: codModeFrom(setting("cod_mode")), codTable, codCollectedJpy: codCollected,
  });
  const codFee = method === "cod" && options.cod.available ? Number(options.cod.fee_jpy ?? 0) : 0;
  return {
    // Plan A.1: one entry per method, in display order; `offered: false`
    // carries why (the storefront greys it out with that reason).
    // COD also carries fee_jpy: what choosing it adds (null when not offered).
    payment_options: CHECKOUT_METHODS.map((m) => (m === "cod"
      ? { method: m, offered: options[m].available, reason: options[m].reason, fee_jpy: options.cod.fee_jpy ?? null }
      : { method: m, offered: options[m].available, reason: options[m].reason })),
    payment_method: method,
    points: {
      usable: reason === null && max > 0,
      reason,
      balance,
      held,
      available,
      // "You have 1,250 points (= ¥1,250)" — the value in THIS order's currency.
      available_value: pointsValue(available, q.currency, q.fxRate),
      max_points: max,
      max_value: pointsValue(max, q.currency, q.fxRate),
      chosen,
      chosen_value: chosenValue,
      applies_to: q.mode === "layaway" ? "deposit" : "pieces",
    },
    totals: {
      // Cash on delivery: the 代引手数料 when COD is the chosen method, else 0.
      // Already included in the two figures below.
      cod_fee: codFee,
      total_after_points: q.totalSettle - chosenValue + codFee,
      due_now_after_points: q.mode === "layaway" ? Math.max(0, Number(q.deposit ?? 0) - chosenValue) : q.totalSettle - chosenValue + codFee,
    },
  };
}

/** The delivery country of one of THIS customer's addresses, upper-case, or null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function addressCountry(supabase: any, customerId: string, addressId: unknown): Promise<string | null> {
  if (!addressId) return null;
  const { data, error } = await supabase.from("customer_addresses").select("country")
    .eq("id", String(addressId)).eq("customer_id", customerId).maybeSingle();
  if (error) throw error;
  const c = String((data as AnyRec | null)?.country ?? "").trim().toUpperCase();
  return c || null;
}

/**
 * Validate and store the customer's payment choice + points on her own unspent
 * quote (C1–C7). Re-derives every figure from the stored quote, exactly as
 * GET /checkout/quote/:id does, so the answer is the Hub's.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyCheckoutChoice(supabase: any, customer: AnyRec, quoteId: string, body: AnyRec):
  Promise<{ block: AnyRec } | { error: true; status: number; body: AnyRec }> {
  const fail = (status: number, b: AnyRec) => ({ error: true as const, status, body: b });
  if (!quoteId) return fail(400, { error: "quote_id_required" });
  const { data: q, error: qErr } = await supabase.from("checkout_quotes")
    .select("id, mode, term_months, subtotal_jpy, shipping_jpy, total_jpy, settlement_currency, fx_rate, expires_at, consumed_at, ship_to_address_id, payment_method, points")
    .eq("id", quoteId).eq("customer_id", customer.id).maybeSingle();
  if (qErr) throw qErr;
  if (!q) return fail(404, { error: "quote_not_found" });
  const row = q as AnyRec;
  if (row.consumed_at) return fail(409, { error: "quote_already_used" });
  if (row.expires_at && new Date(String(row.expires_at)) <= new Date()) return fail(409, { error: "quote_expired" });

  const mode: "full" | "layaway" = String(row.mode) === "layaway" ? "layaway" : "full";
  const currency: "JPY" | "PHP" = String(row.settlement_currency ?? "JPY") === "PHP" ? "PHP" : "JPY";
  const fxRate = row.fx_rate == null ? null : Number(row.fx_rate);
  const subtotalJpy = Number(row.subtotal_jpy ?? 0);
  const shippingJpy = row.shipping_jpy == null ? null : Number(row.shipping_jpy);
  const totalJpy = Number(row.total_jpy ?? 0);
  let totalSettle: number, subtotalSettle: number, shippingSettle: number | null;
  if (mode === "full" && fxRate !== null) {
    ({ total: totalSettle, shipping: shippingSettle, subtotal: subtotalSettle } = settleFullPaymentInPhp(totalJpy, shippingJpy, fxRate));
  } else {
    const toSettle = (jpy: number) => (fxRate === null ? jpy : jpyToPhpHalfUp(jpy, fxRate));
    totalSettle = toSettle(totalJpy);
    shippingSettle = shippingJpy === null ? null : toSettle(shippingJpy);
    subtotalSettle = totalSettle - (shippingSettle ?? 0);
  }
  let deposit: number | null = null;
  if (mode === "layaway") {
    // The same call create_web_draft_atomic makes, so the cap is its deposit.
    const { data: lq, error: lqErr } = await supabase.rpc("layaway_quote", {
      p_price: subtotalSettle, p_term_months: Number(row.term_months ?? 3), p_currency: currency,
      p_order_date: phtToday(), p_shipping: shippingSettle ?? 0, p_services: 0,
    });
    if (lqErr) throw lqErr;
    deposit = Number((lq as AnyRec | null)?.deposit ?? 0);
  }
  const country = await addressCountry(supabase, String(customer.id), row.ship_to_address_id);
  const figures = { mode, currency, fxRate, country, subtotalJpy, subtotalSettle, totalSettle, deposit };

  // The method: as sent, else what the quote already holds, else transfer.
  const methodIn = body.payment_method === undefined || body.payment_method === null || body.payment_method === ""
    ? (row.payment_method ?? "transfer") : body.payment_method;
  const stored = storedMethod(methodIn);
  if (!stored) return fail(400, { error: "bad_method" });
  const pointsIn = body.points === undefined || body.points === null ? Number(row.points ?? 0) : Number(body.points);

  // With the points she asks for: the COD limit is on what the courier collects
  // (pieces after points + shipping). Points themselves are checked below.
  const before = await checkoutChoiceBlock(supabase, customer, { ...figures, paymentMethod: null, points: pointsIn });
  const option = (before.payment_options as { method: CheckoutMethod; offered: boolean; reason: string | null; fee_jpy?: number | null }[])
    .find((o) => o.method === publicMethod(stored))!;
  if (!option.offered) {
    return fail(409, { error: "method_unavailable", method: publicMethod(stored), reason: option.reason });
  }
  const problem = pointsChoiceProblem(pointsIn, before.points.max_points, before.points.reason);
  if (problem) {
    return fail(409, { error: problem, max_points: before.points.max_points, points_available: before.points.available });
  }
  const codFeeJpyNow = stored === "cod" ? Number(option.fee_jpy ?? 0) : 0;
  const { error: upErr } = await supabase.from("checkout_quotes")
    .update({ payment_method: stored, points: pointsIn, cod_fee_jpy: codFeeJpyNow })
    .eq("id", quoteId).eq("customer_id", customer.id).is("consumed_at", null);
  if (upErr) throw upErr;
  return { block: await checkoutChoiceBlock(supabase, customer, { ...figures, paymentMethod: stored, points: pointsIn }) };
}

/**
 * WEBSITE ORDERS PR 10 (2026-10-01): every checkout is a DRAFT confirmed by
 * staff (docs/WEB-ORDER-DRAFTS.md). The reserve-first switch
 * (system_settings.web_reservation_mode) and the checkout-mode switch's
 * 'order' value are retired: nothing here reads either any more. The quote and
 * order responses keep the shape old storefront builds expect — reservation_mode
 * true, provisional true, no bank details before staff confirm.
 */
/**
 * The two reservation flags on an order or plan the customer reads, and
 * ready_confirmed_at itself taken back out: the storefront needs the answer,
 * not the column.
 */
function withReservationFlags(row: AnyRec, kind: ReservationKind): AnyRec {
  const { ready_confirmed_at: _ready, ...rest } = row;
  // Addendum §9 #10: an automatic fraud cancel is shown with the neutral
  // reason — the stored staff text never reaches the customer.
  if ("cancellation_reason" in rest) rest.cancellation_reason = customerCancellationReason(rest.cancellation_reason);
  return { ...rest, ...reservationFlags(row, kind) };
}

// The client type every helper in this file already takes (supabase: any) —
// named once here so the two helpers below stay consistent with it.
type WebsiteClient = Parameters<typeof customerForAuthUser>[0];

// POST /newsletter and POST /contact rate limiters: timestamps per IP,
// in-memory per isolate. Separate maps so the two limits are independent.
const newsletterHits = new Map<string, number[]>();
const contactHits = new Map<string, number[]>();
// POST /review-invite/:token — its own map, so reviews and forms never share a budget.
const reviewHits = new Map<string, number[]>();

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "Maria Santos Cruz" -> "Maria C." ; single word -> that word. */
function reviewDisplayName(fullName: unknown): string {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Customer";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

const REVIEW_PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const REVIEW_PHOTO_MAX = 5 * 1024 * 1024;

/** First product photo (variant sort, then media sort), or null. */
function firstProductImage(p: AnyRec | null): string | null {
  const variants = ((p?.product_variants ?? []) as AnyRec[]).slice().sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
  for (const v of variants) {
    const media = ((v.product_media ?? []) as AnyRec[]).slice().sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
    if (media[0]?.url) return String(media[0].url);
  }
  return null;
}

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
    // GET|POST /hero-cutouts — the storefront workflow's hero-only record
    // (docs/HERO-CUTOUTS.md). Needs x-hero-cutout-key = HERO_CUTOUT_KEY on
    // top of x-api-key; fails closed when the secret is unset.
    if (segments[0] === "hero-cutouts" && !segments[1]) {
      return await handleHeroCutouts(req, supabase, Deno.env.get("HERO_CUTOUT_KEY"), requestId);
    }

    // GET /paidy/widget — whether the storefront shows Paidy's N-Pay widget
    // under product prices (docs/PAIDY.md, owner W3 2026-10-03): ONLY while
    // paidy_mode is 'on'. 'test' keeps it hidden so customers never see the
    // banner before go-live. Public-safe: a boolean, no key. The storefront
    // re-reads it hourly, so flipping the switch needs no deploy.
    if (req.method === "GET" && segments[0] === "paidy" && segments[1] === "widget" && !segments[2]) {
      const { data: modeRow } = await supabase.from("system_settings").select("value").eq("key", "paidy_mode").maybeSingle();
      return jsonResponse({ enabled: paidyModeFrom((modeRow as AnyRec | null)?.value) === "on" });
    }

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
      await attachHeroCutouts(supabase, shaped);
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
      await attachHeroCutouts(supabase, shaped);
      // Hero order (20261016100000): hero_place, only while the hero uses ticked cut-outs.
      await attachHeroPlaces(supabase, shaped, (category as AnyRec).id);
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
      await attachHeroCutouts(supabase, [product]);
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
      await attachHeroCutouts(supabase, shaped);
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
    // web_reservation_mode is NOT a website_settings row: since PR 10 it is
    // the constant true (every checkout is staff-confirmed), kept so the
    // storefront's "awaiting confirmation" copy needs no build to agree.
    if (req.method === "GET" && segments[0] === "content" && segments[1] === "settings" && !segments[2]) {
      const { data, error } = await supabase
        .from("website_settings")
        .select("key, value")
        .eq("public", true)
        .order("key", { ascending: true });
      if (error) throw error;
      const settings: Record<string, unknown> = {};
      for (const row of (data ?? []) as AnyRec[]) settings[String(row.key)] = row.value;
      settings["web_reservation_mode"] = true;
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
        { count: draftCount },
        { data: cartConsent, error: consentErr },
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
        // Website orders PR 6: open drafts count as a record, or a customer
        // whose only checkout is still a draft raises a false blank-account bell.
        supabase.from("web_order_drafts")
          .select("id", { count: "exact", head: true }).eq("customer_id", customer.id).eq("status", "to_confirm"),
        // Cart reminders (stages A/B): the current consent state, so the
        // account page shows the true toggle. Absent row = off.
        supabase.from("customer_email_consents")
          .select("opted_in").eq("customer_id", customer.id).eq("kind", "cart_reminder").maybeSingle(),
      ]);
      if (addrErr) throw addrErr;
      if (consentErr) throw consentErr;

      const records = { layaway: layawayCount ?? 0, orders: orderCount ?? 0, drafts: draftCount ?? 0 };
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
      if (records.layaway === 0 && records.orders === 0 && records.drafts === 0 && sharesEmail) {
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
        // The cart-reminder opt-in (docs/CART-REMINDERS.md). Promotional, so
        // it is OFF until she ticks it; PUT /me/cart-reminders changes it.
        cart_reminders: { opted_in: (cartConsent as AnyRec | null)?.opted_in === true },
      }));
    }

    // GET /me/points-preview?variant_ids=<id>,<id> — the loyalty points a
    // signed-in customer would earn on each piece at her level (owner request
    // 2026-10-03). READ ONLY: the arithmetic is _shared/loyalty-earn.ts, a mirror
    // of award-loyalty-points, which stays the only award path. The figure is a
    // preview — the award itself happens on the confirmed payment, as today.
    if (req.method === "GET" && segments[0] === "me" && segments[1] === "points-preview" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const ids = [...new Set(String(url.searchParams.get("variant_ids") ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean))];
      if (ids.length === 0) return jsonResponse({ error: "variant_ids_required" }, 400);
      if (ids.length > 50) return jsonResponse({ error: "too_many_variants" }, 400);

      const [flagRes, tiersRes, memberRes, variantsRes] = await Promise.all([
        supabase.from("system_settings").select("value").eq("key", "loyalty_enabled").maybeSingle(),
        supabase.from("loyalty_tiers").select("id, name, min_spend_jpy, points_multiplier, requalify_spend_jpy"),
        supabase.from("loyalty_members")
          .select("id, current_tier_id, earned_tier_id, cumulative_spend_jpy, is_downgraded, downgrade_spend_baseline")
          .eq("customer_id", customer.id).maybeSingle(),
        supabase.from("website_product_variants")
          .select("id, price_jpy, product:website_products(status)")
          .in("id", ids),
      ]);
      for (const r of [flagRes, tiersRes, memberRes, variantsRes]) if (r.error) throw r.error;

      // Fail-closed, same reading as award-loyalty-points step 1b.
      if (!loyaltyEnabledFrom((flagRes.data as AnyRec | null)?.value)) {
        return jsonResponse({ enabled: false, enrolled: false, tier: null, items: [] });
      }
      const tierRows = ((tiersRes.data ?? []) as AnyRec[]);
      const tiers: EarnTier[] = tierRows.map((t) => ({
        id: String(t.id),
        name: String(t.name ?? ""),
        min_spend_jpy: Number(t.min_spend_jpy ?? 0),
        points_multiplier: Number(t.points_multiplier ?? 1),
      }));
      const memberRow = memberRes.data as AnyRec | null;

      let member: EarnMember | null = null;
      let promo: EarnPromo | null = null;
      if (memberRow) {
        const earnedTier = tierRows.find((t) => String(t.id) === String(memberRow.earned_tier_id ?? ""));
        member = {
          current_tier_id: String(memberRow.current_tier_id ?? ""),
          cumulative_spend_jpy: Number(memberRow.cumulative_spend_jpy ?? 0),
          is_downgraded: memberRow.is_downgraded === true,
          downgrade_spend_baseline: memberRow.downgrade_spend_baseline == null
            ? null : Number(memberRow.downgrade_spend_baseline),
          requalify_target_jpy: earnedTier?.requalify_spend_jpy == null
            ? null : Number(earnedTier.requalify_spend_jpy),
        };
        // Active promo — same selection as award-loyalty-points step 6: the
        // newest active promo in its date window, allowed for her CURRENT tier,
        // under its per-customer cap. Day boundary in PHT (CLAUDE.md timezone).
        const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
        const { data: promos, error: promoErr } = await supabase
          .from("loyalty_promos")
          .select("id, bonus_multiplier, bonus_points, applicable_tiers, max_per_customer")
          .eq("is_active", true).lte("start_date", today).gte("end_date", today)
          .order("created_at", { ascending: false }).limit(1);
        if (promoErr) throw promoErr;
        const candidate = (promos ?? [])[0] as AnyRec | undefined;
        const currentName = tiers.find((t) => t.id === member!.current_tier_id)?.name ?? null;
        if (candidate) {
          const allowed = candidate.applicable_tiers as string[] | null;
          const tierOk = !allowed || allowed.length === 0 || (currentName != null && allowed.includes(currentName));
          let underCap = true;
          if (tierOk && candidate.max_per_customer != null) {
            const { count, error: capErr } = await supabase
              .from("loyalty_transactions")
              .select("id", { count: "exact", head: true })
              .eq("member_id", memberRow.id).eq("transaction_type", "bonus").eq("promo_id", candidate.id);
            if (capErr) throw capErr;
            underCap = (count ?? 0) < Number(candidate.max_per_customer);
          }
          if (tierOk && underCap) {
            promo = {
              bonus_multiplier: candidate.bonus_multiplier == null ? null : Number(candidate.bonus_multiplier),
              bonus_points: candidate.bonus_points == null ? null : Number(candidate.bonus_points),
            };
          }
        }
      }

      const items = ((variantsRes.data ?? []) as AnyRec[])
        .filter((v) => (v.product as AnyRec | null)?.status === "active")
        .map((v) => {
          const price = Number(v.price_jpy ?? 0);
          const preview = member ? previewEarn(price, member, tiers, promo) : previewEarnAsNewMember(price, tiers);
          return { variant_id: String(v.id), ...(preview ?? { points: 0, base_points: 0, promo_points: 0, multiplier: null, tier: null, upgraded_to: null }), eligible: preview != null };
        });
      const currentTier = member ? tiers.find((t) => t.id === member!.current_tier_id) ?? null : null;
      return jsonResponse({
        enabled: true,
        enrolled: member != null,
        tier: currentTier?.name ?? null,
        multiplier: currentTier ? currentTier.points_multiplier : null,
        items,
      });
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

    // PUT /me/paidy-profile — P05 (owner 2026-10-08): the buyer's own family
    // name, given name and Japanese mobile number, for Paidy. Validated here;
    // nothing else on the customer record is touched. 400 names the field.
    if (req.method === "PUT" && segments[0] === "me" && segments[1] === "paidy-profile" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const body = await req.json().catch(() => ({})) as AnyRec;
      const familyName = paidyNameField(body.family_name);
      const givenName = paidyNameField(body.given_name);
      const mobile = paidyJapaneseMobile(body.mobile_number);
      if (!familyName) return jsonResponse({ error: "family_name_required" }, 400);
      if (!givenName) return jsonResponse({ error: "given_name_required" }, 400);
      if (!mobile) return jsonResponse({ error: "jp_mobile_required" }, 400);
      const { error } = await supabase.from("customers")
        .update({ family_name: familyName, given_name: givenName, mobile_number: mobile })
        .eq("id", customer.id);
      if (error) throw error;
      return jsonResponse({ ok: true, family_name: familyName, given_name: givenName, mobile_number: mobile });
    }

    // ============================================ cart reminders (stages A/B)
    // docs/CART-REMINDERS.md. The browser cookie stays authoritative; this is
    // the server copy a reminder and a cross-device restore read. Every write
    // is one SQL function; consent is recorded with the exact text version.

    // GET /me/cart — the saved lines, for the sign-in merge and /cart/restore.
    if (req.method === "GET" && segments[0] === "me" && segments[1] === "cart" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const { data, error } = await supabase
        .from("customer_cart_lines")
        .select("variant_id, qty, variant:website_product_variants(product:website_products(slug))")
        .eq("customer_id", customer.id)
        .order("added_at", { ascending: true });
      if (error) throw error;
      const lines = ((data ?? []) as AnyRec[]).map((l) => ({
        variant_id: l.variant_id,
        qty: Number(l.qty),
        // The slug is joined at read time, never stored — slugs change.
        slug: ((l.variant as AnyRec | null)?.product as AnyRec | null)?.slug ?? null,
      })).filter((l) => l.slug);
      return jsonResponse({ lines });
    }

    // PUT /me/cart — { lines: [{variant_id, qty}], lang, as_of }. Whole list;
    // last write wins by as_of; updated_at moves only when the lines change,
    // so a re-sync never pushes a reminder back.
    if (req.method === "PUT" && segments[0] === "me" && segments[1] === "cart" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = (await req.json().catch(() => ({}))) as AnyRec;
      if (!Array.isArray(body.lines)) return jsonResponse({ error: "lines_must_be_array" }, 400);
      const asOf = typeof body.as_of === "string" && !Number.isNaN(Date.parse(body.as_of)) ? body.as_of : null;
      const { data, error } = await supabase.rpc("website_set_cart", {
        p_customer_id: customer.id,
        p_lines: body.lines,
        p_lang: pickLang(body.lang),
        p_as_of: asOf,
      });
      if (error) throw error;
      const result = (data ?? {}) as AnyRec;
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
    }

    // PUT /me/cart-reminders — { opted_in, source, lang, text_version }.
    // Writes the current state AND one append-only consent event (the legal
    // record: who, when, from where, in which language, which exact wording).
    if (req.method === "PUT" && segments[0] === "me" && segments[1] === "cart-reminders" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = (await req.json().catch(() => ({}))) as AnyRec;
      if (typeof body.opted_in !== "boolean") return jsonResponse({ error: "opted_in_required" }, 400);
      const source = String(body.source ?? "account");
      if (!["account", "complete_profile", "checkout"].includes(source)) return jsonResponse({ error: "bad_source" }, 400);
      const { data, error } = await supabase.rpc("set_cart_reminder_consent", {
        p_customer_id: customer.id,
        p_opt_in: body.opted_in,
        p_source: source,
        p_lang: pickLang(body.lang),
        p_text_version: typeof body.text_version === "string" ? body.text_version.trim().slice(0, 64) : null,
      });
      if (error) throw error;
      const result = (data ?? {}) as AnyRec;
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse(result);
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
      // WEBSITE ORDERS PR 6 / PR 10: a destination with no published rate is
      // not a dead end — staff add the shipping on the review screen (R4).
      const shippingAtConfirmation = shipping === null;

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
        // Draft mode: priced without shipping and marked provisional; the
        // review screen re-runs layaway_quote with the shipping staff add.
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
      // No bank details before staff confirm the piece (owner decision
      // 2026-09-23). transfer_available still reports whether the currency CAN
      // be paid, so checkout is not refused for nothing.

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
        // storefront must stop and ask, never assume free. In draft mode it is
        // "added when we confirm" instead (shipping_at_confirmation), and the
        // checkout may continue; every figure is then provisional.
        requires_manual_quote: false,
        shipping_at_confirmation: shippingAtConfirmation,
        provisional: true,
        // Lets the payment step render the real methods, and hide transfer
        // entirely rather than offering one that /checkout/pay would refuse.
        // Methods are region-scoped here, not filtered in the browser: the
        // other region's account details never reach the page at all.
        transfer_region: regionForCurrency(settlement),
        transfer_methods: [],
        transfer_available: quoteMethods.length > 0,
        reservation_mode: true,
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
        // C1–C7 (2026-10-05): the payment choice and the points panel.
        ...(await checkoutChoiceBlock(supabase, customer, {
          mode: mode as "full" | "layaway", currency: settlement as "JPY" | "PHP", fxRate,
          country: String(address.country ?? "").toUpperCase() || null,
          subtotalJpy: subtotal, subtotalSettle, totalSettle,
          deposit: layaway ? Number(layaway.deposit ?? 0) : null,
          paymentMethod: null, points: 0,
        })),
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
        .select("id, items, mode, term_months, order_type, recipient_name, recipient_phone, gift_note, subtotal_jpy, shipping_jpy, total_jpy, settlement_currency, fx_rate, fx_rate_date, expires_at, consumed_at, ship_to_address_id, reserved_invoice_seq, payment_method, points")
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

      // Website orders PR 6 / PR 10: same flags as POST /checkout/quote.
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
      // As POST /checkout/quote — no bank details before staff confirm.

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
        requires_manual_quote: false,
        shipping_at_confirmation: shippingJpy === null,
        provisional: true,
        transfer_region: regionForCurrency(settlement),
        transfer_methods: [],
        transfer_available: methods.length > 0,
        reservation_mode: true,
        order_type: row.order_type ?? "SELF",
        expires_at: row.expires_at,
        deposit_deadline_hours: depositDeadlineHours,
        // C1–C7 (2026-10-05): as POST /checkout/quote, with what she chose.
        ...(await checkoutChoiceBlock(supabase, customer, {
          mode: String(row.mode ?? "full") === "layaway" ? "layaway" : "full",
          currency: settlement === "PHP" ? "PHP" : "JPY", fxRate,
          country: await addressCountry(supabase, String(customer.id), row.ship_to_address_id),
          subtotalJpy, subtotalSettle, totalSettle,
          deposit: layawayOut ? Number(layawayOut.deposit ?? 0) : null,
          paymentMethod: row.payment_method, points: row.points,
        })),
      }));
    }

    // POST /checkout/quote/:id/choice — the customer picks how to pay and how
    // many points to use (owner C1–C7, 2026-10-05). Stored on HER unspent
    // quote; /checkout/pay carries it into the draft, where
    // create_web_draft_atomic checks it again. Answers the same figures as the
    // quote reads, so the panel always shows the Hub's numbers.
    if (req.method === "POST" && segments[0] === "checkout" && segments[1] === "quote" && segments[2] && segments[3] === "choice" && !segments[4]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const body = (await req.json().catch(() => ({}))) as AnyRec;
      const quoteId = decodeURIComponent(segments[2]).trim();
      const chosen = await applyCheckoutChoice(supabase, customer, quoteId, body);
      if ("error" in chosen) return jsonResponse(chosen.body, chosen.status);
      return jsonResponse(scrub(chosen.block));
    }

    // POST /checkout/pay — turn a quote into a real order.
    if (req.method === "POST" && segments[0] === "checkout" && segments[1] === "pay" && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);

      const body = (await req.json().catch(() => ({}))) as AnyRec;
      const quoteId = String(body.quote_id ?? "").trim();
      if (!quoteId) return jsonResponse({ error: "quote_id_required" }, 400);
      // C1 (2026-10-05): the method she chose (transfer | paidy | card) and the
      // points she used. Sent here or stored earlier by /checkout/quote/:id/choice;
      // checked against what this quote may take, then again in SQL.
      if (body.method !== undefined || body.points !== undefined) {
        const chosen = await applyCheckoutChoice(supabase, customer, quoteId, {
          payment_method: body.method, points: body.points,
        });
        if ("error" in chosen) return jsonResponse(chosen.body, chosen.status);
      }
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
        .select("mode, settlement_currency, payment_method")
        .eq("id", quoteId).eq("customer_id", customer.id).maybeSingle();
      // Refuse BEFORE the order exists when nothing can receive the currency the
      // quote was taken in. Currency-scoped on purpose: the other currency stays
      // available, so the customer's escape is the toggle they already have
      // rather than a dead checkout.
      const quoteSettlement = String((quoteRow as AnyRec | null)?.settlement_currency ?? "JPY");
      // Only a TRANSFER needs a bank account for the currency (Paidy / card do not).
      const quoteMethod = publicMethod((quoteRow as AnyRec | null)?.payment_method);
      if (quoteMethod === "transfer" && !(await transferAvailable(supabase, quoteSettlement))) {
        return jsonResponse({
          error: "transfer_unavailable",
          currency: quoteSettlement,
          region: regionForCurrency(quoteSettlement),
        }, 409);
      }

      // ── WEBSITE ORDERS PR 6 / PR 10: every checkout is a DRAFT ───────────
      // create_web_draft_atomic: the piece is held, nothing is booked, no bank
      // details. Staff confirm it on the Hub review screen, which creates the
      // real order (materialize_web_draft_atomic) and sends the "ready — pay
      // now" email. The direct create_web_order_atomic / create_web_layaway_
      // atomic paths were retired by PR 10 (2026-10-01).
      {
        // The signed agreement, as the storefront verified it: it checks the
        // signing record server-side before calling this and fails closed when
        // it cannot. Absent stays absent — two NULLs, never a literal.
        const draftAgrVersion = String(body.agreement_version ?? "").trim() || null;
        const draftAgrRaw = String(body.agreement_signed_at ?? "").trim();
        const draftAgrAt = draftAgrRaw && !Number.isNaN(Date.parse(draftAgrRaw))
          ? new Date(draftAgrRaw).toISOString()
          : null;
        const { data: dr, error: drErr } = await supabase.rpc("create_web_draft_atomic", {
          p_customer_id: customer.id,
          p_quote_id: quoteId,
          p_lang: lang,
          p_agreement_version: draftAgrVersion,
          p_agreement_signed_at: draftAgrAt,
        });
        if (drErr) throw drErr;
        const draft = (dr ?? {}) as AnyRec;
        if (draft.error) {
          const status = CHECKOUT_ERROR_STATUS[String(draft.error)] ?? 400;
          console.warn("website draft refused", requestId, String(draft.error));
          return jsonResponse({ ...draft, request_id: requestId }, status);
        }
        // "We have your order / layaway request" — built from the draft. Never
        // throws: the draft exists whether or not the mail goes out.
        await sendDraftReservedEmail(supabase, String(draft.draft_id));
        const draftCurrency = String(draft.currency ?? "JPY") === "PHP" ? "PHP" : "JPY";
        return jsonResponse(scrub({
          draft_id: draft.draft_id,
          web_reference: draft.web_reference,
          mode: draft.mode,
          currency: draftCurrency,
          // Provisional: shipping may still be added (shipping_pending), and
          // services and a discount may be added when staff confirm.
          total: draft.total,
          total_jpy: draft.total_jpy,
          shipping_pending: draft.shipping_pending === true,
          deposit: draft.deposit ?? null,
          term_months: draft.term_months ?? null,
          // C1–C5: what she chose; locked for her from here.
          payment_method: publicMethod(draft.payment_method),
          points: Number(draft.points ?? 0),
          points_value: Number(draft.points_value ?? 0),
          // Cash on delivery: the fee, already in `total` (0 otherwise).
          cod_fee: Number(draft.cod_fee ?? 0),
          provisional: true,
          awaiting_confirmation: true,
          reservation_mode: true,
          transfer_due_at: null,
          transfer_region: regionForCurrency(draftCurrency),
          transfer_methods: [],
        }));
      }
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

    // ── WEBSITE ORDERS PR 6: a customer's DRAFTS ────────────────────────────
    // A draft is a checkout staff have not confirmed (web_order_drafts). It
    // has its own reads so GET /orders and GET /layaway keep their exact shape
    // for storefront builds that predate drafts. Scoped by customer_id, as
    // every read here. Once confirmed, order_id / account_id point at the real
    // order — the storefront redirects there (W2-9).
    //
    // GET /drafts — open (to_confirm) and recently closed drafts, newest first.
    if (req.method === "GET" && segments[0] === "drafts" && !segments[1]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const { data, error } = await supabase
        .from("web_order_drafts")
        .select(DRAFT_FIELDS)
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      const drafts = (data ?? []) as AnyRec[];
      // Storefront step 4 (2026-09-30): first piece + line count per draft,
      // one lines query for the whole page — never a query per draft.
      const draftIds = drafts.map((d) => String(d.id));
      const { data: draftLines, error: dlErr } = draftIds.length
        ? await supabase
            .from("web_order_draft_lines")
            .select("draft_id, variant_id, website_product_id, title, image_url, created_at")
            .in("draft_id", draftIds)
            .order("created_at", { ascending: true })
        : { data: [], error: null };
      if (dlErr) throw dlErr;
      const firstByDraft = new Map<string, AnyRec>();
      const countByDraft = new Map<string, number>();
      for (const l of (draftLines ?? []) as AnyRec[]) {
        const key = String(l.draft_id);
        countByDraft.set(key, (countByDraft.get(key) ?? 0) + 1);
        if (!firstByDraft.has(key)) firstByDraft.set(key, l);
      }
      const firstDraftLines = await withJapaneseTitles(
        supabase,
        await resolveItemImages(
          supabase,
          [...firstByDraft.values()].map(({ website_product_id, ...l }) => ({ ...l, product_id: website_product_id ?? null })),
        ),
      );
      const firstItemByDraft = new Map<string, AnyRec>();
      for (const l of firstDraftLines) firstItemByDraft.set(String(l.draft_id), l);
      return jsonResponse(scrub(drafts.map((d) => {
        const first = firstItemByDraft.get(String(d.id));
        return {
          ...shapeDraft(d),
          first_item: first ? { title: first.title ?? null, title_ja: first.title_ja ?? null, image_url: first.image_url ?? null } : null,
          item_count: countByDraft.get(String(d.id)) ?? 0,
        };
      })));
    }

    // GET /drafts/:id — one draft, with its pieces.
    if (req.method === "GET" && segments[0] === "drafts" && segments[1] && !segments[2]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const { data: draft, error } = await supabase
        .from("web_order_drafts")
        .select(`${DRAFT_FIELDS}, ship_to_snapshot`)
        .eq("id", decodeURIComponent(segments[1]))
        .eq("customer_id", customer.id)
        .maybeSingle();
      if (error) throw error;
      if (!draft) return notFound();
      const { data: lines, error: lineErr } = await supabase
        .from("web_order_draft_lines")
        .select("id, variant_id, website_product_id, title, sku, qty, unit_price_jpy, line_total_jpy, image_url")
        .eq("draft_id", (draft as AnyRec).id)
        .order("created_at");
      if (lineErr) throw lineErr;
      const items = await withJapaneseTitles(
        supabase,
        await resolveItemImages(
          supabase,
          ((lines ?? []) as AnyRec[]).map(({ website_product_id, qty, ...l }) => ({ ...l, quantity: qty, product_id: website_product_id ?? null })),
        ),
      );
      return jsonResponse(scrub({
        draft: { ...shapeDraft(draft as AnyRec), ship_to_address: shipToAddress((draft as AnyRec).ship_to_snapshot, null) },
        items,
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
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      const orders = (data ?? []) as unknown as AnyRec[];
      // Storefront step 4 (2026-09-30): first piece + line count per order,
      // one lines query for the whole page — never a query per order.
      const orderIds = orders.map((o) => String(o.id));
      const { data: orderLines, error: olErr } = orderIds.length
        ? await supabase
            .from("cash_order_items")
            .select("cash_order_id, variant_id, product_id, website_product_id, title, image_url, created_at")
            .in("cash_order_id", orderIds)
            .order("created_at", { ascending: true })
        : { data: [], error: null };
      if (olErr) throw olErr;
      const firstByOrder = new Map<string, AnyRec>();
      const countByOrder = new Map<string, number>();
      for (const l of (orderLines ?? []) as AnyRec[]) {
        const key = String(l.cash_order_id);
        countByOrder.set(key, (countByOrder.get(key) ?? 0) + 1);
        if (!firstByOrder.has(key)) firstByOrder.set(key, l);
      }
      const firstOrderLines = await withJapaneseTitles(
        supabase,
        await resolveItemImages(
          supabase,
          [...firstByOrder.values()].map(({ website_product_id, ...l }) => ({ ...l, product_id: l.product_id ?? website_product_id ?? null })),
        ),
      );
      const firstItemByOrder = new Map<string, AnyRec>();
      for (const l of firstOrderLines) firstItemByOrder.set(String(l.cash_order_id), l);
      // Payment lifecycle H6: "being checked" = an open submission (one query
      // for the whole page) or a payment lock (one batched call,
      // cash_order_payment_locks, for this page's OPEN orders — a closed
      // order holds none; the page is at most 50, the function's cap 100).
      const { data: openSubs, error: osErr } = orderIds.length
        ? await supabase.from("payment_submissions").select("cash_order_id")
            .in("cash_order_id", orderIds).or(PENDING_SUBMISSION_OR)
        : { data: [], error: null };
      if (osErr) throw osErr;
      const checking = new Set(((openSubs ?? []) as AnyRec[]).map((r) => String(r.cash_order_id)));
      const pendingIds = orders.filter((o) => o.status === "pending" && !checking.has(String(o.id))).map((o) => String(o.id));
      if (pendingIds.length) {
        const { data: lockRows, error: lockErr } = await supabase.rpc("cash_order_payment_locks", { p_ids: pendingIds });
        if (lockErr) throw lockErr;
        for (const r of (lockRows ?? []) as AnyRec[]) if (typeof r.lock === "string" && r.lock) checking.add(String(r.id));
      }
      return jsonResponse(scrub(orders.map((o) => {
        const first = firstItemByOrder.get(String(o.id));
        return {
          ...withReservationFlags(o, "cash_order"),
          first_item: first ? { title: first.title ?? null, title_ja: first.title_ja ?? null, image_url: first.image_url ?? null } : null,
          item_count: countByOrder.get(String(o.id)) ?? 0,
          // C1: transfer | paidy | card on a website order; null on any other.
          chosen_method: o.source_channel === "web" ? publicMethod(o.payment_method) : null,
          being_checked: checking.has(String(o.id)),
          // What is left to pay: remaining_balance, which already nets points
          // used at checkout (they are a payment row on the order).
          amount_due: Number(o.remaining_balance ?? 0),
        };
      })));
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

      // Submissions a reviewer has not decided yet (the plan page's shape):
      // the storefront shows "being checked" and hides the payment card.
      const { data: pendingSubs, error: pendErr } = await supabase
        .from("payment_submissions")
        .select("id, submitted_amount, payment_date, payment_method, status, created_at")
        .eq("cash_order_id", order.id).or(PENDING_SUBMISSION_OR).order("created_at");
      if (pendErr) throw pendErr;
      const shipTo = shipToAddress((order as AnyRec).ship_to_snapshot, (order as AnyRec).ship_to_address);
      // Owner rule 2026-10-04: while a Paidy payment is open, processing,
      // taken-but-not-recorded or waiting for review, the customer sees NO
      // way to pay — no Paidy button, no card, no bank details — only that
      // it is being processed. The database enforces the same rule.
      // Owner 3A / SQ11: the same while a card attempt is in flight, a hold is
      // live or captured card money is not yet recorded (the lock answers
      // card_payment_unresolved; card_payment carries the card's own state).
      const lock = await paymentLock(supabase, String(order.id));
      // P04 QA (2026-10-08, owner default "she can reopen Paidy right away"):
      // her OWN checkout window (paidy_checkout_open — every attempt on her
      // order is hers) is not a payment. Paidy is offered again at once
      // (start_paidy_checkout_attempt replaces the window); transfer and card
      // stay hidden until the sweep confirms nothing was paid. Only when
      // nothing else holds the order (ignoreAttempts) — otherwise it is a
      // real Paidy payment in progress.
      const windowOnly = lock === "paidy_checkout_open" && (await paymentLock(supabase, String(order.id), { ignoreAttempts: true })) === null;
      const paidyProcessing = !!lock && lock.startsWith("paidy") && !windowOnly;
      const cardPayment = await cardPaymentState(supabase, String(order.id));
      const blockedByCard = cardPayment !== null || lock === "card_payment_unresolved";
      const paidyBlock = await paidyOffer(supabase, customer, order as AnyRec, shipTo, (items ?? []) as AnyRec[], (pendingSubs ?? []).length, windowOnly ? null : lock);
      // C1 (2026-10-05): the method she chose at checkout. After staff Confirm
      // the order page shows ONLY that one (staff change it in the Hub).
      const chosenMethod = publicMethod((order as AnyRec).payment_method);
      const isWebOrder = (order as AnyRec).source_channel === "web";
      const pointsApplied = await orderPointsApplied(supabase, String(order.id));
      const cardBlock = lock || blockedByCard
        ? { offered: false as const, reason: blockedByCard ? "card_payment_unresolved" : "payment_in_progress" }
        : await cardOffer(supabase, customer, order as AnyRec, (pendingSubs ?? []).length, false);
      // F-11 / D-QC4 (owner 2026-10-09): she chose card, but card is no longer
      // offered to her (switched off, test mode, not on the card list, set-up
      // incomplete). The stored choice is unchanged — no second writer of
      // payment_method — the page simply shows bank transfer so she always has
      // a way to pay. Never while a payment is in progress (lock / card state).
      const cardFallsBackToTransfer = isWebOrder && chosenMethod === "card" && !lock && !blockedByCard
        && !cardBlock.offered && CARD_SETUP_REASONS.has(String(cardBlock.reason ?? ""));
      // Payment lifecycle H6 / D1: her latest decided payment (separate read —
      // pending_submissions keeps its shape) and, after a rejection with
      // nothing in progress, the other methods she may switch to herself.
      const decided = await decidedSubmissions(supabase, "cash_order_id", String(order.id));
      const switchMethods = await customerSwitchMethods(
        supabase, customer, order as AnyRec, shipTo, (items ?? []) as AnyRec[], (pendingSubs ?? []).length, lock, blockedByCard, decided,
      );

      return jsonResponse(scrub({
        order: {
          // awaiting_confirmation / ready_for_payment (reserve-first A2).
          ...withReservationFlags(order as AnyRec, "cash_order"),
          ship_to_snapshot: undefined,
          ship_to_address: shipTo,
        },
        items: lines,
        // A Confirm that claimed a payment but has not recorded it yet is
        // still "being checked" for the customer (review 2026-10-04 #1): the
        // storefront then hides the payment options, so no second payment.
        pending_submissions: ((pendingSubs ?? []) as AnyRec[]).map((p) => p.status === "confirmed" ? { ...p, status: "under_review" } : p),
        // "paidy_processing" while Paidy holds the order (see above); the
        // storefront then shows the processing state and no payment option.
        payment_state: paidyProcessing ? "paidy_processing" : windowOnly ? "paidy_window_open" : (lock ? "payment_pending" : null),
        // Paidy ato-barai (2026-10-03): the block the order page renders, or
        // null with the reason it is not offered (logged, never shown).
        paidy: paidyBlock.offered ? paidyBlock : null,
        // P05 (2026-10-08): what Paidy still needs from her, so the order page
        // can ask for it (names, Japanese mobile, Japanese billing address).
        paidy_requirements: paidyBlock.requirements ? {
          ...paidyBlock.requirements, mobile_number: paidyBlock.mobile_number ?? null,
          // PA15A: prefill — the name parts already on file (either may be null).
          family_name_on_file: paidyBlock.names?.family_name ?? null, given_name_on_file: paidyBlock.names?.given_name ?? null,
        } : null,
        // Card payment (Square, S2 2026-10-04): the block the pay-card page
        // renders, or null (reason logged, never shown).
        card: cardBlock.offered ? cardBlock : null,
        // SQ22: the card payment's own state while it is unresolved —
        // processing (answer not known yet) | held (authorised, awaiting
        // staff) | capturing | recording — or null. Never "paid" before it is.
        card_payment: cardPayment,
        // C1: transfer | paidy | card | cod — what she chose at checkout (or staff since).
        chosen_method: chosenMethod,
        // Cash on delivery (2026-10-10): no pay box, no deadline — the courier
        // collects collect_on_delivery (remaining_balance, the 代引手数料
        // included) when the parcel arrives. null on any other method.
        cod: isWebOrder && chosenMethod === "cod"
          ? { fee: Number((order as AnyRec).cod_fee ?? 0), collect_on_delivery: Number((order as AnyRec).remaining_balance ?? 0) }
          : null,
        // H6: { status: rejected | needs_clarification, method, amount,
        // decided_at, message } for her newest decided payment, or null (none,
        // or a confirmed one is newer). message = the reviewer's words to her.
        latest_decision: latestDecision(decided),
        // D1: true when she may pick another way to pay herself
        // (POST /orders/:id/payment-method); switch_methods = the ones offered.
        can_switch_method: switchMethods.length > 0,
        switch_methods: switchMethods,
        // Points used at checkout, already taken off (a discount, in the order's
        // currency). 0 when none. The storefront shows "Points −¥N".
        points_applied: pointsApplied,
        transfer_region: regionForCurrency(String((order as AnyRec).currency ?? "JPY")),
        // Methods are only actionable while the transfer is outstanding — and
        // never before staff confirm the piece (reserve-first A2; a reservation
        // reads payment_status awaiting_confirmation, so this is belt and braces).
        // C1: on a website order only when transfer is the chosen method.
        transfer_methods: (order as AnyRec).payment_status === "pending_transfer" && !isUnconfirmedReservation(order as AnyRec) && !paidyProcessing && !blockedByCard
            && (!isWebOrder || chosenMethod === "transfer" || cardFallsBackToTransfer)
          ? await transferMethods(supabase, String((order as AnyRec).currency ?? "JPY"))
          : [],
      }));
    }

    // POST /orders/:id/payment-method — D1 (payment lifecycle, 2026-10-05):
    // after her latest payment was REJECTED and nothing is in progress, the
    // customer picks another way to pay. Body { method: transfer | paidy | card }.
    // C1 otherwise holds. The writer is
    // switch_web_payment_method_by_customer_atomic (row lock, audited, actor
    // customer); the checks here are the TS mirror for an early refusal plus
    // the one thing SQL cannot know — whether Paidy / card is OFFERED on this
    // order right now (409 method_not_offered). Internal lock names never leave.
    if (req.method === "POST" && segments[0] === "orders" && segments[1] && segments[2] === "payment-method" && !segments[3]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const body = await req.json().catch(() => ({})) as AnyRec;
      const to = storedMethod(body.method);
      if (!to || !CHECKOUT_METHODS.includes(String(body.method ?? "").trim().toLowerCase() as CheckoutMethod)) {
        return jsonResponse({ error: "bad_method" }, 400);
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segments[1])) return jsonResponse({ error: "not_found" }, 404);
      const { data: order, error } = await supabase
        .from("cash_orders")
        .select(`${ORDER_FIELDS}, ship_to_snapshot, ship_to_address:customer_addresses(id, recipient_name, line1, line2, city, region, postal_code, country, phone)`)
        .eq("id", segments[1]).eq("customer_id", customer.id).maybeSingle();
      if (error) throw error;
      if (!order) return jsonResponse({ error: "not_found" }, 404);
      const orderId = String((order as AnyRec).id);
      const [{ data: offerItems, error: itemsErr }, { data: pendingSubs, error: pendErr }, lock, decided, cardPayment] = await Promise.all([
        supabase.from("cash_order_items").select("id, variant_id, sku, title, quantity, unit_price_jpy").eq("cash_order_id", orderId).order("created_at"),
        supabase.from("payment_submissions").select("id").eq("cash_order_id", orderId).or(PENDING_SUBMISSION_OR),
        paymentLock(supabase, orderId),
        decidedSubmissions(supabase, "cash_order_id", orderId),
        cardPaymentState(supabase, orderId),
      ]);
      if (itemsErr) throw itemsErr;
      if (pendErr) throw pendErr;
      // Early refusal, same codes and order as the SQL writer.
      const switchedSince = await customerSwitchedSinceDecision(supabase, orderId, decided);
      const verdict = canCustomerSwitch({ ...switchBase(order as AnyRec, lock, decided, switchedSince), to });
      if (!verdict.ok) return jsonResponse({ error: verdict.error }, SWITCH_ERROR_STATUS[verdict.error] ?? 409);
      const shipTo = shipToAddress((order as AnyRec).ship_to_snapshot, (order as AnyRec).ship_to_address);
      const offered = await switchTargetOffered(
        supabase, customer, order as AnyRec, shipTo, (offerItems ?? []) as AnyRec[], (pendingSubs ?? []).length, lock,
        cardPayment !== null || lock === "card_payment_unresolved", to,
      );
      if (!offered) return jsonResponse({ error: "method_not_offered" }, 409);

      const { data: switched, error: swErr } = await supabase.rpc("switch_web_payment_method_by_customer_atomic", {
        p_order_id: orderId, p_customer_id: customer.id, p_method: to,
      });
      if (swErr) throw swErr;
      const r = (switched ?? {}) as AnyRec;
      if (!r.ok) {
        const code = String(r.error ?? "not_payable");
        return jsonResponse({ error: code }, SWITCH_ERROR_STATUS[code] ?? 409);
      }
      // The order-method-changed email: how to pay now, only the new method.
      // guarded() inside never throws — a failed send never fails the switch.
      // Deterministic key: one email per (order, deciding rejection, new method).
      const decisionId = String(r.decision_id ?? newestDecided(decided)?.id ?? "");
      const email = await sendOrderReadyEmail(supabase, orderId, {
        methodChanged: true,
        idempotencyKey: customerSwitchEmailKey(orderId, decisionId, String(r.payment_method)),
      });
      console.log(JSON.stringify({ customer_payment_method_switch: orderId, from: r.old_method, to: r.payment_method, email_sent: email?.sent === true }));
      return jsonResponse({ ok: true, payment_method: publicMethod(r.payment_method) });
    }

    // POST /orders/:id/paidy/start — persist the customer's Paidy window
    // BEFORE Paidy.launch (owner rule 2026-10-04). Refused while anything else
    // holds the order (another tab's window included). Answers the attempt id;
    // every other payment route is closed until it is filed, abandoned or
    // times out (30 min).
    if (req.method === "POST" && segments[0] === "orders" && segments[1] && segments[2] === "paidy" && segments[3] === "start" && !segments[4]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const { data: order, error } = await supabase
        .from("cash_orders")
        .select(`${ORDER_FIELDS}, customer_id, ship_to_snapshot, ship_to_address:customer_addresses(id, recipient_name, line1, line2, city, region, postal_code, country, phone)`)
        .eq("id", segments[1]).eq("customer_id", customer.id).maybeSingle();
      if (error) throw error;
      if (!order) return notFound();
      if (isUnconfirmedReservation(order as AnyRec)) return jsonResponse({ error: NOT_READY_FOR_PAYMENT }, 409);
      const shipTo = shipToAddress((order as AnyRec).ship_to_snapshot, (order as AnyRec).ship_to_address);
      const { data: offerItems, error: offerItemsErr } = await supabase
        .from("cash_order_items").select("id, variant_id, sku, title, quantity, unit_price_jpy").eq("cash_order_id", order.id).order("created_at");
      if (offerItemsErr) throw offerItemsErr;
      // PA15B (2026-10-09): the billing address she chose on the order page —
      // one of HER complete Japanese address-book entries, else refused (never
      // silently replaced). Absent = the preselected one (default first).
      const startBody = await req.json().catch(() => ({})) as AnyRec;
      const wantedBilling = typeof startBody.billing_address_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(startBody.billing_address_id)
        ? startBody.billing_address_id : null;
      if (startBody.billing_address_id != null && !wantedBilling) return jsonResponse({ error: "billing_address_invalid" }, 400);
      const offer = await paidyOffer(supabase, customer, order as AnyRec, shipTo, (offerItems ?? []) as AnyRec[], 0, null, wantedBilling);
      if (!offer.offered) {
        return jsonResponse({ error: offer.reason === "billing_address_invalid" ? "billing_address_invalid" : "paidy_not_offered", reason: offer.reason }, offer.reason === "billing_address_invalid" ? 400 : 409);
      }
      const { data: started, error: startErr } = await supabase.rpc("start_paidy_checkout_attempt", {
        p_cash_order_id: order.id, p_customer_id: customer.id, p_ttl_minutes: 30,
      });
      if (startErr) throw startErr;
      const st = (started ?? {}) as AnyRec;
      if (!st.ok) return jsonResponse({ error: String(st.error ?? "payment_in_progress"), lock: st.lock ?? null }, 409);
      // PA04 (2026-10-08): the launch carries the attempt id in Paidy's
      // metadata, so a late authorisation (webhook, dashboard) can be tied to
      // the window it came from. Paidy allows 20 keys; four are used.
      // PA15B: which billing address this window sent Paidy (audit). A failed
      // write does not stop her paying — it is logged.
      const { error: billErr } = await supabase.from("paidy_checkout_attempts")
        .update({ billing_address_id: offer.billing_address_id ?? null }).eq("id", st.attempt_id);
      if (billErr) console.error("[paidy] attempt billing_address_id not recorded:", billErr);
      const checkout = offer.checkout as AnyRec;
      const withAttempt = { ...checkout, metadata: { ...(checkout.metadata ?? {}), attempt_id: String(st.attempt_id) } };
      return jsonResponse({ ok: true, attempt_id: st.attempt_id, expires_at: st.expires_at, checkout: withAttempt });
    }

    // POST /orders/:id/paidy/abandon — Paidy's window reported closed or
    // rejected with no authorisation: the window ends and the other payment
    // options come back. An authorisation that arrives anyway (the webhook)
    // is still filed or released.
    if (req.method === "POST" && segments[0] === "orders" && segments[1] && segments[2] === "paidy" && segments[3] === "abandon" && !segments[4]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const body = await req.json().catch(() => ({})) as AnyRec;
      const attemptId = typeof body.attempt_id === "string" && /^[0-9a-f-]{36}$/i.test(body.attempt_id) ? body.attempt_id : null;
      if (!attemptId) return jsonResponse({ error: "bad_attempt" }, 400);
      const reason = body.reason === "rejected" ? "paidy_rejected" : body.reason === "error" ? "launch_error" : "paidy_closed";
      // PA04 (2026-10-08): Paidy's rejected / closed callback names the
      // payment it created; the window keeps that id so the hourly sweep can
      // VERIFY with Paidy that it holds nothing before the window ends
      // (verified_empty) — instead of ending on the clock alone.
      // H1 (Paidy QC 2026-10-09): the id comes from the browser, so it is
      // checked with Paidy BEFORE it is kept. A noted id holds the window
      // until Paidy says it holds nothing, so a made-up id (Paidy: 404) or
      // another order's payment would freeze this order for good — neither is
      // noted. Paidy unreachable → noted anyway (fail closed; the sweep
      // verifies it, and staff have "End Paidy window").
      let noted = false;
      let noteCheck: string | null = null;
      if (isPaidyPaymentId(body.paidy_payment_id)) {
        const { data: ord, error: ordErr } = await supabase
          .from("cash_orders").select("id, invoice_number, web_reference, source_channel")
          .eq("id", segments[1]).eq("customer_id", customer.id).maybeSingle();
        if (ordErr) throw ordErr;
        if (!ord) return notFound();
        let read: Parameters<typeof paidyNoteDecision>[0];
        try {
          read = { payment: await paidy.get(body.paidy_payment_id) };
        } catch (e) {
          read = e instanceof PaidyError && e.status === 404 ? { notFound: true } : { error: true };
          if (!("notFound" in read)) console.warn("[website] paidy.get for the abandon note failed:", e instanceof PaidyError ? `${e.status} ${e.code}` : e);
        }
        noteCheck = paidyNoteDecision(read, { id: String(ord.id), ref: customerReference(ord as AnyRec) });
        if (noteCheck === "note" || noteCheck === "note_unverified") {
          const { data: n, error: nErr } = await supabase.rpc("note_paidy_checkout_attempt_payment", {
            p_attempt_id: attemptId, p_customer_id: customer.id, p_paidy_payment_id: body.paidy_payment_id,
          });
          if (nErr) throw nErr;
          noted = (n as AnyRec | null)?.noted === true;
        }
      }
      const { data: ended, error: endErr } = await supabase.rpc("end_paidy_checkout_attempt", {
        p_attempt_id: attemptId, p_customer_id: customer.id, p_reason: reason,
      });
      if (endErr) throw endErr;
      return jsonResponse({ ok: true, ended: (ended as AnyRec | null)?.ended === true, payment_noted: noted, note_check: noteCheck });
    }

    // POST /orders/:id/paidy — the customer finished Paidy's window; file the
    // authorisation as a payment submission (docs/PAIDY.md). Nothing is
    // charged here: a reviewer's Confirm captures it, Reject closes it.
    if (req.method === "POST" && segments[0] === "orders" && segments[1] && segments[2] === "paidy" && !segments[3]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const body = await req.json().catch(() => ({})) as AnyRec;
      const paidyPaymentId = body.paidy_payment_id;
      if (!isPaidyPaymentId(paidyPaymentId)) return jsonResponse({ error: "paidy_mismatch", detail: "bad_id" }, 409);

      const { data: order, error } = await supabase
        .from("cash_orders")
        .select(`${ORDER_FIELDS}, customer_id, ship_to_snapshot, ship_to_address:customer_addresses(id, recipient_name, line1, line2, city, region, postal_code, country, phone)`)
        .eq("id", segments[1]).eq("customer_id", customer.id).maybeSingle();
      if (error) throw error;
      if (!order) return notFound();
      if (isUnconfirmedReservation(order as AnyRec)) return jsonResponse({ error: NOT_READY_FOR_PAYMENT }, 409);

      // P01 (2026-10-04): a retried click (or a lost response) for an
      // authorisation already filed on THIS order gets that submission back,
      // instead of "submission_pending" for its own payment.
      const { data: known, error: knownErr } = await supabase
        .from("paidy_payments").select("id, cash_order_id").eq("paidy_payment_id", paidyPaymentId).maybeSingle();
      if (knownErr) throw knownErr;
      if (known) {
        if ((known as AnyRec).cash_order_id !== order.id) return jsonResponse({ error: "paidy_mismatch", detail: "other_order" }, 409);
        const { data: live, error: liveErr } = await supabase
          .from("payment_submissions").select("id, status, submitted_amount, payment_date")
          .eq("paidy_payment_id", (known as AnyRec).id).in("status", ["submitted", "under_review", "confirmed"])
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        if (liveErr) throw liveErr;
        if (live) return jsonResponse(scrub({ ok: true, submission: live }));
        // A record with no live submission falls through: the writer recovers it.
      }

      // Anything else holding the order (another payment waiting, another
      // Paidy payment) refuses — the customer's own open Paidy window, and
      // this payment's own record, do not.
      const lock = await paymentLock(supabase, String(order.id), { ignorePaidyRow: known ? String((known as AnyRec).id) : null, ignoreAttempts: true });
      if (lock) return jsonResponse({ error: "submission_pending", lock }, 409);

      // The same rule that showed the button must still hold now.
      const shipTo = shipToAddress((order as AnyRec).ship_to_snapshot, (order as AnyRec).ship_to_address);
      const { data: offerItems, error: offerItemsErr } = await supabase
        .from("cash_order_items").select("id, variant_id, sku, title, quantity, unit_price_jpy").eq("cash_order_id", order.id).order("created_at");
      if (offerItemsErr) throw offerItemsErr;
      const offer = await paidyOffer(supabase, customer, order as AnyRec, shipTo, (offerItems ?? []) as AnyRec[], 0, null);
      if (!offer.offered) return jsonResponse({ error: "paidy_not_offered", reason: offer.reason }, 409);

      // 3 per 24 h per order, like submit-cash-payment (rejected ones excluded).
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: recent, error: recentErr } = await supabase
        .from("payment_submissions").select("id", { count: "exact", head: true })
        .eq("cash_order_id", order.id).not("status", "in", '("rejected","cancelled")').gte("created_at", since);
      if (recentErr) throw recentErr;
      if ((recent ?? 0) >= 3) return jsonResponse({ error: "too_many_submissions" }, 429);

      // Read the authorisation back from Paidy with the secret key — the only
      // thing about a Paidy payment the Hub ever trusts.
      let payment: PaidyPayment;
      try {
        if (paidySecretIsTest() !== offer.test) return jsonResponse({ error: "paidy_not_offered", reason: "secret_mode_mismatch" }, 409);
        payment = await paidy.get(paidyPaymentId);
      } catch (e) {
        if (e instanceof PaidyError && e.status === 404) return jsonResponse({ error: "paidy_mismatch", detail: "unknown_payment" }, 409);
        console.error("[website] paidy.get failed:", e);
        return jsonResponse({ error: "paidy_unavailable" }, 502);
      }

      // Validation + paidy_payments + payment_submissions + audit in ONE
      // transaction under the order lock (P01/P04, _shared/paidy-filing.ts).
      // A mismatch releases the authorisation so nothing stays reserved
      // against the customer's Paidy limit.
      const filed = await filePaidyAuthorization(supabase, {
        order: order as AnyRec,
        customer: { id: String(customer.id), full_name: customer.full_name == null ? null : String(customer.full_name) },
        payment, expectTest: offer.test, path: "website_paidy",
      });
      if (!filed.ok) {
        // M1 (Paidy QC 2026-10-09): the payment names ANOTHER order. It was not
        // closed; it is handed to the order it names, exactly as Paidy's
        // webhook would (filed there if that order can take it, else released).
        if (filed.error === "paidy_mismatch" && filed.detail === "order_ref") {
          const routed = await adoptOrphanAuthorization(supabase, payment, "website_paidy");
          console.warn(`[website] Paidy ${payment.id} names another order; routed: ${routed}`);
          return jsonResponse({ error: "paidy_mismatch", detail: "other_order" }, 409);
        }
        if (filed.error === "paidy_mismatch") return jsonResponse({ error: "paidy_mismatch", detail: filed.detail }, 409);
        if (filed.error === "stale_authorization") return jsonResponse({ error: "paidy_mismatch", detail: `stale:${filed.detail ?? ""}`, released: filed.released === true }, 409);
        if (filed.error === "submission_pending" || filed.error === "card_payment_unresolved") return jsonResponse({ error: "submission_pending" }, 409);
        if (filed.error === "paidy_payment_other_order") return jsonResponse({ error: "paidy_mismatch", detail: "other_order" }, 409);
        if (filed.error === "order_not_found") return notFound();
        return jsonResponse({ error: "paidy_mismatch", detail: filed.error }, 409);
      }
      return jsonResponse(scrub({ ok: true, submission: filed.submission }));
    }

    // POST /orders/:id/card — the customer's card was tokenised (3-D Secure
    // inside the token) on the website; AUTHORISE it with Square and file the
    // hold as a payment submission (docs/SQUARE.md, docs/SQUARE-INTEGRITY.md).
    // Nothing is charged here: a reviewer's Confirm captures it, Reject voids
    // it (owner D6).
    //
    // Integrity (SQ03–SQ05, SQ12, SQ17–SQ23): the attempt is RESERVED in the
    // database under the order lock BEFORE Square is called
    // (reserve_square_attempt: exact integer yen, one unresolved commitment per
    // order, caps 5/order and 10/customer). The request Square sees is the
    // attempt's immutable one (amount, location, key, reference). An ambiguous
    // failure leaves the attempt "unknown" and the customer is told it is being
    // confirmed — never "not charged". The hold, its submission, audit and bell
    // are written in ONE transaction (file_square_authorization_atomic).
    if (req.method === "POST" && segments[0] === "orders" && segments[1] && segments[2] === "card" && !segments[3]) {
      const who = await requireCustomerUser(req, supabase);
      if (who instanceof Response) return who;
      const customer = await customerForAuthUser(supabase, who.id);
      if (!customer) return jsonResponse({ error: "not_linked" }, 404);
      const body = await req.json().catch(() => ({})) as AnyRec;
      const sourceId = typeof body.source_id === "string" ? body.source_id.trim() : "";
      if (!/^[A-Za-z0-9_:-]{8,200}$/.test(sourceId)) return jsonResponse({ error: "card_mismatch", detail: "bad_source" }, 409);
      // 3-D Secure: Square's current Web Payments SDK verifies the buyer INSIDE
      // card.tokenize(verificationDetails); a separate verification token is
      // only forwarded when an older client sends one. The Hub records what it
      // can actually establish (SQ18) — never "verified".
      const verificationToken = typeof body.verification_token === "string" && body.verification_token.trim() ? body.verification_token.trim().slice(0, 500) : null;
      const verification = cardVerificationEvidence(body.verification, verificationToken !== null);
      const terms = (body.terms ?? {}) as AnyRec;
      const termsVersion = typeof terms.version === "string" && terms.version.trim() ? terms.version.trim().slice(0, 64) : null;
      const termsProblem = termsTimeProblem(terms.accepted_at);
      if (!termsVersion || termsProblem) return jsonResponse({ error: "terms_required", detail: termsProblem ?? "version" }, 409);
      const termsAt = new Date(String(terms.accepted_at)).toISOString();
      const agreement = body.agreement && typeof body.agreement === "object" ? body.agreement as AnyRec : null;
      const expectedAmount = canonicalYen(body.expected_amount_jpy);
      if (expectedAmount === null) return jsonResponse({ error: "amount_changed", detail: "expected_amount_missing" }, 409);
      const billingIn = body.billing && typeof body.billing === "object" ? body.billing as AnyRec : {};
      const bStr = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
      const cardholderName = bStr(billingIn.name, 120);
      const billingCountry = bStr(billingIn.country, 2).toUpperCase();
      // SQ17: the cardholder's billing contact — never the gift recipient. The
      // full name goes in one field (no first/last split: Japanese and Filipino
      // name orders differ).
      const billing = {
        first_name: cardholderName || undefined,
        address_line_1: bStr(billingIn.address_line_1, 200) || undefined,
        address_line_2: bStr(billingIn.address_line_2, 200) || undefined,
        locality: bStr(billingIn.locality, 100) || undefined,
        administrative_district_level_1: bStr(billingIn.administrative_district_level_1, 100) || undefined,
        postal_code: bStr(billingIn.postal_code, 20) || undefined,
        country: /^[A-Z]{2}$/.test(billingCountry) ? billingCountry : undefined,
      };

      const { data: order, error } = await supabase
        .from("cash_orders")
        .select(`${ORDER_FIELDS}, customer_id`)
        .eq("id", segments[1]).eq("customer_id", customer.id).maybeSingle();
      if (error) throw error;
      if (!order) return notFound();
      if (isUnconfirmedReservation(order as AnyRec)) return jsonResponse({ error: NOT_READY_FOR_PAYMENT }, 409);

      const { count: pendingCount, error: pendErr } = await supabase
        .from("payment_submissions").select("id", { count: "exact", head: true })
        .eq("cash_order_id", order.id).or(PENDING_SUBMISSION_OR);
      if (pendErr) throw pendErr;
      // Nothing at all while Paidy holds the order (owner 2026-10-04) —
      // checked BEFORE Square is asked for a hold, and again under the order
      // lock by reserve_square_attempt (which also enforces one pending
      // payment and one unresolved card commitment per order).
      const lock = await paymentLock(supabase, String(order.id));
      if (lock && lock.startsWith("paidy")) return jsonResponse({ error: "paidy_in_progress", lock }, 409);

      // The same rule that showed the button must still hold now. Pending and
      // unresolved-card gates are enforced by reserve_square_attempt under the
      // order lock (so a retry of the SAME attempt is still answered).
      const offer = await cardOffer(supabase, customer, order as AnyRec, 0, false);
      if (!offer.offered) return jsonResponse({ error: "card_not_offered", reason: offer.reason }, 409);
      // SQ23: the amount the customer saw when she tokenised must be the amount
      // charged now; otherwise she re-checks and pays the new amount.
      if (expectedAmount !== offer.amount_jpy) return jsonResponse({ error: "amount_changed", amount_jpy: offer.amount_jpy }, 409);
      // D9 + owner 5A: the signed Card Purchase Agreement must bind THIS
      // customer and THIS amount (Card.gs lookup, verified server-side by the
      // storefront). A changed amount → sign again.
      if (offer.agreement_required) {
        const problem = agreementBindingProblem(agreement, String(customer.id), offer.amount_jpy);
        if (problem) return jsonResponse({ error: problem === "agreement_amount_changed" ? "agreement_resign" : "agreement_missing", detail: problem }, 409);
      }

      // 3 per 24 h per order, like submit-cash-payment (rejected ones excluded).
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: recent, error: recentErr } = await supabase
        .from("payment_submissions").select("id", { count: "exact", head: true })
        .eq("cash_order_id", order.id).not("status", "in", '("rejected","cancelled")').gte("created_at", since);
      if (recentErr) throw recentErr;
      if ((pendingCount ?? 0) === 0 && (recent ?? 0) >= 3) return jsonResponse({ error: "too_many_submissions" }, 429);

      const env = offer.test ? "sandbox" : "production";
      const ip = String(req.headers.get("x-storefront-client-ip") ?? terms.ip ?? "").slice(0, 64) || null;
      const ua = String(req.headers.get("x-storefront-client-ua") ?? terms.user_agent ?? "").slice(0, 400) || null;
      const evidence = {
        terms_accepted_at: termsAt, terms_version: termsVersion, terms_ip: ip, terms_user_agent: ua,
        received_at: new Date().toISOString(),
        agreement_version: agreement && typeof agreement.version === "string" ? agreement.version.slice(0, 64) : null,
        agreement_signed_at: agreement && typeof agreement.signed_at === "string" && Number.isFinite(Date.parse(agreement.signed_at)) ? new Date(agreement.signed_at).toISOString() : null,
        agreement_customer_id: agreement && typeof agreement.customer_id === "string" ? agreement.customer_id : null,
        agreement_amount_jpy: agreement ? canonicalYen(agreement.amount_jpy) : null,
        billing: { same_as_delivery: billingIn.same_as_delivery === true, country: billing.country ?? null, name_given: cardholderName !== "" },
      };
      const reserveArgs = {
        p_cash_order_id: order.id, p_customer_id: customer.id, p_amount_jpy: offer.amount_jpy, p_environment: env,
        p_location_id: offer.location_id, p_app_id: offer.app_id, p_test: offer.test,
        p_idempotency_key: await cardIdempotencyKey(String(order.id), sourceId), p_reference: newAttemptReference(),
        p_verification: verification, p_evidence: evidence,
      };
      let reserved = await rpc(supabase, "reserve_square_attempt", reserveArgs);
      // A previous attempt still unresolved (lost answer, closed tab): resolve
      // it now — found in Square → filed/resolved; not found after 2 minutes →
      // cancelled by its key — then admit this one.
      if (reserved.error === "attempt_in_progress" && reserved.attempt) {
        const prev = reserved.attempt as AnyRec;
        if (Date.now() - Date.parse(String(prev.updated_at ?? prev.created_at)) < 2 * 60 * 1000) {
          return jsonResponse({ error: "card_attempt_pending", attempt: { reference: prev.reference, status: prev.status } }, 409);
        }
        try { await recoverAttempt(supabase, prev, 2 * 60 * 1000, "website"); }
        catch (e) { console.warn("[website] attempt recovery failed:", e); }
        reserved = await rpc(supabase, "reserve_square_attempt", reserveArgs);
      }
      if (reserved.error) {
        const code = String(reserved.error);
        if (code === "too_many_attempts") return jsonResponse({ error: "too_many_attempts", scope: reserved.scope }, 429);
        if (code === "amount_changed") return jsonResponse({ error: "amount_changed", amount_jpy: Number(reserved.remaining_balance) }, 409);
        if (code === "attempt_in_progress") return jsonResponse({ error: "card_attempt_pending", attempt: { reference: reserved.attempt?.reference, status: reserved.attempt?.status } }, 409);
        if (code === "card_hold_active" || code === "submission_pending") return jsonResponse({ error: "submission_pending", detail: code }, 409);
        if (code === "paidy_in_progress") return jsonResponse({ error: "paidy_in_progress", lock: reserved.lock ?? null }, 409);
        return jsonResponse({ error: "card_not_offered", reason: code }, 409);
      }
      const attempt = reserved.attempt as AnyRec;
      const attemptEnv = attempt.environment as SquareEnvironment;
      if (reserved.outcome === "existing") {
        // Same card token again (double click, refresh): report what it became.
        // F-05 / F-12 (QC 2026-10-09): the answer comes from the hold's REAL
        // state (square_payments) and the hold's latest submission — never
        // "authorized" for a hold with no live submission, never "nothing was
        // charged" while a void is still pending.
        const holdOf = async (squarePaymentId: unknown) => {
          if (!squarePaymentId) return null;
          const { data, error } = await supabase.from("square_payments")
            .select("id, status").eq("square_payment_id", String(squarePaymentId)).maybeSingle();
          if (error) throw error;
          return data as { id: string; status: string } | null;
        };
        const answerAuthorized = async (squarePaymentId: unknown) => {
          const hold = await holdOf(squarePaymentId);
          if (!hold) return jsonResponse({ error: "card_hold_unfiled", detail: "replay_no_hold_row" }, 409);
          if (["voided", "expired", "failed", "rejected"].includes(hold.status)) {
            return jsonResponse({ error: "card_mismatch", detail: "hold_closed", hold: "voided" }, 409);
          }
          const { data: sub, error: subErr } = await supabase.from("payment_submissions")
            .select("id, status, submitted_amount, payment_date")
            .eq("square_payment_id", hold.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
          if (subErr) throw subErr;
          if (!sub || ["rejected", "cancelled"].includes(String(sub.status))) {
            return jsonResponse({ error: "card_hold_unfiled", detail: sub ? `submission_${sub.status}` : "replay_no_submission" }, 409);
          }
          return jsonResponse(scrub({ ok: true, submission: { id: sub.id, status: sub.status, submitted_amount: sub.submitted_amount, payment_date: sub.payment_date }, card: { status: hold.status === "captured" ? "captured" : "authorized" }, attempt: { reference: attempt.reference } }));
        };
        const closedHold = async (squarePaymentId: unknown) => {
          if (!squarePaymentId) return "voided";
          const hold = await holdOf(squarePaymentId);
          return !hold || hold.status === "authorized" ? "void_pending" : "voided";
        };
        const st = String(attempt.status);
        if (st === "authorized") return await answerAuthorized(attempt.square_payment_id);
        if (st === "declined") return jsonResponse({ error: "card_declined", code: attempt.error_code ?? null }, 402);
        if (st === "cancelling") return jsonResponse({ error: "card_attempt_pending", attempt: { reference: attempt.reference, status: st } }, 409);
        if (st !== "reserved" && st !== "unknown") return jsonResponse({ error: "card_mismatch", detail: st, hold: await closedHold(attempt.square_payment_id) }, 409);
        // reserved / unknown (review 2026-10-04 #2): NEVER call CreatePayment
        // again — a changed body or a request still in flight answers 4xx and
        // would wrongly close an attempt that may hold money. A fresh one is
        // still in flight; an older one is resolved by READING Square (found
        // by its reference → filed/resolved; nothing after 2 min → cancelled
        // by its key).
        const updatedAt = Date.parse(String(attempt.updated_at ?? attempt.created_at));
        if (st === "reserved" && Date.now() - updatedAt < 2 * 60 * 1000) {
          return jsonResponse({ error: "card_attempt_pending", attempt: { reference: attempt.reference, status: st } }, 409);
        }
        let recovered: string;
        try { recovered = await recoverAttempt(supabase, attempt, 2 * 60 * 1000, "website_replay"); }
        catch (e) { console.warn("[website] replay recovery failed:", e); recovered = "waiting"; }
        if (recovered === "waiting") return jsonResponse({ error: "card_attempt_pending", attempt: { reference: attempt.reference, status: st } }, 409);
        if (recovered === "exception") return jsonResponse({ error: "card_hold_unfiled", detail: "recovered_exception" }, 409);
        const { data: after, error: afterErr } = await supabase.from("square_card_attempts")
          .select("status, error_code, square_payment_id").eq("id", attempt.id).maybeSingle();
        if (afterErr) throw afterErr;
        const st2 = String(after?.status ?? "");
        if (st2 === "authorized") return await answerAuthorized(after?.square_payment_id);
        if (st2 === "declined") return jsonResponse({ error: "card_declined", code: after?.error_code ?? null, hold: "none" }, 402);
        if (st2 === "cancelled" || st2 === "failed") return jsonResponse({ error: "card_mismatch", detail: st2, hold: await closedHold(after?.square_payment_id) }, 409);
        return jsonResponse({ error: "card_attempt_pending", attempt: { reference: attempt.reference, status: st2 } }, 409);
      }

      const resolve = (status: string, from: string[], extra: AnyRec = {}) => resolveAttempt(supabase, String(attempt.id), status, from, extra);
      let payment: SquarePayment;
      try {
        payment = await square.create({
          env: attemptEnv,
          sourceId,
          verificationToken,
          amountJpy: Number(attempt.amount_jpy),
          locationId: String(attempt.location_id),
          idempotencyKey: String(attempt.idempotency_key),
          referenceId: String(attempt.reference),
          note: `${customerReference(order as never)} · ${(order as AnyRec).invoice_number ?? ""}`,
          billing,
          buyerEmail: typeof customer.email === "string" ? customer.email : null,
        });
      } catch (e) {
        if (e instanceof SquareError && e.isCardRefusal) {
          const res = await resolve("declined", ["reserved", "unknown"], { squarePaymentId: e.payment?.id ?? null, code: e.code });
          if (res.ok && res.fraud) {
            const fc = await fraudCancel(supabase, attemptEnv, String(order.id), String(res.fraud), { attempt: attempt.reference, counts: res.counts }, null);
            return jsonResponse({ error: "card_declined", code: e.code, order_cancelled: fc.ok === true }, 402);
          }
          return jsonResponse({ error: "card_declined", code: e.code }, 402);
        }
        if (e instanceof SquareError && (e.kind === "client" || e.kind === "auth" || e.kind === "not_configured")) {
          // Square refused the REQUEST (a used/expired token, a configuration
          // error): nothing was created under this key.
          await resolve("failed", ["reserved", "unknown"], { squarePaymentId: e.payment?.id ?? null, code: e.code, detail: e.message });
          if (e.kind !== "client") console.error("[website] square.create refused:", e.status, e.code);
          return e.kind === "client" ? jsonResponse({ error: "card_mismatch", detail: e.code }, 409) : jsonResponse({ error: "card_unavailable" }, 502);
        }
        // Network / timeout / 5xx / 429 after retries: Square MAY have
        // authorised. The attempt stays open; the website or square-reconcile
        // resolves it by reading Square. The customer must not pay again yet.
        console.error("[website] square.create ambiguous:", e instanceof SquareError ? `${e.status} ${e.code}` : "", e);
        // HUB-1: a payment Square attached to the error lets recovery read it directly.
        await resolve("unknown", ["reserved"], { squarePaymentId: e instanceof SquareError ? e.payment?.id ?? null : null, detail: e instanceof Error ? e.message : String(e) }).catch(() => null);
        return jsonResponse({ ok: false, status: "unknown", attempt: { reference: attempt.reference } }, 202);
      }

      if (payment.status === "FAILED") {
        // HUB-5 (2026-10-05): a decline answered as a FAILED payment (HTTP 200)
        // counts toward the fraud rule exactly like a refusal answered as 4xx.
        const res = await resolve("declined", ["reserved", "unknown"], { squarePaymentId: payment.id, code: "payment_failed" });
        if (res.ok && res.fraud) {
          const fc = await fraudCancel(supabase, attemptEnv, String(order.id), String(res.fraud), { attempt: attempt.reference, counts: res.counts }, null);
          return jsonResponse({ error: "card_declined", code: "payment_failed", order_cancelled: fc.ok === true }, 402);
        }
        return jsonResponse({ error: "card_declined", code: "payment_failed" }, 402);
      }
      if (payment.status !== "APPROVED" && payment.status !== "COMPLETED") {
        await resolve("unknown", ["reserved"], { squarePaymentId: payment.id, detail: `status ${payment.status}` }).catch(() => null);
        return jsonResponse({ ok: false, status: "unknown", attempt: { reference: attempt.reference } }, 202);
      }

      const filed = await fileForAttempt(supabase, attempt, payment, "website_card");
      if (filed.error) throw new Error(`file_square_authorization_atomic: ${filed.error}`);
      // A replay of a hold already recorded as an exception has no submission
      // either: never answer "authorised" for it (review 2026-10-04 #3).
      if (filed.outcome === "already_recorded_exception") return jsonResponse({ error: "card_hold_unfiled", detail: filed.reason }, 409);
      if (filed.outcome === "exception") {
        const action = await handleFilingException(supabase, attemptEnv, attempt, payment, filed);
        if (filed.exception === "amount_mismatch") return jsonResponse({ error: "card_mismatch", detail: "amount", hold: action === "mismatch_voided" ? "voided" : "void_pending" }, 409);
        // risk HIGH: Square approved, the Hub refused. hold "voided" only when
        // the fraud cancel went through (it voids first); otherwise the hold
        // may still be on her card and is being handled — never "not charged".
        if (filed.exception === "risk_high") return jsonResponse({ error: "card_declined", code: "risk_high", order_cancelled: action === "risk_high_cancelled", hold: action === "risk_high_cancelled" ? "voided" : "held" }, 402);
        if (filed.reason === "paidy_in_progress") return jsonResponse({ error: "paidy_in_progress", hold: action === "paidy_voided" ? "voided" : "void_pending" }, 409);
        return jsonResponse({ error: "card_hold_unfiled", detail: filed.reason }, 409);
      }
      const cardFacts = paymentFacts(payment);
      return jsonResponse(scrub({
        ok: true, submission: filed.submission ? { id: filed.submission.id, status: filed.submission.status, submitted_amount: filed.submission.submitted_amount, payment_date: filed.submission.payment_date } : null,
        card: { brand: cardFacts.cardBrand, last4: cardFacts.cardLast4, receipt_url: cardFacts.receiptUrl, status: "authorized", capture_by: cardFacts.captureBy },
        attempt: { reference: attempt.reference },
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

      // Points used at checkout pay part or all of the deposit (2026-10-05):
      // they are a discount, not money. The deposit counts as paid once money
      // has arrived or points cover all of it (public.layaway_deposit_started).
      const [{ data: started, error: startedErr }, { data: ptsPaid, error: ptsErr }] = await Promise.all([
        supabase.rpc("layaway_deposit_started", { p_account_id: plan.id }),
        supabase.rpc("layaway_points_paid", { p_account_id: plan.id }),
      ]);
      if (startedErr) throw startedErr;
      if (ptsErr) throw ptsErr;
      const depositPaid = started === true;
      const pointsApplied = Number(ptsPaid ?? 0);
      // Payment lifecycle H6: her newest decided payment on the plan (separate
      // read — pending_submissions keeps its shape). A plan never switches
      // method (layaway is transfer only), so no switch fields here.
      const decided = await decidedSubmissions(supabase, "account_id", String(plan.id));

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
        latest_decision: latestDecision(decided),
        deposit_paid: depositPaid,
        // Points taken off the deposit at checkout, and what is still due on
        // the deposit (null once it is paid). Hub figures, plan currency.
        points_applied: pointsApplied,
        deposit_due: depositPaid ? null : Math.max(0, Number((plan as AnyRec).downpayment_amount ?? 0) - pointsApplied),
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
      // QC P1-1 (2026-10-06): only a file upload-proof put in our own bucket.
      if (!isOwnProofUrl(proofUrl)) return jsonResponse(INVALID_PROOF_URL, 400);

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

      // A report is the DEPOSIT while the DP portion paid (plus DP reports still
      // pending) is below downpayment_amount — a part-paid deposit keeps filing
      // deposits (qc-audit P2-1, 2026-10-06). review-payment-submission keys the
      // DP split and the loyalty award off submission_type = 'downpayment'.
      // Detection mirrors allocate_payment_atomic / submissionIsDP exactly:
      // _shared/layaway-deposit-rules.ts. Points used at checkout count only
      // as the DP rows they already are (LOYALTY-, remarks "downpayment").
      const [{ data: dpAcct, error: dpAcctErr }, { data: dpPays, error: dpPaysErr }, { data: dpPending, error: dpPendErr }] = await Promise.all([
        supabase.from("layaway_accounts").select("downpayment_amount").eq("id", plan.id).maybeSingle(),
        supabase.from("payments").select("amount_paid, reference_number, remarks")
          .eq("account_id", plan.id).is("voided_at", null),
        supabase.from("payment_submissions").select("submitted_amount, submission_type, reference_number, notes")
          .eq("account_id", plan.id).in("status", ["submitted", "under_review"]),
      ]);
      if (dpAcctErr) throw dpAcctErr;
      if (dpPaysErr) throw dpPaysErr;
      if (dpPendErr) throw dpPendErr;
      const isDeposit = webLayawaySubmissionIsDeposit({
        downpaymentAmount: Number((dpAcct as AnyRec | null)?.downpayment_amount ?? 0),
        payments: (dpPays ?? []) as DepositPaymentRow[],
        pendingSubmissions: (dpPending ?? []) as PendingSubmissionRow[],
      });

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

      // Addendum §9 #2: she hears that her payment details arrived (English —
      // a layaway email). Never throws; once per submission.
      if (created?.id) {
        await sendOrderUpdateEmail(supabase, {
          entity: "layaway", id: String(plan.id), variant: "details_received",
          amount: amount, idempotencyKey: `details-received-${created.id}`,
        });
      }

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
        .select("id, kind, status, item_title, details, ring_size, cash_order_id, layaway_account_id, web_draft_id, customer_note, created_at, updated_at")
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;

      return jsonResponse(((data ?? []) as AnyRec[]).map((row) => {
        const { layaway_account_id, web_draft_id, ...rest } = row;
        return { ...rest, layaway_plan_id: layaway_account_id ?? null, draft_id: web_draft_id ?? null };
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
      // Website orders PR 6 (W2-5): a request may target a DRAFT the customer
      // still has open; Confirm re-points it to the real order.
      const draftId = String(body.draft_id ?? "").trim();
      if ((cashOrderId ? 1 : 0) + (layawayPlanId ? 1 : 0) + (draftId ? 1 : 0) !== 1) {
        return jsonResponse({ error: "exactly_one_target_required" }, 400);
      }
      let targetInvoiceNumber: string | null = null;
      if (draftId) {
        const { data: dr, error: dErr } = await supabase
          .from("web_order_drafts").select("id, invoice_seq, status")
          .eq("id", draftId).eq("customer_id", customer.id).maybeSingle();
        if (dErr) throw dErr;
        if (!dr) return notFound();
        if ((dr as AnyRec).status !== "to_confirm") return jsonResponse({ error: "draft_closed", status: (dr as AnyRec).status }, 409);
        targetInvoiceNumber = String((dr as AnyRec).invoice_seq ?? "") || null;
      } else if (cashOrderId) {
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
          web_draft_id: draftId || null,
          status: "requested",
        })
        .select("id, kind, status, item_title, details, ring_size, cash_order_id, layaway_account_id, web_draft_id, customer_note, created_at, updated_at")
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
            web_draft_id: draftId || null,
          },
        });
      } catch (notifyErr) {
        console.warn("[website] service_request_created notification failed (non-blocking):", notifyErr);
      }

      const { layaway_account_id, web_draft_id, ...rest } = created as AnyRec;
      return jsonResponse({ ...rest, layaway_plan_id: layaway_account_id ?? null, draft_id: web_draft_id ?? null });
    }

    // GET /reviews?product=<slug>&limit=<n<=50>&lang=<en|ja> — APPROVED reviews
    // only, newest approved first, plus { count, average } for the same filter.
    // Never returns customer, order, email or ip fields.
    if (req.method === "GET" && segments[0] === "reviews" && !segments[1]) {
      const slug = (url.searchParams.get("product") ?? "").trim();
      const lang = (url.searchParams.get("lang") ?? "en").trim().toLowerCase() === "ja" ? "ja" : "en";
      const limitRaw = Number(url.searchParams.get("limit") ?? 20);
      const limit = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 20));

      let productId: string | null = null;
      if (slug) {
        const { data: prod, error: pErr } = await supabase
          .from("website_products").select("id").eq("slug", slug).eq("status", "active").maybeSingle();
        if (pErr) throw pErr;
        if (!prod) return jsonResponse({ reviews: [], count: 0, average: null });
        productId = String((prod as AnyRec).id);
      }

      let listQ = supabase
        .from("product_reviews")
        .select("id, rating, body_original, body_en, body_ja, original_language, display_name, piece_name, photo_urls, reviewed_at, product:website_products(slug, name, status)")
        .eq("status", "approved")
        .order("reviewed_at", { ascending: false })
        .limit(limit);
      let statsQ = supabase.from("product_reviews").select("rating").eq("status", "approved");
      if (productId) {
        listQ = listQ.eq("website_product_id", productId);
        statsQ = statsQ.eq("website_product_id", productId);
      }
      const [{ data: rows, error: lErr }, { data: ratings, error: sErr }] = await Promise.all([listQ, statsQ]);
      if (lErr) throw lErr;
      if (sErr) throw sErr;

      const all = (ratings ?? []) as AnyRec[];
      const count = all.length;
      const average = count ? Math.round((all.reduce((t, r) => t + Number(r.rating ?? 0), 0) / count) * 10) / 10 : null;

      const reviews = ((rows ?? []) as AnyRec[]).map((r) => {
        const prod = r.product as AnyRec | null;
        const body = lang === "ja"
          ? r.body_ja
          : (r.original_language === "ja" ? r.body_en : r.body_original);
        return {
          id: r.id,
          rating: r.rating,
          body: body ?? null,
          display_name: r.display_name,
          piece_name: r.piece_name,
          product: prod && prod.status === "active" ? { slug: prod.slug, name: prod.name } : null,
          photos: r.photo_urls ?? [],
          approved_at: r.reviewed_at,
        };
      });
      return jsonResponse({ reviews, count, average });
    }

    // GET /review-invite/:token — is this personal review link usable?
    // A revoked invite reads as not_found.
    if (req.method === "GET" && segments[0] === "review-invite" && segments[1] && !segments[2]) {
      const tokenHash = await sha256Hex(segments[1]);
      const { data: inv, error: iErr } = await supabase
        .from("review_invites")
        .select(`id, piece_name, expires_at, used_at, revoked_at, customer:customers(full_name), product:website_products(slug, name, status, ${VARIANT_SELECT})`)
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (iErr) throw iErr;
      const empty = { first_name: null, piece_name: null, product: null };
      const row = inv as unknown as AnyRec | null;
      if (!row || row.revoked_at) return jsonResponse({ status: "not_found", ...empty });
      const status = row.used_at ? "used" : new Date(String(row.expires_at)).getTime() <= Date.now() ? "expired" : "valid";
      const prod = row.product as AnyRec | null;
      const firstName = String((row.customer as AnyRec | null)?.full_name ?? "").trim().split(/\s+/)[0] || null;
      return jsonResponse({
        status,
        first_name: firstName,
        piece_name: row.piece_name,
        product: prod && prod.status === "active"
          ? { slug: prod.slug, name: prod.name, image: firstProductImage(prod) }
          : null,
      });
    }

    // POST /review-invite/:token (multipart/form-data: rating, body, photos[0..4]).
    // Claim the invite atomically, upload photos to the PRIVATE bucket, insert a
    // pending review. Any failure after the claim releases it.
    if (req.method === "POST" && segments[0] === "review-invite" && segments[1] && !segments[2]) {
      const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
      if (rateLimited(reviewHits, ip)) return jsonResponse({ error: "rate_limited" }, 429);

      const form = await req.formData().catch(() => null);
      if (!form) return jsonResponse({ error: "invalid_body" }, 400);
      const rating = Number(form.get("rating"));
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return jsonResponse({ error: "invalid_rating" }, 400);
      const text = String(form.get("body") ?? "").trim();
      if (text.length < 10) return jsonResponse({ error: "body_too_short" }, 400);
      if (text.length > 2000) return jsonResponse({ error: "body_too_long" }, 400);
      const photos = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
      if (photos.length > 4) return jsonResponse({ error: "too_many_photos" }, 400);
      for (const f of photos) {
        if (!REVIEW_PHOTO_TYPES[f.type]) return jsonResponse({ error: "photo_type" }, 400);
        if (f.size > REVIEW_PHOTO_MAX) return jsonResponse({ error: "photo_too_large" }, 400);
      }

      const tokenHash = await sha256Hex(segments[1]);
      const { data: inv, error: iErr } = await supabase
        .from("review_invites")
        .select("id, used_at, revoked_at, expires_at")
        .eq("token_hash", tokenHash)
        .maybeSingle();
      if (iErr) throw iErr;
      if (!inv || (inv as AnyRec).revoked_at) return jsonResponse({ error: "not_found" }, 404);
      if ((inv as AnyRec).used_at) return jsonResponse({ error: "already_used" }, 409);
      if (new Date(String((inv as AnyRec).expires_at)).getTime() <= Date.now()) return jsonResponse({ error: "expired" }, 410);

      const nowIso = new Date().toISOString();
      const { data: claimed, error: cErr } = await supabase
        .from("review_invites")
        .update({ used_at: nowIso })
        .eq("id", (inv as AnyRec).id)
        .is("used_at", null)
        .is("revoked_at", null)
        .gt("expires_at", nowIso)
        .select("id, customer_id, cash_order_id, layaway_account_id, website_product_id, piece_name")
        .maybeSingle();
      if (cErr) throw cErr;
      if (!claimed) return jsonResponse({ error: "already_used" }, 409);
      const invite = claimed as AnyRec;

      const reviewId = crypto.randomUUID();
      const uploaded: string[] = [];
      try {
        for (let i = 0; i < photos.length; i++) {
          const f = photos[i];
          const path = `${reviewId}/${i + 1}.${REVIEW_PHOTO_TYPES[f.type]}`;
          const { error: upErr } = await supabase.storage.from("review-uploads")
            .upload(path, new Uint8Array(await f.arrayBuffer()), { contentType: f.type, upsert: false });
          if (upErr) throw upErr;
          uploaded.push(path);
        }

        const { data: cust, error: custErr } = await supabase
          .from("customers").select("full_name").eq("id", invite.customer_id).maybeSingle();
        if (custErr) throw custErr;
        const displayName = reviewDisplayName((cust as AnyRec | null)?.full_name);

        const { error: insErr } = await supabase.from("product_reviews").insert({
          id: reviewId,
          invite_id: invite.id,
          customer_id: invite.customer_id,
          cash_order_id: invite.cash_order_id ?? null,
          layaway_account_id: invite.layaway_account_id ?? null,
          website_product_id: invite.website_product_id ?? null,
          piece_name: invite.piece_name,
          rating,
          body_original: text,
          display_name: displayName,
          upload_paths: uploaded,
          status: "pending",
          submitted_ip_hash: ip === "unknown" ? null : await sha256Hex(ip),
        });
        if (insErr) throw insErr;

        try {
          await supabase.from("staff_notifications").insert({
            type: "review_submitted",
            title: "New customer review",
            body: `${String((cust as AnyRec | null)?.full_name ?? displayName)} reviewed ${String(invite.piece_name)} (${rating}★) — Website → Reviews`,
            customer_id: invite.customer_id,
            metadata: { review_id: reviewId, rating, link: "/website?tab=reviews" },
          });
        } catch (notifyErr) {
          console.warn("[website] review_submitted notification failed (non-blocking):", notifyErr);
        }
        return jsonResponse({ ok: true });
      } catch (err) {
        const e = err as { message?: string; code?: string };
        console.error("website review submit failed", requestId, e?.code ?? "", e?.message ?? err);
        if (uploaded.length) await supabase.storage.from("review-uploads").remove(uploaded).catch(() => {});
        await supabase.from("review_invites").update({ used_at: null }).eq("id", invite.id);
        return jsonResponse({ error: "server_error", request_id: requestId }, 500);
      }
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

    // GET /cart-reminders/unsubscribe?token=… — the link in every cart
    // reminder. x-api-key only (no session: she may open it on any device).
    // ALWAYS answers unsubscribed, whatever the token, so the page cannot be
    // used to probe tokens. Touches ONLY the cart-reminder consent — never
    // suppressed_emails, so her order emails continue.
    if (req.method === "GET" && segments[0] === "cart-reminders" && segments[1] === "unsubscribe") {
      const token = (url.searchParams.get("token") ?? "").trim();
      if (/^[0-9a-fA-F-]{36}$/.test(token)) {
        const { error: wErr } = await supabase.rpc("withdraw_cart_reminder_by_token", { p_token: token });
        if (wErr) throw wErr;
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
