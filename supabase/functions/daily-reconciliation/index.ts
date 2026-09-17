import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole } from "../_shared/jwt-claims.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_ACCOUNTS_PER_RUN = 800;

// Stop and report rather than being killed mid-loop. reconcile-account costs
// ~1.56s per account, so 493 accounts need ~13 minutes against a hard ~185s
// ceiling: the run died every night having covered ~120, and everything after
// the loop was unreachable. The cron comes back tomorrow and the cursor below
// resumes where this run stopped. Same shape as loyalty-award-sweep.
const BUDGET_MS = 150_000;

// Page size for the reconciliation_log sweep that builds the cursor.
const LOG_PAGE = 1000;

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
    // Candidates first, ordering second. The ordering key USED TO BE
    // layaway_accounts.updated_at, and that was the bug: reconcile-account is
    // report-only (Bug #34) — it writes one reconciliation_log row and never
    // touches the account — so reconciling a row left updated_at untouched and
    // every run got the same head of the same list, forever. 55% of accounts
    // had not been reconciled once in eight days. The cursor below is
    // reconciliation_log.checked_at, which reconciling DOES advance.
    const { data: accounts, error: acctErr } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, status, total_paid, remaining_balance")
      .in("status", ["active", "overdue", "extension_active", "final_settlement"])
      .limit(MAX_ACCOUNTS_PER_RUN);

    if (acctErr) {
      console.error(`[daily-recon:${runId}] Failed to fetch accounts:`, acctErr);
      return new Response(JSON.stringify({ ok: false, error: acctErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const candidates = accounts || [];

    // One paginated pass over reconciliation_log, JS-aggregated to a
    // Map<account_id, latest checked_at> — no N+1 and no .in(ids) URL-length
    // risk (Bug #59 precedent). Rows come back newest-first, so the FIRST
    // sighting of an account is its latest run; we stop as soon as every
    // candidate is accounted for.
    const lastChecked = new Map<string, string>();
    for (let from = 0; lastChecked.size < candidates.length; from += LOG_PAGE) {
      const { data: logRows, error: logErr } = await supabase
        .from("reconciliation_log")
        .select("account_id, checked_at")
        .order("checked_at", { ascending: false })
        .range(from, from + LOG_PAGE - 1);
      if (logErr) {
        console.error(`[daily-recon:${runId}] reconciliation_log page ${from} failed:`, logErr);
        break; // fall back to whatever we have — never-checked accounts still sort first
      }
      if (!logRows || logRows.length === 0) break;
      for (const r of logRows as Array<{ account_id: string; checked_at: string }>) {
        if (r.account_id && !lastChecked.has(r.account_id)) lastChecked.set(r.account_id, r.checked_at);
      }
      if (logRows.length < LOG_PAGE) break;
    }

    // Never reconciled first, then oldest first. Stable on id so a tie cannot
    // make two runs disagree about who is next.
    const accountList = [...candidates].sort((a, b) => {
      const ta = lastChecked.get(a.id);
      const tb = lastChecked.get(b.id);
      if (ta === undefined && tb === undefined) return a.id < b.id ? -1 : 1;
      if (ta === undefined) return -1;
      if (tb === undefined) return 1;
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

    const neverChecked = accountList.filter((a) => !lastChecked.has(a.id)).length;
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
