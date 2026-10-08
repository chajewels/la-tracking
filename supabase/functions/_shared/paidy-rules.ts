/**
 * Paidy 『あと払い（ペイディ）』 on a confirmed web order (2026-10-03): the PURE
 * rules. No Deno globals, no Supabase client, so vitest runs the same file
 * the edge functions do (src/test/paidy-rules.test.ts). docs/PAIDY.md.
 *
 * Owner decisions (claude/paidy-build-plan-2026-10-03): P1 Paidy is offered
 * only on a confirmed order; staff capture it in the Paidy merchant dashboard
 * and the Hub records what Paidy reports (owner 2026-10-04 — the Hub never
 * captures); P5 only for a Japanese delivery address, yen only; PD1 a Paidy
 * submission carries no proof file; PD4 an authorisation past Paidy's
 * `expires_at` cannot be captured (Paidy's docs give no fixed length; 30 days
 * after authorisation is only the fallback when `expires_at` is missing).
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
  /**
   * Owner 2026-10-04: Paidy only while nothing has been paid on the order.
   * Points used at checkout (LOYALTY- discounts) are not money: callers pass
   * total_paid LESS cash_order_points_paid (2026-10-05).
   */
  totalPaid?: number | string | null;
  /** cash_order_payment_lock() — a Paidy window/payment or any other payment in progress. */
  paymentLock?: string | null;
  /** The buyer's own name (never the delivery recipient, R11). */
  buyerName?: string | null;
  /** R10: false when the item breakdown cannot equal the amount. */
  breakdownOk?: boolean;
  /**
   * P05 (owner 2026-10-08): Paidy only for a buyer with a complete Japanese
   * billing address (prefecture included), her own Japanese mobile number
   * and both name fields. Omitted = not checked (older callers).
   */
  requirements?: PaidyRequirements;
  /**
   * cash_orders.payment_method (owner C1, 2026-10-05): the customer chose how to
   * pay at checkout, so a WEBSITE order offers Paidy only when Paidy is its
   * method (null = transfer). Omitted = not checked (older callers).
   */
  paymentMethod?: string | null;
}

/** Why Paidy is not offered, or null when it is. One reason, the first that fails. */
export function paidyNotOfferedReason(i: PaidyOfferInput): string | null {
  if (i.mode === "off") return "mode_off";
  if (i.mode === "test" && !i.customerIsTest) return "test_mode_real_customer";
  if (!isPaidyPublicKey(i.publicKey)) return "no_public_key";
  if (i.mode === "test" && !String(i.publicKey).startsWith("pk_test_")) return "key_mode_mismatch";
  if (i.mode === "on" && !String(i.publicKey).startsWith("pk_live_")) return "key_mode_mismatch";
  if (i.paymentMethod !== undefined && i.order.source_channel === "web" && (i.paymentMethod ?? "transfer") !== "paidy") return "method_not_chosen";
  if (String(i.order.currency ?? "") !== "JPY") return "not_jpy";
  if (i.order.status !== "pending") return "order_not_open";
  if (i.order.payment_status !== "pending_transfer") return "no_payment_due";
  if (i.order.source_channel === "web" && i.order.ready_confirmed_at == null) return "not_ready_for_payment";
  if (!(Number(i.order.remaining_balance ?? 0) > 0)) return "nothing_due";
  if (paidyYen(i.order.remaining_balance) == null) return "amount_not_whole_yen";
  if (i.totalPaid !== undefined && Number(i.totalPaid ?? 0) !== 0) return "part_paid";
  if (!paidyAddressComplete(i.address)) return "address_not_jp_or_incomplete";
  if (i.pendingSubmissions > 0) return "submission_pending";
  if (i.paymentLock) return "payment_in_progress";
  if (i.buyerName !== undefined && !String(i.buyerName ?? "").trim()) return "no_buyer_name";
  if (i.requirements) {
    if (!i.requirements.jp_billing_address) return "no_jp_billing_address";
    if (!i.requirements.jp_mobile) return "no_jp_mobile";
    if (!i.requirements.family_name || !i.requirements.given_name) return "no_buyer_name";
  }
  if (i.breakdownOk === false) return "breakdown_mismatch";
  return null;
}

/**
 * R14 (2026-10-04): a yen amount as an exact positive whole number, or null.
 * Never rounds: ¥51,999.6 is not ¥52,000 — it is refused.
 */
export function paidyYen(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 && n <= 99_999_999 ? n : null;
}

/**
 * FALLBACK ONLY: Paidy's `expires_at` is the authority (paidyExpiryTime);
 * Paidy's developer docs state no fixed authorisation length.
 */
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

/** Total yen Paidy reports as captured on a payment; NaN when any capture amount is not whole yen (R14). */
export function paidyCapturedAmount(p: { captures?: unknown } | null | undefined): number {
  const captures = Array.isArray(p?.captures) ? p!.captures as { amount?: unknown }[] : [];
  return captures.reduce((sum, c) => {
    const y = paidyYen(c?.amount);
    return y == null ? NaN : sum + y;
  }, 0);
}

/** The capture Paidy returned last (the one a Confirm just made), or null. */
export function paidyLatestCapture(p: { captures?: unknown } | null | undefined): { id: string; amount: number; created_at?: string } | null {
  const captures = Array.isArray(p?.captures) ? p!.captures as { id?: unknown; amount?: unknown; created_at?: unknown }[] : [];
  const last = captures[captures.length - 1];
  if (!last || typeof last.id !== "string") return null;
  return { id: last.id, amount: paidyYen(last.amount) ?? NaN, created_at: typeof last.created_at === "string" ? last.created_at : undefined };
}

/**
 * Owner 2026-10-04 (capture in the Paidy dashboard, the Hub records it): why a
 * capture Paidy reports must NOT be recorded against this submission, or null.
 * Exact yen everywhere (R14); a refunded capture is held for staff (owner D4).
 */
export function paidyRecordProblem(i: {
  capturedAmount: unknown; recordAmount: unknown; submittedAmount: unknown; refundedAmount: unknown;
}): string | null {
  const captured = paidyYen(i.capturedAmount), record = paidyYen(i.recordAmount), submitted = paidyYen(i.submittedAmount);
  if (captured == null) return "captured_amount_invalid";
  if (record == null || captured !== record) return "captured_vs_authorized";
  if (submitted == null || submitted !== record) return "authorized_vs_submission";
  if (Number(i.refundedAmount ?? 0) !== 0) return "refunded";
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

export interface PaidyHistoryOrder {
  status?: unknown; currency?: unknown; total_amount?: unknown;
  completed_at?: unknown; order_date?: unknown;
  /** any non-voided payment on it was made with Paidy */
  paid_by_paidy?: boolean;
  /** Paidy (or staff) reported a refund on it */
  refunded?: boolean;
}

/**
 * R12 (2026-10-04): buyer_data from the customer's OWN completed yen orders
 * that were not paid with Paidy and not refunded (Paidy Checkout: "orders
 * excluding those paid with Paidy, refunded or cancelled"). Order VALUES
 * (total_amount), not receipts. last_order_at = whole days since the latest
 * one; registration date is never invented here. Empty history → zeros and
 * no last-order fields.
 */
export function paidyBuyerHistory(orders: PaidyHistoryOrder[], now: Date = new Date()): {
  order_count: number; ltv: number; last_order_amount?: number; last_order_at?: number;
} {
  const ok = orders
    .filter((o) => o.status === "completed" && o.currency === "JPY" && !o.paid_by_paidy && !o.refunded)
    .map((o) => ({ amount: paidyYen(o.total_amount), at: Date.parse(String(o.completed_at ?? o.order_date ?? "")) }))
    .filter((o): o is { amount: number; at: number } => o.amount != null);
  const ltv = ok.reduce((s, o) => s + o.amount, 0);
  const dated = ok.filter((o) => Number.isFinite(o.at)).sort((a, b) => b.at - a.at);
  const last = dated[0];
  return {
    order_count: ok.length,
    ltv,
    ...(last ? { last_order_amount: last.amount, last_order_at: Math.max(0, Math.floor((now.getTime() - last.at) / 86_400_000)) } : {}),
  };
}

/**
 * H9 / P2-3 (2026-10-06): the customer's layaway plans as history rows for
 * paidyBuyerHistory. Paidy's ltv / order_count / last_order_* cover every
 * order she made at the store, so a COMPLETED yen plan counts like a completed
 * cash order; paidyBuyerHistory keeps only status 'completed' + JPY, so a
 * forfeited / cancelled / final_* plan never counts. Value = total_amount (the
 * plan's obligation); date = completed_at, else order_date. Paidy never pays a
 * layaway, so a plan is never Paidy-paid; layaway has no refund record.
 */
export function paidyHistoryFromLayaway(rows: {
  status?: unknown; currency?: unknown; total_amount?: unknown; completed_at?: unknown; order_date?: unknown;
}[]): PaidyHistoryOrder[] {
  return rows.map((r) => ({
    status: r.status, currency: r.currency, total_amount: r.total_amount,
    completed_at: r.completed_at, order_date: r.order_date,
    paid_by_paidy: false, refunded: false,
  }));
}

/**
 * H9 / P2-2: the customer's own address from her `customers` row. That table
 * has address_line1, city, postal_code, country and NO line2 / prefecture
 * column, so region is null here — never guessed from city.
 */
export function paidyCustomerRecordAddress(c: {
  address_line1?: unknown; city?: unknown; postal_code?: unknown; country?: unknown;
} | null | undefined): PaidyAddress | null {
  if (!c) return null;
  const s = (v: unknown) => (v == null ? null : String(v));
  return { line1: s(c.address_line1), line2: null, city: s(c.city), region: null, postal_code: s(c.postal_code), country: s(c.country) };
}

/**
 * H9 / P2-2: Paidy marks buyer_data.billing_address REQUIRED ("Consumer's
 * billing address (i.e., residence)"). Her default address-book entry when it
 * is a complete Japanese address, else her own customer record when THAT is
 * complete, else nothing (omitted, as before) with a reason code that carries
 * no address text. Never the order's ship-to / gift recipient (R11).
 */
export function paidyBillingAddress(
  defaultEntry: PaidyAddress | null | undefined,
  customerRecord: PaidyAddress | null | undefined,
): { address?: ReturnType<typeof paidyAddressLines>; source: "address_book" | "customer_record" | null; reason?: string } {
  if (paidyAddressComplete(defaultEntry)) return { address: paidyAddressLines(defaultEntry), source: "address_book" };
  if (paidyAddressComplete(customerRecord)) return { address: paidyAddressLines(customerRecord), source: "customer_record" };
  return { source: null, reason: "no_complete_jp_billing_address" };
}

/** H9 / P2-4: buyer.dob "YYYY-MM-DD" (Paidy Checkout) from customers.birthday; a real calendar date or undefined. */
export function paidyDob(raw: unknown): string | undefined {
  const s = typeof raw === "string" ? raw.trim().slice(0, 10) : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
    ? s : undefined;
}

/**
 * H9 / P2-5: buyer_data.number_of_points — "points the consumer has
 * accumulated (prior to this order)". Paidy is offered only after staff
 * Confirm, and Confirm approves the checkout redemption, which already took
 * those points off loyalty_members.remaining_points. So the points spent on
 * THIS order (1 pt = ¥1, cash_order_points_paid) are added back. No member
 * row → undefined (omitted).
 */
export function paidyPointsBeforeOrder(member: { remaining_points?: unknown } | null | undefined, spentOnThisOrder: unknown): number | undefined {
  if (!member) return undefined;
  const held = Math.max(0, Math.floor(Number(member.remaining_points ?? 0) || 0));
  const spent = Math.max(0, Math.floor(Number(spentOnThisOrder ?? 0) || 0));
  return held + spent;
}

/**
 * R13: a Japanese mobile number for Paidy's SMS prefill (070/080/090 + 8
 * digits; +81 accepted), or null — then Paidy Checkout asks for it. Only the
 * BUYER's own number is ever passed, never the delivery recipient's.
 */
export function paidyJapaneseMobile(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xFF10)).replace(/[^0-9+]/g, "");
  if (d.startsWith("+81")) d = "0" + d.slice(3);
  else if (d.startsWith("81") && d.length === 12) d = "0" + d.slice(2);
  return /^0[789]0\d{8}$/.test(d) ? d : null;
}

/**
 * R13: Paidy's address lines. Paidy Checkout's field definitions: line1 =
 * "building name, apartment number", line2 = "district, land number, land
 * number extension" (paidy.com/docs/en/paidycheckout.html). The Hub stores
 * 住所1 (番地まで) in line1 and 住所2 (建物名・部屋番号) in line2, so they are
 * swapped here.
 */
export function paidyAddressLines(a: PaidyAddress | null | undefined): { line1?: string; line2?: string; city?: string; state?: string; zip: string } {
  const street = String(a?.line1 ?? "").trim(), building = String(a?.line2 ?? "").trim();
  return {
    line1: building || undefined,
    line2: street || undefined,
    city: String(a?.city ?? "").trim() || undefined,
    state: String(a?.region ?? "").trim() || undefined,
    zip: paidyZip(a?.postal_code) ?? "",
  };
}

export interface PaidyItem { id: string; quantity: number; title: string; unit_price: number }

/**
 * R10: ONE charge breakdown. Paidy is offered only when nothing has been paid
 * (owner D2), so the amount is the whole order: Σ item lines + shipping −
 * discount must equal it. A discount is a negative-price line (Paidy Checkout:
 * "If the order item is a discount or coupon, set the unit_price to a negative
 * value"); a
 * difference the lines do not explain (a staff-added fee) is an explicit
 * "Other charges" line; an order with no item lines is one line named after
 * the order. Returns null when the figures are not whole yen or cannot add up.
 *
 * POINTS (owner C3–C5, 2026-10-05): points used at checkout are a discount
 * already applied to the order (a LOYALTY- line, total_paid). `points_applied`
 * is that yen figure; the amount is then total − points and a negative
 * "Points" line makes the breakdown add up to it.
 */
export function paidyCheckoutBreakdown(
  order: { total_amount?: unknown; shipping_fee?: unknown; discount_amount?: unknown; remaining_balance?: unknown; points_applied?: unknown },
  lines: { sku?: unknown; variant_id?: unknown; id?: unknown; quantity?: unknown; title?: unknown; unit_price_jpy?: unknown }[],
  reference: string,
): { amount: number; items: PaidyItem[]; shipping: number } | null {
  const amount = paidyYen(order.remaining_balance);
  const total = paidyYen(order.total_amount);
  const shipping = Number(order.shipping_fee ?? 0), discount = Number(order.discount_amount ?? 0);
  const points = Number(order.points_applied ?? 0);
  if (!Number.isInteger(points) || points < 0) return null;
  if (amount == null || total == null || amount !== total - points) return null;
  if (!Number.isInteger(shipping) || shipping < 0 || !Number.isInteger(discount) || discount < 0) return null;
  const items: PaidyItem[] = [];
  for (const l of lines) {
    const qty = Number(l.quantity ?? 1), price = Number(l.unit_price_jpy ?? NaN);
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isInteger(price) || price < 0) return null;
    items.push({ id: String(l.sku ?? l.variant_id ?? l.id ?? "item"), quantity: qty, title: String(l.title ?? "Jewelry"), unit_price: price });
  }
  if (items.length === 0) {
    const goods = total - shipping + discount;
    if (goods <= 0) return null;
    items.push({ id: reference || "order", quantity: 1, title: reference ? `Order ${reference}` : "Order", unit_price: goods });
  }
  if (discount > 0) items.push({ id: "discount", quantity: 1, title: "Discount", unit_price: -discount });
  if (points > 0) items.push({ id: "points", quantity: 1, title: "Points", unit_price: -points });
  const sum = items.reduce((s, it) => s + it.unit_price * it.quantity, 0) + shipping;
  if (sum !== amount) {
    const diff = amount - sum;
    if (diff <= 0) return null; // the lines claim more than the order: never hide it with an invented discount
    items.push({ id: "other", quantity: 1, title: "Other charges", unit_price: diff });
  }
  return { amount, items, shipping };
}

/** P11/R17: refunds Paidy reports that the Hub has not recorded yet (by refund id), with their capture link. */
export function paidyNewRefunds(
  p: { refunds?: unknown } | null | undefined, knownIds: Iterable<string>,
): { id: string; amount: number; created_at?: string; capture_id?: string; reason?: string | null; raw: Record<string, unknown> }[] {
  const known = new Set(knownIds);
  const refunds = Array.isArray(p?.refunds) ? p!.refunds as Record<string, unknown>[] : [];
  return refunds
    .filter((r) => typeof r?.id === "string" && !known.has(r.id as string) && paidyYen(r.amount) != null)
    .map((r) => ({
      id: r.id as string, amount: paidyYen(r.amount)!,
      created_at: typeof r.created_at === "string" ? r.created_at : undefined,
      capture_id: typeof r.capture_id === "string" ? r.capture_id : undefined,
      reason: typeof r.reason === "string" ? r.reason : null,
      raw: r,
    }));
}

/** R06: the refund total as the ledger says, from every refund Paidy reports. */
export function paidyRefundTotal(p: { refunds?: unknown } | null | undefined): number {
  const refunds = Array.isArray(p?.refunds) ? p!.refunds as { amount?: unknown }[] : [];
  return refunds.reduce((s, r) => s + (paidyYen(r?.amount) ?? 0), 0);
}

/**
 * PA12 (owner brief 2026-10-08): a successful HTTP answer from Paidy is a
 * usable FINANCIAL object only when it carries what every caller then reads
 * off it — the REQUESTED payment id, a whole-yen amount in JPY, a boolean
 * test flag, a status, and well-formed capture / refund arrays whose refunds
 * point at captures the payment really has. A 200 that lacks any of these
 * (the reproduced `{ "status": "CLOSED" }`) is `paidy_bad_response`: an
 * UNKNOWN the callers keep and re-read, never a verified uncaptured state.
 *
 * Deliberately NOT refused here: an unfamiliar status value (a future Paidy
 * state). It passes through and paidyProviderOutcome answers "unknown", so
 * Reject / cancel refuse it (PA13) instead of a false release.
 *
 * CLOSED without a captures ARRAY is incomplete: CLOSED is both "released"
 * and "captured", and only the array tells them apart. AUTHORIZED / REJECTED
 * may omit the arrays (nothing financial has happened) — treated as empty.
 */
export type PaidyObjectProblem =
  | "not_object" | "missing_id" | "id_mismatch" | "status" | "amount" | "currency" | "test_flag"
  | "captures_shape" | "capture_shape" | "closed_without_captures" | "refunds_shape" | "refund_shape" | "refund_capture_link";

export function validatePaidyPaymentObject(
  json: unknown, expectedId?: string,
): { ok: true; payment: Record<string, unknown> & { id: string; status: string; amount: number; currency: string; test: boolean; captures: unknown[]; refunds: unknown[] } } | { ok: false; reason: PaidyObjectProblem; detail?: string } {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, reason: "not_object" };
  const o = json as Record<string, unknown>;
  const id = o.id;
  if (typeof id !== "string" || !/^pay_[A-Za-z0-9_-]{6,80}$/.test(id)) return { ok: false, reason: "missing_id" };
  if (expectedId !== undefined && id !== expectedId) return { ok: false, reason: "id_mismatch", detail: `${id} for ${expectedId}` };
  const status = normalizePaidyStatus(o.status);
  if (!status) return { ok: false, reason: "status" };
  const amount = paidyYen(o.amount);
  if (amount == null) return { ok: false, reason: "amount" };
  if (String(o.currency ?? "").trim().toUpperCase() !== "JPY") return { ok: false, reason: "currency", detail: String(o.currency) };
  if (typeof o.test !== "boolean") return { ok: false, reason: "test_flag" };

  if (o.captures !== undefined && o.captures !== null && !Array.isArray(o.captures)) return { ok: false, reason: "captures_shape" };
  if (status === "CLOSED" && !Array.isArray(o.captures)) return { ok: false, reason: "closed_without_captures" };
  const captures = Array.isArray(o.captures) ? o.captures : [];
  const captureIds = new Set<string>();
  for (const c of captures) {
    const cc = c as Record<string, unknown> | null;
    if (!cc || typeof cc !== "object" || typeof cc.id !== "string" || !cc.id || paidyYen(cc.amount) == null) return { ok: false, reason: "capture_shape" };
    captureIds.add(cc.id);
  }
  if (o.refunds !== undefined && o.refunds !== null && !Array.isArray(o.refunds)) return { ok: false, reason: "refunds_shape" };
  const refunds = Array.isArray(o.refunds) ? o.refunds : [];
  for (const r of refunds) {
    const rr = r as Record<string, unknown> | null;
    if (!rr || typeof rr !== "object" || typeof rr.id !== "string" || !rr.id || paidyYen(rr.amount) == null) return { ok: false, reason: "refund_shape" };
    if (rr.capture_id !== undefined && rr.capture_id !== null) {
      if (typeof rr.capture_id !== "string" || !rr.capture_id) return { ok: false, reason: "refund_shape" };
      if (!captureIds.has(rr.capture_id)) return { ok: false, reason: "refund_capture_link", detail: `${rr.id} → ${rr.capture_id}` };
    }
  }
  return { ok: true, payment: { ...o, id, status, amount, currency: "JPY", test: o.test, captures, refunds } };
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

/** R14: exact whole yen on both sides, equal — never a rounded comparison. */
export function paidyAmountMatches(paidyAmount: unknown, remainingBalance: unknown): boolean {
  const a = paidyYen(paidyAmount), b = paidyYen(remainingBalance);
  return a != null && b != null && a === b;
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

/**
 * H9 (2026-10-06): the Paidy Checkout payload (`Paidy.launch()`), built from
 * figures the caller already computed. Field names and formats follow
 * paidy.com/docs/en/paidycheckout.html:
 *   - order.tax is OPTIONAL and omitted (prices are tax-inclusive; sending 0
 *     under-reported it, P3-1);
 *   - metadata (max 20 keys) carries the Hub ids for dashboard ↔ Hub matching
 *     (P3-2);
 *   - buyer.dob YYYY-MM-DD and buyer_data.number_of_points only when known.
 * Undefined fields vanish when the storefront serialises the payload.
 */
export function paidyCheckoutPayload(a: {
  amount: number; orderRef: string; cashOrderId: string; customerId: string; userId: string;
  email?: string; name1: string; phone?: string; dob?: string;
  history: ReturnType<typeof paidyBuyerHistory>; registered?: string;
  billing?: ReturnType<typeof paidyAddressLines>; numberOfPoints?: number;
  items: PaidyItem[]; shipping: number; shippingAddress: ReturnType<typeof paidyAddressLines>;
}) {
  return {
    amount: a.amount,
    currency: "JPY" as const,
    store_name: "Cha Jewels",
    description: a.orderRef,
    buyer: {
      email: a.email,
      name1: a.name1,
      phone: a.phone,
      dob: a.dob,
    },
    buyer_data: {
      user_id: a.userId,
      ltv: a.history.ltv,
      order_count: a.history.order_count,
      last_order_amount: a.history.last_order_amount,
      last_order_at: a.history.last_order_at,
      account_registration_date: a.registered,
      billing_address: a.billing,
      number_of_points: a.numberOfPoints,
    },
    order: {
      items: a.items,
      order_ref: a.orderRef,
      shipping: a.shipping,
    },
    shipping_address: a.shippingAddress,
    metadata: { cash_order_id: a.cashOrderId, customer_id: a.customerId, source: "web" },
  };
}

/**
 * H9 / P2-6: the IPs Paidy sends webhooks from, as published at
 * https://paidy.com/docs/en/webhook.html ("Paidy sends webhook notifications
 * from the following IP addresses"). Change ONLY when Paidy's page changes.
 *
 * SOFT GATE (controller ruling R14, 2026-10-06): the source never decides
 * whether a delivery is processed — every one is stored and re-read from
 * Paidy. It only decides whether an id Paidy does not know may open a
 * `provider_unreadable` case + staff bell. The PAIDY_WEBHOOK_IP_CHECK=off
 * edge secret treats every source as recognised (docs/PAIDY.md).
 */
export const PAIDY_WEBHOOK_IPS: readonly string[] = [
  "13.114.134.35",
  "13.113.94.100",
  "18.182.135.232",
  "52.199.50.20",
  "52.199.62.26",
];

/**
 * The address that connected: `cf-connecting-ip` when present, else the LAST
 * x-forwarded-for entry (the one the platform adds; earlier entries are
 * client-supplied). null when neither is there.
 */
export function paidyWebhookSourceIp(headers: { get(name: string): string | null }): string | null {
  const cf = String(headers.get("cf-connecting-ip") ?? "").trim();
  if (cf) return cf;
  const entries = String(headers.get("x-forwarded-for") ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  return entries.length ? entries[entries.length - 1] : null;
}

/** True only for one of Paidy's published IPs. Missing / empty → false. */
export function isPaidyWebhookIp(ip: string | null | undefined): boolean {
  const v = String(ip ?? "").trim();
  return v !== "" && PAIDY_WEBHOOK_IPS.includes(v);
}

/** The check is on unless the env value is exactly "off". */
export function paidyWebhookIpCheckOn(envValue: string | null | undefined): boolean {
  return envValue !== "off";
}

/**
 * H9 / P3-5: the capture deadline in the staff bell — Paidy's own `expires_at`
 * as a Japan date; the old "valid 30 days" only when Paidy did not send it.
 */
export function paidyCaptureDeadlineText(expiresAt: unknown): string {
  const t = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(t) ? `capture by ${paidyJapanDate(new Date(t))} JST` : "valid 30 days";
}

// Owner decisions 2026-10-06 / 2026-10-08 (P05): Paidy's buyer.name1 is
// FAMILY NAME FIRST, built from the two fields she (or staff) entered —
// customers.family_name + given_name — never guessed from full_name. Either
// missing → "" (Paidy is then not offered: no_buyer_name).
export function paidyBuyerName(family: unknown, given: unknown): string {
  const f = String(family ?? "").replace(/\s+/g, " ").trim();
  const g = String(given ?? "").replace(/\s+/g, " ").trim();
  return f && g ? `${f} ${g}` : "";
}

/** P05: a name field as she typed it — 1..60 chars after trimming, or null. */
export function paidyNameField(raw: unknown): string | null {
  const v = String(raw ?? "").replace(/\s+/g, " ").trim();
  return v.length >= 1 && v.length <= 60 ? v : null;
}

/**
 * P05 (owner 2026-10-08): what Paidy needs from the buyer herself, as the
 * order page reports it so she can fill in what is missing. true = satisfied.
 *   family_name / given_name — customers.family_name / given_name
 *   jp_mobile                — her own Japanese mobile (paidyJapaneseMobile)
 *   jp_billing_address       — a complete Japanese billing address
 *                              (paidyBillingAddress found one)
 */
export interface PaidyRequirements { family_name: boolean; given_name: boolean; jp_mobile: boolean; jp_billing_address: boolean }
export function paidyRequirements(i: {
  family_name?: unknown; given_name?: unknown; mobile_number?: unknown; billingAddressFound: boolean;
}): PaidyRequirements {
  return {
    family_name: paidyNameField(i.family_name) != null,
    given_name: paidyNameField(i.given_name) != null,
    jp_mobile: paidyJapaneseMobile(i.mobile_number) != null,
    jp_billing_address: i.billingAddressFound,
  };
}
export function paidyRequirementsMet(r: PaidyRequirements): boolean {
  return r.family_name && r.given_name && r.jp_mobile && r.jp_billing_address;
}

// Owner decision 2026-10-06: a staff CANCEL closes an open Paidy authorisation
// first. What to do with one authorisation, decided from Paidy's own read-back:
//   close  — still authorised (or past expires_at): close it at Paidy
//   mark   — Paidy already ended it: record that, nothing to call
//   refuse — Paidy has taken the money: never cancel over captured money
//   retry  — Paidy's answer could not be read: refuse, nothing changed
export type PaidyCancelStep = "close" | "mark" | "refuse" | "retry";
export function paidyCancelStep(outcome: PaidyProviderOutcome): PaidyCancelStep {
  if (outcome === "captured") return "refuse";
  if (outcome === "authorized" || outcome === "expired") return "close";
  if (outcome === "closed" || outcome === "rejected") return "mark";
  return "retry";
}

/**
 * PA08 (2026-10-09): the idempotency key of the 「返金を受け付けました」 email
 * the Hub sends once per Paidy refund (paidy-sync). One place, so the sender,
 * the "already emailed" proof in mark-refund-issued and the audited manual
 * resend can never disagree on it.
 */
export function paidyRefundReceivedKey(refundId: string): string {
  return `refund-received-paidy-${refundId}`;
}

/** PA15B: one of her address-book entries Paidy may bill to (a complete Japanese address). */
export interface PaidyBillingChoice {
  id: string; is_default: boolean;
  line1: string | null; line2: string | null; city: string | null; region: string | null; postal_code: string | null;
}

/**
 * PA15B (owner 2026-10-08 17:17 JST, recommended option 2026-10-09): the
 * customer CHOOSES where Paidy bills her, separately from where the piece
 * goes (the order's delivery address, chosen at checkout). The choices are
 * her own address-book entries that are complete Japanese addresses, default
 * first. With her choice (`wantedId`) that entry is used — an id that is not
 * one of HER complete Japanese entries is refused (`billing_address_invalid`,
 * never silently replaced). Without a choice the default entry is preselected,
 * then any other complete entry, then her customer record (H9) — never the
 * order's ship-to / gift recipient (R11).
 */
export function paidyBillingChoice(
  entries: Array<PaidyAddress & { id?: unknown; is_default?: unknown }> | null | undefined,
  customerRecord: PaidyAddress | null | undefined,
  wantedId?: string | null,
): {
  choices: PaidyBillingChoice[];
  address?: ReturnType<typeof paidyAddressLines>;
  source: "address_book" | "customer_record" | null;
  id: string | null;
  reason?: "billing_address_invalid" | "no_complete_jp_billing_address";
} {
  const s = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v));
  const choices: PaidyBillingChoice[] = (entries ?? [])
    .filter((e) => e && e.id != null && paidyAddressComplete(e))
    .map((e) => ({
      id: String(e.id), is_default: e.is_default === true,
      line1: s(e.line1), line2: s(e.line2), city: s(e.city), region: s(e.region), postal_code: s(e.postal_code),
    }))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default));
  const asAddress = (c: PaidyBillingChoice): PaidyAddress => ({ ...c, country: "JP" });
  if (wantedId) {
    const hit = choices.find((c) => c.id === wantedId);
    if (!hit) return { choices, source: null, id: null, reason: "billing_address_invalid" };
    return { choices, address: paidyAddressLines(asAddress(hit)), source: "address_book", id: hit.id };
  }
  if (choices.length > 0) return { choices, address: paidyAddressLines(asAddress(choices[0])), source: "address_book", id: choices[0].id };
  if (paidyAddressComplete(customerRecord)) return { choices, address: paidyAddressLines(customerRecord), source: "customer_record", id: null };
  return { choices, source: null, id: null, reason: "no_complete_jp_billing_address" };
}
