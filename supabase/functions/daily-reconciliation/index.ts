import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole } from "../_shared/jwt-claims.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ACCOUNTS_PER_RUN = 800;

// Stop and report rather than being killed mid-loop. reconcile-account costs
// ~2.0s per account (measured over five consecutive nights of reconciliation_log
// timestamps), so the 563 current candidates need ~19 minutes against a hard
// ~185s ceiling: the run died every night having covered ~120, and everything
// after the loop was unreachable. The cursor below resumes where this run
// stopped. Same shape as loyalty-award-sweep.
//
// One run therefore covers ~91 accounts, a ~6-day cycle. THE BUDGET IS NOT WHERE
// THE TIME GOES TO WASTE — it is all real per-account work — so the way to cover
// the list sooner is more runs, not a cheaper cursor: a second cron at 12:20 UTC
// (migration 20260923100000) makes it ~182 a day and a ~3-day cycle.
const BUDGET_MS = 150_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Service-role-only guard — cron-only endpoint.
  const authToken = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!isServiceRole(authToken)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const runId = crypto.randomUUID().slice(0, 8);
  const runStart = new Date().toISOString();
  const runStartMs = Date.now();
  console.log(`[daily-recon:${runId}] Starting run at ${runStart}, max=${MAX_ACCOUNTS_PER_RUN}`);

  try {
    // Candidates AND ordering, in one query. The ordering key USED TO BE
    // layaway_accounts.updated_at, and that was the bug: reconcile-account is
    // report-only (Bug #34) — it writes one reconciliation_log row and never
    // touches the account — so reconciling a row left updated_at untouched and
    // every run got the same head of the same list, forever. The cursor is
    // reconciliation_log.checked_at, which reconciling DOES advance.
    //
    // That cursor was built here in JS, by paging reconciliation_log newest-first
    // into a Map until it had seen as many distinct accounts as there were
    // candidates. It was cheap (~3 pages, ~60ms of database time) but it was not
    // correct: the stop condition counts every account the log has ever carried,
    // not the candidates, so it can stop with candidates still unseen and hand
    // them to the sort as "never reconciled" — and the page count grows with the
    // log, not with the work. next_reconciliation_batch does the same ordering in
    // SQL, exactly, over the whole log, in one round trip.
    const { data: accounts, error: acctErr } = await supabase.rpc(
      "next_reconciliation_batch",
      { p_limit: MAX_ACCOUNTS_PER_RUN }
    );

    if (acctErr) {
      console.error(`[daily-recon:${runId}] Failed to fetch accounts:`, acctErr);
      return new Response(JSON.stringify({ ok: false, error: acctErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Already ordered by the RPC: never reconciled first, then oldest first,
    // stable on id. Nothing to sort here.
    const accountList = (accounts || []) as Array<{
      id: string;
      invoice_number: string;
      status: string;
      total_paid: number;
      remaining_balance: number;
      last_checked_at: string | null;
    }>;

    const neverChecked = accountList.filter((a) => a.last_checked_at === null).length;
    console.log(
      `[daily-recon:${runId}] ${accountList.length} candidates, ` +
      `${neverChecked} never reconciled, budget ${BUDGET_MS}ms`
    );

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
    let budgetExhausted = false;

    for (const acct of accountList) {
      if (haltRun) break;

      // Checked BEFORE the work, never after, so the stamp and the summary
      // below are always reached. A budget-exhausted run is progress, not an
      // outage — `remaining` is how the two are told apart.
      if (Date.now() - runStartMs > BUDGET_MS) {
        budgetExhausted = true;
        console.log(
          `[daily-recon:${runId}] budget reached after ${results.length}/${accountList.length} — ` +
          `the next run resumes from the cursor`
        );
        break;
      }

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

        if (!res.ok) {
          const _t = await res.clone().text().catch(() => "<no body>");
          console.error(`[daily-reconciliation] reconcile-account failed (${res.status}) for ${acct.invoice_number}: ${_t}`);
        }

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

    // The loyalty self-healing checker USED TO RUN HERE, and that was the bug.
    // Sequenced after the loop above, it could never be reached: the loop dies
    // against a hard ~185s ceiling having covered ~120 of 493 accounts, so the
    // checker produced one staff notification in ninety days. It now lives in
    // its own function on its own cron — supabase/functions/loyalty-award-sweep
    // — where reconciliation's failure cannot silence it. Do not move it back.

    // Record completion timestamp
    // Written on EVERY run that reaches here, including a budget-exhausted one:
    // a partial run is still a run, and Check 17 asking "did this job run today"
    // must not read a partial pass as an outage. `remaining` distinguishes them.
    // The shape changed from a bare ISO string to an object on 2026-09-17;
    // Check 17 reads both, so deploy order does not matter.
    const remaining = accountList.length - results.length;
    await supabase.from("system_settings").upsert(
      {
        key: "last_daily_reconciliation",
        value: {
          at: new Date().toISOString(),
          run_id: runId,
          evaluated: results.length,
          candidates: accountList.length,
          remaining,
          never_checked_at_start: neverChecked,
          budget_exhausted: budgetExhausted,
          halted: haltRun,
        },
      },
      { onConflict: "key" }
    );

    const accountsWithDrift = results.filter(r => r.drift_detected).length;
    const totalDriftItems = results.reduce((s, r) => s + r.drift_count, 0);

    const summary = {
      run_id: runId,
      run_start: runStart,
      run_end: new Date().toISOString(),
      accounts_processed: results.length,
      candidates: accountList.length,
      remaining,
      never_checked_at_start: neverChecked,
      budget_exhausted: budgetExhausted,
      elapsed_ms: Date.now() - runStartMs,
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
