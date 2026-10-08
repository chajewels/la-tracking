/**
 * SQUARE QA 2026-10-08 — S01 / S02 / S03 / B01 / B02 and the cancellation
 * store-credit rule, edge side (owner plan v2, project doc
 * claude/square-s01-s05-plan-2026-10-08.md). The SQL side is
 * development/sql/square-qa-refunds-credit-acceptance.sql.
 *
 * Pure rules (_shared/square-reconcile-rules.ts), the cancellation email's
 * credit line (both languages, with and without the 30% charge), and the
 * wiring: each change is checked in its source with comments stripped, so a
 * removed call fails here.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-qa-reconcile.test.ts
 */
import * as React from 'npm:react@18.3.1'
import { renderEmail } from '../supabase/functions/_shared/render-email.ts'
import { OrderCancelledEmail } from '../supabase/functions/_shared/email-templates/order-cancelled.tsx'
import {
  attemptStuckThisRun, discoveryEnvironments, MAX_REFUND_EMAIL_RESENDS, refundEmailNext, refundReceivedKey,
} from '../supabase/functions/_shared/square-reconcile-rules.ts'
import { terminateRefusalMessage } from '../supabase/functions/_shared/terminate-refusals.ts'
import { refundIssuedRefusal } from '../supabase/functions/_shared/refund-issued-rules.ts'

const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg) }
const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const fn = (path: string) => Deno.readTextFile(new URL(`../supabase/functions/${path}`, import.meta.url))
const code = async (path: string) => (await fn(path)).replace(/^\s*(\*|\/\/).*$/gm, '')
const both = async (e: React.ReactElement) => (await renderEmail(e)) + '\n' + (await renderEmail(e, { plainText: true }))

// ───────────────────────────────────────────── S02 environments

Deno.test('S02: the current environment plus every environment with watched rows', () => {
  eq(discoveryEnvironments('sandbox', []), ['sandbox'], 'mode test, nothing else')
  eq(discoveryEnvironments(null, []), [], 'mode off, nothing to watch')
  eq(discoveryEnvironments(null, [{ environment: 'sandbox' }]), ['sandbox'], 'mode off still watches sandbox rows')
  eq(discoveryEnvironments('production', [{ environment: 'sandbox' }, { environment: 'production' }]), ['production', 'sandbox'], 'after go-live the old sandbox rows are still watched')
  eq(discoveryEnvironments(null, [{ environment: null, test: false }, { environment: null, test: true }]), ['production', 'sandbox'], 'legacy rows: environment from the test flag')
  eq(discoveryEnvironments(null, [{ environment: 'nonsense', test: null }]), [], 'an unknown environment is ignored')
})

// ───────────────────────────────────────────── S01 stuck attempt

Deno.test('S01: only an open attempt past its give-up time that could not be settled counts', () => {
  const now = Date.parse('2026-10-08T12:00:00Z')
  const old = { status: 'unknown', created_at: '2026-10-08T11:00:00Z' }
  const young = { status: 'reserved', created_at: '2026-10-08T11:50:00Z' }
  const GIVE_UP = 15 * 60 * 1000
  assert(attemptStuckThisRun(old, 'waiting', now, GIVE_UP), 'an hour-old unsettled attempt counts')
  assert(!attemptStuckThisRun(young, 'waiting', now, GIVE_UP), 'a 10-minute-old attempt does not')
  assert(!attemptStuckThisRun(old, 'filed', now, GIVE_UP), 'a settled attempt does not')
  assert(!attemptStuckThisRun({ ...old, status: 'cancelling' }, 'waiting', now, GIVE_UP), 'an attempt being cancelled does not')
})

// ───────────────────────────────────────────── B02 refund email replay

Deno.test('B02: the replay uses the same key square-sync used, so it is never sent twice', async () => {
  eq(refundReceivedKey('rf_1'), 'refund-received-square-rf_1', 'key')
  const sync = await code('_shared/square-sync.ts')
  assert(sync.includes('idempotencyKey: `refund-received-square-${refund.id}`'), 'square-sync still sends with refund-received-square-<id>')
})

Deno.test('B02: sent or a deliberate no-send stops; a transient failure retries; the 3rd failure gives up', () => {
  eq(refundEmailNext({ sent: true }, 0), 'done', 'sent')
  eq(refundEmailNext({ sent: false, reason: 'skipped_not_web' }, 0), 'done', 'not a website order')
  eq(refundEmailNext({ sent: false, reason: 'not_sent_test_customer' }, 0), 'done', 'test customer')
  eq(refundEmailNext({ sent: false, reason: 'not_sent_recipient_suppressed' }, 0), 'done', 'suppressed address')
  eq(refundEmailNext({ sent: false, reason: 'not_sent_error' }, 0), 'retry', '1st failure')
  eq(refundEmailNext({ sent: false, reason: 'error' }, 1), 'retry', '2nd failure')
  eq(refundEmailNext({ sent: false, reason: 'not_sent_not_configured' }, MAX_REFUND_EMAIL_RESENDS - 1), 'give_up', '3rd failure')
})

Deno.test('B02 wiring: square-reconcile checks for a sent row, re-sends refund_received, and bells when it gives up', async () => {
  const src = await code('square-reconcile/index.ts')
  assert(src.includes('.eq("refund_email_replay", true)'), 'only refunds marked for replay')
  assert(src.includes('.eq("metadata->>idempotency_key", key)'), 'checks email_send_log for a sent row first')
  assert(src.includes('variant: "refund_received"'), 'sends the refund_received email')
  assert(src.includes('type: "refund_email_failed"'), 'rings refund_email_failed when it gives up')
})

// ───────────────────────────────────────────── S01 / S02 / S03 wiring

Deno.test('S01/S02/S03 wiring in square-reconcile', async () => {
  const src = await code('square-reconcile/index.ts')
  assert(src.includes('rpc(db, "note_square_attempt_stuck"'), 'S01 calls note_square_attempt_stuck')
  assert(src.includes('envs = discoveryEnvironments(env, rows)'), 'S02 computes the environments')
  assert(/for \(const dEnv of envs\)[\s\S]*walkStream\(db, `refunds:\$\{dEnv\}`/.test(src), 'S02 refund discovery per environment')
  assert(/for \(const dEnv of envs\)[\s\S]*`disputes:\$\{dEnv\}`/.test(src), 'S02 dispute discovery per environment')
  // S03: no unchecked progress write is left.
  for (const where of ['attempts_touch', 'holds_touch', 'refunds_touch', 'open_refunds_touch', 'disputes_touch']) {
    assert(src.includes(`checked(\`${where} `), `S03 ${where} is checked`)
  }
  assert(!/^\s*await db\.from\("square_(payments|refunds|disputes|card_attempts)"\)\.update/m.test(src), 'S03 no bare awaited update remains')
  assert(src.includes('report.health_write_failed = true'), 'S03 a failed health write is reported')
})

// ───────────────────────────────────────────── B01 edge

Deno.test('B01: the edge maps the card refusals and the retry answer', async () => {
  const src = await code('mark-refund-issued/index.ts')
  assert(src.includes('method_mismatch: 409') && src.includes('no_completed_card_refund: 409'), 'refusal codes mapped')
  assert(src.includes('r.already_recorded === true'), 'reads already_recorded')
  assert(src.includes('refundIssuedEmailSent(supabase, emailKey)'), 'a retry re-sends only when the email never went out')
  eq(terminateRefusalMessage('card_refund_needs_square')?.startsWith('This order was paid by card.'), true, 'cancel refusal has staff text')
  // a retry of an already-marked order reaches the SQL (which answers already_recorded)
  const issued = { source_channel: 'web', status: 'cancelled', refund_status: 'refund_issued' }
  eq(refundIssuedRefusal(issued, { method: 'card', refundedOn: '2026-10-07' }, '2026-10-08'), null, 'refund_issued passes the pre-check')
  eq(refundIssuedRefusal({ ...issued, refund_status: 'store_credit_issued' }, { method: 'card', refundedOn: '2026-10-07' }, '2026-10-08'), 'not_refund_pending', 'other statuses still refused')
})

// ───────────────────────────────────────────── cancellation email

const baseEmail = {
  reference: 'CJ-W-900099', items: [{ title: 'Ring', title_ja: null, qty: 1, line_total_jpy: 10000 }],
  shippingJpy: 0, totalJpy: 10000, currency: 'JPY' as const, reason: 'customer request',
  refundStatus: 'store_credit_issued' as const, refundNote: null, orderUrl: null,
}

Deno.test('cancel email: after the order day it states the credit and the 30% charge (JA + EN)', async () => {
  const out = await both(React.createElement(OrderCancelledEmail, { ...baseEmail, lang: 'ja', storeCredit: { amount: 7000, charge: 3000 } }))
  assert(out.includes('30%のキャンセル料（¥3,000）を差し引いた¥7,000'), 'JA states ¥7,000 after the ¥3,000 charge')
  assert(out.includes('¥7,000 has been added to your account as store credit') && out.includes('30% cancellation charge of ¥3,000'), 'EN states both figures')
  assert(!out.includes('The amount you paid has been added'), 'the old full-amount sentence is gone')
})

Deno.test('cancel email: same day states the full amount, no charge', async () => {
  const out = await both(React.createElement(OrderCancelledEmail, { ...baseEmail, lang: 'en', storeCredit: { amount: 10000, charge: 0 } }))
  assert(out.includes('The amount you paid, ¥10,000, has been added'), 'EN full amount')
  assert(!out.includes('cancellation charge'), 'no charge mentioned')
})

Deno.test('cancel email: without figures the older wording stays (other senders unchanged)', async () => {
  const out = await both(React.createElement(OrderCancelledEmail, { ...baseEmail, lang: 'en' }))
  assert(out.includes('The amount you paid has been added to your account as store credit'), 'old wording')
})

Deno.test('cancel-cash-order passes the credit and the charge to the email, bell and portal note', async () => {
  const src = await code('cancel-cash-order/index.ts')
  assert(src.includes('charge: Number(c.cancellation_split?.kept ?? 0)'), 'email gets the charge')
  assert(src.includes('30% cancellation charge ${symbol}${kept.toLocaleString("en-US")} kept'), 'staff bell names the charge')
  assert(src.includes('less the 30% cancellation charge of'), 'portal note names the charge')
})
