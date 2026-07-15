// supabase/functions/issue-store-credit/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";
import { corsHeaders } from "../_shared/cors.ts";

async function resolveCustomerName(
  supabase: any,
  customerId: string | null | undefined,
): Promise<string | null> {
  if (!customerId) return null;
  try {
    const { data } = await supabase
      .from("customers")
      .select("full_name")
      .eq("id", customerId)
      .maybeSingle();
    return (data?.full_name as string) ?? null;
  } catch {
    return null;
  }
}

// Mirror a Hub store-credit movement into Shopify (single source of truth = Hub).
// Never throws; a sync failure must never block the committed Hub operation.
async function syncToShopify(body: Record<string, unknown>): Promise<unknown> {
  try {
    const res = await fetch(
      `${Deno.env.get("SUPABASE_URL")}/functions/v1/sync-store-credit-to-shopify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify(body),
      },
    );
    const out = await res.json().catch(() => null);
    console.log("[sync-to-shopify]", JSON.stringify(out));
    return out;
  } catch (e) {
    console.warn("[sync-to-shopify] failed (non-blocking):", e);
    return { success: false, error: String((e as Error)?.message ?? e) };
  }
}

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

    // Emit a staff bell notification. Money movement already succeeded — a failed
    // notification must never fail or block the operation.
    try {
      const d = (data ?? {}) as Record<string, any>;
      if (d.success === true) {
        const symbol = (d.currency ?? currency) === "PHP" ? "₱" : "¥";
        const amt = Number(d.amount ?? amount).toLocaleString("en-US");
        const name = await resolveCustomerName(supabase, customer_id);
        let actorName: string | null = user.email ?? null;
        try {
          const { data: actorProfile } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("user_id", user.id)
            .maybeSingle();
          if (actorProfile?.full_name) actorName = actorProfile.full_name as string;
        } catch { /* keep email fallback */ }
        const actorSuffix = actorName ? ` · by ${actorName}` : "";
        await supabase.from("staff_notifications").insert({
          type: "store_credit_issued",
          title: "Store credit issued",
          body: `${name ? name + " — " : ""}${symbol}${amt} store credit issued (manual), expires ${new Date(d.expires_at).toLocaleDateString("en-US")}${actorSuffix}`,
          customer_id: customer_id,
          invoice_number: null,
          metadata: data,
        });
      }
    } catch (notifyErr) {
      console.warn("[issue-store-credit] staff_notifications insert failed (non-blocking):", notifyErr);
    }

    // Mirror the issuance into Shopify (credit). Non-blocking.
    let shopify_sync: unknown = null;
    if ((data as any)?.success === true) {
      shopify_sync = await syncToShopify({
        customer_id,
        direction: "credit",
        amount: Number((data as any).amount),
        currency: (data as any).currency,
        lot_id: (data as any).lot_id,
        expires_at: (data as any).expires_at,
        reason: "Hub store credit issued (manual)",
      });
    }

    return json({ ...(data ?? {}), shopify_sync });
  } catch (e) {
    console.error("[issue-store-credit] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
