import { useState, useMemo } from 'react';
import { ROUTES } from '@/constants/routes';
import { DollarSign, FileText, AlertTriangle, TrendingUp, CheckCircle2, Banknote, Users, ShieldAlert, Gem, Award, Flame } from 'lucide-react';
import PendingSubmissionsAlert from '@/components/dashboard/PendingSubmissionsAlert';
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
import { usePermissions } from '@/contexts/PermissionsContext';

export default function Dashboard() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const { session, loading: authLoading, profile } = useAuth();
  const { can, canAccessPage } = usePermissions();
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);
  const canSeePendingSubmissions = canAccessPage('/payment-submissions');

  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(
    currencyFilter,
    Boolean(session) && !authLoading,
  );
  // Only load accounts/customers if needed by visible widgets
  const needsGeo = can('view_geo_breakdown');
  const { data: accounts } = useAccounts();
  const { data: customers } = useCustomers();
  // Note: accounts/customers are cached with staleTime so these calls are cheap when already loaded

  const customerCount = customers?.length ?? 0;

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }, []);

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-8">
        {/* Welcome Banner */}
        <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-card via-card to-primary/5 p-6 sm:p-8">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/3 blur-3xl" />
          <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl gold-gradient shadow-lg">
                <Gem className="h-6 w-6 text-primary-foreground" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-bold text-foreground font-display">
                  {greeting}, {profile?.full_name?.split(' ')[0] || 'there'}
                </h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Cha Jewels · Layaway Payment Management
                </p>
              </div>
            </div>
            <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
          </div>
        </div>

        {/* KPI Cards */}
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Key Metrics</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-4 gap-3 sm:gap-4">
            {summaryLoading ? (
              [...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
            ) : (
              <>
                <StatCard
                  title="Total Customers"
                  value={customerCount.toString()}
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
                  subtitle={currencyFilter === 'ALL' ? 'PHP & JPY' : `${currencyFilter} only`}
                  icon={FileText}
                />
                <StatCard
                  title="Collections Today"
                  value={formatCurrency(summary?.payments_today ?? 0, displayCurrency)}
                  icon={TrendingUp}
                  variant="success"
                />
              </>
            )}
          </div>
        </div>

        {canSeePendingSubmissions && <PendingSubmissionsAlert />}

        {/* Secondary KPIs */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
          {summaryLoading ? (
            [...Array(6)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          ) : (
            <>
              <StatCard
                title="This Month"
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
                href={`${ROUTES.MONITORING}?filter=overdue`}
              />
              <StatCard
                title="Completed"
                value={(summary?.completed_this_month ?? 0).toString()}
                subtitle="This month"
                icon={CheckCircle2}
                variant="success"
                href={`${ROUTES.ACCOUNTS}?status=completed`}
              />
              <StatCard
                title="Forfeited"
                value={(summary?.forfeited_accounts ?? 0).toString()}
                subtitle="Inactive"
                icon={ShieldAlert}
                variant="danger"
                href={`${ROUTES.ACCOUNTS}?status=forfeited`}
              />
              <StatCard
                title="Forfeited Today"
                value={(summary?.forfeited_today ?? 0).toString()}
                icon={Flame}
                variant="warning"
                href={`${ROUTES.ACCOUNTS}?status=forfeited&period=today`}
              />
              <StatCard
                title="All Time Completed"
                value={(summary?.completed_all_time ?? 0).toString()}
                subtitle="All time"
                icon={Award}
                variant="success"
                href={`${ROUTES.ACCOUNTS}?status=completed`}
              />
            </>
          )}
        </div>

        {/* Geo Breakdown */}
        {needsGeo && (
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Regional Overview</p>
          <GeoBreakdown accounts={accounts || []} customers={customers || []} />
        </div>
        )}

        {/* Operations + Live Collection */}
        {(can('view_operations_panel') || can('view_live_collection')) && (
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">Operations & Activity</p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {can('view_operations_panel') && <OperationsPanel summary={summary} displayCurrency={displayCurrency} />}
            {can('view_live_collection') && <LiveCollectionTracker currencyFilter={currencyFilter} displayCurrency={displayCurrency} />}
          </div>
        </div>
        )}

        {/* AI & Predictions */}
        {can('view_ai_risk') && (
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">AI & Predictions</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <LatePaymentRiskPanel />
            <CompletionProbabilityPanel />
            <CLVPanel />
          </div>
        </div>
        )}

        {/* Aging + Overdue + System Health */}
        <div>
          <p className="text-[10px] font-semibold text-primary uppercase tracking-widest mb-3">System Overview</p>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {can('view_aging_buckets') && <AgingBuckets currency={displayCurrency} />}
            {can('view_overdue_alerts') && <OverdueAlerts />}
            {can('view_system_health') && <SystemHealthPanel summary={summary} />}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
