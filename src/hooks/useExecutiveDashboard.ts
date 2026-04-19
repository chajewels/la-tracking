import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

const REFRESH_INTERVAL = 30_000;

export function useIsExecAdmin() {
  return useQuery({
    queryKey: ['exec-admin-check'],
    staleTime: 300_000,
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return false;
      const { data: roleData } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', session.user.id)
        .eq('role', 'admin')
        .maybeSingle();
      return !!roleData;
    },
  });
}

interface PlanConfig {
  plan_months: number;
  display_label: string;
  risk_tier: string;
  min_amount_jpy: number;
}

interface FinancialAlert {
  id: string;
  severity: string;
  message: string;
  created_at: string;
}

function toJpyWithRate(amount: number, currency: string, rate: number): number {
  if (currency === 'JPY') return Math.round(amount);
  return Math.round(amount / rate);
}

export function useConversionRate() {
  return useQuery({
    queryKey: ['exec-php-jpy-rate'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'php_jpy_rate')
        .single();
      if (error) throw error;
      return Number(JSON.parse(String(data.value)));
    },
  });
}

export function usePlanConfigurations() {
  return useQuery<PlanConfig[]>({
    queryKey: ['exec-plan-configs'],
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('plan_configurations' as any)
        .select('plan_months, display_label, risk_tier, min_amount_jpy')
        .order('plan_months', { ascending: true });
      if (error) throw error;
      return (data || []) as PlanConfig[];
    },
  });
}

export function useFinancialAlerts() {
  const [alerts, setAlerts] = useState<FinancialAlert[]>([]);

  useEffect(() => {
    const fetchAlerts = async () => {
      const { data } = await supabase
        .from('financial_alerts' as any)
        .select('id, severity, message, created_at')
        .is('resolved_at', null)
        .order('created_at', { ascending: false });
      if (data) setAlerts(data as FinancialAlert[]);
    };
    fetchAlerts();

    const channel = supabase
      .channel('financial-alerts-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'financial_alerts' }, () => {
        fetchAlerts();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return alerts;
}

export function useActiveAccounts(rate: number | undefined) {
  return useQuery({
    queryKey: ['exec-active-accounts'],
    enabled: rate != null,
    refetchInterval: REFRESH_INTERVAL,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('layaway_accounts')
        .select('id, currency, total_amount, remaining_balance, payment_plan_months, status')
        .in('status', ['active', 'overdue', 'extension_active', 'final_settlement', 'forfeited'])
        .not('invoice_number', 'like', 'TEST-%');
      if (error) throw error;
      return data || [];
    },
  });
}

export function useMonthlyPayments(rate: number | undefined) {
  return useQuery({
    queryKey: ['exec-monthly-payments'],
    enabled: rate != null,
    refetchInterval: REFRESH_INTERVAL,
    queryFn: async () => {
      const now = new Date();
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      const startDate = sixMonthsAgo.toISOString().split('T')[0];

      const { data, error } = await supabase
        .from('payments')
        .select('amount_paid, date_paid, currency, account_id, layaway_accounts!inner(payment_plan_months, invoice_number)')
        .is('voided_at', null)
        .gte('date_paid', startDate)
        .not('layaway_accounts.invoice_number', 'like', 'TEST-%');
      if (error) throw error;
      return (data || []) as any[];
    },
  });
}

export function useKPIs(
  accounts: any[] | undefined,
  payments: any[] | undefined,
  rate: number | undefined,
) {
  if (!accounts || !rate) {
    return { portfolioValue: 0, grossProfit: 0, monthlyInflow: 0, netExposure: 0 };
  }

  const activeOnly = accounts.filter(a => a.status === 'active' || a.status === 'overdue');
  const exposureStatuses = ['active', 'overdue', 'forfeited', 'extension_active', 'final_settlement'];
  const exposureAccounts = accounts.filter(a => exposureStatuses.includes(a.status));

  const portfolioValue = activeOnly.reduce(
    (s, a) => s + toJpyWithRate(Number(a.remaining_balance), a.currency, rate), 0
  );
  const grossProfit = Math.round(
    activeOnly.reduce((s, a) => s + toJpyWithRate(Number(a.total_amount), a.currency, rate), 0) * 0.15
  );
  const netExposure = exposureAccounts.reduce(
    (s, a) => s + toJpyWithRate(Number(a.remaining_balance), a.currency, rate), 0
  );

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const monthlyInflow = (payments || [])
    .filter(p => p.date_paid >= monthStart)
    .reduce((s, p) => s + toJpyWithRate(Number(p.amount_paid), p.currency, rate), 0);

  return { portfolioValue, grossProfit, monthlyInflow, netExposure };
}

export function useMonthlyInflowByPlan(
  payments: any[] | undefined,
  rate: number | undefined,
) {
  if (!payments || !rate) return [];

  const buckets = new Map<string, Map<number, number>>();

  for (const p of payments) {
    const month = p.date_paid.substring(0, 7);
    const planMonths = (p.layaway_accounts as any)?.payment_plan_months ?? 0;
    if (!buckets.has(month)) buckets.set(month, new Map());
    const planMap = buckets.get(month)!;
    planMap.set(planMonths, (planMap.get(planMonths) || 0) + toJpyWithRate(Number(p.amount_paid), p.currency, rate));
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, planMap]) => {
      const d = new Date(month + '-01');
      const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      const row: Record<string, any> = { label };
      for (const [plan, amount] of planMap) {
        row[`plan_${plan}`] = amount;
      }
      return row;
    });
}

export function useActiveByPlan(accounts: any[] | undefined) {
  if (!accounts) return [];
  const activeOnly = accounts.filter(a => a.status === 'active' || a.status === 'overdue');
  const counts = new Map<number, number>();
  for (const a of activeOnly) {
    const pm = a.payment_plan_months || 0;
    counts.set(pm, (counts.get(pm) || 0) + 1);
  }
  const total = activeOnly.length || 1;
  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([plan, count]) => ({
      plan,
      count,
      pct: Math.round((count / total) * 100),
    }));
}

export function usePlanPerformance(
  accounts: any[] | undefined,
  payments: any[] | undefined,
  planConfigs: PlanConfig[] | undefined,
  rate: number | undefined,
) {
  if (!accounts || !planConfigs || !rate) return [];

  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const activeOnly = accounts.filter(a => a.status === 'active' || a.status === 'overdue');

  return planConfigs.map(cfg => {
    const planAccounts = activeOnly.filter(a => a.payment_plan_months === cfg.plan_months);
    const count = planAccounts.length;
    const portfolio = planAccounts.reduce(
      (s, a) => s + toJpyWithRate(Number(a.remaining_balance), a.currency, rate), 0
    );
    const totalAmount = planAccounts.reduce(
      (s, a) => s + toJpyWithRate(Number(a.total_amount), a.currency, rate), 0
    );
    const avgTicket = count > 0 ? Math.round(totalAmount / count) : 0;
    const grossProfit = Math.round(totalAmount * 0.15);
    const monthlyInflow = (payments || [])
      .filter(p => {
        const pm = (p.layaway_accounts as any)?.payment_plan_months;
        return pm === cfg.plan_months && p.date_paid >= monthStart;
      })
      .reduce((s, p) => s + toJpyWithRate(Number(p.amount_paid), p.currency, rate), 0);

    return {
      ...cfg,
      count,
      portfolio,
      avgTicket,
      monthlyInflow,
      grossProfit,
    };
  });
}
