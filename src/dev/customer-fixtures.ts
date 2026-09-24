/**
 * DEV-only fixtures for the Customers screens (Hub visual refresh, Phase 3):
 * the directory and one fully-populated customer page. Seeded into the
 * react-query cache by FixturePreview under the exact keys the real pages
 * read — no component code is forked. Never imported by production paths.
 */
import { buildCustomerFixtures } from './fixtures';

export const DEMO_CUSTOMER_ID = 'fixture-cust-demo';

const pad = (n: number, w: number) => String(n).padStart(w, '0');
// Distinct names for the directory (the shared customerName() repeats every
// ten rows): long Filipino, Spanish and Japanese names exercise truncation.
const GIVEN = ['Angelica', 'Bernadette', 'Christopher John', 'Dolores', 'Esperanza Lourdes', 'Francisco', 'Gloria', 'Hiroko', 'Isabel', 'Jose Protacio', 'Katrina Bianca', 'Leonora'];
const FAMILY = ['Aquino III', 'Bautista', 'Concepción-Ilagan', 'dela Rosa', 'Fernandez', 'Macapagal-Reyes', 'Santos', '髙橋（たかはし）'];
const LOCATIONS = ['Japan', 'Philippines', 'Philippines', 'Japan', 'United States', 'Philippines', 'Canada'];

/** The directory: the shared 88 fixture customers plus the demo customer, with contact fields filled in. */
export function buildCustomerDirectoryFixtures(empty = false) {
  if (empty) return [];
  const base = buildCustomerFixtures(false).map((c, i) => ({
    ...c,
    full_name: `${GIVEN[i % GIVEN.length]} ${FAMILY[Math.floor(i / GIVEN.length) % FAMILY.length]}`,
    customer_code: `CJ-2026-${pad((i + 1) * 8, 5)}`,
    facebook_name: i % 3 === 0 ? c.full_name.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '') + `.${i}` : null,
    messenger_link: i % 4 === 0 ? `https://m.me/fixture.${i}` : null,
    mobile_number: i % 5 === 0 ? `+63 917 ${pad(100 + i, 3)} ${pad(1000 + i * 7, 4)}` : null,
    email: i % 6 === 0 ? `customer${i}@example.com` : null,
    notes: null,
    location: LOCATIONS[i % LOCATIONS.length],
    auth_user_id: null,
  }));
  return [DEMO_CUSTOMER, ...base];
}

const DEMO_CUSTOMER = {
  id: DEMO_CUSTOMER_ID,
  full_name: 'Maria Consolación Villanueva-Dela Cruz',
  customer_code: 'CJ-2026-00808',
  facebook_name: 'maria.consolacion.vdc',
  messenger_link: 'https://m.me/maria.consolacion.vdc',
  mobile_number: '+63 917 555 0142',
  email: 'maria.vdc@example.com',
  notes: 'Prefers GCash. Ring size 6 — resized once (Apr).',
  location: 'Philippines',
  auth_user_id: null,
  setup_link_sent_at: null,
  is_test: false,
  created_at: '2026-03-20T03:00:00Z',
};

/** Loyalty tier map the directory reads (customer_id → tier name). */
export function buildCustomerTierMap() {
  const m = new Map<string, string>();
  m.set(DEMO_CUSTOMER_ID, 'Radiant');
  const tiers = ['Glimmer', 'Radiant', 'Elite', 'Crown VIP'];
  for (let i = 0; i < 88; i += 5) m.set(`fixture-cust-${pad(i, 4)}`, tiers[(i / 5) % tiers.length]);
  return m;
}

/** Demo customer's layaway accounts: one active PHP plan (penalty + service), one completed JPY plan. */
const ACTIVE = {
  id: 'fixture-demo-acct-1', customer_id: DEMO_CUSTOMER_ID, invoice_number: '18042', currency: 'PHP', status: 'active',
  total_amount: 27_480, total_paid: 17_112, remaining_balance: 10_368, downpayment_amount: 7_200,
  payment_plan_months: 6, order_date: '2026-03-12', created_at: '2026-03-12T03:00:00Z', notes: null,
};
const DONE = {
  id: 'fixture-demo-acct-2', customer_id: DEMO_CUSTOMER_ID, invoice_number: '17611', currency: 'JPY', status: 'completed',
  total_amount: 186_000, total_paid: 186_000, remaining_balance: 0, downpayment_amount: 55_800,
  payment_plan_months: 3, order_date: '2025-11-02', created_at: '2025-11-02T03:00:00Z', notes: null,
};

const row = (acct: typeof ACTIVE, n: number, due: string, base: number, paid: number, status: string, penalty = 0) => ({
  id: `${acct.id}-s${n}`, account_id: acct.id, installment_number: n, due_date: due,
  base_installment_amount: base, penalty_amount: penalty, carried_amount: 0,
  total_due_amount: base + penalty, paid_amount: paid, status,
});
const pay = (acct: typeof ACTIVE, n: number, amount: number, date: string, extra: Record<string, unknown> = {}) => ({
  id: `${acct.id}-p${n}`, account_id: acct.id, amount_paid: amount, date_paid: date, created_at: `${date}T04:00:00Z`,
  reference_number: null, remarks: null, voided_at: null, submission_type: 'single', ...extra,
});

export function buildCustomerDetailFixture() {
  return {
    customer: DEMO_CUSTOMER,
    accounts: [
      {
        account: ACTIVE,
        schedule: [
          row(ACTIVE, 1, '2026-04-12', 3_380, 3_380, 'paid'),
          row(ACTIVE, 2, '2026-05-12', 3_380, 3_880, 'paid', 500),
          row(ACTIVE, 3, '2026-06-12', 3_380, 1_652, 'partially_paid'),
          row(ACTIVE, 4, '2026-07-12', 3_380, 0, 'overdue', 500),
          row(ACTIVE, 5, '2026-08-12', 3_380, 0, 'pending'),
          row(ACTIVE, 6, '2026-09-12', 3_380, 0, 'pending'),
        ],
        penalties: [],
        payments: [
          pay(ACTIVE, 1, 7_200, '2026-03-14', { reference_number: 'DP-2201', remarks: 'downpayment', submission_type: 'downpayment' }),
          pay(ACTIVE, 2, 3_380, '2026-04-11'),
          pay(ACTIVE, 3, 3_880, '2026-05-13'),
          pay(ACTIVE, 4, 1_652, '2026-06-14'),
          pay(ACTIVE, 5, 1_000, '2026-06-20'),
        ],
        services: [{ id: 'fixture-demo-svc-1', account_id: ACTIVE.id, service_type: 'resize', description: 'Ring resize to 6', amount: 800 }],
        schedulePaymentDates: {},
      },
      {
        account: DONE,
        schedule: [
          row(DONE as never, 1, '2025-12-02', 43_400, 43_400, 'paid'),
          row(DONE as never, 2, '2026-01-02', 43_400, 43_400, 'paid'),
          row(DONE as never, 3, '2026-02-02', 43_400, 43_400, 'paid'),
        ],
        penalties: [],
        payments: [
          pay(DONE as never, 1, 55_800, '2025-11-02', { reference_number: 'DP-1740', remarks: 'downpayment', submission_type: 'downpayment' }),
          pay(DONE as never, 2, 43_400, '2025-12-01'),
          pay(DONE as never, 3, 43_400, '2026-01-02'),
          pay(DONE as never, 4, 43_400, '2026-02-01'),
        ],
        services: [],
        schedulePaymentDates: {},
      },
    ],
  };
}

/** The demo customer's cash orders (CustomerCashOrdersTab reads ['cash-orders-by-customer', id]). */
export function buildCustomerCashOrderFixtures() {
  const o = (i: number, status: string, currency: 'PHP' | 'JPY', total: number, paid: number, date: string, item: string) => ({
    id: `fixture-demo-cash-${i}`, invoice_number: String(19480 + i), currency, total_amount: total, total_paid: paid,
    remaining_balance: total - paid, status, order_date: date, item_description: item,
    created_at: `${date}T03:00:00Z`, source_channel: 'hub', web_reference: null,
  });
  return [
    o(3, 'pending', 'JPY', 92_000, 40_000, '2026-09-10', '18K yellow-gold tennis bracelet, 4.2 ct total — fixture with a long description'),
    o(2, 'completed', 'PHP', 18_450.5, 18_450.5, '2026-07-22', 'Pearl drop earrings'),
    o(1, 'cancelled', 'PHP', 9_800, 0, '2026-05-03', 'Initial pendant'),
  ];
}
