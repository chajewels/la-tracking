import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRole, parseJwtClaims } from "../_shared/jwt-claims.ts";
import { checkPermission } from "../_shared/check-permission.ts";

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

/**
 * A read that fails must say so. It must NEVER return [].
 *
 * This function used to destructure only `data`, so a PostgREST error left
 * `data` undefined, the loop broke, and it returned an empty array that was
 * indistinguishable from an empty table. Every check downstream then computed
 * a confident, wrong answer from nothing — 493 accounts reported as broken by
 * three separate checks on 2026-09-17, against a payments table that could not
 * be read at all (Bug #281).
 *
 * A partial read is discarded too. If page 2 fails after page 1 succeeded,
 * returning page 1 alone would be the same lie in a smaller size.
 */
async function fetchAll(
  supabase: any,
  table: string,
  select: string,
  filter?: (q: any) => any,
): Promise<{ rows: any[]; error: string | null }> {
  const all: any[] = [];
  let from = 0;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + PAGE - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) {
      const code = (error as any).code ? `${(error as any).code} ` : "";
      return { rows: [], error: `${code}${(error as any).message ?? String(error)}`.trim() };
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { rows: all, error: null };
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

/**
 * CLAUDE.md INVARIANT 11, verbatim: "DP detection: reference_number starts with
 * 'DP-' OR remarks ILIKE '%down%' (non-voided)."
 *
 * The previous version also tested `payment_type` and `is_downpayment`. NEITHER
 * COLUMN EXISTS on `payments` — asking PostgREST for them is what made the whole
 * payments read fail with 42703 (Bug #281). It also matched any remark merely
 * containing "dp", which is not the rule.
 */
function isDPPayment(p: any): boolean {
  return (!!p.reference_number && String(p.reference_number).startsWith("DP-")) ||
    (!!p.remarks && String(p.remarks).toLowerCase().includes("down"));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth gate. Accept either:
  //   (a) the service-role key (cron / internal callers), OR
  //   (b) a signed-in admin/staff/finance/csr user JWT (frontend callers
  //       like UnifiedSystemHealthTab / SystemHealthCheckPanel).
  // Same role list as dashboard-summary — this endpoint exposes the same
  // business data class so it must match exactly. Customers (Phase B JWT
  // holders without a staff user_roles row) get 403.
  const authHeader = req.headers.get("Authorization");
  const authToken = authHeader?.replace("Bearer ", "") ?? "";
  let authorized = false;
  // Bug #168 fix (Batch F): use parseJwtClaims for service-role detection — never string equality
  if (authToken && isServiceRole(authToken)) {
    authorized = true;
  } else if (authHeader?.startsWith("Bearer ")) {
    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (!userError && user) {
      const supabaseGate = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      // Permission gate (Bug #205 Batch F: matrix-driven access — user JWT path, service_role handled above)
      authorized = await checkPermission(supabaseGate, user.id, "system_health");
    }
  }
  if (!authorized) {
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

    const today = new Date().toISOString().split("T")[0];
    const startTime = Date.now();

    // ── Fetch all data in parallel ──
    const [accountsR, schedulesR, penaltiesR, paymentsR, servicesR, allSchedRowsR] = await Promise.all([
      fetchAll(supabase, "layaway_accounts",
        "id, invoice_number, status, currency, total_amount, total_paid, remaining_balance, downpayment_amount, payment_plan_months, customers!inner(full_name)"),
      // penalty_amount was missing from this list until 2026-09-17 while five
      // checks read sched.penalty_amount. It resolved to undefined, so every
      // ceiling was computed WITHOUT the penalty and check 5's skip test
      // (Number(undefined) === 0 → NaN === 0 → false) never skipped anything.
      // That is the second half of Bug #281 and the source of the four
      // failures that looked real. The column exists; it was simply not asked for.
      fetchAll(supabase, "layaway_schedule",
        "id, account_id, installment_number, due_date, base_installment_amount, penalty_amount, total_due_amount, paid_amount, status, carried_amount",
        q => q.neq("status", "cancelled")),
      fetchAll(supabase, "penalty_fees",
        "id, account_id, schedule_id, penalty_amount, status"),
      // payment_type and is_downpayment were requested here until 2026-09-17 and
      // DO NOT EXIST on payments. PostgREST answered 42703, fetchAll swallowed it,
      // and every payments-derived check read SUM = 0. See Bug #281.
      fetchAll(supabase, "payments",
        "id, account_id, amount_paid, reference_number, remarks, voided_at"),
      fetchAll(supabase, "account_services",
        "id, account_id, amount"),
      // All schedule rows including cancelled — used by check 12 to detect accounts with zero rows
      fetchAll(supabase, "layaway_schedule", "account_id"),
    ]);

    // A dataset that could not be read is recorded by NAME, so the checks that
    // depend on it can be withdrawn rather than answered from nothing.
    const loadErrors: Record<string, string> = {};
    const take = (dataset: string, r: { rows: any[]; error: string | null }) => {
      if (r.error) loadErrors[dataset] = r.error;
      return r.rows;
    };
    const accounts     = take("layaway_accounts", accountsR);
    const schedules    = take("layaway_schedule", schedulesR);
    const penalties    = take("penalty_fees", penaltiesR);
    const payments     = take("payments", paymentsR);
    const services     = take("account_services", servicesR);
    const allSchedRows = take("layaway_schedule_all", allSchedRowsR);

    // ── Index by account_id ──
    const schedByAcct = index(schedules, s => s.account_id);
    const penByAcct   = index(penalties, p => p.account_id);
    const payByAcct   = index(payments,  p => p.account_id);
    const svcByAcct   = index(services,  s => s.account_id);
    const schedById: Record<string, any> = {};
    for (const s of schedules) schedById[s.id] = s;

    // All account IDs that have at least one schedule row of any status (for check 12)
    const acctIdsWithAnySchedule = new Set<string>(allSchedRows.map((s: any) => s.account_id));

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

    // Check 9: removed 2026-05-25 — customer-statement feature deleted (#153),
    // statement_token column on layaway_accounts no longer consumed.

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
    // Mirrors: SELECT ... FROM layaway_accounts la LEFT JOIN layaway_schedule ls ON ls.account_id = la.id
    //          WHERE la.status NOT IN ('completed','forfeited','voided','cancelled')
    //          GROUP BY la.id HAVING COUNT(ls.id) = 0
    {
      const affected: CheckResult["affectedAccounts"] = [];
      const check12Excl = new Set(["completed", "forfeited", "voided", "cancelled"]);
      const check12Accounts = accounts.filter((a: any) => !check12Excl.has(a.status));
      for (const acct of check12Accounts) {
        if (!acctIdsWithAnySchedule.has(acct.id)) {
          affected.push({ account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: "Account has no schedule rows — schedule was never generated" });
        }
      }
      checks.push({ id: 12, section: "system", label: "Schedule Completeness",
        description: "Every non-completed account has at least one schedule row",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 accounts missing schedule",
        affectedCount: affected.length, affectedAccounts: affected });
    }

    // Check 13: Unallocated Bulk Import Payments
    // Accounts where installment payments exist (sum > 0) but no schedule row
    // has been updated — indicates payments were imported but never allocated.
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        const pays   = (payByAcct[acct.id] || []).filter((p: any) => !p.voided_at);
        const scheds = schedByAcct[acct.id] || [];

        // Sum non-DP payments (installment payments only)
        const installmentPaid = pays
          .filter((p: any) => !isDPPayment(p))
          .reduce((s: number, p: any) => s + Number(p.amount_paid), 0);

        if (installmentPaid <= 0) continue; // no installment payments at all — not an issue

        // Check if schedule has any paid/partial rows
        const anyAllocated = scheds.some(
          (s: any) => Number(s.paid_amount) > 0 || s.status === "paid" || s.status === "partially_paid"
        );

        if (!anyAllocated) {
          affected.push({
            account_id: acct.id,
            invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `₱${Math.round(installmentPaid).toLocaleString()} in installment payments but all schedule rows show 0 paid`,
          });
        }
      }
      checks.push({
        id: 13, section: "data", label: "Unallocated Bulk Import Payments",
        description: "Accounts with installment payments recorded but zero allocation on any schedule row",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 unallocated accounts",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // Check 14: Overdue Accounts Missing Penalties (7+ days overdue, no active penalty)
    // More sensitive than Check 11 (30+ days) — catches accounts the penalty engine missed early.
    // Excludes TEST accounts.
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        if (acct.invoice_number && String(acct.invoice_number).startsWith("TEST-")) continue;

        const scheds = schedByAcct[acct.id] || [];
        const pens   = penByAcct[acct.id] || [];

        const overdueUnpaid = scheds
          .filter((s: any) => s.due_date < today && !isEffectivelyPaid(s))
          .sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));

        if (overdueUnpaid.length === 0) continue;

        const earliestDue = overdueUnpaid[0].due_date;
        const daysOverdue = Math.floor(
          (Date.now() - new Date(earliestDue + "T00:00:00Z").getTime()) / 86400000
        );

        if (daysOverdue < 7) continue; // still in grace period

        const hasActivePen = pens.some((p: any) => p.status !== "waived");
        if (!hasActivePen) {
          affected.push({
            account_id: acct.id,
            invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `${daysOverdue}d overdue since ${earliestDue} — no active penalty recorded`,
          });
        }
      }
      checks.push({
        id: 14, section: "system", label: "Overdue Missing Penalties",
        description: "Non-test accounts 7+ days overdue with no active penalty fees (penalty engine missed them)",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 overdue accounts missing penalty",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // ══════════════════════════════════════
    // SECTION 4 — ARCHITECTURE INTEGRITY (Phase 2 checks)
    // ══════════════════════════════════════

    // Check 15: total_paid drift
    // SUM(non-voided payments) must equal account.total_paid within 0.01
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of activeAccounts) {
        const pays = (payByAcct[acct.id] || []).filter((p: any) => !p.voided_at);
        const actualPaid = pays.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
        const storedPaid = Number(acct.total_paid);
        if (Math.abs(actualPaid - storedPaid) > 0.01) {
          affected.push({
            account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `SUM(payments)=${Math.round(actualPaid * 100) / 100} ≠ total_paid=${storedPaid}`,
          });
        }
      }
      checks.push({
        id: 15, section: "data", label: "Payment Integrity — total_paid matches sum of payments",
        description: "SUM(non-voided payments.amount_paid) = account.total_paid (EPSILON 0.01)",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 drift",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // Check 16: Allocation ceiling breach
    // No schedule row should have total allocations > base + penalty + carried + 0.01
    {
      const affected: CheckResult["affectedAccounts"] = [];
      // Fetch all payment_allocations
      const allAllocsR = await fetchAll(supabase, "payment_allocations",
        "schedule_id, allocated_amount");
      if (allAllocsR.error) loadErrors["payment_allocations"] = allAllocsR.error;
      const allAllocs = allAllocsR.rows;
      const allocBySchedule: Record<string, number> = {};
      for (const alloc of allAllocs) {
        allocBySchedule[alloc.schedule_id] = (allocBySchedule[alloc.schedule_id] || 0) + Number(alloc.allocated_amount);
      }
      for (const sched of schedules) {
        const allocated = allocBySchedule[sched.id] || 0;
        const ceiling = Number(sched.base_installment_amount)
          + Number(sched.penalty_amount || 0)
          + Number((sched as any).carried_amount || 0);
        if (allocated > ceiling + 0.01) {
          const acct = acctById[sched.account_id];
          if (!acct) continue;
          affected.push({
            account_id: sched.account_id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `Month ${sched.installment_number}: allocated=${Math.round(allocated * 100) / 100} > ceiling=${Math.round(ceiling * 100) / 100}`,
          });
        }
      }
      checks.push({
        id: 16, section: "data", label: "Allocation Ceiling — no row over-allocated",
        description: "SUM(payment_allocations) ≤ base + penalty + carried_amount per row",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 breaches",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // Check 17: Stale schedule rows
    //
    // CORRECTED 2026-09-17 (Bug #281). This check asserted
    //   total_due_amount = base + penalty   ("no carry inflation")
    // and therefore reported every legitimately carried row as inflated.
    //
    // CLAUDE.md, CARRIED_AMOUNT PRESERVATION, is explicit and the opposite:
    // "total_due_amount = base_installment_amount + penalty_amount +
    // carried_amount on EVERY recompute. carried_amount is part of the row's
    // full obligation." The CACHE-STALENESS TEST in the same section says a row
    // is genuinely stale ONLY when total_due_amount differs from that sum — and
    // a carry is a backing entry, not inflation.
    //
    // So the test is now equality against the canonical GROSS, in both
    // directions: a row short of it is as stale as a row over it.
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const sched of schedules) {
        if (!["pending", "overdue"].includes(sched.status)) continue;
        const expected = Number(sched.base_installment_amount)
          + Number(sched.penalty_amount || 0)
          + Number((sched as any).carried_amount || 0);
        const actual = Number(sched.total_due_amount);
        if (Math.abs(actual - expected) > 0.01) {
          const acct = acctById[sched.account_id];
          if (!acct) continue;
          affected.push({
            account_id: sched.account_id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `Month ${sched.installment_number}: total_due=${actual} ≠ base+penalty+carried=${Math.round(expected * 100) / 100}`,
          });
        }
      }
      checks.push({
        id: 17, section: "data", label: "Schedule Integrity — total_due_amount matches its parts",
        description: "pending/overdue rows: total_due_amount = base + penalty + carried (CLAUDE.md cache-staleness test)",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 stale rows",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // Check 18: Zero remaining not paid
    // Any row where allocations >= ceiling should have db_status = 'paid'
    {
      const affected: CheckResult["affectedAccounts"] = [];
      const allAllocs18R = await fetchAll(supabase, "payment_allocations",
        "schedule_id, allocated_amount");
      if (allAllocs18R.error) loadErrors["payment_allocations"] = allAllocs18R.error;
      const allAllocs18 = allAllocs18R.rows;
      const allocBySchedule18: Record<string, number> = {};
      for (const alloc of allAllocs18) {
        allocBySchedule18[alloc.schedule_id] = (allocBySchedule18[alloc.schedule_id] || 0) + Number(alloc.allocated_amount);
      }
      for (const sched of schedules) {
        if (sched.status === "paid" || sched.status === "cancelled") continue;
        const allocated = allocBySchedule18[sched.id] || 0;
        const ceiling = Number(sched.base_installment_amount)
          + Number(sched.penalty_amount || 0)
          + Number((sched as any).carried_amount || 0);
        if (ceiling > 0 && allocated >= ceiling - 0.005 && sched.status !== "paid") {
          const acct = acctById[sched.account_id];
          if (!acct) continue;
          affected.push({
            account_id: sched.account_id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `Month ${sched.installment_number}: allocated=${Math.round(allocated * 100) / 100} ≥ ceiling but status=${sched.status}`,
          });
        }
      }
      checks.push({
        id: 18, section: "data", label: "Zero Remaining — all fully-allocated rows marked paid",
        description: "Any schedule row where allocations ≥ ceiling should have status = 'paid'",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 rows",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // Check 19: Wrongful forfeit
    // No forfeited account should have remaining_balance <= 0
    {
      const affected: CheckResult["affectedAccounts"] = [];
      for (const acct of accounts.filter((a: any) => a.status === "forfeited" || a.status === "final_forfeited")) {
        if (Number(acct.remaining_balance) <= 0) {
          affected.push({
            account_id: acct.id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `${acct.status} but remaining_balance = ${acct.remaining_balance}`,
          });
        }
      }
      checks.push({
        id: 19, section: "data", label: "Forfeit Guard — no zero-balance forfeited accounts",
        description: "Forfeited accounts should not have remaining_balance ≤ 0",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 accounts",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // Check 20: Carried amount on paid row (unconsumed carry)
    // A paid row with carried_amount > 0 AND allocated < ceiling = bug
    {
      const affected: CheckResult["affectedAccounts"] = [];
      const allAllocs20R = await fetchAll(supabase, "payment_allocations",
        "schedule_id, allocated_amount");
      if (allAllocs20R.error) loadErrors["payment_allocations"] = allAllocs20R.error;
      const allAllocs20 = allAllocs20R.rows;
      const allocBySchedule20: Record<string, number> = {};
      for (const alloc of allAllocs20) {
        allocBySchedule20[alloc.schedule_id] = (allocBySchedule20[alloc.schedule_id] || 0) + Number(alloc.allocated_amount);
      }
      for (const sched of schedules) {
        if (sched.status !== "paid") continue;
        const carriedAmt = Number((sched as any).carried_amount || 0);
        if (carriedAmt <= 0.005) continue;
        const allocated = allocBySchedule20[sched.id] || 0;
        const ceiling = Number(sched.base_installment_amount)
          + Number(sched.penalty_amount || 0)
          + carriedAmt;
        if (allocated < ceiling - 0.01) {
          const acct = acctById[sched.account_id];
          if (!acct) continue;
          affected.push({
            account_id: sched.account_id, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `Month ${sched.installment_number}: paid but carried_amount=${carriedAmt} not consumed (allocated=${Math.round(allocated*100)/100} < ceiling=${Math.round(ceiling*100)/100})`,
          });
        }
      }
      checks.push({
        id: 20, section: "data", label: "Carry Integrity — no unconsumed carry on paid rows",
        description: "Paid rows with carried_amount > 0 must have allocations covering the full ceiling",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 rows",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // Check 21: Double carry
    // No account should have carried_amount > 0 on more than one row
    {
      const affected: CheckResult["affectedAccounts"] = [];
      const carryByAcct: Record<string, number> = {};
      for (const sched of schedules) {
        if (Number((sched as any).carried_amount || 0) > 0.005) {
          carryByAcct[sched.account_id] = (carryByAcct[sched.account_id] || 0) + 1;
        }
      }
      for (const [accountId, count] of Object.entries(carryByAcct)) {
        if (count > 1) {
          const acct = acctById[accountId];
          if (!acct) continue;
          affected.push({
            account_id: accountId, invoice_number: acct.invoice_number,
            customer_name: acct.customers?.full_name || "Unknown",
            detail: `${count} rows have carried_amount > 0 — only 1 allowed`,
          });
        }
      }
      checks.push({
        id: 21, section: "data", label: "Double Carry — no account has carry on multiple rows",
        description: "At most one schedule row per account may have carried_amount > 0",
        status: affected.length === 0 ? "pass" : "fail", expected: "0 accounts",
        affectedCount: affected.length, affectedAccounts: affected,
      });
    }

    // ── Withdraw any check whose source data could not be read ─────────────
    //
    // Derived from the checks' own bodies, not guessed. Every check also reads
    // layaway_accounts, so a failure there withdraws all of them.
    //
    // This runs AFTER the checks so their bodies are untouched: a blocked check
    // still computes a meaningless verdict over an empty array, and that verdict
    // is then thrown away and replaced. Overwriting the answer is a far smaller
    // change than threading a guard through twenty blocks, and it cannot alter
    // the logic of a check that is not blocked.
    const CHECK_SOURCES: Record<number, string[]> = {
      1:  ["payments", "penalty_fees", "account_services"],
      2:  ["layaway_schedule"],
      3:  ["payments"],
      4:  ["payments"],
      5:  ["penalty_fees", "layaway_schedule"],
      6:  ["payments", "layaway_schedule", "penalty_fees", "account_services"],
      7:  ["payments", "layaway_schedule", "penalty_fees", "account_services"],
      8:  ["payments", "layaway_schedule", "penalty_fees", "account_services"],
      10: ["layaway_schedule"],
      11: ["layaway_schedule", "penalty_fees"],
      12: ["layaway_schedule_all"],
      13: ["payments", "layaway_schedule"],
      14: ["layaway_schedule", "penalty_fees"],
      15: ["payments"],
      16: ["layaway_schedule", "payment_allocations"],
      17: ["layaway_schedule"],
      18: ["layaway_schedule", "payment_allocations"],
      19: [],
      20: ["layaway_schedule", "payment_allocations"],
      21: ["layaway_schedule"],
    };

    for (const c of checks) {
      const sources = ["layaway_accounts", ...(CHECK_SOURCES[c.id] ?? [])];
      const broken = sources
        .filter(d => loadErrors[d])
        .map(d => `${d} (${loadErrors[d]})`);
      if (broken.length === 0) continue;
      c.status = "skip";
      c.expected = "a readable source table";
      c.description =
        `COULD NOT RUN — failed to read ${broken.join("; ")}. ` +
        `This check has no verdict. A "0 affected" result here would be a lie, ` +
        `and a "493 affected" one would be a louder lie.`;
      c.affectedCount = 0;
      c.affectedAccounts = [];
    }

    const passed  = checks.filter(c => c.status === "pass").length;
    const skipped = checks.filter(c => c.status === "skip").length;
    const failed  = checks.filter(c => c.status === "fail").length;

    return new Response(JSON.stringify({
      checks,
      // Present and empty on a healthy run. Non-empty means some checks were
      // withdrawn above and the run is INCOMPLETE, not clean.
      load_errors: loadErrors,
      summary: {
        total: checks.length, passed, failed, skipped,
        unreadable_sources: Object.keys(loadErrors).length,
        elapsed_ms: Date.now() - startTime,
      },
      timestamp: new Date().toISOString(),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
