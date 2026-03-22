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

    // Validate portal token
    const { data: tokenRow, error: tokenErr } = await supabase
      .from("customer_portal_tokens")
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
      return new Response(JSON.stringify({ error: "Portal link has expired" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const customerId = tokenRow.customer_id;

    // Fetch customer
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .select("id, full_name, customer_code")
      .eq("id", customerId)
      .maybeSingle();

    if (custErr || !customer) {
      return new Response(JSON.stringify({ error: "Customer not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch all accounts for this customer
    const { data: accounts, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("customer_id", customerId)
      .order("order_date", { ascending: false });

    if (accErr) {
      return new Response(JSON.stringify({ error: "Failed to load accounts" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accountIds = (accounts || []).map((a: any) => a.id);

    // Fetch schedules, payments, and statement tokens for all accounts in parallel
    const [schedulesRes, paymentsRes, stTokensRes, servicesRes] = await Promise.all([
      accountIds.length > 0
        ? supabase.from("layaway_schedule").select("*").in("account_id", accountIds).order("installment_number")
        : Promise.resolve({ data: [], error: null }),
      accountIds.length > 0
        ? supabase.from("payments").select("*").in("account_id", accountIds).is("voided_at", null).order("date_paid", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      accountIds.length > 0
        ? supabase.from("statement_tokens").select("*").in("account_id", accountIds).eq("is_active", true)
        : Promise.resolve({ data: [], error: null }),
      accountIds.length > 0
        ? supabase.from("account_services").select("*").in("account_id", accountIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const schedules = schedulesRes.data || [];
    const payments = paymentsRes.data || [];
    const stTokens = stTokensRes.data || [];
    const services = servicesRes.data || [];

    // Group by account
    const schedulesByAccount: Record<string, any[]> = {};
    const paymentsByAccount: Record<string, any[]> = {};
    const servicesByAccount: Record<string, any[]> = {};
    const statementTokenByAccount: Record<string, string> = {};

    for (const s of schedules) {
      (schedulesByAccount[s.account_id] ||= []).push(s);
    }
    for (const p of payments) {
      (paymentsByAccount[p.account_id] ||= []).push(p);
    }
    for (const s of services) {
      (servicesByAccount[s.account_id] ||= []).push(s);
    }
    for (const t of stTokens) {
      // Check expiry
      if (!t.expires_at || new Date(t.expires_at) > new Date()) {
        statementTokenByAccount[t.account_id] = t.token;
      }
    }

    // Build response
    const accountCards = (accounts || []).map((acc: any) => {
      const acctSchedule = schedulesByAccount[acc.id] || [];
      const acctPayments = paymentsByAccount[acc.id] || [];
      const acctServices = servicesByAccount[acc.id] || [];

      const paidInstallments = acctSchedule.filter((s: any) => s.status === 'paid').length;
      const totalInstallments = acctSchedule.filter((s: any) => s.status !== 'cancelled').length;

      // Compute actual remaining from payments
      const totalPayments = acctPayments.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
      const computedRemaining = Math.max(0, Number(acc.total_amount) - totalPayments);
      const totalServices = acctServices.reduce((s: number, sv: any) => s + Number(sv.amount), 0);

      // Next due date
      const today = new Date().toISOString().split('T')[0];
      const unpaidSchedule = acctSchedule
        .filter((s: any) => s.status !== 'paid' && s.status !== 'cancelled')
        .sort((a: any, b: any) => a.due_date.localeCompare(b.due_date));
      const nextDue = unpaidSchedule[0] || null;

      // Progress percentage
      const progressPercent = Number(acc.total_amount) > 0
        ? Math.min(100, Math.round((totalPayments / Number(acc.total_amount)) * 100))
        : 0;

      // Status label
      const statusLabel =
        acc.status === 'completed' ? 'Fully Paid' :
        acc.status === 'active' ? (unpaidSchedule.some((s: any) => s.due_date < today) ? 'Overdue' : 'Active') :
        acc.status === 'final_settlement' ? 'Final Settlement' :
        acc.status === 'forfeited' ? 'Forfeited' :
        acc.status === 'cancelled' ? 'Cancelled' :
        acc.status === 'reactivated' ? 'Active' :
        acc.status === 'extension_active' ? 'Active' :
        acc.status.charAt(0).toUpperCase() + acc.status.slice(1);

      return {
        id: acc.id,
        invoice_number: acc.invoice_number,
        currency: acc.currency,
        total_amount: Number(acc.total_amount),
        total_paid: totalPayments,
        remaining_balance: computedRemaining,
        downpayment_amount: Number(acc.downpayment_amount || 0),
        order_date: acc.order_date,
        payment_plan_months: acc.payment_plan_months,
        status: acc.status,
        status_label: statusLabel,
        progress_percent: progressPercent,
        paid_installments: paidInstallments,
        total_installments: totalInstallments,
        total_services: totalServices,
        next_due_date: nextDue?.due_date || null,
        next_due_amount: nextDue ? Number(nextDue.total_due_amount) - Number(nextDue.paid_amount) : null,
        statement_token: statementTokenByAccount[acc.id] || null,
        schedule: acctSchedule.map((s: any) => ({
          installment_number: s.installment_number,
          due_date: s.due_date,
          base_amount: Number(s.base_installment_amount),
          penalty_amount: Number(s.penalty_amount),
          total_due: Number(s.total_due_amount),
          paid_amount: Number(s.paid_amount),
          status: s.status,
        })),
        payments: acctPayments.map((p: any) => ({
          amount: Number(p.amount_paid),
          date: p.date_paid,
          method: p.payment_method,
          reference: p.reference_number,
          remarks: p.remarks,
        })),
      };
    });

    // Summary stats
    const activeAccounts = accountCards.filter((a: any) => ['Active', 'Overdue'].includes(a.status_label));
    const completedAccounts = accountCards.filter((a: any) => a.status_label === 'Fully Paid');
    const totalOutstanding = activeAccounts.reduce((s: number, a: any) => s + a.remaining_balance, 0);

    // Next due across all accounts
    const allNextDues = accountCards
      .filter((a: any) => a.next_due_date)
      .sort((a: any, b: any) => a.next_due_date.localeCompare(b.next_due_date));

    return new Response(JSON.stringify({
      customer_name: customer.full_name,
      customer_code: customer.customer_code,
      summary: {
        total_active: activeAccounts.length,
        total_completed: completedAccounts.length,
        total_outstanding: totalOutstanding,
        total_accounts: accountCards.length,
        next_due_date: allNextDues[0]?.next_due_date || null,
        next_due_invoice: allNextDues[0]?.invoice_number || null,
        primary_currency: accountCards[0]?.currency || 'PHP',
      },
      accounts: accountCards,
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
