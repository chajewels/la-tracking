/**
 * Website orders PR 5 — the park area's rules (docs/WEB-ORDER-DRAFTS.md "PR 5").
 *
 * A website order lives in Sales → Website orders until its first real payment
 * (web_released_at, stamped by the triggers of PR 3). Only then does it appear
 * in the Cash / Layaway lists (R7). An order that is never paid is never a sale:
 * it stays in the park area's Closed tab and never reaches those lists (W2-2).
 *
 * Pure functions only, so the lists, the park area, the customer page and the
 * tests all read the same rule.
 */

export type ParkKind = 'cash_order' | 'layaway';

export interface ParkRow {
  source_channel?: string | null;
  web_released_at?: string | null;
  ready_confirmed_at?: string | null;
  status?: string | null;
}

/** Closed statuses — an unpaid web order in one of these is listed under Closed. */
export const PARK_CLOSED_STATUSES: Record<ParkKind, readonly string[]> = {
  cash_order: ['cancelled', 'expired'],
  layaway: ['cancelled', 'forfeited', 'final_forfeited'],
};

/**
 * A web order with no real payment yet. It belongs to the park area, not to the
 * Cash / Layaway lists. A 'completed' order is never parked: it can only be
 * completed with money on it (a points-only payment is the one theoretical
 * exception, and hiding a completed order would be worse than showing it).
 */
export function isParkedWebOrder(row: ParkRow | null | undefined): boolean {
  if (!row || row.source_channel !== 'web') return false;
  if (row.web_released_at) return false;
  return String(row.status ?? '') !== 'completed';
}

/** Shown in the Cash / Layaway lists: every Hub order, and web orders once released. */
export function showInSalesLists(row: ParkRow | null | undefined): boolean {
  return !isParkedWebOrder(row);
}

/**
 * "Awaiting payment": confirmed by staff, no payment yet, still live. An
 * unconfirmed one (old reserve-first flow) is under To confirm instead.
 */
export function isAwaitingPayment(row: ParkRow | null | undefined, kind: ParkKind): boolean {
  if (!isParkedWebOrder(row)) return false;
  if (!row?.ready_confirmed_at) return false;
  return !PARK_CLOSED_STATUSES[kind].includes(String(row.status ?? ''));
}

/** Parked and closed: cancelled / expired / forfeited without ever being paid. */
export function isClosedUnpaid(row: ParkRow | null | undefined, kind: ParkKind): boolean {
  return isParkedWebOrder(row) && PARK_CLOSED_STATUSES[kind].includes(String(row?.status ?? ''));
}

/** The badge on the customer page and the Awaiting payment rows (W2-8). */
export const AWAITING_PAYMENT_BADGE = 'Website — awaiting payment';

/** Drafts auto-cancel 72 hours after checkout (expire_web_drafts_atomic default). */
export const DRAFT_AUTO_CANCEL_HOURS = 72;

export interface DraftSummaryFields {
  mode: 'full' | 'layaway';
  term_months: number | null;
}

/** "Full payment" / "Layaway · 6 months" — how the customer will pay, never whether they have. */
export function draftKindLabel(d: DraftSummaryFields): string {
  if (d.mode === 'layaway') return d.term_months ? `Layaway · ${d.term_months} months` : 'Layaway';
  return 'Full payment';
}

/** Why a draft is closed, in staff words. */
export function draftClosedLabel(status: string, reason?: string | null): string {
  if (status === 'declined') return reason ? `Can't supply: ${reason}` : "Can't supply";
  if (status === 'expired') return 'Not confirmed within 72 hours — cancelled automatically';
  if (status === 'confirmed') return 'Confirmed';
  return status;
}

/** Hours left before a deadline; negative once passed. NaN-safe (null → null). */
export function hoursUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - now.getTime()) / 3_600_000);
}

/** "in 5h", "in 1d 3h", "passed 2h ago". */
export function formatCountdown(iso: string | null | undefined, now: Date = new Date()): string {
  const h = hoursUntil(iso, now);
  if (h === null) return 'no deadline';
  const abs = Math.abs(h);
  const d = Math.floor(abs / 24);
  const rest = abs % 24;
  const span = d > 0 ? (rest ? `${d}d ${rest}h` : `${d}d`) : `${abs}h`;
  return h >= 0 ? `in ${span}` : `passed ${span} ago`;
}
