// supabase/functions/cancel-cash-order/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const { data: { user }, error: authError } =
      await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const allowed = await checkPermission(supabase, user.id, "cancel_cash_order");
    if (!allowed) return json({ error: "cancel_cash_order permission required" }, 403);

    const body = await req.json().catch(() => ({}));
    const cash_order_id = body.cash_order_id ?? null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const preview = body.preview === true;

    if (!cash_order_id) return json({ error: "cash_order_id is required" }, 400);
    if (!preview && reason.length < 3) {
      return json({ error: "A cancellation reason is required" }, 400);
    }

    // CASH ORDERS ONLY. Layaway cancellation never auto-issues store credit
    // (DP is non-refundable; 3-month non-payment = forfeiture). Layaway store
    // credit is manual-only via issue-store-credit.
    const { data, error } = await supabase.rpc("cancel_cash_order_atomic", {
      p_cash_order_id: cash_order_id,
      p_reason: reason,
      p_user_id: user.id,
      p_user_email: user.email ?? null,
      p_preview: preview,
    });

    if (error) {
      console.error("[cancel-cash-order] rpc error:", error);
      return json({ error: error.message ?? "cancel_cash_order_atomic failed" }, 400);
    }

    return json(data ?? { error: "no_response" });
  } catch (e) {
    console.error("[cancel-cash-order] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
