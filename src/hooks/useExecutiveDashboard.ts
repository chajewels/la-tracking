import { useCallback, useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const INTERVAL = 30_000;

interface ExecData {
  portfolioValue: number;
  grossProfit: { active_gross_profit: number; lifetime_gross_profit: number } | null;
  monthlyInflow: { installment_inflow: number; penalty_inflow: number; total_inflow: number } | null;
  netExposure: { gross_exposure: number; dp_retained: number; penalties_collected: number; estimated_resale: number; net_exposure: number; prior_month_exposure: number; exposure_change: number; healthy_exposure: number; at_risk_exposure: number; critical_exposure: number; delta_healthy: number; delta_at_risk: number; delta_critical: number; delta_pct: number } | null;
  coverageRatio: { cash_in: number; inventory_cost: number; coverage_ratio: number; status_label: string; funding_gap: number; days_covered: number; projected_inflow_30d: number; projected_coverage_30d: number; projected_funding_gap: number } | null;
  atRisk: { total_at_risk: number; critical_count: number; active_total: number; at_risk_pct: number } | null;
  atRiskDetail: any[];
  penaltyRevenue: { current_month_jpy: number; cumulative_jpy: number; penalty_pct_of_inflow: number } | null;
  penaltyDriven: { penalty_driven_count: number; pct_of_active: number; penalty_revenue_contribution: number } | null;
  planPerformance: any[];
  cohortTimeline: any[];
  cfoInsights: CfoInsight[];
  lastUpdated: Date;
  loading: boolean;
}

interface CfoInsight {
  priority: number;
  category: string;
  observation: string;
  implication: string;
  action: string;
  impact_magnitude: number;
  primary_driver: string;
  req_accounts_8m: number | null;
  req_accounts_10m: number | null;
}


interface FinancialAlert {
  id: string;
  severity: string;
  message: string;
  created_at: string;
}

const EMPTY_EXEC_DATA: Omit<ExecData, 'loading'> = {
  portfolioValue: 0,
  grossProfit: null,
  monthlyInflow: null,
  netExposure: null,
  coverageRatio: null,
  atRisk: null,
  atRiskDetail: [],
  penaltyRevenue: null,
  penaltyDriven: null,
  planPerformance: [],
  cohortTimeline: [],
  cfoInsights: [],
  lastUpdated: new Date(),
};

// Exported so usePrefetchHeavyPages can warm the same cache key at app
// idle. The hook below consumes this object unchanged (plus its 30s
// refetchInterval). React Query conversion (2026-07-07): the former
// hand-rolled useEffect fetch had NO cache — every visit refetched all 12
// RPCs behind one loading flag, so the slowest query gated every card.
// The Promise.all is verbatim; only the cache policy around it changed.
export const executiveDashboardQueryOptions = {
  queryKey: ['executive-dashboard'] as const,
  staleTime: 120_000,
  placeholderData: keepPreviousData,
  queryFn: async (): Promise<Omit<ExecData, 'loading'>> => {
      const [pv, gp, mi, ne, cr, ar, ard, pr, pd, pp, ct, ci] = await Promise.all([
        supabase.rpc('fc_portfolio_value' as any),
        supabase.rpc('fc_gross_profit' as any),
        supabase.rpc('fc_monthly_inflow' as any),
        supabase.rpc('fc_net_exposure_risk' as any),
        supabase.rpc('fc_coverage_ratio' as any),
        supabase.rpc('fc_at_risk_accounts' as any),
        supabase.rpc('fc_at_risk_detail' as any),
        supabase.rpc('fc_penalty_revenue' as any),
        supabase.rpc('fc_penalty_driven_accounts' as any),
        supabase.rpc('fc_plan_performance' as any),
        supabase.rpc('fc_cohort_timeline' as any),
        supabase.rpc('fc_cfo_insights' as any),
      ]);

      return {
        portfolioValue: Number(pv.data ?? 0),
        grossProfit: {
          active_gross_profit: Number(gp.data?.[0]?.active_gross_profit ?? 0),
          lifetime_gross_profit: Number(gp.data?.[0]?.lifetime_gross_profit ?? 0),
        },
        monthlyInflow: {
          installment_inflow: Number(mi.data?.[0]?.installment_inflow ?? 0),
          penalty_inflow: Number(mi.data?.[0]?.penalty_inflow ?? 0),
          total_inflow: Number(mi.data?.[0]?.total_inflow ?? 0),
        },
        netExposure: {
          gross_exposure: Number(ne.data?.[0]?.gross_exposure ?? 0),
          dp_retained: Number(ne.data?.[0]?.dp_retained ?? 0),
          penalties_collected: Number(ne.data?.[0]?.penalties_collected ?? 0),
          estimated_resale: Number(ne.data?.[0]?.estimated_resale ?? 0),
          net_exposure: Number(ne.data?.[0]?.net_exposure ?? 0),
          prior_month_exposure: Number(ne.data?.[0]?.prior_month_exposure ?? 0),
          exposure_change: Number(ne.data?.[0]?.exposure_change ?? 0),
          healthy_exposure: Number(ne.data?.[0]?.healthy_exposure ?? 0),
          at_risk_exposure: Number(ne.data?.[0]?.at_risk_exposure ?? 0),
          critical_exposure: Number(ne.data?.[0]?.critical_exposure ?? 0),
          delta_healthy: Number(ne.data?.[0]?.delta_healthy ?? 0),
          delta_at_risk: Number(ne.data?.[0]?.delta_at_risk ?? 0),
          delta_critical: Number(ne.data?.[0]?.delta_critical ?? 0),
          delta_pct: Number(ne.data?.[0]?.delta_pct ?? 0),
        },
        coverageRatio: {
          cash_in: Number(cr.data?.[0]?.cash_in ?? 0),
          inventory_cost: Number(cr.data?.[0]?.inventory_cost ?? 0),
          coverage_ratio: Number(cr.data?.[0]?.coverage_ratio ?? 0),
          status_label: cr.data?.[0]?.status_label ?? 'CRITICAL',
          funding_gap: Number(cr.data?.[0]?.funding_gap ?? 0),
          days_covered: Number(cr.data?.[0]?.days_covered ?? 0),
          projected_inflow_30d: Number(cr.data?.[0]?.projected_inflow_30d ?? 0),
          projected_coverage_30d: Number(cr.data?.[0]?.projected_coverage_30d ?? 0),
          projected_funding_gap: Number(cr.data?.[0]?.projected_funding_gap ?? 0),
        },
        atRisk: {
          total_at_risk: Number(ar.data?.[0]?.total_at_risk ?? 0),
          critical_count: Number(ar.data?.[0]?.critical_count ?? 0),
          active_total: Number(ar.data?.[0]?.active_total ?? 0),
          at_risk_pct: Number(ar.data?.[0]?.at_risk_pct ?? 0),
        },
        atRiskDetail: ard.data ?? [],
        penaltyRevenue: {
          current_month_jpy: Number(pr.data?.[0]?.current_month_jpy ?? 0),
          cumulative_jpy: Number(pr.data?.[0]?.cumulative_jpy ?? 0),
          penalty_pct_of_inflow: Number(pr.data?.[0]?.penalty_pct_of_inflow ?? 0),
        },
        penaltyDriven: {
          penalty_driven_count: Number(pd.data?.[0]?.penalty_driven_count ?? 0),
          pct_of_active: Number(pd.data?.[0]?.pct_of_active ?? 0),
          penalty_revenue_contribution: Number(pd.data?.[0]?.penalty_revenue_contribution ?? 0),
        },
        planPerformance: pp.data ?? [],
        cohortTimeline: ct.data ?? [],
        cfoInsights: (ci.data ?? []) as CfoInsight[],
        lastUpdated: new Date(),
      };
  },
};

export function useExecutiveDashboard(): ExecData {
  const { data, isLoading } = useQuery({
    ...executiveDashboardQueryOptions,
    refetchInterval: INTERVAL,
  });

  return { ...(data ?? EMPTY_EXEC_DATA), loading: isLoading && !data };
}

export function useMonthlyInflowByPlan() {
  const [data, setData] = useState<any[]>([]);

  const fetchData = useCallback(async () => {
    const { data: rows, error } = await supabase.rpc('monthly_inflow_by_plan_6m');

    if (error || !rows) { setData([]); return; }

    // Pivot pre-aggregated rows into chart shape: one row per month with plan_X columns.
    const byMonth = new Map<string, Record<string, any>>();
    for (const r of rows as Array<{ month: string; payment_plan_months: number; jpy_total: number }>) {
      if (!byMonth.has(r.month)) {
        const d = new Date(r.month + '-01');
        const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        byMonth.set(r.month, { label });
      }
      byMonth.get(r.month)![`plan_${r.payment_plan_months}`] = Number(r.jpy_total);
    }

    setData(
      [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([_, row]) => row)
    );
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, INTERVAL);
    return () => clearInterval(id);
  }, [fetchData]);

  return data;
}

export function useActiveByPlan() {
  const [data, setData] = useState<{ plan: number; count: number; pct: number }[]>([]);

  const fetchData = useCallback(async () => {
    const { data: rows } = await supabase
      .from('layaway_accounts')
      .select('payment_plan_months')
      .in('status', ['active', 'overdue'])
      .eq('is_test', false);

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
    fetchData();
    const id = setInterval(fetchData, INTERVAL);
    return () => clearInterval(id);
  }, [fetchData]);

  return data;
}

export function useFinancialAlerts() {
  const [alerts, setAlerts] = useState<FinancialAlert[]>([]);

  useEffect(() => {
    let isMounted = true;

    const fetchAlerts = async () => {
      const { data } = await supabase
        .from('financial_alerts')
        .select('*')
        .is('resolved_at', null)
        .order('created_at', { ascending: false });
      if (isMounted) {
        const rows = (data ?? []) as FinancialAlert[];
        const seen = new Set<string>();
        const deduped = rows.filter(r => {
          if (seen.has(r.id)) return false;
          seen.add(r.id);
          return true;
        });
        setAlerts(deduped);
      }
    };

    fetchAlerts();

    const channel = supabase
      .channel('exec-alerts')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'financial_alerts',
      }, () => { fetchAlerts(); })
      .subscribe();

    return () => {
      isMounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  return alerts;
}
