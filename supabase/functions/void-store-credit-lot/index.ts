// supabase/functions/void-store-credit-lot/index.ts
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

    const allowed = await checkPermission(supabase, user.id, "void_store_credit");
    if (!allowed) return json({ error: "void_store_credit permission required" }, 403);

    const body = await req.json().catch(() => ({}));
    const lot_id = body.lot_id ?? null;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";

    if (!lot_id) return json({ error: "lot_id is required" }, 400);
    if (reason.length < 3) return json({ error: "A void reason is required" }, 400);

    // Voids only the UNSPENT remainder of a lot. Any consumed portion is already a
    // real payment on a real order and must be reversed there, not here.
    const { data, error } = await supabase.rpc("void_store_credit_lot_atomic", {
      p_lot_id: lot_id,
      p_reason: reason,
      p_user_id: user.id,
      p_user_email: user.email ?? null,
    });

    if (error) {
      console.error("[void-store-credit-lot] rpc error:", error);
      return json({ error: error.message ?? "void_store_credit_lot_atomic failed" }, 400);
    }

    // Bell notification. Never blocks the void.
    try {
      const r = (data ?? {}) as Record<string, any>;
      if (r.success === true) {
        const symbol = r.currency === "PHP" ? "₱" : "¥";
        const amt = Number(r.voided_amount ?? 0).toLocaleString("en-US");
        const name = await resolveCustomerName(supabase, r.customer_id);
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
          type: "store_credit_voided",
          title: "Store credit voided",
          body: `${name ? name + " — " : ""}${symbol}${amt} store credit voided · ${reason}${actorSuffix}`,
          customer_id: r.customer_id ?? null,
          invoice_number: null,
          metadata: r,
        });
      }
    } catch (notifyErr) {
      console.warn("[void-store-credit-lot] notification failed (non-blocking):", notifyErr);
    }

    // A voided lot must be removed from Shopify too — DEBIT the mirror. Non-blocking.
    let shopify_sync: unknown = null;
    const v = data as any;
    if (v?.success === true && Number(v.voided_amount) > 0 && v.customer_id) {
      shopify_sync = await syncToShopify({
        customer_id: v.customer_id,
        direction: "debit",
        amount: Number(v.voided_amount),
        currency: v.currency,
        lot_id: v.lot_id,
        reason: `Store credit lot voided in the Hub: ${reason}`,
      });
    }

    return json({ ...(data ?? {}), shopify_sync });
  } catch (e) {
    console.error("[void-store-credit-lot] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
