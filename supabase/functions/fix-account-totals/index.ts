import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Fix account totals after penalty recalculation.
 * total_amount = downpayment + sum(schedule total_due_amount)
 * remaining_balance = sum of unpaid schedule rows (total_due - paid for non-paid/cancelled)
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get all active/overdue accounts
    let allAccounts: any[] = [];
    let page = 0;
    while (true) {
      const { data } = await supabase
        .from("layaway_accounts")
        .select("id, invoice_number, total_amount, remaining_balance, total_paid, downpayment_amount, status")
        .in("status", ["active", "overdue"])
        .range(page * 500, (page + 1) * 500 - 1);
      if (!data || data.length === 0) break;
      allAccounts = allAccounts.concat(data);
      if (data.length < 500) break;
      page++;
    }

    const fixes: any[] = [];

    for (const acct of allAccounts) {
      const { data: schedule } = await supabase
        .from("layaway_schedule")
        .select("total_due_amount, paid_amount, status")
        .eq("account_id", acct.id);

      if (!schedule) continue;

      const schedTotal = schedule.reduce((s: number, r: any) => s + Number(r.total_due_amount), 0);
      const unpaidDue = schedule
        .filter((r: any) => r.status !== "paid" && r.status !== "cancelled")
        .reduce((s: number, r: any) => s + Math.max(0, Number(r.total_due_amount) - Number(r.paid_amount)), 0);

      const correctTotalAmount = Number(acct.downpayment_amount) + schedTotal;
      const correctRemaining = unpaidDue;

      const needsUpdate =
        Math.abs(Number(acct.total_amount) - correctTotalAmount) > 0.01 ||
        Math.abs(Number(acct.remaining_balance) - correctRemaining) > 0.01;

      if (needsUpdate) {
        const hasOverdue = schedule.some((r: any) => r.status === "overdue");
        await supabase.from("layaway_accounts").update({
          total_amount: correctTotalAmount,
          remaining_balance: correctRemaining,
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
      accounts_fixed: fixes.length,
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
