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
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Read currency filter from body (POST) or URL params (GET)
    let currencyFilter = "ALL";
    if (req.method === "POST") {
      try {
        const body = await req.json();
        currencyFilter = body.currency_mode || body.currency || "ALL";
      } catch { /* empty body, default ALL */ }
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

    // Build currency filter
    const currencyWhere = currencyFilter !== "ALL" ? currencyFilter : null;

    // Active accounts
    let accountsQuery = supabase
      .from("layaway_accounts")
      .select("*")
      .in("status", ["active", "overdue"]);
    
    if (currencyWhere) {
      accountsQuery = accountsQuery.eq("currency", currencyWhere);
    }

    const { data: accounts } = await accountsQuery;

    // Calculate totals
    let totalReceivables = 0;
    let activeCount = 0;
    let overdueCount = 0;

    for (const acc of accounts || []) {
      const balance = Number(acc.remaining_balance);
      if (currencyFilter === "ALL") {
        totalReceivables += toJpy(balance, acc.currency);
      } else {
        totalReceivables += balance;
      }
      activeCount++;
      if (acc.status === "overdue") overdueCount++;
    }

    // Today's payments
    const today = new Date().toISOString().split("T")[0];
    let paymentsQuery = supabase
      .from("payments")
      .select("*")
      .eq("date_paid", today);

    if (currencyWhere) {
      paymentsQuery = paymentsQuery.eq("currency", currencyWhere);
    }

    const { data: todayPayments } = await paymentsQuery;

    let paymentsToday = 0;
    for (const p of todayPayments || []) {
      if (currencyFilter === "ALL") {
        paymentsToday += toJpy(Number(p.amount_paid), p.currency);
      } else {
        paymentsToday += Number(p.amount_paid);
      }
    }

    // This month's collections
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStartStr = monthStart.toISOString().split("T")[0];

    let monthQuery = supabase
      .from("payments")
      .select("*")
      .gte("date_paid", monthStartStr);

    if (currencyWhere) {
      monthQuery = monthQuery.eq("currency", currencyWhere);
    }

    const { data: monthPayments } = await monthQuery;

    let collectionsThisMonth = 0;
    for (const p of monthPayments || []) {
      if (currencyFilter === "ALL") {
        collectionsThisMonth += toJpy(Number(p.amount_paid), p.currency);
      } else {
        collectionsThisMonth += Number(p.amount_paid);
      }
    }

    // Upcoming due (next 7 days)
    const next7 = new Date();
    next7.setDate(next7.getDate() + 7);
    const next7Str = next7.toISOString().split("T")[0];

    let upcomingQuery = supabase
      .from("layaway_schedule")
      .select("*, layaway_accounts!inner(currency, customer_id, invoice_number)")
      .gte("due_date", today)
      .lte("due_date", next7Str)
      .in("status", ["pending"]);

    const { data: upcomingDue } = await upcomingQuery;

    const displayCurrency = currencyFilter === "ALL" ? "JPY" : currencyFilter;

    return new Response(JSON.stringify({
      currency: displayCurrency,
      currency_filter: currencyFilter,
      active_layaways: activeCount,
      overdue_accounts: overdueCount,
      total_receivables: totalReceivables,
      payments_today: paymentsToday,
      collections_this_month: collectionsThisMonth,
      upcoming_due_count: upcomingDue?.length || 0,
      conversion_rate: conversionRate,
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
