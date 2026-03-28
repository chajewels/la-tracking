import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Penalty-aware next due date.
 * 14-day checkpoints only for installments with penalty_amount > 0.
 */
function computeNextDueDate(
  unpaidSchedule: any[],
  today: string,
  todayDate: Date
): { date: string; isAdjusted: boolean } | null {
  if (unpaidSchedule.length === 0) return null;

  const candidates: Array<{ date: Date; isAdjusted: boolean }> = [];

  for (const item of unpaidSchedule) {
    const hasPenalty = Number(item.penalty_amount) > 0;
    const isOverdue = item.due_date < today;

    if (!isOverdue) {
      candidates.push({ date: new Date(item.due_date + 'T00:00:00Z'), isAdjusted: false });
    } else if (hasPenalty) {
      const dueDate = new Date(item.due_date + 'T00:00:00Z');
      const dueDayOfMonth = dueDate.getUTCDate();
      const checkpoints: Date[] = [];
      const p1 = new Date(dueDate); p1.setUTCDate(p1.getUTCDate() + 7); checkpoints.push(p1);
      const p2 = new Date(dueDate); p2.setUTCDate(p2.getUTCDate() + 14); checkpoints.push(p2);
      for (let m = 1; m <= 12; m++) {
        const year = dueDate.getUTCFullYear();
        const month = dueDate.getUTCMonth() + m;
        const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        const monthly = new Date(Date.UTC(year, month, Math.min(dueDayOfMonth, maxDay)));
        checkpoints.push(monthly);
        const plus14 = new Date(monthly); plus14.setUTCDate(plus14.getUTCDate() + 14);
        checkpoints.push(plus14);
      }
      const nextCp = checkpoints.find(cp => cp > todayDate);
      if (nextCp) candidates.push({ date: nextCp, isAdjusted: true });
    } else {
      candidates.push({ date: new Date(item.due_date + 'T00:00:00Z'), isAdjusted: false });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.date.getTime() - b.date.getTime());
  const future = candidates.find(c => c.date >= todayDate);
  if (future) return { date: future.date.toISOString().split('T')[0], isAdjusted: future.isAdjusted };
  const latest = candidates[candidates.length - 1];
  return { date: latest.date.toISOString().split('T')[0], isAdjusted: latest.isAdjusted };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Handle POST for profile updates
    if (req.method === "POST") {
      const body = await req.json();
      const token = body.token;
      const action = body.action;

      if (!token || token.length < 16) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Validate token
      const { data: tokenRow } = await supabase
        .from("customer_portal_tokens")
        .select("*")
        .eq("token", token)
        .eq("is_active", true)
        .maybeSingle();

      if (!tokenRow) {
        return new Response(JSON.stringify({ error: "Access denied" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
        return new Response(JSON.stringify({ error: "Portal link has expired" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (action === "update_profile") {
        const profile = body.profile;
        if (!profile || !profile.full_name?.trim()) {
          return new Response(JSON.stringify({ error: "Full Name is required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const updateData: Record<string, any> = {
          full_name: profile.full_name.trim(),
          location: profile.location || null,
          facebook_name: profile.facebook_name || null,
          messenger_link: profile.messenger_link || null,
          mobile_number: profile.mobile_number || null,
          email: profile.email || null,
          notes: profile.notes || null,
        };

        const { error: updateErr } = await supabase
          .from("customers")
          .update(updateData)
          .eq("id", tokenRow.customer_id);

        if (updateErr) {
          return new Response(JSON.stringify({ error: "Failed to update profile" }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Log audit
        await supabase.from("audit_logs").insert({
          entity_type: "customer",
          entity_id: tokenRow.customer_id,
          action: "portal_profile_update",
          new_value_json: updateData,
        });

        return new Response(JSON.stringify({ profile: updateData }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ error: "Unknown action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET flow - existing portal data
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token || token.length < 16) {
      return new Response(JSON.stringify({ error: "Invalid or missing token" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    if (tokenRow.expires_at && new Date(tokenRow.expires_at) < new Date()) {
      return new Response(JSON.stringify({ error: "Portal link has expired" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const customerId = tokenRow.customer_id;

    // Fetch customer with profile fields
    const { data: customer, error: custErr } = await supabase
      .from("customers")
      .select("id, full_name, customer_code, location, facebook_name, messenger_link, mobile_number, email, notes")
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

    const [schedulesRes, paymentsRes, stTokensRes, servicesRes, methodsRes, submissionsRes, penaltiesRes] = await Promise.all([
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
      supabase.from("payment_methods").select("*").eq("is_active", true).order("sort_order"),
      accountIds.length > 0
        ? supabase.from("payment_submissions").select("id, account_id, submitted_amount, payment_date, payment_method, reference_number, sender_name, notes, proof_url, status, reviewer_notes, created_at, customer_edited_at").eq("customer_id", customerId).in("account_id", accountIds).neq("status", "cancelled").order("created_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      accountIds.length > 0
        ? supabase.from("penalty_fees").select("id, account_id, schedule_id, penalty_amount, status").in("account_id", accountIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const schedules = schedulesRes.data || [];
    const payments = paymentsRes.data || [];
    const stTokens = stTokensRes.data || [];
    const services = servicesRes.data || [];
    const paymentMethods = methodsRes.data || [];
    const submissions = submissionsRes.data || [];
    const penalties = penaltiesRes.data || [];

    const schedulesByAccount: Record<string, any[]> = {};
    const paymentsByAccount: Record<string, any[]> = {};
    const servicesByAccount: Record<string, any[]> = {};
    const statementTokenByAccount: Record<string, string> = {};
    const submissionsByAccount: Record<string, any[]> = {};
    const penaltiesByAccount: Record<string, any[]> = {};
    const penaltiesBySchedule: Record<string, any> = {};

    for (const s of schedules) { (schedulesByAccount[s.account_id] ||= []).push(s); }
    for (const p of payments) { (paymentsByAccount[p.account_id] ||= []).push(p); }
    for (const s of services) { (servicesByAccount[s.account_id] ||= []).push(s); }
    for (const pen of penalties) {
      (penaltiesByAccount[pen.account_id] ||= []).push(pen);
      if (pen.schedule_id) penaltiesBySchedule[pen.schedule_id] = pen;
    }
    for (const t of stTokens) {
      if (!t.expires_at || new Date(t.expires_at) > new Date()) {
        statementTokenByAccount[t.account_id] = t.token;
      }
    }
    for (const sub of submissions) { (submissionsByAccount[sub.account_id] ||= []).push(sub); }

    const accountCards = (accounts || []).map((acc: any) => {
      const acctSchedule = schedulesByAccount[acc.id] || [];
      const acctPayments = paymentsByAccount[acc.id] || [];
      const acctServices = servicesByAccount[acc.id] || [];

      const paidInstallments = acctSchedule.filter((s: any) => s.status === 'paid').length;
      const totalInstallments = acctSchedule.filter((s: any) => s.status !== 'cancelled').length;
      const totalPayments = acctPayments.reduce((s: number, p: any) => s + Number(p.amount_paid), 0);
      const computedRemaining = Math.max(0, Number(acc.total_amount) - totalPayments);
      const totalServices = acctServices.reduce((s: number, sv: any) => s + Number(sv.amount), 0);

      // Compute outstanding penalties from penalty_fees table (source of truth)
      const acctPenalties = penaltiesByAccount[acc.id] || [];
      const unpaidPenaltySum = acctPenalties
        .filter((p: any) => p.status === 'unpaid')
        .reduce((s: number, p: any) => s + Number(p.penalty_amount), 0);
      const currentTotalPayable = computedRemaining + unpaidPenaltySum + totalServices;

      const today = new Date().toISOString().split('T')[0];
      const todayDate = new Date(today + 'T00:00:00Z');
      const unpaidSchedule = acctSchedule
        .filter((s: any) => s.status !== 'cancelled' && (s.status === 'partially_paid' || s.status !== 'paid'))
        .sort((a: any, b: any) => {
          // Priority: partially_paid first, then by due_date
          const isPartialA = a.status === 'partially_paid';
          const isPartialB = b.status === 'partially_paid';
          if (isPartialA !== isPartialB) return isPartialA ? -1 : 1;
          return a.due_date.localeCompare(b.due_date);
        });

      // Penalty-aware next due date calculation
      const nextDueInfo = computeNextDueDate(unpaidSchedule, today, todayDate);
      const nextDue = unpaidSchedule[0] || null;
      // For partial items: if paid < total_due → not reconciled, remaining = total_due - paid;
      // if paid >= total_due → reconciled, total_due IS the remaining shortfall. Never negative.
      const nextDueAmount = (() => {
        if (!nextDue) return null;
        const td = Number(nextDue.total_due_amount);
        const pa = Number(nextDue.paid_amount);
        if (nextDue.status === 'partially_paid') {
          return pa < td ? Math.max(0, td - pa) : Math.max(0, td);
        }
        return Math.max(0, td - pa);
      })();

      const progressPercent = Number(acc.total_amount) > 0
        ? Math.min(100, Math.round((totalPayments / Number(acc.total_amount)) * 100))
        : 0;

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
        outstanding_penalties: unpaidPenaltySum,
        current_total_payable: currentTotalPayable,
        next_due_date: nextDueInfo?.date || null,
        next_due_amount: nextDueAmount,
        statement_token: statementTokenByAccount[acc.id] || null,
        schedule: acctSchedule.map((s: any) => ({
          installment_number: s.installment_number,
          due_date: s.due_date,
          base_amount: Number(s.base_installment_amount),
          penalty_amount: Number(s.penalty_amount),
          penalty_fee_status: penaltiesBySchedule[s.id]?.status ?? null,
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
        submissions: (submissionsByAccount[acc.id] || []).map((sub: any) => ({
          id: sub.id,
          submitted_amount: Number(sub.submitted_amount),
          payment_date: sub.payment_date,
          payment_method: sub.payment_method,
          reference_number: sub.reference_number,
          sender_name: sub.sender_name,
          notes: sub.notes,
          proof_url: sub.proof_url,
          status: sub.status,
          reviewer_notes: sub.reviewer_notes,
          created_at: sub.created_at,
        })),
      };
    });

    const activeAccounts = accountCards.filter((a: any) => ['Active', 'Overdue'].includes(a.status_label));
    const completedAccounts = accountCards.filter((a: any) => a.status_label === 'Fully Paid');
    const totalOutstanding = activeAccounts.reduce((s: number, a: any) => s + a.remaining_balance, 0);

    // Accumulated amount spent: sum of total_paid for non-forfeited, non-cancelled accounts
    const accumulatedAmountSpent = accountCards
      .filter((a: any) => !['forfeited', 'final_forfeited', 'cancelled'].includes(a.status))
      .reduce((s: number, a: any) => s + a.total_paid, 0);

    const allNextDues = accountCards
      .filter((a: any) => a.next_due_date)
      .sort((a: any, b: any) => a.next_due_date.localeCompare(b.next_due_date));

    return new Response(JSON.stringify({
      customer_name: customer.full_name,
      customer_code: customer.customer_code,
      customer_id: customer.id,
      profile: {
        full_name: customer.full_name,
        location: customer.location,
        facebook_name: customer.facebook_name,
        messenger_link: customer.messenger_link,
        mobile_number: customer.mobile_number,
        email: customer.email,
        notes: customer.notes,
      },
      summary: {
        total_active: activeAccounts.length,
        total_completed: completedAccounts.length,
        total_outstanding: totalOutstanding,
        accumulated_amount_spent: accumulatedAmountSpent,
        total_accounts: accountCards.length,
        next_due_date: allNextDues[0]?.next_due_date || null,
        next_due_invoice: allNextDues[0]?.invoice_number || null,
        primary_currency: accountCards[0]?.currency || 'PHP',
      },
      accounts: accountCards,
      payment_methods: paymentMethods.map((m: any) => ({
        id: m.id,
        method_name: m.method_name,
        bank_name: m.bank_name,
        account_name: m.account_name,
        account_number: m.account_number,
        instructions: m.instructions,
        qr_image_url: m.qr_image_url,
      })),
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
