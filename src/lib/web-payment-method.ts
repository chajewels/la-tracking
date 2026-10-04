/**
 * The payment method a website customer chose at checkout (owner C1,
 * 2026-10-05). Stored on web_order_drafts / cash_orders as transfer | paidy |
 * square; shown in the Hub as below.
 */
export type WebPaymentMethod = 'transfer' | 'paidy' | 'card';

/** cash_orders / web_order_drafts store 'square' for card; null = transfer. */
export function webMethodOf(stored: unknown): WebPaymentMethod {
  const v = String(stored ?? '').toLowerCase();
  if (v === 'paidy') return 'paidy';
  if (v === 'square' || v === 'card') return 'card';
  return 'transfer';
}

export const WEB_METHOD_LABEL: Record<WebPaymentMethod, string> = {
  transfer: 'Bank transfer',
  paidy: 'Paidy (pay later)',
  card: 'Credit / debit card',
};
