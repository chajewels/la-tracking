import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { ExternalLink, Wrench } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import ServiceJobDialog from './ServiceJobDialog';
import { buildServiceJobPrefill, invoiceForRequest, serviceJobHref } from './request-to-job';
import {
  SERVICE_REQUEST_STATUSES,
  serviceRequests,
  kindLabel,
  requestStatusBadgeClass,
  statusLabel,
  type ServiceRequestRow,
  type ServiceRequestStatus,
} from './service-request-types';

interface Props {
  request: ServiceRequestRow | null;
  onClose: () => void;
}

/**
 * Triage drawer for one customer service request.
 *
 * What the customer wrote is READ-ONLY here — item, kind, details and ring
 * size are their words and staff do not rewrite them. Staff own three
 * fields: the status, a private staff_note, and customer_note, which is the
 * reply the customer sees in the portal.
 *
 * Every save is ONE .update carrying an explicit updated_at. The column has
 * no trigger behind it, so leaving it to the database would leave the row's
 * age wrong in the queue — the one column staff actually sort on.
 *
 * A status change also writes an audit_logs row. A note edit does not: the
 * note is already visible in the drawer, whereas a status move is what other
 * surfaces and the customer's portal react to.
 *
 * CONVERTING TO A JOB is the one thing here that creates another record. It
 * opens the job dialog with a prefill (never a description — see
 * request-to-job.ts) and, once the job exists, links it back and moves the
 * request to `received`. A job is money (SERVICES RULE), so a person makes
 * that call and the dialog is never skipped.
 */
export default function ServiceRequestDrawer({ request, onClose }: Props) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const { can } = usePermissions();
  const canEdit = can('add_service');

  const [status, setStatus] = useState<ServiceRequestStatus>('requested');
  const [staffNote, setStaffNote] = useState('');
  const [customerNote, setCustomerNote] = useState('');
  const [jobDialogOpen, setJobDialogOpen] = useState(false);

  // Re-seed the form whenever a different request opens the drawer.
  useEffect(() => {
    if (!request) return;
    setStatus((request.status as ServiceRequestStatus) ?? 'requested');
    setStaffNote(request.staff_note ?? '');
    setCustomerNote(request.customer_note ?? '');
  }, [request]);

  const statusChanged = !!request && status !== request.status;
  const dirty = !!request && (
    statusChanged
    || staffNote !== (request.staff_note ?? '')
    || customerNote !== (request.customer_note ?? '')
  );

  const mutation = useMutation({
    mutationFn: async () => {
      if (!request) return;
      const previousStatus = request.status;

      const { error } = await serviceRequests()
        .update({
          status,
          staff_note: staffNote.trim() || null,
          customer_note: customerNote.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', request.id);
      if (error) throw error;

      // Audited only when the status actually moved.
      if (previousStatus !== status) {
        await supabase.from('audit_logs').insert([{
          entity_type: 'service_request',
          entity_id: request.id,
          action: 'update_service_request_status',
          old_value_json: { status: previousStatus },
          new_value_json: { status },
          performed_by_user_id: user?.id ?? null,
        }]);
      }
    },
    onSuccess: () => {
      toast.success('Request updated');
      qc.invalidateQueries({ queryKey: ['service-requests'] });
      qc.invalidateQueries({ queryKey: ['service-requests-open-count'] });
      qc.invalidateQueries({ queryKey: ['service-requests-by-target'] });
      onClose();
    },
    onError: (err: Error) => {
      toast.error('Save failed', { description: err.message });
    },
  });

  // Memoised so the dialog's open-time hydration reads one stable object.
  const prefill = useMemo(
    () => (request ? buildServiceJobPrefill(request) : null),
    [request],
  );

  /**
   * Link the job the dialog just created back to this request.
   *
   * The status move to `received` is the Hub's, and only on the way IN. From
   * there the DB trigger trg_sync_service_request_from_job owns the request's
   * status as the job progresses — the Hub must not duplicate that, or the two
   * writers will disagree.
   */
  const linkJob = useMutation({
    mutationFn: async (jobId: string) => {
      if (!request) return;
      const previousStatus = request.status;
      const { error } = await serviceRequests()
        .update({
          service_job_id: jobId,
          status: 'received',
          updated_at: new Date().toISOString(),
        })
        .eq('id', request.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert([{
        entity_type: 'service_request',
        entity_id: request.id,
        action: 'convert_service_request_to_job',
        old_value_json: { status: previousStatus, service_job_id: request.service_job_id },
        new_value_json: { status: 'received', service_job_id: jobId },
        performed_by_user_id: user?.id ?? null,
      }]);
    },
    onSuccess: () => {
      toast.success('Service job linked to this request');
      qc.invalidateQueries({ queryKey: ['service-requests'] });
      qc.invalidateQueries({ queryKey: ['service-requests-open-count'] });
      qc.invalidateQueries({ queryKey: ['service-requests-by-target'] });
      onClose();
    },
    onError: (err: Error) => {
      // The job itself was created — say so, rather than implying it was lost.
      toast.error('Job created, but linking it to the request failed', {
        description: err.message,
      });
    },
  });

  return (
    <Sheet open={!!request} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto !duration-[280ms]">
        {request && (
          <>
            <SheetHeader className="text-left">
              <SheetTitle className="flex flex-wrap items-center gap-2 text-champagne">
                <span className="font-display">{request.item_title ?? 'Service request'}</span>
                <Badge variant="outline" className={`text-[10px] ${requestStatusBadgeClass(request.status)}`}>
                  {statusLabel(request.status)}
                </Badge>
              </SheetTitle>
              <p className="text-sm text-muted-foreground">
                {request.customer_id ? (
                  <Link to={`/customers/${request.customer_id}`} className="text-primary hover:underline">
                    {request.customers?.full_name ?? 'Unknown customer'}
                  </Link>
                ) : (
                  request.customers?.full_name ?? 'Unknown customer'
                )}
                {' · '}
                {formatDistanceToNow(new Date(request.created_at), { addSuffix: true })}
              </p>
            </SheetHeader>

            <div className="hairline-gold my-4" />

            {/* The customer's own words — read-only. */}
            <section aria-label="Request details" className="space-y-3">
              <div>
                <p className="label-caps">Kind</p>
                <p className="text-sm text-card-foreground">{kindLabel(request.kind)}</p>
              </div>
              {request.ring_size && (
                <div>
                  <p className="label-caps">Ring Size</p>
                  <p className="text-sm tabular-nums text-card-foreground">{request.ring_size}</p>
                </div>
              )}
              <div>
                <p className="label-caps">Details</p>
                <p className="whitespace-pre-wrap text-sm text-card-foreground">
                  {request.details?.trim() || <span className="text-muted-foreground">No details given.</span>}
                </p>
              </div>
              <RequestTarget request={request} />
            </section>

            <div className="hairline-gold my-4" />

            {/* Staff-owned fields. */}
            <section aria-label="Staff triage" className="space-y-4">
              <div>
                <Label htmlFor="sr-status" className="label-caps">Status</Label>
                <Select
                  value={status}
                  onValueChange={(v) => setStatus(v as ServiceRequestStatus)}
                  disabled={!canEdit}
                >
                  <SelectTrigger id="sr-status" className="mt-1 h-9 text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SERVICE_REQUEST_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{statusLabel(s)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="sr-staff-note" className="label-caps">Staff Note</Label>
                <p className="mb-1 text-[11px] text-muted-foreground">Internal. The customer never sees this.</p>
                <Textarea
                  id="sr-staff-note"
                  value={staffNote}
                  onChange={(e) => setStaffNote(e.target.value)}
                  disabled={!canEdit}
                  rows={3}
                  className="text-sm"
                />
              </div>

              <div>
                <Label htmlFor="sr-customer-note" className="label-caps">Customer Note</Label>
                <p className="mb-1 text-[11px] text-muted-foreground">Shown to the customer in their portal.</p>
                <Textarea
                  id="sr-customer-note"
                  value={customerNote}
                  onChange={(e) => setCustomerNote(e.target.value)}
                  disabled={!canEdit}
                  rows={3}
                  className="text-sm"
                />
              </div>

              {!canEdit && (
                <p className="text-xs text-muted-foreground">
                  You do not have permission to update service requests.
                </p>
              )}

              <Button
                type="button"
                onClick={() => mutation.mutate()}
                disabled={!canEdit || !dirty || mutation.isPending}
                className="w-full gold-gradient font-medium text-primary-foreground"
              >
                {mutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </section>

            <div className="hairline-gold my-4" />

            {/* The one action here that creates another record. */}
            <section aria-label="Service job" className="space-y-2">
              <p className="label-caps">Service Job</p>
              {request.service_job_id ? (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    {request.service_jobs
                      ? `${request.service_jobs.service_type} · ${request.service_jobs.service_status}`
                      : 'A job has been raised for this request.'}
                  </p>
                  <Link
                    to={serviceJobHref(request.service_job_id)}
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                  >
                    <Wrench className="h-3.5 w-3.5" /> Open the service job
                  </Link>
                </>
              ) : (
                <>
                  <p className="text-[11px] text-muted-foreground">
                    {invoiceForRequest(request)
                      ? 'Opens the job form with what the customer told us. A job carries a fee, so nothing is created until you save it.'
                      : 'This request has no order or plan behind it — you will need to enter the invoice yourself.'}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setJobDialogOpen(true)}
                    disabled={!canEdit || linkJob.isPending}
                    className="w-full"
                  >
                    <Wrench className="mr-2 h-3.5 w-3.5" />
                    {linkJob.isPending ? 'Linking…' : 'Convert to service job'}
                  </Button>
                </>
              )}
            </section>

            <ServiceJobDialog
              open={jobDialogOpen}
              onOpenChange={setJobDialogOpen}
              mode="add"
              prefill={prefill}
              onCreated={(jobId) => linkJob.mutate(jobId)}
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The order or plan behind the request, when there is one. */
function RequestTarget({ request }: { request: ServiceRequestRow }) {
  const target = request.layaway_account_id && request.layaway_accounts
    ? { href: `/accounts/${request.layaway_account_id}`, label: `Plan ${request.layaway_accounts.invoice_number ?? ''}`.trim() }
    : request.cash_order_id && request.cash_orders
      ? { href: `/cash-orders/${request.cash_order_id}`, label: `Order ${request.cash_orders.invoice_number ?? ''}`.trim() }
      : null;

  if (!target) return null;
  return (
    <div>
      <p className="label-caps">Reference</p>
      <Link to={target.href} className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
        <ExternalLink className="h-3.5 w-3.5" /> {target.label}
      </Link>
    </div>
  );
}
