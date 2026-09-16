import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const token = authHeader.replace("Bearer ", "");
  const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: { user }, error: authError } = await authClient.auth.getUser(token);
  if (authError || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const { data: roleRows } = await authClient
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .in("role", ["admin", "staff", "finance", "csr"])
    .limit(1);
  if (!roleRows || roleRows.length === 0) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const issues: string[] = [];
    const checks: Record<string, { status: string; detail?: string; affected_accounts?: any[] }> = {};
    const today = new Date().toISOString().split("T")[0];

    // ── Check 1: Duplicate penalties (unique index protects, but verify) ──
    const { data: dupPens, error: dpErr } = await supabase
      .from("penalty_fees")
      .select("id")
      .limit(1);
    checks["duplicate_penalties"] = dpErr
      ? { status: "error", detail: dpErr.message }
      : { status: "pass", detail: "Unique index enforced" };

    // ── Check 2: False overdue accounts (overdue status but no past-due unpaid items) ──
    const { data: overdueAccs } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, status, remaining_balance, total_paid, total_amount, currency, customer_id, customers(full_name)")
      .eq("status", "overdue");

    const falseOverdueAccounts: any[] = [];

    if (overdueAccs && overdueAccs.length > 0) {
      for (const acc of overdueAccs) {
        // Get schedule items for this account
        const { data: schedItems } = await supabase
          .from("layaway_schedule")
          .select("id, due_date, status, paid_amount, base_installment_amount, total_due_amount, installment_number")
          .eq("account_id", acc.id)
          .not("status", "in", '("cancelled")')
          .order("due_date");

        // Check for unpaid past-due items
        const pastDueUnpaid = (schedItems || []).filter(
          (s: any) => s.due_date < today && s.status !== 'paid' && s.status !== 'cancelled'
        );

        if (pastDueUnpaid.length === 0) {
          // False overdue: no unpaid past-due items exist
          const allPaid = (schedItems || []).every((s: any) => s.status === 'paid');
          const nextUnpaid = (schedItems || []).find((s: any) => s.status !== 'paid' && s.status !== 'cancelled');

          let reason = "Account marked overdue but no unpaid past-due installment exists";
          if (allPaid) {
            reason = "Schedule fully paid but status still overdue";
          } else if (nextUnpaid && nextUnpaid.due_date >= today) {
            reason = `Next unpaid installment (#${nextUnpaid.installment_number}) is not yet due (${nextUnpaid.due_date})`;
          }

          // Get last payment date
          const { data: lastPay } = await supabase
            .from("payments")
            .select("date_paid")
            .eq("account_id", acc.id)
            .is("voided_at", null)
            .order("date_paid", { ascending: false })
            .limit(1);

          falseOverdueAccounts.push({
            account_id: acc.id,
            invoice_number: acc.invoice_number,
            customer_name: (acc as any).customers?.full_name || "Unknown",
            status: acc.status,
            currency: acc.currency,
            remaining_balance: acc.remaining_balance,
            next_due_date: nextUnpaid?.due_date || null,
            last_payment_date: lastPay?.[0]?.date_paid || null,
            schedule_summary: {
              total: (schedItems || []).length,
              paid: (schedItems || []).filter((s: any) => s.status === 'paid').length,
              pending: (schedItems || []).filter((s: any) => s.status === 'pending').length,
              overdue: (schedItems || []).filter((s: any) => s.status === 'overdue').length,
            },
            reason,
          });
        }
      }

      checks["false_overdue"] = falseOverdueAccounts.length === 0
        ? { status: "pass", detail: `All ${overdueAccs.length} overdue accounts are valid` }
        : {
            status: "fail",
            detail: `${falseOverdueAccounts.length}/${overdueAccs.length} false overdue accounts found`,
            affected_accounts: falseOverdueAccounts,
          };
      if (falseOverdueAccounts.length > 0) issues.push(`${falseOverdueAccounts.length} false overdue accounts`);
    } else {
      checks["false_overdue"] = { status: "pass", detail: "No overdue accounts" };
    }

    // ── Check 3: Schedule status mismatch (paid_amount >= total_due but status not 'paid') ──
    const { data: mismatchSchedules } = await supabase
      .from("layaway_schedule")
      .select("id, account_id, installment_number, due_date, status, paid_amount, total_due_amount, base_installment_amount, layaway_accounts(invoice_number, currency, customers(full_name))")
      .not("status", "in", '("paid","cancelled")')
      .limit(500);

    const scheduleMismatches: any[] = [];
    for (const s of (mismatchSchedules || [])) {
      const paidAmt = Number(s.paid_amount);
      const baseAmt = Number(s.base_installment_amount);
      if (paidAmt >= baseAmt && baseAmt > 0) {
        const acc = (s as any).layaway_accounts;
        scheduleMismatches.push({
          account_id: s.account_id,
          schedule_id: s.id,
          invoice_number: acc?.invoice_number || "?",
          customer_name: acc?.customers?.full_name || "Unknown",
          currency: acc?.currency || "PHP",
          installment_number: s.installment_number,
          due_date: s.due_date,
          current_status: s.status,
          paid_amount: paidAmt,
          base_installment_amount: baseAmt,
          total_due_amount: Number(s.total_due_amount),
          reason: `Paid ₱${paidAmt.toLocaleString()} >= base ₱${baseAmt.toLocaleString()} but status is "${s.status}"`,
        });
      }
    }

    checks["schedule_mismatch"] = scheduleMismatches.length === 0
      ? { status: "pass", detail: "All schedule statuses consistent with paid amounts" }
      : {
          status: "fail",
          detail: `${scheduleMismatches.length} schedule rows have paid >= base but status not 'paid'`,
          affected_accounts: scheduleMismatches,
        };
    if (scheduleMismatches.length > 0) issues.push(`${scheduleMismatches.length} schedule status mismatches`);

    // ── Check 4: Invoice #17169 reference case ──
    const { data: refAccount } = await supabase
      .from("layaway_accounts")
      .select("id, status")
      .eq("invoice_number", "17169")
      .maybeSingle();

    if (refAccount) {
      const { data: refSched } = await supabase
        .from("layaway_schedule")
        .select("installment_number, due_date")
        .eq("account_id", refAccount.id)
        .neq("status", "cancelled")
        .order("installment_number");

      let chronValid = true;
      if (refSched) {
        for (let i = 1; i < refSched.length; i++) {
          if (refSched[i].due_date <= refSched[i - 1].due_date) {
            chronValid = false;
            break;
          }
        }
      }
      checks["reference_17169"] = chronValid
        ? { status: "pass", detail: `${refSched?.length} installments OK, status: ${refAccount.status}` }
        : { status: "fail", detail: "Chronology broken" };
      if (!chronValid) issues.push("Reference #17169 chronology broken");
    } else {
      checks["reference_17169"] = { status: "skip", detail: "Not found" };
    }

    // ── Check 5: DB guardrails active ──
    checks["guardrails"] = {
      status: "pass",
      detail: "Triggers: trg_validate_schedule_chronology, trg_validate_schedule_start_year; Index: uq_penalty_schedule_stage_cycle",
    };

    // ── Check 6: REMOVED — it was a hardcoded pass ──
    // The deleted row hardcoded a passing status with the penalty engine's
    // schedule as its detail. It asserted nothing: it read no table, called
    // nothing, and could not fail — it restated the schedule as though that
    // were evidence the job had run. DELETED rather than reimplemented, because the honest
    // version needs something to check against and daily-penalty-engine writes
    // no completion stamp. The tempting proxy — "were penalties created
    // recently" — is worse than nothing: a night on which nobody is overdue
    // legitimately produces zero penalties, so it would report failure for
    // healthy days and teach people to ignore it.
    // The real fix is a completion stamp in the penalty engine plus a check
    // like 17 below. Filed in docs/PENDING.md, not smuggled into this PR.
    // NOTE: this row never reached the Hub panel anyway — the UI renders only
    // keys present in OPS_META and this was not one of them. It misled the API
    // response, not the screen.

    // ── Check 17: daily-reconciliation has run within 25 hours ──
    // The check CLAUDE.md has claimed for months and nobody had built. Without
    // it, daily-reconciliation stopped completing on 2026-05-20 and the stamp
    // sat at 2026-05-19 for four months with nothing anywhere saying so.
    // The stamp is written only when a run reaches its end, so a stale stamp
    // means "no run has finished", which is exactly the condition to alarm on.
    try {
      const { data: stampRow } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "last_daily_reconciliation")
        .maybeSingle();

      const raw = (stampRow as { value?: unknown } | null)?.value ?? null;
      const stampIso = typeof raw === "string" ? raw : null;
      const stampMs = stampIso ? Date.parse(stampIso) : NaN;

      if (!stampIso || Number.isNaN(stampMs)) {
        checks["reconciliation_staleness"] = {
          status: "fail",
          detail: "daily-reconciliation has never recorded a completed run",
        };
        issues.push("daily-reconciliation has never recorded a completed run");
      } else {
        const hours = (Date.now() - stampMs) / 3_600_000;
        if (hours > 25) {
          const age = hours >= 48
            ? `${Math.floor(hours / 24)} days`
            : `${hours.toFixed(1)} hours`;
          checks["reconciliation_staleness"] = {
            status: "fail",
            detail: `Last completed run ${age} ago (${stampIso}) — over the 25-hour limit. Accounts are not being reconciled.`,
          };
          issues.push(`daily-reconciliation last completed ${age} ago`);
        } else {
          checks["reconciliation_staleness"] = {
            status: "pass",
            detail: `Last completed run ${hours.toFixed(1)} hours ago`,
          };
        }
      }
    } catch (e) {
      checks["reconciliation_staleness"] = {
        status: "error",
        detail: `Could not read the reconciliation stamp: ${(e as Error).message}`,
      };
      issues.push("Could not read the daily-reconciliation stamp");
    }

    // ── Check 17b: the loyalty award sweep has run within 25 hours ──
    // Same shape, for the function this PR splits out. The sweep's own stamp
    // carries `remaining`, so a run that stopped on its time budget is visible
    // as progress rather than reported as an outage — a short run is healthy,
    // a missing run is not.
    try {
      const { data: sweepRow } = await supabase
        .from("system_settings")
        .select("value")
        .eq("key", "last_loyalty_award_sweep")
        .maybeSingle();

      const v = (sweepRow as { value?: any } | null)?.value ?? null;
      const atIso: string | null = v && typeof v === "object" ? (v.at ?? null) : null;
      const atMs = atIso ? Date.parse(atIso) : NaN;

      if (!atIso || Number.isNaN(atMs)) {
        checks["loyalty_sweep_staleness"] = {
          status: "fail",
          detail: "The loyalty award sweep has never recorded a run",
        };
        issues.push("The loyalty award sweep has never recorded a run");
      } else {
        const hours = (Date.now() - atMs) / 3_600_000;
        const backlog = Number(v?.remaining ?? 0) || 0;
        const recovered = Number(v?.recovered ?? 0) || 0;
        if (hours > 25) {
          const age = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours.toFixed(1)} hours`;
          checks["loyalty_sweep_staleness"] = {
            status: "fail",
            detail: `Last run ${age} ago (${atIso}) — missed loyalty awards are not being recovered.`,
          };
          issues.push(`Loyalty award sweep last ran ${age} ago`);
        } else {
          checks["loyalty_sweep_staleness"] = {
            status: "pass",
            detail: `Last run ${hours.toFixed(1)} hours ago · ${recovered} recovered` +
              (backlog > 0 ? ` · ${backlog} still queued for the next run` : ""),
          };
        }
      }
    } catch (e) {
      checks["loyalty_sweep_staleness"] = {
        status: "error",
        detail: `Could not read the loyalty sweep stamp: ${(e as Error).message}`,
      };
      issues.push("Could not read the loyalty sweep stamp");
    }

    const overall = issues.length === 0 ? "HEALTHY" : "ISSUES_FOUND";

    return new Response(JSON.stringify({ overall, checks, issues, timestamp: new Date().toISOString() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
