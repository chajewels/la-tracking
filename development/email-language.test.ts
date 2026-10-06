/**
 * EMAIL LANGUAGE FOLLOWS THE CUSTOMER (payment lifecycle H2, 2026-10-05).
 *
 *   - the customer's own language wins ('en' / 'ja');
 *   - with none stored, the delivery country decides: JP → Japanese,
 *     anything else (or unknown) → English;
 *   - an English order email's subject is English only (no Japanese);
 *   - a Japanese one is "Japanese / English";
 *   - the order-page button in Japanese reads 「ご注文ページを見る」.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/email-language.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { emailLang, pickLang, snapshotCountry, type Lang } from '../supabase/functions/_shared/storefront-email.ts'
import { subjectFor } from '../supabase/functions/_shared/email-templates/order-shared.tsx'
import { orderConfirmationSubject, orderReadySubject } from '../supabase/functions/_shared/email-templates/order-confirmation.tsx'
import { orderReservedSubject } from '../supabase/functions/_shared/email-templates/order-reserved.tsx'
import { orderPaymentReceivedSubject } from '../supabase/functions/_shared/email-templates/order-payment-received.tsx'
import { orderPaymentDueSubject } from '../supabase/functions/_shared/email-templates/order-payment-due.tsx'
import { orderExpiredSubject } from '../supabase/functions/_shared/email-templates/order-expired.tsx'
import {
  OrderPaymentNotAcceptedEmail, orderPaymentNotAcceptedSubject,
} from '../supabase/functions/_shared/email-templates/order-payment-not-accepted.tsx'
import { orderCancelledSubject } from '../supabase/functions/_shared/email-templates/order-cancelled.tsx'
import { orderReservationLapsedSubject } from '../supabase/functions/_shared/email-templates/order-reservation-lapsed.tsx'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const CJK = /[぀-ヿ一-龯]/

Deno.test('emailLang: stored language wins, else delivery country (JP → ja, else en)', () => {
  assert(emailLang('en', 'JP') === 'en', "emailLang('en','JP')")
  assert(emailLang('ja', 'PH') === 'ja', "emailLang('ja','PH')")
  assert(emailLang(null, 'PH') === 'en', "emailLang(null,'PH')")
  assert(emailLang(null, 'JP') === 'ja', "emailLang(null,'JP')")
  assert(emailLang(undefined, null) === 'en', "emailLang(undefined,null)")
  assert(emailLang('fr', undefined) === 'en', "emailLang('fr',undefined)")
})

Deno.test('pickLang stays for old callers: emailLang(v, JP)', () => {
  assert(pickLang('en') === 'en' && pickLang('ja') === 'ja' && pickLang(null) === 'ja', 'pickLang')
})

Deno.test('snapshotCountry reads ship_to_snapshot.country', () => {
  assert(snapshotCountry({ ship_to_snapshot: { country: 'PH' } }) === 'PH', 'PH')
  assert(snapshotCountry({ ship_to_snapshot: null }) === null, 'null snapshot')
  assert(snapshotCountry({}) === null, 'no snapshot')
  assert(snapshotCountry({ ship_to_snapshot: { country: '' } }) === null, 'empty country')
  assert(snapshotCountry({ ship_to_snapshot: 'x' }) === null, 'non-object')
})

Deno.test('subjectFor: ja → "JA / EN", en → EN only', () => {
  assert(subjectFor('ja', 'あ', 'A') === 'あ / A', 'ja')
  assert(subjectFor('en', 'あ', 'A') === 'A', 'en')
})

Deno.test('payment-not-accepted subject: English has no Japanese; Japanese has both', () => {
  const en = orderPaymentNotAcceptedSubject('CJ-W-1', 'en')
  assert(!CJK.test(en), `EN subject has Japanese: ${en}`)
  const ja = orderPaymentNotAcceptedSubject('CJ-W-1', 'ja')
  assert(ja.includes('お支払いを確認できませんでした') && ja.includes('We could not accept your payment'), ja)
})

const SUBJECTS: Record<string, (ref: string, lang: Lang) => string> = {
  orderConfirmationSubject, orderReadySubject, orderReservedSubject, orderPaymentReceivedSubject,
  orderPaymentDueSubject, orderExpiredSubject, orderPaymentNotAcceptedSubject, orderCancelledSubject,
  orderReservationLapsedSubject,
}

Deno.test('every order subject: English has no Japanese, Japanese carries both and the reference', () => {
  for (const [name, fn] of Object.entries(SUBJECTS)) {
    const en = fn('CJ-W-000123', 'en')
    assert(!CJK.test(en), `${name} EN has Japanese: ${en}`)
    assert(en.includes('CJ-W-000123'), `${name} EN reference`)
    const ja = fn('CJ-W-000123', 'ja')
    assert(CJK.test(ja) && ja.includes(' / ') && ja.includes(en), `${name} JA must be "JA / EN": ${ja}`)
  }
})

Deno.test('Japanese payment-not-accepted email: the button reads ご注文ページを見る', async () => {
  const t = await renderEmail(React.createElement(OrderPaymentNotAcceptedEmail, {
    lang: 'ja', reference: 'CJ-W-1', method: 'transfer', kind: 'staff', amount: 980, currency: 'JPY',
    reason: null, remaining: 980, transferDueAt: '2026-10-08T01:49:18.592Z', region: 'JP',
    orderUrl: 'https://www.chajewelsjp.com/account/orders/x',
  }), { plainText: true })
  assert(t.includes('ご注文ページを見る'), 'JA button')
})
