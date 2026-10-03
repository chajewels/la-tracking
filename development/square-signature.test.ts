/**
 * SQUARE WEBHOOK SIGNATURE (S2, 2026-10-04, docs/SQUARE.md).
 *
 * Square signs every webhook: base64(HMAC-SHA256(signature_key,
 * notification_url + raw_body)) in x-square-hmacsha256-signature. The Hub
 * verifies against the REGISTERED notification URL (a constant), timing-safe,
 * and never accepts a body without a key or a header. Pins the vector so the
 * verifier cannot drift, and the fail-closed cases.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/square-signature.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { hmacSha256Base64, isCardRefusalCode, verifySquareSignature } from '../supabase/functions/_shared/square.ts'

const key = 'test-signature-key-0123456789'
const url = 'https://pfoicalpzdcmyxzvwyhz.supabase.co/functions/v1/square-webhook'
const body = '{"merchant_id":"MLTZ79","type":"payment.updated","event_id":"6a8f5f28-54a1-4eb0-a98a-3111513fd4fc","data":{"type":"payment","id":"hYy9pRFVxpDsO1FB05SunFWUe9JZY","object":{"payment":{"id":"hYy9pRFVxpDsO1FB05SunFWUe9JZY","status":"COMPLETED"}}}}'

Deno.test('a correctly signed body verifies, against the registered URL + raw body', async () => {
  const sig = await hmacSha256Base64(key, url + body)
  assertEquals(await verifySquareSignature(url, body, sig, key), true)
})

Deno.test('a tampered body, a different URL, a wrong key, a missing header or key all fail closed', async () => {
  const sig = await hmacSha256Base64(key, url + body)
  assertEquals(await verifySquareSignature(url, body.replace('COMPLETED', 'CANCELED'), sig, key), false)
  assertEquals(await verifySquareSignature(url + '/', body, sig, key), false)
  assertEquals(await verifySquareSignature(url, body, sig, 'another-key'), false)
  assertEquals(await verifySquareSignature(url, body, null, key), false)
  assertEquals(await verifySquareSignature(url, body, '', key), false)
  assertEquals(await verifySquareSignature(url, body, sig, ''), false)
  assertEquals(await verifySquareSignature(url, body, sig.slice(0, -2) + 'AA', key), false)
})

Deno.test('the HMAC vector is stable (RFC 4231-style check against a known digest)', async () => {
  // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog") (openssl dgst -sha256 -hmac key, base64) is the value below.
  assertEquals(await hmacSha256Base64('key', 'The quick brown fox jumps over the lazy dog'), '97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=')
})

Deno.test('isCardRefusalCode: a card refusal is 402 card_declined; a used nonce or a merchant config error is not', () => {
  assertEquals(isCardRefusalCode('PAYMENT_METHOD_ERROR', 'CARD_DECLINED'), true)
  assertEquals(isCardRefusalCode('PAYMENT_METHOD_ERROR', 'CVV_FAILURE'), true)
  assertEquals(isCardRefusalCode('PAYMENT_METHOD_ERROR', 'INSUFFICIENT_FUNDS'), true)
  assertEquals(isCardRefusalCode('', 'GENERIC_DECLINE'), true)
  assertEquals(isCardRefusalCode('INVALID_REQUEST_ERROR', 'CARD_TOKEN_USED'), false)
  assertEquals(isCardRefusalCode('INVALID_REQUEST_ERROR', 'CARD_TOKEN_EXPIRED'), false)
  assertEquals(isCardRefusalCode('PAYMENT_METHOD_ERROR', 'CARD_PROCESSING_NOT_ENABLED'), false)
  assertEquals(isCardRefusalCode('INVALID_REQUEST_ERROR', 'AMOUNT_TOO_LOW'), false)
  assertEquals(isCardRefusalCode('INVALID_REQUEST_ERROR', 'IDEMPOTENCY_KEY_REUSED'), false)
  assertEquals(isCardRefusalCode('AUTHENTICATION_ERROR', 'UNAUTHORIZED'), false)
})
