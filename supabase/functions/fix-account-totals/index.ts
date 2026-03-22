import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Fix account totals using SINGLE SOURCE OF TRUTH:
 * remaining_balance = total_amount - SUM(actual non-voided payments)
 * total_paid = SUM(actual non-voided payments)
 * Never derives from schedule rows to avoid rounding/gap discrepancies.
 * Supports ?offset=N&limit=N for chunked execution.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const offset = parseInt(url.searchParams.get("offset") || "0");
    const limit = parseInt(url.searchParams.get("limit") || "200");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: accounts } = await supabase
      .from("layaway_accounts")
      .select("id, invoice_number, total_amount, remaining_balance, total_paid, downpayment_amount, status")
      .in("status", ["active", "overdue"])
      .order("invoice_number")
      .range(offset, offset + limit - 1);

    if (!accounts || accounts.length === 0) {
      return new Response(JSON.stringify({ message: "No more accounts", accounts_fixed: 0, fixes: [], offset, done: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Batch fetch all payments for these accounts (SINGLE SOURCE OF TRUTH for remaining balance)
    const accountIds = accounts.map((a: any) => a.id);
    let allPayments: any[] = [];
    for (let i = 0; i < accountIds.length; i += 50) {
      const chunk = accountIds.slice(i, i + 50);
      const { data: pays } = await supabase
        .from("payments")
        .select("account_id, amount_paid")
        .in("account_id", chunk)
        .is("voided_at", null)
        .limit(5000);
      if (pays) allPayments = allPayments.concat(pays);
    }

    // Also fetch schedules for status checking
    let allSchedules: any[] = [];
    for (let i = 0; i < accountIds.length; i += 50) {
      const chunk = accountIds.slice(i, i + 50);
      const { data: scheds } = await supabase
        .from("layaway_schedule")
        .select("account_id, status")
        .in("account_id", chunk)
        .neq("status", "cancelled")
        .limit(5000);
      if (scheds) allSchedules = allSchedules.concat(scheds);
    }

    // Index payments and schedules by account
    const payByAcct: Record<string, any[]> = {};
    for (const p of allPayments) {
      (payByAcct[p.account_id] ||= []).push(p);
    }
    const schedByAcct: Record<string, any[]> = {};
    for (const s of allSchedules) {
      (schedByAcct[s.account_id] ||= []).push(s);
    }

    const fixes: any[] = [];

    for (const acct of accounts) {
      const payments = payByAcct[acct.id] || [];
      const schedule = schedByAcct[acct.id] || [];

      // SINGLE SOURCE OF TRUTH: total_paid = SUM(actual non-voided payments)
      // Downpayment must exist as a real payment row; do not double-count account.downpayment_amount here.
      const totalPayments = payments.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
      const correctTotalPaid = totalPayments;
      const correctRemaining = Math.max(0, Number(acct.total_amount) - correctTotalPaid);

      const needsUpdate =
        Math.abs(Number(acct.total_paid) - correctTotalPaid) > 0.01 ||
        Math.abs(Number(acct.remaining_balance) - correctRemaining) > 0.01;

      if (needsUpdate) {
        const hasOverdue = schedule.some((r: any) => r.status === "overdue");
        await supabase.from("layaway_accounts").update({
          remaining_balance: correctRemaining,
          total_paid: correctTotalPaid,
          status: hasOverdue ? "overdue" : acct.status,
          updated_at: new Date().toISOString(),
        }).eq("id", acct.id);

        fixes.push({
          invoice: acct.invoice_number,
          old_remaining: Number(acct.remaining_balance),
          new_remaining: correctRemaining,
          old_total_paid: Number(acct.total_paid),
          new_total_paid: correctTotalPaid,
        });
      }
    }

    return new Response(JSON.stringify({
      message: "Account totals corrected",
      accounts_processed: accounts.length,
      accounts_fixed: fixes.length,
      offset,
      next_offset: offset + limit,
      done: accounts.length < limit,
      fixes,
    }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
