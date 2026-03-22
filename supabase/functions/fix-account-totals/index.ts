import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Fix account totals after penalty recalculation.
 * total_amount = downpayment + sum(non-cancelled schedule total_due_amount)
 * remaining_balance = sum of unpaid schedule rows
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

    // Batch fetch all schedules for these accounts
    const accountIds = accounts.map((a: any) => a.id);
    let allSchedules: any[] = [];
    // Fetch in chunks of 50 account IDs to avoid URL length limits
    for (let i = 0; i < accountIds.length; i += 50) {
      const chunk = accountIds.slice(i, i + 50);
      const { data: scheds } = await supabase
        .from("layaway_schedule")
        .select("account_id, total_due_amount, paid_amount, status")
        .in("account_id", chunk)
        .neq("status", "cancelled")
        .limit(5000);
      if (scheds) allSchedules = allSchedules.concat(scheds);
    }

    // Index by account
    const schedByAcct: Record<string, any[]> = {};
    for (const s of allSchedules) {
      (schedByAcct[s.account_id] ||= []).push(s);
    }

    const fixes: any[] = [];

    for (const acct of accounts) {
      const schedule = schedByAcct[acct.id] || [];
      // Use base_installment_amount only — penalties must NOT inflate the contract total
      const schedTotal = schedule.reduce((s: number, r: any) => s + Number(r.base_installment_amount), 0);
      const unpaidDue = schedule
        .filter((r: any) => r.status !== "paid")
        .reduce((s: number, r: any) => s + Math.max(0, Number(r.base_installment_amount) - Number(r.paid_amount)), 0);

      const correctTotalAmount = Number(acct.downpayment_amount) + schedTotal;
      const correctRemaining = unpaidDue;
      // Also fix total_paid to be consistent
      const correctTotalPaid = correctTotalAmount - correctRemaining;

      const needsUpdate =
        Math.abs(Number(acct.total_amount) - correctTotalAmount) > 0.01 ||
        Math.abs(Number(acct.remaining_balance) - correctRemaining) > 0.01;

      if (needsUpdate) {
        const hasOverdue = schedule.some((r: any) => r.status === "overdue");
        await supabase.from("layaway_accounts").update({
          total_amount: correctTotalAmount,
          remaining_balance: correctRemaining,
          total_paid: correctTotalPaid,
          status: hasOverdue ? "overdue" : acct.status,
          updated_at: new Date().toISOString(),
        }).eq("id", acct.id);

        fixes.push({
          invoice: acct.invoice_number,
          old_total: Number(acct.total_amount),
          new_total: correctTotalAmount,
          old_remaining: Number(acct.remaining_balance),
          new_remaining: correctRemaining,
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
