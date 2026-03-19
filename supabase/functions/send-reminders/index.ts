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

function generateEmailHtml(alerts: AlertItem[], staffName: string): string {
  const overdueAlerts = alerts.filter((a) => a.type === "overdue");
  const dueTodayAlerts = alerts.filter((a) => a.type === "due_today");
  const upcomingAlerts = alerts.filter((a) => a.type === "upcoming");

  const renderAlertRows = (items: AlertItem[], color: string) =>
    items
      .map(
        (a) =>
          `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;">${a.customer}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">INV #${a.invoice}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${new Date(a.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;color:${color};">${formatCurrency(a.amount, a.currency)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;">${a.type === "overdue" ? a.daysOverdue + " days" : "—"}</td>
      </tr>`
      )
      .join("");

  let sections = "";

  if (overdueAlerts.length > 0) {
    sections += `
      <h2 style="color:#dc2626;margin:24px 0 8px;">🚨 Overdue (${overdueAlerts.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="background:#fef2f2;">
          <th style="padding:8px;text-align:left;">Customer</th>
          <th style="padding:8px;text-align:left;">Invoice</th>
          <th style="padding:8px;text-align:left;">Due Date</th>
          <th style="padding:8px;text-align:left;">Amount</th>
          <th style="padding:8px;text-align:left;">Overdue</th>
        </tr>
        ${renderAlertRows(overdueAlerts, "#dc2626")}
      </table>`;
  }

  if (dueTodayAlerts.length > 0) {
    sections += `
      <h2 style="color:#d97706;margin:24px 0 8px;">⏰ Due Today (${dueTodayAlerts.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="background:#fffbeb;">
          <th style="padding:8px;text-align:left;">Customer</th>
          <th style="padding:8px;text-align:left;">Invoice</th>
          <th style="padding:8px;text-align:left;">Due Date</th>
          <th style="padding:8px;text-align:left;">Amount</th>
          <th style="padding:8px;text-align:left;">Overdue</th>
        </tr>
        ${renderAlertRows(dueTodayAlerts, "#d97706")}
      </table>`;
  }

  if (upcomingAlerts.length > 0) {
    sections += `
      <h2 style="color:#2563eb;margin:24px 0 8px;">📅 Upcoming (${upcomingAlerts.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr style="background:#eff6ff;">
          <th style="padding:8px;text-align:left;">Customer</th>
          <th style="padding:8px;text-align:left;">Invoice</th>
          <th style="padding:8px;text-align:left;">Due Date</th>
          <th style="padding:8px;text-align:left;">Amount</th>
          <th style="padding:8px;text-align:left;">Overdue</th>
        </tr>
        ${renderAlertRows(upcomingAlerts, "#2563eb")}
      </table>`;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#f9fafb;">
  <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="text-align:center;margin-bottom:20px;">
      <h1 style="color:#1a1a2e;margin:0;">💎 Cha Jewels</h1>
      <p style="color:#6b7280;font-size:14px;margin:4px 0;">Daily Payment Alert Summary</p>
      <p style="color:#6b7280;font-size:12px;">Hi ${staffName}, here's your daily update:</p>
    </div>
    
    <div style="display:flex;gap:16px;margin:16px 0;text-align:center;">
      <div style="flex:1;background:#fef2f2;border-radius:8px;padding:12px;">
        <p style="font-size:24px;font-weight:bold;color:#dc2626;margin:0;">${overdueAlerts.length}</p>
        <p style="font-size:11px;color:#6b7280;margin:4px 0 0;">Overdue</p>
      </div>
      <div style="flex:1;background:#fffbeb;border-radius:8px;padding:12px;">
        <p style="font-size:24px;font-weight:bold;color:#d97706;margin:0;">${dueTodayAlerts.length}</p>
        <p style="font-size:11px;color:#6b7280;margin:4px 0 0;">Due Today</p>
      </div>
      <div style="flex:1;background:#eff6ff;border-radius:8px;padding:12px;">
        <p style="font-size:24px;font-weight:bold;color:#2563eb;margin:0;">${upcomingAlerts.length}</p>
        <p style="font-size:11px;color:#6b7280;margin:4px 0 0;">Upcoming</p>
      </div>
    </div>

    ${sections}

    <p style="color:#9ca3af;font-size:11px;text-align:center;margin-top:24px;">
      Sent from Cha Jewels Layaway Management System · ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
    </p>
  </div>
</body>
</html>`;
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

    // 5. Get all staff profiles for email notifications
    const { data: profiles } = await supabase.from("profiles").select("*");
    const { data: roles } = await supabase.from("user_roles").select("*");

    const staffEmails: { email: string; name: string }[] = [];
    for (const p of profiles || []) {
      const hasRole = (roles || []).some((r: any) => r.user_id === p.user_id);
      if (hasRole && p.email) {
        staffEmails.push({ email: p.email, name: p.full_name });
      }
    }

    // 6. Log reminders
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

    // 7. Send email to each staff member (if email infra is available)
    let emailsSent = 0;
    const emailHtml = generateEmailHtml(alerts, "Team");

    // Try sending via Lovable email API if available
    const lovableApiKey = Deno.env.get("LOVABLE_API_KEY");
    if (lovableApiKey && staffEmails.length > 0) {
      for (const staff of staffEmails) {
        try {
          const personalHtml = generateEmailHtml(alerts, staff.name);
          // Use Supabase Edge Function invocation for email
          const emailResponse = await fetch(`${supabaseUrl}/functions/v1/send-notification-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${serviceRoleKey}`,
            },
            body: JSON.stringify({
              to: staff.email,
              subject: `💎 Cha Jewels Daily Alert — ${alerts.filter((a) => a.type === "overdue").length} Overdue, ${alerts.filter((a) => a.type === "due_today").length} Due Today`,
              html: personalHtml,
            }),
          });
          if (emailResponse.ok) emailsSent++;
        } catch (e) {
          console.error(`Failed to send email to ${staff.email}:`, e);
        }
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
          staffNotified: staffEmails.length,
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
