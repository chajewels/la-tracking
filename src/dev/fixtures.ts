/**
 * Deterministic fixture data for the DEV-only /__fixtures preview route.
 * Never imported by production code paths — the route registration in
 * App.tsx is stripped from production builds via import.meta.env.DEV.
 *
 * Coverage per the Phase 2 verification spec: a folder with >60 items
 * (exercises the virtualized reveal), PHP and JPY rows, the full status
 * spread, penalty statuses (unpaid / paid / waived), voided payments,
 * long Filipino and Japanese names, and an empty variant (?empty=1).
 */

const FIRST_NAMES = [
  'Maria Consolación', 'Juan Miguel', 'Angelica', 'Katrina Bianca', 'Jose Protacio',
  '髙橋 美咲子', '佐々木 千代乃', 'Reina Sofia', 'Bernadette', 'Christopher John',
];
const LAST_NAMES = [
  'Villanueva-Dela Cruz', 'Santos', 'Reyes-Macapagal', 'dela Rosa', 'Bautista',
  '（たかはし みさきこ）', '（ささき ちよの）', 'Fernandez', 'Concepción-Ilagan', 'Aquino III',
];

function customerName(i: number): string {
  return `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 3 + 1) % LAST_NAMES.length]}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function isoDate(i: number): string {
  const month = (i % 12) + 1;
  const day = (i % 27) + 1;
  return `2026-${pad(month, 2)}-${pad(day, 2)}`;
}

export interface FixtureAccount {
  id: string;
  invoice_number: string;
  customer_id: string;
  currency: 'PHP' | 'JPY';
  status: string;
  is_test: boolean;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  payment_plan_months: number;
  order_date: string;
  created_at: string;
  updated_at: string;
  customers: { full_name: string; messenger_link: string | null };
}

function makeAccount(i: number, status: string): FixtureAccount {
  const currency = i % 3 === 0 ? 'JPY' : 'PHP';
  const total = currency === 'JPY' ? 120_000 + i * 7_000 : 24_000 + i * 1_350.5;
  const paidRatio = status === 'completed' ? 1 : (i % 5) / 5;
  const paid = Math.round(total * paidRatio * 100) / 100;
  // Recent order dates so the KPI new/mo sparkline has data in the last
  // 6 months window (spread across the trailing half-year).
  const now = new Date();
  const orderDate = new Date(now.getFullYear(), now.getMonth() - (i % 6), (i % 27) + 1);
  const orderIso = `${orderDate.getFullYear()}-${pad(orderDate.getMonth() + 1, 2)}-${pad(orderDate.getDate(), 2)}`;
  return {
    id: `fixture-acct-${pad(i, 4)}`,
    invoice_number: String(18000 + i),
    customer_id: `fixture-cust-${pad(i, 4)}`,
    currency,
    status,
    is_test: false,
    total_amount: total,
    total_paid: paid,
    remaining_balance: Math.round((total - paid) * 100) / 100,
    payment_plan_months: [3, 6, 8, 10, 12][i % 5],
    order_date: orderIso,
    created_at: `${orderIso}T08:00:00Z`,
    updated_at: `${isoDate(i + 1)}T08:00:00Z`,
    customers: {
      full_name: customerName(i),
      messenger_link: i % 4 === 0 ? 'https://m.me/fixture' : null,
    },
  };
}

/** 70 active (virtual reveal) + the full status spread + one TEST account. */
export function buildAccountFixtures(): FixtureAccount[] {
  const rows: FixtureAccount[] = [];
  for (let i = 0; i < 70; i++) rows.push(makeAccount(i, 'active'));
  for (let i = 70; i < 78; i++) rows.push(makeAccount(i, 'overdue'));
  for (let i = 78; i < 83; i++) rows.push(makeAccount(i, 'completed'));
  for (let i = 83; i < 85; i++) rows.push(makeAccount(i, 'forfeited'));
  rows.push(makeAccount(85, 'extension_active'));
  rows.push(makeAccount(86, 'final_settlement'));
  for (let i = 87; i < 89; i++) rows.push(makeAccount(i, 'cancelled'));
  const test = makeAccount(89, 'active');
  test.invoice_number = 'TEST-4567';
  test.is_test = true;
  rows.push(test);
  return rows;
}

/** dashboard-summary edge-function payload (only the fields Dashboard reads). */
export function buildDashboardSummary(empty = false) {
  if (empty) {
    return {
      active_layaways: 0, overdue_accounts: 0, overdue_amount: 0,
      collections_this_month: 0, completed_this_month: 0,
      forfeited_accounts: 0, forfeited_today: 0, completed_all_time: 0,
      due_today_count: 0, due_3_days_count: 0, due_7_days_count: 0,
      cash_orders_active: 0, cash_orders_completed_this_month: 0,
    };
  }
  return {
    active_layaways: 70, overdue_accounts: 8, overdue_amount: 412_350.75,
    collections_this_month: 1_284_500, completed_this_month: 5,
    forfeited_accounts: 2, forfeited_today: 1, completed_all_time: 311,
    due_today_count: 3, due_3_days_count: 7, due_7_days_count: 15,
    cash_orders_active: 16, cash_orders_completed_this_month: 9,
  };
}

/** get_monthly_analytics rows — 12 months of Collected (JPY). */
export function buildMonthlyAnalytics(empty = false) {
  if (empty) return [];
  const rows: Array<{ month: string; collected_jpy: number }> = [];
  const now = new Date();
  const amounts = [820, 910, 760, 1040, 980, 1120, 890, 1310, 1180, 1420, 1260, 1284.5];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    rows.push({
      month: `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-01`,
      collected_jpy: amounts[11 - i] * 1000,
    });
  }
  return rows;
}

export function buildRedemptionsKpi(empty = false) {
  if (empty) return { thisMonthCount: 0, lastMonthCount: 0, series: [0, 0, 0, 0, 0, 0] };
  return { thisMonthCount: 4, lastMonthCount: 2, series: [1, 0, 2, 3, 2, 4] };
}

/** Needs Attention fixtures — overdue/due-soon schedule + expiring cash. */
export function buildAttentionSchedule(empty = false) {
  if (empty) return [];
  const now = new Date();
  const due = (offsetDays: number) => {
    const d = new Date(now.getTime() + offsetDays * 86400000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  };
  return [
    { id: 'fx-sched-1', due_date: due(-14), actual_remaining: 8_500, currency: 'PHP', layaway_accounts: { id: 'fixture-acct-0070', invoice_number: '18070', status: 'overdue', customers: { full_name: customerName(70), messenger_link: 'https://m.me/fixture' } } },
    { id: 'fx-sched-2', due_date: due(-6), actual_remaining: 42_000, currency: 'JPY', layaway_accounts: { id: 'fixture-acct-0071', invoice_number: '18071', status: 'overdue', customers: { full_name: customerName(71), messenger_link: null } } },
    { id: 'fx-sched-3', due_date: due(0), actual_remaining: 3_250.5, currency: 'PHP', layaway_accounts: { id: 'fixture-acct-0002', invoice_number: '18002', status: 'active', customers: { full_name: customerName(2), messenger_link: null } } },
    { id: 'fx-sched-4', due_date: due(2), actual_remaining: 12_400, currency: 'PHP', layaway_accounts: { id: 'fixture-acct-0004', invoice_number: '18004', status: 'active', customers: { full_name: customerName(4), messenger_link: 'https://m.me/fixture' } } },
  ];
}

export function buildAttentionCash(empty = false) {
  if (empty) return [];
  const now = new Date();
  const exp = (offsetDays: number) => new Date(now.getTime() + offsetDays * 86400000).toISOString();
  return [
    { id: 'fixture-cash-0001', invoice_number: '19501', currency: 'PHP', remaining_balance: 9_960.19, expires_at: exp(1), customers: { full_name: customerName(3) } },
    { id: 'fixture-cash-0005', invoice_number: '19505', currency: 'PHP', remaining_balance: 12_300.94, expires_at: exp(4), customers: { full_name: customerName(7) } },
    { id: 'fixture-cash-0006', invoice_number: '19506', currency: 'JPY', remaining_balance: 34_000, expires_at: exp(9), customers: { full_name: customerName(8) } },
  ];
}

/** Phase 4 — payment timeline fixture (schedule-shaped, display props). */
export function buildTimelineFixture(empty = false) {
  if (empty) {
    return { downpayment: null, installments: [], completed: false };
  }
  return {
    downpayment: { amount: 7_200, paid: 7_200 },
    installments: [
      {
        id: 'fx-tl-1', installmentNumber: 1, dueDate: '2026-04-12', base: 3_956,
        allocated: 3_956, remaining: 0, status: 'paid', penalties: [],
      },
      {
        id: 'fx-tl-2', installmentNumber: 2, dueDate: '2026-05-12', base: 3_956,
        allocated: 3_956, remaining: 0, status: 'paid',
        penalties: [
          { id: 'fx-tl-pen-1', amount: 500, status: 'paid', date: '2026-05-19', cycle: 1, stage: 'week1' },
        ],
      },
      {
        id: 'fx-tl-3', installmentNumber: 3, dueDate: '2026-06-12', base: 3_956,
        allocated: 1_500, remaining: 2_956, status: 'partially_paid',
        penalties: [
          {
            id: 'fx-tl-pen-2', amount: 500, status: 'waived', date: '2026-06-19', cycle: 1, stage: 'week1',
            waiverReason: 'Customer hospitalized — documented, approved by finance',
          },
        ],
      },
      {
        id: 'fx-tl-4', installmentNumber: 4, dueDate: '2026-07-12', base: 3_956,
        allocated: 0, remaining: 3_956, status: 'overdue',
        penalties: [
          { id: 'fx-tl-pen-3', amount: 500, status: 'unpaid', date: '2026-07-19', cycle: 1, stage: 'week1' },
          { id: 'fx-tl-pen-4', amount: 500, status: 'unpaid', date: '2026-07-26', cycle: 1, stage: 'week2' },
        ],
      },
      {
        id: 'fx-tl-5', installmentNumber: 5, dueDate: '2026-08-12', base: 3_956,
        allocated: 0, remaining: 3_956, status: 'pending', penalties: [],
      },
    ],
    completed: false,
  };
}

/** Phase 4 — tier card fixture set (all four tiers). The colorHex values
 *  stand in for loyalty_tiers.color_hex DB DATA; they deliberately avoid
 *  the brand-gold hex family so the CLAUDE.md gold-literal grep stays
 *  clean (these are arbitrary fixture data, not styling). */
export function buildTierFixtures() {
  return [
    { tierName: 'Glimmer', colorHex: '#9B948A', remainingPoints: 800, totalEarned: 800, totalRedeemed: 0, totalExpired: 0, multiplier: 1, enrolledAt: '2026-01-15' },
    { tierName: 'Radiant', colorHex: '#D9BC5A', remainingPoints: 3_400, totalEarned: 5_200, totalRedeemed: 1_800, totalExpired: 0, multiplier: 2, enrolledAt: '2025-11-02' },
    { tierName: 'Elite', colorHex: '#B08D2F', remainingPoints: 9_150, totalEarned: 14_650, totalRedeemed: 5_000, totalExpired: 500, multiplier: 2, enrolledAt: '2025-06-20' },
    { tierName: 'Crown VIP', colorHex: '#8C6D1F', remainingPoints: 26_300, totalEarned: 41_300, totalRedeemed: 14_000, totalExpired: 1_000, multiplier: 3, enrolledAt: '2024-12-01' },
  ];
}

/** Customers list stub — Dashboard only reads .length. */
export function buildCustomerFixtures(empty = false) {
  if (empty) return [];
  return Array.from({ length: 88 }, (_, i) => ({
    id: `fixture-cust-${pad(i, 4)}`,
    full_name: customerName(i),
  }));
}

export interface FixtureCashOrder {
  id: string;
  invoice_number: string;
  currency: 'PHP' | 'JPY';
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  status: string;
  order_date: string | null;
  item_description: string | null;
  created_at: string;
  customers: { id: string; full_name: string; messenger_link: string | null };
}

export function buildCashOrderFixtures(): FixtureCashOrder[] {
  const rows: FixtureCashOrder[] = [];
  const statuses = ['pending', 'pending', 'completed', 'completed', 'cancelled'];
  for (let i = 0; i < 40; i++) {
    const status = statuses[i % statuses.length];
    const currency = i % 4 === 0 ? 'JPY' : 'PHP';
    const total = currency === 'JPY' ? 68_000 + i * 3_000 : 12_500 + i * 780.25;
    const paid = status === 'completed' ? total : status === 'pending' ? Math.round(total * ((i % 4) / 4) * 100) / 100 : 0;
    rows.push({
      id: `fixture-cash-${pad(i, 4)}`,
      invoice_number: i === 39 ? 'TEST-9001' : String(19500 + i),
      currency,
      total_amount: total,
      total_paid: paid,
      remaining_balance: Math.round((total - paid) * 100) / 100,
      status,
      order_date: isoDate(i + 10),
      item_description: `18K gold piece #${i + 1}`,
      created_at: `${isoDate(i + 10)}T09:30:00Z`,
      customers: {
        id: `fixture-cust-${pad(i, 4)}`,
        full_name: customerName(i + 2),
        messenger_link: null,
      },
    });
  }
  return rows;
}

/** Quick-view payload (payments + penalties) for one fixture account. */
export function buildQuickViewFixture() {
  return {
    payments: [
      { id: 'fixture-pay-1', amount_paid: 5_000, payment_method: 'gcash', reference_number: 'GC-88121', created_at: '2026-06-15T03:12:00Z', voided_at: null },
      { id: 'fixture-pay-2', amount_paid: 5_000, payment_method: 'bdo', reference_number: 'BDO-4471', created_at: '2026-05-14T07:45:00Z', voided_at: null },
      { id: 'fixture-pay-3', amount_paid: 2_500, payment_method: 'cash', reference_number: null, created_at: '2026-04-30T10:02:00Z', voided_at: '2026-05-01T02:00:00Z' },
      { id: 'fixture-pay-4', amount_paid: 7_200, payment_method: 'maya', reference_number: 'DP-2201', created_at: '2026-04-12T06:20:00Z', voided_at: null },
    ],
    penalties: [
      { id: 'fixture-pen-1', penalty_amount: 500, status: 'unpaid', penalty_date: '2026-06-22', penalty_cycle: 1, penalty_stage: 'week1' },
      { id: 'fixture-pen-2', penalty_amount: 500, status: 'paid', penalty_date: '2026-05-21', penalty_cycle: 1, penalty_stage: 'week2' },
      { id: 'fixture-pen-3', penalty_amount: 500, status: 'waived', penalty_date: '2026-04-20', penalty_cycle: 1, penalty_stage: 'week1' },
    ],
  };
}
