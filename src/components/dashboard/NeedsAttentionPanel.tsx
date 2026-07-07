import { AlertTriangle, Eye, MessageCircle, Timer } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import type { AttentionCashRow, AttentionScheduleRow } from '@/hooks/useDashboardExtras';

/**
 * "Needs Attention" — replaced the former OverdueAlerts component,
 * deleted in Phase 5 (same
 * view_overdue_alerts gate). Two urgency-ordered groups:
 *   1. Overdue / due-soon layaway installments (schedule_with_actuals,
 *      due_date ascending = most-overdue first). Days-overdue is display
 *      date arithmetic only — statuses come from the DB.
 *   2. Pending cash orders by soonest expiry (cash_orders.expires_at — the
 *      DP-deadline concept; expiry itself is enforced by the
 *      auto-expire-cash-orders cron, never computed here).
 * Every row deep-links to its record. Presentational — data via props.
 */

interface NeedsAttentionPanelProps {
  scheduleRows: AttentionScheduleRow[] | undefined;
  cashRows: AttentionCashRow[] | undefined;
  loading: boolean;
}

function daysFromToday(dateStr: string): number {
  const target = new Date(`${dateStr.slice(0, 10)}T00:00:00`);
  return Math.floor((Date.now() - target.getTime()) / 86400000);
}

export default function NeedsAttentionPanel({ scheduleRows, cashRows, loading }: NeedsAttentionPanelProps) {
  const schedule = scheduleRows ?? [];
  const cash = cashRows ?? [];
  const empty = !loading && schedule.length === 0 && cash.length === 0;

  return (
    <div className="rounded-xl border border-warning/25 bg-card p-5">
      <div className="flex items-center gap-2 pb-3 hairline-b mb-4">
        <AlertTriangle className="h-4 w-4 text-warning" />
        <h3 className="text-sm font-semibold text-card-foreground">Needs Attention</h3>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
      ) : empty ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          Nothing needs attention — no overdue installments or expiring cash orders. Well done. ✨
        </p>
      ) : (
        <div className="space-y-4">
          {schedule.length > 0 && (
            <section aria-label="Overdue and due-soon layaway installments">
              <p className="label-caps mb-2">Overdue &amp; due soon</p>
              <div className="space-y-2">
                {schedule.map(item => {
                  const account = item.layaway_accounts;
                  const customer = account?.customers;
                  const days = daysFromToday(item.due_date);
                  const urgencyLabel =
                    days > 0 ? `${days} day${days === 1 ? '' : 's'} overdue`
                    : days === 0 ? 'Due today'
                    : `Due in ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`;
                  return (
                    <div key={item.id} className="flex items-center justify-between gap-2 p-3 rounded-lg bg-destructive/5 border border-destructive/10">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-card-foreground truncate">{customer?.full_name || 'Unknown'}</p>
                        <p className="text-xs text-muted-foreground">
                          INV #{account?.invoice_number} · Due {new Date(`${item.due_date.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                        </p>
                        <p className={`text-xs font-medium mt-0.5 ${days >= 0 ? 'text-destructive' : 'text-warning'}`}>{urgencyLabel}</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm font-semibold text-card-foreground tabular-nums">
                          {formatCurrency(Number(item.actual_remaining ?? 0), item.currency as Currency)}
                        </span>
                        {customer?.messenger_link && (
                          <a href={customer.messenger_link} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" aria-label="Message customer">
                              <MessageCircle className="h-4 w-4" />
                            </Button>
                          </a>
                        )}
                        {account?.id && (
                          <Link to={`/accounts/${account.id}`}>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" aria-label={`Open account ${account.invoice_number}`}>
                              <Eye className="h-4 w-4" />
                            </Button>
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {cash.length > 0 && (
            <section aria-label="Cash orders nearing expiry">
              <p className="label-caps mb-2">Cash orders expiring</p>
              <div className="space-y-2">
                {cash.map(order => {
                  const days = order.expires_at ? -daysFromToday(order.expires_at) : null;
                  const urgencyLabel =
                    days === null ? 'No expiry set'
                    : days < 0 ? 'Expiry passed — pending auto-expire'
                    : days === 0 ? 'Expires today'
                    : `Expires in ${days} day${days === 1 ? '' : 's'}`;
                  return (
                    <div key={order.id} className="flex items-center justify-between gap-2 p-3 rounded-lg bg-warning/5 border border-warning/15">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-card-foreground truncate">{order.customers?.full_name || 'Unknown'}</p>
                        <p className="text-xs text-muted-foreground">INV #{order.invoice_number} · Cash order</p>
                        <p className="text-xs font-medium mt-0.5 text-warning flex items-center gap-1">
                          <Timer className="h-3 w-3" /> {urgencyLabel}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-sm font-semibold text-card-foreground tabular-nums">
                          {formatCurrency(Number(order.remaining_balance), order.currency as Currency)}
                        </span>
                        <Link to={`/cash-orders/${order.id}`}>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary" aria-label={`Open cash order ${order.invoice_number}`}>
                            <Eye className="h-4 w-4" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
