// send-portal-setup-invite — single-customer portal setup invite
//
// This function exists so the portal setup invite goes through the managed
// send helper (sendTemplateEmail) instead of the legacy
// send-transactional-email queue path. It is the server-side entry point for
// CustomerPortalShareMenu's "Send Setup Link" button.
//
// The ONLY caller-supplied input is customer_id. The recipient, template and
// template data are all derived server-side — the browser no longer supplies
// them.
//
// Auth: mirrors send-transactional-email exactly — Authorization header is
// mandatory; the service role is allowed; otherwise the user JWT is
// validated and must belong to staff (is_staff). 401 on missing/invalid
// token, 403 for a valid non-staff user.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendTemplateEmail } from "../_shared/transactional-email-templates/send-email.ts";
import { isServiceRole } from "../_shared/jwt-claims.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PORTAL_BASE = "https://portal.chajewelsjp.com";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth gate — identical to send-transactional-email
    const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    if (!authToken) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!isServiceRole(authToken)) {
      const authClient = createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      );
      const { data: userData, error: userErr } = await authClient.auth.getUser(authToken);
      if (userErr || !userData?.user) {
        return json({ error: "Unauthorized" }, 401);
      }
      const { data: callerIsStaff } = await authClient.rpc("is_staff", {
        _user_id: userData.user.id,
      });
      if (!callerIsStaff) {
        return json({ error: "Forbidden" }, 403);
      }
    }

    // Parse + validate body — customer_id is the ONLY accepted input
    let body: { customer_id?: string } = {};
    try {
      body = await req.json().catch(() => ({}));
    } catch {
      return json({ error: "Invalid JSON in request body" }, 400);
    }
    const customerId = typeof body.customer_id === "string" ? body.customer_id : "";
    if (!customerId) {
      return json({ error: "customer_id is required" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Load the customer server-side
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .select("full_name, email, mobile_number")
      .eq("id", customerId)
      .maybeSingle();

    if (custErr) {
      console.error("[send-portal-setup-invite] customer fetch failed:", custErr);
      return json({ error: custErr.message ?? "customer_fetch_failed" }, 500);
    }
    if (!customer) {
      return json({ error: "customer_not_found" }, 404);
    }
    if (!customer.email) {
      return json({ error: "no_email_on_file" }, 400);
    }

    // Derive template data exactly as bulk-send-setup-invites does
    const email = customer.email as string;
    const customerName = (customer.full_name as string) ?? "";
    const setupUrl = `${PORTAL_BASE}/portal/setup?email=${encodeURIComponent(email)}`;
    const digits = ((customer.mobile_number as string | null) ?? "").replace(/\D/g, "");
    const customerPin = digits.length >= 4 ? digits.slice(-4) : "----";

    // Per-day idempotency key: a key stable per customer forever (as
    // bulk-send-setup-invites uses) would silently block a legitimate
    // re-send when a customer says they never received the invite; a per-day
    // key still absorbs double-clicks, which is the actual bug today,
    // because the previous front-end call sent no idempotency key at all
    // and two clicks sent two emails.
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const idempotencyKey = `portal-setup-invite-${customerId}-${today}`;

    const result = await sendTemplateEmail("portal-setup-invite", email, {
      templateData: { customerName, setupUrl, customerEmail: email, customerPin },
      idempotencyKey,
    });

    if (!result.sent) {
      // Suppressed recipient — do not stamp setup_link_sent_at
      return json({ sent: false, suppressed: true });
    }

    // Stamp setup_link_sent_at — failure logs a warning but the send stands
    const nowIso = new Date().toISOString();
    const { error: stampError } = await supabase
      .from("customers")
      .update({ setup_link_sent_at: nowIso })
      .eq("id", customerId);
    if (stampError) {
      console.warn(
        `[send-portal-setup-invite] stamp failed for ${customerId}:`,
        stampError,
      );
    }

    return json({ sent: true, suppressed: false, setup_link_sent_at: nowIso });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[send-portal-setup-invite] unexpected error:", err);
    return json({ error: message || "internal_error" }, 500);
  }
});
