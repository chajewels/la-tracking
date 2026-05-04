// Shared portal link builder for Phase B email/password auth.
//
// Returns the appropriate portal URL for a customer based on
// whether they have set up email/password authentication:
//   - auth_user_id IS NULL  → token-bearing URL (legacy auth)
//   - auth_user_id NOT NULL → bare URL (email/password auth)
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

  // Non-migrated customer without token → bare URL fallback
  // (portal will prompt for token via Messenger or other recovery)
  return `${PORTAL_BASE}${path}`;
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
  supabase: ReturnType<typeof createClient>,
  customerId: string,
  intent: PortalIntent = 'portal',
): Promise<string> {
  const path = intent === 'loyalty' ? '/loyalty' : '/portal';

  // Fetch customer auth state
  const { data: customer, error: customerErr } = await supabase
    .from('customers')
    .select('auth_user_id')
    .eq('id', customerId)
    .single();

  if (customerErr || !customer) {
    console.error('buildPortalLinkForCustomerId: customer lookup failed', {
      customerId, error: customerErr,
    });
    // Defensive fallback — never throw, just return bare URL
    return `${PORTAL_BASE}${path}`;
  }

  // Migrated customer → bare URL, no token fetch needed
  if (customer.auth_user_id) {
    return `${PORTAL_BASE}${path}`;
  }

  // Non-migrated → fetch active token
  const { data: tokenRow } = await supabase
    .from('customer_portal_tokens')
    .select('token')
    .eq('customer_id', customerId)
    .eq('is_active', true)
    .maybeSingle();

  if (tokenRow?.token) {
    return `${PORTAL_BASE}${path}?token=${encodeURIComponent(tokenRow.token)}`;
  }

  // Fallback if no active token
  return `${PORTAL_BASE}${path}`;
}
