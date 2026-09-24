// Reassign Owner — pure rules (CLAUDE.md "REASSIGN OWNER", R1–R10).
//
// reassign_order_owner_atomic (SQL) is AUTHORITATIVE: it makes every decision
// the move depends on, under a row lock. This module mirrors those rules so
// they can be unit-tested (src/test/reassign-owner.test.ts) and so the edge
// function can map outcomes to HTTP and judge the catch-up award's result.
// A change to one side must be made on the other.
//
// No Deno or Supabase imports: the vitest suite imports this file directly.

export type OrderKind = "layaway" | "cash";

/** R5 — statuses in which an order can no longer change owner. */
export const CLOSED_STATUSES: Record<OrderKind, readonly string[]> = {
  layaway: ["cancelled", "forfeited", "final_forfeited"],
  cash: ["cancelled", "expired"],
};

export function isClosedStatus(kind: OrderKind, status: string): boolean {
  return CLOSED_STATUSES[kind].includes(status);
}

export interface LoyaltyHistory {
  total_points_earned?: number | null;
  cumulative_spend_jpy?: number | null;
  spend_baseline_jpy?: number | null;
}

/** R1 — an account "has points" when it carries ANY loyalty history. */
export function hasLoyaltyHistory(member: LoyaltyHistory | null | undefined): boolean {
  if (!member) return false;
  return Number(member.total_points_earned ?? 0) > 0 ||
    Number(member.cumulative_spend_jpy ?? 0) > 0 ||
    Number(member.spend_baseline_jpy ?? 0) > 0;
}

/** R1 — the FIRST loyalty check. null = allowed. */
export function priorityRefusal(
  current: LoyaltyHistory | null | undefined,
  target: LoyaltyHistory | null | undefined,
): "both_have_points" | "points_account_is_current_owner" | null {
  const c = hasLoyaltyHistory(current);
  const t = hasLoyaltyHistory(target);
  if (c && t) return "both_have_points";
  if (c) return "points_account_is_current_owner";
  return null;
}

export interface PaymentRow {
  created_at: string;
  reference_number?: string | null;
  remarks?: string | null;
  voided_at?: string | null;
  amount_paid?: number | null;
  id?: string;
}

/** The DP rule used for the layaway award point. LOYALTY-% rows are loyalty
 *  redemptions dressed as a downpayment and are never the award point. */
export function isDownpaymentPayment(p: PaymentRow): boolean {
  if (p.voided_at) return false;
  const ref = p.reference_number ?? "";
  if (ref.startsWith("LOYALTY-")) return false;
  return ref.startsWith("DP-") || /down/i.test(p.remarks ?? "");
}

const earliest = (xs: string[]): string | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a));

export interface AwardPoint {
  at: string | null;
  source: "downpayment_payment" | "downpayment_submission" | "completed_at" | "fully_paid_payment" | null;
}

/** R6 — layaway: earliest non-voided DP payment's created_at; fallback the
 *  confirmed DP submission's updated_at. Never date_paid. */
export function layawayAwardPoint(
  payments: PaymentRow[],
  confirmedDpSubmissionUpdatedAt: string[],
): AwardPoint {
  const dp = earliest(payments.filter(isDownpaymentPayment).map((p) => p.created_at));
  if (dp) return { at: dp, source: "downpayment_payment" };
  const sub = earliest(confirmedDpSubmissionUpdatedAt);
  if (sub) return { at: sub, source: "downpayment_submission" };
  return { at: null, source: null };
}

/** R6 — cash: completed_at; fallback the created_at of the payment that made
 *  it fully paid. An order that is not completed has not reached its award
 *  point (it will earn normally when it completes). */
export function cashAwardPoint(order: {
  status: string;
  completed_at: string | null;
  total_amount: number;
}, payments: PaymentRow[]): AwardPoint {
  if (order.status !== "completed") return { at: null, source: null };
  if (order.completed_at) return { at: order.completed_at, source: "completed_at" };
  const live = payments
    .filter((p) => !p.voided_at)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || String(a.id ?? "").localeCompare(String(b.id ?? "")));
  let running = 0;
  for (const p of live) {
    running += Number(p.amount_paid ?? 0);
    if (running >= order.total_amount) return { at: p.created_at, source: "fully_paid_payment" };
  }
  return { at: null, source: null };
}

export const DEFAULT_GRACE_DAYS = 3;

/** R6 — the award point may be up to graceDays BEFORE enrolment. */
export function withinGrace(awardAt: string, enrolledAt: string, graceDays = DEFAULT_GRACE_DAYS): boolean {
  return Date.parse(awardAt) >= Date.parse(enrolledAt) - graceDays * 86_400_000;
}

export type CatchUpReason = "eligible" | "not_enrolled" | "not_at_award_point" | "paid_before_enrollment";

export function catchUpDecision(args: {
  enrolledAt: string | null; // null = not a loyalty member
  awardAt: string | null;
  graceDays?: number;
}): CatchUpReason {
  if (!args.enrolledAt) return "not_enrolled";
  if (!args.awardAt) return "not_at_award_point";
  if (!withinGrace(args.awardAt, args.enrolledAt, args.graceDays)) return "paid_before_enrollment";
  return "eligible";
}

/** Today's date in PHT, YYYY-MM-DD. */
export function phtToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(now);
}

/** R7 — the catch-up lot expires order_date + 180 days. */
export function lotExpiresOn(orderDate: string): string {
  const d = new Date(`${orderDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 180);
  return d.toISOString().slice(0, 10);
}

/** R7 — points are born expired when order_date + 180 days is already past
 *  (PHT day boundary — the same test insert_lot_catch_up makes). */
export function expiredOnAward(orderDate: string, now: Date = new Date()): boolean {
  return lotExpiresOn(orderDate) <= phtToday(now);
}

/** R7 — last_purchase_at = GREATEST(existing, order_date); prev_purchase_at
 *  shifts only when last_purchase_at actually changes. Returns the member
 *  fields to write, or {} when nothing changes. */
export function catchUpPurchaseDates(
  existingLast: string | null,
  orderDate: string,
): { last_purchase_at?: string; prev_purchase_at?: string | null } {
  const orderTs = new Date(`${orderDate}T00:00:00+08:00`);
  if (existingLast && Date.parse(existingLast) >= orderTs.getTime()) return {};
  return { last_purchase_at: orderTs.toISOString(), prev_purchase_at: existingLast };
}

/** Refusal codes that are a 409 (the order cannot move as asked). */
export const REFUSAL_CODES = [
  "same_owner",
  "status_closed",
  "test_boundary",
  "both_have_points",
  "points_account_is_current_owner",
  "already_earned",
  "shopify_order",
  "split_submission",
  "loyalty_redemption",
  "store_credit",
  "loyalty_amount_required",
  "loyalty_permission_required",
] as const;

export function httpStatusFor(code: string): number {
  if (code === "not_found") return 404;
  if (code === "forbidden") return 403;
  if ((REFUSAL_CODES as readonly string[]).includes(code)) return 409;
  return 400;
}

/** Skips from award-loyalty-points that are an expected outcome of a valid
 *  catch-up, not a failure: the order is under the ¥10,000 earning minimum,
 *  or loyalty is switched off program-wide. Anything else that is not
 *  `awarded: true` is a failure (R9 → staff bell). */
export const BENIGN_AWARD_SKIPS = ["below_minimum", "loyalty_disabled"] as const;

export function classifyAwardResult(
  httpOk: boolean,
  body: { awarded?: boolean; skipped?: boolean; reason?: string; error?: string } | null,
): "awarded" | "benign_skip" | "failed" {
  if (!httpOk || !body || body.error) return "failed";
  if (body.awarded === true) return "awarded";
  if (body.skipped && (BENIGN_AWARD_SKIPS as readonly string[]).includes(body.reason ?? "")) return "benign_skip";
  return "failed";
}
