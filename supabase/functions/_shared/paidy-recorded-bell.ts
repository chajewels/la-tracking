/**
 * The "Paidy payment recorded" bell (owner 2026-10-10, QC PR-B D5), built in
 * ONE place so the bell rung at recording time (review-payment-submission)
 * and the late bell rung by the hourly sweep (paidy-reconcile, reassessment
 * F2, owner 2026-10-10 "A") read the same. Pure: no I/O.
 *
 * Type paidy_payment_recorded is emailed to Brenda + the admins when ticked
 * in Website → Settings → Staff bell emails. One bell per cash payment:
 * metadata.cash_payment_id is the key the sweep checks before ringing.
 */

export const PAIDY_RECORDED_BELL_TYPE = "paidy_payment_recorded";

/** How long the sweep leaves a recording alone before ringing a missing bell —
 *  the recording path rings within seconds; this keeps the two from racing. */
export const PAIDY_RECORDED_BELL_GRACE_MINUTES = 10;

/** The sweep only looks back this far (and never before the feature shipped). */
export const PAIDY_RECORDED_BELL_LOOKBACK_DAYS = 7;
export const PAIDY_RECORDED_BELL_SINCE = "2026-10-10T10:10:00Z";

export interface PaidyRecordedBellInput {
  reference: string;
  amountJpy: number;
  senderName: string | null | undefined;
  automatic: boolean;
  fullyPaid: boolean;
  remainingJpy: number;
  /** true when the hourly sweep rings it because the first ring never happened. */
  late?: boolean;
}

const yen = (n: number) => `¥${Math.round(Number(n) || 0).toLocaleString("en-US")}`;

export function paidyRecordedBell(i: PaidyRecordedBellInput): { type: string; title: string; body: string } {
  const title = i.fullyPaid ? "Paidy payment recorded — order completed, ready to ship" : "Paidy payment recorded";
  const how = i.automatic ? "automatically after the capture in the Paidy dashboard" : "by a staff Confirm";
  const tail = i.fullyPaid ? " · the order is completed and ready to ship" : ` · ${yen(i.remainingJpy)} still due`;
  const late = i.late ? " · this bell was sent late by the hourly Paidy check" : "";
  return {
    type: PAIDY_RECORDED_BELL_TYPE,
    title,
    body: `${i.reference} · ${yen(i.amountJpy)} · ${String(i.senderName ?? "")} · recorded ${how}${tail}${late}`,
  };
}

/** Earliest recording the sweep considers, as an ISO string. */
export function paidyRecordedBellSince(nowMs: number): string {
  const lookback = nowMs - PAIDY_RECORDED_BELL_LOOKBACK_DAYS * 86_400_000;
  return new Date(Math.max(lookback, Date.parse(PAIDY_RECORDED_BELL_SINCE))).toISOString();
}

/** Latest recording the sweep considers (older than the grace period). */
export function paidyRecordedBellUntil(nowMs: number): string {
  return new Date(nowMs - PAIDY_RECORDED_BELL_GRACE_MINUTES * 60_000).toISOString();
}
