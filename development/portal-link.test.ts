/**
 * PORTAL LINK RULE (2026-09-28). Both builders — the Hub's
 * src/lib/portal-link.ts and the edge functions' _shared/portal-link.ts —
 * must agree:
 *   1. portal_password_at set              → bare URL (sign-in), intent honoured
 *   2. else a live (active, unexpired) token → token URL, intent honoured
 *   3. else auth_user_id set                → bare URL, intent honoured
 *   4. else                                 → https://portal.chajewelsjp.com/portal
 * auth_user_id alone is NOT a password: storefront magic-link sign-ins set it.
 * The PIN line follows isTokenLink(url).
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/portal-link.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import * as front from '../src/lib/portal-link.ts'
import * as back from '../supabase/functions/_shared/portal-link.ts'

const BASE = 'https://portal.chajewelsjp.com'
const PAST = '2000-01-01T00:00:00Z'
const FUTURE = '2999-01-01T00:00:00Z'

type Builder = typeof front.getPortalLinkForCustomer

const builders: Array<[string, Builder, (u: string) => boolean]> = [
  ['frontend', front.getPortalLinkForCustomer, front.isTokenLink],
  ['backend', back.getPortalLinkForCustomer, back.isTokenLink],
]

for (const [name, build, isTokenLink] of builders) {
  Deno.test(`${name}: password + live token → bare sign-in URL (no PIN)`, () => {
    const url = build({ auth_user_id: 'u1', portal_password_at: '2026-06-01T00:00:00Z', portal_token: 'tok', token_expires_at: FUTURE })
    assertEquals(url, `${BASE}/portal`)
    assertEquals(isTokenLink(url), false)
  })

  Deno.test(`${name}: password, no token → bare URL`, () => {
    assertEquals(build({ auth_user_id: 'u1', portal_password_at: '2026-06-01T00:00:00Z' }), `${BASE}/portal`)
  })

  Deno.test(`${name}: magic-link sign-in (auth_user_id, no password) + token → token URL (PIN)`, () => {
    const url = build({ auth_user_id: 'u1', portal_password_at: null, portal_token: 'tok', token_expires_at: FUTURE })
    assertEquals(url, `${BASE}/portal?token=tok`)
    assertEquals(isTokenLink(url), true)
  })

  Deno.test(`${name}: magic-link sign-in, no token → bare URL`, () => {
    assertEquals(build({ auth_user_id: 'u1', portal_password_at: null, portal_token: null }), `${BASE}/portal`)
  })

  Deno.test(`${name}: token only → token URL`, () => {
    assertEquals(build({ auth_user_id: null, portal_token: 'a b' }), `${BASE}/portal?token=a%20b`)
  })

  Deno.test(`${name}: expired token, no auth → /portal home`, () => {
    const url = build({ auth_user_id: null, portal_token: 'tok', token_expires_at: PAST })
    assertEquals(url, `${BASE}/portal`)
    assertEquals(isTokenLink(url), false)
  })

  Deno.test(`${name}: expired token + magic-link sign-in → bare URL`, () => {
    assertEquals(build({ auth_user_id: 'u1', portal_token: 'tok', token_expires_at: PAST }), `${BASE}/portal`)
  })

  Deno.test(`${name}: loyalty intent honoured on every branch but the last`, () => {
    assertEquals(build({ auth_user_id: 'u1', portal_password_at: '2026-06-01T00:00:00Z', portal_token: 'tok' }, 'loyalty'), `${BASE}/loyalty`)
    assertEquals(build({ auth_user_id: 'u1', portal_token: 'tok' }, 'loyalty'), `${BASE}/loyalty?token=tok`)
    assertEquals(build({ auth_user_id: 'u1' }, 'loyalty'), `${BASE}/loyalty`)
    assertEquals(build({ auth_user_id: null }, 'loyalty'), `${BASE}/portal`)
  })
}

// ── backend buildPortalLinkForCustomerId against a fake client ──

interface FakeData {
  customer: { auth_user_id: string | null; portal_password_at: string | null } | null
  token: { token: string; expires_at: string | null } | null
}

function fakeClient(d: FakeData) {
  const reads: string[] = []
  const chain = (table: string) => {
    const q: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q
    q.single = () => {
      reads.push(table)
      return Promise.resolve(d.customer ? { data: d.customer, error: null } : { data: null, error: { message: 'nope' } })
    }
    q.maybeSingle = () => {
      reads.push(table)
      return Promise.resolve({ data: d.token, error: null })
    }
    return q
  }
  return { client: { from: chain }, reads }
}

Deno.test('backend by id: password → bare URL, token never read', async () => {
  const { client, reads } = fakeClient({
    customer: { auth_user_id: 'u1', portal_password_at: '2026-06-01T00:00:00Z' },
    token: { token: 'tok', expires_at: FUTURE },
  })
  assertEquals(await back.buildPortalLinkForCustomerId(client, 'c1', 'loyalty'), `${BASE}/loyalty`)
  assertEquals(reads, ['customers'])
})

Deno.test('backend by id: magic-link sign-in + live token → token URL', async () => {
  const { client } = fakeClient({ customer: { auth_user_id: 'u1', portal_password_at: null }, token: { token: 'tok', expires_at: FUTURE } })
  assertEquals(await back.buildPortalLinkForCustomerId(client, 'c1'), `${BASE}/portal?token=tok`)
})

Deno.test('backend by id: magic-link sign-in, expired token → bare URL', async () => {
  const { client } = fakeClient({ customer: { auth_user_id: 'u1', portal_password_at: null }, token: { token: 'tok', expires_at: PAST } })
  assertEquals(await back.buildPortalLinkForCustomerId(client, 'c1'), `${BASE}/portal`)
})

Deno.test('backend by id: nothing → /portal home even for loyalty', async () => {
  const { client } = fakeClient({ customer: { auth_user_id: null, portal_password_at: null }, token: null })
  assertEquals(await back.buildPortalLinkForCustomerId(client, 'c1', 'loyalty'), `${BASE}/portal`)
})

Deno.test('backend by id: customer lookup fails → token still tried, else bare URL (never throws)', async () => {
  const withToken = fakeClient({ customer: null, token: { token: 'tok', expires_at: null } })
  assertEquals(await back.buildPortalLinkForCustomerId(withToken.client, 'c1'), `${BASE}/portal?token=tok`)
  const without = fakeClient({ customer: null, token: null })
  assertEquals(await back.buildPortalLinkForCustomerId(without.client, 'c1', 'loyalty'), `${BASE}/loyalty`)
})
