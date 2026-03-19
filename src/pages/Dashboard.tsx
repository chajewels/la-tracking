import { useState } from 'react';
import { DollarSign, FileText, AlertTriangle, TrendingUp, Sparkles, ShieldAlert } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import RecentPayments from '@/components/dashboard/RecentPayments';
import OverdueAlerts from '@/components/dashboard/OverdueAlerts';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import RiskBadge from '@/components/dashboard/RiskBadge';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { Link } from 'react-router-dom';
import { useAccounts, useDashboardSummary } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';

export default function Dashboard() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(currencyFilter);
  const { data: accounts } = useAccounts();

  const activeAccounts = (accounts || []).filter(a => a.status === 'active');

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-1">Overview</p>
            <h1 className="text-2xl font-bold text-foreground font-display">Dashboard</h1>
            <p className="text-sm text-muted-foreground mt-1">Cha Jewels · Layaway Payment Management</p>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {summaryLoading ? (
            <>
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </>
          ) : (
            <>
              <StatCard
                title="Total Receivables"
                value={formatCurrency(summary?.total_receivables ?? 0, displayCurrency)}
                icon={DollarSign}
                variant="gold"
              />
              <StatCard
                title="Active Accounts"
                value={(summary?.active_layaways ?? 0).toString()}
                subtitle={currencyFilter === 'ALL' ? 'PHP & JPY (in ¥)' : `${currencyFilter} only`}
                icon={FileText}
              />
              <StatCard
                title="Collections Today"
                value={formatCurrency(summary?.payments_today ?? 0, displayCurrency)}
                icon={TrendingUp}
                variant="success"
              />
              <StatCard
                title="Overdue"
                value={(summary?.overdue_accounts ?? 0).toString()}
                subtitle="Requires attention"
                icon={AlertTriangle}
                variant="danger"
              />
            </>
          )}
        </div>

        {/* Active Accounts Quick View */}
        {activeAccounts.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-primary" />
                Active Layaway Accounts
              </h3>
              <Link to="/accounts" className="text-xs text-primary hover:underline">View all →</Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {activeAccounts.slice(0, 6).map(account => {
                const currency = currencyFilter !== 'ALL' && account.currency !== currencyFilter ? null : account.currency;
                if (currencyFilter !== 'ALL' && account.currency !== currencyFilter) return null;
                return (
                  <Link key={account.id} to={`/accounts/${account.id}`}>
                    <div className="p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-card-foreground">{account.customers?.full_name}</p>
                      </div>
                      <p className="text-xs text-muted-foreground">INV #{account.invoice_number}</p>
                      <p className="text-xs font-semibold text-card-foreground mt-1">
                        {formatCurrency(Number(account.remaining_balance), account.currency as Currency)}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <RecentPayments currencyFilter={currencyFilter} />
          </div>
          <div className="space-y-6">
            <AgingBuckets currency={displayCurrency} />
            <OverdueAlerts />
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
