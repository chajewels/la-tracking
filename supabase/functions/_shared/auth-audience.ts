/**
 * auth-email-hook AUDIENCE: is this sign-in email for a storefront customer or
 * for the Hub? Extracted from auth-email-hook/index.ts (2026-09-26) so the host
 * list is covered by development/auth-audience.test.ts. Pure: no env, no I/O.
 */

// One Supabase Auth project serves two audiences: staff and portal users of the
// Hub, and CUSTOMERS of the chajewelsjp.com storefront. The hook payload has no
// user metadata, but every link carries where it lands — `callback_url`, or the
// redirect_to inside the verify URL — and that is enough to tell them apart.
// A storefront link gets Cha Jewels branding and no mention of the Hub; every
// other email is exactly as before.
export const STOREFRONT_HOSTS = [
  // The storefront's own domain, with or without www: chajewelsjp.com and
  // www.chajewelsjp.com — and NOTHING else under it. app.chajewelsjp.com
  // (staff) and portal.chajewelsjp.com (Hub customer portal) are the Hub and
  // must keep the Hub email.
  // (2026-09-26: this line used to read chajewelsjapan.com — the Page365
  // shop, which never signs in against this project — so a sign-in from
  // www.chajewelsjp.com got "Your login link / Cha Jewels Hub".)
  /^(www\.)?chajewelsjp\.com$/i,
  // Every host Vercel gives the cha-jewels-web project, and nothing else:
  //   cha-jewels-web.vercel.app                        production alias
  //   cha-jewels-web-cha-jewels.vercel.app             team alias
  //   cha-jewels-web-git-<branch>-cha-jewels.vercel.app git-branch / PR preview
  //   cha-jewels-web-<hash>-cha-jewels.vercel.app       per-deployment URL
  // The "-cha-jewels" team suffix is what keeps this project-scoped: a
  // stranger's "cha-jewels-web-anything.vercel.app" does not match.
  // (2026-09-13: the team alias was missing — its pattern demanded a segment
  // between the two dashes — so a sign-in from that host got the Hub email.)
  /^cha-jewels-web\.vercel\.app$/i,
  /^cha-jewels-web-([a-z0-9-]+-)?cha-jewels\.vercel\.app$/i,
]

export type HookLinkData = { action_type?: string; callback_url?: string; url?: string }

const REDIRECT_PARAMS = ['redirect_to', 'redirectTo', 'redirect_uri', 'redirect_url']

function redirectParamOf(u: string): string | null {
  try {
    const q = new URL(u).searchParams
    for (const k of REDIRECT_PARAMS) {
      const v = q.get(k)
      if (v) return v
    }
    return null
  } catch {
    return null
  }
}

/**
 * Every URL the payload could be pointing the customer at, in the order they
 * were found. Earlier versions returned ONLY callback_url when it was present,
 * so a callback_url that was not the storefront (a relay or the project's
 * own callback) hid the real redirect_to inside `url` and the storefront
 * branding never fired. Now every candidate is checked, including a
 * redirect_to nested inside a redirect_to (a relay that itself redirects).
 */
export function linkTargets(data: HookLinkData): string[] {
  const out: string[] = []
  const push = (v: string | null | undefined) => { if (v && !out.includes(v)) out.push(v) }
  push(data.callback_url)
  push(redirectParamOf(data.callback_url ?? ''))
  push(data.url)
  const rt = redirectParamOf(data.url ?? '')
  push(rt)
  push(redirectParamOf(rt ?? ''))
  return out
}

export function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname
  } catch {
    return null
  }
}

export function isStorefrontHost(host: string | null): boolean {
  return !!host && STOREFRONT_HOSTS.some((re) => re.test(host))
}

export function isStorefrontLink(data: HookLinkData): boolean {
  return linkTargets(data).some((t) => isStorefrontHost(hostOf(t)))
}

/**
 * The link a STOREFRONT email carries.
 *
 * GoTrue's verify URL consumes the one-time token on its first GET, and
 * Gmail's link scanner GETs every link in a message within seconds of
 * delivery — so the customer's own click found the token already spent
 * (otp_expired; 2026-09-13 02:40:43 send, code issued 02:40:58, nobody had
 * clicked). The storefront email therefore does NOT point at /auth/v1/verify.
 * It points at the storefront's /auth/confirm page with token_hash + type, and
 * nothing is exchanged until the customer presses "Sign in" there — a POST a
 * scanner never makes. The token and type are the ones GoTrue put in its own
 * verify URL; the storefront origin and `next` come from that URL's
 * redirect_to. If anything is missing, or the target is not a storefront host,
 * the original URL is used unchanged.
 */
export function storefrontConfirmUrl(data: HookLinkData): string {
  const original = data.url ?? ''
  try {
    // The verify URL may be data.url itself or sit behind a relay's redirect_to.
    const candidates = [original, redirectParamOf(original) ?? '', redirectParamOf(redirectParamOf(original) ?? '') ?? '']
    for (const c of candidates) {
      if (!c) continue
      const verify = new URL(c)
      const tokenHash = verify.searchParams.get('token')
      const type = verify.searchParams.get('type')
      const rt = redirectParamOf(c)
      if (!tokenHash || !type || !rt) continue
      const target = new URL(rt)
      if (!isStorefrontHost(target.hostname)) return original
      const next = target.searchParams.get('next') || '/account'
      const out = new URL('/auth/confirm', target.origin)
      out.searchParams.set('token_hash', tokenHash)
      out.searchParams.set('type', type)
      out.searchParams.set('next', next.startsWith('/') && !next.startsWith('//') ? next : '/account')
      return out.toString()
    }
    return original
  } catch {
    return original
  }
}

// Email types a storefront customer can trigger from /login. signInWithOtp
// sends `magiclink` to a known address and `signup` to a first-time one
// (GoTrue creates the user and asks them to confirm) — to the customer both
// are "the sign-in link I asked for", so both get the storefront email when
// the link lands on a storefront host. Everything else stays staff-branded.
export const STOREFRONT_ACTION_TYPES = new Set(['magiclink', 'signup'])

/** The one audience decision: storefront only for a sign-in link that lands on a storefront host. */
export function audienceOf(data: HookLinkData | null | undefined): 'storefront' | 'staff' {
  return !!data && STOREFRONT_ACTION_TYPES.has(data.action_type ?? '') && isStorefrontLink(data) ? 'storefront' : 'staff'
}
