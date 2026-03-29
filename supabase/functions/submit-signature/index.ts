import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://cha-jewels-layaway.web.app",
  "https://cha-jewels-layaway.firebaseapp.com",
];

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const headers = corsHeaders(origin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json();
    const {
      full_name,
      email,
      facebook_name,
      country,
      signature_image,
      invoice_number,
      agreement_version,
    } = body;

    // Step 2 — Validate required fields
    if (!full_name || !email || !facebook_name || !country || !signature_image) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // Step 3 — Validate signature_image format
    if (!signature_image.startsWith("data:image")) {
      return new Response(JSON.stringify({ error: "Invalid signature image" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // Step 4 — Resolve account_id from invoice_number if provided
    let account_id: string | null = null;
    if (invoice_number && invoice_number.trim() !== "") {
      const { data: acct } = await supabase
        .from("layaway_accounts")
        .select("id")
        .eq("invoice_number", invoice_number.trim())
        .limit(1)
        .single();
      if (acct) account_id = acct.id;
    }

    // Step 5 — Extract IP
    const forwarded = req.headers.get("x-forwarded-for");
    const ip_address = forwarded
      ? forwarded.split(",")[0].trim()
      : (req.headers.get("cf-connecting-ip") ?? "unknown");

    // Step 6 — Insert signature
    const { data: inserted, error: dbErr } = await supabase
      .from("layaway_signatures")
      .insert({
        full_name,
        email,
        facebook_name,
        country,
        signature_image,
        invoice_number: invoice_number?.trim() || null,
        account_id,
        agreement_version,
        ip_address,
      })
      .select("id")
      .single();

    if (dbErr || !inserted) {
      console.error("[submit-signature] DB insert error:", dbErr);
      return new Response(JSON.stringify({ error: "Failed to save signature" }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    // Step 7 — Return success
    return new Response(
      JSON.stringify({
        success: true,
        signature_id: inserted.id,
        linked: account_id !== null,
      }),
      { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[submit-signature] Unexpected error:", err);
    return new Response(JSON.stringify({ error: "Failed to save signature" }), {
      status: 500,
      headers: { ...corsHeaders(req.headers.get("origin")), "Content-Type": "application/json" },
    });
  }
});
