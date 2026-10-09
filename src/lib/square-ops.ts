/**
 * Card payments (Square) — operator panel helpers (Square integrity, 2026-10-04,
 * docs/SQUARE-INTEGRITY.md "Hub UI"). Pure functions only, so the panel's
 * wording, totals, CSV and warning thresholds are pinned by
 * src/test/square-ops.test.ts without a DOM or a database.
 *
 * The panel never computes money the database did not: every yen figure in the
 * settlement report comes from square_settlement_report; the totals row here is
 * only the column sums of those rows.
 */
import { toCsv } from '@/lib/csv';

/** square_payments.exception (migration 20261104100000) → plain words for staff. */
export const SQUARE_EXCEPTION_LABEL: Record<string, string> = {
  captured_after_close: 'Square captured after the Hub had closed it',
  captured_unallocated: 'Captured but the order could not take it',
  amount_mismatch: 'Amount does not match the submission',
  unfiled_hold: 'Hold the order could not take',
  // QC15: the risk finding only — whether the hold was voided is the
  // payment's own state (squarePaymentStateLabel), never assumed here.
  risk_high: 'Square risk HIGH',
  void_unconfirmed: 'Hub closed it but Square still holds it',
  refunded_before_record: 'Square refunded (or is refunding) it before the Hub recorded it',
};

/** What Square says the money is doing now — shown beside every exception (QC15). */
export function squarePaymentStateLabel(status: string | null | undefined): string {
  switch ((status ?? '').toLowerCase()) {
    case 'authorized': return 'Still held on the card';
    case 'captured': return 'Captured — money taken';
    case 'voided': return 'Voided — hold released';
    case 'expired': return 'Expired — hold released';
    case 'failed':
    case 'rejected': return 'Closed — nothing charged';
    default: return status ? status : 'Unknown';
  }
}

/** Exception label; a capture with no exception code is "captured, not recorded". */
export function squareExceptionLabel(code: string | null | undefined): string {
  if (!code) return 'Captured, not recorded yet';
  return SQUARE_EXCEPTION_LABEL[code] ?? code.replace(/_/g, ' ');
}

/** decide_square_case decisions per kind — the exact values the function accepts. */
export type SquareCaseKind = 'exception' | 'refund' | 'dispute';
export const SQUARE_DECISIONS: Record<SquareCaseKind, { value: string; label: string }[]> = {
  // QC02: a decision is recorded; only evidence resolves it (the capture
  // recorded on the ledger, a completed full refund, Square showing the hold
  // closed). "Note only" never releases the order.
  exception: [
    { value: 'record_on_order', label: 'Record the captured money on this order' },
    { value: 'record_net_after_refund', label: 'Record the net after a completed partial refund' },
    { value: 'refunded_in_square', label: 'Refunded in full in the Square Dashboard' },
    { value: 'voided_in_square', label: 'Voided in the Square Dashboard' },
    { value: 'other', label: 'Note only (does not resolve it)' },
  ],
  refund: [
    { value: 'order_cancelled_refunded', label: 'Order cancelled, refunded' },
    { value: 'partial_refund_order_kept', label: 'Partial refund, order kept' },
    { value: 'refund_failed_followed_up', label: 'Refund failed, followed up' },
    { value: 'other', label: 'Other (explain in the note)' },
  ],
  dispute: [
    { value: 'evidence_submitted', label: 'Evidence submitted' },
    { value: 'accepted', label: 'Accepted (not contested)' },
    { value: 'won', label: 'Won' },
    { value: 'lost', label: 'Lost' },
    { value: 'other', label: 'Other (explain in the note)' },
  ],
};

/** The note is required for an exception decision (it is the audit of what was done with the money); optional otherwise. */
export function squareNoteRequired(kind: SquareCaseKind): boolean {
  return kind === 'exception';
}

/** decide_square_case refusal codes → plain words. */
export function squareDecisionRefusal(code: string): string {
  switch (code) {
    case 'decision_required': return 'Choose a decision.';
    case 'bad_decision': return 'That decision is not allowed for this case.';
    case 'note_required': return 'A note is required: say what was done with the money.';
    case 'not_permitted': return 'Only an admin or finance can decide a card exception.';
    case 'refund_not_verified': return 'Square does not show a completed refund covering this capture (or a refund is still pending). The decision is noted; the case stays open until Square shows the refund.';
    case 'void_not_verified': return 'Square does not show this hold as voided (captured money cannot be voided — refund it instead). The decision is noted; the case stays open.';
    case 'square_refunded': return 'Square shows a refund on this capture, so it cannot be recorded in full. Use "Record the net after a completed partial refund", or "Refunded in full".';
    case 'refund_pending': return 'A refund on this capture is still pending in Square. Wait until it completes or fails.';
    case 'no_refund': return 'Square shows no completed refund on this capture — use "Record the captured money on this order".';
    case 'fully_refunded': return 'The capture is refunded in full — choose "Refunded in full in the Square Dashboard".';
    case 'already_recorded': return 'This capture is already recorded on the order.';
    case 'not_captured': return 'Square does not show this payment as captured.';
    case 'order_closed': return 'The order is cancelled or expired, so it cannot take this money — refund it in the Square Dashboard.';
    case 'card_disputed': return 'A chargeback holds or took back money on this order, so the capture cannot be booked as paid. Contest the dispute in the Square Dashboard; record it only once Square shows the dispute won.';
    case 'exceeds_remaining': return 'The order no longer owes this much. Refund the excess in the Square Dashboard, then choose "Record the net after a completed partial refund".';
    case 'state_mismatch': return 'That decision does not match what Square reports for this case yet.';
    case 'not_found': return 'The case was not found, or it is already resolved. Refresh the panel.';
    case 'bad_kind': return 'Unknown case type.';
    case 'not_staff': return 'Only staff can record a decision.';
    default: return code;
  }
}

const DAY_MS = 86_400_000;

/**
 * Warning predicate for a deadline (Square's capture_by, a dispute's evidence
 * due date): true when the deadline is less than `days` days away — or already
 * past. No deadline → no warning.
 */
export function isDeadlineSoon(deadline: string | null | undefined, now: Date, days: number): boolean {
  if (!deadline) return false;
  const t = new Date(deadline).getTime();
  if (Number.isNaN(t)) return false;
  return t - now.getTime() < days * DAY_MS;
}

/** Hold deadline warning: under 2 days to Square's capture_by. */
export const HOLD_WARNING_DAYS = 2;
/** Dispute evidence warning: under 3 days to due_at. */
export const DISPUTE_WARNING_DAYS = 3;

/** A Square refund that did not pay the customer back. */
export function refundNotPaidBack(status: string | null | undefined): boolean {
  const s = (status ?? '').toUpperCase();
  return s === 'FAILED' || s === 'REJECTED';
}

/** Finished dispute states (Square). INQUIRY_CLOSED = "the inquiry is complete" (HUB-2, 2026-10-05). */
export const DISPUTE_CLOSED_STATES = ['WON', 'LOST', 'ACCEPTED', 'INQUIRY_CLOSED'] as const;

/**
 * The "captured, not recorded / exceptions" predicate, mirrored client-side
 * so the panel never lists a row the server filter would not (and the test
 * pins it): captured with no ledger link and not resolved, OR any unresolved
 * exception.
 */
export function isOpenSquareException(row: {
  status: string;
  cash_payment_id: string | null;
  exception: string | null;
  exception_resolved_at: string | null;
}): boolean {
  if (row.exception_resolved_at) return false;
  if (row.exception) return true;
  return row.status === 'captured' && !row.cash_payment_id;
}

/** Short age label: "12 min", "5 h", "3 d". */
export function ageLabel(since: string | null | undefined, now: Date): string {
  if (!since) return '—';
  const ms = now.getTime() - new Date(since).getTime();
  if (Number.isNaN(ms)) return '—';
  if (ms < 0) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** YYYY-MM-DD in Japan time (the settlement report's day is a Japan day). */
export function jstDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(d);
}

/** Default report range: first day of the current Japan month → today (Japan). */
export function defaultSettlementRange(now: Date): { from: string; to: string } {
  const to = jstDate(now);
  return { from: `${to.slice(0, 8)}01`, to };
}

/** One row of square_settlement_report. bigint may arrive as a string. */
export interface SettlementRow {
  day: string;
  captures: number | string;
  gross_jpy: number | string;
  fees_jpy: number | string;
  refunds_completed_jpy: number | string;
  refunds_open_jpy: number | string;
  disputes_lost_jpy: number | string;
  net_jpy: number | string;
  /** Captures whose Square fee was not reported yet (counted as ¥0 — net is an estimate). */
  fees_missing?: number | string;
}

export interface SettlementTotals {
  captures: number;
  gross_jpy: number;
  fees_jpy: number;
  refunds_completed_jpy: number;
  refunds_open_jpy: number;
  disputes_lost_jpy: number;
  net_jpy: number;
  fees_missing: number;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Column sums of the report rows (integer yen in, integer yen out). */
export function settlementTotals(rows: SettlementRow[]): SettlementTotals {
  const t: SettlementTotals = {
    captures: 0, gross_jpy: 0, fees_jpy: 0, refunds_completed_jpy: 0,
    refunds_open_jpy: 0, disputes_lost_jpy: 0, net_jpy: 0, fees_missing: 0,
  };
  for (const r of rows) {
    t.captures += num(r.captures);
    t.gross_jpy += num(r.gross_jpy);
    t.fees_jpy += num(r.fees_jpy);
    t.refunds_completed_jpy += num(r.refunds_completed_jpy);
    t.refunds_open_jpy += num(r.refunds_open_jpy);
    t.disputes_lost_jpy += num(r.disputes_lost_jpy);
    t.net_jpy += num(r.net_jpy);
    t.fees_missing += num(r.fees_missing);
  }
  return t;
}

export const SETTLEMENT_CSV_HEADER = [
  'Day (Japan)', 'Captures', 'Gross JPY', 'Square fees JPY', 'Refunds completed JPY',
  'Refunds pending JPY', 'Disputes lost JPY', 'Estimated net JPY', 'Captures with fee not reported',
];

/** Header + rows (with a final Total row) for the settlement CSV. Numbers stay numbers. */
export function settlementCsvRows(rows: SettlementRow[]): { header: string[]; rows: (string | number)[][] } {
  const body = rows.map((r) => [
    r.day, num(r.captures), num(r.gross_jpy), num(r.fees_jpy), num(r.refunds_completed_jpy),
    num(r.refunds_open_jpy), num(r.disputes_lost_jpy), num(r.net_jpy), num(r.fees_missing),
  ]);
  const t = settlementTotals(rows);
  body.push(['Total', t.captures, t.gross_jpy, t.fees_jpy, t.refunds_completed_jpy,
    t.refunds_open_jpy, t.disputes_lost_jpy, t.net_jpy, t.fees_missing]);
  return { header: SETTLEMENT_CSV_HEADER, rows: body };
}

/** The settlement CSV text (RFC 4180, formula-guarded by lib/csv). */
export function settlementCsv(rows: SettlementRow[]): string {
  const { header, rows: body } = settlementCsvRows(rows);
  return toCsv(header, body);
}

/** CSV file base name for a range, e.g. "square-card-activity-2026-10-01-to-2026-10-04" (QC13: activity, not bank settlement). */
export function settlementFileName(from: string, to: string): string {
  return `square-card-activity-${from}-to-${to}`;
}

/** square_ops_health() (QC11) — the panel's health strip. */
export interface SquareOpsHealth {
  last_run?: { at?: string; finished_at?: string; status?: 'ok' | 'degraded' | 'failed'; backlog?: number; report?: { errors?: string[]; truncated?: string[]; history_gaps?: string[]; events_api?: string } } | null;
  last_ok_at?: string | null;
  events_backlog?: number;
  events_dead?: number;
  holds_live?: number;
  attempts_open?: number;
  captured_unrecorded?: number;
  exceptions_open?: number;
  refunds_open?: number;
  disputes_open?: number;
  /** S05 (2026-10-08): when the oldest refund still not finished started (Square's time). */
  refund_oldest_pending_at?: string | null;
  /** S01 (2026-10-08): open card attempts that already rang 'card_attempt_stuck'. */
  attempts_stuck?: number;
}

/** S05: the first bell rings at 7 days, the second (contact Square support) at 14. Every day counts (owner E1). */
export const REFUND_PENDING_WARN_DAYS = 7;
export const REFUND_PENDING_SUPPORT_DAYS = 14;

/** S05: whole days the oldest unfinished Square refund has been waiting, or null when none. */
export function refundPendingDays(h: SquareOpsHealth | null | undefined, now: Date): number | null {
  const at = h?.refund_oldest_pending_at ? Date.parse(h.refund_oldest_pending_at) : NaN;
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((now.getTime() - at) / 86_400_000));
}

/** True when the last run found Square's event history (Events API) not enabled for the account. */
export function eventsApiNotEnabled(h: SquareOpsHealth | null | undefined): boolean {
  return String(h?.last_run?.report?.events_api ?? '').startsWith('not_enabled');
}

/** The checks run hourly: a last good run older than this is stale (cron silent or failing). */
export const RECONCILE_STALE_MS = 3 * 60 * 60 * 1000;

/** ok | degraded | failed | stale | unknown — what the strip shows. */
export function squareHealthStatus(h: SquareOpsHealth | null | undefined, now: Date): 'ok' | 'degraded' | 'failed' | 'stale' | 'unknown' {
  if (!h || !h.last_run?.at) return 'unknown';
  const lastOk = h.last_ok_at ? new Date(h.last_ok_at).getTime() : NaN;
  if (Number.isNaN(lastOk) || now.getTime() - lastOk > RECONCILE_STALE_MS) {
    const s = h.last_run.status;
    return s === 'failed' || s === 'degraded' ? s : 'stale';
  }
  const s = h.last_run.status;
  return s === 'failed' || s === 'degraded' ? s : (h.events_dead ?? 0) > 0 ? 'degraded' : 'ok';
}

/** Customer-facing order reference: the web reference, else the invoice number. */
export function orderRef(o: { web_reference?: string | null; invoice_number?: string | number | null } | null | undefined): string {
  if (!o) return '—';
  return o.web_reference || (o.invoice_number != null ? String(o.invoice_number) : '—');
}

/** F-08 (owner D-QC5, 2026-10-09): an attempt may be closed by an admin only once it is 30 minutes old (the SQL refuses earlier). */
export const ATTEMPT_CLOSE_MIN_AGE_MS = 30 * 60 * 1000;
export function attemptClosable(createdAt: string, now: Date = new Date()): boolean {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) && now.getTime() - t >= ATTEMPT_CLOSE_MIN_AGE_MS;
}

/** close_square_attempt_atomic refusal codes → plain words. */
export function closeAttemptRefusal(code: string): string {
  switch (code) {
    case "admin_only": return "Only an admin can close a card attempt.";
    case "note_required": return "Write what you checked in the Square Dashboard (at least 10 characters).";
    case "too_recent": return "This attempt is less than 30 minutes old. Wait for the hourly check first.";
    case "payment_exists": return "Square gave this attempt a payment. Do not close it — the hourly check files it, or decide it under Exceptions.";
    case "not_open": return "This attempt is already settled. Refresh.";
    case "not_found": return "Attempt not found. Refresh.";
    case "user_identity_required": return "Your session has expired. Sign in again.";
    default: return code;
  }
}
