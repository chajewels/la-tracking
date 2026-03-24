import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type ReminderStage = "due_7_days" | "due_3_days" | "due_today" | "overdue" | "penalty";

interface AlertItem {
  stage: ReminderStage;
  customer: string;
  invoice: string;
  dueDate: string;
  amount: number;
  currency: string;
  daysOverdue: number;
  accountId: string;
  messengerLink?: string | null;
  customerId: string;
  scheduleId: string;
  customerEmail?: string | null;
  hasPenalties?: boolean;
}

function formatCurrency(amount: number, currency: string): string {
  const symbol = currency === "PHP" ? "₱" : "¥";
  return `${symbol} ${Math.round(amount).toLocaleString("en-US")}`;
}

function classifyAlert(daysOverdue: number, hasPenalties: boolean): ReminderStage | null {
  // daysOverdue > 0 means past due, < 0 means upcoming
  if (daysOverdue >= 7 || hasPenalties) return "penalty";
  if (daysOverdue >= 1 && daysOverdue <= 6) return "overdue";
  if (daysOverdue === 0) return "due_today";
  if (daysOverdue === -3) return "due_3_days";
  if (daysOverdue === -7) return "due_7_days";
  // Any other day (e.g., -1, -2, -4, -5, -6) → no email
  return null;
}

function generateMessengerMessage(alert: AlertItem): string {
  const dueStr = new Date(alert.dueDate).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  switch (alert.stage) {
    case "penalty":
      return `Hi ${alert.customer}! 👋\n\nThis is an urgent reminder from Cha Jewels. Your layaway payment for INV #${alert.invoice} is now ${alert.daysOverdue} days overdue and has incurred penalty fees.\n\nRemaining amount due: ${formatCurrency(alert.amount, alert.currency)}\n\nPlease settle immediately to avoid further penalties. Thank you! 💎`;
    case "overdue":
      return `Hi ${alert.customer}! 👋\n\nThis is a friendly reminder from Cha Jewels that your layaway payment for INV #${alert.invoice} was due on ${dueStr} (${alert.daysOverdue} day${alert.daysOverdue > 1 ? "s" : ""} ago).\n\nRemaining amount due: ${formatCurrency(alert.amount, alert.currency)}\n\nYou are still within the grace period. Please settle to avoid penalties. Thank you! 💎`;
    case "due_today":
      return `Hi ${alert.customer}! 👋\n\nJust a reminder from Cha Jewels — your layaway payment for INV #${alert.invoice} is due today!\n\nAmount due: ${formatCurrency(alert.amount, alert.currency)}\n\nThank you for your prompt payment! 💎`;
    case "due_3_days":
      return `Hi ${alert.customer}! 👋\n\nThis is a friendly heads-up from Cha Jewels — your layaway payment for INV #${alert.invoice} is due in 3 days (${dueStr}).\n\nAmount due: ${formatCurrency(alert.amount, alert.currency)}\n\nThank you for staying on track! 💎`;
    case "due_7_days":
      return `Hi ${alert.customer}! 👋\n\nThis is an early reminder from Cha Jewels — your layaway payment for INV #${alert.invoice} is coming up on ${dueStr} (7 days from now).\n\nAmount due: ${formatCurrency(alert.amount, alert.currency)}\n\nThank you for staying on track! 💎`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // 1. Get active/overdue accounts with customer info
    const { data: accounts, error: acctErr } = await supabase
      .from("layaway_accounts")
      .select("*, customers(*)")
      .in("status", ["active", "overdue"]);
    if (acctErr) throw acctErr;

    const accountIds = (accounts || []).map((a: any) => a.id);
    if (accountIds.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No active accounts", alerts: [], messengerMessages: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 2. Get unpaid schedule items (no date ceiling — penalty items can be far overdue)
    const { data: scheduleItems, error: schedErr } = await supabase
      .from("layaway_schedule")
      .select("*")
      .in("account_id", accountIds)
      .in("status", ["pending", "overdue", "partially_paid"])
      .order("due_date", { ascending: true });
    if (schedErr) throw schedErr;

    // 3. Get penalty fees to identify accounts with active penalties
    const { data: penaltyFees } = await supabase
      .from("penalty_fees")
      .select("schedule_id, status")
      .in("account_id", accountIds)
      .eq("status", "unpaid");

    const scheduleIdsWithPenalties = new Set(
      (penaltyFees || []).map((p: any) => p.schedule_id)
    );

    // 4. Build alert items — only for the 5 allowed stages
    const today = new Date().toISOString().split("T")[0];
    const accountMap = new Map((accounts || []).map((a: any) => [a.id, a]));
    const alerts: AlertItem[] = [];

    for (const s of (scheduleItems || [])) {
      const acc = accountMap.get(s.account_id);
      if (!acc) continue;

      const diffMs = new Date(today).getTime() - new Date(s.due_date).getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      const hasPenalties = scheduleIdsWithPenalties.has(s.id);

      const stage = classifyAlert(diffDays, hasPenalties);
      if (!stage) continue; // Skip days that don't match any trigger stage

      alerts.push({
        stage,
        customer: acc.customers?.full_name || "Unknown",
        invoice: acc.invoice_number,
        dueDate: s.due_date,
        amount: Number(s.total_due_amount) - Number(s.paid_amount),
        currency: acc.currency,
        daysOverdue: diffDays,
        accountId: acc.id,
        messengerLink: acc.customers?.messenger_link,
        customerId: acc.customer_id,
        scheduleId: s.id,
        customerEmail: acc.customers?.email,
        hasPenalties,
      });
    }

    if (alerts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No alerts to send", alerts: [], messengerMessages: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 5. Generate Messenger messages
    const messengerMessages = alerts.map((a) => ({
      customer: a.customer,
      invoice: a.invoice,
      stage: a.stage,
      messengerLink: a.messengerLink,
      message: generateMessengerMessage(a),
    }));

    // 6. Log reminders
    const reminderLogs = alerts.map((a) => ({
      account_id: a.accountId,
      schedule_id: a.scheduleId,
      customer_id: a.customerId,
      channel: "system",
      template_type: a.stage,
      message_body: generateMessengerMessage(a),
      delivery_status: "generated",
    }));

    if (reminderLogs.length > 0) {
      await supabase.from("reminder_logs").insert(reminderLogs);
    }

    // 7. Send per-customer emails
    let emailsSent = 0;
    let emailsFailed = 0;
    const emailAlerts = alerts.filter((a) => a.customerEmail);
    const sentKeys = new Set<string>();

    for (const alert of emailAlerts) {
      const key = `${alert.customerId}-${alert.invoice}-${alert.stage}`;
      if (sentKeys.has(key)) continue;
      sentKeys.add(key);

      const dueStr = new Date(alert.dueDate).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });

      try {
        const { error } = await supabase.functions.invoke("send-transactional-email", {
          body: {
            templateName: "payment-reminder",
            recipientEmail: alert.customerEmail,
            idempotencyKey: `reminder-${alert.scheduleId}-${alert.stage}-${today}`,
            templateData: {
              customerName: alert.customer,
              invoiceNumber: alert.invoice,
              dueDate: dueStr,
              amountDue: Math.round(alert.amount).toLocaleString("en-US"),
              currency: alert.currency,
              stage: alert.stage,
              daysOverdue: alert.daysOverdue,
            },
          },
        });
        if (error) {
          console.error(`Email failed for ${alert.customer}:`, error);
          emailsFailed++;
        } else {
          emailsSent++;
          await supabase
            .from("reminder_logs")
            .update({ channel: "email", delivery_status: "sent", recipient: alert.customerEmail })
            .eq("schedule_id", alert.scheduleId)
            .eq("customer_id", alert.customerId)
            .order("created_at", { ascending: false })
            .limit(1);
        }
      } catch (e) {
        console.error(`Email exception for ${alert.customer}:`, e);
        emailsFailed++;
      }

      if (emailAlerts.length > 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    // 8. Build summary
    const summary: Record<string, number> = { due_7_days: 0, due_3_days: 0, due_today: 0, overdue: 0, penalty: 0 };
    for (const a of alerts) summary[a.stage]++;

    return new Response(
      JSON.stringify({
        success: true,
        summary: {
          ...summary,
          totalAlerts: alerts.length,
          emailsSent,
          emailsFailed,
          customersWithEmail: emailAlerts.length,
        },
        alerts,
        messengerMessages,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("send-reminders error:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
