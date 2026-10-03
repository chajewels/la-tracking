/**
 * Square card payments on a confirmed web order (S2, 2026-10-04): the PURE
 * rules. No Deno globals, no Supabase client, no imports, so vitest runs the
 * same file the edge functions do (src/test/card-rules.test.ts). docs/SQUARE.md.
 * Twin of paidy-rules.ts.
 *
 * Owner decisions (claude/square-build-plan-v2-2026-10-03 + 2026-10-04 01:07):
 * D4 yen-settled cash orders only, ANY country; D5 only after staff Confirm;
 * D6 authorise on pay, capture on reviewer Confirm, void on Reject; D9 every
 * card payment needs the signed Card Purchase Agreement (threshold seeded 0);
 * Q2 an unconfirmed hold is cancelled by Square at the end of its window and
 * the submission auto-rejects; a bell warns two days before.
 */

export type SquareMode = "off" | "test" | "on";

/** Fail-closed: anything but the two exact strings is off (mirrors public.square_mode()). */
export function squareModeFrom(raw: unknown): SquareMode {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { /* a bare string */ }
  }
  return v === "test" || v === "on" ? v : "off";
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
}

/** Why card payment is not offered, or null when it is. One reason, the first that fails. No address rule (D4: any country). */
export function cardNotOfferedReason(i: CardOfferInput): string | null {
  if (i.mode === "off") return "mode_off";
  if (i.mode === "test" && !i.customerIsTest) return "test_mode_real_customer";
  const family = squareAppIdFamily(i.appId);
  if (!family) return "no_app_id";
  if (i.mode === "test" && family !== "sandbox") return "app_id_mode_mismatch";
  if (i.mode === "on" && family !== "production") return "app_id_mode_mismatch";
  if (typeof i.locationId !== "string" || i.locationId.trim() === "") return "no_location_id";
  if (String(i.order.currency ?? "") !== "JPY") return "not_jpy";
  if (i.order.status !== "pending") return "order_not_open";
  if (i.order.payment_status !== "pending_transfer") return "no_payment_due";
  if (i.order.source_channel === "web" && i.order.ready_confirmed_at == null) return "not_ready_for_payment";
  if (!(Number(i.order.remaining_balance ?? 0) > 0)) return "nothing_due";
  if (i.pendingSubmissions > 0) return "submission_pending";
  return null;
}

/**
 * Square holds a card authorisation (autocomplete:false) for 7 days, then
 * applies delay_action — CANCEL for us (owner Q2). The reviewer must Confirm
 * inside the window; a bell warns from day 5.
 */
export const CARD_HOLD_DAYS = 7;
export const CARD_HOLD_WARN_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A hold Square no longer honours. Square's own `delayed_until` (stored as
 * square_payments.capture_by) wins when present; otherwise the 7-day rule.
 * An unparsable authorisation timestamp counts as expired. `now` for tests.
 */
export function cardHoldExpired(authorizedAt: string, now: Date = new Date(), captureBy?: string | null): boolean {
  const cb = captureBy ? Date.parse(captureBy) : NaN;
  if (Number.isFinite(cb)) return now.getTime() > cb;
  const t = Date.parse(authorizedAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > CARD_HOLD_DAYS * DAY_MS;
}

/** The warning is due from day 5 on (a hold past day 7 is still warned — "expired, Reject it"). */
export function cardHoldWarnDue(authorizedAt: string, now: Date = new Date()): boolean {
  const t = Date.parse(authorizedAt);
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= CARD_HOLD_WARN_DAYS * DAY_MS;
}

/**
 * The CreatePayment idempotency key: one per CARD TOKEN, not per attempt.
 * A Web Payments SDK nonce is single-use, so a retried click with the same
 * nonce maps to the same Square payment (no second hold), while a corrected
 * card (new nonce) gets a fresh key — a declined or cancelled attempt never
 * locks the order (review finding B1, 2026-10-04). ≤ 45 chars (Square's limit).
 */
export async function cardIdempotencyKey(orderId: string, sourceId: string): Promise<string> {
  const data = new TextEncoder().encode(`${orderId}\n${sourceId}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `cj-card-${hex.slice(0, 36)}`;
}

/** Square's card-attempt cap per order per rolling 24 h (declines included — the submission cap cannot see them). */
export const CARD_ATTEMPTS_PER_DAY = 5;

/**
 * What a Square status means for a square_payments row the Hub holds as
 * `current`. Our own settled states are never downgraded; an unknown or
 * pending answer changes nothing.
 */
export function nextSquareRowStatus(current: string, squareStatus: SquarePaymentStatus, authorizedAt: string, captureBy: string | null | undefined, now: Date = new Date()): string {
  if (current === "captured" || current === "expired" || current === "voided" || current === "failed") return current;
  if (squareStatus === "COMPLETED") return "captured";
  if (squareStatus === "FAILED") return "failed";
  if (squareStatus === "CANCELED") return cardHoldExpired(authorizedAt, now, captureBy) ? "expired" : "voided";
  return current;
}

/** Yen are whole; Square's amount_money.amount for JPY is a number of yen. */
export function cardAmountMatches(squareAmount: unknown, remainingBalance: unknown): boolean {
  const a = Number(squareAmount), b = Number(remainingBalance);
  return Number.isFinite(a) && Number.isFinite(b) && Math.round(a) === Math.round(b) && a > 0;
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
