import { useState, useMemo } from 'react';
import { BarChart3, Users, Target, TrendingUp, ShieldAlert, Sparkles, Crown, UserCheck } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import RiskBadge from '@/components/dashboard/RiskBadge';
import CLVBadge from '@/components/dashboard/CLVBadge';
import CompletionBadge from '@/components/dashboard/CompletionBadge';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/calculations';
import { Currency, RiskLevel, CLVTier, CompletionProbability } from '@/lib/types';
import { getDisplayCurrencyForFilter, toJpy } from '@/lib/currency-converter';
import { Link } from 'react-router-dom';
import { useAccounts, useCustomers, usePayments, AccountWithCustomer, DbCustomer } from '@/hooks/use-supabase-data';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { riskStyles } from '@/lib/analytics-engine';

// ── Live risk assessment from real data ──
function assessRisk(account: AccountWithCustomer, payments: any[], schedules: any[]): { riskLevel: RiskLevel; score: number; recommendation: string } {
  const acctPayments = payments.filter(p => p.account_id === account.id && !p.voided_at);
  const acctSchedules = schedules.filter(s => s.account_id === account.id);
  let score = 0;

  const progressRatio = Number(account.total_paid) / Number(account.total_amount);
  if (progressRatio === 0) score += 35;
  else if (progressRatio < 0.25) score += 20;
  else if (progressRatio >= 0.5) score -= 10;

  const overdueItems = acctSchedules.filter(s =>
    s.due_date < new Date().toISOString().split('T')[0] && ['pending', 'partially_paid'].includes(s.status)
  );
  if (overdueItems.length > 3) score += 25;
  else if (overdueItems.length > 0) score += 15;

  const balanceRatio = Number(account.remaining_balance) / Number(account.total_amount);
  if (balanceRatio > 0.8) score += 15;

  score = Math.max(0, Math.min(100, score));

  let riskLevel: RiskLevel = 'low';
  let recommendation = 'Monitor normally';
  if (score >= 50) { riskLevel = 'high'; recommendation = 'Send reminder now'; }
  else if (score >= 25) { riskLevel = 'medium'; recommendation = 'Send reminder before due'; }

  return { riskLevel, score, recommendation };
}

// ── Live CLV from real data ──
function assessCLV(customer: DbCustomer, accounts: AccountWithCustomer[], payments: any[]): { tier: CLVTier; score: number; totalPurchaseValue: number; completedContracts: number; reliabilityScore: number } {
  const custAccounts = accounts.filter(a => a.customer_id === customer.id);
  const custPayments = payments.filter(p => custAccounts.some(a => a.id === p.account_id) && !p.voided_at);

  const totalPurchaseValue = custAccounts.reduce((s, a) => s + Number(a.total_amount), 0);
  const completedContracts = custAccounts.filter(a => a.status === 'completed').length;
  const activeAccounts = custAccounts.filter(a => a.status === 'active' || a.status === 'overdue');
  const reliabilityScore = activeAccounts.length > 0
    ? (activeAccounts.reduce((s, a) => s + Number(a.total_paid) / Number(a.total_amount), 0) / activeAccounts.length) * 100
    : completedContracts > 0 ? 100 : 0;

  let score = 0;
  score += Math.min(30, totalPurchaseValue / 5000);
  score += Math.min(25, completedContracts * 12.5);
  score += reliabilityScore * 0.25;
  score += Math.min(20, custAccounts.length * 10);
  score = Math.min(100, Math.round(score));

  let tier: CLVTier = 'bronze';
  if (score >= 75) tier = 'vip';
  else if (score >= 50) tier = 'gold';
  else if (score >= 25) tier = 'silver';

  return { tier, score, totalPurchaseValue, completedContracts, reliabilityScore: Math.round(reliabilityScore) };
}

export default function Analytics() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const currency = currencyFilter === 'ALL' ? undefined : currencyFilter;
  const isAllMode = currencyFilter === 'ALL';
  const displayCurrency: Currency = getDisplayCurrencyForFilter(currencyFilter);

  const { data: accounts, isLoading: acctLoading } = useAccounts();
  const { data: customers, isLoading: custLoading } = useCustomers();
  const { data: allPayments, isLoading: payLoading } = usePayments();

  const { data: allSchedules } = useQuery({
    queryKey: ['all-schedules-analytics'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('*');
      if (error) throw error;
      return data;
    },
  });

  const isLoading = acctLoading || custLoading || payLoading;

  const activeAccounts = useMemo(() =>
    (accounts || []).filter(a => (a.status === 'active' || a.status === 'overdue') && (!currency || a.currency === currency)),
    [accounts, currency]
  );

  // Risk assessments
  const risks = useMemo(() =>
    activeAccounts.map(a => ({
      accountId: a.id,
      customerName: a.customers?.full_name || 'Unknown',
      invoiceNumber: a.invoice_number,
      currency: a.currency as Currency,
      ...assessRisk(a, allPayments || [], allSchedules || []),
    })).sort((a, b) => b.score - a.score),
    [activeAccounts, allPayments, allSchedules]
  );

  // CLV assessments
  const clvs = useMemo(() =>
    (customers || []).map(c => ({
      customerId: c.id,
      customerName: c.full_name,
      ...assessCLV(c, accounts || [], allPayments || []),
    })).sort((a, b) => b.score - a.score),
    [customers, accounts, allPayments]
  );

  // Completion predictions
  const completions = useMemo(() =>
    activeAccounts.map(a => {
      const progressPercent = Math.round((Number(a.total_paid) / Number(a.total_amount)) * 100);
      const risk = assessRisk(a, allPayments || [], allSchedules || []);
      let score = Math.round((100 - risk.score) * 0.6 + progressPercent * 0.4);
      score = Math.max(0, Math.min(100, score));
      let probability: CompletionProbability = 'low';
      if (score >= 65) probability = 'high';
      else if (score >= 35) probability = 'medium';
      return {
        accountId: a.id,
        customerName: a.customers?.full_name || 'Unknown',
        invoiceNumber: a.invoice_number,
        probability,
        score,
        progressPercent,
      };
    }).sort((a, b) => a.score - b.score),
    [activeAccounts, allPayments, allSchedules]
  );

  // Predicted revenue
  const predictedRevenue = useMemo(() => {
    let total30 = 0, total90 = 0;
    activeAccounts.forEach(a => {
      const schedules = (allSchedules || []).filter(s => s.account_id === a.id && ['pending', 'partially_paid'].includes(s.status));
      const remaining = schedules.length;
      if (remaining === 0) return;
      let monthly = Number(a.remaining_balance) / Math.max(1, remaining);
      if (isAllMode) monthly = toJpy(monthly, a.currency as Currency);
      const risk = assessRisk(a, allPayments || [], allSchedules || []);
      const factor = (100 - risk.score) / 100;
      total30 += monthly * factor;
      total90 += monthly * Math.min(3, remaining) * factor;
    });
    return { day30: Math.round(total30), day90: Math.round(total90) };
  }, [activeAccounts, allSchedules, allPayments, isAllMode]);

  const highRisk = risks.filter(r => r.riskLevel === 'high').length;
  const avgCompletion = completions.length > 0
    ? Math.round(completions.reduce((s, c) => s + c.score, 0) / completions.length) : 0;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <BarChart3 className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Analytics & Intelligence</h1>
              <p className="text-sm text-muted-foreground mt-0.5">Live predictions & customer insights</p>
            </div>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        {isLoading ? (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard title="Predicted (30d)" value={formatCurrency(predictedRevenue.day30, displayCurrency)} icon={TrendingUp} variant="gold" />
            <StatCard title="Predicted (90d)" value={formatCurrency(predictedRevenue.day90, displayCurrency)} icon={TrendingUp} />
            <StatCard title="Avg Completion" value={`${avgCompletion}%`} icon={Target} variant="success" />
            <StatCard title="High Risk" value={highRisk.toString()} subtitle="accounts" icon={ShieldAlert} variant="danger" />
            <StatCard title="Active Accounts" value={activeAccounts.length.toString()} icon={Users} />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Late Payment Risk Matrix */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-primary" /> Late Payment Risk Matrix
            </h3>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {risks.slice(0, 15).map(risk => (
                <Link key={risk.accountId} to={`/accounts/${risk.accountId}`}>
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium text-card-foreground">{risk.customerName}</p>
                        <RiskBadge level={risk.riskLevel} />
                      </div>
                      <p className="text-xs text-muted-foreground">INV #{risk.invoiceNumber} · Score: {risk.score}/100</p>
                    </div>
                    <div className="text-right">
                      <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${riskStyles[risk.riskLevel].bg} ${riskStyles[risk.riskLevel].text}`}>
                        {risk.recommendation}
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
              {risks.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No active accounts</p>}
            </div>
          </div>

          {/* Completion Predictions */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Layaway Completion Prediction
            </h3>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {completions.slice(0, 15).map(p => (
                <Link key={p.accountId} to={`/accounts/${p.accountId}`}>
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                    <div>
                      <p className="text-sm font-medium text-card-foreground">{p.customerName}</p>
                      <p className="text-xs text-muted-foreground">INV #{p.invoiceNumber}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-20">
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full gold-gradient rounded-full" style={{ width: `${p.progressPercent}%` }} />
                        </div>
                        <p className="text-[10px] text-muted-foreground text-right mt-0.5">{p.progressPercent}%</p>
                      </div>
                      <CompletionBadge probability={p.probability} />
                    </div>
                  </div>
                </Link>
              ))}
              {completions.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No active accounts</p>}
            </div>
          </div>

          {/* CLV Overview */}
          <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <Crown className="h-4 w-4 text-primary" /> Customer Lifetime Value
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto">
              {clvs.slice(0, 20).map(clv => (
                <Link key={clv.customerId} to={`/customers/${clv.customerId}`}>
                  <div className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                        {clv.customerName.charAt(0)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-card-foreground">{clv.customerName}</p>
                        <p className="text-xs text-muted-foreground">
                          {clv.completedContracts} completed · {clv.reliabilityScore}% reliability
                        </p>
                      </div>
                    </div>
                    <CLVBadge tier={clv.tier} />
                  </div>
                </Link>
              ))}
              {clvs.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No customers</p>}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
