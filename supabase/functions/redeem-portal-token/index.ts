// POST /functions/v1/redeem-portal-token
//
// Request body: { token: string }
// Response: { session_id: string, customer_id: string, expires_at: string }
//
// Called by frontend portal pages on first mount when they receive
// a ?token=... URL parameter. Exchanges the URL token for a
// session_id which is then stored in localStorage on
// portal.chajewelsjp.com.
//
// The session persists across PWA installations (iOS 17.2+ copies
// localStorage to installed WebClips) and survives token rotation
// by checking customer_portal_tokens.is_active at auth time.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.7";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body = await req.json();
    const { token } = body;

    if (!token || typeof token !== 'string') {
      return new Response(
        JSON.stringify({ error: 'Token required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Validate token
    const { data: tokenRow, error: tokenErr } = await supabase
      .from('customer_portal_tokens')
      .select('id, customer_id, is_active, expires_at')
      .eq('token', token)
      .single();

    if (tokenErr || !tokenRow) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (!tokenRow.is_active) {
      return new Response(
        JSON.stringify({ error: 'Token has been revoked' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
      return new Response(
        JSON.stringify({ error: 'Token expired' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Capture user-agent and IP for audit (best-effort, not required)
    const userAgent = req.headers.get('user-agent') || null;
    const forwardedFor = req.headers.get('x-forwarded-for') || null;
    const ipAddress = forwardedFor ? forwardedFor.split(',')[0].trim() : null;

    // Create session
    const { data: session, error: sessionErr } = await supabase
      .from('customer_portal_sessions')
      .insert({
        customer_id: tokenRow.customer_id,
        source_token_id: tokenRow.id,
        user_agent: userAgent,
        ip_address: ipAddress,
      })
      .select('session_id, customer_id, expires_at')
      .single();

    if (sessionErr || !session) {
      console.error('Failed to create session:', sessionErr);
      return new Response(
        JSON.stringify({ error: 'Failed to create session' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        session_id: session.session_id,
        customer_id: session.customer_id,
        expires_at: session.expires_at,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('redeem-portal-token error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
