import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ACCOUNTS_PER_RUN = 800;

// Helper: retry fetch on Deno runtime rate limit (RateLimitError).
// Ported verbatim from send-reminders/index.ts (Bug #114 / Phase 7 fix,
// commit 8ea5b2a). Duplicate-in-file per the Phase 7 pattern; future
// cleanup can DRY both into a shared helper.
async function fetchWithRetryOnRateLimit(
  url: string,
  init: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      const isRateLimit =
        e && typeof e === 'object' && 'name' in e &&
        (e as { name: string }).name === 'RateLimitError';
      if (!isRateLimit || attempt >= maxRetries) {
        throw e;
      }
      const retryAfterMs =
        typeof (e as { retryAfterMs?: number }).retryAfterMs === 'number'
          ? (e as { retryAfterMs: number }).retryAfterMs
          : 200;
      console.warn(
        `Rate limited at fetch, retry after ${retryAfterMs + 50}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise((r) => setTimeout(r, retryAfterMs + 50));
    }
  }
  throw new Error('fetchWithRetryOnRateLimit: exhausted retries unexpectedly');
}

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
      .in("status", ["active", "overdue", "extension_active", "final_settlement"])
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
      drift_detected: boolean;
      drift_count: number;
      guard_fired: boolean;
      error?: string;
    }> = [];

    let haltRun = false;

    for (const acct of accountList) {
      if (haltRun) break;

      const beforeTotalPaid = Number(acct.total_paid);
      console.log(`[daily-recon:${runId}] ${acct.invoice_number}: before total_paid=${beforeTotalPaid}`);

      let afterTotalPaid: number | null = null;
      let driftDetected = false;
      let driftCount = 0;
      let guardFired = false;
      let errorMsg: string | undefined;

      try {
        const res = await fetchWithRetryOnRateLimit(
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
        driftDetected = body.drift_detected ?? false;
        driftCount = body.drift_count ?? 0;
        guardFired = !!body.guardFired;
        afterTotalPaid = body.computed?.total_paid ?? null;

        console.log(
          `[daily-recon:${runId}] ${acct.invoice_number}: ` +
          `drift=${driftDetected ? driftCount + " items" : "none"}, guardFired=${guardFired}`
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
        drift_detected: driftDetected,
        drift_count: driftCount,
        guard_fired: guardFired,
        ...(errorMsg ? { error: errorMsg } : {}),
      });
    }

    // Record completion timestamp
    await supabase.from("system_settings").upsert(
      { key: "last_daily_reconciliation", value: new Date().toISOString() },
      { onConflict: "key" }
    );

    const accountsWithDrift = results.filter(r => r.drift_detected).length;
    const totalDriftItems = results.reduce((s, r) => s + r.drift_count, 0);

    const summary = {
      run_id: runId,
      run_start: runStart,
      run_end: new Date().toISOString(),
      accounts_processed: results.length,
      accounts_with_drift: accountsWithDrift,
      total_drift_items: totalDriftItems,
      accounts_guard_fired: results.filter(r => r.guard_fired).length,
      halted: haltRun,
      results,
    };

    console.log(`[daily-recon:${runId}] Done — ${accountsWithDrift}/${results.length} with drift (${totalDriftItems} items), halted=${haltRun}`);

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
