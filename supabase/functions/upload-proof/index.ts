// Authorized customer-portal proof-of-payment upload.
//
// The browser previously POSTed the proof straight to the `payment-proofs`
// bucket as anon, relying on a storage RLS policy that reads the x-portal-token
// request header. storage-api does not surface that custom header to Postgres
// RLS, so every token/session customer upload was denied (broken since the
// 2026-06-05 policy rework; staff covered it manually via the staff app).
//
// This function performs the SAME authorization the storage policy intended —
// resolvePortalAuth -> customer_id, then verify the target account belongs to
// that customer (layaway_accounts OR cash_orders) — and writes the object with
// the service-role key, which bypasses storage RLS cleanly. No header dependency.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolvePortalAuth } from "../_shared/portal-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const BUCKET = "payment-proofs";
const MAX_BYTES = 10 * 1024 * 1024; // matches bucket file_size_limit (10485760)

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const form = await req.formData();
    const file = form.get("file");
    const accountId = form.get("account_id");
    const fileName = form.get("file_name");
    const portalToken = form.get("portal_token");
    const sessionId = form.get("session_id");
    const upsert = form.get("upsert") === "true";

    if (!(file instanceof File)) return json(400, { error: "Missing file" });
    if (typeof accountId !== "string" || !accountId) return json(400, { error: "Missing account_id" });
    if (typeof fileName !== "string" || !fileName) return json(400, { error: "Missing file_name" });
    if (file.size === 0) return json(400, { error: "Empty file" });
    if (file.size > MAX_BYTES) return json(413, { error: "File exceeds 10 MB limit" });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let customerId: string;
    try {
      const auth = await resolvePortalAuth(supabase, {
        portal_token: typeof portalToken === "string" ? portalToken : undefined,
        session_id: typeof sessionId === "string" ? sessionId : undefined,
        authHeader: req.headers.get("Authorization"),
      });
      customerId = auth.customer_id;
    } catch (err) {
      return json(401, { error: (err as Error)?.message || "Access denied" });
    }

    const { data: la } = await supabase
      .from("layaway_accounts").select("id")
      .eq("id", accountId).eq("customer_id", customerId).maybeSingle();
    let owns = !!la;
    if (!owns) {
      const { data: co } = await supabase
        .from("cash_orders").select("id")
        .eq("id", accountId).eq("customer_id", customerId).maybeSingle();
      owns = !!co;
    }
    if (!owns) return json(403, { error: "Account not found or access denied" });

    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectPath = `${accountId}/${safeName}`;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(objectPath, bytes, { contentType: file.type || "application/octet-stream", upsert });
    if (upErr) return json(500, { error: `Upload failed: ${upErr.message}` });

    const proofUrl = `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${BUCKET}/${objectPath}`;
    return json(200, { proof_url: proofUrl });
  } catch (err) {
    return json(500, { error: (err as Error)?.message || "Unexpected error" });
  }
});
