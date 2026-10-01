/**
 * CART REMINDERS — the Japanese email never mentions layaway, and every money
 * figure is the Hub's (docs/CART-REMINDERS.md; owner rules 2026-09-25).
 *
 * Renders the cart-reminder template in every form, both languages, HTML and
 * plain text, and fails when:
 *   - a JAPANESE email contains any layaway / deposit word (JA_FORBIDDEN), a
 *     reserve line, a plan panel or "0% interest" — in ANY form, including a
 *     caller that wrongly passes form 'layaway' with lang 'ja';
 *   - an ENGLISH stage-A email prints a reserve line for a piece whose Hub
 *     down payment is missing (either currency), or invents a percentage;
 *   - the mandatory sender block (full address, opt-out link, sales@) is
 *     missing from any email.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/cart-reminder-ja.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { COMPANY_ADDRESS } from '../supabase/functions/_shared/transactional-email-templates/brand.ts'
import { CartReminderEmail, cartReminderSubject, type CartReminderItem, type CartReminderProps } from '../supabase/functions/_shared/email-templates/cart-reminder.tsx'
import { JA_FORBIDDEN, planFiguresFromQuote, reminderForm, type ReminderForm } from '../supabase/functions/_shared/cart-reminder-rules.ts'

const full: CartReminderItem = {
  name: 'Pearl drop earrings', name_ja: 'パールドロップピアス', stone: 'Akoya pearl', qty: 1,
  price_jpy: 68000, price_php: 27016, down_payment_jpy: 20400, down_payment_php: 8105, down_payment_pct: 30,
}
const noPhpDp: CartReminderItem = { name: 'Plain band', qty: 2, price_jpy: 30000, price_php: 11919, down_payment_jpy: 9000, down_payment_php: null, down_payment_pct: 30 }
const noRate: CartReminderItem = { name: 'Chain', qty: 1, price_jpy: 12000, price_php: null }
const plan = { currency: 'JPY' as const, deposit: 20400, monthly: 15867, lastMonth: 15866, termMonths: 3, total: 68000 }
const base = { reserveFirst: true, cartUrl: 'https://www.chajewelsjp.com/cart/restore', unsubscribeUrl: 'https://www.chajewelsjp.com/cart-reminders/unsubscribe?token=t' }

async function both(p: CartReminderProps): Promise<string[]> {
  const el = React.createElement(CartReminderEmail, p)
  return [await renderEmail(el), await renderEmail(el, { plainText: true })]
}

const FORMS: ReminderForm[] = ['stage_a', 'full_jpy', 'full_php', 'layaway']

Deno.test('Japanese: no layaway word, reserve line, plan panel or interest line in any form, HTML or text', async () => {
  for (const form of FORMS) {
    for (const reached of [false, true]) {
      const outs = await both({ ...base, lang: 'ja', form, items: [full, noPhpDp, noRate], plan, reachedCheckout: reached })
      for (const out of outs) {
        for (const w of JA_FORBIDDEN) if (out.includes(w)) throw new Error(`JA ${form}: contains "${w}"`)
        // お取り置き is the reserve-first sentence (we hold the piece after she ORDERS) — the owner's own JA wording, not layaway.
        for (const w of ['reserve', '0% interest', 'Deposit', 'Monthly', '月々', '金利']) {
          if (out.includes(w)) throw new Error(`JA ${form}: contains "${w}"`)
        }
        if (out.includes('₱8,105') || out.includes('20,400')) throw new Error(`JA ${form}: prints a deposit figure`)
      }
    }
  }
  if (JA_FORBIDDEN.some((w) => cartReminderSubject('ja').includes(w))) throw new Error('JA subject')
})

Deno.test('Japanese stage A is yen only; full_php prints the Hub peso and the rate note', async () => {
  const [a] = await both({ ...base, lang: 'ja', form: 'stage_a', items: [full], reachedCheckout: false })
  if (!a.includes('¥68,000')) throw new Error('JA stage A: missing yen')
  if (a.includes('₱')) throw new Error('JA stage A: prints pesos')
  const [p] = await both({ ...base, lang: 'ja', form: 'full_php', items: [full], reachedCheckout: true })
  if (!p.includes('₱27,016') || !p.includes('本日のレート')) throw new Error('JA full_php: missing the Hub peso or the note')
})

Deno.test('English stage A: reserve line only when BOTH Hub deposits exist, with the Hub percentage', async () => {
  const [a] = await both({ ...base, lang: 'en', form: 'stage_a', items: [full, noPhpDp, noRate], reachedCheckout: false })
  if (!a.includes('¥68,000 (₱27,016)')) throw new Error('EN: missing yen (peso)')
  if (!a.includes('Or reserve with ¥20,400 (₱8,105) — 30% down —')) throw new Error('EN: missing the Hub reserve line')
  if (a.includes('¥9,000')) throw new Error('EN: reserve line printed without a peso deposit')
  if ((a.match(/Or reserve with/g) ?? []).length !== 1) throw new Error('EN: reserve line count')
  if (!a.includes('¥12,000') || a.includes('¥12,000 (')) throw new Error('EN: no-rate piece must be yen alone')
  if (!a.includes('we reserve it for you and confirm before you pay')) throw new Error('EN: reserve-first sentence missing')
  const [b] = await both({ ...base, lang: 'en', form: 'stage_a', items: [full], reachedCheckout: false, reserveFirst: false })
  if (b.includes('confirm before you pay')) throw new Error('EN: reserve-first sentence shown while the switch is off')
})

Deno.test('English stage B: full_jpy has no pesos and no reserve line; layaway shows the Hub plan and the checkout line', async () => {
  const [j] = await both({ ...base, lang: 'en', form: 'full_jpy', items: [full], reachedCheckout: true })
  if (j.includes('₱') || j.includes('reserve with')) throw new Error('EN full_jpy: pesos or reserve line')
  if (!j.includes('Your earlier checkout did not reserve anything') || !j.includes('Continue to checkout')) throw new Error('EN full_jpy: stage-B wording')
  const [l] = await both({ ...base, lang: 'en', form: 'layaway', items: [full], plan, reachedCheckout: true })
  for (const w of ['Your layaway plan', 'Deposit', '¥20,400', 'Monthly × 3', '¥15,867', 'Last month', '¥15,866', '0% interest']) {
    if (!l.includes(w)) throw new Error(`EN layaway: missing "${w}"`)
  }
  if (l.includes('reserve with')) throw new Error('EN layaway: stage-A reserve line leaked')
})

Deno.test('every email carries the sender block: full address, opt-out link, sales@', async () => {
  for (const lang of ['ja', 'en'] as const) {
    const [h, t] = await both({ ...base, lang, form: 'stage_a', items: [full], reachedCheckout: false })
    for (const out of [h, t]) {
      if (!out.includes(COMPANY_ADDRESS[lang])) throw new Error(`${lang}: address`)
      if (!out.includes('sales@chajewelsjp.com')) throw new Error(`${lang}: contact`)
      if (!out.includes('cart-reminders/unsubscribe?token=t')) throw new Error(`${lang}: opt-out link`)
    }
    if (!h.includes(lang === 'ja' ? '配信停止' : 'Stop cart reminders')) throw new Error(`${lang}: opt-out words`)
  }
})

Deno.test('rules: JA + layaway quote renders the stage-A form; a refused or downgraded quote gives no plan', () => {
  if (reminderForm('ja', { quote_mode: 'layaway', quote_currency: 'JPY', quote_term: 6 }) !== 'stage_a') throw new Error('ja layaway')
  if (reminderForm('en', { quote_mode: 'layaway', quote_currency: 'JPY', quote_term: 6 }) !== 'layaway') throw new Error('en layaway')
  if (reminderForm('en', { quote_mode: 'full', quote_currency: 'PHP' }) !== 'full_php') throw new Error('full php')
  if (reminderForm('en', null) !== 'stage_a') throw new Error('no quote')
  const ok = { eligible: true, term_downgraded: false, deposit: 20400, monthly: 15867, last_month: 15866, term_months: 3, total: 68000 }
  if (!planFiguresFromQuote(ok, 'JPY')) throw new Error('eligible quote refused')
  if (planFiguresFromQuote({ ...ok, eligible: false }, 'JPY')) throw new Error('ineligible quote accepted')
  if (planFiguresFromQuote({ ...ok, term_downgraded: true }, 'JPY')) throw new Error('downgraded quote accepted')
})
