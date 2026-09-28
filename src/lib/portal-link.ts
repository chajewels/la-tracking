/**
 * Frontend portal link builder.
 *
 * THE RULE (2026-09-28 — identical in the backend twin):
 *   1. portal_password_at set              → bare URL (sign-in), intent honoured
 *   2. else a live (active, unexpired) token → token URL, intent honoured
 *   3. else auth_user_id set                → bare URL, intent honoured
 *   4. else                                 → https://portal.chajewelsjp.com/portal
 *
 * WHY portal_password_at AND NOT auth_user_id. auth_user_id does NOT mean
 * "has a portal password". The storefront signs customers in by MAGIC LINK
 * and website POST /auth/customer sets auth_user_id on any storefront
 * sign-in, so a token customer who only ever used the storefront is
 * "linked" without ever choosing a password. Supabase also stores a random
 * encrypted_password for OTP-created users, so auth.users cannot tell the
 * two apart either. The only reliable marker is the one PortalSetup's
 * signUp leaves behind (user_metadata.full_name); customers.portal_password_at
 * was backfilled from it on 2026-09-28 and setup-customer-account stamps it
 * from then on.
 *
 * History: before 2026-09-15 auth_user_id won (magic-link customers were sent
 * to a password form they could not use). PR #70/#71 made any live token win
 * instead — but setting a password never retires the token, so password
 * customers kept getting token links. The password marker now wins; a live
 * token still wins over a bare auth_user_id.
 *
 * PIN LINE: every token link opens the portal PIN gate, so a message shows
 * the PIN line iff the built URL is a token URL (isTokenLink) and a PIN
 * exists — never keyed on auth_user_id.
 *
 * The backend has a parallel implementation at
 * supabase/functions/_shared/portal-link.ts. Both files must be kept in
 * sync — same logic, different runtimes (Deno vs Vite).
 *
 * Usage:
 *   const url = getPortalLinkForCustomer(
 *     {
 *       auth_user_id: customer.auth_user_id,
 *       portal_password_at: customer.portal_password_at,
 *       portal_token: tokenRow?.token,
 *     },
 *     'portal'
 *   );
 */

const PORTAL_BASE = 'https://portal.chajewelsjp.com';

export type PortalIntent = 'portal' | 'loyalty';

export interface CustomerForLink {
  auth_user_id: string | null;
  /** When the customer chose a portal password at /portal/setup. NULL = none. */
  portal_password_at?: string | null;
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

/** True when a built portal URL carries a token (and so opens the PIN gate). */
export function isTokenLink(url: string): boolean {
  return url.includes('?token=');
}

/**
 * Build the portal URL for a customer and intent. See the file header for
 * the rule and why it keys on portal_password_at.
 *
 * The caller is responsible for passing only an active token; supply
 * token_expires_at to have expiry checked here.
 *
 * @param customer auth_user_id, portal_password_at and optional portal_token
 * @param intent 'portal' (default) or 'loyalty'
 * @returns Fully-qualified portal URL string
 */
export function getPortalLinkForCustomer(
  customer: CustomerForLink,
  intent: PortalIntent = 'portal',
): string {
  const path = intent === 'loyalty' ? '/loyalty' : '/portal';

  // 1. They chose a portal password → the sign-in page.
  if (customer.portal_password_at) {
    return `${PORTAL_BASE}${path}`;
  }

  // 2. A live token works whatever else is true (magic-link customers too).
  if (customer.portal_token && !tokenExpired(customer.token_expires_at)) {
    return `${PORTAL_BASE}${path}?token=${encodeURIComponent(customer.portal_token)}`;
  }

  // 3. No token, but they have a sign-in. Honours the intent.
  if (customer.auth_user_id) {
    return `${PORTAL_BASE}${path}`;
  }

  // 4. Nothing to authenticate with → /portal home regardless of intent. The
  // loyalty page requires auth to render, so token-less unauthenticated
  // visitors land at the portal home (Messenger token recovery flow). Matches
  // backend buildPortalLinkForCustomerId.
  return `${PORTAL_BASE}/portal`;
}
