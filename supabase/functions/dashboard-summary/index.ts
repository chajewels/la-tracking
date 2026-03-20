import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await anonClient.auth.getClaims(token);
    if (claimsError || !claimsData?.claims) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Read currency filter
    let currencyFilter = "ALL";
    if (req.method === "POST") {
      try {
        const body = await req.json();
        currencyFilter = body.currency_mode || body.currency || "ALL";
      } catch { /* empty body */ }
    } else {
      const url = new URL(req.url);
      currencyFilter = url.searchParams.get("currency") || "ALL";
    }

    // Get conversion rate
    const { data: rateSetting } = await supabase
      .from("system_settings")
      .select("value")
      .eq("key", "php_jpy_rate")
      .single();

    const conversionRate = rateSetting ? Number(JSON.parse(String(rateSetting.value))) : 0.42;

    const toJpy = (amount: number, currency: string) => {
      if (currency === "JPY") return amount;
      return Math.round(amount / conversionRate);
    };

    const currencyWhere = currencyFilter !== "ALL" ? currencyFilter : null;
    const today = new Date().toISOString().split("T")[0];
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStartStr = monthStart.toISOString().split("T")[0];

    // Fetch all data in parallel
    let accountsQ = supabase.from("layaway_accounts").select("*").in("status", ["active", "overdue"]);
    if (currencyWhere) accountsQ = accountsQ.eq("currency", currencyWhere);

    let todayPayQ = supabase.from("payments").select("*").eq("date_paid", today).is("voided_at", null);
    if (currencyWhere) todayPayQ = todayPayQ.eq("currency", currencyWhere);

    let monthPayQ = supabase.from("payments").select("*").gte("date_paid", monthStartStr).is("voided_at", null);
    if (currencyWhere) monthPayQ = monthPayQ.eq("currency", currencyWhere);

    // Overdue schedule items (past due, not fully paid) — determines real overdue count
    const overdueSchedQ = supabase
      .from("layaway_schedule")
      .select("account_id, total_due_amount, paid_amount, currency")
      .lt("due_date", today)
      .in("status", ["pending", "partially_paid"]);

    // Completed this month
    const completedQ = supabase
      .from("layaway_accounts")
      .select("id")
      .eq("status", "completed")
      .gte("updated_at", monthStartStr);

    // Penalties applied today
    const penaltiesTodayQ = supabase
      .from("penalty_fees")
      .select("id, penalty_amount, currency")
      .eq("penalty_date", today);

    // Pending waivers
    const pendingWaiversQ = supabase
      .from("penalty_waiver_requests")
      .select("id")
      .eq("status", "pending");

    // Due today schedule items
    const dueTodaySchedQ = supabase
      .from("layaway_schedule")
      .select("account_id")
      .eq("due_date", today)
      .in("status", ["pending", "partially_paid"]);

    // Due in 3 days
    const next3 = new Date();
    next3.setDate(next3.getDate() + 3);
    const next3Str = next3.toISOString().split("T")[0];
    const due3DaysQ = supabase
      .from("layaway_schedule")
      .select("account_id")
      .gt("due_date", today)
      .lte("due_date", next3Str)
      .in("status", ["pending", "partially_paid"]);

    // Due in 7 days
    const next7 = new Date();
    next7.setDate(next7.getDate() + 7);
    const next7Str = next7.toISOString().split("T")[0];
    const due7DaysQ = supabase
      .from("layaway_schedule")
      .select("account_id")
      .gt("due_date", today)
      .lte("due_date", next7Str)
      .in("status", ["pending", "partially_paid"]);

    // Total penalties & waivers (system health)
    const totalPenaltiesQ = supabase.from("penalty_fees").select("id, status, penalty_amount, currency");
    const reminderLogsQ = supabase.from("reminder_logs").select("id, delivery_status").order("created_at", { ascending: false }).limit(200);

    const [
      { data: accounts },
      { data: todayPayments },
      { data: monthPayments },
      { data: overdueScheds },
      { data: completedAccounts },
      { data: penaltiesToday },
      { data: pendingWaivers },
      { data: dueTodayScheds },
      { data: due3DaysScheds },
      { data: due7DaysScheds },
      { data: allPenalties },
      { data: reminderLogs },
    ] = await Promise.all([
      accountsQ, todayPayQ, monthPayQ, overdueSchedQ, completedQ,
      penaltiesTodayQ, pendingWaiversQ, dueTodaySchedQ, due3DaysQ, due7DaysQ,
      totalPenaltiesQ, reminderLogsQ,
    ]);

    // Calculate totals
    let totalReceivables = 0;
    let activeCount = 0;

    for (const acc of accounts || []) {
      const balance = Number(acc.remaining_balance);
      totalReceivables += currencyFilter === "ALL" ? toJpy(balance, acc.currency) : balance;
      activeCount++;
    }

    // Overdue: count distinct accounts that have past-due unpaid schedule items
    const overdueAccountIds = new Set<string>();
    let overdueAmount = 0;
    for (const s of overdueScheds || []) {
      if (currencyWhere && s.currency !== currencyWhere) continue;
      overdueAccountIds.add(s.account_id);
      const amt = Number(s.total_due_amount) - Number(s.paid_amount);
      overdueAmount += currencyFilter === "ALL" ? toJpy(amt, s.currency) : amt;
    }

    let paymentsToday = 0;
    for (const p of todayPayments || []) {
      paymentsToday += currencyFilter === "ALL" ? toJpy(Number(p.amount_paid), p.currency) : Number(p.amount_paid);
    }

    let collectionsThisMonth = 0;
    for (const p of monthPayments || []) {
      collectionsThisMonth += currencyFilter === "ALL" ? toJpy(Number(p.amount_paid), p.currency) : Number(p.amount_paid);
    }

    // Penalties today count & amount
    let penaltiesTodayCount = 0;
    let penaltiesTodayAmount = 0;
    for (const p of penaltiesToday || []) {
      if (currencyWhere && p.currency !== currencyWhere) continue;
      penaltiesTodayCount++;
      penaltiesTodayAmount += currencyFilter === "ALL" ? toJpy(Number(p.penalty_amount), p.currency) : Number(p.penalty_amount);
    }

    // System health
    let totalPenaltiesApplied = 0;
    let totalPenaltiesWaived = 0;
    let totalPenaltiesAmount = 0;
    let totalWaivedAmount = 0;
    for (const p of allPenalties || []) {
      totalPenaltiesApplied++;
      totalPenaltiesAmount += Number(p.penalty_amount);
      if (p.status === "waived") {
        totalPenaltiesWaived++;
        totalWaivedAmount += Number(p.penalty_amount);
      }
    }

    const totalReminders = (reminderLogs || []).length;
    const successReminders = (reminderLogs || []).filter((r: any) => r.delivery_status === "sent" || r.delivery_status === "delivered").length;
    const failedReminders = (reminderLogs || []).filter((r: any) => r.delivery_status === "failed").length;

    const displayCurrency = currencyFilter === "ALL" ? "JPY" : currencyFilter;

    return new Response(JSON.stringify({
      currency: displayCurrency,
      currency_filter: currencyFilter,
      conversion_rate: conversionRate,
      // Row 1 KPIs
      total_receivables: totalReceivables,
      active_layaways: activeCount,
      payments_today: paymentsToday,
      collections_this_month: collectionsThisMonth,
      overdue_accounts: overdueAccountIds.size,
      overdue_amount: overdueAmount,
      completed_this_month: (completedAccounts || []).length,
      // Operations
      due_today_count: new Set((dueTodayScheds || []).map((s: any) => s.account_id)).size,
      due_3_days_count: new Set((due3DaysScheds || []).map((s: any) => s.account_id)).size,
      due_7_days_count: new Set((due7DaysScheds || []).map((s: any) => s.account_id)).size,
      penalties_today_count: penaltiesTodayCount,
      penalties_today_amount: penaltiesTodayAmount,
      pending_waivers_count: (pendingWaivers || []).length,
      // System health
      total_penalties_applied: totalPenaltiesApplied,
      total_penalties_waived: totalPenaltiesWaived,
      total_penalties_amount: totalPenaltiesAmount,
      total_waived_amount: totalWaivedAmount,
      reminder_total: totalReminders,
      reminder_success: successReminders,
      reminder_failed: failedReminders,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
