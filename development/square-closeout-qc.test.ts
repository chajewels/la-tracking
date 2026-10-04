/**
 * SQUARE CLOSE-OUT QC (2026-10-05, independent review QC05 / QC08 / QC14;
 * docs/SQUARE.md "QC fixes"). Fake database + fake Square (fetch stub) — no
 * network, no database. The SQL half (QC01–QC04, QC10, QC12) is tested on a
 * Postgres copy of the live schema (see the migration header).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-closeout-qc.test.ts
 */
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1'
import { SQUARE_HTTP, square, SquareError } from '../supabase/functions/_shared/square.ts'
import { findPaymentByReference, processSquareEvent, recoverAttempt, syncSquareRefund } from '../supabase/functions/_shared/square-sync.ts'
import { walkStream } from '../supabase/functions/_shared/square-stream.ts'

type Rec = Record<string, unknown>
const REF = 'cja_00112233445566778899aabb'

/** A fake database: square_payments rows by Square id, RPC answers by name (a function may vary per call). */
function fakeDb(opts: { payments?: Record<string, Rec>; attempt?: Rec | null; rpc?: Record<string, (args: Rec) => Rec> } = {}) {
  const calls: { name: string; args: Rec }[] = []
  const payments = opts.payments ?? {}
  const builder = (table: string) => {
    let eqVal: unknown = null
    const q = {
      select: () => q, in: () => q, or: () => q, limit: () => q, order: () => q,
      eq: (_c: string, v: unknown) => { eqVal = v; return q },
      maybeSingle: () => {
        if (table === 'square_payments') return Promise.resolve({ data: payments[String(eqVal)] ?? null, error: null })
        if (table === 'square_card_attempts') return Promise.resolve({ data: opts.attempt ?? null, error: null })
        if (table === 'system_settings') return Promise.resolve({ data: { value: 'test' }, error: null })
        if (table === 'cash_orders') return Promise.resolve({ data: { web_reference: 'CJ-W-1', invoice_number: 'T-1', customer_id: 'c1', customers: { full_name: 'Test' } }, error: null })
        return Promise.resolve({ data: null, error: null })
      },
    }
    return q
  }
  return {
    calls,
    from: (t: string) => builder(t),
    rpc: (name: string, args: Rec) => {
      calls.push({ name, args })
      const f = opts.rpc?.[name]
      return Promise.resolve({ data: f ? f(args) : { ok: true }, error: null })
    },
  }
}

const payment = (over: Rec = {}) => ({
  id: 'sqpay_1', status: 'COMPLETED', amount_money: { amount: 10000, currency: 'JPY' }, location_id: 'L1',
  reference_id: REF, created_at: '2026-10-04T00:00:00Z', ...over,
})
const refund = (over: Rec = {}) => ({ id: 'rf_1', status: 'PENDING', payment_id: 'sqpay_1', amount_money: { amount: 10000, currency: 'JPY' }, ...over })

function withFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>, fn: () => Promise<void>) {
  return async () => {
    Deno.env.set('SQUARE_ACCESS_TOKEN', 'test-token-0123456789abcdef')
    const real = globalThis.fetch
    globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(u), init))) as typeof fetch
    try { await fn() } finally { globalThis.fetch = real; Deno.env.delete('SQUARE_ACCESS_TOKEN') }
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

// ---------------------------------------------------------------- QC05

Deno.test('QC05: refund before its payment — parent is ours → payment filed, then the refund recorded', withFetch(
  (url) => url.includes('/payments/sqpay_1') ? json({ payment: payment({ status: 'APPROVED' }) }) : json({}),
  async () => {
    let refundTries = 0
    let applied = 0
    const db = fakeDb({
      attempt: { id: 'a1', cash_order_id: 'o1', reference: REF, status: 'unknown' },
      rpc: {
        record_square_refund: () => (++refundTries === 1 ? { ok: false, error: 'unknown_payment' } : { ok: true, changed: true }),
        apply_square_payment_state: () => (++applied === 1 ? { ok: false, error: 'unknown_payment' } : { ok: true }),
        file_square_authorization_atomic: () => ({ ok: true, outcome: 'filed' }),
      },
    })
    const r = await syncSquareRefund(db, 'sandbox', refund() as never)
    assertEquals(r.outcome, 'synced')
    assertEquals(refundTries, 2)
    assert(db.calls.some((c) => c.name === 'file_square_authorization_atomic'), 'parent filed before the refund')
  },
))

Deno.test('QC05: refund before its payment — parent not visible yet → quarantined (retried), never ignored', withFetch(
  () => json({ errors: [{ code: 'NOT_FOUND' }] }, 404),
  async () => {
    const db = fakeDb({ rpc: { record_square_refund: () => ({ ok: false, error: 'unknown_payment' }) } })
    assertEquals((await syncSquareRefund(db, 'sandbox', refund() as never)).outcome, 'quarantined')
  },
))

Deno.test('QC05: refund on a payment that is not a Cha Jewels web attempt (e.g. in-person) → ignored', withFetch(
  (url) => url.includes('/payments/sqpay_1') ? json({ payment: payment({ reference_id: 'POS-778' }) }) : json({}),
  async () => {
    const db = fakeDb({ rpc: { record_square_refund: () => ({ ok: false, error: 'unknown_payment' }) } })
    assertEquals((await syncSquareRefund(db, 'sandbox', refund() as never)).outcome, 'ignored_unrelated')
  },
))

Deno.test('QC05: a refund event whose parent cannot be found yet is quarantined in the inbox', withFetch(
  (url) => url.includes('/refunds/rf_1') ? json({ refund: refund() }) : json({ errors: [{ code: 'NOT_FOUND' }] }, 404),
  async () => {
    const db = fakeDb({ rpc: { record_square_refund: () => ({ ok: false, error: 'unknown_payment' }) } })
    const r = await processSquareEvent(db, { type: 'refund.created', event_id: 'e1', data: { object: { refund: { id: 'rf_1', payment_id: 'sqpay_1' } } } })
    assertEquals(r.status, 'quarantined')
  },
))

Deno.test('QC05: a payment event Square cannot show in either environment is quarantined, not ignored', withFetch(
  () => json({ errors: [{ code: 'NOT_FOUND' }] }, 404),
  async () => {
    const db = fakeDb()
    const r = await processSquareEvent(db, { type: 'payment.updated', event_id: 'e2', data: { id: 'sqpay_9' } })
    assertEquals(r.status, 'quarantined')
  },
))

// ---------------------------------------------------------------- QC08

function pagedList(totalPages: number, hitOnPage: number | null) {
  let served = 0
  return (url: string) => {
    if (!url.includes('/payments?')) return json({})
    served++
    const page = served
    const payments = [payment({ id: `other_${page}`, reference_id: 'cja_ffffffffffffffffffffffff' })]
    if (hitOnPage === page) payments.push(payment({ id: 'sqpay_hit', status: 'APPROVED' }))
    return json({ payments, cursor: page < totalPages ? `c${page}` : undefined })
  }
}

Deno.test('QC08: a matching payment on page six is found', withFetch(pagedList(8, 6), async () => {
  const r = await findPaymentByReference('sandbox', 'L1', REF, Date.now() - 60_000)
  assertEquals(r.state, 'found')
}))

Deno.test('QC08: every page read and no match → absent', withFetch(pagedList(3, null), async () => {
  assertEquals((await findPaymentByReference('sandbox', 'L1', REF, Date.now() - 60_000)).state, 'absent')
}))

Deno.test('QC08: page budget exhausted with pages left → incomplete, never absent', withFetch(pagedList(50, null), async () => {
  assertEquals((await findPaymentByReference('sandbox', 'L1', REF, Date.now() - 60_000, 5)).state, 'incomplete')
}))

Deno.test('QC08: an incomplete search never cancels the attempt by key', async () => {
  let cancelCalls = 0
  const handler = (url: string) => {
    if (url.endsWith('/payments/cancel')) { cancelCalls++; return json({}) }
    return pagedList(500, null)(url)
  }
  await withFetch(handler, async () => {
    const db = fakeDb({ rpc: { resolve_square_attempt: () => ({ ok: true }) } })
    const a = { id: 'a1', environment: 'sandbox', location_id: 'L1', reference: REF, idempotency_key: 'k1', status: 'unknown', created_at: new Date(Date.now() - 60 * 60_000).toISOString() }
    const r = await recoverAttempt(db, a, 15 * 60_000, 'reconcile')
    assertEquals(r, 'waiting')
    assertEquals(cancelCalls, 0)
    assertEquals(db.calls.filter((c) => c.name === 'resolve_square_attempt').length, 0)
  })()
})

Deno.test('QC08: a known Square payment id is read directly, no search', async () => {
  let listCalls = 0
  await withFetch((url) => {
    if (url.includes('/payments?')) { listCalls++; return json({ payments: [] }) }
    if (url.includes('/payments/sqpay_known')) return json({ payment: payment({ id: 'sqpay_known', status: 'APPROVED' }) })
    return json({})
  }, async () => {
    const db = fakeDb({ rpc: { apply_square_payment_state: () => ({ ok: true }) } })
    const a = { id: 'a1', environment: 'sandbox', location_id: 'L1', reference: REF, idempotency_key: 'k1', status: 'unknown', square_payment_id: 'sqpay_known', created_at: new Date().toISOString() }
    assertEquals(await recoverAttempt(db, a, 15 * 60_000, 'reconcile'), 'filed')
    assertEquals(listCalls, 0)
  })()
})

// ---------------------------------------------------------------- QC14

Deno.test('QC14: headers then a stalled body is bounded by the deadline and is an ambiguous network error', async () => {
  const before = SQUARE_HTTP.timeoutMs
  SQUARE_HTTP.timeoutMs = 150
  Deno.env.set('SQUARE_ACCESS_TOKEN', 'test-token-0123456789abcdef')
  const real = globalThis.fetch
  let calls = 0
  globalThis.fetch = ((_u: string, init?: RequestInit) => {
    calls++
    const signal = init?.signal
    const body = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('{"payment":'))
        signal?.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')))
      },
    })
    return Promise.resolve(new Response(body, { status: 200 }))
  }) as typeof fetch
  const t0 = Date.now()
  try {
    const err = await square.get('sandbox', 'sqpay_1').then(() => null, (e) => e)
    assert(err instanceof SquareError, 'a SquareError')
    assertEquals(err.code, 'network')
    assertEquals(err.ambiguous, true)
    assertEquals(calls, 3) // retried like any network failure
    assert(Date.now() - t0 < 10_000, 'bounded')
  } finally {
    globalThis.fetch = real
    SQUARE_HTTP.timeoutMs = before
    Deno.env.delete('SQUARE_ACCESS_TOKEN')
  }
})

Deno.test('QC14: a truncated JSON body on 200 is never treated as an answer', withFetch(
  () => new Response('{"payment": {"id": "sqpay_1", "status": "COMP', { status: 200 }),
  async () => {
    await assertRejects(() => square.get('sandbox', 'sqpay_1'))
  },
))

// ---------------------------------------------------------------- QC06 / QC07 (resumable walks)

/** A fake square_sync_state table plus a fake Square list of events at fixed times. */
function streamHarness(eventTimesMs: number[], pageSize = 3) {
  const state: Record<string, Rec> = {}
  const db = {
    from: (_t: string) => {
      let key = ''
      const q = {
        select: () => q,
        eq: (_c: string, v: string) => { key = v; return q },
        maybeSingle: () => Promise.resolve({ data: state[key] ? { value: state[key] } : null, error: null }),
        upsert: (row: { key: string; value: Rec }) => { state[row.key] = structuredClone(row.value); return Promise.resolve({ error: null }) },
      }
      return q
    },
  }
  const fetch = (begin: string, end: string, cursor: string | null) => {
    const b = Date.parse(begin), e = Date.parse(end)
    const inWin = eventTimesMs.filter((t) => t >= b && t < e).sort((x, y) => x - y)
    const offset = cursor ? Number(cursor) : 0
    const items = inWin.slice(offset, offset + pageSize).map((t) => ({ event_id: `ev_${t}`, t }))
    return Promise.resolve({ items, cursor: offset + pageSize < inWin.length ? String(offset + pageSize) : null })
  }
  return { db, state, fetch }
}

Deno.test('QC06: a multi-day outage is caught up across windows and pages, nothing skipped, nothing twice-lost', async () => {
  const now = Date.now()
  const H = 3600_000
  // 40 events spread over the last 3 days; last checkpoint 3 days ago.
  const times = Array.from({ length: 40 }, (_, i) => now - 72 * H + i * 1.7 * H)
  const h = streamHarness(times)
  h.state['events:sandbox'] = { through: new Date(now - 72 * H).toISOString() }
  const seen = new Set<string>()
  const handle = (it: Rec) => { seen.add(String(it.event_id)); return Promise.resolve() }
  const opts = { firstLookbackMs: 2 * H, overlapMs: 5 * 60_000, windowMs: 6 * H, retentionMs: 27 * 24 * H, maxPages: 4, fetch: h.fetch, handle }
  let runs = 0, r
  do { r = await walkStream(h.db, 'events:sandbox', opts); runs++ } while (r.truncated && runs < 50)
  assertEquals(r.truncated, false)
  assert(runs > 1, 'needed several runs (page budget per run)')
  assertEquals(seen.size, 40)
  assert(Date.parse(String(h.state['events:sandbox'].through)) >= now - 1000, 'checkpoint reached now')
})

Deno.test('QC06: an interrupted page write does not move the checkpoint; the next run re-reads that page', async () => {
  const now = Date.now()
  const H = 3600_000
  const times = Array.from({ length: 9 }, (_, i) => now - 60 * 60_000 + i * 60_000)
  const h = streamHarness(times)
  h.state['events:sandbox'] = { through: new Date(now - 2 * H).toISOString() }
  const seen: string[] = []
  let fail = true
  const handle = (it: Rec) => {
    if (fail && String(it.event_id) === `ev_${times[4]}`) { fail = false; return Promise.reject(new Error('db down')) }
    seen.push(String(it.event_id)); return Promise.resolve()
  }
  const opts = { firstLookbackMs: 2 * H, overlapMs: 0, windowMs: 6 * H, maxPages: 10, fetch: h.fetch, handle }
  await assertRejects(() => walkStream(h.db, 'events:sandbox', opts))
  assertEquals(h.state['events:sandbox'].cursor, '3', 'checkpoint stays after the last fully handled page')
  const r = await walkStream(h.db, 'events:sandbox', opts)
  assertEquals(r.truncated, false)
  for (const t of times) assert(seen.includes(`ev_${t}`), `event ${t} handled`)
})

Deno.test('QC06: history older than Square keeps is reported, not silently skipped', async () => {
  const now = Date.now()
  const H = 3600_000
  const h = streamHarness([now - 10 * 60_000])
  h.state['events:sandbox'] = { through: new Date(now - 40 * 24 * H).toISOString() }
  const r = await walkStream(h.db, 'events:sandbox', { firstLookbackMs: 2 * H, overlapMs: 0, windowMs: 30 * 24 * H, retentionMs: 27 * 24 * H, maxPages: 5, fetch: h.fetch, handle: () => Promise.resolve() })
  assert(r.history_gap !== null, 'gap reported')
  assertEquals(r.items, 1)
})

Deno.test('review #3: a slow Square page (over 1 s) does not stop the walk from finishing', async () => {
  const now = Date.now()
  const H = 3600_000
  const h = streamHarness([now - 30 * 60_000, now - 20 * 60_000])
  h.state['events:sandbox'] = { through: new Date(now - 2 * H).toISOString() }
  const slowFetch = async (b: string, e: string, c: string | null) => { await new Promise((r) => setTimeout(r, 1100)); return await h.fetch(b, e, c) }
  const r = await walkStream(h.db, 'events:sandbox', { firstLookbackMs: 2 * H, overlapMs: 5 * 60_000, windowMs: 6 * H, maxPages: 10, fetch: slowFetch, handle: () => Promise.resolve() })
  assertEquals(r.truncated, false)
  assertEquals(r.pages, 1)
})

Deno.test('review #8: a saved cursor Square refuses is dropped and the window re-read', async () => {
  const now = Date.now()
  const H = 3600_000
  const times = [now - 50 * 60_000, now - 40 * 60_000]
  const h = streamHarness(times)
  h.state['events:sandbox'] = { through: new Date(now - 2 * H).toISOString(), window_begin: new Date(now - 2 * H).toISOString(), window_end: new Date(now).toISOString(), cursor: 'stale-cursor' }
  const fetch = (b: string, e: string, c: string | null) => c === 'stale-cursor'
    ? Promise.reject(Object.assign(new Error('bad cursor'), { status: 400 }))
    : h.fetch(b, e, c)
  const seen: string[] = []
  const r = await walkStream(h.db, 'events:sandbox', { firstLookbackMs: 2 * H, overlapMs: 0, windowMs: 6 * H, maxPages: 10, fetch, handle: (it) => { seen.push(String(it.event_id)); return Promise.resolve() } })
  assertEquals(r.truncated, false)
  assertEquals(seen.length, 2)
  assertEquals(h.state['events:sandbox'].cursor, null)
})
