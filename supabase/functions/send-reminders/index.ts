import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface AlertItem {
  type: "overdue" | "due_today" | "upcoming";
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
}

function formatCurrency(amount: number, currency: string): string {
  const symbol = currency === "PHP" ? "₱" : "¥";
  return `${symbol} ${Math.round(amount).toLocaleString("en-US")}`;
}

function generateMessengerMessage(alert: AlertItem): string {
  const dueStr = new Date(alert.dueDate).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  if (alert.type === "overdue") {
    return `Hi ${alert.customer}! 👋\n\nThis is a friendly reminder from Cha Jewels that your layaway payment for INV #${alert.invoice} was due on ${dueStr} (${alert.daysOverdue} days ago).\n\nRemaining amount due: ${formatCurrency(alert.amount, alert.currency)}\n\nPlease settle at your earliest convenience to avoid additional penalties. Thank you! 💎`;
  } else if (alert.type === "due_today") {
    return `Hi ${alert.customer}! 👋\n\nJust a reminder from Cha Jewels — your layaway payment for INV #${alert.invoice} is due today!\n\nAmount due: ${formatCurrency(alert.amount, alert.currency)}\n\nThank you for your prompt payment! 💎`;
  } else {
    return `Hi ${alert.customer}! 👋\n\nThis is a friendly heads-up from Cha Jewels — your next layaway payment for INV #${alert.invoice} is coming up on ${dueStr}.\n\nAmount due: ${formatCurrency(alert.amount, alert.currency)}\n\nThank you for staying on track! 💎`;
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

    // 2. Get pending/overdue schedule items within 7 days
    const today = new Date().toISOString().split("T")[0];
    const next7 = new Date();
    next7.setDate(next7.getDate() + 7);
    const next7Str = next7.toISOString().split("T")[0];

    const { data: scheduleItems, error: schedErr } = await supabase
      .from("layaway_schedule")
      .select("*")
      .in("account_id", accountIds)
      .in("status", ["pending", "overdue", "partially_paid"])
      .lte("due_date", next7Str)
      .order("due_date", { ascending: true });
    if (schedErr) throw schedErr;

    // 3. Build alert items
    const accountMap = new Map((accounts || []).map((a: any) => [a.id, a]));
    const alerts: AlertItem[] = (scheduleItems || [])
      .map((s: any) => {
        const acc = accountMap.get(s.account_id);
        if (!acc) return null;
        const diffMs = new Date(today).getTime() - new Date(s.due_date).getTime();
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        let type: AlertItem["type"] = "upcoming";
        if (diffDays > 0) type = "overdue";
        else if (diffDays === 0) type = "due_today";

        return {
          type,
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
        } as AlertItem;
      })
      .filter(Boolean) as AlertItem[];

    if (alerts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No alerts to send", alerts: [], messengerMessages: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // 4. Generate Messenger messages for each alert
    const messengerMessages = alerts.map((a) => ({
      customer: a.customer,
      invoice: a.invoice,
      type: a.type,
      messengerLink: a.messengerLink,
      message: generateMessengerMessage(a),
    }));

    // 5. Log reminders
    const reminderLogs = alerts.map((a) => ({
      account_id: a.accountId,
      schedule_id: a.scheduleId,
      customer_id: a.customerId,
      channel: "system",
      template_type: a.type,
      message_body: generateMessengerMessage(a),
      delivery_status: "generated",
    }));

    if (reminderLogs.length > 0) {
      await supabase.from("reminder_logs").insert(reminderLogs);
    }

    // 6. Send per-customer emails via transactional email system
    let emailsSent = 0;
    let emailsFailed = 0;
    const emailAlerts = alerts.filter((a) => a.customerEmail);

    // Deduplicate: one email per customer+invoice (avoid sending multiple for same account)
    const sentKeys = new Set<string>();

    for (const alert of emailAlerts) {
      const key = `${alert.customerId}-${alert.invoice}`;
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
            idempotencyKey: `reminder-${alert.scheduleId}-${today}`,
            templateData: {
              customerName: alert.customer,
              invoiceNumber: alert.invoice,
              dueDate: dueStr,
              amountDue: Math.round(alert.amount).toLocaleString("en-US"),
              currency: alert.currency,
              type: alert.type,
              daysOverdue: alert.daysOverdue,
            },
          },
        });
        if (error) {
          console.error(`Email failed for ${alert.customer}:`, error);
          emailsFailed++;
        } else {
          emailsSent++;
          // Update reminder log for this alert
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

      // Small delay between sends to avoid rate limits
      if (emailAlerts.length > 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        summary: {
          overdue: alerts.filter((a) => a.type === "overdue").length,
          dueToday: alerts.filter((a) => a.type === "due_today").length,
          upcoming: alerts.filter((a) => a.type === "upcoming").length,
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
