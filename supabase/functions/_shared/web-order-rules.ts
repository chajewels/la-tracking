/**
 * Pure decision rules for the web-order lifecycle fixes of 2026-09-23.
 *
 * Kept free of Deno globals and of the Supabase client so the SAME file the
 * edge functions run is imported by vitest (src/test/web-order-gaps.test.ts),
 * the way _shared/payment-validation.ts is.
 */

/**
 * INVARIANT 12 — a payment_submissions row in one of these statuses freezes
 * every AUTOMATED status change on its account or order. The money may already
 * be in the bank; only the reviewer knows. Staff acting deliberately are never
 * blocked by it.
 */
export const FREEZING_SUBMISSION_STATUSES = ["submitted", "under_review"] as const;

export function isFreezingSubmissionStatus(status: string | null | undefined): boolean {
  return (FREEZING_SUBMISSION_STATUSES as readonly string[]).includes(String(status ?? ""));
}

/**
 * Split the expiry candidates into the ones the sweep may expire this run and
 * the ones INVARIANT 12 freezes.
 *
 * Order is preserved (the caller selects oldest deadline first). Frozen orders
 * are reported every run and never counted against `max`, so a handful of
 * frozen orders sitting at the head of the queue can never starve the orders
 * behind them — which is what a plain `.limit(max)` followed by a skip would do.
 */
export function partitionExpiryCandidates<T extends { id: string }>(
  orders: readonly T[],
  frozenIds: ReadonlySet<string>,
  max: number,
): { expire: T[]; frozen: T[] } {
  const expire: T[] = [];
  const frozen: T[] = [];
  for (const o of orders) {
    if (frozenIds.has(o.id)) frozen.push(o);
    else if (expire.length < max) expire.push(o);
  }
  return { expire, frozen };
}

/**
 * HTTP status for a revive_web_cash_order_atomic refusal. 404 for the order we
 * cannot find; 409 for the states that are a conflict with the world (the piece
 * is gone, or the order is not in a state revival applies to); 400 otherwise.
 * Same shape as reactivate-web-layaway.
 */
export function reviveRefusalStatus(error: string): number {
  if (error === "not_web_order") return 404;
  if (["out_of_stock", "not_expired", "already_paid", "payment_exists"].includes(error)) return 409;
  return 400;
}

/**
 * Which email a staff forfeit sends. A web plan's customer has only ever dealt
 * with the storefront, so it gets the storefront email (Cha Jewels brand,
 * customer's language, Reply-To sales@) — the same split auto-expire-cash-orders
 * makes between order-expired and the Hub's cash-order-expired. Every other plan
 * keeps the Hub's account-forfeited template, unchanged.
 */
export function forfeitEmailKind(sourceChannel: string | null | undefined): "storefront" | "hub" {
  return sourceChannel === "web" ? "storefront" : "hub";
}
