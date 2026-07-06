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
  return {
    id: `fixture-acct-${pad(i, 4)}`,
    invoice_number: String(18000 + i),
    customer_id: `fixture-cust-${pad(i, 4)}`,
    currency,
    status,
    total_amount: total,
    total_paid: paid,
    remaining_balance: Math.round((total - paid) * 100) / 100,
    payment_plan_months: [3, 6, 8, 10, 12][i % 5],
    order_date: isoDate(i),
    created_at: `${isoDate(i)}T08:00:00Z`,
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
  rows.push(test);
  return rows;
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
