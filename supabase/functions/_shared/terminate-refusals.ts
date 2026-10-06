/**
 * Plain-English text for staff when terminate_web_order_atomic refuses a
 * cancel because payment money is still unresolved (payment lifecycle H10,
 * qc-audit P2-3). Nothing was written when these come back.
 * Returns null for a reason that has no staff message here.
 */
const MESSAGES: Record<string, string> = {
  paidy_payment_unresolved: 'Reject or record the Paidy payment first',
  card_payment_unresolved: 'Reject or record the card payment first',
}

export function terminateRefusalMessage(reason: string | null | undefined): string | null {
  return MESSAGES[String(reason ?? '')] ?? null
}
