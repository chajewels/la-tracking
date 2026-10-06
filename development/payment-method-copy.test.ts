/**
 * EVERY ORDER EMAIL NAMES THE METHOD SHE IS ACTUALLY PAYING WITH
 * (payment lifecycle H3, spec §5 A, 2026-10-05).
 *
 * Before this, the payment-received, payment-due (reminder), reserved and
 * expired emails said 「お振込」 / "transfer" to every customer, including the
 * ones who chose Paidy or a card, and the transfer copy told her to "upload"
 * a receipt that web orders have no way to upload.
 *
 * For each template × Paidy / card × JA / EN the rendered plain text carries
 * no 振込 / "transfer" / "bank"; the transfer variant still does. Plus the
 * partial payment-received, the payment-due with no accounts, the
 * method-changed confirmation, and no "upload" anywhere in the transfer copy.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/payment-method-copy.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { OrderPaymentReceivedEmail } from '../supabase/functions/_shared/email-templates/order-payment-received.tsx'
import { OrderPaymentDueEmail } from '../supabase/functions/_shared/email-templates/order-payment-due.tsx'
import { OrderExpiredEmail } from '../supabase/functions/_shared/email-templates/order-expired.tsx'
import { OrderReservedEmail } from '../supabase/functions/_shared/email-templates/order-reserved.tsx'
import { OrderConfirmationEmail } from '../supabase/functions/_shared/email-templates/order-confirmation.tsx'
import { OrderPaymentNotAcceptedEmail } from '../supabase/functions/_shared/email-templates/order-payment-not-accepted.tsx'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
type Method = 'transfer' | 'paidy' | 'card'
const LANGS = ['ja', 'en'] as const
const OTHER: Method[] = ['paidy', 'card']

const items = [{ title: 'K18 Necklace', title_ja: 'K18 ネックレス', qty: 1, line_total_jpy: 68000 }]
const bankMethod = {
  id: 'm1', method_type: 'bank', label_ja: '銀行振込（日本）', label_en: 'Bank transfer (Japan)',
  bank: { name: 'Test Bank', branch: 'Main', account_type: 'Savings', account_number: '1234567', account_holder: 'CHA JEWELS' },
  wallet: null, note_ja: null, note_en: null,
}
const due = '2026-10-08T01:49:18.592Z'
const orderUrl = 'https://www.chajewelsjp.com/account/orders/x'
const base = { reference: 'CJ-W-900067', items, shippingJpy: 0, totalJpy: 68000, currency: 'JPY' as const }

/** Plain text with line wraps joined, so a phrase the 80-column wrap splits still matches. */
const render = async (c: React.ComponentType<any>, p: Record<string, unknown>) =>
  (await renderEmail(React.createElement(c, p), { plainText: true })).replace(/[ \t]*\n[ \t]*/g, ' ')

/** Every template in its per-method shape. `methods` is what the sender passes for that method. */
const shapes: Record<string, (lang: 'ja' | 'en', method: Method) => Promise<string>> = {
  'order-payment-received': (lang, method) =>
    render(OrderPaymentReceivedEmail, { lang, ...base, method, amountReceivedJpy: 68000, orderUrl }),
  'order-payment-due': (lang, method) =>
    render(OrderPaymentDueEmail, {
      lang, reference: base.reference, currency: 'JPY', amount: 68000, method,
      methods: method === 'transfer' ? [bankMethod] : [], transferDueAt: due, region: 'JP', orderUrl,
    }),
  'order-reserved': (lang, method) =>
    render(OrderReservedEmail, { lang, ...base, method, orderUrl, provisional: true }),
  'order-confirmation ready': (lang, method) =>
    render(OrderConfirmationEmail, {
      lang, ...base, methods: method === 'transfer' ? [bankMethod] : [], transferDueAt: due, region: 'JP',
      orderUrl, variant: 'ready', chosenMethod: method,
    }),
  'order-payment-not-accepted': (lang, method) =>
    render(OrderPaymentNotAcceptedEmail, {
      lang, reference: base.reference, method, kind: 'staff', amount: 68000, currency: 'JPY', reason: null,
      remaining: 68000, transferDueAt: due, region: 'JP', orderUrl,
    }),
}

const TRANSFER_WORDS = /振込|transfer|bank/i

for (const [name, shape] of Object.entries(shapes)) {
  for (const lang of LANGS) {
    for (const method of OTHER) {
      Deno.test(`${name} ${method} ${lang}: no transfer / bank wording`, async () => {
        const t = await shape(lang, method)
        const hit = t.match(TRANSFER_WORDS)
        assert(!hit, `${name} ${method} ${lang} says "${hit?.[0]}":\n${t}`)
      })
    }
    Deno.test(`${name} transfer ${lang}: still names the transfer`, async () => {
      const t = await shape(lang, 'transfer')
      assert(lang === 'ja' ? t.includes('振込') : /transfer/i.test(t), `${name} transfer ${lang} lost its wording:\n${t}`)
    })
  }
}

Deno.test('order-expired is method-neutral in both languages', async () => {
  for (const lang of LANGS) {
    const t = await render(OrderExpiredEmail, { lang, ...base, transferDueAt: due, region: 'JP', shopUrl: 'https://www.chajewelsjp.com' })
    const hit = t.match(TRANSFER_WORDS)
    assert(!hit, `order-expired ${lang} says "${hit?.[0]}"`)
    if (lang === 'ja') assert(t.includes('お支払いの確認ができなかった'), 'JA neutral intro')
    else assert(t.includes('If you have already paid'), 'EN already-paid line')
  }
})

Deno.test('partial payment received: names what is still to pay, and no shipping promise', async () => {
  for (const lang of LANGS) {
    const t = await render(OrderPaymentReceivedEmail, {
      lang, ...base, method: 'transfer', amountReceivedJpy: 67500, remaining: 500, transferDueAt: due, region: 'JP', orderUrl,
    })
    assert(t.includes('¥500'), `${lang}: remaining ¥500`)
    assert(t.includes('still to pay'), `${lang}: "still to pay" line (English block)`)
    if (lang === 'ja') assert(t.includes('一部を受領'), 'JA partial intro')
    assert(!t.includes('preparing your shipment'), `${lang}: a partial payment does not ship`)
  }
})

Deno.test('payment received with points: points shown as points, not as money received', async () => {
  const t = await render(OrderPaymentReceivedEmail, { lang: 'en', ...base, method: 'paidy', amountReceivedJpy: 67000, pointsApplied: 1000, orderUrl })
  assert(t.includes('Points used') && t.includes('−¥1,000'), 'points line')
  assert(t.includes('¥67,000'), 'the amount actually received')
  assert(t.includes('Paidy'), 'names Paidy')
})

Deno.test('fully paid by points (H5, confirm-web-draft): no "received ¥0", no transfer words, says points paid it', async () => {
  for (const method of ['transfer', 'paidy', 'card'] as Method[]) {
    for (const lang of LANGS) {
      const t = await render(OrderPaymentReceivedEmail, { lang, ...base, method, amountReceivedJpy: 0, pointsApplied: 68000, orderUrl })
      // The "total after points ¥0" row is correct; any OTHER ¥0 is the bug.
      const body = t.replace(/(Order total after points|ポイント利用後のご注文金額)\s*¥0/g, '')
      assert(!/¥0(?![\d,])/.test(body), `${lang}/${method}: no "received ¥0"`)
      assert(!TRANSFER_WORDS.test(body), `${lang}/${method}: no transfer wording`)
      assert(t.includes('fully paid with your loyalty points'), `${lang}/${method}: English points-paid line`)
      if (lang === 'ja') assert(t.includes('ポイントで全額のお支払いが完了しました'), `${method}: Japanese points-paid line`)
      assert(t.includes('Points used'), `${lang}/${method}: points line kept`)
    }
  }
})

Deno.test('payment-due with Paidy and no accounts: no account field, the order page instead', async () => {
  for (const lang of LANGS) {
    const t = await render(OrderPaymentDueEmail, {
      lang, reference: base.reference, currency: 'JPY', amount: 68000, method: 'paidy', methods: [], transferDueAt: due, region: 'JP', orderUrl,
    })
    assert(!t.includes('口座番号') && !t.includes('Account number'), `${lang}: no account number label`)
    assert(t.includes('/account/orders/x'), `${lang}: order link`)
    assert(t.includes('Paidy'), `${lang}: names Paidy`)
  }
})

Deno.test('transfer copy never asks for an upload (no such upload on web orders)', async () => {
  for (const lang of LANGS) {
    const na = await shapes['order-payment-not-accepted'](lang, 'transfer')
    const due2 = await shapes['order-payment-due'](lang, 'transfer')
    for (const [n, t] of [['not-accepted', na], ['payment-due', due2]] as const) {
      assert(!/upload/i.test(t) && !t.includes('アップロード'), `${n} ${lang} mentions upload`)
    }
    if (lang === 'ja') assert(na.includes('お振込の控えをこのメールにご返信ください'), 'JA reply-with-receipt line')
    else assert(na.includes('reply to this email with your transfer receipt'), 'EN reply-with-receipt line')
  }
})

Deno.test('method changed: heading and the from → to line', async () => {
  for (const lang of LANGS) {
    const t = await render(OrderConfirmationEmail, {
      lang, ...base, methods: [bankMethod], transferDueAt: due, region: 'JP', orderUrl, variant: 'ready',
      chosenMethod: 'transfer', methodChanged: { from: 'paidy' },
    })
    if (lang === 'ja') assert(t.includes('お支払い方法を変更しました'), 'JA heading')
    assert(/your payment method has changed/i.test(t), `${lang}: EN heading`)
    assert(t.includes('→'), `${lang}: from → to line`)
    assert(t.includes('1234567'), `${lang}: the new method (transfer) instructions follow`)
  }
})

Deno.test('method changed with no previous method known: heading still says so, no from → to line', async () => {
  for (const lang of LANGS) {
    for (const methodChanged of [{}, { from: null }]) {
      const t = await render(OrderConfirmationEmail, {
        lang, ...base, methods: [], transferDueAt: due, region: 'JP', orderUrl, variant: 'ready',
        chosenMethod: 'card', methodChanged,
      })
      if (lang === 'ja') assert(t.includes('お支払い方法を変更しました'), 'JA heading')
      assert(/your payment method has changed/i.test(t), `${lang}: EN heading`)
      assert(!t.includes('→'), `${lang}: no from → to line without a previous method`)
    }
  }
})

Deno.test('sender: a method change always renders the method-changed heading, audit lookup scoped to cash orders', async () => {
  const src = await Deno.readTextFile(new URL('../supabase/functions/_shared/reservation-emails.ts', import.meta.url))
  assert(src.includes('...(opts.methodChanged ? { methodChanged: { from: changedFrom } } : {})'), 'methodChanged passed whenever opts.methodChanged, even with no previous method')
  const fn = src.slice(src.indexOf('async function previousMethod'), src.indexOf('async function paidyOfferedForEmail'))
  assert(fn.includes('.eq("entity_type", "cash_order")'), 'previousMethod filters entity_type cash_order')
  assert(fn.includes('.eq("action", "payment_method_changed")'), 'previousMethod filters the action')
})

Deno.test('received email with points: the total row is "Order total after points", never "Amount to pay"', async () => {
  for (const lang of LANGS) {
    for (const partial of [false, true]) {
      const t = await render(OrderPaymentReceivedEmail, {
        lang, ...base, method: 'card', amountReceivedJpy: partial ? 60000 : 67000, pointsApplied: 1000, orderUrl,
        ...(partial ? { remaining: 7000, transferDueAt: due, region: 'JP' } : {}),
      })
      assert(t.includes('Order total after points'), `${lang} partial=${partial}: EN after-points label`)
      if (lang === 'ja') assert(t.includes('ポイント利用後のご注文金額'), `JA partial=${partial}: after-points label`)
      assert(!t.includes('Amount to pay'), `${lang} partial=${partial}: no "Amount to pay"`)
      // 「残りのお支払い金額」 (the still-to-pay line) is not the items table; nothing else may say お支払い金額.
      assert(!t.replaceAll('残りのお支払い金額', '').includes('お支払い金額'), `${lang} partial=${partial}: no 「お支払い金額」 in the items table`)
    }
  }
})

Deno.test('payment-due keeps "Amount to pay"', async () => {
  const t = await render(OrderPaymentDueEmail, {
    lang: 'ja', reference: base.reference, currency: 'JPY', amount: 68000, method: 'card', methods: [], transferDueAt: due, region: 'JP', orderUrl,
  })
  assert(t.includes('Amount to pay') && t.includes('お支払い金額'), 'payment-due label unchanged')
})
