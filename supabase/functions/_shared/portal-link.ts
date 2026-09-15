// Shared portal link builder.
//
// A USABLE TOKEN WINS, whatever the customer's auth state (changed
// 2026-09-15). The order is:
//   1. a valid, active, unexpired token  → token-bearing URL
//   2. otherwise, auth_user_id set       → bare URL (they can sign in)
//   3. otherwise                         → /portal home
//
// IT USED TO BRANCH ON auth_user_id FIRST, and that is a trap now that the
// storefront exists. `/auth/customer` sets auth_user_id on ANY successful
// storefront sign-in, and the storefront signs customers in with a MAGIC LINK
// — so a legacy token customer who signs in there to look at their plan
// becomes "linked" without ever choosing a password. Under the old order
// every Hub email to them switched to the bare URL, which asks for a password
// they do not have. They would have been locked out by looking.
//
// Preferring the token is safe for everyone because a token URL does not care
// about auth_user_id: resolvePortalAuth Path 2 resolves the customer from the
// token row alone. A customer who also has a password loses nothing — they
// get a link that works instead of a form they could have used.
//
// Two functions exported:
//   1. getPortalLinkForCustomer (pure)
//      Caller has already fetched customer.auth_user_id and
//      (for non-migrated customers) customer.portal_token.
//
//   2. buildPortalLinkForCustomerId (async wrapper)
//      Caller has only customerId. Fetches both pieces from
//      customers + customer_portal_tokens.
//
// Both support 'portal' (default) and 'loyalty' intents:
//   - portal:  https://portal.chajewelsjp.com/portal[?token=...]
//   - loyalty: https://portal.chajewelsjp.com/loyalty[?token=...]

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const PORTAL_BASE = 'https://portal.chajewelsjp.com';

export type PortalIntent = 'portal' | 'loyalty';

export interface CustomerForLink {
  auth_user_id: string | null;
  portal_token?: string | null;
  /**
   * The token's expiry, when the caller knows it.
   *
   * `undefined` means "not supplied" and the token is trusted, which keeps
   * every existing caller behaving exactly as before. Supplying it is how a
   * caller stops having to remember the rule: an expired token is then
   * treated as no token at all, here, rather than in six call sites.
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
 * Pure function: builds the appropriate portal URL based on
 * the customer's auth state and intent.
 *
 * Rules:
 *   - If customer.auth_user_id is set → bare URL (email/password)
 *   - If null and portal_token present → token-bearing URL
 *   - If null and no token available → bare URL fallback
 *
 * The caller is responsible for ensuring portal_token is a
 * valid, non-expired, active token. This function does not
 * validate the token. For DB-backed token resolution with
 * expiry/active checks, use buildPortalLinkForCustomerId.
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
  // visitors land at the portal home (Messenger token recovery flow).
  return `${PORTAL_BASE}/portal`;
}

/**
 * Async wrapper: fetches customer.auth_user_id and the customer's
 * active portal token, then builds the URL.
 *
 * Use this when the caller has only a customer_id. For callers that
 * already have customer data loaded, prefer getPortalLinkForCustomer.
 *
 * @param supabase Supabase client with service_role permissions
 * @param customerId UUID of the customer
 * @param intent 'portal' (default) or 'loyalty'
 * @returns Fully-qualified portal URL string. Falls back to bare URL
 *          if customer lookup fails (defensive — never throws).
 */
export async function buildPortalLinkForCustomerId(
  supabase: any,
  customerId: string,
  intent: PortalIntent = 'portal',
): Promise<string> {
  const path = intent === 'loyalty' ? '/loyalty' : '/portal';

  // 1. THE TOKEN IS TRIED FIRST, for every customer. This lookup used to be
  // skipped entirely when auth_user_id was set; that is the change. The filter
  // is unchanged and still does the work that matters:
  //   - is_active = true            never offer a token Regenerate retired
  //   - newest first               when several are active, the latest wins
  //   - expires_at checked below   an expired token is treated as no token
  const { data: tokenRow } = await supabase
    .from('customer_portal_tokens')
    .select('token, expires_at')
    .eq('customer_id', customerId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle() as { data: { token: string; expires_at: string | null } | null };

  if (tokenRow?.token && !tokenExpired(tokenRow.expires_at)) {
    return `${PORTAL_BASE}${path}?token=${encodeURIComponent(tokenRow.token)}`;
  }

  // 2. No usable token. Can they sign in? Only then is the bare URL a door.
  const { data: customer, error: customerErr } = await supabase
    .from('customers')
    .select('auth_user_id')
    .eq('id', customerId)
    .single();

  if (customerErr || !customer) {
    console.error('buildPortalLinkForCustomerId: customer lookup failed', {
      customerId, error: customerErr,
    });
    // Defensive fallback — never throw, just return the bare URL
    return `${PORTAL_BASE}${path}`;
  }

  if (customer.auth_user_id) {
    return `${PORTAL_BASE}${path}`;
  }

  // 3. Neither a usable token nor a sign-in. /portal home regardless of
  // intent — the loyalty page requires auth, so token-less unauthenticated
  // visitors land at the portal home (Messenger token recovery flow).
  return `${PORTAL_BASE}/portal`;
}
