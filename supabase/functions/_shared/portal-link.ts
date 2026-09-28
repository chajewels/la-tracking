// Shared portal link builder.
//
// THE RULE (2026-09-28 — identical in the frontend twin src/lib/portal-link.ts):
//   1. portal_password_at set                → bare URL (sign-in), intent honoured
//   2. else a live (active, unexpired) token → token URL, intent honoured
//   3. else auth_user_id set                 → bare URL, intent honoured
//   4. else                                  → https://portal.chajewelsjp.com/portal
//
// WHY portal_password_at AND NOT auth_user_id. auth_user_id does NOT mean "has
// a portal password". The storefront signs customers in by MAGIC LINK and
// website POST /auth/customer sets auth_user_id on any storefront sign-in, so a
// token customer who only used the storefront is "linked" without ever choosing
// a password. Supabase also stores a random encrypted_password for OTP-created
// users, so auth.users.encrypted_password cannot tell them apart. So the Hub
// keeps its own flag: customers.portal_password_at, backfilled on 2026-09-28
// for all 138 linked customers (every login created before the storefront
// magic link existed, 2026-09-10, came from /portal/setup; see
// 20261010310000) and written from then on by setup-customer-account and by
// resolvePortalAuth Path 0 on any password sign-in (_shared/portal-auth.ts).
//
// History: before 2026-09-15 auth_user_id won, which sent magic-link customers
// to a password form they did not have. PR #70/#71 then made any live token
// win — but setting a password never retires the token, so password customers
// kept getting token links (and the PIN gate). The password marker now wins; a
// live token still wins over a bare auth_user_id. A token URL resolves the
// customer from the token row alone (resolvePortalAuth Path 2).
//
// PIN LINE: every token link opens the portal PIN gate, so a message shows the
// PIN line iff the built URL is a token URL (isTokenLink) and a PIN exists —
// never keyed on auth_user_id.
//
// Exports:
//   1. getPortalLinkForCustomer (pure) — caller already has auth_user_id,
//      portal_password_at and (optionally) the token.
//   2. buildPortalLinkForCustomerId (async) — caller has only customerId.
//   3. isTokenLink (pure) — for the PIN-line rule.
//
// Both builders support 'portal' (default) and 'loyalty' intents:
//   - portal:  https://portal.chajewelsjp.com/portal[?token=...]
//   - loyalty: https://portal.chajewelsjp.com/loyalty[?token=...]

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const PORTAL_BASE = 'https://portal.chajewelsjp.com';

export type PortalIntent = 'portal' | 'loyalty';

export interface CustomerForLink {
  auth_user_id: string | null;
  /** When the customer chose a portal password at /portal/setup. NULL = none. */
  portal_password_at?: string | null;
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

/** True when a built portal URL carries a token (and so opens the PIN gate). */
export function isTokenLink(url: string): boolean {
  return url.includes('?token=');
}

/**
 * Pure function: builds the portal URL for a customer and intent. See the
 * file header for the rule and why it keys on portal_password_at.
 *
 * The caller is responsible for passing only an active token; supply
 * token_expires_at to have expiry checked here. For DB-backed resolution use
 * buildPortalLinkForCustomerId.
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
  // visitors land at the portal home (Messenger token recovery flow).
  return `${PORTAL_BASE}/portal`;
}

/**
 * Async wrapper: reads customers.auth_user_id + portal_password_at FIRST,
 * then (only if no password) the customer's active portal token, and builds
 * the URL by the same rule as getPortalLinkForCustomer.
 *
 * Use this when the caller has only a customer_id. For callers that
 * already have customer data loaded, prefer getPortalLinkForCustomer.
 *
 * @param supabase Supabase client with service_role permissions
 * @param customerId UUID of the customer
 * @param intent 'portal' (default) or 'loyalty'
 * @returns Fully-qualified portal URL string. Never throws: if the customer
 *          lookup fails the token is still tried, then the bare URL.
 */
export async function buildPortalLinkForCustomerId(
  supabase: any,
  customerId: string,
  intent: PortalIntent = 'portal',
): Promise<string> {
  const path = intent === 'loyalty' ? '/loyalty' : '/portal';

  // 1. Who is this customer? A portal password decides it outright.
  const { data: customer, error: customerErr } = await supabase
    .from('customers')
    .select('auth_user_id, portal_password_at')
    .eq('id', customerId)
    .single() as {
      data: { auth_user_id: string | null; portal_password_at: string | null } | null;
      error: unknown;
    };

  if (customerErr || !customer) {
    console.error('buildPortalLinkForCustomerId: customer lookup failed', {
      customerId, error: customerErr,
    });
  } else if (customer.portal_password_at) {
    return `${PORTAL_BASE}${path}`;
  }

  // 2. No password: a live token wins. The filter does the work that matters:
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

  // Defensive fallback — the customer lookup failed and there is no token.
  // Never throw, just return the bare URL (as before).
  if (customerErr || !customer) {
    return `${PORTAL_BASE}${path}`;
  }

  // 3. No token, but they have a sign-in.
  if (customer.auth_user_id) {
    return `${PORTAL_BASE}${path}`;
  }

  // 4. Neither a usable token nor a sign-in. /portal home regardless of
  // intent — the loyalty page requires auth, so token-less unauthenticated
  // visitors land at the portal home (Messenger token recovery flow).
  return `${PORTAL_BASE}/portal`;
}
