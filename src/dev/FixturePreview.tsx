import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Route, Routes, useSearchParams } from 'react-router-dom';
import AccountList from '@/pages/AccountList';
import HubRouteShim from './HubRouteShim';
import Dashboard from '@/pages/Dashboard';
import AccountDetail from '@/pages/AccountDetail';
import CashOrdersList from '@/components/customers/CashOrdersList';
import KpiStrip from '@/components/dashboard/KpiStrip';
import NeedsAttentionPanel from '@/components/dashboard/NeedsAttentionPanel';
import PaymentTimeline, { CashOrderTimeline } from '@/components/accounts/PaymentTimeline';
import PostLoginSplash from '@/components/auth/PostLoginSplash';
import FloatingField from '@/components/forms/FloatingField';
import CurrencyInput from '@/components/forms/CurrencyInput';
import TypedConfirmField from '@/components/forms/TypedConfirmField';
import GeoBreakdown from '@/components/dashboard/GeoBreakdown';
import { EmptyState, ErrorState } from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { FileText, AlertTriangle } from 'lucide-react';
import ProgressRing from '@/components/shared/ProgressRing';
import PortalBottomNav, { type PortalTab } from '@/components/portal/shared/PortalBottomNav';
import AnimatedNumber from '@/components/portal/shared/AnimatedNumber';
import HeroLayawayCard from '@/components/portal/home/HeroLayawayCard';
import TierStrip from '@/components/portal/home/TierStrip';
import PaymentJourneyTimeline, { buildJourneyEntries } from '@/components/portal/detail/PaymentJourneyTimeline';
import ItemizedTotals from '@/components/portal/detail/ItemizedTotals';
import CompletedPlanBanner from '@/components/portal/detail/CompletedPlanBanner';
import AccountStatementSheet from '@/components/portal/statements/AccountStatementSheet';
import OfflineBanner from '@/components/portal/shared/OfflineBanner';
import RecentActivity from '@/components/loyalty/RecentActivity';
import HomeScreen from '@/components/loyalty/screens/HomeScreen';
import LoyaltyBottomNav, { type LoyaltyTab } from '@/components/loyalty/LoyaltyBottomNav';
import { LoyaltyComingSoon } from '@/components/loyalty/LoyaltyComingSoon';
import { LoyaltyJoinPrompt } from '@/components/loyalty/LoyaltyJoinPrompt';
import RedemptionForm from '@/components/loyalty/RedemptionForm';
import TierCelebrationModal from '@/components/loyalty/TierCelebrationModal';
import {
  setLoyaltyData,
  TIER_STATIC,
  type TierName,
  type LoyaltyMemberData,
  type LoyaltyTierData,
  type LoyaltyTransactionData,
} from '@/components/loyalty/loyaltyData';
import TierCard from '@/components/customers/TierCard';
import AccountStatement from '@/components/statements/AccountStatement';
import { getPHTToday } from '@/lib/date-utils';
import ProductDialog from '@/components/website/ProductDialog';
import { emptyProduct, emptyVariant, type ProductForm } from '@/components/website/product-form';
import DataTable, { type DataTableColumn } from '@/components/data-table/DataTable';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PermissionsContextForFixtures, usePermissions } from '@/contexts/PermissionsContext';
import ReservationsAwaitingCard from '@/components/reservations/ReservationsAwaitingCard';
import ReservationPanel from '@/components/reservations/ReservationPanel';
import DeadlinesCard from '@/components/accounts/DeadlinesCard';
import ReassignOwnerFixture from './ReassignOwnerFixture';
import { ReservationModeCard } from '@/components/website/ReservationModeCard';
import { RESERVATION_MODE_KEY } from '@/components/website/reservation-mode';
import { AuthContext, useAuth } from '@/contexts/AuthContext';
import type { ReactNode } from 'react';
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
  buildTimelineFixture,
  buildTierFixtures,
  buildPaymentFixtures,
  buildCashPaymentFixtures,
} from './fixtures';
import {
  buildProofIndexFixtures,
  buildSubmissionAllocationFixtures,
  buildWaiverFixtures,
  PAYMENT_METHOD_FIXTURES,
  stubProofStorage,
  submissionCacheEntries,
} from './sales-fixtures';
import { supabase } from '@/integrations/supabase/client';
import {
  buildCustomerCashOrderFixtures,
  buildCustomerDetailFixture,
  buildCustomerDirectoryFixtures,
  buildCustomerTierMap,
  DEMO_CUSTOMER_ID,
} from './customer-fixtures';

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
 *   /__fixtures?view=hub&at=/        → real shell + pages at real paths
 *                                     (in-memory router; sidebar nav works;
 *                                     every permission granted)
 *     &reservations=1               → two layaway plans + two cash orders
 *                                     become unconfirmed web reservations
 *   /__fixtures?view=hub&at=/sales?tab=payments  (or tab=waivers)
 *                                   → Sales → Payments / Waivers, seeded from
 *                                     sales-fixtures.ts (proof thumbnails are
 *                                     drawn locally — no storage session)
 *   /__fixtures?view=hub&at=/customers  → Customers directory (Phase 3)
 *   /__fixtures?view=hub&at=/customers/fixture-cust-demo[?tab=cash]
 *                                   → a fully populated customer page
 *   /__fixtures?view=cash           → CashOrdersList
 *   /__fixtures?view=dashboard      → Dashboard (full page, seeded)
 *   /__fixtures?view=attention      → NeedsAttentionPanel (perm-gated on the
 *                                     real page, so shot standalone here)
 *   /__fixtures?view=kpi-loading    → KPI strip + panel skeleton states
 *   /__fixtures?view=product-dialog → Website Catalog ProductDialog (long form)
 *   /__fixtures?view=datatable      → DataTable with expandable rows
 *   /__fixtures?view=tabs           → Tabs primitive (sliding indicator)
 *   /__fixtures?view=reassign-owner → ReassignOwnerDialog (layaway catch-up, cash born expired, refused)
 *   /__fixtures/<account-id>?view=account-detail
 *                                   → AccountDetail for a seeded account
 *                                     (summary tiles; empty schedule/payments)
 *   /__fixtures?view=hub&roles=staff[,admin]
 *                                   → the Hub signed in as that role mix (header +
 *                                     sidebar footer role label)
 *   /__fixtures?view=reservations   → reserve-first A2: Dashboard card,
 *                                     detail-page panels, DeadlinesCard
 *   /__fixtures?view=reservations-dashboard
 *                                   → Dashboard + sidebar "To confirm" pill
 *   /__fixtures?view=reservations-cash
 *                                   → CashOrdersList with reservations
 *   /__fixtures?view=reservation-mode[&on=1][&waiting=N][&role=staff]
 *                                   → Website → Settings reserve-first switch card
 *                                     (admin by default; role=staff = read-only)
 *   (the three reservations views grant every permission — the UI is gated
 *    on confirm_web_order_ready, and a fixture has no session)
 *   &empty=1                        → empty-state variant of any view
 */
export default function FixturePreview() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view') ?? 'accounts';
  const empty = searchParams.get('empty') === '1';
  // Hub shim only: &reservations=1 turns a few seeded orders into website
  // reservations awaiting confirmation. Off (the default) mirrors the live
  // web_reservation_mode switch being FALSE — the queue is empty.
  const hubReservations = view === 'hub' && searchParams.get('reservations') === '1';

  // Seed once, before the components mount, so their queries hit fresh cache.
  useState(() => {
    const accounts = empty ? [] : buildAccountFixtures();
    const cashOrders = empty ? [] : buildCashOrderFixtures();
    // Before any seed: several seeds copy these rows.
    if (hubReservations) markHubReservations(accounts as unknown as Array<Record<string, unknown>>, cashOrders as unknown as Array<Record<string, unknown>>);
    const seed = (key: unknown[], data: unknown) => {
      queryClient.setQueryDefaults(key, { staleTime: Infinity, gcTime: Infinity, retry: false });
      queryClient.setQueryData(key, data);
    };
    seed(['accounts'], accounts);
    seed(['accounts-light'], accounts);
    seed(['cash-orders'], cashOrders);
    for (const o of cashOrders) {
      seed(['cash-order', o.id], { ...o, customer_id: o.customers.id, loyalty_jpy_amount: null, expires_at: null, expired_at: null, completed_at: null, notes: null });
      seed(['cash-payments', o.id], buildCashPaymentFixtures(o));
      for (const k of ['cash-submissions', 'cash-order-notes', 'cash-order-items']) seed([k, o.id], []);
    }
    // Customers (Phase 3): the directory, its lookups, and one full customer
    // page at /customers/fixture-cust-demo (hub view).
    seed(['customers'], buildCustomerDirectoryFixtures(empty));
    seed(['cash-orders-light'], cashOrders.map((o) => ({ id: o.id, customer_id: o.customers.id, status: o.status })));
    seed(['customers-loyalty-tiers'], empty ? new Map() : buildCustomerTierMap());
    if (!empty) {
      // &test_customer=1 flags the demo customer is_test, to show the TEST tag.
      const detail = buildCustomerDetailFixture();
      seed(['customer-detail', DEMO_CUSTOMER_ID], searchParams.get('test_customer') === '1'
        ? { ...detail, customer: { ...detail.customer, is_test: true } }
        : detail);
      seed(['cash-orders-by-customer', DEMO_CUSTOMER_ID], buildCustomerCashOrderFixtures());
    }
    seed(['dashboard-summary', 'ALL'], buildDashboardSummary(empty));
    seed(['monthly-analytics', getPHTToday()], buildMonthlyAnalytics(empty));
    seed(['dashboard-redemptions-kpi'], buildRedemptionsKpi(empty));
    seed(['needs-attention-schedule'], buildAttentionSchedule(empty));
    seed(['needs-attention-cash'], buildAttentionCash(empty));
    // Reserve-first A2: the queue the sidebar pill and Dashboard card read.
    seed(
      ['web-reservations'],
      empty ? []
        : view === 'hub' ? (hubReservations ? hubReservationQueue(accounts, cashOrders) : [])
        : buildReservationFixtures(),
    );
    // Sidebar footer health pills. The harness has no backend, so unseeded they
    // always read "unknown"; &health=unseeded shows that state on purpose.
    if (searchParams.get('health') !== 'unseeded') {
      const now = new Date().toISOString();
      seed(['email-health', 24], { status: 'ok', last_sent_at: now, generated_at: now });
      seed(['portal-token-health', 60], { status: 'ok', expiring_in_window: 0, expiring_in_window_with_live_plan: 0, generated_at: now });
    }
    // Page365 stock (2026-09-26): the four-line acceptance invoice — matched,
    // sold on the website, no code, resize. Hub view: /website?tab=page365-stock,
    // /page365/review/fixture-p365-draft, and the first cash order's page.
    if (!empty) {
      const p365 = buildPage365StockFixtures(cashOrders[0]?.id ?? 'fixture-cash');
      seed(['page365-stock-flags', false], p365.lines.filter((l) => l.flag));
      seed(['page365-stock-flags', true], p365.lines.filter((l) => l.flag));
      seed(['page365-stock-lines', 'cash', cashOrders[0]?.id], p365.lines);
      seed(['page365-draft', 'fixture-p365-draft'], p365.draft);
      // Page365 inventory fetch (2026-09-27): one complete run covering every
      // review group — Website → Page365 stock, hub view. &inv=partial shows
      // an incomplete read (nothing tickable).
      const inv = buildPage365InventoryFixtures(searchParams.get('inv') === 'partial');
      seed(['page365-inventory-run'], inv.run);
      seed(['page365-inventory-items', inv.run.id], inv.items);
      // PR 2: Website → Catalog, N4020 switched to "Don't sync with Page365"
      // (open it to see the switch) next to an ordinary synced piece.
      seed(['website-products'], buildCatalogSyncFixtures());
    }
    if (view === 'reservations-cash') seed(['cash-orders'], [...buildReservationCashRows(), ...cashOrders]);
    if (view === 'reservation-mode') {
      const admin = searchParams.get('role') !== 'staff';
      seed([...RESERVATION_MODE_KEY], {
        enabled: searchParams.get('on') === '1',
        updated_at: '2026-09-24T01:15:00Z',
        updated_by_user_id: 'fixture-admin',
        updated_by_name: 'Cynthia Largo',
        can_change: admin,
        awaiting_total: Number(searchParams.get('waiting') ?? 0),
      });
    }
    // Sales → Payments / Waivers (Phase 2B). Same keys the real pages read.
    stubProofStorage(supabase.storage as never);
    const subs = submissionCacheEntries();
    for (const [filter, rows] of Object.entries(subs)) {
      const shown = empty ? [] : rows;
      seed(['payment-submissions', filter], shown);
      seed(['submission-allocations', shown.map((r) => r.id)], empty ? [] : buildSubmissionAllocationFixtures());
    }
    seed(['payment-methods-active'], PAYMENT_METHOD_FIXTURES);
    seed(['pending-submission-count'], empty ? 0 : subs.pending.length);
    seed(['submission-proofs-all'], empty ? [] : buildProofIndexFixtures());
    const waivers = empty ? [] : buildWaiverFixtures();
    seed(['waivers-page', 'pending'], waivers.filter((w) => w.status === 'pending'));
    seed(['waivers-page', 'all'], waivers);
    seed(['waiver-request-pending-count'], waivers.filter((w) => w.status === 'pending').length);
    for (const a of accounts) {
      seed(['account-quickview', a.id], buildQuickViewFixture());
      seed(['account', a.id], a);
      for (const k of ['schedule', 'penalties', 'account-services', 'account-notes']) seed([k, a.id], []);
      seed(['payments', a.id], buildPaymentFixtures(a));
    }
    return null;
  });

  if (view === 'hub') {
    const roles = searchParams.get('roles')?.split(',').map((r) => r.trim()).filter(Boolean);
    return <AllowAll><HubRouteShim at={searchParams.get('at') ?? '/'} roles={roles} /></AllowAll>;
  }
  if (view === 'cash') return <CashOrdersList />;
  if (view === 'reservations') return <AllowAll><ReservationsFixture /></AllowAll>;
  if (view === 'reservations-dashboard') return <AllowAll><Dashboard /></AllowAll>;
  if (view === 'reservations-cash') return <AllowAll><CashOrdersList /></AllowAll>;
  if (view === 'reservation-mode') return <ReservationModeFixture admin={searchParams.get('role') !== 'staff'} />;
  if (view === 'product-dialog') return <ProductDialogFixture />;
  if (view === 'datatable') return <DataTableFixture />;
  if (view === 'tabs') return <TabsFixture />;
  if (view === 'reassign-owner') return <AllowAll><ReassignOwnerFixture /></AllowAll>;
  if (view === 'account-detail') {
    return (
      <Routes>
        <Route path=":id" element={<AccountDetail />} />
      </Routes>
    );
  }
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
  if (view === 'timeline') {
    const tl = buildTimelineFixture(empty);
    return (
      <div className="max-w-xl p-6 space-y-6">
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center justify-between pb-3 hairline-b mb-4">
            <h3 className="text-sm font-semibold text-card-foreground">Payment Timeline</h3>
            <ProgressRing percent={empty ? 0 : 46} label="paid" />
          </div>
          <PaymentTimeline currency="PHP" downpayment={tl.downpayment} installments={tl.installments as never} completed={tl.completed} />
        </div>
        <div className="rounded-2xl border border-border bg-card p-5">
          <h3 className="text-sm font-semibold text-card-foreground pb-3 hairline-b mb-4">Cash Order Timeline</h3>
          <CashOrderTimeline
            currency="JPY"
            orderDate={empty ? null : '2026-05-02'}
            payments={empty ? [] : [
              { id: 'fx-cp-1', amount: 40_000, createdAt: '2026-05-10T02:00:00Z', method: 'paypal', reference: 'PP-1204' },
              { id: 'fx-cp-2', amount: 12_000, createdAt: '2026-05-20T02:00:00Z', method: 'cash', voided: true },
              { id: 'fx-cp-3', amount: 28_000, createdAt: '2026-06-01T02:00:00Z', method: 'bdo', reference: 'BDO-7781' },
            ]}
            status={empty ? 'pending' : 'completed'}
            terminalAt={empty ? null : '2026-06-01T02:05:00Z'}
          />
        </div>
      </div>
    );
  }
  if (view === 'tiers') {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-6 max-w-4xl">
        {buildTierFixtures().map(t => <TierCard key={t.tierName} {...t} />)}
        <TierCard tierName={null} />
      </div>
    );
  }
  if (view === 'statement') {
    const tl = buildTimelineFixture(empty);
    return (
      <AccountStatement
        open
        onClose={() => { document.title = 'statement-closed'; }}
        kind="layaway"
        currency="PHP"
        customerName="Maria Consolación Villanueva-Dela Cruz"
        customerCode="CJ-2026-00808"
        invoiceNumber="18042"
        status="active"
        planMonths={6}
        orderDate="2026-03-12"
        schedule={tl.installments as never}
        waivers={empty ? [] : [{ id: 'fx-w-1', amount: 500, reason: 'Customer hospitalized — documented, approved by finance' }]}
        services={empty ? [] : [{ id: 'fx-svc-1', label: 'Resize', amount: 800 }]}
        payments={empty ? [] : [
          { id: 'fx-sp-1', amount: 7_200, createdAt: '2026-03-14T03:00:00Z', method: 'gcash', reference: 'DP-2201' },
          { id: 'fx-sp-2', amount: 3_956, createdAt: '2026-04-11T05:00:00Z', method: 'bdo', reference: 'BDO-4471' },
          { id: 'fx-sp-3', amount: 4_456, createdAt: '2026-05-13T05:00:00Z', method: 'gcash', reference: 'GC-9903' },
          { id: 'fx-sp-4', amount: 1_500, createdAt: '2026-06-14T05:00:00Z', method: 'maya', reference: 'MY-1189' },
          { id: 'fx-sp-5', amount: 2_000, createdAt: '2026-06-20T05:00:00Z', method: 'cash', voided: true },
        ]}
        totals={{ total: 27_480, paid: 17_112, remaining: 10_368, penalties: 1_500, services: 800 }}
      />
    );
  }
  if (view === 'splash') {
    // Screenshot-only stand-in source (the sandbox cannot reach
    // supabase.co). srcOverride exists solely for this harness.
    const src = searchParams.get('src') ?? undefined;
    return (
      <PostLoginSplash
        srcOverride={src}
        onEnter={() => {
          document.title = 'splash-exited';
        }}
      />
    );
  }
  if (view === 'geo') {
    // Standalone (the real page perm-gates it): fixture accounts carry one
    // is_test=true active row, so the expected active+overdue count is 78,
    // not 79 — proving GeoBreakdown's canonical test exclusion.
    return (
      <div className="max-w-3xl p-6">
        <GeoBreakdown
          accounts={(empty ? [] : buildAccountFixtures()) as never}
          customers={buildCustomerFixtures(empty) as never}
          countOnly
        />
      </div>
    );
  }
  if (view === 'portal-nav') {
    // Maison mobile nav shell — standalone preview (Phase 1 has not wired
    // this into CustomerPortal.tsx/LoyaltyPortal.tsx yet).
    return <PortalNavFixture />;
  }
  if (view === 'portal-home') {
    // Phase 2 hero card + tier strip — standalone preview. CustomerPortal.tsx
    // fetches via plain fetch() + supabase.auth.getSession() (not react-query),
    // so it can't be seeded through the cache like the Hub fixtures; this
    // renders the extracted components directly with realistic props instead.
    const variant = searchParams.get('variant') ?? 'due-soon';
    const heroByVariant: Record<string, Parameters<typeof HeroLayawayCard>[0]['account']> = {
      'due-soon': { invoiceNumber: '18734', planMonths: 6, statusLabel: 'Active', progressPercent: 62, currency: 'JPY', nextDueAmount: 45000, nextDueDate: (() => { const d = new Date(); d.setDate(d.getDate() + 2); return d.toISOString().slice(0, 10); })(), totalPaid: 279000, totalObligation: 450000 },
      'overdue': { invoiceNumber: '18422', planMonths: 8, statusLabel: 'Overdue', progressPercent: 38, currency: 'PHP', nextDueAmount: 12500.5, nextDueDate: '2026-06-20', totalPaid: 47500, totalObligation: 125000 },
      'completed': { invoiceNumber: '17903', planMonths: 3, statusLabel: 'Fully Paid', progressPercent: 100, currency: 'JPY', nextDueAmount: null, nextDueDate: null, totalPaid: 180000, totalObligation: 180000 },
    };
    return (
      <div className="maison-portal font-body min-h-screen bg-background">
        <div className="border-b border-border">
          <div className="max-w-lg mx-auto px-4 py-5">
            <div className="font-display text-primary text-xl" style={{ letterSpacing: '0.15em', textTransform: 'uppercase' }}>Cha Jewels</div>
            <div className="flex items-center gap-2 mt-1.5">
              <p className="font-display text-foreground text-[15px]">Good Afternoon, Maria</p>
              <span className="text-[9px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/10 text-primary">Crown VIP</span>
            </div>
          </div>
        </div>
        <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
          <HeroLayawayCard
            account={heroByVariant[variant]}
            onPay={() => { document.title = 'hero-pay-clicked'; }}
            onViewDetails={() => { document.title = 'hero-details-clicked'; }}
          />
          <TierStrip
            points={empty ? null : 12480}
            activePlans={3}
            onPointsClick={() => { document.title = 'points-clicked'; }}
            onPlansClick={() => { document.title = 'plans-clicked'; }}
          />
        </div>
      </div>
    );
  }
  if (view === 'portal-statement') {
    // Phase 4 — AccountStatementSheet standalone preview.
    return (
      <div className="maison-portal font-body min-h-screen bg-background">
        <AccountStatementSheet
          open
          onClose={() => { document.title = 'statement-closed'; }}
          invoiceNumber="18734"
          currency="JPY"
          customerName="Maria Consolación Villanueva-Dela Cruz"
          customerCode="CJ-2026-00808"
          statusLabel="Active"
          planMonths={6}
          orderDate="2026-03-12"
          downpaymentAmount={90000}
          totalAmount={315000}
          totalServices={15000}
          outstandingPenalties={0}
          totalPaid={180000}
          remainingBalance={135000}
          schedule={[
            { installment_number: 1, due_date: '2026-04-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 45000, status: 'paid' },
            { installment_number: 2, due_date: '2026-05-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 45000, status: 'paid' },
            { installment_number: 3, due_date: '2026-07-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 0, status: 'pending' },
            { installment_number: 4, due_date: '2026-08-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 0, status: 'pending' },
            { installment_number: 5, due_date: '2026-09-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 0, status: 'pending' },
            { installment_number: 6, due_date: '2026-10-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 0, status: 'pending' },
          ]}
          payments={[
            { amount: 90000, date: '2026-03-12', method: 'bank_transfer', reference: 'DP-2201', remarks: 'downpayment' },
            { amount: 45000, date: '2026-04-12', method: 'paypal', reference: 'PP-1204', remarks: null },
            { amount: 45000, date: '2026-05-12', method: 'gcash', reference: 'GC-9903', remarks: null },
          ]}
          services={[
            { service_type: 'resize', description: 'Ring resize to size 7', amount: 15000, currency: 'JPY' },
          ]}
        />
      </div>
    );
  }
  if (view === 'portal-empty-states') {
    // Phase 5 — empty-state previews. RecentActivity is the real, exported
    // component (seeded via setLoyaltyData with an empty transactions
    // array); the layaway-accounts empty card is a private block inside
    // CustomerPortal.tsx, replicated here verbatim (same rationale as the
    // Phase 3 DetailHeaderFixture — it isn't exported/mockable directly).
    setLoyaltyData(
      { id: 'fx-m', customer_id: 'fx-c', customer_name: 'Maria', member_id: 'CJ-2026-00808', current_tier: 'Glimmer', is_downgraded: false, available_points: 0, lifetime_points_earned: 0, redeemed_points: 0, lifetime_spend_yen: 0, current_multiplier: 1, amount_needed_for_next_tier: 200000, activity_status: 'Active', email: null, join_date: 'Jul 1, 2026', last_purchase_date: null },
      [], [], null, [],
    );
    return (
      <div className="maison-portal font-body min-h-screen bg-background p-6 space-y-8 max-w-md mx-auto">
        <div>
          <p className="text-xs uppercase text-muted-foreground mb-2" style={{ letterSpacing: '0.15em' }}>Loyalty — Recent Activity (empty)</p>
          <RecentActivity onViewAll={() => {}} />
        </div>
        <div>
          <p className="text-xs uppercase text-muted-foreground mb-2" style={{ letterSpacing: '0.15em' }}>Home — No Layaway Accounts</p>
          <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] text-center" style={{ padding: '4rem 2rem' }}>
            <p className="font-display text-foreground" style={{ fontSize: '18px', marginBottom: '8px' }}>No layaway accounts yet.</p>
            <p className="text-muted-foreground" style={{ fontSize: '13px' }}>Visit Cha Jewels to start your first layaway plan.</p>
          </div>
        </div>
      </div>
    );
  }
  if (view === 'portal-fullscreen-states') {
    // Phase 5 — CustomerPortal.tsx's loading/no-auth/error/PIN-gate states,
    // replicated verbatim (private inline JSX, not exported — same
    // rationale as portal-detail's header fixture).
    const variant = (searchParams.get('variant') ?? 'error-expired') as 'error-expired' | 'error-invalid' | 'pin-gate' | 'no-auth';
    if (variant === 'no-auth') {
      return (
        <div className="maison-portal font-body min-h-screen bg-background flex items-center justify-center px-4 py-10">
          <div className="w-full max-w-sm rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-8 sm:p-10 text-center">
            <p className="font-display text-primary" style={{ fontSize: 22, marginBottom: 4 }}>Cha Jewels</p>
            <p className="text-muted-foreground" style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 28 }}>Customer Portal</p>
            <h1 className="font-display text-foreground" style={{ fontSize: 18, marginBottom: 12, fontWeight: 400 }}>Sign in to your Cha Jewels Portal</h1>
            <p className="text-muted-foreground" style={{ fontSize: 13, marginBottom: 24, lineHeight: 1.6 }}>Use your email and password to access your accounts.</p>
            <button className="w-full rounded-lg bg-primary text-primary-foreground font-bold mb-3" style={{ padding: 12, fontSize: 14 }}>Sign In</button>
            <button className="w-full rounded-lg border border-primary text-primary font-semibold" style={{ padding: 12, fontSize: 13 }}>First time? Set up your account</button>
          </div>
        </div>
      );
    }
    if (variant === 'pin-gate') {
      return (
        <div className="maison-portal font-body min-h-screen bg-background flex items-center justify-center px-4">
          <div className="w-full max-w-[340px] rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-10 text-center">
            <p className="font-display text-primary" style={{ fontSize: 20, marginBottom: 8 }}>Cha Jewels</p>
            <p className="text-foreground" style={{ fontSize: 14, marginBottom: 24 }}>Enter your 4-digit portal PIN</p>
            <input className="w-full rounded-lg bg-secondary border border-border text-foreground box-border" style={{ padding: '14px', fontSize: 28, textAlign: 'center', letterSpacing: 12, marginBottom: 16 }} placeholder="••••" readOnly value="12" />
            <button className="w-full rounded-lg bg-primary text-primary-foreground font-bold" style={{ padding: 12, fontSize: 14 }}>Access My Account</button>
            <p className="text-muted-foreground" style={{ fontSize: 11, marginTop: 16 }}>Forgot your PIN? Contact your staff.</p>
            <p className="text-muted-foreground" style={{ fontSize: 10, marginTop: 4 }}>Default PIN: last 4 digits of your registered mobile number</p>
          </div>
        </div>
      );
    }
    const isExpired = variant === 'error-expired';
    return (
      <div className="maison-portal font-body min-h-screen bg-background flex items-center justify-center p-4">
        <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] max-w-[400px] w-full text-center" style={{ padding: '2.5rem 2rem' }}>
          <div className="font-display text-primary" style={{ fontSize: '26px', fontWeight: 600, letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: '4px' }}>Cha Jewels</div>
          <div className="text-muted-foreground" style={{ fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: '2rem' }}>Customer Portal</div>
          <AlertTriangle className="h-10 w-10 mx-auto mb-4 text-destructive" />
          <h2 className="font-display text-foreground" style={{ fontSize: '20px', marginBottom: '8px' }}>{isExpired ? 'Portal Link Expired' : 'Invalid Portal Link'}</h2>
          <p className="text-muted-foreground" style={{ fontSize: '13px', lineHeight: '1.6' }}>
            {isExpired ? 'This portal link has expired. Please request a new link from Cha Jewels.' : 'This link is invalid or no longer active. Please contact Cha Jewels for a new portal link.'}
          </p>
        </div>
      </div>
    );
  }
  if (view === 'portal-profile') {
    // Phase 5 — ProfileEditor preview. Private component in
    // CustomerPortal.tsx (not exported) — replicated verbatim, same
    // rationale as the other private-function fixtures this phase.
    const variant = (searchParams.get('variant') ?? 'view') as 'view' | 'edit';
    const rows: Array<[string, string]> = [
      ['Full Name', 'Maria Consolación Villanueva-Dela Cruz'],
      ['Location', 'Philippines'],
      ['Facebook Name', 'Maria Villanueva'],
      ['Messenger Link', 'm.me/maria.villanueva'],
      ['Mobile Number', '+63 917 000 0000'],
      ['Email', 'maria@example.com'],
      ['Notes', ''],
    ];
    return (
      <div className="maison-portal font-body min-h-screen bg-background p-6 max-w-md mx-auto">
        <div className="flex items-center justify-between mb-4">
          <p className="font-display text-foreground" style={{ fontSize: 22, fontWeight: 600 }}>My Profile</p>
          {variant === 'view' && (
            <button className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-primary text-primary text-[11px] uppercase" style={{ letterSpacing: '0.1em' }}>
              Edit
            </button>
          )}
        </div>
        {variant === 'view' ? (
          <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-5 sm:p-6">
            {rows.map(([lbl, val]) => (
              <div key={lbl} className="py-2.5 flex gap-4 border-b border-border last:border-b-0">
                <p className="text-[10px] font-medium uppercase text-muted-foreground pt-px" style={{ letterSpacing: '0.12em', width: '100px', flexShrink: 0 }}>{lbl}</p>
                <p className={`text-[13px] ${val ? 'text-foreground' : 'text-muted-foreground italic'}`}>{val || 'Not set'}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl bg-card shadow-[0_2px_12px_rgba(43,39,35,0.06)] p-5 sm:p-6 space-y-4">
            <div className="space-y-1.5">
              <p className="text-[10px] uppercase text-muted-foreground">Full Name <span className="text-destructive">*</span></p>
              <input className="w-full h-10 rounded-md px-3 bg-secondary text-foreground border border-border" defaultValue={rows[0][1]} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase text-muted-foreground">Mobile Number</p>
                <input className="w-full h-10 rounded-md px-3 bg-secondary text-foreground border border-border" defaultValue={rows[4][1]} />
              </div>
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase text-muted-foreground">Email</p>
                <input className="w-full h-10 rounded-md px-3 bg-secondary text-foreground border border-border" defaultValue={rows[5][1]} />
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button className="px-4 py-2 rounded-lg border border-border text-muted-foreground text-xs">Cancel</button>
              <button className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold uppercase" style={{ letterSpacing: '0.1em' }}>Save Changes</button>
            </div>
          </div>
        )}
      </div>
    );
  }
  if (view === 'portal-offline-banner') {
    // Phase 5 — OfflineBanner, real exported component. navigator.onLine
    // can't be forced true→false from inside the page; the Playwright
    // verification script uses browserContext.setOffline(true) instead
    // of a fixture variant here.
    return (
      <div className="maison-portal font-body min-h-screen bg-background p-6">
        <p className="text-sm text-muted-foreground mb-4">Set the browser context offline to see the banner render at the top of the viewport.</p>
        <OfflineBanner />
      </div>
    );
  }
  if (view === 'portal-loyalty') {
    // Phase 4 — .loyalty-portal retheme, standalone preview. LoyaltyPortal.tsx
    // fetches via react-query keyed on a bootstrapped auth session (not
    // reachable from this sandbox), so — same rationale as portal-home/
    // portal-detail — this renders the real screens/dialogs directly with
    // loyaltyData.ts seeded via setLoyaltyData(), the same external store
    // MemberView itself writes to.
    const variant = (searchParams.get('variant') ?? 'home') as
      | 'home' | 'redemption' | 'celebration' | 'coming-soon' | 'join-prompt';
    return <PortalLoyaltyFixture variant={variant} />;
  }
  if (view === 'portal-detail') {
    // Phase 3 — payment journey timeline, itemized totals, completed-plan
    // state — standalone preview (same rationale as portal-home: CustomerPortal.tsx
    // isn't seedable via react-query cache).
    return <PortalDetailFixture variant={(searchParams.get('variant') ?? 'active') as 'active' | 'penalty' | 'completed'} />;
  }
  if (view === 'forms') {
    return <FormsFixture />;
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

/** Phase 5 forms/states fixture — the shared UX primitives in every state. */
function FormsFixture() {
  const [invoice, setInvoice] = useState('');
  const [touched, setTouched] = useState(false);
  const [php, setPhp] = useState<number | ''>(83311.5);
  const [jpy, setJpy] = useState<number | ''>(1250000);
  const [armed, setArmed] = useState(false);
  return (
    <div className="max-w-xl p-6 space-y-6">
      <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-card-foreground pb-2 hairline-b">Forms polish</h3>
        <FloatingField
          label="Invoice Number *"
          value={invoice}
          onChange={e => setInvoice(e.target.value)}
          onBlur={() => setTouched(true)}
          error={touched && !invoice ? 'Invoice number is required.' : undefined}
        />
        <FloatingField label="Customer name" defaultValue="Maria Consolación Villanueva-Dela Cruz" />
        <CurrencyInput currency="PHP" label="Total amount (PHP)" value={php} onValueChange={setPhp} hint="Auto-formats as you type" />
        <CurrencyInput currency="JPY" label="Total amount (JPY)" value={jpy} onValueChange={setJpy} error="Below the 12-month plan minimum of ¥1,000,000 — shown on blur, enforced on submit." />
      </div>
      <div className="rounded-2xl border border-danger/25 bg-card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-card-foreground pb-2 hairline-b">Typed confirmation</h3>
        <TypedConfirmField word="VOID" onArmedChange={setArmed} />
        <Button variant="destructive" disabled={!armed} className="w-full">
          {armed ? 'Void Payment (armed)' : 'Void Payment (type VOID to arm)'}
        </Button>
      </div>
      <EmptyState
        icon={FileText}
        title="No accounts found"
        description="Create the first layaway account to get started."
        action={<Button size="sm" className="gold-gradient text-primary-foreground">New Account</Button>}
      />
      <ErrorState message="Couldn't load the collections trend. Your other dashboard data is unaffected." onRetry={() => {}} />
    </div>
  );
}

/** Phase 3 — payment journey timeline, itemized totals, completed-plan state. */
function PortalDetailFixture({ variant }: { variant: 'active' | 'penalty' | 'completed' }) {
  const fixtures = {
    active: {
      currency: 'JPY',
      downpaymentAmount: 90000,
      payments: [
        { amount: 90000, date: '2026-03-12', method: 'bank_transfer', reference: 'DP-2201', remarks: 'downpayment' },
        { amount: 45000, date: '2026-04-12', method: 'paypal', reference: 'PP-1204', remarks: null },
        { amount: 45000, date: '2026-05-12', method: 'gcash', reference: 'GC-9903', remarks: null },
      ],
      schedule: [
        { installment_number: 1, due_date: '2026-04-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 45000, status: 'paid' },
        { installment_number: 2, due_date: '2026-05-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 45000, status: 'paid' },
        { installment_number: 3, due_date: (() => { const d = new Date(); d.setDate(d.getDate() + 3); return d.toISOString().slice(0, 10); })(), base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 0, status: 'pending' },
        { installment_number: 4, due_date: '2026-08-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 0, status: 'pending' },
        { installment_number: 5, due_date: '2026-09-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 0, status: 'pending' },
        { installment_number: 6, due_date: '2026-10-12', base_amount: 45000, penalty_amount: 0, penalty_fee_status: null, total_due: 45000, paid_amount: 0, status: 'pending' },
      ],
      totals: { totalAmount: 315000, totalServices: 15000, outstandingPenalties: 0, totalPaid: 180000, remainingBalance: 135000 },
    },
    penalty: {
      currency: 'PHP',
      downpaymentAmount: 8400,
      payments: [
        { amount: 8400, date: '2026-02-01', method: 'bdo', reference: 'DP-1190', remarks: 'downpayment' },
        { amount: 5000, date: '2026-03-05', method: 'cash', reference: null, remarks: null },
      ],
      schedule: [
        { installment_number: 1, due_date: '2026-03-01', base_amount: 9450, penalty_amount: 500, penalty_fee_status: 'paid', total_due: 9950, paid_amount: 9450, status: 'paid' },
        { installment_number: 2, due_date: '2026-04-01', base_amount: 9450, penalty_amount: 1000, penalty_fee_status: 'unpaid', total_due: 10450, paid_amount: 5000, status: 'partially_paid' },
        { installment_number: 3, due_date: '2026-05-01', base_amount: 9450, penalty_amount: 0, penalty_fee_status: null, total_due: 9450, paid_amount: 0, status: 'overdue' },
        { installment_number: 4, due_date: '2026-06-01', base_amount: 9450, penalty_amount: 0, penalty_fee_status: null, total_due: 9450, paid_amount: 0, status: 'pending' },
      ],
      totals: { totalAmount: 46200, totalServices: 0, outstandingPenalties: 1000, totalPaid: 13400, remainingBalance: 33800 },
    },
    completed: {
      currency: 'JPY',
      downpaymentAmount: 54000,
      payments: [
        { amount: 54000, date: '2026-01-10', method: 'bank_transfer', reference: 'DP-0904', remarks: 'downpayment' },
        { amount: 42000, date: '2026-02-10', method: 'paypal', reference: 'PP-0201', remarks: null },
        { amount: 42000, date: '2026-03-10', method: 'paypal', reference: 'PP-0347', remarks: null },
        { amount: 42000, date: '2026-04-10', method: 'gcash', reference: 'GC-1102', remarks: null },
      ],
      schedule: [
        { installment_number: 1, due_date: '2026-02-10', base_amount: 42000, penalty_amount: 0, penalty_fee_status: null, total_due: 42000, paid_amount: 42000, status: 'paid' },
        { installment_number: 2, due_date: '2026-03-10', base_amount: 42000, penalty_amount: 0, penalty_fee_status: null, total_due: 42000, paid_amount: 42000, status: 'paid' },
        { installment_number: 3, due_date: '2026-04-10', base_amount: 42000, penalty_amount: 0, penalty_fee_status: null, total_due: 42000, paid_amount: 42000, status: 'paid' },
      ],
      totals: { totalAmount: 180000, totalServices: 0, outstandingPenalties: 0, totalPaid: 180000, remainingBalance: 0 },
    },
  } as const;

  const fx = fixtures[variant];
  const entries = buildJourneyEntries({
    downpaymentAmount: fx.downpaymentAmount,
    currency: fx.currency,
    payments: fx.payments as never,
    schedule: fx.schedule as never,
  });

  return (
    <div className="maison-portal font-body min-h-screen bg-background">
      <DetailHeaderFixture
        invoiceNumber={variant === 'completed' ? '17903' : variant === 'penalty' ? '18422' : '18734'}
        statusLabel={variant === 'completed' ? 'Fully Paid' : variant === 'penalty' ? 'Overdue' : 'Active'}
        totalAmount={fx.totals.totalAmount}
        remainingBalance={fx.totals.remainingBalance}
        outstandingPenalties={fx.totals.outstandingPenalties}
        currency={fx.currency}
        nextDueDate={variant === 'penalty' ? '2026-06-01' : variant === 'active' ? entries[3]?.dateLabel ?? null : null}
        nextDueAmount={variant === 'completed' ? null : 45000}
      />
      <div className="max-w-lg mx-auto px-4 py-6 space-y-5">
        {variant === 'completed' && (
          <CompletedPlanBanner currency={fx.currency} totalPaid={fx.totals.totalPaid} totalObligation={fx.totals.totalAmount} />
        )}
        <ItemizedTotals
          currency={fx.currency}
          totalAmount={fx.totals.totalAmount}
          totalServices={fx.totals.totalServices}
          outstandingPenalties={fx.totals.outstandingPenalties}
          totalPaid={fx.totals.totalPaid}
          remainingBalance={fx.totals.remainingBalance}
        />
        <PaymentJourneyTimeline entries={entries} />
      </div>
    </div>
  );
}

/**
 * Faithful mock of AccountDetail's Sheet header + tab bar (a private,
 * non-exported function inside CustomerPortal.tsx — same reason this can't
 * import the real thing as HeroLayawayCard/TierStrip do). Mirrors the exact
 * JSX/classes shipped there so this screenshot verifies what customers see.
 */
function DetailHeaderFixture({ invoiceNumber, statusLabel, totalAmount, remainingBalance, outstandingPenalties, currency, nextDueDate, nextDueAmount }: {
  invoiceNumber: string; statusLabel: string; totalAmount: number; remainingBalance: number;
  outstandingPenalties: number; currency: string; nextDueDate: string | null; nextDueAmount: number | null;
}) {
  const [tab, setTab] = useState<'overview' | 'pay' | 'submissions'>('overview');
  const isOverdue = statusLabel === 'Overdue';
  const fmtMoney = (n: number) => currency === 'JPY' ? `¥${Math.round(n).toLocaleString('en-US')}` : `₱${n.toLocaleString('en-US')}`;
  const fmtDateLong = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <div className="bg-background border-b border-border" style={{ padding: '1.25rem 1.25rem 0' }}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[9px] uppercase text-muted-foreground mb-1" style={{ letterSpacing: '0.2em' }}>Invoice</p>
          <p className="font-display text-2xl text-foreground" style={{ letterSpacing: '0.03em' }}>#{invoiceNumber}</p>
        </div>
        <span className={`text-[9px] uppercase rounded-[2px] px-2.5 py-1 border ${statusLabel === 'Fully Paid' ? 'text-[#3E7D5B] border-[#3E7D5B]/40' : statusLabel === 'Overdue' ? 'text-destructive border-destructive/50' : 'text-primary border-primary/50'}`} style={{ letterSpacing: '0.12em' }}>
          {statusLabel}
        </span>
      </div>

      {isOverdue && (
        <div className="mt-3 flex items-start gap-2.5 p-3 rounded-lg bg-destructive/10 border-l-[3px] border-destructive">
          <div>
            <p className="text-xs font-semibold text-destructive">Payment Overdue</p>
            <p className="text-[11px] text-destructive mt-0.5">Please submit your payment as soon as possible to avoid additional penalties.</p>
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div>
          <p className="text-[9px] font-medium uppercase text-muted-foreground mb-0.5" style={{ letterSpacing: '0.18em' }}>Total Amount</p>
          <p className="text-[13px] font-medium text-foreground">{fmtMoney(totalAmount)}</p>
        </div>
        <div>
          <p className="text-[9px] font-medium uppercase text-muted-foreground mb-0.5" style={{ letterSpacing: '0.18em' }}>Balance Due</p>
          <p className={`text-[13px] font-medium ${isOverdue ? 'text-destructive' : 'text-foreground'}`}>{fmtMoney(remainingBalance)}</p>
        </div>
        {outstandingPenalties > 0 && (
          <p className="text-[11px] text-muted-foreground mt-0.5" style={{ gridColumn: '1 / -1' }}>includes {fmtMoney(outstandingPenalties)} in late penalties</p>
        )}
        <div>
          <p className="text-[9px] font-medium uppercase text-muted-foreground mb-0.5" style={{ letterSpacing: '0.18em' }}>Next Due</p>
          <p className="text-[13px] font-medium text-foreground">{nextDueDate ? fmtDateLong(nextDueDate) : '—'}</p>
        </div>
        <div>
          <p className="text-[9px] font-medium uppercase text-muted-foreground mb-0.5" style={{ letterSpacing: '0.18em' }}>Next Amount</p>
          <p className="text-[13px] font-medium text-foreground">{nextDueAmount ? fmtMoney(nextDueAmount) : '—'}</p>
        </div>
      </div>

      <div className="mt-4 flex border-t border-border" style={{ marginLeft: '-1.25rem', marginRight: '-1.25rem' }}>
        {(['overview', 'pay', 'submissions'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 px-1 text-[11px] uppercase transition-colors ${tab === t ? 'font-semibold text-primary border-b-2 border-primary' : 'font-normal text-muted-foreground border-b-2 border-transparent'}`}
            style={{ letterSpacing: '0.1em' }}
          >
            {t === 'overview' ? 'Schedule' : t === 'pay' ? 'Pay Now' : 'Submissions'}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Phase 4 — .loyalty-portal retheme preview: real screens/dialogs, mock loyaltyData.ts store. */
function PortalLoyaltyFixture({ variant }: { variant: 'home' | 'redemption' | 'celebration' | 'coming-soon' | 'join-prompt' }) {
  const [tab, setTab] = useState<LoyaltyTab>('home');

  useState(() => {
    const tiers: LoyaltyTierData[] = (Object.keys(TIER_STATIC) as TierName[]).map((name, i) => ({
      name,
      spendRequired: [0, 200_000, 600_000, 1_500_000][i],
      multiplier: [1, 2, 2, 3][i],
      ...TIER_STATIC[name],
    }));
    const member: LoyaltyMemberData = {
      id: 'fx-member-1',
      customer_id: 'fx-customer-1',
      customer_name: 'Maria Consolación Villanueva-Dela Cruz',
      member_id: 'CJ-2026-00808',
      current_tier: 'Elite',
      is_downgraded: false,
      available_points: 9_150,
      lifetime_points_earned: 14_650,
      redeemed_points: 5_000,
      lifetime_spend_yen: 620_000,
      current_multiplier: 2,
      amount_needed_for_next_tier: 1_500_000 - 620_000,
      activity_status: 'Active',
      email: 'maria@example.com',
      join_date: 'Jun 20, 2025',
      last_purchase_date: 'Jul 1, 2026',
    };
    const transactions: LoyaltyTransactionData[] = [
      { id: 'fx-tx-1', date: 'Jul 1, 2026', type: 'earned', points: 1_240, description: 'Invoice #18734', source: 'purchase', invoice_number: '18734', spend_amount_jpy: 45_000, tier_multiplier: 2 },
      { id: 'fx-tx-2', date: 'Jun 10, 2026', type: 'redeemed', points: 2_000, description: 'Shipping fee', source: 'redemption', invoice_number: null, spend_amount_jpy: null, tier_multiplier: null },
      { id: 'fx-tx-3', date: 'May 12, 2026', type: 'earned', points: 900, description: 'Invoice #18422', source: 'purchase', invoice_number: '18422', spend_amount_jpy: 45_000, tier_multiplier: 2 },
    ];
    setLoyaltyData(member, tiers, transactions, null, [
      { id: 'fx-lot-1', original_amount: 5_000, remaining_amount: 3_150, earned_at: '2026-05-01', expires_at: '2026-08-01' },
    ]);
    return null;
  });

  if (variant === 'coming-soon') {
    return (
      <div className="loyalty-portal font-body min-h-screen bg-background flex items-center justify-center p-6">
        <LoyaltyComingSoon customerEmail="maria@example.com" customerId="fx-customer-1" />
      </div>
    );
  }
  if (variant === 'join-prompt') {
    return (
      <div className="loyalty-portal font-body min-h-screen bg-background flex items-center justify-center p-6">
        <LoyaltyJoinPrompt portalToken="fx-token" customerId="fx-customer-1" />
      </div>
    );
  }

  return (
    <div className="loyalty-portal font-body min-h-screen bg-background pb-24">
      {tab === 'home' && (
        <HomeScreen
          canRedeem={new URLSearchParams(window.location.search).get('canredeem') !== '0'}
          onRedeemClick={() => { document.title = 'redeem-clicked'; }}
          setTab={setTab}
          unreadCount={2}
          latestUnread={{ title: 'Tier upgrade!', body: "You've reached Elite status." }}
          birthdayReward={null}
          portalToken="fx-token"
          onClaimed={() => {}}
        />
      )}
      <LoyaltyBottomNav active={tab} unreadCount={2} onChange={setTab} />
      <RedemptionForm
        isOpen={variant === 'redemption'}
        onClose={() => { document.title = 'redemption-closed'; }}
        remainingPoints={9_150}
        customerId="fx-customer-1"
        memberId="fx-member-1"
        portalToken="fx-token"
      />
      <TierCelebrationModal
        tierName="Elite"
        isOpen={variant === 'celebration'}
        onClose={() => { document.title = 'celebration-closed'; }}
        direction="upgrade"
      />
    </div>
  );
}

/** Maison mobile nav shell + AnimatedNumber — standalone Phase 1 preview. */
function PortalNavFixture() {
  const [tab, setTab] = useState<PortalTab>('home');
  return (
    <div className="maison-portal font-body min-h-screen bg-background pb-24">
      <div className="max-w-sm mx-auto p-6 space-y-6">
        <p className="font-display text-2xl text-foreground">Maison Foundation</p>
        <div className="rounded-xl bg-card p-5 shadow-[0_2px_12px_rgba(43,39,35,0.06)]">
          <p className="text-[11px] uppercase text-muted-foreground mb-1" style={{ letterSpacing: '0.15em' }}>Points Balance</p>
          <p className="font-display text-3xl text-foreground tabular-nums">
            <AnimatedNumber value={12480} />
          </p>
        </div>
        <div className="rounded-xl bg-card p-5 shadow-[0_2px_12px_rgba(43,39,35,0.06)]">
          <p className="text-[11px] uppercase text-muted-foreground mb-1" style={{ letterSpacing: '0.15em' }}>Remaining Balance</p>
          <p className="font-display text-3xl text-foreground tabular-nums">
            <AnimatedNumber value={284500} format={(n) => `¥${Math.round(n).toLocaleString()}`} />
          </p>
        </div>
        <p className="text-sm text-muted-foreground">Active tab: <span className="text-primary font-medium">{tab}</span></p>
      </div>
      <PortalBottomNav active={tab} onChange={setTab} />
    </div>
  );
}

/** Website Catalog product editor with enough content to force scrolling. */
function ProductDialogFixture() {
  const longEn = Array.from({ length: 6 }, () =>
    '18K yellow gold chain with a hand-set natural diamond pendant. Hallmarked, inspected and polished in Tokyo before shipping.',
  ).join(' ');
  const [form, setForm] = useState<ProductForm>(() => ({
    ...emptyProduct(),
    id: 'fixture-product',
    sku: 'CJ-NK-0142',
    slug: 'k18-diamond-pendant-necklace',
    name: 'K18 Diamond Pendant Necklace',
    name_ja: 'K18 ダイヤモンド ペンダント ネックレス',
    brand: 'Cha Jewels',
    weight_g: 4.2,
    description_en: longEn,
    description_ja: 'K18 イエローゴールドのチェーンに天然ダイヤモンドのペンダント。'.repeat(8),
    status: 'active',
    variants: [0, 1, 2, 3].map(i => ({
      ...emptyVariant(i),
      size: `${40 + i * 5}cm`,
      stone: i % 2 ? '0.30ct' : '0.20ct',
      price_jpy: 128000 + i * 24000,
      stock_qty: 3 - (i % 3),
    })),
  }));
  return (
    <ProductDialog
      open
      onOpenChange={() => {}}
      form={form}
      setForm={setForm}
      collections={[{ id: 'c1', name: 'Signature' }, { id: 'c2', name: 'Bridal' }]}
      categories={[{ id: 'k1', name: 'Necklaces', published: true }, { id: 'k2', name: 'Pendants', published: true }]}
      isAdmin
      translating={false}
      uploadingKey={null}
      peso={n => `₱ ${Math.round(n * 0.42).toLocaleString('en-US')}`}
      saving={false}
      onSave={() => {}}
      onRegenerateJapanese={() => {}}
      onUploadMedia={() => {}}
      onPatchVariant={(i, patch) =>
        setForm(f => ({ ...f, variants: f.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) }))
      }
    />
  );
}

interface InquiryFixture { id: string; name: string; email: string; subject: string; received: string; message: string }

/** DataTable with searchable, expandable rows (inquiry-card shape). */
function DataTableFixture() {
  const rows: InquiryFixture[] = Array.from({ length: 8 }, (_, i) => ({
    id: `inq-${i}`,
    name: ['Maria Santos', 'Yuki Tanaka', 'Ana Reyes', 'Kenji Mori'][i % 4],
    email: `customer${i + 1}@example.com`,
    subject: ['Ring sizing', 'Layaway question', 'Wholesale pricing', 'Shipping to Manila'][i % 4],
    received: `2026-09-${String(20 - i).padStart(2, '0')}`,
    message: 'Hello, I would like to ask about the availability of this piece and whether it can be reserved on a 6-month layaway plan.',
  }));
  const columns: DataTableColumn<InquiryFixture>[] = [
    { key: 'name', header: 'Name', cell: r => r.name, sortValue: r => r.name },
    { key: 'email', header: 'Email', cell: r => r.email, hideable: true },
    { key: 'subject', header: 'Subject', cell: r => r.subject },
    { key: 'received', header: 'Received', cell: r => r.received, sortValue: r => r.received, align: 'right' },
  ];
  return (
    <div className="p-4 sm:p-6">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={r => r.id}
        searchText={r => [r.name, r.email, r.subject]}
        renderExpanded={r => <p className="text-sm text-muted-foreground">{r.message}</p>}
        csvName="fixture-inquiries"
      />
    </div>
  );
}

/** Tabs primitive mirroring the /website workspace tab set. */
function TabsFixture() {
  return (
    <div className="p-4 sm:p-6">
      <Tabs defaultValue="catalog" className="w-full">
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="content">Content</TabsTrigger>
          <TabsTrigger value="audience">Audience</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        {['catalog', 'content', 'audience', 'settings'].map(v => (
          <TabsContent key={v} value={v} className="mt-5">
            <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground capitalize">{v} panel</div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

// ------------------------------------------------ reserve-first A2 fixtures
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function buildReservationFixtures() {
  return [
    { kind: 'cash_order', id: 'fixture-rsv-cash-1', reference: 'CJ-W-000131', customer_name: 'Aiko Tanaka', customer_is_test: false, total_amount: 72_980, currency: 'JPY', plan_months: null, created_at: ago(30) },
    { kind: 'layaway', id: 'fixture-rsv-lay-1', reference: 'CJ-W-000134', customer_name: 'Maria Consolación Villanueva-Dela Cruz', customer_is_test: false, total_amount: 126_000, currency: 'PHP', plan_months: 8, created_at: ago(7) },
    { kind: 'cash_order', id: 'fixture-rsv-cash-2', reference: 'CJ-W-000136', customer_name: 'Test Customer', customer_is_test: true, total_amount: 18_500, currency: 'JPY', plan_months: null, created_at: ago(1) },
  ];
}

function buildReservationCashRows() {
  return buildReservationFixtures().filter(r => r.kind === 'cash_order').map((r) => ({
    id: r.id, invoice_number: r.reference.replace('CJ-W-', ''), currency: r.currency, total_amount: r.total_amount,
    total_paid: 0, remaining_balance: r.total_amount, status: 'pending', order_date: r.created_at.slice(0, 10),
    item_description: 'Web order', created_at: r.created_at, source_channel: 'web', web_reference: r.reference,
    payment_status: 'awaiting_confirmation', transfer_due_at: null, ready_confirmed_at: null,
    customers: { id: `${r.id}-cust`, full_name: r.customer_name, messenger_link: null },
  }));
}

/** Hub shim: web reservations awaiting confirmation on real seeded rows, so the
 *  list pills, detail panels, sidebar count and Dashboard card all agree. */
const HUB_RESERVATION_ACCOUNTS = ['fixture-acct-0001', 'fixture-acct-0002'];
const HUB_RESERVATION_CASH = ['fixture-cash-0006', 'fixture-cash-0001'];

function markHubReservations(accounts: Array<Record<string, unknown>>, cash: Array<Record<string, unknown>>) {
  const mark = (row: Record<string, unknown>, n: number, hoursAgo: number) => {
    row.source_channel = 'web';
    row.web_reference = `CJ-W-${String(140 + n).padStart(6, '0')}`;
    row.ready_confirmed_at = null;
    row.created_at = ago(hoursAgo);
  };
  accounts.filter(a => HUB_RESERVATION_ACCOUNTS.includes(String(a.id))).forEach((a, i) => mark(a, i, 6 + i * 20));
  cash.filter(o => HUB_RESERVATION_CASH.includes(String(o.id))).forEach((o, i) => mark(o, 10 + i, 3 + i * 27));
}

interface HubReservationRow {
  id: string;
  web_reference?: string | null;
  customers?: { full_name?: string | null } | null;
  total_amount: number;
  currency: string;
  payment_plan_months?: number;
  created_at: string;
}

function hubReservationQueue(accounts: HubReservationRow[], cash: HubReservationRow[]) {
  const pick = (rows: HubReservationRow[], ids: string[], kind: 'cash_order' | 'layaway') =>
    rows.filter(r => ids.includes(r.id)).map(r => ({
      kind, id: r.id, reference: r.web_reference ?? r.id, customer_name: r.customers?.full_name ?? 'A website customer',
      customer_is_test: false, total_amount: Number(r.total_amount), currency: r.currency,
      plan_months: kind === 'layaway' ? r.payment_plan_months ?? null : null, created_at: r.created_at,
    }));
  return [...pick(cash, HUB_RESERVATION_CASH, 'cash_order'), ...pick(accounts, HUB_RESERVATION_ACCOUNTS, 'layaway')]
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Every permission granted — the reservation UI is gated, a fixture has no session. */
function AllowAll({ children }: { children: ReactNode }) {
  const base = usePermissions();
  return (
    <PermissionsContextForFixtures.Provider
      value={{ ...base, can: () => true, canAccessPage: () => true, canSeeNav: () => true, loading: false }}
    >
      {children}
    </PermissionsContextForFixtures.Provider>
  );
}

/** Website → Settings reserve-first card, with the role the fixture asks for. */
function ReservationModeFixture({ admin }: { admin: boolean }) {
  const base = useAuth();
  return (
    <AuthContext.Provider value={{ ...base, roles: admin ? ['admin'] : ['staff'] } as typeof base}>
      <div className="mx-auto max-w-3xl p-4 sm:p-6"><ReservationModeCard /></div>
    </AuthContext.Provider>
  );
}

function ReservationsFixture() {
  const [cash, lay] = buildReservationFixtures();
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
      <ReservationsAwaitingCard />
      <h3 className="text-sm font-semibold text-muted-foreground">Cash order detail — top of page</h3>
      <ReservationPanel entityType="cash_order" entityId={cash.id} reference={cash.reference} createdAt={cash.created_at} canAct />
      <DeadlinesCard entityType="cash_order" entityId={cash.id} status="pending" transferDueAt={null} reference={cash.reference} sourceChannel="web" awaitingConfirmation canEdit />
      <h3 className="text-sm font-semibold text-muted-foreground">Layaway detail — top of page (no permission)</h3>
      <ReservationPanel entityType="layaway" entityId={lay.id} reference={lay.reference} createdAt={lay.created_at} canAct={false} />
      <DeadlinesCard entityType="layaway" entityId={lay.id} status="active" transferDueAt={null} reference={lay.reference} sourceChannel="web" awaitingConfirmation canEdit />
    </div>
  );
}

/** Page365 inventory fixtures: one run with every review population. */
function buildPage365InventoryFixtures(partial: boolean) {
  const run = {
    id: 'fixture-inv-run', status: partial ? 'partial' : 'ready', page365_count: 572, products_total: 572,
    error: partial ? '1 product(s) could not be read' : null,
    created_at: '2026-09-27T01:00:00Z', finished_at: '2026-09-27T01:03:10Z',
  };
  const base = {
    run_id: run.id, kind: 'page365', variant_name: null, page365_full_price_jpy: null, match_result: 'matched',
    website_product_id: 'wp', variant_id: 'wv', web_holds: 0, invoice_holds: 0, price_differs: false,
    photos_total: 0, photos_to_copy: 0, photos_removed: 0, missing_runs: null, status: 'review', result_note: null,
  };
  const row = (id: string, code: string, name: string, over: Record<string, unknown>) => ({
    ...base, id, page365_product_id: Number(id.replace(/\D/g, '')) || 1, page365_variant_id: Number(id.replace(/\D/g, '')) || 1,
    code, hub_sku: code, page365_name: name, page365_price_jpy: 72980, hub_price_jpy: 72980, ...over,
  });
  const items = [
    // PR 2: N4020 is the owner's first "Don't sync with Page365" piece (a sample).
    row('i1', 'N4020', 'N4020 Necklace Tiffany & Co. 750 Open Teardrop', { category: 'not_synced', page365_available: 0, seen_stock: 1, proposed_stock: null, photos_total: 0, photos_to_copy: 0 }),
    row('i2', 'E1053', 'E1053 Earrings K18', { variant_name: 'E1053 2.0g', category: 'decrease', page365_available: 0, seen_stock: 1, proposed_stock: 0, page365_price_jpy: 74980, hub_price_jpy: 74980, photos_total: 2, photos_to_copy: 2 }),
    row('i3', 'R7828', 'R7828 Ring 750YG/WG 19.0g Diamond 2.70ct', { category: 'increase', page365_available: 2, seen_stock: 1, proposed_stock: 2, page365_price_jpy: 679980, hub_price_jpy: 679980, photos_total: 3, photos_to_copy: 1, photos_removed: 1 }),
    row('i4', 'R3341', 'R3341 Ring K18WG 16.20g Diamond 3.82ct', { category: 'no_change', page365_available: 1, seen_stock: 0, proposed_stock: 0, web_holds: 1 }),
    // PR 2: an imported, still-unpaid Page365 invoice holds this piece.
    row('i5', 'ZT9001', 'ZT9001 Test ring K18', { category: 'decrease', page365_available: 1, seen_stock: 1, proposed_stock: 0, invoice_holds: 1 }),
    row('i6', 'E2794', 'E2794 Earrings K18 Diamond', { category: 'no_change', page365_available: 1, seen_stock: 1, proposed_stock: 1, page365_price_jpy: 19184, page365_full_price_jpy: 23980, hub_price_jpy: 23980, price_differs: true }),
    row('i7', 'R0001', 'R0001 duplicate listing', { category: 'flagged', match_result: 'duplicate_in_page365', website_product_id: null, variant_id: null, hub_sku: null, seen_stock: null, proposed_stock: null }),
    row('i8', 'E1053X', 'E1053X Earrings (two sizes in the Hub)', { category: 'flagged', match_result: 'ambiguous_variant', variant_id: null, seen_stock: null, proposed_stock: null }),
    row('i9', 'NL22', 'NL22 Necklace new piece', { category: 'new', match_result: 'unmatched', website_product_id: null, variant_id: null, hub_sku: null, hub_price_jpy: null, seen_stock: null, proposed_stock: null, page365_available: 1, page365_price_jpy: 39980 }),
    { ...base, id: 'i10', kind: 'hub_only', page365_product_id: null, page365_variant_id: null, page365_name: null, code: null, hub_sku: 'ZT9200',
      page365_price_jpy: null, hub_price_jpy: null, page365_available: null, match_result: 'hub_only', category: 'hub_only',
      seen_stock: null, proposed_stock: null, missing_runs: 2 },
  ];
  return { run, items };
}

/** Page365 stock fixtures: the owner's four-line acceptance invoice. */
function buildPage365StockFixtures(cashOrderId: string) {
  const base = {
    page365_no: 900001, cash_order_id: cashOrderId, account_id: null, website_product_id: null,
    held_at: null, released_at: null, resolved_at: null, resolution_note: null,
    created_at: '2026-09-26T02:00:00Z', cash_orders: { invoice_number: '19901' }, layaway_accounts: null,
  };
  const lines = [
    { ...base, id: 'p365-l1', line_no: 1, line_name: 'ZT9001 Test ring K18', first_word: 'ZT9001', quantity: 1,
      match_result: 'matched', stock_state: 'held', flag: null, stock_seen: 2, held_at: '2026-09-26T02:00:00Z' },
    { ...base, id: 'p365-l2', line_no: 2, line_name: 'ZT9002 Test earrings', first_word: 'ZT9002', quantity: 1,
      match_result: 'matched', stock_state: 'none', flag: 'insufficient_stock', stock_seen: 0 },
    { ...base, id: 'p365-l3', line_no: 3, line_name: 'Necklace test pearl 45cm', first_word: 'NECKLACE', quantity: 1,
      match_result: 'unmatched', stock_state: 'none', flag: 'unmatched', stock_seen: null },
    { ...base, id: 'p365-l4', line_no: 4, line_name: 'Resize # 12', first_word: 'RESIZE', quantity: 1,
      match_result: 'not_a_product', stock_state: 'none', flag: null, stock_seen: null },
  ];
  const at = '2026-09-26T01:58:00Z';
  const item = (name: string, kind: 'product' | 'service', price: number, stock_match: unknown) => ({
    kind, name, sku: null, quantity: 1, unit_price_jpy: price, line_total_jpy: price, note: null,
    photo_url: null, source_photo_url: null, photo_note: null, stock_match,
  });
  const draft = {
    id: 'fixture-p365-draft', page365_no: 900001, page365_slug: 'fixture', expires_at: '2099-01-01T00:00:00Z', consumed_at: null,
    payload: {
      page365_no: 900001, page365_slug: 'fixture', currency: 'JPY',
      customer: { name: 'Test Customer', phone: null, address: null, structural_address: null },
      items: [
        item('ZT9001 Test ring K18', 'product', 30000, { first_word: 'ZT9001', result: 'matched', stock_qty: 2, checked_at: at }),
        item('ZT9002 Test earrings', 'product', 20000, { first_word: 'ZT9002', result: 'matched', stock_qty: 0, checked_at: at }),
        item('Necklace test pearl 45cm', 'product', 10000, { first_word: 'NECKLACE', result: 'unmatched', stock_qty: null, checked_at: at }),
        item('Resize # 12', 'service', 3000, { first_word: 'RESIZE', result: 'service', stock_qty: null, checked_at: at }),
      ],
      shipping_jpy: 0, subtotal_jpy: 63000, discount_jpy: 0, total_jpy: 63000,
      fx: { php_jpy_rate: 0.39, source: 'system_settings.php_jpy_rate', read_at: at },
      page365_stage: 'pending', page365_created_at: at, page365_expires_on: null, fetched_at: at, photo_failures: [],
    },
  };
  return { lines, draft };
}

/** PR 2 catalogue fixtures: one product switched to "Don't sync with Page365". */
function buildCatalogSyncFixtures() {
  const product = (id: string, sku: string, name: string, off: boolean, stock: number) => ({
    id, sku, slug: sku.toLowerCase(), name, name_ja: null, karat: null, metals: ['K18'], weight_g: null, condition: 'New',
    origin: 'UNKNOWN', brand: null, description_en: null, description_ja: null, status: 'active',
    created_at: '2026-09-28T00:00:00Z', page365_sync_disabled: off,
    website_product_variants: [{
      id: `${id}-v`, size: null, stone: null, price_jpy: 72980, cost_basis: null, stock_qty: stock, sort: 0,
      website_product_media: [],
    }],
    website_collection_products: [], website_category_products: [],
  });
  return [
    product('fixture-wp-n4020', 'N4020', 'Necklace Tiffany & Co. 750 Open Teardrop (sample)', true, 1),
    product('fixture-wp-r7828', 'R7828', 'Ring 750YG/WG 19.0g Diamond 2.70ct', false, 1),
  ];
}
