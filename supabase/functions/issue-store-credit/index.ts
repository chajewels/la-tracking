// supabase/functions/issue-store-credit/index.ts
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

    const allowed = await checkPermission(supabase, user.id, "issue_store_credit");
    if (!allowed) return json({ error: "issue_store_credit permission required" }, 403);

    const body = await req.json().catch(() => ({}));
    const customer_id = body.customer_id ?? null;
    const currency = body.currency ?? null;
    const amount = typeof body.amount === "number" ? body.amount : null;
    const notes = typeof body.notes === "string" ? body.notes.trim() : "";

    if (!customer_id) return json({ error: "customer_id is required" }, 400);
    if (currency !== "JPY" && currency !== "PHP") {
      return json({ error: "currency must be JPY or PHP" }, 400);
    }
    if (amount === null || !(amount > 0)) {
      return json({ error: "amount must be greater than 0" }, 400);
    }
    if (notes.length < 3) {
      return json({ error: "notes (reason) is required" }, 400);
    }

    // Manual admin issuance only. Cancellation-sourced credit is issued by the
    // reversal flow, never by this endpoint.
    const { data, error } = await supabase.rpc("issue_store_credit_atomic", {
      p_customer_id: customer_id,
      p_currency: currency,
      p_amount: amount,
      p_source_type: "manual_admin",
      p_source_account_id: null,
      p_source_cash_order_id: null,
      p_user_id: user.id,
      p_user_email: user.email ?? null,
      p_notes: notes,
    });

    if (error) {
      console.error("[issue-store-credit] rpc error:", error);
      return json({ error: error.message ?? "issue_store_credit_atomic failed" }, 400);
    }

    return json(data ?? { error: "no_response" });
  } catch (e) {
    console.error("[issue-store-credit] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
