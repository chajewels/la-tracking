import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";
import { buildPortalLinkForCustomerId } from "../_shared/portal-link.ts";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mirrors src/pages/CustomerPortal.tsx: floor(elapsedDays) <= 7, i.e. the
// window closes exactly 8x24h after forfeited_at. The off-by-one (named
// "7 days" in the UI copy) is deliberate and logged in docs/OPEN-BUGS.md —
// do NOT tighten it here without changing the frontend in the same commit.
const WINDOW_DAYS = 7;

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

    if (acct.forfeited_at) {
      const elapsedDays = Math.floor((Date.now() - new Date(acct.forfeited_at).getTime()) / 86400000);
      if (elapsedDays > WINDOW_DAYS) {
        return json({ error: "The extension request window has closed. Please contact us directly for assistance.", code: "window_closed" }, 403);
      }
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
    try {
      const { data: cust } = await supabase
        .from("customers").select("full_name").eq("id", customerId).maybeSingle();
      const portalUrl = await buildPortalLinkForCustomerId(supabase, customerId, "portal");
      const rb = Number(acct.remaining_balance ?? 0);
      const remainingBalance = String(acct.currency).toUpperCase() === "JPY"
        ? "¥" + Math.round(rb).toLocaleString("en-US")
        : "₱" + rb.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      const result = await sendTemplateEmail(
        "extension-requested",
        "sales@chajewelsjp.com",
        {
          templateData: {
            customerName: cust?.full_name || "Valued customer",
            invoiceNumber: acct.invoice_number,
            reason: cleanReason || "No reason provided",
            currency: acct.currency,
            remainingBalance,
            portalUrl,
          },
        },
      );
      if (!result.sent) {
        console.log(`[request-extension] "extension-requested" suppressed for ${"sales@chajewelsjp.com"}`);
      }
    } catch (mailErr) {
      console.error("[request-extension] staff email failed (non-blocking):", mailErr);
    }

    return json({ ok: true, id: inserted.id, requested_at: inserted.requested_at });
  } catch (err) {
    console.error("[request-extension] error:", err);
    return json({ error: (err as Error)?.message || "internal_error" }, 500);
  }
});
