/**
 * SQF03 / SQF04 (Square go-live counter-check, 2026-10-08): the B02 refund-email
 * replay with its database scripted.
 *   SQF03 — a transient DB error while looking up the order ('lookup_error') is
 *           retried; a real 'not_found' stops the replay WITH a bell.
 *   SQF04 — the 3-send cap holds when the give-up bell fails: the send is
 *           claimed on the row before it happens; a refund that used its sends
 *           gets only its bell; the bell is one per (refund, type).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-sqf03-sqf04-replay.test.ts
 */
import { replayRefundEmail, type ReplayBellType, type ReplayDeps, type ReplayRefund } from '../supabase/functions/_shared/refund-email-replay.ts'
import { MAX_REFUND_EMAIL_RESENDS, refundEmailNext } from '../supabase/functions/_shared/square-reconcile-rules.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const code = async (path: string) => (await Deno.readTextFile(new URL(`../supabase/functions/${path}`, import.meta.url))).replace(/^\s*(\*|\/\/).*$/gm, '')

/** A scripted square_refunds row + send log + bell table. */
function world(opts: { sendResults: Array<{ sent: boolean; reason?: string }>; bellFails?: number; stampFails?: number; sentAlready?: boolean }) {
  const row = { email_resends: 0, email_given_up_at: null as string | null, refund_email_replay: true }
  const bells: ReplayBellType[] = []
  const log = { sends: 0, bellAttempts: 0, claims: 0 }
  let bellFails = opts.bellFails ?? 0
  let stampFails = opts.stampFails ?? 0
  const rf = (): ReplayRefund => ({ id: 'row1', square_refund_id: 'rf_1', cash_order_id: 'o1', amount_jpy: 8563, email_resends: row.email_resends })
  const deps: ReplayDeps = {
    alreadySent: async () => opts.sentAlready === true,
    claim: async (_rf, before) => {
      log.claims++
      if (row.email_resends !== before || row.email_given_up_at !== null) return false
      row.email_resends = before + 1
      return true
    },
    send: async () => { log.sends++; return opts.sendResults[Math.min(log.sends - 1, opts.sendResults.length - 1)] },
    bellExists: async (_rf, type) => bells.includes(type),
    ringBell: async (_rf, type) => {
      log.bellAttempts++
      if (bellFails > 0) { bellFails--; throw new Error('staff_notifications insert failed') }
      bells.push(type)
    },
    markDone: async () => { row.refund_email_replay = false },
    stampGivenUp: async () => {
      if (stampFails > 0) { stampFails--; return } // checked() swallows the error: the row simply is not stamped
      row.email_given_up_at = 'now'
    },
  }
  /** One hourly run: the row is eligible while replay is on and not given up. */
  const run = async () => {
    if (!row.refund_email_replay || row.email_given_up_at !== null) return { action: 'not_eligible' as const }
    try { return await replayRefundEmail(rf(), deps) } catch (e) { return { action: 'threw' as const, reason: (e as Error).message } }
  }
  return { row, bells, log, run, deps }
}

Deno.test('SQF03 rule: lookup_error retries, not_found alerts, the deliberate no-sends still stop', () => {
  eq(refundEmailNext({ sent: false, reason: 'lookup_error' }, 0), 'retry', 'a DB error reading the order is transient')
  eq(refundEmailNext({ sent: false, reason: 'lookup_error' }, MAX_REFUND_EMAIL_RESENDS - 1), 'give_up', 'the last allowed try still gives up')
  eq(refundEmailNext({ sent: false, reason: 'not_found' }, 0), 'alert', 'a missing order is an alert, never a silent done')
  eq(refundEmailNext({ sent: false, reason: 'skipped_not_web' }, 0), 'done', 'not a website order still stops')
  eq(refundEmailNext({ sent: true }, 2), 'done', 'sent stops')
})

Deno.test('SQF03 wiring: sendOrderUpdateEmail says lookup_error on a DB error and not_found only on an empty row', async () => {
  const src = await code('_shared/order-update-email.ts')
  assert(src.includes('if (error) return log("lookup_error");'), 'DB error → lookup_error')
  assert(src.includes('if (!row) return log("not_found");'), 'empty row → not_found')
  assert(!src.includes('if (error || !row) return log("not_found")'), 'the conflation is gone')
})

Deno.test('SQF03: first read fails, next succeeds → the email is sent on the second run', async () => {
  const w = world({ sendResults: [{ sent: false, reason: 'lookup_error' }, { sent: true }] })
  eq((await w.run()).action, 'retry', 'run 1 retries')
  eq((await w.run()).action, 'sent', 'run 2 sends')
  eq([w.log.sends, w.row.email_resends, w.row.refund_email_replay, w.bells], [2, 2, false, []], 'two attempts, counted, queue left, no bell')
})

Deno.test('SQF03: a real not_found stops the replay and rings refund_email_order_missing once', async () => {
  const w = world({ sendResults: [{ sent: false, reason: 'not_found' }] })
  eq((await w.run()).action, 'order_missing', 'run 1 alerts')
  eq([w.bells, w.row.refund_email_replay, w.log.sends], [['refund_email_order_missing'], false, 1], 'one bell, out of the queue, one attempt')
  eq((await w.run()).action, 'not_eligible', 'nothing more happens')
})

Deno.test('SQF04: the bell fails for 5 runs → at most 3 sends ever, exactly 1 bell in the end, then stamped given-up', async () => {
  const w = world({ sendResults: [{ sent: false, reason: 'not_sent_error' }], bellFails: 3 })
  const actions: string[] = []
  for (let i = 0; i < 7; i++) actions.push((await w.run()).action)
  eq(actions.slice(0, 2), ['retry', 'retry'], 'two retries')
  eq(actions[2], 'threw', 'run 3: the third send fails and the bell cannot be written (R07: nothing stamped)')
  eq(actions[3], 'threw', 'run 4: NO send — only the bell is tried, and it fails again')
  eq(actions[4], 'threw', 'run 5: still only the bell')
  eq(actions[5], 'given_up', 'run 6: the bell lands, the row is stamped')
  eq(actions[6], 'not_eligible', 'run 7: nothing left to do')
  eq([w.log.sends, w.row.email_resends, w.bells, w.row.email_given_up_at], [MAX_REFUND_EMAIL_RESENDS, MAX_REFUND_EMAIL_RESENDS, ['refund_email_failed'], 'now'],
    `exactly ${MAX_REFUND_EMAIL_RESENDS} sends, one bell, given up (the old code sent again every hour the bell failed)`)
})

Deno.test('SQF04: the stamp fails after the bell → next run rings NO second bell and stamps', async () => {
  const w = world({ sendResults: [{ sent: false, reason: 'error' }], stampFails: 1 })
  await w.run(); await w.run()
  eq((await w.run()).action, 'given_up', 'run 3 gives up: bell written, stamp lost')
  eq([w.bells.length, w.row.email_given_up_at], [1, null], 'one bell, not stamped')
  eq((await w.run()).action, 'given_up', 'run 4: no send, bell found, stamp written')
  eq([w.log.sends, w.bells.length, w.row.email_given_up_at], [3, 1, 'now'], 'still 3 sends and 1 bell')
})

Deno.test('SQF04: the send is claimed BEFORE it happens; a row another runner already claimed is not sent', async () => {
  const w = world({ sendResults: [{ sent: true }] })
  // simulate a concurrent runner: this run READ email_resends = 0, but the row moved on before the claim
  w.row.email_resends = 1
  const stale: ReplayRefund = { id: 'row1', square_refund_id: 'rf_1', cash_order_id: 'o1', amount_jpy: 8563, email_resends: 0 }
  eq((await replayRefundEmail(stale, w.deps)).action, 'not_claimed', 'compare-and-set fails → no send')
  eq([w.log.sends, w.row.email_resends], [0, 1], 'nothing sent, the row is as the other runner left it')
})

Deno.test('SQF04: an email already in the send log leaves the queue without a send', async () => {
  const w = world({ sendResults: [{ sent: true }], sentAlready: true })
  eq((await w.run()).action, 'already_sent', 'proven sent')
  eq([w.log.sends, w.log.claims, w.row.refund_email_replay], [0, 0, false], 'no send, no claim, out of the queue')
})

Deno.test('SQF04 wiring: square-reconcile step 7 runs replayRefundEmail with a compare-and-set claim and a per-refund bell lookup', async () => {
  const src = await code('square-reconcile/index.ts')
  assert(src.includes('await replayRefundEmail(rf, deps)'), 'uses the shared logic')
  assert(/update\(\{ email_resends: resendsBefore \+ 1 \}\)[\s\S]{0,80}?\.eq\("email_resends", resendsBefore\)\.is\("email_given_up_at", null\)/.test(src), 'the claim is a compare-and-set on the value read')
  assert(src.includes('.eq("type", type).eq("metadata->>square_refund_id", rf.square_refund_id)'), 'bell dedupe by (refund id, type)')
  assert(src.includes('"refund_email_failed"') && src.includes('Refund email: order not found'), 'both bell types are written')
  assert(!src.includes('refundEmailNext('), 'the step no longer re-implements the rule inline')
})
