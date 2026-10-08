/**
 * SQV06 (fix revalidation 2026-10-09): what the Hub may truthfully say about the
 * 「返金を受け付けました」 email of each COMPLETED Square refund on an order.
 *
 *   sent          — the send log holds a `sent` row for the refund's own key;
 *   retrying      — not sent, and the hourly replay (B02) will try again:
 *                   refund_email_replay is on and it has not given up;
 *   given_up      — not sent, and the replay stopped after its attempts (a
 *                   refund_email_failed bell exists): staff tell her another way;
 *   not_replayed  — not sent, and no automatic retry is scheduled (a refund from
 *                   before the replay existed, or the replay was switched off for
 *                   it): staff tell her another way.
 *
 * Only `retrying` may be described as "the hourly check will retry". Pure.
 */
export type RefundEmailState = "sent" | "retrying" | "given_up" | "not_replayed";

export function refundEmailState(i: { sent: boolean; replay: boolean | null | undefined; givenUpAt: string | null | undefined }): RefundEmailState {
  if (i.sent) return "sent";
  if (i.givenUpAt) return "given_up";
  if (i.replay === true) return "retrying";
  return "not_replayed";
}

export interface RefundEmailCoverage { sent: number; total: number; retrying: number; given_up: number; not_replayed: number }

export function refundEmailCoverage(states: RefundEmailState[]): RefundEmailCoverage {
  const c: RefundEmailCoverage = { sent: 0, total: states.length, retrying: 0, given_up: 0, not_replayed: 0 };
  for (const s of states) c[s]++;
  return c;
}

/**
 * The one sentence the Hub shows after "Mark refund issued" on a card refund
 * (the dialog renders exactly this; the edge returns the coverage it is built
 * from). Never promises a retry that is not scheduled.
 */
export function refundEmailSentence(c: RefundEmailCoverage): string {
  if (c.total === 0) return "";
  if (c.sent === c.total) {
    return c.total === 1 ? "Square's refund email already told the customer." : `All ${c.total} Square refund emails were sent.`;
  }
  const parts: string[] = [];
  const of = c.total > 1 ? `${c.sent} of ${c.total} Square refund emails are confirmed sent. ` : "The Square refund email is not confirmed sent. ";
  if (c.retrying > 0) parts.push(c.retrying === 1 && c.total === 1 ? "The hourly check will retry it." : `The hourly check will retry ${c.retrying}.`);
  const manual = c.given_up + c.not_replayed;
  if (manual > 0) {
    parts.push(c.given_up > 0
      ? `${manual === c.total - c.sent && c.retrying === 0 ? "No more automatic tries" : `${manual} will not be retried`} — see the "Refund email could not be sent" bell and tell the customer another way.`
      : `${manual === c.total - c.sent && c.retrying === 0 ? "No automatic retry is scheduled" : `${manual} will not be retried`} — tell the customer another way.`);
  }
  return of + parts.join(" ");
}
