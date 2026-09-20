/**
 * Customer-raised service requests — the storefront side of Services.
 *
 * A request is NOT a service job. A customer creates a request from the
 * website (GET/POST /me/service-requests on the website function); staff
 * triage it here and, if it becomes real work, raise a service_job for it.
 * The two tables stay separate on purpose: a request is a conversation, a
 * job is the workshop's record.
 *
 * `service_requests` is not in src/integrations/supabase/types.ts yet — the
 * table was created live and Lovable regenerates that file on its next
 * edge-function deploy. Per CLAUDE.md (GENERATED FILES) the file is never
 * hand-edited, so this module carries the one cast the feature's queries go
 * through, and these hand-written row types are what the UI reads.
 */

import { supabase } from '@/integrations/supabase/client';

/**
 * The ONE cast in this feature. CLAUDE.md's rule for a table missing from the
 * generated types is "cast at the call site"; this is that cast, made once at
 * a call site every query shares rather than repeated in each of them. Delete
 * it when Lovable's next deploy regenerates types.ts with `service_requests`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const serviceRequests = () => (supabase as any).from('service_requests');

export const SERVICE_REQUEST_STATUSES = [
  'requested',
  'received',
  'in_progress',
  'completed',
  'declined',
] as const;
export type ServiceRequestStatus = typeof SERVICE_REQUEST_STATUSES[number];

/** Open = still on someone's desk. Drives the sidebar badge count. */
export const OPEN_SERVICE_REQUEST_STATUSES: ServiceRequestStatus[] = [
  'requested',
  'received',
  'in_progress',
];

export const SERVICE_REQUEST_KINDS = [
  'resize',
  'cleaning',
  'repair',
  'appraisal',
  'other',
] as const;
export type ServiceRequestKind = typeof SERVICE_REQUEST_KINDS[number];

/** Lowercase enum values are storage; these are what staff read. */
export const STATUS_LABEL: Record<ServiceRequestStatus, string> = {
  requested: 'Requested',
  received: 'Received',
  in_progress: 'In Progress',
  completed: 'Completed',
  declined: 'Declined',
};

export const KIND_LABEL: Record<ServiceRequestKind, string> = {
  resize: 'Resize',
  cleaning: 'Cleaning',
  repair: 'Repair',
  appraisal: 'Appraisal',
  other: 'Other',
};

export function statusLabel(s: string): string {
  return STATUS_LABEL[s as ServiceRequestStatus] ?? s;
}

export function kindLabel(k: string | null): string {
  if (!k) return '—';
  return KIND_LABEL[k as ServiceRequestKind] ?? k;
}

/** Theme-token badge classes, same vocabulary as service-badge-styles.ts. */
export function requestStatusBadgeClass(status: string): string {
  switch (status) {
    case 'requested':
      return 'bg-amber-500/10 text-amber-500 border-amber-500/30';
    case 'received':
      return 'bg-sky-500/10 text-sky-500 border-sky-500/30';
    case 'in_progress':
      return 'bg-blue-500/10 text-blue-500 border-blue-500/30';
    case 'completed':
      return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/30';
    case 'declined':
      return 'bg-destructive/10 text-destructive border-destructive/30';
    default:
      return 'bg-muted/40 text-muted-foreground border-border';
  }
}

/**
 * One request row as the queue reads it.
 *
 * NOTE the FK column is `layaway_account_id`, not `layaway_plan_id` — the
 * website calls the record a plan, the Hub calls it an account, and this
 * table is the Hub's.
 */
export interface ServiceRequestRow {
  id: string;
  customer_id: string | null;
  cash_order_id: string | null;
  layaway_account_id: string | null;
  item_title: string | null;
  kind: string | null;
  details: string | null;
  ring_size: string | null;
  status: string;
  /** The service job raised from this request, once one has been. */
  service_job_id: string | null;
  staff_note: string | null;
  customer_note: string | null;
  created_at: string;
  updated_at: string | null;
  // Embeds, via the named FK constraints.
  customers?: { id: string; full_name: string | null; is_test: boolean | null } | null;
  cash_orders?: { id: string; invoice_number: string | null } | null;
  layaway_accounts?: { id: string; invoice_number: string | null } | null;
}

/**
 * The embed spec. The FK constraint names are explicit because a table with
 * two FKs to different tables still needs disambiguating once a third arrives,
 * and PostgREST's inferred name is not stable enough to rely on.
 */
export const SERVICE_REQUEST_SELECT = `
  *,
  customers:customer_id (id, full_name, is_test),
  cash_orders!service_requests_cash_order_id_fkey (id, invoice_number),
  layaway_accounts!service_requests_layaway_account_id_fkey (id, invoice_number)
`;
