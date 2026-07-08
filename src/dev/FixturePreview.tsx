import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import AccountList from '@/pages/AccountList';
import Dashboard from '@/pages/Dashboard';
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
import { FileText } from 'lucide-react';
import ProgressRing from '@/components/shared/ProgressRing';
import PortalBottomNav, { type PortalTab } from '@/components/portal/shared/PortalBottomNav';
import AnimatedNumber from '@/components/portal/shared/AnimatedNumber';
import HeroLayawayCard from '@/components/portal/home/HeroLayawayCard';
import TierStrip from '@/components/portal/home/TierStrip';
import PaymentJourneyTimeline, { buildJourneyEntries } from '@/components/portal/detail/PaymentJourneyTimeline';
import ItemizedTotals from '@/components/portal/detail/ItemizedTotals';
import CompletedPlanBanner from '@/components/portal/detail/CompletedPlanBanner';
import TierCard from '@/components/customers/TierCard';
import AccountStatement from '@/components/statements/AccountStatement';
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
  buildTimelineFixture,
  buildTierFixtures,
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
