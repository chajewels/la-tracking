import { supabase } from '@/integrations/supabase/client';

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
