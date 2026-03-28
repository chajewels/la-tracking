import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CLOSED_STATUSES = ["forfeited", "final_forfeited", "cancelled", "completed"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Fetch all non-closed, non-test accounts
    let allAccounts: any[] = [];
    let from = 0;
    const PAGE = 1000;

    while (true) {
      const { data } = await supabase
        .from("layaway_accounts")
        .select("id, invoice_number, status")
        .not("status", "in", `(${CLOSED_STATUSES.join(",")})`)
        .not("invoice_number", "like", "TEST-%")
        .range(from, from + PAGE - 1);

      if (!data || data.length === 0) break;
      allAccounts = allAccounts.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    let processed = 0;
    let fixed = 0;
    let errors = 0;
    const errorAccounts: string[] = [];
    const allChanges: { invoice: string; changes: string[] }[] = [];

    for (const acct of allAccounts) {
      try {
        const resp = await fetch(`${supabaseUrl}/functions/v1/reconcile-account`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceRoleKey}`,
            "apikey": serviceRoleKey,
          },
          body: JSON.stringify({ account_id: acct.id }),
        });

        const result = await resp.json();
        processed++;

        if (result.ok && result.changes && result.changes.length > 0) {
          fixed++;
          allChanges.push({ invoice: acct.invoice_number, changes: result.changes });
        }

        if (!result.ok) {
          errors++;
          errorAccounts.push(`${acct.invoice_number}: ${result.error || "unknown"}`);
        }
      } catch (e) {
        errors++;
        errorAccounts.push(`${acct.invoice_number}: ${(e as Error).message}`);
      }
    }

    // Store timestamp
    await supabase
      .from("system_settings")
      .upsert({
        key: "last_daily_reconciliation",
        value: JSON.stringify(new Date().toISOString()),
        description: "Timestamp of last daily reconciliation run",
      }, { onConflict: "key" });

    const elapsed = Date.now() - startTime;

    const result = {
      total_accounts: allAccounts.length,
      processed,
      fixed,
      errors,
      error_accounts: errorAccounts,
      elapsed_ms: elapsed,
      changes_detail: allChanges,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
