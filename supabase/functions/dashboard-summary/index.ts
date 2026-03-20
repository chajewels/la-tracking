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
    const isAllMode = currencyFilter === "ALL";
    const today = new Date().toISOString().split("T")[0];
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStartStr = monthStart.toISOString().split("T")[0];

    // ── Build all queries in parallel ──
    let accountsQ = supabase.from("layaway_accounts").select("*").in("status", ["active", "overdue"]);
    if (currencyWhere) accountsQ = accountsQ.eq("currency", currencyWhere);

    let todayPayQ = supabase.from("payments").select("*").eq("date_paid", today).is("voided_at", null);
    if (currencyWhere) todayPayQ = todayPayQ.eq("currency", currencyWhere);

    let monthPayQ = supabase.from("payments").select("*").gte("date_paid", monthStartStr).is("voided_at", null);
    if (currencyWhere) monthPayQ = monthPayQ.eq("currency", currencyWhere);

    const overdueSchedQ = supabase
      .from("layaway_schedule")
      .select("account_id, total_due_amount, paid_amount, currency")
      .lt("due_date", today)
      .in("status", ["pending", "partially_paid"]);

    const completedQ = supabase
      .from("layaway_accounts")
      .select("id")
      .eq("status", "completed")
      .gte("updated_at", monthStartStr);

    let forfeitedQ = supabase.from("layaway_accounts").select("id").eq("status", "forfeited");
    if (currencyWhere) forfeitedQ = forfeitedQ.eq("currency", currencyWhere);

    const penaltiesTodayQ = supabase
      .from("penalty_fees")
      .select("id, penalty_amount, currency")
      .eq("penalty_date", today);

    const pendingWaiversQ = supabase
      .from("penalty_waiver_requests")
      .select("id")
      .eq("status", "pending");

    const dueTodaySchedQ = supabase
      .from("layaway_schedule")
      .select("account_id")
      .eq("due_date", today)
      .in("status", ["pending", "partially_paid"]);

    const next3 = new Date();
    next3.setDate(next3.getDate() + 3);
    const next3Str = next3.toISOString().split("T")[0];
    const due3DaysQ = supabase
      .from("layaway_schedule")
      .select("account_id")
      .gt("due_date", today)
      .lte("due_date", next3Str)
      .in("status", ["pending", "partially_paid"]);

    const next7 = new Date();
    next7.setDate(next7.getDate() + 7);
    const next7Str = next7.toISOString().split("T")[0];
    const due7DaysQ = supabase
      .from("layaway_schedule")
      .select("account_id")
      .gt("due_date", today)
      .lte("due_date", next7Str)
      .in("status", ["pending", "partially_paid"]);

    const totalPenaltiesQ = supabase.from("penalty_fees").select("id, status, penalty_amount, currency");
    const reminderLogsQ = supabase.from("reminder_logs").select("id, delivery_status").order("created_at", { ascending: false }).limit(200);

    // ── Fetch ALL unpaid schedule items for predictions (no 1000-row limit) ──
    // Use pagination to get all rows
    const fetchAllScheduleItems = async () => {
      const allItems: any[] = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from("layaway_schedule")
          .select("account_id, due_date, total_due_amount, paid_amount, currency, status")
          .in("status", ["pending", "partially_paid", "overdue"])
          .range(from, from + pageSize - 1);
        if (error) break;
        if (!data || data.length === 0) break;
        allItems.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
      return allItems;
    };

    const [
      { data: accounts },
      { data: todayPayments },
      { data: monthPayments },
      { data: overdueScheds },
      { data: completedAccounts },
      { data: forfeitedAccounts },
      { data: penaltiesToday },
      { data: pendingWaivers },
      { data: dueTodayScheds },
      { data: due3DaysScheds },
      { data: due7DaysScheds },
      { data: allPenalties },
      { data: reminderLogs },
      allUnpaidScheduleItems,
    ] = await Promise.all([
      accountsQ, todayPayQ, monthPayQ, overdueSchedQ, completedQ, forfeitedQ,
      penaltiesTodayQ, pendingWaiversQ, dueTodaySchedQ, due3DaysQ, due7DaysQ,
      totalPenaltiesQ, reminderLogsQ, fetchAllScheduleItems(),
    ]);

    // ── Build account currency map for predictions ──
    const accountCurrencyMap = new Map<string, string>();
    const activeAccountIds = new Set<string>();
    for (const acc of accounts || []) {
      accountCurrencyMap.set(acc.id, acc.currency);
      activeAccountIds.add(acc.id);
    }

    // ── Calculate KPI totals ──
    let totalReceivables = 0;
    let activeCount = 0;
    for (const acc of accounts || []) {
      const balance = Number(acc.remaining_balance);
      totalReceivables += isAllMode ? toJpy(balance, acc.currency) : balance;
      activeCount++;
    }

    const overdueAccountIds = new Set<string>();
    let overdueAmount = 0;
    for (const s of overdueScheds || []) {
      if (currencyWhere && s.currency !== currencyWhere) continue;
      overdueAccountIds.add(s.account_id);
      const amt = Number(s.total_due_amount) - Number(s.paid_amount);
      overdueAmount += isAllMode ? toJpy(amt, s.currency) : amt;
    }

    let paymentsToday = 0;
    for (const p of todayPayments || []) {
      paymentsToday += isAllMode ? toJpy(Number(p.amount_paid), p.currency) : Number(p.amount_paid);
    }

    let collectionsThisMonth = 0;
    for (const p of monthPayments || []) {
      collectionsThisMonth += isAllMode ? toJpy(Number(p.amount_paid), p.currency) : Number(p.amount_paid);
    }

    let penaltiesTodayCount = 0;
    let penaltiesTodayAmount = 0;
    for (const p of penaltiesToday || []) {
      if (currencyWhere && p.currency !== currencyWhere) continue;
      penaltiesTodayCount++;
      penaltiesTodayAmount += isAllMode ? toJpy(Number(p.penalty_amount), p.currency) : Number(p.penalty_amount);
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

    // ── Predictions: 30d, 90d, next month, 6-month forecast ──
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86400000);
    const in90 = new Date(now.getTime() + 90 * 86400000);
    const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonthEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0);

    let predicted30Raw = 0, predicted90Raw = 0, nextMonthRaw = 0;

    // 6-month forecast buckets
    const forecastMonths: { month: string; expected: number; adjusted: number }[] = [];
    const monthBuckets: { start: Date; end: Date; label: string; total: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const fStart = new Date(now.getFullYear(), now.getMonth() + i + 1, 1);
      const fEnd = new Date(now.getFullYear(), now.getMonth() + i + 2, 0);
      const label = fStart.toLocaleDateString("en-US", { month: "short", year: "numeric" });
      monthBuckets.push({ start: fStart, end: fEnd, label, total: 0 });
    }

    for (const item of allUnpaidScheduleItems) {
      const remaining = Math.max(0, Number(item.total_due_amount) - Number(item.paid_amount));
      if (remaining <= 0) continue;

      // Only count items from active/overdue accounts
      if (!activeAccountIds.has(item.account_id)) continue;

      const acctCurrency = accountCurrencyMap.get(item.account_id) || item.currency;
      if (currencyWhere && acctCurrency !== currencyWhere) continue;

      let amount = remaining;
      if (isAllMode && acctCurrency === "PHP") {
        amount = toJpy(amount, "PHP");
      }

      const dueDate = new Date(item.due_date);

      // 30d & 90d predictions
      if (dueDate >= now && dueDate <= in30) predicted30Raw += amount;
      if (dueDate >= now && dueDate <= in90) predicted90Raw += amount;

      // Next month
      if (dueDate >= nextMonthStart && dueDate <= nextMonthEnd) nextMonthRaw += amount;

      // 6-month forecast
      for (const bucket of monthBuckets) {
        if (dueDate >= bucket.start && dueDate <= bucket.end) {
          bucket.total += amount;
          break;
        }
      }
    }

    // Risk-adjusted factor: 85%
    const riskFactor = 0.85;
    for (const bucket of monthBuckets) {
      forecastMonths.push({
        month: bucket.label,
        expected: Math.round(bucket.total),
        adjusted: Math.round(bucket.total * riskFactor),
      });
    }

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
      forfeited_accounts: (forfeitedAccounts || []).length,
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
      // Predictions (NEW)
      predicted_30d: Math.round(predicted30Raw * riskFactor),
      predicted_30d_raw: Math.round(predicted30Raw),
      predicted_90d: Math.round(predicted90Raw * riskFactor),
      predicted_90d_raw: Math.round(predicted90Raw),
      next_month_expected: Math.round(nextMonthRaw),
      next_month_adjusted: Math.round(nextMonthRaw * riskFactor),
      forecast_6_months: forecastMonths,
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
