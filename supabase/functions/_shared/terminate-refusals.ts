/**
 * Plain-English text for staff when terminate_web_order_atomic refuses a
 * cancel because payment money is still unresolved (payment lifecycle H10,
 * qc-audit P2-3). Nothing was written when these come back.
 * Returns null for a reason that has no staff message here.
 */
const MESSAGES: Record<string, string> = {
  paidy_payment_unresolved: 'Reject or record the Paidy payment first',
  card_payment_unresolved: 'Reject or record the card payment first',
  // B01 (2026-10-08): card money goes back only through Square.
  card_refund_needs_square: 'This order was paid by card. Choose "Refund pending", refund it in the Square Dashboard, then use "Mark refund issued" once Square shows the refund completed',
}

export function terminateRefusalMessage(reason: string | null | undefined): string | null {
  return MESSAGES[String(reason ?? '')] ?? null
}
