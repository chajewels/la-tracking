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
  // R05 (owner 2026-10-08, refuse): money Square already gave back never comes back again as credit.
  card_already_refunded: 'Money on this order was already refunded through Square — it cannot be issued again as store credit. Choose "Refund pending", then "Mark refund issued"',
  // PA03 (owner 2026-10-08): Paidy money goes back only through the Paidy dashboard, and only a refund the Hub has read back from Paidy counts.
  paidy_refund_needs_dashboard: 'This order was paid with Paidy. Choose "Refund pending", refund it in the Paidy merchant dashboard, then use "Mark refund issued" once the Hub has recorded the Paidy refund (the hourly check picks it up)',
  // PA02 (owner 2026-10-08, refuse): money Paidy already gave back never comes back again as credit.
  paidy_already_refunded: 'Money on this order was already refunded in the Paidy dashboard — it cannot be issued again as store credit. Choose "Refund pending", then "Mark refund issued"',
}

export function terminateRefusalMessage(reason: string | null | undefined): string | null {
  return MESSAGES[String(reason ?? '')] ?? null
}
