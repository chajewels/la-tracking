/**
 * The "Refund emails" panel's wording for one row (ops-panel truth,
 * 2026-10-15, QA finding C). Kept apart from the component so the pure parts
 * are testable and Fast Refresh stays happy.
 */
export const MAX_MANUAL_RESENDS = 3;
const MAX = MAX_MANUAL_RESENDS;

export interface RefundEmailState {
  last_at: string | null;
  last_status: string | null;
  resends_used: number;
  /** Why a row with no attempt is not a missed email (card orders: Square's own email went instead). */
  not_sent_reason?: 'card_refund_email_sent_by_square' | null;
  /** false = re-sent by the hourly check only (Square refund email), never from the panel. */
  resendable?: boolean;
}

/** The one-line delivery state under a row (ops-panel truth, 2026-10-15). */
export function refundEmailStateLine(e: RefundEmailState, fmt: (iso: string) => string): string {
  if (!e.last_at && e.not_sent_reason === 'card_refund_email_sent_by_square') {
    return "Not sent on card orders — by design: Square's own refund email (below) told the customer";
  }
  const attempt = e.last_at ? `Last attempt ${fmt(e.last_at)} PHT` : 'Never attempted';
  if (e.resendable === false) return `${attempt} · re-sent automatically by the hourly check if needed (up to 3 times)`;
  return `${attempt} · manual resends ${e.resends_used} of ${MAX}`;
}

/** What the status badge says; a by-design skip is not "not attempted". */
export function refundEmailBadge(e: Pick<RefundEmailState, 'last_at' | 'last_status' | 'not_sent_reason'>): string {
  if (!e.last_at && e.not_sent_reason === 'card_refund_email_sent_by_square') return 'skipped by design';
  return e.last_status ?? 'not attempted';
}
