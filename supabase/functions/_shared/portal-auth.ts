// Shared portal authentication helper for Phase A + Phase B.
// Resolves a portal request to a customer_id by checking, in order:
//   0. Bearer JWT in Authorization header (Phase B email/password)
//   1. session_id (from localStorage on portal.chajewelsjp.com)
//   2. token (legacy URL token, still supported indefinitely)
//
// Path 0 is tried only if authHeader is provided. JWT validation
// failures (malformed, expired) silently fall through to Path 1/2.
// JWT-valid-but-no-linked-customer is a hard error — does NOT fall
// through (data integrity issue).
//
// Field-name handling: accepts both `token` and `portal_token`
// in request bodies (historical inconsistency across functions).
//
// Returns { customer_id, session_id?, source_token_id?, via } on
// success. source_token_id is undefined for the JWT path.
// Throws on auth failure with a structured error message.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

export interface PortalAuthResult {
  customer_id: string;
  session_id?: string;
  source_token_id?: string;
  via: 'session' | 'token' | 'jwt';
}

export interface PortalAuthInput {
  token?: string;
  portal_token?: string;
  session_id?: string;
  authHeader?: string | null;
}

/**
 * Resolves portal authentication from either a session_id or a token.
 *
 * Priority order:
 *   1. If session_id present → validate against customer_portal_sessions
 *      (JOIN to customer_portal_tokens.is_active for revocation check)
 *   2. If token (or portal_token) present → validate against
 *      customer_portal_tokens.is_active = true
 *
 * On session validation success: updates last_used_at to now().
 *
 * @param supabase Supabase client with service_role permissions
 * @param input Object with token, portal_token, or session_id
 * @returns PortalAuthResult with customer_id and metadata
 * @throws Error with structured message if auth fails
 */
/**
 * Records that the portal was reached, on every successful authentication.
 *
 * WHY THIS EXISTS. Until 2026-09-15 nothing recorded a portal authentication
 * anywhere. Every "does this customer use the portal" figure had to be built
 * from customers taking an ACTION that happened to leave a row — a payment
 * submission, an edit, a redemption — so a read-only visit (checking a balance,
 * reading a schedule, the commonest reason to open the portal) was invisible.
 * That made the 2026-09-15 investigation's 153 "active" customers a FLOOR, not
 * a count, and it is why the mint-vs-use expiry decision was deferred rather
 * than taken: it cannot honestly be answered against a floor.
 *
 * TWO PLACES, because they answer two different questions:
 *   customer_portal_tokens.last_used_at  does THIS TOKEN get used — the
 *                                        deferred lifecycle question
 *   customers.portal_last_seen_at        does THIS CUSTOMER use the portal at
 *                                        all, by any route. The JWT path has no
 *                                        token row, and 76 of 632 token-holders
 *                                        also hold a password; without this
 *                                        they would read as "never uses it".
 *
 * FIRE AND FORGET, matching the session-path write below that has always
 * worked this way: the customer's response never waits on it, and a failure
 * here must never cost anybody their portal.
 *
 * THROTTLED TO ONE WRITE PER HOUR, in the WHERE clause so it costs no extra
 * read. Eleven edge functions call resolvePortalAuth, so one customer opening
 * the portal and submitting a payment authenticates about four times; without
 * the throttle that is four writes for one visit. The side effect is that
 * use_count counts SESSIONS rather than page loads, which is the more useful
 * number anyway.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function recordPortalSeen(supabase: any, opts: { tokenId?: string | null; customerId: string }): void {
  // ONE RPC, not two PostgREST updates: the counter needs an atomic
  // `use_count + 1`, which .update() cannot express, and the throttle belongs
  // in the WHERE clause beside it. One round trip, no read.
  supabase
    .rpc('record_portal_seen', {
      p_token_id: opts.tokenId ?? null,
      p_customer_id: opts.customerId,
    })
    .then(({ error }: { error: any }) => {
      if (error) console.error('Failed to record portal last-seen:', error);
    });
}

export async function resolvePortalAuth(
  supabase: any,
  input: PortalAuthInput,
): Promise<PortalAuthResult> {
  const { token, portal_token, session_id, authHeader } = input;
  const effectiveToken = token || portal_token;

  // Path 0 — Bearer JWT authentication (Phase B email/password).
  // Tried first if authHeader provided. JWT validation failures
  // silently fall through to Path 1/2. JWT valid but no linked
  // customer is a hard error.
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) {
      const jwt = match[1].trim();
      const { data: userData, error: userErr } =
        await supabase.auth.getUser(jwt);
      if (!userErr && userData?.user) {
        const authUserId = userData.user.id;
        const { data: customer, error: custErr } = await supabase
          .from('customers')
          .select('id')
          .eq('auth_user_id', authUserId)
          .maybeSingle() as { data: { id: string } | null; error: any };
        if (custErr) {
          console.error('JWT customer lookup failed:', custErr);
          throw new Error('No customer linked to this account');
        }
        if (!customer) {
          throw new Error('No customer linked to this account');
        }
        // No token row on this path — the customers column is the only place
        // a password sign-in can be recorded, and 12% of token-holders use it.
        recordPortalSeen(supabase, { customerId: customer.id });
        return {
          customer_id: customer.id,
          source_token_id: undefined,
          via: 'jwt',
        };
      }
      // JWT validation failed — fall through to Path 1/2
    }
    // Authorization header present but not Bearer-shaped — fall through
  }

  if (!effectiveToken && !session_id) {
    throw new Error('Authentication required: missing session_id or token');
  }

  // Path 1 — session_id authentication (Phase A)
  if (session_id) {
    // Query 1: validate session exists and not expired
    const { data: session, error: sessionErr } = await supabase
      .from('customer_portal_sessions')
      .select('session_id, customer_id, source_token_id, expires_at')
      .eq('session_id', session_id)
      .single() as { data: { session_id: string; customer_id: string; source_token_id: string; expires_at: string } | null; error: any };

    if (sessionErr || !session) {
      console.error('Session lookup failed:', sessionErr);
      throw new Error('Invalid or expired session');
    }

    // Check expiry
    if (new Date(session.expires_at) < new Date()) {
      throw new Error('Session expired');
    }

    // Query 2: validate source token is still active
    const { data: token, error: tokenErr } = await supabase
      .from('customer_portal_tokens')
      .select('id, is_active')
      .eq('id', session.source_token_id)
      .single() as { data: { id: string; is_active: boolean } | null; error: any };

    if (tokenErr || !token) {
      console.error('Token lookup failed:', tokenErr);
      throw new Error('Source token not found');
    }

    if (!token.is_active) {
      throw new Error('Source token has been revoked');
    }

    // Update last_used_at (fire and forget — don't block on this)
    supabase
      .from('customer_portal_sessions')
      .update({ last_used_at: new Date().toISOString() })
      .eq('session_id', session_id)
      .then(({ error }: { error: any }) => {
        if (error) console.error('Failed to update session last_used_at:', error);
      });

    // The session's own last_used_at above tracks the SESSION. This records
    // the token behind it and the customer, which is what the expiry question
    // and the warning list read.
    recordPortalSeen(supabase, {
      tokenId: session.source_token_id,
      customerId: session.customer_id,
    });

    return {
      customer_id: session.customer_id,
      session_id: session.session_id,
      source_token_id: session.source_token_id,
      via: 'session',
    };
  }

  // Path 2 — token authentication (legacy, additive)
  const { data: tokenRow, error: tokenErr } = await supabase
    .from('customer_portal_tokens')
    .select('id, customer_id, is_active, expires_at')
    .eq('token', effectiveToken!)
    .single() as { data: { id: string; customer_id: string; is_active: boolean; expires_at: string | null } | null; error: any };

  if (tokenErr || !tokenRow) {
    throw new Error('Invalid token');
  }

  if (!tokenRow.is_active) {
    throw new Error('Token has been revoked');
  }

  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
    throw new Error('Token expired');
  }

  recordPortalSeen(supabase, { tokenId: tokenRow.id, customerId: tokenRow.customer_id });

  return {
    customer_id: tokenRow.customer_id,
    source_token_id: tokenRow.id,
    via: 'token',
  };
}
