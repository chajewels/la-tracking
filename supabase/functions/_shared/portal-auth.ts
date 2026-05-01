// Shared portal authentication helper for Phase A.
// Resolves a portal request to a customer_id by checking either:
//   1. session_id (from localStorage on portal.chajewelsjp.com)
//   2. token (legacy URL token, still supported indefinitely)
//
// Field-name handling: accepts both `token` and `portal_token`
// in request bodies (historical inconsistency across functions).
//
// Returns { customer_id, session_id?, source_token_id } on success.
// Throws on auth failure with a structured error message.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

export interface PortalAuthResult {
  customer_id: string;
  session_id?: string;
  source_token_id: string;
  via: 'session' | 'token';
}

export interface PortalAuthInput {
  token?: string;
  portal_token?: string;
  session_id?: string;
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
export async function resolvePortalAuth(
  supabase: ReturnType<typeof createClient>,
  input: PortalAuthInput,
): Promise<PortalAuthResult> {
  const { token, portal_token, session_id } = input;
  const effectiveToken = token || portal_token;

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
      .single();

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
      .single();

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
      .then(({ error }) => {
        if (error) console.error('Failed to update session last_used_at:', error);
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
    .eq('token', effectiveToken)
    .single();

  if (tokenErr || !tokenRow) {
    throw new Error('Invalid token');
  }

  if (!tokenRow.is_active) {
    throw new Error('Token has been revoked');
  }

  if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
    throw new Error('Token expired');
  }

  return {
    customer_id: tokenRow.customer_id,
    source_token_id: tokenRow.id,
    via: 'token',
  };
}
