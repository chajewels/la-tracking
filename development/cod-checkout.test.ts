/**
 * CASH ON DELIVERY (代金引換) at website checkout — owner plan 2026-10-10,
 * migration 20261202100000_cod_checkout.sql, docs/COD.md.
 *
 *   - the TS fee mirror (_shared/cod-fee.ts) equals the SQL rule: same seed
 *     table, same inclusive brackets, same limit, same validity rules (and,
 *     when COD_PG_DB names a local database with the migration applied, the
 *     two are compared value by value through psql);
 *   - who is offered COD (layaway / pesos / off / abroad / nothing to collect /
 *     over the limit), and the mappers never read 'cod' as transfer;
 *   - a customer may not file a COD payment (submit-cash-payment Path A);
 *   - the expiry sweep, Confirm and the website API carry COD;
 *   - the emails: COD fee row, no deadline lines, no transfer wording;
 *   - the migration's anchors carry no comment lines (Lovable strips them).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/cod-checkout.test.ts
 *      (COD_PG_DB=<db> and --allow-run add the live-SQL comparison locally.)
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import {
  DEFAULT_COD_FEE_TABLE, codFeeJpy, codFeeTable, codFeeTableValid, codLimitJpy, codModeFrom,
  codNotOfferedReason, customerFilingRefusal,
} from '../supabase/functions/_shared/cod-fee.ts'
import { CHECKOUT_METHODS, checkoutMethodOptions, publicMethod, storedMethod } from '../supabase/functions/_shared/checkout-choice.ts'
import { CUSTOMER_METHODS, canCustomerSwitch } from '../supabase/functions/_shared/method-switch-rules.ts'
import { notAcceptedMethod } from '../supabase/functions/_shared/payment-rejected-email.ts'
import { OrderConfirmationEmail } from '../supabase/functions/_shared/email-templates/order-confirmation.tsx'
import { OrderReservedEmail } from '../supabase/functions/_shared/email-templates/order-reserved.tsx'
import { OrderPaymentReceivedEmail } from '../supabase/functions/_shared/email-templates/order-payment-received.tsx'
import { OrderPaymentNotAcceptedEmail } from '../supabase/functions/_shared/email-templates/order-payment-not-accepted.tsx'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`)
const read = (p: string) => Deno.readTextFileSync(new URL(`../${p}`, import.meta.url))
const MIG = read('supabase/migrations/20261202100000_cod_checkout.sql')
const T = [...DEFAULT_COD_FEE_TABLE]

// ---------------------------------------------------------------- the fee rule
Deno.test('fee brackets are inclusive, owner figures', () => {
  const cases: [number, number | null][] = [
    [1, 1040], [10000, 1040], [10001, 1150], [30000, 1150], [30001, 1370], [100000, 1370],
    [100001, 1810], [300000, 1810], [300001, null], [0, null], [-1, null],
  ]
  for (const [c, fee] of cases) eq(codFeeJpy(c, T), fee, `codFeeJpy(${c})`)
  eq(codLimitJpy(T), 300000, 'limit')
})

Deno.test('the TS default table IS the SQL seed', () => {
  const m = MIG.match(/VALUES \('cod_fee_table',\s*'(\[[^']+\])'::jsonb/)
  assert(m, 'seed not found in the migration')
  eq(JSON.parse(m![1]), T, 'seed vs DEFAULT_COD_FEE_TABLE')
  assert(/VALUES \('cod_mode', '"off"'::jsonb/.test(MIG), 'cod_mode must be seeded off')
})

Deno.test('table validity mirrors cod_fee_table_valid', () => {
  assert(codFeeTableValid(T), 'default valid')
  assert(!codFeeTableValid([]), 'empty')
  assert(!codFeeTableValid([{ max_jpy: 30000, fee_jpy: 1 }, { max_jpy: 10000, fee_jpy: 2 }]), 'descending')
  assert(!codFeeTableValid([{ max_jpy: 10000, fee_jpy: 1.5 }]), 'fraction')
  assert(!codFeeTableValid([{ max_jpy: 10000, fee_jpy: -1 }]), 'negative fee')
  assert(!codFeeTableValid([{ max_jpy: 10000, fee_jpy: 100001 }]), 'fee too large')
  assert(!codFeeTableValid(Array.from({ length: 11 }, (_, i) => ({ max_jpy: (i + 1) * 1000, fee_jpy: 1 }))), '11 rows')
  eq(codFeeTable('nonsense'), null, 'invalid → null')
  eq(codFeeJpy(5000, null), null, 'no table → no COD')
  for (const raw of ['on']) eq(codModeFrom(raw), 'on', 'on')
  for (const raw of ['off', 'ON', ' on', '', null, undefined, true]) eq(codModeFrom(raw), 'off', `fail-closed ${String(raw)}`)
})

Deno.test('the SQL rule reads the same table the same way (shape check)', () => {
  assert(/WHERE p_collected <= \(e ->> 'max_jpy'\)::numeric\s+ORDER BY \(e ->> 'max_jpy'\)::numeric\s+LIMIT 1/.test(MIG), 'first bracket with collected <= max, ascending')
  assert(/WHEN p_collected IS NULL OR p_collected <= 0 OR NOT public\.cod_fee_table_valid\(t\) THEN NULL/.test(MIG), 'null on nothing / invalid')
})

// Optional: value-by-value against the real SQL (local only).
const DB = Deno.env.get('COD_PG_DB')
Deno.test({
  name: 'TS mirror == public.cod_fee_jpy on a local database (COD_PG_DB)',
  ignore: !DB,
  fn: async () => {
    const points = [-1, 0, 1, 9999, 10000, 10001, 29999, 30000, 30001, 99999, 100000, 100001, 299999, 300000, 300001, 1000000]
    const sql = `SELECT string_agg(coalesce(public.cod_fee_jpy(v)::text, 'null'), ',' ORDER BY ord) FROM unnest(ARRAY[${points.join(',')}]::numeric[]) WITH ORDINALITY u(v, ord)`
    const out = await new Deno.Command('sudo', { args: ['-u', 'postgres', 'psql', '-d', DB!, '-Atc', sql] }).output()
    const got = new TextDecoder().decode(out.stdout).trim().split(',').map((x) => (x === 'null' ? null : Number(x)))
    eq(got, points.map((p) => codFeeJpy(p, T)), 'SQL vs TS')
  },
})

// ---------------------------------------------------------------- who is offered COD
const offer = (o: Partial<Parameters<typeof codNotOfferedReason>[0]>) => codNotOfferedReason({
  mode: 'full', currency: 'JPY', country: 'JP', codMode: 'on', collectedJpy: 20000, table: T, ...o,
})
Deno.test('COD reasons, in order: layaway, currency_not_yen, off, address_not_jp, nothing_to_collect, over_cod_limit', () => {
  eq(offer({}), null, 'offered')
  eq(offer({ mode: 'layaway', currency: 'PHP' }), 'layaway', 'layaway first')
  eq(offer({ currency: 'PHP' }), 'currency_not_yen', 'pesos')
  eq(offer({ codMode: 'off' }), 'off', 'switched off')
  eq(offer({ table: null }), 'off', 'no valid table')
  eq(offer({ country: 'PH' }), 'address_not_jp', 'abroad')
  eq(offer({ collectedJpy: 0 }), 'nothing_to_collect', 'nothing to collect')
  eq(offer({ collectedJpy: 300001 }), 'over_cod_limit', 'over the limit')
  eq(offer({ collectedJpy: 300000 }), null, 'at the limit — the fee is not counted')
})

Deno.test('checkout options: cod offered with its Hub fee; greyed with a reason otherwise', () => {
  const base = { mode: 'full' as const, currency: 'JPY' as const, country: 'JP', paidyMode: 'off' as const, squareMode: 'off' as const, customerIsTest: false, transferAvailable: true }
  const on = checkoutMethodOptions({ ...base, codMode: 'on', codTable: T, codCollectedJpy: 20800 })
  eq(on.cod, { available: true, reason: null, fee_jpy: 1150 }, 'offered')
  const off = checkoutMethodOptions(base)
  eq(off.cod, { available: false, reason: 'off', fee_jpy: null }, 'omitted switch = off')
  const over = checkoutMethodOptions({ ...base, codMode: 'on', codTable: T, codCollectedJpy: 400000 })
  eq(over.cod.reason, 'over_cod_limit', 'over')
  assert(CHECKOUT_METHODS.includes('cod'), 'cod is a checkout method')
})

Deno.test('mappers never read cod as transfer', () => {
  eq(storedMethod('cod'), 'cod', 'storedMethod')
  eq(storedMethod(' COD '), 'cod', 'storedMethod trims/case')
  eq(publicMethod('cod'), 'cod', 'publicMethod')
  eq(publicMethod(null), 'transfer', 'null stays transfer (pre-2026-10-05 orders)')
  eq(notAcceptedMethod('cod'), 'cod', 'rejection email method')
  eq(notAcceptedMethod('Cash on Delivery'), 'cod', 'rejection email method (label)')
  const hub = read('src/lib/web-payment-method.ts')
  assert(/if \(v === 'cod'\) return 'cod';/.test(hub), 'Hub webMethodOf maps cod')
})

Deno.test('the customer switch allows cod by the same rules (offer is checked by the caller)', () => {
  assert((CUSTOMER_METHODS as readonly string[]).includes('cod'), 'cod in CUSTOMER_METHODS')
  const base = { status: 'pending', paymentStatus: 'pending_transfer', sourceChannel: 'web', lock: null, latestDecision: 'rejected' as const, switchedSinceDecision: false, currency: 'JPY', from: 'transfer' }
  eq(canCustomerSwitch({ ...base, to: 'cod' }), { ok: true }, 'transfer → cod')
  eq(canCustomerSwitch({ ...base, from: 'cod', to: 'transfer' }), { ok: true }, 'cod → transfer')
  eq(canCustomerSwitch({ ...base, currency: 'PHP', to: 'cod' }), { ok: false, error: 'method_requires_yen' }, 'pesos')
  eq(canCustomerSwitch({ ...base, lock: 'submission_pending', to: 'cod' }), { ok: false, error: 'payment_in_progress' }, 'lock')
})

// ---------------------------------------------------------------- the customer cannot file COD
Deno.test('a customer may not file a COD payment, nor pay a COD order herself', () => {
  for (const m of ['cod', 'COD', 'Cash on Delivery', 'cash-on-delivery', '代金引換']) eq(customerFilingRefusal(m, 'transfer'), 'cod_staff_only', m)
  eq(customerFilingRefusal('bank_transfer', 'cod'), 'cod_paid_on_delivery', 'any method on a COD order')
  eq(customerFilingRefusal('bank_transfer', 'transfer'), null, 'regression: transfer on a transfer order')
  const src = read('supabase/functions/submit-cash-payment/index.ts')
  assert(/if \(pathACustomerId\) \{\s+const \{ data: methodRow \}[\s\S]{0,300}customerFilingRefusal\(payment_method/.test(src), 'Path A (customer) runs customerFilingRefusal')
  assert(src.indexOf('customerFilingRefusal(payment_method') < src.indexOf('.from("payment_submissions")\n      .insert(insertRow)'), 'refused before the insert')
})

// ---------------------------------------------------------------- wiring
Deno.test('wiring: expiry sweep, Confirm, website API, reminders', () => {
  const sweep = read('supabase/functions/auto-expire-cash-orders/index.ts')
  assert(sweep.includes('or(payment_method.is.null,payment_method.neq.cod)'), 'auto-expire leaves COD out')
  const figures = read('supabase/functions/_shared/web-draft-figures.ts')
  assert(/supabase\.rpc\("cod_fee_jpy", \{ p_collected: collected \}\)/.test(figures), 'Confirm re-brackets with the SQL rule')
  assert(/if \(isCod\) \{/.test(figures), 'no deadline computed for COD')
  const confirm = read('supabase/functions/confirm-web-draft/index.ts')
  assert(/cod_fee: figures\.cod_fee,/.test(confirm), 'confirm sends cod_fee to materialize')
  const site = read('supabase/functions/website/index.ts')
  assert(/fee_jpy: options\.cod\.fee_jpy \?\? null/.test(site), 'payment_options carries the COD fee')
  assert(/cod_fee: codFee,/.test(site), 'totals carry cod_fee')
  assert(/if \(to === "cod"\) return \(await codOffer\(/.test(site), 'switch target cod checks the offer')
  assert(/"cod_mode", "cod_fee_table"\]/.test(site), 'reads the switch and the table')
  const rem = read('supabase/functions/_shared/payment-reminder-emails.ts')
  assert(/if \(method === "cod"\) return \{ sent: false, reason: "error", detail: "cod_no_reminder" \};/.test(rem), 'no reminder email for COD')
})

// ---------------------------------------------------------------- the migration
Deno.test('migration: md5-guarded patches of the seven live bodies, no comment lines in anchors', () => {
  for (const [fn, md5] of [
    ['create_web_draft_atomic', 'f0a9ffb0b7da4270b95a11f12598e202'],
    ['materialize_web_draft_atomic', '705947d28506eccffc57e78dcdade34b'],
    ['change_web_payment_method_atomic', '4d07cf117230e17683ac15238ad52af8'],
    ['switch_web_payment_method_by_customer_atomic', 'd1ade6ebaeef2a1737dcd7c7a8dbb511'],
    ['terminate_web_order_atomic', '2901b12e50afdc83dfc51ef07c91bc1b'],
    ['web_payment_reminder_eligible', '384a7617728fe87832646d9f98b47dfd'],
    ['set_account_deadlines', '540e9b703377a02e3d4126143197ef79'],
  ]) assert(new RegExp(`cj_patch\\('public\\.${fn}\\([^']*\\)', '${md5}'`).test(MIG), `${fn} patched from live md5 ${md5}`)
  for (const block of MIG.matchAll(/\$(o|n)\$([\s\S]*?)\$\1\$/g)) {
    assert(!/^\s*--/m.test(block[2]), `comment line inside a patch anchor/new text: ${block[2].slice(0, 80)}`)
  }
  assert(/REVOKE ALL ON FUNCTION public\.cod_fee_jpy\(numeric\) FROM PUBLIC, anon, authenticated;/.test(MIG), 'fee rule not callable by customers')
  assert(/IF NOT public\.has_role\(v_uid, 'admin'::public\.app_role\) THEN\s+RETURN jsonb_build_object\('error', 'permission_denied'\);/.test(MIG), 'setter is admin-role only')
  assert(!/DROP FUNCTION/.test(MIG), 'no DROP FUNCTION')
})

Deno.test('review fixes: H1 deadline cleared / shipped never expires, M1 fresh deadline, H2 money lock, L2', () => {
  assert(/transfer_due_at = CASE WHEN p_method = 'cod' THEN NULL ELSE transfer_due_at END,\s+expires_at = CASE WHEN p_method = 'cod' THEN NULL ELSE expires_at END,/.test(MIG), 'H1: switching to COD clears both deadline columns')
  assert(/AND shipped_at IS NOT NULL\) THEN\s+RETURN jsonb_build_object\('ok', false, 'success', false, 'reason', 'shipped'/.test(MIG), 'H1: shipped orders never auto-expire')
  assert(read('supabase/functions/auto-expire-cash-orders/index.ts').includes('.is("shipped_at", null)'), 'H1: sweep leaves shipped orders out')
  assert((MIG.match(/v_dl := public\.set_account_deadlines\(/g) ?? []).length === 2, 'M1: both switches arm the deadline through set_account_deadlines')
  assert((MIG.match(/public\.web_deposit_deadline_hours\(/g) ?? []).length === 2, 'M1: at the customer rule')
  assert(/CREATE TRIGGER trg_guard_cod_order_amount\s+BEFORE UPDATE OF total_amount, shipping_fee, discount_amount, cod_fee ON public\.cash_orders/.test(MIG), 'H2: money lock trigger')
  assert(/RETURN jsonb_build_object\('error', 'cod_no_deadline'\);/.test(MIG), 'L2: set_account_deadlines refuses COD')
  const cpm = read('supabase/functions/change-payment-method/index.ts')
  assert(cpm.includes('deadline_in_past: deadlineInPast') && cpm.includes('deadlineMissing = !due;'), 'warns on a missing or past deadline')
})

// ---------------------------------------------------------------- emails
const render = async (c: React.ComponentType<any>, p: Record<string, unknown>) =>
  (await renderEmail(React.createElement(c, p), { plainText: true })).replace(/[ \t]*\n[ \t]*/g, ' ')
const items = [{ title: 'K18 Necklace', title_ja: 'K18 ネックレス', qty: 1, line_total_jpy: 20000 }]
const base = { reference: 'CJ-W-900099', items, shippingJpy: 0, totalJpy: 21150, currency: 'JPY' as const, orderUrl: 'https://www.chajewelsjp.com/account/orders/x' }
const TRANSFER_WORDS = /振込|transfer|bank/i

for (const lang of ['ja', 'en'] as const) {
  Deno.test(`order confirmation (COD, ${lang}): fee row, paid on delivery, no deadline, no transfer words`, async () => {
    const t = await render(OrderConfirmationEmail, { lang, ...base, methods: [], transferDueAt: '', region: 'JP', variant: 'ready', chosenMethod: 'cod', codFee: 1150 })
    assert(t.includes('Cash on delivery fee') && t.includes('¥1,150'), 'fee row (EN block always present)')
    if (lang === 'ja') assert(t.includes('代引手数料') && t.includes('配達員'), 'JA fee row + courier')
    assert(t.includes('courier when your parcel arrives'), 'paid to the courier on delivery')
    assert(!/Pay by:|Transfer by:|お支払い期限|お振込期限|cancelled automatically|自動的にキャンセル/.test(t), `no deadline lines:\n${t}`)
    const hit = t.match(TRANSFER_WORDS)
    assert(!hit, `transfer wording "${hit?.[0]}":\n${t}`)
  })
  Deno.test(`order reserved (COD, ${lang}): fee row, no transfer words`, async () => {
    const t = await render(OrderReservedEmail, { lang, ...base, method: 'cod', provisional: true, codFee: 1150 })
    assert(t.includes('Cash on delivery fee') && t.includes('cash on delivery'), 'fee row + COD next step')
    assert(!TRANSFER_WORDS.test(t), `transfer wording:\n${t}`)
  })
  Deno.test(`payment received + not accepted (COD, ${lang}) name cash on delivery`, async () => {
    const r = await render(OrderPaymentReceivedEmail, { lang, ...base, method: 'cod', amountReceivedJpy: 21150 })
    assert(r.includes('cash on delivery payment') && r.includes('Thank you for receiving your parcel'), `received:\n${r}`)
    const n = await render(OrderPaymentNotAcceptedEmail, { lang, reference: base.reference, method: 'cod', kind: 'staff', amount: 21150, currency: 'JPY', reason: null, remaining: 21150, transferDueAt: null, region: 'JP', orderUrl: base.orderUrl })
    assert(n.includes('cash on delivery') && !TRANSFER_WORDS.test(n), `not accepted:\n${n}`)
  })
}
Deno.test('regression: a transfer confirmation still has its deadline and no COD row', async () => {
  const t = await render(OrderConfirmationEmail, { lang: 'en', ...base, methods: [], transferDueAt: '2026-10-12T00:00:00Z', region: 'JP', variant: 'ready', chosenMethod: 'transfer' })
  assert(t.includes('Transfer by:') && !t.includes('Cash on delivery fee'), t)
})
