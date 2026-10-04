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

/**
 * P07 (2026-10-04): when the authorisation stops being capturable, in ms.
 * Paidy's own `expires_at` wins (its support page: 30 days = 720 h after the
 * authorisation, "a few seconds" of drift possible, check the dashboard); the
 * 30-day rule is only the fallback when Paidy did not send it. null = unknown.
 */
export function paidyExpiryTime(authorizedAt: unknown, expiresAt?: unknown): number | null {
  const e = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  if (Number.isFinite(e)) return e;
  const a = typeof authorizedAt === "string" ? Date.parse(authorizedAt) : NaN;
  return Number.isFinite(a) ? a + PAIDY_AUTH_DAYS * 24 * 60 * 60 * 1000 : null;
}

/** P07: lapsed by Paidy's expires_at (fallback 30 days). Unknown dates count as lapsed. */
export function paidyAuthorizationLapsed(rec: { authorized_at?: unknown; expires_at?: unknown }, now: Date = new Date()): boolean {
  const t = paidyExpiryTime(rec.authorized_at, rec.expires_at);
  return t == null || now.getTime() >= t;
}

export type PaidyProviderOutcome = "captured" | "authorized" | "expired" | "closed" | "rejected" | "unknown";

/**
 * P03 (2026-10-04): what Paidy's OWN read-back says happened. Decisions about
 * a Paidy payment are taken from this, never from an HTTP status code:
 *   captured   — at least one capture exists (money taken; record it, never ask again)
 *   authorized — still capturable
 *   expired    — AUTHORIZED but past expires_at (cannot be captured; customer pays again)
 *   closed     — CLOSED with no capture (released; customer pays again)
 *   rejected   — Paidy declined it
 *   unknown    — anything else: keep it pending, never tell the customer to pay again
 */
export function paidyProviderOutcome(
  p: { status?: unknown; captures?: unknown; expires_at?: unknown; created_at?: unknown } | null | undefined,
  now: Date = new Date(),
): PaidyProviderOutcome {
  if (!p) return "unknown";
  const captures = Array.isArray(p.captures) ? p.captures : [];
  if (captures.length > 0) return "captured";
  const s = normalizePaidyStatus(p.status);
  if (s === "AUTHORIZED") return paidyAuthorizationLapsed({ authorized_at: p.created_at, expires_at: p.expires_at }, now) ? "expired" : "authorized";
  if (s === "CLOSED") return "closed";
  if (s === "REJECTED") return "rejected";
  return "unknown";
}

/** Total yen Paidy reports as captured on a payment. */
export function paidyCapturedAmount(p: { captures?: unknown } | null | undefined): number {
  const captures = Array.isArray(p?.captures) ? p!.captures as { amount?: unknown }[] : [];
  return captures.reduce((sum, c) => sum + Math.round(Number(c?.amount ?? 0) || 0), 0);
}

/** The capture Paidy returned last (the one a Confirm just made), or null. */
export function paidyLatestCapture(p: { captures?: unknown } | null | undefined): { id: string; amount: number; created_at?: string } | null {
  const captures = Array.isArray(p?.captures) ? p!.captures as { id?: unknown; amount?: unknown; created_at?: unknown }[] : [];
  const last = captures[captures.length - 1];
  if (!last || typeof last.id !== "string") return null;
  return { id: last.id, amount: Math.round(Number(last.amount ?? 0) || 0), created_at: typeof last.created_at === "string" ? last.created_at : undefined };
}

/**
 * P08 (2026-10-04): before a capture, the yen Paidy holds, the yen the Hub
 * recorded, the yen on the submission and the order's live balance must agree.
 * Returns the first disagreement, or null.
 */
export function paidyCaptureAmountProblem(i: {
  providerAmount: unknown; recordAmount: unknown; submittedAmount: unknown; remainingBalance: unknown;
}): string | null {
  const provider = Math.round(Number(i.providerAmount)), record = Math.round(Number(i.recordAmount));
  const submitted = Math.round(Number(i.submittedAmount)), remaining = Number(i.remainingBalance);
  if (!Number.isFinite(provider) || provider <= 0) return "provider_amount_missing";
  if (!Number.isFinite(record) || provider !== record) return "provider_vs_record";
  if (!Number.isFinite(submitted) || submitted !== record) return "record_vs_submission";
  if (!Number.isFinite(remaining) || submitted > remaining + 0.005) return "exceeds_remaining";
  return null;
}

/**
 * Q5 (owner 2026-10-04): a Paidy payment's date_paid is the CAPTURE day in
 * JAPAN time — the order is yen-only, Japan-only. An owner exception to the
 * PHT day boundary, for Paidy captures only (docs/PAIDY.md). YYYY-MM-DD.
 */
export function paidyJapanDate(at: Date | string = new Date()): string {
  const d = typeof at === "string" ? new Date(at) : at;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * P10 (2026-10-04): buyer_data.last_order_amount = the most recently COMPLETED
 * paid yen cash order (by completed_at, then order_date), never "whatever row
 * the database returned last". undefined when there is none.
 */
export function paidyLastOrderAmount(
  orders: { total_paid?: unknown; status?: unknown; completed_at?: unknown; order_date?: unknown }[],
): number | undefined {
  const done = orders
    .filter((o) => o.status === "completed" && Number(o.total_paid ?? 0) > 0)
    .map((o) => ({ amount: Math.round(Number(o.total_paid)), at: Date.parse(String(o.completed_at ?? o.order_date ?? "")) || 0 }))
    .sort((a, b) => b.at - a.at);
  return done.length ? done[0].amount : undefined;
}

/** P11: refunds Paidy reports that the Hub has not recorded yet (by refund id). */
export function paidyNewRefunds(
  p: { refunds?: unknown } | null | undefined, knownIds: Iterable<string>,
): { id: string; amount: number; created_at?: string }[] {
  const known = new Set(knownIds);
  const refunds = Array.isArray(p?.refunds) ? p!.refunds as { id?: unknown; amount?: unknown; created_at?: unknown }[] : [];
  return refunds
    .filter((r) => typeof r?.id === "string" && !known.has(r.id as string) && Math.round(Number(r.amount ?? 0)) > 0)
    .map((r) => ({ id: r.id as string, amount: Math.round(Number(r.amount)), created_at: typeof r.created_at === "string" ? r.created_at : undefined }));
}

/** P02: how long a reviewer Confirm owns a claimed submission before it may be resumed. */
export const PAIDY_CONFIRM_LEASE_MS = 5 * 60 * 1000;

/** P02: a claim with no lease stamp (older code) or an older stamp may be resumed. */
export function paidyConfirmLeaseExpired(processingStartedAt: unknown, now: Date = new Date()): boolean {
  const t = typeof processingStartedAt === "string" ? Date.parse(processingStartedAt) : NaN;
  return !Number.isFinite(t) || now.getTime() - t >= PAIDY_CONFIRM_LEASE_MS;
}

/**
 * P01/P12: why a payment read back from Paidy cannot be filed against this
 * order, or null when it can. One rule for the website callback, the webhook
 * and paidy-reconcile, so an authorisation the callback lost is judged exactly
 * as the callback would have judged it.
 */
export function paidyFilingMismatch(
  p: { status?: unknown; currency?: unknown; test?: unknown; amount?: unknown; order?: { order_ref?: unknown } | null } | null | undefined,
  order: { remaining_balance?: unknown },
  expect: { test: boolean; orderRef: string },
): string | null {
  if (!p) return "unknown_payment";
  if (normalizePaidyStatus(p.status) !== "AUTHORIZED") return "not_authorized";
  if (p.currency !== "JPY") return "not_jpy";
  if ((p.test === true) !== expect.test) return "test_flag";
  if (!paidyAmountMatches(p.amount, order.remaining_balance)) return "amount";
  if (String(p.order?.order_ref ?? "") !== expect.orderRef) return "order_ref";
  return null;
}

/** Yen are whole; Paidy's amount is a number of yen. */
export function paidyAmountMatches(paidyAmount: unknown, remainingBalance: unknown): boolean {
  const a = Number(paidyAmount), b = Number(remainingBalance);
  return Number.isFinite(a) && Number.isFinite(b) && Math.round(a) === Math.round(b) && a > 0;
}

/**
 * Paidy's status, upper-cased. The reference documents AUTHORIZED | CLOSED |
 * REJECTED, but the live Checkout callback sent "authorized" in lower case
 * (test run 2026-10-03, pay_asDHekoAAEkAmsmA). Pure, so vitest pins it; the
 * API client (_shared/paidy.ts) applies it to every read-back.
 */
export function normalizePaidyStatus(raw: unknown): string {
  return String(raw ?? "").trim().toUpperCase();
}
