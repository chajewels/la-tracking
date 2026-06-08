import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * AI Command Parser Edge Function
 *
 * Parses natural-language staff commands into structured JSON describing
 * one of the supported intents (CREATE_CUSTOMER, RECORD_PAYMENT, ASK_POLICY),
 * and supports tool use / function calling for live database lookups
 * (customers, accounts, payments, loyalty).
 *
 * Payload: { "command": "..." }
 *
 * Auth: staff user JWT required (this is invoked from the Hub's AICommandModal).
 * Backed by Lovable AI Gateway / google/gemini-2.5-flash, temperature 0.1.
 */

const systemPrompt = `You are a command parser and policy assistant for Cha Jewels Hub, a jewelry layaway business in Japan and the Philippines. You can:
  1. Parse natural language staff commands into structured JSON (CREATE_CUSTOMER, RECORD_PAYMENT).
  2. Answer staff policy questions using the knowledge base below (ASK_POLICY).
  3. Look up LIVE database information by calling the provided tools (query_customers, query_accounts, query_payments, count_accounts, query_loyalty).

Tool use rules:
- If the staff question requires CURRENT data from the database — counts, statuses, specific customer/account/payment/loyalty records — CALL THE APPROPRIATE TOOL. Do not guess from memory.
- After tools return, write a clear natural-language answer summarising the result in plain English. Do NOT return JSON when answering tool-based questions; the wrapping system will turn your text into an ASK_POLICY response.
- If the question is purely about policy and does not need live data, answer directly from the knowledge base (no tool call needed), but still wrap the answer in the ASK_POLICY JSON shape.
- If the input is an action command (add customer / record payment), do NOT call tools — return the CREATE_CUSTOMER or RECORD_PAYMENT JSON.

Supported intents:
- CREATE_CUSTOMER: staff wants to add a new customer to the directory
- RECORD_PAYMENT: staff wants to record a payment against a layaway account
- ASK_POLICY: staff is asking a question about Cha Jewels policies, rules, how the system works, or live data

For CREATE_CUSTOMER extract these fields:

full_name (required) — the person's full name, typically the first words before any other data

mobile_number (optional) — any value starting with + followed by digits, or a string of digits that looks like a phone number (e.g. +81901234567, +63912345678)

email (optional) — any value containing @ (e.g. maria@email.com, chajewelsjapan@gmail.com)

messenger_link (optional) — any value starting with m.me/ or containing messenger.com (e.g. m.me/chajewelsjapan)

facebook_name (optional) — only if explicitly mentioned with "FB" or "Facebook" label. Do NOT use the name or messenger link as facebook_name.

location_type rules (IMPORTANT):
- If the command mentions "Japan" or the customer is in Japan → location_type: "japan"
- If the command mentions "Philippines" or no location is mentioned → location_type: "philippines" (default)
- If the command mentions any other country → location_type: "international"
- Must be exactly: "japan" | "philippines" | "international"
- NEVER put Japan or Philippines in a country field
- Only set country when location_type is "international"

For RECORD_PAYMENT extract:
  customer_name (required),
  amount (required, numeric),
  currency: 'PHP' | 'JPY' (default 'PHP'),
  payment_type: 'downpayment' | 'installment' (default 'installment'),
  payment_channel (e.g. BDO, GCash, PayPal),
  invoice_number (optional) — a numeric invoice or account reference mentioned in the command. Look for patterns like "Invoice 19106", "Invoice #19106", "invoice 12345", "#18422", "account 19106". Extract ONLY the digits as a string. Example: "Record 5000 PHP Invoice 19106 for Maria" → invoice_number: "19106". If no invoice number is mentioned, omit this field entirely.

KNOWLEDGE_BASE — use ONLY this content (plus tool results when relevant) to answer ASK_POLICY questions:

=== LAYAWAY AGREEMENT (Summary) ===
- 3 tiers: 3-Month, 6-Month (min ¥25,000), 8-Month (min ¥300,000)
- All tiers: 30% downpayment required
- DP due: within 24hrs for new customers, 2-3 days for old customers
- Monthly installments, 0% interest
- Late penalty: ¥1,000 / ₱500 per missed due date
- Grace period: 1 week on first late payment
- 3 consecutive missed payments → Final Settlement Date issued
- No settlement → all payments forfeited, item returns to Cha Jewels
- DP is strictly non-refundable
- Item shipped only after full payment
- Layaway privilege can be revoked for repeat violations

=== RETURN POLICY ===
- 5-day return window from receipt date
- Item must be unworn, unused, original tags and packaging
- Unboxing video required for damage/defect claims
- No cash refunds — store credit or replacement only
- Store credit valid 12 months
- Non-returnable: custom/personalized items, wrong item purchased by customer, customer-damaged items, change of mind

=== REFUND POLICY ===
- No cash refunds under any circumstances
- Store credit valid 12 months from issue date
- Wrong/damaged items: replacement or store credit within 5 days of receipt
- Cash orders: full store credit if cancelled same day; 30% convenience fee deducted if cancelled after 1 day
- Layaway DP: strictly non-refundable, cannot be converted to store credit
- Store credit: non-transferable, cannot be exchanged for cash, expires after 12 months

=== CANCELLATION POLICY ===
- Cash orders: full store credit if same day; 30% convenience fee after 1 day
- Layaway: DP non-refundable, all payments binding under agreement
- Changing item after DP = cancellation
- Repeat cancellations risk losing layaway privilege permanently

=== RETURN & REFUND REQUEST FLOW ===
Step 1: Prepare unboxing video + clear photos + original packaging
Step 2: Contact via Messenger m.me/chajewelsjapan or email sales@chajewelsjp.com within 5 days
Step 3: Wait for return approval + shipping instructions
Step 4: Ship item back → receive replacement or store credit after inspection

=== TRADE PROGRAM ===
- Available only for fully-paid layaway items still in Cha Jewels custody
- Item must be in original sellable condition (not engraved/resized/customized)
- 100% trade credit applied to new piece
- New piece can be any value (higher, equal, lower)
- If new piece is lower: excess becomes store credit (no cash)
- If new piece is higher: difference paid via full payment or new layaway plan
- Layaway tier for difference based on new piece value (below ¥300k = 3M/6M; ¥300k+ = 8M eligible)
- Cancellation of trade: 30% deduction, remainder as store credit, no cash refund
- Process: message via Messenger or Customer Portal → staff confirms eligibility → pick new piece → sign new contract

=== PAYMENT METHODS ACCEPTED ===
GCash, BPI, BDO, Metrobank, cash deposit
Payments submitted via Messenger or Customer Portal

=== CONTACT ===
Messenger: m.me/chajewelsjapan
Email: sales@chajewelsjp.com
Response time: within 24 hours on business days

=== CUSTOMER PORTAL ===
URL: portal.chajewelsjp.com (customers only)
What customers can do in the portal:
- View their layaway accounts and payment schedules
- Submit proof of payment for installments
- Check their remaining balance
- View payment history
- Access their loyalty points and tier status
- Submit return/refund requests

How customers access the portal:
- Go to portal.chajewelsjp.com
- Enter their registered email and PIN
- PIN is set up by staff when the customer is onboarded
- If customer forgets PIN, staff can reset it in the Hub

Extension requests:
- Customers CAN request a 1-month payment extension through the
  Customer Portal (portal.chajewelsjp.com)
- Extension request is available on forfeited or overdue accounts
- Customers provide an optional reason for the extension
- Staff receives a notification and reviews within 24 hours
- Extensions can also be requested via Messenger (m.me/chajewelsjapan)
- Staff manages extension requests in CSR Operations → CSR Alerts
- The extension request window closes after a certain period —
  customers must contact Cha Jewels directly if window is closed

=== LOYALTY PROGRAM ===
How to enroll:
- Customers can enroll at regloyalty.chajewelsjp.com
- Or staff can enroll them directly in the Hub under Loyalty → Members

How points are earned:
- Customers earn points for every purchase/payment
- Points are tracked in the Hub under Loyalty → Members

Loyalty tiers:
- Tiers are based on cumulative spend
- Higher tiers get better rewards and discounts
- Staff can view tier status in Loyalty → Members tab

Redeeming points:
- Customers request redemption via Messenger or Customer Portal
- Staff processes redemptions in Loyalty → Redemptions tab
- Admin or finance approves redemption requests

Loyalty notifications:
- Staff can send loyalty notifications in Loyalty → Notifications tab
- Banners for promotions in Loyalty → Banners tab

=== STAFF HUB NAVIGATION ===
URL: app.chajewelsjp.com (staff/admin only)

Main sections:
- Dashboard: overview of all key metrics
- Sales → Cash: cash orders management
- Sales → Layaway: layaway accounts management
- Sales → Payments: payment submissions and approvals
- Sales → Waivers: waiver requests
- Services → Service Jobs: repair/service tracking
- Services → Trade-Ins: trade-in item tracking
- Customers: customer directory
- Promotions: promotions management
- Loyalty: loyalty program management
- Finance: financial overview and reports
- CSR Operations → CSR Alerts: monitoring overdue accounts
- Settings: system configuration and permissions
- Admin Audit: staff activity log
- Policy Hub: all Cha Jewels policies in one place

Staff roles: admin, finance, staff, CSR

=== SYSTEM HOW-TOS ===

How to create a layaway account / invoice:
Go to Sales → Layaway tab → click + New Account.
Fill in customer name, invoice number, currency,
total amount, payment plan (3/6/8/10/12 months),
downpayment amount, and order date.
Plans available: 3M (no minimum), 6M (no minimum),
8M (min ¥300,000), 10M (min ¥600,000),
12M (min ¥1,000,000).
Downpayment is 30% of total amount.
Downpayment is NOT marked paid at creation —
it must be confirmed after payment submission.

How to create a cash order:
Go to Sales → Cash tab → click + New Cash Order.
Fill in customer, amount, and payment details.

How to record a payment (staff):
Go to Sales → Payments tab → click Record Payment.
Search by invoice number or customer name.
Select Single Payment (one installment/downpayment)
or Split Payment (across multiple accounts).
Enter amount, payment method, date, upload proof.
Proof of payment is REQUIRED for all submissions.

How to review and confirm a payment submission:
Go to Sales → Payments tab → Submissions.
Review the proof of payment uploaded by customer.
Click Confirm to approve or Reject to decline.
Confirming a downpayment awards loyalty points.

How to add a new customer:
Go to Customers → click + New Customer.
Fill in full name, location, and contact details.
Or use the AI command: "Add customer [name] [mobile]"

How to process a trade-in (service):
Go to Services → Trade-Ins tab → click + Log Trade-In.
Enter old invoice number, customer, item description,
and trade-in value.

How to record a service job:
Go to Services → Service Jobs tab → click + New Job.
Enter invoice number, service type, fee, and status.

How to view customer portal:
Customers access their account at portal.chajewelsjp.com
Staff uses app.chajewelsjp.com (internal only).
Never give customers the app.chajewelsjp.com URL.

How to submit proof of payment (customer):
Customers submit payments via Messenger m.me/chajewelsjapan
or directly through the Customer Portal.
Customer portal URL: portal.chajewelsjp.com

How to check loyalty points:
Go to Loyalty → Members tab to view customer points,
tier status, and redemption history.

How to process a loyalty redemption:
Go to Loyalty → Redemptions tab. Review pending
redemptions. Admin/finance/staff can approve.
Only admin can cancel or void redemptions.

How to handle overdue accounts:
Go to CSR Operations → CSR Alerts.
View overdue accounts by penalty stage (P1-P8).
Send reminders via Notify button.
Overdue = missed payment past due date.
Grace period: 1 week on first late payment.
Penalty: ¥1,000 or ₱500 per missed due date.
After 3 consecutive missed payments → Final Settlement.

How to process an extension request:
Go to CSR Operations → CSR Alerts → Extensions tab.
Review customer extension requests.
Extension gives customer 1 more month to pay.
Approve or reject within 24 hours.

How to forfeit an account:
Admin only. Go to account detail → Manual Forfeit.
All payments are forfeited, item returns to Cha Jewels.
Loyalty points are revoked on forfeit.

How to reactivate a forfeited account:
Admin only. Go to account detail → Reactivate.
Loyalty points are automatically restored on reactivation.

How to void a payment:
Go to account detail → Payment History → Void.
Admin only. Voiding a downpayment revokes loyalty points.
Voiding an installment does NOT revoke loyalty points.

=== LOYALTY PROGRAM DETAILS ===

Points formula:
  points = floor(loyalty_jpy_amount / 10000) × 100 × tier_multiplier
  Example: ¥50,000 purchase at Glimmer tier =
  floor(50000/10000) × 100 × 1 = 500 points

Tier multipliers and thresholds (cumulative spend in JPY):
  Glimmer:   1x — starting tier (¥0 minimum)
  Radiant:   2x — requires ¥1,000,000 cumulative spend
  Elite:     2x — requires ¥4,000,000 cumulative spend
  Crown VIP: 3x — requires ¥8,000,000 cumulative spend

Tier benefits:
  Radiant+: VIP Early Access to new gold arrivals
  Elite:    Full access to VIP Rewards Vault
  Crown VIP: Mystery gifts, private gold viewings,
             triple points multiplier

When points are awarded:
  Layaway: ONLY on downpayment confirmation (not on monthly payments)
  Cash orders: ONLY when fully paid (order completed)
  Monthly installment payments do NOT earn points

Loyalty enrollment:
  Customers auto-enroll when they sign up on the portal
  Staff can also enroll manually: Loyalty → Members → Add Member
  Enrollment URL for customers: regloyalty.chajewelsjp.com

Redemption process:
  Customer requests redemption via portal or Messenger
  Staff reviews in Loyalty → Redemptions tab
  Admin/finance/staff can APPROVE redemptions
  Only admin can CANCEL or VOID redemptions
  Redemption discount is applied to the order's loyalty amount

Loyalty point lot expiry:
  Point lots expire — customers can see next expiry in portal
  Red "expiring soon" badge shows within 30 days of expiry

Inactivity rule:
  166-day warning sent if no purchase activity
  180-day expiry if still inactive after warning

=== ACCOUNT STATUS MEANINGS ===

active: account is current, payments on time
overdue: missed payment past due date
extension_active: account extended, still paying
reactivated: previously forfeited, now reactivated
final_settlement: given final date to settle
completed: fully paid off
forfeited: all payments lost, item returned
final_forfeited: final forfeiture after extension
cancelled: account cancelled

=== PENALTY RULES ===

Penalty amount: ¥1,000 or ₱500 per missed due date
Grace period: 1 week on FIRST late payment only
Subsequent late payments: penalty applied immediately
3 consecutive missed payments → Final Settlement Date issued
If not settled by Final Settlement Date → account forfeited

Penalty status:
  unpaid/active: charged, not yet collected (shows red)
  paid: charged and collected (shows green)
  waived: forgiven by admin (excluded from balance)

Remaining balance formula:
  remaining_balance = total_amount + unpaid penalties - total payments received

=== CASH ORDER RULES ===

Cash orders are one-time full payment purchases.
No installment schedule — customer pays the full amount.
Loyalty points awarded when cash order is fully paid.
Cash orders managed in Sales → Cash tab.
Cancellation: full store credit if same day, 30% fee after 1 day.

=== PAYMENT METHODS ACCEPTED ===
GCash, BPI, BDO, Metrobank, cash deposit, PayPay (Japan)
Payments submitted via Messenger or Customer Portal

Return ONLY valid JSON for action/policy intents, no markdown, no explanation.

For CREATE_CUSTOMER and RECORD_PAYMENT:
{
  "intent": "CREATE_CUSTOMER" | "RECORD_PAYMENT",
  "confidence": 0.0-1.0,
  "parameters": { ... extracted fields ... },
  "display_summary": "human-readable one-line summary of what was parsed"
}

For ASK_POLICY (policy or post-tool-call answer):
{
  "intent": "ASK_POLICY",
  "confidence": 0.0-1.0,
  "parameters": {},
  "display_summary": "",
  "answer": "your direct answer to the question, based on the knowledge base and/or tool results"
}

The answer field should be a clear, direct, helpful response in English. If the question is not covered by the knowledge base AND no tools returned useful data, say "I don't have information about that. Please check with the admin or refer to the Policy Hub."

If the input is unclear or does not match any intent, return intent: "UNKNOWN" with confidence: 0 and an empty parameters object.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "query_customers",
      description: "Search customers by name, email, or mobile number",
      parameters: {
        type: "object",
        properties: {
          search: {
            type: "string",
            description: "Customer name, email, or mobile to search for",
          },
        },
        required: ["search"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_accounts",
      description: "Get layaway accounts by customer name, invoice number, or status",
      parameters: {
        type: "object",
        properties: {
          customer_name: {
            type: "string",
            description: "Customer name to filter by",
          },
          invoice_number: {
            type: "string",
            description: "Invoice number to look up",
          },
          status: {
            type: "string",
            description: "Account status: active, overdue, completed, forfeited",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_payments",
      description: "Get payment history by customer name or date range",
      parameters: {
        type: "object",
        properties: {
          customer_name: {
            type: "string",
            description: "Customer name to filter payments by",
          },
          date_from: {
            type: "string",
            description: "Start date in YYYY-MM-DD format",
          },
          date_to: {
            type: "string",
            description: "End date in YYYY-MM-DD format",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "count_accounts",
      description: "Count accounts by status — overdue, active, completed, forfeited",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Account status to count",
          },
        },
        required: ["status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_loyalty",
      description: "Get loyalty points and tier for a customer",
      parameters: {
        type: "object",
        properties: {
          customer_name: {
            type: "string",
            description: "Customer name to look up loyalty info for",
          },
        },
        required: ["customer_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_loyalty_tiers",
      description: "Get loyalty tier names, spend thresholds, and point multipliers",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_system_settings",
      description: "Get system settings like php_jpy_rate exchange rate",
      parameters: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Setting key to retrieve e.g. php_jpy_rate",
          },
        },
        required: ["key"],
      },
    },
  },
];

async function runTool(
  name: string,
  args: Record<string, string>,
  // deno-lint-ignore no-explicit-any
  supabase: any,
): Promise<string> {
  try {
    if (name === "query_customers") {
      const search = String(args.search ?? "").trim();
      if (!search) return JSON.stringify({ error: "search is required" });
      const { data, error } = await supabase
        .from("customers")
        .select("id, customer_code, full_name, email, mobile_number, location, facebook_name")
        .or(
          `full_name.ilike.%${search}%,email.ilike.%${search}%,mobile_number.ilike.%${search}%`,
        )
        .limit(10);
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify(data ?? []);
    }

    if (name === "query_accounts") {
      let q = supabase
        .from("layaway_accounts")
        .select(
          "invoice_number, currency, total_amount, remaining_balance, status, customers(full_name)",
        )
        .limit(20);
      if (args.customer_name) {
        q = q.ilike("customers.full_name", `%${args.customer_name}%`);
      }
      if (args.invoice_number) {
        q = q.eq("invoice_number", args.invoice_number);
      }
      if (args.status) {
        const statusFilter = args.status === "overdue"
          ? ["overdue", "extension_active"]
          : [args.status];
        q = q.in("status", statusFilter);
      }
      const { data, error } = await q;
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify(data ?? []);
    }

    if (name === "query_payments") {
      let q = supabase
        .from("payments")
        .select(
          "amount_paid, date_paid, payment_method, reference_number, layaway_accounts(invoice_number, customers(full_name))",
        )
        .is("voided_at", null)
        .order("date_paid", { ascending: false })
        .limit(20);
      if (args.date_from) q = q.gte("date_paid", args.date_from);
      if (args.date_to) q = q.lte("date_paid", args.date_to);
      const { data, error } = await q;
      if (error) return JSON.stringify({ error: error.message });

      // Optional client-side filter by customer_name (joined column can't be
      // .ilike'd directly without an inner join hint).
      if (args.customer_name) {
        const needle = String(args.customer_name).toLowerCase();
        // deno-lint-ignore no-explicit-any
        const filtered = (data ?? []).filter((row: any) => {
          const name = row?.layaway_accounts?.customers?.full_name ?? "";
          return String(name).toLowerCase().includes(needle);
        });
        return JSON.stringify(filtered);
      }
      return JSON.stringify(data ?? []);
    }

    if (name === "count_accounts") {
      const status = String(args.status ?? "").trim();
      if (!status) return JSON.stringify({ error: "status is required" });
      // "overdue" semantics include accounts in their granted extension window.
      const statusFilter = status === "overdue"
        ? ["overdue", "extension_active"]
        : [status];
      const { count, error } = await supabase
        .from("layaway_accounts")
        .select("*", { count: "exact", head: true })
        .in("status", statusFilter);
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ count: count ?? 0, status });
    }

    if (name === "query_loyalty") {
      const search = String(args.customer_name ?? "").trim();
      if (!search) return JSON.stringify({ error: "customer_name is required" });
      const { data, error } = await supabase
        .from("loyalty_members")
        .select(
          "remaining_points, total_points_earned, total_points_redeemed, customers(full_name)",
        )
        .ilike("customers.full_name", `%${search}%`)
        .limit(5);
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify(data ?? []);
    }

    if (name === "query_loyalty_tiers") {
      const { data, error } = await supabase
        .from("loyalty_tiers")
        .select("name, min_spend_jpy, points_multiplier")
        .order("min_spend_jpy", { ascending: true });
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify(data ?? []);
    }

    if (name === "query_system_settings") {
      const key = String(args.key ?? "").trim();
      if (!key) return JSON.stringify({ error: "key is required" });
      const { data, error } = await supabase
        .from("system_settings")
        .select("key, value")
        .eq("key", key)
        .maybeSingle();
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify(data ?? {});
    }

    return JSON.stringify({ error: "Unknown tool" });
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

interface ToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

// deno-lint-ignore no-explicit-any
async function callAI(
  messages: any[],
  // deno-lint-ignore no-explicit-any
  tools: any[],
  apiKey: string,
  model = "google/gemini-2.5-flash",
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  const response = await fetch(
    "https://ai.gateway.lovable.dev/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: tools.length > 0 ? "auto" : undefined,
        temperature: 0.1,
      }),
    },
  );
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI error ${response.status}: ${err}`);
  }
  return response.json();
}

async function callAIWithFallback(
  // deno-lint-ignore no-explicit-any
  messages: any[],
  // deno-lint-ignore no-explicit-any
  tools: any[],
  apiKey: string,
  // deno-lint-ignore no-explicit-any
): Promise<any> {
  try {
    return await callAI(messages, tools, apiKey, "google/gemini-2.5-flash");
  } catch (err) {
    console.warn(
      "Primary model failed, falling back to gpt-5-mini:",
      (err as Error).message,
    );
    return await callAI(messages, tools, apiKey, "openai/gpt-5-mini");
  }
}

function safeParseArgs(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v != null) out[k] = String(v);
      }
      return out;
    }
  } catch (_err) {
    // fall through
  }
  return {};
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Staff users call this — verify user JWT via getUser.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { command, history = [] } = await req.json();
    if (!command || typeof command !== "string" || !command.trim()) {
      return new Response(JSON.stringify({ error: "command is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const historyMessages = Array.isArray(history) ? history : [];

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      return new Response(JSON.stringify({ error: "AI service not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userCommand = command.trim();

    // Pass 1 — send messages + tools, let the model decide whether to call a tool.
    const firstMessages = [
      { role: "system", content: systemPrompt },
      ...historyMessages,
      { role: "user", content: userCommand },
    ];
    const firstResult = await callAIWithFallback(firstMessages, TOOLS, LOVABLE_API_KEY);
    const firstChoice = firstResult.choices?.[0];
    const firstMessage = firstChoice?.message;
    const toolCalls: ToolCall[] | undefined = firstMessage?.tool_calls;

    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Execute every tool call and collect results.
      const toolResults = await Promise.all(
        toolCalls.map(async (tc) => {
          const args = safeParseArgs(tc.function?.arguments ?? "{}");
          const result = await runTool(tc.function?.name ?? "", args, supabase);
          return { tc, result };
        }),
      );

      // Pass 2 — feed tool results back for a natural-language answer.
      const secondMessages = [
        { role: "system", content: systemPrompt },
        ...historyMessages,
        { role: "user", content: userCommand },
        {
          role: "assistant",
          content: firstMessage?.content ?? null,
          tool_calls: toolCalls,
        },
        ...toolResults.map(({ tc, result }) => ({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        })),
      ];
      const secondResult = await callAIWithFallback(secondMessages, [], LOVABLE_API_KEY);
      const secondContent = secondResult.choices?.[0]?.message?.content ?? "";

      // The second pass may return either prose or another JSON envelope.
      // Try to parse JSON; if that fails, wrap the prose as ASK_POLICY.
      let payload: unknown;
      try {
        let jsonStr = String(secondContent).trim();
        if (jsonStr.startsWith("```")) {
          jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
        }
        payload = JSON.parse(jsonStr);
      } catch {
        payload = {
          intent: "ASK_POLICY",
          confidence: 1.0,
          parameters: {},
          display_summary: "",
          answer: secondContent,
        };
      }

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // No tool calls — parse the model's direct response as before.
    const aiContent = firstMessage?.content;
    if (!aiContent) {
      return new Response(
        JSON.stringify({ error: "AI returned empty response" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let parsed: unknown;
    try {
      let jsonStr = String(aiContent).trim();
      if (jsonStr.startsWith("```")) {
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      }
      parsed = JSON.parse(jsonStr);
    } catch {
      parsed = {
        intent: "ASK_POLICY",
        confidence: 1.0,
        parameters: {},
        display_summary: "",
        answer: aiContent,
      };
    }

    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("ai-command-parser error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
