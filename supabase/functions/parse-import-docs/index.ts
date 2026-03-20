import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Parse Import Docs Edge Function
 * 
 * Takes markdown text from parsed Word documents and uses AI to extract
 * structured customer/account data, then passes it to the bulk-import logic.
 * 
 * Payload: { "markdown_text": "...", "dry_run": false }
 */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify auth - accept service role key or user token
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const isServiceRole = token === serviceRoleKey;
    console.log("Auth check - isServiceRole:", isServiceRole, "token length:", token.length, "srk length:", serviceRoleKey.length);

    if (!isServiceRole) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { markdown_text, dry_run = false } = await req.json();

    if (!markdown_text) {
      return new Response(JSON.stringify({ error: "No markdown_text provided" }), {
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

    // Use AI to extract structured data
    const systemPrompt = `You are a data extraction specialist. You extract layaway customer account data from parsed Word document text.

RULES:
- Each customer has a name that appears as a heading before their account details
- Each customer can have multiple invoices/accounts
- For each account, extract: invoice_number, currency (PHP or JPY based on ₱/PHP or ¥/JPY), total_amount, payment_plan_months (usually 3 or 6), downpayment, order_date, schedule details
- The "LA XXX" label tells you the end month (e.g. "LA JUL" = July, "LA SEPT" = September, etc.)
- Determine order_date: it is 1 month before the first installment due date. Use year 2025 for months Oct-Dec and 2025 for Jan-Sep unless context shows otherwise.
- For schedule items: extract installment_number, due_date (use year 2025 for most dates), amount (base installment without penalty), is_paid (true if marked PAID), date_paid (same as due_date if paid)
- The downpayment = total_amount - sum of all installment amounts (the "remaining balance" section)
- If schedule months have year context like "LA APR" with 1st month Nov, those Nov/Dec dates are 2024, Jan+ are 2025
- If an invoice is marked "(PAID OFF)" or "(Forfeited)", still include it but note in remarks
- For amounts with penalties included, use the BASE installment amount (without penalty) as the schedule amount
- payment_plan_months: count the number of installment rows (usually 3 or 6)
- Generate a customer_code from the first 4 letters of the name + sequential number

Return ONLY valid JSON matching this exact structure (no markdown, no explanation):
{
  "customers": [
    {
      "customer_code": "DXAC-001",
      "full_name": "Dxa C Traynor",
      "facebook_name": "Dxa C Traynor",
      "accounts": [
        {
          "invoice_number": "18313",
          "currency": "PHP",
          "total_amount": 36162,
          "payment_plan_months": 6,
          "downpayment": 10849,
          "order_date": "2025-01-26",
          "notes": "LA JUL",
          "schedule": [
            { "installment_number": 1, "due_date": "2025-02-26", "amount": 4223, "is_paid": true, "date_paid": "2025-02-26" },
            { "installment_number": 2, "due_date": "2025-03-26", "amount": 4218, "is_paid": false }
          ]
        }
      ]
    }
  ]
}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-pro",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Extract all customer and account data from this parsed document:\n\n${markdown_text}` },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("AI gateway error:", response.status, errorText);
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }), {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted." }), {
          status: 402,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "AI extraction failed", details: errorText }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiResult = await response.json();
    const aiContent = aiResult.choices?.[0]?.message?.content;
    
    if (!aiContent) {
      return new Response(JSON.stringify({ error: "AI returned empty response" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse the JSON from AI response (strip markdown code fences if present)
    let extractedData;
    try {
      let jsonStr = aiContent.trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      }
      extractedData = JSON.parse(jsonStr);
    } catch (parseError) {
      console.error("Failed to parse AI output:", aiContent.substring(0, 500));
      return new Response(JSON.stringify({ 
        error: "Failed to parse AI extraction result",
        raw_preview: aiContent.substring(0, 1000),
      }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (dry_run) {
      // Return the extracted data for review without importing
      const customerCount = extractedData.customers?.length || 0;
      const accountCount = extractedData.customers?.reduce(
        (sum: number, c: any) => sum + (c.accounts?.length || 0), 0
      ) || 0;
      return new Response(JSON.stringify({
        dry_run: true,
        summary: {
          customers_extracted: customerCount,
          accounts_extracted: accountCount,
        },
        data: extractedData,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Forward to bulk-import
    const bulkImportUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/bulk-import`;
    const importResponse = await fetch(bulkImportUrl, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
        apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
      },
      body: JSON.stringify({
        customers: extractedData.customers,
        dry_run: false,
      }),
    });

    const importResult = await importResponse.json();

    return new Response(JSON.stringify({
      success: true,
      extraction: {
        customers_extracted: extractedData.customers?.length || 0,
        accounts_extracted: extractedData.customers?.reduce(
          (sum: number, c: any) => sum + (c.accounts?.length || 0), 0
        ) || 0,
      },
      import_result: importResult,
    }), {
      status: importResponse.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("parse-import-docs error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
