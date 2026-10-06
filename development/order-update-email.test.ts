/**
 * GENERIC UPDATE EMAILS FOR WEB ORDERS AND WEB LAYAWAYS (payment lifecycle H4,
 * spec §5 B, C and D2).
 *
 * Order update (JA + EN, or EN only): needs_info, deadline_moved, shipped,
 * details_received — each Japanese email carries the spec's exact Japanese,
 * each English one carries no Japanese at all. Layaway update: English only
 * (owner rule), rejected / needs_info / deadline_moved / shipped.
 *
 * The sender only ever writes for source_channel 'web'; a Hub order or plan
 * keeps its existing Hub email, and a cash-order 'rejected' is the existing
 * sendCashPaymentRejectedEmail's job, never this one's.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/order-update-email.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { COMPANY_NAME } from '../supabase/functions/_shared/transactional-email-templates/brand.ts'
import {
  OrderUpdateEmail, orderUpdateSubject, type OrderUpdateEmailProps, type OrderUpdateVariant,
} from '../supabase/functions/_shared/email-templates/order-update.tsx'
import {
  LayawayUpdateEmail, layawayUpdateSubject, type LayawayUpdateEmailProps, type LayawayUpdateVariant,
} from '../supabase/functions/_shared/email-templates/layaway-update.tsx'
import { isWebEntity, sendOrderUpdateEmail, trackingUrlFor } from '../supabase/functions/_shared/order-update-email.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
/** Hiragana, katakana, CJK ideographs, CJK punctuation, full-width forms. */
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
const noCompany = (s: string) => s.split(COMPANY_NAME).join('')

const ORDER_VARIANTS: OrderUpdateVariant[] = ['needs_info', 'deadline_moved', 'shipped', 'details_received']
const LAYAWAY_VARIANTS: LayawayUpdateVariant[] = ['rejected', 'needs_info', 'deadline_moved', 'shipped']
const due = '2026-10-10T05:00:00.000Z'
const trackingUrl = 'https://member.kms.kuronekoyamato.co.jp/parcel/detail?pno=472575516733'

const orderBase: OrderUpdateEmailProps = {
  lang: 'ja', variant: 'needs_info', reference: 'CJ-W-900070', currency: 'JPY', amount: 72980,
  message: 'お振込名義を教えてください。 / Please tell us the transfer name.', deadline: due, region: 'JP',
  courier: 'Yamato Transport', trackingNumber: '4725-7551-6733', trackingUrl,
  orderUrl: 'https://www.chajewelsjp.com/account/orders/x',
}
const layawayBase: LayawayUpdateEmailProps = {
  variant: 'rejected', reference: 'CJ-W-900071', currency: 'PHP', amount: 8000,
  message: 'The receipt shows a different amount.', deadline: due,
  courier: 'Pabitbit', trackingNumber: 'LBC123', trackingUrl: 'https://www.lbcexpress.com/track/?tracking_no=LBC123',
  planUrl: 'https://www.chajewelsjp.com/account/layaway/y',
}
const both = async (e: React.ReactElement) => (await renderEmail(e)) + '\n' + (await renderEmail(e, { plainText: true }))
const order = (p: Partial<OrderUpdateEmailProps>) => both(React.createElement(OrderUpdateEmail, { ...orderBase, ...p }))
const layaway = (p: Partial<LayawayUpdateEmailProps>) => both(React.createElement(LayawayUpdateEmail, { ...layawayBase, ...p }))

const JA_EXACT: Record<OrderUpdateVariant, string> = {
  needs_info: 'お支払いについて確認させてください',
  deadline_moved: 'お支払い期限を',
  shipped: '発送しました',
  details_received: 'お支払いのご連絡を受け付けました。確認後にあらためてご連絡します',
  // Addendum A variants — covered in email-addendum-a.test.ts.
  payment_filed: 'お支払いを受け付けました',
  payment_voided: 'お支払い記録を取り消しました',
  payment_restored: 'お支払い記録を復元しました',
}

Deno.test('every order variant in Japanese carries the spec\'s exact Japanese, then English', async () => {
  for (const variant of ORDER_VARIANTS) {
    const out = await order({ variant })
    assert(out.includes(JA_EXACT[variant]), `${variant}: missing ${JA_EXACT[variant]}`)
    assert(out.includes('ご注文ページを見る'), `${variant}: JA button`)
    assert(out.includes('/account/orders/x'), `${variant}: order link`)
    assert(/View your order/i.test(out), `${variant}: English block follows`)
  }
})

Deno.test('deadline_moved names the new deadline in the heading: お支払い期限を {新期限} に変更しました', async () => {
  const out = await order({ variant: 'deadline_moved' })
  assert(/お支払い期限を 2026年10月10日[^<]*（JST） に変更しました/.test(out), 'JA heading with the new deadline')
})

Deno.test('every order variant in English has no Japanese character', async () => {
  for (const variant of ORDER_VARIANTS) {
    const out = noCompany(await order({ lang: 'en', variant, message: 'Please tell us the transfer name.' }))
    const m = out.match(CJK)
    assert(!m, `${variant}: Japanese in English email …${m ? out.slice(Math.max(0, m.index! - 20), m.index! + 20) : ''}…`)
    assert(orderUpdateSubject(variant, 'CJ-W-1', 'en').length > 0 && !CJK.test(orderUpdateSubject(variant, 'CJ-W-1', 'en')), `${variant}: EN subject`)
  }
})

Deno.test('subjects: ja is Japanese / English, en is English only', () => {
  for (const variant of ORDER_VARIANTS) {
    const ja = orderUpdateSubject(variant, 'CJ-W-900070', 'ja')
    assert(CJK.test(ja) && ja.includes(' / ') && ja.includes('CJ-W-900070'), `${variant} ja subject: ${ja}`)
  }
})

Deno.test('needs_info shows the message; shipped shows the tracking number and URL', async () => {
  const n = await order({ variant: 'needs_info' })
  assert(n.includes('お振込名義を教えてください。'), 'message shown')
  const s = await order({ variant: 'shipped' })
  assert(s.includes('4725-7551-6733'), 'tracking number')
  assert(s.includes(trackingUrl), 'tracking URL')
  assert(s.includes('Yamato Transport'), 'courier')
})

Deno.test('a message is plain text — markup is escaped, never injected', async () => {
  const html = await renderEmail(React.createElement(OrderUpdateEmail, { ...orderBase, message: '<script>alert(1)</script><b>x</b>' }))
  assert(!html.includes('<script>alert(1)</script>') && !html.includes('<b>x</b>'), 'markup escaped')
  assert(html.includes('&lt;script&gt;'), 'shown as text')
})

Deno.test('every layaway variant renders English only (subject and body)', async () => {
  for (const variant of LAYAWAY_VARIANTS) {
    for (const currency of ['JPY', 'PHP'] as const) {
      const out = noCompany(await layaway({ variant, currency }))
      const m = out.match(CJK)
      assert(!m, `layaway ${variant} ${currency}: Japanese …${m ? out.slice(Math.max(0, m.index! - 20), m.index! + 20) : ''}…`)
      assert(out.includes('/account/layaway/y'), `${variant}: plan link`)
      assert(!CJK.test(layawayUpdateSubject(variant, 'CJ-W-900071')), `${variant}: subject`)
    }
  }
  const s = await layaway({ variant: 'shipped' })
  assert(s.includes('LBC123') && s.includes('https://www.lbcexpress.com/track/?tracking_no=LBC123'), 'layaway shipped tracking')
  const r = await layaway({ variant: 'rejected' })
  assert(r.includes('The receipt shows a different amount.'), 'reject message')
  assert(r.includes('₱8,000'), 'peso amount')
})

Deno.test('isWebEntity', () => {
  assert(isWebEntity({ source_channel: 'web' }) === true, 'web')
  assert(isWebEntity({ source_channel: 'hub' }) === false, 'hub')
  assert(isWebEntity({}) === false, 'missing')
  assert(isWebEntity({ source_channel: null }) === false, 'null')
})

Deno.test('tracking URL is built exactly as src/lib/tracking-link.ts buildTrackingUrl builds it', () => {
  const deep = { tracking_url_template: 'https://x.jp/d?pno={tracking_code}', supports_deeplink: true }
  assert(trackingUrlFor(deep, '4725-7551 6733') === 'https://x.jp/d?pno=472575516733', 'filled, hyphens/spaces stripped')
  assert(trackingUrlFor(deep, null) === null, 'no number')
  assert(trackingUrlFor(null, '123') === null, 'no method')
  assert(trackingUrlFor({ tracking_url_template: null, supports_deeplink: true }, '123') === null, 'no template')
  assert(trackingUrlFor({ tracking_url_template: 'https://x.jp/track', supports_deeplink: true }, '123') === 'https://x.jp/track', 'no placeholder: landing page')
  assert(trackingUrlFor({ tracking_url_template: 'https://x.jp/d?pno={tracking_code}', supports_deeplink: false }, '123') === 'https://x.jp/d?pno={tracking_code}', 'no deeplink: template as is, like the Hub')
})

// A fake Db that records every table read and answers from a fixed row.
function fakeDb(row: Record<string, unknown> | null) {
  const reads: string[] = []
  const db = {
    reads,
    from(table: string) {
      reads.push(table)
      const q = {
        select: () => q, eq: () => q,
        maybeSingle: () => Promise.resolve({ data: table === 'shipping_methods' ? null : row, error: null }),
      }
      return q
    },
  }
  return db
}

Deno.test('sender: a Hub order is never emailed here (only the row is read)', async () => {
  const db = fakeDb({ id: 'o1', source_channel: 'hub', customers: { email: 'a@example.com', is_test: false } })
  await sendOrderUpdateEmail(db, { entity: 'cash_order', id: 'o1', variant: 'needs_info', message: 'x', idempotencyKey: 'k' })
  assert(db.reads.join(',') === 'cash_orders', `reads: ${db.reads.join(',')}`)
})

Deno.test('sender: cash order + rejected returns without reading anything (sendCashPaymentRejectedEmail owns it)', async () => {
  const db = fakeDb({ id: 'o1', source_channel: 'web' })
  await sendOrderUpdateEmail(db, { entity: 'cash_order', id: 'o1', variant: 'rejected', idempotencyKey: 'k' })
  assert(db.reads.length === 0, `reads: ${db.reads.join(',')}`)
})

Deno.test('sender: layaway + details_received is not a layaway variant — no send', async () => {
  const db = fakeDb({ id: 'a1', source_channel: 'web' })
  await sendOrderUpdateEmail(db, { entity: 'layaway', id: 'a1', variant: 'details_received', idempotencyKey: 'k' })
  assert(db.reads.length === 0, `reads: ${db.reads.join(',')}`)
})

Deno.test('sender: never throws, even when the database does', async () => {
  const db = { from() { throw new Error('boom') } }
  await sendOrderUpdateEmail(db, { entity: 'layaway', id: 'a1', variant: 'needs_info', idempotencyKey: 'k' })
})

Deno.test('sender: a web order with "shipped" goes on to read its courier (send path reached, never throws)', async () => {
  const db = fakeDb({ id: 'o1', source_channel: 'web', web_reference: 'CJ-W-1', currency: 'JPY', tracking_number: '123', shipping_method_id: 'm1', customers: { email: null, is_test: false } })
  await sendOrderUpdateEmail(db, { entity: 'cash_order', id: 'o1', variant: 'shipped', idempotencyKey: 'k' })
  assert(db.reads.join(',').startsWith('cash_orders,shipping_methods'), `reads: ${db.reads.join(',')}`)
})
