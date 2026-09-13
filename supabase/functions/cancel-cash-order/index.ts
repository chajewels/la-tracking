// supabase/functions/cancel-cash-order/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as React from "npm:react@18.3.1";
import { checkPermission } from "../_shared/check-permission.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { emitNotification } from "../_shared/emit-notification.ts";
import { pickLang, sendStorefrontEmail, storefrontOrderUrl } from "../_shared/storefront-email.ts";
import { OrderCancelledEmail, orderCancelledSubject, type RefundStatus } from "../_shared/email-templates/order-cancelled.tsx";

const REFUND_STATUSES = new Set(["refund_issued", "refund_pending", "store_credit_issued", "no_refund"]);

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

/**
 * Web order: the Cha Jewels cancellation email — reason and refund decision,
 * the same two lines the customer sees on /account/orders. Fire-and-forget;
 * the helper logs one line per send.
 */
async function sendWebCancellationEmail(supabase: any, orderId: string, reason: string, refundStatus: RefundStatus | null, refundNote: string | null) {
  try {
    const { data: order } = await supabase
      .from("cash_orders")
      .select("id, web_reference, invoice_number, customer_lang, shipping_fee, total_amount, customers(email, is_test)")
      .eq("id", orderId)
      .maybeSingle();
    if (!order) return;
    const { data: lines } = await supabase
      .from("cash_order_items")
      .select("website_product_id, title, quantity, line_total_jpy")
      .eq("cash_order_id", orderId)
      .order("created_at");
    const ids = [...new Set(((lines ?? []) as any[]).map((l) => l.website_product_id).filter(Boolean))];
    const { data: prods } = ids.length
      ? await supabase.from("website_products").select("id, name, name_ja").in("id", ids)
      : { data: [] as any[] };
    const byId = new Map<string, any>(((prods ?? []) as any[]).map((p) => [String(p.id), p]));
    const items = ((lines ?? []) as any[]).map((l) => {
      const pr = l.website_product_id ? byId.get(String(l.website_product_id)) : undefined;
      const title = String(l.title ?? "");
      const title_ja = pr?.name && pr?.name_ja && title.startsWith(pr.name) ? pr.name_ja + title.slice(pr.name.length) : null;
      return { title, title_ja, qty: Number(l.quantity ?? 1), line_total_jpy: Number(l.line_total_jpy ?? 0) };
    });
    const reference = String(order.web_reference ?? order.invoice_number);
    const customer = (order as any).customers;
    await sendStorefrontEmail({
      to: { email: customer?.email ?? null, is_test: customer?.is_test === true },
      subject: orderCancelledSubject(reference),
      label: "order-cancelled",
      reference,
      idempotencyKey: `order-cancelled-${orderId}`,
      element: React.createElement(OrderCancelledEmail, {
        lang: pickLang(order.customer_lang),
        reference,
        items,
        shippingJpy: Number(order.shipping_fee ?? 0),
        totalJpy: Number(order.total_amount ?? 0),
        reason,
        refundStatus,
        refundNote,
        orderUrl: storefrontOrderUrl(orderId),
      }),
    });
  } catch (mailErr) {
    console.warn("[cancel-cash-order] order-cancelled email failed (non-blocking):", mailErr);
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
    const refundStatus: RefundStatus | null =
      typeof body.refund_status === "string" && REFUND_STATUSES.has(body.refund_status) ? body.refund_status : null;
    const refundNote: string | null =
      typeof body.refund_note === "string" && body.refund_note.trim() ? body.refund_note.trim().slice(0, 300) : null;

    if (!cash_order_id) return json({ error: "cash_order_id is required" }, 400);
    if (!preview && reason.length < 3) {
      return json({ error: "A cancellation reason is required" }, 400);
    }

    // Web orders (source_channel = 'web') go through terminate_web_order_atomic:
    // points reversal, store credit per the refund decision, status, stock back
    // on sale, note + audit — one transaction, once. Hub cash orders keep
    // cancel_cash_order_atomic (no stock, store credit for money received).
    const { data: orderRow } = await supabase
      .from("cash_orders")
      .select("id, source_channel, web_reference, invoice_number, customer_id")
      .eq("id", cash_order_id)
      .maybeSingle();
    if (!orderRow) return json({ error: "cash_order_not_found" }, 404);
    const isWeb = orderRow.source_channel === "web";

    const { data, error } = isWeb
      ? await supabase.rpc("terminate_web_order_atomic", {
          p_order_id: cash_order_id,
          p_outcome: "cancelled",
          p_reason: reason || null,
          p_user_id: user.id,
          p_user_email: user.email ?? null,
          p_refund_status: refundStatus,
          p_refund_note: refundNote,
          p_source: "staff",
          p_preview: preview,
        })
      : await supabase.rpc("cancel_cash_order_atomic", {
          p_cash_order_id: cash_order_id,
          p_reason: reason,
          p_user_id: user.id,
          p_user_email: user.email ?? null,
          p_preview: preview,
        });

    if (error) {
      console.error("[cancel-cash-order] rpc error:", error);
      const msg = error.message ?? "cancel failed";
      const status = msg.includes("refund_decision_required") ? 400 : 400;
      return json({ error: msg, code: msg.split(":")[0] }, status);
    }
    if (isWeb && (data as any)?.ok === false) {
      // already_terminal / not_web_order — nothing was written.
      return json({ error: (data as any).reason ?? "not_cancellable", ...(data as any) }, 409);
    }

    // Emit staff bell notifications. The cancellation already succeeded — neither
    // insert may fail, block, or affect the result, and the two are independent.
    {
      const c = (data ?? {}) as Record<string, any>;
      if (c.success === true && preview !== true) {
        const curr = c.currency ?? c.store_credit?.currency;
        const symbol = curr === "PHP" ? "₱" : "¥";
        const ref = isWeb ? `Order ${c.web_reference ?? orderRow.web_reference ?? c.invoice_number}` : `Cash Order #${c.invoice_number}`;

        const custId = c.store_credit?.customer_id ?? orderRow.customer_id ?? null;
        const name = await resolveCustomerName(supabase, custId);

        // (a) Store credit minted from money actually received (web: only when
        //     staff chose "store credit issued"; Hub cash orders: always).
        if (c.store_credit) {
          try {
            const money = Number(c.store_credit.amount ?? c.money_received ?? 0).toLocaleString("en-US");
            await supabase.from("staff_notifications").insert({
              type: "store_credit_issued",
              title: "Store credit issued on cancellation",
              body: `${name ? name + " — " : ""}${ref} cancelled, ${symbol}${money} store credit issued (valid 1 year)`,
              customer_id: custId,
              invoice_number: c.invoice_number,
              metadata: data,
            });
          } catch (notifyErr) {
            console.warn("[cancel-cash-order] store_credit_issued notification failed (non-blocking):", notifyErr);
          }
        } else if (isWeb && Number(c.money_received ?? 0) > 0) {
          try {
            await supabase.from("staff_notifications").insert({
              type: "web_order_refund",
              title: c.refund_status === "refund_pending" ? "Refund pending on cancelled web order"
                : c.refund_status === "no_refund" ? "Web order cancelled, no refund (forfeited)" : "Web order cancelled with refund",
              body: `${name ? name + " — " : ""}${ref} cancelled, ${symbol}${Number(c.money_received ?? 0).toLocaleString("en-US")} received, decision: ${String(c.refund_status ?? "").replace("_", " ")}`,
              customer_id: custId,
              invoice_number: c.invoice_number,
              metadata: data,
            });
          } catch (notifyErr) {
            console.warn("[cancel-cash-order] web_order_refund notification failed (non-blocking):", notifyErr);
          }
        }

        // (b) Loyalty points earned on the order were revoked.
        if (c.earned_points_revoked_tx != null) {
          try {
            await supabase.from("staff_notifications").insert({
              type: "loyalty_revoked",
              title: "Loyalty points revoked",
              body: `${name ? name + " — " : ""}Loyalty points earned on ${ref} were revoked (order cancelled)`,
              customer_id: custId,
              invoice_number: c.invoice_number,
              metadata: { earned_points_revoked_tx: c.earned_points_revoked_tx, invoice_number: c.invoice_number },
            });
          } catch (notifyErr) {
            console.warn("[cancel-cash-order] loyalty_revoked notification failed (non-blocking):", notifyErr);
          }
        }

        // Customer-facing PORTAL notifications (loyalty_notifications channel,
        // member-scoped) — distinct from the staff bell above.
        try {
          let memberId: string | null = null;
          if (custId) {
            const { data: m } = await supabase
              .from("loyalty_members")
              .select("id")
              .eq("customer_id", custId)
              .maybeSingle();
            memberId = (m?.id as string) ?? null;
          }
          if (memberId) {
            if (c.earned_points_revoked_tx != null) {
              await emitNotification(supabase, memberId, {
                category: "points",
                title: "Points revoked",
                body: `The loyalty points earned on ${ref} have been revoked because the order was cancelled.`,
                link_target: "tab:points",
              });
            }
            if (c.store_credit) {
              const amt = Number(c.store_credit.amount ?? c.money_received ?? 0).toLocaleString("en-US");
              const expiry = c.store_credit?.expires_at
                ? new Date(c.store_credit.expires_at).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
                : null;
              await emitNotification(supabase, memberId, {
                category: "order",
                title: "Store credit issued",
                body: `${ref} was cancelled. ${symbol}${amt} store credit has been added to your account${expiry ? ` and is valid until ${expiry}` : ""}. Our staff will apply it to your next order.`,
                link_target: "tab:home",
              });
            }
          }
        } catch (portalErr) {
          console.warn("[cancel-cash-order] customer portal notification failed (non-blocking):", portalErr);
        }

        // (c) Web order: the cancellation email (reason + refund decision).
        if (isWeb) {
          await sendWebCancellationEmail(supabase, cash_order_id, reason, c.refund_status ?? refundStatus, refundNote);
        }
      }
    }

    // Mirror the issued credit into Shopify — ONLY when store credit was actually
    // issued (data.store_credit not null). Non-blocking.
    let shopify_sync: unknown = null;
    const sc = (data as any)?.store_credit;
    if ((data as any)?.success === true && preview !== true && sc) {
      shopify_sync = await syncToShopify({
        customer_id: sc.customer_id,
        direction: "credit",
        amount: Number(sc.amount),
        currency: sc.currency,
        lot_id: sc.lot_id,
        expires_at: sc.expires_at,
        reason: `Store credit issued on cancellation of ${(data as any).web_reference ?? (data as any).invoice_number ?? "cash order"}`,
      });
    }

    return json({ ...(data ?? {}), shopify_sync });
  } catch (e) {
    console.error("[cancel-cash-order] unhandled:", e);
    return json({ error: String((e as any)?.message ?? e) }, 500);
  }
});
