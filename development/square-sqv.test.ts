/**
 * SQV01–SQV06 + D-G04 + D-SQV05 (Square fix revalidation, 2026-10-09), edge + Hub side.
 *   SQV01 — the refund writer is service_role only again (SQL test); the edge still calls it.
 *   SQV02/SQV03 — approve first, then pay: the edge re-reads Square (resyncOrderRefunds,
 *           fail closed) before approve_card_refund_exception_atomic; the dialog is two steps.
 *   SQV04 — the age trigger is authorized_at more than one calendar year ago.
 *   SQV06 — the refund-email sentence never promises a retry that is not scheduled.
 *   D-SQV05 — read-only production preflight classification.
 *   D-G04 — the card allow-list (squareCardAllowed, not_on_card_list, checkout "off").
 * The SQL side is development/sql/sqv-square-exception-allowlist-acceptance.sql
 * and development/sql/sqv-concurrency.sh.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-sqv.test.ts
 */
import { refundEmailCoverage, refundEmailSentence, refundEmailState } from '../supabase/functions/_shared/refund-email-state.ts'
import { type ResyncDeps, resyncOrderRefunds } from '../supabase/functions/_shared/square-refund-resync.ts'
import { preflightPassed, preflightStateOf, tokenSecretInUse } from '../supabase/functions/_shared/square-preflight-rules.ts'
import { cardNotOfferedReason, squareAudienceFrom, squareCardAllowed, squareCardCustomerIds } from '../supabase/functions/_shared/card-rules.ts'
import { checkoutMethodOptions } from '../supabase/functions/_shared/checkout-choice.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const read = (rel: string) => Deno.readTextFile(new URL(`../${rel}`, import.meta.url))
const code = async (rel: string) => (await read(rel)).replace(/^\s*(\*|\/\/).*$/gm, '')

// ---------------------------------------------------------------- SQV06
Deno.test('SQV06: refund email state — only an armed, not-given-up replay is "retrying"', () => {
  eq(refundEmailState({ sent: true, replay: false, givenUpAt: '2026-10-09T00:00:00Z' }), 'sent', 'a sent row wins')
  eq(refundEmailState({ sent: false, replay: true, givenUpAt: null }), 'retrying', 'armed replay')
  eq(refundEmailState({ sent: false, replay: true, givenUpAt: '2026-10-09T00:00:00Z' }), 'given_up', 'gave up')
  eq(refundEmailState({ sent: false, replay: false, givenUpAt: null }), 'not_replayed', 'never armed (pre-release refund)')
  eq(refundEmailState({ sent: false, replay: null, givenUpAt: undefined }), 'not_replayed', 'null replay = not armed')
})

Deno.test('SQV06: the sentence never says "will retry" unless a retry is scheduled', () => {
  const s = (xs: Parameters<typeof refundEmailCoverage>[0]) => refundEmailSentence(refundEmailCoverage(xs))
  eq(s([]), '', 'no card refunds → nothing to say')
  assert(s(['sent']).includes('already told the customer'), 'one sent')
  assert(s(['sent', 'sent']).includes('All 2'), 'all sent')
  assert(s(['retrying']).includes('The hourly check will retry it.'), 'one retrying')
  for (const st of ['given_up', 'not_replayed'] as const) {
    const t = s([st])
    assert(!/will retry/.test(t), `${st}: no retry promise — "${t}"`)
    assert(/another way/.test(t), `${st}: tells staff to reach the customer — "${t}"`)
  }
  assert(s(['given_up']).includes('bell'), 'given up points at the bell')
  const mixed = s(['sent', 'retrying', 'not_replayed'])
  assert(mixed.startsWith('1 of 3 Square refund emails are confirmed sent.'), `count first — "${mixed}"`)
  assert(mixed.includes('will retry 1') && mixed.includes('1 will not be retried'), `mixed is exact — "${mixed}"`)
})

// ---------------------------------------------------------------- SQV03 resync
type Row = Record<string, unknown>
function fakeDb(tables: Record<string, Row[] | Error>) {
  return {
    from(t: string) {
      const filters: Array<[string, unknown]> = []
      const q = {
        select() { return q },
        eq(c: string, v: unknown) { filters.push([c, v]); return q },
        then(res: (v: { data: Row[] | null; error: unknown }) => unknown) {
          const src = tables[t]
          if (src instanceof Error) return Promise.resolve(res({ data: null, error: src }))
          return Promise.resolve(res({ data: (src ?? []).filter((r) => filters.every(([c, v]) => r[c] === v)), error: null }))
        },
      }
      return q
    },
  }
}
const ORDER = 'o-1'
function deps(over: Partial<ResyncDeps> & { log?: string[] } = {}): ResyncDeps {
  const log = over.log ?? []
  return {
    getPayment: over.getPayment ?? (async (env, id) => { log.push(`pay:${env}:${id}`); return { id, status: 'COMPLETED', amount_money: { amount: 1000, currency: 'JPY' }, created_at: '', refund_ids: ['r-sq'] } as never }),
    getRefund: over.getRefund ?? (async (env, id) => { log.push(`ref:${env}:${id}`); return { id, status: 'COMPLETED' } as never }),
    sync: over.sync ?? (async (_env, r) => { log.push(`sync:${r.id}`); return { outcome: 'synced' } }),
  }
}

Deno.test('SQV03: resync reads every captured payment and every refund (Square-listed AND Hub-known), then records each', async () => {
  const db = fakeDb({
    square_payments: [
      { cash_order_id: ORDER, status: 'captured', square_payment_id: 'p1', environment: 'production', test: false },
      { cash_order_id: ORDER, status: 'voided', square_payment_id: 'p0', environment: 'production', test: false },
    ],
    square_refunds: [{ cash_order_id: ORDER, square_refund_id: 'r-hub', square_payment_id: 'p1' }],
  })
  const log: string[] = []
  const r = await resyncOrderRefunds(db, ORDER, deps({ log }))
  eq(r, { ok: true, payments: 1, refunds: 2 }, 'result')
  assert(log.includes('pay:production:p1') && !log.some((l) => l.includes('p0')), 'only captured payments are read')
  assert(log.includes('ref:production:r-sq') && log.includes('ref:production:r-hub'), 'Square-listed and Hub-known refunds are both read')
  assert(log.includes('sync:r-sq') && log.includes('sync:r-hub'), 'each refund goes through syncSquareRefund')
})

Deno.test('SQV03: environment falls back to the test flag when the column is empty', async () => {
  const db = fakeDb({ square_payments: [{ cash_order_id: ORDER, status: 'captured', square_payment_id: 'p1', environment: null, test: true }], square_refunds: [] })
  const log: string[] = []
  await resyncOrderRefunds(db, ORDER, deps({ log }))
  assert(log.includes('pay:sandbox:p1'), `sandbox for a test payment — ${log.join(',')}`)
})

Deno.test('SQV03: resync FAILS CLOSED — Square unreachable, a refund not recorded, or a Hub read error refuses the approval', async () => {
  const ok = { square_payments: [{ cash_order_id: ORDER, status: 'captured', square_payment_id: 'p1', environment: 'production', test: false }], square_refunds: [] as Row[] }
  const a = await resyncOrderRefunds(fakeDb(ok), ORDER, deps({ getPayment: () => Promise.reject(new Error('timeout')) }))
  eq(a.ok ? '' : a.error, 'square_unreachable', 'payment read fails')
  const b = await resyncOrderRefunds(fakeDb(ok), ORDER, deps({ getRefund: () => Promise.reject(new Error('503')) }))
  eq(b.ok ? '' : b.error, 'square_unreachable', 'refund read fails')
  const c = await resyncOrderRefunds(fakeDb(ok), ORDER, deps({ sync: async () => ({ outcome: 'refused', detail: 'over_ceiling' }) }))
  eq(c.ok ? '' : c.error, 'refund_not_recorded', 'a refund the Hub could not record')
  assert(!c.ok && c.detail.includes('over_ceiling'), 'detail carried')
  const d = await resyncOrderRefunds(fakeDb(ok), ORDER, deps({ sync: () => Promise.reject(new Error('rpc')) }))
  eq(d.ok ? '' : d.error, 'refund_not_recorded', 'sync throws')
  const e = await resyncOrderRefunds(fakeDb({ square_payments: new Error('rls'), square_refunds: [] }), ORDER, deps())
  eq(e.ok ? '' : e.error, 'hub_read_failed', 'Hub read error')
})

Deno.test('SQV02/SQV03 edge: approve = admin → resync (fail closed) → approve RPC; cancel_approval; record carries the sentence', async () => {
  const src = await code('supabase/functions/mark-refund-issued/index.ts')
  const iResync = src.indexOf('const resync = await resyncOrderRefunds(supabase, orderId);')
  const iApprove = src.indexOf('supabase.rpc("approve_card_refund_exception_atomic"')
  assert(iResync > 0 && iApprove > iResync, 'Square is re-read before the approval RPC')
  assert(src.includes('if (!resync.ok) return jsonResponse({ error: resync.error, detail: resync.detail }, STATUS[resync.error] ?? 503);'), 'a failed resync refuses')
  assert(src.includes('supabase.rpc("cancel_card_refund_exception_atomic"'), 'cancel path')
  assert(src.includes('square_unreachable: 503') && src.includes('exception_refund_in_progress: 409'), 'status codes')
  assert(src.includes('refund_email_sentence: refundEmailSentence(coverage)'), 'SQV06 sentence in the answer')
  assert(src.includes('mark_web_order_refund_issued_atomic'), 'SQV01: the edge (service role) still records')
})

// ---------------------------------------------------------------- Hub dialog
Deno.test('Hub dialog: two steps, fail-closed facts, sticky footer, calendar-year age, PHT approval day', async () => {
  const ui = await read('src/components/web-orders/MarkRefundIssuedDialog.tsx')
  assert(ui.includes("const step: 'approve' | 'record' | null = isException ? (approval ? 'record' : 'approve') : null;"), 'approve → record')
  assert(ui.includes("const factsMissing = cardError !== null || card === null;") && ui.includes('disabled={busy || !day || factsMissing'), 'fail closed when the card facts cannot be read')
  assert(ui.includes('max-h-[90vh]') && ui.includes('overflow-y-auto') && ui.includes('data-testid="refund-footer"'), 'scrolling body, fixed footer')
  assert(ui.includes("d.setUTCFullYear(d.getUTCFullYear() - 1);") && ui.includes("select('authorized_at, status, amount_jpy')"), 'SQV04: authorized_at + one calendar year')
  assert(!ui.includes('captureOver365') && !ui.includes('EXCEPTION_AGE_DAYS'), 'the 365-day capture rule is gone')
  assert(ui.includes("timeZone: 'Asia/Manila'"), 'approval day is the PHT day the SQL compares with')
  assert(ui.includes('refundProcessing') && ui.includes('approveIncomplete'), 'approve disabled while a Square refund is processing')
})

// ---------------------------------------------------------------- D-SQV05 preflight
Deno.test('D-SQV05: a first 401/403 is auth_failed, never "not enabled"; only success passes', () => {
  eq(preflightStateOf({ status: 401 }), 'auth_failed', '401')
  eq(preflightStateOf({ status: 403, code: 'INSUFFICIENT_SCOPES' }), 'auth_failed', '403')
  eq(preflightStateOf({ kind: 'not_configured' }), 'not_configured', 'no token')
  eq(preflightStateOf({ status: 503 }), 'unavailable', '5xx')
  eq(preflightStateOf({ status: 429 }), 'unavailable', 'rate limit')
  eq(preflightStateOf({ status: 400, code: 'BAD_REQUEST' }), 'refused', '4xx')
  eq(preflightStateOf(null), 'unavailable', 'nothing')
  const base = {
    environment: 'production' as const, token: { state: 'ok' as const, status: 200, code: null, secret: 'SQUARE_PRODUCTION_ACCESS_TOKEN' },
    locations: ['L1'], location_configured: 'L1', location_match: true, app_id_family: 'production' as const,
    events: { state: 'ok' as const, status: 200, code: null, first_page: 0, window_days: 28 },
    location: { status: 'ACTIVE', currency: 'JPY', country: 'JP' }, webhook_key: true,
  }
  assert(preflightPassed(base), 'all ok passes')
  // M2 / F-14 (QC 2026-10-09)
  assert(!preflightPassed({ ...base, location: { status: 'INACTIVE', currency: 'JPY', country: 'JP' } }), 'inactive location fails')
  assert(!preflightPassed({ ...base, location: { status: 'ACTIVE', currency: 'USD', country: 'US' } }), 'non-yen location fails')
  assert(!preflightPassed({ ...base, location: null }), 'unread location fails')
  assert(!preflightPassed({ ...base, webhook_key: false }), 'missing webhook key fails')
  assert(!preflightPassed({ ...base, location_match: false }), 'location mismatch fails')
  assert(!preflightPassed({ ...base, app_id_family: 'sandbox' }), 'sandbox app id fails')
  assert(!preflightPassed({ ...base, events: { ...base.events, state: 'auth_failed' } }), 'events auth failure fails')
  eq(tokenSecretInUse('production', (n) => n === 'SQUARE_ACCESS_TOKEN'), null, 'F-09: production never falls back to the shared (sandbox) token')
  eq(tokenSecretInUse('sandbox', (n) => n === 'SQUARE_ACCESS_TOKEN'), 'SQUARE_ACCESS_TOKEN', 'sandbox fallback name')
  eq(tokenSecretInUse('production', (n) => n !== 'x'), 'SQUARE_PRODUCTION_ACCESS_TOKEN', 'production name first')
  eq(tokenSecretInUse('sandbox', () => false), null, 'none')
})

Deno.test('D-SQV05 edge: admin only, read-only, writes only its own sync-state row, never a token value', async () => {
  const src = await code('supabase/functions/square-preflight/index.ts')
  assert(src.includes('r.role === "admin"') && src.includes('return jsonResponse({ error: "admin_only" }, 403);'), 'admin only')
  assert(src.includes('square.listLocations(env)') && src.includes('square.searchEvents(env,'), 'locations + events reads')
  assert(!/square\.(create|complete|cancel|refund)/i.test(src), 'no money calls')
  assert(!src.includes('system_settings").update') && !src.includes('set_square_settings'), 'never changes settings')
  const writes = src.match(/\.from\("([a-z_]+)"\)\s*\.(upsert|insert|update)/g) ?? []
  eq(writes.length, 1, 'one write')
  assert(src.includes('key: `preflight:${env}`'), 'its own row')
  assert(!/Deno\.env\.get\([^)]*\)(?!\?\.trim\(\)\.length)/.test(src.replace(/Deno\.env\.get\(n\)\?\.trim\(\)\.length/g, '')), 'token values are only measured, never stored')
  const cfg = await read('supabase/config.toml')
  assert(/\[functions\.square-preflight\]\s*\n\s*verify_jwt = true/.test(cfg), 'verify_jwt = true')
})

// ---------------------------------------------------------------- D-G04 allow-list
Deno.test('D-G04: squareCardAllowed mirrors square_card_allowed()', () => {
  const listed = new Set(['c1'])
  eq(squareCardAllowed({ mode: 'off', audience: 'everyone', listed, customerId: 'c1', customerIsTest: true }), false, 'off')
  eq(squareCardAllowed({ mode: 'test', audience: 'listed', listed, customerId: 'c9', customerIsTest: true }), true, 'test: is_test only')
  eq(squareCardAllowed({ mode: 'test', audience: 'everyone', listed, customerId: 'c1', customerIsTest: false }), false, 'test: list does not matter')
  eq(squareCardAllowed({ mode: 'on', audience: 'listed', listed, customerId: 'c1', customerIsTest: false }), true, 'on + listed')
  eq(squareCardAllowed({ mode: 'on', audience: 'listed', listed, customerId: 'c2', customerIsTest: false }), false, 'on + not listed')
  eq(squareCardAllowed({ mode: 'on', audience: 'listed', listed, customerId: null, customerIsTest: false }), false, 'on + no customer')
  eq(squareCardAllowed({ mode: 'on', audience: 'everyone', listed: new Set(), customerId: 'c2', customerIsTest: false }), true, 'on + everyone')
})

Deno.test('D-G04: audience fails closed to listed; ids parse defensively', () => {
  eq(squareAudienceFrom('everyone'), 'everyone', 'bare')
  eq(squareAudienceFrom('"everyone"'), 'everyone', 'json string')
  for (const v of [null, undefined, '', 'Everyone', 'all', 42, '"listed"']) eq(squareAudienceFrom(v), 'listed', `fail closed: ${JSON.stringify(v)}`)
  eq([...squareCardCustomerIds(['a', 1, 'b'])], ['a', 'b'], 'array, strings only')
  eq([...squareCardCustomerIds('["a"]')], ['a'], 'json text')
  eq([...squareCardCustomerIds('nope')], [], 'garbage → empty')
  eq([...squareCardCustomerIds({ a: 1 })], [], 'object → empty')
})

Deno.test('D-G04: a customer off the list is not offered card (order page + checkout)', () => {
  const offer = {
    mode: 'on' as const, appId: 'sq0idp-abcdefgh', locationId: 'L1', customerIsTest: false,
    order: { currency: 'JPY', status: 'pending', remaining_balance: 1000, source_channel: 'web' }, pendingSubmissions: 0,
  }
  eq(cardNotOfferedReason({ ...offer, cardAllowed: false }), 'not_on_card_list', 'refused')
  assert(cardNotOfferedReason({ ...offer, cardAllowed: true }) !== 'not_on_card_list', 'listed passes this rule')
  assert(cardNotOfferedReason(offer) !== 'not_on_card_list', 'omitted = old behaviour')
  const base = { mode: 'full' as const, currency: 'JPY' as const, country: 'JP', paidyMode: 'off' as const, squareMode: 'on' as const, customerIsTest: false, transferAvailable: true }
  eq(checkoutMethodOptions({ ...base, squareAllowed: false }).card, { available: false, reason: 'off' }, 'checkout says "off"')
  eq(checkoutMethodOptions({ ...base, squareAllowed: true }).card, { available: true, reason: null }, 'listed customer sees card')
})

Deno.test('D-G04 edge: website reads both settings and passes the allow-list to both offers', async () => {
  const src = await code('supabase/functions/website/index.ts')
  assert((src.match(/"square_audience"/g) ?? []).length >= 2 && (src.match(/"square_card_customer_ids"/g) ?? []).length >= 2, 'both readers fetch both keys')
  assert(src.includes('const cardAllowed = squareCardAllowed({') && src.includes('cardUnresolved, cardAllowed,') && src.includes('squareAllowed: squareCardAllowed({'), 'both offers receive the decision')
})

// ---------------------------------------------------------------- Hub settings card
Deno.test('Hub settings card: audience + codes go to set_square_settings; preflight button calls the function', async () => {
  const ui = await read('src/components/settings/SquareSettingsCard.tsx')
  assert(ui.includes('p_audience: v.audience ?? null') && ui.includes('p_card_customer_codes: v.codes ?? null'), 'new setter params')
  assert(ui.includes('supabase.functions.invoke("square-preflight"'), 'preflight call')
  assert(ui.includes('data-testid="square-on-no-preflight"'), 'switching On warns when the preflight has not passed')
})
