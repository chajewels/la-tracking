// Portal session helper for Phase A token → session redemption.
// Stores the session in localStorage on the customer portal origin
// (portal.chajewelsjp.com) so installed PWAs survive token rotation
// and reinstall.

const SESSION_KEY = 'cha_portal_session';

export interface PortalSession {
  session_id: string;
  customer_id: string;
  expires_at: string; // ISO date string
  redeemed_at: string; // ISO date string
}

/**
 * Read the current portal session from localStorage.
 * Returns null if absent, malformed, or expired.
 * Auto-clears expired sessions.
 */
export function getPortalSession(): PortalSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PortalSession;
    if (!parsed.session_id || !parsed.customer_id || !parsed.expires_at) {
      return null;
    }
    if (new Date(parsed.expires_at) < new Date()) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setPortalSession(session: PortalSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // localStorage unavailable (private browsing on some browsers,
    // or quota exceeded). Fail silently — caller falls back to
    // URL token auth.
  }
}

export function clearPortalSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // fail silently
  }
}

/**
 * Exchange a portal URL token for a session_id.
 * Calls the redeem-portal-token edge function and persists the
 * resulting session to localStorage.
 *
 * Returns the new session on success, null on any failure.
 */
export async function redeemPortalToken(
  token: string,
  supabaseUrl: string,
  anonKey: string,
): Promise<PortalSession | null> {
  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/redeem-portal-token`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
        },
        body: JSON.stringify({ token }),
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.session_id || !data?.customer_id || !data?.expires_at) {
      return null;
    }
    const session: PortalSession = {
      session_id: data.session_id,
      customer_id: data.customer_id,
      expires_at: data.expires_at,
      redeemed_at: new Date().toISOString(),
    };
    setPortalSession(session);
    return session;
  } catch {
    return null;
  }
}
