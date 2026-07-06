import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import AccountList from '@/pages/AccountList';
import CashOrdersList from '@/components/customers/CashOrdersList';
import {
  buildAccountFixtures,
  buildCashOrderFixtures,
  buildQuickViewFixture,
} from './fixtures';

/**
 * DEV-only preview harness (/__fixtures) used for Playwright screenshot
 * verification without real credentials or a live Supabase session.
 *
 * It seeds the react-query cache with deterministic fixtures under the
 * exact keys the real components read (['accounts'], ['cash-orders'],
 * ['account-quickview', id]) and then renders the REAL components — no
 * component code is forked for testing. Never registered in production
 * builds (see the import.meta.env.DEV guard in App.tsx).
 *
 *   /__fixtures                → AccountList with fixture data
 *   /__fixtures?view=cash      → CashOrdersList with fixture data
 *   /__fixtures?empty=1        → empty-state variant
 */
export default function FixturePreview() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') === 'cash' ? 'cash' : 'accounts';
  const empty = searchParams.get('empty') === '1';

  // Seed once, before the lists mount, so their queries hit fresh cache.
  useState(() => {
    const accounts = empty ? [] : buildAccountFixtures();
    const cashOrders = empty ? [] : buildCashOrderFixtures();
    const seed = (key: unknown[], data: unknown) => {
      queryClient.setQueryDefaults(key, { staleTime: Infinity, gcTime: Infinity, retry: false });
      queryClient.setQueryData(key, data);
    };
    seed(['accounts'], accounts);
    seed(['cash-orders'], cashOrders);
    for (const a of accounts) {
      seed(['account-quickview', a.id], buildQuickViewFixture());
    }
    return null;
  });

  return view === 'cash' ? <CashOrdersList /> : <AccountList />;
}
