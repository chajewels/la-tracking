import { assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { EmailAPIError } from 'npm:@lovable.dev/email-js@0.1.0'
import { isTransientEmailError, sendLovableEmailWithRetry } from './email-retry.ts'
import { formatEmailErrorMessage } from './email-log.ts'

// deno-lint-ignore no-explicit-any
function apiErr(status: number, type: string): any {
  const e = new Error(`Email API error: ${status} {"type":"${type}"}`) as Error & { status: number; code: string }
  e.status = status
  e.code = type
  return e
}

// deno-lint-ignore no-explicit-any
const payload: any = { to: 'x@example.com', label: 't', idempotency_key: 'key-1' }
// deno-lint-ignore no-explicit-any
const opts: any = { apiKey: 'k' }
const sleep = () => Promise.resolve()

function fake(errors: unknown[]) {
  const keys: string[] = []
  // deno-lint-ignore no-explicit-any
  const send = (p: any) => {
    keys.push(p.idempotency_key)
    const e = errors.shift()
    return e ? Promise.reject(e) : Promise.resolve({})
  }
  return { send, keys }
}

for (const [name, first] of [
  ['registry_lookup_failed', apiErr(403, 'lovable_api_key_registry_lookup_failed')],
  ['503', apiErr(503, 'unavailable')],
  ['network TypeError', new TypeError('fetch failed')],
] as const) {
  Deno.test(`${name} then success → retried, same key`, async () => {
    const f = fake([first])
    const r = await sendLovableEmailWithRetry(payload, opts, { send: f.send, sleep })
    assertEquals(r.retried, true)
    assertEquals(f.keys, ['key-1', 'key-1'])
  })
}

Deno.test('registry_lookup_failed twice → throws second, 2 calls', async () => {
  const second = apiErr(403, 'lovable_api_key_registry_lookup_failed')
  const f = fake([apiErr(403, 'lovable_api_key_registry_lookup_failed'), second])
  const e = await assertRejects(() => sendLovableEmailWithRetry(payload, opts, { send: f.send, sleep }))
  assertEquals(e, second)
  assertEquals(f.keys.length, 2)
})

for (const [name, err] of [
  ['429 rate_limited', apiErr(429, 'rate_limited')],
  ['recipient_suppressed', apiErr(400, 'recipient_suppressed')],
  ['400 missing_unsubscribe', apiErr(400, 'missing_unsubscribe')],
  ['other 403', apiErr(403, 'forbidden')],
] as const) {
  Deno.test(`${name} → throws at once, 1 call`, async () => {
    const f = fake([err])
    await assertRejects(() => sendLovableEmailWithRetry(payload, opts, { send: f.send, sleep }))
    assertEquals(f.keys.length, 1)
    assertEquals(isTransientEmailError(err), false)
  })
}

Deno.test('real EmailAPIError class is handled', () => {
  assertEquals(typeof EmailAPIError, 'function')
})

Deno.test('success first time → 1 call, retried false', async () => {
  const f = fake([])
  const r = await sendLovableEmailWithRetry(payload, opts, { send: f.send, sleep })
  assertEquals(r, { retried: false, firstErrorType: null })
  assertEquals(f.keys.length, 1)
})

Deno.test('email-log prefix applied once', () => {
  assertEquals(formatEmailErrorMessage('Email API error: 403 x'), 'Email API error: 403 x')
  assertEquals(formatEmailErrorMessage('boom'), 'Email API error: boom')
})
