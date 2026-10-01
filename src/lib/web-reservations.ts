/**
 * Reserve-first (A2, 2026-09-24): the Hub's reservation rules.
 *
 * TWIN FILE of supabase/functions/_shared/web-reservation-rules.ts (the edge
 * functions' copy). src/test/web-reservations.test.tsx runs both over the same
 * inputs and fails if they disagree — change one, change the other.
 *
 * A reservation is a WEB order or plan whose ready_confirmed_at is NULL. Hub
 * rows also carry NULL there (A1 only stamps web rows), so the channel is
 * checked first: without it every Hub plan would read as "awaiting".
 *
 * The reserve-first checkout itself was retired by website orders PR 10
 * (2026-10-01): every website checkout is now a draft confirmed by staff, and
 * the Confirm / Can't supply UI for reservations is gone. What remains here is
 * read-only: isAwaitingConfirmation (list pills, payment gating on the detail
 * pages) and the age helpers the draft park reuses. The confirm/decline
 * refusal wording and the deadline label left with that UI.
 */

export type ReservationKind = 'cash_order' | 'layaway';

export interface ReservationRow {
  source_channel?: string | null;
  ready_confirmed_at?: string | null;
  status?: string | null;
  payment_status?: string | null;
}

export const RESERVATION_LIVE_STATUS: Record<ReservationKind, string> = {
  cash_order: 'pending',
  layaway: 'active',
};

export const RESERVATION_AUTO_CANCEL_HOURS = 72;
export const RESERVATION_REMIND_HOURS = 24;

export function isUnconfirmedReservation(row: ReservationRow | null | undefined): boolean {
  if (!row) return false;
  return row.source_channel === 'web' && (row.ready_confirmed_at === null || row.ready_confirmed_at === undefined);
}

/** Unconfirmed and still live — the rows staff must confirm or decline. */
export function isAwaitingConfirmation(row: ReservationRow | null | undefined, kind: ReservationKind): boolean {
  return isUnconfirmedReservation(row) && String(row?.status ?? '') === RESERVATION_LIVE_STATUS[kind];
}

export function reservationAgeHours(createdAt: string | null | undefined, now: Date = new Date()): number {
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 3_600_000));
}

export function reservationAutoCancelAt(createdAt: string | null | undefined): string | null {
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t + RESERVATION_AUTO_CANCEL_HOURS * 3_600_000).toISOString();
}

/**
 * The plan-type label on a reservation: "Full payment" or "Layaway". It names
 * how the customer will pay, never whether they have — a reservation has no
 * money on it by definition, and "Paid in full" read as paid (owner acceptance
 * run, 2026-09-24).
 */
export function reservationKindLabel(kind: ReservationKind): string {
  return kind === 'layaway' ? 'Layaway' : 'Full payment';
}

/** "5h", "1d 3h" — how long a reservation has been waiting. */
export function formatReservationAge(createdAt: string | null | undefined, now: Date = new Date()): string {
  const h = reservationAgeHours(createdAt, now);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest ? `${d}d ${rest}h` : `${d}d`;
}
