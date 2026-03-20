import { useState } from 'react';
import { DollarSign, FileText, AlertTriangle, TrendingUp, CheckCircle2, Banknote, Users, ShieldAlert } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import OverdueAlerts from '@/components/dashboard/OverdueAlerts';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import GeoBreakdown from '@/components/dashboard/GeoBreakdown';
import OperationsPanel from '@/components/dashboard/OperationsPanel';
import LiveCollectionTracker from '@/components/dashboard/LiveCollectionTracker';
import { LatePaymentRiskPanel, CompletionProbabilityPanel, CLVPanel } from '@/components/dashboard/AIRiskPanel';
import SystemHealthPanel from '@/components/dashboard/SystemHealthPanel';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { useAccounts, useCustomers, useDashboardSummary } from '@/hooks/use-supabase-data';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';

export default function Dashboard() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const { session, loading: authLoading } = useAuth();
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(
    currencyFilter,
    Boolean(session) && !authLoading,
  );
  const { data: accounts } = useAccounts();
  const { data: customers } = useCustomers();

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

        {/* ROW 1 — Executive Summary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-8 gap-4">
          {summaryLoading ? (
            [...Array(7)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          ) : (
            <>
              <StatCard
                title="Total Customers"
                value={(customers?.length ?? 0).toString()}
                subtitle="All registered"
                icon={Users}
              />
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
                title="Collections This Month"
                value={formatCurrency(summary?.collections_this_month ?? 0, displayCurrency)}
                icon={Banknote}
                variant="success"
              />
              <StatCard
                title="Overdue"
                value={(summary?.overdue_accounts ?? 0).toString()}
                subtitle={formatCurrency(summary?.overdue_amount ?? 0, displayCurrency)}
                icon={AlertTriangle}
                variant="danger"
              />
              <StatCard
                title="Completed This Month"
                value={(summary?.completed_this_month ?? 0).toString()}
                subtitle="Closed deals"
                icon={CheckCircle2}
                variant="success"
              />
              <StatCard
                title="Forfeited"
                value={(summary?.forfeited_accounts ?? 0).toString()}
                subtitle="Inactive accounts"
                icon={ShieldAlert}
                variant="danger"
              />
            </>
          )}
        </div>

        {/* ROW 2 — Geo Breakdown */}
        <GeoBreakdown accounts={accounts || []} customers={customers || []} />

        {/* ROW 3 — Operations + Live Collection */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <OperationsPanel summary={summary} displayCurrency={displayCurrency} />
          <LiveCollectionTracker currencyFilter={currencyFilter} displayCurrency={displayCurrency} />
        </div>

        {/* ROW 4 — AI & Predictions */}
        <div>
          <p className="text-xs font-semibold text-primary uppercase tracking-widest mb-3">AI & Predictions</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <LatePaymentRiskPanel />
            <CompletionProbabilityPanel />
            <CLVPanel />
          </div>
        </div>

        {/* ROW 5 — Aging + Overdue + System Health */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <AgingBuckets currency={displayCurrency} />
          <OverdueAlerts />
          <SystemHealthPanel summary={summary} />
        </div>
      </div>
    </AppLayout>
  );
}
