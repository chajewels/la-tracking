import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkPermission } from "../_shared/check-permission.ts";
import { writeOrderExtras, type OrderExtras } from "../_shared/order-extras.ts";
import {
  applyPage365Stock,
  checkPage365Draft,
  normaliseServiceLineNos,
  type Page365StockResult,
} from "../_shared/page365-stock.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Permission gate (Bug #199 Batch A: matrix-driven access)
    const allowed = await checkPermission(supabase, user.id, "create_cash_order");
    if (!allowed) {
      return new Response(JSON.stringify({ error: "create_cash_order permission required" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Parse + validate body
    const body = await req.json();
    const {
      customer_id,
      invoice_number,
      currency,
      total_amount,
      order_date,
      expires_at,
      notes,
      agreement_version,
      is_trade, // boolean — optional, trade program flag (locked after creation)
      // Optional extras, written inside THIS call rather than by the browser
      // afterwards — see _shared/order-extras.ts for why. Absent on every
      // existing caller, whose behaviour is therefore unchanged.
      items,
      discount,
      shipping_fee,
      page365_no,
      page365_slug,
      // Page365 stock (2026-09-26): the draft the lines come from, and the
      // draft positions the CSR marked as a service. See _shared/page365-stock.ts.
      page365_draft_id,
      page365_service_lines,
    } = body;

    if (!customer_id || !invoice_number || !currency || total_amount == null || !expires_at) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!["PHP", "JPY"].includes(currency)) {
      return new Response(JSON.stringify({ error: "Currency must be PHP or JPY" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const totalAmountNum = Number(total_amount);
    if (!Number.isFinite(totalAmountNum) || totalAmountNum <= 0) {
      return new Response(JSON.stringify({ error: "total_amount must be a positive number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Validate expires_at parses to a real timestamp
    const expiresAtDate = new Date(expires_at);
    if (Number.isNaN(expiresAtDate.getTime())) {
      return new Response(JSON.stringify({ error: "expires_at must be a valid date/timestamp" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Customer must exist
    const { data: customer, error: customerErr } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customer_id)
      .maybeSingle();
    if (customerErr || !customer) {
      return new Response(JSON.stringify({ error: "customer_id not found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // A test customer's invoice_number is REWRITTEN to TEST-<n> by
    // enforce_test_invoice_prefix, which fires after this check — so the raw
    // number colliding with a real order is not a real collision. Skip the
    // pre-check for test customers and let trg_zz_invoice_registry_*, which
    // sees the final prefixed value, be the judge.
    const { data: custFlags } = await supabase
      .from("customers").select("is_test").eq("id", customer_id).maybeSingle();
    const isTestCustomer = custFlags?.is_test === true;

    // 5. Invoice number must be unique across cash_orders AND layaway_accounts
    const [{ data: existingCash }, { data: existingLayaway }] = await Promise.all([
      supabase.from("cash_orders").select("id").eq("invoice_number", invoice_number).maybeSingle(),
      supabase.from("layaway_accounts").select("id").eq("invoice_number", invoice_number).maybeSingle(),
    ]);
    if (!isTestCustomer && (existingCash || existingLayaway)) {
      return new Response(JSON.stringify({ error: `invoice_number ${invoice_number} already exists` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 5b. One Hub order per Page365 invoice. uq_{cash_orders,layaway_accounts}
    // _page365_no is the backstop; this is the message a CSR can act on.
    if (page365_no != null) {
      const [{ data: p365Cash }, { data: p365Layaway }] = await Promise.all([
        supabase.from("cash_orders").select("id").eq("page365_no", page365_no).maybeSingle(),
        supabase.from("layaway_accounts").select("id").eq("page365_no", page365_no).maybeSingle(),
      ]);
      if (p365Cash || p365Layaway) {
        return new Response(JSON.stringify({
          error: `Page365 invoice ${page365_no} has already been imported`,
          already_imported: p365Cash
            ? { source: "cash_order", id: p365Cash.id }
            : { source: "layaway_account", id: p365Layaway!.id },
        }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    // 5c. A Page365 import names its draft: stock is taken from the draft's own
    // lines, never from what the browser sends. Checked before anything is written.
    let page365DraftId: string | null = null;
    if (page365_no != null) {
      const draftCheck = await checkPage365Draft(supabase, page365_no, page365_draft_id);
      if (!draftCheck.ok) {
        return new Response(JSON.stringify({ error: draftCheck.error }), {
          status: draftCheck.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      page365DraftId = draftCheck.draftId;
    }

    // 6. Loyalty-only product amount in JPY — manually entered by
    // admin/finance because total_amount can include shipping, service
    // fees, and insurance that don't count toward loyalty points. NULL
    // means the customer is not a loyalty member or the value was
    // intentionally left blank.
    const loyaltyJpyAmount =
      typeof body.loyalty_jpy_amount === "number" && body.loyalty_jpy_amount > 0
        ? Math.round(body.loyalty_jpy_amount)
        : null;

    // 6b. Loyalty enforcement: if the customer is a loyalty member (any tier),
    // Loyalty Product Amount (JPY) is mandatory. Authoritative gate — the
    // NewCashOrder.tsx mirror is UX only. Matches create-layaway-account.
    const { data: memberRow } = await supabase
      .from("loyalty_members")
      .select("current_tier_id, current_tier:current_tier_id(name)")
      .eq("customer_id", customer_id)
      .maybeSingle();

    const hasLoyaltyTier = memberRow?.current_tier_id != null;
    if (hasLoyaltyTier && (loyaltyJpyAmount === null || loyaltyJpyAmount <= 0)) {
      return new Response(
        JSON.stringify({
          error: "LOYALTY_AMOUNT_REQUIRED",
          message: `Customer is a ${
            (memberRow.current_tier as any)?.name ?? "loyalty"
          } tier member. Loyalty Product Amount (JPY) is required.`,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 7. Resolve order_date (defaults to today UTC date)
    const resolvedOrderDate = order_date || new Date().toISOString().split("T")[0];

    // 8. Build insert payload
    const insertRow: Record<string, unknown> = {
      customer_id,
      invoice_number,
      currency,
      total_amount: totalAmountNum,
      order_date: resolvedOrderDate,
      expires_at: expiresAtDate.toISOString(),
      notes: notes ?? null,
      status: "pending",
      total_paid: 0,
      remaining_balance: totalAmountNum,
      loyalty_jpy_amount: loyaltyJpyAmount,
      is_trade: is_trade ?? false,
      created_by_user_id: user.id,
      page365_no: page365_no ?? null,
      page365_slug: page365_slug ?? null,
    };
    if (agreement_version) {
      insertRow.agreement_version = agreement_version;
      insertRow.accepted_by_user_id = user.id;
      insertRow.agreement_acceptance_datetime = new Date().toISOString();
    }

    // 9. Insert cash order
    const { data: cashOrder, error: insertErr } = await supabase
      .from("cash_orders")
      .insert(insertRow)
      .select()
      .single();
    if (insertErr || !cashOrder) {
      return new Response(JSON.stringify({ error: insertErr?.message || "Failed to create cash order" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 9b. Optional extras (line items, discount/shipping, Page365 provenance).
    // These used to be best-effort browser writes that swallowed their own
    // failure into a toast; here a failure rolls the order back rather than
    // leaving one whose lines silently vanished. The order has no payments yet,
    // so prevent_paid_order_delete permits the rollback.
    let extrasResult: unknown = null;
    const cashExtras: OrderExtras = { items, discount, shipping_fee };
    const hasExtras =
      (Array.isArray(items) && items.length > 0) ||
      discount != null || shipping_fee != null;
    if (hasExtras) {
      try {
        extrasResult = await writeOrderExtras(supabase, "cash", cashOrder.id, cashExtras, {
          id: user.id,
          name: (user.user_metadata as Record<string, unknown> | undefined)?.full_name as string
            ?? user.email ?? "Unknown",
        });
      } catch (e) {
        await supabase.from("cash_orders").delete().eq("id", cashOrder.id);
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 9c. Page365 stock: claim each invoice line, then take website stock for
    // the lines that match (owner rule D1 — at import, never at fetch). A line
    // that does not match, or whose piece is already reserved/sold on the
    // website, is FLAGGED and the order still stands. Only a request or
    // database error lands here, and it rolls the order back like extras do.
    let page365Stock: Page365StockResult | null = null;
    if (page365DraftId) {
      try {
        page365Stock = await applyPage365Stock(
          supabase, "cash", cashOrder.id, page365DraftId,
          normaliseServiceLineNos(page365_service_lines), user.id,
        );
      } catch (e) {
        await supabase.from("cash_orders").delete().eq("id", cashOrder.id);
        return new Response(JSON.stringify({ error: (e as Error).message }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // 10. Audit log
    await supabase.from("audit_logs").insert({
      entity_type: "cash_order",
      entity_id: cashOrder.id,
      action: "create",
      new_value_json: cashOrder,
      performed_by_user_id: user.id,
    });

    // 11. Return created record
    return new Response(JSON.stringify({ cash_order: cashOrder, extras: extrasResult, page365_stock: page365Stock }), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("create-cash-order error:", error);
    return new Response(JSON.stringify({ error: (error as Error).message || "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
