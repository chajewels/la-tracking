// Website receipts (docs/RECEIPTS.md). Deno, because the PDF renderer and the
// routes import npm: specifiers. The tax maths itself is pinned by vitest
// (src/test/receipt-math.test.ts) and the SQL by supabase/tests/website-receipts/.
//
// RECEIPT_TEST_FONT=/path/NotoSansJP-Regular.ttf renders real PDFs (the font is
// not in the repo — owner rule); without it the render test is skipped.
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { COMPANY_NAME } from '../supabase/functions/_shared/transactional-email-templates/brand.ts'
import {
  ISSUER, RECEIPT_FONT_PATH, RECEIPT_SEAL_PATH, paymentRows, receiptRows, renderReceiptPdf, verifyUrl,
  type ReceiptPayload,
} from '../supabase/functions/_shared/receipt-pdf.ts'
import { receiptPdf, updateReceiptDetails, verifyReceipt, verifyRateLimited } from '../supabase/functions/_shared/website-receipts.ts'
import { receiptEmailDone, receiptEmailKey } from '../supabase/functions/_shared/receipt-email.ts'
import { ReceiptReadyEmail } from '../supabase/functions/_shared/email-templates/receipt-ready.tsx'
import { LayawayReceiptReadyEmail } from '../supabase/functions/_shared/email-templates/layaway-receipt-ready.tsx'

function eq(a: unknown, b: unknown, what: string) {
  const x = JSON.stringify(a), y = JSON.stringify(b)
  if (x !== y) throw new Error(`${what}: expected ${y}, got ${x}`)
}
function ok(c: unknown, what: string) {
  if (!c) throw new Error(what)
}

const yen: ReceiptPayload = {
  receipt_number: 'CJR-2026-000042', order_number: 'CJ-W-900501', currency: 'JPY',
  lines: {
    items: [{ title: 'K18 ネックレス', quantity: 1, line_total_jpy: 60000 }, { title: 'Earrings', quantity: 2, line_total_jpy: 38000 }],
    goods_total: 98000, discount: 5000, coupon_code: 'WELCOME', points: 3000, shipping: 800, cod_fee: 1150, penalties: 0, refunds: 0,
    payments: [{ method: 'cod', amount: 81950 }, { method: 'store_credit', amount: 10000 }],
    product_amount: 98000, subtotal: 89091, tax: 8909, discount_total: 8000, received: 91950, adds_up: true,
  },
  total_paid: 91950, penalty_total: 0, taxable_total: 98000, subtotal: 89091, tax_amount: 8909, fx_rate_used: null,
  addressee: '株式会社テスト', purpose: 'お品代として', verify_code: '0123456789abcdef0123456789abcdef01234567',
  issued_at: '2026-10-27T03:00:00Z',
}
const php: ReceiptPayload = {
  ...yen, receipt_number: 'CJR-2026-000043', order_number: 'CJ-W-900701', currency: 'PHP',
  lines: {
    items: [{ title: 'Bracelet', quantity: 1, line_total_jpy: 100000 }],
    goods_total: 42000, discount: 0, points: 0, shipping: 0, cod_fee: 0, penalties: 1000, refunds: 0,
    payments: [{ method: 'bdo', amount: 12600 }, { method: 'gcash', amount: 30400 }],
    product_amount: 42000, subtotal: 38182, tax: 3818, discount_total: 0, received: 43000, adds_up: true,
  },
  total_paid: 43000, penalty_total: 1000, taxable_total: 42000, subtotal: 38182, tax_amount: 3818, fx_rate_used: 0.42,
  addressee: null,
}

const M = '\u2212'
Deno.test('yen totals block (owner layout): subtotal, 10% tax, discount = coupon + points, shipping, COD fee, total', () => {
  eq(receiptRows(yen, 'ja').map((r) => [r.label, r.value]), [
    ['K18 ネックレス　× 1', '¥60,000'],
    ['Earrings　× 2', '¥38,000'],
    ['小計（税抜）', '¥89,091'],
    ['消費税（10%）', '¥8,909'],
    ['割引', `${M}¥8,000`],
    ['送料', '¥800'],
    ['代引手数料', '¥1,150'],
    ['合計（税込）', '¥91,950'],
  ], 'yen rows ja')
  eq(receiptRows(yen, 'en').slice(2).map((r) => r.label), ['Subtotal (excl. tax)', '10% Tax', 'Discount', 'Shipping fee', 'COD fee', 'Total (tax incl.)'], 'yen labels en')
  eq(paymentRows(yen, 'ja').map((r) => r.label), ['代金引換', 'ストアクレジット'], 'store credit is a payment line')
})

Deno.test('owner example: ¥100,000, no discount, no shipping — discount and shipping still shown, COD fee and late fee not', () => {
  const r: ReceiptPayload = { ...yen, lines: { items: [{ title: 'Ring', quantity: 1, line_total_jpy: 100000 }], discount_total: 0, shipping: 0, cod_fee: 0, payments: [] },
    total_paid: 100000, penalty_total: 0, taxable_total: 100000, subtotal: 90909, tax_amount: 9091 }
  eq(receiptRows(r, 'ja').slice(1).map((x) => [x.label, x.value]), [
    ['小計（税抜）', '¥90,909'], ['消費税（10%）', '¥9,091'], ['割引', `${M}¥0`], ['送料', '¥0'], ['合計（税込）', '¥100,000'],
  ], 'owner example')
})

Deno.test('peso receipt: every line in PHP, late fee shown, no yen and no rate anywhere', () => {
  const rows = receiptRows(php, 'en')
  eq(rows.map((r) => [r.label, r.value]), [
    ['Bracelet　× 1', ''],
    ['Subtotal (excl. tax)', 'PHP 38,182'],
    ['10% Tax', 'PHP 3,818'],
    ['Discount', `${M}PHP 0`],
    ['Shipping fee', 'PHP 0'],
    ['Late fee', 'PHP 1,000'],
    ['Total (tax incl.)', 'PHP 43,000'],
  ], 'peso rows')
  for (const lang of ['ja', 'en'] as const) {
    const all = JSON.stringify([receiptRows(php, lang), paymentRows(php, lang)])
    ok(!/[¥₱]|0\.42|JPY/.test(all), `no yen / rate on a peso receipt (${lang})`)
  }
})

Deno.test('no layaway wording anywhere the receipt prints', () => {
  for (const lang of ['ja', 'en'] as const) {
    const all = JSON.stringify([receiptRows(php, lang), paymentRows(php, lang)])
    ok(!/layaway|lay-away|分割|レイアウェイ|予約/i.test(all), `layaway wording in ${lang}`)
  }
})

Deno.test('the issuer block is the owner\'s exact text; verify link on chajewelsjp.com', () => {
  eq(ISSUER.nameJa, 'Ｃｈａ　Ｊｅｗｅｌｓ株式会社', 'name')
  eq(ISSUER.registration, 'T7011801044120', 'registration')
  eq(ISSUER.tel, '03-6657-6129', 'tel')
  eq(verifyUrl('ab'), 'https://chajewelsjp.com/receipts/verify?code=ab', 'verify url')
  eq([RECEIPT_FONT_PATH, RECEIPT_SEAL_PATH], ['fonts/NotoSansJP-Regular.ttf', 'seal/seal.png'], 'asset paths')
})

const FONT = Deno.env.get('RECEIPT_TEST_FONT')
Deno.test({
  name: 'renders a real PDF (whole font, no form fields, reissue mark)',
  ignore: !FONT,
  fn: async () => {
    const font = await Deno.readFile(FONT!)
    for (const [r, lang, reissue] of [[yen, 'ja', false], [php, 'en', true]] as const) {
      const t = performance.now()
      const bytes = await renderReceiptPdf({ receipt: r, lang, issueNo: reissue ? 2 : 1, isReissue: reissue, downloadedAt: '2026-10-28T05:00:00Z' }, font, null)
      const ms = Math.round(performance.now() - t)
      const head = new TextDecoder('latin1').decode(bytes.slice(0, 8))
      ok(head.startsWith('%PDF-'), 'a PDF')
      const text = new TextDecoder('latin1').decode(bytes)
      ok(!text.includes('/AcroForm'), 'no form fields')
      console.log(`  ${r.currency} ${lang}: ${ms} ms, ${bytes.length} bytes`)
    }
  },
})

// ------------------------------------------------------------------ routes
type Call = { fn: string; args: unknown }
function fakeDb(opts: { receipt?: Record<string, unknown> | null; font?: boolean; rpc?: Record<string, unknown> }) {
  const calls: Call[] = []
  const db = {
    calls,
    from: (_t: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.receipt ?? null, error: null }) }) }),
    }),
    storage: {
      from: () => ({
        download: (path: string) =>
          Promise.resolve(path.startsWith('fonts/') && opts.font ? { data: new Blob([new Uint8Array([1])]), error: null } : { data: null, error: { message: 'not found' } }),
      }),
    },
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args })
      return Promise.resolve({ data: opts.rpc?.[fn] ?? null, error: null })
    },
  }
  return db
}

Deno.test('PDF route: another customer\'s receipt is not found; a cancelled one is refused; nothing recorded', async () => {
  const other = fakeDb({ receipt: { id: 'x', status: 'issued', customer_id: 'someone-else' } })
  const r1 = await receiptPdf(other, 'me', '00000000-0000-0000-0000-000000000001', 'ja')
  eq(r1.status, 404, 'other customer')
  const cancelled = fakeDb({ receipt: { id: 'x', status: 'cancelled', customer_id: 'me' } })
  const r2 = await receiptPdf(cancelled, 'me', '00000000-0000-0000-0000-000000000001', 'ja')
  eq(r2.status, 409, 'cancelled')
  eq([...other.calls, ...cancelled.calls].length, 0, 'no download recorded')
})

Deno.test('PDF route: a missing font answers 503 BEFORE a download is recorded (no false reissue)', async () => {
  const db = fakeDb({ receipt: { id: 'x', status: 'issued', customer_id: 'me' }, font: false })
  const r = await receiptPdf(db, 'me', '00000000-0000-0000-0000-000000000002', 'en')
  eq(r.status, 503, 'font missing')
  eq(db.calls.filter((c) => c.fn === 'record_website_receipt_issue').length, 0, 'not recorded')
})

Deno.test('PATCH: limits checked before the RPC; the RPC gets trimmed values', async () => {
  const db = fakeDb({ rpc: { update_website_receipt_details: { ok: true, addressee: 'A', purpose: 'お品代として' } } })
  const bad = await updateReceiptDetails(db, 'me', '00000000-0000-0000-0000-000000000003', { addressee: 'あ'.repeat(61) })
  eq(bad.status, 400, 'too long')
  eq(db.calls.length, 0, 'no rpc on a bad body')
  const good = await updateReceiptDetails(db, 'me', '00000000-0000-0000-0000-000000000003', { addressee: '  A  ', purpose: '' })
  eq(good.status, 200, 'ok')
  eq(db.calls[0], { fn: 'update_website_receipt_details', args: { p_receipt_id: '00000000-0000-0000-0000-000000000003', p_customer_id: 'me', p_addressee: 'A', p_purpose: 'お品代として' } }, 'rpc args')
})

Deno.test('verify: minimal answer only, even if the RPC returned more', async () => {
  const db = fakeDb({ rpc: { verify_website_receipt: { receipt_number: 'CJR-2026-000001', issued_at: '2026-10-27T03:00:00Z', total: 100000, currency: 'JPY', status: 'valid', customer: 'LEAK', items: ['LEAK'] } } })
  const req = new Request('https://x/receipts/verify', { headers: { 'x-forwarded-for': '203.0.113.9' } })
  const res = await verifyReceipt(db, req, 'A'.repeat(40))
  const body = await res.json()
  eq(Object.keys(body).sort(), ['currency', 'issued_at', 'receipt_number', 'status', 'total'], 'keys')
  const bad = await verifyReceipt(db, new Request('https://x', { headers: { 'x-forwarded-for': '203.0.113.10' } }), 'short')
  eq(bad.status, 404, 'malformed code')
})

Deno.test('verify rate limit: 30 per IP per 10 minutes', () => {
  const ip = '198.51.100.7'
  for (let i = 0; i < 30; i++) ok(!verifyRateLimited(ip, 1_000_000), `hit ${i}`)
  ok(verifyRateLimited(ip, 1_000_000), '31st refused')
  ok(!verifyRateLimited(ip, 1_000_000 + 11 * 60 * 1000), 'window passes')
})

// ------------------------------------------------------------------- email
Deno.test('receipt-ready emails link to My Account only (never the PDF), layaway English only', async () => {
  const order = await renderEmail(React.createElement(ReceiptReadyEmail, { lang: 'ja', reference: 'CJ-W-1', receiptNumber: 'CJR-2026-000001', currency: 'JPY', total: 1000, orderUrl: 'https://www.chajewelsjp.com/account/orders/abc' }))
  ok(order.includes('https://www.chajewelsjp.com/account/orders/abc'), 'order link')
  ok(order.includes('領収書を発行しました') && order.includes('Your receipt is ready'), 'JA then EN')
  const plan = await renderEmail(React.createElement(LayawayReceiptReadyEmail, { reference: 'CJ-W-2', receiptNumber: 'CJR-2026-000002', currency: 'PHP', total: 43000, planUrl: 'https://www.chajewelsjp.com/account/layaway/def' }))
  ok(plan.includes('/account/layaway/def'), 'plan link')
  for (const html of [order, plan]) {
    ok(!/\.pdf|\/pdf\b|receipts\/[0-9a-f-]{36}/i.test(html), 'no PDF link')
  }
  ok(!/[\u3040-\u30ff\u4e00-\u9faf]/.test(plan.split(COMPANY_NAME).join('')), 'plan email has no Japanese (registered company name excepted)')
})

Deno.test('email queue outcomes', () => {
  ok(receiptEmailDone({ sent: true }), 'sent')
  ok(receiptEmailDone({ sent: false, reason: 'test_customer' }), 'test customer leaves the queue')
  ok(receiptEmailDone({ sent: false, reason: 'no_address' }), 'no address leaves the queue')
  ok(!receiptEmailDone({ sent: false, reason: 'error' }), 'error is retried')
  ok(!receiptEmailDone({ sent: false, reason: 'not_configured' }), 'not configured is retried')
  eq(receiptEmailKey('r1'), 'receipt-ready-r1', 'idempotency key')
})

// ---------------------------------------------------------------- migration
Deno.test('migration: no comment line inside a function body (Lovable strips them)', async () => {
  const sql = await Deno.readTextFile(new URL('../supabase/migrations/20270216100000_website_receipts.sql', import.meta.url))
  const bodies = [...sql.matchAll(/\$fn\$([\s\S]*?)\$fn\$/g)].map((m) => m[1])
  ok(bodies.length >= 14, `function bodies found: ${bodies.length}`)
  const bad = bodies.filter((b) => /^\s*--/m.test(b))
  eq(bad.length, 0, 'in-body comments')
  ok(!/DELETE FROM public\.website_receipts/i.test(sql), 'never deletes receipts')
  ok(/DEFERRABLE INITIALLY DEFERRED/.test(sql), 'deferred triggers')
  ok(/'receipt-assets', 'receipt-assets', false/.test(sql), 'private bucket')
})
