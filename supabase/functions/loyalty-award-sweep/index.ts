import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, corsPreflight, jsonResponse } from "../_shared/cors.ts";
import { isServiceRole } from "../_shared/jwt-claims.ts";
import { fetchWithRetryOnRateLimit } from "../_shared/fetch-retry.ts";

/**
 * LOYALTY AWARD SWEEP — the self-healing checker, as its own function.
 *
 * WHY IT LIVES HERE NOW. This block used to sit at the end of
 * daily-reconciliation, after a loop over every active account. That loop
 * cannot finish: measured on live, the run dies against a hard ~185s ceiling
 * having reconciled ~120 of 493 accounts, at 1.56s each. Everything sequenced
 * after it is therefore not "occasionally skipped" — it is UNREACHABLE. The
 * evidence is that the checker produced ONE staff notification in ninety days,
 * and daily-reconciliation's completion stamp has read 2026-05-19 ever since
 * nightly volume crossed the ceiling on 2026-05-20.
 *
 * The old code called this block "ENTIRELY non-blocking — a loyalty problem
 * must NEVER affect reconciliation". That was true in the direction it worried
 * about and false in the other: reconciliation's failure silently killed
 * loyalty. Independence you only assert is not independence. This function IS
 * the independence.
 *
 * IT CANNOT INHERIT THE SAME FAILURE. The work is bounded by TIME, not by a
 * row count: it stops at BUDGET_MS and reports how far it got, so a growing
 * backlog makes runs shorter of the total rather than making them fail. The
 * sweep is idempotent — award-loyalty-points refuses a second award through
 * its own already_awarded guard — so stopping early and resuming tomorrow
 * costs nothing but a day. Oldest-first ordering means a backlog drains in a
 * stable direction instead of starving its own tail, which is the mistake
 * daily-reconciliation still makes and which its own PR fixes.
 *
 * WHAT IT DOES NOT DO: it never awards points itself. It asks
 * award-loyalty-points, which owns every rule — enrolment, the loyalty_enabled
 * gate, the amount gate, the idempotency claim (Bug #269). A "recovered" award
 * here is that function deciding an award was genuinely owed and never made.
 */

const BUDGET_MS = 120_000;          // stop and report; the cron comes back tomorrow
const PAGE_LIMIT = 500;             // per source table
const LOOKBACK_DAYS = 14;           // as before: survives an outage longer than one cycle

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
          .from("customers").select("full_name").eq("id", custId).maybeSingle();
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
      return { fullName: row?.customers?.full_name ?? null, invoice: row?.invoice_number ?? null };
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
  const pre = corsPreflight(req);
  if (pre) return pre;

  // Service-role only — cron endpoint. Claims-based, never string equality
  // against the env key (CLAUDE.md EDGE FUNCTION SERVICE-ROLE AUTH PATTERN).
  const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
  if (!isServiceRole(token)) return jsonResponse({ error: "Forbidden" }, 403);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const startedAt = Date.now();
  const runId = crypto.randomUUID().slice(0, 8);
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[loyalty-sweep:${runId}] start, lookback ${LOOKBACK_DAYS}d, budget ${BUDGET_MS}ms`);

  try {
    type Candidate =
      | { kind: "cash"; cash_order_id: string; customer_id: string | null; invoice_number: string | null }
      | { kind: "layaway"; account_id: string };

    const candidates: Candidate[] = [];

    const { data: cashRows } = await supabase
      .from("cash_orders")
      .select("id, customer_id, invoice_number")
      .gte("completed_at", cutoff)
      .order("completed_at", { ascending: true })
      .limit(PAGE_LIMIT);
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
      .gte("updated_at", cutoff)
      .order("updated_at", { ascending: true })
      .limit(PAGE_LIMIT);
    const seen = new Set<string>();
    for (const r of (subRows ?? []) as any[]) {
      const aid = r.account_id as string | null;
      if (!aid || seen.has(aid)) continue;
      seen.add(aid);
      candidates.push({ kind: "layaway", account_id: aid });
    }

    const lpUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/award-loyalty-points`;
    const lpHeaders = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    };

    let processed = 0;
    let recovered = 0;
    let failed = 0;
    // A candidate the sweep could not even ASK about. Counted apart from
    // `failed` because the two mean opposite things: `failed` is
    // award-loyalty-points deciding an award could not be made, `unreachable`
    // is this function never getting an answer. Conflating them is what made
    // the first run read as 257 failed awards when 257 awards were never
    // evaluated at all.
    let unreachable = 0;
    const unreachableDetail: Array<Record<string, unknown>> = [];
    let pointsRecovered = 0;
    const recoveredDetail: Array<Record<string, unknown>> = [];
    let budgetExhausted = false;

    for (const cand of candidates) {
      // TIME is the limit, not a row count. Checked BEFORE the call so the
      // summary and the stamp below are always reached.
      if (Date.now() - startedAt > BUDGET_MS) {
        budgetExhausted = true;
        console.warn(
          `[loyalty-sweep:${runId}] budget reached after ${processed}/${candidates.length} — ` +
          `the rest resume on the next run (the sweep is idempotent)`,
        );
        break;
      }

      processed++;
      let result: Record<string, unknown> | null = null;
      let transportError: unknown = null;
      try {
        const body = cand.kind === "cash"
          ? { cash_order_id: cand.cash_order_id, customer_id: cand.customer_id }
          : { account_id: cand.account_id };
        // RETRYING FETCH, NOT A BARE ONE. The Deno isolate's rate limiter
        // REJECTS rather than returning 429, so a bare fetch turns a 22-second
        // wait into an instant, permanent-looking failure — and on the first
        // real run it did that 257 times inside one second.
        const res = await fetchWithRetryOnRateLimit(lpUrl, {
          method: "POST", headers: lpHeaders, body: JSON.stringify(body),
        });
        if (!res.ok) {
          const t = await res.clone().text().catch(() => "<no body>");
          console.error(`[loyalty-sweep:${runId}] award-loyalty-points ${res.status}: ${t}`);
        }
        result = (await res.json().catch(() => null)) ?? { error: "no_response" };
      } catch (e) {
        // Retries are exhausted or this was never a rate limit. Either way the
        // candidate was NOT evaluated, so it does not become a failed award.
        transportError = e;
      }

      if (transportError !== null) {
        unreachable++;
        const ids = cand.kind === "cash"
          ? { cash_order_id: cand.cash_order_id, invoice_number: cand.invoice_number }
          : { account_id: cand.account_id };
        unreachableDetail.push({ ...ids, error: String(transportError) });
        console.warn(`[loyalty-sweep:${runId}] unreachable after retries:`, transportError);
        // NO per-candidate notification. One outage is one thing to tell
        // somebody, not 257 — the aggregate is raised after the loop.
        continue;
      }

      const a: any = result as Record<string, unknown>;
      const sourceIds = cand.kind === "cash"
        ? { cash_order_id: cand.cash_order_id, customer_id: cand.customer_id, invoice_number: cand.invoice_number }
        : { account_id: cand.account_id };

      try {
        if (a.awarded === true) {
          recovered++;
          pointsRecovered += Number(a.points_earned ?? 0) || 0;
          const ctx = await resolveAwardNotifyContext(supabase, { ...sourceIds } as any);
          const who = ctx.fullName ? ` to ${ctx.fullName}` : "";
          recoveredDetail.push({
            ...sourceIds,
            customer: ctx.fullName,
            invoice: ctx.invoice,
            points_earned: a.points_earned ?? null,
          });
          await supabase.from("staff_notifications").insert({
            type: "loyalty_award_missing",
            title: "Loyalty award RECOVERED by the sweep",
            body: `+${fmtLoyaltyNum(a.points_earned)} pts awarded retroactively${who} · Inv #${ctx.invoice ?? "?"}`,
            customer_id: cand.kind === "cash" ? cand.customer_id : null,
            invoice_number: cand.kind === "cash" ? cand.invoice_number : null,
            account_id: cand.kind === "layaway" ? cand.account_id : null,
            metadata: { ...result, ...sourceIds, run_id: runId },
          });
        } else if (a.error) {
          failed++;
          const ctx = await resolveAwardNotifyContext(supabase, { ...sourceIds } as any);
          const failBody = ctx.fullName
            ? `${ctx.fullName} · Inv #${ctx.invoice ?? "?"} — ${String(a.error)}`
            : `${String(a.error)} · Inv #${ctx.invoice ?? "?"}`;
          await supabase.from("staff_notifications").insert({
            type: "loyalty_award_failed",
            title: "Loyalty award FAILED in the sweep",
            body: failBody,
            customer_id: cand.kind === "cash" ? cand.customer_id : null,
            invoice_number: cand.kind === "cash" ? cand.invoice_number : null,
            account_id: cand.kind === "layaway" ? cand.account_id : null,
            metadata: { ...result, ...sourceIds, run_id: runId },
          });
        }
        // skipped (already_awarded / not_enrolled / no_loyalty_amount / …): silent by design
      } catch (nErr) {
        console.warn(`[loyalty-sweep:${runId}] notification insert failed (non-blocking):`, nErr);
      }
    }

    // ONE notification for an outage, raised after the loop.
    //
    // This still RAISES — exhausted retries are a real failure and somebody
    // has to know the sweep could not do its job. What changed is the
    // cardinality: 257 rows for one rate-limit event told nobody anything they
    // could act on, and each row asserted a failed award that had never been
    // evaluated. The type stays `loyalty_award_failed` so the Hub bell renders
    // it with its existing failure treatment.
    if (unreachable > 0) {
      try {
        await supabase.from("staff_notifications").insert({
          type: "loyalty_award_failed",
          title: "Loyalty sweep could not reach award-loyalty-points",
          body:
            `${unreachable} of ${candidates.length} candidates were NOT evaluated — ` +
            `the award service was unreachable after retries. These are unknown, not ` +
            `resolved: the next run re-asks them. Run ${runId}.`,
          metadata: { run_id: runId, unreachable, candidates: candidates.length, detail: unreachableDetail.slice(0, 50) },
        });
      } catch (nErr) {
        console.warn(`[loyalty-sweep:${runId}] outage notification failed (non-blocking):`, nErr);
      }
    }

    // The completion stamp is what System Health Check 17's sibling reads. It
    // is written on EVERY run that reaches here, including a budget-exhausted
    // one — a short run is progress, not an outage, and the two must be
    // distinguishable. `remaining` is how you tell them apart.
    const remaining = candidates.length - processed;
    await supabase.from("system_settings").upsert(
      {
        key: "last_loyalty_award_sweep",
        value: {
          at: new Date().toISOString(),
          run_id: runId,
          candidates: candidates.length,
          processed,
          // `processed` counts candidates the loop REACHED; `evaluated` counts
          // the ones award-loyalty-points actually answered. They differ by
          // `unreachable`, and only `evaluated` licenses any claim about what
          // was or was not owed.
          evaluated: processed - unreachable,
          remaining,
          recovered,
          failed,
          unreachable,
          points_recovered: pointsRecovered,
          budget_exhausted: budgetExhausted,
        },
      },
      { onConflict: "key" },
    );

    const summary = {
      ok: true,
      run_id: runId,
      elapsed_ms: Date.now() - startedAt,
      candidates: candidates.length,
      processed,
      evaluated: processed - unreachable,
      remaining,
      recovered,
      failed,
      unreachable,
      points_recovered: pointsRecovered,
      budget_exhausted: budgetExhausted,
      recovered_detail: recoveredDetail,
      unreachable_detail: unreachableDetail,
    };
    console.log(`[loyalty-sweep:${runId}] done —`, JSON.stringify({ ...summary, recovered_detail: undefined }));
    return jsonResponse(summary);
  } catch (err: any) {
    console.error(`[loyalty-sweep:${runId}] unexpected error:`, err);
    return jsonResponse({ ok: false, error: err?.message ?? String(err) }, 500);
  }
});
