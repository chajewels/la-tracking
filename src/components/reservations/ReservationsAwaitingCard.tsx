import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Hourglass } from 'lucide-react';
import { formatCurrency } from '@/lib/calculations';
import { formatPHTDisplay } from '@/lib/date-utils';
import {
  RESERVATION_REMIND_HOURS, formatReservationAge, reservationAgeHours, reservationAutoCancelAt, reservationKindLabel,
} from '@/lib/web-reservations';
import { useWebReservations } from '@/hooks/use-supabase-data';
import { usePermissions } from '@/contexts/PermissionsContext';
import ReservationActions from './ReservationActions';
import { useWebDrafts } from '@/hooks/use-web-park';
import { draftKindLabel } from '@/lib/web-park';
import { Button } from '@/components/ui/button';
import { DeclineDraftButton } from '@/components/web-orders/WebOrdersPark';

/**
 * Dashboard: every web reservation waiting for staff, OLDEST FIRST, with its
 * age, the moment it auto-cancels, and Confirm / Can't supply inline
 * (reserve-first A2). Renders nothing when the queue is empty — with
 * web_reservation_mode off it always is, so the Dashboard is unchanged.
 *
 * Website orders PR 5: website DRAFTS are listed first (Review opens the
 * review screen; Can't supply declines), then any reservation from the old
 * reserve-first flow. The sidebar pill now lands on Sales → Website orders;
 * id="reservations" stays for old links.
 */
export default function ReservationsAwaitingCard() {
  const { can } = usePermissions();
  const allowed = can('confirm_web_order_ready');
  const { data: rows = [] } = useWebReservations(allowed);
  const { data: drafts = [] } = useWebDrafts('open', allowed);
  const total = rows.length + drafts.length;
  const location = useLocation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (location.hash === '#reservations' && total > 0) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [location.hash, total]);

  if (!allowed || total === 0) return null;

  return (
    <div id="reservations" ref={ref} className="scroll-mt-4 rounded-xl border-2 border-warning/60 bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center gap-2">
        <Hourglass className="h-5 w-5 text-warning" />
        <h2 className="font-deco text-xl font-semibold text-champagne">
          Website orders to confirm
        </h2>
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-bold text-warning tabular-nums">
          {total}
        </span>
        <Link to="/sales?tab=web" className="ml-auto text-xs text-muted-foreground hover:text-primary">
          Open Website orders →
        </Link>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        These customers checked out on the website and are waiting for us. They have no payment details
        until you confirm the piece. Each one cancels itself 72 hours after checkout.
      </p>
      <ul className="divide-y divide-border">
        {drafts.map((d) => {
          const overdue = reservationAgeHours(d.created_at) >= RESERVATION_REMIND_HOURS;
          const cancelAt = reservationAutoCancelAt(d.created_at);
          return (
            <li key={`draft-${d.id}`} className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={`/orders/review/website/${d.id}`} className="font-mono text-sm font-bold text-card-foreground hover:text-primary">
                    {d.web_reference}
                  </Link>
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {draftKindLabel(d)}
                  </span>
                  {d.shipping_pending && (
                    <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">Shipping to add</span>
                  )}
                  {d.customer_is_test && (
                    <span className="rounded-md border border-info/20 bg-info/10 px-1.5 py-0.5 text-[10px] font-bold text-info">🧪 TEST</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {d.customer_name} · {formatCurrency(d.total, d.currency)}{d.shipping_pending ? ' before shipping' : ''}
                </p>
                <p className={`text-xs ${overdue ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                  Waiting {formatReservationAge(d.created_at)}
                  {cancelAt && <> · auto-cancels {formatPHTDisplay(cancelAt)}</>}
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
        })}
        {rows.map((r) => {
          const hours = reservationAgeHours(r.created_at);
          const overdue = hours >= RESERVATION_REMIND_HOURS;
          const cancelAt = reservationAutoCancelAt(r.created_at);
          const href = r.kind === 'layaway' ? `/accounts/${r.id}` : `/cash-orders/${r.id}`;
          return (
            <li key={`${r.kind}-${r.id}`} className="flex flex-col gap-3 py-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Link to={href} className="font-mono text-sm font-bold text-card-foreground hover:text-primary">
                    {r.reference}
                  </Link>
                  <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {reservationKindLabel(r.kind)}
                  </span>
                  {r.customer_is_test && (
                    <span className="rounded-md border border-info/20 bg-info/10 px-1.5 py-0.5 text-[10px] font-bold text-info">🧪 TEST</span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {r.customer_name} · {formatCurrency(r.total_amount, r.currency)}
                  {r.plan_months ? ` over ${r.plan_months} months` : ''}
                </p>
                <p className={`text-xs ${overdue ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                  Waiting {formatReservationAge(r.created_at)}
                  {cancelAt && <> · auto-cancels {formatPHTDisplay(cancelAt)}</>}
                </p>
              </div>
              <ReservationActions entityType={r.kind} entityId={r.id} reference={r.reference} compact />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
