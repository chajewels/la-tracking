// supabase/functions/redeem-store-credit/index.ts
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

    // Store credit is real money: it must earn loyalty points exactly like cash.
    // redeem_store_credit_atomic writes payments directly and never passes through
    // review-payment-submission, so the award must be triggered here, using the SAME
    // gates: cash -> only when the order is now completed; layaway -> only when the
    // credit landed as the downpayment. Idempotent server-side; never blocks the redemption.
    let loyaltyAward: Record<string, unknown> | null = null;
    try {
      const result = (data ?? {}) as Record<string, unknown>;
      if (result.success === true && preview !== true) {
        const isCash = cash_order_id !== null;
        const shouldAward = isCash
          ? result.new_order_status === "completed"
          : result.is_downpayment === true;

        if (shouldAward) {
          const awardBody = isCash
            ? { cash_order_id }
            : { account_id };

          const lpRes = await fetch(
            `${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              },
              body: JSON.stringify(awardBody),
            },
          );
          const lpJson = await lpRes.json().catch(() => null);
          loyaltyAward = lpRes.ok
            ? { ...(lpJson ?? { error: "no_response" }) }
            : { error: (lpJson as { error?: string } | null)?.error ?? `http_${lpRes.status}`,
                status: lpRes.status, ...(lpJson ?? {}) };
        }
      }
    } catch (loyaltyErr) {
      console.warn("[redeem-store-credit] award-loyalty-points failed (non-blocking):", loyaltyErr);
      loyaltyAward = { error: String(loyaltyErr) };
    }

    // Emit a staff bell notification for the redemption. Money movement already
    // succeeded — a failed notification must never fail or block the operation.
    try {
      const r = (data ?? {}) as Record<string, any>;
      if (r.success === true && preview !== true) {
        const symbol = r.currency === "PHP" ? "₱" : "¥";
        const applied = Number(r.amount_applied ?? 0).toLocaleString("en-US");
        const balance = Number(r.new_credit_balance ?? 0).toLocaleString("en-US");
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
          type: "store_credit_redeemed",
          title: "Store credit applied",
          body: `${name ? name + " — " : ""}${symbol}${applied} store credit applied to ${r.order_type === "cash" ? "Cash Order" : "INV"} #${r.invoice_number}${r.is_downpayment ? " as downpayment" : ""} · remaining balance ${symbol}${balance}${actorSuffix}`,
          customer_id: r.customer_id ?? null,
          invoice_number: r.invoice_number ?? null,
          metadata: data,
        });
      }
    } catch (notifyErr) {
      console.warn("[redeem-store-credit] staff_notifications insert failed (non-blocking):", notifyErr);
    }

    // Credit was SPENT in the Hub, so DEBIT Shopify's mirror by the same amount —
    // otherwise the customer could spend it again at Shopify checkout. Non-blocking.
    let shopify_sync: unknown = null;
    const r = data as any;
    if (r?.success === true && preview !== true && Number(r.amount_applied) > 0 && r.customer_id) {
      shopify_sync = await syncToShopify({
        customer_id: r.customer_id,
        direction: "debit",
        amount: Number(r.amount_applied),
        currency: r.currency,
        reason: `Store credit applied in the Hub to ${r.invoice_number ?? "an order"}`,
      });
    }

    return json({ ...(data ?? {}), loyalty_award: loyaltyAward, shopify_sync });
  } catch (e) {
    console.error("[redeem-store-credit] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
