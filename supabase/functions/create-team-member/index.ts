import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify caller is admin
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const { data: { user } } = await supabaseAdmin.auth.getUser(authHeader.replace("Bearer ", ""));
      if (user) {
        const { data: roles } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", user.id);
        const isAdmin = roles?.some((r: any) => r.role === "admin");
        if (!isAdmin) {
          // Allow if no users exist yet (bootstrap)
          const { count } = await supabaseAdmin.from("user_roles").select("*", { count: "exact", head: true });
          if ((count ?? 0) > 0) {
            return new Response(JSON.stringify({ error: "Admin only" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
      }
    }

    const { email, password, full_name, role } = await req.json();
    if (!email || !password || !full_name || !role) {
      return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Create auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
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
