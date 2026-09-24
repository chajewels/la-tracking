/**
 * DEV-only fixtures for Sales → Payments and Sales → Waivers (Hub visual
 * refresh, Phase 2B). Seeded into the react-query cache by FixturePreview
 * under the exact keys PaymentSubmissions / PaymentProofs / Waivers read.
 * Never imported by production code.
 *
 * The rows deliberately cover every state the screens render: a split, a
 * cash order, a missing proof, a PDF proof, a customer edit, a possible
 * duplicate, a long name and long references (column fit at 1280px), and
 * each non-pending status for the "All" filters.
 */

type Cur = 'PHP' | 'JPY';

const PROOF = (name: string) => `https://fixture.supabase.co/storage/v1/object/public/payment-proofs/fixture/${name}`;

const layaway = (id: string, inv: string, cur: Cur, name: string) => ({
  account_id: id,
  cash_order_id: null,
  customers: { full_name: name, customer_code: 'CJ-2026-00808' },
  layaway_accounts: { invoice_number: inv, currency: cur, remaining_balance: 20_000, total_amount: 60_000 },
  cash_orders: null,
});
const cash = (id: string, inv: string, cur: Cur, name: string) => ({
  account_id: null,
  cash_order_id: id,
  customers: { full_name: name, customer_code: 'CJ-2026-00816' },
  layaway_accounts: null,
  cash_orders: { invoice_number: inv, currency: cur, customer_id: 'fixture-cust-x', customers: { full_name: name, customer_code: 'CJ-2026-00816' } },
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function submission(id: string, over: Record<string, unknown>) {
  return {
    id,
    customer_id: `cust-${id}`,
    submitted_amount: 0,
    payment_date: '2026-09-22',
    payment_method: 'gcash',
    reference_number: null,
    sender_name: null,
    notes: null,
    proof_url: PROOF(`${id}.jpg`),
    status: 'submitted',
    reviewer_user_id: null,
    reviewer_notes: null,
    confirmed_payment_id: null,
    portal_token: null,
    submission_type: 'single',
    created_at: hoursAgo(2),
    updated_at: hoursAgo(2),
    customer_edited_at: null,
    installment_number: null,
    ...over,
  };
}

export function buildSubmissionFixtures() {
  return [
    submission('fx-sub-01', {
      ...layaway('fixture-acct-0042', '18042', 'PHP', 'Maria Consolación Villanueva-Dela Cruz'),
      submitted_amount: 3_956, payment_method: 'gcash', reference_number: 'GC-2026-0922-99031288412',
      sender_name: 'Maria C. Villanueva', created_at: hoursAgo(1), installment_number: 4,
    }),
    submission('fx-sub-02', {
      ...cash('fixture-cash-0006', '19506', 'JPY', 'Kenji Sato'),
      submitted_amount: 34_000, payment_method: 'bank_transfer', reference_number: 'MUFG-7781', sender_name: 'サトウ ケンジ',
      created_at: hoursAgo(3),
    }),
    submission('fx-sub-03', {
      ...layaway('fixture-acct-0004', '18004', 'PHP', 'Liza Cruz'),
      submitted_amount: 12_000, payment_method: 'bdo', reference_number: 'BDO-55120', submission_type: 'split',
      notes: 'One transfer for both of my plans', created_at: hoursAgo(5),
    }),
    submission('fx-sub-04', {
      ...layaway('fixture-acct-0070', '18070', 'PHP', 'Jose Ramirez'),
      submitted_amount: 8_500, payment_method: 'maya', reference_number: null, proof_url: null,
      notes: 'Will send the slip tonight', created_at: hoursAgo(7),
    }),
    submission('fx-sub-05', {
      ...layaway('fixture-acct-0071', '18071', 'JPY', 'Ana Reyes'),
      submitted_amount: 42_000, payment_method: 'bank_transfer', reference_number: 'SMBC-000912',
      proof_url: PROOF('fx-sub-05-transfer-slip.pdf'), customer_edited_at: hoursAgo(4), created_at: hoursAgo(9),
    }),
    submission('fx-sub-06', {
      ...layaway('fixture-acct-0010', '18010', 'PHP', 'Grace Tan'),
      submitted_amount: 2_500, payment_method: 'gcash', reference_number: 'GC-4410', sender_name: 'Grace Tan',
      status: 'under_review', created_at: hoursAgo(10),
    }),
    submission('fx-sub-07', {
      ...layaway('fixture-acct-0010', '18010', 'PHP', 'Grace Tan'),
      submitted_amount: 2_500, payment_method: 'gcash', reference_number: 'GC-4411', sender_name: 'Grace Tan',
      created_at: hoursAgo(10.2),
    }),
    // Non-pending — only under the All / status filters.
    submission('fx-sub-08', {
      ...layaway('fixture-acct-0002', '18002', 'PHP', 'Ramon Aquino'),
      submitted_amount: 5_000, status: 'confirmed', reviewer_notes: 'Matched GCash statement', created_at: hoursAgo(30),
    }),
    submission('fx-sub-09', {
      ...cash('fixture-cash-0001', '19501', 'PHP', 'Carmela Bautista'),
      submitted_amount: 9_960.19, payment_method: 'bdo', status: 'rejected', reviewer_notes: 'Amount on the slip is ₱9,690 — please check', created_at: hoursAgo(50),
    }),
    submission('fx-sub-10', {
      ...layaway('fixture-acct-0012', '18012', 'JPY', 'Yuki Tanaka'),
      submitted_amount: 15_000, payment_method: 'paypal', status: 'needs_clarification', reviewer_notes: 'Which invoice is this for?', created_at: hoursAgo(70),
    }),
  ];
}

export function buildSubmissionAllocationFixtures() {
  return [
    { id: 'fx-alloc-1', submission_id: 'fx-sub-03', account_id: 'fixture-acct-0004', invoice_number: '18004', allocated_amount: 7_000 },
    { id: 'fx-alloc-2', submission_id: 'fx-sub-03', account_id: 'fixture-acct-0002', invoice_number: '18002', allocated_amount: 5_000 },
  ];
}

export const PAYMENT_METHOD_FIXTURES = ['gcash', 'maya', 'bdo', 'bank_transfer', 'paypal', 'cash'];

/** Keys PaymentSubmissions reads, per status filter. */
export function submissionCacheEntries() {
  const all = buildSubmissionFixtures();
  const byStatus = (s: string) => all.filter((r) => r.status === s);
  return {
    pending: all.filter((r) => r.status === 'submitted' || r.status === 'under_review'),
    all,
    confirmed: byStatus('confirmed'),
    rejected: byStatus('rejected'),
    needs_clarification: byStatus('needs_clarification'),
  } as Record<string, ReturnType<typeof buildSubmissionFixtures>>;
}

export function buildProofIndexFixtures() {
  return buildSubmissionFixtures()
    .map((s) => ({ ...s, status: 'confirmed', proof_url: s.proof_url ?? PROOF(`${s.id}.jpg`) }))
    .slice(0, 8);
}

// ------------------------------------------------------------------ waivers

const penalty = (id: string, stage: string, cycle: number, amount: number, date: string, status = 'unpaid') =>
  ({ id, penalty_stage: stage, penalty_cycle: cycle, penalty_amount: amount, penalty_date: date, status });

function waiver(id: string, acct: { id: string; inv: string; cur: Cur; name: string }, pen: ReturnType<typeof penalty>, over: Record<string, unknown> = {}) {
  return {
    id,
    account_id: acct.id,
    schedule_id: `${acct.id}-sch`,
    penalty_fee_id: pen.id,
    penalty_amount: pen.penalty_amount,
    reason: 'Customer was hospitalised during the due week — medical certificate on file',
    status: 'pending',
    created_at: hoursAgo(20),
    requested_by_user_id: 'fixture-csr',
    approved_by_user_id: null,
    approved_at: null,
    rejected_at: null,
    layaway_accounts: { id: acct.id, invoice_number: acct.inv, currency: acct.cur, customer_id: `cust-${acct.id}`, customers: { full_name: acct.name } },
    penalty_fees: pen,
    ...over,
  };
}

export function buildWaiverFixtures() {
  const a1 = { id: 'fixture-acct-0055', inv: '18055', cur: 'PHP' as Cur, name: 'Maria Consolación Villanueva-Dela Cruz' };
  const a2 = { id: 'fixture-acct-0071', inv: '18071', cur: 'JPY' as Cur, name: 'Ana Reyes' };
  const a3 = { id: 'fixture-acct-0070', inv: '18070', cur: 'PHP' as Cur, name: 'Jose Ramirez' };
  const a4 = { id: 'fixture-acct-0033', inv: '18033', cur: 'PHP' as Cur, name: 'Ramon Aquino' };
  const a5 = { id: 'fixture-acct-0021', inv: '18021', cur: 'JPY' as Cur, name: 'Yuki Tanaka' };
  return [
    waiver('fx-w-01', a1, penalty('fx-p-01', 'week1', 1, 500, '2026-09-08')),
    waiver('fx-w-02', a1, penalty('fx-p-02', 'week2', 1, 500, '2026-09-15')),
    waiver('fx-w-03', a1, penalty('fx-p-03', 'week1', 2, 500, '2026-09-22'), { reason: 'Bank holiday — transfer went through a day late' }),
    waiver('fx-w-04', a2, penalty('fx-p-04', 'week1', 1, 1_000, '2026-09-10'), { reason: 'Paid on time; the bank posted it late' }),
    waiver('fx-w-05', a2, penalty('fx-p-05', 'week2', 1, 1_000, '2026-09-17'), { reason: 'Paid on time; the bank posted it late' }),
    waiver('fx-w-06', a3, penalty('fx-p-06', 'week1', 1, 500, '2026-09-19'), { reason: 'First late payment in 8 months' }),
    // Resolved — only under "All Requests".
    waiver('fx-w-07', a4, penalty('fx-p-07', 'week1', 1, 500, '2026-08-11', 'waived'), { status: 'approved', approved_at: hoursAgo(300), approved_by_user_id: 'fixture-fin' }),
    waiver('fx-w-08', a5, penalty('fx-p-08', 'week2', 1, 1_000, '2026-08-19'), { status: 'rejected', rejected_at: hoursAgo(200), approved_by_user_id: 'fixture-fin', reason: 'Asked after the grace window' }),
  ];
}

// ------------------------------------------------------------------ proof images

/** A small bank-slip drawing so screenshots show a real thumbnail. */
function slipSvg(label: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480">
<rect width="360" height="480" fill="#f4f1ea"/><rect x="0" y="0" width="360" height="70" fill="#1f5fae"/>
<text x="24" y="44" font-family="Arial" font-size="24" font-weight="bold" fill="#fff">Transfer receipt</text>
<text x="24" y="120" font-family="Arial" font-size="14" fill="#555">Reference</text><text x="24" y="144" font-family="monospace" font-size="16" fill="#222">${label}</text>
<text x="24" y="200" font-family="Arial" font-size="14" fill="#555">Amount</text><text x="24" y="232" font-family="Arial" font-size="28" font-weight="bold" fill="#222">SENT</text>
<line x1="24" y1="270" x2="336" y2="270" stroke="#ccc"/><text x="24" y="300" font-family="Arial" font-size="13" fill="#777">Status: Successful</text>
<text x="24" y="440" font-family="Arial" font-size="11" fill="#999">Fixture image — not a real receipt</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * The payment-proofs bucket is private: the real page mints a signed URL per
 * proof. The harness has no session, so answer those calls locally with a
 * drawn slip. Patches only the dev harness's client, only for this bucket.
 */
export function stubProofStorage(storage: { from: (bucket: string) => unknown }) {
  const s = storage as { from: (bucket: string) => Record<string, unknown>; __fixtureStubbed?: boolean };
  if (s.__fixtureStubbed) return;
  const original = s.from.bind(s);
  s.from = (bucket: string) => {
    const real = original(bucket);
    if (bucket !== 'payment-proofs') return real;
    return {
      ...real,
      createSignedUrl: async (path: string) => ({ data: { signedUrl: slipDataUrl(path) }, error: null }),
    };
  };
  s.__fixtureStubbed = true;
}

function slipDataUrl(path: string) {
  return slipSvg(path.split('/').pop()?.replace(/\.[a-z]+$/i, '').toUpperCase() ?? 'SLIP');
}
