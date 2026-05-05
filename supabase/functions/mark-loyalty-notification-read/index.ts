// mark-loyalty-notification-read — Phase 4
//
// Customer-facing endpoint that flips loyalty_notification_recipients.is_read
// for one notification (mode='single') or every unread row for the member
// (mode='all'). Token-auth gated via resolvePortalAuth (Phase A).
//
// Idempotent: marking an already-read row succeeds silently.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestBody {
  portal_token?: string;
  token?: string;
  session_id?: string;
  mode?: string;
  notification_id?: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = (await req.json().catch(() => null)) as RequestBody | null;
    if (!body) return json({ error: "invalid_body" }, 400);

    if (body.mode !== "single" && body.mode !== "all") {
      return json({ error: "validation_failed", detail: "mode must be 'single' or 'all'" }, 400);
    }
    if (body.mode === "single") {
      if (!body.notification_id || !UUID_RE.test(body.notification_id)) {
        return json(
          { error: "validation_failed", detail: "notification_id required and must be a valid UUID" },
          400,
        );
      }
    }

    // Auth — token, session_id, or Bearer JWT; resolvePortalAuth
    // handles missing-credentials. authHeader comes from the HTTP
    // Authorization header, NOT from the JSON body.
    let auth;
    try {
      auth = await resolvePortalAuth(supabase, {
        token: body.token,
        portal_token: body.portal_token,
        session_id: body.session_id,
        authHeader: req.headers.get('Authorization'),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "auth_failed";
      return json({ error: "auth_failed", detail: msg }, 401);
    }

    // Resolve customer → loyalty member
    const { data: member, error: memberErr } = await supabase
      .from("loyalty_members")
      .select("id")
      .eq("customer_id", auth.customer_id)
      .maybeSingle();

    if (memberErr) {
      return json({ error: "member_lookup_failed", detail: memberErr.message }, 500);
    }
    if (!member) {
      return json({ error: "not_enrolled", detail: "customer is not a loyalty member" }, 404);
    }

    const nowIso = new Date().toISOString();

    if (body.mode === "single") {
      // Flip only when currently unread; matched=0 if already read or not a recipient.
      const { data: updated, error: upErr } = await supabase
        .from("loyalty_notification_recipients")
        .update({ is_read: true, read_at: nowIso })
        .eq("notification_id", body.notification_id)
        .eq("member_id", member.id)
        .eq("is_read", false)
        .select("id");

      if (upErr) {
        return json({ error: "update_failed", detail: upErr.message }, 500);
      }

      const wasUnread = (updated ?? []).length > 0;
      return json({
        success: true,
        notification_id: body.notification_id,
        already_read: !wasUnread,
      });
    }

    // mode === 'all'
    const { data: updated, error: upErr } = await supabase
      .from("loyalty_notification_recipients")
      .update({ is_read: true, read_at: nowIso })
      .eq("member_id", member.id)
      .eq("is_read", false)
      .select("id");

    if (upErr) {
      return json({ error: "update_failed", detail: upErr.message }, 500);
    }

    return json({
      success: true,
      updated_count: (updated ?? []).length,
    });
  } catch (err: any) {
    console.error("[mark-loyalty-notification-read] unexpected error:", err);
    return json({ error: err?.message || "internal_error" }, 500);
  }
});
