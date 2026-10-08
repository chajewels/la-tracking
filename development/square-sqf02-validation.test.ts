/**
 * SQF02 (Square go-live counter-check, 2026-10-08): the FINANCIAL object inside
 * a Square answer is validated before anything trusts it. R08 made the
 * transport honest (a 2xx is JSON); this makes the content honest: the payment
 * or refund is the one asked for, its money is a whole amount in a named
 * currency, and the refund ledger refuses what cannot be true (a refund in
 * another currency, a refund larger than the capture, a refund re-bound to
 * another payment).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-sqf02-validation.test.ts
 */
import { listField, moneyOf, paymentOf, refundOf, SquareError } from '../supabase/functions/_shared/square.ts'
import { refundMoneyJpy } from '../supabase/functions/_shared/square-sync.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const refused = (f: () => unknown, msg: string) => {
  let threw: unknown = null
  try { f() } catch (e) { threw = e }
  assert(threw instanceof SquareError && threw.code === 'square_bad_response' && threw.kind === 'ambiguous', `${msg}: expected square_bad_response, got ${threw instanceof Error ? threw.message : JSON.stringify(threw)}`)
  return threw as SquareError
}
const code = async (path: string) => (await Deno.readTextFile(new URL(`../supabase/functions/${path}`, import.meta.url))).replace(/^\s*(\*|\/\/).*$/gm, '')

const payment = (over: Record<string, unknown> = {}) => ({
  payment: { id: 'pay_1', status: 'APPROVED', amount_money: { amount: 12000, currency: 'JPY' }, reference_id: 'cja_abc', created_at: '2026-10-08T00:00:00Z', ...over },
})
const refund = (over: Record<string, unknown> = {}) => ({
  refund: { id: 'rf_1', status: 'COMPLETED', payment_id: 'pay_1', amount_money: { amount: 3000, currency: 'JPY' }, ...over },
})

// ───────────────────────────────────────────── money

Deno.test('SQF02 moneyOf: a whole non-negative amount in a named currency, nothing else', () => {
  eq(moneyOf({ amount: 12000, currency: 'JPY' }), { amount: 12000, currency: 'JPY' }, 'plain')
  eq(moneyOf({ amount: 0, currency: 'jpy' }), { amount: 0, currency: 'JPY' }, 'zero is a valid amount (refunded_money); currency upper-cased')
  eq(moneyOf({ amount: '500', currency: 'JPY' }), { amount: 500, currency: 'JPY' }, 'an int64 serialised as a digit string is accepted')
  eq(moneyOf({ amount: 12.5, currency: 'JPY' }), null, 'fractional refused')
  eq(moneyOf({ amount: -1, currency: 'JPY' }), null, 'negative refused')
  eq(moneyOf({ amount: null, currency: 'JPY' }), null, 'null amount is NOT zero')
  eq(moneyOf({ amount: '', currency: 'JPY' }), null, 'empty string is NOT zero')
  eq(moneyOf({ amount: true, currency: 'JPY' }), null, 'a boolean is NOT one')
  eq(moneyOf({ currency: 'JPY' }), null, 'missing amount')
  eq(moneyOf({ amount: 100 }), null, 'missing currency')
  eq(moneyOf({ amount: 100, currency: ' ' }), null, 'blank currency')
  eq(moneyOf([100, 'JPY']), null, 'an array is not a Money object')
  eq(moneyOf(null), null, 'null')
  eq(moneyOf(undefined), null, 'undefined')
})

// ───────────────────────────────────────────── payments

Deno.test('SQF02 paymentOf: the payment asked for, with an id, a status and whole-unit money', () => {
  const p = paymentOf(payment(), { id: 'pay_1' })
  eq([p.id, p.status, p.amount_money.amount], ['pay_1', 'APPROVED', 12000], 'the good case passes and the status is normalised')
  refused(() => paymentOf({}), 'no payment')
  refused(() => paymentOf({ payment: [payment().payment] }), 'payment as an array')
  refused(() => paymentOf({ payment: 'pay_1' }), 'payment as a string')
  const wrong = refused(() => paymentOf(payment({ id: 'pay_2' }), { id: 'pay_1' }), 'a different payment than the one asked for')
  assert(wrong.message.includes('pay_2') && wrong.message.includes('pay_1'), 'the message names both ids')
  refused(() => paymentOf(payment({ id: '' })), 'empty id')
  refused(() => paymentOf(payment({ id: 7 })), 'numeric id')
  refused(() => paymentOf(payment({ status: undefined })), 'no status')
  refused(() => paymentOf(payment({ amount_money: undefined })), 'no money')
  refused(() => paymentOf(payment({ amount_money: { amount: 12000.5, currency: 'JPY' } })), 'fractional money')
  refused(() => paymentOf(payment({ amount_money: { amount: 12000 } })), 'money without a currency')
  eq(paymentOf(payment({ status: 'SOMETHING_NEW' })).status, 'UNKNOWN', 'an unrecognised status is normalised to UNKNOWN (quarantined by the callers), not a bad answer')
})

Deno.test('SQF02 paymentOf: a Cha Jewels payment must be in yen; an arbitrary GetPayment only has to be well-formed', () => {
  refused(() => paymentOf(payment({ amount_money: { amount: 120, currency: 'USD' } }), { id: 'pay_1', jpy: true }), 'USD on our own payment')
  const usd = paymentOf(payment({ amount_money: { amount: 120, currency: 'USD' } }), { id: 'pay_1' })
  eq(usd.amount_money.currency, 'USD', 'a read of an arbitrary id (parent recovery of an unrelated sale) is returned as-is; the RPCs refuse not_jpy before any money is written')
})

Deno.test('SQF02 paymentOf: CreatePayment must echo the reference and the amount that were sent', () => {
  const p = paymentOf(payment(), { jpy: true, referenceId: 'cja_abc', amountJpy: 12000 })
  eq(p.reference_id, 'cja_abc', 'echo matches')
  refused(() => paymentOf(payment({ reference_id: 'cja_other' }), { jpy: true, referenceId: 'cja_abc', amountJpy: 12000 }), 'another attempt\'s payment')
  refused(() => paymentOf(payment({ reference_id: undefined }), { jpy: true, referenceId: 'cja_abc', amountJpy: 12000 }), 'no reference at all')
  refused(() => paymentOf(payment({ amount_money: { amount: 11000, currency: 'JPY' } }), { jpy: true, referenceId: 'cja_abc', amountJpy: 12000 }), 'a different amount than requested')
})

Deno.test('SQF02 wiring: get / complete / cancel pass the requested id; create passes reference + amount; our writes require yen', async () => {
  const src = await code('_shared/square.ts')
  assert(/get: \(e: Env, id: string\) =>[^\n]*paymentOf\(j, \{ id \}\)/.test(src), 'get checks the id')
  assert(/complete: [\s\S]{0,400}?paymentOf\(j, \{ id, jpy: true \}\)/.test(src), 'complete checks id + JPY')
  assert(/cancel: \(e: Env, id: string\) =>[^\n]*paymentOf\(j, \{ id, jpy: true \}\)/.test(src), 'cancel checks id + JPY')
  assert(/create: [\s\S]{0,400}?paymentOf\(j, \{ jpy: true, referenceId: body\.reference_id as string, amountJpy: i\.amountJpy \}\)/.test(src), 'create checks the echo')
  assert(!/\.then\(paymentOf\)/.test(src), 'no caller takes a payment unchecked')
})

// ───────────────────────────────────────────── refunds

Deno.test('SQF02 refundOf: the refund asked for, bound to a payment, with positive whole-unit money', () => {
  const r = refundOf(refund(), 'rf_1')
  eq([r.id, r.status, r.payment_id, r.amount_money?.amount], ['rf_1', 'COMPLETED', 'pay_1', 3000], 'good case')
  refused(() => refundOf({}), 'no refund')
  refused(() => refundOf({ refund: [refund().refund] }), 'refund as an array')
  const wrong = refused(() => refundOf(refund({ id: 'rf_2' }), 'rf_1'), 'a different refund than the one asked for')
  assert(wrong.message.includes('rf_2') && wrong.message.includes('rf_1'), 'the message names both ids')
  refused(() => refundOf(refund({ status: '' })), 'blank status')
  refused(() => refundOf(refund({ payment_id: undefined })), 'a refund without its payment')
  refused(() => refundOf(refund({ payment_id: '' })), 'a refund with a blank payment id')
  refused(() => refundOf(refund({ amount_money: undefined })), 'a refund without money is a bad answer, never ¥0')
  refused(() => refundOf(refund({ amount_money: { amount: 0, currency: 'JPY' } })), 'a ¥0 refund is a bad answer')
  refused(() => refundOf(refund({ amount_money: { amount: 30.5, currency: 'JPY' } })), 'fractional refund')
  refused(() => refundOf(refund({ amount_money: { amount: 30, currency: '' } })), 'refund without a currency')
  eq(refundOf(refund({ amount_money: { amount: 30, currency: 'USD' } })).amount_money?.currency, 'USD', 'a foreign-currency refund is well-formed here; the sync quarantines it and the ledger refuses it')
})

Deno.test('SQF02 refundMoneyJpy: the yen the ledger may record, or null (never 0)', () => {
  eq(refundMoneyJpy(refund().refund as never), 3000, 'yen')
  eq(refundMoneyJpy(refund({ amount_money: { amount: 30, currency: 'USD' } }).refund as never), null, 'not yen → null')
  eq(refundMoneyJpy(refund({ amount_money: undefined }).refund as never), null, 'no money → null')
  eq(refundMoneyJpy(refund({ amount_money: { amount: 0, currency: 'JPY' } }).refund as never), null, '¥0 → null')
  eq(refundMoneyJpy(refund({ amount_money: { amount: 2999.5, currency: 'JPY' } }).refund as never), null, 'fractional → null')
})

Deno.test('SQF02 wiring: every refund read goes through refundOf; the sync quarantines bad money instead of recording 0', async () => {
  const sq = await code('_shared/square.ts')
  assert(/getRefund: [\s\S]{0,300}?refundOf\(json, id\)/.test(sq), 'GetRefund checks the id')
  assert(/listRefunds: [\s\S]{0,600}?\.map\(\(r\) => refundOf\(\{ refund: r \}\)\)/.test(sq), 'every ListRefunds item is checked')
  assert(!sq.includes('return json.refund as SquareRefund'), 'the unchecked cast is gone')
  const sync = await code('_shared/square-sync.ts')
  assert(sync.includes('const amountJpy = refundMoneyJpy(refund)'), 'the sync reads the money through the rule')
  assert(/if \(amountJpy === null\) return \{ outcome: "quarantined", detail: "bad_money" \}/.test(sync), 'bad money → quarantined (the inbox retries, then bells), never ¥0')
  assert(!/Number\.isSafeInteger\(Number\(refund\.amount_money/.test(sync), 'the "else 0" is gone')
  assert(sync.includes('p_amount_jpy: amountJpy'), 'the ledger gets the validated yen')
})

Deno.test('SQF02 listField: an explicit null is a bad answer; only an OMITTED list is an empty page', () => {
  eq(listField({}, 'refunds'), [], 'omitted → []')
  eq(listField({ refunds: [] }, 'refunds'), [], 'empty array → []')
  refused(() => listField({ refunds: null }, 'refunds'), 'explicit null')
  refused(() => listField({ refunds: {} }, 'refunds'), 'object')
  refused(() => listField({ refunds: 'x' }, 'refunds'), 'string')
})
