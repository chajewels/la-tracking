import { Users, MessageCircle } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { useCustomers, useAccounts } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router-dom';

export default function Customers() {
  const { data: customers, isLoading } = useCustomers();
  const { data: accounts } = useAccounts();

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Customers</h1>
            <p className="text-sm text-muted-foreground mt-0.5">{(customers || []).length} registered customers</p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Customer</th>
                  <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Contact</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Accounts</th>
                  <th className="text-center px-5 py-3 text-xs font-semibold text-muted-foreground uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(customers || []).length === 0 ? (
                  <tr><td colSpan={4} className="px-5 py-8 text-center text-sm text-muted-foreground">No customers found</td></tr>
                ) : (customers || []).map(c => {
                  const accountCount = (accounts || []).filter(a => a.customer_id === c.id).length;
                  const activeAccount = (accounts || []).find(a => a.customer_id === c.id && a.status === 'active');
                  return (
                    <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3">
                        <Link to={`/customers/${c.id}`} className="flex items-center gap-3 group">
                          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">
                            {c.full_name.charAt(0)}
                          </div>
                          <div>
                            <p className="text-sm font-medium text-card-foreground group-hover:text-primary transition-colors">{c.full_name}</p>
                            {c.facebook_name && <p className="text-xs text-muted-foreground">@{c.facebook_name}</p>}
                          </div>
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-sm text-muted-foreground">{c.mobile_number || '—'}</td>
                      <td className="px-5 py-3 text-center text-sm text-card-foreground">{accountCount}</td>
                      <td className="px-5 py-3 text-center">
                        {c.messenger_link && (
                          <a href={c.messenger_link} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-info">
                              <MessageCircle className="h-4 w-4" />
                            </Button>
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
