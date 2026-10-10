/**
 * LATEST PAYMENT DECISION (payment lifecycle H6, 2026-10-05).
 * latestDecision / newestDecided pick the newest decided submission exactly as
 * public.switch_web_payment_method_by_customer_atomic does:
 *   ORDER BY updated_at DESC NULLS LAST, created_at DESC, id DESC
 * among rejected / needs_clarification / confirmed. Pure — no network.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/latest-decision.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { latestDecision, newestDecided, switchedSinceDecision, type DecisionRow } from '../supabase/functions/_shared/latest-decision.ts'
import { switchTargets, type SwitchInput } from '../supabase/functions/_shared/method-switch-rules.ts'

const row = (over: Partial<DecisionRow>): DecisionRow => ({
  id: '00000000-0000-0000-0000-000000000001',
  status: 'rejected',
  payment_method: 'transfer',
  submitted_amount: 12000,
  created_at: '2026-10-05T01:00:00+00:00',
  updated_at: '2026-10-05T02:00:00+00:00',
  customer_message: null,
  ...over,
})

Deno.test('no rows -> null', () => {
  assertEquals(latestDecision([]), null)
})

Deno.test('one rejected -> the decision with its message', () => {
  assertEquals(latestDecision([row({ customer_message: 'The amount did not match.' })]), {
    status: 'rejected',
    method: 'transfer',
    amount: 12000,
    decided_at: '2026-10-05T02:00:00+00:00',
    message: 'The amount did not match.',
  })
})

Deno.test('rejected then a later confirmed -> null', () => {
  assertEquals(latestDecision([
    row({ status: 'rejected', updated_at: '2026-10-05T02:00:00+00:00' }),
    row({ id: '00000000-0000-0000-0000-000000000002', status: 'confirmed', updated_at: '2026-10-05T03:00:00+00:00' }),
  ]), null)
})

Deno.test('needs_clarification newest -> needs_clarification', () => {
  const d = latestDecision([
    row({ status: 'rejected', updated_at: '2026-10-05T02:00:00+00:00' }),
    row({ id: '00000000-0000-0000-0000-000000000002', status: 'needs_clarification', updated_at: '2026-10-05T04:00:00+00:00', customer_message: 'Please send the slip.' }),
  ])
  assertEquals(d?.status, 'needs_clarification')
  assertEquals(d?.message, 'Please send the slip.')
})

Deno.test('square -> method card; paidy stays paidy; null -> transfer', () => {
  assertEquals(latestDecision([row({ payment_method: 'square' })])?.method, 'card')
  assertEquals(latestDecision([row({ payment_method: 'paidy' })])?.method, 'paidy')
  assertEquals(latestDecision([row({ payment_method: null })])?.method, 'transfer')
})

Deno.test('pending statuses are ignored', () => {
  assertEquals(latestDecision([row({ status: 'submitted', updated_at: '2026-10-06T00:00:00+00:00' })]), null)
  assertEquals(latestDecision([
    row({ status: 'rejected' }),
    row({ id: '00000000-0000-0000-0000-000000000009', status: 'under_review', updated_at: '2026-10-06T00:00:00+00:00' }),
  ])?.status, 'rejected')
})

Deno.test('equal updated_at -> created_at DESC breaks the tie', () => {
  const t = '2026-10-05T02:00:00+00:00'
  assertEquals(newestDecided([
    row({ id: 'aaaaaaaa-0000-0000-0000-000000000000', status: 'confirmed', updated_at: t, created_at: '2026-10-05T01:00:00+00:00' }),
    row({ id: '00000000-0000-0000-0000-000000000000', status: 'rejected', updated_at: t, created_at: '2026-10-05T01:30:00+00:00' }),
  ])?.status, 'rejected')
})

Deno.test('equal updated_at and created_at -> id DESC breaks the tie', () => {
  const t = '2026-10-05T02:00:00+00:00'
  assertEquals(newestDecided([
    row({ id: '10000000-0000-0000-0000-000000000000', status: 'rejected', updated_at: t, created_at: t }),
    row({ id: 'f0000000-0000-0000-0000-000000000000', status: 'confirmed', updated_at: t, created_at: t }),
  ])?.status, 'confirmed')
})

Deno.test('updated_at NULLS LAST', () => {
  assertEquals(newestDecided([
    row({ id: 'f0000000-0000-0000-0000-000000000000', status: 'confirmed', updated_at: null, created_at: '2026-10-09T00:00:00+00:00' }),
    row({ status: 'rejected', updated_at: '2026-10-01T00:00:00+00:00' }),
  ])?.status, 'rejected')
})

Deno.test('microseconds count, as in SQL', () => {
  assertEquals(newestDecided([
    row({ id: 'f0000000-0000-0000-0000-000000000000', status: 'confirmed', updated_at: '2026-10-05T02:00:00.123401+00:00' }),
    row({ status: 'rejected', updated_at: '2026-10-05T02:00:00.123402+00:00' }),
  ])?.status, 'rejected')
  // Different time-zone spellings of the same instant order correctly.
  assertEquals(newestDecided([
    row({ id: 'f0000000-0000-0000-0000-000000000000', status: 'confirmed', updated_at: '2026-10-05T10:00:00+09:00' }),
    row({ status: 'rejected', updated_at: '2026-10-05T01:00:00.5+00:00' }),
  ])?.status, 'rejected')
})

Deno.test('amount is a number; decided_at falls back to created_at', () => {
  const d = latestDecision([row({ submitted_amount: '5000.00' as unknown as number, updated_at: null })])
  assertEquals(d?.amount, 5000)
  assertEquals(d?.decided_at, '2026-10-05T01:00:00+00:00')
})

// switchTargets: the methods canCustomerSwitch allows, in public names.
const base: Omit<SwitchInput, 'to'> = {
  status: 'pending', paymentStatus: 'pending_transfer', sourceChannel: 'web', lock: null,
  latestDecision: 'rejected', switchedSinceDecision: false, currency: 'JPY', from: 'paidy',
}

Deno.test('switchTargets: rejected Paidy on yen -> transfer, card and cash on delivery (by the rules; the offer is checked by the caller)', () => {
  assertEquals(switchTargets(base), ['transfer', 'square', 'cod'])
})

Deno.test('switchTargets: peso order -> transfer only', () => {
  assertEquals(switchTargets({ ...base, currency: 'PHP', from: 'transfer' }), [])
  assertEquals(switchTargets({ ...base, currency: 'PHP', from: 'square' }), ['transfer'])
})

Deno.test('switchTargets: none when not rejected, locked or not web', () => {
  assertEquals(switchTargets({ ...base, latestDecision: 'needs_clarification' }), [])
  assertEquals(switchTargets({ ...base, latestDecision: 'confirmed' }), [])
  assertEquals(switchTargets({ ...base, latestDecision: null }), [])
  assertEquals(switchTargets({ ...base, lock: 'payment_pending' }), [])
  assertEquals(switchTargets({ ...base, sourceChannel: 'hub' }), [])
})

Deno.test('switchTargets: none once she has switched since the rejection', () => {
  assertEquals(switchTargets({ ...base, switchedSinceDecision: true }), [])
})

Deno.test('switchedSinceDecision: a customer switch after the decision counts, before does not', () => {
  const d = row({ updated_at: '2026-10-05T02:00:00.000001+00:00' })
  assertEquals(switchedSinceDecision(d, '2026-10-05T02:00:00.000002+00:00'), true)
  assertEquals(switchedSinceDecision(d, '2026-10-05T02:00:00.000001+00:00'), false)
  assertEquals(switchedSinceDecision(d, '2026-10-05T01:00:00+00:00'), false)
  assertEquals(switchedSinceDecision(d, null), false)
  assertEquals(switchedSinceDecision(null, '2026-10-05T03:00:00+00:00'), false)
  // decision time falls back to created_at when updated_at is null
  assertEquals(switchedSinceDecision(row({ updated_at: null, created_at: '2026-10-05T01:00:00+00:00' }), '2026-10-05T01:30:00+00:00'), true)
})
