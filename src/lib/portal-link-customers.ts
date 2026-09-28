/**
 * Loads what the portal link rule (src/lib/portal-link.ts) needs, for every
 * customer at once: the newest live token, auth_user_id, portal_password_at
 * and the PIN (last 4 digits of the mobile). Used by the Monitoring reminder
 * list and the penalty follow-up section.
 *
 * Both selects are paged with .range() — customers is ~900 rows (2026-09-28),
 * close to PostgREST's 1000-row default cap, past which rows silently vanish.
 *
 * portal_password_at is newer than the generated types (types.ts is never
 * hand-edited; Lovable regenerates it), so the customers rows are cast here.
 */
import { supabase } from '@/integrations/supabase/client';

const PAGE_SIZE = 1000;

export interface CustomerPortalAuth {
  token: string | null;
  authUserId: string | null;
  portalPasswordAt: string | null;
  /** Last 4 digits of the mobile, or null when there are fewer than 4. */
  customerPin: string | null;
}

interface CustomerAuthRow {
  id: string;
  auth_user_id: string | null;
  portal_password_at: string | null;
  mobile_number: string | null;
}

interface TokenRow {
  customer_id: string;
  token: string;
  expires_at: string | null;
}

export function pinFromMobile(mobile: string | null | undefined): string | null {
  const digits = (mobile ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

async function fetchAllCustomers(): Promise<CustomerAuthRow[]> {
  const rows: CustomerAuthRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('customers')
      .select('id, auth_user_id, portal_password_at, mobile_number')
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as unknown as CustomerAuthRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAllActiveTokens(): Promise<TokenRow[]> {
  const rows: TokenRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('customer_portal_tokens')
      .select('customer_id, token, expires_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const page = (data ?? []) as TokenRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * customer_id → portal auth facts. A customer appears when they have a live
 * token, an auth_user_id or a portal password; anyone else has no portal
 * link to offer and is absent.
 */
export async function fetchPortalAuthByCustomer(): Promise<Map<string, CustomerPortalAuth>> {
  const [tokens, customers] = await Promise.all([fetchAllActiveTokens(), fetchAllCustomers()]);

  const byId = new Map<string, CustomerAuthRow>();
  for (const c of customers) byId.set(c.id, c);

  const now = Date.now();
  const map = new Map<string, CustomerPortalAuth>();
  // Tokens arrive newest first, so the first live one per customer wins.
  for (const t of tokens) {
    if (map.has(t.customer_id)) continue;
    if (t.expires_at && Date.parse(t.expires_at) < now) continue;
    const c = byId.get(t.customer_id);
    map.set(t.customer_id, {
      token: t.token,
      authUserId: c?.auth_user_id ?? null,
      portalPasswordAt: c?.portal_password_at ?? null,
      customerPin: pinFromMobile(c?.mobile_number),
    });
  }
  for (const c of customers) {
    if (map.has(c.id)) continue;
    if (!c.auth_user_id && !c.portal_password_at) continue;
    map.set(c.id, {
      token: null,
      authUserId: c.auth_user_id,
      portalPasswordAt: c.portal_password_at,
      customerPin: pinFromMobile(c.mobile_number),
    });
  }
  return map;
}
