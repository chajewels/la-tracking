// What the CUSTOMER is told when the Hub ended her order or payment by itself
// (payment lifecycle addendum §9 #10, owner directive 2026-10-06).
//
// square_fraud_cancel stores a staff-facing reason on the order —
// "Card payment stopped for suspected fraud (…) — auto-cancelled" — so staff
// see exactly what happened. The customer must NEVER be told "fraud": her email
// and her order page show the neutral reason below instead. The stored reason
// is left as it is (staff need it; the bell and audit read it).

/** The prefix every square_fraud_cancel reason starts with (20261104100000_square_integrity.sql). */
export const FRAUD_REASON_PREFIX = "Card payment stopped for suspected fraud";

/** The neutral wording, in both languages. */
export const NEUTRAL_CANCEL_REASON = {
  ja: "お支払いを確認できなかったため",
  en: "We could not confirm your payment",
} as const;

/** True when a stored cancellation reason is the automatic fraud cancel. */
export function isAutomaticFraudReason(reason: unknown): boolean {
  return typeof reason === "string" && reason.trimStart().startsWith(FRAUD_REASON_PREFIX);
}

/**
 * The cancellation reason the customer may see: the neutral text (both
 * languages, "日本語 / English") for an automatic fraud cancel, otherwise the
 * stored reason unchanged.
 */
export function customerCancellationReason(reason: unknown): string | null {
  if (reason === null || reason === undefined) return null;
  if (isAutomaticFraudReason(reason)) return `${NEUTRAL_CANCEL_REASON.ja} / ${NEUTRAL_CANCEL_REASON.en}`;
  return String(reason);
}
