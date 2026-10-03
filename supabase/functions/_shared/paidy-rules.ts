/**
 * Paidy 『あと払い（ペイディ）』 on a confirmed web order (2026-10-03): the PURE
 * rules. No Deno globals, no Supabase client, so vitest runs the same file
 * the edge functions do (src/test/paidy-rules.test.ts). docs/PAIDY.md.
 *
 * Owner decisions (claude/paidy-build-plan-2026-10-03): P1 Paidy is offered
 * only on a confirmed order and captured on reviewer Confirm; P5 only for a
 * Japanese delivery address, yen only; PD1 a Paidy submission carries no
 * proof file; PD4 an authorisation older than 30 days cannot be captured.
 */

export type PaidyMode = "off" | "test" | "on";

/** Fail-closed: anything but the two exact strings is off (mirrors public.paidy_mode()). */
export function paidyModeFrom(raw: unknown): PaidyMode {
  let v = raw;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { /* a bare string */ }
  }
  return v === "test" || v === "on" ? v : "off";
}

/** The storefront only ever receives a PUBLIC key. */
export function isPaidyPublicKey(key: unknown): key is string {
  return typeof key === "string" && /^pk_(test|live)_[A-Za-z0-9]{8,}$/.test(key);
}

export interface PaidyAddress {
  line1?: string | null; line2?: string | null; city?: string | null;
  region?: string | null; postal_code?: string | null; country?: string | null;
}

/**
 * Paidy rejects a payment whose shipping address is not complete "down to the
 * room number"; postal code + prefecture alone is refused at creation. We
 * require the four fields the snapshot carries and a Japanese postal code.
 */
export function paidyAddressComplete(a: PaidyAddress | null | undefined): boolean {
  if (!a) return false;
  if (String(a.country ?? "").toUpperCase() !== "JP") return false;
  return !!(a.line1 && a.city && a.region && paidyZip(a.postal_code));
}

/** Paidy wants NNN-NNNN. Accepts 1234567 / 123-4567 / 〒123-4567 with spaces; anything else → null. */
export function paidyZip(raw: unknown): string | null {
  const digits = String(raw ?? "").replace(/[^0-9０-９]/g, "").replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xFF10));
  return /^\d{7}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3)}` : null;
}

export interface PaidyOfferInput {
  mode: PaidyMode;
  publicKey: unknown;
  customerIsTest: boolean;
  order: {
    currency?: string | null;
    payment_status?: string | null;
    status?: string | null;
    remaining_balance?: number | string | null;
    source_channel?: string | null;
    ready_confirmed_at?: string | null;
  };
  address: PaidyAddress | null | undefined;
  pendingSubmissions: number;
}

/** Why Paidy is not offered, or null when it is. One reason, the first that fails. */
export function paidyNotOfferedReason(i: PaidyOfferInput): string | null {
  if (i.mode === "off") return "mode_off";
  if (i.mode === "test" && !i.customerIsTest) return "test_mode_real_customer";
  if (!isPaidyPublicKey(i.publicKey)) return "no_public_key";
  if (i.mode === "test" && !String(i.publicKey).startsWith("pk_test_")) return "key_mode_mismatch";
  if (i.mode === "on" && !String(i.publicKey).startsWith("pk_live_")) return "key_mode_mismatch";
  if (String(i.order.currency ?? "") !== "JPY") return "not_jpy";
  if (i.order.status !== "pending") return "order_not_open";
  if (i.order.payment_status !== "pending_transfer") return "no_payment_due";
  if (i.order.source_channel === "web" && i.order.ready_confirmed_at == null) return "not_ready_for_payment";
  if (!(Number(i.order.remaining_balance ?? 0) > 0)) return "nothing_due";
  if (!paidyAddressComplete(i.address)) return "address_not_jp_or_incomplete";
  if (i.pendingSubmissions > 0) return "submission_pending";
  return null;
}

export const PAIDY_AUTH_DAYS = 30;

/** PD4: an authorisation Paidy no longer honours. `authorizedAt` ISO; `now` for tests. */
export function paidyAuthorizationExpired(authorizedAt: string, now: Date = new Date()): boolean {
  const t = Date.parse(authorizedAt);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > PAIDY_AUTH_DAYS * 24 * 60 * 60 * 1000;
}

/** Yen are whole; Paidy's amount is a number of yen. */
export function paidyAmountMatches(paidyAmount: unknown, remainingBalance: unknown): boolean {
  const a = Number(paidyAmount), b = Number(remainingBalance);
  return Number.isFinite(a) && Number.isFinite(b) && Math.round(a) === Math.round(b) && a > 0;
}
