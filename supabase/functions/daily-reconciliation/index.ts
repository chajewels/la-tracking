import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole, parseJwtClaims } from "../_shared/jwt-claims.ts";

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

/**
 * Resolve (full_name, invoice) for a loyalty award notification. Mirrors
 * the helper used in review-payment-submission. Lookup failures degrade
 * to nulls so the notification insert is never blocked on a name miss.
 */
async function resolveAwardNotifyContext(
  supabase: any,
  src: {
    account_id?: string | null;
    cash_order_id?: string | null;
    customer_id?: string | null;
    invoice_number?: string | null;
  },
): Promise<{ fullName: string | null; invoice: string | null }> {
  if (src.cash_order_id) {
    try {
      let invoice = src.invoice_number ?? null;
      let custId = src.customer_id ?? null;
      if (!invoice || !custId) {
        const { data: order } = await supabase
          .from("cash_orders")
          .select("invoice_number, customer_id")
          .eq("id", src.cash_order_id)
          .maybeSingle();
        const row = order as { invoice_number?: string | null; customer_id?: string | null } | null;
        invoice = invoice ?? row?.invoice_number ?? null;
        custId = custId ?? row?.customer_id ?? null;
      }
      let fullName: string | null = null;
      if (custId) {
        const { data: cust } = await supabase
          .from("customers")
          .select("full_name")
          .eq("id", custId)
          .maybeSingle();
        fullName = (cust as { full_name?: string | null } | null)?.full_name ?? null;
      }
      return { fullName, invoice };
    } catch (_e) {
      return { fullName: null, invoice: src.invoice_number ?? null };
    }
  }
  if (src.account_id) {
    try {
      const { data: acct } = await supabase
        .from("layaway_accounts")
        .select("invoice_number, customers(full_name)")
        .eq("id", src.account_id)
        .maybeSingle();
      const row = acct as { invoice_number?: string | null; customers?: { full_name?: string | null } | null } | null;
      return {
        fullName: row?.customers?.full_name ?? null,
        invoice: row?.invoice_number ?? null,
      };
    } catch (_e) {
      return { fullName: null, invoice: null };
    }
  }
  return { fullName: null, invoice: null };
}

function fmtLoyaltyNum(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n ?? 0);
  return v.toLocaleString("en-US");
}

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

    // ──────────────────────────────────────────────────────────────
    // Loyalty self-healing checker. Replays award-loyalty-points for
    // recent cash-order completions and recent confirmed-submission
    // layaway accounts in the last 25h window. The award function's
    // own guards (already_awarded / not_enrolled / below_minimum)
    // make replay safe; recovered awards and hard failures surface
    // as staff_notifications. ENTIRELY non-blocking — a loyalty
    // problem must NEVER affect reconciliation or the completion
    // stamp below.
    // ──────────────────────────────────────────────────────────────
    try {
      // Lookback widened 25h -> 14 days after the 2026-06-08 -> 2026-06-12
      // outage (Bug #223) — the 25h window guaranteed any outage longer
      // than one daily cycle was permanently unrecoverable by the sweep.
      // Ordered oldest-first so older missed awards aren't starved by the
      // page LIMIT, and the LIMIT raised so a multi-week backlog can
      // drain across a few daily runs. award-loyalty-points is idempotent
      // via its already_awarded guard, so re-sweeping recently-awarded
      // rows is a no-op.
      const loyaltyWindowMs = 14 * 24 * 60 * 60 * 1000;
      const loyaltyCutoff = new Date(Date.now() - loyaltyWindowMs).toISOString();
      const loyaltyPageLimit = 500;
      const lpUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`;
      const lpHeaders = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
      };

      type Candidate =
        | { kind: "cash"; cash_order_id: string; customer_id: string | null; invoice_number: string | null }
        | { kind: "layaway"; account_id: string };

      const candidates: Candidate[] = [];

      const { data: cashRows } = await supabase
        .from("cash_orders")
        .select("id, customer_id, invoice_number")
        .gte("completed_at", loyaltyCutoff)
        .order("completed_at", { ascending: true })
        .limit(loyaltyPageLimit);
      for (const r of (cashRows ?? []) as any[]) {
        candidates.push({
          kind: "cash",
          cash_order_id: r.id,
          customer_id: r.customer_id ?? null,
          invoice_number: r.invoice_number ?? null,
        });
      }

      const { data: subRows } = await supabase
        .from("payment_submissions")
        .select("account_id")
        .eq("status", "confirmed")
        .not("account_id", "is", null)
        .gte("updated_at", loyaltyCutoff)
        .order("updated_at", { ascending: true })
        .limit(loyaltyPageLimit);
      const seenAccounts = new Set<string>();
      for (const r of (subRows ?? []) as any[]) {
        const aid = r.account_id as string | null;
        if (!aid || seenAccounts.has(aid)) continue;
        seenAccounts.add(aid);
        candidates.push({ kind: "layaway", account_id: aid });
      }

      let recoveredCount = 0;
      let failedCount = 0;

      for (const cand of candidates) {
        let result: Record<string, unknown> | null = null;
        try {
          const body = cand.kind === "cash"
            ? { cash_order_id: cand.cash_order_id, customer_id: cand.customer_id }
            : { account_id: cand.account_id };
          const res = await fetch(lpUrl, {
            method: "POST",
            headers: lpHeaders,
            body: JSON.stringify(body),
          });
          const lpJson = await res.json().catch(() => null);
          result = lpJson ?? { error: "no_response" };
        } catch (lpErr) {
          console.warn("[daily-reconciliation] award-loyalty-points call failed (non-blocking):", lpErr);
          result = { error: String(lpErr) };
        }

        if (!result) continue;
        const a: any = result;
        const sourceIds = cand.kind === "cash"
          ? { cash_order_id: cand.cash_order_id, customer_id: cand.customer_id, invoice_number: cand.invoice_number }
          : { account_id: cand.account_id };

        try {
          if (a.awarded === true) {
            recoveredCount++;
            const ctx = await resolveAwardNotifyContext(
              supabase,
              cand.kind === "cash"
                ? { cash_order_id: cand.cash_order_id, customer_id: cand.customer_id, invoice_number: cand.invoice_number }
                : { account_id: cand.account_id },
            );
            const who = ctx.fullName ? ` to ${ctx.fullName}` : "";
            await supabase.from("staff_notifications").insert({
              type: "loyalty_award_missing",
              title: "Loyalty award RECOVERED by daily checker",
              body: `+${fmtLoyaltyNum(a.points_earned)} pts awarded retroactively${who} · Inv #${ctx.invoice ?? "?"}`,
              customer_id: cand.kind === "cash" ? cand.customer_id : null,
              invoice_number: cand.kind === "cash" ? cand.invoice_number : null,
              account_id: cand.kind === "layaway" ? cand.account_id : null,
              metadata: { ...result, ...sourceIds },
            });
          } else if (a.error) {
            failedCount++;
            let invStr: string = "?";
            // Resolve customer name for the failure body. Cash awards have
            // cand.customer_id directly; layaway awards resolve via the
            // account_id → layaway_accounts → customers join (which also
            // surfaces the invoice number). If the lookup itself fails we
            // fall back to the original body — never skip the insert on a
            // name miss.
            let fullName: string | null = null;
            try {
              if (cand.kind === "cash") {
                invStr = cand.invoice_number ?? "?";
                const { data: cust } = await supabase
                  .from("customers")
                  .select("full_name")
                  .eq("id", cand.customer_id)
                  .maybeSingle();
                fullName = (cust as { full_name?: string | null } | null)?.full_name ?? null;
              } else if (cand.account_id) {
                const { data: acct } = await supabase
                  .from("layaway_accounts")
                  .select("invoice_number, customers(full_name)")
                  .eq("id", cand.account_id)
                  .maybeSingle();
                const row = acct as { invoice_number?: string | null; customers?: { full_name?: string | null } | null } | null;
                fullName = row?.customers?.full_name ?? null;
                invStr = row?.invoice_number ?? "?";
              }
            } catch (_lookupErr) {
              fullName = null;
            }
            const failBody = fullName
              ? `${fullName} · Inv #${invStr} — ${String(a.error)}`
              : `${String(a.error)} · Inv #${invStr}`;
            await supabase.from("staff_notifications").insert({
              type: "loyalty_award_failed",
              title: "Loyalty award FAILED in daily checker",
              body: failBody,
              customer_id: cand.kind === "cash" ? cand.customer_id : null,
              invoice_number: cand.kind === "cash" ? cand.invoice_number : null,
              account_id: cand.kind === "layaway" ? cand.account_id : null,
              metadata: { ...result, ...sourceIds },
            });
          }
          // skipped (already_awarded / not_enrolled / below_minimum / etc.): silent
        } catch (nErr) {
          console.warn("[daily-reconciliation] staff_notifications insert failed (non-blocking):", nErr);
        }
      }

      console.log(
        `[daily-reconciliation] loyalty checker: candidates=${candidates.length} recovered=${recoveredCount} failed=${failedCount}`,
      );
    } catch (loyaltyBlockErr) {
      console.warn("[daily-reconciliation] loyalty self-healing block failed (non-blocking):", loyaltyBlockErr);
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
