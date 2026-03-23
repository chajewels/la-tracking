import { useMemo } from 'react';
import { ShieldAlert, TrendingUp, Crown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router-dom';
import { useAccounts, useCustomers, AccountWithCustomer, DbCustomer } from '@/hooks/use-supabase-data';
import { Currency, RiskLevel, CLVTier, CompletionProbability } from '@/lib/types';

// ── Risk assessment ──
function assessRisk(account: AccountWithCustomer, schedules: any[]): { riskLevel: RiskLevel; score: number; maxOverdueDays: number } {
  const acctSchedules = schedules.filter(s => s.account_id === account.id);
  const today = new Date().toISOString().split('T')[0];
  const overdueItems = acctSchedules.filter(s => s.due_date < today && ['pending', 'partially_paid'].includes(s.status));

  if (overdueItems.length === 0) return { riskLevel: 'low', score: 0, maxOverdueDays: 0 };

  const oldestDueDate = overdueItems.reduce((o, s) => s.due_date < o ? s.due_date : o, overdueItems[0].due_date);
  const maxOverdueDays = Math.floor((new Date(today).getTime() - new Date(oldestDueDate).getTime()) / 86400000);

  let riskLevel: RiskLevel = 'low';
  let score = 0;

  if (maxOverdueDays < 7) {
    riskLevel = 'low'; score = Math.round((maxOverdueDays / 7) * 15);
  } else if (maxOverdueDays <= 30) {
    riskLevel = 'low'; score = 15 + Math.round(((maxOverdueDays - 7) / 23) * 18);
  } else if (maxOverdueDays <= 60) {
    riskLevel = 'medium'; score = 34 + Math.round(((maxOverdueDays - 30) / 30) * 32);
  } else {
    riskLevel = 'high'; score = 67 + Math.min(33, Math.round(((maxOverdueDays - 60) / 30) * 33));
  }

  return { riskLevel, score: Math.max(0, Math.min(100, score)), maxOverdueDays };
}

// ── CLV assessment ──
function assessCLV(customer: DbCustomer, accounts: AccountWithCustomer[]): { tier: CLVTier; score: number } {
  const custAccounts = accounts.filter(a => a.customer_id === customer.id);
  const totalPurchaseValue = custAccounts.reduce((s, a) => s + Number(a.total_amount), 0);
  const completedContracts = custAccounts.filter(a => a.status === 'completed').length;
  const activeAccts = custAccounts.filter(a => a.status === 'active' || a.status === 'overdue');
  const reliabilityScore = activeAccts.length > 0
    ? (activeAccts.reduce((s, a) => s + Number(a.total_paid) / Number(a.total_amount), 0) / activeAccts.length) * 100
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

  return { tier, score };
}

// Shared hook - only fetches schedules separately, reuses cached accounts/customers
function useAIData() {
  const { data: accounts, isLoading: aL } = useAccounts();
  const { data: customers, isLoading: cL } = useCustomers();
  const { data: schedules, isLoading: sL } = useQuery({
    queryKey: ['ai-panel-schedules'],
    staleTime: 120_000, // 2min cache
    queryFn: async () => {
      // Only fetch active/overdue account schedules for risk assessment
      const { data, error } = await supabase
        .from('layaway_schedule')
        .select('account_id, due_date, status, total_due_amount, paid_amount')
        .in('status', ['pending', 'partially_paid', 'overdue']);
      if (error) throw error;
      return data;
    },
  });
  return { accounts: accounts || [], customers: customers || [], schedules: schedules || [], isLoading: aL || cL || sL };
}

export function LatePaymentRiskPanel() {
  const { accounts, schedules, isLoading } = useAIData();

  const risks = useMemo(() => {
    const active = accounts.filter(a => a.status === 'active' || a.status === 'overdue');
    return active.map(a => ({
      accountId: a.id,
      customerId: a.customer_id,
      customerName: a.customers?.full_name || 'Unknown',
      invoice: a.invoice_number,
      ...assessRisk(a, schedules),
    })).sort((a, b) => b.score - a.score);
  }, [accounts, schedules]);

  const high = risks.filter(r => r.riskLevel === 'high');
  const medium = risks.filter(r => r.riskLevel === 'medium');
  const low = risks.filter(r => r.riskLevel === 'low');

  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <ShieldAlert className="h-4 w-4 text-destructive" />
        <h3 className="text-sm font-semibold text-card-foreground">Late Payment Risk</h3>
      </div>
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="text-center p-2 rounded-lg bg-destructive/5">
          <p className="text-xl font-bold text-destructive">{high.length}</p>
          <p className="text-[10px] text-muted-foreground">High Risk</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-warning/5">
          <p className="text-xl font-bold text-warning">{medium.length}</p>
          <p className="text-[10px] text-muted-foreground">Medium</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-success/5">
          <p className="text-xl font-bold text-success">{low.length}</p>
          <p className="text-[10px] text-muted-foreground">Low</p>
        </div>
      </div>
      {high.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">High Risk Accounts</p>
          {high.slice(0, 5).map(c => (
            <Link key={c.accountId} to={`/accounts/${c.accountId}`} className="flex items-center justify-between text-xs p-2 rounded-lg hover:bg-muted/50 transition-colors">
              <div>
                <span className="text-card-foreground font-medium">{c.customerName}</span>
                <span className="text-muted-foreground ml-1.5">#{c.invoice}</span>
              </div>
              <Badge variant="outline" className="text-[10px] text-destructive border-destructive/20">
                {c.maxOverdueDays}d · {c.score}/100
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function CompletionProbabilityPanel() {
  const { accounts, schedules, isLoading } = useAIData();

  const completions = useMemo(() => {
    const active = accounts.filter(a => a.status === 'active' || a.status === 'overdue');
    return active.map(a => {
      const progressPercent = Math.round((Number(a.total_paid) / Number(a.total_amount)) * 100);
      const risk = assessRisk(a, schedules);
      let score = Math.round((100 - risk.score) * 0.6 + progressPercent * 0.4);
      score = Math.max(0, Math.min(100, score));
      let probability: CompletionProbability = 'low';
      if (score >= 65) probability = 'high';
      else if (score >= 35) probability = 'medium';
      return { accountId: a.id, customerName: a.customers?.full_name || 'Unknown', invoice: a.invoice_number, probability, score, progressPercent };
    }).sort((a, b) => a.score - b.score);
  }, [accounts, schedules]);

  const likelyComplete = completions.filter(c => c.probability === 'high');
  const atRisk = completions.filter(c => c.probability === 'low');

  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="h-4 w-4 text-success" />
        <h3 className="text-sm font-semibold text-card-foreground">Completion Probability</h3>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="text-center p-2 rounded-lg bg-success/5">
          <p className="text-xl font-bold text-success">{likelyComplete.length}</p>
          <p className="text-[10px] text-muted-foreground">Likely Complete</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-destructive/5">
          <p className="text-xl font-bold text-destructive">{atRisk.length}</p>
          <p className="text-[10px] text-muted-foreground">At Risk</p>
        </div>
      </div>
      {atRisk.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">At-Risk Accounts</p>
          {atRisk.slice(0, 5).map(c => (
            <Link key={c.accountId} to={`/accounts/${c.accountId}`} className="flex items-center justify-between text-xs p-2 rounded-lg hover:bg-muted/50 transition-colors">
              <div>
                <span className="text-card-foreground font-medium">{c.customerName}</span>
                <span className="text-muted-foreground ml-1.5">#{c.invoice}</span>
              </div>
              <Badge variant="outline" className="text-[10px] text-warning border-warning/20">
                {c.score}% · {c.progressPercent}% paid
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export function CLVPanel() {
  const { accounts, customers, isLoading } = useAIData();

  const clvs = useMemo(() =>
    customers.map(c => ({
      customerId: c.id,
      customerName: c.full_name,
      ...assessCLV(c, accounts),
    })).sort((a, b) => b.score - a.score),
    [customers, accounts]
  );

  const vip = clvs.filter(c => c.tier === 'vip');
  const gold = clvs.filter(c => c.tier === 'gold');

  if (isLoading) return <Skeleton className="h-48 rounded-xl" />;

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-4">
        <Crown className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold text-card-foreground">Customer Value (CLV)</h3>
      </div>
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="text-center p-2 rounded-lg bg-primary/5">
          <p className="text-xl font-bold text-primary">{vip.length}</p>
          <p className="text-[10px] text-muted-foreground">VIP</p>
        </div>
        <div className="text-center p-2 rounded-lg bg-warning/5">
          <p className="text-xl font-bold text-warning">{gold.length}</p>
          <p className="text-[10px] text-muted-foreground">Gold</p>
        </div>
      </div>
      {[...vip, ...gold].slice(0, 5).length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Top Customers</p>
          {[...vip, ...gold].slice(0, 5).map(c => (
            <Link key={c.customerId} to={`/customers/${c.customerId}`} className="flex items-center justify-between text-xs p-2 rounded-lg hover:bg-muted/50 transition-colors">
              <span className="text-card-foreground font-medium">{c.customerName}</span>
              <Badge variant="outline" className={`text-[10px] ${
                c.tier === 'vip' ? 'text-primary border-primary/20' : 'text-warning border-warning/20'
              }`}>
                {c.tier.toUpperCase()} · {c.score}/100
              </Badge>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
