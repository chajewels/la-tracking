// change-payment-plan — the ONLY path that changes layaway_accounts.payment_plan_months
// after creation. Thin wrapper over public.change_payment_plan_atomic (all rules live
// in SQL). Body: { account_id, new_months, reason?, apply? }. apply=false (default)
// returns a preview and writes nothing; apply=true writes, then reconciles.
// Gate: permission key 'change_payment_plan' (admin + per-user override).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function callReconcile(accountId: string) {
  try {
    const _res = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/reconcile-account`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ account_id: accountId }),
      },
    );
    if (!_res.ok) {
      const _t = await _res.text().catch(() => "<no body>");
      console.error(`[change-payment-plan] reconcile-account failed (${_res.status}) for ${accountId}: ${_t}`);
    }
  } catch (e) {
    console.warn(`[change-payment-plan] reconcile call failed for ${accountId}:`, e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const accountId = typeof body.account_id === "string" ? body.account_id : "";
    const newMonths = Number(body.new_months);
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const apply = body.apply === true;
    if (!accountId || !Number.isInteger(newMonths)) {
      return json({ error: "account_id and new_months are required" }, 400);
    }
    if (apply && !reason) return json({ error: "A reason is required." }, 400);

    const allowed = await checkPermission(supabase, user.id, "change_payment_plan");
    if (!allowed) return json({ error: "change_payment_plan permission required" }, 403);

    const { data, error } = await supabase.rpc("change_payment_plan_atomic", {
      p_account_id: accountId,
      p_new_months: newMonths,
      p_user_id: user.id,
      p_reason: apply ? reason : (reason || "preview"),
      p_apply: apply,
    });
    if (error) {
      console.error("[change-payment-plan] rpc failed:", error);
      return json({ error: error.message || "Plan change failed" }, 500);
    }
    const result = (data ?? null) as Record<string, unknown> | null;
    if (!result) return json({ error: "No result from change_payment_plan_atomic" }, 500);
    if (result.error) return json(result, 400);

    if (apply && result.success === true) {
      await callReconcile(accountId);
    }
    return json(result);
  } catch (err) {
    console.error("[change-payment-plan] unexpected error:", err);
    return json({ error: (err as Error)?.message || "internal_error" }, 500);
  }
});
