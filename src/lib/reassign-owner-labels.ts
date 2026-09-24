// Display labels for the Reassign Owner dialog (CLAUDE.md "REASSIGN OWNER").
// Pure, so src/test/reassign-owner.test.ts can check the wording directly.

/** Rows that move with the order, as [singular, plural]. */
export const CHILD_LABELS: Record<string, readonly [string, string]> = {
  payment_submissions: ['payment submission', 'payment submissions'],
  extension_requests: ['extension request', 'extension requests'],
  service_jobs: ['service job', 'service jobs'],
  service_requests: ['service request', 'service requests'],
  checkout_quotes: ['checkout quote', 'checkout quotes'],
  csr_notifications: ['CSR notification', 'CSR notifications'],
  ship_to_address_detached: ['saved address (kept as a snapshot)', 'saved addresses (kept as snapshots)'],
};

/** "1 payment submission", "3 payment submissions". */
export function countLabel(n: number, key: string): string {
  const [one, many] = CHILD_LABELS[key] ?? [key, key];
  return `${n} ${n === 1 ? one : many}`;
}

/** Every non-zero moved-rows line, in the order the RPC reports them. */
export function movedList(rows: Record<string, number>): string[] {
  return Object.entries(rows).filter(([, n]) => n > 0).map(([k, n]) => countLabel(n, k));
}

/** R11 — the identity fields reassign_order_owner_atomic reports in matched_on. */
export const IDENTITY_LABELS: Record<string, string> = {
  full_name: 'full name',
  facebook_name: 'Facebook name',
  mobile: 'mobile',
  email: 'email',
};

/** "Matched on: full name, mobile" — or null when nothing matched. */
export function matchedOnText(matchedOn: string[] | null | undefined): string | null {
  if (!matchedOn || matchedOn.length === 0) return null;
  return `Matched on: ${matchedOn.map((f) => IDENTITY_LABELS[f] ?? f).join(', ')}`;
}
