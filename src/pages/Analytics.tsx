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
import { Currency } from '@/lib/types';
import { getDisplayCurrencyForFilter } from '@/lib/currency-converter';
import { Link } from 'react-router-dom';
import { useAccounts, useCustomers, usePayments, useDashboardSummary, AccountWithCustomer, DbCustomer } from '@/hooks/use-supabase-data';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import {
  assessRisk,
  predictCompletion,
  assessCLV,
  isAccountActive,
  riskStyles,
  todayStr,
} from '@/lib/business-rules';

// ── Live risk assessment from real data ──
function assessRisk(account: AccountWithCustomer, payments: any[], schedules: any[]): { riskLevel: RiskLevel; score: number; recommendation: string; maxOverdueDays: number } {
  const acctSchedules = schedules.filter(s => s.account_id === account.id);
  const today = new Date().toISOString().split('T')[0];

  // Find the oldest overdue installment to determine days overdue
  const overdueItems = acctSchedules.filter(s =>
    s.due_date < today && ['pending', 'partially_paid'].includes(s.status)
  );

  if (overdueItems.length === 0) {
    return { riskLevel: 'low', score: 0, recommendation: 'On track — no overdue', maxOverdueDays: 0 };
  }

  // Calculate max days overdue from the oldest unpaid installment
  const oldestDueDate = overdueItems.reduce((oldest, s) => s.due_date < oldest ? s.due_date : oldest, overdueItems[0].due_date);
  const maxOverdueDays = Math.floor((new Date(today).getTime() - new Date(oldestDueDate).getTime()) / 86400000);

  // Risk levels based on overdue duration:
  // 7–30 days → Low Risk
  // 37–60 days → Medium Risk (1 month 1 week to 2 months)
  // 67+ days → High Risk (2 months 1 week+)
  let riskLevel: RiskLevel = 'low';
  let recommendation = 'Monitor normally';
  let score = 0;

  if (maxOverdueDays < 7) {
    // Less than 1 week — not yet risk-flagged
    riskLevel = 'low';
    score = Math.round((maxOverdueDays / 7) * 15);
    recommendation = 'Recently overdue — monitor';
  } else if (maxOverdueDays <= 30) {
    // 1 week to 1 month — Low Risk
    riskLevel = 'low';
    score = 15 + Math.round(((maxOverdueDays - 7) / 23) * 18); // 15–33
    recommendation = 'Send payment reminder';
  } else if (maxOverdueDays <= 60) {
    // 1 month 1 week to 2 months — Medium Risk
    riskLevel = 'medium';
    score = 34 + Math.round(((maxOverdueDays - 30) / 30) * 32); // 34–66
    recommendation = 'Urgent follow-up needed';
  } else {
    // 2 months 1 week+ — High Risk
    riskLevel = 'high';
    score = 67 + Math.min(33, Math.round(((maxOverdueDays - 60) / 30) * 33)); // 67–100
    recommendation = 'Escalate — restructure or collect';
  }

  score = Math.max(0, Math.min(100, score));
  return { riskLevel, score, recommendation, maxOverdueDays };
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
  const { session, loading: authLoading } = useAuth();

  const { data: accounts, isLoading: acctLoading } = useAccounts();
  const { data: customers, isLoading: custLoading } = useCustomers();
  const { data: allPayments, isLoading: payLoading } = usePayments();

  // Use dashboard-summary for predictions (handles pagination server-side)
  const { data: summary, isLoading: summaryLoading } = useDashboardSummary(
    currencyFilter,
    Boolean(session) && !authLoading,
  );

  // Paginated schedule fetch to get ALL rows (not capped at 1000)
  const { data: allSchedules } = useQuery({
    queryKey: ['all-schedules-analytics'],
    queryFn: async () => {
      const allItems: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from('layaway_schedule')
          .select('*')
          .range(from, from + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allItems.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      return allItems;
    },
  });

  // Fetch profiles + roles for CSR performance
  const { data: profilesWithRoles } = useQuery({
    queryKey: ['csr-profiles'],
    queryFn: async () => {
      const { data: profiles, error: pErr } = await supabase
        .from('profiles')
        .select('*');
      if (pErr) throw pErr;

      const { data: roles, error: rErr } = await supabase
        .from('user_roles')
        .select('*');
      if (rErr) throw rErr;

      return (profiles || []).map(p => ({
        ...p,
        role: (roles || []).find(r => r.user_id === p.user_id)?.role || 'staff',
      }));
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

  // Use server-side predictions from dashboard-summary (handles all rows, no 1000-row cap)
  const predictedRevenue = {
    day30: summary?.predicted_30d ?? 0,
    day90: summary?.predicted_90d ?? 0,
  };

  // CSR Performance from real data
  const csrPerformance = useMemo(() => {
    const staff = profilesWithRoles || [];
    const payments = (allPayments || []).filter(p => !p.voided_at);
    const accts = accounts || [];

    return staff.map(s => {
      const userPayments = payments.filter(p => p.entered_by_user_id === s.user_id);
      const totalCollected = userPayments.reduce((sum, p) => sum + Number(p.amount_paid), 0);
      const accountIds = new Set(userPayments.map(p => p.account_id));

      // Accounts created by this user
      const createdAccounts = accts.filter(a => a.created_by_user_id === s.user_id);

      // Recovery: overdue accounts that received a payment from this user
      const overdueAccountIds = new Set(
        (allSchedules || [])
          .filter(sc => sc.due_date < new Date().toISOString().split('T')[0] && ['pending', 'partially_paid'].includes(sc.status))
          .map(sc => sc.account_id)
      );
      const recoveries = userPayments.filter(p => overdueAccountIds.has(p.account_id)).length;

      return {
        userId: s.user_id,
        name: s.full_name,
        role: s.role,
        totalCollected,
        paymentCount: userPayments.length,
        accountsHandled: accountIds.size,
        accountsCreated: createdAccounts.length,
        recoveries,
      };
    }).sort((a, b) => b.totalCollected - a.totalCollected);
  }, [profilesWithRoles, allPayments, accounts, allSchedules]);

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
                      <p className="text-xs text-muted-foreground">INV #{risk.invoiceNumber} · {risk.maxOverdueDays > 0 ? `${risk.maxOverdueDays} days overdue` : 'Current'} · Score: {risk.score}/100</p>
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

          {/* CSR Performance */}
          <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-primary" /> CSR Performance
            </h3>
            {csrPerformance.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No team members yet</p>
            ) : (
              <div className="space-y-4">
                {csrPerformance.map((csr, i) => (
                  <div key={csr.userId} className="p-4 rounded-lg border border-border">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                          i === 0 ? 'gold-gradient text-primary-foreground' : 'bg-muted text-muted-foreground'
                        }`}>
                          #{i + 1}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-card-foreground">{csr.name}</p>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{csr.role}</p>
                        </div>
                      </div>
                      {i === 0 && (
                        <Badge className="gold-gradient text-primary-foreground text-[10px] border-0">Top Collector</Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-center">
                      {[
                        { label: 'Total Collected', value: `¥ ${Math.round(csr.totalCollected).toLocaleString()}` },
                        { label: 'Payments', value: csr.paymentCount },
                        { label: 'Accounts Handled', value: csr.accountsHandled },
                        { label: 'Accounts Created', value: csr.accountsCreated },
                        { label: 'Recoveries', value: csr.recoveries },
                      ].map(m => (
                        <div key={m.label} className="p-2 rounded-lg bg-muted/30">
                          <p className="text-[10px] text-muted-foreground">{m.label}</p>
                          <p className="text-sm font-bold text-card-foreground">{m.value}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
