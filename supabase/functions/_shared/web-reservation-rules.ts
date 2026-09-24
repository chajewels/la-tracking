/**
 * Reserve-first (A2, 2026-09-24): pure rules for web reservations.
 *
 * Kept free of Deno globals and of the Supabase client so the SAME file the
 * edge functions run is imported by vitest (src/test/web-reservations.test.ts),
 * the way _shared/web-order-rules.ts is. Twin file for the Hub:
 * src/lib/web-reservations.ts — the test asserts the two agree.
 *
 * WHAT A RESERVATION IS. A WEB order or plan whose ready_confirmed_at is NULL
 * (docs/RESERVE-FIRST.md). Hub-created rows also carry NULL there — A1 only
 * stamps web rows — so every predicate here checks the channel first. Getting
 * that wrong would block payment on every Hub layaway in the portal.
 */

export type ReservationKind = "cash_order" | "layaway";

export interface ReservationRow {
  source_channel?: string | null;
  ready_confirmed_at?: string | null;
  status?: string | null;
  /** cash_orders only */
  payment_status?: string | null;
}

/** The statuses A1's queue indexes and the 72-hour sweep treat as a live reservation. */
export const RESERVATION_LIVE_STATUS: Record<ReservationKind, string> = {
  cash_order: "pending",
  layaway: "active",
};

/** A layaway is payable in any of these once confirmed (same set as POST /layaway/:id/pay). */
export const LAYAWAY_PAYABLE_STATUSES = ["active", "overdue", "extension_active", "reactivated"] as const;

/** Hours after creation at which an unconfirmed reservation is auto-cancelled. */
export const RESERVATION_AUTO_CANCEL_HOURS = 72;
/** Hours after creation at which sales@ is reminded, once. */
export const RESERVATION_REMIND_HOURS = 24;

/** The one refusal code every payment path returns on an unconfirmed reservation. */
export const NOT_READY_FOR_PAYMENT = "not_ready_for_payment";

/**
 * Web and never confirmed — whatever its status. This is the PAYMENT guard:
 * money must never be taken against a piece staff have not confirmed, and a
 * cancelled reservation is refused by the callers' own status checks anyway.
 */
export function isUnconfirmedReservation(row: ReservationRow | null | undefined): boolean {
  if (!row) return false;
  return row.source_channel === "web" && (row.ready_confirmed_at === null || row.ready_confirmed_at === undefined);
}

/** Unconfirmed AND still live — what staff must act on, and what the storefront calls "awaiting confirmation". */
export function isAwaitingConfirmation(row: ReservationRow | null | undefined, kind: ReservationKind): boolean {
  return isUnconfirmedReservation(row) && String(row?.status ?? "") === RESERVATION_LIVE_STATUS[kind];
}

/**
 * Can the customer pay this now? Cash: pending with the transfer outstanding.
 * Layaway: a payable status. Either way, never before confirmation.
 */
export function isReadyForPayment(row: ReservationRow | null | undefined, kind: ReservationKind): boolean {
  if (!row || isUnconfirmedReservation(row)) return false;
  const status = String(row.status ?? "");
  if (kind === "cash_order") return status === "pending" && row.payment_status === "pending_transfer";
  return (LAYAWAY_PAYABLE_STATUSES as readonly string[]).includes(status);
}

/** The two flags the website API adds to an order or plan. */
export function reservationFlags(row: ReservationRow | null | undefined, kind: ReservationKind) {
  return {
    awaiting_confirmation: isAwaitingConfirmation(row, kind),
    ready_for_payment: isReadyForPayment(row, kind),
  };
}

/**
 * system_settings.web_reservation_mode, read FAIL-CLOSED to today's flow: only
 * a JSON true (or the string "true", the way php_jpy_rate is stored as a
 * string) switches reservations on. Anything else — absent, null, false, a
 * typo — is off, so a broken setting can never start taking reservations.
 */
export function readReservationMode(value: unknown): boolean {
  return value === true || value === "true";
}

/** Whole hours since creation, floored; 0 for a bad or future timestamp. */
export function reservationAgeHours(createdAt: string | null | undefined, now: Date = new Date()): number {
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 3_600_000));
}

/** When the 72-hour sweep will cancel it (ISO), or null for a bad timestamp. */
export function reservationAutoCancelAt(createdAt: string | null | undefined): string | null {
  const t = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t + RESERVATION_AUTO_CANCEL_HOURS * 3_600_000).toISOString();
}

/** Owed the one sales@ reminder: 24 hours old, never chased. */
export function isDueForReminder(
  row: { created_at?: string | null; reservation_reminded_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (row.reservation_reminded_at) return false;
  return reservationAgeHours(row.created_at, now) >= RESERVATION_REMIND_HOURS;
}

/**
 * HTTP status for a confirm_web_order_ready_atomic / decline refusal.
 * 404 for what is not there, 403/401 for who is asking, 409 for a state the
 * order is no longer in, 400 otherwise.
 */
export function reservationRefusalStatus(error: string): number {
  if (error === "not_found") return 404;
  if (error === "permission_denied") return 403;
  if (error === "user_identity_required") return 401;
  if ([
    "already_confirmed", "not_live", "already_paid", "payment_exists", "schedule_not_pristine",
    "not_web_order", "not_web_layaway", "submission_pending", "already_terminal", "not_pending_or_paid",
  ].includes(error)) return 409;
  return 400;
}

/**
 * The deadline wording staff see before confirming: 24 hours for a first
 * order, 72 for a returning customer. Hours come from the server
 * (web_deposit_deadline_hours) — never guessed here.
 */
export function deadlineHoursLabel(hours: number | null | undefined): string {
  if (!Number.isFinite(Number(hours)) || Number(hours) <= 0) return "the standard deadline";
  const h = Math.round(Number(hours));
  return `${h} hours${h === 24 ? " (first order)" : h === 72 ? " (returning customer)" : ""}`;
}

/**
 * The plan-type label on a reservation: "Full payment" or "Layaway". It names
 * how the customer will pay, never whether they have — a reservation has no
 * money on it by definition, and "Paid in full" read as paid (owner acceptance
 * run, 2026-09-24).
 */
export function reservationKindLabel(kind: ReservationKind): string {
  return kind === "layaway" ? "Layaway" : "Full payment";
}

/**
 * STAFF PAYMENT GUARD (2026-09-24, owner acceptance run finding 4). The Hub
 * hides "Record payment" on a reservation, but hiding a button is not a rule:
 * record-payment, record-multi-payment and the confirm branch of
 * review-payment-submission must refuse on the server too. Each passes the
 * order rows it has already read; the first unconfirmed reservation among
 * them, or null. Hub rows are never matched (the channel is checked first).
 */
export function firstUnconfirmedReservation<T extends ReservationRow>(
  rows: ReadonlyArray<T | null | undefined> | null | undefined,
): T | null {
  for (const r of rows ?? []) if (r && isUnconfirmedReservation(r)) return r;
  return null;
}

/** The 409 body every staff payment path returns — one code, one wording. */
export function staffNotReadyForPaymentBody(
  row: { invoice_number?: string | null; web_reference?: string | null } | null | undefined,
) {
  const ref = row?.web_reference || row?.invoice_number || null;
  return {
    error: NOT_READY_FOR_PAYMENT,
    reference: ref,
    message: `${ref ? `${ref} is` : "This web order is"} still a reservation. Confirm the piece before recording a payment.`,
  };
}
