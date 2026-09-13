/**
 * The ONE reference for a cash order, everywhere the Hub names it.
 *
 * A storefront order is known to its customer as CJ-W-000123 (web_reference):
 * it is on the confirmation email, the order page and every message they send
 * us. The Hub shows the same string — titles, search, exports, notifications —
 * so staff and customer are never talking about two numbers. invoice_number
 * (TEST-900008 for a test customer, 900008 otherwise) stays the internal key
 * and the test-badge signal; it is shown as "Invoice" in the detail view only.
 *
 * Hub-created cash orders have no web_reference and keep their invoice number.
 */
export interface CashOrderRefFields {
  invoice_number?: string | null;
  web_reference?: string | null;
  source_channel?: string | null;
}

export function isWebOrder(o: CashOrderRefFields): boolean {
  return o.source_channel === 'web' && !!o.web_reference;
}

/** Display reference: web_reference for web orders, invoice_number otherwise. */
export function cashOrderRef(o: CashOrderRefFields): string {
  return isWebOrder(o) ? String(o.web_reference) : String(o.invoice_number ?? '');
}

/** "Order CJ-W-000123" for web orders, "Inv # 19599" for Hub orders — message and toast wording. */
export function cashOrderRefLabel(o: CashOrderRefFields): string {
  return isWebOrder(o) ? `Order ${o.web_reference}` : `Inv # ${o.invoice_number ?? ''}`;
}

/** Test-customer marker — always from the invoice prefix the DB trigger writes, never from the reference shown. */
export function isTestCashOrder(o: CashOrderRefFields): boolean {
  return String(o.invoice_number ?? '').startsWith('TEST-');
}
