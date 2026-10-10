/**
 * The payment method a website customer chose at checkout (owner C1,
 * 2026-10-05). Stored on web_order_drafts / cash_orders as transfer | paidy |
 * square | cod; shown in the Hub as below. 'cod' = cash on delivery (代金引換,
 * owner plan 2026-10-10, docs/COD.md): no deadline, paid to the courier.
 */
export type WebPaymentMethod = 'transfer' | 'paidy' | 'card' | 'cod';

export const WEB_METHODS: readonly WebPaymentMethod[] = ['transfer', 'paidy', 'card', 'cod'];

/** cash_orders / web_order_drafts store 'square' for card; 'cod' stays 'cod' (never transfer); null = transfer. */
export function webMethodOf(stored: unknown): WebPaymentMethod {
  const v = String(stored ?? '').toLowerCase();
  if (v === 'paidy') return 'paidy';
  if (v === 'square' || v === 'card') return 'card';
  if (v === 'cod') return 'cod';
  return 'transfer';
}

export const WEB_METHOD_LABEL: Record<WebPaymentMethod, string> = {
  transfer: 'Bank transfer',
  paidy: 'Paidy (pay later)',
  card: 'Credit / debit card',
  cod: 'Cash on delivery (代引)',
};

/**
 * Manage Invoice on a cash-on-delivery order (review H2): total, shipping and
 * discount are locked while the method is COD (trg_guard_cod_order_amount).
 */
export const COD_AMOUNT_LOCKED_MESSAGE =
  'This order is paid cash on delivery: its total, shipping and discount cannot be edited here, because the fee is bracketed on the amount the courier collects. Change the payment method first (the fee is removed), edit, then switch back — or cancel and recreate the order.';

/** Whole yen, for the COD fee row and warnings. */
export function formatYen(n: number): string {
  return `¥${Math.round(n).toLocaleString('en-US')}`;
}
