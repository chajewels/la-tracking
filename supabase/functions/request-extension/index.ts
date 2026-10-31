import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import { EXTENSION_WINDOW_CLOSED_MESSAGE, extensionWindowOpen } from "../_shared/extension-rules.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// The window check (floor(elapsedDays) <= 7, i.e. it closes exactly 8x24h
// after forfeited_at) lives in _shared/extension-rules.ts, shared with
// CustomerPortal.tsx and staff reactivation (owner rule R2, 2026-10-20). The
// off-by-one (named "7 days" in the UI copy) is deliberate and logged in
// docs/OPEN-BUGS.md — change it only there, for every caller at once.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json();
    const { portal_token, session_id, account_id, reason } = body ?? {};

    if (!account_id) return json({ error: "Missing account_id" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let customerId: string;
    try {
      const auth = await resolvePortalAuth(supabase, {
        portal_token,
        session_id,
        authHeader: req.headers.get("Authorization"),
      });
      customerId = auth.customer_id;
    } catch (err) {
      return json({ error: (err as Error)?.message || "Access denied" }, 401);
    }

    const { data: acct } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, status, forfeited_at, currency, remaining_balance")
      .eq("id", account_id)
      .eq("customer_id", customerId)
      .maybeSingle();
    if (!acct) return json({ error: "Account not found or access denied" }, 404);

    if (acct.status !== "forfeited") {
      return json({ error: "Extensions can only be requested on forfeited accounts.", code: "not_forfeited" }, 409);
    }

    if (!extensionWindowOpen(acct.forfeited_at)) {
      return json({ error: EXTENSION_WINDOW_CLOSED_MESSAGE, code: "window_closed" }, 403);
    }

    const { data: existing } = await supabase
      .from("extension_requests")
      .select("id")
      .eq("account_id", account_id)
      .eq("status", "pending")
      .limit(1);
    if (existing && existing.length > 0) {
      return json({ error: "An extension request is already pending for this account.", code: "already_pending" }, 409);
    }

    const cleanReason = typeof reason === "string" && reason.trim() !== "" ? reason.trim() : null;

    const { data: inserted, error: insErr } = await supabase
      .from("extension_requests")
      .insert({
        account_id,
        customer_id: customerId,
        portal_token: portal_token || null,
        reason: cleanReason,
        status: "pending",
      })
      .select("id, requested_at")
      .single();

    if (insErr) {
      console.error("[request-extension] insert failed:", insErr);
      return json({ error: insErr.message || "Insert failed" }, 500);
    }

    // Staff notification email — moved verbatim from CustomerPortal.tsx.
    // The frontend copy authenticated with the ANON key, which the
    // send-transactional-email service_role gate (Bug #168) rejects, so this
    // mail has been silently failing. Service-role key here fixes it.
    // Non-blocking: a mail failure must never fail the request.
    //
    // The CUSTOMER copy of the same template also sends from here since
    // 2026-11-01 (migration 20270227100000): it used to be sent by the DB
    // trigger notify_extension_event through net.http_post, which blocked
    // Lovable's managed-email update (docs/EMAIL-DELIVERY.md, 2026-10-31).
    // Both sends share the values computed once below; each send has its own
    // try/catch so neither can fail the request or the other send.
    let customerEmail: string | null = null;
    let templateData: Record<string, unknown> | null = null;
    try {
      const { data: cust } = await supabase
        .from("customers").select("full_name, email").eq("id", customerId).maybeSingle();
      const portalUrl = await buildPortalLinkForCustomerId(supabase, customerId, "portal");
      const rb = Number(acct.remaining_balance ?? 0);
      const remainingBalance = String(acct.currency).toUpperCase() === "JPY"
        ? "¥" + Math.round(rb).toLocaleString("en-US")
        : "₱" + rb.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      customerEmail = typeof cust?.email === "string" && cust.email.trim() !== "" ? cust.email.trim() : null;
      templateData = {
        customerName: cust?.full_name || "Valued customer",
        invoiceNumber: acct.invoice_number,
        reason: cleanReason || "No reason provided",
        currency: acct.currency,
        remainingBalance,
        portalUrl,
      };
    } catch (prepErr) {
      console.error("[request-extension] email data lookup failed (non-blocking):", prepErr);
    }

    if (templateData) {
      try {
        const result = await sendTemplateEmail(
          "extension-requested",
          "sales@chajewelsjp.com",
          { templateData },
        );
        if (!result.sent) {
          console.log(`[request-extension] "extension-requested" suppressed for the staff inbox`);
        }
      } catch (mailErr) {
        console.error("[request-extension] staff email failed (non-blocking):", mailErr);
      }

      // Customer copy: only when the customer has an e-mail address (skipped
      // silently otherwise, as the trigger did). The idempotency key is derived
      // from the new extension_requests row so a retry cannot double-send.
      if (customerEmail) {
        try {
          const result = await sendTemplateEmail(
            "extension-requested",
            customerEmail,
            { templateData, idempotencyKey: `extension-requested:${inserted.id}:customer` },
          );
          if (!result.sent) {
            console.log(`[request-extension] "extension-requested" suppressed for the customer`);
          }
        } catch (mailErr) {
          console.error("[request-extension] customer email failed (non-blocking):", mailErr);
        }
      }
    }

    return json({ ok: true, id: inserted.id, requested_at: inserted.requested_at });
  } catch (err) {
    console.error("[request-extension] error:", err);
    return json({ error: (err as Error)?.message || "internal_error" }, 500);
  }
});
