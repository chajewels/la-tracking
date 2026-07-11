// supabase/functions/redeem-store-credit/index.ts
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

    const allowed = await checkPermission(supabase, user.id, "redeem_store_credit");
    if (!allowed) return json({ error: "redeem_store_credit permission required" }, 403);

    const body = await req.json().catch(() => ({}));
    const account_id = body.account_id ?? null;
    const cash_order_id = body.cash_order_id ?? null;
    const amount = typeof body.amount === "number" ? body.amount : null;
    const preview = body.preview === true;

    if ((account_id === null) === (cash_order_id === null)) {
      return json({ error: "Provide exactly one of account_id or cash_order_id" }, 400);
    }

    const { data, error } = await supabase.rpc("redeem_store_credit_atomic", {
      p_customer_id: null,
      p_account_id: account_id,
      p_cash_order_id: cash_order_id,
      p_amount: amount,
      p_user_id: user.id,
      p_user_email: user.email ?? null,
      p_preview: preview,
    });

    if (error) {
      console.error("[redeem-store-credit] rpc error:", error);
      return json({ error: error.message ?? "redeem_store_credit_atomic failed" }, 400);
    }

    return json(data ?? { error: "no_response" });
  } catch (e) {
    console.error("[redeem-store-credit] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
