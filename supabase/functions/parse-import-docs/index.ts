import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Parse Import Docs Edge Function
 * 
 * Accepts markdown text and uses AI to extract structured customer/account data.
 * Supports batch mode: splits large text into customer chunks and processes sequentially.
 * 
 * Payload: { "markdown_text": "...", "dry_run": false, "batch_size": 5 }
 */

function splitIntoCustomerChunks(markdown: string): string[] {
  // Split by customer headings - typically bold names or ## headings
  // Common patterns: "**Name**", "## Name", or lines that look like customer names
  const lines = markdown.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    // Detect customer boundary: bold name pattern or heading
    const isCustomerHeading =
      /^\*\*[A-Z][a-zA-Z\s\-'.,]+\*\*/.test(line.trim()) ||
      /^#{1,3}\s+[A-Z][a-zA-Z\s\-'.,]+/.test(line.trim());

    if (isCustomerHeading && current.length > 5) {
      chunks.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }
  return chunks;
}

function groupChunks(chunks: string[], batchSize: number): string[] {
  const batches: string[] = [];
  for (let i = 0; i < chunks.length; i += batchSize) {
    batches.push(chunks.slice(i, i + batchSize).join("\n\n---\n\n"));
  }
  return batches;
}

const systemPrompt = `You are a data extraction specialist. You extract layaway customer account data from parsed Word document text.

RULES:
- Each customer has a name that appears as a heading (bold or ## heading) before their account details
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

async function extractWithAI(text: string, apiKey: string): Promise<any> {
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
        { role: "user", content: `Extract all customer and account data from this parsed document:\n\n${text}` },
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

  let jsonStr = aiContent.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  return JSON.parse(jsonStr);
}

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
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    let isServiceRole = false;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      isServiceRole = payload.role === 'service_role';
    } catch (_) {}

    if (!isServiceRole) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { markdown_text, dry_run = false, batch_size = 3 } = await req.json();

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

    // Split into customer chunks and group into batches
    const customerChunks = splitIntoCustomerChunks(markdown_text);
    const batches = groupChunks(customerChunks, batch_size);

    console.log(`Processing ${customerChunks.length} customer chunks in ${batches.length} batches`);

    const allCustomers: any[] = [];
    const batchResults: any[] = [];

    for (let i = 0; i < batches.length; i++) {
      console.log(`Processing batch ${i + 1}/${batches.length} (${batches[i].length} chars)`);
      try {
        const result = await extractWithAI(batches[i], LOVABLE_API_KEY);
        const customers = result.customers || [];
        allCustomers.push(...customers);
        batchResults.push({ batch: i + 1, customers: customers.length, status: "ok" });
      } catch (err) {
        console.error(`Batch ${i + 1} failed:`, (err as Error).message);
        batchResults.push({ batch: i + 1, status: "error", error: (err as Error).message });
      }
      // Small delay between batches to avoid rate limits
      if (i < batches.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (dry_run) {
      const accountCount = allCustomers.reduce(
        (sum: number, c: any) => sum + (c.accounts?.length || 0), 0
      );
      return new Response(JSON.stringify({
        dry_run: true,
        summary: {
          customers_extracted: allCustomers.length,
          accounts_extracted: accountCount,
          batches_processed: batchResults,
        },
        data: { customers: allCustomers },
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
        customers: allCustomers,
        dry_run: false,
      }),
    });

    const importResult = await importResponse.json();

    return new Response(JSON.stringify({
      success: true,
      extraction: {
        customers_extracted: allCustomers.length,
        accounts_extracted: allCustomers.reduce(
          (sum: number, c: any) => sum + (c.accounts?.length || 0), 0
        ),
        batches: batchResults,
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
