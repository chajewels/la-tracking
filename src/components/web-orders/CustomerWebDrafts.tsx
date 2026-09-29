import { Link } from 'react-router-dom';
import { Hourglass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/calculations';
import { formatReservationAge } from '@/lib/web-reservations';
import { draftKindLabel } from '@/lib/web-park';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useWebDrafts } from '@/hooks/use-web-park';

/**
 * Customer page (website orders PR 5, W2-8): this customer's website orders
 * still to confirm. Renders nothing when there are none, or for a role that
 * cannot confirm website orders (the draft tables are readable only by them).
 */
export default function CustomerWebDrafts({ customerId }: { customerId: string }) {
  const allowed = usePermissions().can('confirm_web_order_ready');
  const { data: drafts = [] } = useWebDrafts('open', allowed, customerId);
  if (!allowed || drafts.length === 0) return null;

  return (
    <div className="rounded-2xl border border-warning/40 bg-card p-4 sm:p-5" data-testid="customer-web-drafts">
      <div className="mb-2 flex items-center gap-2">
        <Hourglass className="h-4 w-4 text-warning" />
        <h2 className="font-deco text-lg font-semibold text-champagne">Website orders to confirm</h2>
      </div>
      <ul className="divide-y divide-border">
        {drafts.map((d) => (
          <li key={d.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-bold text-card-foreground">{d.web_reference}</span>
                <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{draftKindLabel(d)}</span>
                <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning">Website — to confirm</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {formatCurrency(d.total, d.currency)}{d.shipping_pending ? ' before shipping' : ''} · waiting {formatReservationAge(d.created_at)}
              </p>
            </div>
            <Button asChild size="sm" className="gold-gradient text-xs text-primary-foreground">
              <Link to={`/orders/review/website/${d.id}`}>Review</Link>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
