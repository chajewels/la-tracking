import { supabase } from '@/integrations/supabase/client';
import { getPortalSessionId } from '@/lib/portal-session';

/**
 * Build the Authorization headers for a customer portal API call,
 * branching on whether the customer is in token-auth or session-auth mode.
 *
 * - Token-auth (portalToken truthy): returns an empty object. The
 *   token continues to be sent via the request body or URL param
 *   (existing pattern); no Authorization header is needed.
 * - Session-auth (portalToken null/undefined): looks up the active
 *   Supabase Auth session and returns
 *   `{ Authorization: \`Bearer <jwt>\` }` so the backend's
 *   resolvePortalAuth helper (Phase B Step 3f-1) can validate via
 *   Path 0.
 *
 * Throws `Error('Not authenticated')` when neither auth source is
 * available (no token AND no live session).
 *
 * Shared between CustomerPortal and LoyaltyPortal so the dual-auth
 * branching lives in exactly one place.
 */
export async function getPortalAuthHeaders(portalToken: string | null | undefined): Promise<Record<string, string>> {
  if (portalToken) {
    return {};
  }
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated');
  }
  return { Authorization: `Bearer ${session.access_token}` };
}

/**
 * Portal auth fields for a JSON body (PIN enforcement, 2026-10-03). A link
 * token alone is refused by the server with `pin_required`; the PIN session
 * id issued by verify-portal-pin is what authenticates. Both are sent: the
 * server resolves `session_id` first (Path 1) and the token only identifies
 * the link. For a signed-in (password) customer both are empty and the
 * Bearer header from getPortalAuthHeaders() carries the auth.
 */
export function portalAuthBody(portalToken: string | null | undefined): {
  portal_token?: string;
  token?: string;
  session_id?: string;
} {
  if (!portalToken) return {};
  const sid = getPortalSessionId(portalToken);
  return { portal_token: portalToken, token: portalToken, ...(sid ? { session_id: sid } : {}) };
}
