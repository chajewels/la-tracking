import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole, parseJwtClaims } from "../_shared/jwt-claims.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ORDERS_PER_RUN = 100;

/**
 * Auto Expire Cash Orders
 *
 * Daily cron — transitions pending cash orders past their expires_at deadline
 * to status='expired'. Auto-rejects all pending payment_submissions on the
 * expired order. Confirmed payments are NEVER voided — money already received
 * stays received; only the unpaid portion is forfeited per the order terms.
 *
 * Runs at 30 0 * * * (08:30 PHT) — after auto-forfeit-settlement and
 * daily-reconciliation, alongside loyalty-inactivity-check.
 *
 * No user auth — runs with service-role key from pg_cron.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Service-role-only guard — cron-only endpoint.
  const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!isServiceRole(authToken)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const now = new Date();
    const nowIso = now.toISOString();

    // Helper: send cash-order-expired email (fire-and-forget)
    const sendExpiredEmail = async (
      cashOrderId: string,
      invoiceNumber: string,
      currency: string,
      totalAmount: number,
      totalPaid: number,
      remainingBalance: number,
      expiresAt: string,
      customerEmail: string | null,
      customerName: string | null,
    ) => {
      if (!customerEmail) return;
      try {
        const portalUrl = `https://portal.chajewelsjp.com/portal?invoice=${invoiceNumber}`;
        await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({
            templateName: "cash-order-expired",
            recipientEmail: customerEmail,
            idempotencyKey: `cash-order-expired-${cashOrderId}`,
            templateData: {
              customerName: customerName || "Valued Customer",
              invoiceNumber,
              currency,
              totalAmount: Number(totalAmount).toLocaleString("en-US"),
              totalPaid: Number(totalPaid).toLocaleString("en-US"),
              remainingBalance: Number(remainingBalance).toLocaleString("en-US"),
              expiresAt,
              portalUrl,
            },
          }),
        });
      } catch (emailErr) {
        console.warn(`[auto-expire-cash-orders] email send failed for ${invoiceNumber} (non-blocking):`, emailErr);
      }
    };

    // 1. Fetch pending cash orders past expires_at with outstanding balance
    const { data: orders, error: fetchErr } = await supabase
      .from("cash_orders")
      .select("id, invoice_number, customer_id, currency, total_amount, total_paid, remaining_balance, expires_at, customers(full_name, email)")
      .eq("status", "pending")
      .not("expires_at", "is", null)
      .lt("expires_at", nowIso)
      .gt("remaining_balance", 0)
      .order("expires_at", { ascending: true })
      .limit(MAX_ORDERS_PER_RUN);

    if (fetchErr) {
      console.error("[auto-expire-cash-orders] fetch error:", fetchErr);
      return new Response(JSON.stringify({ error: fetchErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!orders || orders.length === 0) {
      return new Response(JSON.stringify({
        message: "No expired cash orders to process",
        processed: 0,
        expired: 0,
        submissions_rejected: 0,
        errors: [],
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const expiredResults: Array<{ id: string; invoice_number: string; submissions_rejected: number }> = [];
    const errors: Array<{ id: string; invoice_number: string; error: string }> = [];
    let totalSubmissionsRejected = 0;

    // 2. Per-order processing with try/catch — one failure won't abort the batch
    for (const order of orders) {
      try {
        // 2a. Flip cash order to expired
        const { error: updErr } = await supabase
          .from("cash_orders")
          .update({
            status: "expired",
            expired_at: nowIso,
          })
          .eq("id", order.id)
          .eq("status", "pending"); // race guard — skip if already changed
        if (updErr) {
          throw new Error(`cash_orders update failed: ${updErr.message}`);
        }

        // 2b. Auto-reject all pending/under-review submissions for this order
        const { data: rejectedRows, error: rejErr } = await supabase
          .from("payment_submissions")
          .update({
            status: "rejected",
            reviewer_notes: "Cash order expired (auto-rejected)",
            updated_at: nowIso,
          })
          .eq("cash_order_id", order.id)
          .in("status", ["submitted", "under_review"])
          .select("id");
        if (rejErr) {
          // Log but don't roll back — the order is already expired and that's
          // the source of truth. Manual cleanup via SQL is preferable to
          // attempting a half-rollback that could leave the system inconsistent.
          console.error(`[auto-expire-cash-orders] submission rejection failed for ${order.invoice_number}:`, rejErr);
        }
        const rejectedCount = (rejectedRows || []).length;
        totalSubmissionsRejected += rejectedCount;

        // 2c. Audit log
        await supabase.from("audit_logs").insert({
          entity_type: "cash_order",
          entity_id: order.id,
          action: "auto_expired",
          new_value_json: {
            invoice_number: order.invoice_number,
            customer_id: order.customer_id,
            currency: order.currency,
            total_amount: Number(order.total_amount),
            total_paid: Number(order.total_paid),
            remaining_balance: Number(order.remaining_balance),
            expires_at: order.expires_at,
            expired_at: nowIso,
            submissions_rejected: rejectedCount,
          },
        });

        // 2d. Fire-and-forget customer email
        const customer = (order as any).customers;
        await sendExpiredEmail(
          order.id,
          order.invoice_number,
          order.currency,
          Number(order.total_amount),
          Number(order.total_paid),
          Number(order.remaining_balance),
          order.expires_at,
          customer?.email ?? null,
          customer?.full_name ?? null,
        );

        expiredResults.push({
          id: order.id,
          invoice_number: order.invoice_number,
          submissions_rejected: rejectedCount,
        });
      } catch (perOrderErr: unknown) {
        const msg = (perOrderErr as Error).message || "unknown error";
        console.error(`[auto-expire-cash-orders] failed for ${order.invoice_number}:`, msg);
        errors.push({
          id: order.id,
          invoice_number: order.invoice_number,
          error: msg,
        });
        // Audit-log the failure for diagnostics
        try {
          await supabase.from("audit_logs").insert({
            entity_type: "cash_order",
            entity_id: order.id,
            action: "auto_expire_failed",
            new_value_json: {
              invoice_number: order.invoice_number,
              expires_at: order.expires_at,
              error: msg,
              timestamp: nowIso,
            },
          });
        } catch (auditErr) {
          console.error(`[auto-expire-cash-orders] audit log failure for ${order.invoice_number}:`, auditErr);
        }
      }
    }

    return new Response(JSON.stringify({
      message: "auto-expire-cash-orders completed",
      processed: orders.length,
      expired: expiredResults.length,
      submissions_rejected: totalSubmissionsRejected,
      errors,
      expired_details: expiredResults,
    }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    console.error("[auto-expire-cash-orders] fatal error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
