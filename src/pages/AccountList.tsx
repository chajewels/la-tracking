import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Search, Eye, MessageCircle } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { useAccounts } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';

const statusStyles: Record<string, string> = {
  active: 'bg-success/10 text-success border-success/20',
  completed: 'bg-primary/10 text-primary border-primary/20',
  overdue: 'bg-destructive/10 text-destructive border-destructive/20',
  cancelled: 'bg-muted text-muted-foreground border-border',
};

export default function AccountList() {
  const [search, setSearch] = useState('');
  const [filterCurrency, setFilterCurrency] = useState<Currency | 'all'>('all');
  const { data: accounts, isLoading } = useAccounts();

  const filtered = (accounts || []).filter(a => {
    const matchesSearch = a.invoice_number.includes(search) ||
      (a.customers?.full_name || '').toLowerCase().includes(search.toLowerCase());
    const matchesCurrency = filterCurrency === 'all' || a.currency === filterCurrency;
    return matchesSearch && matchesCurrency;
  });

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground font-display">Layaway Accounts</h1>
            <p className="text-sm text-muted-foreground mt-1">{(accounts || []).length} total accounts</p>
          </div>
          <Link to="/accounts/new">
            <Button className="gold-gradient text-primary-foreground font-medium">
              <Plus className="h-4 w-4 mr-1" /> New Account
            </Button>
          </Link>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by invoice or customer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 bg-card border-border"
            />
          </div>
          <div className="flex gap-1 rounded-lg border border-border p-1 bg-card">
            {(['all', 'PHP', 'JPY'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setFilterCurrency(c)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  filterCurrency === c
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {c === 'all' ? 'All' : c}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Invoice</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Customer</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Plan</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Total</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Paid</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Remaining</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="text-center px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">No accounts found</td></tr>
                ) : filtered.map((account) => (
                  <tr key={account.id} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <span className="text-sm font-semibold text-card-foreground">#{account.invoice_number}</span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-medium text-card-foreground">{account.customers?.full_name}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">{account.payment_plan_months}mo</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-sm font-medium text-card-foreground tabular-nums">
                        {formatCurrency(Number(account.total_amount), account.currency as Currency)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-sm text-success tabular-nums">
                        {formatCurrency(Number(account.total_paid), account.currency as Currency)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-sm font-semibold text-card-foreground tabular-nums">
                        {formatCurrency(Number(account.remaining_balance), account.currency as Currency)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant="outline" className={`text-[10px] ${statusStyles[account.status] || ''}`}>
                        {account.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Link to={`/accounts/${account.id}`}>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-primary">
                            <Eye className="h-4 w-4" />
                          </Button>
                        </Link>
                        {account.customers?.messenger_link && (
                          <a href={account.customers.messenger_link} target="_blank" rel="noopener noreferrer">
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-info">
                              <MessageCircle className="h-4 w-4" />
                            </Button>
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
