import { requireAuth, requirePermission } from "../_shared/handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Every call is authenticated and needs manage_team (admin; or a user
    // override — CLAUDE.md permission resolution order). There is NO bootstrap
    // mode any more: it skipped all checks when user_roles counted 0, and a
    // FAILED count read as 0 too, so a database hiccup opened team creation
    // (incl. role 'admin') to anyone. Lovable scan 2026-10-01; removed
    // 2026-10-03. The first admin of a new project is created in SQL, never
    // through this endpoint. No service-role path: no cron or internal caller.
    const ctx = await requireAuth(req);
    if (ctx instanceof Response) return ctx;
    const denied = await requirePermission(ctx, "manage_team");
    if (denied) return denied;
    const supabaseAdmin = ctx.supabase;
    const callerId: string = ctx.user!.id;

    const body = await req.json();
    const { action } = body;

    // Password reset action
    if (action === "reset_password") {
      const { user_id, password } = body;
      if (!user_id || !password) {
        return new Response(JSON.stringify({ error: "Missing user_id or password" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, { password });
      if (error) throw error;
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Deactivate / reactivate team member
    if (action === "deactivate" || action === "reactivate") {
      const { user_id } = body;
      if (!user_id) {
        return new Response(JSON.stringify({ error: "Missing user_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const deactivating = action === "deactivate";
      if (deactivating && user_id === callerId) {
        return new Response(JSON.stringify({ error: "You cannot deactivate your own account." }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const { error: profileErr } = await supabaseAdmin
        .from("profiles")
        .update({ status: deactivating ? "inactive" : "active" })
        .eq("user_id", user_id);
      if (profileErr) throw profileErr;

      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
        ban_duration: deactivating ? "876000h" : "none",
      });
      if (banErr) throw banErr;

      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Default: create team member
    const { email, password, full_name, role } = body;
    if (!email || !password || !full_name || !role) {
      return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Create auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, is_team_member: true },
    });
    if (authError) throw authError;

    // Assign role
    await supabaseAdmin.from("user_roles").insert({ user_id: authData.user.id, role });

    return new Response(JSON.stringify({ success: true, user_id: authData.user.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
