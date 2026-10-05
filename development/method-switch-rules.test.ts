/**
 * CUSTOMER PAYMENT-METHOD SWITCH (payment lifecycle H1, 2026-10-05).
 * canCustomerSwitch mirrors the refusal order of the SQL writer
 * public.switch_web_payment_method_by_customer_atomic (migration
 * 20261109100000_payment_lifecycle.sql). Pure function — no network, no database.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/method-switch-rules.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { canCustomerSwitch, type SwitchInput } from '../supabase/functions/_shared/method-switch-rules.ts'

const base: SwitchInput = {
  status: 'pending',
  paymentStatus: 'pending_transfer',
  sourceChannel: 'web',
  lock: null,
  latestDecision: 'rejected',
  currency: 'JPY',
  from: 'paidy',
  to: 'transfer',
}

type Over = Partial<Omit<SwitchInput, 'to'>> & { to?: string }
const err = (over: Over) => {
  const r = canCustomerSwitch({ ...base, ...over } as unknown as SwitchInput)
  return r.ok ? 'ok' : r.error
}

Deno.test('rejected Paidy -> transfer is allowed', () => {
  assertEquals(canCustomerSwitch(base), { ok: true })
})

Deno.test('no decision yet -> not_rejected', () => {
  assertEquals(err({ latestDecision: null }), 'not_rejected')
})

Deno.test('needs_clarification is not a rejection -> not_rejected', () => {
  assertEquals(err({ latestDecision: 'needs_clarification' }), 'not_rejected')
})

Deno.test('a live lock -> payment_in_progress', () => {
  assertEquals(err({ lock: 'paidy_authorized' }), 'payment_in_progress')
})

Deno.test('completed order -> not_payable', () => {
  assertEquals(err({ status: 'completed' }), 'not_payable')
})

Deno.test('payment status other than pending_transfer -> not_payable', () => {
  assertEquals(err({ paymentStatus: 'paid' }), 'not_payable')
  assertEquals(err({ paymentStatus: null }), 'not_payable')
})

Deno.test('Hub order -> not_web_order', () => {
  assertEquals(err({ sourceChannel: 'hub' }), 'not_web_order')
  assertEquals(err({ sourceChannel: null }), 'not_web_order')
})

Deno.test('peso order to card -> method_requires_yen', () => {
  assertEquals(err({ currency: 'PHP', from: 'transfer', to: 'square' }), 'method_requires_yen')
  assertEquals(err({ currency: 'PHP', from: 'transfer', to: 'paidy' }), 'method_requires_yen')
})

Deno.test('same method -> unchanged', () => {
  assertEquals(err({ from: 'transfer', to: 'transfer' }), 'unchanged')
})

Deno.test('unknown method -> bad_method', () => {
  assertEquals(err({ to: 'bitcoin' }), 'bad_method')
})

Deno.test('refusal order mirrors the SQL', () => {
  // everything wrong at once: the first SQL check wins
  assertEquals(err({ sourceChannel: 'hub', status: 'completed', lock: 'x', latestDecision: null, to: 'bitcoin' }), 'not_web_order')
  assertEquals(err({ status: 'completed', lock: 'x', latestDecision: null, to: 'bitcoin' }), 'not_payable')
  assertEquals(err({ lock: 'x', latestDecision: null, to: 'bitcoin' }), 'payment_in_progress')
  assertEquals(err({ latestDecision: null, to: 'bitcoin' }), 'not_rejected')
  assertEquals(err({ to: 'bitcoin', currency: 'PHP' }), 'bad_method')
  assertEquals(err({ from: 'square', to: 'square', currency: 'PHP' }), 'unchanged')
})

Deno.test('latest decision confirmed -> not_rejected', () => {
  assertEquals(err({ latestDecision: 'confirmed' }), 'not_rejected')
})

Deno.test('null stored method reads as transfer', () => {
  assertEquals(err({ from: null, to: 'transfer' }), 'unchanged')
  assertEquals(err({ from: null, to: 'paidy' }), 'ok')
})
