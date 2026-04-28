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

    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
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
    // PHT (Asia/Manila, UTC+8) boundaries — canonical timezone for all date
    // comparisons. See CLAUDE.md TIMEZONE STANDARD.
    const pad = (n: number) => String(n).padStart(2, "0");
    const phtDateStr = (d: Date) =>
      Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(d);
    const today = phtDateStr(new Date());
    // PHT-tomorrow string for half-open day-window queries on timestamptz
    // columns. PostgREST gte/lt on timestamptz interpret no-TZ strings as
    // UTC; appending +08:00 makes them PHT-correct. Half-open avoids the
    // .999999µs hack. See CLAUDE.md TIMEZONE STANDARD.
    const tomorrow = phtDateStr(new Date(Date.now() + 86400000));
    const phtNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Manila" }),
    );
    const monthStartStr = `${phtNow.getFullYear()}-${pad(phtNow.getMonth() + 1)}-01`;
    const nextMonthYear = phtNow.getMonth() === 11 ? phtNow.getFullYear() + 1 : phtNow.getFullYear();
    const nextMonthMonth = phtNow.getMonth() === 11 ? 0 : phtNow.getMonth() + 1;
    const nextMonthStartStr = `${nextMonthYear}-${pad(nextMonthMonth + 1)}-01`;

    // ── Build all queries in parallel ──
    // Active statuses must match ACTIVE_STATUSES in business-rules.ts
    let accountsQ = supabase.from("layaway_accounts").select("*").in("status", ["active", "overdue", "final_settlement", "extension_active"]).not("invoice_number", "like", "TEST-%");
    if (currencyWhere) accountsQ = accountsQ.eq("currency", currencyWhere);

    let todayPayQ = supabase.from("payments").select("*").eq("date_paid", today).is("voided_at", null);
    if (currencyWhere) todayPayQ = todayPayQ.eq("currency", currencyWhere);

    let monthPayQ = supabase.from("payments").select("*").gte("date_paid", monthStartStr).is("voided_at", null);
    if (currencyWhere) monthPayQ = monthPayQ.eq("currency", currencyWhere);

    const completedThisMonthQ = supabase
      .from("layaway_accounts")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gte("completed_at", monthStartStr)
      .lt("completed_at", nextMonthStartStr)
      .not("invoice_number", "like", "TEST-%");

    // Include both forfeited and final_forfeited — both represent forfeited accounts
    let forfeitedQ = supabase.from("layaway_accounts").select("id").in("status", ["forfeited", "final_forfeited"]).not("invoice_number", "like", "TEST-%");
    if (currencyWhere) forfeitedQ = forfeitedQ.eq("currency", currencyWhere);

    // Forfeited today — accounts forfeited within the current PHT calendar
    // day. Half-open interval at PHT midnight (today 00:00 PHT inclusive,
    // tomorrow 00:00 PHT exclusive). The +08:00 offset is required because
    // forfeited_at is timestamptz and a bare ISO string would be parsed as
    // UTC. See CLAUDE.md TIMEZONE STANDARD.
    let forfeitedTodayQ = supabase.from("layaway_accounts")
      .select("id")
      .in("status", ["forfeited", "final_forfeited"])
      .gte("forfeited_at", today    + "T00:00:00+08:00")
      .lt ("forfeited_at", tomorrow + "T00:00:00+08:00")
      .not("invoice_number", "like", "TEST-%");
    if (currencyWhere) forfeitedTodayQ = forfeitedTodayQ.eq("currency", currencyWhere);

    // All-time completed accounts
    const completedAllTimeQ = supabase
      .from("layaway_accounts")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .not("invoice_number", "like", "TEST-%");

    const penaltiesTodayQ = supabase
      .from("penalty_fees")
      .select("id, penalty_amount, currency, account_id")
      .eq("penalty_date", today);

    const pendingWaiversQ = supabase
      .from("penalty_waiver_requests")
      .select("id")
      .eq("status", "pending");

    const totalPenaltiesQ = supabase.from("penalty_fees").select("id, status, penalty_amount, currency");
    const reminderLogsQ = supabase.from("reminder_logs").select("id, delivery_status").order("created_at", { ascending: false }).limit(200);

    // ── Cash order queries (independent of currencyFilter — cash KPIs always reported in JPY) ──
    const cashActiveQ = supabase
      .from("cash_orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .not("invoice_number", "like", "TEST-%");

    const cashCompletedMonthQ = supabase
      .from("cash_orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .gte("completed_at", monthStartStr)
      .lt("completed_at", nextMonthStartStr)
      .not("invoice_number", "like", "TEST-%");

    const cashCompletedAllQ = supabase
      .from("cash_orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed")
      .not("invoice_number", "like", "TEST-%");

    const cashCancelledQ = supabase
      .from("cash_orders")
      .select("id", { count: "exact", head: true })
      .eq("status", "cancelled")
      .not("invoice_number", "like", "TEST-%");

    // Conversion rate denominators — orders CREATED this month / all time, by source
    const cashCreatedMonthQ = supabase
      .from("cash_orders")
      .select("id", { count: "exact", head: true })
      .gte("created_at", monthStartStr)
      .lt("created_at", nextMonthStartStr)
      .not("invoice_number", "like", "TEST-%");

    const cashCreatedAllQ = supabase
      .from("cash_orders")
      .select("id", { count: "exact", head: true })
      .not("invoice_number", "like", "TEST-%");

    const layawayCreatedMonthQ = supabase
      .from("layaway_accounts")
      .select("id", { count: "exact", head: true })
      .gte("created_at", monthStartStr)
      .lt("created_at", nextMonthStartStr)
      .not("invoice_number", "like", "TEST-%");

    const layawayCreatedAllQ = supabase
      .from("layaway_accounts")
      .select("id", { count: "exact", head: true })
      .not("invoice_number", "like", "TEST-%");

    // Non-voided cash_payments joined to cash_orders for currency + TEST filter — single fetch covers
    // today / this month / all time aggregations (bucketed in JS to save round trips).
    const cashPaymentsAllTimeQ = supabase
      .from("cash_payments")
      .select("amount_paid, date_paid, cash_orders!inner(currency, invoice_number)")
      .is("voided_at", null)
      .not("cash_orders.invoice_number", "like", "TEST-%");

    // Non-voided layaway payments joined to layaway_accounts (TEST excluded) — basis for the split.
    // This fetch is needed for all-time figures; existing monthPayments lacks the TEST filter.
    const layawayPaymentsAllTimeQ = supabase
      .from("payments")
      .select("amount_paid, currency, date_paid, layaway_accounts!inner(invoice_number)")
      .is("voided_at", null)
      .not("layaway_accounts.invoice_number", "like", "TEST-%");

    // ── Fetch ALL unpaid schedule items (paginated to bypass 1000-row limit) ──
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
      { count: completedThisMonth },
      { data: forfeitedAccounts },
      { data: penaltiesToday },
      { data: pendingWaivers },
      { data: allPenalties },
      { data: reminderLogs },
      allUnpaidScheduleItems,
      { data: forfeitedTodayAccounts },
      { count: completedAllTime },
      { count: cashOrdersActive },
      { count: cashOrdersCompletedMonth },
      { count: cashOrdersCompletedAll },
      { count: cashOrdersCancelled },
      { count: cashCreatedMonth },
      { count: cashCreatedAll },
      { count: layawayCreatedMonth },
      { count: layawayCreatedAll },
      { data: cashPaymentsAllTime },
      { data: layawayPaymentsAllTime },
    ] = await Promise.all([
      accountsQ, todayPayQ, monthPayQ, completedThisMonthQ, forfeitedQ,
      penaltiesTodayQ, pendingWaiversQ,
      totalPenaltiesQ, reminderLogsQ, fetchAllScheduleItems(),
      forfeitedTodayQ, completedAllTimeQ,
      cashActiveQ, cashCompletedMonthQ, cashCompletedAllQ, cashCancelledQ,
      cashCreatedMonthQ, cashCreatedAllQ, layawayCreatedMonthQ, layawayCreatedAllQ,
      cashPaymentsAllTimeQ, layawayPaymentsAllTimeQ,
    ]);

    // ── Build account currency map ──
    const accountCurrencyMap = new Map<string, string>();
    const activeAccountIds = new Set<string>();
    for (const acc of accounts || []) {
      accountCurrencyMap.set(acc.id, acc.currency);
      activeAccountIds.add(acc.id);
    }

    // ══════════════════════════════════════════════════════════
    // CORE FIX: Classify each account by its NEXT unpaid due date
    // Each account goes into exactly ONE bucket.
    // ══════════════════════════════════════════════════════════
    const accountScheduleMap = new Map<string, any[]>();
    for (const item of allUnpaidScheduleItems) {
      if (!activeAccountIds.has(item.account_id)) continue;
      const list = accountScheduleMap.get(item.account_id) || [];
      list.push(item);
      accountScheduleMap.set(item.account_id, list);
    }

    const in3Str = phtDateStr(new Date(Date.now() + 3 * 86400000));
    const in7Str = phtDateStr(new Date(Date.now() + 7 * 86400000));

    const overdueAccountIds = new Set<string>();
    const dueTodayAccountIds = new Set<string>();
    const due3DaysAccountIds = new Set<string>();
    const due7DaysAccountIds = new Set<string>();
    let overdueAmount = 0;

    for (const [accountId, items] of accountScheduleMap.entries()) {
      const acctCurrency = accountCurrencyMap.get(accountId) || "PHP";
      if (currencyWhere && acctCurrency !== currencyWhere) continue;

      // Find next unpaid due date (earliest)
      const unpaidSorted = items
        .filter((s: any) => {
          const paid = Number(s.paid_amount);
          const due = Number(s.total_due_amount);
          if (s.status === "paid") return false;
          if (paid > 0 && paid >= due) return false;
          return true;
        })
        .sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));

      if (unpaidSorted.length === 0) continue;

      const nextDueDate = unpaidSorted[0].due_date;

      // Classify based on next due date
      if (nextDueDate < today) {
        overdueAccountIds.add(accountId);
        // Sum ALL overdue amounts for this account (not just next due)
        for (const s of items) {
          if (s.due_date < today) {
            const paid = Number(s.paid_amount);
            const due = Number(s.total_due_amount);
            if (s.status !== "paid" && !(paid > 0 && paid >= due)) {
              const amt = due - paid;
              overdueAmount += isAllMode ? toJpy(amt, acctCurrency) : amt;
            }
          }
        }
      } else if (nextDueDate === today) {
        dueTodayAccountIds.add(accountId);
      } else if (nextDueDate <= in3Str) {
        due3DaysAccountIds.add(accountId);
      } else if (nextDueDate <= in7Str) {
        due7DaysAccountIds.add(accountId);
      }
    }

    // Note: due_3 and due_7 are EXCLUSIVE of overdue and due_today
    // due_7 includes due_3 accounts (cumulative for the 7-day window)
    const due7Total = new Set([...due3DaysAccountIds, ...due7DaysAccountIds]);

    // ── Calculate KPI totals ──
    let totalReceivables = 0;
    let activeCount = 0;
    for (const acc of accounts || []) {
      const balance = Number(acc.remaining_balance);
      totalReceivables += isAllMode ? toJpy(balance, acc.currency) : balance;
      activeCount++;
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
    const penaltiesTodayAccountIds = new Set<string>();
    for (const p of penaltiesToday || []) {
      if (currencyWhere && p.currency !== currencyWhere) continue;
      penaltiesTodayCount++;
      penaltiesTodayAmount += isAllMode ? toJpy(Number(p.penalty_amount), p.currency) : Number(p.penalty_amount);
      if (p.account_id) penaltiesTodayAccountIds.add(p.account_id);
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
      if (!activeAccountIds.has(item.account_id)) continue;

      const acctCurrency = accountCurrencyMap.get(item.account_id) || item.currency;
      if (currencyWhere && acctCurrency !== currencyWhere) continue;

      let amount = remaining;
      if (isAllMode && acctCurrency === "PHP") {
        amount = toJpy(amount, "PHP");
      }

      const dueDate = new Date(item.due_date);
      if (dueDate >= now && dueDate <= in30) predicted30Raw += amount;
      if (dueDate >= now && dueDate <= in90) predicted90Raw += amount;
      if (dueDate >= nextMonthStart && dueDate <= nextMonthEnd) nextMonthRaw += amount;

      for (const bucket of monthBuckets) {
        if (dueDate >= bucket.start && dueDate <= bucket.end) {
          bucket.total += amount;
          break;
        }
      }
    }

    const riskFactor = 0.85;
    for (const bucket of monthBuckets) {
      forecastMonths.push({
        month: bucket.label,
        expected: Math.round(bucket.total),
        adjusted: Math.round(bucket.total * riskFactor),
      });
    }

    // ── Cash order KPIs (always reported in JPY regardless of currencyFilter) ──
    let cashRevenueTodayJpy = 0;
    let cashRevenueMonthJpy = 0;
    let cashRevenueTotalJpy = 0;
    for (const cp of (cashPaymentsAllTime || []) as any[]) {
      const amt = Number(cp.amount_paid);
      const cur = cp.cash_orders?.currency || "PHP";
      const jpy = toJpy(amt, cur);
      cashRevenueTotalJpy += jpy;
      const dp = String(cp.date_paid || "");
      if (dp >= monthStartStr && dp < nextMonthStartStr) cashRevenueMonthJpy += jpy;
      if (dp === today) cashRevenueTodayJpy += jpy;
    }

    // Layaway revenue (TEST excluded) — month + all time, for the split
    let layawayRevenueMonthJpy = 0;
    let layawayRevenueTotalJpy = 0;
    for (const p of (layawayPaymentsAllTime || []) as any[]) {
      const amt = Number(p.amount_paid);
      const cur = p.currency || "PHP";
      const jpy = toJpy(amt, cur);
      layawayRevenueTotalJpy += jpy;
      const dp = String(p.date_paid || "");
      if (dp >= monthStartStr && dp < nextMonthStartStr) layawayRevenueMonthJpy += jpy;
    }

    const pctOrZero = (numerator: number, denominator: number) =>
      denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

    const cashRevenueMonthRound = Math.round(cashRevenueMonthJpy);
    const layawayRevenueMonthRound = Math.round(layawayRevenueMonthJpy);
    const cashRevenueTotalRound = Math.round(cashRevenueTotalJpy);
    const layawayRevenueTotalRound = Math.round(layawayRevenueTotalJpy);

    const cashVsLayawaySplit = {
      this_month: {
        cash_revenue_jpy: cashRevenueMonthRound,
        layaway_revenue_jpy: layawayRevenueMonthRound,
        cash_percentage: pctOrZero(cashRevenueMonthRound, cashRevenueMonthRound + layawayRevenueMonthRound),
      },
      all_time: {
        cash_revenue_jpy: cashRevenueTotalRound,
        layaway_revenue_jpy: layawayRevenueTotalRound,
        cash_percentage: pctOrZero(cashRevenueTotalRound, cashRevenueTotalRound + layawayRevenueTotalRound),
      },
    };

    const cashCreatedMonthVal = cashCreatedMonth ?? 0;
    const cashCreatedAllVal = cashCreatedAll ?? 0;
    const layawayCreatedMonthVal = layawayCreatedMonth ?? 0;
    const layawayCreatedAllVal = layawayCreatedAll ?? 0;
    const cashConversionRate = {
      this_month: pctOrZero(cashCreatedMonthVal, cashCreatedMonthVal + layawayCreatedMonthVal),
      all_time: pctOrZero(cashCreatedAllVal, cashCreatedAllVal + layawayCreatedAllVal),
    };

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
      completed_this_month: completedThisMonth ?? 0,
      forfeited_accounts: (forfeitedAccounts || []).length,
      forfeited_today: (forfeitedTodayAccounts || []).length,
      completed_all_time: completedAllTime ?? 0,
      // Operations — based on NEXT due date per account (single bucket)
      due_today_count: dueTodayAccountIds.size,
      due_3_days_count: due3DaysAccountIds.size,
      due_7_days_count: due7Total.size,
      penalties_today_count: penaltiesTodayCount,
      penalties_today_amount: penaltiesTodayAmount,
      penalties_today_account_ids: [...penaltiesTodayAccountIds],
      pending_waivers_count: (pendingWaivers || []).length,
      // System health
      total_penalties_applied: totalPenaltiesApplied,
      total_penalties_waived: totalPenaltiesWaived,
      total_penalties_amount: totalPenaltiesAmount,
      total_waived_amount: totalWaivedAmount,
      reminder_total: totalReminders,
      reminder_success: successReminders,
      reminder_failed: failedReminders,
      // Cash orders
      cash_orders_active: cashOrdersActive ?? 0,
      cash_orders_completed_this_month: cashOrdersCompletedMonth ?? 0,
      cash_orders_completed_all_time: cashOrdersCompletedAll ?? 0,
      cash_orders_cancelled: cashOrdersCancelled ?? 0,
      cash_revenue_today_jpy: Math.round(cashRevenueTodayJpy),
      cash_revenue_month_jpy: cashRevenueMonthRound,
      cash_revenue_total_jpy: cashRevenueTotalRound,
      cash_vs_layaway_split: cashVsLayawaySplit,
      cash_conversion_rate: cashConversionRate,
      // Predictions
      predicted_30d: Math.round(predicted30Raw * riskFactor),
      predicted_30d_raw: Math.round(predicted30Raw),
      predicted_90d: Math.round(predicted90Raw * riskFactor),
      predicted_90d_raw: Math.round(predicted90Raw),
      next_month_expected: Math.round(nextMonthRaw),
      next_month_adjusted: Math.round(nextMonthRaw * riskFactor),
      forecast_6_months: forecastMonths,
      // Debug: account IDs per bucket for drill-down verification
      _debug_overdue_ids: [...overdueAccountIds],
      _debug_due_today_ids: [...dueTodayAccountIds],
      _debug_due_3_ids: [...due3DaysAccountIds],
      _debug_due_7_ids: [...due7Total],
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
