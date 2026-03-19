import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * Restructure an overdue layaway account.
 * Auto-extends a 6-month plan to 8 months (or custom) when the account
 * is 6+ months past due from the original end date.
 *
 * Can be called manually or triggered from the penalty engine.
 *
 * Body: { account_id: string, preview_only?: boolean }
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Auth check
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { account_id, preview_only } = body;

    if (!account_id) {
      return new Response(
        JSON.stringify({ error: "account_id is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Fetch account
    const { data: account, error: accErr } = await supabase
      .from("layaway_accounts")
      .select("*")
      .eq("id", account_id)
      .single();

    if (accErr || !account) {
      return new Response(JSON.stringify({ error: "Account not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (account.status !== "overdue") {
      return new Response(
        JSON.stringify({ error: "Account is not overdue" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Check if 6 months past end_date
    const endDate = account.end_date
      ? new Date(account.end_date)
      : null;
    const now = new Date();

    if (!endDate) {
      return new Response(
        JSON.stringify({ error: "Account has no end_date set" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const monthsPastDue = (now.getFullYear() - endDate.getFullYear()) * 12 +
      (now.getMonth() - endDate.getMonth());

    if (monthsPastDue < 6) {
      return new Response(
        JSON.stringify({
          error: "Account is not yet 6 months past due",
          months_past_due: monthsPastDue,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Get current schedule
    const { data: schedule } = await supabase
      .from("layaway_schedule")
      .select("*")
      .eq("account_id", account_id)
      .order("installment_number", { ascending: true });

    if (!schedule) {
      return new Response(
        JSON.stringify({ error: "Schedule not found" }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Calculate extension: add 2 more months
    const currentMonths = account.payment_plan_months;
    const newMonths = currentMonths + 2;
    const remainingBalance = Number(account.remaining_balance);

    // Determine the order day from the original order_date
    const orderDate = new Date(account.order_date);
    const orderDay = orderDate.getDate();

    // Find the last paid installment to determine where to start new schedule
    const paidInstallments = schedule.filter(
      (s) => s.status === "paid"
    );
    const unpaidInstallments = schedule.filter(
      (s) => s.status !== "paid"
    );
    const nextInstallmentNumber = paidInstallments.length + 1;

    // Calculate new per-month amount for remaining unpaid months
    // Total unpaid months = newMonths - paidInstallments.length
    const unpaidMonthsCount = newMonths - paidInstallments.length;
    const perMonth = Math.floor(remainingBalance / unpaidMonthsCount);
    const remainder = remainingBalance - perMonth * unpaidMonthsCount;

    // Generate new schedule entries
    // Start from the month after the last paid installment
    const lastPaidDate = paidInstallments.length > 0
      ? new Date(paidInstallments[paidInstallments.length - 1].due_date)
      : orderDate;

    const newScheduleItems: Array<{
      installment_number: number;
      due_date: string;
      base_installment_amount: number;
      total_due_amount: number;
    }> = [];

    for (let i = 0; i < unpaidMonthsCount; i++) {
      const isLast = i === unpaidMonthsCount - 1;
      const amount = isLast ? perMonth + remainder : perMonth;

      // Calculate due date
      const dueDate = new Date(lastPaidDate);
      dueDate.setMonth(dueDate.getMonth() + i + 1);
      // Maintain same day of month
      dueDate.setDate(Math.min(orderDay, new Date(dueDate.getFullYear(), dueDate.getMonth() + 1, 0).getDate()));

      newScheduleItems.push({
        installment_number: nextInstallmentNumber + i,
        due_date: dueDate.toISOString().split("T")[0],
        base_installment_amount: amount,
        total_due_amount: amount,
      });
    }

    // Calculate new end date
    const newEndDate = newScheduleItems[newScheduleItems.length - 1]?.due_date;

    if (preview_only) {
      return new Response(
        JSON.stringify({
          preview: true,
          current_months: currentMonths,
          new_months: newMonths,
          remaining_balance: remainingBalance,
          per_month: perMonth,
          remainder_on_last: remainder,
          new_end_date: newEndDate,
          new_schedule: newScheduleItems,
          unpaid_installments_to_remove: unpaidInstallments.length,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Delete unpaid installments (cancel them)
    for (const item of unpaidInstallments) {
      await supabase
        .from("layaway_schedule")
        .update({ status: "cancelled" })
        .eq("id", item.id);
    }

    // Insert new schedule items
    for (const item of newScheduleItems) {
      await supabase.from("layaway_schedule").insert({
        account_id,
        installment_number: item.installment_number,
        due_date: item.due_date,
        base_installment_amount: item.base_installment_amount,
        total_due_amount: item.total_due_amount,
        paid_amount: 0,
        currency: account.currency,
        status: "pending",
      });
    }

    // Update account
    await supabase
      .from("layaway_accounts")
      .update({
        payment_plan_months: newMonths,
        end_date: newEndDate,
      })
      .eq("id", account_id);

    // Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "account",
      entity_id: account_id,
      action: "restructure",
      old_value_json: {
        payment_plan_months: currentMonths,
        end_date: account.end_date,
      },
      new_value_json: {
        payment_plan_months: newMonths,
        end_date: newEndDate,
        reason: "6_month_overdue_auto_extension",
      },
      performed_by_user_id: user.id,
    });

    return new Response(
      JSON.stringify({
        success: true,
        old_months: currentMonths,
        new_months: newMonths,
        new_end_date: newEndDate,
        new_schedule_count: newScheduleItems.length,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
