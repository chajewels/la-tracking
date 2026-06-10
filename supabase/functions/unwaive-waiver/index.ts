import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await anonClient.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;
    const userEmail = userData.user.email || '';
    const supabase = createClient(supabaseUrl, serviceKey);

    // ── Permission check via role_permissions matrix ─────────────────────────
    const allowed = await checkPermission(supabase, userId, "manage_waivers");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Forbidden: manage_waivers permission required" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Parse body ────────────────────────────────────────────────────────────
    const body = await req.json() as { waiver_id?: string };
    if (!body.waiver_id) {
      return new Response(JSON.stringify({ error: "waiver_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Call atomic RPC ───────────────────────────────────────────────────────
    const { data: result, error: rpcErr } = await supabase.rpc("unwaive_penalty_atomic", {
      p_waiver_id: body.waiver_id,
      p_user_id: userId,
      p_user_email: userEmail,
    });

    if (rpcErr) {
      console.error("[unwaive-waiver] RPC error:", rpcErr);
      return new Response(JSON.stringify({ error: rpcErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Map RPC error_code to HTTP status
    if (result?.error_code) {
      const statusMap: Record<string, number> = {
        waiver_not_found: 404,
        waiver_not_approved: 400,
        penalty_not_found: 404,
        account_terminal_state: 400,
      };
      const status = statusMap[result.error_code] || 500;
      return new Response(JSON.stringify({ error: result.error_code }), {
        status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[unwaive-waiver] error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
