import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * AI Command Parser Edge Function
 *
 * Parses natural-language staff commands into structured JSON describing
 * one of the supported intents (CREATE_CUSTOMER, RECORD_PAYMENT).
 *
 * Payload: { "command": "..." }
 *
 * Auth: staff user JWT required (this is invoked from the Hub's AICommandModal).
 * Backed by Lovable AI Gateway / google/gemini-2.5-flash, temperature 0.1.
 */

const systemPrompt = `You are a command parser for Cha Jewels Hub, a jewelry layaway business in Japan and the Philippines. Parse natural language staff commands into structured JSON.

Supported intents:
- CREATE_CUSTOMER: staff wants to add a new customer to the directory
- RECORD_PAYMENT: staff wants to record a payment against a layaway account

For CREATE_CUSTOMER extract these fields:

full_name (required) — the person's full name, typically the first words before any other data

mobile_number (optional) — any value starting with + followed by digits, or a string of digits that looks like a phone number (e.g. +81901234567, +63912345678)

email (optional) — any value containing @ (e.g. maria@email.com, chajewelsjapan@gmail.com)

messenger_link (optional) — any value starting with m.me/ or containing messenger.com (e.g. m.me/chajewelsjapan)

facebook_name (optional) — only if explicitly mentioned with "FB" or "Facebook" label. Do NOT use the name or messenger link as facebook_name.

location_type rules (IMPORTANT):
- If the command mentions "Japan" or the customer is in Japan → location_type: "japan"
- If the command mentions "Philippines" or no location is mentioned → location_type: "philippines" (default)
- If the command mentions any other country → location_type: "international"
- Must be exactly: "japan" | "philippines" | "international"
- NEVER put Japan or Philippines in a country field
- Only set country when location_type is "international"

For RECORD_PAYMENT extract:
  customer_name (required),
  amount (required, numeric),
  currency: 'PHP' | 'JPY' (default 'PHP'),
  payment_type: 'downpayment' | 'installment' (default 'installment'),
  payment_channel (e.g. BDO, GCash, PayPal),
  invoice_number (optional) — a numeric invoice reference mentioned in the command (e.g. "Invoice 12345", "invoice #19105", "#18422"). Extract only the digits. If no invoice number is mentioned, omit this field.

Return ONLY valid JSON, no markdown, no explanation:
{
  "intent": "CREATE_CUSTOMER" | "RECORD_PAYMENT" | "UNKNOWN",
  "confidence": 0.0-1.0,
  "parameters": { ... extracted fields ... },
  "display_summary": "human-readable one-line summary of what was parsed"
}

If the input is unclear or does not match any intent, return intent: "UNKNOWN" with confidence: 0 and an empty parameters object.`;

async function extractWithAI(command: string, apiKey: string): Promise<string> {
  const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: command },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`AI error ${response.status}: ${errorText}`);
  }

  const aiResult = await response.json();
  const aiContent = aiResult.choices?.[0]?.message?.content;
  if (!aiContent) throw new Error("AI returned empty response");
  return aiContent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Staff users call this — verify user JWT via getUser.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { command } = await req.json();
    if (!command || typeof command !== "string" || !command.trim()) {
      return new Response(JSON.stringify({ error: "command is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiContent = await extractWithAI(command.trim(), LOVABLE_API_KEY);

    // Strip code fences if the model wrapped its JSON.
    let jsonStr = aiContent.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (_err) {
      return new Response(JSON.stringify({ error: "Could not parse command" }), {
        status: 422,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("ai-command-parser error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
