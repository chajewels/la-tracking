import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ACCOUNTS_PER_RUN = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const runId = crypto.randomUUID().slice(0, 8);
  const runStart = new Date().toISOString();
  console.log(`[daily-recon:${runId}] Starting run at ${runStart}, max=${MAX_ACCOUNTS_PER_RUN}`);

  try {
    // Fetch up to MAX_ACCOUNTS_PER_RUN active/overdue accounts with at least one payment
    // Prefer accounts not recently reconciled (order by updated_at asc)
    const { data: accounts, error: acctErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, status, total_paid, remaining_balance")
      .in("status", ["active", "overdue"])
      .order("updated_at", { ascending: true })
      .limit(MAX_ACCOUNTS_PER_RUN);

    if (acctErr) {
      console.error(`[daily-recon:${runId}] Failed to fetch accounts:`, acctErr);
      return new Response(JSON.stringify({ ok: false, error: acctErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountList = accounts || [];
    console.log(`[daily-recon:${runId}] Processing ${accountList.length} accounts`);

    const results: Array<{
      account_id: string;
      invoice_number: string;
      before_total_paid: number;
      after_total_paid: number | null;
      success: boolean;
      guard_fired: boolean;
      error?: string;
    }> = [];

    let haltRun = false;

    for (const acct of accountList) {
      if (haltRun) break;

      const beforeTotalPaid = Number(acct.total_paid);
      console.log(`[daily-recon:${runId}] ${acct.invoice_number}: before total_paid=${beforeTotalPaid}`);

      let afterTotalPaid: number | null = null;
      let success = false;
      let guardFired = false;
      let errorMsg: string | undefined;

      try {
        const res = await fetch(
          `${Deno.env.get("SUPABASE_URL")}/functions/v1/reconcile-account`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            },
            body: JSON.stringify({ account_id: acct.id }),
          }
        );

        const body = await res.json();
        success = !!body.success;
        guardFired = !!body.guardFired;
        afterTotalPaid = typeof body.totalPaid === "number" ? body.totalPaid : null;

        console.log(
          `[daily-recon:${runId}] ${acct.invoice_number}: ` +
          `after total_paid=${afterTotalPaid}, success=${success}, guardFired=${guardFired}`
        );

        // Guard 4: halt entire run if total_paid decreased
        if (afterTotalPaid !== null && afterTotalPaid < beforeTotalPaid - 0.01) {
          console.error(
            `[daily-recon:${runId}] HALT — ${acct.invoice_number} total_paid decreased: ` +
            `${beforeTotalPaid} → ${afterTotalPaid}`
          );
          haltRun = true;
          errorMsg = `total_paid decreased: ${beforeTotalPaid} → ${afterTotalPaid}`;
        }

        if (guardFired) {
          console.warn(
            `[daily-recon:${runId}] ${acct.invoice_number}: reconcile-account guard fired (would have decreased total_paid)`
          );
        }

      } catch (err: any) {
        errorMsg = err.message;
        console.error(`[daily-recon:${runId}] ${acct.invoice_number}: fetch error:`, err);
      }

      results.push({
        account_id: acct.id,
        invoice_number: acct.invoice_number,
        before_total_paid: beforeTotalPaid,
        after_total_paid: afterTotalPaid,
        success,
        guard_fired: guardFired,
        ...(errorMsg ? { error: errorMsg } : {}),
      });
    }

    // Record completion timestamp
    await supabase.from("system_settings").upsert(
      { key: "last_daily_reconciliation", value: new Date().toISOString() },
      { onConflict: "key" }
    );

    const summary = {
      run_id: runId,
      run_start: runStart,
      run_end: new Date().toISOString(),
      accounts_processed: results.length,
      accounts_success: results.filter(r => r.success).length,
      accounts_guard_fired: results.filter(r => r.guard_fired).length,
      halted: haltRun,
      results,
    };

    console.log(`[daily-recon:${runId}] Done — ${summary.accounts_success}/${summary.accounts_processed} succeeded, halted=${haltRun}`);

    return new Response(JSON.stringify({ ok: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error(`[daily-recon:${runId}] Unexpected error:`, err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
