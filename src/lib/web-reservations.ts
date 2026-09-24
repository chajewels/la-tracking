/**
 * Reserve-first (A2, 2026-09-24): the Hub's reservation rules.
 *
 * TWIN FILE of supabase/functions/_shared/web-reservation-rules.ts (the edge
 * functions' copy). src/test/web-reservations.test.ts runs both over the same
 * inputs and fails if they disagree — change one, change the other.
 *
 * A reservation is a WEB order or plan whose ready_confirmed_at is NULL. Hub
 * rows also carry NULL there (A1 only stamps web rows), so the channel is
 * checked first: without it every Hub plan would read as "awaiting".
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

export function deadlineHoursLabel(hours: number | null | undefined): string {
  if (!Number.isFinite(Number(hours)) || Number(hours) <= 0) return 'the standard deadline';
  const h = Math.round(Number(hours));
  return `${h} hours${h === 24 ? ' (first order)' : h === 72 ? ' (returning customer)' : ''}`;
}

/** "5h", "1d 3h" — how long a reservation has been waiting. */
export function formatReservationAge(createdAt: string | null | undefined, now: Date = new Date()): string {
  const h = reservationAgeHours(createdAt, now);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest ? `${d}d ${rest}h` : `${d}d`;
}

/** Staff-facing words for a refusal from confirm-web-order-ready / decline-web-reservation. */
export function reservationRefusalMessage(code: string, detail?: { status?: string | null }): string {
  switch (code) {
    case 'already_confirmed': return 'Already confirmed — someone got there first. The customer has the payment details.';
    case 'not_live': return `This order is ${detail?.status ?? 'no longer live'} — there is nothing to confirm or decline.`;
    case 'already_paid':
    case 'payment_exists': return 'Money has already been recorded on this plan, so the reservation cannot be changed here.';
    case 'schedule_not_pristine': return 'The payment schedule has already been changed, so it cannot be re-dated. Ask an admin.';
    case 'permission_denied': return 'You do not have permission to confirm or decline web reservations.';
    case 'reason_required': return 'A reason is required — the customer is told why.';
    case 'not_found': return 'Order not found.';
    case 'not_web_order':
    case 'not_web_layaway': return 'This is not a website reservation.';
    case 'already_terminal': return 'This order is already closed.';
    default: return code || 'Something went wrong';
  }
}
