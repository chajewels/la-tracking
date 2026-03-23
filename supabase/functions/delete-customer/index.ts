import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function hasPermission(supabase: any, userId: string, permissionKey: string) {
  const { data: roles, error: roleError } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleError) throw roleError;

  const roleNames = (roles ?? []).map((row: any) => row.role);
  if (roleNames.length === 0) return false;

  const { data: permissions, error: permissionError } = await supabase
    .from("role_permissions")
    .select("role, is_allowed")
    .eq("permission_key", permissionKey)
    .in("role", roleNames);
  if (permissionError) throw permissionError;

  return (permissions ?? []).some((row: any) => row.is_allowed);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing authorization");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify user
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) throw new Error("Unauthorized");

    const canDeleteCustomer = await hasPermission(supabase, user.id, "delete_customer");
    if (!canDeleteCustomer) throw new Error("You do not have permission to delete customers");

    const { customer_id } = await req.json();
    if (!customer_id) throw new Error("customer_id is required");

    // Check for linked accounts
    const { data: accounts, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, status")
      .eq("customer_id", customer_id);
    if (accErr) throw accErr;

    if (accounts && accounts.length > 0) {
      const invoices = accounts.map((a: any) => a.invoice_number).join(", ");
      throw new Error(
        `Cannot delete: customer has ${accounts.length} linked account(s) (${invoices}). Reassign or remove accounts first.`
      );
    }

    // Safe to delete — also clean up analytics
    await supabase.from("customer_analytics").delete().eq("customer_id", customer_id);
    const { error: delErr } = await supabase.from("customers").delete().eq("id", customer_id);
    if (delErr) throw delErr;

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
