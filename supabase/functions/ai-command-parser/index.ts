import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const systemPrompt = `You are a command parser for Cha Jewels Hub, a jewelry layaway business in Japan and the Philippines. Parse natural language staff commands into structured JSON.

Supported intents:
- CREATE_CUSTOMER: staff wants to add a new customer
- RECORD_PAYMENT: staff wants to record a payment

For CREATE_CUSTOMER extract:
  full_name (required), email (optional),
  mobile_number (optional), facebook_name (optional),
  location_type: japan | philippines | international
  (default philippines)

For RECORD_PAYMENT extract:
  customer_name (required), amount (required numeric),
  currency: PHP | JPY (default PHP),
  payment_type: downpayment | installment (default installment),
  payment_channel (e.g. BDO, GCash, PayPal)

Return ONLY valid JSON, no markdown, no explanation:
{
  "intent": "CREATE_CUSTOMER" | "RECORD_PAYMENT" | "UNKNOWN",
  "confidence": 0.0-1.0,
  "parameters": { extracted fields },
  "display_summary": "human-readable one-line summary"
}

If unclear, return intent UNKNOWN with confidence 0 and empty parameters.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } =
      await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { command } = await req.json();
    if (!command?.trim()) {
      return new Response(
        JSON.stringify({ error: "No command provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "AI service not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          { role: "user", content: command }
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic error ${response.status}: ${err}`);
    }

    const aiResult = await response.json();
    const aiContent = aiResult.content?.[0]?.text;
    if (!aiContent) throw new Error("AI returned empty response");

    let jsonStr = aiContent.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, "");
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      return new Response(
        JSON.stringify({ error: "Could not parse command" }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify(parsed),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("ai-command-parser error:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
