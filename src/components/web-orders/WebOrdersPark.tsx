import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Hourglass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/calculations';
import { formatPHTDisplay } from '@/lib/date-utils';
import {
  RESERVATION_REMIND_HOURS, formatReservationAge, reservationAgeHours, reservationAutoCancelAt, reservationKindLabel,
} from '@/lib/web-reservations';
import {
  AWAITING_PAYMENT_BADGE, DRAFT_AUTO_CANCEL_HOURS, draftClosedLabel, draftKindLabel, formatCountdown, hoursUntil,
} from '@/lib/web-park';
import { useWebReservations } from '@/hooks/use-supabase-data';
import {
  declineWebDraft, useInvalidateWebPark, useWebAwaitingPayment, useWebClosedUnpaid, useWebDrafts,
  type ParkedOrderRow, type WebDraftRow,
} from '@/hooks/use-web-park';
import ReservationActions from '@/components/reservations/ReservationActions';

/**
 * Sales → Website orders (website orders PR 5, docs/WEB-ORDER-DRAFTS.md).
 *
 *   To confirm        — website drafts waiting for staff (Review / Can't supply),
 *                       plus any reservation from the old reserve-first flow
 *                       ("Old flow", same Confirm / Can't supply as before).
 *   Awaiting payment  — confirmed web orders with no payment yet. They reach the
 *                       Cash / Layaway lists only when the first payment is
 *                       confirmed (web_released_at).
 *   Closed            — declined / auto-cancelled drafts, and web orders
 *                       cancelled or expired without a payment (never a sale).
 */

const pill = 'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium';
const testPill = `${pill} border-info/20 bg-info/10 font-bold text-info`;

function kindHref(kind: 'cash_order' | 'layaway', id: string) {
  return kind === 'layaway' ? `/accounts/${id}` : `/cash-orders/${id}`;
}

function autoCancelAt(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + DRAFT_AUTO_CANCEL_HOURS * 3_600_000).toISOString();
}

function EmptyLine({ text }: { text: string }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{text}</p>;
}

function Loading() {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-md" />)}
    </div>
  );
}

export function DeclineDraftButton({ draft, onDone }: { draft: Pick<WebDraftRow, 'id' | 'web_reference'>; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const invalidate = useInvalidateWebPark();

  async function submit() {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await declineWebDraft(draft.id, reason);
      toast.success(`${draft.web_reference} declined. The piece is back on sale.`);
      setOpen(false);
      setReason('');
      invalidate();
      onDone?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" className="text-xs" onClick={() => setOpen(true)}>Can't supply</Button>
      <Dialog open={open} onOpenChange={(v) => { if (!busy) setOpen(v); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Can't supply {draft.web_reference}?</DialogTitle>
            <DialogDescription>
              The order is closed and the piece goes back on sale. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`decline-${draft.id}`}>Reason (the customer will be told)</Label>
            <Textarea id={`decline-${draft.id}`} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>Keep the order</Button>
            <Button variant="destructive" disabled={busy || !reason.trim()} onClick={submit}>
              Decline and put the piece back on sale
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DraftRow({ d }: { d: WebDraftRow }) {
  const hours = reservationAgeHours(d.created_at);
  const late = hours >= RESERVATION_REMIND_HOURS;
  return (
    <li className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between" data-testid="park-draft">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/orders/review/website/${d.id}`} className="font-mono text-sm font-bold text-card-foreground hover:text-primary">
            {d.web_reference}
          </Link>
          <span className={`${pill} border-border text-muted-foreground`}>{draftKindLabel(d)}</span>
          {d.shipping_pending && <span className={`${pill} border-warning/30 bg-warning/10 text-warning`}>Shipping to add</span>}
          {d.open_service_requests > 0 && <span className={`${pill} border-gold-500/30 bg-gold-500/10 text-gold-300`}>Service requested</span>}
          {d.customer_is_test && <span className={testPill}>🧪 TEST</span>}
        </div>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <Link to={`/customers/${d.customer_id}`} className="hover:text-primary">{d.customer_name}</Link>
          {' · '}{formatCurrency(d.total, d.currency)}{d.shipping_pending ? ' before shipping' : ''}
          {d.country ? ` · ${d.country}` : ''}
        </p>
        <p className={`text-xs ${late ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
          Waiting {formatReservationAge(d.created_at)} · auto-cancels {formatPHTDisplay(autoCancelAt(d.created_at))}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" className="gold-gradient text-xs text-primary-foreground">
          <Link to={`/orders/review/website/${d.id}`}>Review</Link>
        </Button>
        <DeclineDraftButton draft={d} />
      </div>
    </li>
  );
}

function OldFlowRow({ r }: { r: { kind: 'cash_order' | 'layaway'; id: string; reference: string; customer_name: string; customer_is_test: boolean; total_amount: number; currency: 'JPY' | 'PHP'; plan_months: number | null; created_at: string } }) {
  const hours = reservationAgeHours(r.created_at);
  const cancelAt = reservationAutoCancelAt(r.created_at);
  return (
    <li className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between" data-testid="park-old-flow">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={kindHref(r.kind, r.id)} className="font-mono text-sm font-bold text-card-foreground hover:text-primary">{r.reference}</Link>
          <span className={`${pill} border-border text-muted-foreground`}>{reservationKindLabel(r.kind)}</span>
          <span className={`${pill} border-border bg-muted text-muted-foreground`}>Old flow</span>
          {r.customer_is_test && <span className={testPill}>🧪 TEST</span>}
        </div>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {r.customer_name} · {formatCurrency(r.total_amount, r.currency)}{r.plan_months ? ` over ${r.plan_months} months` : ''}
        </p>
        <p className={`text-xs ${hours >= RESERVATION_REMIND_HOURS ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
          Waiting {formatReservationAge(r.created_at)}{cancelAt && <> · auto-cancels {formatPHTDisplay(cancelAt)}</>}
        </p>
      </div>
      <ReservationActions entityType={r.kind} entityId={r.id} reference={r.reference} compact />
    </li>
  );
}

function AwaitingRow({ o }: { o: ParkedOrderRow }) {
  const left = hoursUntil(o.transfer_due_at);
  const urgent = left !== null && left < 6;
  return (
    <li className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between" data-testid="park-awaiting">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={kindHref(o.kind, o.id)} className="font-mono text-sm font-bold text-card-foreground hover:text-primary">{o.reference}</Link>
          <span className={`${pill} border-border text-muted-foreground`}>
            {o.kind === 'layaway' ? `Layaway${o.plan_months ? ` · ${o.plan_months} months` : ''}` : 'Full payment'}
          </span>
          <span className={`${pill} border-warning/30 bg-warning/10 text-warning`}>{AWAITING_PAYMENT_BADGE}</span>
          {o.customer_is_test && <span className={testPill}>🧪 TEST</span>}
        </div>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {o.customer_id
            ? <Link to={`/customers/${o.customer_id}`} className="hover:text-primary">{o.customer_name}</Link>
            : o.customer_name}
          {' · '}{o.kind === 'layaway' ? 'Deposit due ' : 'Due '}{formatCurrency(o.amount_due, o.currency)}
        </p>
        <p className={`text-xs ${urgent ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
          Deadline {o.transfer_due_at ? `${formatPHTDisplay(o.transfer_due_at)} (${formatCountdown(o.transfer_due_at)})` : '— none set'}
          {' · '}{o.reminder_sent ? 'Reminder sent' : 'No reminder yet'}
        </p>
        {o.pending_submission && (
          <p className="text-xs font-semibold text-info">
            Payment submitted — waiting for review in Sales → Payments. The deadline will not cancel it meanwhile.
          </p>
        )}
      </div>
      <Button asChild variant="outline" size="sm" className="text-xs">
        <Link to={kindHref(o.kind, o.id)}>Open</Link>
      </Button>
    </li>
  );
}

function closedOrderLabel(o: ParkedOrderRow): string {
  if (o.status === 'expired') return 'Not paid by the deadline — expired';
  if (o.status === 'cancelled') return 'Cancelled before any payment';
  return `${o.status.replace(/_/g, ' ')} before any payment`;
}

/** The Sales toolbar search: the CJ-W reference the customer quotes, or her name. */
function matches(q: string, reference: string, name: string): boolean {
  const n = q.trim().toLowerCase();
  return !n || reference.toLowerCase().includes(n) || name.toLowerCase().includes(n);
}

export default function WebOrdersPark({ search = '' }: { search?: string }) {
  const [tab, setTab] = useState<'confirm' | 'awaiting' | 'closed'>('confirm');
  const draftsQ = useWebDrafts('open');
  const oldFlowQ = useWebReservations();
  const awaitingQ = useWebAwaitingPayment();
  const closedDraftsQ = useWebDrafts('closed', tab === 'closed');
  const closedOrdersQ = useWebClosedUnpaid(tab === 'closed');
  const filterDrafts = (rows?: WebDraftRow[]) => rows?.filter((d) => matches(search, d.web_reference, d.customer_name));
  const filterOrders = <T extends { reference: string; customer_name: string }>(rows?: T[]) =>
    rows?.filter((o) => matches(search, o.reference, o.customer_name));
  const drafts = { ...draftsQ, data: filterDrafts(draftsQ.data) };
  const oldFlow = { ...oldFlowQ, data: filterOrders(oldFlowQ.data) };
  const awaiting = { ...awaitingQ, data: filterOrders(awaitingQ.data) };
  const closedDrafts = { ...closedDraftsQ, data: filterDrafts(closedDraftsQ.data) };
  const closedOrders = { ...closedOrdersQ, data: filterOrders(closedOrdersQ.data) };

  const toConfirmCount = (drafts.data?.length ?? 0) + (oldFlow.data?.length ?? 0);
  const awaitingCount = awaiting.data?.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-gold-500/15 bg-card p-4">
        <Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p className="text-xs text-muted-foreground">
          Orders placed on the website wait here. Confirm the piece first; the customer gets the payment details
          only after that. An order moves to the Cash or Layaway list when its first payment is confirmed.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="confirm">To confirm · {toConfirmCount}</TabsTrigger>
          <TabsTrigger value="awaiting">Awaiting payment · {awaitingCount}</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
        </TabsList>

        <TabsContent value="confirm" className="mt-4">
          {drafts.isLoading || oldFlow.isLoading ? <Loading /> : drafts.isError ? (
            <EmptyLine text="Could not load website orders. Refresh the page." />
          ) : toConfirmCount === 0 ? (
            <EmptyLine text="Nothing to confirm." />
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-gold-500/15 bg-card px-4">
              {(drafts.data ?? []).map((d) => <DraftRow key={d.id} d={d} />)}
              {(oldFlow.data ?? []).map((r) => <OldFlowRow key={`${r.kind}-${r.id}`} r={r} />)}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="awaiting" className="mt-4">
          {awaiting.isLoading ? <Loading /> : awaiting.isError ? (
            <EmptyLine text="Could not load website orders. Refresh the page." />
          ) : awaitingCount === 0 ? (
            <EmptyLine text="No website order is waiting for payment." />
          ) : (
            <ul className="divide-y divide-border rounded-xl border border-gold-500/15 bg-card px-4">
              {(awaiting.data ?? []).map((o) => <AwaitingRow key={`${o.kind}-${o.id}`} o={o} />)}
            </ul>
          )}
        </TabsContent>

        <TabsContent value="closed" className="mt-4">
          {closedDrafts.isLoading || closedOrders.isLoading ? <Loading /> : (
            (closedDrafts.data?.length ?? 0) + (closedOrders.data?.length ?? 0) === 0 ? (
              <EmptyLine text="No closed website orders." />
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-gold-500/15 bg-card px-4">
                {(closedDrafts.data ?? []).map((d) => (
                  <li key={d.id} className="space-y-0.5 py-3" data-testid="park-closed">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={`/orders/review/website/${d.id}`} className="font-mono text-sm font-bold text-card-foreground hover:text-primary">{d.web_reference}</Link>
                      <span className={`${pill} border-border text-muted-foreground`}>{draftKindLabel(d)}</span>
                      {d.customer_is_test && <span className={testPill}>🧪 TEST</span>}
                    </div>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{d.customer_name} · {formatCurrency(d.total, d.currency)}</p>
                    <p className="text-xs text-muted-foreground">
                      {draftClosedLabel(d.status, d.decline_reason)}{d.decided_at ? ` · ${formatPHTDisplay(d.decided_at)}` : ''}
                    </p>
                  </li>
                ))}
                {(closedOrders.data ?? []).map((o) => (
                  <li key={`${o.kind}-${o.id}`} className="space-y-0.5 py-3" data-testid="park-closed">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link to={kindHref(o.kind, o.id)} className="font-mono text-sm font-bold text-card-foreground hover:text-primary">{o.reference}</Link>
                      <span className={`${pill} border-border text-muted-foreground`}>{o.kind === 'layaway' ? 'Layaway' : 'Full payment'}</span>
                      {o.customer_is_test && <span className={testPill}>🧪 TEST</span>}
                    </div>
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{o.customer_name} · {formatCurrency(o.total_amount, o.currency)}</p>
                    <p className="text-xs text-muted-foreground">{closedOrderLabel(o)} · placed {formatPHTDisplay(o.created_at)}</p>
                  </li>
                ))}
              </ul>
            )
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
