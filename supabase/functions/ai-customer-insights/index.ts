import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * AI Customer Insights
 *
 * Takes a customer_id, aggregates their layaway accounts, payment history,
 * penalties, and loyalty status, and asks Lovable AI Gateway (Gemini) to
 * produce a concise staff-facing insight report:
 *
 *   • Payment behavior summary
 *   • Risk assessment (Low / Medium / High) with reasons
 *   • Recommended next action for staff
 *
 * Read-only — does NOT mutate any data.
 *
 * Body: { customer_id: string }
 * Returns: { insights: string, risk: 'low'|'medium'|'high', meta: {...} }
 */

interface AccountRow {
  id: string;
  invoice_number: string;
  currency: string;
  status: string;
  total_amount: number;
  total_paid: number;
  remaining_balance: number;
  payment_plan_months: number;
  order_date: string;
  is_trade: boolean | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { customer_id } = await req.json();
    if (!customer_id || typeof customer_id !== "string") {
      return new Response(JSON.stringify({ error: "customer_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Gather data ──
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .select("id, customer_code, full_name, location, created_at")
      .eq("id", customer_id)
      .maybeSingle();
    if (custErr || !customer) {
      return new Response(JSON.stringify({ error: "Customer not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: accountsRaw } = await supabase
      .from("layaway_accounts")
      .select(
        "id, invoice_number, currency, status, total_amount, total_paid, remaining_balance, payment_plan_months, order_date, is_trade",
      )
      .eq("customer_id", customer_id)
      .order("order_date", { ascending: false });
    const accounts = (accountsRaw ?? []) as AccountRow[];
    const accountIds = accounts.map((a) => a.id);

    const [paymentsRes, penaltiesRes, loyaltyRes] = await Promise.all([
      accountIds.length
        ? supabase
          .from("payments")
          .select("amount_paid, date_paid, payment_method, account_id, voided_at")
          .in("account_id", accountIds)
          .is("voided_at", null)
          .order("date_paid", { ascending: false })
          .limit(50)
        : Promise.resolve({ data: [] as any[] }),
      accountIds.length
        ? supabase
          .from("penalty_fees")
          .select("penalty_amount, status, account_id, created_at")
          .in("account_id", accountIds)
          .not("created_at", "gte", "2026-03-22T00:00:00Z")
          .not("created_at", "lte", "2026-03-22T23:59:59Z")
        : Promise.resolve({ data: [] as any[] }),
      supabase
        .from("loyalty_members")
        .select("current_tier_name, remaining_points, total_points_earned, cumulative_spend_jpy, status")
        .eq("customer_id", customer_id)
        .maybeSingle(),
    ]);

    const payments = (paymentsRes as any).data ?? [];
    // Exclude migration-batch penalties (all created 2026-03-22)
    const allPenalties = (penaltiesRes as any).data ?? [];
    const penalties = allPenalties.filter((p: any) =>
      !p.created_at?.startsWith("2026-03-22")
    );
    const loyalty = (loyaltyRes as any).data ?? null;

    // ── Build compact context for the AI ──
    const today = new Date().toISOString().slice(0, 10);
    const totalLayaway = accounts.reduce((s, a) => s + Number(a.total_amount || 0), 0);
    const totalPaid = accounts.reduce((s, a) => s + Number(a.total_paid || 0), 0);
    const totalRemaining = accounts.reduce((s, a) => s + Number(a.remaining_balance || 0), 0);
    const overdueCount = accounts.filter((a) => a.status === "overdue").length;
    const forfeitedCount = accounts.filter((a) =>
      ["forfeited", "final_forfeited", "final_settlement"].includes(a.status)
    ).length;
    const completedCount = accounts.filter((a) => a.status === "completed").length;
    const activeCount = accounts.filter((a) =>
      ["active", "overdue", "extension_active", "reactivated"].includes(a.status)
    ).length;
    const penaltyCount = penalties.length;
    const unpaidPenaltyCount = penalties.filter((p: any) => p.status === "unpaid").length;
    const waivedPenaltyCount = penalties.filter((p: any) => p.status === "waived").length;
    const lastPayment = payments[0] ?? null;
    const daysSinceLastPayment = lastPayment
      ? Math.floor(
        (Date.now() - new Date(lastPayment.date_paid).getTime()) / 86_400_000,
      )
      : null;

    const context = {
      today,
      customer: {
        name: customer.full_name,
        code: customer.customer_code,
        location: (customer as any).location,
        joined: (customer as any).created_at?.slice(0, 10),
      },
      portfolio: {
        total_accounts: accounts.length,
        active: activeCount,
        overdue: overdueCount,
        completed: completedCount,
        forfeited_or_settlement: forfeitedCount,
        total_layaway_value: totalLayaway,
        total_paid: totalPaid,
        total_remaining: totalRemaining,
      },
      accounts: accounts.slice(0, 10).map((a) => ({
        invoice: a.invoice_number,
        currency: a.currency,
        status: a.status,
        plan_months: a.payment_plan_months,
        order_date: a.order_date,
        total: Number(a.total_amount),
        paid: Number(a.total_paid),
        remaining: Number(a.remaining_balance),
        is_trade: !!a.is_trade,
      })),
      penalties: {
        total_events: penaltyCount,
        currently_unpaid: unpaidPenaltyCount,
        waived: waivedPenaltyCount,
      },
      payments: {
        recent_count: payments.length,
        last_payment_amount: lastPayment ? Number(lastPayment.amount_paid) : null,
        last_payment_date: lastPayment?.date_paid ?? null,
        last_payment_method: lastPayment?.payment_method ?? null,
        days_since_last_payment: daysSinceLastPayment,
      },
      loyalty: loyalty
        ? {
          tier: loyalty.current_tier_name,
          points: loyalty.remaining_points,
          lifetime_earned: loyalty.total_points_earned,
          cumulative_spend_jpy: loyalty.cumulative_spend_jpy,
          status: loyalty.status,
        }
        : null,
    };

    const systemPrompt = `You are an analyst for Cha Jewels, a jewelry layaway business.
Given a customer's account portfolio, produce a concise STAFF-FACING insight report.

Output STRICT JSON (no markdown, no prose outside JSON) with this shape:
{
  "risk": "low" | "medium" | "high",
  "summary": "2-3 sentence plain-English overview of this customer",
  "behavior": ["bullet 1", "bullet 2", "bullet 3"],
  "risk_reasons": ["short reason 1", "short reason 2"],
  "next_action": "single recommended next step for staff (one sentence)",
  "highlights": ["positive highlight 1", "positive highlight 2"]
}

Risk rubric:
- HIGH: any forfeited/final_settlement account, OR >=2 overdue accounts, OR unpaid penalty count >=3, OR no payment in 60+ days AND remaining balance > 0.
- MEDIUM: 1 overdue account, OR 1-2 unpaid penalties, OR (no payment in 30-59 days AND remaining balance > 0), OR mostly paying late.
- LOW: all accounts completed or active with good payment history, OR customer has no remaining balance (fully paid off). A completed account with zero remaining balance should NEVER be flagged as high or medium risk due to payment inactivity alone.
- LOW: paying on time, no unpaid penalties, recent payment activity.

Be specific. Reference invoice numbers, days since last payment, balance amounts. Currency symbol: ₱ for PHP, ¥ for JPY. No commentary outside JSON.`;

    const userPrompt = `Customer data (JSON):\n${JSON.stringify(context, null, 2)}`;

    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });

    if (!aiResp.ok) {
      const errorText = await aiResp.text();
      if (aiResp.status === 429) {
        return new Response(
          JSON.stringify({ error: "AI rate limit reached. Please try again in a moment." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (aiResp.status === 402) {
        return new Response(
          JSON.stringify({ error: "AI credits exhausted. Please add credits in workspace billing." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      throw new Error(`AI error ${aiResp.status}: ${errorText}`);
    }

    const aiJson = await aiResp.json();
    let content = String(aiJson.choices?.[0]?.message?.content ?? "").trim();
    if (content.startsWith("```")) {
      content = content.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {
        risk: "medium",
        summary: content || "AI returned an unparseable response.",
        behavior: [],
        risk_reasons: [],
        next_action: "Review account manually.",
        highlights: [],
      };
    }

    return new Response(
      JSON.stringify({
        ...parsed,
        meta: {
          generated_at: new Date().toISOString(),
          accounts_analyzed: accounts.length,
          payments_analyzed: payments.length,
          penalties_analyzed: penaltyCount,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("ai-customer-insights error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
