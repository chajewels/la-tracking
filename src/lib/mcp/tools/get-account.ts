import { createClient } from "@supabase/supabase-js";
import { defineTool, type ToolContext } from "@lovable.dev/mcp-js";
import { z } from "zod";

function supabaseForUser(ctx: ToolContext) {
  return createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export default defineTool({
  name: "get_account_by_invoice",
  title: "Get layaway account by invoice",
  description:
    "Look up a layaway account by its numeric invoice number. Returns account totals, status, customer, and current payment schedule. Requires an authenticated internal user (RLS-enforced).",
  inputSchema: {
    invoice_number: z
      .string()
      .min(1)
      .describe("Invoice number (numeric string, e.g. '19115')."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ invoice_number }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);

    const { data: account, error } = await supabase
      .from("layaway_accounts")
      .select(
        "id, invoice_number, status, currency, total_amount, total_paid, remaining_balance, downpayment_amount, payment_plan_months, order_date, is_trade, customer:customers(id, customer_code, full_name, email, mobile_number)",
      )
      .eq("invoice_number", invoice_number.trim())
      .maybeSingle();

    if (error) {
      return { content: [{ type: "text", text: `Query failed: ${error.message}` }], isError: true };
    }
    if (!account) {
      return {
        content: [{ type: "text", text: `No account found for invoice ${invoice_number}` }],
      };
    }

    const { data: schedule } = await supabase
      .from("layaway_schedule")
      .select("installment_number, due_date, base_installment_amount, penalty_amount, carried_amount, paid_amount, total_due_amount, status")
      .eq("account_id", account.id)
      .order("installment_number", { ascending: true });

    const result = { account, schedule: schedule ?? [] };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
});
