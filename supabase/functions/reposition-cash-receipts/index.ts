const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// RETIRED (Bug #251). This function read each slot's metadata from a hard-coded
// OLD (24-slot, row-major) map and wrote it to a hard-coded NEW map. On 13-slot
// sheets the OLD positions were never used and held blank template placeholders,
// which it then wrote OVER the correct metadata — destroying the text block while
// the image (rebuilt from proof_url) still looked fine.
//
// Slot maps are now DERIVED PER SHEET from that sheet's merged ranges, and ALL
// slots are rebuilt from payment_submissions on every confirmed payment
// (self-healing). This function must never run again — every request returns 410.
Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  return new Response(
    JSON.stringify({
      error: "reposition-cash-receipts is retired (Bug #251). Slot maps are now derived per-sheet and all slots are rebuilt from DB on every confirmed payment.",
    }),
    { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
