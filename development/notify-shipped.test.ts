/**
 * notify-shipped (payment lifecycle H7): the idempotency key for the shipped
 * email is stable for one shipped_at, so a double click never sends twice.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/notify-shipped.test.ts
 */
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1'
import { shippedKey } from '../supabase/functions/_shared/shipped-key.ts'

Deno.test('shippedKey has the contract shape', () => {
  assertEquals(shippedKey('cash_order', 'a', '2026-10-05'), 'shipped-cash_order-a-2026-10-05')
  assertEquals(shippedKey('layaway', 'b', '2026-10-06'), 'shipped-layaway-b-2026-10-06')
})

Deno.test('shippedKey is stable, and differs per shipped_at / id / kind', () => {
  assertEquals(shippedKey('layaway', 'x', 'd'), shippedKey('layaway', 'x', 'd'))
  assertNotEquals(shippedKey('layaway', 'x', 'd1'), shippedKey('layaway', 'x', 'd2'))
  assertNotEquals(shippedKey('layaway', 'x', 'd'), shippedKey('layaway', 'y', 'd'))
  assertNotEquals(shippedKey('layaway', 'x', 'd'), shippedKey('cash_order', 'x', 'd'))
})
