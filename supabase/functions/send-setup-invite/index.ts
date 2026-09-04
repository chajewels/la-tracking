// send-setup-invite — sends one portal setup invite to one customer.
//
// Staff-facing trigger from the customer detail page. Replaces the previous
// client-side invocation of the retired generic email sender: the recipient and
// the template are resolved server-side from the customer id.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendAppEmail } from "../_shared/send-app-email.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const PORTAL_BASE = "https://portal.chajewelsjp.com";

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userError } = await supabase.auth.getUser(
    authHeader.slice("Bearer ".length).trim(),
  );
  if (userError || !userData?.user) {
    return json({ error: "Unauthorized" }, 401);
  }

  const { data: roleRows } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id);
  const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
  if (!roles.some((r) => ["admin", "staff", "finance", "csr"].includes(r))) {
    return json({ error: "Forbidden" }, 403);
  }

  let customerId: string | undefined;
  try {
    const body = await req.json();
    customerId = typeof body?.customer_id === "string" ? body.customer_id : undefined;
  } catch {
    customerId = undefined;
  }
  if (!customerId) {
    return json({ error: "customer_id is required" }, 400);
  }

  const { data: customer, error: custError } = await supabase
    .from("customers")
    .select("id, full_name, email, mobile_number")
    .eq("id", customerId)
    .maybeSingle();

  if (custError || !customer) {
    return json({ error: "Customer not found" }, 404);
  }
  if (!customer.email) {
    return json({ error: "Customer has no email on file" }, 400);
  }

  const digits = (customer.mobile_number ?? "").replace(/\D/g, "");
  const customerPin = digits.length >= 4 ? digits.slice(-4) : "----";
  const setupUrl = `${PORTAL_BASE}/portal/setup?email=${
    encodeURIComponent(customer.email)
  }`;

  const result = await sendAppEmail("portal-setup-invite", customer.email, {
    idempotencyKey: `portal-setup-invite-${customer.id}-${
      new Date().toISOString().slice(0, 10)
    }`,
    templateData: {
      customerName: customer.full_name,
      setupUrl,
      customerEmail: customer.email,
      customerPin,
    },
  });

  if (!result.sent) {
    return json({ success: false, reason: result.reason, error: result.error }, 200);
  }

  const sentAt = new Date().toISOString();
  const { error: stampError } = await supabase
    .from("customers")
    .update({ setup_link_sent_at: sentAt })
    .eq("id", customer.id);
  if (stampError) {
    console.warn("[send-setup-invite] tracking update failed", {
      code: (stampError as { code?: string }).code,
      message: stampError.message,
    });
  }

  return json({ success: true, sent_at: sentAt });
});
