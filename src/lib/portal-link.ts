/**
 * Frontend portal link builder for Phase B email/password auth.
 *
 * Returns the appropriate portal URL for a customer based on
 * whether they have set up email/password authentication:
 *   - auth_user_id IS NULL  → token-bearing URL (legacy auth)
 *   - auth_user_id NOT NULL → bare URL (email/password auth)
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

  // Migrated customer → bare URL (email/password auth)
  if (customer.auth_user_id) {
    return `${PORTAL_BASE}${path}`;
  }

  // Non-migrated customer with token → token URL (legacy auth)
  if (customer.portal_token) {
    return `${PORTAL_BASE}${path}?token=${encodeURIComponent(customer.portal_token)}`;
  }

  // Non-migrated customer without token → /portal home regardless
  // of intent. The loyalty page requires auth to render, so we
  // route token-less unauthenticated visitors to the portal home
  // (Messenger token recovery flow). Matches backend
  // buildPortalLinkForCustomerId fallback behavior.
  return `${PORTAL_BASE}/portal`;
}
