/**
 * SQUARE INTEGRITY (2026-10-04, docs/SQUARE-INTEGRITY.md, review SQ01–SQ23).
 *
 * Pins the pure pieces of the Square client (error classification, the
 * CreatePayment body, per-environment secrets, both webhook keys, backoff) and
 * the sync decisions in _shared/square-sync.ts against a fake database and a
 * fake Square (fetch stub) — no network, no database.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-integrity.test.ts
 */
import { assert, assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1'
import {
  accessTokenNames, backoffMs, buyerEmailOf, createPaymentBody, hmacSha256Base64, square, SquareError, squareErrorKind, verifySquareSignature,
} from '../supabase/functions/_shared/square.ts'
import { eventObjectId, processSquareEvent, syncSquarePayment } from '../supabase/functions/_shared/square-sync.ts'

// ---------------------------------------------------------------- client

Deno.test('error kinds: only a card refusal or a 4xx client error proves Square did not act (SQ06/SQ23)', () => {
  assertEquals(squareErrorKind(402, 'PAYMENT_METHOD_ERROR', 'CARD_DECLINED'), 'card_refusal')
  assertEquals(squareErrorKind(400, 'INVALID_REQUEST_ERROR', 'CARD_TOKEN_USED'), 'client')
  assertEquals(squareErrorKind(401, 'AUTHENTICATION_ERROR', 'UNAUTHORIZED'), 'auth')
  assertEquals(squareErrorKind(429, 'RATE_LIMIT_ERROR', 'RATE_LIMITED'), 'rate_limited')
  assertEquals(squareErrorKind(500, 'API_ERROR', 'INTERNAL_SERVER_ERROR'), 'ambiguous')
  assertEquals(squareErrorKind(0, '', 'network'), 'ambiguous')
  assertEquals(squareErrorKind(502, '', 'square_bad_response'), 'ambiguous')
  assertEquals(new SquareError(503, 'X', 'x').ambiguous, true)
  assertEquals(new SquareError(429, 'RATE_LIMITED', 'x').ambiguous, true)
  assertEquals(new SquareError(402, 'CARD_DECLINED', 'x', 'PAYMENT_METHOD_ERROR').ambiguous, false)
})

Deno.test('CreatePayment body: exact integer yen, hold only, attempt reference, cardholder billing (SQ12/SQ17)', () => {
  const b = createPaymentBody({
    env: 'sandbox', sourceId: 'cnon:abc', amountJpy: 24980, locationId: 'L1', idempotencyKey: 'cj-card-x',
    referenceId: 'cja_0011223344556677', note: 'CJ-W-900063 · TEST-900063',
    billing: { first_name: 'Yamada Taro', country: 'JP', postal_code: '', address_line_1: '1-2-3 Ginza' },
  })
  assertEquals(b.amount_money, { amount: 24980, currency: 'JPY' })
  assertEquals(b.autocomplete, false)
  assertEquals(b.delay_action, 'CANCEL')
  assertEquals(b.reference_id, 'cja_0011223344556677')
  assertEquals(b.customer_details, { customer_initiated: true, seller_keyed_in: false })
  assertEquals(b.billing_address, { first_name: 'Yamada Taro', country: 'JP', address_line_1: '1-2-3 Ginza' })
  assertEquals('buyer_email_address' in b, false)
  for (const bad of [24979.5, 0, -1, Number.NaN, 2 ** 60]) {
    assertThrows(() => createPaymentBody({ env: 'sandbox', sourceId: 's', amountJpy: bad, locationId: 'L', idempotencyKey: 'k', referenceId: 'r', note: '' }))
  }
})

Deno.test('per-environment secrets with fallback (SQ21; owner: sandbox keys unchanged)', () => {
  assertEquals(accessTokenNames('production'), ['SQUARE_PRODUCTION_ACCESS_TOKEN'])
  assertEquals(accessTokenNames('sandbox'), ['SQUARE_SANDBOX_ACCESS_TOKEN', 'SQUARE_ACCESS_TOKEN'])
})

Deno.test('webhook: either configured signature key verifies; none configured fails closed', async () => {
  const url = 'https://example.test/square-webhook'
  const body = '{"event_id":"e1"}'
  Deno.env.set('SQUARE_WEBHOOK_SIGNATURE_KEY', 'sandbox-key-0123456789')
  Deno.env.set('SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY', 'production-key-0123456789')
  assert(await verifySquareSignature(url, body, await hmacSha256Base64('sandbox-key-0123456789', url + body)))
  assert(await verifySquareSignature(url, body, await hmacSha256Base64('production-key-0123456789', url + body)))
  assertEquals(await verifySquareSignature(url, body, await hmacSha256Base64('other', url + body)), false)
  Deno.env.delete('SQUARE_WEBHOOK_SIGNATURE_KEY')
  Deno.env.delete('SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY')
  assertEquals(await verifySquareSignature(url, body, await hmacSha256Base64('sandbox-key-0123456789', url + body)), false)
})

Deno.test('backoff is bounded and jittered', () => {
  assertEquals(backoffMs(0, 0), 300)
  assertEquals(backoffMs(0, 1), 500)
  assertEquals(backoffMs(1, 0.5), 1200)
})

Deno.test('eventObjectId: payment / refund / dispute ids from Square payloads', () => {
  assertEquals(eventObjectId({ type: 'payment.updated', data: { id: 'p1', object: { payment: { id: 'p1' } } } }), { kind: 'payment', id: 'p1' })
  assertEquals(eventObjectId({ type: 'refund.updated', data: { object: { refund: { id: 'r1' } } } }), { kind: 'refund', id: 'r1' })
  assertEquals(eventObjectId({ type: 'dispute.state.updated', data: { object: { dispute: { id: 'd1' } } } }), { kind: 'dispute', id: 'd1' })
  assertEquals(eventObjectId({ type: 'oauth.authorization.revoked', data: {} }), { kind: 'other', id: null })
})

// ---------------------------------------------------------------- sync (fake db + fake Square)

type Rec = Record<string, unknown>
function fakeDb(opts: { applyResult?: Rec; attempt?: Rec | null; rpcResults?: Record<string, Rec> }) {
  const calls: { name: string; args: Rec }[] = []
  const tableRows: Record<string, Rec | null> = {
    square_card_attempts: opts.attempt ?? null,
    square_payments: null,
    system_settings: { value: 'test' },
    cash_orders: { web_reference: 'CJ-W-1', invoice_number: 'T-1', customer_id: 'c1', customers: { full_name: 'Test Customer' } },
  }
  const builder = (table: string) => {
    const q = {
      select: () => q, eq: () => q, in: () => q, or: () => q, limit: () => q, order: () => q,
      maybeSingle: () => Promise.resolve({ data: tableRows[table] ?? null, error: null }),
    }
    return q
  }
  return {
    calls,
    from: (t: string) => builder(t),
    rpc: (name: string, args: Rec) => {
      calls.push({ name, args })
      if (name === 'apply_square_payment_state') return Promise.resolve({ data: opts.applyResult ?? { ok: false, error: 'unknown_payment' }, error: null })
      return Promise.resolve({ data: opts.rpcResults?.[name] ?? { ok: true }, error: null })
    },
  }
}
const pay = (over: Rec = {}) => ({
  id: 'sqpay_1', status: 'APPROVED', amount_money: { amount: 24980, currency: 'JPY' }, location_id: 'L1',
  reference_id: 'cja_00112233445566778899aabb', created_at: '2026-10-04T00:00:00Z', ...over,
}) as never

Deno.test('sync: a known payment is applied (provider truth, one RPC)', async () => {
  const db = fakeDb({ applyResult: { ok: true, changed: true } })
  assertEquals((await syncSquarePayment(db, 'sandbox', pay(), 'webhook')).outcome, 'synced')
  assertEquals(db.calls.map((c) => c.name), ['apply_square_payment_state'])
})

Deno.test('sync: a payment without a Cha Jewels reference is never allocated (seller/POS payment)', async () => {
  const db = fakeDb({})
  assertEquals((await syncSquarePayment(db, 'sandbox', pay({ reference_id: 'INV-123' }), 'webhook')).outcome, 'ignored_unrelated')
})

Deno.test('sync: our reference with no attempt yet is quarantined for retry (SQ03)', async () => {
  const db = fakeDb({ attempt: null })
  assertEquals((await syncSquarePayment(db, 'sandbox', pay(), 'webhook')).outcome, 'quarantined')
})

Deno.test('sync: an APPROVED payment whose create answer was lost is filed for its attempt (SQ03/SQ04)', async () => {
  const db = fakeDb({ attempt: { id: 'a1', cash_order_id: 'o1', reference: 'cja_00112233445566778899aabb', status: 'unknown' }, rpcResults: { file_square_authorization_atomic: { ok: true, outcome: 'filed', filed: true } } })
  assertEquals((await syncSquarePayment(db, 'sandbox', pay(), 'reconcile')).outcome, 'filed')
  const file = db.calls.find((c) => c.name === 'file_square_authorization_atomic')!
  assertEquals(file.args.p_attempt_id, 'a1')
  assertEquals(file.args.p_amount_jpy, 24980)
  assertEquals(file.args.p_reference_label, 'CJ-W-1')
})

Deno.test('sync: a FAILED payment resolves its attempt as declined and the fraud rule cancels the invoice', async () => {
  const db = fakeDb({
    attempt: { id: 'a1', cash_order_id: 'o1', reference: 'cja_00112233445566778899aabb', status: 'reserved' },
    rpcResults: { resolve_square_attempt: { ok: true, fraud: 'order_refusals', counts: {} }, square_fraud_cancel: { ok: true } },
  })
  assertEquals((await syncSquarePayment(db, 'sandbox', pay({ status: 'FAILED' }), 'webhook')).outcome, 'attempt_resolved')
  assertEquals(db.calls.map((c) => c.name), ['apply_square_payment_state', 'resolve_square_attempt', 'square_fraud_cancel'])
  assertEquals(db.calls[1].args.p_status, 'declined')
})

Deno.test('sync: a failed database write is an error, never "synced" (SQ02)', async () => {
  const db = fakeDb({})
  db.rpc = () => Promise.resolve({ data: null, error: { message: 'connection reset' } }) as never
  await assertRejects(() => syncSquarePayment(db, 'sandbox', pay(), 'webhook'))
})

Deno.test('event processing: Square unreachable → failed (retried), not done (SQ01)', async () => {
  Deno.env.set('SQUARE_ACCESS_TOKEN', 'test-token-0123456789abcdef')
  const realFetch = globalThis.fetch
  let n = 0
  globalThis.fetch = (() => { n++; return Promise.resolve(new Response('{"errors":[{"code":"INTERNAL_SERVER_ERROR"}]}', { status: 500 })) }) as typeof fetch
  try {
    const db = fakeDb({})
    const r = await processSquareEvent(db, { type: 'payment.updated', event_id: 'e1', data: { id: 'sqpay_1', object: { payment: { id: 'sqpay_1' } } } })
    assertEquals(r.status, 'failed')
    assertEquals(n, 3) // first try + 2 retries
  } finally {
    globalThis.fetch = realFetch
    Deno.env.delete('SQUARE_ACCESS_TOKEN')
  }
})

Deno.test('event processing: a payment read back from Square is synced through the attempt', async () => {
  Deno.env.set('SQUARE_ACCESS_TOKEN', 'test-token-0123456789abcdef')
  const realFetch = globalThis.fetch
  globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ payment: pay({ status: 'CANCELED' }) }), { status: 200 }))) as typeof fetch
  try {
    const db = fakeDb({ attempt: { id: 'a1', cash_order_id: 'o1', reference: 'cja_00112233445566778899aabb', status: 'cancelling' }, rpcResults: { resolve_square_attempt: { ok: true } } })
    const r = await processSquareEvent(db, { type: 'payment.updated', event_id: 'e2', data: { id: 'sqpay_1' } })
    assertEquals(r, { status: 'done', outcome: 'attempt_resolved' })
    assertEquals(db.calls.find((c) => c.name === 'resolve_square_attempt')!.args.p_status, 'cancelled')
  } finally {
    globalThis.fetch = realFetch
    Deno.env.delete('SQUARE_ACCESS_TOKEN')
  }
})

// ---------------------------------------------------------------- docs-gap review (2026-10-05)

function withFetchSeq(responses: Array<() => Response | Promise<Response>>, fn: (calls: string[]) => Promise<void>) {
  return async () => {
    Deno.env.set('SQUARE_ACCESS_TOKEN', 'test-token-0123456789abcdef')
    const real = globalThis.fetch
    const calls: string[] = []
    let i = 0
    globalThis.fetch = ((u: string | URL | Request) => {
      calls.push(String(u))
      const next = responses[Math.min(i++, responses.length - 1)]
      return Promise.resolve().then(next)
    }) as typeof fetch
    try { await fn(calls) } finally { globalThis.fetch = real; Deno.env.delete('SQUARE_ACCESS_TOKEN') }
  }
}
const sqErr = (status: number, category: string, code: string) =>
  () => new Response(JSON.stringify({ errors: [{ category, code, detail: code }] }), { status })
const netDown = () => { throw new TypeError('connection reset') }
const createInput = { env: 'sandbox' as const, sourceId: 'cnon:x', amountJpy: 8640, locationId: 'L1', idempotencyKey: 'cj-card-k', referenceId: 'cja_00', note: 'n' }

Deno.test('HUB-1: CreatePayment lost on the network, then 4xx on the same-key retry → ambiguous (attempt stays unknown)', withFetchSeq(
  [netDown, sqErr(400, 'INVALID_REQUEST_ERROR', 'IDEMPOTENCY_KEY_REUSED')],
  async (calls) => {
    const e = await assertRejects(() => square.create(createInput)) as SquareError
    assertEquals(calls.length, 2)
    assertEquals(e.kind, 'ambiguous')
    assertEquals(e.isCardRefusal, false)
    assertEquals(e.code, 'ambiguous_then_IDEMPOTENCY_KEY_REUSED')
  },
))

Deno.test('HUB-1: a 5xx then a card decline on the retry is ambiguous too (never "nothing was created")', withFetchSeq(
  [sqErr(503, 'API_ERROR', 'SERVICE_UNAVAILABLE'), sqErr(402, 'PAYMENT_METHOD_ERROR', 'CARD_DECLINED')],
  async () => {
    const e = await assertRejects(() => square.create(createInput)) as SquareError
    assertEquals(e.kind, 'ambiguous')
    assertEquals(e.isCardRefusal, false)
  },
))

Deno.test('HUB-1: a first-try 4xx is unchanged (client / card refusal prove Square did not act)', withFetchSeq(
  [sqErr(402, 'PAYMENT_METHOD_ERROR', 'CARD_DECLINED')],
  async (calls) => {
    const e = await assertRejects(() => square.create(createInput)) as SquareError
    assertEquals(calls.length, 1)
    assertEquals(e.kind, 'card_refusal')
  },
))

Deno.test('HUB-1: reads are unaffected — a 404 after a lost GET is still a 404', withFetchSeq(
  [netDown, sqErr(404, 'INVALID_REQUEST_ERROR', 'NOT_FOUND')],
  async () => {
    const e = await assertRejects(() => square.get('sandbox', 'sqpay_x')) as SquareError
    assertEquals(e.status, 404)
    assertEquals(e.kind, 'client')
  },
))

Deno.test('HUB-1: Cancel after a lost answer then a 4xx is ambiguous (callers read Square back)', withFetchSeq(
  [netDown, sqErr(400, 'INVALID_REQUEST_ERROR', 'BAD_REQUEST')],
  async () => {
    const e = await assertRejects(() => square.cancel('sandbox', 'sqpay_x')) as SquareError
    assertEquals(e.kind, 'ambiguous')
  },
))

Deno.test('HUB-4: buyer_email_address is sent only for a plain address', () => {
  const b = createPaymentBody({ ...createInput, buyerEmail: '  hanako@example.jp ' })
  assertEquals(b.buyer_email_address, 'hanako@example.jp')
  for (const bad of [null, undefined, '', 'not-an-email', 'a@b', 'x'.repeat(250) + '@example.jp']) {
    assertEquals('buyer_email_address' in createPaymentBody({ ...createInput, buyerEmail: bad as string | null }), false)
  }
  assertEquals(buyerEmailOf('a@b.co'), 'a@b.co')
})
