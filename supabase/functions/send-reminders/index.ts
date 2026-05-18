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
  if (daysOverdue >= 7 || hasPenalties) return "penalty";
  if (daysOverdue >= 1 && daysOverdue <= 6) return "overdue";
  if (daysOverdue === 0) return "due_today";
  if (daysOverdue === -3) return "due_3_days";
  if (daysOverdue === -7) return "due_7_days";
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

// Helper: retry fetch on Deno runtime rate limit (RateLimitError)
// Bug #110 fix (2026-05-18): Supabase Edge Function outbound fetch is rate-limited
// per-invocation; without retry, due_today alerts (positional 31-35 in iteration)
// consistently failed since the rate limit window kicks in mid-batch.
async function fetchWithRetryOnRateLimit(
  url: string,
  init: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      const isRateLimit =
        e && typeof e === 'object' && 'name' in e &&
        (e as { name: string }).name === 'RateLimitError';
      if (!isRateLimit || attempt >= maxRetries) {
        throw e;
      }
      const retryAfterMs =
        typeof (e as { retryAfterMs?: number }).retryAfterMs === 'number'
          ? (e as { retryAfterMs: number }).retryAfterMs
          : 200;
      console.warn(
        `Rate limited at fetch, retry after ${retryAfterMs + 50}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise((r) => setTimeout(r, retryAfterMs + 50));
    }
  }
  throw new Error('fetchWithRetryOnRateLimit: exhausted retries unexpectedly');
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const today = new Date().toISOString().split("T")[0];

    // Use RPC or direct query to avoid .in() with hundreds of IDs
    // Fetch schedule items with their account and customer data in one go
    // Only get the EARLIEST unpaid installment per account to avoid flooding
    const { data: rawItems, error: queryErr } = await supabase
      .from("layaway_schedule")
      .select("id, due_date, total_due_amount, paid_amount, status, account_id, layaway_accounts!inner(id, invoice_number, currency, customer_id, status, customers!inner(id, full_name, email, messenger_link))")
      .in("status", ["pending", "overdue", "partially_paid"])
      .in("layaway_accounts.status", ["active", "overdue"])
      .order("due_date", { ascending: true })
      .limit(1000);

    if (queryErr) throw queryErr;

    // Get all unpaid penalty fees to identify penalty-stage items
    const { data: penaltyFees } = await supabase
      .from("penalty_fees")
      .select("schedule_id")
      .eq("status", "unpaid");

    const scheduleIdsWithPenalties = new Set(
      (penaltyFees || []).map((p: any) => p.schedule_id)
    );

    // Deduplicate: only take earliest unpaid installment per account
    const seenAccounts = new Set<string>();
    const alerts: AlertItem[] = [];

    for (const s of (rawItems || [])) {
      const acc = (s as any).layaway_accounts;
      if (!acc) continue;
      
      // One alert per account (earliest unpaid installment)
      if (seenAccounts.has(acc.id)) continue;

      const diffMs = new Date(today).getTime() - new Date(s.due_date).getTime();
      const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
      const hasPenalties = scheduleIdsWithPenalties.has(s.id);

      const stage = classifyAlert(diffDays, hasPenalties);
      if (!stage) continue;

      seenAccounts.add(acc.id);

      const cust = acc.customers;
      alerts.push({
        stage,
        customer: cust?.full_name || "Unknown",
        invoice: acc.invoice_number,
        dueDate: s.due_date,
        amount: Number(s.total_due_amount) - Number(s.paid_amount),
        currency: acc.currency,
        daysOverdue: diffDays,
        accountId: acc.id,
        messengerLink: cust?.messenger_link,
        customerId: acc.customer_id,
        scheduleId: s.id,
        customerEmail: cust?.email,
        hasPenalties,
      });
    }

    if (alerts.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: "No alerts matching trigger stages", alerts: [], messengerMessages: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate Messenger messages
    const messengerMessages = alerts.map((a) => ({
      customer: a.customer,
      invoice: a.invoice,
      stage: a.stage,
      messengerLink: a.messengerLink,
      message: generateMessengerMessage(a),
    }));

    // Log reminders
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

    // Send per-customer emails (deduplicated by customer+invoice+stage)
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

      // Grace period takes priority: due 1-7 days ago AND no unpaid penalties
      // for this schedule row. Sends payment-reminder with type=grace_period.
      const isGracePeriod =
        alert.daysOverdue >= 1 && alert.daysOverdue <= 7 && !alert.hasPenalties;

      try {
        if (isGracePeriod) {
          const dueDateObj = new Date(alert.dueDate + "T00:00:00Z");
          const graceEndObj = new Date(dueDateObj.getTime() + 7 * 86_400_000);
          const graceEndStr = graceEndObj.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
          const graceRes = await fetchWithRetryOnRateLimit(`${supabaseUrl}/functions/v1/send-transactional-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${serviceRoleKey}`,
            },
            body: JSON.stringify({
              templateName: "payment-reminder",
              recipientEmail: alert.customerEmail,
              idempotencyKey: `grace-period-${alert.scheduleId}-${today}`,
              templateData: {
                customerName: alert.customer,
                invoiceNumber: alert.invoice,
                dueDate: dueStr,
                amountDue: Math.round(alert.amount).toLocaleString("en-US"),
                currency: alert.currency,
                type: "grace_period",
                graceEndDate: graceEndStr,
                portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${alert.invoice}`,
              },
            }),
          });
          const graceBody = await graceRes.text();
          if (!graceRes.ok) {
            console.error(`Grace-period email failed for ${alert.customer}: ${graceRes.status} ${graceBody}`);
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
          if (emailAlerts.length > 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
          continue;
        }

        const emailRes = await fetchWithRetryOnRateLimit(`${supabaseUrl}/functions/v1/send-transactional-email`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceRoleKey}`,
          },
          body: JSON.stringify({
            templateName: "payment-reminder",
            recipientEmail: alert.customerEmail,
            idempotencyKey: `reminder-${alert.scheduleId}-${alert.stage}-${today}`,
            templateData: {
              customerName: alert.customer,
              invoiceNumber: alert.invoice,
              dueDate: dueStr,
              amountDue: Math.round(alert.amount).toLocaleString("en-US"),
              currency: alert.currency,
              type: alert.stage === 'overdue' || alert.stage === 'penalty' ? 'overdue'
                    : alert.stage === 'due_today' ? 'due_today'
                    : 'upcoming',
              daysOverdue: alert.daysOverdue,
              portalUrl: `https://portal.chajewelsjp.com/portal?invoice=${alert.invoice}`,
            },
          }),
        });
        const emailBody = await emailRes.text();
        if (!emailRes.ok) {
          console.error(`Email failed for ${alert.customer}: ${emailRes.status} ${emailBody}`);
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

    // Build summary
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
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
