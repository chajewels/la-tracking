import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

const INTERVAL = 30_000;

interface ExecData {
  portfolioValue: number;
  grossProfit: { active_gross_profit: number; lifetime_gross_profit: number } | null;
  monthlyInflow: { installment_inflow: number; penalty_inflow: number; total_inflow: number } | null;
  netExposure: { gross_exposure: number; dp_retained: number; penalties_collected: number; estimated_resale: number; net_exposure: number } | null;
  coverageRatio: { cash_in: number; inventory_cost: number; coverage_ratio: number; status_label: string } | null;
  atRisk: { total_at_risk: number; critical_count: number; active_total: number; at_risk_pct: number } | null;
  atRiskDetail: any[];
  penaltyRevenue: { current_month_jpy: number; cumulative_jpy: number } | null;
  planPerformance: any[];
  cohortTimeline: any[];
  lastUpdated: Date;
  loading: boolean;
}

interface FinancialAlert {
  id: string;
  severity: string;
  message: string;
  created_at: string;
}

export function useExecutiveDashboard(): ExecData {
  const [data, setData] = useState<ExecData>({
    portfolioValue: 0,
    grossProfit: null,
    monthlyInflow: null,
    netExposure: null,
    coverageRatio: null,
    atRisk: null,
    atRiskDetail: [],
    penaltyRevenue: null,
    planPerformance: [],
    cohortTimeline: [],
    lastUpdated: new Date(),
    loading: true,
  });

  const fetchAll = useCallback(async () => {
    try {
      const [
        pv, gp, mi, ne, cr, ar, ard, pr, pp, ct,
      ] = await Promise.all([
        supabase.rpc('fc_portfolio_value' as any),
        supabase.rpc('fc_gross_profit' as any),
        supabase.rpc('fc_monthly_inflow' as any),
        supabase.rpc('fc_net_exposure_risk' as any),
        supabase.rpc('fc_coverage_ratio' as any),
        supabase.rpc('fc_at_risk_accounts' as any),
        supabase.rpc('fc_at_risk_detail' as any),
        supabase.rpc('fc_penalty_revenue' as any),
        supabase.rpc('fc_plan_performance' as any),
        supabase.rpc('fc_cohort_timeline' as any),
      ]);

      setData({
        portfolioValue: Number(pv.data) || 0,
        grossProfit: gp.data as any,
        monthlyInflow: mi.data as any,
        netExposure: ne.data as any,
        coverageRatio: cr.data as any,
        atRisk: ar.data as any,
        atRiskDetail: Array.isArray(ard.data) ? ard.data : [],
        penaltyRevenue: pr.data as any,
        planPerformance: Array.isArray(pp.data) ? pp.data : [],
        cohortTimeline: Array.isArray(ct.data) ? ct.data : [],
        lastUpdated: new Date(),
        loading: false,
      });
    } catch (err) {
      console.error('[ExecDashboard] fetch error:', err);
      setData(prev => ({ ...prev, loading: false }));
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, INTERVAL);
    return () => clearInterval(id);
  }, [fetchAll]);

  return data;
}

export function useMonthlyInflowByPlan() {
  const [data, setData] = useState<any[]>([]);

  const fetch = useCallback(async () => {
    const now = new Date();
    const sixAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    const startDate = sixAgo.toISOString().split('T')[0];

    const { data: rows } = await supabase
      .from('payments')
      .select('amount_paid, date_paid, currency, layaway_accounts!inner(payment_plan_months, invoice_number)')
      .is('voided_at', null)
      .gte('date_paid', startDate)
      .not('layaway_accounts.invoice_number', 'like', 'TEST-%');

    if (!rows) { setData([]); return; }

    const { data: rateRow } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'php_jpy_rate')
      .single();
    const rate = rateRow ? Number(JSON.parse(String(rateRow.value))) : 0.42;

    const buckets = new Map<string, Map<number, number>>();
    for (const p of rows as any[]) {
      const month = p.date_paid.substring(0, 7);
      const plan = p.layaway_accounts?.payment_plan_months ?? 0;
      const jpy = p.currency === 'JPY' ? Number(p.amount_paid) : Math.round(Number(p.amount_paid) / rate);
      if (!buckets.has(month)) buckets.set(month, new Map());
      const m = buckets.get(month)!;
      m.set(plan, (m.get(plan) || 0) + jpy);
    }

    setData(
      [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, planMap]) => {
          const d = new Date(month + '-01');
          const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
          const row: Record<string, any> = { label };
          for (const [plan, amount] of planMap) row[`plan_${plan}`] = amount;
          return row;
        })
    );
  }, []);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, INTERVAL);
    return () => clearInterval(id);
  }, [fetch]);

  return data;
}

export function useActiveByPlan() {
  const [data, setData] = useState<{ plan: number; count: number; pct: number }[]>([]);

  const fetch = useCallback(async () => {
    const { data: rows } = await supabase
      .from('layaway_accounts')
      .select('payment_plan_months')
      .in('status', ['active', 'overdue'])
      .not('invoice_number', 'like', 'TEST-%');

    if (!rows) { setData([]); return; }

    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.payment_plan_months, (counts.get(r.payment_plan_months) || 0) + 1);
    const total = rows.length || 1;

    setData(
      [...counts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([plan, count]) => ({ plan, count, pct: Math.round((count / total) * 100) }))
    );
  }, []);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, INTERVAL);
    return () => clearInterval(id);
  }, [fetch]);

  return data;
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
