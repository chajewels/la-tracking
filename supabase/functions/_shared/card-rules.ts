/**
 * Square card payments on a confirmed web order: the PURE rules. No Deno
 * globals, no Supabase client, no imports, so vitest runs the same file the
 * edge functions do (src/test/card-rules.test.ts). docs/SQUARE.md. Twin of
 * paidy-rules.ts.
 *
 * Owner decisions (claude/square-build-plan-v2-2026-10-03 + 2026-10-04 01:07):
 * D4 yen-settled cash orders only, ANY country; D5 only after staff Confirm;
 * D6 authorise on pay, capture on reviewer Confirm, void on Reject; D9 every
 * card payment needs the signed Card Purchase Agreement (threshold seeded 0);
 * Q2 an unconfirmed hold is cancelled by Square at the end of its window and
 * the submission auto-rejects; a bell warns two days before.
 *
 * Integrity (2026-10-04, docs/SQUARE-INTEGRITY.md, review SQ01–SQ23): exact
 * integer yen everywhere (SQ12); Square COMPLETED is never hidden behind a
 * local "no charge" state (SQ13); the warning follows Square's own deadline
 * (SQ14); the fraud thresholds (owner 2026-10-04); truthful 3DS evidence
 * (SQ18); agreement binding (SQ20, owner 5A).
 */

export type SquareMode = "off" | "test" | "on";
export type SquareEnvironment = "sandbox" | "production";

/** Fail-closed: anything but the two exact strings is off (mirrors public.square_mode()). */
export function squareModeFrom(raw: unknown): SquareMode {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { /* a bare string */ }
  }
  return v === "test" || v === "on" ? v : "off";
}

/**
 * D-G04 (owner 2026-10-09): who may pay by card while the mode is ON.
 * square_audience 'everyone' | 'listed'; anything else is 'listed' (fail-closed,
 * mirrors public.square_audience()).
 */
export type SquareAudience = "everyone" | "listed";
export function squareAudienceFrom(raw: unknown): SquareAudience {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { /* a bare string */ }
  }
  return v === "everyone" ? "everyone" : "listed";
}

/** square_card_customer_ids as a set of customer id strings; anything not an array is empty. */
export function squareCardCustomerIds(raw: unknown): Set<string> {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return new Set(); }
  }
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
}

/**
 * TS twin of public.square_card_allowed(customer): off → no; test → only test
 * customers; on → everyone when the audience is 'everyone', else only the
 * listed customers. The SQL is the authority (reserve_square_attempt refuses
 * card_not_offered); this decides what the storefront is offered.
 */
export function squareCardAllowed(i: { mode: SquareMode; audience: SquareAudience; listed: Set<string>; customerId: string | null | undefined; customerIsTest: boolean }): boolean {
  if (i.mode === "off") return false;
  if (i.mode === "test") return i.customerIsTest;
  return i.audience === "everyone" || (!!i.customerId && i.listed.has(String(i.customerId)));
}

/** test → sandbox, on → production; off has no environment. */
export function squareEnvironmentOf(mode: SquareMode): SquareEnvironment | null {
  return mode === "test" ? "sandbox" : mode === "on" ? "production" : null;
}

/**
 * The storefront only ever receives a PUBLIC Application ID. Square's ids:
 * sandbox-sq0idb-… (sandbox) / sq0idp-… (production). An access token
 * (EAAA…) or an application secret (sq0csp-…) is never an id.
 */
export function squareAppIdFamily(id: unknown): "sandbox" | "production" | null {
  if (typeof id !== "string") return null;
  if (/^sandbox-sq0idb-[A-Za-z0-9_-]{6,}$/.test(id)) return "sandbox";
  if (/^sq0idp-[A-Za-z0-9_-]{6,}$/.test(id)) return "production";
  return null;
}

/**
 * Canonical yen (SQ12): a positive safe integer. Square's JPY amount_money is a
 * number of whole yen; a fractional, negative, non-finite or unsafe value is
 * never rounded into one.
 */
export function isCanonicalYen(v: unknown): boolean {
  if (typeof v === "string" && !/^\s*\d+(\.0+)?\s*$/.test(v)) return false;
  const n = Number(v);
  return Number.isFinite(n) && Number.isSafeInteger(n) && n > 0;
}

/** The canonical yen value, or null — never rounded. */
export function canonicalYen(v: unknown): number | null {
  return isCanonicalYen(v) ? Number(v) : null;
}

export interface CardOfferInput {
  mode: SquareMode;
  appId: unknown;
  locationId: unknown;
  customerIsTest: boolean;
  order: {
    currency?: string | null;
    payment_status?: string | null;
    status?: string | null;
    remaining_balance?: number | string | null;
    source_channel?: string | null;
    ready_confirmed_at?: string | null;
  };
  pendingSubmissions: number;
  /** square_order_unresolved: an attempt in flight, a live hold or unrecorded captured money (SQ11). */
  cardUnresolved?: boolean;
  /**
   * cash_orders.payment_method (owner C1, 2026-10-05): a WEBSITE order offers
   * card only when card ('square') is its method (null = transfer). Omitted =
   * not checked (older callers).
   */
  paymentMethod?: string | null;
  /**
   * D-G04 (2026-10-09): squareCardAllowed for this customer while the mode is
   * on. Omitted = everyone (older callers, mode test/off unaffected).
   */
  cardAllowed?: boolean;
}

/** Why card payment is not offered, or null when it is. One reason, the first that fails. No address rule (D4: any country). */
export function cardNotOfferedReason(i: CardOfferInput): string | null {
  if (i.mode === "off") return "mode_off";
  if (i.mode === "test" && !i.customerIsTest) return "test_mode_real_customer";
  if (i.mode === "on" && i.cardAllowed === false) return "not_on_card_list";
  const family = squareAppIdFamily(i.appId);
  if (!family) return "no_app_id";
  if (i.mode === "test" && family !== "sandbox") return "app_id_mode_mismatch";
  if (i.mode === "on" && family !== "production") return "app_id_mode_mismatch";
  if (typeof i.locationId !== "string" || i.locationId.trim() === "") return "no_location_id";
  if (i.paymentMethod !== undefined && i.order.source_channel === "web" && (i.paymentMethod ?? "transfer") !== "square") return "method_not_chosen";
  if (String(i.order.currency ?? "") !== "JPY") return "not_jpy";
  if (i.order.status !== "pending") return "order_not_open";
  if (i.order.payment_status !== "pending_transfer") return "no_payment_due";
  if (i.order.source_channel === "web" && i.order.ready_confirmed_at == null) return "not_ready_for_payment";
  if (!(Number(i.order.remaining_balance ?? 0) > 0)) return "nothing_due";
  if (!isCanonicalYen(i.order.remaining_balance)) return "fractional_balance";
  if (i.cardUnresolved) return "card_payment_unresolved";
  if (i.pendingSubmissions > 0) return "submission_pending";
  return null;
}

/**
 * Square holds a card-not-present authorisation (autocomplete:false) for 7
 * days by default, then applies delay_action — CANCEL for us (owner Q2). The
 * real deadline is Square's own `delayed_until` (square_payments.capture_by);
 * the 7 days are only the fallback when Square did not send it.
 */
export const CARD_HOLD_DAYS = 7;
/** The expiry bell rings this long before Square's deadline (SQ14). */
export const CARD_HOLD_WARN_BEFORE_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Square's deadline for a hold: delayed_until when known, else authorised + 7 days; null when neither parses. */
export function cardHoldDeadline(authorizedAt: string | null | undefined, captureBy?: string | null): Date | null {
  const cb = captureBy ? Date.parse(captureBy) : NaN;
  if (Number.isFinite(cb)) return new Date(cb);
  const t = authorizedAt ? Date.parse(authorizedAt) : NaN;
  return Number.isFinite(t) ? new Date(t + CARD_HOLD_DAYS * DAY_MS) : null;
}

/**
 * Past Square's deadline by the clock. This is TIME, not proof: only Square's
 * read-back (CANCELED) closes a hold (SQ14) — callers use this to decide when
 * to read Square, never to conclude that nothing was charged.
 */
export function cardHoldExpired(authorizedAt: string, now: Date = new Date(), captureBy?: string | null): boolean {
  const d = cardHoldDeadline(authorizedAt, captureBy);
  return d === null ? true : now.getTime() > d.getTime();
}

/** The warning is due from 2 days before Square's own deadline (a hold already past it is warned too). */
export function cardHoldWarnDue(authorizedAt: string, now: Date = new Date(), captureBy?: string | null): boolean {
  const d = cardHoldDeadline(authorizedAt, captureBy);
  if (d === null) return false;
  return now.getTime() >= d.getTime() - CARD_HOLD_WARN_BEFORE_DAYS * DAY_MS;
}

/**
 * The CreatePayment idempotency key: one per CARD TOKEN on the order. A Web
 * Payments SDK token is single-use, so a retried click with the same token
 * maps to the same attempt row and the same Square payment (no second hold),
 * while a new token is a new attempt — admitted only once the previous one
 * is resolved (reserve_square_attempt). ≤ 45 chars (Square's limit).
 */
export async function cardIdempotencyKey(orderId: string, sourceId: string): Promise<string> {
  const data = new TextEncoder().encode(`${orderId}\n${sourceId}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `cj-card-${hex.slice(0, 36)}`;
}

/**
 * The attempt reference sent to Square as reference_id (≤ 40 chars). Every
 * webhook and every ListPayments row carries it back, so a payment whose
 * create response was lost still finds its attempt (SQ03). `cja_` marks it as
 * ours: a payment without it is a seller/POS payment and is never allocated.
 */
export function newAttemptReference(randomBytes?: Uint8Array): string {
  const b = randomBytes ?? globalThis.crypto.getRandomValues(new Uint8Array(12));
  return "cja_" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
export function isAttemptReference(v: unknown): v is string {
  return typeof v === "string" && /^cja_[0-9a-f]{8,36}$/.test(v);
}

/** Caps and the fraud rule (owner 2026-10-04): enforced in reserve_square_attempt / resolve_square_attempt. */
export const CARD_ATTEMPTS_PER_DAY = 5;
export const CARD_REFUSALS_PER_ORDER = 5;
export const CARD_REFUSALS_PER_CUSTOMER = 10;

/**
 * What a Square status means for a square_payments row the Hub holds as
 * `current` — the TS mirror of apply_square_payment_state (the SQL is the
 * authority). COMPLETED is captured whatever the Hub concluded before (SQ13);
 * captured never moves; APPROVED means the hold is live; CANCELED/FAILED close
 * a live hold only; PENDING/UNKNOWN change nothing.
 */
export function nextSquareRowStatus(current: string, squareStatus: SquarePaymentStatus, authorizedAt: string, captureBy: string | null | undefined, now: Date = new Date()): string {
  if (squareStatus === "COMPLETED") return "captured";
  if (current === "captured") return "captured";
  if (squareStatus === "APPROVED") return "authorized";
  if (current !== "authorized") return current;
  if (squareStatus === "FAILED") return "failed";
  if (squareStatus === "CANCELED") return cardHoldExpired(authorizedAt, now, captureBy) ? "expired" : "voided";
  return current;
}

/** A provider completion the Hub had closed — money that must surface as an exception, never stay hidden. */
export function isCaptureAfterClose(current: string, squareStatus: SquarePaymentStatus): boolean {
  return squareStatus === "COMPLETED" && (current === "voided" || current === "expired" || current === "failed" || current === "rejected");
}

/** Exact integer-yen equality (SQ12): 52000 vs 51999.6 is NOT a match. */
export function cardAmountMatches(squareAmount: unknown, remainingBalance: unknown): boolean {
  return isCanonicalYen(squareAmount) && isCanonicalYen(remainingBalance) && Number(squareAmount) === Number(remainingBalance);
}

/** Square payment ids are opaque URL-safe strings. */
export function isSquarePaymentId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

export type SquarePaymentStatus = "APPROVED" | "COMPLETED" | "CANCELED" | "FAILED" | "PENDING" | "UNKNOWN";

/** Square's documented statuses, upper-cased; anything else is UNKNOWN (never guessed). */
export function normalizeSquareStatus(raw: unknown): SquarePaymentStatus {
  const s = String(raw ?? "").trim().toUpperCase();
  return s === "APPROVED" || s === "COMPLETED" || s === "CANCELED" || s === "FAILED" || s === "PENDING" ? s : "UNKNOWN";
}

/**
 * D9: the signed Card Purchase Agreement is required at or above the Hub's
 * card_agreement_min_jpy; a threshold of 0 (or anything unusable) means EVERY
 * card payment — the fail-closed reading.
 */
export function agreementRequired(amountJpy: number, minJpy: number): boolean {
  const min = Number(minJpy);
  if (!Number.isFinite(min) || min <= 0) return true;
  return Number(amountJpy) >= min;
}

export interface AgreementEvidence {
  version?: unknown;
  signed_at?: unknown;
  customer_id?: unknown;
  amount_jpy?: unknown;
  bound?: unknown;
}

/**
 * Owner 5A / SQ20: the signature counts only for THIS customer and THIS amount
 * — the Card.gs lookup returns who signed (customer id from the signed link)
 * and the amount shown when she signed. A changed amount means she signs
 * again. Returns the refusal code, or null when the agreement binds the charge.
 */
export function agreementBindingProblem(a: AgreementEvidence | null | undefined, orderCustomerId: string, amountJpy: number, now: Date = new Date()): string | null {
  if (!a || typeof a !== "object") return "agreement_missing";
  if (typeof a.version !== "string" || a.version.trim() === "") return "agreement_missing";
  const signed = typeof a.signed_at === "string" ? Date.parse(a.signed_at) : NaN;
  if (!Number.isFinite(signed)) return "agreement_missing";
  if (signed > now.getTime() + 5 * 60 * 1000) return "agreement_time_invalid";
  if (a.bound !== true) return "agreement_unbound";
  if (typeof a.customer_id !== "string" || a.customer_id !== orderCustomerId) return "agreement_other_customer";
  if (!isCanonicalYen(a.amount_jpy) || Number(a.amount_jpy) !== amountJpy) return "agreement_amount_changed";
  return null;
}

/** Terms acceptance time (client-reported) must be a real time, not in the future, and recent (24 h). */
export function termsTimeProblem(acceptedAt: unknown, now: Date = new Date()): string | null {
  const t = typeof acceptedAt === "string" ? Date.parse(acceptedAt) : NaN;
  if (!Number.isFinite(t)) return "terms_missing";
  if (t > now.getTime() + 5 * 60 * 1000) return "terms_time_invalid";
  if (now.getTime() - t > DAY_MS) return "terms_stale";
  return null;
}

/**
 * SQ18 — truthful 3-D Secure evidence. The Hub cannot observe the issuer's
 * verdict for an online card payment; it records only what it knows: which
 * SDK path the storefront reports, or that a separate token was supplied.
 */
export function cardVerificationEvidence(flow: unknown, verificationTokenSupplied: boolean): string {
  if (verificationTokenSupplied) return "verification_token_supplied";
  if (flow === "sdk_tokenize_with_verification") return "sdk_tokenize_with_verification";
  return "unknown";
}

/** Owner Q5 (Paidy) applied to card: the ledger date of a capture is its Japan calendar day. */
export function jstDate(iso: string | null | undefined, fallback: Date = new Date()): string {
  const t = iso ? Date.parse(iso) : NaN;
  const d = Number.isFinite(t) ? new Date(t) : fallback;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(d);
}

/**
 * L5 (2026-10-09, eighth release): may a card hold still be CAPTURED for this
 * order? Read on a FRESH order row right before Square's capture, on every
 * path — a first Confirm and a resumed "Finish recording" alike (the resume
 * used to skip the balance check, so Square could take money the order could
 * no longer record). Mirrors finalize_cash_submission_atomic's refusals:
 * order_closed, exceeds_remaining (INVARIANT 4, ¥0.005 tolerance).
 */
export function cardCaptureOrderRefusal(
  order: { status?: unknown; remaining_balance?: unknown } | null | undefined,
  amountJpy: unknown,
): "order_closed" | "exceeds_remaining" | null {
  if (!order) return "order_closed";
  if (order.status === "cancelled" || order.status === "expired") return "order_closed";
  const amount = Number(amountJpy);
  const remaining = Number(order.remaining_balance);
  if (!Number.isFinite(amount) || !Number.isFinite(remaining) || order.remaining_balance == null) return "exceeds_remaining";
  return amount > remaining + 0.005 ? "exceeds_remaining" : null;
}
