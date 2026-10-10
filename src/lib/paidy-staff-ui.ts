/**
 * Pure helpers for the staff Paidy UI (Paidy QC PR-B, 2026-10-10). Kept free
 * of React and Supabase so the decisions are unit-tested on their own
 * (src/test/paidy-staff-ui.test.ts).
 */

/**
 * M1: a refusal is a PERMISSION refusal only when the server says so — HTTP
 * 403, or a coded `error` field. Never a substring of the message: a Paidy
 * read failure (502 paidy_unverified) can quote Paidy's own
 * "service.forbidden" code in its message, and that is not the reviewer's
 * permission.
 */
export const PERMISSION_ERROR_CODES: ReadonlySet<string> = new Set([
  'forbidden',
  'permission_denied',
  'insufficient_permission',
  'insufficient_permissions',
  'missing_permission',
  'not_authorized',
  'forbidden_admin_only',
]);

export function isPermissionRefusal(status: number | undefined | null, code: string | undefined | null): boolean {
  if (status === 403) return true;
  if (status != null && status >= 500) return false;
  return !!code && PERMISSION_ERROR_CODES.has(code.trim().toLowerCase());
}

/**
 * M2: an ORPHAN capture case — Paidy captured the money, and the Hub has no
 * paidy_payments row for it (paidy_payment_row NULL). resolve_paidy_case
 * cannot record it (it reads the row), so it is never offered "Record this
 * capture"; an admin records it through paidy-staff-action
 * record_orphan_capture instead.
 */
export const CAPTURE_CASE_KINDS: ReadonlySet<string> = new Set(['captured_unrecorded', 'captured_no_submission', 'record_failed']);

export function isOrphanCaptureCase(c: { kind: string; paidy_payment_row: string | null }): boolean {
  return CAPTURE_CASE_KINDS.has(c.kind) && !c.paidy_payment_row;
}

/** Plain-English lines for every record_orphan_capture refusal code. */
export const ORPHAN_RECORD_ERRORS: Record<string, string> = {
  forbidden_admin_only: 'Only an admin can record a Paidy payment the Hub has no record of.',
  reason_required: 'Write a reason (at least 10 characters).',
  case_not_found: 'This case no longer exists. Reload the page.',
  case_not_orphan: 'The Hub already has a record of this Paidy payment — use Resolve instead.',
  case_not_open: 'This case is already closed. Reload the page.',
  order_missing: 'The case is not linked to an order, so the payment cannot be recorded here.',
  order_cannot_take_payment: 'The order can no longer take a payment (it is closed, cancelled or already paid).',
  amount_differs_from_balance: "Paidy's amount is not the order's balance, so the Hub will not record it. Check the Paidy dashboard.",
  order_part_paid: 'The order already has part of its money recorded, so a Paidy payment for the whole order cannot be recorded.',
  not_yen: 'The order is not in yen; a Paidy payment can only be recorded on a yen order.',
  paidy_not_captured: 'Paidy reports that this payment is not captured, so there is nothing to record.',
  paidy_refunded: 'Paidy shows a refund on this payment, so it cannot be recorded as paid.',
  paidy_order_mismatch: 'Paidy says this payment belongs to a different order.',
  paidy_environment_mismatch: "This Paidy payment belongs to the other Paidy environment (test vs live) than the Hub's current key.",
  paidy_unavailable: 'The Hub could not reach Paidy to check the payment. Nothing was recorded — try again in a few minutes.',
  payment_in_progress: 'Another payment on this order is being processed. Wait for it to finish, then try again.',
  already_recorded: 'This Paidy payment is already recorded.',
  paidy_not_tied_to_order: 'This order never opened Paidy for this payment, so the Hub will not record it here. Refund it in the Paidy dashboard and check with the customer.',
  paidy_capture_mismatch: "Paidy's capture does not equal the whole payment in yen, so it was not recorded.",
};

export function orphanRecordErrorText(code: string, message?: string | null): string {
  if (message && message.trim()) return message.trim();
  return ORPHAN_RECORD_ERRORS[code] ?? `Could not record the payment (${code || 'unknown error'}).`;
}

/** Success line for record_orphan_capture. */
export function orphanRecordSuccessText(outcome: string | undefined): string {
  return outcome === 'recorded'
    ? 'Paidy payment recorded — the order is completed.'
    : 'Filed — the Hub records it within the hour (or press Confirm in Payment Submissions).';
}

/**
 * M3: the order's SERVER payment lock (cash_order_payment_lock_for_staff),
 * mapped to what the cash order page shows. `paidyHold` hides Confirm
 * transfer received / Submit Payment / Change payment method and the
 * "hourly job will cancel this order" warning. 'paidy_checkout_open' keeps
 * the page's existing open-window UI, so it is not a hold here.
 */
export type PaidyLockView =
  | { paidyHold: false }
  | { paidyHold: true; kind: 'submission_pending' | 'captured_unrecorded' | 'authorized' | 'other'; line: string };

export const PAIDY_LOCK_LINES = {
  submission_pending:
    'Paidy authorised — awaiting your Confirm in Payment Submissions. If a Confirm started but has not finished, open Payments Hub and press Finish recording.',
  captured_unrecorded:
    'Paidy took this payment but the Hub has not recorded it — see Payment Submissions → Paidy cases.',
  authorized:
    'Paidy holds an approval for this order that has no submission yet — the hourly Paidy check files or releases it.',
  other: 'A Paidy payment on this order is being processed. No other payment can be taken until it is settled.',
} as const;

export function paidyLockView(lock: string | null | undefined): PaidyLockView {
  if (!lock || !lock.startsWith('paidy') || lock === 'paidy_checkout_open') return { paidyHold: false };
  if (lock === 'paidy_submission_pending') return { paidyHold: true, kind: 'submission_pending', line: PAIDY_LOCK_LINES.submission_pending };
  if (lock === 'paidy_captured_unrecorded') return { paidyHold: true, kind: 'captured_unrecorded', line: PAIDY_LOCK_LINES.captured_unrecorded };
  if (lock === 'paidy_authorized') return { paidyHold: true, kind: 'authorized', line: PAIDY_LOCK_LINES.authorized };
  return { paidyHold: true, kind: 'other', line: PAIDY_LOCK_LINES.other };
}

/**
 * L5: "Finish recording" appears only once the Confirm's claim
 * (processing_started_at) is older than the 5-minute lease — before that a
 * Confirm may still be running. No stamp at all (an old row) counts as old.
 */
export const FINISH_RECORDING_LEASE_MS = 5 * 60 * 1000;

export function claimLeaseExpired(processingStartedAt: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!processingStartedAt) return true;
  const t = Date.parse(processingStartedAt);
  if (Number.isNaN(t)) return true;
  return nowMs - t >= FINISH_RECORDING_LEASE_MS;
}
