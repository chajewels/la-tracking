import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import AccountList from '@/pages/AccountList';
import Dashboard from '@/pages/Dashboard';
import CashOrdersList from '@/components/customers/CashOrdersList';
import KpiStrip from '@/components/dashboard/KpiStrip';
import NeedsAttentionPanel from '@/components/dashboard/NeedsAttentionPanel';
import { getPHTToday } from '@/lib/date-utils';
import {
  buildAccountFixtures,
  buildCashOrderFixtures,
  buildQuickViewFixture,
  buildDashboardSummary,
  buildMonthlyAnalytics,
  buildRedemptionsKpi,
  buildAttentionSchedule,
  buildAttentionCash,
  buildCustomerFixtures,
} from './fixtures';

/**
 * DEV-only preview harness (/__fixtures) used for Playwright screenshot
 * verification without real credentials or a live Supabase session.
 *
 * It seeds the react-query cache with deterministic fixtures under the
 * exact keys the real components read and then renders the REAL components
 * — no component code is forked for testing. Never registered in
 * production builds (see the import.meta.env.DEV guard in App.tsx).
 *
 *   /__fixtures                     → AccountList
 *   /__fixtures?view=cash           → CashOrdersList
 *   /__fixtures?view=dashboard      → Dashboard (full page, seeded)
 *   /__fixtures?view=attention      → NeedsAttentionPanel (perm-gated on the
 *                                     real page, so shot standalone here)
 *   /__fixtures?view=kpi-loading    → KPI strip + panel skeleton states
 *   &empty=1                        → empty-state variant of any view
 */
export default function FixturePreview() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') ?? 'accounts';
  const empty = searchParams.get('empty') === '1';

  // Seed once, before the components mount, so their queries hit fresh cache.
  useState(() => {
    const accounts = empty ? [] : buildAccountFixtures();
    const cashOrders = empty ? [] : buildCashOrderFixtures();
    const seed = (key: unknown[], data: unknown) => {
      queryClient.setQueryDefaults(key, { staleTime: Infinity, gcTime: Infinity, retry: false });
      queryClient.setQueryData(key, data);
    };
    seed(['accounts'], accounts);
    seed(['accounts-light'], accounts);
    seed(['cash-orders'], cashOrders);
    seed(['customers'], buildCustomerFixtures(empty));
    seed(['dashboard-summary', 'ALL'], buildDashboardSummary(empty));
    seed(['monthly-analytics', getPHTToday()], buildMonthlyAnalytics(empty));
    seed(['dashboard-redemptions-kpi'], buildRedemptionsKpi(empty));
    seed(['needs-attention-schedule'], buildAttentionSchedule(empty));
    seed(['needs-attention-cash'], buildAttentionCash(empty));
    for (const a of accounts) {
      seed(['account-quickview', a.id], buildQuickViewFixture());
    }
    return null;
  });

  if (view === 'cash') return <CashOrdersList />;
  if (view === 'dashboard') return <Dashboard />;
  if (view === 'attention') {
    return (
      <div className="max-w-xl p-6">
        <NeedsAttentionPanel
          scheduleRows={buildAttentionSchedule(empty) as never}
          cashRows={buildAttentionCash(empty) as never}
          loading={false}
        />
      </div>
    );
  }
  if (view === 'kpi-loading') {
    return (
      <div className="space-y-6 p-6">
        <KpiStrip
          summaryLoading
          activeLayaways={undefined}
          collectionsThisMonth={undefined}
          overdueCount={undefined}
          overdueAmount={undefined}
          displayCurrency="JPY"
          accounts={undefined}
          collectedRows={undefined}
          redemptions={undefined}
          redemptionsUnavailable={false}
        />
        <div className="max-w-xl">
          <NeedsAttentionPanel scheduleRows={undefined} cashRows={undefined} loading />
        </div>
      </div>
    );
  }
  return <AccountList />;
}
