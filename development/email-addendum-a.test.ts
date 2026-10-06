/**
 * EMAIL ADDENDUM A (payment lifecycle, owner directive 2026-10-06): items 1, 6,
 * 7 and 10.
 *
 *   1  she pays by Paidy / card on the website → 「お支払いを受け付けました」,
 *      once per submission; card brand •last4 and "held, not charged yet" only
 *      from the stored Square record.
 *   6  a payment on a WEB cash order voided / restored → its own email, amount
 *      and the Hub's new balance; Hub orders and points lines never.
 *   7  the ready email names the checkout points used, their value and the
 *      amount after points — never calling points money.
 *   10 fraud cancel / automatic card void → the existing cancelled /
 *      not-accepted email with a neutral reason; the word "fraud" never.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/email-addendum-a.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { COMPANY_NAME } from '../supabase/functions/_shared/transactional-email-templates/brand.ts'
import type { SendStorefrontEmailArgs } from '../supabase/functions/_shared/storefront-email.ts'
import { OrderUpdateEmail, cardLabel, orderUpdateSubject, type OrderUpdateEmailProps } from '../supabase/functions/_shared/email-templates/order-update.tsx'
import { OrderConfirmationEmail } from '../supabase/functions/_shared/email-templates/order-confirmation.tsx'
import {
  NEUTRAL_CANCEL_REASON, checkoutPointsCount, filedMethod, sendCardHoldReleasedEmail, sendCashPaymentRecordEmail,
  sendPaymentFiledEmail, sendProviderCancelledEmail,
} from '../supabase/functions/_shared/payment-event-emails.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const CJK = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/
const noCompany = (s: string) => s.split(COMPANY_NAME).join('')
const both = async (e: React.ReactElement) => (await renderEmail(e)) + '\n' + (await renderEmail(e, { plainText: true }))

// ---------------------------------------------------------------- fake db
type Row = Record<string, unknown>
/** A tiny PostgREST stand-in: eq / is / like / in filters, maybeSingle, limit, await. */
function fakeDb(tables: Record<string, Row[]>) {
  const reads: string[] = []
  return {
    reads,
    from(table: string) {
      reads.push(table)
      let rows = [...(tables[table] ?? [])]
      const q: Record<string, unknown> = {
        select: () => q,
        order: () => q,
        limit: (n: number) => { rows = rows.slice(0, n); return q },
        eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q },
        is: (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return q },
        like: (c: string, p: string) => { const pre = p.replace(/%$/, ''); rows = rows.filter((r) => String(r[c] ?? '').startsWith(pre)); return q },
        in: (c: string, vs: unknown[]) => { rows = rows.filter((r) => vs.includes(r[c])); return q },
        maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: rows, error: null }),
      }
      return q
    },
  }
}
function capture() {
  const sent: SendStorefrontEmailArgs[] = []
  return { sent, send: (a: SendStorefrontEmailArgs) => { sent.push(a); return Promise.resolve({ sent: true as const }) } }
}
const customer = { email: 'hanako@example.com', is_test: false }
const webOrder: Row = {
  id: 'o1', web_reference: 'CJ-W-900068', invoice_number: '20001', source_channel: 'web', customer_lang: null,
  ship_to_snapshot: { country: 'JP' }, currency: 'JPY', status: 'pending', remaining_balance: 72980,
  transfer_due_at: '2026-10-08T15:00:00.000Z', shipping_fee: 0, total_amount: 72980, customers: customer,
}

// ---------------------------------------------------------------- item 1
Deno.test('1: card filed → JA+EN 「お支払いを受け付けました」, brand •last4 from square_payments, held + hold end in JST', async () => {
  const c = capture()
  const db = fakeDb({
    payment_submissions: [{ id: 's1', status: 'submitted', cash_order_id: 'o1', payment_method: 'square', submitted_amount: 72980, square_payment_id: 'sq-row-1' }],
    cash_orders: [webOrder],
    square_payments: [{ id: 'sq-row-1', status: 'authorized', card_brand: 'VISA', card_last4: '4242', capture_by: '2026-10-12T23:24:00.000Z' }],
  })
  await sendPaymentFiledEmail(db, 's1', { send: c.send })
  assert(c.sent.length === 1, `one send, got ${c.sent.length}`)
  const a = c.sent[0]
  assert(a.idempotencyKey === 'payment-filed-s1', `key ${a.idempotencyKey}`)
  assert(a.subject.startsWith('お支払いを受け付けました CJ-W-900068 / We have received your payment'), a.subject)
  const out = await both(a.element)
  for (const s of ['お支払いを受け付けました', '確認後に改めてご連絡します', '仮売上（まだ請求されていません）', 'Visa •4242', '¥72,980', '2026年10月13日', '（JST）', 'Held, not charged yet', '/account/orders/o1']) {
    assert(out.includes(s), `missing ${s}`)
  }
  assert(!/has been charged|was charged|we charged/i.test(out.replace(/\s+/g, ' ')), 'never claims a charge')
})

Deno.test('1: card whose stored row is no longer authorized → no "held" claim, no hold date', async () => {
  const c = capture()
  const db = fakeDb({
    payment_submissions: [{ id: 's1', status: 'submitted', cash_order_id: 'o1', payment_method: 'square', submitted_amount: 72980, square_payment_id: 'sq-row-1' }],
    cash_orders: [{ ...webOrder, customer_lang: 'en' }],
    square_payments: [{ id: 'sq-row-1', status: 'captured', card_brand: 'MASTERCARD', card_last4: '0005', capture_by: '2026-10-12T23:24:00.000Z' }],
  })
  await sendPaymentFiledEmail(db, 's1', { send: c.send })
  const out = await both(c.sent[0].element)
  assert(out.includes('Mastercard •0005'), 'brand from the record')
  assert(!out.includes('Held, not charged yet') && !out.includes('Hold ends'), 'no held claim')
  assert(!CJK.test(noCompany(out)), 'EN email has no Japanese')
})

Deno.test('1: Paidy filed → method Paidy, no card lines; a transfer submission is never this email', async () => {
  const c = capture()
  const db = fakeDb({
    payment_submissions: [
      { id: 's2', status: 'submitted', cash_order_id: 'o1', payment_method: 'paidy', submitted_amount: 72980, paidy_payment_id: 'pp1' },
      { id: 's3', status: 'submitted', cash_order_id: 'o1', payment_method: 'bank_transfer', submitted_amount: 72980 },
    ],
    cash_orders: [webOrder],
  })
  await sendPaymentFiledEmail(db, 's2', { send: c.send })
  await sendPaymentFiledEmail(db, 's3', { send: c.send })
  assert(c.sent.length === 1, `only the Paidy one, got ${c.sent.length}`)
  const out = await both(c.sent[0].element)
  assert(out.includes('あと払い（ペイディ）') && out.includes('Paidy'), 'method named')
  assert(!out.includes('仮売上') && !out.includes('•'), 'no card lines')
  assert(c.sent[0].idempotencyKey === 'payment-filed-s2', 'key per submission')
})

Deno.test('1: a submission already decided is not announced; the sender never throws', async () => {
  const c = capture()
  const db = fakeDb({
    payment_submissions: [{ id: 's1', status: 'rejected', cash_order_id: 'o1', payment_method: 'square', submitted_amount: 1 }],
    cash_orders: [webOrder],
  })
  await sendPaymentFiledEmail(db, 's1', { send: c.send })
  assert(c.sent.length === 0, 'no send')
  await sendPaymentFiledEmail({ from() { throw new Error('boom') } }, 's1', { send: c.send })
})

Deno.test('1: filedMethod and cardLabel', () => {
  assert(filedMethod('square') === 'card' && filedMethod('paidy') === 'paidy' && filedMethod('bank_transfer') === null, 'filedMethod')
  assert(cardLabel('AMERICAN_EXPRESS', '1005') === 'American Express •1005', cardLabel('AMERICAN_EXPRESS', '1005'))
  assert(cardLabel(null, null) === '' && cardLabel('JCB', 'x') === 'JCB', 'partial')
})

// ---------------------------------------------------------------- item 6
const cashPay = { id: 'cp1', cash_order_id: 'o1', amount_paid: 30000, reference_number: 'TR-1' }

Deno.test('6: web void → 「お支払い記録を取り消しました」, amount and new balance, key per void', async () => {
  const c = capture()
  const db = fakeDb({ cash_payments: [cashPay], cash_orders: [{ ...webOrder, remaining_balance: 72980 }] })
  await sendCashPaymentRecordEmail(db, { cashPaymentId: 'cp1', kind: 'voided', cycleKey: '2026-10-06T00:00:00Z' }, { send: c.send })
  assert(c.sent.length === 1, 'one send')
  assert(c.sent[0].idempotencyKey === 'payment-voided-cp1-2026-10-06T00:00:00Z', c.sent[0].idempotencyKey)
  const out = await both(c.sent[0].element)
  for (const s of ['お支払い記録を取り消しました', '¥30,000', '残りのお支払い金額', '¥72,980', 'A payment record has been cancelled']) assert(out.includes(s), `missing ${s}`)
})

Deno.test('6: web restore to fully paid → 「お支払い記録を復元しました」 and "paid in full", no balance row', async () => {
  const c = capture()
  const db = fakeDb({ cash_payments: [cashPay], cash_orders: [{ ...webOrder, customer_lang: 'en', remaining_balance: 0, status: 'completed' }] })
  await sendCashPaymentRecordEmail(db, { cashPaymentId: 'cp1', kind: 'restored', cycleKey: 'v1' }, { send: c.send })
  const out = await both(c.sent[0].element)
  assert(out.includes('A payment record has been restored') && out.includes('paid in full'), 'restored, paid in full')
  assert(!out.includes('Amount still to pay'), 'no balance row at 0')
  assert(!CJK.test(noCompany(out)), 'EN only')
  assert(c.sent[0].idempotencyKey === 'payment-restored-cp1-v1', 'restore key')
})

Deno.test('6: Hub order and points lines are never emailed', async () => {
  const c = capture()
  await sendCashPaymentRecordEmail(fakeDb({ cash_payments: [cashPay], cash_orders: [{ ...webOrder, source_channel: 'hub' }] }), { cashPaymentId: 'cp1', kind: 'voided', cycleKey: 'x' }, { send: c.send })
  await sendCashPaymentRecordEmail(fakeDb({ cash_payments: [{ ...cashPay, reference_number: 'LOYALTY-abc' }], cash_orders: [webOrder] }), { cashPaymentId: 'cp1', kind: 'voided', cycleKey: 'x' }, { send: c.send })
  assert(c.sent.length === 0, `no sends, got ${c.sent.length}`)
})

Deno.test('6: the staff void reason never reaches the customer', async () => {
  // The sender takes no reason at all: the void dialog's reason is an internal note.
  const src = await Deno.readTextFile(new URL('../supabase/functions/_shared/payment-event-emails.ts', import.meta.url))
  const fn = src.slice(src.indexOf('export async function sendCashPaymentRecordEmail'), src.indexOf('export async function sendCardHoldReleasedEmail'))
  assert(!/void_reason|message:/.test(fn), 'no reason field passed')
})

// ---------------------------------------------------------------- item 7
Deno.test('7: ready email shows points used (count), their value and the amount after points', async () => {
  const props = {
    lang: 'ja' as const, reference: 'CJ-W-900068', items: [{ title: 'K18 Ring', title_ja: 'K18 リング', qty: 1, line_total_jpy: 72980 }],
    shippingJpy: 0, totalJpy: 72980, methods: [], transferDueAt: '2026-10-08T15:00:00.000Z', region: 'JP' as const,
    orderUrl: 'https://www.chajewelsjp.com/account/orders/o1', variant: 'ready' as const, chosenMethod: 'card' as const,
    pointsApplied: 1000, pointsCount: 100,
  }
  const out = await both(React.createElement(OrderConfirmationEmail, props))
  for (const s of ['ポイント利用（100ポイント）', '−¥1,000', 'お支払い金額', '¥71,980', 'Points used (100 points)', 'Amount to pay']) assert(out.includes(s), `missing ${s}`)
  assert(!/points? (paid|payment)|ポイントでお支払い済み/i.test(out), 'points are never called a payment')
  const en = await both(React.createElement(OrderConfirmationEmail, { ...props, lang: 'en' }))
  assert(!CJK.test(noCompany(en)), 'EN ready email has no Japanese')
})

Deno.test('7: checkoutPointsCount sums the redemptions behind live LOYALTY lines only', async () => {
  const r1 = '11111111-1111-1111-1111-111111111111', r2 = '22222222-2222-2222-2222-222222222222'
  const db = fakeDb({
    cash_payments: [
      { cash_order_id: 'o1', reference_number: `LOYALTY-${r1}`, voided_at: null },
      { cash_order_id: 'o1', reference_number: `LOYALTY-${r2}`, voided_at: '2026-10-01' },
      { cash_order_id: 'o1', reference_number: 'TR-1', voided_at: null },
    ],
    loyalty_redemptions: [{ id: r1, points_redeemed: 100 }, { id: r2, points_redeemed: 50 }],
  })
  assert(await checkoutPointsCount(db, 'o1') === 100, 'live line only')
  assert(await checkoutPointsCount(fakeDb({}), 'o1') === 0, 'none → 0')
})

Deno.test('7: sendOrderReadyEmail passes the points count', async () => {
  const src = await Deno.readTextFile(new URL('../supabase/functions/_shared/reservation-emails.ts', import.meta.url))
  const fn = src.slice(src.indexOf('export function sendOrderReadyEmail'), src.indexOf('export function sendOrderPaidByPointsEmail'))
  assert(/pointsCount: Number\(ptsPaid \?\? 0\) > 0 \? await checkoutPointsCount\(supabase, orderId\)/.test(fn), 'ready email reads the count')
})

// ---------------------------------------------------------------- item 10
Deno.test('10: fraud cancel → order-cancelled with the neutral reason in both languages, cancel key, never "fraud"', async () => {
  const c = capture()
  const db = fakeDb({
    cash_orders: [{ ...webOrder, status: 'cancelled' }],
    cash_order_items: [{ cash_order_id: 'o1', title: 'K18 Ring', quantity: 1, line_total_jpy: 72980 }],
  })
  await sendProviderCancelledEmail(db, 'o1', { send: c.send })
  assert(c.sent.length === 1 && c.sent[0].idempotencyKey === 'order-cancelled-o1', 'one send on the cancel key')
  const out = await both(c.sent[0].element)
  assert(out.includes(NEUTRAL_CANCEL_REASON.ja) && out.includes(NEUTRAL_CANCEL_REASON.en), 'neutral reason JA + EN')
  assert(!/fraud|不正|詐欺/i.test(out + c.sent[0].subject), 'never names fraud')
})

Deno.test('10: an order not cancelled, or a Hub order, gets no cancel email', async () => {
  const c = capture()
  await sendProviderCancelledEmail(fakeDb({ cash_orders: [webOrder] }), 'o1', { send: c.send })
  await sendProviderCancelledEmail(fakeDb({ cash_orders: [{ ...webOrder, status: 'cancelled', source_channel: 'hub' }] }), 'o1', { send: c.send })
  assert(c.sent.length === 0, 'no sends')
})

Deno.test('10: a voided hold with no submission → not-accepted (provider_ended) once; with a submission → left to the rejection email', async () => {
  const c = capture()
  const sq = { id: 'sq-row-9', square_payment_id: 'SQ9', cash_order_id: 'o1', status: 'voided', amount_jpy: 72980 }
  await sendCardHoldReleasedEmail(fakeDb({ square_payments: [sq], payment_submissions: [], cash_orders: [webOrder] }), 'SQ9', { send: c.send })
  assert(c.sent.length === 1 && c.sent[0].idempotencyKey === 'card-hold-released-sq-row-9', 'one send, keyed by the hold')
  const out = await both(c.sent[0].element)
  assert(out.includes('お支払いを確認できませんでした') && !/fraud|不正|詐欺/i.test(out), 'neutral')
  await sendCardHoldReleasedEmail(fakeDb({ square_payments: [sq], payment_submissions: [{ id: 's1', square_payment_id: 'sq-row-9' }], cash_orders: [webOrder] }), 'SQ9', { send: c.send })
  await sendCardHoldReleasedEmail(fakeDb({ square_payments: [{ ...sq, status: 'authorized' }], payment_submissions: [], cash_orders: [webOrder] }), 'SQ9', { send: c.send })
  assert(c.sent.length === 1, 'no second email: a submission owns it, or the hold is not voided yet')
})

Deno.test('10: wiring — fraudCancel, handleFilingException and the reconcile void retry call the neutral senders', async () => {
  const sync = await Deno.readTextFile(new URL('../supabase/functions/_shared/square-sync.ts', import.meta.url))
  const fraud = sync.slice(sync.indexOf('export async function fraudCancel'), sync.indexOf('export async function handleFilingException'))
  assert(fraud.includes('sendProviderCancelledEmail(db, orderId)') && fraud.includes('sendCardHoldReleasedEmail(db, holdSquareId)'), 'fraudCancel')
  const exc = sync.slice(sync.indexOf('export async function handleFilingException'), sync.indexOf('export async function syncSquarePayment'))
  assert((exc.match(/sendCardHoldReleasedEmail\(db, p\.id\)/g) ?? []).length === 2, 'mismatch + paidy voids')
  const rec = await Deno.readTextFile(new URL('../supabase/functions/square-reconcile/index.ts', import.meta.url))
  assert(/sendCardHoldReleasedEmail\(db, String\(p\.id\)\)/.test(rec), 'reconcile void retry')
})

Deno.test('1/6: wiring — every filing path and both cash-payment functions send', async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url))
  const paidy = await read('../supabase/functions/_shared/paidy-filing.ts')
  assert(/sendPaymentFiledEmail\(supabase, String\(r\.submission\.id\)\)/.test(paidy), 'paidy filing (website, webhook, reconcile)')
  const sync = await read('../supabase/functions/_shared/square-sync.ts')
  const file = sync.slice(sync.indexOf('export async function fileForAttempt'), sync.indexOf('export async function resolveAttempt'))
  assert(/sendPaymentFiledEmail\(db, String\(filed\.submission\.id\)\)/.test(file), 'card filing (website + recovery)')
  assert(/sendCashPaymentRecordEmail\(supabase, \{ cashPaymentId: cash_payment_id, kind: "voided"/.test(await read('../supabase/functions/void-cash-payment/index.ts')), 'void')
  assert(/sendCashPaymentRecordEmail\(supabase, \{ cashPaymentId: body\.cash_payment_id, kind: "restored"/.test(await read('../supabase/functions/restore-cash-payment/index.ts')), 'restore')
})

// ---------------------------------------------------------------- template
Deno.test('template: every new variant in English has no Japanese; subjects agree', async () => {
  const base: OrderUpdateEmailProps = { lang: 'en', variant: 'payment_filed', reference: 'CJ-W-1', currency: 'JPY', amount: 1000, region: 'JP', orderUrl: null, method: 'card', cardBrand: 'JCB', cardLast4: '1234', held: true, holdUntil: '2026-10-12T23:24:00.000Z', balance: 500 }
  for (const variant of ['payment_filed', 'payment_voided', 'payment_restored'] as const) {
    const out = noCompany(await both(React.createElement(OrderUpdateEmail, { ...base, variant })))
    assert(!CJK.test(out), `${variant}: Japanese in EN`)
    assert(!CJK.test(orderUpdateSubject(variant, 'CJ-W-1', 'en')), `${variant}: EN subject`)
  }
})

Deno.test('dead code: the five reserve-first senders are gone', async () => {
  const src = await Deno.readTextFile(new URL('../supabase/functions/_shared/reservation-emails.ts', import.meta.url))
  for (const f of ['sendOrderReservedEmail', 'sendLayawayReservedEmail', 'sendOrderCantSupplyEmail', 'sendLayawayDeclinedEmail', 'sendOrderReservationLapsedEmail']) {
    assert(!src.includes(f), `${f} still present`)
  }
})
