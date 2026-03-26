import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const CLOSED_STATUSES = ["forfeited", "final_forfeited", "cancelled", "completed"];
const PAGE = 1000;

interface CheckResult {
  id: number;
  section: "data" | "benchmark" | "system";
  label: string;
  description: string;
  status: "pass" | "fail" | "skip";
  expected: string;
  affectedCount: number;
  affectedAccounts: Array<{ account_id: string; invoice_number: string; customer_name: string; detail: string }>;
}

async function fetchAll(supabase: any, table: string, select: string, filter?: (q: any) => any): Promise<any[]> {
  let all: any[] = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data } = await q;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function index<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of arr) (out[key(item)] ||= []).push(item);
  return out;
}

function isEffectivelyPaid(s: any): boolean {
  return s.status === "paid" ||
    (s.status === "partially_paid" && Number(s.paid_amount) >= Number(s.total_due_amount));
}

function isDPPayment(p: any): boolean {
  return p.payment_type === "downpayment" ||
    p.payment_type === "dp" ||
    p.is_downpayment === true ||
    (p.reference_number && String(p.reference_number).startsWith("DP-")) ||
    (p.remarks && String(p.remarks).toLowerCase().includes("down")) ||
    (p.remarks && String(p.remarks).toLowerCase().includes("dp"));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const today = new Date().toISOString().split("T")[0];
    const startTime = Date.now();

    // ── Fetch all data in parallel ──
    const [accounts, schedules, penalties, payments, services] = await Promise.all([
      fetchAll(supabase, "layaway_accounts",
        "id, invoice_number, status, currency, total_amount, total_paid, remaining_balance, downpayment_amount, payment_plan_months, statement_token, customers!inner(full_name)"),
      fetchAll(supabase, "layaway_schedule",
        "id, account_id, installment_number, due_date, base_installment_amount, total_due_amount, paid_amount, status",
        q => q.neq("status", "cancelled")),
      fetchAll(supabase, "penalty_fees",
        "id, account_id, schedule_id, penalty_amount, status"),
      fetchAll(supabase, "payments",
        "id, account_id, amount_paid, payment_type, is_downpayment, reference_number, remarks, voided_at"),
      fetchAll(supabase, "account_services",
        "id, account_id, amount"),
    ]);

    // ── Index by account_id ──
    const schedByAcct = index(schedules, s => s.account_id);
    const penByAcct   = index(penalties, p => p.account_id);
    const payByAcct   = index(payments,  p => p.account_id);
    const svcByAcct   = index(services,  s => s.account_id);
    const schedById: Record<string, any> = {};
    for (const s of schedules) schedById[s.id] = s;

    const activeAccounts = accounts.filter((a: any) => !CLOSED_STATUSES.includes(a.status));
    const acctById: Record<string, any> = {};
    for (const a of activeAccounts) acctById[a.id] = a;

    const checks: CheckResult[] = [];

    // ══════════════════════════════════════
    // SECTION 1 — DATA INTEGRITY
    // ══════════════════════════════════════

    // Check 1: Balance Integrity
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        const pens  = penByAcct[acct.id] || [];
        const pays  = (payByAcct[acct.id] || []).filter((p: any) => !p.voided_at);
        const svcs  = svcByAcct[acct.id] || [];
        const activePen  = pens.filter((p: any) => p.status !== "waived").reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
        const svcSum     = svcs.reduce((s: number, sv: any) => s + Number(sv.amount), 0);
        const totalPaid  = pays.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
        const computed   = Math.max(0, Number(acct.total_amount) + activePen + svcSum - totalPaid);
        const stored     = Number(acct.remaining_balance);
        if (Math.abs(computed - stored) > 1) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `Stored: ${stored.toLocaleString()} | Computed: ${Math.round(computed * 100) / 100}` });
        }
      }
      checks.push({ id: 1, section: "data", label: "Balance Integrity",
        description: "remaining_balance = total_amount + activePenalties + services − totalPaid",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 mismatches",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // Check 2: Schedule Integrity
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        const scheds = schedByAcct[acct.id] || [];
        const remaining = Number(acct.remaining_balance);
        const allPaid = scheds.length > 0 && scheds.every(isEffectivelyPaid);
        if (allPaid && remaining > 1) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `All months paid but remaining_balance = ${remaining.toLocaleString()}` });
          continue;
        }
        const pendingMonths = scheds.filter((s: any) => !isEffectivelyPaid(s));
        if (remaining <= 0 && pendingMonths.length > 0) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `Balance = 0 but ${pendingMonths.length} pending month(s) exist` });
        }
      }
      checks.push({ id: 2, section: "data", label: "Schedule Integrity",
        description: "No fully-paid accounts with positive balance; no zero-balance accounts with pending months",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 mismatches",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // Check 3: Payment Integrity
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        const pays = (payByAcct[acct.id] || []).filter((p: any) => !p.voided_at);
        const actualPaid = pays.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
        const storedPaid = Number(acct.total_paid);
        if (Math.abs(actualPaid - storedPaid) > 1) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `SUM(payments) = ${Math.round(actualPaid * 100) / 100} | total_paid = ${storedPaid}` });
        }
      }
      checks.push({ id: 3, section: "data", label: "Payment Integrity",
        description: "SUM(non-voided payments.amount_paid) matches account.total_paid",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 mismatches",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // Check 4: Downpayment Integrity
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        const dp = Number(acct.downpayment_amount);
        if (dp <= 0) continue;
        const pays = (payByAcct[acct.id] || []).filter((p: any) => !p.voided_at);
        const totalPaid = pays.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
        if (totalPaid < dp) continue; // DP not yet due — not a data error
        if (!pays.some(isDPPayment)) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `DP of ${dp.toLocaleString()} expected but no DP-tagged payment found` });
        }
      }
      checks.push({ id: 4, section: "data", label: "Downpayment Integrity",
        description: "Accounts whose total_paid covers the DP have a DP-tagged payment",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 missing DP payments",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // Check 5: Penalty Integrity (waived penalties not stale on schedule rows)
    {
      const affected: CheckResult["affectedAccounts"] = [];
      const flagged = new Set<string>();
      for (const pen of penalties) {
        if (pen.status !== "waived") continue;
        if (!acctById[pen.account_id]) continue; // closed account
        const sched = schedById[pen.schedule_id];
        if (!sched || Number(sched.penalty_amount) === 0) continue;
        if (!flagged.has(pen.account_id)) {
          flagged.add(pen.account_id);
          const acct = acctById[pen.account_id];
          affected.push({ account_id: pen.account_id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `Month ${sched.installment_number}: waived but schedule still has penalty_amount = ${sched.penalty_amount}` });
        }
      }
      checks.push({ id: 5, section: "data", label: "Penalty Integrity",
        description: "Waived penalties have their linked schedule row penalty_amount = 0",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 stale waived penalties",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // ══════════════════════════════════════
    // SECTION 2 — BENCHMARK VERIFICATION
    // ══════════════════════════════════════

    const runBenchmarkChecks = (invoiceNumber: string): { status: "pass" | "fail" | "skip"; issues: CheckResult["affectedAccounts"] } => {
      const acct = accounts.find((a: any) => a.invoice_number === invoiceNumber);
      if (!acct) return { status: "skip", issues: [] };

      const scheds = schedByAcct[acct.id] || [];
      const pens   = penByAcct[acct.id] || [];
      const pays   = (payByAcct[acct.id] || []).filter((p: any) => !p.voided_at);
      const svcs   = svcByAcct[acct.id] || [];
      const issues: CheckResult["affectedAccounts"] = [];

      const activePen  = pens.filter((p: any) => p.status !== "waived").reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
      const svcSum     = svcs.reduce((s: number, sv: any) => s + Number(sv.amount), 0);
      const totalPaid  = pays.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
      const computed   = Math.max(0, Number(acct.total_amount) + activePen + svcSum - totalPaid);
      const stored     = Number(acct.remaining_balance);

      const add = (detail: string) => issues.push({
        account_id: acct.id, invoice_number: invoiceNumber,
        customer_name: acct.customers?.full_name || "", detail });

      if (Math.abs(computed - stored) > 1) add(`Balance mismatch: stored ${stored} vs computed ${Math.round(computed * 100) / 100}`);
      if (Math.abs(totalPaid - Number(acct.total_paid)) > 1) add(`Payment sum ${Math.round(totalPaid * 100) / 100} ≠ total_paid ${acct.total_paid}`);
      for (const s of scheds) {
        if (Number(s.paid_amount) >= Number(s.total_due_amount) && Number(s.total_due_amount) > 0 && s.status !== "paid")
          add(`Month ${s.installment_number}: paid ≥ due but status = ${s.status}`);
      }
      for (const p of pens.filter((p: any) => p.status === "waived")) {
        const s = schedById[p.schedule_id];
        if (s && Number(s.penalty_amount) > 0)
          add(`Month ${s.installment_number}: waived penalty but schedule still shows penalty_amount = ${s.penalty_amount}`);
      }
      return { status: issues.length === 0 ? "pass" : "fail", issues };
    };

    // Check 6: TEST-001
    {
      const { status, issues } = runBenchmarkChecks("TEST-001");
      checks.push({ id: 6, section: "benchmark", label: "TEST-001 — Locked Benchmark",
        description: "Locked reference account passes all data integrity checks",
        status, expected: "0 issues", affectedCount: issues.length, affectedAccounts: issues });
    }

    // Check 7: TEST-003
    {
      const { status, issues } = runBenchmarkChecks("TEST-003");
      checks.push({ id: 7, section: "benchmark", label: "TEST-003 — Split Payment Test",
        description: "Split payment test account passes data integrity checks",
        status, expected: "0 issues", affectedCount: issues.length, affectedAccounts: issues });
    }

    // Check 8: TEST-004
    {
      const { status, issues } = runBenchmarkChecks("TEST-004");
      checks.push({ id: 8, section: "benchmark", label: "TEST-004 — Split Payment Test",
        description: "Split payment test account passes data integrity checks",
        status, expected: "0 issues", affectedCount: issues.length, affectedAccounts: issues });
    }

    // ══════════════════════════════════════
    // SECTION 3 — SYSTEM FUNCTIONS
    // ══════════════════════════════════════

    // Check 9: Customer Portal tokens
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        if (!acct.statement_token) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: "statement_token is null — portal link broken" });
        }
      }
      checks.push({ id: 9, section: "system", label: "Customer Portal Tokens",
        description: "All active accounts have a valid portal token (statement_token)",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 missing tokens",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // Check 10: Overdue Logic — no false OVERDUE flags
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts.filter((a: any) => a.status === "overdue")) {
        const scheds = schedByAcct[acct.id] || [];
        const hasUnpaidPastDue = scheds.some((s: any) =>
          s.due_date < today && !isEffectivelyPaid(s)
        );
        if (!hasUnpaidPastDue) {
          const nextUnpaid = scheds.find((s: any) => !isEffectivelyPaid(s));
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `Marked overdue but no unpaid past-due month. Next unpaid: ${nextUnpaid?.due_date || "none"}` });
        }
      }
      checks.push({ id: 10, section: "system", label: "Overdue Logic",
        description: "No account shows OVERDUE when all past-due months are paid",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 false OVERDUE flags",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // Check 11: Penalty Automation — accounts overdue 30+ days have a penalty
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        const scheds = schedByAcct[acct.id] || [];
        const pens   = penByAcct[acct.id] || [];
        const overdueUnpaid = scheds
          .filter((s: any) => s.due_date < today && !isEffectivelyPaid(s))
          .sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));
        if (overdueUnpaid.length === 0) continue;
        const daysOverdue = Math.floor((Date.now() - new Date(overdueUnpaid[0].due_date + "T00:00:00Z").getTime()) / 86400000);
        const hasActivePen = pens.some((p: any) => p.status !== "waived");
        if (daysOverdue >= 30 && !hasActivePen) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `${daysOverdue}d overdue since ${overdueUnpaid[0].due_date} — no active penalty found` });
        }
      }
      checks.push({ id: 11, section: "system", label: "Penalty Automation",
        description: "Accounts overdue 30+ days have at least one active penalty recorded",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 overdue accounts missing penalty",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // Check 12: Schedule Completeness
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        if ((schedByAcct[acct.id] || []).length === 0) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: "Active account has no schedule rows" });
        }
      }
      checks.push({ id: 12, section: "system", label: "Schedule Completeness",
        description: "Every active account has at least one non-cancelled schedule row",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 incomplete schedules",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    const passed  = checks.filter(c => c.status === "pass").length;
    const skipped = checks.filter(c => c.status === "skip").length;
    const failed  = checks.filter(c => c.status === "fail").length;

    return new Response(JSON.stringify({
      checks,
      summary: { total: checks.length, passed, failed, skipped, elapsed_ms: Date.now() - startTime },
      timestamp: new Date().toISOString(),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
