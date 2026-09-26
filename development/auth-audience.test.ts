/**
 * SIGN-IN EMAIL AUDIENCE (2026-09-26). A storefront sign-in on
 * https://www.chajewelsjp.com produced the Hub template "Your login link"
 * because the storefront host list named chajewelsjapan.com (Page365) instead
 * of chajewelsjp.com. Every address form a customer or staff member can sign
 * in from is pinned here: storefront hosts get the storefront email, the Hub's
 * own hosts keep the Hub email.
 *
 * Run: deno test --config development/deno.ci.json --allow-read --allow-env development/auth-audience.test.ts
 */
import { assertEquals } from 'jsr:@std/assert@1'
import {
  audienceOf,
  isStorefrontHost,
  storefrontConfirmUrl,
} from '../supabase/functions/_shared/auth-audience.ts'

const VERIFY = 'https://abcdefgh.supabase.co/auth/v1/verify'

/** GoTrue's verify URL, the way the hook receives it, with redirect_to on `origin`. */
function payload(origin: string, action_type = 'magiclink') {
  const redirect = `${origin}/auth/callback?next=/account`
  const url = `${VERIFY}?token=pkce_abc123&type=${action_type}&redirect_to=${encodeURIComponent(redirect)}`
  return { action_type, url, callback_url: undefined as string | undefined }
}

const STOREFRONT = [
  'https://www.chajewelsjp.com', // the evidence: 2026-09-26 02:03 UTC
  'https://chajewelsjp.com',
  'https://WWW.CHAJEWELSJP.COM',
  'https://cha-jewels-web.vercel.app',
  'https://cha-jewels-web-cha-jewels.vercel.app',
  'https://cha-jewels-web-git-feature-x-cha-jewels.vercel.app',
  'https://cha-jewels-web-a1b2c3d4e-cha-jewels.vercel.app',
]

const HUB = [
  'https://app.chajewelsjp.com', // staff
  'https://portal.chajewelsjp.com', // Hub customer portal
  'https://chajewelslayaway.web.app',
  'https://chajewelslayaway.lovable.app',
  'https://id-preview--abc.lovable.app',
  'https://chajewelsjapan.com', // Page365 — never signs in here
  'https://www.chajewelsjapan.com',
  'https://cha-jewels-web-anything.vercel.app', // a stranger's project
  'https://evilchajewelsjp.com',
  'https://www.chajewelsjp.com.evil.test',
  'http://localhost:8080',
]

for (const origin of STOREFRONT) {
  Deno.test(`storefront email for a sign-in from ${origin}`, () => {
    assertEquals(isStorefrontHost(new URL(origin).hostname), true)
    for (const action of ['magiclink', 'signup']) assertEquals(audienceOf(payload(origin, action)), 'storefront')
    // The link goes to the storefront's own /auth/confirm on the SAME origin.
    const confirm = new URL(storefrontConfirmUrl(payload(origin)))
    assertEquals(confirm.origin, new URL(origin).origin.toLowerCase())
    assertEquals(confirm.pathname, '/auth/confirm')
    assertEquals(confirm.searchParams.get('token_hash'), 'pkce_abc123')
    assertEquals(confirm.searchParams.get('next'), '/account')
  })
}

for (const origin of HUB) {
  Deno.test(`Hub email for a sign-in from ${origin}`, () => {
    assertEquals(isStorefrontHost(new URL(origin).hostname), false)
    assertEquals(audienceOf(payload(origin)), 'staff')
    // Not a storefront target → the original GoTrue link, unchanged.
    assertEquals(storefrontConfirmUrl(payload(origin)), payload(origin).url)
  })
}

Deno.test('storefront host but a non-sign-in action (recovery, invite, email_change) stays Hub', () => {
  for (const action of ['recovery', 'invite', 'email_change', 'reauthentication'])
    assertEquals(audienceOf(payload('https://www.chajewelsjp.com', action)), 'staff')
})

Deno.test('storefront target found through callback_url too', () => {
  assertEquals(audienceOf({ action_type: 'magiclink', callback_url: 'https://www.chajewelsjp.com/auth/callback' }), 'storefront')
  assertEquals(audienceOf({ action_type: 'magiclink', callback_url: 'https://app.chajewelsjp.com/auth/callback' }), 'staff')
})

Deno.test('no payload → Hub', () => {
  assertEquals(audienceOf(null), 'staff')
  assertEquals(audienceOf({}), 'staff')
})
