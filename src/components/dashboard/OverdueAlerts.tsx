import { AlertTriangle, MessageCircle, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { Link } from 'react-router-dom';
import { useAccounts, useSchedule } from '@/hooks/use-supabase-data';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export default function OverdueAlerts() {
  // Fetch overdue/upcoming schedule items
  const { data: overdueItems } = useQuery({
    queryKey: ['overdue-schedule'],
    queryFn: async () => {
      const today = new Date().toISOString().split('T')[0];
      const threeDaysFromNow = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];

      // Get overdue or due-soon schedule items
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*, layaway_accounts!inner(*, customers(*))')
        .in('status', ['pending', 'overdue', 'partially_paid'])
        .in('layaway_accounts.status', ['active', 'overdue'])
        .lte('due_date', threeDaysFromNow)
        .order('due_date', { ascending: true })
        .limit(5);
      if (error) throw error;
      return data;
    },
  });

  const items = overdueItems || [];

  return (
    <div className="rounded-xl border border-destructive/20 bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <h3 className="text-sm font-semibold text-card-foreground">Overdue & Due Soon</h3>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No overdue items</p>
      ) : (
        <div className="space-y-3">
          {items.map((item: any) => {
            const account = item.layaway_accounts;
            const customer = account?.customers;
            const dueDate = new Date(item.due_date);
            const today = new Date();
            const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / 86400000);
            const currency = item.currency as Currency;

            return (
              <div key={item.id} className="flex items-center justify-between p-3 rounded-lg bg-destructive/5 border border-destructive/10">
                <div>
                  <p className="text-sm font-medium text-card-foreground">{customer?.full_name || 'Unknown'}</p>
                  <p className="text-xs text-muted-foreground">
                    INV #{account?.invoice_number} · Due {dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </p>
                  <p className="text-xs font-medium text-destructive mt-0.5">
                    {daysOverdue > 0 ? `${daysOverdue} days overdue` : daysOverdue === 0 ? 'Due today' : `Due in ${Math.abs(daysOverdue)} days`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-card-foreground tabular-nums">
                    {formatCurrency(Number(item.total_due_amount), currency)}
                  </span>
                  {customer?.messenger_link && (
                    <a href={customer.messenger_link} target="_blank" rel="noopener noreferrer">
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                        <MessageCircle className="h-4 w-4" />
                      </Button>
                    </a>
                  )}
                  {account?.id && (
                    <Link to={`/accounts/${account.id}`}>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                        <Eye className="h-4 w-4" />
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
