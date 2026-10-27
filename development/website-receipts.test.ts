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
  ISSUER, RECEIPT_FONT_PATH, itemTable, paymentRows, renderReceiptPdf, totalsRows, verifyUrl,
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

const it = (title: string, unit: number, ex: number, quantity = 1) =>
  ({ title, quantity, unit_price_jpy: unit, line_total_jpy: unit * quantity, unit_price_ex: ex, line_ex: ex * quantity })
// 3 items, qty 2 on one line, coupon + points, shipping, COD fee (owner case)
const yen: ReceiptPayload = {
  receipt_number: 'CJR-2026-000042', order_number: 'CJ-W-900501', currency: 'JPY',
  lines: {
    items: [it('K18 ネックレス', 30000, 27273), it('Earrings', 19000, 17273, 2), it('PT900 リング', 30000, 27273)],
    discount: 5000, coupon_code: 'WELCOME', points: 3000, shipping: 800, cod_fee: 1150, penalties: 0, refunds: 0,
    payments: [{ method: 'cod', amount: 81950 }, { method: 'store_credit', amount: 10000 }],
    product_amount: 98000, subtotal: 89092, tax: 8908, discount_total: 8000, received: 91950, adds_up: true,
  },
  total_paid: 91950, penalty_total: 0, taxable_total: 98000, subtotal: 89092, tax_amount: 8908, fx_rate_used: null,
  addressee: '株式会社テスト', purpose: 'お品代として', verify_code: '0123456789abcdef0123456789abcdef01234567',
  issued_at: '2026-10-27T03:00:00Z',
}
// layaway with a late fee
const lay: ReceiptPayload = {
  ...yen, receipt_number: 'CJR-2026-000043', order_number: 'CJ-W-900701',
  lines: { items: [it('Bracelet', 100000, 90909)], discount_total: 0, shipping: 0, cod_fee: 0, payments: [{ method: 'transfer', amount: 101000 }] },
  total_paid: 101000, penalty_total: 1000, taxable_total: 100000, subtotal: 90909, tax_amount: 9091, addressee: null,
}

const M = '\u2212'
Deno.test('item table excl. tax: 品名 / 数量 / 単価（税抜） / 金額（税抜）, lines add up to the subtotal', () => {
  const t = itemTable(yen, 'ja')
  eq(t.header, ['品名', '数量', '単価（税抜）', '金額（税抜）'], 'ja header')
  eq(t.rows, [
    ['K18 ネックレス', '1', '¥27,273', '¥27,273'],
    ['Earrings', '2', '¥17,273', '¥34,546'],
    ['PT900 リング', '1', '¥27,273', '¥27,273'],
  ], 'rows')
  eq(itemTable(yen, 'en').header, ['Item', 'Qty', 'Unit price (excl. tax)', 'Amount (excl. tax)'], 'en header')
  eq(27273 + 34546 + 27273, 89092, 'lines = subtotal')
})

Deno.test('totals block: subtotal, 10% tax, discount = coupon + points, shipping, COD fee, total', () => {
  eq(totalsRows(yen, 'ja').map((r) => [r.label, r.value]), [
    ['小計（税抜）', '¥89,092'],
    ['消費税（10%）', '¥8,908'],
    ['割引', `${M}¥8,000`],
    ['送料', '¥800'],
    ['代引手数料', '¥1,150'],
    ['合計（税込）', '¥91,950'],
  ], 'yen totals ja')
  eq(totalsRows(yen, 'en').map((r) => r.label), ['Subtotal (excl. tax)', '10% Tax', 'Discount', 'Shipping fee', 'COD fee', 'Total (tax incl.)'], 'en labels')
  eq(paymentRows(yen, 'ja').map((r) => r.label), ['代金引換', 'ストアクレジット'], 'store credit is a payment line')
})

Deno.test('owner example: 1 item ¥100,000 — discount and shipping shown at 0, COD fee and late fee not', () => {
  const r: ReceiptPayload = { ...yen, lines: { items: [it('Ring', 100000, 90909)], discount_total: 0, shipping: 0, cod_fee: 0, payments: [] },
    total_paid: 100000, penalty_total: 0, taxable_total: 100000, subtotal: 90909, tax_amount: 9091 }
  eq(itemTable(r, 'ja').rows, [['Ring', '1', '¥90,909', '¥90,909']], 'item')
  eq(totalsRows(r, 'ja').map((x) => [x.label, x.value]), [
    ['小計（税抜）', '¥90,909'], ['消費税（10%）', '¥9,091'], ['割引', `${M}¥0`], ['送料', '¥0'], ['合計（税込）', '¥100,000'],
  ], 'owner example')
})

Deno.test('layaway: the late fee is its own line', () => {
  eq(totalsRows(lay, 'en').map((x) => [x.label, x.value]), [
    ['Subtotal (excl. tax)', '¥90,909'], ['10% Tax', '¥9,091'], ['Discount', `${M}¥0`], ['Shipping fee', '¥0'], ['Late fee', '¥1,000'], ['Total (tax incl.)', '¥101,000'],
  ], 'late fee')
})

// peso order (owner option a): lines converted at fx_rate_used, remainder on the qty-1 line
const peso: ReceiptPayload = {
  ...yen, receipt_number: 'CJR-2026-000044', order_number: 'CJ-W-900703', currency: 'PHP',
  lines: {
    items: [
      { title: 'Earrings', quantity: 2, unit_price_jpy: 19000, line_total_jpy: 38000, unit_price: 5859, line_total: 11718, unit_price_ex: 5326, line_ex: 10652 },
      { title: 'Pendant', quantity: 1, unit_price_jpy: 30000, line_total_jpy: 30000, unit_price: 9249, line_total: 9249, unit_price_ex: 8408, line_ex: 8408 },
    ],
    discount_total: 0, shipping: 0, cod_fee: 0, payments: [{ method: 'gcash', amount: 20967 }],
  },
  total_paid: 20967, penalty_total: 0, taxable_total: 20967, subtotal: 19060, tax_amount: 1907, fx_rate_used: 0.308345, addressee: null,
}

Deno.test('peso receipt: every figure in PHP, no yen, no rate', () => {
  eq(itemTable(peso, 'ja').rows, [['Earrings', '2', 'PHP 5,326', 'PHP 10,652'], ['Pendant', '1', 'PHP 8,408', 'PHP 8,408']], 'peso rows')
  eq(10652 + 8408, 19060, 'lines = subtotal')
  const all = JSON.stringify([itemTable(peso, 'ja'), totalsRows(peso, 'ja'), paymentRows(peso, 'ja')])
  ok(!all.includes('¥') && !all.includes('0.308345'), 'no yen figure or rate on a peso receipt')
  eq(totalsRows(peso, 'ja').map((r) => [r.label, r.value]).at(-1), ['合計（税込）', 'PHP 20,967'], 'peso total')
})

Deno.test('no layaway wording anywhere the receipt prints', () => {
  for (const lang of ['ja', 'en'] as const) {
    const all = JSON.stringify([itemTable(lay, lang), totalsRows(lay, lang), paymentRows(lay, lang)])
    ok(!/layaway|lay-away|分割|レイアウェイ|予約/i.test(all), `layaway wording in ${lang}`)
  }
})

Deno.test('the issuer block is the owner\'s exact text; verify link on chajewelsjp.com', () => {
  eq(ISSUER.nameJa, 'Ｃｈａ　Ｊｅｗｅｌｓ株式会社', 'name')
  eq(ISSUER.registration, 'T7011801044120', 'registration')
  eq(ISSUER.tel, '03-6657-6129', 'tel')
  eq(verifyUrl('ab'), 'https://chajewelsjp.com/receipts/verify?code=ab', 'verify url')
  eq(RECEIPT_FONT_PATH, 'fonts/NotoSansJP-Regular.ttf', 'font path (no seal: owner 2026-10-27)')
})

const FONT = Deno.env.get('RECEIPT_TEST_FONT')
Deno.test({
  name: 'renders a real PDF (whole font, no form fields, reissue mark)',
  ignore: !FONT,
  fn: async () => {
    const font = await Deno.readFile(FONT!)
    for (const [r, lang, reissue] of [[yen, 'ja', false], [lay, 'en', true], [peso, 'ja', false]] as const) {
      const t = performance.now()
      const bytes = await renderReceiptPdf({ receipt: r, lang, issueNo: reissue ? 2 : 1, isReissue: reissue, downloadedAt: '2026-10-28T05:00:00Z' }, font)
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
