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
  name: "search_customers",
  title: "Search customers",
  description:
    "Search Cha Jewels customers by full name, email, customer code, or mobile number. Returns up to 20 matches. Requires an authenticated internal user (RLS-enforced).",
  inputSchema: {
    query: z
      .string()
      .min(2)
      .describe("Partial name, email, customer code (CJ-YYYY-XXXXX), or mobile number."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ query }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const q = query.trim();
    const { data, error } = await supabase
      .from("customers")
      .select("id, customer_code, full_name, email, mobile_number, location, is_test")
      .or(
        `full_name.ilike.%${q}%,email.ilike.%${q}%,customer_code.ilike.%${q}%,mobile_number.ilike.%${q}%`,
      )
      .eq("is_test", false)
      .limit(20);

    if (error) {
      return { content: [{ type: "text", text: `Query failed: ${error.message}` }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? [], null, 2) }],
      structuredContent: { customers: data ?? [] },
    };
  },
});
