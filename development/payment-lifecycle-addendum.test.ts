/**
 * PAYMENT LIFECYCLE ADDENDUM §9 — every payment cycle reaches the customer
 * (owner directive 2026-10-06 08:51 JST; spec
 * docs/superpowers/specs/2026-10-05-payment-lifecycle-design.md §9).
 *
 * Pure helpers (neutral reason, refund-issued refusal order), the exact copy the
 * owner fixed (card hold 「仮売上（まだ請求されていません）」, 「返金を受け付けました」 +
 * 「反映まで日数がかかる場合があります」, 「ストアクレジットを発行しました」), the
 * "never names fraud" rule, and the wiring: each sender is checked in its
 * source with comments stripped, so a removed call fails here.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/payment-lifecycle-addendum.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { COMPANY_NAME } from '../supabase/functions/_shared/transactional-email-templates/brand.ts'
import { OrderUpdateEmail, type OrderUpdateEmailProps } from '../supabase/functions/_shared/email-templates/order-update.tsx'
import { LayawayUpdateEmail } from '../supabase/functions/_shared/email-templates/layaway-update.tsx'
import { OrderCancelledEmail } from '../supabase/functions/_shared/email-templates/order-cancelled.tsx'
import { WebLoyaltyEmail } from '../supabase/functions/_shared/email-templates/web-loyalty.tsx'
import { StoreCreditIssuedEmail, storeCreditIssuedSubject } from '../supabase/functions/_shared/email-templates/store-credit-issued.tsx'
import { OrderPaymentNotAcceptedEmail } from '../supabase/functions/_shared/email-templates/order-payment-not-accepted.tsx'
import {
  FRAUD_REASON_PREFIX, NEUTRAL_CANCEL_REASON, customerCancellationReason, isAutomaticFraudReason,
} from '../supabase/functions/_shared/customer-reasons.ts'
import { canMarkRefundIssued, isRefundMethod, refundIssuedRefusal } from '../supabase/functions/_shared/refund-issued-rules.ts'
import { variantAllowed } from '../supabase/functions/_shared/order-update-email.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const both = async (e: React.ReactElement) => (await renderEmail(e)) + '\n' + (await renderEmail(e, { plainText: true }))
const orderUrl = 'https://www.chajewelsjp.com/account/orders/x'
const base: OrderUpdateEmailProps = { lang: 'ja', variant: 'payment_submitted', reference: 'CJ-W-900068', currency: 'JPY', amount: 980, region: 'JP', orderUrl }
const order = (p: Partial<OrderUpdateEmailProps>) => both(React.createElement(OrderUpdateEmail, { ...base, ...p }))
const fn = (path: string) => Deno.readTextFile(new URL(`../supabase/functions/${path}`, import.meta.url))
const code = async (path: string) => (await fn(path)).replace(/^\s*(\*|\/\/).*$/gm, '')

// ───────────────────────────────────────────── neutral reason (#10)

Deno.test('the stored fraud reason is shown to her as the neutral reason, anything else unchanged', () => {
  const stored = `${FRAUD_REASON_PREFIX} (Square risk evaluation HIGH) — auto-cancelled`
  assert(isAutomaticFraudReason(stored), 'detects the square_fraud_cancel reason')
  const shown = customerCancellationReason(stored)!
  assert(shown === `${NEUTRAL_CANCEL_REASON.ja} / ${NEUTRAL_CANCEL_REASON.en}`, `shown: ${shown}`)
  assert(!/fraud|不正/i.test(shown), 'never names fraud')
  assert(customerCancellationReason('お客様のご希望によりキャンセル') === 'お客様のご希望によりキャンセル', 'staff reason unchanged')
  assert(customerCancellationReason(null) === null, 'null stays null')
})

Deno.test('the SQL reason still starts with the prefix this file detects (square_fraud_cancel)', async () => {
  const sql = await Deno.readTextFile(new URL('../supabase/migrations/20261104100000_square_integrity.sql', import.meta.url))
  assert(sql.includes(`v_reason := '${FRAUD_REASON_PREFIX} (' ||`), 'prefix drifted from the SQL')
})

Deno.test('neutral cancel email: the reason in each language, and no "fraud" anywhere', async () => {
  const out = await both(React.createElement(OrderCancelledEmail, {
    lang: 'ja', reference: 'CJ-W-1', items: [], shippingJpy: 0, totalJpy: 980,
    reason: `${FRAUD_REASON_PREFIX} (x)`, reasonByLang: NEUTRAL_CANCEL_REASON, refundStatus: null, refundNote: null, orderUrl,
  }))
  assert(out.includes('お支払いを確認できなかったため') && out.includes('We could not confirm your payment'), 'both languages')
  assert(!/fraud|不正/i.test(out), 'no fraud')
})

// ───────────────────────────────────────────── #1 card / Paidy received

Deno.test('card received (#1): 仮売上（まだ請求されていません）, brand •last4, hold end in JST, 確認後に改めてご連絡します', async () => {
  const out = await order({ method: 'card', cardBrand: 'VISA', cardLast4: '4242', holdUntil: '2026-10-13T08:24:00.000Z' })
  for (const s of ['お支払いを受け付けました', '仮売上（まだ請求されていません）', 'VISA •4242', '2026年10月13日', '（JST）', '確認後に改めてご連絡します', 'ご注文ページを見る', '¥980'])
    assert(out.includes(s), `missing ${s}`)
  assert(/not been charged yet/.test(out), 'English: not charged yet')
  assert(!/振込|transfer|bank/i.test(out), 'no transfer wording on a card email')
})

Deno.test('Paidy received (#1): method named, no card hold line, no transfer wording', async () => {
  const out = await order({ method: 'paidy' })
  assert(out.includes('あと払い（ペイディ）') && out.includes('お支払いを受け付けました'), 'Paidy named')
  assert(!out.includes('仮売上'), 'no hold line on Paidy')
  assert(!/振込|transfer|bank/i.test(out), 'no transfer wording')
})

Deno.test('English email is English only (#1, #6, #8, #9)', async () => {
  const CJK = /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/
  for (const p of [
    { variant: 'payment_submitted', method: 'card', cardLast4: '1111' },
    { variant: 'payment_voided', message: 'Recorded twice', balance: 500 },
    { variant: 'payment_restored', balance: 0 },
    { variant: 'refund_issued', refundMethod: 'bank_transfer', refundDate: '2026-10-06' },
    { variant: 'refund_received', refundMethod: 'card' },
  ] as Partial<OrderUpdateEmailProps>[]) {
    const out = (await order({ ...p, lang: 'en' })).split(COMPANY_NAME).join('')
    const m = out.match(CJK)
    assert(!m, `${p.variant}: Japanese in English email …${m ? out.slice(Math.max(0, m.index! - 20), m.index! + 20) : ''}`)
  }
})

// ───────────────────────────────────────────── #6, #8, #9

Deno.test('void / restore (#6): amount, reason, new balance', async () => {
  const v = await order({ variant: 'payment_voided', amount: 500, message: '二重に記録されていたため', balance: 980 })
  assert(v.includes('お支払い記録を取り消しました') && v.includes('二重に記録されていたため') && v.includes('現在のお支払い残高') && v.includes('¥500'), 'void email')
  const r = await order({ variant: 'payment_restored', amount: 500, balance: 480 })
  assert(r.includes('お支払い記録を復元しました') && r.includes('¥480'), 'restore email')
})

Deno.test('refund issued (#8): 返金が完了しました + amount, method, date', async () => {
  const out = await order({ variant: 'refund_issued', amount: 72980, refundMethod: 'bank_transfer', refundDate: '2026-10-06' })
  for (const s of ['返金が完了しました', '¥72,980', '銀行振込', '2026年10月6日', '6 October 2026']) assert(out.includes(s), `missing ${s}`)
})

Deno.test('refund received (#9): 返金を受け付けました + 反映まで日数がかかる場合があります', async () => {
  const out = await order({ variant: 'refund_received', amount: 980, refundMethod: 'paidy' })
  for (const s of ['返金を受け付けました', '反映まで日数がかかる場合があります', '¥980', 'あと払い（ペイディ）']) assert(out.includes(s), `missing ${s}`)
})

// ───────────────────────────────────────────── #13 store credit

Deno.test('store credit (#13): 「ストアクレジットを発行しました」, amount, currency, 1-year expiry, staff apply it', async () => {
  const out = await both(React.createElement(StoreCreditIssuedEmail, { lang: 'ja', amount: 25000, currency: 'JPY', expiresAt: '2027-10-06T00:00:00.000Z' }))
  for (const s of ['ストアクレジットを発行しました', '¥25,000', '日本円', '2027年10月6日', '1年間', 'スタッフ', 'valid for one year']) assert(out.includes(s), `missing ${s}`)
  assert(storeCreditIssuedSubject('en') === 'Store credit has been added to your account — Cha Jewels', 'EN subject')
  const php = await both(React.createElement(StoreCreditIssuedEmail, { lang: 'en', amount: 10500, currency: 'PHP', expiresAt: null }))
  assert(php.includes('₱10,500') && php.includes('Philippine peso') && !/[぀-ヿ]/.test(php.split(COMPANY_NAME).join('')), 'peso, English only')
})

// ───────────────────────────────────────────── #5 loyalty

Deno.test('web loyalty (#5): website /loyalty link, CJ-W reference, the Japanese email never mentions layaway', async () => {
  for (const variant of ['earned', 'bonus', 'tier_upgrade', 'tier_restored'] as const) {
    const out = await both(React.createElement(WebLoyaltyEmail, { lang: 'ja', variant, reference: 'CJ-W-900070', points: 1400, balance: 9000, level: 'Radiant', previousLevel: 'Glimmer', multiplier: 2, loyaltyUrl: 'https://www.chajewelsjp.com/loyalty' }))
    assert(out.includes('https://www.chajewelsjp.com/loyalty') && out.includes('CJ-W-900070'), `${variant}: link + reference`)
    assert(!/portal\.chajewelsjp\.com/.test(out), `${variant}: never the portal`)
    assert(!/分割|レイアウェイ|layaway|deposit/i.test(out), `${variant}: layaway mentioned`)
  }
})

// ───────────────────────────────────────────── never names fraud

Deno.test('no new customer template says "fraud" (#10)', async () => {
  const outs = [
    await order({ method: 'card' }),
    await both(React.createElement(OrderPaymentNotAcceptedEmail, { lang: 'ja', reference: 'CJ-W-1', method: 'card', kind: 'provider_ended', amount: 980, currency: 'JPY', reason: null, remaining: 980, transferDueAt: null, region: 'JP', orderUrl })),
    await both(React.createElement(LayawayUpdateEmail, { variant: 'penalty', penaltyStage: 'P8', reference: 'CJ-W-2', currency: 'JPY', planUrl: 'https://www.chajewelsjp.com/account/layaway/y' })),
  ]
  for (const o of outs) assert(!/fraud|不正/i.test(o), 'fraud named')
})

// ───────────────────────────────────────────── #8 refusal order (mirror of the SQL)

Deno.test('mark refund issued: the refusal order mirrors mark_web_order_refund_issued_atomic', () => {
  const ok = { source_channel: 'web', status: 'cancelled', refund_status: 'refund_pending' }
  const today = '2026-10-06'
  const good = { method: 'bank_transfer', refundedOn: '2026-10-06' }
  assert(refundIssuedRefusal(null, good, today) === 'not_found', 'not_found')
  assert(refundIssuedRefusal({ ...ok, source_channel: 'hub' }, good, today) === 'not_web_order', 'not_web_order')
  assert(refundIssuedRefusal({ ...ok, status: 'completed' }, good, today) === 'not_cancelled', 'not_cancelled')
  assert(refundIssuedRefusal({ ...ok, refund_status: 'refund_issued' }, good, today) === null, 'already issued passes to the SQL (B01 retry, 2026-10-08)')
  assert(refundIssuedRefusal({ ...ok, refund_status: 'store_credit_issued' }, good, today) === 'not_refund_pending', 'credit')
  assert(refundIssuedRefusal(ok, { method: 'bitcoin', refundedOn: today }, today) === 'bad_method', 'bad_method')
  assert(refundIssuedRefusal(ok, { method: 'card', refundedOn: '2026-10-07' }, today) === 'bad_date', 'future day')
  assert(refundIssuedRefusal(ok, { method: 'card', refundedOn: '10/06/2026' }, today) === 'bad_date', 'format')
  assert(refundIssuedRefusal(ok, good, today) === null, 'ok')
  assert(canMarkRefundIssued(ok) && !canMarkRefundIssued({ ...ok, refund_status: null }), 'button rule')
  assert(isRefundMethod('Paidy') && !isRefundMethod(''), 'methods')
})

Deno.test('the SQL refuses in the same order and is service_role only', async () => {
  const sql = await Deno.readTextFile(new URL('../supabase/migrations/20261112100000_payment_lifecycle_refund_issued.sql', import.meta.url))
  const order = ['not_found', 'not_web_order', 'not_cancelled', 'not_refund_pending', 'bad_method', 'bad_date'].map((c) => sql.indexOf(`'error', '${c}'`))
  assert(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]), `order: ${order}`)
  assert(/REVOKE ALL ON FUNCTION public\.mark_web_order_refund_issued_atomic\(uuid, uuid, text, date, text\) FROM PUBLIC, anon, authenticated;/.test(sql), 'revoke')
  assert(/GRANT EXECUTE ON FUNCTION public\.mark_web_order_refund_issued_atomic\(uuid, uuid, text, date, text\) TO service_role;/.test(sql), 'grant')
  assert(/NOT LIKE 'LOYALTY-%'/.test(sql), 'points never refunded')
})

// ───────────────────────────────────────────── variants per kind

Deno.test('variant table: order and layaway variants', () => {
  for (const v of ['payment_submitted', 'payment_voided', 'payment_restored', 'refund_issued', 'refund_received', 'details_received']) assert(variantAllowed('cash_order', v), `order ${v}`)
  for (const v of ['details_received', 'reminder', 'penalty', 'penalty_reinstated', 'penalty_waived', 'payment_voided', 'reactivated']) assert(variantAllowed('layaway', v), `layaway ${v}`)
  assert(!variantAllowed('cash_order', 'rejected') && !variantAllowed('layaway', 'payment_submitted') && !variantAllowed('layaway', 'refund_received'), 'refused')
})

// ───────────────────────────────────────────── wiring (comment-stripped source)

Deno.test('wiring: every addendum sender is called from its function', async () => {
  const checks: [string, RegExp][] = [
    ['_shared/square-sync.ts', /sendPaymentSubmittedEmail\(db, \{/],
    ['_shared/square-sync.ts', /variant: "refund_received"/],
    ['_shared/square-sync.ts', /sendWebCancellationEmail\(db, orderId, \{ reason:/],
    ['_shared/square-sync.ts', /sendCardHoldReleasedEmail\(db, \{/],
    ['_shared/paidy-filing.ts', /await sendPaymentSubmittedEmail\(supabase, \{ submissionId:/],
    ['_shared/paidy-sync.ts', /idempotencyKey: `refund-received-paidy-\$\{r\.id\}`/],
    ['website/index.ts', /variant: "details_received"/],
    ['website/index.ts', /rest\.cancellation_reason = customerCancellationReason\(/],
    ['submit-payment/index.ts', /entity: "layaway", id: String\(primaryAccountId\), variant: "details_received"/],
    ['send-reminders/index.ts', /variant: "reminder", reminderStage: "grace_period"/],
    ['send-reminders/index.ts', /variant: "reminder", reminderStage: reminderType/],
    ['penalty-engine/index.ts', /variant: "penalty",/],
    ['penalty-engine/index.ts', /variant: "penalty_reinstated"/],
    ['approve-waiver/index.ts', /variant: "penalty_waived"/],
    ['void-payment/index.ts', /variant: "payment_voided"/],
    ['reactivate-account/index.ts', /variant: "reactivated"/],
    ['award-loyalty-points/index.ts', /sendWebLoyalty\("earned"/],
    ['award-loyalty-points/index.ts', /sendWebLoyalty\("tier_upgrade"/],
    ['void-cash-payment/index.ts', /variant: "payment_voided"/],
    ['restore-cash-payment/index.ts', /variant: "payment_restored"/],
    ['mark-refund-issued/index.ts', /rpc\("mark_web_order_refund_issued_atomic"/],
    ['mark-refund-issued/index.ts', /variant: "refund_issued"/],
    ['issue-store-credit/index.ts', /await sendStoreCreditIssuedEmail\(supabase, \{/],
    ['cancel-cash-order/index.ts', /await sendWebCancellationEmail\(supabase, cash_order_id, \{ reason,/],
  ]
  const missing: string[] = []
  for (const [file, re] of checks) if (!re.test(await code(file))) missing.push(`${file}: ${re}`)
  assert(missing.length === 0, `not wired:\n${missing.join('\n')}`)
})

Deno.test('the five dead reservation senders are gone (addendum dead-code list)', async () => {
  const src = await code('_shared/reservation-emails.ts')
  for (const name of ['sendOrderReservedEmail', 'sendLayawayReservedEmail', 'sendOrderCantSupplyEmail', 'sendLayawayDeclinedEmail', 'sendOrderReservationLapsedEmail'])
    assert(!new RegExp(`export function ${name}\\b`).test(src), `${name} still defined`)
})

Deno.test('card hold expiring and dispute opened stay staff-bell only (#11, #12): no customer send in those paths', async () => {
  const sync = await code('_shared/square-sync.ts')
  const dispute = sync.slice(sync.indexOf('export async function syncSquareDispute'), sync.indexOf('export function eventObjectId'))
  assert(dispute.length > 0 && !/send[A-Za-z]*Email\(/.test(dispute), 'a dispute must not email the customer')
})

// ───────────────────────────────────────────── independent review fixes (2026-10-06)

Deno.test('review #1: a card hold released while her Paidy payment is checked never says "pay again"', async () => {
  const out = await both(React.createElement(OrderPaymentNotAcceptedEmail, { lang: 'ja', reference: 'CJ-W-1', method: 'card', kind: 'provider_ended', amount: 980, currency: 'JPY', reason: null, remaining: null, transferDueAt: null, region: 'JP', orderUrl, otherPaymentInProgress: true }))
  assert(out.includes('新たにお支払いいただく必要はありません') && out.includes('You do not need to pay again'), 'other payment line')
  assert(!out.includes('もう一度お支払い') && !/pay again from your order page/.test(out), 'no pay-again')
  assert(/sendCardHoldReleasedEmail[\s\S]{0,400}otherPaymentInProgress/.test(await code('_shared/square-sync.ts')) && /await released\(true\); return "paidy_voided"/.test(await code('_shared/square-sync.ts')), 'Paidy branch passes the flag')
})

Deno.test('review #2: Mark refund issued sends no second email after a provider refund already emailed her', async () => {
  const src = await code('mark-refund-issued/index.ts')
  assert(/email_skipped: "provider_refund_already_emailed"/.test(src) && src.indexOf('square_refunds') < src.indexOf('variant: "refund_issued"'), 'provider check before the send')
})

Deno.test('review #3: an impossible day (2026-02-30) is bad_date, not a database error', () => {
  const ok = { source_channel: 'web', status: 'cancelled', refund_status: 'refund_pending' }
  assert(refundIssuedRefusal(ok, { method: 'cash', refundedOn: '2026-02-30' }, '2026-10-06') === 'bad_date', 'rolled-over day refused')
  assert(refundIssuedRefusal(ok, { method: 'cash', refundedOn: '2026-02-28' }, '2026-10-06') === null, 'real day accepted')
})

Deno.test('review #4: web peso reminders keep their centavos (no Math.round on the amount)', async () => {
  const src = await code('send-reminders/index.ts')
  assert(!/amount: Math\.round\(alert\.amount\)/.test(src) && (src.match(/amount: alert\.amount,/g) ?? []).length === 2, 'unrounded amount')
  // The sender passes the exact figure; how pesos are printed is formatMoney's (shared by every layaway email, unchanged here).
})

Deno.test('review #5: the automatic cancel has its own key, so a real cancel after a revive is still sent', async () => {
  assert(/idempotencyKey: `order-cancelled-auto-\$\{orderId\}`/.test(await code('_shared/square-sync.ts')), 'auto key')
  assert(!/idempotencyKey:/.test((await code('cancel-cash-order/index.ts')).match(/sendWebCancellationEmail\([^)]*\)/)?.[0] ?? ''), 'staff cancel keeps order-cancelled-<id>')
})
