import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Daily Reconciliation Job
 *
 * Runs reconcile-account for every active layaway account to ensure:
 *   - payment_allocations exist for all payments
 *   - layaway_schedule.paid_amount and status match allocations
 *   - unpaid penalties on paid installments are auto-waived
 *   - account.total_paid and remaining_balance are accurate
 *
 * Intended to be called by a Supabase cron job once per day.
 * Records completion timestamp in system_settings.key = 'last_daily_reconciliation'.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY") || "";

    const supabase = createClient(supabaseUrl, serviceKey);

    const CLOSED_STATUSES = ["forfeited", "final_forfeited", "cancelled", "completed"];
    const PAGE = 500;

    // Fetch all non-closed accounts (paginated)
    let allAccounts: any[] = [];
    let from = 0;
    while (true) {
      const { data } = await supabase
        .from("layaway_accounts")
        .select("id, invoice_number, status")
        .not("status", "in", `(${CLOSED_STATUSES.map(s => `"${s}"`).join(",")})`)
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      allAccounts = allAccounts.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    const reconcileUrl = `${supabaseUrl}/functions/v1/reconcile-account`;

    let processed = 0;
    let fixed = 0;
    let errors = 0;
    const errorAccounts: string[] = [];

    for (const account of allAccounts) {
      // Skip test accounts
      if (String(account.invoice_number).startsWith("TEST-")) continue;

      try {
        const res = await fetch(reconcileUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceKey}`,
            "apikey": anonKey,
          },
          body: JSON.stringify({ account_id: account.id }),
        });

        if (res.ok) {
          const result = await res.json();
          processed++;
          if (
            result.allocations_created > 0 ||
            result.schedule_rows_fixed > 0 ||
            result.penalties_waived > 0 ||
            result.account_totals_updated
          ) {
            fixed++;
            console.log(
              `[daily-reconciliation] Fixed ${account.invoice_number}: ` +
              `allocations=${result.allocations_created}, ` +
              `rows=${result.schedule_rows_fixed}, ` +
              `penalties_waived=${result.penalties_waived}`
            );
          }
        } else {
          errors++;
          errorAccounts.push(account.invoice_number);
          console.error(`[daily-reconciliation] reconcile failed for ${account.invoice_number}: ${res.status}`);
        }
      } catch (err: any) {
        errors++;
        errorAccounts.push(account.invoice_number);
        console.error(`[daily-reconciliation] error for ${account.invoice_number}:`, err.message);
      }
    }

    // Record last run timestamp in system_settings
    await supabase.from("system_settings").upsert({
      key: "last_daily_reconciliation",
      value: JSON.stringify(new Date().toISOString()),
    }, { onConflict: "key" });

    const elapsed = Date.now() - startTime;
    console.log(
      `[daily-reconciliation] Complete: ${processed} processed, ${fixed} fixed, ${errors} errors in ${elapsed}ms`
    );

    return new Response(JSON.stringify({
      ok: true,
      total_accounts: allAccounts.length,
      processed,
      fixed,
      errors,
      error_accounts: errorAccounts,
      elapsed_ms: elapsed,
      timestamp: new Date().toISOString(),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[daily-reconciliation] fatal error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
