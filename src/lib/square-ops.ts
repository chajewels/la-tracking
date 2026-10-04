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
  risk_high: 'Square risk HIGH (voided)',
  void_unconfirmed: 'Hub closed it but Square still holds it',
};

/** Exception label; a capture with no exception code is "captured, not recorded". */
export function squareExceptionLabel(code: string | null | undefined): string {
  if (!code) return 'Captured, not recorded yet';
  return SQUARE_EXCEPTION_LABEL[code] ?? code.replace(/_/g, ' ');
}

/** decide_square_case decisions per kind — the exact values the function accepts. */
export type SquareCaseKind = 'exception' | 'refund' | 'dispute';
export const SQUARE_DECISIONS: Record<SquareCaseKind, { value: string; label: string }[]> = {
  exception: [
    { value: 'recorded_manually', label: 'Recorded by hand in the Hub' },
    { value: 'refunded_in_square', label: 'Refunded in the Square Dashboard' },
    { value: 'voided_in_square', label: 'Voided in the Square Dashboard' },
    { value: 'other', label: 'Other (explain in the note)' },
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

/** The note is required for an exception (it releases the order); optional otherwise. */
export function squareNoteRequired(kind: SquareCaseKind): boolean {
  return kind === 'exception';
}

/** decide_square_case refusal codes → plain words. */
export function squareDecisionRefusal(code: string): string {
  switch (code) {
    case 'decision_required': return 'Choose a decision.';
    case 'bad_decision': return 'That decision is not allowed for this case.';
    case 'note_required': return 'A note is required: say what was done with the money.';
    case 'not_permitted': return 'Only an admin or finance can resolve a card exception (it reopens the order for payment).';
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

/** Finished dispute states (Square). */
export const DISPUTE_CLOSED_STATES = ['WON', 'LOST', 'ACCEPTED'] as const;

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
}

export interface SettlementTotals {
  captures: number;
  gross_jpy: number;
  fees_jpy: number;
  refunds_completed_jpy: number;
  refunds_open_jpy: number;
  disputes_lost_jpy: number;
  net_jpy: number;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Column sums of the report rows (integer yen in, integer yen out). */
export function settlementTotals(rows: SettlementRow[]): SettlementTotals {
  const t: SettlementTotals = {
    captures: 0, gross_jpy: 0, fees_jpy: 0, refunds_completed_jpy: 0,
    refunds_open_jpy: 0, disputes_lost_jpy: 0, net_jpy: 0,
  };
  for (const r of rows) {
    t.captures += num(r.captures);
    t.gross_jpy += num(r.gross_jpy);
    t.fees_jpy += num(r.fees_jpy);
    t.refunds_completed_jpy += num(r.refunds_completed_jpy);
    t.refunds_open_jpy += num(r.refunds_open_jpy);
    t.disputes_lost_jpy += num(r.disputes_lost_jpy);
    t.net_jpy += num(r.net_jpy);
  }
  return t;
}

export const SETTLEMENT_CSV_HEADER = [
  'Day (Japan)', 'Captures', 'Gross JPY', 'Square fees JPY', 'Refunds completed JPY',
  'Refunds pending JPY', 'Disputes lost JPY', 'Net JPY',
];

/** Header + rows (with a final Total row) for the settlement CSV. Numbers stay numbers. */
export function settlementCsvRows(rows: SettlementRow[]): { header: string[]; rows: (string | number)[][] } {
  const body = rows.map((r) => [
    r.day, num(r.captures), num(r.gross_jpy), num(r.fees_jpy), num(r.refunds_completed_jpy),
    num(r.refunds_open_jpy), num(r.disputes_lost_jpy), num(r.net_jpy),
  ]);
  const t = settlementTotals(rows);
  body.push(['Total', t.captures, t.gross_jpy, t.fees_jpy, t.refunds_completed_jpy,
    t.refunds_open_jpy, t.disputes_lost_jpy, t.net_jpy]);
  return { header: SETTLEMENT_CSV_HEADER, rows: body };
}

/** The settlement CSV text (RFC 4180, formula-guarded by lib/csv). */
export function settlementCsv(rows: SettlementRow[]): string {
  const { header, rows: body } = settlementCsvRows(rows);
  return toCsv(header, body);
}

/** CSV file base name for a range, e.g. "square-settlement-2026-10-01-to-2026-10-04". */
export function settlementFileName(from: string, to: string): string {
  return `square-settlement-${from}-to-${to}`;
}

/** Customer-facing order reference: the web reference, else the invoice number. */
export function orderRef(o: { web_reference?: string | null; invoice_number?: string | number | null } | null | undefined): string {
  if (!o) return '—';
  return o.web_reference || (o.invoice_number != null ? String(o.invoice_number) : '—');
}
