import { useState } from 'react';
import { BarChart3, Users, Target, TrendingUp, ShieldAlert, Sparkles } from 'lucide-react';
import AppLayout from '@/components/layout/AppLayout';
import StatCard from '@/components/dashboard/StatCard';
import CurrencyToggle, { CurrencyFilter } from '@/components/dashboard/CurrencyToggle';
import RiskBadge from '@/components/dashboard/RiskBadge';
import CLVBadge from '@/components/dashboard/CLVBadge';
import CompletionBadge from '@/components/dashboard/CompletionBadge';
import { Badge } from '@/components/ui/badge';
import { mockAccounts, mockCustomers } from '@/lib/mock-data';
import {
  getAllRiskAssessments, getAllCLVAssessments, getAllCompletionPredictions,
  getPredictedRevenue, riskStyles
} from '@/lib/analytics-engine';
import { formatCurrency } from '@/lib/calculations';
import { Currency } from '@/lib/types';
import { Link } from 'react-router-dom';

const csrPerformance = [
  { name: 'CSR Alice', collections: 97049, accounts: 4, reminders: 12, recoveries: 2 },
  { name: 'CSR Bob', collections: 62134, accounts: 3, reminders: 8, recoveries: 1 },
];

export default function Analytics() {
  const [currencyFilter, setCurrencyFilter] = useState<CurrencyFilter>('ALL');
  const currency = currencyFilter === 'ALL' ? undefined : currencyFilter;
  const displayCurrency: Currency = currency || 'PHP';

  const risks = getAllRiskAssessments();
  const clvs = getAllCLVAssessments();
  const completions = getAllCompletionPredictions();

  const predicted30 = getPredictedRevenue(30, currency);
  const predicted90 = getPredictedRevenue(90, currency);

  const highRisk = risks.filter(r => r.riskLevel === 'high').length;
  const avgCompletionRate = completions.length > 0
    ? Math.round(completions.reduce((s, c) => s + c.score, 0) / completions.length)
    : 0;

  return (
    <AppLayout>
      <div className="animate-fade-in space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-3">
            <BarChart3 className="h-5 w-5 text-primary" />
            <div>
              <h1 className="text-2xl font-bold text-foreground font-display">Analytics & Intelligence</h1>
              <p className="text-sm text-muted-foreground mt-0.5">AI predictions, CSR performance & customer insights</p>
            </div>
          </div>
          <CurrencyToggle value={currencyFilter} onChange={setCurrencyFilter} />
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard title="Predicted (30d)" value={formatCurrency(predicted30, displayCurrency)} icon={TrendingUp} variant="gold" />
          <StatCard title="Predicted (90d)" value={formatCurrency(predicted90, displayCurrency)} icon={TrendingUp} />
          <StatCard title="Avg Completion" value={`${avgCompletionRate}%`} icon={Target} variant="success" />
          <StatCard title="High Risk" value={highRisk.toString()} subtitle="accounts" icon={ShieldAlert} variant="danger" />
          <StatCard title="Avg Days to Pay" value="2.3" subtitle="days after due" icon={Users} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Late Payment Risk Matrix */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-primary" /> Late Payment Risk Matrix
            </h3>
            <div className="space-y-3">
              {risks.map(risk => {
                const account = mockAccounts.find(a => a.id === risk.accountId);
                if (!account) return null;
                if (currency && account.currency !== currency) return null;
                return (
                  <Link key={risk.accountId} to={`/accounts/${risk.accountId}`}>
                    <div className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-sm font-medium text-card-foreground">{account.customer.name}</p>
                          <RiskBadge level={risk.riskLevel} />
                        </div>
                        <p className="text-xs text-muted-foreground">INV #{account.invoice_number} · Score: {risk.score}/100</p>
                      </div>
                      <div className="text-right">
                        <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] ${riskStyles[risk.riskLevel].bg} ${riskStyles[risk.riskLevel].text}`}>
                          {risk.recommendation}
                        </div>
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Layaway Completion Predictions */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Layaway Completion Prediction
            </h3>
            <div className="space-y-3">
              {completions.map(p => {
                const account = mockAccounts.find(a => a.id === p.accountId);
                if (!account) return null;
                if (currency && account.currency !== currency) return null;
                return (
                  <Link key={p.accountId} to={`/accounts/${p.accountId}`}>
                    <div className="flex items-center justify-between p-3 rounded-lg border border-border hover:border-primary/30 transition-colors">
                      <div>
                        <p className="text-sm font-medium text-card-foreground">{account.customer.name}</p>
                        <p className="text-xs text-muted-foreground">INV #{account.invoice_number}</p>
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
                );
              })}
            </div>
          </div>

          {/* CSR Performance */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">CSR Performance</h3>
            <div className="space-y-4">
              {csrPerformance.map((csr, i) => (
                <div key={csr.name} className="p-4 rounded-lg border border-border">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold ${
                        i === 0 ? 'gold-gradient text-primary-foreground' : 'bg-muted text-muted-foreground'
                      }`}>
                        #{i + 1}
                      </div>
                      <p className="text-sm font-semibold text-card-foreground">{csr.name}</p>
                    </div>
                    {i === 0 && <Badge className="gold-gradient text-primary-foreground text-[10px] border-0">Top Collector</Badge>}
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    {[
                      { label: 'Collections', value: `₱ ${csr.collections.toLocaleString()}` },
                      { label: 'Accounts', value: csr.accounts },
                      { label: 'Reminders', value: csr.reminders },
                      { label: 'Recoveries', value: csr.recoveries },
                    ].map(m => (
                      <div key={m.label}>
                        <p className="text-xs text-muted-foreground">{m.label}</p>
                        <p className="text-sm font-bold text-card-foreground">{m.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* CLV Overview */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="text-sm font-semibold text-card-foreground mb-4">Customer Lifetime Value</h3>
            <div className="space-y-3">
              {clvs.map(clv => {
                const customer = require('@/lib/mock-data').mockCustomers.find((c: any) => c.id === clv.customerId);
                if (!customer) return null;
                return (
                  <div key={clv.customerId} className="flex items-center justify-between p-3 rounded-lg border border-border">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary text-xs font-bold">
                        {customer.name.charAt(0)}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-card-foreground">{customer.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {clv.completedContracts} completed · {clv.reliabilityScore}% reliability
                        </p>
                      </div>
                    </div>
                    <CLVBadge tier={clv.tier} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
