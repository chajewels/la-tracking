/**
 * Frontend portal link builder for Phase B email/password auth.
 *
 * A USABLE TOKEN WINS, whatever the customer's auth state (changed
 * 2026-09-15):
 *   1. a valid, unexpired token → token-bearing URL
 *   2. otherwise auth_user_id   → bare URL (they can sign in)
 *   3. otherwise                → /portal home
 *
 * It used to branch on auth_user_id first. `/auth/customer` sets
 * auth_user_id on any storefront sign-in, and the storefront signs
 * customers in with a magic link — so a legacy token customer who
 * signed in there became "linked" without ever choosing a password,
 * and every Hub link to them switched to a bare URL asking for one.
 * A token URL works either way, so preferring it costs a
 * password-holder nothing.
 *
 * The backend has a parallel implementation at
 * supabase/functions/_shared/portal-link.ts. Both files must be
 * kept in sync — same logic, different runtimes (Deno vs Vite).
 *
 * The frontend version is pure: caller passes already-loaded
 * customer data (auth_user_id + optional portal_token). For
 * customers who lack a token AND lack auth_user_id, the URL
 * falls back to the portal home (/portal) regardless of intent,
 * matching backend behavior — the loyalty page requires auth to
 * render, so token-less unauthenticated visitors land at portal
 * home (Messenger token recovery flow).
 *
 * Usage:
 *   const url = getPortalLinkForCustomer(
 *     { auth_user_id: customer.auth_user_id, portal_token: tokenRow?.token },
 *     'portal'
 *   );
 */

const PORTAL_BASE = 'https://portal.chajewelsjp.com';

export type PortalIntent = 'portal' | 'loyalty';

export interface CustomerForLink {
  auth_user_id: string | null;
  portal_token?: string | null;
  /**
   * The token's expiry, when the caller knows it. `undefined` means
   * "not supplied" and the token is trusted, so existing callers are
   * unaffected; supplying it moves the check out of the call sites.
   */
  token_expires_at?: string | null;
}

/** A token is unusable once its expiry has passed. No expiry = never expires. */
function tokenExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return !Number.isNaN(t) && t < Date.now();
}

/**
 * Build the appropriate portal URL based on the customer's auth
 * state and intent.
 *
 * Rules:
 *   - If customer.auth_user_id is set → bare URL (email/password)
 *   - If null and portal_token present → token-bearing URL
 *   - If null and no token available → /portal home fallback
 *     (regardless of intent — see file header)
 *
 * The caller is responsible for ensuring portal_token is a valid,
 * non-expired, active token. This function does not validate the
 * token.
 *
 * @param customer Object with auth_user_id and optional portal_token
 * @param intent 'portal' (default) or 'loyalty'
 * @returns Fully-qualified portal URL string
 */
export function getPortalLinkForCustomer(
  customer: CustomerForLink,
  intent: PortalIntent = 'portal',
): string {
  const path = intent === 'loyalty' ? '/loyalty' : '/portal';

  // 1. A usable token wins, linked or not — it works either way.
  if (customer.portal_token && !tokenExpired(customer.token_expires_at)) {
    return `${PORTAL_BASE}${path}?token=${encodeURIComponent(customer.portal_token)}`;
  }

  // 2. No usable token, but they can sign in. Honours the intent.
  if (customer.auth_user_id) {
    return `${PORTAL_BASE}${path}`;
  }

  // 3. Nothing to authenticate with → /portal home regardless of intent. The
  // loyalty page requires auth to render, so token-less unauthenticated
  // visitors land at the portal home (Messenger token recovery flow). Matches
  // backend buildPortalLinkForCustomerId.
  return `${PORTAL_BASE}/portal`;
}
