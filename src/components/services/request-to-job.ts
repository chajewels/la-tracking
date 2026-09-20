/**
 * Turning a customer's request into the workshop's job.
 *
 * The two records mean different things (see docs/SERVICE-REQUESTS.md), and
 * this module is the only place that translates between them. It is pure —
 * no Supabase, no React — so the guard below is testable on its own.
 *
 * THE GUARD: a prefill never carries a service description. On a Ring Resize
 * the dialog derives the fee from a signed size token in the description, and
 * `ring_size` is the size the customer WANTS, not the delta the workshop will
 * cut. Putting "7.5" in the description would quote a ¥3,000 resize off a
 * number that was never a delta. The size and the customer's own words go to
 * `notes`, where a human reads them and writes the real description.
 */

import type { ServiceJobPrefill, ServiceType } from './ServiceJobDialog';
import { kindLabel, type ServiceRequestRow } from './service-request-types';

/**
 * The service type a request kind implies, or '' when the CSR must choose.
 *
 * `resize` is deliberately only a Ring Resize when a ring size came with the
 * request — without one there is nothing saying the piece is a ring, and
 * Bracelet Resize is the other half of that coin. `other` never maps: it is
 * the kind a customer picks when none of the rest fit.
 */
export function jobTypeForKind(
  kind: string | null,
  ringSize: string | null,
): ServiceType | '' {
  switch (kind) {
    case 'resize':
      return ringSize ? 'Ring Resize' : '';
    case 'cleaning':
      return 'Polishing';
    case 'repair':
      return 'Repair';
    case 'appraisal':
      return 'Appraisal';
    default:
      return '';
  }
}

/** The invoice the job is booked against — a plan or an order, or none. */
export function invoiceForRequest(request: ServiceRequestRow): string | undefined {
  return (
    request.layaway_accounts?.invoice_number
    ?? request.cash_orders?.invoice_number
    ?? undefined
  );
}

/**
 * What the CSR should see already filled in, and nothing more.
 *
 * Note what is NOT here: no serviceDescription, by construction. See the
 * module comment — the customer's size lives in `notes` and only there.
 */
export function buildServiceJobPrefill(request: ServiceRequestRow): ServiceJobPrefill {
  const serviceType = jobTypeForKind(request.kind, request.ring_size);

  // The customer's own account of the work, verbatim, for the CSR to read.
  const noteLines = [`From customer request: ${kindLabel(request.kind)}`];
  if (request.item_title?.trim()) noteLines.push(`Item: ${request.item_title.trim()}`);
  if (request.ring_size?.trim()) {
    noteLines.push(`Customer's ring size: ${request.ring_size.trim()}`);
  }
  if (request.details?.trim()) noteLines.push(`Customer says: ${request.details.trim()}`);

  const prefill: ServiceJobPrefill = {
    invoiceNumber: invoiceForRequest(request),
    serviceType,
    notes: noteLines.join('\n'),
  };

  if (!serviceType) {
    prefill.hint = request.kind === 'resize'
      ? 'The customer gave no ring size — pick Ring Resize or Bracelet Resize.'
      : `Request kind "${kindLabel(request.kind)}" has no matching service type — choose one.`;
  }

  return prefill;
}
