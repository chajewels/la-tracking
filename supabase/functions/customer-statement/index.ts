import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token || token.length < 16) {
      return new Response(JSON.stringify({ error: "Invalid or missing token" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Validate token
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("statement_tokens")
      .select("*")
      .eq("token", token)
      .eq("is_active", true)
      .maybeSingle();

    if (tokenErr || !tokenRow) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check expiry
    if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: "Statement link has expired" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountId = tokenRow.account_id;

    // Fetch account with customer
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*, customers(*)")
      .eq("id", accountId)
      .maybeSingle();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch schedule, penalties, payments, services in parallel
    const [scheduleRes, penaltiesRes, paymentsRes, servicesRes] = await Promise.all([
      supabase.from("layaway_schedule").select("*").eq("account_id", accountId).order("installment_number"),
      supabase.from("penalty_fees").select("*").eq("account_id", accountId).order("penalty_date"),
      supabase.from("payments").select("*").eq("account_id", accountId).is("voided_at", null).order("date_paid"),
      supabase.from("account_services").select("*").eq("account_id", accountId),
    ]);

    // Strip internal fields from customer
    const customer = account.customers ? {
      full_name: account.customers.full_name,
      customer_code: account.customers.customer_code,
    } : null;

    // Build safe response - no internal IDs, user IDs, or admin data
    const isFinalSettlement = account.status === 'final_settlement';
    const isForfeited = account.status === 'forfeited';

    // Fetch final settlement record if applicable
    let finalSettlementRecord = null;
    if (isFinalSettlement) {
      const { data: fsRecord } = await supabase
        .from("final_settlement_records")
        .select("*")
        .eq("account_id", accountId)
        .maybeSingle();
      if (fsRecord) {
        finalSettlementRecord = {
          final_settlement_amount: Number(fsRecord.final_settlement_amount),
          remaining_principal: Number(fsRecord.remaining_principal),
          penalty_total: Number(fsRecord.penalty_total_from_last_paid),
          penalty_occurrences: fsRecord.penalty_occurrence_count,
          last_paid_month: fsRecord.last_paid_month_date,
        };
      }
    }

    // SINGLE SOURCE OF TRUTH: derive totals from confirmed payments, not stored fields
    const actualPaymentsTotal = (paymentsRes.data || []).reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
    const computedRemaining = Math.max(0, Number(account.total_amount) - actualPaymentsTotal);

    const statement = {
      invoice_number: account.invoice_number,
      customer_name: customer?.full_name || "Customer",
      currency: account.currency,
      total_amount: Number(account.total_amount),
      total_paid: actualPaymentsTotal,
      remaining_balance: computedRemaining,
      downpayment_amount: Number(account.downpayment_amount || 0),
      status: account.status,
      status_label: isFinalSettlement ? 'FINAL SETTLEMENT' : isForfeited ? 'FORFEITED' : account.status.toUpperCase(),
      order_date: account.order_date,
      payment_plan_months: account.payment_plan_months,
      final_settlement: finalSettlementRecord,
      schedule: (scheduleRes.data || []).map((s: any) => ({
        installment_number: s.installment_number,
        due_date: s.due_date,
        base_amount: Number(s.base_installment_amount),
        penalty_amount: Number(s.penalty_amount),
        total_due: Number(s.total_due_amount),
        paid_amount: Number(s.paid_amount),
        status: s.status,
      })),
      penalties: (penaltiesRes.data || []).map((p: any) => ({
        schedule_id: p.schedule_id,
        amount: Number(p.penalty_amount),
        stage: p.penalty_stage,
        date: p.penalty_date,
        status: p.status,
      })),
      payments: (paymentsRes.data || []).map((p: any) => ({
        amount: Number(p.amount_paid),
        date: p.date_paid,
        method: p.payment_method,
      })),
      services: (servicesRes.data || []).map((s: any) => ({
        type: s.service_type,
        description: s.description,
        amount: Number(s.amount),
      })),
    };

    // Compute derived totals
    const activePenalties = (penaltiesRes.data || []).filter((p: any) => p.status === "unpaid");
    const waivedPenalties = (penaltiesRes.data || []).filter((p: any) => p.status === "waived");
    const totalActivePenalties = activePenalties.reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
    const totalWaivedAmount = waivedPenalties.reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
    const totalServices = (servicesRes.data || []).reduce((s: number, sv: any) => s + Number(sv.amount), 0);

    // Consistent payable total: remaining principal + outstanding penalties
    const currentTotalPayable = computedRemaining + totalActivePenalties;

    return new Response(JSON.stringify({
      ...statement,
      total_active_penalties: totalActivePenalties,
      total_waived_amount: totalWaivedAmount,
      total_services: totalServices,
      computed_remaining: computedRemaining,
      current_total_payable: currentTotalPayable,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
