// Addendum §9 #8 — "Mark refund issued" on a cancelled WEBSITE order.
// TS mirror of mark_web_order_refund_issued_atomic's refusal order
// (supabase/migrations/20261112100000_payment_lifecycle_refund_issued.sql):
// change one, change the other. The SQL is the authority; this lets the edge
// function refuse a bad request before the database and lets the Hub decide
// when to show the button.
// B01 (2026-10-08): the card checks — method must match how she paid, a card
// refund needs a COMPLETED Square refund and records Square's amount
// (method_mismatch / no_completed_card_refund) — need the payment and refund
// rows, so they live in the SQL only; this mirror stops at bad_date.

// SQF06 (owner D-SQF06, 2026-10-09): the two "card refund outside Square"
// exception methods — admin only, evidence required, capped by the SQL
// (mark_web_order_refund_issued_atomic p_exception). The customer's email
// names the payout (bank transfer / store credit), never the word exception.
export const REFUND_METHODS = ["bank_transfer", "paidy", "card", "cash", "other", "bank_transfer_exception", "store_credit_exception"] as const;
export type RefundMethodCode = typeof REFUND_METHODS[number];
export const EXCEPTION_METHODS: readonly RefundMethodCode[] = ["bank_transfer_exception", "store_credit_exception"];
export function isExceptionMethod(v: unknown): boolean {
  return typeof v === "string" && (EXCEPTION_METHODS as readonly string[]).includes(v);
}
/** The refund method the customer is told: an exception is a bank transfer or store credit to her. */
export function customerRefundMethod(method: string): "bank_transfer" | "paidy" | "card" | "cash" | "other" | "store_credit" | null {
  if (method === "bank_transfer_exception") return "bank_transfer";
  if (method === "store_credit_exception") return "store_credit";
  return isRefundMethod(method) ? (method as "bank_transfer" | "paidy" | "card" | "cash" | "other") : null;
}

export function isRefundMethod(v: unknown): v is RefundMethodCode {
  return typeof v === "string" && (REFUND_METHODS as readonly string[]).includes(v.trim().toLowerCase());
}

/** The order may be marked refunded: a cancelled web order still waiting for its refund. */
export function canMarkRefundIssued(o: { source_channel?: unknown; status?: unknown; refund_status?: unknown } | null | undefined): boolean {
  return !!o && o.source_channel === "web" && o.status === "cancelled" && o.refund_status === "refund_pending";
}

/**
 * The first refusal, in the SQL's order, or null when the request may go on.
 * `today` is the PHT calendar day (YYYY-MM-DD) — a refund cannot be dated in the future.
 */
export function refundIssuedRefusal(
  o: { source_channel?: unknown; status?: unknown; refund_status?: unknown } | null | undefined,
  input: { method: unknown; refundedOn: unknown },
  today: string,
): string | null {
  if (!o) return "not_found";
  if (o.source_channel !== "web") return "not_web_order";
  if (o.status !== "cancelled") return "not_cancelled";
  // B01 (2026-10-08): an order already marked refund_issued goes through to the
  // SQL, which answers the same result again for the same method
  // (already_recorded) and refuses otherwise — a retry after a lost answer
  // must not be bounced here.
  if (o.refund_status !== "refund_pending" && o.refund_status !== "refund_issued") return "not_refund_pending";
  if (!isRefundMethod(input.method)) return "bad_method";
  const d = typeof input.refundedOn === "string" ? input.refundedOn.trim() : "";
  // Round-trip: Date.parse rolls 2026-02-30 over to 2 March, so only a day that survives is real.
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== d || d > today) return "bad_date";
  return null;
}
