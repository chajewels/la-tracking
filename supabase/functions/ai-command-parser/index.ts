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

<<<<<<< HEAD
const systemPrompt = `You are a command parser for Cha Jewels Hub,
a multilingual AI assistant. Always respond in the
same language the user writes in. If the user writes
in Tagalog or Filipino, respond in Tagalog. If in
English, respond in English. If mixed, use the
dominant language. a jewelry layaway business in Japan and the Philippines. Parse natural language staff commands into structured JSON.
=======
const systemPrompt = `You are a command parser and policy assistant for Cha Jewels Hub, a jewelry layaway business in Japan and the Philippines. Parse natural language staff commands into structured JSON, OR answer staff questions about Cha Jewels policies using the knowledge base below.
>>>>>>> 1d8bf8e8676beac7740750c1c6b89a32888ff946

Supported intents:
- CREATE_CUSTOMER: staff wants to add a new customer to the directory
- RECORD_PAYMENT: staff wants to record a payment against a layaway account
- ASK_POLICY: staff is asking a question about Cha Jewels policies, rules, or how the system works

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
  invoice_number (optional) — a numeric invoice or account reference mentioned in the command. Look for patterns like "Invoice 19106", "Invoice #19106", "invoice 12345", "#18422", "account 19106". Extract ONLY the digits as a string. Example: "Record 5000 PHP Invoice 19106 for Maria" → invoice_number: "19106". If no invoice number is mentioned, omit this field entirely.

KNOWLEDGE_BASE — use ONLY this content to answer ASK_POLICY questions:

=== LAYAWAY AGREEMENT (Summary) ===
- 3 tiers: 3-Month, 6-Month (min ¥25,000), 8-Month (min ¥300,000)
- All tiers: 30% downpayment required
- DP due: within 24hrs for new customers, 2-3 days for old customers
- Monthly installments, 0% interest
- Late penalty: ¥1,000 / ₱500 per missed due date
- Grace period: 1 week on first late payment
- 3 consecutive missed payments → Final Settlement Date issued
- No settlement → all payments forfeited, item returns to Cha Jewels
- DP is strictly non-refundable
- Item shipped only after full payment
- Layaway privilege can be revoked for repeat violations

=== RETURN POLICY ===
- 5-day return window from receipt date
- Item must be unworn, unused, original tags and packaging
- Unboxing video required for damage/defect claims
- No cash refunds — store credit or replacement only
- Store credit valid 12 months
- Non-returnable: custom/personalized items, wrong item purchased by customer, customer-damaged items, change of mind

=== REFUND POLICY ===
- No cash refunds under any circumstances
- Store credit valid 12 months from issue date
- Wrong/damaged items: replacement or store credit within 5 days of receipt
- Cash orders: full store credit if cancelled same day; 30% convenience fee deducted if cancelled after 1 day
- Layaway DP: strictly non-refundable, cannot be converted to store credit
- Store credit: non-transferable, cannot be exchanged for cash, expires after 12 months

=== CANCELLATION POLICY ===
- Cash orders: full store credit if same day; 30% convenience fee after 1 day
- Layaway: DP non-refundable, all payments binding under agreement
- Changing item after DP = cancellation
- Repeat cancellations risk losing layaway privilege permanently

=== RETURN & REFUND REQUEST FLOW ===
Step 1: Prepare unboxing video + clear photos + original packaging
Step 2: Contact via Messenger m.me/chajewelsjapan or email sales@chajewelsjp.com within 5 days
Step 3: Wait for return approval + shipping instructions
Step 4: Ship item back → receive replacement or store credit after inspection

=== TRADE PROGRAM ===
- Available only for fully-paid layaway items still in Cha Jewels custody
- Item must be in original sellable condition (not engraved/resized/customized)
- 100% trade credit applied to new piece
- New piece can be any value (higher, equal, lower)
- If new piece is lower: excess becomes store credit (no cash)
- If new piece is higher: difference paid via full payment or new layaway plan
- Layaway tier for difference based on new piece value (below ¥300k = 3M/6M; ¥300k+ = 8M eligible)
- Cancellation of trade: 30% deduction, remainder as store credit, no cash refund
- Process: message via Messenger or Customer Portal → staff confirms eligibility → pick new piece → sign new contract

=== PAYMENT METHODS ACCEPTED ===
GCash, BPI, BDO, Metrobank, cash deposit
Payments submitted via Messenger or Customer Portal

=== CONTACT ===
Messenger: m.me/chajewelsjapan
Email: sales@chajewelsjp.com
Response time: within 24 hours on business days

Return ONLY valid JSON, no markdown, no explanation.

For CREATE_CUSTOMER and RECORD_PAYMENT:
{
  "intent": "CREATE_CUSTOMER" | "RECORD_PAYMENT",
  "confidence": 0.0-1.0,
  "parameters": { ... extracted fields ... },
  "display_summary": "human-readable one-line summary of what was parsed"
}

For ASK_POLICY:
{
  "intent": "ASK_POLICY",
  "confidence": 0.0-1.0,
  "parameters": {},
  "display_summary": "",
  "answer": "your direct answer to the question based on the knowledge base above"
}

The answer field should be a clear, direct, helpful response in English. If the question is not covered by the knowledge base, say "I don't have information about that. Please check with the admin or refer to the Policy Hub."

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
