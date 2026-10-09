/**
 * A REJECTED PAYMENT ON A WEB ORDER EMAILS THE CUSTOMER (owner 2026-10-05).
 *
 * The Paidy live test showed a Hub Reject on a web order sent nothing, and
 * Paidy never emails a cancellation. This renders the new email in every
 * shape it can go out in and checks what the customer must be told:
 *   - Paidy / card: that nothing is charged;
 *   - a reviewer's Reject shows the reviewer's message; a provider-ended one
 *     never shows one (those notes are internal English);
 *   - the amount still owed, the deadline and the order link while open;
 *     "no longer open" and no pay-again line once the order is closed;
 *   - the method mapping the sender uses.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/payment-rejected-email.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import {
  OrderPaymentNotAcceptedEmail, orderPaymentNotAcceptedSubject, type OrderPaymentNotAcceptedProps,
} from '../supabase/functions/_shared/email-templates/order-payment-not-accepted.tsx'
import { deadlineHasPassed, notAcceptedMethod } from '../supabase/functions/_shared/payment-rejected-email.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const base: OrderPaymentNotAcceptedProps = {
  lang: 'ja', reference: 'CJ-W-900067', method: 'paidy', kind: 'staff', amount: 980, currency: 'JPY',
  reason: 'お届け先の番地を確認させてください。', remaining: 980, transferDueAt: '2026-10-08T01:49:18.592Z',
  region: 'JP', orderUrl: 'https://www.chajewelsjp.com/account/orders/x',
}
const render = (p: Partial<OrderPaymentNotAcceptedProps>) =>
  renderEmail(React.createElement(OrderPaymentNotAcceptedEmail, { ...base, ...p }), { plainText: true })

Deno.test('Paidy, staff Reject, Japanese: nothing billed, the message, amount, deadline, link — then English', async () => {
  const t = await render({})
  assert(t.includes('お支払いを確認できませんでした'), 'JA heading')
  assert(t.includes('ペイディからのご請求は発生しません'), 'JA: Paidy will not bill')
  assert(t.includes('お届け先の番地を確認させてください。'), 'staff message shown')
  assert(t.includes('¥980'), 'amount')
  assert(t.includes('2026'), 'deadline')
  assert(t.includes('/account/orders/x'), 'order link')
  assert(t.includes('Paidy will not bill you'), 'English block follows the Japanese')
})

Deno.test('provider ended: never shows a message', async () => {
  const t = await render({ kind: 'provider_ended', reason: 'internal note — must not appear' })
  assert(!t.includes('internal note'), 'no message on a provider-ended rejection')
  assert(t.includes('お手続きが完了しなかった'), 'JA: Paidy not completed wording')
})

Deno.test('card, English: hold released, nothing charged', async () => {
  const t = await render({ lang: 'en', method: 'card', reason: null })
  assert(t.toLowerCase().includes('we could not accept your payment'), 'EN heading (plain text capitalises headings)')
  assert(t.includes('nothing was charged'), 'nothing charged')
  assert(!t.includes('お支払い'), 'English-only email has no Japanese block')
})

Deno.test('bank transfer: asks her to reply with the receipt, no "nothing charged"', async () => {
  const t = await render({ lang: 'en', method: 'transfer', amount: 72980, remaining: 72980 })
  assert(t.includes('reply to this email with your transfer receipt'), 'reply-with-receipt line (web orders have no upload)')
  assert(!/upload/i.test(t), 'no upload wording')
  assert(!t.includes('nothing was charged'), 'no charge wording for a transfer')
})

Deno.test('closed order: no amount to pay, no pay-again line', async () => {
  const t = await render({ lang: 'en', remaining: null })
  assert(t.includes('no longer open for payment'), 'closed wording')
  assert(!t.includes('You can pay again'), 'no pay-again on a closed order')
})

Deno.test('subject carries the reference in both languages', () => {
  const s = orderPaymentNotAcceptedSubject('CJ-W-900067', 'ja')
  assert(s.includes('お支払いを確認できませんでした CJ-W-900067') && s.includes('We could not accept your payment'), s)
})

Deno.test('method mapping', () => {
  assert(notAcceptedMethod('paidy') === 'paidy', 'paidy')
  assert(notAcceptedMethod('square') === 'card' && notAcceptedMethod('Card') === 'card', 'card')
  assert(notAcceptedMethod('bank_transfer') === 'transfer' && notAcceptedMethod(null) === 'transfer', 'transfer')
})

Deno.test('CODE-M2: a hold that ends after the deadline never says "pay by <past date>" or "pay again"', async () => {
  const t = await render({ method: 'card', kind: 'provider_ended', reason: null, deadlinePassed: true })
  assert(t.includes('お支払い期限は過ぎています'), 'JA: deadline passed, reply instead')
  assert(t.includes('The payment deadline for this order has passed'), 'EN: deadline passed, reply instead')
  assert(!t.includes('Pay by:') && !t.includes('お支払い期限：'), 'no past deadline shown')
  assert(!t.includes('You can pay again') && !t.includes('もう一度お支払いいただけます'), 'no pay-again line')
  assert(t.includes('nothing was charged'), 'still says nothing was charged')
  const live = await render({ method: 'card', kind: 'provider_ended', reason: null, deadlinePassed: false })
  assert(live.includes('Pay by:') && live.includes('You can pay again'), 'before the deadline the pay-again line stays')
})

Deno.test('CODE-M2: deadlineHasPassed', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  assert(deadlineHasPassed('2026-10-09T11:59:59Z', now), 'past')
  assert(!deadlineHasPassed('2026-10-09T12:00:01Z', now), 'future')
  assert(!deadlineHasPassed(null, now) && !deadlineHasPassed('', now) && !deadlineHasPassed('not a date', now), 'unknown is never "passed"')
})
