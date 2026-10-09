/**
 * SQUARE L2–L8 (2026-10-09, eighth release). docs/SQUARE.md "L2–L8".
 * Project doc: claude/square-golive-countercheck-2026-10-09-evening.md (the Low items).
 *
 *   L2  disputeOf: a dispute is read like a payment / refund (the one asked for,
 *       positive whole yen); the SQL refuses what still cannot be read (one bell).
 *   L3  refund_jpy never goes down (SQL, migration 20261201120000).
 *   L4  the attempt is locked first in close / apply (SQL).
 *   L5  a capture re-checks the order on a FRESH row (first Confirm and resumed
 *       "Finish recording" alike); the browser balance edit is guarded (SQL + page).
 *   L6  "Mark refund issued — card" capped at the recorded card money; a second
 *       mark for the other part (SQL + dialog mirror, src/test).
 *   L7  a late hold on an attempt already closed is voided automatically, audited,
 *       one bell if Square does not confirm; square-reconcile retries it.
 * The SQL half is proven by development/sql/square-l2-l8-2026-10-09.sql on a copy
 * of the live bodies.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-l2-l8.test.ts
 */
import { assert, assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { disputeOf, SquareError } from '../supabase/functions/_shared/square.ts'
import { disputeMoneyJpy, handleFilingException, isLateHoldReason, syncSquareDispute } from '../supabase/functions/_shared/square-sync.ts'
import { cardCaptureOrderRefusal } from '../supabase/functions/_shared/card-rules.ts'

type Rec = Record<string, unknown>
const code = (p: string) => Deno.readTextFileSync(new URL(p, import.meta.url))
/** Code only: comment lines removed, so an assertion never matches an explanation. */
const codeOnly = (p: string) => code(p).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|--)/.test(l)).join('\n')

const dispute = (over: Rec = {}) => ({
  id: 'dp_1', state: 'EVIDENCE_REQUIRED', reason: 'FRAUD', amount_money: { amount: 8640, currency: 'JPY' },
  disputed_payment: { payment_id: 'sqpay_1' }, ...over,
})

// ---------------------------------------------------------------- L2

Deno.test('L2: disputeOf accepts the dispute asked for, in positive whole yen', () => {
  const d = disputeOf({ dispute: dispute({ amount_money: { amount: '8640', currency: 'jpy' } }) }, { id: 'dp_1', jpy: true })
  assertEquals(d.id, 'dp_1')
  assertEquals(d.amount_money, { amount: 8640, currency: 'JPY' })
  // Square's older shape carries dispute_id only.
  assertEquals(disputeOf({ dispute: dispute({ id: undefined, dispute_id: 'dp_2' }) }).id, 'dp_2')
})

Deno.test('L2: disputeOf refuses what the Hub cannot read (bad answer, never ¥0 or "the whole payment")', () => {
  const bad = (j: Rec, e: Rec = { id: 'dp_1', jpy: true }) => assertThrows(() => disputeOf(j, e), SquareError)
  bad({})
  bad({ dispute: null })
  bad({ dispute: dispute({ id: 'dp_other' }) })
  bad({ dispute: dispute({ id: '', dispute_id: '' }) })
  bad({ dispute: dispute({ state: '' }) })
  bad({ dispute: dispute({ disputed_payment: {} }) })
  bad({ dispute: dispute({ amount_money: undefined }) })
  bad({ dispute: dispute({ amount_money: { amount: 0, currency: 'JPY' } }) })
  bad({ dispute: dispute({ amount_money: { amount: 86.4, currency: 'JPY' } }) })
  bad({ dispute: dispute({ amount_money: { amount: null, currency: 'JPY' } }) })
  bad({ dispute: dispute({ amount_money: { amount: 100, currency: 'USD' } }) })
  // Without the yen expectation the currency is left to the SQL (bad_currency + bell).
  assertEquals(disputeOf({ dispute: dispute({ amount_money: { amount: 100, currency: 'USD' } }) }).amount_money?.currency, 'USD')
  try { disputeOf({}) } catch (e) { assertEquals((e as SquareError).code, 'square_bad_response'); assert((e as SquareError).ambiguous, 'read again, never acted on') }
})

Deno.test('L2: the figure passed to record_square_dispute is the read one, else null (never 0)', async () => {
  assertEquals(disputeMoneyJpy(dispute() as never), 8640)
  assertEquals(disputeMoneyJpy(dispute({ amount_money: undefined }) as never), null)
  assertEquals(disputeMoneyJpy(dispute({ amount_money: { amount: 0, currency: 'JPY' } }) as never), null)
  assertEquals(disputeMoneyJpy(dispute({ amount_money: { amount: true, currency: 'JPY' } }) as never), null)
  const calls: Rec[] = []
  const db = { rpc: (_n: string, a: Rec) => { calls.push(a); return Promise.resolve({ data: { ok: false, error: 'bad_currency' }, error: null }) } }
  const r = await syncSquareDispute(db, dispute({ amount_money: { amount: 100, currency: 'USD' } }) as never, 'sandbox')
  assertEquals(r, { outcome: 'failed', detail: 'bad_currency' })
  assertEquals(calls[0].p_amount_jpy, 100)
})

Deno.test('L2 edge: GetDispute goes through disputeOf (the one asked for, yen)', () => {
  const src = codeOnly('../supabase/functions/_shared/square.ts')
  assert(src.includes('return disputeOf(json, { id, jpy: true });'), 'getDispute validated')
  assert(!src.includes('return json.dispute as SquareDispute;'), 'no unchecked cast left')
})

// ---------------------------------------------------------------- L5

Deno.test('L5: a capture is refused on a fresh order row that can no longer take the money', () => {
  assertEquals(cardCaptureOrderRefusal({ status: 'pending', remaining_balance: 10000 }, 10000), null)
  assertEquals(cardCaptureOrderRefusal({ status: 'pending', remaining_balance: '10000.00' }, '10000'), null)
  assertEquals(cardCaptureOrderRefusal({ status: 'pending', remaining_balance: 5000 }, 10000), 'exceeds_remaining')
  assertEquals(cardCaptureOrderRefusal({ status: 'pending', remaining_balance: 0 }, 10000), 'exceeds_remaining')
  assertEquals(cardCaptureOrderRefusal({ status: 'pending', remaining_balance: null }, 10000), 'exceeds_remaining')
  assertEquals(cardCaptureOrderRefusal({ status: 'cancelled', remaining_balance: 10000 }, 10000), 'order_closed')
  assertEquals(cardCaptureOrderRefusal({ status: 'expired', remaining_balance: 10000 }, 10000), 'order_closed')
  assertEquals(cardCaptureOrderRefusal(null, 10000), 'order_closed')
})

Deno.test('L5 edge: review-payment-submission re-checks the order before square.complete, resumed or not', () => {
  const src = codeOnly('../supabase/functions/review-payment-submission/index.ts')
  const check = src.indexOf('cardCaptureOrderRefusal(freshOrder, submission.submitted_amount)')
  const capture = src.indexOf('live = await square.complete(env, sp.square_payment_id')
  assert(check > 0 && capture > 0 && check < capture, 'the fresh-order check comes before the capture')
  assert(src.includes('.from("cash_orders").select("status, remaining_balance").eq("id", cashOrder.id).maybeSingle();'), 'a fresh read, not the step-1 row')
  const block = src.slice(check, capture)
  assert(!/if \(!resuming[^)]*\)\s*\{?\s*const orderRefusal/.test(block), 'not skipped for a resumed Finish recording')
  assert(block.includes('.update({ status: "submitted", processing_started_at: null'), 'a resumed claim goes back to the queue (nothing captured)')
  assert(block.includes('.eq("processing_started_at", claimAt)'), 'only while this Confirm still holds the claim')
})

Deno.test('L5 page: Manage Invoice writes the balance only when the total changes', () => {
  const src = codeOnly('../src/pages/CashOrderDetail.tsx')
  assert(/if \(!totalChanged\) \{\s*delete updatePayload\.total_amount;\s*delete updatePayload\.remaining_balance;/.test(src), 'balance stripped when the total is unchanged')
})

// ---------------------------------------------------------------- L7

Deno.test('L7: a late hold is an attempt_* reason, nothing else', () => {
  for (const r of ['attempt_cancelled', 'attempt_declined', 'attempt_risk_cancelled', 'attempt_mismatch', 'attempt_failed']) assert(isLateHoldReason(r), r)
  for (const r of ['paidy_in_progress', 'balance_changed', 'order_cancelled', 'other_hold_active', 'submission_pending', 'attempt_', '', null, undefined, 5]) assert(!isLateHoldReason(r), String(r))
})

function fakeDb(opts: { seenBell?: boolean } = {}) {
  const calls: { kind: string; table?: string; name?: string; args: unknown }[] = []
  const builder = (table: string) => {
    const q: Rec = {}
    Object.assign(q, {
      select: () => q, eq: () => q, order: () => q, in: () => q, or: () => q,
      limit: () => Promise.resolve({ data: table === 'staff_notifications' && opts.seenBell ? [{ id: 'n1' }] : [], error: null }),
      maybeSingle: () => Promise.resolve({ data: table === 'cash_orders' ? { customer_id: 'c1', invoice_number: '9001', web_reference: 'CJ-W-9001' } : null, error: null }),
      insert: (row: unknown) => { calls.push({ kind: 'insert', table, args: row }); return Promise.resolve({ error: null }) },
    })
    return q
  }
  return {
    calls,
    from: (t: string) => builder(t),
    rpc: (name: string, args: Rec) => { calls.push({ kind: 'rpc', name, args }); return Promise.resolve({ data: { ok: true }, error: null }) },
  }
}
const attempt = { id: 'a1', cash_order_id: 'o1', customer_id: 'c1', reference: 'cja_00112233445566778899aabb', test: true }
const held = { id: 'sqpay_9', status: 'APPROVED', amount_money: { amount: 15000, currency: 'JPY' }, location_id: 'L1', created_at: '2026-10-09T00:00:00Z' }
const filed = { ok: true, outcome: 'exception', filed: false, exception: 'unfiled_hold', reason: 'attempt_cancelled', square_row_id: 'row9' }

function withFetch(handler: (url: string, init?: RequestInit) => Response, fn: () => Promise<void>) {
  return async () => {
    Deno.env.set('SQUARE_ACCESS_TOKEN', 'test-token-0123456789abcdef')
    const real = globalThis.fetch
    globalThis.fetch = ((u: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(u), init))) as typeof fetch
    try { await fn() } finally { globalThis.fetch = real; Deno.env.delete('SQUARE_ACCESS_TOKEN') }
  }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

Deno.test('L7: a late hold is voided at filing, audited, the void applied as "void"', withFetch(
  (url, init) => url.endsWith('/payments/sqpay_9/cancel') && init?.method === 'POST' ? json({ payment: { ...held, status: 'CANCELED' } })
    : url.includes('/payments/sqpay_9') ? json({ payment: { ...held, status: 'CANCELED' } }) : json({}, 404),
  async () => {
    const db = fakeDb()
    const action = await handleFilingException(db, 'sandbox', attempt, held as never, filed)
    assertEquals(action, 'late_hold_voided')
    const apply = db.calls.find((c) => c.name === 'apply_square_payment_state')
    assertEquals((apply?.args as Rec).p_source, 'void')
    assertEquals((apply?.args as Rec).p_provider_status, 'CANCELED')
    const audit = db.calls.find((c) => c.kind === 'insert' && c.table === 'audit_logs')
    assertEquals((audit?.args as Rec).action, 'square_late_hold_auto_voided')
    assert(!db.calls.some((c) => c.kind === 'insert' && c.table === 'staff_notifications'), 'no failure bell when the void worked')
  },
))

Deno.test('L7: Square does not confirm the void → ONE card_void_failed bell, nothing claimed voided', withFetch(
  (url, init) => url.endsWith('/payments/sqpay_9/cancel') && init?.method === 'POST' ? json({ errors: [{ code: 'BAD_REQUEST', category: 'INVALID_REQUEST_ERROR' }] }, 400)
    : url.includes('/payments/sqpay_9') ? json({ payment: held }) : json({}, 404),
  async () => {
    const db = fakeDb()
    assertEquals(await handleFilingException(db, 'sandbox', attempt, held as never, filed), 'late_hold_void_pending')
    const bells = db.calls.filter((c) => c.kind === 'insert' && c.table === 'staff_notifications')
    assertEquals(bells.length, 1)
    const b = bells[0].args as Rec
    assertEquals(b.type, 'card_void_failed')
    assertEquals((b.metadata as Rec).source, 'late_hold')
    assertEquals((b.metadata as Rec).square_payment_id, 'sqpay_9')
    assert(!db.calls.some((c) => c.kind === 'insert' && c.table === 'audit_logs'), 'no "voided" audit without Square proof')
    const again = fakeDb({ seenBell: true })
    assertEquals(await handleFilingException(again, 'sandbox', attempt, held as never, filed), 'late_hold_void_pending')
    assert(!again.calls.some((c) => c.kind === 'insert' && c.table === 'staff_notifications'), 'never a second bell for the same hold')
  },
))

Deno.test('L7: other unfiled holds are still left to staff (no automatic void)', withFetch(
  () => json({}, 500),
  async () => {
    const db = fakeDb()
    assertEquals(await handleFilingException(db, 'sandbox', attempt, held as never, { ...filed, reason: 'balance_changed' }), 'unfiled_hold')
    assertEquals(db.calls.length, 0)
  },
))

Deno.test('L7 edge: square-reconcile retries the void of a late hold; the website answers the hold state', () => {
  const rec = codeOnly('../supabase/functions/square-reconcile/index.ts')
  assert(rec.includes('const lateHold = row.exception === "unfiled_hold" && isLateHoldReason(row.exception_note) && row.exception_resolved_at == null;'), 'late hold detected on the row')
  assert(rec.includes('|| paidyConflict || lateHold)) {'), 'retried with the other voids')
  const web = codeOnly('../supabase/functions/website/index.ts')
  assert(web.includes('hold: action === "late_hold_voided" ? "voided" : "void_pending"'), 'the website reports voided / void_pending')
})

// ---------------------------------------------------------------- migration

Deno.test('L2–L8 migration: md5-guarded patches from live, new objects re-granted, self-checked', () => {
  const m = code('../supabase/migrations/20261201120000_square_l2_l8.sql')
  const guards: [string, string][] = [
    ['public.apply_square_payment_state(', 'eeed3c3ed1ba50d30c26dcb90606e252'],
    ['public.close_square_attempt_atomic(uuid,text)', '706dca83c7f28da36ca00fbf80ea578e'],
    ['public.record_square_dispute(', '1fe4414de85e291a25adb50b65df0115'],
    ['public.file_square_authorization_atomic(', 'a38f0098901621b0e049f4a80042dd17'],
    ['public.mark_web_order_refund_issued_atomic(', 'd31a247c532e2c741d4fae702fd05cf5'],
  ]
  for (const [sig, md5] of guards) assert(new RegExp(`cj_patch\\('${sig.replace(/[().]/g, '\\$&')}[^']*', '${md5}'`).test(m), `${sig} guarded by its live md5`)
  assert(m.includes('refund_jpy = greatest(coalesce(p_refunded_jpy, 0), coalesce(refund_jpy, 0), 0),'), 'L3')
  assert(m.includes("'card_dispute_unrecorded', 'Square dispute NOT recorded — needs a look'"), 'L2 bell')
  assert(m.includes('REVOKE ALL ON FUNCTION public.square_order_card_refund_recordable_jpy(uuid) FROM PUBLIC, anon, authenticated;'), 'L6 helper revoked')
  assert(m.includes('REVOKE ALL ON FUNCTION public.guard_cash_order_balance_during_hold() FROM PUBLIC, anon, authenticated;'), 'L5 trigger fn revoked')
  assert(m.includes('BEFORE UPDATE OF remaining_balance ON public.cash_orders'), 'L5 trigger')
  assert(m.includes('DO $self$'), 'self-check')
  for (const block of m.split("jsonb_build_object('old', ").slice(1)) {
    const text = block.split('));')[0]
    assert(!/^\s*--/m.test(text), 'no comment line inside a patch (Lovable drops them)')
  }
})
