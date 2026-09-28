/**
 * isPasswordSession (2026-09-28) — supabase/functions/_shared/portal-auth.ts.
 *
 * resolvePortalAuth Path 0 fills customers.portal_password_at when it is empty
 * and the validated access token came from an EMAIL/PASSWORD sign-in. The
 * token's `amr` claim is an array of { method, timestamp } (Supabase docs,
 * guides/auth/jwt-fields). Only "password" counts — never "recovery" (a
 * reset-link session exists before any password is chosen), "otp",
 * "magiclink" or anything else. A plain string array is accepted too, and
 * anything unreadable is false, never a throw.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/portal-auth-amr.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import { isPasswordSession } from '../supabase/functions/_shared/portal-auth.ts'

/** base64url, no padding — the way a real JWT encodes its parts. */
function b64url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function jwt(payload: unknown): string {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.sig`
}

const at = (method: string) => ({ method, timestamp: 1790000000 })

const cases: Array<[string, string, boolean]> = [
  ['password sign-in', jwt({ sub: 'u', amr: [at('password')] }), true],
  ['password after a refresh (both entries)', jwt({ amr: [at('password'), at('token_refresh')] }), true],
  ['string-array amr', jwt({ amr: ['password'] }), true],
  ['otp (storefront code)', jwt({ amr: [at('otp')] }), false],
  ['magiclink (storefront link)', jwt({ amr: [at('magiclink')] }), false],
  ['recovery (reset link, no password yet)', jwt({ amr: [at('recovery')] }), false],
  ['token_refresh only', jwt({ amr: [at('token_refresh')] }), false],
  ['email/signup', jwt({ amr: [at('email/signup')] }), false],
  ['no amr claim', jwt({ sub: 'u' }), false],
  ['amr not an array', jwt({ amr: 'password' }), false],
  ['empty amr', jwt({ amr: [] }), false],
  ['null entries', jwt({ amr: [null, 42] }), false],
  // '~' and '?' runs encode to '-' / '_' in base64url, which atob rejects unless converted.
  ['base64url payload characters', jwt({ name: '~~~???>>>', amr: [at('password')] }), true],
  ['garbage string', 'not-a-jwt', false],
  ['empty string', '', false],
  ['undecodable payload', 'a.%%%%.c', false],
  ['payload not JSON', `a.${b64url('not json')}.c`, false],
]

for (const [name, token, expected] of cases) {
  Deno.test(`isPasswordSession: ${name} → ${expected}`, () => {
    assertEquals(isPasswordSession(token), expected)
  })
}
