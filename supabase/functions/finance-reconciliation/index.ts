import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PENALTY_CAP_PER_INSTALLMENT: Record<string, number> = {
  PHP: 1000,
  JPY: 2000,
};

interface Exception {
  account_id: string;
  invoice_number: string;
  customer_name: string;
  currency: string;
  type: string;
  detail: string;
  expected?: number;
  actual?: number;
  difference?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const exceptions: Exception[] = [];
    const today = new Date().toISOString().split("T")[0];

    // Only audit operationally relevant accounts (exclude closed/terminal statuses)
    const CLOSED_STATUSES = ['forfeited', 'final_forfeited', 'cancelled', 'completed'];

    let allAccounts: any[] = [];
    let closedAccountCount = 0;
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data } = await supabase
        .from("layaway_accounts")
        .select("id, invoice_number, currency, total_amount, total_paid, remaining_balance, status, downpayment_amount, payment_plan_months, customers!inner(full_name)")
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      for (const row of data) {
        if (CLOSED_STATUSES.includes(row.status)) {
          closedAccountCount++;
        } else {
          allAccounts.push(row);
        }
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }

    // Fetch all schedules
    let allSchedules: any[] = [];
    from = 0;
    while (true) {
      const { data } = await supabase
        .from("layaway_schedule")
        .select("id, account_id, installment_number, due_date, base_installment_amount, penalty_amount, total_due_amount, paid_amount, status, currency")
        .neq("status", "cancelled")
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      allSchedules = allSchedules.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    // Fetch all penalty fees
    let allPenalties: any[] = [];
    from = 0;
    while (true) {
      const { data } = await supabase
        .from("penalty_fees")
        .select("id, account_id, schedule_id, penalty_amount, status, currency, penalty_stage, penalty_cycle")
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      allPenalties = allPenalties.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    // Fetch non-voided payments
    let allPayments: any[] = [];
    from = 0;
    while (true) {
      const { data } = await supabase
        .from("payments")
        .select("id, account_id, amount_paid, date_paid, currency")
        .is("voided_at", null)
        .range(from, from + PAGE - 1);
      if (!data || data.length === 0) break;
      allPayments = allPayments.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    // Index by account
    const schedByAcct: Record<string, any[]> = {};
    for (const s of allSchedules) {
      (schedByAcct[s.account_id] ||= []).push(s);
    }
    const penByAcct: Record<string, any[]> = {};
    for (const p of allPenalties) {
      (penByAcct[p.account_id] ||= []).push(p);
    }
    const payByAcct: Record<string, any[]> = {};
    for (const p of allPayments) {
      (payByAcct[p.account_id] ||= []).push(p);
    }

    let cleanCount = 0;
    let penaltyExceptions = 0;
    let waiverExceptions = 0;
    let balanceExceptions = 0;
    let paymentExceptions = 0;

    for (const acct of allAccounts) {
      const custName = (acct.customers as any)?.full_name || "Unknown";
      const scheds = (schedByAcct[acct.id] || []).sort((a: any, b: any) => a.installment_number - b.installment_number);
      const pens = penByAcct[acct.id] || [];
      const pays = payByAcct[acct.id] || [];

      let hasException = false;
      const addEx = (type: string, detail: string, expected?: number, actual?: number) => {
        hasException = true;
        exceptions.push({
          account_id: acct.id,
          invoice_number: acct.invoice_number,
          customer_name: custName,
          currency: acct.currency,
          type,
          detail,
          expected,
          actual,
          difference: expected !== undefined && actual !== undefined ? Math.round((actual - expected) * 100) / 100 : undefined,
        });
      };

      // 1. Balance reconciliation — SINGLE SOURCE OF TRUTH: remaining_balance = SUM(unpaid principal in schedule)
      // remaining_balance tracks PRINCIPAL only; penalty payments do NOT reduce it.
      const unpaidPrincipal = scheds.reduce((s: number, si: any) => {
        if (si.status === 'paid' || si.status === 'cancelled') return s;
        const base = Number(si.base_installment_amount);
        const paid = Number(si.paid_amount);
        // paid_amount on schedule reflects principal allocated, not penalty
        return s + Math.max(0, base - paid);
      }, 0);

      const storedBalance = Number(acct.remaining_balance);

      if (Math.abs(unpaidPrincipal - storedBalance) > 1) {
        addEx("balance_mismatch", `Stored remaining ${storedBalance} vs schedule unpaid principal ${Math.round(unpaidPrincipal * 100) / 100}`, unpaidPrincipal, storedBalance);
        balanceExceptions++;
      }

      // 2. Negative balance
      if (storedBalance < -0.5) {
        addEx("negative_balance", `Remaining balance is ${storedBalance}`, 0, storedBalance);
        balanceExceptions++;
      }

      // 3. Over-cap penalties (non-final installments only — final is uncapped)
      const planMonths = acct.payment_plan_months || 6;
      const penBySched: Record<string, any[]> = {};
      for (const p of pens) {
        (penBySched[p.schedule_id] ||= []).push(p);
      }
      for (const sched of scheds) {
        // Only cap non-final installments; final installment is uncapped
        if (sched.installment_number < planMonths) {
          const schedPens = (penBySched[sched.id] || []).filter((p: any) => p.status !== "waived");
          const totalPen = schedPens.reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
          const cap = PENALTY_CAP_PER_INSTALLMENT[acct.currency] || 1000;
          if (totalPen > cap + 0.01) {
            addEx("overcap_penalty", `Inst ${sched.installment_number}: penalty ${totalPen} exceeds cap ${cap}`, cap, totalPen);
            penaltyExceptions++;
          }
        }
      }

      // 4. Waived penalty still counted as active
      for (const p of pens) {
        if (p.status === "waived") {
          // Check if any schedule still includes this in penalty_amount
          // (simplified: check total schedule penalty vs sum of non-waived penalties)
        }
      }

      // 5. Schedule chronology
      for (let i = 1; i < scheds.length; i++) {
        if (scheds[i].due_date <= scheds[i - 1].due_date) {
          addEx("chronology_break", `Inst ${scheds[i].installment_number} (${scheds[i].due_date}) <= inst ${scheds[i - 1].installment_number} (${scheds[i - 1].due_date})`);
        }
      }

      // 6. Payment date year mismatch
      // Already fixed, but keep monitoring
      for (const pay of pays) {
        const payYear = new Date(pay.date_paid).getFullYear();
        if (payYear === 2024) {
          addEx("legacy_year", `Payment ${pay.id} still has year 2024`, undefined, undefined);
          paymentExceptions++;
        }
      }

      // 7. Paid installment marked unpaid
      for (const sched of scheds) {
        if (Number(sched.paid_amount) >= Number(sched.total_due_amount) && sched.status !== "paid" && sched.status !== "cancelled") {
          addEx("paid_marked_unpaid", `Inst ${sched.installment_number}: paid ${sched.paid_amount} >= due ${sched.total_due_amount} but status=${sched.status}`);
        }
      }

      if (!hasException) cleanCount++;
    }

    // Reference invoice checks — also check closed/completed accounts
    const refInvoices = ["17059", "17062", "17169"];
    const refResults: Record<string, string> = {};
    for (const inv of refInvoices) {
      const found = allAccounts.find((a: any) => a.invoice_number === inv);
      if (found) {
        const hasEx = exceptions.some(e => e.invoice_number === inv);
        refResults[inv] = hasEx ? "EXCEPTION" : "CLEAN";
      } else {
        // Check if it's a closed/completed account
        const { data: closedAcct } = await supabase
          .from("layaway_accounts")
          .select("status")
          .eq("invoice_number", inv)
          .maybeSingle();
        if (closedAcct) {
          refResults[inv] = closedAcct.status.toUpperCase();
        } else {
          refResults[inv] = "not_found";
        }
      }
    }

    const summary = {
      total_accounts: allAccounts.length,
      clean_accounts: cleanCount,
      exception_accounts: allAccounts.length - cleanCount,
      total_exceptions: exceptions.length,
      penalty_exceptions: penaltyExceptions,
      waiver_exceptions: waiverExceptions,
      balance_exceptions: balanceExceptions,
      payment_exceptions: paymentExceptions,
      closed_accounts_excluded: closedAccountCount,
      reference_invoices: refResults,
      timestamp: new Date().toISOString(),
    };

    return new Response(JSON.stringify({ summary, exceptions }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
