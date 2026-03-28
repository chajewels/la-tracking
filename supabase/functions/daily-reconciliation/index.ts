const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  return new Response(JSON.stringify({
    ok: true,
    disabled: true,
    reason: "daily-reconciliation disabled for safety while reconcile-account is untrusted",
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
