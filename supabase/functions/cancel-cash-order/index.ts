// supabase/functions/cancel-cash-order/index.ts
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

    // Emit staff bell notifications. The cancellation already succeeded — neither
    // insert may fail, block, or affect the result, and the two are independent.
    {
      const c = (data ?? {}) as Record<string, any>;
      if (c.success === true && preview !== true) {
        const curr = c.currency ?? c.store_credit?.currency;
        const symbol = curr === "PHP" ? "₱" : "¥";

        // Resolve the customer name — from the issued credit lot, or (when no
        // money was received so no lot exists) from the cash order itself.
        const custId = c.store_credit?.customer_id
          ?? (await supabase.from("cash_orders").select("customer_id").eq("id", cash_order_id).maybeSingle()).data?.customer_id
          ?? null;
        const name = await resolveCustomerName(supabase, custId);

        // (a) Store credit auto-issued from money actually received.
        if (Number(c.money_received ?? 0) > 0) {
          try {
            const money = Number(c.money_received ?? 0).toLocaleString("en-US");
            await supabase.from("staff_notifications").insert({
              type: "store_credit_issued",
              title: "Store credit issued on cancellation",
              body: `${name ? name + " — " : ""}Cash Order #${c.invoice_number} cancelled, ${symbol}${money} store credit issued (valid 1 year)`,
              customer_id: custId,
              invoice_number: c.invoice_number,
              metadata: data,
            });
          } catch (notifyErr) {
            console.warn("[cancel-cash-order] store_credit_issued notification failed (non-blocking):", notifyErr);
          }
        }

        // (b) Loyalty points earned on the order were revoked.
        if (c.earned_points_revoked_tx != null) {
          try {
            await supabase.from("staff_notifications").insert({
              type: "loyalty_revoked",
              title: "Loyalty points revoked",
              body: `${name ? name + " — " : ""}Loyalty points earned on Cash Order #${c.invoice_number} were revoked (order cancelled)`,
              customer_id: custId,
              invoice_number: c.invoice_number,
              metadata: { earned_points_revoked_tx: c.earned_points_revoked_tx, invoice_number: c.invoice_number },
            });
          } catch (notifyErr) {
            console.warn("[cancel-cash-order] loyalty_revoked notification failed (non-blocking):", notifyErr);
          }
        }
      }
    }

    return json(data ?? { error: "no_response" });
  } catch (e) {
    console.error("[cancel-cash-order] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
