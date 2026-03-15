import { useState } from 'react';
import { DollarSign, FileText, Users, AlertTriangle, TrendingUp, CheckCircle, ShieldAlert, Sparkles } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import AgingBuckets from '@/components/dashboard/AgingBuckets';
import RecentPayments from '@/components/dashboard/RecentPayments';
import OverdueAlerts from '@/components/dashboard/OverdueAlerts';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import RiskBadge from '@/components/dashboard/RiskBadge';
import { getDashboardStats, mockAccounts } from '@/lib/mock-data';
import { formatCurrency } from '@/lib/calculations';
import { getAllRiskAssessments, getExpectedNextMonthCollection, getPredictedRevenue } from '@/lib/analytics-engine';
import { Currency } from '@/lib/types';
import { Link } from 'react-router-dom';

export default function Dashboard() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const currency = currencyFilter === 'ALL' ? undefined : currencyFilter;
  const displayCurrency: Currency = currency || 'PHP';

  const stats = getDashboardStats(currency);
  const riskAssessments = getAllRiskAssessments();
  const highRiskCount = riskAssessments.filter(r => {
    if (r.riskLevel !== 'high') return false;
    if (!currency) return true;
    const acct = mockAccounts.find(a => a.id === r.accountId);
    return acct?.currency === currency;
  }).length;

  const nextMonth = getExpectedNextMonthCollection(currency);
  const predicted30 = getPredictedRevenue(30, currency);

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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <StatCard
            title="Total Receivables"
            value={formatCurrency(stats.totalReceivables, displayCurrency)}
            icon={DollarSign}
            variant="gold"
          />
          <StatCard
            title="Active Accounts"
            value={stats.activeAccounts.toString()}
            subtitle={currencyFilter === 'ALL' ? 'Across PHP & JPY' : `${currencyFilter} only`}
            icon={FileText}
          />
          <StatCard
            title="Collections Today"
            value={formatCurrency(stats.collectionsToday, displayCurrency)}
            icon={TrendingUp}
            variant="success"
          />
          <StatCard
            title="Expected Next Month"
            value={formatCurrency(nextMonth.adjusted, displayCurrency)}
            subtitle="Risk-adjusted"
            icon={Sparkles}
            variant="gold"
          />
          <StatCard
            title="Overdue"
            value={stats.overdueCount.toString()}
            subtitle="Requires attention"
            icon={AlertTriangle}
            variant="danger"
          />
          <StatCard
            title="Predicted (30d)"
            value={formatCurrency(predicted30, displayCurrency)}
            subtitle="Collection forecast"
            icon={TrendingUp}
            variant="success"
          />
        </div>

        {/* Late Payment Risk Summary */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-primary" />
              Late Payment Risk Predictions
            </h3>
            <Link to="/monitoring" className="text-xs text-primary hover:underline">View all →</Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {riskAssessments.slice(0, 6).map(risk => {
              const account = mockAccounts.find(a => a.id === risk.accountId);

              if (!account) return null;
              if (currency && account.currency !== currency) return null;
              return (
                <Link key={risk.accountId} to={`/accounts/${risk.accountId}`}>
                  <div className="p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium text-card-foreground">{account.customer.name}</p>
                      <RiskBadge level={risk.riskLevel} />
                    </div>
                    <p className="text-xs text-muted-foreground">INV #{account.invoice_number}</p>
                    <p className="text-[10px] text-muted-foreground mt-1">{risk.recommendation}</p>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <RecentPayments />
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
