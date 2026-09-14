/**
 * The order number the CUSTOMER knows.
 *
 * An order placed on the storefront carries two numbers. `invoice_number` is
 * the Hub's key, assigned from the sequence and prefixed TEST- for a test
 * customer by enforce_test_invoice_prefix. `web_reference` (CJ-W-900011) is
 * what the storefront showed, what the confirmation email said, and the only
 * one the customer has ever seen.
 *
 * The CJ-W-900011 test on 2026-09-14 put both in one inbox: the storefront
 * emails said "CJ-W-900011" and the Hub emails said "INV #TEST-900011". For a
 * real customer that reads "INV #900011" — still a second number for one
 * order, just less alarming.
 *
 * The trigger is correct and is left alone. The rule is at the template edge:
 *
 *   CUSTOMER-FACING email  -> customerReference(order)
 *   Hub-internal screen or staff email -> invoice_number, unchanged
 *
 * Pass the row with `source_channel` and `web_reference` selected; a row
 * missing them falls back to the invoice number, so a caller that has not been
 * updated degrades to today's behaviour rather than printing nothing.
 */
export interface ReferenceSource {
  invoice_number?: string | null;
  web_reference?: string | null;
  source_channel?: string | null;
}

export function customerReference(order: ReferenceSource | null | undefined): string {
  if (!order) return "";
  const web = String(order.web_reference ?? "").trim();
  if (order.source_channel === "web" && web) return web;
  return String(order.invoice_number ?? "").trim();
}

/** Columns customerReference needs. Append to a select that feeds an email. */
export const REFERENCE_FIELDS = "invoice_number, web_reference, source_channel";
